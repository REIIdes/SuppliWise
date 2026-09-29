import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERVIEW_TREND_DAYS,
  formatMetricValue,
  formatCount,
  shareOf,
  dayParts,
  buildTrendSeries,
  axisTicks,
  initialsOf,
  displayNameOf,
  buildPlanMix,
  donutBackground,
} from './adminOverview.js';

const LABELS = { free: 'FREE', monthly: 'DELUXE', annual: 'PREMIUM', custom: 'ULTIMATE' };

test('metric values group digits and abbreviate only when they overflow', () => {
  assert.equal(formatMetricValue(0), '0');
  assert.equal(formatMetricValue(1), '1');
  assert.equal(formatMetricValue(1234), '1,234');
  assert.equal(formatMetricValue(99999), '99,999');
  assert.equal(formatMetricValue(123456), '123k');
});

test('a missing or unparseable metric reads as 0, never NaN or blank', () => {
  for (const bad of [undefined, null, '', 'abc', NaN, Infinity, {}, []]) {
    assert.equal(formatMetricValue(bad), '0', `input: ${String(bad)}`);
    assert.equal(formatCount(bad), '0', `input: ${String(bad)}`);
  }
});

test('supporting counts abbreviate past a thousand', () => {
  assert.equal(formatCount(24), '24');
  assert.equal(formatCount(1240), '1.2k');
  assert.equal(formatCount(24000), '24k');
  assert.equal(formatCount(-1240), '-1.2k');
});

test('a share with nobody to divide by says so instead of reading 0%', () => {
  // "0% of members" would claim nobody upgraded, when in fact nobody exists.
  assert.equal(shareOf(3, 0), 'No members yet');
  assert.equal(shareOf(0, 0), 'No members yet');
  assert.equal(shareOf(1, 4), '25% of members');
  assert.equal(shareOf(1, 3), '33% of members');
  assert.equal(shareOf(2, 3), '67% of members');
  assert.equal(shareOf(undefined, undefined), 'No members yet');
});

test('day keys parse as UTC, so a column cannot shift by a day', () => {
  const parts = dayParts('2026-09-28');
  assert.equal(parts.number, '28');
  assert.equal(parts.month, 'Sep');
  assert.ok(parts.full.includes('Sep 28'));
});

test('a malformed day key yields blanks instead of "Invalid Date"', () => {
  for (const bad of [undefined, null, '', 'today', '2026-13-45', '28-09-2026', 20260928, {}]) {
    const parts = dayParts(bad);
    assert.deepEqual(parts, { number: '', month: '', full: '' }, `input: ${String(bad)}`);
  }
});

test('sparse day buckets are densified into the full window', () => {
  // The server groups only days that HAVE rows, so three days of data used to
  // render as three bars under a "14 days" badge.
  const series = buildTrendSeries([
    { _id: '2026-09-16', count: 2 },
    { _id: '2026-09-28', count: 5 },
  ]);
  assert.equal(series.length, OVERVIEW_TREND_DAYS);
  assert.equal(series[0].key, '2026-09-15');
  assert.equal(series[series.length - 1].key, '2026-09-28');
  assert.equal(series.reduce((sum, day) => sum + day.count, 0), 7);
  // Only the two days the server actually sent carry a value.
  assert.equal(series.filter(day => day.count > 0).length, 2);
});

test('the window ends on the newest day present, so stale data stays visible', () => {
  const series = buildTrendSeries([{ _id: '2026-01-05', count: 1 }]);
  // The window is a full 14 days ending on the newest bucket that exists, so
  // the only real day lands on the LAST column, not the first.
  assert.equal(series.length, OVERVIEW_TREND_DAYS);
  assert.equal(series[series.length - 1].key, '2026-01-05');
  assert.equal(series[0].key, '2025-12-23');
  assert.equal(series.filter(day => day.count > 0).length, 1);
  assert.equal(series.reduce((sum, day) => sum + day.count, 0), 1);
});

test('the series spans a month boundary without drifting', () => {
  const series = buildTrendSeries([{ _id: '2026-03-02', count: 4 }]);
  assert.equal(series.length, OVERVIEW_TREND_DAYS);
  assert.equal(series[0].key, '2026-02-17');
  assert.equal(series[series.length - 1].key, '2026-03-02');
  // Every key must round-trip: no "2026-02-30" from a naive +N-days walk.
  series.forEach(day => assert.ok(dayParts(day.key).full.length > 0, day.key));
});

test('a trend that is missing, empty or entirely malformed yields no chart', () => {
  for (const bad of [undefined, null, [], 'nope', 42, [{ _id: 'today', count: 3 }], [{}, { _id: '' }]]) {
    assert.deepEqual(buildTrendSeries(bad), [], `input: ${JSON.stringify(bad)}`);
  }
});

test('negative and non-numeric counts are floored at zero, not rendered as bars', () => {
  const series = buildTrendSeries([{ _id: '2026-05-10', count: -4 }, { _id: '2026-05-11', count: 'x' }]);
  assert.equal(series.reduce((sum, day) => sum + day.count, 0), 0);
  assert.ok(series.every(day => day.count >= 0));
});

test('duplicate day buckets are summed rather than overwriting each other', () => {
  const series = buildTrendSeries([
    { _id: '2026-07-04', count: 2 },
    { _id: '2026-07-04', count: 3 },
  ]);
  assert.equal(series.find(day => day.key === '2026-07-04').count, 5);
});

test('a single-assessment week is not labelled as a five-figure total', () => {
  assert.equal(formatMetricValue(buildTrendSeries([{ _id: '2026-06-01', count: 1 }])
    .reduce((sum, day) => sum + day.count, 0)), '1');
});

test('the axis drops the midpoint when a max of 1 has none to show', () => {
  // "1 / 1 / 0" claimed two different heights were the same value.
  assert.deepEqual(axisTicks(1), [1, 0]);
  assert.deepEqual(axisTicks(0), [0, 0]);
  assert.deepEqual(axisTicks(2), [2, 1, 0]);
  assert.deepEqual(axisTicks(7), [7, 4, 0]);
  assert.deepEqual(axisTicks(40), [40, 20, 0]);
});

test('initials are derived safely from any name shape', () => {
  assert.equal(initialsOf('Janrich Userverb'), 'JU');
  assert.equal(initialsOf('  Ada  Lovelace  '), 'AL');
  assert.equal(initialsOf('Prince'), 'PR');
  assert.equal(initialsOf('X'), 'X');
  assert.equal(initialsOf(''), '?');
  assert.equal(initialsOf('   '), '?');
  assert.equal(initialsOf(undefined), '?');
});

test('a row with no name falls back rather than printing "undefined"', () => {
  assert.equal(displayNameOf({ firstName: 'Ada', lastName: 'Lovelace' }), 'Ada Lovelace');
  assert.equal(displayNameOf({ firstName: 'Ada' }), 'Ada');
  assert.equal(displayNameOf({ email: 'a@b.com' }), 'a@b.com');
  assert.equal(displayNameOf({ firstName: '', lastName: null, email: 'a@b.com' }), 'a@b.com');
  assert.equal(displayNameOf({}), 'Unnamed member');
  assert.equal(displayNameOf(undefined), 'Unnamed member');
});

test('the free tier is derived from the member count, so the bar can move', () => {
  // The server's breakdown never contains free plans, so reading plans.free
  // produced a permanently empty row.
  const { rows, total } = buildPlanMix({ free: 0, monthly: 2, annual: 1, custom: 1 }, 10, LABELS);
  assert.equal(total, 10);
  const byKey = Object.fromEntries(rows.map(row => [row.key, row.value]));
  assert.deepEqual(byKey, { free: 6, monthly: 2, annual: 1, custom: 1 });
  assert.equal(rows.reduce((sum, row) => sum + row.value, 0), total);
});

test('the four plan rows always sum to the donut total', () => {
  const cases = [
    [{ free: 0, monthly: 0, annual: 0, custom: 0 }, 0],
    [{ free: 0, monthly: 0, annual: 0, custom: 0 }, 1],
    [{ free: 0, monthly: 3, annual: 0, custom: 0 }, 3],
    [{ free: 0, monthly: 1, annual: 1, custom: 1 }, 9],
    // Breakdown ahead of the member count (the two are separate queries).
    [{ free: 0, monthly: 5, annual: 5, custom: 5 }, 2],
  ];
  for (const [breakdown, users] of cases) {
    const { rows, total } = buildPlanMix(breakdown, users, LABELS);
    assert.equal(rows.reduce((sum, row) => sum + row.value, 0), total, JSON.stringify({ breakdown, users }));
    assert.ok(total >= 0);
  }
});

test('plan rows carry their label from the shared plan registry', () => {
  const { rows } = buildPlanMix({}, 5, LABELS);
  assert.deepEqual(rows.map(row => row.label), ['FREE', 'DELUXE', 'PREMIUM', 'ULTIMATE']);
});

test('a missing breakdown does not throw', () => {
  for (const bad of [undefined, null, 'nope', 7]) {
    const { rows, total } = buildPlanMix(bad, 0, LABELS);
    assert.equal(rows.length, 4);
    assert.equal(total, 0);
  }
});

test('the donut only paints slices that exist', () => {
  // A single monthly member paints the monthly slice (indigo), not the custom
  // one: the free slice is derived as total - paid, so it collapses to 0 here
  // and must not appear in the gradient.
  assert.equal(
    donutBackground(buildPlanMix({ monthly: 1 }, 1, LABELS).rows, 1),
    'conic-gradient(#6366f1 0.00% 100.00%)',
  );
  const mixed = donutBackground(buildPlanMix({ monthly: 1, custom: 1 }, 2, LABELS).rows, 2);
  assert.ok(mixed.includes('#6366f1 0.00% 50.00%'), mixed);
  assert.ok(mixed.includes('#10b981 50.00% 100.00%'), mixed);
});

test('an all-zero mix yields a neutral ring, not a dropped declaration', () => {
  // conic-gradient() with no arguments is invalid CSS: the browser discards it
  // and the donut renders as a transparent hole on a fresh install.
  assert.equal(donutBackground([], 0), 'conic-gradient(#e2e8f0 0% 100%)');
  assert.equal(donutBackground(buildPlanMix({}, 0, LABELS).rows, 0), 'conic-gradient(#e2e8f0 0% 100%)');
});
