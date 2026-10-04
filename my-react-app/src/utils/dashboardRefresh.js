/**
 * Dashboard refresh — the Navbar's brand control asking the dashboard to reload.
 *
 * WHY THIS EXISTS
 * ---------------
 * The brand mark in the top bar is the app's "take me to my dashboard"
 * control. Pressing it while ALREADY on the dashboard has to do something too,
 * and that something is not a navigation: React Router will not re-navigate to
 * the route you are already on, so a plain <Link> pressed there does nothing
 * at all — which is precisely the moment the user is asking for a refresh.
 *
 * So the two cases are split by destination rather than by navigation:
 *
 *   elsewhere  → the link navigates. App.jsx's ScrollToTop scrolls to the top
 *                on the route change and DashboardPage fetches on mount, so
 *                there is nothing to coordinate here.
 *   /dashboard → the click is handled in place: scroll to the top, and ask the
 *                page to refetch. No navigation, no remount, no spinner.
 *
 * A window EVENT rather than a shared ref or context, matching the existing
 * `suppliwise:subscription` / `suppliwise:auth-changed` convention: the Navbar
 * and the Dashboard are siblings with no common owner, and the Navbar must keep
 * working when the dashboard is not mounted at all.
 *
 * WHY THIS DOES NOT REPLAY (unlike utils/overlayRegistry.js)
 * ----------------------------------------------------------
 * The overlay registry replays its current state to a late subscriber, because
 * "a menu is open" is a standing fact a latecomer must know. A refresh request
 * is an IMPULSE, not a state: replaying it would make a dashboard that mounted
 * after the click refetch a second time, on top of the fetch it already does on
 * mount. Fire-and-forget, and a listener attached later is correctly unaffected.
 */
export const DASHBOARD_REFRESH_EVENT = 'suppliwise:dashboard-refresh';

/**
 * Ask any mounted dashboard to refetch. A no-op when nothing is listening, so
 * the caller never has to know whether the dashboard is on screen.
 * @param {unknown} [detail] passed through to subscribers
 */
export function requestDashboardRefresh(detail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DASHBOARD_REFRESH_EVENT, { detail }));
}

/**
 * Listen for refresh requests.
 * @param {(detail: unknown) => void} handler
 * @returns {() => void} unsubscribe
 */
export function subscribeDashboardRefresh(handler) {
  // Server/SSR safety: this module is imported by the Navbar unconditionally.
  if (typeof window === 'undefined') return () => {};
  const listener = (event) => handler(event.detail);
  window.addEventListener(DASHBOARD_REFRESH_EVENT, listener);
  return () => window.removeEventListener(DASHBOARD_REFRESH_EVENT, listener);
}
