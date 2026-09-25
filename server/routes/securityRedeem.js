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
const { verifyTotpOnce } = require('../utils/totp');
const { issueUserSession, attachRememberToken, markSessionTrusted } = require('../utils/sessions');
const { describeDevice } = require('../utils/device');
const { describeSubscription } = require('../utils/entitlements');
const { sendStatusEmail } = require('../utils/email');
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
      const userId = str(req.body?.userId);
      const code = str(req.body?.code);
      if (!mongoose.isValidObjectId(userId) || !code) {
        return res.status(400).json({ message: 'Enter one of your recovery codes.' });
      }

      const user = await User.findById(userId);
      if (!user || !user.twoFactorEnabled) {
        // Same answer as a wrong code — do not confirm the account exists.
        return res.status(401).json({ message: 'That recovery code is not valid.' });
      }

      const emailKey = accountKey('otp-user', userId);
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
      const token = await issueUserSession(user._id, describeDevice({
        userAgent: req.get('user-agent'), ip: req.ip,
        location: user.lastLoginLocation || '',
      }));

      let rememberToken = '';
      if (req.body?.remember === true || req.body?.remember === 'true') {
        try { rememberToken = await attachRememberToken(token); } catch { rememberToken = ''; }
      }
      if (rememberToken) await markSessionTrusted(token).catch(() => {});

      await SecurityEvent.write({
        user: user._id, type: 'backup-code-used', success: true,
        ip: req.ip, userAgent: req.get('user-agent'),
        location: user.lastLoginLocation || '',
        reason: 'Signed in with a recovery code',
      });
      await SecurityEvent.write({
        user: user._id, type: 'login-success', success: true,
        ip: req.ip, userAgent: req.get('user-agent'),
        location: user.lastLoginLocation || '',
        reason: 'Recovery code sign-in',
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
        profilePicture: user.profilePicture,
        twoFactorEnabled: user.twoFactorEnabled,
        twoFactorMethod: user.twoFactorMethod,
        subscriptionActive: user.subscriptionActive,
        subscriptionPlan: user.subscriptionPlan,
        subscription: describeSubscription(user),
        token,
        ...(rememberToken ? { rememberToken } : {}),
      });
    } catch (error) {
      console.error('[security/backup-codes/redeem]', error.message);
      return res.status(500).json({ message: 'Could not verify that recovery code.' });
    }
  });
};
