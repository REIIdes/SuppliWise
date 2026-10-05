const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
// .env MUST be loaded by envFile, not by calling dotenv directly: envFile
// snapshots the real environment first, so a later reload can tell an
// OS-provided variable from one that only exists because .env defined it.
// Requiring dotenv here instead would lose that distinction forever.
require('./utils/envFile').reloadFromDisk();

const authRoutes = require('./routes/auth');
// Emailed-link password reset. A separate file rather than more of
// routes/auth.js, mounted under the same /api/auth prefix (see STAGE 3).
const passwordResetRoutes = require('./routes/passwordReset');
// The 2026 authentication-security surface. Each is its own router so the
// credential logic stays readable, and all four hang off the SAME /api/auth
// prefix, so they inherit the flood guard, lockout check and auth limiter
// registered in STAGE 1 below — the strictest rate limiting in the app is
// exactly where these endpoints must live.
const passkeyRoutes = require('./routes/passkeys');
const totpRoutes = require('./routes/totp');
const recoveryCodeRoutes = require('./routes/recoveryCodes');
const sessionRoutes = require('./routes/sessions');
const assessmentRoutes = require('./routes/assessment');
const recommendRoutes = require('./routes/recommend');
const chatRoutes = require('./routes/chat');
const supportChatRoutes = require('./routes/supportChat');
const adminSupportChatRoutes = require('./routes/adminSupportChats');
const polishRoutes = require('./routes/polish');
const supplementDetailRoutes = require('./routes/supplement_detail');
const dashboardRoutes = require('./routes/dashboard');
const insightsRoutes = require('./routes/insights');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notifications');
const securityRoutes = require('./routes/security');
const subscriptionRoutes = require('./routes/subscription');
const web3Routes = require('./routes/web3');
const { PICTURE_DIR } = require('./utils/pictures');
const AdminAccount = require('./models/AdminAccount');
// The one trusted-origin list, and the CSRF guard built on it. See the CORS
// block below for why these two used to be separate concerns.
const { isAllowed: isTrustedOrigin, verifyOrigin, assertProductionConfigured, list: trustedOriginList } = require('./utils/origins');
// WebAuthn / passkey relying-party configuration. Loading it here is what makes
// the production boot check below possible.
const webauthn = require('./utils/webauthn');
const secretBox = require('./utils/secretBox');

const app = express();

// ── Reverse proxy ─────────────────────────────────────────────────────────
// Off by default: with it OFF, `req.ip` is the real socket peer, so a
// client-supplied X-Forwarded-For header can never spoof the address that
// rate limits, lockouts and login-location evidence key on. Set
// TRUST_PROXY=true ONLY when the app sits behind a proxy you control
// (nginx / Cloudflare / a load balancer) — then Express picks the real
// client hop from the forwarded chain instead of trusting the raw header.
// `1` trusts exactly one hop (the proxy itself), never the whole chain.
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

// `JWT_SECRET` signs BOTH user and admin session tokens. User tokens are minted
// with no `exp` (sessions.js), so a guessed secret means forgeable tokens for
// every account with no expiry to fall back on. The admin security monitor
// reported short secrets as Critical, but nothing prevented one from booting.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'suppliwise_jwt_secret_key_change_in_production') {
  throw new Error('JWT_SECRET is missing or still uses the default placeholder value.');
}
if (process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters. Use a long random value (e.g. `openssl rand -hex 32`).');
}

// Production safeguard: OTP values must never be exposed in API responses.
// Refuse to boot live with the dev override enabled.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_OTP_RESPONSE === 'true') {
  throw new Error('ALLOW_DEV_OTP_RESPONSE must never be "true" in production.');
}

// Password reset links are built from PUBLIC_WEB_URL, and that value decides
// where a real user's reset actually goes. Unset in production, the link is
// built for http://localhost:5173 and every reset email a real user receives is
// a dead end — a failure that only shows up once someone is actually locked out,
// and looks like a broken product rather than a missing setting. Refuse to boot.
if (process.env.NODE_ENV === 'production' && !String(process.env.PUBLIC_WEB_URL || '').trim()) {
  throw new Error('PUBLIC_WEB_URL must be set in production — it is the origin password reset links point at.');
}

// ── Authentication-security boot checks ────────────────────────────────────
// Each of these refuses to start a production server that would be quietly,
// silently weaker than it looks. All three fail at BOOT rather than at first
// use, because the failure mode they prevent — a fallback to localhost, a key
// derived from another secret, an empty origin allowlist — is invisible from
// the outside until a real user is the one affected.

// 1. Trusted origins. `Allow-Credentials: true` with no configured allowlist is
//    a configuration that looks locked down and is not.
assertProductionConfigured();

// 2. The TOTP encryption key. Without it the seed key is derived from
//    JWT_SECRET, which means anyone who can forge tokens can also decrypt every
//    authenticator seed in the database.
const secretKey = secretBox.describe();
if (process.env.NODE_ENV === 'production' && !secretKey.available) {
  throw new Error('No TOTP encryption key is available. Set TOTP_ENCRYPTION_KEY to a base64/hex 32-byte value in production.');
}
if (process.env.NODE_ENV === 'production' && secretKey.source !== 'TOTP_ENCRYPTION_KEY') {
  throw new Error(
    'TOTP_ENCRYPTION_KEY must be set explicitly in production. Falling back to a key derived from JWT_SECRET '
    + 'ties token forgery to authenticator-seed decryption, which is not a separation anyone relying on 2FA expects.',
  );
}

// 3. WebAuthn. A passkey ceremony needs a real RP ID and real https origins.
//    A localhost fallback here produces credentials that work on one developer's
//    machine and nowhere else, and the only symptom is real users failing to
//    use the feature meant to save them. Outside production the module falls
//    back to loopback dev origins so a fresh clone works, and the warning at
//    the bottom of this file says so.
const passkeyConfig = webauthn.describe();
if (process.env.NODE_ENV === 'production' && !passkeyConfig.configured) {
  throw new Error(`WebAuthn is not configured for production: ${passkeyConfig.error}`);
}

// ── Security headers ──────────────────────────────────────────────────────
// Helmet sets X-Frame-Options, X-Content-Type-Options, HSTS, etc.
// Strict CSP: this origin serves JSON only (no HTML/JS ever rendered), so
// `default-src 'none'` + `frame-ancestors 'none'` blocks any injected
// content from executing if an upstream layer ever reflects markup.
// Safe for the SPA: the Vite frontend is a separate origin (localhost:5173)
// and only consumes JSON — it never renders this origin's responses as pages.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// ── Compression ────────────────────────────────────────────────────────────
// Compress all responses. AI recommendation payloads can be ~500KB uncompressed;
// gzip typically reduces them to ~50KB. This is a major latency win for
// mobile users on slow connections.
app.use(compression({
  level: 6, // balanced between CPU and compression ratio
  threshold: 1024, // only compress responses > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));

// Middleware
// CORS, from ONE trusted-origin list shared with the CSRF guard below.
//
// This used to be a hard-coded array that only the `cors` package ever saw.
// Two problems with that shape, both now fixed:
//
//  1. An allowlist that exists only in CORS is not a CSRF defence. CORS stops
//     a foreign page from READING a response; it does not stop one from causing
//     a state change, because a "simple" cross-origin POST is sent and only the
//     reply is withheld. `verifyOrigin` below is the server-side rule.
//
//  2. `http://192.168.x.x` origins were trusted unconditionally, which is a
//     development affordance presented as a default. utils/origins.js confines
//     it to non-production (or an explicit opt-in that warns), and production
//     refuses to boot without a configured allowlist — because
//     `Allow-Credentials: true` with an empty or wildcard origin is a
//     configuration that looks secure and is not.
//
// The list NEVER contains a wildcard. `Access-Control-Allow-Origin: *` is
// incompatible with credentials anyway, and the dangerous variant — reflecting
// whatever Origin arrives — is exactly what this replaces.
app.use(cors({
  origin(origin, callback) {
    // No Origin header at all: a same-origin request, curl, a native client or
    // a server-to-server call. Nothing to decide, so it is allowed — refusing
    // it would break the Capacitor build and every integration test.
    if (!origin) return callback(null, true);
    return callback(null, isTrustedOrigin(origin));
  },
  credentials: true,
}));

// CSRF / origin guard for every state-changing request, mounted globally.
//
// This API is Bearer-authenticated, so classic CSRF is already structurally
// impossible: a browser will not attach an `Authorization` header to a
// cross-site request, and a third-party page cannot read a token out of another
// origin's storage. This middleware is defence in depth for the day that
// changes — it makes adding a cookie fail CLOSED instead of quietly — and it is
// the control the authentication endpoints specifically are meant to have.
// See utils/origins.js for the exact rule and what it deliberately allows.
app.use(verifyOrigin);
// express.json() is deliberately NOT mounted here. It used to sit above every
// rate limiter, so each request body was fully read into memory before any
// limiter could see the request: a flood of 10 MB bodies was buffered and only
// *then* counted and answered 429. Metering has to run ahead of parsing or it
// protects nothing — the parser is mounted below, after the limiters (STAGE 2).

// Add a middleware to set Cache-Control headers
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── Profile / banner images ────────────────────────────────────────────────
// Served from disk rather than stored inline in the user document: a single
// inline banner made one account's document ~3 MB, which turned every sign-in
// into two ~30 s round-trips and broke the login button outright. See
// utils/pictures.js for the full story.
//
// Mounted OUTSIDE /api, so it is served with normal static caching instead of
// the no-store above, and ahead of every rate limiter: an <img> tag cannot
// carry an Authorization header, and pictures are immutable (the filename is
// content-addressed), so they are safe to cache hard and cheap to serve.
//
// Helmet sets `Cross-Origin-Resource-Policy: same-origin`, which the browser
// enforces when the SPA (dev server on :5173, or a deployed web origin) loads
// an image from the API origin (:5000) — every avatar would be blocked. The
// pictures are public, non-sensitive assets by nature, so this route opts back
// in to cross-origin reads. Scoped to /pictures; every other response keeps
// the stricter default.
app.use('/pictures', (req, res, next) => {
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});
app.use('/pictures', express.static(PICTURE_DIR, {
  index: false,
  dotfiles: 'ignore',
  // A picture's URL changes whenever its bytes change, so a cached copy can
  // never be stale.
  immutable: true,
  maxAge: '365d',
}));

// ── Rate limiters ──────────────────────────────────────────────────────────
// Keep production limits strict while allowing repeated localhost testing.
// Every 429 escalates that IP up the lockout ladder (15 min → 1 h → 6 h → 1 day)
// via lockoutCheck (hard stop) + limitReachedHandler (escalation on each hit).
const { lockoutCheck, limitReachedHandler } = require('./utils/lockout');
const { floodGuard, bodyBudget, rejectOversized, logClientError, isLocalDevRequest } = require('./utils/floodGuard');
const rateLimits = require('./utils/rateLimits');

// Coarse outer meter over every path. /api/health and the JSON 404 below had
// no limiter at all, so they were an unbounded source of cheap requests; this
// covers them and anything a future route forgets to guard. It runs FIRST and
// is looser than every specific limit, so legitimate traffic is still governed
// by the tight per-family rule — this only ever catches what those cannot see.
const requestFloodGuard = floodGuard();

// Traffic under /api/auth that is NOT a credential attempt, and so must never
// consume the sensitive auth budget or escalate the brute-force ladder.
//
//   GET  /me            read-only session/plan traffic; the reactive plan store
//                       refreshes it on focus and on a slow interval. A client
//                       refresh storm once locked users out of their own
//                       accounts.
//   POST /admin-activity  the admin dashboard's "I am still here" beacon, sent
//                       at most once a minute while an administrator is actually
//                       working. It carries no credential and guesses nothing, so
//                       counting it would spend 15 of the 20 requests a
//                       non-loopback deployment gets per 15 minutes on a
//                       background ping — leaving a legitimate admin unable to
//                       sign in. It is authenticated (see `protect`) and it
//                       mints nothing, so it cannot be used to attack anything;
//                       the broad flood guard above still applies.
//
// Both are served by generous buckets below rather than being unlimited.
const isSessionRead = (req) => (
  (req.method === 'GET' && (req.path === '/me' || req.path === '/me/'))
  || (req.method === 'POST' && req.path === '/admin-activity')
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Two ceilings, not one: a loopback developer (or the e2e suites, which talk
  // to 127.0.0.1) and a real deployment need wildly different numbers for the
  // same policy, and one compromise value serves neither. Both are
  // configuration — see utils/rateLimits.js. Defaults are unchanged.
  max: (req) => (isLocalDevRequest(req)
    ? rateLimits.limit('AUTH_RATE_LIMIT_MAX_LOCAL', 200)
    : rateLimits.limit('AUTH_RATE_LIMIT_MAX', 20)),
  standardHeaders: true,
  legacyHeaders: false,
  skip: isSessionRead,
  message: { message: 'Too many attempts. Please wait 15 minutes and try again.' },
  handler: limitReachedHandler('Too many attempts. Lockout escalated — please wait and try again.'),
});

// Session/plan reads: generous, non-escalating (protected by auth + no store).
const sessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => isLocalDevRequest(req) ? 1500 : 400,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many session refreshes. Please wait a moment and try again.' },
});

// Recommend: 15 requests per 10 min per IP (protects Groq quota)
const recommendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please wait a few minutes and try again.' },
});

// AI-adjacent endpoints: generous but bounded (protects OpenRouter quota)
const aiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req) => isLocalDevRequest(req) ? 300 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please wait a few minutes and try again.' },
});

// General API abuse guard (dashboard/insights/assessment polling) — kept for future use
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: (req) => isLocalDevRequest(req) ? 600 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down and try again.' },
});

// ── Dedicated rate limiters for Admins vs Users ───────────────────────────
// Separate buckets so admin traffic never starves user traffic and vice-versa.
// Production limits are stricter; local dev stays generous for testing/HMR.
const userLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: (req) => isLocalDevRequest(req) ? 600 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down and try again.' },
});

const adminLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: (req) => isLocalDevRequest(req) ? 300 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many admin requests. Please slow down and try again.' },
  handler: limitReachedHandler('Too many admin requests. Lockout escalated — please wait and try again.'),
});

// ── STAGE 1 — METER (before a single body byte is buffered) ────────────────
// Admin vs user buckets are isolated; lockoutCheck hard-stops IPs serving an
// escalated lockout before any limiter or handler runs.
// Session/plan reads get their own non-escalating bucket (registered first so
// it applies to /api/auth/me before the strict auth limiter).
app.use('/api', requestFloodGuard);
app.use('/api/auth/me', sessionLimiter);
app.use('/api/auth', lockoutCheck, authLimiter);
app.use('/api/assessment', userLimiter);
// Subscription state is polled/streamed by every open session — use the
// non-escalating session bucket so it can never trip lockouts.
app.use('/api/subscription', sessionLimiter);
app.use('/api/recommend', recommendLimiter);
app.use('/api/chat', userLimiter);
// Human support conversations (the "where did I pay" channel). Same
// non-escalating user bucket as the rest of the feature surface: a member
// writing to support must never climb the brute-force lockout ladder.
app.use('/api/support-chat', userLimiter);
app.use('/api/polish', aiLimiter);
app.use('/api/supplement-detail', aiLimiter);
app.use('/api/dashboard', userLimiter);
app.use('/api/insights', userLimiter);
app.use('/api/notifications', userLimiter);
// Account-security dashboard. Its own limiter inside the router is stricter
// (these are credential-adjacent endpoints), and it is deliberately NOT part
// of the escalating auth bucket: reviewing your own security page must never
// count toward a lockout.
app.use('/api/security', userLimiter);
// Blockchain layer (wallets, supply chain, marketplace, DAO, rewards, data
// sovereignty). Same non-escalating user bucket: normal feature traffic must
// never climb the brute-force lockout ladder.
app.use('/api/web3', userLimiter);
app.use('/api/admin', lockoutCheck, adminLimiter);

// ── STAGE 2 — PARSE (only requests that passed metering reach here) ────────
// The byte budget caps how much JSON may be buffered *in total* across all
// concurrent requests. Rate limits bound requests/second; they do not bound
// the heap — N allowed requests × 10 MB each can still exhaust memory while
// every limiter happily answers 200.
const JSON_LIMIT_BYTES = 1 * 1024 * 1024;           // every text payload
const JSON_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;   // base64 pictures only
// Reserve BEFORE parsing, using the largest parser limit anywhere as the
// worst case for a chunked body (which declares no length).
app.use(bodyBudget(JSON_UPLOAD_LIMIT_BYTES));

// Three base64-picture routes need the wide limit; everything else is text.
// body-parser sets req._body once it has run, so mounting the 10 mb parser on
// just these paths *ahead of* the blanket parser scopes the allowance to them
// and only them (audit finding L7 — "reduce with a per-route limit").
//
// Oversized bodies are refused from Content-Length by rejectOversized() BELOW,
// which must be mounted per-route in exactly the same shape — otherwise the
// blanket 1 mb guard would start rejecting the picture routes' own payloads.
//
// Why it matters: JSON.parse blocks Node's single-threaded event loop for the
// whole parse, so a blanket 10 mb cap turned every endpoint into a CPU sink —
// a handful of concurrent oversized bodies could stall *all* traffic for
// seconds while still passing every rate limit. Held to 1 mb, one request can
// only ever monopolise the loop for a few milliseconds.
// Refuse oversized payloads from their headers, ahead of the parsers. This has
// to sit *before* express.json(): body-parser's own 413 path dumps the whole
// request first (see rejectOversized), which would mean paying for exactly the
// upload we are trying to refuse — and never answering at all for a body that
// stops mid-flight.
app.use('/api/auth/profile', rejectOversized(JSON_UPLOAD_LIMIT_BYTES));
app.use('/api/admin/profile', rejectOversized(JSON_UPLOAD_LIMIT_BYTES));
// Proof-of-payment receipts. Same rule, same reason: the request body carries a
// base64 image (~2.7 MB for the 2 MB cap in utils/subscriptionRequests.js), so
// the blanket 1 MB guard would reject a receipt the picker already accepted.
app.use('/api/subscription/requests', rejectOversized(JSON_UPLOAD_LIMIT_BYTES));
app.use(rejectOversized(JSON_LIMIT_BYTES));

app.use('/api/auth/profile', express.json({ limit: JSON_UPLOAD_LIMIT_BYTES }));
app.use('/api/admin/profile', express.json({ limit: JSON_UPLOAD_LIMIT_BYTES }));
app.use('/api/subscription/requests', express.json({ limit: JSON_UPLOAD_LIMIT_BYTES }));
app.use(express.json({ limit: JSON_LIMIT_BYTES }));

// ── STAGE 3 — HANDLE ───────────────────────────────────────────────────────
// Password reset (emailed link) is mounted BEFORE routes/auth.js so it owns
// /api/auth/password-reset/*. It still inherits the /api/auth flood guard,
// lockout check and global auth limiter registered in STAGE 1 — a narrower
// mount of a wider middleware is normal Express, and the per-flow rate limits
// inside the router stack on top of those.
// Password reset (emailed link) is mounted BEFORE routes/auth.js so it owns
// /api/auth/password-reset/*. It still inherits the /api/auth flood guard,
// lockout check and global auth limiter registered in STAGE 1 — a narrower
// mount of a wider middleware is normal Express, and the per-flow rate limits
// inside the router stack on top of those.
//
// The four credential routers below are mounted here too, BEFORE routes/auth.js
// so their more specific paths win, and AFTER it would be a silent 404
// otherwise. Each of them applies its own Origin check and its own per-family
// rate limiter on top of the shared /api/auth ones.
app.use('/api/auth/password-reset', passwordResetRoutes);
app.use('/api/auth/passkeys', passkeyRoutes);
app.use('/api/auth/totp', totpRoutes);
app.use('/api/auth/recovery-codes', recoveryCodeRoutes);
app.use('/api/auth/sessions', sessionRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/recommend', recommendRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/support-chat', supportChatRoutes);
app.use('/api/polish', polishRoutes);
app.use('/api/supplement-detail', supplementDetailRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/web3', web3Routes);
app.use('/api/admin', adminRoutes);
// The admin "Chat management" queue. A separate file rather than more of
// routes/admin.js, but mounted under the same /api/admin prefix so it inherits
// the admin limiter and lockout check registered in STAGE 1 above.
app.use('/api/admin/chats', adminSupportChatRoutes);

// Health check — metered like every other /api path (it was the cheapest
// unbounded endpoint before: no limiter, no headers, no ceiling).
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// ── JSON 404 for the API ───────────────────────────────────────────────────
// Without this, any unmatched /api/* path fell through to Express's default
// handler and answered text/html ("Cannot GET ..."), which every JSON client
// then has to special-case. Registered after all routers + /health so real
// routes always win, and before the error handler so it stays a 404, not a 500.
app.use('/api', (req, res) => {
  res.status(404).json({ message: 'Not found.' });
});

// ── Global error handler — catches any unhandled errors in routes ──────────
// Must be defined AFTER all routes and have 4 parameters (err, req, res, next)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Malformed JSON is an expected client input error, not an application
  // failure. Do not log parser internals or echo the raw SyntaxError text.
  if (err && err.type === 'entity.parse.failed') {
    if (!req.complete) res.set('Connection', 'close');
    return res.status(400).json({ message: 'Invalid JSON request body.' });
  }

  // Never expose stack traces or raw DB errors to the client
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    // A genuine server fault — full detail is exactly what we want in the log.
    console.error('[Global Error Handler]', {
      message: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    });
  } else {
    // 4xx here are EXPECTED client outcomes (413 entity-too-large, malformed
    // JSON, unsupported media type…). Printing a multi-KB stack for each one
    // hands any caller a denial-of-service lever over the log itself: one
    // oversized body per request writes unbounded megabytes and burns CPU on
    // stack formatting. A flood test proved it — dozens of full traces from a
    // single 80-request run. Throttle to a fixed budget per minute instead;
    // after the burst we summarise how many were suppressed.
    logClientError(status, req.method, req.path, err.message);
  }

  const userMessage = status < 500
    ? (err.message || 'An error occurred.')
    : 'Something went wrong. Please try again later.';

  // A body-parser rejection (413, "entity too large") fires before the body
  // has been read, so req.complete is false. Ending gracefully on close lets
  // the client receive this response instead of an RST that discards it.
  if (!req.complete) res.set('Connection', 'close');

  res.status(status).json({ message: userMessage });
});

// ── Crash guards — a single bad request must never take the whole API
// offline (which surfaces client-side as "Failed to fetch" everywhere) ──
// try/catch inside the guards: if the log itself throws (e.g. a broken stdout
// pipe after the host shell dies), Node terminates the process with the
// handler's error — logging must never be able to take the API down.
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack || reason.message : reason);
  } catch { /* keep serving */ }
});
process.on('uncaughtException', (err) => {
  // Some failures mean "there is no server left to keep serving" — swallowing
  // those would strand a zombie process. A bind error is the classic case:
  // the crash guard exists to survive a bad *request*, not a failed boot.
  if (err && typeof err.code === 'string' && ['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].includes(err.code)) {
    try {
      console.error(`[uncaughtException] fatal bind error (${err.code}): ${err.message} — exiting.`);
    } catch { /* logging must not throw */ }
    process.exit(1);
  }
  try {
    console.error('[uncaughtException]', err instanceof Error ? err.stack || err.message : err);
  } catch { /* keep serving */ }
});

// Connect to MongoDB and start server.
// Hardened client: bounded pool, fast boot-fail instead of hanging forever
// on an unreachable host, and no credentials ever touch the logs.
const PORT = process.env.PORT || 5000;
if (!process.env.MONGO_URI) {
  console.error('[mongo] MONGO_URI is not set — refusing to boot without a database.');
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI, {
    maxPoolSize: 50,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 30000,
    // ── Surviving a blip instead of surfacing it ──────────────────────────
    // A login once answered "Something went wrong. Please try again later."
    // because one pooled socket to Atlas timed out:
    //
    //     [login] connection 10 to 159.143.174.62:27017 timed out
    //
    // The credential was correct; the request died anyway. The driver can
    // transparently re-run a single-document read/write on a fresh connection
    // when the failure was a dropped socket or a server that went away, which
    // is exactly this case — but retryWrites/retryReads must be opted into
    // explicitly for the options below to be honoured, and the default
    // `waitQueueTimeoutMS: 0` means a saturated pool waits forever instead of
    // failing cleanly. Both are set here, with a bounded wait so a genuinely
    // exhausted pool reports a retryable 503 rather than hanging the request.
    retryWrites: true,
    retryReads: true,
    waitQueueTimeoutMS: 10000,
  })
  .then(() => {
    console.log('Connected to MongoDB');
    const legacy = process.env.ADMIN_ALIAS && process.env.ADMIN_PASSWORD_HASH && process.env.ADMIN_TOTP_SECRET
      ? [{ alias: process.env.ADMIN_ALIAS, passwordHash: process.env.ADMIN_PASSWORD_HASH, totpSecret: process.env.ADMIN_TOTP_SECRET }]
      : [];
    // Parsed by utils/adminAccounts, NOT with a bare split(','): the entries are
    // comma-joined, but an argon2id hash is itself comma-separated
    // ($argon2id$v=19$m=19456,t=2,p=1$...), so the naive split cut each account
    // into three fragments and the seeder silently ensured only the legacy one.
    // See utils/adminAccounts.js for the delimiter rule.
    const accounts = require('./utils/adminAccounts').configuredAdminAccounts();
    return Promise.all(accounts.map(account => AdminAccount.updateOne({ alias: account.alias }, { $setOnInsert: account }, { upsert: true })))
      // Alias-only log (never secrets/hashes): proves every admin account
      // exists after boot on any device, so a fresh clone + .env self-heals.
      .then((results) => {
        const inserted = results.filter(r => r.upsertedCount > 0).length;
        console.log(`[admin-sync] ${accounts.length} admin account(s) ensured (${inserted} newly inserted): ${accounts.map(a => a.alias).join(', ')}`);
      })
      .then(() => new Promise((resolve, reject) => {
        const server = app.listen(PORT, () => {
          // Slowloris / idle-connection hygiene. Node's defaults allow 60 s
          // for headers and 300 s for a whole body, so a flood of half-open
          // sockets can pin an fd for minutes each; these bound it. Node
          // warns if headersTimeout <= keepAliveTimeout, hence the ordering.
          //
          // `headersTimeout` still bounds how long a client may take to send its
          // HEADERS, and is deliberately left tight — that is the Slowloris
          // surface. `requestTimeout` is a different thing: it bounds the whole
          // exchange INCLUDING our own handler's runtime, so it has to outlast
          // the slowest legitimate AI generation.
          //
          // It was 60 s while a supplement guide is given a 90 s generation
          // budget, which is a contradiction with a very specific symptom: the
          // socket is torn down mid-generation, so a provider that was about to
          // answer is reported to the browser as a network error instead of a
          // guide. Raising the budget without raising this makes that failure
          // MORE likely, not less. 150 s leaves 60 s of headroom to actually
          // format and send the response. Asserted in supplement-guide-store.test.js.
          server.headersTimeout = 15 * 1000;
          server.requestTimeout = 150 * 1000;
          server.keepAliveTimeout = 5 * 1000;
          console.log(`Server running on port ${PORT}`);
          resolve(server);
        });
        // A bind failure is FATAL, not transient. Without this listener the
        // 'error' escapes as an uncaughtException, which the crash guard below
        // deliberately swallows — leaving a zombie that holds a MongoDB pool
        // and serves nothing on the port while a second copy "appears" to run.
        server.once('error', reject);
      }))
      .then(() => {
        // Genesis for the Web3 layer: chain + reference data. Non-blocking, so
        // a seed hiccup must never keep the API from serving requests (the
        // endpoints self-heal by lazy-initializing on first use) — but NOT
        // silent: a swallowed failure here used to present as a permanently
        // "stale" oracle network in the admin monitor with no clue why.
        require('./blockchain/seed').bootstrap().catch((err) => {
          console.error('[web3] bootstrap failed — endpoints will lazy-initialize on first use:', err.message);
        });
        // Pre-compute the ledger's whole-chain audit so the first person to open
        // the admin security monitor does not pay for it. The monitor itself
        // only re-hashes blocks appended since the last proven-good one, so
        // this single background walk is what makes every later check cheap.
        require('./blockchain/ledger').audit().then(
          (result) => {
            if (result && result.valid) {
              console.log(`[web3] chain verified at boot — ${result.checked} block(s), height ${result.height}`);
            } else {
              console.error('[web3] CHAIN INTEGRITY FAILED at boot:', JSON.stringify(result));
            }
          },
          (err) => console.error('[web3] chain audit at boot failed:', err.message),
        );
      })
      .then(() => {
        // Non-blocking SMTP check — bad credentials surface in the log at boot
        const { verifyEmailConfig } = require('./utils/email');
        verifyEmailConfig().catch((err) => {
          console.error('[email] configuration check failed:', err.message);
        });
      })
      .then(() => {
        // No payment processor is integrated, so self-serve "purchase" grants a
        // paid plan for free. It fails closed, but if it has been switched on
        // the entitlement bypass is real and must be visible in the log rather
        // than discovered from a support ticket.
        const { selfServeEnabled } = require('./utils/planCatalogue');
        if (selfServeEnabled()) {
          console.warn(
            '[subscription] SELF-SERVE PURCHASE IS ENABLED — no payment is taken. ' +
            'Any authenticated user can grant themselves a paid plan for free. ' +
            'Set SUBSCRIPTION_SELF_SERVE_PURCHASE=false to close this.'
          );
        }
      })
      .then(() => {
        // A one-line, SECRET-FREE summary of how authentication is actually
        // configured, printed once at boot.
        //
        // This exists because every one of these values is a silent default
        // somewhere. An operator who cannot see "passkeys are off because
        // WEBAUTHN_RP_ID is unset" has no way to know the strongest
        // authentication the product offers is not running, and nothing in the
        // UI would ever tell them. Key IDs and key SOURCES only, never key
        // material, and origins are just the deployment's own hostnames.
        const passkeys = webauthn.describe();
        const key = secretBox.describe();
        console.log(
          '[auth-security] '
          + `passkeys=${passkeys.configured ? `on (rpId=${passkeys.rpID}, origins=${passkeys.origins.length})` : `OFF (${passkeys.error})`} `
          + `| totp-encryption=${key.source} keyIds=${key.keyIds.join(',')} `
          + `| trusted-origins=${trustedOriginList().length}`,
        );
        if (!passkeys.configured) {
          // Not fatal outside production, but it is not fine either: the
          // security page would still offer a passkey button that cannot work.
          console.warn(
            '[auth-security] Passkey sign-in and registration are UNAVAILABLE. '
            + 'Set WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN to enable them.',
          );
        }
      });
  })
  .catch((err) => {
    // Name the failing subsystem. Every boot failure used to print as a
    // MongoDB error, which sent me hunting the database for a port conflict.
    if (err && typeof err.code === 'string' && ['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].includes(err.code)) {
      console.error(`[server] Cannot bind port ${PORT} — ${err.code}: ` + (
        err.code === 'EADDRINUSE'
          ? `another process is already listening on ${PORT}. Stop it (or set PORT to a free port) and retry.`
          : err.message
      ));
      process.exit(1);
    }
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });