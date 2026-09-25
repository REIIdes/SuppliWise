/**
 * /api/security — the account-security dashboard's server side.
 *
 * EVERY route here except the recovery-code redemption is `protect`-guarded,
 * admin-excluded, and scoped to `req.user._id` in the query itself. That last
 * part matters: a route that looks up "a session by id" without also matching
 * the owner is an IDOR, so every find below pairs the id with the
 * authenticated user and treats a miss as 404 (never 403 — that would confirm
 * the object exists to someone who does not own it).
 *
 * The mutating routes additionally require STEP-UP: a fresh proof of
 * possession (password, plus the TOTP when the authenticator is the active
 * factor) traded for a short-lived token. Without it, anyone holding a stolen
 * session token could immediately strip MFA, mint backup codes, or repoint
 * recovery email — which is the single most valuable thing to do with a
 * stolen session, so it must not be one token away.
 */
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { protect } = require('../middleware/auth');
const User = require('../models/User');
const Session = require('../models/Session');
const SecurityEvent = require('../models/SecurityEvent');
const BackupCode = require('../models/BackupCode');
const { verifyTotpOnce } = require('../utils/totp');
const { revokeUserSession, revokeOtherUserSessions } = require('../utils/sessions');
const { describeDevice } = require('../utils/device');
const { sendOtpEmail, sendStatusEmail } = require('../utils/email');
const { isValidEmail } = require('../utils/emailValidation');
const {
  accountKey, recordOffense, lockRemainingMs, recordAccountFailure, clearOffenses, lockMeta,
} = require('../utils/lockout');

const router = express.Router();

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Tighter limiter for the credential-touching routes below.
 *
 * The broad authLimiter is shared across the whole /api/auth tree and, in
 * production, is exhausted by ordinary sign-in traffic long before a
 * brute-force attempt against these endpoints runs out.
 *
 * Read-only endpoints (summary, devices, events) deliberately stay OUT of it —
 * reviewing your own security page must never be throttled into looking like an
 * attack on your account.
 */
const sensitiveLimiter = require('express-rate-limit')({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many security requests. Please wait a few minutes and try again.' },
});

// ── Public: the second-factor fallback, reached mid-sign-in ────────────────
// Registered BEFORE `protect` on purpose. This is the one endpoint here a
// caller reaches while signing in — they hold a password and a userId but no
// session yet. Sitting behind the router-wide guard made it unreachable and
// answered every legitimate recovery-code sign-in with NO_SESSION.
require('./securityRedeem')(router, { sensitiveLimiter });

router.use(protect);

// Admin accounts are a separate identity with their own console; the user
// security surface does not apply to them and must not be a second way in.
router.use((req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    return res.status(403).json({ message: 'User account required.' });
  }
  next();
});

// ── Step-up ────────────────────────────────────────────────────────────────

const STEP_UP_TTL_MS = 5 * 60 * 1000;
const STEP_UP_PURPOSE = 'step-up';

function issueStepUpToken(userId, sid) {
  return jwt.sign(
    { sub: String(userId), id: String(userId), sid: String(sid), purpose: STEP_UP_PURPOSE },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
}

/**
 * Gate for the mutating security routes.
 *
 * Requires `X-Step-Up` carrying a token minted by POST /security/step-up in
 * the last 5 minutes, for THIS user and THIS session. A step-up earned on one
 * device does not authorise a change from another, and a fresh sign-in
 * invalidates it because the token is bound to the session id.
 */
function requireStepUp(req, res, next) {
  const raw = str(req.get('x-step-up') || req.body?.stepUp);
  if (!raw) {
    return res.status(401).json({
      code: 'STEP_UP_REQUIRED',
      message: 'Please confirm your identity again to change this setting.',
    });
  }
  let claims;
  try {
    claims = jwt.verify(raw, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ code: 'STEP_UP_REQUIRED', message: 'Your confirmation expired. Please try again.' });
  }
  if (claims.purpose !== STEP_UP_PURPOSE) {
    return res.status(401).json({ code: 'STEP_UP_REQUIRED', message: 'Your confirmation expired. Please try again.' });
  }
  if (String(claims.id) !== String(req.user._id) || String(claims.sid || '') !== String(req.sessionId || '')) {
    return res.status(401).json({ code: 'STEP_UP_REQUIRED', message: 'Your confirmation expired. Please try again.' });
  }
  return next();
}

// @route   POST /api/security/step-up
// @desc    Trade the current password (plus a live TOTP when the account uses
//          the authenticator) for a 5-minute step-up token.
//          Deliberately NOT the session token: possessing a session must not be
//          enough to change security settings.
// @access  Private
router.post('/step-up', sensitiveLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+twoFactorSecret');
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });

    const emailKey = accountKey('email', user.email);
    if (lockRemainingMs(emailKey) > 0) {
      return res.status(429).json({ message: 'Too many failed attempts. Please wait before trying again.' });
    }

    const password = str(req.body?.password);
    const otp = str(req.body?.otp).trim();
    if (!password) return res.status(400).json({ message: 'Enter your current password.' });

    const passwordOk = await user.matchPassword(password);
    if (!passwordOk) {
      recordAccountFailure(emailKey, lockMeta(req, req.ip));
      await SecurityEvent.write({
        user: user._id, type: 'password-change-failed', success: false,
        ip: req.ip, userAgent: req.get('user-agent'),
        reason: 'Incorrect password while confirming identity',
      });
      return res.status(401).json({ message: 'That password is not correct.' });
    }

    // The authenticator method requires a live code as well: a stolen session
    // plus a guessed password must not be enough.
    const method = user.twoFactorEnabled ? (user.twoFactorMethod || 'authenticator') : null;
    if (method === 'authenticator') {
      if (!otp) {
        return res.status(400).json({ message: 'Enter the 6-digit code from your authenticator app.' });
      }
      if (!verifyTotpOnce(user.twoFactorSecret, otp)) {
        recordOffense(emailKey, lockMeta(req, req.ip));
        await SecurityEvent.write({
          user: user._id, type: 'mfa-failure', success: false,
          ip: req.ip, userAgent: req.get('user-agent'),
          reason: 'Code rejected while confirming identity',
        });
        return res.status(401).json({ message: 'That verification code is not valid.' });
      }
      await SecurityEvent.write({
        user: user._id, type: 'mfa-success', success: true,
        ip: req.ip, userAgent: req.get('user-agent'),
        reason: 'Identity confirmed with authenticator',
      });
    }

    return res.json({
      stepUp: issueStepUpToken(user._id, req.sessionId),
      expiresInSeconds: Math.floor(STEP_UP_TTL_MS / 1000),
    });
  } catch (error) {
    console.error('[security/step-up]', error.message);
    return res.status(500).json({ message: 'Could not confirm your identity. Please try again.' });
  }
});

// @route   GET /api/security/summary
// @desc    Everything the dashboard header needs, in one call.
// @access  Private
router.get('/summary', async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('twoFactorEnabled twoFactorMethod passwordChangedAt recoveryEmail recoveryEmailVerifiedAt')
      .lean();
    if (!user) return res.status(404).json({ message: 'Account not found.' });

    const [backupRemaining, trustedCount, activeCount] = await Promise.all([
      BackupCode.countDocuments({ user: user._id, usedAt: null }),
      Session.countDocuments({ user: user._id, rememberHash: { $nin: ['', null] } }),
      Session.countDocuments({ user: user._id, revokedAt: null }),
    ]);

    res.json({
      twoFactor: {
        enabled: user.twoFactorEnabled === true,
        // Never send the secret. The method is a label, not a credential.
        method: user.twoFactorEnabled ? (user.twoFactorMethod || 'authenticator') : null,
      },
      passwordChangedAt: user.passwordChangedAt || null,
      recoveryEmail: {
        address: user.recoveryEmail || null,
        verified: !!user.recoveryEmailVerifiedAt,
      },
      backupCodes: { remaining: backupRemaining, total: BackupCode.CODE_COUNT },
      sessions: { trusted: trustedCount, active: activeCount },
    });
  } catch (error) {
    console.error('[security/summary]', error.message);
    res.status(500).json({ message: 'Could not load your security settings.' });
  }
});

// @route   GET /api/security/devices
// @desc    The signed-in devices this account can see: the live session plus
//          any session still holding a saved-login ("trusted") credential.
//
//          The architecture allows ONE active session, so this is usually a
//          single row. Revoked history is deliberately NOT padded in — showing
//          dead sessions as though they were live is exactly what makes a
//          security panel untrustworthy.
//
//          Identity is NOT inferred from user-agent (see utils/device.js).
//          Those fields are display labels on records whose trust anchor is the
//          stored credential hash.
// @access  Private
router.get('/devices', async (req, res) => {
  try {
    const sessions = await Session.find({ user: req.user._id, revokedAt: null })
      .select('_id deviceLabel platform ip location createdAt lastActivityAt rememberHash trustedAt')
      .sort({ lastActivityAt: -1 })
      .lean();

    const devices = sessions.map((s) => ({
      id: String(s._id),
      label: s.deviceLabel || 'Unknown device',
      platform: s.platform || 'Unknown OS',
      location: s.location || 'Unknown location',
      ip: s.ip || '',
      createdAt: s.createdAt,
      lastActiveAt: s.lastActivityAt,
      isCurrent: String(s._id) === String(req.sessionId),
      // "Trusted" only because it holds a saved-login credential.
      isTrusted: !!s.rememberHash,
      trustedAt: s.trustedAt || null,
    }));

    res.json({
      devices,
      note: 'Only one sign-in is active at a time; signing in on a new device replaces the previous one.',
    });
  } catch (error) {
    console.error('[security/devices]', error.message);
    res.status(500).json({ message: 'Could not load your signed-in devices.' });
  }
});

// @route   POST /api/security/devices/:id/revoke
// @desc    Revoke ONE other session and strip its saved-login credential.
//          Owner-scoped: the id is matched together with req.user._id, so a
//          guessed id belonging to someone else is a 404, not a revocation.
// @access  Private + step-up
router.post('/devices/:id/revoke', sensitiveLimiter, requireStepUp, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Device not found.' });
    if (String(req.params.id) === String(req.sessionId)) {
      return res.status(400).json({ message: 'That is the device you are using. Use Sign out instead.' });
    }

    const result = await Session.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, revokedAt: null },
      { $set: { revokedAt: new Date(), rememberHash: '' } },
      { new: true }
    ).lean();

    if (!result) return res.status(404).json({ message: 'Device not found.' });

    await User.updateOne(
      { _id: req.user._id, currentSessionId: result._id },
      { $set: { currentSessionId: null } }
    ).catch(() => {});

    await SecurityEvent.write({
      user: req.user._id, type: 'device-trust-revoked', success: true,
      ip: req.ip, userAgent: req.get('user-agent'), reason: result.deviceLabel || 'Device',
    });

    res.json({ message: 'That device has been signed out.' });
  } catch (error) {
    console.error('[security/devices/revoke]', error.message);
    res.status(500).json({ message: 'Could not sign out that device.' });
  }
});

// @route   POST /api/security/devices/revoke-others
// @desc    Sign out every session except this one, dropping their saved-login
//          credentials. Also records it in the history.
// @access  Private + step-up
router.post('/devices/revoke-others', sensitiveLimiter, requireStepUp, async (req, res) => {
  try {
    const revoked = await revokeOtherUserSessions(req.user._id, req.sessionId);
    await SecurityEvent.write({
      user: req.user._id, type: 'sessions-revoked-all', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: `${revoked} other ${revoked === 1 ? 'session' : 'sessions'} signed out`,
    });
    res.json({
      revoked,
      message: revoked > 0
        ? `Signed out ${revoked} other ${revoked === 1 ? 'device' : 'devices'}.`
        : 'No other active sessions were found.',
    });
  } catch (error) {
    console.error('[security/devices/revoke-others]', error.message);
    res.status(500).json({ message: 'Could not sign out your other devices.' });
  }
});

// @route   GET /api/security/events
// @desc    This account's own security history, newest first, for the login
//          activity + recent activity panels. Owner-scoped.
// @access  Private
router.get('/events', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const events = await SecurityEvent.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      events: events.map((e) => ({
        id: String(e._id),
        type: e.type,
        success: e.success,
        ip: e.ip,
        location: e.location,
        userAgent: e.userAgent,
        reason: e.reason,
        createdAt: e.createdAt,
      })),
    });
  } catch (error) {
    console.error('[security/events]', error.message);
    res.status(500).json({ message: 'Could not load your security activity.' });
  }
});

// @route   POST /api/security/backup-codes/generate
// @desc    Mint a new set of single-use recovery codes. Requires step-up. The
//          previous set is destroyed in the same operation. Plaintext codes are
//          returned exactly once — only their hashes are ever stored.
// @access  Private + step-up
router.post('/backup-codes/generate', sensitiveLimiter, requireStepUp, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('twoFactorEnabled twoFactorMethod');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    if (!user.twoFactorEnabled) {
      return res.status(409).json({ message: 'Turn on two-factor authentication before creating recovery codes.' });
    }

    const { codes } = await BackupCode.generate(user._id);

    await SecurityEvent.write({
      user: user._id, type: 'backup-codes-generated', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: `${codes.length} recovery codes issued`,
    });
    try {
      const UserNotification = require('../models/UserNotification');
      await UserNotification.create({
        user: user._id, type: 'info', title: 'Backup codes generated',
        detail: 'New recovery codes were generated for your account. If you did not do this, change your password and contact support.',
      }).catch(() => {});
    } catch { /* best-effort */ }

    res.json({
      codes,
      message: 'Save these codes somewhere safe. They are shown once and cannot be retrieved later.',
    });
  } catch (error) {
    console.error('[security/backup-codes/generate]', error.message);
    res.status(500).json({ message: 'Could not create recovery codes.' });
  }
});

// @route   DELETE /api/security/backup-codes
// @desc    Destroy every unused recovery code.
// @access  Private + step-up
router.delete('/backup-codes', sensitiveLimiter, requireStepUp, async (req, res) => {
  try {
    const removed = await BackupCode.invalidateAll(req.user._id);
    await SecurityEvent.write({
      user: user._id, type: 'backup-codes-invalidated', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: `${removed} recovery codes invalidated`,
    });
    res.json({ removed, message: 'All recovery codes have been invalidated.' });
  } catch (error) {
    console.error('[security/backup-codes DELETE]', error.message);
    res.status(500).json({ message: 'Could not invalidate your recovery codes.' });
  }
});

// ── Recovery email ─────────────────────────────────────────────────────────

// Pending confirmations, keyed by user. In-memory like the existing
// email-change proof: single-use, short-lived, and a restart simply asks the
// user to request a new code. The address is NOT written to the user until it
// is verified, so an unproven value can never be read back.
const recoveryEmailProofs = new Map(); // userId -> { email, otp, expiresAt }
const RECOVERY_PROOF_TTL_MS = 15 * 60 * 1000;

function maskLocal(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${String(user).slice(0, 2)}***@${domain}`;
}

// @route   POST /api/security/recovery-email/request
// @desc    Send a confirmation code to a candidate recovery address. The
//          address is not stored until verified, and it can never be used to
//          sign in — a recovery address that grants access is a second
//          password.
// @access  Private + step-up
router.post('/recovery-email/request', sensitiveLimiter, requireStepUp, async (req, res) => {
  try {
    const email = str(req.body?.email).trim().toLowerCase();
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: 'Enter a valid recovery email address.' });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    if (email === user.email) {
      return res.status(400).json({ message: 'That is already your account email.' });
    }
    if (email === user.recoveryEmail && user.recoveryEmailVerifiedAt) {
      return res.status(409).json({ message: 'That recovery email is already verified.' });
    }
    const taken = await User.findOne({ email, _id: { $ne: user._id } }).select('_id').lean();
    if (taken) {
      // Deliberately does not confirm the address belongs to an account.
      return res.status(400).json({ message: 'That address cannot be used as a recovery email.' });
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    recoveryEmailProofs.set(String(user._id), { email, otp, expiresAt: Date.now() + RECOVERY_PROOF_TTL_MS });

    // Background delivery; a failure drops the proof so the address can never
    // be "verified" by someone who never proved they receive mail there.
    setTimeout(() => {
      sendOtpEmail(email, otp, 'recovery').catch(() => {
        recoveryEmailProofs.delete(String(user._id));
      });
    }, 0);

    res.json({ message: `We sent a confirmation code to ${email}.` });
  } catch (error) {
    console.error('[security/recovery-email/request]', error.message);
    res.status(500).json({ message: 'Could not send the confirmation code.' });
  }
});

// @route   POST /api/security/recovery-email/verify
// @desc    Confirm the candidate address and activate it. Always notifies the
//          PRIMARY account email, because a silent change here is the one
//          thing an attacker with a live session could do without the owner
//          noticing. The primary address itself is never read back or changed.
// @access  Private
router.post('/recovery-email/verify', sensitiveLimiter, async (req, res) => {
  try {
    const code = str(req.body?.code).trim();
    const key = String(req.user._id);
    const proof = recoveryEmailProofs.get(key);
    if (!proof) return res.status(400).json({ message: 'Request a new confirmation code.' });
    if (Date.now() > proof.expiresAt) {
      recoveryEmailProofs.delete(key);
      return res.status(400).json({ message: 'That code has expired. Request a new one.' });
    }
    if (code !== proof.otp) {
      return res.status(400).json({ message: 'That confirmation code is not correct.' });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Account not found.' });

    recoveryEmailProofs.delete(key); // single-use
    user.recoveryEmail = proof.email;
    user.recoveryEmailVerifiedAt = new Date();
    await user.save();

    await SecurityEvent.write({
      user: user._id, type: 'recovery-email-changed', success: true,
      ip: req.ip, userAgent: req.get('user-agent'), reason: 'Recovery email set',
    });

    try {
      const UserNotification = require('../models/UserNotification');
      await UserNotification.create({
        user: user._id, type: 'info', title: 'Recovery email changed',
        detail: `Your recovery email was set to ${maskLocal(proof.email)}. If this was not you, change your password and contact support immediately.`,
      }).catch(() => {});
      if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
        await sendStatusEmail(user.email, 'recovery-email', { address: maskLocal(proof.email) }).catch(() => {});
      }
    } catch { /* best-effort */ }

    res.json({ message: 'Recovery email verified.' });
  } catch (error) {
    console.error('[security/recovery-email/verify]', error.message);
    res.status(500).json({ message: 'Could not verify that code.' });
  }
});

// @route   DELETE /api/security/recovery-email
// @desc    Remove the recovery email. Requires step-up.
// @access  Private + step-up
router.delete('/recovery-email', sensitiveLimiter, requireStepUp, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    if (!user.recoveryEmail) return res.status(409).json({ message: 'No recovery email is set.' });

    user.recoveryEmail = '';
    user.recoveryEmailVerifiedAt = null;
    await user.save();
    recoveryEmailProofs.delete(String(req.user._id));

    await SecurityEvent.write({
      user: user._id, type: 'recovery-email-changed', success: true,
      ip: req.ip, userAgent: req.get('user-agent'), reason: 'Recovery email removed',
    });
    res.json({ message: 'Recovery email removed.' });
  } catch (error) {
    console.error('[security/recovery-email DELETE]', error.message);
    res.status(500).json({ message: 'Could not remove your recovery email.' });
  }
});

module.exports = router;
