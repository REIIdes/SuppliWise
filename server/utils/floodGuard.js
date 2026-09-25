/**
 * Flood protection that runs BEFORE a single body byte is buffered.
 *
 * Three independent layers, because rate limiting, memory exhaustion and
 * wasted upload are different attacks:
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
 *   rejectOversized() — a Content-Length check ahead of body-parser. Its own
 *                  413 path drains the whole body before responding, so
 *                  without this the price of refusing an oversized upload is
 *                  reading all of it. See its comment for the measurements.
 *
 * All three must be mounted ahead of express.json(); mounted behind it they run
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
      console.error(`[client-error] ... and ${clientErrSuppressed} more in the last minute (suppressed to bound log growth)`);
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

// ── Graceful rejection send ─────────────────────────────────────────────────
// An early rejection is written while the request body is still unread. The
// instant the response "finishes", Node tears the socket down — and because
// those unread bytes are still in the receive buffer, that teardown is a TCP
// RST, not a FIN. An RST DISCARDS whatever the peer has not yet read, which
// includes the response we just wrote. The client therefore reports a plain
// network error instead of the 413/503 it was actually given.
//
// This was measured, not guessed: the server logged every rejection, curl
// received 6/6 of them, and yet both Node's http client and undici fetch
// reported ECONNRESET with bytesRead=0 — zero bytes ever reached the parser.
//
// Sending the full body immediately but delaying only the FIN gives the peer
// time to read it. There is no added latency for the client: it has the whole
// message (Content-Length satisfied) the moment we write it, and completes
// without waiting for the close. The cost is holding the socket for the grace
// period, which is bounded — rejections can only arrive at whatever rate the
// global limiter already admitted, so this pins a few dozen sockets at most,
// never a growing number. (Measured: a client pushing 80 x 4 MB concurrently
// still needs ~200 ms to get its own writes out of the way and read the reply,
// so 150 ms was measurably too tight; 400 ms clears it with room to spare.)
const CLOSE_GRACE_MS = 400;

function sendAndClose(res, status, payload) {
  const body = JSON.stringify(payload);
  res.status(status);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Length', Buffer.byteLength(body));
  res.set('Connection', 'close');
  res.write(body);
  const timer = setTimeout(() => res.end(), CLOSE_GRACE_MS);
  // If the peer goes away first, stop holding the timer open.
  res.on('close', () => clearTimeout(timer));
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
      // Reject WITHOUT reading the body — that is the whole point of the
      // budget. sendAndClose() keeps the refusal deliverable anyway (see its
      // comment): an immediate teardown would RST and swallow the response.
      return sendAndClose(res, 503, {
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

    // originalUrl, not path: as a mounted middleware `req.path` is already
    // stripped to the mount remainder ("/"), which makes the log useless for
    // the two scoped profile routes.
    logClientError(413, req.method, String(req.originalUrl || req.url || '').split('?')[0], 'request entity too large');
    // Never read the body, and never absorb it: draining would hand an attacker
    // exactly the work this guard exists to refuse. sendAndClose() makes the
    // refusal deliverable without doing so.
    return sendAndClose(res, 413, { message: 'request entity too large' });
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
