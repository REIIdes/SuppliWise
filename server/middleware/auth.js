const jwt = require('jsonwebtoken');
const AdminAccount = require('../models/AdminAccount');
const {
  verifyUserSession,
  SESSION_ENDED_MESSAGE,
  NO_SESSION,
  INVALID_TOKEN,
  TOKEN_EXPIRED,
} = require('../utils/sessions');

const ADMIN_IDLE_TIMEOUT_MS = (3 * 60 + 30) * 1000;

// Throttled lastActivityAt writes (informational only — activity never
// expires a session; users are never logged out for being idle).
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
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
      admin = await AdminAccount.findById(adminId).select('alias enabled lastActivityAt');
    } catch (error) {
      // Lookup failure = outage, not a bad session — never sign admins out over it.
      return res.status(503).json({ message: 'The service is temporarily unavailable. Please try again.' });
    }
    if (!admin || !admin.enabled) return res.status(401).json({ message: 'Admin account is unavailable.' });
    if (admin.lastActivityAt && Date.now() - admin.lastActivityAt.getTime() > ADMIN_IDLE_TIMEOUT_MS) {
      return res.status(401).json({ message: 'Admin session expired after inactivity.' });
    }
    if (req.get('x-admin-background') !== 'true') {
      // Fire-and-forget heartbeat (no per-request document validation/save race)
      AdminAccount.updateOne({ _id: admin._id }, { $set: { lastActivityAt: new Date() } }).exec()
        .catch(() => {});
    }
    req.user = { _id: admin._id, role: 'admin', alias: admin.alias };
    req.authDecoded = decoded;
    return next();
  }

  // ── User session validation (server is authoritative) ───────────────────
  // A signed JWT alone is NOT enough: the session must exist, belong to this
  // account, be unrevoked, and still be the account's current active session.
  try {
    const check = await verifyUserSession(decoded);
    if (!check.ok) return rejectSession(res, check);
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
};
