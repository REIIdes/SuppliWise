/**
 * Dev-server dependency cache preflight.
 *
 * `vite dev` fails with
 *
 *   Failed to fetch dynamically imported module:
 *   http://localhost:5173/node_modules/.vite/deps/<pkg>.js?v=<hash>
 *
 * when its dependency-optimizer cache is missing, half-written, or committed
 * under a different package set. Every `?v=` URL the open page is holding then
 * 504s ("Outdated Optimize Dep") and nothing renders until it is reloaded.
 *
 * The documented repair has always been manual: stop the server, `rm -rf
 * node_modules/.vite`, start it again. That works, but it depends on someone
 * recognising the symptom and knowing the incantation, and the cache
 * re-corrupts the next time a dependency changes. This script does the same
 * repair automatically, before Vite starts, and prunes the debris.
 *
 * ── Why the debris is a real problem, not cosmetic ─────────────────────────
 *
 * Vite bundles into `deps_temp_<suffix>` and only then renames that directory
 * onto `deps`. `suffix` is derived from `process.pid` + timestamp + random, so
 * an interrupted run leaves its output behind and the next run cannot reuse it.
 * Vite's own cleanup (`cleanupDepsCacheStaleDirs`) only removes a temp
 * directory once it is **24 hours** old — deliberately, in case a concurrent
 * process is mid-run — so a session of restarts accumulates one per attempt.
 * This repository was found with 15 of them and no committed `deps/` at all.
 *
 * ── The liveness guard, and why it is not optional ─────────────────────────
 *
 * Deleting `deps/` (or a temp dir another run is still filling) out from under
 * a LIVE server is what turns a recoverable glitch into the corrupt state above:
 * the running server keeps its in-memory metadata pointing at files that no
 * longer exist, so every dependency 504s. So when a dev server is already
 * listening on the configured port this script does nothing destructive and
 * says so. `strictPort: true` in vite.config.js means a listener there is a
 * dev server for this app, which is exactly the case to back off from.
 *
 * Never exits non-zero: this runs from `predev`, and refusing to start would
 * make a cache problem worse than the problem it is fixing.
 *
 * Usage:
 *   node scripts/healDepsCache.mjs [cacheDir] [--force]
 *
 *   cacheDir  defaults to node_modules/.vite (the dev cacheDir in vite.config.js;
 *             `vite build` uses node_modules/.vite-build, a separate directory,
 *             so it needs no liveness guard and should pass it explicitly)
 *   --force   skip the liveness guard (CI, or a cache you know is dead)
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
const cacheDirArg = args.find((a) => !a.startsWith('--'));
const isDevCache = !cacheDirArg;
const cacheDir = cacheDirArg ? resolve(appRoot, cacheDirArg) : join(appRoot, 'node_modules', '.vite');

const log = (msg) => console.log(`[healDeps] ${msg}`);

/**
 * The dev port, read from vite.config.js as TEXT.
 *
 * Imported rather than parsed for the same reason `optimizeDepsInclude.test.js`
 * avoids importing it: executing the config pulls in vite, the react plugin and
 * vite-plugin-pwa purely to learn a number, and those are ESM-only with a
 * build-time environment. Falls back to Vite's default when the port is not
 * pinned in the file, which is the common case here.
 */
function readDevPort() {
  try {
    const text = readFileSync(join(appRoot, 'vite.config.js'), 'utf8');
    const serverBlock = /\bserver:\s*\{[\s\S]*?\n\s*\}/.exec(text);
    const found = serverBlock && /\bport:\s*(\d+)/.exec(serverBlock[0]);
    return found ? Number(found[1]) : 5173;
  } catch {
    return 5173;
  }
}

/**
 * True when something is already listening on the dev port.
 *
 * BOTH loopback families are probed, and that is not defensive padding — it is
 * the observed behaviour. vite.config.js sets `host: 'localhost'`, which Node
 * resolves to IPv6 first, so the server ends up bound to `[::1]` and nothing at
 * all listens on `127.0.0.1`. A guard that checked only `127.0.0.1` gets
 * ECONNREFUSED from a perfectly healthy dev server, concludes the port is
 * free, and then deletes `deps/` out from under it — turning a recoverable
 * glitch into exactly the corrupt state this script exists to prevent. Verified
 * against a running server: `http://[::1]:5173/` answers 200 while
 * `http://127.0.0.1:5173/` is unreachable.
 *
 * Any successful connection counts as live. Erring towards "live" only costs a
 * skipped cleanup; erring towards "not live" destroys a running server's cache.
 */
function devServerLive(port) {
  return new Promise((done) => {
    const hosts = ['127.0.0.1', '::1'];
    let settled = false;
    let pending = hosts.length;

    const finish = (live) => {
      if (settled) return;
      settled = true;
      done(live);
    };

    for (const host of hosts) {
      // 400ms is deliberate: a refused local connection is immediate, and
      // anything slower is not a healthy listener worth waiting on.
      const socket = createConnection({ port, host, family: host.includes(':') ? 6 : 4 });
      const settle = (live) => {
        socket.destroy();
        if (--pending > 0 && !live) return;
        finish(live);
      };
      socket.setTimeout(400);
      socket.once('connect', () => settle(true));
      socket.once('timeout', () => settle(false));
      socket.once('error', () => settle(false));
    }
  });
}

/**
 * Packages that must be in the committed cache.
 *
 * Read out of `optimizeDeps.include` rather than hardcoded, so a newly added
 * lazy dependency extends this check automatically instead of needing a second
 * list kept in step by hand. Relative paths are skipped: app source is not a
 * dependency and never appears under /node_modules/.vite.
 */
function requiredPackages() {
  try {
    const text = readFileSync(join(appRoot, 'vite.config.js'), 'utf8');
    const block = /optimizeDeps:\s*\{[\s\S]*?include:\s*\[([\s\S]*?)\]/.exec(text);
    if (!block) return [];
    return [...block[1].matchAll(/'([^']+)'|"([^"]+)"/g)]
      .map((m) => m[1] || m[2])
      .filter((pkg) => pkg && !pkg.startsWith('.') && !pkg.startsWith('/'));
  } catch {
    return [];
  }
}

// ── 1. Refuse to touch anything a live server is using ────────────────────
if (isDevCache && !force) {
  const port = readDevPort();
  if (await devServerLive(port)) {
    log(`a dev server is already listening on ${port} — leaving its cache alone.`);
    log('if dependencies are failing to load, stop it and run `npm run dev` again.');
    process.exit(0);
  }
}

/**
 * Remove a directory, reporting rather than throwing: untidy is not broken.
 *
 * `message` is the whole log line because the two callers mean genuinely
 * different things — pruning a leftover temp dir is pure housekeeping, while
 * discarding the committed `deps/` is what forces a re-optimize. Conflating
 * them would have the log claim a re-optimize on every prune.
 */
function discard(path, message) {
  try {
    rmSync(path, { recursive: true, force: true });
    log(message);
  } catch (err) {
    log(`could not discard ${path}: ${err.message}`);
  }
}

// ── 2. Prune interrupted-run debris ─────────────────────────────────────────
//
// Every one of these is a bundle that was written and never committed. Vite
// would keep them for 24h in case a run is in flight; the liveness guard above
// is what makes removing them now safe.
if (existsSync(cacheDir)) {
  const orphans = readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes('_temp_'));

  for (const orphan of orphans) {
    discard(join(cacheDir, orphan.name), `pruned ${orphan.name} (a run that never committed)`);
  }
}

// ── 3. Verify the committed cache is complete, and rebuild it if not ───────
const depsDir = join(cacheDir, 'deps');
const metadataPath = join(depsDir, '_metadata.json');

let metadata = null;
try {
  metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
} catch {
  metadata = null;
}

if (!metadata) {
  // The exact state this whole exercise exists for: no committed tree, or a
  // truncated _metadata.json. Serving it would 504 every dependency URL, so the
  // only repair is to discard it and let Vite rebuild from a clean slate.
  const why = existsSync(depsDir)
    ? 'deps/_metadata.json is missing or unreadable'
    : 'there is no committed deps/ tree';
  discard(depsDir, `${why} — discarded so Vite re-optimizes cleanly on startup.`);
} else {
  const required = requiredPackages();
  const optimized = new Set(Object.keys(metadata.optimized || {}));
  const missing = required.filter((pkg) => !optimized.has(pkg));

  if (missing.length) {
    discard(depsDir, `deps/ is missing ${missing.join(', ')} — discarded so Vite re-optimizes cleanly.`);
  } else {
    // The committed tree is intact, so leave it alone: rebuilding on every
    // start would cost seconds of cold start and, worse, hand every open tab a
    // fresh browserHash for no reason.
    log(`deps/ is healthy — ${optimized.size} deps pre-bundled, all ${required.length} required packages present.`);
  }
}

// ── 4. Sweep the build cache ───────────────────────────────────────────────
//
// A dev crash can leave a half-written _metadata.json in the build cache, and
// `vite build` then fails on it. It is a separate directory (vite.config.js
// splits the two so a build cannot corrupt a running dev server), needs no
// liveness guard, and is only read by `vite build` — so checking it costs
// nothing and cannot disturb a dev session.
const buildDepsDir = join(appRoot, 'node_modules', '.vite-build', 'deps');
if (existsSync(buildDepsDir)) {
  try {
    JSON.parse(readFileSync(join(buildDepsDir, '_metadata.json'), 'utf8'));
  } catch {
    discard(buildDepsDir, 'the build cache was incomplete — discarded so `vite build` re-optimizes cleanly.');
  }
}
