'use strict';

/**
 * Password recovery — the link-based flow.
 *
 *   GET  /api/auth/password-reset/rules       the policy, for the live checklist
 *   POST /api/auth/password-reset/request     ask for a link
 *   GET  /api/auth/password-reset/validate    is this link still usable?
 *   POST /api/auth/password-reset/complete    set the new password
 *
 * Mounted here rather than inside routes/auth.js because routes/auth.js is
 * already ~2100 lines and this is a self-contained flow with its own rate-limit
 * budget, its own model and its own email. The four legacy OTP endpoints remain
 * in routes/auth.js as thin aliases onto the same service, so an old client
 * (or a stale test) still completes a reset instead of hitting a 404.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const service = require('../utils/passwordReset');
const { describePasswordRules } = require('../utils/passwordRules');
const { limitReachedHandler } = require('../utils/lockout');
const { isTransientInfrastructureError } = require('../utils/transientError');

const router = express.Router();

// The generic answers for infrastructure trouble. `/request` deliberately does
// NOT use these (it must look identical whether or not the account exists), and
// that asymmetry is commented at the call site.
const TRANSIENT_MESSAGE = 'We could not reach our servers just now. Please try again in a moment.';
const UNEXPECTED_MESSAGE = 'Something went wrong. Please try again later.';

// Budgets are per-IP and generous enough that a household sharing one address
// never trips them, tight enough that mail-bombing a victim's inbox is not
// worth it. The per-account cooldown in the service is the real rate limit.
const requestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many reset links requested from this device. Please wait a few minutes and try again.' },
  handler: limitReachedHandler('Too many reset links requested. Lockout escalated — please wait and try again.'),
});

const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts on this reset link. Please request a new one.' },
  handler: limitReachedHandler('Too many attempts on a reset link. Lockout escalated — please wait and try again.'),
});

router.use(requestLimiter);

/** Shared error tail: honest about our outages, mute about everything else. */
function fail(res, error, context) {
  console.error(`[${context}]`, error.message);
  if (isTransientInfrastructureError(error)) {
    res.set('Retry-After', '5');
    return res.status(503).json({ message: TRANSIENT_MESSAGE });
  }
  return res.status(500).json({ message: UNEXPECTED_MESSAGE });
}

// ── The policy, so the client checklist cannot drift from the server ─────────
// Not rate-limited: it is static, public, and reveals nothing. The cheap
// limiter above still applies, which is plenty.
router.get('/rules', (req, res) => {
  res.json(describePasswordRules());
});

/**
 * Ask for a reset link.
 *
 * Returns 200 with the same body whether or not the address has an account, and
 * whether or not the mail went out. See requestReset() for why that is the
 * point rather than a limitation.
 */
router.post('/request', async (req, res) => {
  try {
    const result = await service.requestReset({ email: req.body?.email, req });
    return res.status(result.status).json({ message: result.message });
  } catch (error) {
    return fail(res, error, 'password-reset/request');
  }
});

/**
 * Is this link still usable?
 *
 * Checks nothing else and never consumes the grant, so the reset page can say
 * "this link expired" instead of showing a password form that is guaranteed to
 * fail. The token travels as a query parameter because that is what the emailed
 * link is; nothing is written to the response body, and the 200/400 split
 * describes only the token the caller already holds.
 */
router.get('/validate', async (req, res) => {
  try {
    const token = typeof req.query?.token === 'string' ? req.query.token : '';
    const result = await service.validateToken(token);
    if (!result.valid) {
      return res.status(400).json({ valid: false, reason: result.reason || 'invalid', message: result.message });
    }
    return res.json({ valid: true, expiresAt: result.expiresAt });
  } catch (error) {
    return fail(res, error, 'password-reset/validate');
  }
});

/**
 * Redeem the link and set the new password.
 *
 * The token is read from the body, never the query string: a body does not end
 * up in access logs, browser history, or a Referer header, and this is a
 * credential.
 */
router.post('/complete', redeemLimiter, async (req, res) => {
  try {
    const token = req.body?.token;
    const newPassword = req.body?.newPassword;
    if (typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ message: 'This page needs a reset link. Request a new one below.' });
    }
    if (typeof newPassword !== 'string' || !newPassword) {
      return res.status(400).json({ message: 'Please enter a new password.' });
    }

    const result = await service.completeWithToken({ token, newPassword, req });
    return res.status(result.status).json({ message: result.message, success: !!result.success });
  } catch (error) {
    return fail(res, error, 'password-reset/complete');
  }
});

module.exports = router;
