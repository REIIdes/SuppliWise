const jwt = require('jsonwebtoken');
const AdminAccount = require('../models/AdminAccount');
const {
  verifyUserSession,
  SESSION_ENDED_MESSAGE,
  NO_SESSION,
  INVALID_TOKEN,
  TOKEN_EXPIRED,
} = require('../utils/sessions');

// Machine-readable marker for "signed in, but you must set your own password
// first". The client keys its redirect off this rather than off the 403 status,
// because 403 also means "forbidden" everywhere else in the admin API.
const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

// The only two things an admin may reach while `mustChangePassword` is set:
// the change itself, and the endpoint that tells the client the policy it must
// satisfy to get past it. Everything else - the dashboard, the user list, the
// security panel, every mutating route - is refused until the flag clears.
//
// Matched against baseUrl+path, which excludes the query string, so a crafted
// `?next=` cannot widen the allowlist. Both entries are exact matches: a prefix
// rule would let `/profile/password/anything` through.
const PASSWORD_CHANGE_ALLOWLIST = new Set([
  'PATCH /api/admin/profile/password',
  'GET /api/admin/session-status',
]);

function mayChangePassword(req) {
  // baseUrl is the router mount (/api/admin) and path is the remainder, so the
  // join reproduces the route exactly as declared in index.js.
  const target = `${req.baseUrl || ''}${req.path || ''}`.replace(/\/+$/, '') || '/';
  return PASSWORD_CHANGE_ALLOWLIST.has(`${req.method} ${target}`);
}

// ── Session validation cache ──────────────────────────────────────────────
// Every authenticated request previously hit MongoDB to validate the session.
// Under load, this doubled DB traffic for no benefit — sessions change
// infrequently (sign-out, new sign-in, ban). This cache stores validation
// results for a short TTL, reducing DB round-trips by ~50% for authenticated
// traffic. Invalidated immediately on sign-out/session change via the
// sessionVersion bump in the JWT.
const sessionCache = new Map(); // sid -> { user, sid, exp }
const sessionOwners = new Map(); // sid -> userId, so a plan change can evict every session
const SESSION_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const SESSION_CACHE_MAX = 5000;

function getCachedSession(sid) {
  const key = String(sid);
  const entry = sessionCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    sessionCache.delete(key);
    sessionOwners.delete(key);
    return null;
  }
  return entry;
}

function setCachedSession(sid, user) {
  const key = String(sid);
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    // Evict oldest entries when cache is full
    const now = Date.now();
    for (const [cachedSid, val] of sessionCache) {
      if (now > val.exp) {
        sessionCache.delete(cachedSid);
        sessionOwners.delete(cachedSid);
      }
    }
    // If still too large, delete oldest 25%
    if (sessionCache.size >= SESSION_CACHE_MAX) {
      const keys = [...sessionCache.keys()];
      for (let i = 0; i < keys.length / 4; i++) {
        sessionCache.delete(keys[i]);
        sessionOwners.delete(keys[i]);
      }
    }
  }
  sessionCache.set(key, { user, sid, exp: Date.now() + SESSION_CACHE_TTL_MS });
  sessionOwners.set(key, String(user?._id || ''));
}

function invalidateSessionCache(sid) {
  if (!sid) return;
  const key = String(sid);
  sessionCache.delete(key);
  sessionOwners.delete(key);
  lastTouched.delete(key);
}

// Subscription changes are published to every open client immediately. Drop
// every cached snapshot for the affected account so the very next request
// re-reads the authoritative plan instead of serving the old tier for the
// cache's remaining TTL.
function invalidateUserSessionCache(userId) {
  const owner = String(userId || '');
  if (!owner) return 0;
  let invalidated = 0;
  for (const [sid, cachedOwner] of sessionOwners) {
    if (cachedOwner === owner) {
      invalidateSessionCache(sid);
      invalidated += 1;
    }
  }
  return invalidated;
}

// Revoked sessions must stop working on the very next request, not at the end
// of the 30-second cache TTL. utils/sessions.js cannot require this module (we
// require it), so it publishes revocations through a listener list instead and
// we subscribe here.
//
// Without this, `POST /auth/logout` revoked the session record but a token
// already cached under the same `sid` kept authenticating for up to 30 seconds
// — a real window in which "signed out" was not yet true. Displacement by a
// newer sign-in was never affected (a new sign-in mints a NEW sid, so the stale
// entry was unreachable); in-place revocation was.
{
  const { onSessionRevoked } = require('../utils/sessions');
  onSessionRevoked((sids) => {
    for (const sid of sids) invalidateSessionCache(sid);
  });
}

// The admin session policy lives in utils/adminSession.js — the idle window, the
// token lifetime, the heartbeat interval, AND the idle check itself are defined
// once there. They used to be literals in this file and in routes/auth.js with
// a comment claiming they were kept in step, and the two copies of the check
// both carried the same null-`lastActivityAt` hole. Import the decision, not
// just the numbers.
const {
  ADMIN_HEARTBEAT_INTERVAL_MS,
  idleExceeded,
} = require('../utils/adminSession');

// Throttled `lastActivityAt` writes for USER sessions.
//
// Purely informational: a user session does not expire by time, so nothing here
// decides anything. It feeds the "signed-in devices" list.
const TOUCH_INTERVAL_MS = ADMIN_HEARTBEAT_INTERVAL_MS;
const lastTouched = new Map(); // sid → epoch ms

// A published plan change is the authoritative signal that the cached user
// snapshot is stale. Invalidate before any SSE listener runs so a client that
// reacts immediately and calls an entitlement-gated endpoint gets fresh data.
const subscriptionBus = require('../utils/subscriptionBus');
subscriptionBus.onPublish((userId) => invalidateUserSessionCache(userId));

function touchSession(sid) {
  const now = Date.now();
  const previous = lastTouched.get(sid) || 0;
  if (now - previous < TOUCH_INTERVAL_MS) return;
  lastTouched.set(sid, now);
  if (lastTouched.size > 5000) {
    // Bounded memory: drop the oldest half when the map grows too large.
    for (const [key, ts] of lastTouched) {
      if (now - ts < TOUCH_INTERVAL_MS) break;
      lastTouched.delete(key);
    }
  }
  // Fire-and-forget: an activity-stamp failure must never fail the request.
  const Session = require('../models/Session');
  Session.updateOne({ _id: sid }, { $set: { lastActivityAt: new Date() } })
    .exec()
    .catch(() => {});
}

/**
 * Stamp admin activity — THROTTLED IN THE DATABASE, not in process memory.
 *
 * This used to be an unconditional write on every single admin request. The
 * dashboard polls every 10 seconds and every interaction fetches, so an
 * actively-working administrator generated a database write several times a
 * minute for a value nothing reads more often than the idle check does.
 *
 * The throttle is the `$lt` in the FILTER rather than a `Map` here, and that is
 * the whole point of this function's shape:
 *   - it is correct across processes, where a per-process map is not (two app
 *     instances behind a load balancer would each keep their own counter, so
 *     the stamp would be written roughly twice as often as configured);
 *   - it needs no state, so there is no map to grow and evict;
 *   - when the write is skipped, Mongo matches zero documents and does no
 *     update at all — the saving is in the database, not in the round trip.
 *
 * `lastActivityAt: null` is included so a session that has never been stamped
 * gets one immediately rather than waiting out the interval.
 *
 * Fire-and-forget: a failed activity stamp must never fail the request it was
 * made for. Worst case the session ends a little early, which is the safe
 * direction.
 */
function heartbeatAdmin(adminId, at = Date.now()) {
  const AdminAccount = require('../models/AdminAccount');
  const fresh = new Date(at);
  return AdminAccount.updateOne(
    {
      _id: adminId,
      $or: [
        { lastActivityAt: null },
        { lastActivityAt: { $exists: false } },
        { lastActivityAt: { $lt: new Date(at - ADMIN_HEARTBEAT_INTERVAL_MS) } },
      ],
    },
    { $set: { lastActivityAt: fresh } },
  ).exec().catch(() => {});
}

// Reject a request with a machine-readable session error code so the
// frontend can distinguish "your session was replaced/revoked" from other
// failures and clear only this tab's session.
const rejectSession = (res, check) =>
  res.status(check.status).json({ message: check.message, code: check.code });

const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  // Header-only credential. Query-string tokens are deliberately NOT
  // accepted here: URLs leak into proxy/access logs, browser history,
  // analytics and Referer headers. The single legitimate query-token
  // consumer — the EventSource subscription stream, whose API cannot set
  // request headers — copies `?token=` into this header on its own route
  // (routes/subscription.js → streamTokenAuth) BEFORE protect runs, so that
  // flow keeps working while every other endpoint requires the header.
  const token = authHeader && authHeader.startsWith('Bearer')
    ? authHeader.split(' ')[1]
    : '';

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token', code: NO_SESSION });
  }

  let decoded;
  try {
    // `algorithms` is pinned: without it a token signed with a different
    // (and, on some configurations, `none`) algorithm could be accepted.
    // Every token this server mints is HS256.
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      // Only admin tokens carry `exp`. A user session does not expire by time —
      // see utils/userSession.js — so reaching this branch means an admin token
      // aged out, which the client's automatic renewal exists to prevent.
      return res.status(401).json({ message: 'Your session has expired. Please sign in again.', code: TOKEN_EXPIRED });
    }
    if (error.name === 'NotBeforeError') {
      return res.status(403).json({ message: 'Token not active yet.' });
    }
    return res.status(401).json({ message: 'Not authorized, token failed', code: INVALID_TOKEN });
  }

  // ── Admin sessions ──────────────────────────────────────────────────────
  // A ten-minute idle window (utils/adminSession.js) plus a short-lived token
  // that the client renews automatically. Unlike user sessions, an admin
  // session DOES end on a timer — it is the higher-privilege account.
  if (decoded.role === 'admin') {
    const adminId = decoded.adminId || decoded.id;
    if (!adminId || adminId === 'admin') return res.status(401).json({ message: 'Please sign in again.' });
    let admin;
    try {
      admin = await AdminAccount.findById(adminId).select('alias enabled lastActivityAt mustChangePassword');
    } catch (error) {
      // Lookup failure = outage, not a bad session — never sign admins out over it.
      return res.status(503).json({ message: 'The service is temporarily unavailable. Please try again.' });
    }
    if (!admin || !admin.enabled) return res.status(401).json({ message: 'Admin account is unavailable.' });
    // The single shared implementation. This used to read
    // `admin.lastActivityAt && ...`, which SKIPPED the check entirely whenever
    // the stamp was null — so an account that had never been stamped was never
    // idle-expired, and only the token's `exp` bounded it. `idleExceeded` falls
    // back to the token's own issue time and fails closed.
    if (idleExceeded(admin, decoded)) {
      return res.status(401).json({ message: 'Admin session expired after inactivity.' });
    }
    // ── Forced password change ────────────────────────────────────────────
    // An account whose password was generated or reset for it may sign in, but
    // may do nothing else until it picks its own. This is enforced HERE rather
    // than by a client redirect: by the time the admin is authenticated the JWT
    // is already valid, so a UI-only gate would be bypassed by anything that
    // does not go through the browser - a saved token, curl, another device.
    //
    // 403, not 401: the session is perfectly valid, the caller simply is not
    // allowed to do this yet. 401 would make the client discard a working token
    // and bounce to the sign-in page, which is exactly the wrong response to
    // "you are signed in, you just have one more step".
    if (admin.mustChangePassword && !mayChangePassword(req)) {
      return res.status(403).json({
        message: 'Choose your own password before continuing.',
        code: PASSWORD_CHANGE_REQUIRED,
        mustChangePassword: true,
      });
    }
    // Background polls (the dashboard's own refresh loop) are not evidence that
    // a human is at the keyboard, so they must not hold a session open — hence
    // the opt-out header the client sets on them.
    if (req.get('x-admin-background') !== 'true') {
      // Throttled in the database. See heartbeatAdmin: this was one write per
      // request and is now at most one per ADMIN_HEARTBEAT_INTERVAL_MS.
      heartbeatAdmin(admin._id);
    }
    req.user = { _id: admin._id, role: 'admin', alias: admin.alias, mustChangePassword: !!admin.mustChangePassword };
    req.authDecoded = decoded;
    return next();
  }

  // ── User session validation (server is authoritative) ───────────────────
  // A signed JWT alone is NOT enough: the session must exist, belong to this
  // account, be unrevoked, and still be the account's current active session.
  //
  // Cached for 30s: the DB lookup was the single largest source of read
  // traffic (every API call = 1 session query + 1 data query). Sessions
  // change rarely, and a stale entry for 30s is harmless — sign-out bumps
  // sessionVersion which changes the sid, so the old entry is never reused.
  const sid = decoded.sid;
  if (sid) {
    const cached = getCachedSession(sid);
    if (cached) {
      req.user = cached.user;
      req.sessionId = cached.sid;
      req.authDecoded = decoded;
      touchSession(cached.sid);
      return next();
    }
  }
  try {
    const check = await verifyUserSession(decoded);
    if (!check.ok) return rejectSession(res, check);
    // Cache the validated session for subsequent requests
    if (check.sid) setCachedSession(check.sid, check.user);
    req.user = check.user;
    req.sessionId = check.sid;
    req.authDecoded = decoded;
    touchSession(check.sid);
    return next();
  } catch (error) {
    // Failed lookup = outage, not a bad token: 503 so the client shows
    // "try again" instead of wiping a perfectly good session.
    console.error('[auth] session lookup failed:', error.message);
    return res.status(503).json({ message: 'The service is temporarily unavailable. Please try again.' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required.' });
  next();
};

module.exports = {
  protect,
  adminOnly,
  rejectSession,
  invalidateUserSessionCache,
  SESSION_ENDED_MESSAGE,
  PASSWORD_CHANGE_REQUIRED,
  PASSWORD_CHANGE_ALLOWLIST,
  mayChangePassword,
};
