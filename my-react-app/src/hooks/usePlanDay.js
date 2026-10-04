import { useEffect, useState } from 'react';
import { planDayPollDelay, planDayKey, resolveTodayKey } from '../utils/planDay.js';

/**
 * The running plan day, and the moment to refetch when it changes.
 *
 * WHY A HOOK
 * "Today's Supplements" had three independent notions of the current time: this
 * page's 30-second interval, the dashboard's identical copy, and the server's
 * UTC date. The reset happened on none of them, so a page left open across 4 AM
 * kept rendering yesterday's plan — every dose ticked, nothing to do — until the
 * user reloaded by hand. That is the bug this fixes: the rollover has to be an
 * event the app reacts to, not something the user has to trigger.
 *
 * The hook returns the day key the SERVER sent when it has one, and its own
 * reading of the boundary before then. Falling back is safe because both apply
 * the same rule (utils/planDay.js), which is also why the key changing is a
 * reliable signal: it means the boundary was crossed, and the plan behind it is
 * now a different day's.
 *
 * @param {string} [serverKey] `planDay.todayKey` from the last response.
 * @param {(reason: string) => void} onDayChange Called when the day rolls over.
 *   Receives 'reset'. Must be stable (useCallback) or the timer restarts on
 *   every render — which is harmless but wasteful.
 * @param {object} [options]
 * @param {number} [options.enabled=false] When false the hook reports the day
 *   and does no work. Pages with no plan to refresh use it to opt out.
 * @returns {string} YYYY-MM-DD for the plan day currently on screen.
 */
export default function usePlanDay(serverKey, onDayChange, { enabled = false } = {}) {
  // The day the SERVER is on, as soon as it arrives, with the local rule as the
  // fallback for the moment before it does.
  //
  // This is derived state, not stored state. It used to be `useState` seeded once
  // and then overwritten from an effect as soon as `serverKey` changed — the
  // "setState synchronously inside an effect" shape, which costs an extra render
  // pass on every response and can cascade when the parent re-renders in turn.
  // Deriving it means there is one source of truth and no effect to keep in sync.
  //
  // The consequence worth stating: the server's answer wins whenever it exists,
  // so a client whose own clock is wrong (or sits in an odd zone) still shows the
  // right day from the first response, without a reload.
  const [localDayKey, setLocalDayKey] = useState(() => planDayKey(new Date()));
  // `localDayKey` is only consulted when the server has not answered yet. The
  // rollover timer still advances it, because that is what makes the change
  // observable while the request is in flight — the derived value above keeps
  // showing the server's day until a fresh one replaces it.
  const dayKey = enabled ? resolveTodayKey(serverKey, new Date()) : localDayKey;

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;

    /**
     * Re-read the clock, and fire only if the DAY changed.
     *
     * Comparing keys rather than timestamps is what keeps this cheap: the timer
     * wakes up to an hour often, and a wake that finds the same day must not
     * trigger a refetch — otherwise an idle tab would hammer the dashboard API
     * once an hour for the whole time it was open.
     */
    const check = () => {
      if (cancelled) return;
      const current = planDayKey(new Date());
      setLocalDayKey(prev => {
        if (prev === current) return prev;
        onDayChange?.('reset');
        return current;
      });
    };

    const arm = () => {
      const delay = planDayPollDelay(new Date());
      // `setTimeout` hands back a handle, and Node/jsdom number them too, so the
      // identity check is only a guard against an unbounded chain — the real
      // protection against leaks is the `cancelled` flag in the cleanup.
      const handle = setTimeout(() => {
        if (cancelled) return;
        check();
        if (!cancelled) arm();
      }, delay);
      return handle;
    };

    const handle = arm();

    // Wake paths. A laptop asleep across 4 AM must not come back showing
    // yesterday's doses; both of these fire after a sleep, where the timer may
    // have been throttled or skipped entirely.
    const onWake = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);

    return () => {
      cancelled = true;
      clearTimeout(handle);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [enabled, onDayChange]);

  return dayKey;
}