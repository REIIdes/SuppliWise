/**
 * The brand control — what the logo tile and the wordmark actually do when
 * pressed.
 *
 * Run: npm test
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The behaviour is split across two files that cannot see each other: the
 * Navbar decides WHEN to refresh and the Dashboard decides HOW. Nothing but a
 * convention holds them together, and each half is individually reasonable, so
 * the ways this quietly breaks are:
 *
 *   1. The two halves stop agreeing on the event name, and pressing the logo on
 *      the dashboard silently does nothing — the exact bug this feature exists
 *      to fix, and invisible because the link still looks and navigates fine.
 *   2. The Dashboard listens WITHOUT `silent`, so every press swaps the whole
 *      dashboard for a full-screen spinner and back. It still "refreshes", so
 *      it passes a manual check and fails in the hand.
 *   3. The brand reverts to being a bare <div> tile beside a separate wordmark
 *      link: the tile goes dead to clicks again and the control splits into two
 *      tab stops for one destination.
 *
 * These are source-reading assertions, in the same spirit as navbarSurface.test.js
 * and planDayWiring.test.js — there is no DOM in `node --test`, and the failure
 * that matters here is a shape, not a computed style.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');

const NAVBAR = readFileSync(join(HERE, 'Navbar.jsx'), 'utf8');
const DASHBOARD = readFileSync(join(SRC, 'Pages', 'DashboardPage.jsx'), 'utf8');
const REFRESH = readFileSync(join(SRC, 'utils', 'dashboardRefresh.js'), 'utf8');

/** The `<Link …>…</Link>` that wraps the brand cluster. */
function brandLink() {
  const m = NAVBAR.match(/<Link\b[^>]*className="navbar-left"[\s\S]*?<\/Link>/);
  assert.ok(m, 'Navbar.jsx has no <Link className="navbar-left">');
  return m[0];
}

/* ═══════════════════════════════════════════════════════════════════════ */

test('the logo tile and the wordmark are ONE control, and it is a link', () => {
  const link = brandLink();

  // Both live inside the single link, so the whole brand area is the hit area.
  assert.match(link, /className="navbar-logo-box"/, 'the logo tile is not inside the link');
  assert.match(link, /className="navbar-brand"/, 'the wordmark is not inside the link');

  // The tile was a bare <div>, which ignores clicks entirely — that is the
  // regression. If it is a div again, the icon is dead.
  assert.doesNotMatch(
    link,
    /<div[^>]*className="navbar-logo-box"/,
    'the logo tile is a <div> again, so it cannot be clicked',
  );

  // Two stops for one destination was the original complaint, and a link nested
  // inside a link is invalid HTML as well as two stops. Exactly ONE opening tag
  // may appear: the wrapper itself.
  const anchors = link.match(/<(?:a|NavLink|Link)\b/gi) || [];
  assert.equal(anchors.length, 1, `the brand link nests another link: ${anchors.join(' ')}`);

  // NavLink would append an `active` class that no rule matches.
  assert.doesNotMatch(link, /<NavLink\b/, 'the brand uses NavLink, which adds a dead `active` class');

  // Reachable and identifiable by keyboard/AT.
  assert.match(link, /aria-label=/, 'the brand link has no accessible name beyond the wordmark');
});

test('the brand renders no text besides the wordmark', () => {
  // The visible half of the accessible-name decision.
  //
  // The destination is carried by `aria-label`, which is an attribute and paints
  // nothing. It was briefly ALSO a visually-hidden span, and the repo has no
  // `.navbar-sr-only` rule — so "SuppliWise home" rendered as plain visible text
  // beside the wordmark, which is how it reached a screenshot. One name, one
  // mechanism, and this is the assertion that keeps a third box or a stray
  // string out of the bar.
  const link = brandLink();

  // Exactly the tile and the wordmark, nothing else. The opening <Link> tag is
  // dropped first: `brandLink()` starts at it, and it carries className too.
  const inner = link.replace(/^<Link\b[^>]*>/, '');
  const elements = [...inner.matchAll(/<(\w+)\b[^>]*className="([^"]+)"/g)]
    .filter((m) => m[1] !== 'svg' && !/^nav-logo-grad$/.test(m[2]));
  const classes = elements.map((m) => m[2]);
  assert.deepEqual(
    classes,
    ['navbar-logo-box', 'navbar-brand'],
    `the brand link should hold only the tile and the wordmark, found: ${classes.join(', ')}`,
  );

  // The name must not be in the markup as content — only as an attribute.
  assert.doesNotMatch(inner, />\s*SuppliWise home\s*</, 'the accessible name is rendered as visible text');
  assert.doesNotMatch(inner, />\s*Go to dashboard\s*</, 'the accessible name is rendered as visible text');
  assert.doesNotMatch(inner, /sr-only/, 'a visually-hidden span needs a real .sr-only rule; this repo has none');
  assert.doesNotMatch(inner, /\{token\s*\?\s*'Go to dashboard'/, 'the name is rendered as a text child');
});

test('the brand points at the dashboard when signed in, and home when not', () => {
  const link = brandLink();
  assert.match(link, /to=\{token\s*\?\s*DASHBOARD_PATH\s*:\s*'\/'\}/);
  // One constant for both the destination and the "already there?" test — the
  // two must not be allowed to drift.
  assert.match(NAVBAR, /const DASHBOARD_PATH = '\/dashboard';/);
  const uses = NAVBAR.match(/DASHBOARD_PATH/g) || [];
  assert.equal(uses.length, 3, 'DASHBOARD_PATH should be the const plus its two uses');
});

test('pressing the brand on the dashboard scrolls to top and asks for a refresh', () => {
  const handler = NAVBAR.match(/const onBrandActivate[\s\S]*?\n\x20{2}\};/);
  assert.ok(handler, 'Navbar.jsx has no onBrandActivate handler');
  const body = handler[0];

  assert.match(body, /window\.location\.pathname\s*!==\s*DASHBOARD_PATH/);
  // Suppressed rather than re-navigated: navigating to the current path pushes
  // a duplicate history entry, so Back would need two presses to leave.
  assert.match(body, /event\.preventDefault\(\)/);
  assert.match(body, /window\.scrollTo\(0,\s*0\)/);
  assert.match(body, /requestDashboardRefresh\(\)/);
});

test('the route check reads window.location, never the render-time location', () => {
  // The subtle one, and it was a real dead-click bug.
  //
  // React Router's navigate() updates the address bar synchronously, but the
  // `useLocation()` value captured in this render only catches up when React
  // re-renders — and the Navbar is rendered BY the page, so immediately after a
  // navigation this handler can still be holding the previous route. A click in
  // that window read "/dashboard" while the user was on /history, took the
  // refresh branch and called preventDefault(): the brand did nothing at all.
  //
  // `window.location` is already current at the instant of the click, so it
  // cannot be stale.
  const handler = NAVBAR.match(/const onBrandActivate[\s\S]*?\n\x20{2}\};/);
  const body = handler[0];

  assert.doesNotMatch(
    body,
    /(?<!window\.)location\.pathname/,
    'onBrandActivate reads the render-time location, which lags a navigation',
  );
  assert.doesNotMatch(
    body,
    /useLocation/,
    'onBrandActivate must not depend on useLocation at all',
  );
});

test('the navbar and the dashboard agree on the refresh channel', () => {
  // Failure 1: the two halves naming different events. The navbar imports the
  // helper rather than hand-rolling a dispatch, so this is really a guard
  // against someone "simplifying" it into a string literal.
  assert.match(NAVBAR, /import\s*\{[^}]*requestDashboardRefresh[^}]*\}\s*from\s*'\.\.\/\.\.\/utils\/dashboardRefresh'/);
  assert.match(DASHBOARD, /import\s*\{[^}]*subscribeDashboardRefresh[^}]*\}\s*from\s*'\.\.\/utils\/dashboardRefresh'/);

  // And the channel is a single named event, not two literals in two files.
  assert.match(REFRESH, /export const DASHBOARD_REFRESH_EVENT = 'suppliwise:dashboard-refresh';/);
  assert.doesNotMatch(NAVBAR, /suppliwise:dashboard-refresh/, 'the navbar re-declares the event name');
  assert.doesNotMatch(DASHBOARD, /suppliwise:dashboard-refresh/, 'the dashboard re-declares the event name');
});

test('the dashboard refreshes SILENTLY, so the page never blanks', () => {
  // Failure 2, and the one that matters in the hand. `loading` gates a
  // full-screen spinner that replaces every card, so an ordinary refetch here
  // means the entire dashboard flashes away and back on each press.
  // The argument list is `(() => fetchDashboardData({ silent: true }))`, which
  // is two levels of nesting — so the match has to tolerate one level of
  // parentheses inside the call rather than stopping at the arrow's own.
  const listener = DASHBOARD.match(/subscribeDashboardRefresh\((?:[^()]|\([^()]*\))*\)/);
  assert.ok(listener, 'DashboardPage.jsx does not subscribe to refresh requests');
  assert.match(
    listener[0],
    /fetchDashboardData\(\{\s*silent:\s*true\s*\}\)/,
    'the refresh listener must ask for a silent refetch',
  );

  // ...and `silent` has to actually mean something.
  const fetch = DASHBOARD.match(/const fetchDashboardData = useCallback\([\s\S]*?\n\x20{2}\}, \[\]\);/);
  assert.ok(fetch, 'cannot find fetchDashboardData');
  const body = fetch[0];

  assert.match(body, /const silent = options\?\.silent === true && hasContentRef\.current;/);
  assert.match(body, /if \(!silent\) \{\s*setLoading\(true\);/, 'the spinner is raised unconditionally');
  assert.match(body, /if \(!silent\) setLoading\(false\);/, 'the spinner is lowered unconditionally');
  // A failed background refresh must not replace real data with an error page.
  assert.match(body, /if \(!silent\) \{\s*setError\(/, 'a silent failure replaces the dashboard with an error page');

  // The subscription must be torn down, or every navigation to the dashboard
  // leaves another listener attached and one press triggers N refetches.
  assert.match(
    DASHBOARD,
    /useEffect\(\s*\(\)\s*=>\s*subscribeDashboardRefresh\([\s\S]*?\),\s*\[fetchDashboardData\],?\s*\);/,
    'the refresh subscription is not a useEffect returning the unsubscribe',
  );
});

test('the existing refresh paths are untouched', () => {
  // `silent` is opt-in, so the calls that SHOULD show a spinner must not pass
  // it: a first mount and the two retry buttons.
  const calls = DASHBOARD.match(/fetchDashboardData\(([^)]*)\)/g) || [];
  const silentCalls = calls.filter((c) => /silent/.test(c));
  assert.equal(
    silentCalls.length,
    1,
    `exactly one caller may refresh silently, found ${silentCalls.length}: ${silentCalls.join(' ')}`,
  );
});
