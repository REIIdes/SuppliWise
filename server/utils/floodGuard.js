/**
 * Flood protection that runs BEFORE a single body byte is buffered.
 *
 * Two independent layers, because rate limiting and memory exhaustion are
 * different attacks:
 *
 *   floodGuard() — a coarse per-IP meter over EVERY request path. It closes
 *                  the gaps the per-family limiters cannot see: /api/health
 *                  and the JSON /api 404 had no limiter at all, so they were
 *                  an unbounded source of cheap requests. It is registered
 *                  before all of them, so a specific limiter still fires
 *                  first wherever one exists; this only catches what the
 *                  specific limiters never see.
 *
 *   bodyBudget() — a global cap on the JSON bytes allowed to be IN FLIGHT.
 *                  express-rate-limit bounds requests/second, not heap. With
 *                  a 10 mb parser limit, N *allowed* requests can still sum
 *                  to an unbounded allocation — so a flood can exhaust memory
 *                  even while every limiter happily answers 200.
 *
 * Both must be mounted ahead of express.json(); mounted behind it they run
 * only after the body has already been read, which is exactly backwards.
 */

const rateLimit = require('express-rate-limit');
const { limitReachedHandler } = require('./lockout');

/**
 * True for local dev and loopback clients. Same rule the per-family limiters
 * use so repeated localhost testing and HMR never fight a production ceiling.
 * `req.ip` is coerced with String() because it can be undefined on a socket
 * that dies mid-handshake — an unguarded `.includes()` there would throw
 * inside the limiter's `max` callback and surface as a 500 per request.
 */
const isLocalDevRequest = (req) => {
  if (process.env.NODE_ENV !== 'production') return true;
  const hostname = String(req.hostname || '');
  const ip = String(req.ip || '');
  return hostname === 'localhost' || hostname === '127.0.0.1' ||
    ip.includes('127.0.0.1') || ip.includes('::1');
};

// Coarse outer envelope. Deliberately looser than every per-family limiter
// (auth 20/15 min, user 120/min, recommend 15/10 min in production) so
// legitimate traffic is always caught by the specific rule first. This one
// only has to stop a flood from being *unbounded*.
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_MAX = { production: 1200, development: 12000 };

// Volumetric abuse only — deliberately NOT wired to limitReachedHandler.
// Escalating a pure volume 429 up the brute-force ladder would let anyone
// burn a shared-NAT IP's budget to lock that whole office out of sign-in.
// Credential abuse still escalates via authLimiter/adminLimiter.
const floodGuard = () => rateLimit({
  windowMs: GLOBAL_WINDOW_MS,
  max: (req) => (isLocalDevRequest(req) ? GLOBAL_MAX.development : GLOBAL_MAX.production),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down and try again.' },
});

const BYTES_PER_MB = 1024 * 1024;
const MB = (n) => n * BYTES_PER_MB;

// Total JSON allowed to be buffered at once, across ALL concurrent requests.
// Sized so several full-size profile pictures can upload at once while a
// determined flood still cannot walk the heap up to the OOM killer — and so
// the sum of concurrent JSON.parse work stays bounded (that parse blocks the
// event loop, so this doubles as a CPU cap, not just a memory cap).
const DEFAULT_INFLIGHT_BUDGET = MB(32);

const METHODS_WITH_BODIES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ── Client-error log throttle ──────────────────────────────────────────────
// Bounds how fast a caller can grow the log. An oversized-body flood produces
// one error per request, so an unthrottled handler writes attacker-sized
// output at attacker-chosen rate — a way to fill the disk without ever
// touching the app. Fixed budget per minute, then a single summary line: the
// log stays useful (you still see the error) and bounded (you cannot fill it).
const CLIENT_ERROR_LOG_BUDGET_PER_MIN = 60;
let clientErrWindowStart = Date.now();
let clientErrLogged = 0;
let clientErrSuppressed = 0;

function logClientError(status, method, path, message) {
  const now = Date.now();
  if (now - clientErrWindowStart >= 60_000) {
    if (clientErrSuppressed > 0) {
      console.error(`[client-error] … and ${clientErrSuppressed} more in the last minute (suppressed to bound log growth)`);
    }
    clientErrWindowStart = now;
    clientErrLogged = 0;
    clientErrSuppressed = 0;
  }
  if (clientErrLogged < CLIENT_ERROR_LOG_BUDGET_PER_MIN) {
    clientErrLogged += 1;
    console.error(`[client-error] ${status} ${method} ${path}: ${message}`);
  } else {
    clientErrSuppressed += 1;
  }
}

/**
 * @param {number} maxBodyBytes the LARGEST parser limit mounted anywhere —
 *   used as the reservation for chunked bodies, which declare no
 *   Content-Length, so their real size is unknown until they finish arriving.
 *   Reserving less than the parser would accept would let a chunked body
 *   buffer more than it accounted for.
 * @param {number} [budgetBytes] global in-flight ceiling.
 */
function bodyBudget(maxBodyBytes, budgetBytes = DEFAULT_INFLIGHT_BUDGET) {
  const max = Number(process.env.MAX_INFLIGHT_JSON_BYTES) > 0
    ? Number(process.env.MAX_INFLIGHT_JSON_BYTES)
    : budgetBytes;
  let inFlight = 0;

  return function bodyBudgetMiddleware(req, res, next) {
    if (!METHODS_WITH_BODIES.has(req.method)) return next();

    // Content-Length is authoritative for framing: Node caps the body at the
    // declared length, so a client that *lies* small cannot make us buffer
    // more than we reserved (extra bytes are parsed as the next request and
    // rejected as malformed). Chunked bodies declare nothing, so reserve the
    // worst case — the parser limit — for them.
    const declared = Number(req.headers['content-length']);
    // Never reserve more than the parser could ever buffer. A body larger than
    // the limit is answered 413 straight away, so counting its full declared
    // length would let a single oversized request evict every other one.
    const reserve = Number.isFinite(declared) && declared > 0
      ? Math.min(declared, maxBodyBytes)
      : maxBodyBytes;

    if (inFlight + reserve > max) {
      res.set('Retry-After', '1');
      // Reject WITHOUT reading the body. That leaves req.complete === false,
      // and Node would otherwise reuse the keep-alive socket anyway, destroying
      // it mid-upload — an RST that swallows this very response before the
      // client can read it. Declaring close tells the stack to finish the
      // response gracefully instead, so the rejection actually arrives.
      res.set('Connection', 'close');
      return res.status(503).json({
        message: 'The server is busy. Please try again in a moment.',
      });
    }

    inFlight += reserve;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - reserve);
    };
    // 'finish' on a clean response, 'close' when the client vanishes or the
    // parser errors. Registering both (idempotently) is what keeps a flood of
    // aborted uploads from leaking its reservation and wedging the budget.
    res.on('finish', release);
    res.on('close', release);

    next();
  };
}

/**
 * Refuse an oversized body from its Content-Length, before body-parser runs.
 *
 * body-parser cannot do this itself, and this is not a theoretical concern —
 * it was measured. On a limit violation its error path calls `dump()`, which
 * resumes the request and waits for `onFinished`: it reads the ENTIRE
 * oversized body before it will hand the 413 to Express. Consequences:
 *
 *   • a declared 4 MB against a 1 MB cap costs a full 4 MB upload before the
 *     refusal — the attacker chooses how much work we do, and it is never
 *     less than what they send;
 *   • a body that dribbles but never completes gets NO response AT ALL. The
 *     socket, and the bodyBudget reservation held for it, stay occupied until
 *     requestTimeout reaps them 60 s later. Measured directly: a 4 MB header
 *     carrying 4 KB of payload was still unanswered after 15 s.
 *
 * One Number() against the header answers immediately instead.
 *
 * @param {number} limitBytes the parser limit that will apply downstream —
 *   this must mirror express.json()'s own `limit` per mount, or a route that
 *   legitimately accepts more (the base64 picture routes) would start
 *   rejecting its own payloads here.
 */
function rejectOversized(limitBytes) {
  return function oversizedBodyGuard(req, res, next) {
    if (!METHODS_WITH_BODIES.has(req.method)) return next();
    // A wider per-route guard already approved this request. Mirrors how
    // express.json() uses req._body: the scoped 10 mb mount is registered
    // first and runs first, so without this the blanket 1 mb guard underneath
    // would re-check and reject the picture routes' own valid payloads.
    if (req._sizeApproved) return next();
    req._sizeApproved = true;

    const declared = Number(req.headers['content-length']);
    if (!Number.isFinite(declared) || declared <= limitBytes) return next();

    logClientError(413, req.method, req.path, 'request entity too large');
    // The body is never read, so req.complete is false. Without this Node
    // reuses the keep-alive socket and destroys it mid-upload, an RST that
    // swallows this very response — same reasoning as bodyBudget's 503.
    res.set('Connection', 'close');
    return res.status(413).json({ message: 'request entity too large' });
  };
}

module.exports = {
  isLocalDevRequest,
  floodGuard,
  bodyBudget,
  rejectOversized,
  logClientError,
  GLOBAL_WINDOW_MS,
  GLOBAL_MAX,
  DEFAULT_INFLIGHT_BUDGET,
  MB,
};
