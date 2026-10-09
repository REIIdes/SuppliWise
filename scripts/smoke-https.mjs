/**
 * Smoke-test the running dev stack over HTTPS.
 *
 * This is the check that answers "is it actually running, with no errors", from
 * outside the app rather than from the browser console where the symptoms are
 * vague. Every request here goes through `node:https` with the development CA
 * supplied explicitly, so the certificate chain is genuinely verified:
 *
 *   • an https page whose module graph 404s renders a blank screen, and nothing
 *     in any response says why
 *   • an https page reaching an http API fails as MIXED CONTENT — refused by the
 *     browser BEFORE the request is sent, so it looks like the API is broken
 *   • a CORS allowlist that does not match the page origin produces a browser
 *     error and no server-side log line whatsoever
 *
 * Those are the three failure modes of an HTTPS migration that are otherwise
 * invisible from the terminal. Hence this file.
 *
 * It deliberately does NOT use global `fetch`: undici accepts no `ca` option, so
 * a fetch-based check would have to be run under `--use-system-ca`, and would
 * then be testing the flag rather than the stack.
 *
 * Usage (with both dev servers running):
 *   node scripts/smoke-https.mjs
 *
 * Overridable, for checking a LAN address or a deployed host:
 *   APP_ORIGIN=https://192.168.1.7:5173 API_ORIGIN=https://192.168.1.7:5000 \
 *     node scripts/smoke-https.mjs
 */
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const APP = process.env.APP_ORIGIN || 'https://localhost:5173';
const API = process.env.API_ORIGIN || 'https://localhost:5000';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ->  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/**
 * A verified HTTPS GET.
 *
 * `ca` makes the chain checkable, which is the whole point — `rejectUnauthorized:
 * false` would make every check below pass regardless of which certificate the
 * server presented, including somebody else's.
 */
function get(url, headers = {}) {
  return new Promise((resolveRequest, reject) => {
    const { hostname, port, pathname, search } = new URL(url);
    httpsRequest(
      {
        host: hostname,
        port,
        path: `${pathname}${search}`,
        // 127.0.0.1 is an IP address, so the certificate's `localhost` subject
        // alternative name does not match it. `servername` is what selects the
        // name to verify against, and without it every request to 127.0.0.1
        // fails with ERR_TLS_CERT_ALTNAME_INVALID for a reason that has nothing
        // to do with the certificate.
        servername: 'localhost',
        ca,
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, body }));
      },
    )
      .on('error', reject)
      .end();
  });
}

const ca = readFileSync(resolve(repoRoot, 'certs', 'rootCA.pem'));

// ── The certificate ─────────────────────────────────────────────────────────
// Read before anything is requested, so a missing certs/ directory produces one
// clear message instead of a handshake error on every subsequent check.
const certificate = new X509Certificate(readFileSync(resolve(repoRoot, 'certs', 'localhost.pem')));
const san = certificate.subjectAltName || '';
check('certificate is valid for localhost', san.includes('DNS:localhost'));
check('certificate is valid for 127.0.0.1', san.includes('IP Address:127.0.0.1'));
check(
  'certificate is valid for this machine\'s LAN address',
  /IP Address:(192\.168\.|10\.)/.test(san),
  'required for a phone on the same Wi-Fi; without it the phone fails with ERR_CERT_AUTHORITY_INVALID',
);

// ── The app document ────────────────────────────────────────────────────────
let app = null;
try {
  app = await get(`${APP}/`);
  check('the app document loads over https', app.status === 200, `status ${app.status}`);
} catch (error) {
  check('the app document loads over https', false, `${error.code || ''} ${error.message}`.trim());
}

// Every module it references. This is the check that catches an https page
// whose module graph fails to load: the page renders blank, the browser console
// says "failed to fetch dynamically imported module", and every server-side log
// line says everything is fine.
if (app) {
  // Every script and stylesheet the document references, whatever the
  // extension. In dev that is `/src/main.jsx` and `/@vite/client` — neither is
  // a `.js`, so a `\.(?:js|css)` pattern here finds nothing and the check
  // passes vacuously on zero modules while the page is in fact untested.
  const sources = [...app.body.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)]
    .concat([...app.body.matchAll(/<link[^>]*\shref="([^"]+\.(?:js|css))"/g)])
    .map((m) => m[1])
    .filter((url) => url.startsWith('/'));
  check('the document references modules to load', sources.length > 0, `${sources.length} found`);
  for (const src of sources) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await get(`${APP}${src}`);
      check(`module loads: ${src}`, res.status === 200, `status ${res.status}`);
    } catch (error) {
      check(`module loads: ${src}`, false, error.code || error.message);
    }
  }
}

// ── The API ─────────────────────────────────────────────────────────────────
// Both routes matter and they fail differently. Through the proxy is what the
// browser actually does; direct is what a phone on the LAN does.
for (const [label, base] of [['via the dev proxy', APP], ['direct', API]]) {
  try {
    const res = await get(`${base}/api/health`);
    check(
      `the api answers ${label}`,
      res.status === 200 && res.body.includes('Server is running'),
      `status ${res.status}`,
    );
  } catch (error) {
    check(`the api answers ${label}`, false, error.code || error.message);
  }
}

// The headers an https deployment is expected to send, checked on the direct
// call because the proxy is what the previous check covered.
try {
  const res = await get(`${API}/api/health`);
  check('HSTS is sent over https', /max-age=\d+/.test(res.headers['strict-transport-security'] || ''),
    res.headers['strict-transport-security'] || 'absent');
  // `frame-ancestors 'none'` is the real control and the stricter of the two:
  // CSP beats X-Frame-Options in every modern browser, and it cannot be
  // weakened by an X-Frame-Options exception. Helmet's default X-Frame-Options
  // here is SAMEORIGIN, which is also fine — so both are accepted, but
  // frame-ancestors 'none' is required.
  check('framing is refused',
    /frame-ancestors\s+'none'/.test(res.headers['content-security-policy'] || '')
      && ['DENY', 'SAMEORIGIN'].includes(res.headers['x-frame-options']),
    `x-frame-options: ${res.headers['x-frame-options'] || 'absent'}`);
  check('content sniffing is refused', res.headers['x-content-type-options'] === 'nosniff');
} catch (error) {
  check('the api headers are present', false, error.code || error.message);
}

// ── CORS ────────────────────────────────────────────────────────────────────
// A browser CORS failure produces no server-side log line at all, so it is
// invisible from the terminal. This is the only place it shows up.
try {
  const res = await get(`${API}/api/health`, { origin: APP });
  check('CORS allows the app origin', res.headers['access-control-allow-origin'] === APP,
    res.headers['access-control-allow-origin'] || 'absent');
} catch (error) {
  check('CORS allows the app origin', false, error.code || error.message);
}

// ── No unencrypted listener behind the encrypted one ─────────────────────────
// If the API port ALSO answered plain HTTP, then everything above would have
// passed while a plaintext path to the same API remained open — which is exactly
// the state this whole change exists to remove.
// Matching on the error CODE rather than on prose. What a plaintext request to
// a TLS listener actually does is not reliably "connection refused": Node
// accepts the TCP connection and then fails the handshake, so the observable
// outcome varies by how far the TLS server got before hanging up — ECONNRESET,
// EPROTO, an SSL alert surfacing as UND_ERR_SOCKET from undici, or a socket hang
// up. A check written against one of those strings reports a FALSE PASS the
// moment Node phrases it differently.
//
// So this asserts the thing that actually matters: no valid HTTP response comes
// back. If the port were also serving plaintext, `/api/health` would answer 200
// with its JSON body — an unambiguous, stable signal that does not depend on how
// a failed handshake is reported.
const PLAINTEXT_ORIGIN = API.replace(/^https:/, 'http:');
let plaintextAnswered = false;
let plaintextDetail = '';
try {
  const res = await fetch(`${PLAINTEXT_ORIGIN}/api/health`);
  const body = await res.text();
  plaintextAnswered = res.status === 200 && body.includes('Server is running');
  plaintextDetail = plaintextAnswered
    ? `answered ${res.status} with a valid API response`
    : `responded ${res.status} but not as the API (a TLS listener rejecting a plaintext request)`;
} catch (error) {
  plaintextDetail = `refused (${error.cause?.code || error.code || 'socket closed'})`;
}
check('the api port does not also answer plain http', !plaintextAnswered, plaintextDetail);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);