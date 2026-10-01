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
const recovery = require('../utils/passwordRecovery');
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

// For the alternative recovery proofs (recovery code, authenticator, passkey).
//
// Tighter than requestLimiter, and separate from it, for two reasons.
//
//   1. These are CREDENTIALS, not requests. A backup code is ~49 bits and a TOTP
//      code ~20 bits; both are only safe while guessing stays expensive. The
//      emailed path has a 256-bit token behind it and can afford a looser budget.
//   2. A separate bucket means exhausting one does not lock the others out. A
//      person who fat-fingers an authenticator code three times should still be
//      able to try a recovery code, and vice versa.
//
// The per-ACCOUNT lockout inside utils/passwordRecovery.js is the real
// protection and is unaffected by these per-IP budgets.
const factorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => (process.env.NODE_ENV === 'production' ? 12 : 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait a few minutes and try again.' },
  handler: limitReachedHandler('Too many recovery attempts. Lockout escalated — please wait and try again.'),
});

// Passkey ceremonies are two requests per attempt and the challenge is spent on
// the first, so they get their own budget rather than competing with the
// code-shaped methods above.
const passkeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => (process.env.NODE_ENV === 'production' ? 10 : 100),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many passkey attempts. Please wait a few minutes and try again.' },
  handler: limitReachedHandler('Too many passkey attempts. Lockout escalated — please wait and try again.'),
});

// ── Alternative recovery proofs ─────────────────────────────────────────────
//
// Registered BEFORE `router.use(requestLimiter)` further down, and that ordering
// is load-bearing. That middleware is the emailed path's budget — 10 requests
// per 15 minutes, sized for "ask for a link, maybe resend once". Applying it
// here as well would make the two paths share one bucket, so a person who
// fat-fingered an authenticator code could exhaust the quota that sends their
// recovery email, and vice versa. Express evaluates middleware in registration
// order, so being earlier is what excludes them; the wider /api/auth limiter in
// index.js still applies to all of them.
//
// Each handler is a thin translation of one service call into a status + message.
// The service decides what a refusal looks like — see utils/passwordRecovery.js
// for why every failure shares a single message.

/** Shared tail for a recovery-proof result. */
function sendResult(res, result) {
  const body = { message: result.message, success: !!result.success };
  // The grant token is returned in the BODY, never in the query string: a body
  // does not end up in access logs, browser history, or a Referer header, and
  // this is a credential. The client posts it straight back to /complete.
  if (result.resetToken) {
    body.resetToken = result.resetToken;
    body.expiresAt = result.expiresAt;
  }
  if (typeof result.remainingCodes === 'number') body.remainingCodes = result.remainingCodes;
  return res.status(result.status).json(body);
}

/**
 * POST /api/auth/password-reset/recovery-code
 *
 * Redeem one of the account's backup codes for a reset grant.
 */
router.post('/recovery-code', factorLimiter, async (req, res) => {
  try {
    return sendResult(res, await recovery.withRecoveryCode({
      email: req.body?.email,
      code: req.body?.code,
      req,
    }));
  } catch (error) {
    return fail(res, error, 'password-reset/recovery-code');
  }
});

/**
 * POST /api/auth/password-reset/authenticator
 *
 * Redeem a code from the account's authenticator app for a reset grant.
 */
router.post('/authenticator', factorLimiter, async (req, res) => {
  try {
    return sendResult(res, await recovery.withAuthenticatorCode({
      email: req.body?.email,
      code: req.body?.code,
      req,
    }));
  } catch (error) {
    return fail(res, error, 'password-reset/authenticator');
  }
});

/**
 * POST /api/auth/password-reset/passkey/options — step 1 of the ceremony.
 *
 * Identical in shape to a sign-in options request and deliberately so: the same
 * challenge is minted, and the account is discovered from the credential the
 * authenticator returns rather than from anything the client sends.
 */
router.post('/passkey/options', passkeyLimiter, async (req, res) => {
  try {
    return res.json(await recovery.passkeyOptions());
  } catch (error) {
    // WebAuthn not configured is a 503 from `config()`; distinguish it from a
    // genuine failure so the client can say "unavailable" rather than "try again".
    if (error && error.name === 'WebauthnConfigError') {
      console.error('[password-reset/passkey/options] WebAuthn is not configured:', error.message);
      return res.status(503).json({ message: 'Passkey recovery is not available on this server right now.' });
    }
    return fail(res, error, 'password-reset/passkey/options');
  }
});

/**
 * POST /api/auth/password-reset/passkey/verify — step 2.
 *
 * Verifies the assertion and, on success, mints the same grant the emailed link
 * would have produced.
 */
router.post('/passkey/verify', passkeyLimiter, async (req, res) => {
  try {
    return sendResult(res, await recovery.withPasskey({ response: req.body?.response, req }));
  } catch (error) {
    return fail(res, error, 'password-reset/passkey/verify');
  }
});

/**
 * POST /api/auth/password-reset/recovery-email
 *
 * Send the link to the account's verified secondary address instead. Answers
 * 200 with the same body whether or not the account exists or has one — see
 * withRecoveryEmail() for why that is not a limitation.
 */
router.post('/recovery-email', requestLimiter, async (req, res) => {
  try {
    const result = await recovery.withRecoveryEmail({ email: req.body?.email, req });
    return res.status(result.status).json({ message: result.message });
  } catch (error) {
    return fail(res, error, 'password-reset/recovery-email');
  }
});

/** Shared error tail: honest about our outages, mute about everything else. */
function fail(res, error, context) {
  console.error(`[${context}]`, error.message);
  if (isTransientInfrastructureError(error)) {
    res.set('Retry-After', '5');
    return res.status(503).json({ message: TRANSIENT_MESSAGE });
  }
  return res.status(500).json({ message: UNEXPECTED_MESSAGE });
}

// Everything BELOW this line is the emailed-link flow, and only that. Mounted
// here rather than at the top of the file so the recovery proofs above keep their
// own separate budgets — see the note on that section.
router.use(requestLimiter);

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
