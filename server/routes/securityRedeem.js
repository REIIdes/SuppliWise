/**
 * The one PUBLIC route in the security family: redeeming a backup recovery
 * code as the second factor at sign-in.
 *
 * It lives in its own file because it is registered on the router BEFORE the
 * blanket `protect` guard, and that ordering is the whole point. Folded into
 * routes/security.js it was silently unreachable — the guard answered every
 * legitimate recovery-code sign-in with NO_SESSION, because at that moment the
 * user has a password and a userId but no session yet.
 *
 * Everything else about it is the same discipline as the guarded routes:
 *   • rate limited,
 *   • locked out by the same account ladder as any other second factor,
 *   • identical 401 whether the account is unknown, MFA is off, or the code is
 *     wrong — so it cannot be used to probe for accounts,
 *   • only usable while the account's second factor really is the authenticator,
 *   • the code is single-use (BackupCode.consume is a conditional update).
 */
const mongoose = require('mongoose');

const User = require('../models/User');
const BackupCode = require('../models/BackupCode');
const SecurityEvent = require('../models/SecurityEvent');
const MfaTransaction = require('../models/MfaTransaction');
const mfa = require('../utils/mfaTransaction');
const { AUTH_METHODS, completeSignIn } = require('../utils/authFlow');
const { describeSubscription } = require('../utils/entitlements');
const { sendStatusEmail } = require('../utils/email');
// Keeps a not-yet-migrated inline picture from being shipped in this response.
const { safePictureValue } = require('../utils/pictures');
const {
  accountKey, lockRemainingMs, recordAccountFailure, clearOffenses, lockMeta,
} = require('../utils/lockout');

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

module.exports = function registerSecurityRedeem(router, { sensitiveLimiter }) {
  // @route   POST /api/security/backup-codes/redeem
  // @desc    Sign in with a single-use recovery code instead of an
  //          authenticator code. Completes the same session hand-off as
  //          /auth/login-2fa, so the two paths cannot drift apart.
  // @access  Public (pre-session, mid sign-in)
  router.post('/backup-codes/redeem', sensitiveLimiter, async (req, res) => {
    try {
      const token = str(req.body?.mfaTransaction);
      const userId = str(req.body?.userId);
      const code = str(req.body?.code);

      // A recovery code is a complete second factor, so this route used to take
      // a bare `userId` plus the code and issue a full session — which made the
      // second factor sufficient on its own, with the password never involved.
      //
      // `mfaTransaction` is now preferred, and `userId` is honoured only while
      // a live transaction exists for that account. A stale client still works
      // because it always comes through /auth/login first; the bypass is closed.
      let transaction = null;
      if (token) {
        if (!mfa.isValidTokenFormat(token)) {
          return res.status(400).json({ message: 'Enter one of your recovery codes.' });
        }
        const peeked = await mfa.peek(token, { method: 'backup-code' });
        if (!peeked) {
          return res.status(401).json({ message: 'That recovery code is not valid.' });
        }
        transaction = { _id: peeked._id, user: peeked.user, viaToken: true };
      } else {
        if (!mongoose.isValidObjectId(userId) || !code) {
          return res.status(400).json({ message: 'Enter one of your recovery codes.' });
        }
        const found = await MfaTransaction.findOne({
          user: userId,
          consumedAt: null,
          expiresAt: { $gt: new Date() },
          methods: 'backup-code',
        }).select('_id user').sort({ createdAt: -1 }).lean();
        if (!found) {
          // Same answer as a wrong code. Do not confirm the account exists, and
          // do not confirm that a sign-in is in progress.
          return res.status(401).json({ message: 'That recovery code is not valid.' });
        }
        transaction = { _id: found._id, user: found.user, viaToken: false };
      }

      if (!code) {
        return res.status(400).json({ message: 'Enter one of your recovery codes.' });
      }

      const user = await User.findById(transaction.user);
      if (!user || !user.twoFactorEnabled) {
        // Same answer as a wrong code — do not confirm the account exists.
        return res.status(401).json({ message: 'That recovery code is not valid.' });
      }

      const emailKey = accountKey('otp-user', user._id);
      const locked = lockRemainingMs(emailKey);
      if (locked > 0) {
        return res.status(429).json({ message: 'Too many incorrect attempts. Please try again later.' });
      }

      // Recovery codes are the fallback for a LOST authenticator, so they only
      // apply when the authenticator is the active factor. On the email method
      // the emailed code is already the second factor.
      const method = user.twoFactorMethod || 'authenticator';
      if (method !== 'authenticator') {
        return res.status(400).json({ message: 'Recovery codes are only used when an authenticator app is your second factor.' });
      }

      const used = await BackupCode.consume(user._id, code);
      if (!used) {
        recordAccountFailure(emailKey, lockMeta(req, req.ip));
        await SecurityEvent.write({
          user: user._id, type: 'mfa-failure', success: false,
          ip: req.ip, userAgent: req.get('user-agent'),
          location: user.lastLoginLocation || '',
          reason: 'Recovery code rejected',
        });
        return res.status(401).json({ message: 'That recovery code is not valid.' });
      }

      clearOffenses(emailKey);

      // Spend the transaction before any session exists, so a second
      // redemption attempt with another code cannot ride the same window.
      const spent = transaction.viaToken
        ? await mfa.spend(token, { method: 'backup-code' })
        : await mfa.spendById(transaction._id, { method: 'backup-code' });
      if (!spent.ok) {
        return res.status(401).json({ message: 'That recovery code is not valid.' });
      }

      // One active session per ACCOUNT: this displaces the account's previous
      // session and touches nothing belonging to any other account.
      const { token: sessionToken, rememberToken } = await completeSignIn({
        user,
        authMethod: AUTH_METHODS.BACKUP_CODE,
        mfaVerified: true,
        req,
        location: user.lastLoginLocation || '',
        remember: req.body?.remember === true || req.body?.remember === 'true',
        reason: 'Signed in with a recovery code',
        eventType: 'backup-code-used',
        extraEvent: { type: 'login-success', reason: 'Recovery code sign-in' },
      });

      // A recovery-code sign-in is worth telling the user about: it usually
      // means the authenticator is gone, and the next step is a new set.
      try {
        const UserNotification = require('../models/UserNotification');
        await UserNotification.create({
          user: user._id, type: 'info', title: 'A recovery code was used',
          detail: 'One of your recovery codes was used to sign in. If this was not you, change your password and generate a new set of recovery codes.',
        }).catch(() => {});
        if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
          await sendStatusEmail(user.email, 'new-device', {}).catch(() => {});
        }
      } catch { /* best-effort */ }

      return res.json({
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        name: user.fullName,
        email: user.email,
        dateOfBirth: user.dateOfBirth,
        age: user.age,
        gender: user.gender,
        profilePicture: safePictureValue(user.profilePicture),
        // Sent for the same reason, and it used to be missing here while every
        // other sign-in path sent it: an omitted field is indistinguishable
        // from "none" once the client caches this response as its profile.
        bannerPicture: safePictureValue(user.bannerPicture),
        twoFactorEnabled: user.twoFactorEnabled,
        twoFactorMethod: user.twoFactorMethod,
        subscriptionActive: user.subscriptionActive,
        subscriptionPlan: user.subscriptionPlan,
        subscription: describeSubscription(user),
        token: sessionToken,
        authMethod: AUTH_METHODS.BACKUP_CODE,
        mfaVerified: true,
        ...(rememberToken ? { rememberToken } : {}),
      });
    } catch (error) {
      console.error('[security/backup-codes/redeem]', error.message);
      return res.status(500).json({ message: 'Could not verify that recovery code.' });
    }
  });
};
