import test from 'node:test';
import assert from 'node:assert/strict';

// The module reads `window` lazily inside its functions, so a stub installed on
// globalThis before each call is enough - no jsdom needed.
function withWindow(stub, run) {
  const had = 'window' in globalThis;
  const previous = globalThis.window;
  const store = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      ...stub,
    },
    ...(stub?.window || {}),
  };
  try {
    return run(store);
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }
}

const STALE = [
  'Failed to fetch dynamically imported module: http://localhost:5173/node_modules/.vite/deps/jspdf.js?v=70dd7174',
  'error loading dynamically imported module: /assets/History.js',
  'Importing a module script failed.',
  'ChunkLoadError: Loading chunk 42 failed.',
  'Outdated Optimize Dep',
  'Unable to preload CSS for /assets/Home.css',
  // Two React copies in one module graph: a half-reloaded dev session.
  'Warning: Invalid hook call. Hooks can only be called inside of the body of a function component.',
  'You might have more than one copy of React in the same app',
  "TypeError: Cannot read properties of null (reading 'useContext')",
  "TypeError: Cannot read property 'useReducer' of null",
];

const REAL = [
  'The `style` prop expects a mapping from style properties to values, not a string.',
  'ReferenceError: answersTarget is not defined',
  'PDF export is unavailable: the jsPDF library failed to load.',
  'Invalid argument passed to jsPDF.f2',
  null,
  undefined,
];

test('recognises every stale-module wording and no real bug', async () => {
  const { isStaleChunkError } = await import('./chunkReload.js');
  for (const message of STALE) {
    assert.equal(isStaleChunkError(new Error(message)), true, message);
    assert.equal(isStaleChunkError(message), true, message);
  }
  for (const message of REAL) {
    assert.equal(isStaleChunkError(new Error(message)), false, String(message));
  }
  assert.equal(isStaleChunkError(null), false);
  assert.equal(isStaleChunkError(undefined), false);
  assert.equal(isStaleChunkError({}), false);
});

test('a stale chunk schedules exactly one reload, never a loop', async () => {
  const { reloadOnceForStaleChunk } = await import('./chunkReload.js');
  let reloads = 0;
  const err = new Error(STALE[0]);
  withWindow({ window: { location: { reload: () => { reloads += 1; } } } }, () => {
    assert.equal(reloadOnceForStaleChunk(err), true, 'first attempt should reload');
    assert.equal(reloadOnceForStaleChunk(err), false, 'second attempt must be suppressed');
    assert.equal(reloadOnceForStaleChunk(err), false);
  });
  assert.equal(reloads, 1, 'exactly one location.reload() call');
});

test('a real error never triggers a reload', async () => {
  const { reloadOnceForStaleChunk } = await import('./chunkReload.js');
  let reloads = 0;
  withWindow({ window: { location: { reload: () => { reloads += 1; } } } }, () => {
    assert.equal(reloadOnceForStaleChunk(new Error(REAL[0])), false);
    assert.equal(reloadOnceForStaleChunk(null), false);
  });
  assert.equal(reloads, 0);
});

test('recovery re-arms the one-shot reload for a later, unrelated failure', async () => {
  const { reloadOnceForStaleChunk, markChunkReloadHealthy } = await import('./chunkReload.js');
  const err = new Error(STALE[0]);
  let reloads = 0;
  withWindow({ window: { location: { reload: () => { reloads += 1; } } } }, () => {
    assert.equal(reloadOnceForStaleChunk(err), true);
    assert.equal(reloadOnceForStaleChunk(err), false);

    // The page comes back healthy and the app says so.
    markChunkReloadHealthy();
    assert.equal(reloadOnceForStaleChunk(err), true, 'should be allowed to self-heal again');
  });
  assert.equal(reloads, 2);
});

test('storage being unavailable cannot cause a reload loop', async () => {
  const { reloadOnceForStaleChunk } = await import('./chunkReload.js');
  const err = new Error(STALE[0]);
  // Every sessionStorage call throws, like a locked-down webview.
  withWindow({ window: { location: { reload: () => { throw new Error('reloaded'); } } } }, () => {
    // The in-memory guard (alreadyTried stays false but the flag write throws)
    // must not turn this into an infinite reload; a thrown reload is the worst
    // case and is surfaced rather than swallowed in a loop.
    assert.throws(() => reloadOnceForStaleChunk(err), /reloaded/);
  });
});
