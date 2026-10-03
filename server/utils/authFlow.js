/**
 * Shared sign-in completion.
 *
 * Before this existed, "log this person in" was written out five times —
 * /auth/verify-login-otp, /auth/login-2fa, /security/backup-codes/redeem and
 * the admin flow each assembled their own session, their own event and their
 * own response body. They agreed today. The passkey flow made it four-to-one
 * obvious that they could not stay in step forever: a fifth copy of "issue the
 * session, write the event, shape the response" is exactly where a forgotten
 * `rememberHash` clear or a missing security event hides.
 *
 * So this module owns the sequence, and the callers own only what is genuinely
 * theirs: which factor was satisfied, and which lockout bucket to clear.
 */
const { issueUserSession, attachRememberToken, markSessionTrusted } = require('./sessions');
const SecurityEvent = require('../models/SecurityEvent');
const User = require('../models/User');
const { describeDevice } = require('./device');
const { describeSubscription } = require('./entitlements');
const { safePictureValue, boundedPictureFilter, PICTURE_PROJECTION } = require('./pictures');
const { platformOf } = require('./device');

/** How a second factor should be described in the audit trail and the session. */
const AUTH_METHODS = Object.freeze({
  PASSWORD: 'password',
  PASSKEY: 'passkey',
  TOTP: 'totp',
  BACKUP_CODE: 'backup-code',
  EMAIL_OTP: 'email-otp',
  REMEMBER: 'remember',
});

/**
 * The public shape of a signed-in user.
 *
 * Built from an already-projected document. `twoFactorSecret` /
 * `twoFactorSecretEnc` cannot appear here even by accident: this is an
 * explicit allowlist rather than a projection of the document, so a field
 * added to the schema later is invisible until someone deliberately adds it to
 * a response. That is the property worth having on every auth response.
 */
function publicUser(user) {
  return {
    _id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    name: user.fullName,
    email: user.email,
    dateOfBirth: user.dateOfBirth,
    age: user.age,
    gender: user.gender,
    profilePicture: safePictureValue(user.profilePicture),
    bannerPicture: safePictureValue(user.bannerPicture),
    twoFactorEnabled: user.twoFactorEnabled === true,
    twoFactorMethod: user.twoFactorEnabled ? (user.twoFactorMethod || 'authenticator') : null,
    subscriptionActive: user.subscriptionActive,
    subscriptionPlan: user.subscriptionPlan,
    subscription: describeSubscription(user),
  };
}

/**
 * The two picture values a sign-in response has to carry, read separately from
 * the document the response is otherwise built from.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 *
 * Sign-in reads deliberately project `profilePicture` / `bannerPicture` OUT —
 * see `Test File/login-picture-footprint.test.js` and the header of
 * `utils/pictures.js` for the multi-megabyte outage that projection avoids.
 *
 * Three sign-in routes handed that projected document straight to
 * `publicUser()`. A field that was never read is `undefined`,
 * `safePictureValue(undefined)` is `''`, and the response asserted something it
 * had no way of knowing: that the account has no avatar.
 *
 * That is not cosmetic, and it is not self-correcting. The client stores the
 * sign-in response as this tab's cached profile, and nothing re-reads the
 * pictures afterwards, so a passwordless sign-in replaced a real avatar and
 * banner with empty strings and left them that way for the life of the
 * session — reported as "signing in with a passkey resets my profile".
 *
 * ── Why this is a second read rather than a wider projection ───────────────
 *
 * Putting the fields back on the sign-in read would re-open the exact failure
 * the projection exists to close, because an account the disk migration has not
 * reached still holds its image inline. `boundedPictureFilter` decides the size
 * in the QUERY, so the projection below can only ever return a value that is
 * already safe to send.
 *
 * Never fails a sign-in: a database problem here degrades to "no pictures in
 * this one response" (the old behaviour) rather than to a rejected sign-in the
 * person has already proved themselves for.
 *
 * @param {object} user a signed-in user's document (need only its `_id`)
 * @returns {Promise<{profilePicture: string, bannerPicture: string}>}
 */
async function publicPictures(user) {
  const none = { profilePicture: '', bannerPicture: '' };
  if (!user || !user._id) return none;

  let row = null;
  try {
    row = await User.findOne(
      { _id: user._id, ...boundedPictureFilter() },
      PICTURE_PROJECTION,
    ).lean();
  } catch {
    return none;
  }
  if (!row) return none;

  return {
    profilePicture: safePictureValue(row.profilePicture),
    bannerPicture: safePictureValue(row.bannerPicture),
  };
}

/**
 * Turn a proven first factor into a live, fully authenticated session.
 *
 * The ordering is the same everywhere and the order matters:
 *   1. issue the session (which atomically displaces THIS ACCOUNT's previous
 *      session and leaves every other account's alone);
 *   2. optionally attach the opt-in saved-login credential to THAT session;
 *   3. stamp it trusted so the device list can show it;
 *   4. write the audit event.
 *
 * Step 1 is what implements the session policy, and it is per-user by
 * construction: `issueUserSession` flips `User.currentSessionId` and revokes
 * the session it displaces for THAT user only. Two accounts signed in in two
 * tabs never interact, and a second sign-in for account A never touches
 * account B — the requirement that makes multi-account use in one browser
 * possible at all.
 *
 * @param {object}   opts.user         the authenticated user document
 * @param {string}   opts.authMethod   see AUTH_METHODS
 * @param {boolean}  opts.mfaVerified  whether a second factor was satisfied
 * @param {object}   opts.req          the express request (for ip / user-agent)
 * @param {string}   [opts.location]   already-resolved coarse location
 * @param {boolean}  [opts.remember]   attach the saved-login credential
 * @param {string}   [opts.reason]     human-readable audit reason
 * @param {string}   [opts.eventType]  defaults to login-success
 * @param {object}   [opts.passkeyId]  the passkey used, when there was one
 * @returns {Promise<{token: string, rememberToken: string, sid: string}>}
 */
async function completeSignIn({
  user,
  authMethod = AUTH_METHODS.PASSWORD,
  mfaVerified = false,
  req,
  location = '',
  remember = false,
  reason = '',
  eventType = null,
  passkeyId = null,
  extraEvent = null,
}) {
  const uid = user._id;
  const userAgent = (req && req.get && req.get('user-agent')) || '';
  const ip = (req && req.ip) || '';
  const device = describeDevice({ userAgent, ip, location });

  const token = await issueUserSession(uid, {
    ...device,
    authMethod: String(authMethod).slice(0, 32),
    mfaVerified: mfaVerified === true,
    ...(passkeyId ? { passkeyId } : {}),
  });

  let rememberToken = '';
  if (remember === true || remember === 'true') {
    // Best-effort by design: a failed attach must never fail the sign-in the
    // person just proved themselves for.
    try { rememberToken = await attachRememberToken(token); } catch { rememberToken = ''; }
  }
  if (rememberToken) {
    await markSessionTrusted(token).catch(() => {});
  }

  const meta = {
    authMethod: String(authMethod).slice(0, 32),
    mfaVerified: mfaVerified === true,
    platform: platformOf(userAgent),
  };

  await SecurityEvent.write({
    user: uid,
    type: eventType || 'login-success',
    success: true,
    ip,
    userAgent,
    location,
    reason: reason || 'Signed in',
    meta,
  });

  if (extraEvent) {
    await SecurityEvent.write({
      user: uid,
      type: extraEvent.type,
      success: extraEvent.success !== false,
      ip,
      userAgent,
      location,
      reason: extraEvent.reason || '',
      meta: { ...meta, ...(extraEvent.meta || {}) },
    }).catch(() => {});
  }

  return { token, rememberToken, sid: (require('jsonwebtoken').decode(token) || {}).sid };
}

/**
 * Record a rejected authentication attempt.
 *
 * A single helper so the failure events cannot drift apart either, and so no
 * caller is tempted to include the submitted value in `reason` — the type of
 * thing that ends up logging a password.
 */
async function recordFailure({ user, req, reason, type = 'login-failure', authMethod = '', factor = '', outcome = '' }) {
  if (!user) return null;
  return SecurityEvent.write({
    user: user._id ? user._id : user,
    type,
    success: false,
    ip: (req && req.ip) || '',
    userAgent: (req && req.get && req.get('user-agent')) || '',
    location: (user && user.lastLoginLocation) || '',
    reason: String(reason || '').slice(0, 160),
    meta: { authMethod, factor, outcome },
  });
}

module.exports = {
  AUTH_METHODS,
  publicUser,
  publicPictures,
  completeSignIn,
  recordFailure,
};
