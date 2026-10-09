/**
 * A production static host for the built client, with the security headers
 * `vite dev` and `vite preview` already send.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * H8 in the security audit: the client had no Content-Security-Policy at all.
 * A `<meta http-equiv>` policy now covers everything a meta tag is allowed to
 * express, and `vite.config.js` adds `X-Frame-Options` + `frame-ancestors` on
 * `dev` and `preview`.
 *
 * `frame-ancestors` is the one directive per spec that is IGNORED in a
 * `<meta http-equiv>` and honoured only as a real response header. So the
 * closest thing to production — a static host serving `dist/` — was the one
 * origin with no framing protection at all, which is clickjacking. The audit
 * recorded that as a manual action ("whoever serves the production dist/ must
 * send these headers — there is no host config in this repository to do it").
 *
 * That hand-off is now closed for the case where the repo's own host is used:
 * `npm run serve:prod` serves `dist/` with exactly the header set
 * `vite.config.js` uses, taken from that one exported object rather than
 * restated. Two copies of a header list is how the list and the app drift
 * apart, and this file is the second copy otherwise.
 *
 * ── What this deliberately is not ──────────────────────────────────────────
 *
 * Not a CDN, not a reverse proxy, not a deployment story. It is the smallest
 * thing that can be proved to send the headers on a real HTTP response, so the
 * claim "the app origin is not framable" is verifiable rather than aspirational.
 * If you deploy behind Netlify / Vercel / nginx / Cloudflare, configure the
 * headers there instead — and copy them from `securityHeaders` in
 * `vite.config.js` so the policy stays one policy.
 *
 * Deliberately zero-dependency (node:http + node:fs only). Adding a static
 * server package to ship a folder would be a larger change than the gap.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { securityHeaders } from '../vite.config.js';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, '..', 'dist');
// `PORT=0` means "any free port", which is how the header tests avoid colliding
// with a dev server on 4173. `Number(PORT) || 4173` silently defeated that:
// Number('0') is 0, which is falsy, so 0 fell through to the default and two
// concurrent tests fought over 4173 — one failing with EADDRINUSE against a port
// it had just released, which reads as a flaky test rather than a parsing bug.
const PORT = Number(process.env.PORT ?? 4173) || 0;
const HOST = process.env.HOST || '127.0.0.1';

// ── HTTPS ───────────────────────────────────────────────────────────────────
// The same certificate `vite dev` and `vite preview` use, from `certs/`. This is
// the closest thing in the repo to a real deployment, so serving it over plain
// HTTP would make the one origin you actually check a build against be the only
// one that is not encrypted — and the built app talks to an https API, which the
// browser would refuse as mixed content.
//
// Optional, like everywhere else: no `certs/` directory means HTTP, so a clone
// with no certificate still serves. Set SERVE_HTTPS=false to force HTTP.
const CERT_FILE = resolve(here, '..', '..', 'certs', 'localhost.pem');
const KEY_FILE = resolve(here, '..', '..', 'certs', 'localhost-key.pem');
const HTTPS_ENABLED = process.env.SERVE_HTTPS !== 'false';
const certificate = HTTPS_ENABLED && existsSync(CERT_FILE) && existsSync(KEY_FILE)
  ? { cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) }
  : null;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Resolve a URL path to a file inside DIST, or null if it escapes / is missing. */
function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const candidate = resolve(join(DIST, normalize(decoded)));

  // Traversal guard. normalize() collapses `..` first, so a request for
  // `/../../server/.env` resolves outside DIST and is refused here rather than
  // being served. Checking the resolved path (not the request string) is what
  // makes it airtight: by this point there is no `..` left to reason about.
  if (candidate !== DIST && !candidate.startsWith(DIST + sep)) return null;

  try {
    if (statSync(candidate).isDirectory()) {
      const index = join(candidate, 'index.html');
      return statSync(index).isFile() ? index : null;
    }
    return candidate;
  } catch {
    return null;
  }
}

const handle = (req, res) => {
  const file = resolveFile(req.url || '/');

  // A client-side route (/dashboard, /assessment, …) has no file. The SPA
  // fallback answers index.html for it — which is exactly what `vite preview`
  // and every SPA host do, and is why the built app can be deep-linked at all.
  const target = file || resolveFile('/index.html');
  if (!target) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders });
    res.end('Not found — has `npm run build` been run?');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
    ...securityHeaders,
    // Only when this process is actually serving TLS. HSTS over plain HTTP is
    // worse than no HSTS: the browser records the host as HTTPS-only and then
    // refuses to reach it over HTTP, which breaks the HTTP fallback this file
    // deliberately keeps. See utils/tls.js on the server side.
    ...(certificate ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    // Hashed asset filenames are immutable; index.html must never be cached or
    // a deploy leaves clients pinned to a bundle that no longer exists.
    'Cache-Control': target.endsWith('.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  });
  createReadStream(target).pipe(res);
};

const server = certificate ? createHttpsServer(certificate, handle) : createHttpServer(handle);

server.listen(PORT, HOST, () => {
  const scheme = certificate ? 'https' : 'http';
  // `address().port`, not the PORT variable: with PORT=0 the OS chooses the
  // port, so printing the variable would report "…:0", which is both useless
  // and unparseable by the header tests that read this line to find the host.
  const bound = server.address().port;
  console.log(`SuppliWise client: serving ${DIST} at ${scheme}://${HOST}:${bound}`);
  console.log('Security headers are sent on every response (frame-ancestors \'none\').');
  if (!certificate) {
    console.log('No certs/ directory found, so this is plain HTTP. Run `node scripts/dev-certs.mjs` at the repo root for HTTPS.');
  }
});