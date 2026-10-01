import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERVIEW_TREND_DAYS,
  OVERVIEW_TREND_OPTIONS,
  trendCeiling,
  normalizeWindow,
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
  distributeShares,
  sparkPath,
  buildSegments,
  buildRankedBars,
  buildFunnel,
  compareWindows,
  rateOf,
  signedPercent,
  dayCountLabel,
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

// ══════════════════════════════════════════════════════════════════════════
// DEEPER ANALYTICS
// ══════════════════════════════════════════════════════════════════════════

test('the range toggle only offers windows the payload can actually fill', () => {
  // An older server omits trendDays; the ceiling must then be the WIDEST option,
  // not 0 — a zero ceiling would leave the toggle with nothing to pick and the
  // chart would claim a window nobody sent.
  assert.equal(trendCeiling(undefined), 30);
  assert.equal(trendCeiling(30), 30);
  assert.equal(trendCeiling(14), 14);
  // A server cannot report a window wider than the panel offers.
  assert.equal(trendCeiling(365), 30);
  assert.equal(trendCeiling(-4), 30);
  assert.equal(trendCeiling('nonsense'), 30);
});

test('a requested window snaps to a real option and never past the ceiling', () => {
  assert.equal(normalizeWindow(7, 30), 7);
  assert.equal(normalizeWindow(14, 30), 14);
  assert.equal(normalizeWindow(30, 30), 30);
  // A ceiling of 14 must not leave a selectable-but-unrenderable 30d button.
  assert.equal(normalizeWindow(30, 14), 14);
  // Unrecognised values (a stale preference, a corrupt one) fall back to the
  // default rather than producing a 3-day or 900-day chart.
  for (const bad of [undefined, null, NaN, 0, -7, 13, 900, {}, '']) {
    assert.equal(normalizeWindow(bad, 30), OVERVIEW_TREND_DAYS, `input: ${String(bad)}`);
  }
  // A numeric string is a legitimate coercion, not corruption — the whole
  // module normalises numbers the same way.
  assert.equal(normalizeWindow('30', 30), 30);
  assert.equal(normalizeWindow('7', 30), 7);
  // Every offered option is one the panel can actually render.
  for (const days of OVERVIEW_TREND_OPTIONS) {
    assert.equal(normalizeWindow(days, 30), days);
  }
});

test('shared percentages always add up to exactly 100', () => {
  // Plain rounding gave three equal segments 33/33/33 — a legend that visibly
  // did not add up next to a full-width strip.
  assert.equal(distributeShares([1, 1, 1]).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(distributeShares([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(distributeShares([1, 1]), [50, 50]);
  assert.deepEqual(distributeShares([1]), [100]);
  assert.deepEqual(distributeShares([3, 1]), [75, 25]);
  // Uneven input keeps the ordering stable: the biggest share never drops below
  // a smaller one purely because of a rounding tie.
  const many = distributeShares([5, 3, 3, 3, 1]);
  assert.equal(many.reduce((a, b) => a + b, 0), 100);
  assert.ok(many[0] > many[4], many.join(','));
});

test('shares survive a missing, empty or malformed series without dividing by zero', () => {
  for (const bad of [undefined, null, [], [0, 0, 0], [-5, 'x', NaN], [{}, null]]) {
    const shares = distributeShares(bad);
    assert.equal(shares.length, (Array.isArray(bad) ? bad : []).length, `input: ${JSON.stringify(bad)}`);
    assert.ok(shares.every(n => Number.isFinite(n) && n >= 0), JSON.stringify(bad));
  }
  assert.deepEqual(distributeShares([0, 0, 0]), [0, 0, 0]);
});

test('the sparkline draws a real path, and nothing at all when there is nothing', () => {
  const drawn = sparkPath(buildTrendSeries([{ _id: '2026-09-28', count: 3 }], 7), { width: 320, height: 96 });
  assert.ok(drawn.line.startsWith('M'), drawn.line);
  assert.ok(drawn.area.endsWith('Z'), drawn.area);
  assert.equal(drawn.points.length, 7);
  assert.equal(drawn.total, 3);
  assert.equal(drawn.max, 3);
  // Every coordinate must be inside the viewBox, or the line is clipped away.
  for (const [x, y] of drawn.points) {
    assert.ok(x >= 0 && x <= 320, `x ${x}`);
    assert.ok(y >= 0 && y <= 96, `y ${y}`);
  }
  // A single data point cannot enclose an area — a zero-height `Z` path renders
  // as nothing, so the area is withheld and the panel draws the dot itself.
  const single = sparkPath([{ count: 4 }], { width: 320, height: 96 });
  assert.ok(single.line.startsWith('M'));
  assert.equal(single.area, '');
  for (const bad of [undefined, null, [], 'nope', 7, {}]) {
    const empty = sparkPath(bad, { width: 320, height: 96 });
    assert.equal(empty.line, '', `input: ${String(bad)}`);
    assert.equal(empty.area, '');
  }
});

test('a flat sparkline sits on the baseline, so no change never looks like a spike', () => {
  const flat = sparkPath([{ count: 0 }, { count: 0 }, { count: 0 }], { width: 320, height: 96 });
  assert.equal(flat.max, 0);
  // With a zero max every y is the baseline — NOT the top of the box, which is
  // what a naive `top - (v/max)*height` produces and what made "nothing
  // happened" render as a peak.
  assert.ok(flat.points.every(([, y]) => y === flat.points[0][1]), JSON.stringify(flat.points));
  assert.ok(flat.points[0][1] > 48, `baseline should be low in the box: ${flat.points[0][1]}`);
});

test('a degenerate sparkline box yields no path rather than a malformed one', () => {
  for (const size of [{ width: 0, height: 96 }, { width: 320, height: 0 }, { width: 1, height: 1 }]) {
    const out = sparkPath([{ count: 1 }, { count: 2 }], size);
    assert.equal(out.line, '', JSON.stringify(size));
  }
});

test('severity strips render in the panel order, not the payload order', () => {
  const segments = buildSegments({ Severe: 4, Low: 10, Moderate: 2 }, ['Low', 'Moderate', 'High', 'Severe']);
  assert.deepEqual(segments.map(part => part.label), ['Low', 'Moderate', 'Severe']);
  assert.equal(segments.reduce((sum, part) => sum + part.pct, 0), 100);
  assert.deepEqual(segments.map(part => part.value), [10, 2, 4]);
  // The best bar is widest, which is what makes the strip a severity read-out
  // rather than three unrelated numbers.
  assert.ok(segments[0].pct > segments[2].pct, JSON.stringify(segments));
  // Distinct colours, so adjacent segments are never confusable.
  assert.equal(new Set(segments.map(part => part.color)).size, segments.length);
});

test('a label the order does not know still renders instead of vanishing', () => {
  // Adding an option to the questionnaire must not silently drop its members'
  // answers from the panel.
  const segments = buildSegments({ Low: 2, 'Brand New Option': 3 }, ['Low', 'Moderate']);
  assert.deepEqual(segments.map(part => part.label).sort(), ['Brand New Option', 'Low']);
  assert.equal(segments.reduce((sum, part) => sum + part.pct, 0), 100);
});

test('a strip with nothing in it is empty, not a full grey bar', () => {
  for (const bad of [undefined, null, {}, 'nope', 7, [1, 2], { Low: 0, High: '' }, { Low: -3 }]) {
    assert.deepEqual(buildSegments(bad, ['Low', 'High']), [], `input: ${JSON.stringify(bad)}`);
  }
});

test('a strip reads the ranked-list shape as well as the map shape', () => {
  // THE BUG THIS GUARDS. The server once sent `diets` as a ranked
  // `[{ label, count }]` list while the other two strips were maps. `Object.keys`
  // on that array yields "0", "1", "2", whose values are objects; `Number({})` is
  // NaN, every count floored to zero, and the diet strip rendered as an EMPTY BAR
  // LABELLED "0 answers" — with nothing thrown anywhere to explain it.
  const fromList = buildSegments(
    [{ label: 'Low', count: 10 }, { label: 'Moderate', count: 6 }, { label: 'High', count: 4 }],
    ['Low', 'Moderate', 'High', 'Severe'],
  );
  assert.deepEqual(fromList.map(part => part.label), ['Low', 'Moderate', 'High']);
  assert.deepEqual(fromList.map(part => part.value), [10, 6, 4]);
  assert.equal(fromList.reduce((sum, part) => sum + part.pct, 0), 100);

  // Both shapes must produce the SAME strip, so which one the server sends
  // cannot change a single pixel.
  const fromMap = buildSegments({ Low: 10, Moderate: 6, High: 4 }, ['Low', 'Moderate', 'High', 'Severe']);
  assert.deepEqual(fromList, fromMap);
  // `value` is accepted as well as `count`, since neither name is more right.
  assert.deepEqual(
    buildSegments([{ label: 'Low', value: 3 }], ['Low']),
    buildSegments({ Low: 3 }, ['Low']),
  );
});

test('a ranked list sorts by size, colours by rank and never mutates its input', () => {
  const input = [
    { label: 'Increase Energy', count: 12 },
    { label: 'Improve Sleep', count: 30 },
    { label: 'Fat Loss', count: 4 },
  ];
  const frozen = JSON.stringify(input);
  const bars = buildRankedBars(input, { limit: 2 });
  assert.deepEqual(bars.map(row => row.label), ['Improve Sleep', 'Increase Energy']);
  // pct is relative to the leader, so the top bar is always full.
  assert.deepEqual(bars.map(row => row.pct), [100, 40]);
  // sharePct is relative to what is SHOWN, so the two visible rows are 100%
  // between them — the legend can say "of the goals listed".
  assert.equal(bars.reduce((sum, row) => sum + row.sharePct, 0), 100);
  assert.equal(JSON.stringify(input), frozen, 'buildRankedBars mutated its input');
});

test('a ranked list drops blanks and zeroes rather than rendering empty rows', () => {
  const bars = buildRankedBars([
    { label: 'Real', count: 3 },
    { label: '   ', count: 9 },
    { label: '', count: 9 },
    { label: 'Zero', count: 0 },
    { label: 'Negative', count: -5 },
    { label: 'Junk' },
  ]);
  assert.deepEqual(bars.map(row => row.label), ['Real']);
  for (const bad of [undefined, null, [], 'nope', 42, {}]) {
    assert.deepEqual(buildRankedBars(bad), [], `input: ${JSON.stringify(bad)}`);
  }
});

test('the funnel measures every stage against the first, so the rows compare', () => {
  const rows = buildFunnel([
    { key: 'registered', label: 'Registered', value: 100 },
    { key: 'assessed', label: 'Took an assessment', value: 60 },
    { key: 'subscribed', label: 'Subscribed', value: 15 },
  ]);
  assert.deepEqual(rows.map(row => row.sharePct), [100, 60, 15]);
  // dropPct is per-step, and null (not 0%) on the first row — there is no
  // previous step to have dropped from.
  assert.equal(rows[0].dropPct, null);
  assert.equal(rows[1].dropPct, 40);
  assert.equal(rows[2].dropPct, 75);
  rows.forEach(row => assert.ok(row.widthPct >= 0 && row.widthPct <= 100, row.widthPct));
});

test('a racy or out-of-order funnel never renders a negative conversion', () => {
  // The two counts are separate queries, so "assessed" can briefly exceed
  // "registered". A negative drop rate would print as "-4% conversion".
  const rows = buildFunnel([
    { key: 'registered', value: 10 },
    { key: 'assessed', value: 14 },
    { key: 'subscribed', value: 2 },
  ]);
  assert.equal(rows[1].dropPct, 0);
  assert.ok(rows.every(row => row.widthPct >= 0));
  // Dividing by a zero first stage must not produce Infinity or NaN anywhere.
  const empty = buildFunnel([{ key: 'registered', value: 0 }, { key: 'assessed', value: 0 }]);
  assert.deepEqual(empty.map(row => row.sharePct), [0, 0]);
  assert.ok(empty.every(row => Number.isFinite(row.widthPct)));
});

test('a missing funnel renders nothing rather than a fabricated row', () => {
  for (const bad of [undefined, null, [], 'nope', 7, {}]) {
    assert.deepEqual(buildFunnel(bad), [], `input: ${JSON.stringify(bad)}`);
  }
  // A stage with no value counts as zero, not as NaN.
  const rows = buildFunnel([{ key: 'a', label: 'A', value: 5 }, { key: 'b', label: 'B' }]);
  assert.equal(rows[1].value, 0);
  assert.equal(rows[1].dropPct, 100);
});

test('the window comparison refuses a percentage when there is no baseline', () => {
  const rising = buildTrendSeries([
    { _id: '2026-09-20', count: 2 },
    { _id: '2026-09-28', count: 5 },
  ], 14);
  const up = compareWindows(rising, { recent: 7, previous: 7 });
  assert.equal(up.recent, 5);
  assert.equal(up.previous, 2);
  assert.equal(up.delta, 3);
  assert.equal(up.pct, 150);
  assert.equal(up.direction, 'up');

  // Growth from nothing has no meaningful percentage: printing ∞% or 100%
  // would invent one.
  const onlyRecent = buildTrendSeries([{ _id: '2026-09-28', count: 4 }], 14);
  const cold = compareWindows(onlyRecent, { recent: 7, previous: 7 });
  assert.equal(cold.previous, 0);
  assert.equal(cold.pct, null);
  assert.equal(cold.delta, 4);
  assert.equal(cold.direction, 'up');

  // Genuinely flat: one signup in the recent 7 days, one in the 7 before, so
  // the two windows match exactly. (A single day makes recent 1 / previous 0,
  // which is a rise, not a flat line.)
  const flat = compareWindows(
    buildTrendSeries([{ _id: '2026-09-28', count: 1 }, { _id: '2026-09-20', count: 1 }], 14),
    { recent: 7, previous: 7 },
  );
  assert.equal(flat.recent, 1);
  assert.equal(flat.previous, 1);
  assert.equal(flat.delta, 0);
  assert.equal(flat.pct, 0);
  assert.equal(flat.direction, 'flat');
  for (const bad of [undefined, null, [], 'nope', 7]) {
    const out = compareWindows(bad);
    assert.equal(out.recent, 0, `input: ${String(bad)}`);
    assert.equal(out.pct, null);
  }
});

test('a per-member rate is a string, so it can never print NaN', () => {
  assert.equal(rateOf(10, 4), '2.5');
  assert.equal(rateOf(10, 4, 2), '2.50');
  assert.equal(rateOf(3, 3, 0), '1');
  // A real denominator with no numerator is a genuine 0, not a missing rate.
  assert.equal(rateOf(0, 4), '0.0');
  // Nobody to divide by reads as an em dash, not "NaN assessments per member".
  for (const bad of [[0, 0], [5, 0], [undefined, undefined], ['x', 'y'], [3, null]]) {
    assert.equal(rateOf(bad[0], bad[1]), '—', JSON.stringify(bad));
  }
});

test('a signed percentage never claims a change that did not happen', () => {
  assert.equal(signedPercent(12), '+12%');
  assert.equal(signedPercent(-8), '−8%');
  // Zero carries no sign: "+0%" asserts a movement that never happened.
  assert.equal(signedPercent(0), '0%');
  for (const bad of [undefined, null, NaN, 'x', Infinity]) {
    assert.equal(signedPercent(bad), '0%', `input: ${String(bad)}`);
  }
});

test('day counts are pluralised from the number, never from a guess', () => {
  assert.equal(dayCountLabel(0), '0 days');
  assert.equal(dayCountLabel(1), '1 day');
  assert.equal(dayCountLabel(2), '2 days');
  assert.equal(dayCountLabel(1240), '1,240 days');
  for (const bad of [undefined, null, NaN, -3, 'x']) {
    assert.equal(dayCountLabel(bad), '0 days', `input: ${String(bad)}`);
  }
  // The renewal panel has its own nouns, and they have to survive too.
  assert.equal(dayCountLabel(1, 'window', 'windows'), '1 window');
  assert.equal(dayCountLabel(5, 'window', 'windows'), '5 windows');
});

