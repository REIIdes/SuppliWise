/**
 * Overlay registry — lets an open menu tell a floating control to get out of
 * the way.
 *
 * WHY THIS EXISTS
 * ---------------
 * The AI assistant's edge tab (`.chat-edge-toggle`) is `position: fixed` at
 * `z-index: 1000`, parked at `right: 0; top: 50%`. The account menu panel
 * (`.pam-panel`) is anchored to its trigger inside the Navbar, which is
 * `position: sticky; z-index: 100` — a stacking context, so no z-index of the
 * panel's own can escape the Navbar's cap. On phones `mobile-responsive.css`
 * forces that cap up to 1000 instead, which only TIES the tab and hands the
 * decision to DOM order — where the tab, mounted last, still wins. Either way
 * the tab painted straight over the open menu.
 *
 * Raising the panel's z-index cannot fix this (it is trapped), and raising the
 * Navbar above 1000 would put the sticky header over every modal and the
 * pricing sheet. Portalling the panel to <body> would fix the stacking but
 * trades it for manual trigger-rect tracking on every scroll/resize.
 *
 * The cheapest correct answer is also the right behaviour: a floating tab has
 * no business sitting on top of an open menu. It hides itself while one is
 * open and comes back when it closes.
 *
 * This was not only cosmetic — the tab is a real button at z-index 1000, so it
 * also SWALLOWED CLICKS aimed at the menu rows underneath it. On a touch screen
 * the right-hand column of the account menu was simply unclickable.
 *
 * WHY A REGISTRY AND NOT A CUSTOM EVENT
 * ------------------------------------
 * `ChatAssistant` is `lazy()`, so it can mount *after* a menu is already open
 * (navigating with the menu open, or a slow chunk on a cold cache). A DOM event
 * fired once at open time would be missed and the tab would stay visible. The
 * registry keeps the current set, and `subscribe` replays it on attach, so a
 * late subscriber is immediately correct.
 */

// Names are arbitrary but must be stable strings; `overlayRegistry` has no
// import of its consumers, so this stays a plain set of ids.
const open = new Set();
const listeners = new Set();

/** Notify every subscriber (and remember state for the next subscriber). */
function publish() {
  // Copy before iterating: a listener may unsubscribe during the callback.
  [...listeners].forEach((listener) => {
    try {
      listener(open);
    } catch {
      // A broken subscriber must not stop the others from updating.
    }
  });
}

/**
 * Mark an overlay open or closed.
 * @param {string} name stable identifier
 * @param {boolean} isOpen
 */
export function setOverlayOpen(name, isOpen) {
  if (!name) return;
  const wasOpen = open.has(name);
  if (isOpen) open.add(name);
  else open.delete(name);
  // Skip the no-op case so we do not re-render on every unrelated update.
  if (wasOpen === isOpen) return;
  publish();
}

/**
 * Subscribe to overlay changes. The current state is delivered immediately so
 * a late-mounting subscriber is never stale.
 * @returns {() => void} unsubscribe
 */
export function subscribeOverlays(listener) {
  listeners.add(listener);
  try {
    listener(open);
  } catch {
    // ignore
  }
  return () => listeners.delete(listener);
}
