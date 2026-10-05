/**
 * Pure presentation helpers for the admin Overview tab.
 *
 * WHY A SEPARATE MODULE
 * Every function here is total: given any input — including `undefined`, a
 * half-filled response, a negative count, a malformed date key — it returns a
 * renderable value and never throws. That guarantee is the whole reason these
 * live outside AdminDashboard.jsx: they can be tested directly against the
 * payloads the API can actually produce, instead of only being exercised when a
 * panel happens to render.
 *
 * The Overview reads straight off `GET /admin/overview`, an endpoint assembled
 * from nine parallel queries. Any one of its keys can be absent, so nothing in
 * the panel is allowed to assume a shape.
 */

/** Days in the assessment-activity window. Matches the server's $limit. */
export const OVERVIEW_TREND_DAYS = 14;

/**
 * Windows the Overview's trend charts can be read over.
 *
 * The server returns the WIDEST window once (`trendDays`, 30 buckets) and the
 * client densifies down to whichever of these is selected. Sending three
 * separate series instead would have meant three server aggregations for the
 * same documents, and the numbers would have disagreed the moment a signup
 * landed between the queries.
 */
export const OVERVIEW_TREND_OPTIONS = [7, 14, 30];

/**
 * The widest window the payload can actually fill.
 *
 * Falls back to the default when the server omits `trendDays` (an older
 * deployment mid-rollout), so a missing field widens the ceiling rather than
 * shrinking it to zero and rendering an empty chart.
 */
export function trendCeiling(available) {
  const n = Number(available);
  const widest = Math.max(OVERVIEW_TREND_DAYS, ...OVERVIEW_TREND_OPTIONS);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), widest) : widest;
}

/**
 * Snap a requested window to one the panel offers, and never past the ceiling.
 *
 * Anything unrecognised (an old bookmark, a corrupt persisted preference) lands
 * on the default rather than producing a 3-day or 900-day chart.
 *
 * @param {unknown} days
 * @param {number} [available] buckets the payload can actually fill
 * @returns {number}
 */
export function normalizeWindow(days, available) {
  const ceiling = trendCeiling(available);
  const wanted = Math.round(Number(days));
  if (!Number.isFinite(wanted) || !OVERVIEW_TREND_OPTIONS.includes(wanted)) return OVERVIEW_TREND_DAYS;
  return Math.min(wanted, ceiling);
}

const DAY_MS = 86400000;

/**
 * Hero metric value: grouped digits up to six figures, abbreviated past that so
 * a runaway count can never widen a card out of its grid track.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatMetricValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 100000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString();
}

/**
 * Compact count for supporting text: 1240 → "1.2k", 24 → "24".
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1000) return `${Math.round(n / 100) / 10}k`;
  return n.toLocaleString();
}

/**
 * "63% of members" — or an honest empty read-out when there is nobody to divide
 * by, instead of a confident NaN% or a 0% that reads as "nobody upgraded".
 *
 * @param {unknown} part
 * @param {unknown} whole
 * @returns {string}
 */
export function shareOf(part, whole) {
  const p = Number(part) || 0;
  const w = Number(whole) || 0;
  if (w <= 0) return 'No members yet';
  return `${Math.round((p / w) * 100)}% of members`;
}

/**
 * "2026-09-28" → { number: '28', month: 'Sep', full: 'Mon, Sep 28' }.
 *
 * The key is parsed as an explicit UTC midnight rather than through
 * `new Date(value)`, which would read a bare "YYYY-MM-DD" as UTC but a local
 * Date as local time and shift the column by a day west of Greenwich.
 * Anything unparseable yields blanks — never "Invalid Date" in the UI.
 *
 * @param {unknown} key
 * @returns {{ number: string, month: string, full: string }}
 */
export function dayParts(key) {
  const blank = { number: '', month: '', full: '' };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!match) return blank;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return blank;
  return {
    number: String(Number(match[3])),
    month: date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
    full: date.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
    }),
  };
}

/**
 * Densify the server's day buckets into a gap-free series.
 *
 * GET /admin/overview builds `assessmentTrend` with a Mongo `$group`, which
 * emits only the days that HAVE rows. A quiet fortnight therefore arrived as
 * three bars under a "14 days" badge — the chart silently lied about its own
 * window, and the daily average it implied was wrong. This walks back `days`
 * days from the newest bucket that exists and fills every gap with 0, so the
 * axis, the total and the average all describe the same period.
 *
 * Anchoring on the newest *present* day rather than on today keeps older data
 * visible: if the last assessment was three weeks ago the panel shows those
 * three weeks instead of an empty fortnight.
 *
 * Returns [] when nothing parses, which the caller renders as an empty state
 * rather than as a chart of zeroes.
 *
 * @param {unknown} trend raw `assessmentTrend` from the API
 * @param {number} [days]
 * @returns {{ key: string, count: number }[]}
 */
export function buildTrendSeries(trend, days = OVERVIEW_TREND_DAYS) {
  const span = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.floor(Number(days)) : OVERVIEW_TREND_DAYS;
  const counts = new Map();
  let newest = '';
  for (const entry of Array.isArray(trend) ? trend : []) {
    const key = String(entry?._id ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const count = Number(entry?.count);
    counts.set(key, (counts.get(key) || 0) + (Number.isFinite(count) ? Math.max(0, count) : 0));
    if (key > newest) newest = key;
  }
  if (!newest) return [];
  const anchor = Date.parse(`${newest}T00:00:00Z`);
  if (!Number.isFinite(anchor)) return [];

  const series = [];
  for (let offset = span - 1; offset >= 0; offset--) {
    // The anchor is UTC midnight and every step is a whole number of days, so
    // each key stays on a UTC-midnight boundary: no DST drift, no off-by-one
    // column, and the keys still sort lexicographically.
    const key = new Date(anchor - offset * DAY_MS).toISOString().slice(0, 10);
    series.push({ key, count: counts.get(key) || 0 });
  }
  return series;
}

/**
 * Axis ticks for the activity chart: top, midpoint, baseline.
 *
 * A max of 1 has no meaningful midpoint — rounding 0.5 produced "1 / 1 / 0",
 * a scale that claimed two different heights were the same. Below 2 the scale
 * collapses to top and baseline, and the caller draws one fewer gridline so the
 * labels and the lines stay in step.
 *
 * @param {number} max
 * @returns {number[]}
 */
export function axisTicks(max) {
  const top = Math.max(0, Number(max) || 0);
  if (top < 2) return [top, 0];
  return [top, Math.round(top / 2), 0];
}

/**
 * Up to two initials from a display name. Empty, whitespace-only and
 * single-character names are all handled; never throws.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function initialsOf(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Label for a recent-user row. Legacy rows have no first/last name, so the
 * email carries the label instead of rendering a literal "undefined undefined".
 *
 * @param {object} user
 * @returns {string}
 */
export function displayNameOf(user) {
  const joined = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  return joined || user?.email || 'Unnamed member';
}

/**
 * The four plan-mix rows, plus the total they must sum to.
 *
 * The server's `planBreakdown` aggregates ONLY live, non-free subscriptions
 * (`subscriptionActive: true` + a non-free plan), so its `free` bucket was
 * structurally always 0 — the old "Basic" bar could never move, no matter how
 * many accounts were on the free tier. The free tier is therefore DERIVED from
 * the member count here, which also guarantees the four rows sum to exactly the
 * total shown in the donut.
 *
 * `Math.max` on the total means the rows still add up if the breakdown ever
 * reports more paid plans than there are members (a race between the two
 * counts), rather than emitting a donut over 100%.
 *
 * @param {object} planBreakdown
 * @param {number} totalUsers
 * @param {object} labels PLAN_LABELS from subscription/features
 * @returns {{ rows: object[], total: number }}
 */
export function buildPlanMix(planBreakdown, totalUsers, labels) {
  const plans = (planBreakdown && typeof planBreakdown === 'object') ? planBreakdown : {};
  const at = (key) => {
    const n = Number(plans[key]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const paid = at('monthly') + at('annual') + at('custom');
  const total = Math.max(Number(totalUsers) || 0, paid);
  const rows = [
    { key: 'free', label: labels.free, hint: 'Free tier', value: Math.max(0, total - paid), color: '#94a3b8' },
    { key: 'monthly', label: labels.monthly, hint: 'Monthly billing', value: at('monthly'), color: '#6366f1' },
    { key: 'annual', label: labels.annual, hint: 'Annual billing', value: at('annual'), color: '#0ea5e9' },
    { key: 'custom', label: labels.custom, hint: 'Custom grant', value: at('custom'), color: '#10b981' },
  ];
  return { rows, total };
}

/**
 * A `conic-gradient` for the plan donut, with each slice ending where the next
 * begins.
 *
 * All-zero data yields a neutral ring rather than an empty gradient — an empty
 * `conic-gradient()` is invalid and browsers drop the declaration, which left
 * the donut transparent on an account with no members yet.
 *
 * @param {{ value: number, color: string }[]} rows
 * @param {number} total
 * @returns {string}
 */
export function donutBackground(rows, total) {
  const sum = Number(total) || 0;
  const slices = (Array.isArray(rows) ? rows : []).filter(row => (Number(row?.value) || 0) > 0 && sum > 0);
  if (!slices.length) return 'conic-gradient(#e2e8f0 0% 100%)';
  let acc = 0;
  const stops = slices.map(row => {
    const from = (acc / sum) * 100;
    acc += Number(row.value) || 0;
    return `${row.color} ${from.toFixed(2)}% ${((acc / sum) * 100).toFixed(2)}%`;
  });
  return `conic-gradient(${stops.join(', ')})`;
}

// ══════════════════════════════════════════════════════════════════════════
// DEEPER ANALYTICS
//
// Everything below renders the second tier of the Overview: acquisition,
// activation, engagement depth, renewal runway, the health profile members
// submit, and the review backlog. The same contract as the rest of the file —
// total functions, no throwing, renderable output for any input including
// `undefined`.
// ══════════════════════════════════════════════════════════════════════════

/** Positive, finite count from anything. The single gate every new helper uses. */
function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Colour ramps for the new panels. Fixed order so two members of the same rank
 *  are always the same colour, and distinct enough that adjacent bars in a
 *  ranked list are never confusable. */
export const RANK_PALETTE = ['#4f46e5', '#7c3aed', '#0891b2', '#0d9488', '#ea580c', '#be123c'];
export const SEGMENT_PALETTE = ['#4f46e5', '#7c3aed', '#0891b2', '#0d9488', '#ea580c', '#be123c', '#64748b', '#94a3b8'];

/**
 * Split `values` into integer percentages that sum to EXACTLY 100.
 *
 * Plain `Math.round(v / total * 100)` makes three equal segments read
 * 33 / 33 / 33 — a legend that visibly does not add up. Largest-remainder
 * allocation hands the leftover points to the segments that were rounded down
 * hardest, so the displayed shares are always internally consistent AND still
 * track the real proportions.
 *
 * All-zero input yields all zeros rather than dividing by zero.
 *
 * @param {unknown[]} values
 * @returns {number[]}
 */
export function distributeShares(values) {
  const counts = (Array.isArray(values) ? values : []).map(count);
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return counts.map(() => 0);
  const exact = counts.map(n => (n / total) * 100);
  const shares = exact.map(v => Math.floor(v));
  let leftover = 100 - shares.reduce((sum, v) => sum + v, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => (b.frac - a.frac) || (a.index - b.index));
  for (const { index } of byRemainder) {
    if (leftover <= 0) break;
    shares[index] += 1;
    leftover -= 1;
  }
  return shares;
}

/**
 * An SVG polyline + filled area for a densified day series.
 *
 * Returns EMPTY strings rather than a degenerate path when there is nothing to
 * draw, so a caller can `pathLength`/`d`-guard once instead of branching twice.
 * A single data point is the case that matters: a line needs two points, so it
 * gets a line only, and the panel draws the dot itself rather than a zero-area
 * shape that renders as nothing at all.
 *
 * A flat (or all-zero) series is drawn along the BASELINE, not along the top:
 * pinned to the top of a zero-max scale, "no change" reads as a spike.
 *
 * @param {{ count?: unknown }[]} series densified series from buildTrendSeries
 * @param {{ width?: number, height?: number, pad?: number }} [options]
 * @returns {{ line: string, area: string, max: number, total: number, points: [number, number][] }}
 */
export function sparkPath(series, { width = 320, height = 96, pad = 3 } = {}) {
  const values = (Array.isArray(series) ? series : []).map(day => count(day?.count));
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const empty = { line: '', area: '', max: 0, total: 0, points: [] };
  if (!values.length || w < 2 || h < 2) return empty;

  const total = values.reduce((sum, n) => sum + n, 0);
  const max = values.reduce((best, n) => Math.max(best, n), 0);
  const inset = Math.min(Math.max(0, Number(pad) || 0), Math.min(w, h) / 2);
  const plotW = Math.max(1, w - inset * 2);
  const plotH = Math.max(1, h - inset * 2);
  const step = values.length > 1 ? plotW / (values.length - 1) : 0;
  const baseline = inset + plotH;
  const points = values.map((value, index) => [
    Number((inset + (values.length > 1 ? index * step : plotW / 2)).toFixed(2)),
    Number((baseline - (max > 0 ? (value / max) * plotH : 0)).toFixed(2)),
  ]);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ');
  const area = points.length < 2
    ? ''
    : `${line} L${points[points.length - 1][0]} ${baseline.toFixed(2)} L${points[0][0]} ${baseline.toFixed(2)} Z`;
  return { line, area, max, total, points };
}

/**
 * A stacked-severity bar out of a `{ label: count }` map.
 *
 * ACCEPTS BOTH SHAPES, and that is not leniency — it is the fix for a real bug.
 * The server sends the three strips (`diets`, `stress`, `sleep`) as maps, and
 * once sent `diets` as a ranked `[{ label, count }]` list instead. `Object.keys`
 * on that array yields "0", "1", "2", whose values are objects: `Number({})` is
 * NaN, every count floored to zero, and the diet strip rendered as an empty
 * bar labelled "0 answers" with nothing thrown anywhere. A strip that can go
 * blank from a shape change is the exact failure this module exists to prevent,
 * so the reader normalises both forms and the two can never be confused again.
 *
 * `order` is the panel's own severity order (low → high), so a payload that
 * happens to arrive in a different order still renders worst-last. Labels not in
 * `order` follow, by count then alphabetically, so a new option added to the
 * questionnaire shows up instead of silently vanishing.
 *
 * Shares are taken over the labels ACTUALLY SHOWN, so the bar is always full —
 * a legend claiming 60% while the strip leaves 40% empty is a lie either way.
 * Widths are handed to CSS as `flex-grow` ratios rather than percentages for
 * the same reason: they cannot overflow or leave a seam.
 *
 * @param {Record<string, unknown>|{label: unknown, value?: unknown, count?: unknown}[]} counts
 * @param {string[]} [order]
 * @param {{ limit?: number, palette?: string[] }} [options]
 * @returns {{ label: string, value: number, pct: number, color: string }[]}
 */
export function buildSegments(counts, order = [], { limit = 8, palette = SEGMENT_PALETTE } = {}) {
  const map = Array.isArray(counts)
    ? counts.reduce((acc, row) => {
      const label = String(row?.label ?? '').trim();
      if (label) acc[label] = count(row?.value ?? row?.count);
      return acc;
    }, {})
    : ((counts && typeof counts === 'object') ? counts : {});
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 8;
  const known = order.filter(label => count(map[label]) > 0);
  const extra = Object.keys(map)
    .filter(label => !order.includes(label) && count(map[label]) > 0)
    .sort((a, b) => (count(map[b]) - count(map[a])) || a.localeCompare(b));
  const labels = [...known, ...extra].slice(0, max);
  if (!labels.length) return [];

  const values = labels.map(label => count(map[label]));
  const shares = distributeShares(values);
  const ramp = Array.isArray(palette) && palette.length ? palette : SEGMENT_PALETTE;
  return labels.map((label, index) => ({
    label,
    value: values[index],
    pct: shares[index],
    color: ramp[index % ramp.length],
  }));
}

/**
 * A ranked "top N" bar list, sorted biggest-first and coloured by rank.
 *
 * `pct` is relative to the LEADING row (so the top bar is always full and the
 * list reads as a magnitude comparison) while `sharePct` is relative to the sum
 * of what is shown (so the legend can honestly say "of assessments"). Two
 * different denominators, each labelled for what it means — collapsing them into
 * one number was how a "62%" once appeared next to a half-empty bar.
 *
 * @param {{ label: unknown, value: unknown }[]} rows
 * @param {{ limit?: number, palette?: string[] }} [options]
 * @returns {{ label: string, value: number, pct: number, sharePct: number, color: string }[]}
 */
export function buildRankedBars(rows, { limit = 6, palette = RANK_PALETTE } = {}) {
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 6;
  const list = (Array.isArray(rows) ? rows : [])
    .map(row => ({ label: String(row?.label ?? '').trim(), value: count(row?.value ?? row?.count) }))
    .filter(row => row.label && row.value > 0)
    .sort((a, b) => (b.value - a.value) || a.label.localeCompare(b.label))
    .slice(0, max);
  if (!list.length) return [];

  const top = list.reduce((best, row) => Math.max(best, row.value), 0);
  const sum = list.reduce((acc, row) => acc + row.value, 0);
  const ramp = Array.isArray(palette) && palette.length ? palette : RANK_PALETTE;
  return list.map((row, index) => ({
    ...row,
    pct: top > 0 ? Math.round((row.value / top) * 100) : 0,
    sharePct: sum > 0 ? Math.round((row.value / sum) * 100) : 0,
    color: ramp[index % ramp.length],
  }));
}

/**
 * The member-journey funnel: registered → assessed → subscribed.
 *
 * Each stage is expressed against the FIRST stage, not the one above it, because
 * the question the panel answers is "of everyone who joined, how far did they
 * get" — a per-step drop rate answers a different question and would make the
 * three rows impossible to read as one funnel.
 *
 * `dropPct` is null on the first stage (there is no previous step to drop from)
 * and is clamped at 0, so an out-of-order or racy payload can never render a
 * negative "−4% conversion".
 *
 * @param {{ key?: unknown, label?: unknown, value?: unknown, hint?: unknown }[]} stages
 * @returns {{ key: string, label: string, hint: string, value: number, sharePct: number, dropPct: number|null, widthPct: number }[]}
 */
export function buildFunnel(stages) {
  const list = (Array.isArray(stages) ? stages : []).map(stage => ({
    key: String(stage?.key ?? ''),
    label: String(stage?.label ?? ''),
    hint: String(stage?.hint ?? ''),
    value: count(stage?.value),
  }));
  if (!list.length) return [];

  const top = list.reduce((best, stage) => Math.max(best, stage.value), 0);
  let previous = null;
  return list.map(stage => {
    const sharePct = top > 0 ? Math.round((stage.value / top) * 100) : 0;
    const rawDrop = previous === null || previous <= 0 ? null : ((previous - stage.value) / previous) * 100;
    previous = stage.value;
    return {
      ...stage,
      sharePct,
      dropPct: rawDrop === null ? null : Math.max(0, Math.round(rawDrop)),
      widthPct: Math.max(0, Math.min(100, sharePct)),
    };
  });
}

/**
 * Compare the newest `recent` days of a series against the `recent` days before
 * them, for the "vs previous 7 days" line under the growth chart.
 *
 * `pct` is null when the earlier window is empty: growth from nothing has no
 * meaningful percentage, and printing "∞%" or "100%" would invent one.
 *
 * @param {{ count?: unknown }[]} series
 * @param {{ recent?: number, previous?: number }} [options]
 * @returns {{ recent: number, previous: number, delta: number, pct: number|null, direction: 'up'|'down'|'flat' }}
 */
export function compareWindows(series, { recent = 7, previous = 7 } = {}) {
  const days = Array.isArray(series) ? series.map(day => count(day?.count)) : [];
  const take = (source, from, length) => {
    const window = source.slice(Math.max(0, from - length), Math.max(0, from));
    return window.reduce((sum, n) => sum + n, 0);
  };
  const recentTotal = take(days, days.length, Math.max(1, Math.floor(Number(recent) || 7)));
  const previousTotal = take(
    days,
    days.length - Math.max(1, Math.floor(Number(previous) || 7)),
    Math.max(1, Math.floor(Number(recent) || 7)),
  );
  const delta = recentTotal - previousTotal;
  return {
    recent: recentTotal,
    previous: previousTotal,
    delta,
    pct: previousTotal > 0 ? Math.round((delta / previousTotal) * 100) : null,
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
  };
}

/**
 * "2.4" — a per-member rate, or an em dash when there is nobody to divide by.
 *
 * Returns a STRING so the caller can drop it straight into JSX: a numeric
 * fallback would read "NaN assessments per member" on an empty install.
 *
 * @param {unknown} part
 * @param {unknown} whole
 * @param {number} [places]
 * @returns {string}
 */
export function rateOf(part, whole, places = 1) {
  const p = count(part);
  const w = count(whole);
  if (w <= 0) return '—';
  const digits = Math.max(0, Math.min(4, Math.floor(Number(places)) || 0));
  return (p / w).toFixed(digits);
}

/**
 * Signed percentage for a "±n% vs last month" label.
 *
 * Zero is rendered without a sign: "+0%" claims a change that did not happen.
 *
 * @param {number} pct
 * @returns {string}
 */
export function signedPercent(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n) || n === 0) return '0%';
  return `${n > 0 ? '+' : '−'}${Math.abs(Math.round(n))}%`;
}

/**
 * Renders a countdown-style severity label for the renewal runway.
 *
 * Purely presentational and total: a malformed count is floored to zero rather
 * than rendered as "undefined day(s)".
 *
 * @param {unknown} value
 * @returns {string}
 */
export function dayCountLabel(value, singular = 'day', plural = 'days') {
  const n = Math.max(0, Math.round(count(value)));
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

