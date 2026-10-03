/**
 * The passkey loader must survive a stale dependency-optimizer hash.
 *
 * ── The failure this prevents ──────────────────────────────────────────────
 *
 * `@simplewebauthn/browser` is imported lazily. If the dev server's optimizer
 * re-runs mid-session, the `?v=` hash on every module URL the open page holds
 * stops resolving, and the lazy import rejects with:
 *
 *   TypeError: Failed to fetch dynamically imported module:
 *   http://localhost:5173/node_modules/.vite/deps/@simplewebauthn_browser.js?v=<old>
 *
 * The PDF export paths already route this through `reloadOnceForStaleChunk`, and
 * the app-level error boundary catches the same error when it is thrown during
 * render. The passkey paths were the gap: they are ASYNC EVENT HANDLERS, so
 * their rejections never reach the error boundary — they surface as a rejected
 * promise the panel turns into a red banner, and the feature stays dead until
 * someone manually reloads the browser.
 *
 * A reload always fixes it, because the fresh document requests the new hash.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isStaleChunkError, reloadOnceForStaleChunk } from './chunkReload.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, ...p), 'utf8');
const api = read('..', 'api.js');

/**
 * Install a minimal `window` for the duration of `run`.
 *
 * The self-heal is guarded by `typeof window === 'undefined'`, so under plain
 * Node it correctly declines to reload and every assertion about the one-shot
 * flag would trivially pass. The same stub shape as chunkReload.test.js, with a
 * private sessionStorage per call, so the one-shot flag is isolated.
 */
function withWindow(run) {
  const had = 'window' in globalThis;
  const previous = globalThis.window;
  const store = new Map();
  const reloads = { count: 0 };
  globalThis.window = {
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    location: { reload: () => { reloads.count += 1; } },
  };
  try {
    return run(reloads);
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }
}

// The literal message the browser produced in the report this guards.
const REPORTED = 'Failed to fetch dynamically imported module: '
  + 'http://localhost:5173/node_modules/.vite/deps/@simplewebauthn_browser.js?v=64c80f3a';

test('the reported browser error is recognised as a stale module load', () => {
  assert.equal(
    isStaleChunkError(new TypeError(REPORTED)),
    true,
    'the exact message from the bug report must trigger the self-heal',
  );
  // Also as a bare string, since a rejected dynamic import does not always
  // arrive wrapped in an Error.
  assert.equal(isStaleChunkError(REPORTED), true);
});

test('exactly one bare import of the SDK exists, and it is inside the loader', () => {
  // A bare `await import('@simplewebauthn/browser')` left in a call site would
  // silently bypass the backstop again, and nothing else would notice. Exactly
  // ONE is correct — the one inside `loadWebAuthn` itself, which is the whole
  // point of the wrapper.
  const bare = [...api.matchAll(/await import\('@simplewebauthn\/browser'\)/g)];
  assert.equal(
    bare.length,
    1,
    `expected the SDK to be imported in exactly one place, found ${bare.length} — `
    + 'every other site must go through loadWebAuthn()',
  );
  assert.match(api, /const loadWebAuthn = async \(\) =>/, 'the loader should exist');

  // And it must be the loader that holds it, not some unrelated function.
  const loader = /const loadWebAuthn = async \(\) => \{[\s\S]*?\n\};/.exec(api);
  assert.ok(loader, 'the loader is inspectable');
  assert.match(
    loader[0],
    /await import\('@simplewebauthn\/browser'\)/,
    'the single direct import must live inside loadWebAuthn',
  );
});

test('the loader self-heals a stale hash and signals the caller to stand down', () => {
  // The contract callers rely on: a scheduled reload is reported as `null`, not
  // thrown, so no caller shows a banner over a screen that is being replaced.
  assert.match(
    api,
    /if \(isStaleChunkError\(loadError\) && reloadOnceForStaleChunk\(loadError\)\) return null;/,
    'a stale-chunk error should return null rather than throw',
  );
  // A genuine failure must still surface, or a broken WebAuthn environment
  // would silently do nothing.
  assert.match(api, /throw loadError;/, 'a real load failure must still propagate');
});

test('all three passkey call sites handle the stand-down signal', () => {
  // `addPasskey` and `signInWithPasskey` are user-initiated: returning null
  // means "a reload is coming", and the caller's `finally` block will not render
  // anything. Both must check before touching the result.
  const cases = [
    [join('..', 'Pages', 'LogIn.jsx'), /if \(!data\) return;/],
    [
      join('..', 'Components', 'ProfileSecurityControls', 'PasskeyPanel.jsx'),
      /if \(!mounted\.current \|\| !res\) return;/,
    ],
  ];
  for (const [file, guard] of cases) {
    assert.match(read(file), guard, `${file} must not render a result that is null`);
  }
});

test('the autofill watcher deliberately does not reload', () => {
  // Reloading from a background watcher would throw away the sign-in form the
  // user is typing into, to fix a problem the button does not have. It loads the
  // same module and does self-heal, so the watcher only stands down.
  const watcher = /export const watchForPasskeyAutofill[\s\S]*?\n\};/.exec(api);
  assert.ok(watcher, 'the autofill watcher is inspectable');
  assert.match(
    watcher[0],
    /if \(!webauthn\) return \(\) => \{\};/,
    'the watcher must return a no-op cancel rather than reloading',
  );
  assert.ok(
    !/reloadOnceForStaleChunk/.test(watcher[0]),
    'and must not schedule a reload of its own',
  );
});

test('the self-heal is one-shot, so a genuinely broken build cannot loop', () => {
  // Re-read through the real helper: the flag lives in sessionStorage, so a
  // reload happens once and then the real error surfaces.
  withWindow((reloads) => {
    assert.equal(reloadOnceForStaleChunk(new TypeError(REPORTED)), true, 'first attempt reloads');
    assert.equal(reloadOnceForStaleChunk(new TypeError(REPORTED)), false, 'second is suppressed');
    assert.equal(reloads.count, 1, 'exactly one location.reload() call');
  });
});
