// Single reactive source of truth for "who is signed in".
//
// Every write/removal of THIS TAB's session (the sw_tab_* keys below) goes
// through a function in api.js (or at least fires `emitAuthChanged()`), and
// every UI piece that renders signed-in-vs-out state subscribes via
// `useAuth()`. Without this, components that read storage once at render
// time (the navbar, the route guards) keep showing a stale state until a
// full reload — which is exactly how the login page ended up rendering the
// Sign In form under a logged-in navbar.
//
// Session storage layout (see api.js for the full rationale):
//   • sessionStorage `sw_tab_*` — this TAB's session (token/profile/account).
//     Per-tab by spec: Tab 1 can be Account A while Tab 2 is Account B.
//   • localStorage `sw_accounts` — shared DIRECTORY of account metadata
//     (id/email/name only — never credentials).
export const AUTH_CHANGED_EVENT = 'suppliwise:auth-changed';

// Tab-scoped session keys. Defined here (not in api.js) so this module can
// read them without importing api.js — api.js imports US, and cycles around
// module init are how auth state ends up reading `undefined`.
export const TAB_ACCOUNT_KEY = 'sw_tab_account';
export const TAB_TOKEN_KEY = 'sw_tab_token';
export const TAB_USER_KEY = 'sw_tab_user';
export const DIRECTORY_KEY = 'sw_accounts';

// The ADMIN session lives in its own localStorage key (written by AdminLogin,
// read by the admin guards) and is completely separate from the tab's user
// session above. Route guards and the navbar must consult it too: useAuth()
// only sees the user token, so without this a signed-in admin bounces through
// the USER Sign In screen on every user route.
export const ADMIN_TOKEN_KEY = 'adminToken';

export const hasAdminSession = () => {
  try {
    return !!localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return false;
  }
};

// ── "a user session ended in this tab" flag ────────────────────────────────
// Set whenever this tab's user session is torn down (explicit sign-out, 401,
// cross-tab revoke) and cleared when a new session installs here. Route
// guards use it to keep the USER flow and the ADMIN session separate: after
// a user signs out, this tab always returns to the user Sign In screen — an
// adminToken in the browser must never divert it to /admin ("after logged
// out it redirected to the admin session"; also stops Back from bouncing
// into admin). A tab with NO such history that lands on user routes as an
// admin-holder still goes to the admin panel.
const SIGNED_OUT_KEY = 'sw_user_signed_out';

export const markUserSignedOut = () => {
  try { sessionStorage.setItem(SIGNED_OUT_KEY, '1'); } catch { /* best-effort */ }
};

export const clearUserSignedOut = () => {
  try { sessionStorage.removeItem(SIGNED_OUT_KEY); } catch { /* best-effort */ }
};

export const hasUserSignedOut = () => {
  try { return sessionStorage.getItem(SIGNED_OUT_KEY) === '1'; } catch { return false; }
};

// Notify every subscriber that the auth snapshot may have changed.
// Safe to call from plain (non-React) modules such as api.js.
export const emitAuthChanged = () => {
  try {
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
  } catch { /* SSR / no window — nothing to notify */ }
};

// Current snapshot of this tab's session. Parsing is cheap but not free, so
// callers that just need presence checks can use `hasSession()`.
export const readAuthSnapshot = () => {
  let token;
  let user;
  try {
    token = sessionStorage.getItem(TAB_TOKEN_KEY);
    const raw = sessionStorage.getItem(TAB_USER_KEY);
    user = raw ? JSON.parse(raw) : null;
  } catch {
    token = null;
    user = null;
  }
  return { token: token ?? null, user: user ?? null };
};

export const hasSession = () => {
  try {
    return Boolean(sessionStorage.getItem(TAB_TOKEN_KEY));
  } catch {
    return false;
  }
};

// ── Sign-in transition window ───────────────────────────────────────────────
// Writing the token (startSession) emits AUTH_CHANGED_EVENT immediately, but
// the caller (completeLogin / signup submit) may still be deciding where the
// user should land — e.g. awaiting AI recommendations before navigating to
// /results. Without this flag the reactive PublicOnlyRoute would bounce
// /login → /dashboard the moment the token appears, unmounting the page
// mid-flow. Guards skip their "already signed in" redirect while a
// transition is open; closing it re-emits so a sign-in that failed after the
// token was written still gets picked up (never a stuck login form).
let transitionDepth = 0;

export const beginAuthTransition = () => {
  transitionDepth += 1;
};

export const endAuthTransition = () => {
  if (transitionDepth === 0) return;
  transitionDepth -= 1;
  if (transitionDepth === 0) emitAuthChanged();
};

export const isAuthTransitionActive = () => transitionDepth > 0;
