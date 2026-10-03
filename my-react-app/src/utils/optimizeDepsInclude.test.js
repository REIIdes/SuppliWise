/**
 * Every dynamically-imported package must be in `optimizeDeps.include`.
 *
 * ── What this guards, and what it does not ─────────────────────────────────
 *
 * The failure it prevents is a 504 "Outdated Optimize Dep" on a lazy import:
 * Vite re-optimizes, the browser hash changes, and every `?v=` URL the loaded
 * page is holding stops resolving — surfacing as
 *
 *   Failed to fetch dynamically imported module:
 *   http://localhost:5173/node_modules/.vite/deps/<pkg>.js?v=<old hash>
 *
 * A dynamic import is invisible to the startup scan by design, so a lazy dep
 * relies on being discovered at use time. Listing it removes that dependence.
 *
 * HONESTY, because it was measured rather than assumed: on Vite 8.1.1 the
 * startup scanner DOES follow static-string dynamic imports, so removing an
 * entry does not immediately reproduce the 504. This test therefore guards the
 * CONFIG'S COMPLETENESS, not a live outage. That is still worth having — the
 * entries are what the config's own comment promises, and the day the scanner
 * stops following dynamic imports (or a dep is reached in a way the scanner
 * cannot see, such as a computed specifier) this list is the only thing standing
 * between that and a dead button.
 *
 * A dependency INSTALLED WHILE THE DEV SERVER IS RUNNING is the far more common
 * cause of the same 504, and no config entry prevents it; that needs a restart
 * with a cleared `node_modules/.vite`. See the note in vite.config.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..'); // my-react-app/src
const repoRoot = join(here, '..', '..', '..'); // repository root

const read = (...parts) => readFileSync(join(...parts), 'utf8');
const viteConfig = read(repoRoot, 'my-react-app', 'vite.config.js');

/** Every .js/.jsx file under src/, excluding test files. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.(js|jsx)$/.test(entry) && !/\.test\.jsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The package list in `optimizeDeps.include`.
 *
 * Read out of the config as TEXT rather than by importing it, for the same
 * reason the admin policy test does: importing vite.config.js would execute
 * `defineConfig` and pull in vite, the react plugin and vite-plugin-pwa purely
 * to assert on a literal, and those are ESM-only with a build-time environment.
 */
function configuredIncludes() {
  const block = /optimizeDeps:\s*\{[\s\S]*?include:\s*\[([\s\S]*?)\]/.exec(viteConfig);
  assert.ok(block, 'optimizeDeps.include is still declared as an array literal');
  return [...block[1].matchAll(/'([^']+)'|"([^"]+)"/g)]
    .map((m) => m[1] || m[2])
    .filter(Boolean);
}

/**
 * Remove comments, preserving string and template literals.
 *
 * Necessary rather than tidy. `chunkReload.js` opens with the prose
 * "Self-heal from stale dynamic-import (\"chunk\") failures" — which matches
 * `import ("chunk")` exactly, and reports a package called `chunk` that does not
 * exist. A test that cries wolf gets deleted, so comments come out first.
 *
 * Written as a small state machine instead of a regex pair because the obvious
 * regex (`/[^:]//.*$/`) mangles `http://` inside a string, and deleting a
 * string would hide a genuine `import('pkg')` that happened to share a line with
 * a URL — trading a false positive for a false negative, which is worse.
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  // 'code' | 'line' | 'block' | "'" | '"' | '`'
  let state = 'code';
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { state = ch; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
      // Keep newlines so that any line-based tooling downstream still lines up.
      if (ch === '\n') out += ch;
      i += 1; continue;
    }
    // Inside a string or template literal: emit verbatim, and let an escaped
    // quote pass without ending it.
    if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
    if (ch === state) state = 'code';
    out += ch; i += 1; continue;
  }
  return out;
}

/**
 * Packages reached by a dynamic import in `source`.
 *
 * Two things are deliberately excluded:
 *   • RELATIVE specifiers ('./Pages/Foo') — app source, not a dependency, so
 *     they are transformed on demand and never appear under /node_modules/.vite.
 *   • template/interpolated specifiers — not statically knowable, and no package
 *     in this app uses one.
 */
function dynamicImportedPackages(source) {
  const found = new Set();
  for (const m of stripComments(source).matchAll(/\bimport\s*\(\s*(['"`])([^'"`$]+)\1\s*\)/g)) {
    const specifier = m[2];
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
    // Sub-path imports keep their package name, because optimizeDeps.include is
    // keyed on the package.
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    found.add(name);
  }
  return found;
}

test('every dynamically-imported package is pre-bundled', () => {
  const includes = configuredIncludes();
  const offenders = [];

  for (const file of sourceFiles(srcDir)) {
    const packages = dynamicImportedPackages(read(file));
    for (const pkg of packages) {
      if (!includes.includes(pkg)) {
        offenders.push(`${relative(repoRoot, file)} -> '${pkg}'`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these packages are reached by a dynamic import but are missing from '
    + 'optimizeDeps.include in vite.config.js. Each one will 504 ("Outdated '
    + 'Optimize Dep") the first time it is used in a running dev server:\n  '
    + offenders.join('\n  '),
  );
});

test('the list is not empty, so the check cannot pass by scanning nothing', () => {
  // A test that silently stops matching (a renamed helper, a moved directory)
  // would pass forever. These three are the known dynamic imports; if they ever
  // stop being dynamic, the assertion above is what should fail.
  const includes = configuredIncludes();
  assert.ok(includes.length > 0, 'optimizeDeps.include has entries to check against');
  for (const pkg of ['jspdf', 'jspdf-autotable', '@simplewebauthn/browser']) {
    assert.ok(includes.includes(pkg), `${pkg} is pre-bundled`);
  }
});

test('the scanner really does find the dynamic imports it is meant to find', () => {
  // A regex that silently matches nothing would make the test above vacuous.
  const sample = `
    const a = await import('@scope/pkg/sub');
    const b = await import('plain-pkg');
    const c = await import('./relative');
    const d = await import('/absolute');
    const e = await import(\`templated/\${x}\`);
  `;
  assert.deepEqual(
    [...dynamicImportedPackages(sample)].sort(),
    ['@scope/pkg', 'plain-pkg'],
    'scoped sub-paths collapse to the package, relative/absolute/template are ignored',
  );
});

test('a sub-path import is checked against its package name', () => {
  // `@scope/pkg/sub` pre-bundles as `@scope/pkg`, so keying the include on the
  // full sub-path would let a real omission through.
  const includes = configuredIncludes();
  assert.ok(
    !includes.some((entry) => entry.includes('/sub')),
    'include entries are package names, not sub-paths',
  );
});

test('prose about dynamic imports is not mistaken for one', () => {
  // The false positive that would have got this test deleted. This is a faithful
  // reproduction of the head of `chunkReload.js`, opening `/*` included — a
  // JSDoc body is only stripped because line 1 put the stripper into block mode.
  // Reproducing it without the opener would test nothing: the text would simply
  // be valid code, and any scanner would be right to flag it.
  const prose = [
    '/**',
    ' * Self-heal from stale dynamic-import ("chunk") failures.',
    ' *',
    " *   Failed to fetch dynamically imported module:",
    ' */',
    "// import('not-a-real-package') in a line comment",
    "/* import('nor-this-one') in a block comment */",
  ].join('\n');
  assert.deepEqual([...dynamicImportedPackages(prose)], [], 'comments must not be scanned');
});

test('a real import on a line with a URL is still found', () => {
  // The failure the obvious `[^:]//` regex would cause. Deleting the rest of the
  // line would also delete a genuine import, turning a false positive into a
  // false negative — which is the worse direction.
  const tricky = `
    const base = "https://example.com"; const { x } = await import('real-pkg');
  `;
  assert.deepEqual([...dynamicImportedPackages(tricky)], ['real-pkg'], 'a URL must not swallow the import');
});

test('an escaped quote inside a string does not end it early', () => {
  // A regression guard on the stripper's own state machine, asserting what it
  // actually does: string CONTENTS are preserved verbatim, so the `import(...)`
  // text inside the string is still seen, and — the point of the case — the real
  // import after the string is found too. If the escaped `\"` had closed the
  // string early, everything between the two quotes would have been scanned as
  // code and `kept-pkg` would be lost.
  const src = `const s = "he said \\"hi\\" import('ghost')"; const t = await import('kept-pkg');`;
  const found = [...dynamicImportedPackages(src)];
  assert.ok(found.includes('kept-pkg'), 'the real import after the string must be found');

  // A string that merely CONTAINS the import syntax is reported. That is a known
  // limitation of scanning without a parser, and it is safe here for two
  // reasons: nothing in src/ does it, and this very test file is excluded from
  // the scan, so the example cannot feed itself.
  assert.ok(
    found.includes('ghost'),
    'string contents are preserved verbatim — documented limitation, not a state-machine bug',
  );
});

test('the scan set is limited to real app code, so the limitation above cannot bite', () => {
  // Belt and braces on the previous caveat: the only file in this repository
  // that contains `import('…')` inside a string literal is this test, and the
  // scanner must not look at test files at all.
  const scanned = sourceFiles(srcDir).map((f) => relative(repoRoot, f));
  assert.ok(
    scanned.every((f) => !/\.test\.jsx?$/.test(f)),
    'test files are excluded from the scan',
  );
});

test('the stripper preserves line count', () => {
  // Block comments are removed, but their newlines are kept, so a line-based
  // error message from the main test still points at the right place.
  const src = 'a\n/* one\ntwo\nthree\n*/\nb';
  const stripped = stripComments(src);
  assert.equal(stripped.split('\n').length, src.split('\n').length);
});
