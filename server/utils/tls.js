/**
 * TLS material for the API, loaded from the environment.
 *
 * WHY THIS IS OPT-IN AND NOT AUTOMATIC
 * ------------------------------------
 * The obvious design is "if a certificate exists on disk, serve https" — it is
 * one fewer thing to configure and it cannot be got wrong by forgetting. It is
 * also wrong here, for a specific reason: the test suite boots this same
 * `index.js` as a child process and talks to it over plain HTTP
 * (Test File/e2eServer.js). Auto-detecting a certificate would flip the test
 * server to TLS mid-run and every suite would fail against a port that stopped
 * answering HTTP, with an error about the connection rather than about TLS.
 *
 * So HTTPS requires a deliberate instruction — `TLS_ENABLED=true` — and a test
 * that has not asked for it gets HTTP, which is what it expects. The cost is
 * one documented variable; the benefit is that a suite's behaviour does not
 * depend on what happens to be in `certs/` on the machine running it.
 *
 * THE VARIABLES
 *   TLS_ENABLED     "true" turns on TLS. Anything else serves HTTP, which is
 *                   the default and stays the default.
 *   TLS_KEY_FILE    Absolute or repo-relative path to the private key (PEM).
 *   TLS_CERT_FILE   Absolute or repo-relative path to the certificate (PEM).
 *                   Defaults to `certs/localhost.pem` / `certs/localhost-key.pem`
 *                   when unset, which is what scripts/dev-certs.mjs produces.
 *   TLS_CA_FILE     Optional intermediate/CA bundle, only for a chain this
 *                   server presents beyond its own leaf. Rarely needed locally;
 *                   present because a deployment terminating its own TLS will
 *                   eventually need it and it is cheaper to support now than to
 *                   retrofit.
 *
 * WHY A MISSING CERTIFICATE IS FATAL RATHER THAN A WARNING
 * -------------------------------------------------------
 * `TLS_ENABLED=true` with no readable key is almost certainly a typo in a path,
 * and the one thing that must not happen is silently falling back to HTTP: that
 * looks like a successful boot and is a plaintext API carrying bearer tokens.
 * So this throws at startup, before the port is bound, with the paths it tried.
 *
 * Relative paths resolve against the REPOSITORY root, not the process's working
 * directory. A server started from `server/` and one started from the repo root
 * are both normal ways to run this (`npm start` inside server/, or `node
 * server/index.js`), and resolving against cwd would make the same .env file
 * mean two different things. Resolving against the repo root makes one path
 * mean one file regardless of where the command was typed.
 */
const fs = require('fs');
const path = require('path');

const str = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

const isProduction = () => process.env.NODE_ENV === 'production';

/** The repository root: server/utils/ -> server/ -> repo. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Resolve a configured path against the repo root unless it is already absolute. */
function resolvePath(value) {
  const trimmed = str(value).trim();
  if (!trimmed) return '';
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(REPO_ROOT, trimmed);
}

class TlsConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TlsConfigError';
    this.statusCode = 500;
  }
}

/** Is HTTPS explicitly asked for? */
function isEnabled() {
  return str(process.env.TLS_ENABLED).trim().toLowerCase() === 'true';
}

/**
 * Read and validate the key/certificate pair.
 *
 * @returns {{key: Buffer, cert: Buffer, ca?: Buffer, enabled: true,
 *            keyFile: string, certFile: string, caFile: string|null}}
 */
function load() {
  if (!isEnabled()) return { enabled: false };

  const keyFile = resolvePath(process.env.TLS_KEY_FILE) || path.join(REPO_ROOT, 'certs', 'localhost-key.pem');
  const certFile = resolvePath(process.env.TLS_CERT_FILE) || path.join(REPO_ROOT, 'certs', 'localhost.pem');
  const caFile = resolvePath(process.env.TLS_CA_FILE);

  const read = (file, what) => {
    try {
      return fs.readFileSync(file);
    } catch (error) {
      throw new TlsConfigError(
        `TLS is enabled but the ${what} could not be read (${file}): ${error.code || error.message}. `
        + 'Run `node scripts/dev-certs.mjs` to create one, or correct the path in .env. '
        + 'Refusing to start rather than serving this API over plain HTTP.',
      );
    }
  };

  const key = read(keyFile, 'private key');
  const cert = read(certFile, 'certificate');

  // A key and certificate that do not belong together fail deep inside TLS
  // handshake code, as an error on every request rather than at boot. Node's
  // own check catches the common cause (files swapped) and says so here, where
  // the operator is still reading startup output.
  const check = key.length && cert.length;
  if (!check) {
    throw new TlsConfigError('TLS is enabled but the private key or certificate is empty.');
  }

  return {
    enabled: true,
    key,
    cert,
    ...(caFile ? { ca: read(caFile, 'CA bundle') } : {}),
    keyFile,
    certFile,
    caFile: caFile || null,
  };
}

/**
 * Non-throwing probe, for the boot summary.
 *
 * @returns {{enabled: boolean, error: string|null, keyFile?: string, certFile?: string}}
 */
function describe() {
  if (!isEnabled()) return { enabled: false, error: null };
  try {
    const tls = load();
    return {
      enabled: true,
      error: null,
      keyFile: tls.keyFile,
      certFile: tls.certFile,
      // Only ever the file paths — a private key must never reach a log, and a
      // path says enough to diagnose.
      hasCa: Boolean(tls.ca),
    };
  } catch (error) {
    return { enabled: false, error: error.message };
  }
}

/**
 * Create the listening server, over TLS or plain HTTP as configured.
 *
 * The caller gets back the same object `app.listen()` would have returned, so
 * the timeout tuning and the fatal-bind-error handling in index.js are unchanged
 * either way.
 *
 * @param {import('express').Express} app
 * @returns {import('node:http').Server}
 */
function createServer(app) {
  const tls = load();
  if (!tls.enabled) return require('http').createServer(app);

  const https = require('https');
  return https.createServer(
    { key: tls.key, cert: tls.cert, ...(tls.ca ? { ca: tls.ca } : {}) },
    app,
  );
}

/** The scheme this process is actually serving, for logs and generated URLs. */
function scheme() {
  return isEnabled() ? 'https' : 'http';
}

/**
 * The loopback origin of this API, as a string, honouring TLS_ENABLED.
 *
 * For the scripts in this repository that probe a LIVE server from outside
 * (glitch-hunt*.js, test-*-flows.js, verify-bc-monitor.js, utils/attack_probes.js).
 * Each of those hardcoded `http://localhost:5000`, which means every one of them
 * starts failing the moment TLS is switched on — with a fetch error that names
 * neither TLS nor the certificate, so the operator's first conclusion is that
 * the certificate is broken. It is not; the probe is still speaking http.
 *
 * A client that cannot follow this will be fixed one script at a time, each time
 * by someone who has to rediscover why. So it is one function here.
 */
function loopbackOrigin(port = process.env.PORT || 5000) {
  return `${scheme()}://localhost:${port}`;
}

/**
 * The CA a Node-side client needs in order to trust this API over HTTPS, or
 * null when TLS is off.
 *
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------
 * Node does not read the operating system's certificate store. It trusts its own
 * bundled roots plus whatever `NODE_EXTRA_CA_CERTS` names, and a local
 * development certificate authority is in neither. So a script that talks to
 * this API over HTTPS fails the handshake with SELF_SIGNED_CERT_IN_CHAIN or
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE — errors that read as a broken certificate
 * rather than as "this process does not know the issuer".
 *
 * THE PART THAT IS NOT OBVIOUS
 * ----------------------------
 * `fetch` cannot be given a CA. It is undici, and undici accepts no `ca`
 * option — `fetch(url, { ca })` ignores it silently and fails the handshake
 * anyway. The two ways to make `fetch` trust a certificate authority are
 * therefore both process-wide and both must happen BEFORE the process starts:
 *
 *   • `NODE_EXTRA_CA_CERTS=<path>` — read once, at startup. Setting
 *     `process.env.NODE_EXTRA_CA_CERTS` from inside a running script has no
 *     effect; this was verified, not assumed.
 *   • `NODE_OPTIONS=--use-system-ca` — has Node read the OS store, which is
 *     where `mkcert -install` put the CA. This is the more general fix: it also
 *     covers any other local authority, and it needs no path.
 *
 * Neither can be set from within the process, which is why
 * scripts/withDevCa.mjs exists: it re-launches the target script with the right
 * environment rather than trying to fix it from the inside.
 *
 * `https.request` has no such limitation — it takes `ca` per call — so a script
 * using node:https can trust the CA directly.
 */
function developmentCaFile() {
  const file = path.join(REPO_ROOT, 'certs', 'rootCA.pem');
  return fs.existsSync(file) ? file : null;
}

/**
 * Should HSTS be sent?
 *
 * Helmet sets `Strict-Transport-Security` unconditionally, which is right when
 * the connection is already HTTPS and wrong when it is not: a browser that
 * receives HSTS over plain HTTP remembers the host as HTTPS-only and then
 * refuses to talk to it over HTTP, so a server that was serving HTTP on purpose
 * (a test run, a LAN phone on a mixed network) breaks in a way that looks like
 * a network fault. Preloading `localhost` in particular has caused real,
 * hard-to-diagnose breakage.
 *
 * So HSTS is sent only when this process is serving TLS.
 */
function shouldSendHsts() {
  return isEnabled();
}

/**
 * The `max-age` for Strict-Transport-Security, in seconds.
 *
 * ── Why this is configurable, and why the default is short ───────────────────
 *
 * HSTS is cached by the BROWSER, keyed on the host, for the whole max-age — and
 * the effect is immediate and total: a browser holding an HSTS entry for
 * `localhost` will not make a plain-HTTP request to it at all, whatever the
 * server says. It does not wait for a certificate warning, and there is no
 * click-through.
 *
 * That makes a long max-age genuinely hazardous in development in a way it is
 * not in production. The concrete sequence:
 *
 *     1. run with TLS_ENABLED=true      → browser caches HSTS for localhost
 *     2. debug something by setting TLS_ENABLED=false
 *     3. http://localhost:5000 is now unreachable, reporting "connection
 *        refused" — nothing anywhere mentions HSTS
 *
 * and the manual recovery is to clear the browser's HSTS state by hand
 * (chrome://net-internals/#hsts, Firefox about:networking#hsts), which nobody
 * thinks to do and which reads as a machine-specific fault.
 *
 * The development certificate is issued by a local authority that can be
 * uninstalled (`mkcert -uninstall`) and regenerated at any time, so a year-long
 * commitment to HTTPS for `localhost` is a promise this setup has no way to
 * keep. A short default keeps the protection meaningful — it is what stops a
 * downgrade attempt within a session, which is the attack HSTS exists to stop —
 * while making the sequence above recover on its own.
 *
 * A production deployment is the opposite case: the certificate comes from
 * somewhere that will not disappear, and the long commitment is exactly right.
 * Set HSTS_MAX_AGE=31536000 there.
 *
 * Unset, empty or nonsense falls back to the default, and a nonsense value can
 * only change the duration — never remove the header. A typo must not be able to
 * switch HSTS off.
 */
const DEFAULT_HSTS_MAX_AGE = 300;

function hstsMaxAge() {
  const raw = str(process.env.HSTS_MAX_AGE).trim();
  if (!raw) return DEFAULT_HSTS_MAX_AGE;
  // Digits and nothing else, before parsing. `parseInt` alone is too forgiving
  // in a way that matters here: it returns 1 for "1e999" and 30 for "30s", so a
  // typo would set a near-meaningless max-age (or, with a leading digit, quietly
  // shorten a production deployment's year to a second) while looking as though
  // it had been understood. This setting controls how long a BROWSER refuses to
  // talk to a host over HTTP, so "did you mean that?" has to be an error rather
  // than a silent reinterpretation.
  if (!/^\d+$/.test(raw)) return DEFAULT_HSTS_MAX_AGE;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_HSTS_MAX_AGE;
  // A year is the longest value worth having; anything beyond adds no security
  // meaning and only makes the cache harder to escape.
  return Math.min(seconds, 31_536_000);
}

/**
 * Refuse to boot a PRODUCTION server that is not terminating TLS.
 *
 * Not a blanket "https everywhere" rule — TLS is frequently terminated by the
 * load balancer in front of the app, and `TRUST_PROXY=true` is how this process
 * is told that is the case. The combination that is genuinely broken is a
 * production deployment with neither: no TLS here and no proxy to have done it,
 * which is a plaintext API with credentialed CORS exposed to the internet.
 */
function assertProductionConfigured() {
  if (!isProduction()) return;
  if (isEnabled()) return;
  if (str(process.env.TRUST_PROXY).trim().toLowerCase() === 'true') return;
  throw new Error(
    'Production is serving plain HTTP with no terminating proxy in front. Either set TLS_ENABLED=true '
    + 'with TLS_KEY_FILE/TLS_CERT_FILE, or set TRUST_PROXY=true if a reverse proxy or load balancer '
    + 'terminates TLS ahead of this process.',
  );
}

module.exports = {
  REPO_ROOT,
  TlsConfigError,
  isEnabled,
  load,
  describe,
  createServer,
  scheme,
  loopbackOrigin,
  developmentCaFile,
  shouldSendHsts,
  hstsMaxAge,
  DEFAULT_HSTS_MAX_AGE,
  assertProductionConfigured,
  resolvePath,
};