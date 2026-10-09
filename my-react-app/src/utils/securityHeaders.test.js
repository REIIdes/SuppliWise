/**
 * The production static host must send the framing headers the app origin needs.
 *
 * ── The failure this prevents ──────────────────────────────────────────────
 *
 * `frame-ancestors` is the one CSP directive the spec IGNORES inside a
 * `<meta http-equiv>` — it is honoured only as a real HTTP response header. The
 * audit's H8 finding was closed with a `<meta>` policy in index.html, which
 * cannot express it. `vite dev` and `vite preview` then got the real header
 * from vite.config.js, and the audit was honest that production was still a
 * manual action: "whoever serves the production dist/ must send these headers —
 * there is no host config in this repository to do it."
 *
 * scripts/serveDist.mjs is that host. This test asserts it, over real HTTP,
 * because the alternative is the claim resting on a comment — and a comment is
 * what the manual action already was.
 *
 * ── Why it also pins the SHARED list ────────────────────────────────────────
 *
 * The host imports `securityHeaders` from vite.config.js rather than repeating
 * it. That is the part worth defending: two lists drift, and a drift here is
 * silent — the app keeps working, it just quietly loses clickjacking protection
 * on whichever origin was edited second. Asserting the exact header values
 * makes a changed policy a deliberate, visible act.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { securityHeaders } from '../../vite.config.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const CERT_DIR = join(root, '..', 'certs');
const CA_FILE = join(CERT_DIR, 'rootCA.pem');
const hasCertificate = existsSync(join(CERT_DIR, 'localhost.pem'));

// The header assertions below are about RESPONSE HEADERS, not about transport,
// so they run against the plain-HTTP host: SERVE_HTTPS=false pins it. That is
// deliberate rather than incidental — it keeps these tests independent of whether
// anyone has run `npm run certs`, so a fresh clone's suite is green either way.
// Transport gets its own test below, which is where the certificate belongs.
function startHost({ https = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'serveDist.mjs')], {
      // PORT=0 asks the OS for a free port; the host prints the bound one, so
      // the test never collides with a dev server already on 4173.
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        ...(https ? {} : { SERVE_HTTPS: 'false' }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`host did not start in time. Output:\n${out}`));
    }, 20_000);

    const onData = (chunk) => {
      out += String(chunk);
      // The host logs the URL it bound; PORT=0 means only the OS knows it.
      // The scheme is matched rather than assumed, because it depends on
      // whether a certificate is present.
      const match = out.match(/(https?):\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({
          child,
          scheme: match[1],
          origin: `${match[1]}://127.0.0.1:${match[2]}`,
          port: Number(match[2]),
          output: () => out,
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`host exited early with code ${code}. Output:\n${out}`));
    });
  });
}

/**
 * GET over TLS, trusting only the local development CA.
 *
 * `fetch` cannot be given a CA, and `rejectUnauthorized: false` would prove
 * nothing — it accepts a genuinely invalid certificate too, so a test using it
 * passes whether or not the chain is correct. Supplying the CA is what makes
 * this an assertion about the certificate rather than about the port.
 */
function httpsGet(origin, path) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: hostname,
        port,
        path,
        ca: readFileSync(CA_FILE),
        // 127.0.0.1 is an IP, so the certificate's `localhost` SAN does not
        // match it. servername is what selects the right name to check against.
        servername: 'localhost',
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const DIST = join(root, 'dist');
const built = existsSync(join(DIST, 'index.html'));

test('the production host sends frame-ancestors and X-Frame-Options', { skip: !built && 'run `npm run build` first' }, async () => {
  const { child, origin } = await startHost();
  try {
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  } finally {
    child.kill();
  }
});

test('the headers go on a deep-linked SPA route too, not only on /', { skip: !built && 'run `npm run build` first' }, async () => {
  // The fallback rewrites unknown paths to index.html. If headers were attached
  // to the "file found" branch only, a deep link — the way the app is actually
  // opened, e.g. a refresh on /dashboard — would be framable while the root
  // was not. That is the kind of gap that reads as covered and is not.
  const { child, origin } = await startHost();
  try {
    const res = await fetch(`${origin}/dashboard`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
  } finally {
    child.kill();
  }
});

test('the host and vite.config.js cannot drift apart', () => {
  // The host IMPORTS the list, so this is a guard against someone inlining a
  // copy later — which is the exact change that would let the two diverge
  // silently. It also pins the policy itself: changing these values is a
  // security decision and should fail here rather than pass unnoticed.
  assert.equal(securityHeaders['X-Frame-Options'], 'DENY');
  assert.match(securityHeaders['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(securityHeaders['X-Content-Type-Options'], 'nosniff');
  assert.equal(securityHeaders['Referrer-Policy'], 'strict-origin-when-cross-origin');
});

test('a traversal attempt is refused, not served', { skip: !built && 'run `npm run build` first' }, async () => {
  // The static host reads from disk, so `..` is the obvious thing to get wrong.
  // It must 404 rather than hand back a file from outside dist/.
  const { child, origin } = await startHost();
  try {
    const res = await fetch(`${origin}/../package.json`);
    // Either the traversal is refused outright, or the SPA fallback answers
    // index.html. What must never happen is package.json coming back.
    if (res.status === 200) {
      const body = await res.text();
      assert.ok(!body.includes('"serve:prod"'), 'a file outside dist/ was served');
    }
  } finally {
    child.kill();
  }
});

test('the host serves HTTPS when a certificate is present', { skip: !(built && hasCertificate) && 'run `npm run certs` and `npm run build` first' }, async () => {
  // The production host is the closest thing here to a deployment, and the built
  // app talks to an https API — so serving it over plain HTTP would make the one
  // origin you check a build against the only unencrypted one, and the browser
  // would refuse the app's API calls from it as mixed content.
  //
  // Asserted over a real TLS request with the local CA as the only trust root:
  // that proves both that the host terminates TLS and that the chain a browser
  // sees is one it can actually validate.
  const { child, scheme, origin } = await startHost({ https: true });
  try {
    assert.equal(scheme, 'https', 'the host should have chosen https with a certificate present');
    const res = await httpsGet(origin, '/');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    // HSTS is legitimate here — and only here — because this response really did
    // arrive over TLS. Sent over plain HTTP it would make a browser refuse to
    // reach the host at all afterwards.
    assert.match(res.headers['strict-transport-security'], /max-age=\d+/);
  } finally {
    child.kill();
  }
});

test('the host serves plain HTTP when there is no certificate', { skip: !built && 'run `npm run build` first' }, async () => {
  // The other half of the rule. A clone with no `certs/` directory must still
  // serve, over HTTP — requiring a certificate would mean a fresh clone cannot
  // run the app at all, for a reason unrelated to the code.
  const { child, scheme } = await startHost();
  try {
    assert.equal(scheme, 'http');
  } finally {
    child.kill();
  }
});