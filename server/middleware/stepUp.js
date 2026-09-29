/**
 * Re-authentication ("step up") — the gate on every sensitive security change.
 *
 * WHY IT IS ITS OWN MODULE
 * ------------------------
 * It started inside routes/security.js and was correct there, which is exactly
 * why it was a problem: the passkey, TOTP and recovery-code routers all need
 * the same gate, and copy-pasting it four times means four places to keep in
 * step. The one copy is here, and routes/security.js now imports it, so its
 * behaviour and its messages are unchanged for existing clients.
 *
 * ── The requirement it encodes ────────────────────────────────────────────
 *
 * Possessing a session is NOT permission to change how you authenticate. A
 * stolen access token is a bearer credential: it works from anywhere, forever,
 * until it is revoked — and the highest-value thing an attacker can do with one
 * is remove the account's second factor, mint fresh recovery codes, and add
 * their own passkey. Every one of those used to be reachable with a session
 * alone.
 *
 * A step-up token is a proof of RECENT possession: the account's password, plus
 * a live second factor when the account uses one. It is:
 *
 *   • short-lived      — 5 minutes, matching how long a person actually takes
 *                        to decide they meant to press that button;
 *   • session-bound    — the `sid` claim is compared against the caller's own
 *                        session, so a token stolen from one device does not
 *                        authorise a change from another, and a new sign-in
 *                        (which changes the session id) invalidates every
 *                        outstanding step-up;
 *   • user-bound       — the `id` claim is compared too, closing the
 *                        confused-deputy case where a valid token is replayed
 *                        into a different account's request;
 *   • purpose-pinned   — `purpose: 'step-up'`. A token minted for any other
 *                        purpose in this app — a password-reset grant, an admin
 *                        token, a session token — is refused here even though
 *                        it verifies against the same secret;
 *   • algorithm-pinned — HS256 explicitly, so `alg: none` and friends are not
 *                        negotiable.
 *
 * It is transported in the `X-Step-Up` request header, never in the body of a
 * state-changing request and never in a URL. The frontend holds it in React
 * state for the duration of one dialog and drops it when the dialog closes — it
 * is never written to localStorage or sessionStorage.
 */
const jwt = require('jsonwebtoken');

const STEP_UP_TTL_MS = 5 * 60 * 1000;
const STEP_UP_PURPOSE = 'step-up';

const REQUIRED_CODE = 'STEP_UP_REQUIRED';
const NEEDS_PASSWORD = 'Enter your current password to continue.';
const NEEDS_TOTP = 'Enter the 6-digit code from your authenticator app.';
const EXPIRED = 'Your confirmation expired. Please try again.';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Mint a step-up token for this user + session. */
function issue(userId, sid) {
  return jwt.sign(
    { sub: String(userId), id: String(userId), sid: String(sid), purpose: STEP_UP_PURPOSE },
    process.env.JWT_SECRET,
    { expiresIn: `${Math.floor(STEP_UP_TTL_MS / 1000)}s` },
  );
}

/**
 * Read the presented token from the header, or — for the one client shape that
 * cannot set headers — the body.
 */
function presented(req) {
  return str(req.get('x-step-up') || (req.body && req.body.stepUp));
}

/**
 * The gate. Answers 401 with `code: STEP_UP_REQUIRED` when there is no valid,
 * fresh, session-bound proof, and calls `next()` when there is.
 */
function requireStepUp(req, res, next) {
  const raw = presented(req);
  if (!raw) {
    return res.status(401).json({
      code: REQUIRED_CODE,
      message: 'Please confirm your identity again to change this setting.',
    });
  }

  let claims;
  try {
    claims = jwt.verify(raw, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    // Expired, tampered, or signed with something else — one answer for all
    // three, so this cannot be used to probe which.
    return res.status(401).json({ code: REQUIRED_CODE, message: EXPIRED });
  }

  if (claims.purpose !== STEP_UP_PURPOSE) {
    return res.status(401).json({ code: REQUIRED_CODE, message: EXPIRED });
  }
  if (String(claims.id) !== String(req.user._id) || String(claims.sid || '') !== String(req.sessionId || '')) {
    return res.status(401).json({ code: REQUIRED_CODE, message: EXPIRED });
  }

  req.stepUp = { at: claims.iat ? claims.iat * 1000 : Date.now(), id: String(claims.id) };
  return next();
}

/**
 * A step-up, or something stronger that the account already holds.
 *
 * Used on the passkey routes, where the natural re-authentication proof is a
 * passkey assertion rather than a password. The caller has already resolved
 * the account, so this stays a pure predicate over the request.
 */
function hasStepUp(req) {
  const raw = presented(req);
  if (!raw) return false;
  try {
    const claims = jwt.verify(raw, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (claims.purpose !== STEP_UP_PURPOSE) return false;
    if (String(claims.id) !== String(req.user._id)) return false;
    if (String(claims.sid || '') !== String(req.sessionId || '')) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  STEP_UP_TTL_MS,
  STEP_UP_PURPOSE,
  REQUIRED_CODE,
  NEEDS_PASSWORD,
  NEEDS_TOTP,
  EXPIRED,
  issue,
  presented,
  requireStepUp,
  hasStepUp,
};
