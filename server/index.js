const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const authRoutes = require('./routes/auth');
const assessmentRoutes = require('./routes/assessment');
const recommendRoutes = require('./routes/recommend');
const chatRoutes = require('./routes/chat');
const polishRoutes = require('./routes/polish');
const supplementDetailRoutes = require('./routes/supplement_detail');
const dashboardRoutes = require('./routes/dashboard');
const insightsRoutes = require('./routes/insights');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notifications');
const subscriptionRoutes = require('./routes/subscription');
const web3Routes = require('./routes/web3');
const AdminAccount = require('./models/AdminAccount');

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

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'suppliwise_jwt_secret_key_change_in_production') {
  throw new Error('JWT_SECRET is missing or still uses the default placeholder value.');
}

// Production safeguard: OTP values must never be exposed in API responses.
// Refuse to boot live with the dev override enabled.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_OTP_RESPONSE === 'true') {
  throw new Error('ALLOW_DEV_OTP_RESPONSE must never be "true" in production.');
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

// Middleware
// Allow CORS from web dev servers and mobile app (Capacitor uses capacitor:// or http://localhost on device)
app.use(cors({ 
  origin: [
    'http://localhost:5173', 
    'http://localhost:5174',
    'http://localhost:5175',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:5175',
    'https://localhost:5173',
    'https://localhost:5174', 
    'https://localhost:5175',
    'https://127.0.0.1:5173',
    'capacitor://localhost',
    'http://localhost', // Mobile app
    'http://127.0.0.1', // Mobile app (numeric loopback)
    /^http:\/\/192\.168\.\d+\.\d+:\d+$/, // Allow any local network IP
    /^https:\/\/192\.168\.\d+\.\d+:\d+$/ // HTTPS version
  ], 
  credentials: true 
}));
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

// ── Rate limiters ──────────────────────────────────────────────────────────
// Keep production limits strict while allowing repeated localhost testing.
// Every 429 escalates that IP up the lockout ladder (15 min → 1 h → 6 h → 1 day)
// via lockoutCheck (hard stop) + limitReachedHandler (escalation on each hit).
const { lockoutCheck, limitReachedHandler } = require('./utils/lockout');
const { floodGuard, bodyBudget, rejectOversized, logClientError, isLocalDevRequest } = require('./utils/floodGuard');

// Coarse outer meter over every path. /api/health and the JSON 404 below had
// no limiter at all, so they were an unbounded source of cheap requests; this
// covers them and anything a future route forgets to guard. It runs FIRST and
// is looser than every specific limit, so legitimate traffic is still governed
// by the tight per-family rule — this only ever catches what those cannot see.
const requestFloodGuard = floodGuard();

// GET /api/auth/me is read-only session/plan traffic: the reactive plan store
// refreshes it on focus and on a slow interval. It must NEVER consume the
// sensitive auth budget or escalate the brute-force ladder (a client refresh
// storm once locked users out of their own accounts), so it is skipped here
// and served by its own generous bucket below.
const isSessionRead = (req) => req.method === 'GET' && (req.path === '/me' || req.path === '/me/');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => isLocalDevRequest(req) ? 200 : 20,
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
app.use('/api/polish', aiLimiter);
app.use('/api/supplement-detail', aiLimiter);
app.use('/api/dashboard', userLimiter);
app.use('/api/insights', userLimiter);
app.use('/api/notifications', userLimiter);
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

// Two base64-picture routes need the wide limit; everything else is text.
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
app.use(rejectOversized(JSON_LIMIT_BYTES));

app.use('/api/auth/profile', express.json({ limit: JSON_UPLOAD_LIMIT_BYTES }));
app.use('/api/admin/profile', express.json({ limit: JSON_UPLOAD_LIMIT_BYTES }));
app.use(express.json({ limit: JSON_LIMIT_BYTES }));

// ── STAGE 3 — HANDLE ───────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/recommend', recommendRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/polish', polishRoutes);
app.use('/api/supplement-detail', supplementDetailRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/web3', web3Routes);
app.use('/api/admin', adminRoutes);

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
    maxPoolSize: 10,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 30000,
  })
  .then(() => {
    console.log('Connected to MongoDB');
    const legacy = process.env.ADMIN_ALIAS && process.env.ADMIN_PASSWORD_HASH && process.env.ADMIN_TOTP_SECRET
      ? [{ alias: process.env.ADMIN_ALIAS, passwordHash: process.env.ADMIN_PASSWORD_HASH, totpSecret: process.env.ADMIN_TOTP_SECRET }]
      : [];
    const configuredAdmins = String(process.env.ADMIN_ACCOUNTS || '').split(',').map(entry => {
      const [alias, passwordHash, totpSecret] = entry.split('|').map(value => value.trim());
      return alias && passwordHash && totpSecret ? { alias, passwordHash, totpSecret } : null;
    }).filter(Boolean);
    const accounts = [...legacy, ...configuredAdmins];
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
          server.headersTimeout = 15 * 1000;
          server.requestTimeout = 60 * 1000;
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
        // Genesis for the Web3 layer: chain + reference data. Non-blocking —
        // a seed hiccup must never keep the API from serving requests (the
        // endpoints self-heal by lazy-initializing on first use).
        require('./blockchain/seed').bootstrap().catch(() => {});
      })
      .then(() => {
        // Non-blocking SMTP check — bad credentials surface in the log at boot
        const { verifyEmailConfig } = require('./utils/email');
        verifyEmailConfig().catch(() => {});
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