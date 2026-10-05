/**
 * Date formatting for the admin console.
 *
 * WHY THIS EXISTS
 * `new Date(value).toLocaleDateString()` returns the literal string
 * "Invalid Date" for a missing or malformed `value`, and that string was being
 * printed straight into the Users and Assessment panels. The console has
 * imported rows with no `createdAt`, so the admin was shown a browser error
 * message where a date should be.
 *
 * Every formatter here returns a human string or an explicit fallback. None of
 * them can emit "Invalid Date", and none of them throw on a bad value — a
 * render must never be the thing that breaks a panel.
 */

/**
 * Parse a value into a usable Date, or null.
 *
 * The type check is not defensive noise — it is the fix for a real bug. Handed
 * a non-date, `new Date(value)` coerces: `new Date([])` and `new Date(false)`
 * are epoch 0, `new Date(true)` is epoch 1, and `new Date(Symbol())` throws.
 * So a mangled `createdAt` rendered as a confident "Jan 1, 1970" — a plausible-
 * looking lie — and one odd value could crash a render. Only a string, a finite
 * number, or a Date is ever treated as a date.
 *
 * @param {unknown} value
 * @returns {Date|null} null when the value is not a displayable date
 */
function toDate(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

/**
 * Short date, e.g. "Sep 28, 2026".
 *
 * @param {unknown} value
 * @param {string} [fallback] shown when the value is absent or unparseable
 * @returns {string}
 */
export function formatShortDate(value, fallback = 'Unknown') {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Compact date, e.g. "Sep 28" — the year dropped because these rows are read at
 * a glance in a list that is nearly always about the present.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function formatCompactDate(value, fallback = '') {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Whether a value is a date the console can actually display. Lets a caller
 * choose between a formatted date and a "never / unknown" label without
 * parsing the value twice.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRealDate(value) {
  return toDate(value) !== null;
}

/**
 * Full timestamp, e.g. "Sep 28, 2026, 10:24:31 AM".
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function formatDateTime(value, fallback = 'Unknown') {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default { formatShortDate, formatCompactDate, formatDateTime, isRealDate };
