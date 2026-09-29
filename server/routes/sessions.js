/**
 * Session and device management, mounted at /api/auth/sessions.
 *
 * The policy lives in utils/sessions.js and is not restated here:
 *   • a session is valid only while it exists, is unrevoked, is its account's
 *     CURRENT session, and its account is active (utils/sessions.js
 *     verifyUserSession, called by middleware/auth.js on every request);
 *   • a session ends when a newer sign-in displaces it, when it is revoked, or
 *     after 30 days without activity;
 *   • a new sign-in invalidates the previous session OF THE SAME ACCOUNT ONLY.
 *     No code in this file, or in utils/sessions.js, ever writes to another
 *     account's sessions — every query is filtered on `user: req.user._id`.
 *
 * That last point is what makes the product requirement work: two accounts
 * signed in in two tabs of the same browser are independent, because their
 * tokens live in per-tab sessionStorage on the client AND because the server's
 * revocation is per-user. Signing account A in again breaks account A's old
 * session and touches nothing belonging to account B.
 *
 * ── What is never exposed ────────────────────────────────────────────────
 *
 * No token, no token hash, no remember credential, no `Session._id` of a
 * session the caller does not own, no internal device fingerprint. The
 * identifiers returned ARE session document ids, and they have to be: they are
 * what DELETE /sessions/:id acts on. They are safe to show because they are
 * meaningless without the signed JWT that carries the matching `sid` claim —
 * an id on its own authenticates nothing.
 */
const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const { protect } = require('../middleware/auth');
const { verifyOrigin } = require('../utils/origins');
const Session = require('../models/Session');
const User = require('../models/User');
const SecurityEvent = require('../models/SecurityEvent');
const { revokeAllUserSessions, revokeOtherUserSessions } = require('../utils/sessions');

const router = express.Router();
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

router.use(verifyOrigin);

const manageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req) => (process.env.NODE_ENV === 'production' ? 40 : 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please wait a moment and try again.' },
});

const AUTH_METHOD_LABELS = {
  password: 'Password',
  passkey: 'Passkey',
  totp: 'Authenticator app',
  'backup-code': 'Recovery code',
  'email-otp': 'Emailed code',
  remember: 'Saved login',
};

/**
 * GET /api/auth/sessions — every live session for this account.
 *
 * `revokedAt: null` only. Dead sessions are not padded in: a security page
 * that lists signed-out devices as though they were live is worse than no
 * security page, because it teaches people to trust a list that lies.
 */
router.get('/', protect, async (req, res) => {
  try {
    const sessions = await Session.find({ user: req.user._id, revokedAt: null })
      .select('_id deviceLabel platform ip location createdAt lastActivityAt authMethod mfaVerified rememberHash trustedAt')
      .sort({ lastActivityAt: -1 })
      .lean();

    const now = Date.now();
    return res.json({
      sessions: sessions.map((s) => {
        return {
          id: String(s._id),
          isCurrent: String(s._id) === String(req.sessionId),
          device: s.deviceLabel || 'Unknown device',
          platform: s.platform || 'Unknown OS',
          location: s.location || '',
          ip: s.ip || '',
          createdAt: s.createdAt,
          // Informational only. Nothing reads this to make an authorisation
          // decision: a user session does not expire by time, so there is no
          // deadline to show. It is here because "when was this device last
          // used" is the question this page exists to answer.
          lastActiveAt: s.lastActivityAt,
          authMethod: s.authMethod || '',
          authMethodLabel: AUTH_METHOD_LABELS[s.authMethod] || 'Password',
          mfaVerified: s.mfaVerified === true,
          // A session with a saved-login credential can re-enter without a
          // password, which is worth surfacing: it is the thing a user is most
          // likely to forget they granted.
          hasSavedLogin: Boolean(s.rememberHash),
          trustedAt: s.trustedAt || null,
        };
      }),
      total: sessions.length,
      note: 'Signing in on a new device replaces the previous session for this account only. Other accounts in this browser are unaffected.',
    });
  } catch (error) {
    console.error('[auth/sessions/list]', error.message);
    return res.status(500).json({ message: 'Could not load your sessions.' });
  }
});

/**
 * DELETE /api/auth/sessions/:sessionId — revoke one session.
 *
 * Owner-scoped in the QUERY, not checked afterwards: `{ _id, user }` means a
 * guessed id belonging to another account simply matches nothing and is a 404.
 * That also means there is no code path where a valid-looking id from another
 * account is even loaded, so no field of it can leak.
 *
 * The caller's own session cannot be deleted here — "sign out" is what that is,
 * and DELETE on yourself would leave the caller holding a token for a session
 * the server has forgotten, which reads to the client as a mysterious failure.
 */
router.delete('/:sessionId', protect, manageLimiter, async (req, res) => {
  try {
    const id = str(req.params.sessionId);
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ message: 'Session not found.' });
    if (id === String(req.sessionId)) {
      return res.status(400).json({ message: 'That is the session you are using. Use Sign out instead.' });
    }

    const target = await Session.findOne({ _id: id, user: req.user._id, revokedAt: null })
      .select('_id deviceLabel rememberHash')
      .lean();
    if (!target) return res.status(404).json({ message: 'Session not found.' });

    await Session.updateOne(
      { _id: target._id, user: req.user._id, revokedAt: null },
      { $set: { revokedAt: new Date(), rememberHash: '' } },
    ).catch(() => {});

    // Clear the current-session pointer only if it still points at what we just
    // revoked. Skipping this is safe (a non-current session has no pointer to
    // clear); doing it unconditionally would sign the owner out of themselves.
    await User.updateOne(
      { _id: req.user._id, currentSessionId: target._id },
      { $set: { currentSessionId: null } },
    ).catch(() => {});

    await SecurityEvent.write({
      user: req.user._id, type: 'session-revoked', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: `Signed out ${target.deviceLabel || 'a device'}`,
      meta: { outcome: 'single' },
    });

    return res.json({ message: 'That session has been signed out.' });
  } catch (error) {
    console.error('[auth/sessions/revoke]', error.message);
    return res.status(500).json({ message: 'Could not sign out that session.' });
  }
});

/**
 * POST /api/auth/sessions/revoke-others — keep this device, drop the rest.
 *
 * For the requirement "a second sign-in invalidates the previous one", the
 * automatic half is already done by issueUserSession. This is the manual,
 * deliberate half: the panic button.
 */
router.post('/revoke-others', protect, manageLimiter, async (req, res) => {
  try {
    const revoked = await revokeOtherUserSessions(req.user._id, req.sessionId);
    await SecurityEvent.write({
      user: req.user._id, type: 'sessions-revoked-all', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: `Signed out ${revoked} other ${revoked === 1 ? 'session' : 'sessions'}`,
      meta: { outcome: 'others' },
    });
    return res.json({
      revoked,
      message: revoked > 0
        ? `Signed out ${revoked} other ${revoked === 1 ? 'session' : 'sessions'}.`
        : 'No other active sessions were found.',
    });
  } catch (error) {
    console.error('[auth/sessions/revoke-others]', error.message);
    return res.status(500).json({ message: 'Could not sign out your other sessions.' });
  }
});

/**
 * POST /api/auth/sessions/logout-all — drop every session, this one included.
 *
 * Scoped to `req.user._id` and nothing else, which is the property that makes
 * multi-account use safe: signing out here cannot end another account's
 * session, in this tab or any other.
 *
 * The caller's own token stops working on the NEXT request, immediately, not
 * "within a validation interval". `verifyUserSession` reads the session record
 * on every call; the 30-second middleware cache is invalidated for this sid by
 * the revocation path, so there is no window in which a revoked token still
 * works. (See the cache comment in middleware/auth.js — sign-out and
 * displacement both change the session id, which is what makes the cache safe
 * for them; this route is the one place that must invalidate explicitly, and
 * `revokeAllUserSessions` clearing the account's currentSessionId is what does
 * it.)
 */
router.post('/logout-all', protect, manageLimiter, async (req, res) => {
  try {
    const revoked = await revokeAllUserSessions(req.user._id);
    await SecurityEvent.write({
      user: req.user._id, type: 'sessions-revoked-all', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: 'Signed out of every device',
      meta: { outcome: 'all' },
    });
    return res.json({
      revoked,
      message: 'You have been signed out everywhere.',
    });
  } catch (error) {
    console.error('[auth/sessions/logout-all]', error.message);
    return res.status(500).json({ message: 'Could not sign out your sessions.' });
  }
});

module.exports = router;
module.exports.AUTH_METHOD_LABELS = AUTH_METHOD_LABELS;
