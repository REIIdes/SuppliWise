/**
 * Dev-server dependency check.
 *
 * Loads the app the way a browser does — fetch the entry, follow the dep URLs
 * the server rewrites into it — and asserts each one resolves, and that the
 * optimizer hash does not move underneath the page.
 *
 * This is the only check that can see the failure it guards. The broken URL
 * (`/node_modules/.vite/deps/@simplewebauthn_browser.js?v=<old hash>` → 504) is
 * a rewrite the dev server itself emitted, so asking the server is the only
 * honest way to test it. Unit tests, `eslint` and `vite build` all pass with the
 * dep missing from `optimizeDeps.include`; nothing short of talking to a running
 * dev server reaches this class of bug.
 *
 * ── Why there is a warm-up pass ────────────────────────────────────────────
 *
 * The first client to walk the whole module graph discovers deps the startup
 * scan missed, which forces ONE re-optimize and changes the hash. That is normal
 * Vite behaviour and a browser simply reloads. Asserting stability on the very
 * first walk would therefore fail on a perfectly healthy server, and a check
 * that cries wolf gets ignored.
 *
 * What must hold is that it converges: the hash is identical before and after a
 * second full walk, and every dep URL the server advertises during that second
 * walk resolves. A dep missing from `optimizeDeps.include` is discovered at
 * CLICK time instead, so the hash moves mid-session, long after this script has
 * finished — which is exactly the bug the first walk cannot see and the
 * stability check is here to catch.
 *
 * Usage: node scripts/verifyDevDeps.mjs [baseUrl]
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://localhost:5173';
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const srcDir = join(appRoot, 'src');

// Read out of the same place Vite wrote it, so this reports what the server
// actually decided rather than what the config claims.
const METADATA_PATH = join(appRoot, 'node_modules', '.vite', 'deps', '_metadata.json');

/** The packages reached by a dynamic import — the ones at risk. */
const DYNAMIC_PACKAGES = ['jspdf', 'jspdf-autotable', '@simplewebauthn/browser'];

async function readOptimizerMetadata() {
  try {
    return JSON.parse(readFileSync(METADATA_PATH, 'utf8'));
  } catch {
    return null;
  }
}

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? '  -> ' + extra : ''}`);
  ok ? pass += 1 : fail += 1;
};

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(js|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = sourceFiles(srcDir).map(
  (f) => '/' + relative(appRoot, f).replace(/\\/g, '/'),
);

const get = async (url) => {
  const res = await fetch(url);
  return { status: res.status, text: await res.text().catch(() => '') };
};

const DEP_RE = /["'](\/node_modules\/\.vite\/deps\/[^"']+?)["']/g;

/** Walk every module, collecting the dep URLs the server rewrites into them. */
async function walk() {
  const depUrls = new Set();
  const badModules = [];
  for (const file of files) {
    const mod = await get(`${BASE}${file}`);
    if (mod.status !== 200) {
      badModules.push(`${file} -> ${mod.status}`);
      continue;
    }
    for (const m of mod.text.matchAll(DEP_RE)) depUrls.add(m[1]);
  }
  return { depUrls, badModules };
}

const root = await get(`${BASE}/`);
check('dev server responds', root.status === 200, `status ${root.status}`);
if (root.status !== 200) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

// ── Warm-up: the first walk is allowed to move the hash once. ────────────
const warm = await walk();
// Vite answers a stale `?v=` with 504 "Outdated Optimize Dep" precisely so the
// client reloads. Give it a moment to finish committing, as a browser would.
await new Promise((r) => setTimeout(r, 2000));

// ── The pass that must be clean. ─────────────────────────────────────────
const main = await walk();

check(
  'every source module transforms',
  main.badModules.length === 0,
  main.badModules.length ? main.badModules.slice(0, 5).join(', ') : `${files.length} modules`,
);

const depErrors = [];
for (const url of main.depUrls) {
  const res = await get(`${BASE}${url}`);
  if (res.status !== 200) depErrors.push(`${url} -> ${res.status}`);
}
check(
  'every rewritten dependency URL resolves',
  depErrors.length === 0,
  depErrors.length ? depErrors.join(', ') : `${main.depUrls.size} distinct dep URLs`,
);

// Stability: the same walk twice must produce the same URL set. A dep that is
// still being discovered at click time moves the hash mid-session, which is what
// leaves a long-lived tab holding 504s.
const after = await walk();
const moved = [...main.depUrls].filter((u) => !after.depUrls.has(u));
check(
  'the optimizer has converged (a second walk moves nothing)',
  moved.length === 0,
  moved.length ? `moved: ${moved.slice(0, 3).join(', ')}` : `${after.depUrls.size} dep URLs stable`,
);

// The dep this exercise exists for must be pre-bundled, so the startup scan
// finds it and no click-time re-optimize is needed.
const passkey = [...after.depUrls].find((u) => u.includes('simplewebauthn'));
check(
  '@simplewebauthn/browser is pre-bundled and served',
  Boolean(passkey),
  passkey || 'not found in any rewritten specifier',
);

// ── The decisive assertion: pre-bundled AT STARTUP ────────────────────────
//
// A walking client discovers `@simplewebauthn/browser` on its way, so the
// walk-based checks above can pass even with the package absent from
// `optimizeDeps.include` — verified: on Vite 8.1.1 the startup scanner follows
// static-string dynamic imports, so removing the include entry did NOT make this
// script fail.
//
// What this assertion is genuinely for is the state that actually breaks a dev
// session: a server whose optimizer cache is corrupt or absent, which is what
// happens when a package is installed while the dev server is already running.
// That server reports 504 on every dep URL and leaves orphaned `deps_temp_*`
// folders. Comparing the metadata against the known dynamic imports detects it
// immediately, and the fix is `rm -rf node_modules/.vite` plus a restart.
//
// So: a health check for the optimizer's on-disk state, not a test of the
// include list. `src/utils/optimizeDepsInclude.test.js` is what guards the list.
const metadata = await readOptimizerMetadata();
if (metadata) {
  const optimized = new Set(Object.keys(metadata.optimized || {}));
  const discoveredLate = DYNAMIC_PACKAGES.filter((pkg) => !optimized.has(pkg));
  check(
    'every dynamically-imported package is pre-bundled at startup',
    discoveredLate.length === 0,
    discoveredLate.length
      ? `discovered late, not by the startup scan: ${discoveredLate.join(', ')}`
      : `${optimized.size} deps pre-bundled, including all ${DYNAMIC_PACKAGES.length} dynamic ones`,
  );
} else {
  check('every dynamically-imported package is pre-bundled at startup', false, `${METADATA_PATH} not found`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
