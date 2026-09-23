const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Session = require('../models/Session');

// ─── Session rules (backend authority) ───────────────────────────────────────
// • Different accounts NEVER invalidate each other: state is per-user
//   (User.currentSessionId + Session.user), never global.
// • Exactly ONE active session per account: sign-in atomically flips the
//   account's current-session pointer to the freshly created session and
//   revokes ONLY the session it displaced. Concurrent sign-ins serialize on
//   that single-document update, so the last one to commit wins
//   deterministically.
// • Sessions never expire on their own (`exp` absent from user JWTs,
//   Session.expiresAt = null). They end only by replacement or sign-out.
// • The server is authoritative: a JWT is necessary but never sufficient.

const SESSION_ENDED_MESSAGE = 'Your session has ended. Please sign in again.';
const SESSION_INVALID = 'SESSION_INVALID'; // token malformed / no sid / unknown user
const SESSION_REVOKED = 'SESSION_REVOKED'; // session replaced, revoked or missing
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

// User tokens: no `exp` — validity is revocation-based, not time-based.
function signUserToken(userId, sessionId) {
  return jwt.sign(
    { sub: asId(userId), id: asId(userId), sid: asId(sessionId) },
    process.env.JWT_SECRET
  );
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
async function issueUserSession(userId) {
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
 * this account → not revoked → is the account's current active session →
 * account still usable.
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
    Session.findById(sid).select('user revokedAt createdAt').lean(),
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
  if (user.accountStatus && user.accountStatus !== 'active') {
    return deny(
      403,
      ACCOUNT_DISABLED,
      user.accountStatus === 'banned'
        ? 'This account has been banned.'
        : 'This account is no longer active.'
    );
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

  const fresh = signUserToken(session.user, session._id);
  // Audit stamp only — a failure here must never fail the mint.
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

module.exports = {
  issueUserSession,
  verifyUserSession,
  attachRememberToken,
  mintFromRememberToken,
  revokeUserSession,
  revokeAllUserSessions,
  SESSION_ENDED_MESSAGE,
  SESSION_INVALID,
  SESSION_REVOKED,
  NO_SESSION,
  INVALID_TOKEN,
  TOKEN_EXPIRED,
  ACCOUNT_DISABLED,
};
