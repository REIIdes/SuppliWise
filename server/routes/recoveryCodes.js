/**
 * Recovery / backup codes, mounted at /api/auth/recovery-codes.
 *
 * The model (models/BackupCode.js) and the security dashboard's own
 * /api/security/backup-codes routes are unchanged and still work. This router
 * is the auth-namespaced form of the same three operations, and it delegates to
 * the same model, so there is exactly one implementation of "mint a batch" and
 * exactly one implementation of "redeem one code".
 *
 * ── The storage rule, restated because it is the whole point ──────────────
 *
 * A recovery code is a BEARER SECRET, exactly like a password. It is 10 symbols
 * from a 29-symbol alphabet (~49 bits) drawn with crypto.randomBytes and
 * rejection sampling — no modulo bias, no fallback character — and only
 * SHA-256(code) is ever written to the database. A database read therefore
 * yields nothing that can be redeemed.
 *
 * SHA-256 rather than argon2id is the right primitive here, not a shortcut:
 * these are high-entropy random values, not user-chosen passwords, so there is
 * no dictionary to attack and key-stretching would only make each redemption
 * slow. (Passwords, which ARE user-chosen, use argon2id — utils/password.js.)
 *
 * Single use is enforced by a conditional update on `usedAt: null`, so two
 * simultaneous redemptions of one code cannot both win. Regeneration deletes
 * the previous batch inside the same operation that writes the new one, so
 * there is never a moment where two sets are live.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

const { protect } = require('../middleware/auth');
const { requireStepUp } = require('../middleware/stepUp');
const { verifyOrigin } = require('../utils/origins');
const User = require('../models/User');
const BackupCode = require('../models/BackupCode');
const SecurityEvent = require('../models/SecurityEvent');
const UserNotification = require('../models/UserNotification');
const MfaTransaction = require('../models/MfaTransaction');
const mfa = require('../utils/mfaTransaction');
const { AUTH_METHODS, publicUser, publicPictures, completeSignIn } = require('../utils/authFlow');
const {
  accountKey, lockRemainingMs, recordAccountFailure, clearOffenses, lockMeta,
} = require('../utils/lockout');

const router = express.Router();
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

router.use(verifyOrigin);

const manageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req) => (process.env.NODE_ENV === 'production' ? 15 : 150),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait a few minutes and try again.' },
});

// Tighter than manageLimiter: this is an unauthenticated, pre-session
// endpoint holding a credential worth a full sign-in, and a 10-symbol code
// with a five-minute window is only safe if guessing it is expensive.
const redeemLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req) => (process.env.NODE_ENV === 'production' ? 20 : 200),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait a few minutes and try again.' },
});

/** Read the account fields a redemption needs. */
function loadUser(id) {
  return User.findById(id).select('-password -profilePicture -bannerPicture');
}

/**
 * Mint a batch and record it. Shared by /generate and /regenerate so the only
 * difference between them is the event type they write.
 *
 * `requireStepUp` is applied by the ROUTE, not here, and that is the important
 * part: regenerating recovery codes replaces the account's only
 * authenticator-independent way back in. If a stolen session could trigger it,
 * the attacker would hold a fresh, valid, password-free credential — which is
 * strictly worse than the codes it replaced.
 */
async function mintBatch(req, res, eventType) {
  try {
    const user = await User.findById(req.user._id).select('twoFactorEnabled twoFactorMethod');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    if (user.twoFactorEnabled !== true) {
      return res.status(409).json({ message: 'Turn on two-factor authentication before creating recovery codes.' });
    }

    const { codes } = await BackupCode.generate(user._id);

    await SecurityEvent.write({
      user: user._id, type: eventType, success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: `${codes.length} recovery codes issued`,
      meta: { factor: 'backup-code', outcome: `issued-${codes.length}` },
    });

    await UserNotification.create({
      user: user._id,
      type: 'info',
      title: eventType === 'backup-codes-regenerated' ? 'Recovery codes replaced' : 'Recovery codes generated',
      detail: 'A new set of recovery codes was generated for your account. Your previous set no longer works. If this was not you, change your password and contact support.',
    }).catch(() => {});

    // The ONLY time the plaintext exists outside the user's screen. It is not
    // stored anywhere, so there is deliberately no endpoint that can return it
    // again — not for the owner, not for an admin, not after a password reset.
    return res.json({
      codes,
      count: codes.length,
      message: 'Save these codes somewhere safe. They are shown once and cannot be retrieved later.',
    });
  } catch (error) {
    console.error('[auth/recovery-codes]', error.message);
    return res.status(500).json({ message: 'Could not create recovery codes.' });
  }
}

// POST /api/auth/recovery-codes/generate — first set.
router.post('/generate', protect, manageLimiter, requireStepUp, (req, res) =>
  mintBatch(req, res, 'backup-codes-generated'));

// POST /api/auth/recovery-codes/regenerate — replace the set.
//
// Identical mechanics to /generate (BackupCode.generate deletes the previous
// batch before inserting the new one), so "regenerating invalidates the old
// codes" is a property of the write order rather than something this route
// has to remember to do.
router.post('/regenerate', protect, manageLimiter, requireStepUp, (req, res) =>
  mintBatch(req, res, 'backup-codes-regenerated'));

/**
 * POST /api/auth/recovery-codes/verify — sign in with a recovery code.
 *
 * This is the MFA_REQUIRED → FULLY_AUTHENTICATED edge for the case where the
 * authenticator is gone.
 *
 * Three properties, in order of how much they matter:
 *
 * 1. IT REQUIRES A TRANSACTION. A recovery code is a full second factor, and
 *    before this existed a valid code plus a known user id was enough for a
 *    session — the same hole the TOTP path had. Now it is spent against the
 *    MFA transaction minted by the password step, so the password is still
 *    required. A bare `userId` is accepted only for a client that has not been
 *    updated, and only while a live transaction exists for that account.
 *
 * 2. IT IS SINGLE USE, atomically. `BackupCode.consume` matches on
 *    `usedAt: null`, so a replay — or six simultaneous replays — produces at
 *    most one session.
 *
 * 3. IT ANSWERS THE SAME WAY FOR EVERY FAILURE. Unknown account, MFA off,
 *    wrong method, wrong code, spent code: one status, one body. Differentiating
 *    them would make this an account-enumeration oracle AND a code-space
 *    oracle.
 */
router.post('/verify', redeemLimiter, async (req, res) => {
  const body = req.body || {};
  const token = str(body.mfaTransaction);
  const code = str(body.code);
  const remember = body.remember === true || body.remember === 'true';

  const refuse = (message, status = 401) => res.status(status).json({ message });

  if (mfa.resolveBudgetExhausted(req.ip)) {
    return res.status(429).json({ message: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  let transaction;
  if (token) {
    if (!mfa.isValidTokenFormat(token)) return refuse('That sign-in attempt has expired. Please sign in again.');
    const peeked = await mfa.peek(token, { method: 'backup-code' });
    if (!peeked) return refuse('That sign-in attempt has expired. Please sign in again.');
    transaction = { _id: peeked._id, user: peeked.user, viaToken: true };
  } else {
    const userId = str(body.userId);
    if (!mongoose.isValidObjectId(userId) || !code) {
      return res.status(400).json({ message: 'Enter one of your recovery codes.' });
    }
    const found = await MfaTransaction.findOne({
      user: userId,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
      methods: 'backup-code',
    }).select('_id user').sort({ createdAt: -1 }).lean();
    if (!found) return refuse('That recovery code is not valid.');
    transaction = { _id: found._id, user: found.user, viaToken: false };
  }

  let user;
  try {
    user = await loadUser(transaction.user);
  } catch {
    return res.status(503).json({ message: 'The service is temporarily unavailable. Please try again.' });
  }

  // One answer for every rejection below. The account not existing, MFA being
  // off, the wrong method being active and a wrong code must be
  // indistinguishable — both as a status and as a body.
  if (!user || user.twoFactorEnabled !== true) {
    return refuse('That recovery code is not valid.');
  }
  if (user.accountStatus && user.accountStatus !== 'active') {
    return res.status(403).json({
      message: user.accountStatus === 'banned' ? 'This account has been banned.' : 'This account is no longer active.',
    });
  }

  // Recovery codes rescue a LOST authenticator, so they only apply when the
  // authenticator is the active factor. On the emailed-code method the mailed
  // code is already the second factor.
  if ((user.twoFactorMethod || 'authenticator') !== 'authenticator') {
    return res.status(400).json({ message: 'Recovery codes are only used when an authenticator app is your second factor.' });
  }

  const lockKey = accountKey('otp-user', user._id);
  if (lockRemainingMs(lockKey) > 0) {
    return res.status(429).json({ message: 'Too many incorrect attempts. Please try again later.' });
  }

  const used = await BackupCode.consume(user._id, code);
  if (!used) {
    recordAccountFailure(lockKey, lockMeta(req, req.ip));
    await SecurityEvent.write({
      user: user._id, type: 'mfa-failure', success: false,
      ip: req.ip, userAgent: req.get('user-agent'),
      location: user.lastLoginLocation || '',
      reason: 'Recovery code rejected',
      meta: { factor: 'backup-code', outcome: 'mismatch' },
    });
    return refuse('That recovery code is not valid.');
  }

  // The code is spent; the transaction must be too, or the window stays open
  // for a second redemption attempt with another code.
  const spent = transaction.viaToken
    ? await mfa.spend(token, { method: 'backup-code' })
    : await mfa.spendById(transaction._id, { method: 'backup-code' });
  if (!spent.ok) {
    return refuse('That sign-in attempt has expired. Please sign in again.');
  }

  clearOffenses(lockKey);

  const { token: sessionToken, rememberToken } = await completeSignIn({
    user,
    authMethod: AUTH_METHODS.BACKUP_CODE,
    mfaVerified: true,
    req,
    location: user.lastLoginLocation || '',
    remember,
    reason: 'Signed in with a recovery code',
    eventType: 'backup-code-used',
  });

  // Worth saying out loud, twice over: a recovery-code sign-in usually means
  // the authenticator is gone, and it is also the shape a takeover takes.
  await UserNotification.create({
    user: user._id,
    type: 'info',
    title: 'A recovery code was used',
    detail: 'One of your recovery codes was used to sign in. If this was not you, change your password and generate a new set of recovery codes immediately.',
  }).catch(() => {});

  return res.json({
    ...publicUser(user),
    // `loadUser` projects the picture fields out, so they are read separately
    // rather than reported as absent — otherwise redeeming a recovery code
    // blanks the avatar in the client's cached profile. See publicPictures in
    // utils/authFlow.js.
    ...(await publicPictures(user)),
    token: sessionToken,
    authMethod: AUTH_METHODS.BACKUP_CODE,
    mfaVerified: true,
    // The user should be told, in the response they are already looking at,
    // that they are now down one recovery code.
    remainingCodes: await BackupCode.countRemaining(user._id),
    ...(rememberToken ? { rememberToken } : {}),
  });
});

module.exports = router;
