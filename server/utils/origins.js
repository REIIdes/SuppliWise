/**
 * Trusted origins — ONE list, used by both CORS and the CSRF guard.
 *
 * These used to be two independent things: a hard-coded array in index.js that
 * only the `cors` package ever saw, and no origin validation anywhere else. That
 * is a gap with a specific shape. CORS protects the RESPONSE from being read by
 * a foreign page; it does not stop a foreign page from causing a state change,
 * because for a "simple" cross-origin POST the request is sent and only the
 * reply is withheld. So an allowlist that exists only in CORS is not a CSRF
 * defence.
 *
 * Two mechanisms, both here:
 *   • CORS, for the browser's own rules (set in index.js from `list()`).
 *   • `verifyOrigin`, for the server's own rule: every state-changing request
 *     must come from a page this deployment serves.
 *
 * WHY THE EXACT LIST MATTERS
 * --------------------------
 * The existing allowlist includes `/^http:\/\/192\.168\.\d+\.\d+:\d+$/` and
 * `/^https:\/\/192\.168\.\d+\.\d+:\d+$/` — "any device on my home LAN", so a
 * phone can reach a dev backend. That is a genuinely useful development
 * affordance and it is kept, but it is a WEAKENING, not a neutral default, so:
 *   • it is off unless `ALLOW_LAN_ORIGINS=true` or the process is not
 *     production (where it is refused outright by the production check below);
 *   • it never admits a bare `http://192.168.x.x` (no port) or a wildcard;
 *   • it is documented as a development-only allowance.
 *
 * `WEB_ALLOWED_ORIGINS` adds production origins without editing code, which is
 * what stops the next person from adding their own `localhost` variant to the
 * array and shipping it.
 */
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

const isProduction = () => process.env.NODE_ENV === 'production';

/** Exact origins, normalised (no trailing slash). */
function exactOrigins() {
  return str(process.env.WEB_ALLOWED_ORIGINS)
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** WebAuthn ceremonies need the same page to be trusted by CORS and by WebAuthn. */
function webauthnOrigins() {
  return str(process.env.WEBAUTHN_ORIGIN)
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Development origins: the Vite dev servers, the loopback forms the Capacitor
 * shell uses, and the backend's own port. Never used in production.
 */
function developmentOrigins() {
  const port = str(process.env.PORT || '5000');
  return [
    // The Vite dev servers, both schemes. The https forms are not optional
    // decoration: the dev server runs over TLS when a certificate is present
    // (see scripts/dev-certs.mjs), and an https page talking to an http API is
    // blocked by the browser as mixed content — so trusting only the http form
    // would leave the whole app unable to reach its own API.
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'https://localhost:5173',
    'https://localhost:5174',
    'https://localhost:5175',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:5175',
    'https://127.0.0.1:5173',
    'https://127.0.0.1:5174',
    'https://127.0.0.1:5175',
    'capacitor://localhost',
    'http://localhost',
    'http://127.0.0.1',
    // The API's own origin. Same-origin requests (a page served by this
    // process, curl, the native app) must be trusted in both schemes for the
    // same reason as above.
    `http://localhost:${port}`,
    `https://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `https://127.0.0.1:${port}`,
  ];
}

/** The LAN patterns, opt-in only. See the header note. */
function lanOriginPatterns() {
  if (isProduction() && str(process.env.ALLOW_LAN_ORIGINS) !== 'true') return [];
  if (str(process.env.ALLOW_LAN_ORIGINS) === 'true') {
    return [/^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d{1,5}$/, /^https:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d{1,5}$/];
  }
  // Non-production keeps the historical behaviour so a developer on the same
  // Wi-Fi can still reach the backend from their phone.
  return [/^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d{1,5}$/, /^https:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d{1,5}$/];
}

/**
 * Everything CORS should accept. Fed straight to the `cors` package, which
 * accepts strings and RegExps mixed in an array. The returned list NEVER
 * contains a wildcard: `Access-Control-Allow-Origin: *` alongside
 * `Allow-Credentials: true` is refused by browsers anyway, and pairing a
 * reflection-everything callback with credentials is the configuration that
 * actually leaks data.
 */
function list() {
  const exact = new Set([
    ...exactOrigins(),
    // A WebAuthn origin is, by definition, a page that runs a ceremony — it has
    // to be a page this server's own CORS policy trusts as well.
    ...webauthnOrigins(),
    ...(isProduction() ? [] : developmentOrigins()),
  ]);
  return [...exact, ...lanOriginPatterns()];
}

/** True when this exact origin string is trusted. */
function isAllowed(origin) {
  const candidate = str(origin).trim().replace(/\/+$/, '');
  if (!candidate) return false;
  if (exactOrigins().some((o) => o === candidate)) return true;
  if (webauthnOrigins().some((o) => o === candidate)) return true;
  if (!isProduction() && developmentOrigins().some((o) => o === candidate)) return true;
  return lanOriginPatterns().some((re) => re.test(candidate));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The page URL a request came from, preferring Origin over Referer. */
function requestOrigin(req) {
  const origin = str(req.headers && req.headers.origin).trim();
  if (origin && origin !== 'null') return origin;
  const referer = str(req.headers && req.headers.referer).trim();
  if (!referer) return '';
  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

/**
 * CSRF guard for state-changing requests.
 *
 * WHAT IT IS NOT: a substitute for CORS, and not a token. This API is
 * authenticated by an `Authorization: Bearer` header, which a browser will not
 * attach to a cross-site request and a third-party page cannot read out of
 * another origin's storage — so classic CSRF is already structurally
 * impossible here. That is the primary defence and it is not going away.
 *
 * WHY IT EXISTS ANYWAY: the primary defence is one refactor away from being
 * wrong. The day someone adds a cookie for convenience, or a proxy starts
 * injecting an Authorization header, every one of these routes becomes
 * forgeable by a form post — and nothing in the code would say so. This
 * middleware makes that change fail closed instead of silently, and it is the
 * control the design calls for on the authentication endpoints specifically.
 *
 * THE RULE
 *   • Safe methods pass.
 *   • A request with NO Origin and NO Referer passes. That is `curl`, the
 *     native app, a server-to-server call and any non-browser client; none of
 *     them can be the victim of a browser CSRF, and refusing them would break
 *     the Capacitor build and every integration test.
 *   • A request with an Origin that is not trusted is REFUSED (403), whatever
 *     the method. This is the check that matters, and it is not delegated to
 *     CORS.
 *   • `Sec-Fetch-Site: cross-site` is refused even if the Origin string happens
 *     to be trusted, so a spoofed header cannot talk its way past the list.
 */
function verifyOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const site = str(req.headers && req.headers['sec-fetch-site']).trim().toLowerCase();
  if (site === 'cross-site') {
    return res.status(403).json({ message: 'Cross-site request refused.' });
  }

  const origin = requestOrigin(req);
  if (!origin) return next();

  if (!isAllowed(origin)) {
    return res.status(403).json({ message: 'Request origin is not allowed.' });
  }
  return next();
}

/**
 * Boot-time guard. A production deployment that has not configured its origins
 * must not start, because the alternative — an empty allowlist plus
 * `Allow-Credentials: true` — is a configuration that looks secure and is not.
 */
function assertProductionConfigured() {
  if (!isProduction()) return;
  const configured = exactOrigins().length + webauthnOrigins().length;
  if (!configured) {
    throw new Error(
      'WEB_ALLOWED_ORIGINS (and/or WEBAUTHN_ORIGIN) must list the production origins in production. '
      + 'An API with credentialed CORS and no trusted origins is not a safe default to boot into.',
    );
  }
  if (str(process.env.ALLOW_LAN_ORIGINS) === 'true') {
    console.warn(
      '[cors] ALLOW_LAN_ORIGINS=true in production: any 192.168.x.x host is trusted as an origin. '
      + 'That is a development affordance and widens who can make credentialed requests.',
    );
  }
}

module.exports = {
  list,
  isAllowed,
  verifyOrigin,
  requestOrigin,
  assertProductionConfigured,
  developmentOrigins,
  exactOrigins,
  webauthnOrigins,
  isProduction,
};
