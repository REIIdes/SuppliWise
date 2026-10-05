// "Has the page scrolled past N pixels?"
//
// This is the whole mechanism behind the navbar's pinned-but-transparent state.
// It is a hook rather than an inline listener for three reasons, all of which
// are the usual ways a scroll effect goes wrong:
//
//   1. It reads the scroll position ONCE PER CROSSING, not once per event. A
//      raw `setState(window.scrollY)` re-renders the whole navbar on every
//      single scroll frame, ~60 times a second, for a value that only ever
//      takes two forms. `setState` with an unchanged boolean bails out of the
//      re-render entirely, so scrolling is free once past the threshold.
//   2. It reads the position during initial state, not only in the effect. The
//      browser restores the scroll offset on a back/forward navigation and on a
//      refresh mid-page, and that restore can land AFTER the first render — a
//      navbar that only measured inside the effect would flash its "at the top"
//      colour over a page that is actually scrolled.
//   3. The listener is `passive`, so it never blocks scrolling waiting on a
//      paint, and it is removed on unmount.
//
// It is deliberately a boolean and not a position or a progress value: every
// consumer wants "top or not top", and exposing more invites a re-render per
// frame.
import { useEffect, useState } from 'react';

/**
 * @param {number} [threshold] pixels of scroll before this reports `true`
 * @returns {boolean} whether the window is scrolled past `threshold`
 */
export function useScrolledPast(threshold = 10) {
  // Lazily initialised so the FIRST render already has the right value — see
  // note 2 above about restored scroll offsets.
  const [past, setPast] = useState(
    () => typeof window !== 'undefined' && window.scrollY > threshold,
  );

  useEffect(() => {
    const read = () => setPast(window.scrollY > threshold);
    // Re-check on mount. The initial state covers a normal load, but a
    // restored offset can land between that render and this effect.
    read();

    window.addEventListener('scroll', read, { passive: true });
    return () => window.removeEventListener('scroll', read);
  }, [threshold]);

  return past;
}

export default useScrolledPast;
