import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ═══════════════════════════════════════════════════════════════════════════
//  Live security monitor state — ONE fetch, ONE poll, shared by every consumer.
//
//  The Overview dashboard's "Threat notifications" card and the Security
//  Center tab used to answer the same question ("is the platform healthy?")
//  from two different places:
//
//    · the card read `overview.notifications`, which the server derives from
//      `securityChecks()` — five static checks of a handful of env variables;
//    · the Security tab read `GET /admin/security/monitor` — 45 live probes.
//
//  Those two sets barely overlap, so the card could report "All systems secure"
//  on a dashboard where the Security Center was showing critical monitors. The
//  card was also unable to link to the tab that had the real answer, because the
//  one button that did so only rendered when the (static) checks were failing.
//
//  Hoisting the fetch here fixes both halves at once: the card and the Security
//  Center now read the same numbers from the same response, so they cannot
//  disagree, and `active` lets the caller keep the probes off the wire when
//  neither surface is on screen.
// ═══════════════════════════════════════════════════════════════════════════

// How far apart two automatic probes are scheduled.
export const MONITOR_POLL_MS = 30000;

// Longest a single check may occupy the panel. `adminRequest` has no timeout of
// its own, so without this a stalled connection could leave the Sync button
// disabled and the panel frozen on stale numbers indefinitely.
export const MONITOR_REQUEST_TIMEOUT_MS = 20000;

// Severity order for the "needs attention" list. Critical outranks error,
// which outranks warning — the Security Center banner uses the same rule, so the
// card's ordering always agrees with the verdict the admin is about to read.
const ATTENTION_ORDER = ['critical', 'error', 'warning'];

const attentionRank = status => {
  const index = ATTENTION_ORDER.indexOf(status);
  return index === -1 ? ATTENTION_ORDER.length : index;
};

/**
 * Tally monitor rows by status.
 *
 * Every status that appears is present as a key, including the zero-valued ones
 * the Security Center's summary tiles read (`counts.healthy || 0`). Rows with no
 * `status` are counted as 'loading' so a malformed row can never silently
 * disappear from the totals and make the total disagree with the row count.
 */
export function countStatuses(monitors) {
  const list = Array.isArray(monitors) ? monitors : [];
  return list.reduce((acc, m) => {
    const key = (m && typeof m.status === 'string' && m.status) || 'loading';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

/**
 * The monitors that need attention, worst first.
 *
 * Returned from a copy so a consumer cannot reorder the shared poll result.
 * Severity order is stable within a status (Array#sort is stable), so the list
 * does not reshuffle between polls and make the card appear to flicker.
 */
export function attentionList(monitors) {
  const list = Array.isArray(monitors) ? monitors : [];
  return list
    .filter(m => m && attentionRank(m.status) < ATTENTION_ORDER.length)
    .slice()
    .sort((a, b) => attentionRank(a.status) - attentionRank(b.status));
}

// Empty state before the first response lands. `status: 'loading'` is what the
// Security Center banner has always shown while its first probe runs, and it is
// deliberately NOT 'healthy' — a consumer that reads an empty result as "secure"
// would report an all-clear before anything had actually been checked.
const INITIAL = {
  monitors: [],
  status: 'loading',
  syncedAt: null,
  audit: null,
  error: '',
};

export default function useSecurityMonitor(adminRequest, active = true) {
  const [monitors, setMonitors] = useState(INITIAL.monitors);
  const [status, setStatus] = useState(INITIAL.status);
  const [syncedAt, setSyncedAt] = useState(INITIAL.syncedAt);
  const [audit, setAudit] = useState(INITIAL.audit);
  const [error, setError] = useState(INITIAL.error);
  const [syncing, setSyncing] = useState(false);
  const [checking, setChecking] = useState(false);

  // Set while a request is on the wire, and bumped on every request so a slow
  // response can never overwrite a newer one.
  const inFlightRef = useRef(false);
  const requestSeqRef = useRef(0);
  const timerRef = useRef(0);

  const sync = useCallback(async (force = false) => {
    if (!adminRequest || !active) return;
    // Never stack requests: a poll that outlives its own period would queue
    // behind the previous one and the panel would fall further and further
    // behind the state it is meant to be showing.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const seq = ++requestSeqRef.current;
    setChecking(true);
    // Only a user-initiated Sync drives the button label and spinner. Background
    // polls used to flip it to "Syncing…" and disable it every 30 s, which read
    // as a permanently stuck control and blocked the one action an admin
    // actually wants to take. `checking` still disables it so a click can never
    // queue a second request behind the one already running.
    if (force) setSyncing(true);
    setError('');
    // Abort the request if it outlives its budget, so the panel always returns
    // to an interactive state and never sits on a spinner with stale numbers.
    const controller = new AbortController();
    const abortTimer = window.setTimeout(() => controller.abort(), MONITOR_REQUEST_TIMEOUT_MS);
    try {
      const data = await adminRequest(`/security/monitor${force ? '?fresh=1' : ''}`, { signal: controller.signal });
      if (seq !== requestSeqRef.current) return; // superseded by a newer request
      setMonitors(Array.isArray(data.monitors) ? data.monitors : []);
      setStatus(data.overallMonitorStatus || 'healthy');
      setSyncedAt(data.syncedAt || new Date().toISOString());
      // Static record of the completed audit (rarely changes — only replace
      // when the API actually sent one, so a stale-but-valid record never
      // flashes away between the polls).
      if (data.audit) setAudit(data.audit);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      // An aborted or failed poll must NOT clear the previous verdicts. Turning
      // them into an empty list would let a consumer fall back to its all-clear
      // branch and claim the system is secure on the strength of a request that
      // never arrived.
      setError(
        err?.name === 'AbortError'
          ? 'The security check did not respond in time. It will retry automatically.'
          : err.message || 'Unable to load monitor data.',
      );
    } finally {
      window.clearTimeout(abortTimer);
      inFlightRef.current = false;
      if (seq === requestSeqRef.current) {
        setChecking(false);
        if (force) setSyncing(false);
      }
    }
  }, [adminRequest, active]);

  // Initial load + auto-refresh. The timer restarts after every completed poll
  // so a slow check delays the next one instead of racing it.
  useEffect(() => {
    if (!adminRequest || !active) return undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await sync(false);
      if (!cancelled) timerRef.current = window.setTimeout(tick, MONITOR_POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timerRef.current);
    };
  }, [sync, adminRequest, active]);

  // ── Derived verdicts ──────────────────────────────────────────────────
  // Computed here rather than in either consumer so the Overview card and the
  // Security Center cannot derive different counts from the same response.
  const counts = useMemo(() => countStatuses(monitors), [monitors]);

  const attention = useMemo(() => attentionList(monitors), [monitors]);

  // True until the first response lands. A consumer must render this state
  // explicitly — treating "no rows" as "no problems" is what let the card claim
  // an all-clear before anything had been checked.
  const pending = monitors.length === 0 && !error;

  return {
    monitors,
    status,
    syncedAt,
    audit,
    error,
    syncing,
    checking,
    pending,
    counts,
    attention,
    total: monitors.length,
    sync,
    pollMs: MONITOR_POLL_MS,
  };
}