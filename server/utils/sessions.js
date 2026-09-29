const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Session = require('../models/Session');
const {
  USER_IDLE_LIMIT_MS,
  USER_IDLE_DAYS,
  REMEMBER_TOKEN_LIFETIME,
  USER_ACTIVITY_TOUCH_INTERVAL_MS,
  USER_ACTIVITY_MAX_AGE_MS,
} = require('./userSession');

// ─── Session rules (backend authority) ───────────────────────────────────────
// • Different accounts NEVER invalidate each other: state is per-user
//   (User.currentSessionId + Session.user), never global.
// • Exactly ONE active session per account: sign-in atomically flips the
//   account's current-session pointer to the freshly created session and
//   revokes ONLY the session it displaced. Concurrent sign-ins serialize on
//   that single-document update, so the last one to commit wins
//   deterministically.
// • A session ends when it is replaced by a newer sign-in, when it is revoked
//   at sign-out, or after 30 DAYS WITHOUT ACTIVITY (see utils/userSession.js).
//   Validity is revocation-based, not token-based: a user JWT carries no `exp`,
//   so the session record is the single authority on whether a token still acts.
//   The idle window exists because a token with no expiry is valid forever, and
//   a token thief controls neither sign-in nor sign-out.
// • The server is authoritative: a JWT is necessary but never sufficient.

// In-memory throttle for the activity stamp, keyed by session id. A write
// amplification guard only — it is NOT what expires anything, so unlike the
// admin heartbeat it is not required to be shorter than the window (30 days vs
// minutes). Two processes each keep their own map, so the stamp may be written
// more often than this suggests; that is harmless, it only ever pushes the
// deadline further out.
const activityTouches = new Map();

/**
 * Record that this session is still in use, sliding its idle deadline.
 *
 * Two guards keep this honest:
 *   - throttled, so a busy member is not one write per API call;
 *   - only a RECENT request counts, so replaying a captured request cannot
 *     slide the deadline out forever. Without the age check the timeout would be
 *     decorative — an attacker holding a stolen token could keep a session
 *     alive indefinitely by resending one old request.
 *
 * Fire-and-forget: a failed activity stamp must never fail the request it was
 * made for. Worst case the window is not extended and the member signs in again.
 */
function touchActivity(sid, at = Date.now()) {
  if (!sid) return;
  if (at - (activityTouches.get(sid) || 0) < USER_ACTIVITY_TOUCH_INTERVAL_MS) return;
  if (activityTouches.size > 5000) {
    const oldest = activityTouches.keys().next().value;
    activityTouches.delete(oldest);
  }
  activityTouches.set(sid, at);
  Session.updateOne(
    { _id: toObjectId(sid), revokedAt: null, expiresAt: null },
    { $set: { lastActivityAt: new Date(at) } }
  ).exec().catch(() => {});
}


const SESSION_ENDED_MESSAGE = 'Your session has ended. Please sign in again.';
const SESSION_INVALID = 'SESSION_INVALID'; // token malformed / no sid / unknown user
const SESSION_REVOKED = 'SESSION_REVOKED'; // session replaced, revoked or missing
// Distinct from SESSION_REVOKED so the client can TELL the member why. Without
// it, being signed out after a month away looks identical to being signed out by
// an administrator or by a second login — and a member whose own password works
// concludes the app is broken.
const SESSION_IDLE_EXPIRED = 'SESSION_IDLE_EXPIRED';
const SESSION_IDLE_MESSAGE =
  `You were signed out after ${USER_IDLE_DAYS} days of inactivity. Sign in again to pick up where you left off.`;
const NO_SESSION = 'NO_SESSION'; // no credential presented
const INVALID_TOKEN = 'INVALID_TOKEN'; // signature/verification failed
const TOKEN_EXPIRED = 'TOKEN_EXPIRED'; // admin-only TTL (users never expire)
const ACCOUNT_DISABLED = 'ACCOUNT_DISABLED';

// Revoked session records older than this are pruned opportunistically on
// the account's next sign-in. The CURRENT session is never pruned, so an
// account that stays signed in for years is unaffected.
const REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const asId = (value) => String(value || '');

const deny = (status, code, message) => ({ ok: false, status, code, message });

function toObjectId(value) {
  try {
    const sid = new mongoose.Types.ObjectId(String(value));
    return mongoose.Types.ObjectId.isValid(sid) ? sid : null;
  } catch {
    return null;
  }
}

// User tokens: normally no `exp` — validity is decided by the session record,
// not by the token's own clock, so a session that was displaced or revoked stops
// working on the very next request even though the token still looks fine.
//
// The ONE exception is a token minted from a saved-login credential
// (mintFromRememberToken). That token is long-lived by design — it is what saves
// someone re-typing a password — so it carries a real expiry, deliberately set
// LONGER than the idle window. Without it a returning member could land in a gap
// where the credential still worked and the session was still alive but the
// token it produced had already died.
function signUserToken(userId, sessionId, options = {}) {
  const payload = { sub: asId(userId), id: asId(userId), sid: asId(sessionId) };
  return options.expiresIn
    ? jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: options.expiresIn })
    : jwt.sign(payload, process.env.JWT_SECRET);
}

/**
 * Start a NEW session for an account and make it the account's only active
 * session. Returns the JWT (carrying the session's `sid`).
 *
 * Ordering is chosen so that no interleaving of two concurrent sign-ins can
 * leave the account with two live sessions or zero live sessions:
 *   1. snapshot the current pointer (to revoke precisely what we displace)
 *   2. create the Session record (not active yet — nothing points at it)
 *   3. atomically flip User.currentSessionId (+ sessionVersion) ← newest wins
 *   4. revoke the displaced session (the one we saw in step 1, never a
 *      concurrent login's: a session read in step 1 can no longer become the
 *      final pointer, because any later pointer write commits after ours)
 */
async function issueUserSession(userId, deviceMeta = {}) {
  const uid = asId(userId);
  const sid = new mongoose.Types.ObjectId();

  const current = await User.findById(uid).select('+currentSessionId').lean();

  const token = signUserToken(uid, sid);

  await Session.create({
    _id: sid,
    user: uid,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    createdAt: new Date(),
    lastActivityAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    // Display-only attribution so "Signed-in devices" can name a session.
    // Never consulted for an authorisation decision — see utils/device.js.
    ...(deviceMeta && typeof deviceMeta === 'object' ? deviceMeta : {}),
  });

  const flip = await User.updateOne({ _id: uid }, [
    {
      $set: {
        currentSessionId: sid,
        sessionVersion: { $add: [{ $ifNull: ['$sessionVersion', 0] }, 1] },
      },
    },
  ]);
  if (!flip.matchedCount) {
    // Account vanished mid-sign-in: never hand out a token with no owner.
    await Session.deleteOne({ _id: sid, user: uid }).catch(() => {});
    throw new Error('Unable to start session: account not found');
  }

  const displaced = current && current.currentSessionId;
  if (displaced && asId(displaced) !== asId(sid)) {
    await Session.updateOne(
      { _id: displaced, user: uid, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
  }

  // Hygiene only — deletes REVOKED records of this account, never the live one.
  Session.deleteMany({
    user: uid,
    revokedAt: { $ne: null, $lt: new Date(Date.now() - REVOKED_RETENTION_MS) },
  }).catch(() => {});

  return token;
}

/**
 * Validate a decoded user JWT against the server-side session state.
 * Checks, in order: identity claims → session exists → session belongs to
 * this account → not revoked → is the account's current active session → not
 * expired → account still usable.
 *
 * Throws nothing: DB failures propagate to the caller, which must answer 503
 * (a database outage must NEVER log users out).
 */
async function verifyUserSession(decoded) {
  if (!decoded || !decoded.sid) {
    // Legacy/pre-session token (or a token minted without a session): the
    // session store cannot vouch for it, so it must not be honored.
    return deny(401, SESSION_INVALID, SESSION_ENDED_MESSAGE);
  }
  if (decoded.sub && asId(decoded.sub) !== asId(decoded.id)) {
    // sub/id disagreement would be a token confused between accounts.
    return deny(401, SESSION_INVALID, SESSION_ENDED_MESSAGE);
  }
  const sid = toObjectId(decoded.sid);
  if (!sid) return deny(401, SESSION_INVALID, SESSION_ENDED_MESSAGE);
  const uid = asId(decoded.id);

  const [user, session] = await Promise.all([
    User.findById(decoded.id)
      .select('-password -profilePicture -bannerPicture +currentSessionId')
      .lean(),
    Session.findById(sid).select('user revokedAt createdAt lastActivityAt expiresAt').lean(),
  ]);

  if (!user) return deny(401, SESSION_INVALID, SESSION_ENDED_MESSAGE);
  if (!session || asId(session.user) !== asId(user._id)) {
    return deny(401, SESSION_REVOKED, SESSION_ENDED_MESSAGE);
  }
  if (session.revokedAt) return deny(401, SESSION_REVOKED, SESSION_ENDED_MESSAGE);
  if (!user.currentSessionId || asId(user.currentSessionId) !== asId(sid)) {
    // A newer sign-in replaced this session (Rule: one active session per
    // account). Safe to stamp revokedAt as a side effect: a token only ever
    // exists AFTER its own flip committed, and the pointer never returns to
    // an older session id — so "not current" here is always final.
    Session.updateOne(
      { _id: sid, user: uid, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    ).exec().catch(() => {});
    return deny(401, SESSION_REVOKED, SESSION_ENDED_MESSAGE);
  }

  // ── Expiry ──────────────────────────────────────────────────────────────
  // Two mechanisms, and the stored field is checked FIRST so a future policy
  // that sets a hard cap on some session type overrides the sliding window
  // rather than being ignored by it.
  const now = Date.now();
  if (session.expiresAt && new Date(session.expiresAt).getTime() <= now) {
    // An absolute cap elapsed. This is final, so it is stamped revoked exactly
    // like a displacement — otherwise a stale token would re-enter this branch
    // on every request and pay for a query each time.
    Session.updateOne(
      { _id: sid, user: uid, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    ).exec().catch(() => {});
    return deny(401, SESSION_REVOKED, SESSION_ENDED_MESSAGE);
  }
  if (!session.expiresAt) {
    // Sliding idle window, computed from the last ACTIVITY stamp rather than
    // from a stored moving deadline. Deriving it means the deadline cannot drift
    // out of step with the value it is derived from — there is no second copy to
    // fall behind, and no window to extend on a write-heavy path.
    const lastActivity = session.lastActivityAt
      ? new Date(session.lastActivityAt).getTime()
      : new Date(session.createdAt || 0).getTime();
    if (now - lastActivity > USER_IDLE_LIMIT_MS) {
      Session.updateOne(
        { _id: sid, user: uid, revokedAt: null },
        { $set: { revokedAt: new Date() } }
      ).exec().catch(() => {});
      return deny(401, SESSION_IDLE_EXPIRED, SESSION_IDLE_MESSAGE);
    }
  }

  if (user.accountStatus && user.accountStatus !== 'active') {
    return deny(
      403,
      ACCOUNT_DISABLED,
      user.accountStatus === 'banned'
        ? 'This account has been banned.'
        : 'This account is no longer active.'
    );
  }

  // Genuine, recent activity slides the window. Uses the TOKEN's issue time, not
  // the clock: a replayed old request cannot hold a session open indefinitely.
  if (decoded.iat && now - decoded.iat * 1000 <= USER_ACTIVITY_MAX_AGE_MS) {
    touchActivity(sid, now);
  }

  return { ok: true, user, sid: asId(sid) };
}

/**
 * OPT-IN companion credential for "Save my login on this browser": store a
 * hash of a high-entropy remember token ON this session and hand the raw
 * value back to the client exactly once. Swapping it later re-signs an
 * access JWT for the SAME session (mintFromRememberToken) — no session is
 * created and none is displaced, so the one-active-session rule is untouched
 * — and the credential dies together with the session: sign-out, a newer
 * sign-in and account bans all reject the mint through the normal
 * verifyUserSession gauntlet.
 *
 * `issuedToken` is the JWT that was just minted for the session (its `sid`
 * identifies the record). Returns the raw remember token, or '' when it
 * could not be attached (session already gone) or the input was malformed.
 */
async function attachRememberToken(issuedToken) {
  const decoded = jwt.decode(String(issuedToken || ''));
  const sid = decoded && toObjectId(decoded.sid);
  if (!decoded || !sid || !decoded.id) return '';
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const attached = await Session.updateOne(
    { _id: sid, user: asId(decoded.id), revokedAt: null },
    { $set: { rememberHash: hash } }
  );
  return attached.matchedCount ? raw : '';
}

/**
 * Exchange a remember credential for a fresh access JWT — for the SAME
 * session, only after running the exact validity checks any protected
 * endpoint runs (exists → owned → unrevoked → still the account's current
 * session → account active). Hash lookup merely FINDS the candidate; it
 * never grants. DB failures propagate so callers answer 5xx — never a false
 * rejection — which keeps the client's saved login through an outage.
 */
async function mintFromRememberToken(raw) {
  const token = typeof raw === 'string' ? raw : '';
  if (token.length < 20 || token.length > 200) {
    return deny(401, SESSION_INVALID, SESSION_ENDED_MESSAGE);
  }
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const session = await Session.findOne({ rememberHash: hash }).lean();
  if (!session) return deny(401, SESSION_INVALID, SESSION_ENDED_MESSAGE);

  const verified = await verifyUserSession({
    sub: asId(session.user),
    id: asId(session.user),
    sid: asId(session._id),
  });
  if (!verified.ok) return verified;

  const fresh = signUserToken(session.user, session._id, {
    expiresIn: REMEMBER_TOKEN_LIFETIME,
  });
  // The activity stamp is NOT cosmetic here: it is what re-arms the sliding
  // idle window. A member coming back through their saved login is definitionally
  // active, so the 30-day countdown starts again from this moment rather than
  // from whenever they first signed in weeks ago.
  //
  // Audit stamp beyond that is a failure that must never fail the mint.
  Session.updateOne(
    { _id: session._id },
    {
      $set: {
        tokenHash: crypto.createHash('sha256').update(fresh).digest('hex'),
        lastActivityAt: new Date(),
      },
    }
  ).exec().catch(() => {});
  return { ok: true, token: fresh, userId: asId(session.user), sid: asId(session._id) };
}

/**
 * Stamp `trustedAt` on the session behind an issued token.
 *
 * Called once a "save my login" credential is attached, so the security page
 * can show WHEN a device became trusted. This is a display stamp only — trust
 * itself is anchored to the presence of `rememberHash`, which every validation
 * path re-checks. Best-effort by design: a missing stamp must never fail a
 * sign-in.
 */
async function markSessionTrusted(issuedToken) {
  const decoded = jwt.decode(String(issuedToken || ''));
  const sid = decoded && toObjectId(decoded.sid);
  if (!sid || !decoded.id) return false;
  const res = await Session.updateOne(
    { _id: sid, user: asId(decoded.id), revokedAt: null },
    { $set: { trustedAt: new Date() } }
  ).exec();
  return res.matchedCount > 0;
}

/**
 * Revoke ONE session (sign-out). Scoped to the account AND the session id,
 * so signing out Account A can never touch Account B, and a stale token can
 * never revoke a newer session. The pointer is cleared only when it still
 * points at this session.
 */
async function revokeUserSession(userId, sid) {
  const uid = asId(userId);
  const objectId = toObjectId(sid);
  if (!objectId) return false;

  const revoked = await Session.updateOne(
    { _id: objectId, user: uid, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  await User.updateOne(
    { _id: uid, currentSessionId: objectId },
    { $set: { currentSessionId: null } }
  ).catch(() => {});
  return revoked.modifiedCount > 0;
}

/**
 * Revoke EVERY live session of one account and clear its active-session
 * pointer. Used by credential-recovery events (password reset), where the
 * requester may not even be authenticated — whoever still holds an older
 * token must lose access immediately, because a password reset is the
 * account owner proving they recovered from a compromise.
 *
 * Scoped strictly to `userId`: other accounts are never touched.
 */
async function revokeAllUserSessions(userId) {
  const uid = asId(userId);
  if (!uid) return false;

  const revoked = await Session.updateMany(
    { user: uid, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  // Clear the pointer even when no Session rows matched (a legacy token with
  // no row must also stop validating against "current session").
  await User.updateOne({ _id: uid }, { $set: { currentSessionId: null } }).catch(() => {});
  return revoked.modifiedCount > 0;
}

/**
 * Revoke every session of this account EXCEPT `keepSid`, and clear the
 * "save my login" credential from all of them.
 *
 * Backs both "Sign out of all other devices" and the session sweep that
 * follows a password change.
 *
 *   1. `revokedAt` is stamped — this is what actually ends those sessions. Any
 *      live JWT for them stops validating on the very next request.
 *   2. `rememberHash` is cleared as well. To be precise about why: this is
 *      defence-in-depth, NOT the load-bearing part. A saved-login credential
 *      re-runs the full session validation (exists → owned → unrevoked →
 *      still current), so a revoked session's hash can never mint a new token
 *      today. Clearing it removes the stored credential outright, so the
 *      device is genuinely signed out rather than merely holding a hash that
 *      happens to be inert — and a future relaxation of the mint can't
 *      resurrect those devices by accident.
 *
 * `keepSid` (the caller's own session) is excluded from both — the device you
 * clicked the button on stays signed in, which is the whole point of the
 * exclude. Scoped strictly to `userId`; other accounts are never touched.
 * Returns the number of other sessions affected.
 */
async function revokeOtherUserSessions(userId, keepSid) {
  const uid = asId(userId);
  if (!uid) return 0;
  const keep = toObjectId(keepSid);

  const filter = { user: uid, revokedAt: null };
  if (keep) filter._id = { $ne: keep };

  const now = new Date();
  const ended = await Session.updateMany(
    filter,
    { $set: { revokedAt: now, rememberHash: '' } }
  ).catch(() => null);

  // Count what the caller actually lost, not just what we tried to touch.
  // A session already carrying a rememberHash is a device we just cut off
  // from re-entering, so it counts even if its row was already revoked.
  const cleared = await Session.updateMany(
    keep
      ? { user: uid, _id: { $ne: keep }, rememberHash: { $nin: ['', null] } }
      : { user: uid, rememberHash: { $nin: ['', null] } },
    { $set: { rememberHash: '' } }
  ).catch(() => null);

  const revoked = ended ? ended.modifiedCount : 0;
  const alsoCleared = cleared ? cleared.modifiedCount : 0;
  return Math.max(revoked, alsoCleared);
}

module.exports = {
  issueUserSession,
  verifyUserSession,
  attachRememberToken,
  markSessionTrusted,
  mintFromRememberToken,
  revokeUserSession,
  revokeAllUserSessions,
  revokeOtherUserSessions,
  SESSION_ENDED_MESSAGE,
  SESSION_INVALID,
  SESSION_REVOKED,
  SESSION_IDLE_EXPIRED,
  SESSION_IDLE_MESSAGE,
  NO_SESSION,
  INVALID_TOKEN,
  TOKEN_EXPIRED,
  ACCOUNT_DISABLED,
  // Re-exported so a caller (or a test) can reason about the window without
  // importing a second module — and so there is exactly one import path to the
  // policy in utils/userSession.js.
  USER_IDLE_LIMIT_MS,
  USER_IDLE_DAYS,
};
