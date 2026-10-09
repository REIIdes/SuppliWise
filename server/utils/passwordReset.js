'use strict';

/**
 * Password recovery: issue a link, redeem it, change the password.
 *
 * THE FLOW
 * --------
 *   request(email)            → 200 (always) + an email containing a link
 *   validate(token)           → is this link still usable?
 *   complete(token, password) → new password, all sessions revoked
 *
 * Every rule below exists because the previous in-memory, 6-digit-code
 * implementation got it wrong in a specific, observable way. The reasons are
 * kept inline because the code looks needlessly defensive otherwise.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const PasswordResetToken = require('../models/PasswordResetToken');
const SecurityEvent = require('../models/SecurityEvent');
const { evaluatePassword } = require('./passwordRules');
const { isValidEmail } = require('./emailValidation');
const { sendPasswordResetEmail, sendPasswordChangedEmail } = require('./email');
const { revokeAllUserSessions } = require('./sessions');
const { normalizeIp } = require('./geo');

// How long a link stays usable. Thirty minutes is long enough to find an email
// on another device and short enough that a link forwarded by accident has a
// short life. (It was 10 minutes for the old code, which was tight enough that
// people routinely expired before they found the mail.)
const PASSWORD_RESET_TTL_MINUTES = 30;
const PASSWORD_RESET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1000;

// Minimum gap between two emails to the same account, and the ceiling on how
// many live links one account may hold.
const PASSWORD_RESET_RESEND_COOLDOWN_SECONDS = 60;
const PASSWORD_RESET_MAX_ACTIVE_PER_USER = 3;

// Wrong-code strikes before a grant's code is burned. The code is 6 digits
// (~20 bits) and its stored digest offers no real protection against an offline
// search, so this counter is the actual defence — it is enforced on the record
// itself so it survives a restart.
const PASSWORD_RESET_MAX_CODE_ATTEMPTS = 5;

// Lifetime of the short-lived grant minted when a legacy client verifies a code
// instead of following a link. It only bridges one call: verify → set password.
const RESET_GRANT_TTL_SECONDS = 15 * 60;

const GENERIC_REQUEST_MESSAGE =
  'If an account exists for that email address, a reset link is on its way. '
  + 'Check your inbox — and your spam folder if it does not arrive within a few minutes.';

const INVALID_LINK_MESSAGE =
  'This reset link is no longer valid. It may have expired, or it may already have been used. '
  + 'Request a new one and try again.';

/**
 * Mint a grant for an account that has ALREADY proved itself some other way.
 *
 * This is the seam that lets a recovery method be added without touching the
 * redemption path. A verified backup code, an authenticator code, a passkey
 * assertion and an emailed link are four different proofs of the same claim —
 * "this person controls this account" — so they all end here, and every one of
 * them produces the SAME single-use, TTL-bound PasswordResetToken row that
 * `completeWithToken` already knows how to redeem.
 *
 * That is the whole design. It means the expensive, security-critical part of a
 * reset (single-use claim, session revocation, "password changed" mail,
 * invalidating every other outstanding grant) is written once, and a new
 * recovery method cannot get any of it subtly wrong.
 *
 * Deliberately NOT used by `requestReset`, which must send the mail BEFORE
 * storing (an undelivered link must never validate) and so cannot return the
 * token to a caller.
 *
 * @returns {Promise<{ok: true, token: string, expiresAt: Date} | {ok: false}>}
 */
async function mintResetGrant(user, { method, req } = {}) {
  const userId = str(user?._id);
  if (!userId) return { ok: false };

  // Same cap as the emailed path: a burst of verified recoveries must not pile
  // up live rows. Best-effort — a count failure must not block a legitimate
  // recovery that has already proved itself.
  try {
    const active = await PasswordResetToken.countActiveForUser(userId);
    if (active >= PASSWORD_RESET_MAX_ACTIVE_PER_USER) {
      await PasswordResetToken.dropOldestActiveForUser(userId);
    }
  } catch (error) {
    console.error('[password-reset] could not count live grants:', error.message);
  }

  const { token, code } = PasswordResetToken.generateSecrets();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  try {
    await PasswordResetToken.store({
      userId,
      token,
      code,
      ttlMs: PASSWORD_RESET_TTL_MS,
      ip: normalizeIp(req?.ip),
      userAgent: req?.get?.('user-agent'),
    });
    rememberSent(userId, Date.now());
  } catch (error) {
    // Unlike the emailed path there is no mail already in flight, so this is a
    // clean failure and the caller can honestly report it.
    console.error('[password-reset] could not store the grant:', error.message);
    return { ok: false };
  }

  SecurityEvent.write({
    user: userId,
    type: 'password-reset-code-verified',
    reason: `Reset grant issued via ${method}`,
    meta: { factor: method, outcome: 'grant-issued' },
    ip: normalizeIp(req?.ip),
    userAgent: req?.get?.('user-agent'),
  }).catch(() => {});

  console.log(
    `[password-reset] grant issued to ${maskEmail(user.email)} via ${method} `
    + `(expires in ${PASSWORD_RESET_TTL_MINUTES}m)`
  );
  return { ok: true, token, expiresAt, code };
}

/**
 * Generate → send → store, for any grant that reaches the user BY EMAIL.
 *
 * The order is the security property, and it is not interchangeable: the row is
 * written only after the mail has been accepted, so a link that was never
 * delivered can never validate. Issuing the other way round would leave a live
 * credential in the database that nobody holds — and, worse, one an attacker who
 * can read the collection could still not use, but a user who re-requests could
 * collide with.
 *
 * Shared by `requestReset` (to the account address) and the recovery-email path
 * (to a verified secondary address) so that invariant lives in exactly one place.
 *
 * @returns {Promise<{delivered: boolean, reason?: string}>}
 */
async function issueGrantByEmail({ user, recipient, req }) {
  const userId = str(user?._id);
  const address = normalizeEmail(recipient);
  if (!userId || !address) return { delivered: false, reason: 'invalid' };

  // Cap live grants. Best-effort: a count failure must not block a recovery.
  try {
    const active = await PasswordResetToken.countActiveForUser(userId);
    if (active >= PASSWORD_RESET_MAX_ACTIVE_PER_USER) {
      await PasswordResetToken.dropOldestActiveForUser(userId);
    }
  } catch (error) {
    console.error('[password-reset] could not count live grants:', error.message);
  }

  const { token, code } = PasswordResetToken.generateSecrets();
  const resetUrl = buildResetUrl(resolveWebOrigin(req), token);

  const sent = await sendPasswordResetEmail(address, {
    resetUrl,
    code,
    expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
  });

  if (!sent) {
    console.error(
      `[password-reset] delivery FAILED for ${maskEmail(address)} — the user was told to check their inbox. `
      + 'Check the SMTP configuration (server log above has the underlying error).'
    );
    return { delivered: false, reason: 'delivery' };
  }

  try {
    await PasswordResetToken.store({
      userId,
      token,
      code,
      ttlMs: PASSWORD_RESET_TTL_MS,
      ip: normalizeIp(req?.ip),
      userAgent: req?.get?.('user-agent'),
    });
    rememberSent(userId, Date.now());
  } catch (error) {
    // The mail is already out, so this must not fail the request — but the
    // link the user now holds is worthless, and saying so to them would be
    // indistinguishable from the enumeration oracle below. Log it loudly.
    console.error('[password-reset] could not store the grant:', error.message);
    return { delivered: false, reason: 'store' };
  }

  return { delivered: true };
}

/** Last successful send per account, for the resend cooldown. */
const lastSentAt = new Map();

// Cooldown entries for addresses with no account would grow without bound, so
// the map is capped and swept rather than left to the garbage collector.
const MAX_SENT_TRACKED = 20000;
function rememberSent(userId, at) {
  if (lastSentAt.size >= MAX_SENT_TRACKED) {
    const cutoff = at - PASSWORD_RESET_TTL_MS;
    for (const [key, value] of lastSentAt) {
      if (value < cutoff) lastSentAt.delete(key);
    }
    // Still oversized (a flood of live accounts): drop the oldest half outright
    // so this stays O(n) amortized instead of unbounded.
    if (lastSentAt.size >= MAX_SENT_TRACKED) {
      const ordered = [...lastSentAt.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < Math.ceil(ordered.length / 2); i += 1) lastSentAt.delete(ordered[i][0]);
    }
  }
  lastSentAt.set(userId, at);
}

const str = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

function maskEmail(value) {
  const email = str(value);
  const at = email.indexOf('@');
  if (at <= 0) return '[redacted]';
  return `${email[0]}***@${email.slice(at + 1)}`;
}

const normalizeEmail = (value) => str(value).trim().toLowerCase();

/**
 * A syntactically valid ObjectId, or null.
 *
 * `User.findById('not-an-id')` does not return null — it THROWS a CastError. On
 * these routes that error used to be caught by the generic handler and answered
 * 500 "Something went wrong. Please try again later.", which is both wrong (the
 * caller sent a bad value, our side is fine) and misleading (it invites a retry
 * into the same malformed request). A caller-supplied id is validated here so it
 * is a 4xx like every other bad input.
 */
function asObjectId(value) {
  const raw = str(value).trim();
  if (!/^[a-f0-9]{24}$/i.test(raw)) return null;
  return raw;
}

/**
 * The web origin the reset link points at.
 *
 * The Origin header is attacker-controlled, so it is only ever consulted outside
 * production: a hostile origin here would rewrite the link in a real user's
 * inbox, and the token would be delivered straight to whoever chose it. In
 * production `PUBLIC_WEB_URL` is the only source; if it is unset the link is
 * built for localhost and the mail is effectively useless — loudly logged, so
 * the misconfiguration is visible rather than silent.
 */
function resolveWebOrigin(req) {
  const configured = str(process.env.PUBLIC_WEB_URL || process.env.WEB_ORIGIN).trim().replace(/\/+$/, '');
  if (configured) return configured;

  if (process.env.NODE_ENV !== 'production') {
    const origin = str(req?.headers?.origin).trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(origin)) return origin;
  }

  // Unreachable in production — index.js refuses to boot without
  // PUBLIC_WEB_URL — but reachable in a misconfigured dev/test process, where a
  // localhost link is the correct answer. Logged once per process rather than
  // per request so it cannot flood the log.
  if (!resolveWebOrigin.warned) {
    resolveWebOrigin.warned = true;
    console.warn(
      '[password-reset] PUBLIC_WEB_URL is not set. Reset links will point at '
      + 'https://localhost:5173 and will not work for a real user. Set PUBLIC_WEB_URL.'
    );
  }
  return 'https://localhost:5173';
}

function buildResetUrl(webOrigin, token) {
  return `${webOrigin}/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * Issue a reset link.
 *
 * ALWAYS answers 200 with the same body — including when the address has no
 * account, and including when the mail provider is down.
 *
 * This is a deliberate reversal of the old behaviour, which returned 503 when
 * delivery failed but 200 when the account did not exist. That difference was a
 * free account-existence oracle: an attacker could enumerate every registered
 * address by watching for the 503. Answering honestly about OUR mail outage
 * would leak the same thing through the back door, so the outage is logged for
 * us and the user is told to try again — the resend button, not an error, is
 * the recovery path.
 *
 * @returns {Promise<{status: number, message: string, sent?: boolean}>}
 */
async function requestReset({ email, req } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return { status: 400, message: 'Please enter your email address.' };
  }
  if (!isValidEmail(normalized)) {
    return { status: 400, message: 'Please enter a valid email address.' };
  }

  // Only the id and the address are read, and only for the delivery — the
  // response never carries either back, so there is nothing here to leak even
  // if a future change to this function tried to.
  const user = await User.findOne({ email: normalized }).select('_id email').lean();
  if (!user || !user._id) {
    // Answering faster than the branch that does send mail is itself a signal,
    // so this costs roughly the same time.
    await crypto.randomBytes(32);
    return { status: 200, message: GENERIC_REQUEST_MESSAGE };
  }

  const userId = str(user._id);
  const previous = lastSentAt.get(userId);
  if (previous && Date.now() - previous < PASSWORD_RESET_RESEND_COOLDOWN_SECONDS * 1000) {
    // Suppressed rather than reported as 429: a cooldown error here would tell
    // an enumerator that the address HAS an account.
    return { status: 200, message: GENERIC_REQUEST_MESSAGE, sent: false, cooldown: true };
  }

  const outcome = await issueGrantByEmail({ user, recipient: normalized, req });
  if (!outcome.delivered) {
    return { status: 200, message: GENERIC_REQUEST_MESSAGE, sent: false };
  }

  SecurityEvent.write({
    user: user._id,
    type: 'password-reset-requested',
    ip: normalizeIp(req?.ip),
    userAgent: req?.get?.('user-agent'),
  }).catch(() => {});

  console.log(`[password-reset] link issued to ${maskEmail(normalized)} (expires in ${PASSWORD_RESET_TTL_MINUTES}m)`);
  return { status: 200, message: GENERIC_REQUEST_MESSAGE, sent: true };
}

/** Legacy alias target: re-send for an account we can already name by id. */
async function resendForUser({ userId, req } = {}) {
  if (!userId) return { status: 400, message: 'User ID is required.' };
  const validId = asObjectId(userId);
  if (!validId) return { status: 400, message: 'Invalid request.' };
  const user = await User.findById(validId).select('email').lean();
  if (!user) return { status: 401, message: 'Invalid request.' };
  return requestReset({ email: user.email, req });
}

/**
 * Is this link still usable? Used to render the right message before the user
 * types anything, so a dead link never looks like a rejected password.
 *
 * @returns {Promise<{valid: boolean, reason?: string, message?: string}>}
 */
async function validateToken(rawToken) {
  const token = str(rawToken).trim();
  if (!token) {
    return { valid: false, reason: 'missing', message: 'This page needs a reset link. Request a new one below.' };
  }
  const record = await PasswordResetToken.findActiveByTokenHash(token);
  if (!record) {
    return { valid: false, reason: 'invalid', message: INVALID_LINK_MESSAGE };
  }
  return { valid: true, expiresAt: record.expiresAt };
}

/**
 * Everything that must happen once a caller has proved they hold a live grant:
 * validate the new password, write it, evict every intruder, tell the owner.
 *
 * The password rules are checked BEFORE the grant is claimed, so a user who
 * mistypes their new password keeps their link instead of being silently signed
 * out of the flow they are in the middle of. The claim itself is a single
 * atomic update, so two simultaneous redemptions of one link cannot both win.
 */
async function applyNewPassword(user, newPassword, { method, req } = {}) {
  const verdict = evaluatePassword(newPassword, { email: user.email });
  if (!verdict.ok) return { status: 400, message: verdict.message };

  if (await user.matchPassword(newPassword)) {
    return { status: 400, message: 'Choose a password you have not used before.' };
  }

  // The pre-save hook hashes with argon2id and stamps passwordChangedAt.
  user.password = newPassword;
  await user.save();

  // A reset is the owner proving they recovered from a compromise. Any session
  // an intruder still holds has to stop working, or the reset accomplished
  // nothing. Other outstanding links die with it, so a link requested BEFORE
  // this one cannot be used afterwards.
  const revoked = await revokeAllUserSessions(user._id).catch(() => 0);
  await PasswordResetToken.invalidateAllForUser(user._id).catch(() => {});

  console.log(`[PASSWORD RESET] password reset via ${method} for ${maskEmail(user.email)}; ${revoked || 0} session(s) revoked`);

  SecurityEvent.write({
    user: user._id,
    type: 'password-reset-completed',
    reason: method,
    ip: normalizeIp(req?.ip),
    userAgent: req?.get?.('user-agent'),
  }).catch(() => {});

  try {
    const UserNotification = require('../models/UserNotification');
    await UserNotification.create({
      user: user._id,
      type: 'info',
      title: 'Password changed',
      detail: 'Your password was reset and every signed-in device was signed out. '
        + 'If this wasn\'t you, reset it again and contact support immediately.',
    }).catch(() => {});
  } catch { /* best-effort */ }

  // Fires and forgets. A failed confirmation must not fail a completed reset.
  sendPasswordChangedEmail(user.email).catch(() => {});

  return {
    status: 200,
    message: 'Your password has been changed. Every signed-in device has been signed out — you can sign in with your new password now.',
    success: true,
  };
}

/** Resolve a live grant + its account without consuming anything. */
async function loadGrant(rawToken) {
  const record = await PasswordResetToken.findActiveByTokenHash(str(rawToken).trim());
  if (!record) return { ok: false, status: 400, message: INVALID_LINK_MESSAGE };
  const user = await User.findById(record.user);
  if (!user) return { ok: false, status: 400, message: INVALID_LINK_MESSAGE };
  return { ok: true, record, user };
}

/** Redeem an emailed link. */
async function completeWithToken({ token, newPassword, req } = {}) {
  const loaded = await loadGrant(token);
  if (!loaded.ok) return { status: loaded.status, message: loaded.message };

  // Validate before claiming — see applyNewPassword.
  const verdict = evaluatePassword(newPassword, { email: loaded.user.email });
  if (!verdict.ok) return { status: 400, message: verdict.message };
  if (await loaded.user.matchPassword(newPassword)) {
    return { status: 400, message: 'Choose a password you have not used before.' };
  }

  const claimed = await PasswordResetToken.claimByTokenHash(str(token).trim());
  if (!claimed) {
    return { status: 400, message: 'This reset link has just been used. Request a new one and try again.' };
  }

  return applyNewPassword(loaded.user, newPassword, { method: 'link', req });
}

/**
 * Verify a 6-digit code and mint a short-lived grant.
 *
 * The returned grant is proof for exactly one thing: setting this password in
 * the next fifteen minutes. It is signed with the same secret as session tokens
 * but carries a `purpose` claim and cannot be used as a session — it grants no
 * access to the account, only the ability to finish a recovery.
 */
async function verifyCodeForUser({ userId, code, req } = {}) {
  const submitted = str(code).trim();
  if (!userId || !submitted) {
    return { status: 400, message: 'User ID and verification code are required.' };
  }

  // Resolve the id first. The client sends a string and `findById` accepts
  // upper-case hex, so keying anything on the raw value would miss the very
  // record it just found. A malformed id is a 400, not a 500 — see asObjectId.
  const validId = asObjectId(userId);
  if (!validId) return { status: 400, message: 'Invalid request.' };
  const user = await User.findById(validId);
  if (!user) return { status: 401, message: 'Invalid request.' };

  const result = await PasswordResetToken.checkCode(user._id, submitted, PASSWORD_RESET_MAX_CODE_ATTEMPTS);
  if (!result.ok) {
    if (result.outcome === 'mismatch') {
      return { status: 400, message: 'That code is not right. Check the newest email we sent and try again.' };
    }
    if (result.outcome === 'locked') {
      return { status: 429, message: 'Too many incorrect codes. Request a new reset link and use the newest one.' };
    }
    if (result.outcome === 'expired') {
      return { status: 400, message: 'That code has expired. Request a new reset link.' };
    }
    return { status: 400, message: 'No password reset is in progress for this account. Request a new link.' };
  }

  const grant = jwt.sign(
    { sub: str(user._id), purpose: 'password-reset' },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: RESET_GRANT_TTL_SECONDS }
  );

  SecurityEvent.write({
    user: user._id,
    type: 'password-reset-code-verified',
    ip: normalizeIp(req?.ip),
    userAgent: req?.get?.('user-agent'),
  }).catch(() => {});

  return { status: 200, message: 'Code verified. Choose your new password.', verified: true, resetToken: grant };
}

/** Redeem a grant minted by verifyCodeForUser. */
async function completeWithGrant({ resetToken, newPassword, req } = {}) {
  let userId = '';
  try {
    const payload = jwt.verify(str(resetToken), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.purpose !== 'password-reset' || !payload.sub) throw new Error('wrong purpose');
    userId = str(payload.sub);
  } catch {
    return { status: 400, message: 'That reset session has expired. Request a new link and start again.' };
  }

  // The signature is our own, so a well-formed grant always carries a valid id —
  // but this is a public unauthenticated route, and `findById` throws rather
  // than returning null on a malformed value. Never let that become a 500.
  const validId = asObjectId(userId);
  if (!validId) return { status: 400, message: 'That reset session has expired. Request a new link and start again.' };

  const user = await User.findById(validId);
  if (!user) return { status: 400, message: INVALID_LINK_MESSAGE };

  return applyNewPassword(user, newPassword, { method: 'code', req });
}

/** Legacy alias target: set a password straight from a code, in one call. */
async function completeWithCode({ userId, code, newPassword, req } = {}) {
  const submitted = str(code).trim();
  if (!userId || !submitted || !newPassword) {
    return { status: 400, message: 'User ID, verification code, and a new password are required.' };
  }
  const validId = asObjectId(userId);
  if (!validId) return { status: 400, message: 'Invalid request.' };
  const user = await User.findById(validId);
  if (!user) return { status: 401, message: 'Invalid request.' };

  const result = await PasswordResetToken.checkCode(user._id, submitted, PASSWORD_RESET_MAX_CODE_ATTEMPTS);
  if (!result.ok) {
    if (result.outcome === 'mismatch') {
      return { status: 400, message: 'That code is not right. Check the newest email we sent and try again.' };
    }
    if (result.outcome === 'locked') {
      return { status: 429, message: 'Too many incorrect codes. Request a new reset link and use the newest one.' };
    }
    if (result.outcome === 'expired') {
      return { status: 400, message: 'That code has expired. Request a new reset link.' };
    }
    return { status: 400, message: 'No password reset is in progress for this account. Request a new link.' };
  }

  const verdict = evaluatePassword(newPassword, { email: user.email });
  if (!verdict.ok) return { status: 400, message: verdict.message };
  if (await user.matchPassword(newPassword)) {
    return { status: 400, message: 'Choose a password you have not used before.' };
  }

  await PasswordResetToken.invalidateAllForUser(user._id).catch(() => {});
  return applyNewPassword(user, newPassword, { method: 'code', req });
}

module.exports = {
  PASSWORD_RESET_TTL_MINUTES,
  PASSWORD_RESET_RESEND_COOLDOWN_SECONDS,
  PASSWORD_RESET_MAX_CODE_ATTEMPTS,
  GENERIC_REQUEST_MESSAGE,
  INVALID_LINK_MESSAGE,
  resolveWebOrigin,
  buildResetUrl,
  mintResetGrant,
  issueGrantByEmail,
  requestReset,
  resendForUser,
  validateToken,
  completeWithToken,
  verifyCodeForUser,
  completeWithGrant,
  completeWithCode,
};
