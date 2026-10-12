/**
 * Shared Server-Sent Events plumbing, extracted from routes/subscription.js
 * (the first and previously only SSE consumer) so the support-chat streams
 * reuse the exact behaviour that is already proven through the dev proxy, the
 * TLS server and any reverse proxy in front of production.
 */

// SSE_HEARTBEAT_MS comments a live connection so intermediaries never decide
// it is idle and drop it; well under typical 60s proxy timeouts.
const SSE_HEARTBEAT_MS = 25_000;

// EventSource cannot set an Authorization header, so stream endpoints accept
// the access token as a query parameter. Scoped to THOSE routes only — every
// other endpoint still requires the header, so the token never appears in
// logs/URLs anywhere else. This mirrors the note in middleware/auth.js: the
// header copy happens BEFORE protect runs.
const streamTokenAuth = (req, res, next) => {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${String(req.query.token)}`;
  }
  next();
};

function sseWrite(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function sseHeaders(res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering so events arrive instantly (nginx/CDN).
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

// User access tokens carry no `exp` (see utils/userSession.js); admin tokens
// do. A stream riding an expiring credential must close shortly BEFORE the
// expiry so the client reconnects with a fresh token instead of silently
// holding a dead credential. Returns null when there is nothing to schedule.
function tokenExpiryDelayMs(req) {
  try {
    const raw = (req.headers.authorization || '').split(' ')[1] || '';
    const exp = raw ? require('jsonwebtoken').decode(raw)?.exp : null;
    if (!exp) return null;
    const ttl = exp * 1000 - Date.now() - 5_000;
    return ttl > 0 && ttl < 60 * 60 * 1000 ? ttl : null;
  } catch {
    return null;
  }
}

module.exports = { SSE_HEARTBEAT_MS, streamTokenAuth, sseWrite, sseHeaders, tokenExpiryDelayMs };
