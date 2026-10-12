/**
 * THE APP'S ROUTES, IN ONE PLACE.
 *
 * ── Why this module exists ─────────────────────────────────────────────────
 *
 * Every destination in this app used to be written as a string literal at each
 * call site: `'/pricing'` in the pricing page, `'/profile?view=billing'` in the
 * info columns, `'/login'` in three files, and so on. Two real defects came out
 * of that, and they are the reason this table exists:
 *
 *   1. The pricing page's "Change plan" button pointed at `'/pricing'` — the
 *      very page it is rendered ON. Clicking it re-navigated to the same URL,
 *      the pathname never changed, so ScrollToTop never fired and the button
 *      did literally nothing. A dead link, on the page most likely to be read
 *      by someone deciding what to buy.
 *
 *   2. "See your current plan" and "Manage your plan" pointed at
 *      `/profile?view=billing`, but a visitor who was not signed in was bounced
 *      by ProtectedRoute to `/login` with no return address, so after signing
 *      in they landed on the dashboard — never on the card they asked for.
 *
 * Both are drift between where a button says it goes and where the app can
 * actually take you. A click becomes a no-op the moment the string at the call
 * site and the string in App.jsx disagree, and nothing sees it happen.
 *
 * This module is the single agreement between them: the paths live here once,
 * `routes.test.js` proves every one of them is a real `<Route>` in App.jsx, and
 * the deep-link helpers (profileView, pricingPath) build the URLs a switch OFF
 * would otherwise get wrong.
 *
 * Deliberately plain JS with no React and no `react-router-dom` import: the
 * pricing-copy test imports this module directly under `node --test`, where a
 * router dependency would not resolve.
 */

/**
 * Every static route the app serves, keyed for imports rather than restated as
 * raw strings. Values must match the `<Route path="…">` table in App.jsx
 * exactly — the routes test reads that table out of the file and fails on any
 * mismatch, so a renamed or removed route cannot leave a link pointing at
 * nothing.
 *
 * Dynamic routes (`/verify/:code`, `/share/:token`) are deliberately absent:
 * their parameter comes from the server payload or a generated token at render
 * time, and a parameterised path is a builder's job, not a table entry — the
 * Web3 panels already assemble theirs from the token they just created.
 */
export const ROUTES = {
  home: '/',
  dashboard: '/dashboard',
  recommendations: '/recommendations',
  trackIntake: '/track-intake',
  insights: '/insights',

  login: '/login',
  signup: '/signup',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',

  adminLogin: '/admin/login',
  adminChangePassword: '/admin/change-password',
  admin: '/admin',
  adminAssessmentManagement: '/admin/assessment-management',

  assessment: '/assessment',
  results: '/results',
  history: '/history',
  profile: '/profile',
  support: '/support',

  // `/plans` is a legacy alias that immediately redirects to /pricing. It is
  // listed so the alias is a KNOWN route rather than a mystery string.
  pricing: '/pricing',
  plans: '/plans',

  web3: '/web3',
  marketplace: '/marketplace',
  governance: '/governance',

  verify: '/verify',
};

/**
 * The profile page renders ONE card at a time, chosen by `?view=`. ProfilePage
 * allow-lists the same names (see PROFILE_VIEWS there): an unrecognised value
 * lands on 'personal', never on an empty page.
 *
 * 'billing' is the card the pricing page's links point at; 'accounts' is the
 * one the account menu uses; 'personal' is the default.
 */
export const PROFILE_VIEWS = ['personal', 'security', 'accounts', 'billing'];

/** Where /profile lands when the view param is missing or unrecognised. */
export const DEFAULT_PROFILE_VIEW = 'personal';

/**
 * `/profile?view=…`, validated.
 *
 * The allow-list is what makes this safe to call with anything: a typo, a
 * stale constant or a hostile query string produce `?view=personal` rather
 * than a URL ProfilePage has to guess about. Building the URL in one place
 * also means the `view=` name cannot drift from what ProfilePage reads —
 * a silent fallback to Personal Info is exactly how a "Manage billing" link
 * came to open the wrong card once already.
 */
export function profileView(view) {
  const name = String(view == null ? '' : view).trim().toLowerCase();
  const safe = PROFILE_VIEWS.includes(name) ? name : DEFAULT_PROFILE_VIEW;
  return `${ROUTES.profile}?view=${safe}`;
}

/**
 * `/pricing`, optionally with an in-page anchor.
 *
 * The anchor exists for the pricing page's own "Change plan" link: the reader
 * is already on /pricing when they click it, so the useful destination is the
 * plan grid, not the page. `pricingPath()` with no argument stays the plain
 * page URL for everywhere else.
 *
 * Keeping the anchor inside the module means the hash on the link and the id
 * on the plans dock cannot drift apart — PricingPage renders `id="#plans"`
 * from this same namespace.
 */
export function pricingPath(anchor) {
  const raw = String(anchor == null ? '' : anchor).trim().toLowerCase();
  if (!raw) return ROUTES.pricing;
  return `${ROUTES.pricing}#${encodeURIComponent(raw)}`;
}

/**
 * The in-page anchors the pricing page serves. `pricing-bar` carries this id,
 * and the hash-scroll effect in PricingPage scrolls it into view.
 */
export const PRICING_ANCHORS = {
  /** The sticky dock above the plan cards — the "Plans" section. */
  plans: 'plans',
};
