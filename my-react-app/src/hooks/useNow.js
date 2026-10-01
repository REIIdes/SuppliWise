import { useEffect, useState } from 'react';

/**
 * The current time, kept fresh.
 *
 * WHY THIS IS A HOOK AND NOT A `useState(new Date())`
 * Three pages judge the user's time windows against the clock, and each one
 * originally grew its own copy of the same 30-second interval plus a focus and
 * visibility listener. That is three places to forget the wake handler — and the
 * wake handler is the one that matters: a laptop that sleeps across a window
 * boundary must not come back showing a stale, unlocked section.
 *
 * The interval is only a safety net for a page left open and idle. Boundaries
 * land on the hour and half-hour, so the worst case is half a minute of lag on
 * a change that is already due, and nothing is lost by being late to *hide* a
 * window.
 *
 * @param {number} [intervalMs] Poll interval. Tests and read-only views pass 0
 *   to opt out of the timer entirely and get a single frozen reading.
 */
export default function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!intervalMs) return undefined;

    const tick = () => setNow(new Date());
    const interval = setInterval(tick, intervalMs);

    // Wake paths: the tab becomes visible again, or the window regains focus.
    // Both fire after a sleep, where the interval timer may have been throttled
    // or skipped entirely.
    const onWake = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', tick);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', tick);
    };
  }, [intervalMs]);

  return now;
}
