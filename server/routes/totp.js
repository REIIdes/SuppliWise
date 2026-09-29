/**
 * TOTP (authenticator app), mounted at /api/auth/totp.
 *
 * WHAT IS ALREADY HERE, AND WHY THIS FILE EXISTS ANYWAY
 * -----------------------------------------------------
 * `/auth/setup-2fa`, `/auth/verify-2fa`, `/auth/login-2fa` and
 * `/auth/disable-2fa` have worked for a long time and still do. This router
 * adds the REST shape the security surface is specified in, and moves the
 * actual work behind it, so the two cannot drift.
 *
 * What genuinely changed underneath, and it is not cosmetic:
 *
 * 1. THE SEED IS ENCRYPTED AT REST. It used to be raw base32 on the user
 *    document, so a database read meant unlimited valid codes for every
 *    enrolled account. See utils/secretBox.js. The old field is still readable
 *    and is upgraded in place on first use, so no account loses its
 *    authenticator in the transition.
 *
 * 2. ENROLMENT AND DISABLEMENT REQUIRE RE-AUTHENTICATION. Previously
 *    `POST /auth/disable-2fa` needed a live TOTP — but a passkey-only
 *    enrolment path, or a stolen session plus a phished code, made turning 2FA
 *    off a two-click operation. These routes require a step-up in addition to
 *    the factor itself, so it is password AND current factor, not factor alone.
 *
 * 3. VERIFICATION AT SIGN-IN IS TRANSACTION-BOUND. `/auth/totp/verify` requires
 *    the MFA transaction minted by the password step, so a valid code is no
 *    longer sufficient on its own. See utils/mfaTransaction.js.
 *
 * 4. ATTEMPTS ARE BOUNDED PER TRANSACTION, not just per IP.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

const { protect } = require('../middleware/auth');
const { requireStepUp } = require('../middleware/stepUp');
const { verifyOrigin } = require('../utils/origins');
const User = require('../models/User');
const SecurityEvent = require('../models/SecurityEvent');
const UserNotification = require('../models/UserNotification');
const BackupCode = require('../models/BackupCode');
const MfaTransaction = require('../models/MfaTransaction');
const totpSecret = require('../utils/totpSecret');
const { verifyTotpOnce } = require('../utils/totp');
const mfa = require('../utils/mfaTransaction');
const { AUTH_METHODS, publicUser, completeSignIn } = require('../utils/authFlow');
const {
  accountKey, lockRemainingMs, recordAccountFailure, clearOffenses, lockMeta,
} = require('../utils/lockout');

const router = express.Router();
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

router.use(verifyOrigin);

const ISSUER = str(process.env.WEBAUTHN_RP_NAME || 'SuppliWise').trim() || 'SuppliWise';

// Standard RFC 6238 parameters. 6 digits / 30 seconds / SHA-1 is what Google
// Authenticator, Microsoft Authenticator, Authy, 1Password and Bitwarden all
// expect; "make it stronger" here means phones stop accepting the code.
const TOTP_OPTIONS = Object.freeze({
  digits: 6,
  step: 30,
  encoding: 'base32',
  algorithm: 'sha1',
  window: 1, // +/- one 30s step, for ordinary clock drift on a phone
});

const setupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req) => (process.env.NODE_ENV === 'production' ? 20 : 200),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait a few minutes and try again.' },
});

const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req) => (process.env.NODE_ENV === 'production' ? 30 : 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait a few minutes and try again.' },
});

/** Read the account with every field a TOTP operation may touch. */
function loadUser(id) {
  return User.findById(id)
    .select('-profilePicture -bannerPicture +twoFactorSecret +twoFactorSecretEnc');
}

/**
 * POST /api/auth/totp/setup — begin enrolment.
 *
 * Authenticated, and requires a step-up. Enrolling a second factor is a
 * security change; doing it with nothing but a session token would let a
 * hijacked session start replacing the account's authenticator.
 *
 * Generates the seed with speakeasy (a maintained TOTP library — the HMAC and
 * the base32 are not hand-rolled), returns the otpauth URI as a QR code, and
 * stores the seed ENCRYPTED but INACTIVE.
 *
 * The seed is returned exactly once, here, and never again. It is not written
 * to any browser storage, not logged, and not included in any later response.
 * `twoFactorEnabled` stays false until /verify-setup proves the person can
 * produce a code from it — an unpaired seed is a half-finished setup, and
 * treating it as active would lock the owner out of their own second factor.
 */
router.post('/setup', protect, setupLimiter, requireStepUp, async (req, res) => {
  try {
    const user = await loadUser(req.user._id);
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });

    // Replacing a live authenticator is a different, more dangerous action than
    // turning one on: the owner is about to be signed out of the factor they
    // currently rely on. It goes through disable, which demands a current code.
    if (user.twoFactorEnabled === true) {
      return res.status(409).json({
        message: 'Two-factor authentication is already enabled. Turn it off first before setting up a new authenticator.',
      });
    }

    const secret = speakeasy.generateSecret({
      name: `${ISSUER} (${user.email})`,
      issuer: ISSUER,
      length: 20,
      algorithm: TOTP_OPTIONS.algorithm,
      digits: TOTP_OPTIONS.digits,
      step: TOTP_OPTIONS.step,
    });

    // Encrypted immediately, activated later. A seed sitting in the database
    // unencrypted between these two calls is exactly the window this closes.
    totpSecret.writeSecret(user, secret.base32);
    await user.save();

    const qrCode = await QRCode.toDataURL(secret.otpauth_url);

    await SecurityEvent.write({
      user: user._id, type: 'totp-setup-started', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: 'Started authenticator setup',
      meta: { factor: 'totp', outcome: 'pending' },
    });

    return res.json({
      // Shown once, in a dialog the user is looking at. Not persisted, not
      // cached, not logged.
      qrCode,
      // The manual-entry key, for people who cannot scan a code.
      manualEntryKey: secret.base32,
      issuer: ISSUER,
      account: user.email,
      digits: TOTP_OPTIONS.digits,
      period: TOTP_OPTIONS.step,
      algorithm: TOTP_OPTIONS.algorithm,
      message: 'Scan this with your authenticator app, then enter the 6-digit code it shows.',
    });
  } catch (error) {
    // Deliberately does not name the failure: a "could not start setup" that
    // distinguishes "encryption key missing" from "user not found" is an
    // oracle. The detail goes to the log.
    console.error('[auth/totp/setup]', error.message);
    return res.status(500).json({ message: 'Could not start authenticator setup.' });
  }
});

/**
 * POST /api/auth/totp/verify-setup — activate.
 *
 * Requires a step-up as well as the code. The code proves the phone has the
 * seed; the step-up proves the person asking is the one who is signed in. One
 * without the other is the gap this closes: a stolen session could otherwise
 * pair the ATTACKER's authenticator to the victim's account and then walk in
 * with it forever.
 */
router.post('/verify-setup', protect, setupLimiter, requireStepUp, async (req, res) => {
  try {
    const user = await loadUser(req.user._id);
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });

    if (user.twoFactorEnabled === true) {
      return res.status(409).json({ message: 'Two-factor authentication is already enabled.' });
    }

    const secret = totpSecret.readSecret(user);
    if (!secret) return res.status(400).json({ message: 'Authenticator setup was not started. Please try again.' });

    // Lazily upgrade any pre-encryption seed now that we are touching it, so
    // an old account is migrated the moment its owner uses their authenticator.
    if (totpSecret.migrateInPlace(user)) await user.save().catch(() => {});

    const code = str(req.body && req.body.otp).trim();
    if (!verifyTotpOnce(secret, code, String(user._id))) {
      await SecurityEvent.write({
        user: user._id, type: 'totp-failed', success: false,
        ip: req.ip, userAgent: req.get('user-agent'),
        reason: 'Authenticator code rejected during setup',
        meta: { factor: 'totp', outcome: 'mismatch' },
      });
      return res.status(401).json({ message: 'That verification code is not valid.' });
    }

    user.twoFactorEnabled = true;
    // Verifying a TOTP IS choosing the authenticator method, so the field is
    // written here rather than left to default.
    user.twoFactorMethod = 'authenticator';
    await user.save();

    await SecurityEvent.write({
      user: user._id, type: 'totp-enabled', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: 'Authenticator app enabled',
      meta: { factor: 'totp', mfaVerified: true },
    });

    await UserNotification.create({
      user: user._id,
      type: 'info',
      title: 'Two-factor authentication enabled',
      detail: 'Your authenticator app is now required at sign-in. If this was not you, remove it and change your password immediately.',
    }).catch(() => {});

    return res.json({
      message: 'Two-factor authentication enabled.',
      twoFactorEnabled: true,
      twoFactorMethod: 'authenticator',
    });
  } catch (error) {
    console.error('[auth/totp/verify-setup]', error.message);
    return res.status(500).json({ message: 'Could not verify that code.' });
  }
});

/**
 * POST /api/auth/totp/disable — turn the authenticator off.
 *
 * The most dangerous button in the account, so it is the most guarded:
 *   • a step-up (password, plus the current factor), so a stolen session is not
 *     enough;
 *   • a live code from the authenticator being removed, so the step-up itself
 *     cannot have been satisfied by a phished code plus a guessed password;
 *   • `twoFactorEnabled` is only cleared once both are satisfied;
 *   • the session that did it is kept (you did not ask to be signed out) but
 *     every other session is revoked, because a downgrade this significant
 *     should cost anything already holding a token;
 *   • recovery codes are destroyed, since they only exist to rescue a
 *     disabled authenticator and are a liability afterwards;
 *   • the account is told, in the app and by email.
 */
router.post('/disable', protect, setupLimiter, requireStepUp, async (req, res) => {
  try {
    const user = await loadUser(req.user._id);
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });

    if (user.twoFactorEnabled !== true) {
      return res.status(400).json({ message: 'Two-factor authentication is not currently enabled.' });
    }

    const method = user.twoFactorMethod || 'authenticator';
    const code = str(req.body && req.body.otp).trim();

    if (method === 'authenticator') {
      const secret = totpSecret.readSecret(user);
      if (!secret) {
        // Enabled with no readable seed: the account cannot be rescued by a
        // code, so the proof has to be the password plus a recovery code.
        const codeUsed = await BackupCode.consume(user._id, code);
        if (!codeUsed) {
          return res.status(401).json({ message: 'Enter a code from your authenticator app or a recovery code.' });
        }
        await SecurityEvent.write({
          user: user._id, type: 'backup-code-used', success: true,
          ip: req.ip, userAgent: req.get('user-agent'),
          reason: 'Recovery code used to remove the authenticator',
          meta: { factor: 'backup-code' },
        });
      } else if (!verifyTotpOnce(secret, code, String(user._id))) {
        await SecurityEvent.write({
          user: user._id, type: 'totp-failed', success: false,
          ip: req.ip, userAgent: req.get('user-agent'),
          reason: 'Authenticator code rejected while disabling',
          meta: { factor: 'totp', outcome: 'mismatch' },
        });
        return res.status(401).json({ message: 'That verification code is not valid.' });
      }
    } else {
      // On the emailed-code method there is no authenticator code to present,
      // so the step-up's password is the proof. It is the weaker of the two
      // factors by construction, and the UI says so.
      const ok = await user.matchPassword(str(req.body && req.body.currentPassword));
      if (!ok) return res.status(401).json({ message: 'Enter your current password to turn off two-factor authentication.' });
    }

    user.twoFactorEnabled = false;
    // The seed is FORGOTTEN, not just deactivated. Leaving it behind would mean
    // a database read could still mint codes for an account that believes it
    // has no authenticator.
    totpSecret.clearSecret(user);
    // Reset so a later re-enable defaults to the stronger factor.
    user.twoFactorMethod = 'authenticator';
    await user.save();

    const removed = await BackupCode.invalidateAll(user._id);

    // Everything else holding a token for this account loses it. The caller's
    // own session survives, because they did not ask to be signed out.
    const { revokeOtherUserSessions } = require('../utils/sessions');
    await revokeOtherUserSessions(user._id, req.sessionId).catch(() => {});

    await SecurityEvent.write({
      user: user._id, type: 'totp-disabled', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: method === 'email'
        ? 'Email sign-in codes turned off'
        : 'Authenticator app turned off',
      meta: { factor: method === 'email' ? 'email-otp' : 'totp', outcome: removed ? 'codes-invalidated' : '' },
    });

    await UserNotification.create({
      user: user._id,
      type: 'info',
      title: 'Two-factor authentication disabled',
      detail: method === 'email'
        ? 'Email sign-in codes were turned off. If this was not you, re-enable two-factor authentication and change your password immediately.'
        : 'Your authenticator app was turned off. If this was not you, re-enable it and change your password immediately.',
    }).catch(() => {});

    return res.json({ message: 'Two-factor authentication has been disabled.', twoFactorEnabled: false });
  } catch (error) {
    console.error('[auth/totp/disable]', error.message);
    return res.status(500).json({ message: 'Could not turn off two-factor authentication.' });
  }
});

/**
 * POST /api/auth/totp/verify — complete sign-in with a TOTP.
 *
 * The MFA_REQUIRED → FULLY_AUTHENTICATED transition, and the only place a
 * session is issued for this factor.
 *
 * Requires `mfaTransaction`: the opaque token minted by the password step. That
 * is what makes the second factor a second FACTOR rather than a substitute for
 * the first — a valid code on its own, plus a known user id, used to be enough
 * for a full session. The transaction is spent atomically here, so it cannot be
 * replayed, and it carries an attempt budget so ten thousand guesses cost ten
 * guesses.
 *
 * `userId` is accepted for a client that has not been updated, but ONLY when
 * there is a live transaction for that account — which means the password step
 * really did succeed, recently, for that account. A stale build still works
 * (it always goes through /auth/login first); an attacker holding only a code
 * and a user id does not.
 */
router.post('/verify', verifyLimiter, async (req, res) => {
  const body = req.body || {};
  const token = str(body.mfaTransaction);
  const code = str(body.otp).trim();
  const remember = body.remember === true || body.remember === 'true';

  if (mfa.resolveBudgetExhausted(req.ip)) {
    return res.status(429).json({ message: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const refuse = (message, status = 401) => res.status(status).json({ message });

  let transaction;
  if (token) {
    if (!mfa.isValidTokenFormat(token)) return refuse('That sign-in attempt has expired. Please sign in again.');
    const peeked = await mfa.peek(token, { method: 'totp' });
    if (!peeked) return refuse('That sign-in attempt has expired. Please sign in again.');
    transaction = { _id: peeked._id, user: peeked.user, viaToken: true };
  } else {
    // Legacy shape: a bare user id, from a client too old to know about
    // transactions. Honoured ONLY if that account is genuinely mid-sign-in,
    // which means its password step really did succeed here, recently. A stale
    // build still works because it always goes through /auth/login first; an
    // attacker holding only a code and a user id does not.
    const userId = str(body.userId);
    if (!/^[a-f\d]{24}$/i.test(userId)) return refuse('That sign-in attempt has expired. Please sign in again.');
    const found = await MfaTransaction.findOne({
      user: userId,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
      methods: 'totp',
    }).select('_id user').sort({ createdAt: -1 }).lean();
    if (!found) return refuse('That sign-in attempt has expired. Please sign in again.');
    transaction = { _id: found._id, user: found.user, viaToken: false };
  }

  // Per-account throttling, keyed on the RESOLVED account rather than anything
  // the client sent. This is the limit that actually stops a 6-digit guess
  // loop; the IP bucket above only stops one machine.
  const lockKey = accountKey('otp-user', transaction.user);
  if (lockRemainingMs(lockKey) > 0) {
    return refuse('Too many incorrect attempts. Please wait a few minutes and try again.', 429);
  }

  let user;
  try {
    user = await User.findById(transaction.user)
      .select('-profilePicture -bannerPicture +twoFactorSecret +twoFactorSecretEnc');
  } catch {
    return res.status(503).json({ message: 'The service is temporarily unavailable. Please try again.' });
  }
  if (!user || user.twoFactorEnabled !== true) return refuse('That verification code is not valid.');
  if (user.accountStatus && user.accountStatus !== 'active') {
    return res.status(403).json({
      message: user.accountStatus === 'banned' ? 'This account has been banned.' : 'This account is no longer active.',
    });
  }

  // Lazily migrate a pre-encryption seed: touching it is the moment we know
  // the key works, which is exactly when it is safe to re-seal it.
  if (totpSecret.migrateInPlace(user)) await user.save().catch(() => {});

  const secret = totpSecret.readSecret(user);
  if (!secret || !verifyTotpOnce(secret, code, String(user._id))) {
    recordAccountFailure(lockKey, lockMeta(req, req.ip));
    await SecurityEvent.write({
      user: user._id, type: 'mfa-failure', success: false,
      ip: req.ip, userAgent: req.get('user-agent'),
      location: user.lastLoginLocation || '',
      reason: 'Authenticator code rejected at sign-in',
      meta: { factor: 'totp', outcome: 'mismatch' },
    });
    return refuse('That verification code is not valid.');
  }

  // Spend the transaction AFTER the code is accepted but BEFORE the session is
  // issued. Two concurrent submissions of one valid code: both may pass
  // verification, but only one can win the conditional update, and only the
  // winner gets a token.
  const spent = transaction.viaToken
    ? await mfa.spend(token, { method: 'totp' })
    : await mfa.spendById(transaction._id, { method: 'totp' });
  if (!spent.ok) {
    return refuse('That sign-in attempt has expired. Please sign in again.');
  }

  clearOffenses(lockKey);

  const { token: sessionToken, rememberToken } = await completeSignIn({
    user,
    authMethod: AUTH_METHODS.TOTP,
    mfaVerified: true,
    req,
    location: user.lastLoginLocation || '',
    remember,
    reason: 'Signed in with your authenticator app',
    eventType: 'mfa-success',
  });

  return res.json({
    ...publicUser(user),
    token: sessionToken,
    authMethod: AUTH_METHODS.TOTP,
    mfaVerified: true,
    ...(rememberToken ? { rememberToken } : {}),
  });
});

module.exports = router;
module.exports.TOTP_OPTIONS = TOTP_OPTIONS;
