/* Backend reachability store.

   The UI must keep rendering when the API is down, but every action that
   depends on it (assessment, plan updates, sign-in flows) has to be visibly
   inert rather than walking the user into forms that cannot be submitted.

   This module is deliberately dependency-free: api.js owns the probe (it has
   BASE_URL) and registers it here, which keeps the import direction acyclic.
   Status changes are reported by apiFetch/w3Fetch on every request, so the
   store also doubles as the recovery detector — the health probe only runs
   while nothing else has talked to the server. */

const PROBES = {
  DOWN: 'down',
  UP: 'up',
  UNKNOWN: 'unknown',
};

const PROBE_INTERVAL_MS = 15000;
const PROBE_TIMEOUT_MS = 5000;

let status = PROBES.UNKNOWN;
let probeFn = null;
let probeTimer = null;
let probing = false;
const listeners = new Set();

const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* one bad listener must not strand the rest */ } });

const setStatus = (next) => {
  if (status === next) return;
  status = next;
  emit();
};

const startProbing = () => {
  if (probeTimer != null || typeof setInterval !== 'function') return;
  probeTimer = setInterval(runProbe, PROBE_INTERVAL_MS);
  runProbe();
};

const stopProbing = () => {
  if (probeTimer != null) { clearInterval(probeTimer); probeTimer = null; }
};

const runProbe = async () => {
  if (probing || typeof probeFn !== 'function') return;
  probing = true;
  try {
    const reachable = await probeFn();
    if (reachable) {
      setStatus(PROBES.UP);
      stopProbing();
    }
  } catch {
    /* probe errors just mean "still down" — the next tick retries */
  } finally {
    probing = false;
  }
};

export const markBackendDown = () => {
  setStatus(PROBES.DOWN);
  startProbing();
};

export const markBackendUp = () => {
  setStatus(PROBES.UP);
  stopProbing();
};

export const isBackendDown = () => status === PROBES.DOWN;
export const getBackendStatus = () => status;

export const subscribeBackendStatus = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// Registered by api.js once BASE_URL is known. Also wires the browser's own
// connectivity events: going offline is an immediate "down" (no point letting
// the user click into a form the OS already knows cannot load), and coming
// back online probes once instead of waiting out the interval.
export const setBackendProbe = (fn) => {
  probeFn = fn;
  // Feature-detected, not just window-detected: the node --test harness
  // installs a bare `window` object (apiBaseUrl.test.js) with no events on it.
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  if (window.__backendStatusEventsBound) return;
  window.__backendStatusEventsBound = true;
  window.addEventListener('offline', markBackendDown);
  window.addEventListener('online', () => { runProbe(); });
};

// A probe with a hard timeout, shared by api.js and web3.js so both agree on
// what "reachable" means: ANY HTTP answer proves the server process is up —
// even a 404 or a 503 from a still-connecting database.
export const healthProbeFetch = async (baseUrl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(`${baseUrl}/health`, { method: 'GET', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};
