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
const SESSION_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const SESSION_CACHE_MAX = 5000;

function getCachedSession(sid) {
  const entry = sessionCache.get(sid);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    sessionCache.delete(sid);
    return null;
  }
  return entry;
}

function setCachedSession(sid, user) {
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    // Evict oldest entries when cache is full
    const now = Date.now();
    for (const [key, val] of sessionCache) {
      if (now > val.exp) sessionCache.delete(key);
    }
    // If still too large, delete oldest 25%
    if (sessionCache.size >= SESSION_CACHE_MAX) {
      const keys = [...sessionCache.keys()];
      for (let i = 0; i < keys.length / 4; i++) {
        sessionCache.delete(keys[i]);
      }
    }
  }
  sessionCache.set(sid, { user, sid, exp: Date.now() + SESSION_CACHE_TTL_MS });
}

function invalidateSessionCache(sid) {
  sessionCache.delete(sid);
}

// The admin session policy lives in utils/adminSession.js — the idle window, the
// token lifetime and the heartbeat interval are defined once and their ordering
// is asserted there. They used to be literals in this file and in routes/auth.js
// with a comment claiming they were kept in step.
const {
  ADMIN_IDLE_TIMEOUT_MS,
  ADMIN_HEARTBEAT_INTERVAL_MS,
} = require('../utils/adminSession');

// Throttled lastActivityAt writes (informational only — activity never
// expires a session; users are never logged out for being idle).
//
// MUST be shorter than ADMIN_IDLE_TIMEOUT_MS, or a continuously active admin is
// signed out: the write is throttled and stops happening while the idle check
// keeps reading the value it would have written. The invariant is asserted in
// adminSession.js; the value is derived there rather than typed here.
const TOUCH_INTERVAL_MS = ADMIN_HEARTBEAT_INTERVAL_MS;
const lastTouched = new Map(); // sid → epoch ms
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
      // Only admin tokens carry `exp`; user sessions never expire by time.
      return res.status(401).json({ message: 'Your session has expired. Please sign in again.', code: TOKEN_EXPIRED });
    }
    if (error.name === 'NotBeforeError') {
      return res.status(403).json({ message: 'Token not active yet.' });
    }
    return res.status(401).json({ message: 'Not authorized, token failed', code: INVALID_TOKEN });
  }

  // Admin sessions: short sliding TTL + idle kill (unchanged behaviour).
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
    if (admin.lastActivityAt && Date.now() - admin.lastActivityAt.getTime() > ADMIN_IDLE_TIMEOUT_MS) {
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
    if (req.get('x-admin-background') !== 'true') {
      // Fire-and-forget heartbeat (no per-request document validation/save race)
      AdminAccount.updateOne({ _id: admin._id }, { $set: { lastActivityAt: new Date() } }).exec()
        .catch(() => {});
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
  SESSION_ENDED_MESSAGE,
  PASSWORD_CHANGE_REQUIRED,
  PASSWORD_CHANGE_ALLOWLIST,
  mayChangePassword,
};
