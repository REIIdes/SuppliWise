/**
 * Self-heal from stale dynamic-import ("chunk") failures.
 *
 * Vite's dependency optimizer can rewrite `node_modules/.vite/deps` while the
 * dev server is running. When it does, `browserHash` changes and every module
 * URL the current page already holds (`...?v=<old>`) stops resolving — the
 * server answers 504 "Outdated Optimize Dep" and the browser reports:
 *
 *   Failed to fetch dynamically imported module:
 *   http://localhost:5173/node_modules/.vite/deps/jspdf.js?v=<old hash>
 *
 * A reload always fixes it, because the fresh document requests the new hash.
 * Without this the user is stranded on a dead page whose only escape is
 * finding the browser's reload button.
 *
 * The reload is deliberately one-shot: the flag lives in sessionStorage, so a
 * genuinely broken build reloads once and then surfaces the real error instead
 * of looping forever.
 */

const RELOAD_FLAG = 'suppliwise:chunk-reload';
const RESET_FLAG = 'suppliwise:chunk-reload-ok';

/**
 * True when an error looks like a failed module load rather than a real bug.
 * Covers the browser's TypeError wording, Vite's 504 body, and the webpack
 * naming convention, so the check keeps working if the bundler changes.
 */
export function isStaleChunkError(error) {
  if (!error) return false;
  const message = typeof error === 'string' ? error : String(error.message || '');
  return /Failed to fetch dynamically imported module/i.test(message)
    || /error loading dynamically imported module/i.test(message)
    || /Importing a module script failed/i.test(message)
    || /ChunkLoadError/i.test(message)
    || /Loading chunk \S+ failed/i.test(message)
    || /Outdated Optimize Dep/i.test(message)
    || /Unable to preload CSS for/i.test(message)
    // A half-reloaded dev session ends up holding two copies of React (one
    // from the previous optimizer generation, one from the current), so every
    // hook call sees a null dispatcher. A reload always resolves it.
    || /Invalid hook call/i.test(message)
    || /more than one copy of React/i.test(message)
    // Both wordings occur: "properties of null (reading 'useContext')" and
    // "property 'useReducer' of null".
    || /Cannot read propert(?:y|ies).{0,48}'use[A-Z]/i.test(message);
}

/**
 * Reload the document once if this was a stale module load.
 * Returns true when a reload was scheduled, so callers can await the new page
 * instead of also reporting a failure the user already navigated away from.
 */
export function reloadOnceForStaleChunk(error) {
  if (typeof window === 'undefined') return false;
  if (!isStaleChunkError(error)) return false;

  let alreadyTried = false;
  try {
    alreadyTried = window.sessionStorage.getItem(RELOAD_FLAG) === '1';
  } catch {
    // Private browsing / storage disabled: fall back to reloading anyway, but
    // only once per page load, which the in-memory guard below provides.
  }

  if (alreadyTried) return false;

  try {
    window.sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch {
    // Ignore: the in-memory guard still prevents a reload loop.
  }

  window.location.reload();
  return true;
}

/**
 * Call once the app is running normally again, so a later, unrelated failure
 * is still allowed its own single self-heal.
 */
export function markChunkReloadHealthy() {
  if (typeof window === 'undefined') return;
  try {
    if (window.sessionStorage.getItem(RELOAD_FLAG) === '1') {
      window.sessionStorage.setItem(RESET_FLAG, '1');
      window.sessionStorage.removeItem(RELOAD_FLAG);
    }
  } catch {
    // Non-fatal.
  }
}
