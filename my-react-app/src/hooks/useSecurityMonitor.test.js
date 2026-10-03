/**
 * Regression tests for the Overview "Threat notifications" card ↔ Security tab
 * connection.
 *
 * Two distinct bugs are covered here, both of which made the card look fine
 * while telling the admin something untrue:
 *
 *  1. THE CARD COULD NOT REACH THE TAB. The "Open security center" button
 *     rendered only inside the failures branch, so on the exact state the card
 *     advertises — all clear — it was a dead end with no way to inspect the
 *     45 probes behind the claim.
 *
 *  2. THE CARD DID NOT DESCRIBE THE TAB. It read `overview.notifications`,
 *     which the server derives from `securityChecks()` (five env-var checks),
 *     while the Security tab renders `GET /admin/security/monitor` (45 live
 *     probes). Those sets barely overlap, so the card could report "All
 *     systems secure" on a dashboard where the Security Center it linked to
 *     was showing critical monitors.
 *
 * The wiring itself (which component fetches, what is passed where) cannot be
 * exercised without a DOM, so it is asserted against the component source —
 * the same technique securityStatusView.test.js uses for the monitor tables.
 * The severity maths below is imported and tested for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  countStatuses, attentionList, MONITOR_POLL_MS,
} from './useSecurityMonitor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(HERE, ...parts), 'utf8');

// ── Severity maths ─────────────────────────────────────────────────────

const row = (key, status) => ({ key, label: key, status, detail: `${key} detail` });

test('countStatuses tallies every status the monitor can report', () => {
  const counts = countStatuses([
    row('a', 'healthy'), row('b', 'healthy'), row('c', 'warning'),
    row('d', 'critical'), row('e', 'error'),
  ]);
  assert.equal(counts.healthy, 2);
  assert.equal(counts.warning, 1);
  assert.equal(counts.critical, 1);
  assert.equal(counts.error, 1);
  // The total must equal the row count, or the Security Center's summary tiles
  // disagree with its own table.
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 5);
});

test('a row with no status counts as loading rather than vanishing', () => {
  // Dropping it would make the totals read "5 of 5" on a 6-row table, which is
  // how a monitor silently disappears from the picture.
  const counts = countStatuses([row('a', 'healthy'), { key: 'b' }, null, undefined]);
  assert.equal(counts.loading, 3);
  assert.equal(counts.healthy, 1);
});

test('countStatuses survives a missing or non-array payload', () => {
  for (const bad of [undefined, null, 'nope', 42, {}]) {
    assert.deepEqual(countStatuses(bad), {});
  }
});

test('attentionList returns worst-first and excludes healthy rows', () => {
  const list = attentionList([
    row('w', 'warning'), row('h', 'healthy'), row('c', 'critical'),
    row('e', 'error'), row('h2', 'healthy'),
  ]);
  assert.deepEqual(list.map(m => m.key), ['c', 'e', 'w']);
});

test('attentionList is stable across polls, so the card does not reshuffle', () => {
  // Two warnings in the same order must come back in the same order, or the
  // card's rows appear to jump on every 30 s poll.
  const rows = [row('w1', 'warning'), row('w2', 'warning')];
  assert.deepEqual(attentionList(rows).map(m => m.key), ['w1', 'w2']);
  assert.deepEqual(attentionList(rows).map(m => m.key), ['w1', 'w2']);
});

test('attentionList does not mutate the shared poll result', () => {
  // It sorts in place by nature; sorting the array the hook holds would reorder
  // the Security Center's own table as a side effect of rendering the card.
  const rows = [row('w', 'warning'), row('c', 'critical')];
  const before = rows.map(m => m.key);
  attentionList(rows);
  assert.deepEqual(rows.map(m => m.key), before);
});

test('a fully healthy system has nothing needing attention', () => {
  const rows = Array.from({ length: 45 }, (_, i) => row(`m${i}`, 'healthy'));
  assert.deepEqual(attentionList(rows), []);
  assert.equal(countStatuses(rows).healthy, 45);
});

test('the poll cadence is a single exported constant', () => {
  // Both surfaces used to hold their own copy of the cadence; two schedules is
  // two chances for the card and the tab to disagree about how fresh they are.
  assert.equal(MONITOR_POLL_MS, 30000);
  const status = read('..', 'Components', 'SecurityStatus', 'SecurityStatus.jsx');
  assert.match(status, /import \{ MONITOR_POLL_MS \} from '\.\.\/\.\.\/hooks\/useSecurityMonitor'/);
  assert.doesNotMatch(status, /const MONITOR_POLL_MS\s*=/);
});

// ── Bug 1: the card was a dead end in its own all-clear state ──────────

test('every branch of the threat card offers a route into the Security tab', () => {
  const src = read('..', 'Pages', 'AdminDashboard.jsx');
  // Isolate the card so a button elsewhere on the dashboard cannot satisfy this.
  const start = src.indexOf('{/* Threat notifications');
  assert.ok(start !== -1, 'the Threat notifications panel was not found');
  const card = src.slice(start, src.indexOf('</section>', start));

  // One per terminal state: all-clear, monitor-error, and threats.
  const links = card.match(/onOpenSecurity\(\)/g) || [];
  assert.ok(
    links.length >= 3,
    `the card offers only ${links.length} route(s) into the Security tab; every state needs one, or the card is a dead end`,
  );
  // And the all-clear state — the one the bug was reported from — has one.
  const allClear = card.slice(card.indexOf('All systems secure'));
  assert.ok(
    /onOpenSecurity\(\)/.test(allClear),
    'the all-clear state has no link to the Security Center, so an admin cannot verify the claim it just made',
  );
  // The threats state deep-links each row to its own monitor as well.
  assert.match(card, /onOpenSecurity\(note\?\.key \|\| null\)/);
});

test('the card no longer offers a Security route only when checks are failing', () => {
  const src = read('..', 'Pages', 'AdminDashboard.jsx');
  // The original bug was the inverse conditional: the button existed only
  // inside the branch that renders when `notifications.length > 0`.
  const card = src.slice(src.indexOf('{/* Threat notifications'), src.indexOf('</section>', src.indexOf('{/* Threat notifications')));
  assert.doesNotMatch(card, /notifications\.length\s*>\s*0\s*&&/);
});

// ── Bug 2: the card described a different endpoint than the tab ─────────

test('SecurityStatus issues no monitor request of its own', () => {
  // React cannot skip a hook call, so any fetch left in this component would run
  // the 45 probes a second time on every dashboard render — the duplicate
  // traffic the shared hook exists to remove, and a second source of truth.
  const src = read('..', 'Components', 'SecurityStatus', 'SecurityStatus.jsx');
  assert.doesNotMatch(src, /\/security\/monitor/);
  assert.doesNotMatch(src, /useSecurityMonitor\(/);
  assert.doesNotMatch(src, /adminRequest/);
});

test('SecurityStatus reports a missing monitor as "checking", never "healthy"', () => {
  // A component handed no prop must not render an all-clear it never received.
  const src = read('..', 'Components', 'SecurityStatus', 'SecurityStatus.jsx');
  const block = src.slice(src.indexOf('const EMPTY_MONITOR'), src.indexOf('const SecurityStatus ='));
  assert.match(block, /status:\s*'loading'/);
  assert.doesNotMatch(block, /status:\s*'healthy'/);
});

test('both surfaces are handed the same monitor object', () => {
  const src = read('..', 'Pages', 'AdminDashboard.jsx');
  // One fetch, two consumers. If either call site stopped passing `monitor`, the
  // card and the tab would go back to answering from two endpoints.
  assert.match(src, /const monitor = useSecurityMonitor\(request, tab === 'overview' \|\| tab === 'security'\)/);
  assert.match(src, /<Overview[^>]*monitor=\{monitor\}/);
  assert.match(src, /<SecurityStatus[^>]*monitor=\{monitor\}/);
});

test('the card does not read the static check list as its verdict', () => {
  const src = read('..', 'Pages', 'AdminDashboard.jsx');
  const start = src.indexOf('{/* Threat notifications');
  const card = src.slice(start, src.indexOf('</section>', start));
  assert.doesNotMatch(
    card,
    /overview\??\.notifications|notifications\.length/,
    'the card is back on the static env checks, which is what let it contradict the Security tab',
  );
});

// ── Bug 3: an absent verdict was reported as an all-clear ──────────────

test('no verdict and a failed check are distinct from "all secure"', () => {
  const src = read('..', 'Pages', 'AdminDashboard.jsx');
  const start = src.indexOf('{/* Threat notifications');
  const card = src.slice(start, src.indexOf('</section>', start));

  // Each of these must be its own rendered state.
  assert.match(card, /monitorPending/, 'the card has no "still checking" state');
  assert.match(card, /monitorError/, 'the card has no "check failed" state');
  assert.match(card, /Checking security controls…/);
  assert.match(card, /Security checks could not run/);
  // The all-clear claim is reachable only once there is a real verdict to back
  // it, and it shows the tally that backs it.
  assert.match(card, /ov-threat-tally/);
  assert.match(card, /monitorTotal/);
  // …and it is reached by checking `attention.length`, never by the absence of
  // rows, which is what made a dropped poll read as "all secure".
  assert.match(card, /:\s*monitorPending\s*\?/);
  assert.match(card, /:\s*monitorError\s*\?/);
});

test('the hook keeps the previous verdicts when a poll fails', () => {
  // If a failed request cleared the rows, the card would fall back to its
  // all-clear branch and report the platform as secure on the strength of a
  // request that never arrived.
  const src = readFileSync(join(HERE, 'useSecurityMonitor.js'), 'utf8');
  const catchBlock = src.slice(src.indexOf('} catch (err) {'), src.indexOf('} finally {'));
  assert.doesNotMatch(catchBlock, /setMonitors\s*\(/);
  assert.doesNotMatch(catchBlock, /setStatus\s*\(/);
  assert.match(catchBlock, /setError\s*\(/);
});

test('the hook exposes a pending flag distinct from an empty verdict', () => {
  const src = readFileSync(join(HERE, 'useSecurityMonitor.js'), 'utf8');
  assert.match(src, /const pending = monitors\.length === 0 && !error;/);
  assert.match(src, /pending,/);
});

// ── Deep link ──────────────────────────────────────────────────────────

test('clicking a threat deep-links to that monitor instead of the bare tab', () => {
  const src = read('..', 'Pages', 'AdminDashboard.jsx');
  const card = src.slice(src.indexOf('{/* Threat notifications'), src.indexOf('</section>', src.indexOf('{/* Threat notifications')));
  // Each row carries the monitor's own key through to the tab.
  assert.match(card, /onClick=\{\(\) => onOpenSecurity\(note\?\.key \|\| null\)\}/);
});

test('a sidebar visit cancels a stale deep-link focus', () => {
  // Otherwise an admin who deep-linked to one monitor, visited Users, then came
  // back via the sidebar would land on a Security Center still filtered to that
  // one monitor with no visible cause.
  const src = read('..', 'Pages', 'AdminDashboard.jsx');
  const handler = src.slice(src.indexOf('const handleTabClick'), src.indexOf('const TAB_LABEL'));
  assert.match(handler, /clearMonitorFocus\(\)/);
});

test('SecurityStatus clears filters before revealing a deep-linked row', () => {
  // A search term or status chip left over from the previous visit would hide the
  // very row the link pointed at, and the scroll would silently do nothing.
  const src = read('..', 'Components', 'SecurityStatus', 'SecurityStatus.jsx');
  assert.match(src, /if \(focusMonitorKey && appliedFocusKey !== focusMonitorKey\)/);
  assert.match(src, /setQuery\(''\)/);
  assert.match(src, /setStatusFilter\('all'\)/);
  assert.match(src, /setFrameworkFilter\('all'\)/);
  assert.match(src, /scrollIntoView/);
});