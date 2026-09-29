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
