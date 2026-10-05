/**
 * A Vite server created inside a test must never share the dev server's cache.
 *
 * ── The failure this prevents ──────────────────────────────────────────────
 *
 * `RecoveryPanel.test.js` loads a JSX component through Vite's SSR pipeline,
 * which means calling `createServer` from `vite` with this project's root. With
 * no `cacheDir`, that server defaults to `node_modules/.vite` — the exact
 * optimizer cache `npm run dev` owns. Initialising there begins by DELETING the
 * committed dependency tree (its own log line reads "removing old cache dir
 * …/node_modules/.vite/deps"), so running `npm test` next to a dev server
 * silently destroys that server's pre-bundled dependencies.
 *
 * What the developer sees is nothing like a cache problem:
 *
 *   Failed to fetch dynamically imported module:
 *   http://localhost:5173/node_modules/.vite/deps/@simplewebauthn_browser.js?v=<hash>
 *
 * Every dependency URL answers 504 "Outdated Optimize Dep", the dev-server
 * console stays quiet, and the page will not render until someone stops the
 * server, deletes `node_modules/.vite` by hand and restarts. Observed twice in
 * this repository: 20 orphaned `deps_temp_*` directories with no committed
 * `deps/` at all, and a dev server left idle-but-wedged — module requests
 * hanging indefinitely while CPU stayed flat at zero.
 *
 * ── Why this is a test rather than a comment ────────────────────────────────
 *
 * The fix is one line in the test file, which is exactly why it does not stick:
 * that file gets edited, the line is lost in a merge or a revert, and the
 * outage comes back with nothing in the diff to explain it. This file was
 * written after the fix was silently reverted once already, and the whole point
 * is that the NEXT revert fails the suite instead of the dev server.
 *
 * Note what this cannot do: it cannot stop a developer running `npm test` while
 * editing that test file, so the fix also has to be present in the file. Both
 * halves are load-bearing — this one makes the loss loud, the other makes the
 * loss not happen.
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

function testFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (/\.test\.jsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Test files that construct a Vite server, i.e. the ones that can collide. */
function filesCreatingViteServers() {
  return testFiles(srcDir).filter((f) => /\bcreateServer\s*\(/.test(read(f)));
}

/**
 * Does the options object passed to createServer set `cacheDir`?
 *
 * Matches the shorthand (`cacheDir,`) as well as `cacheDir: …`, because the
 * correct fix is naturally written as a shorthand — it holds a variable holding
 * a fresh temp directory — and a check that only understood the colon form would
 * report the one file in the repo that does this correctly as broken. A test
 * that condemns the fix is worse than no test.
 */
function setsCacheDir(optionsSource) {
  return /\bcacheDir\s*[:,}]/.test(optionsSource);
}

test('a test that creates a Vite server cannot collide with the dev server', () => {
  const offenders = [];

  for (const file of filesCreatingViteServers()) {
    const source = read(file);
    // The options object is what matters, so look after the call rather than
    // for the identifier: a file may import `createServer` without using it.
    const after = source.slice(source.search(/\bcreateServer\s*\(/));
    if (!setsCacheDir(after)) {
      offenders.push(`${relative(repoRoot, file)} -> createServer() with no cacheDir`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these tests call vite\'s createServer() without a cacheDir, so the server '
    + 'they build defaults to node_modules/.vite — the cache npm run dev owns. '
    + 'Initialising there deletes the dev server\'s committed deps/ tree, and '
    + 'every dependency URL then 504s ("Outdated Optimize Dep"), which reaches '
    + 'the browser as "Failed to fetch dynamically imported module". Pass a '
    + 'throwaway directory (mkdtempSync(join(tmpdir(), ...))) and remove it in '
    + 'after(), once the server is closed:\n  ' + offenders.join('\n  '),
  );
});

test('the cacheDir it does pass is a throwaway, not a project directory', () => {
  // Satisfying the check above with `cacheDir: 'node_modules/.vite'` would be
  // worse than passing nothing: it looks deliberate and still destroys the dev
  // server's cache. The isolation has to come from outside the project.
  const offenders = [];

  for (const file of filesCreatingViteServers()) {
    const source = read(file);
    const after = source.slice(source.search(/\bcreateServer\s*\(/));
    if (!setsCacheDir(after)) continue; // already reported above

    // A literal path into the project is the tell. `cacheDir` bound to a
    // variable is the good case — but only if that variable really is a fresh
    // temp directory, so the temp-dir construction is looked for in the WHOLE
    // file rather than after createServer(). The natural fix assigns it first
    // (`cacheDir = mkdtempSync(...)` inside `before`), so searching only the
    // options object would find neither the assignment nor the mkdtemp call and
    // would condemn the one file that does this correctly.
    const literal = /cacheDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(after);
    const usesTemp = /\bmkdtempSync\b/.test(source) && /\btmpdir\b/.test(source);

    if (literal && !usesTemp) {
      offenders.push(`${relative(repoRoot, file)} -> cacheDir: '${literal[1]}'`);
    }
    if (!literal && !usesTemp) {
      offenders.push(
        `${relative(repoRoot, file)} -> cacheDir is not a throwaway `
        + '(no mkdtempSync(join(tmpdir(), ...)))',
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a test Vite server needs a cache directory that is thrown away afterwards, '
    + 'so it cannot outlive the process or sit inside the project where the dev '
    + 'server would collide with it:\n  ' + offenders.join('\n  '),
  );
});

test('this scanner can still find a Vite server, so the checks above are not vacuous', () => {
  // Both checks above pass trivially if the filter stops matching. RecoveryPanel
  // is the known case and the reason this file exists, so assert it is seen.
  const creators = filesCreatingViteServers();
  assert.ok(
    creators.some((f) => f.endsWith(join('ProfileSecurityControls', 'RecoveryPanel.test.js'))),
    'RecoveryPanel.test.js is recognised as creating a Vite server',
  );

  // And it must be recognised as CORRECTLY isolated — otherwise a filter that
  // matches nothing would look identical to a healthy repo.
  const source = read(creators.find((f) => f.endsWith('RecoveryPanel.test.js')));
  assert.ok(setsCacheDir(source), 'RecoveryPanel.test.js passes a cacheDir');
  assert.match(source, /mkdtempSync/, 'and it is a fresh temp directory');
});
