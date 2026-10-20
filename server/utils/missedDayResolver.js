/**
 * Which plan days should be backfilled, and which must never be.
 *
 * Run: node --test "Test File/missedDayBackfill.test.js"
 *
 * THE HOLE THIS CLOSES
 * A day's doses are seeded when the dashboard is first opened on it
 * (routes/dashboard.js → GET /). Open the app and tick nothing and the score
 * punishes you the moment each window closes. Never open the app at all and
 * there are no rows for the day — so nothing can be missed, lifetime adherence
 * never drops, the calendar shows a blank square instead of a red one, and the
 * persisted `DashboardMetrics.wellnessScore` sits frozen at whatever it was.
 * Silence read as success, which is the opposite of a wellness score.
 *
 * THE RULE
 * Every plan day that has been and gone with NO records at all gets its plan
 * seeded as unticked, so it counts as fully missed under the one existing
 * rulebook (utils/intakeWindows.js). Nothing else about scoring changes.
 *
 * Three days are deliberately excluded:
 *
 *   today ......... it is still running. Its windows are open, and seeding it
 *                  here would charge doses the user has not yet had the chance
 *                  to take. GET / seeds it itself, window-aware.
 *   any day with
 *   records ....... attended, or opened-and-skipped. Both already scored. The
 *                  caller checks; a day is judged by having rows at all, not by
 *                  having ticked rows. Which is also what makes it safe for
 *                  `sinceDayKey` to be the plan day the assessment itself opened
 *                  on: that day has rows for anyone who ever looked at it, and
 *                  for anyone who did not, the doses were due and never taken.
 *
 * WHY THE WALK IS BOUNDED
 * `lookbackDays` caps how far back one pass reaches, because the documents scale
 * with plan length (a 20-supplement plan times 365 days is 7,300 rows) and a
 * user returning after a year should get an honest recent history, not a
 * minute-long request. The newest day actually written is reported as
 * `lastBackfilledDay`, so the next pass resumes from there rather than
 * re-walking the same window — which is also how older days are eventually
 * reached, one pass at a time.
 *
 * This file is the arithmetic only: no database, no `Intl`. Deciding which days
 * to judge and writing them are kept apart so each can be tested alone.
 */

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Plan days a single pass will walk back from today. */
const DEFAULT_BACKFILL_LOOKBACK_DAYS = 30;

/** Hard ceiling on the keys one pass can return, whatever it is asked for. */
const MAX_BACKFILL_LOOKBACK_DAYS = 366;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');

const asDayKey = (value) => (DAY_KEY_RE.test(typeof value === 'string' ? value : '') ? value : '');

/** `dayKey` moved `days` calendar days, forward (positive) or back (negative).
 *  On a UTC cursor, so no zone offset or DST rule can shift the result — and
 *  `setUTCFullYear` rather than `Date.UTC` because the latter maps years 0–99
 *  into the 1900s. */
function shiftDayKey(dayKey, days) {
  const [y, m, d] = asDayKey(dayKey).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
  // Range-checked rather than handed to `Date`, which would normalise 2026-13-40
  // into a real key ten weeks on and return a day nobody asked for.
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  const steps = Number(days);
  if (!Number.isFinite(steps)) return '';
  const cursor = new Date(0);
  cursor.setUTCFullYear(y, m - 1, d);
  cursor.setTime(cursor.getTime() + Math.trunc(steps) * MS_PER_DAY);
  return `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`;
}

const nextDayKey = (dayKey) => shiftDayKey(dayKey, 1);

/** Day keys are zero-padded YYYY-MM-DD, so string order IS chronological order. */
function isBeforeDay(dayKey, other) {
  const a = asDayKey(dayKey);
  const b = asDayKey(other);
  if (!a || !b) return false;
  return a < b;
}

/**
 * The gap days one pass should seed, oldest first.
 *
 * @param {{sinceDayKey?: string, lastBackfilledDay?: string, todayKey?: string,
 *          lookbackDays?: number}} [options]
 *   `sinceDayKey`       — the oldest day that can be judged (the plan day the
 *                         assessment opened on, read on the user's own clock —
 *                         the dead hours mean a plan created at midnight belongs
 *                         to the previous day).
 *   `lastBackfilledDay` — the newest day a previous pass already wrote; empty
 *                         on the first pass.
 *   `todayKey`          — the running plan day, which is never backfilled.
 *   `lookbackDays`      — how many days one pass may reach back from today.
 * @returns {{keys: string[], lastBackfilledDay: string}} `lastBackfilledDay` is
 *   only ever the newest day in `keys`, so a caller can store it as a
 *   forward-moving pointer.
 */
function planDaysToBackfill({
  sinceDayKey = '',
  lastBackfilledDay = '',
  todayKey = '',
  lookbackDays = DEFAULT_BACKFILL_LOOKBACK_DAYS,
} = {}) {
  const today = asDayKey(todayKey);
  const since = asDayKey(sinceDayKey);
  const resumeAfter = asDayKey(lastBackfilledDay);
  const untouched = { keys: [], lastBackfilledDay: resumeAfter };
  if (!today || !since) return untouched;

  const lookback = Math.max(1, Math.trunc(Number(lookbackDays)) || DEFAULT_BACKFILL_LOOKBACK_DAYS);
  // The oldest day this pass may reach: `lookback` days back counted from
  // yesterday, since today is seeded live and is not this pass's business.
  const windowFloor = shiftDayKey(today, -(lookback - 1));

  // Start after whatever a previous pass already wrote, but never before the
  // plan existed and never older than this pass's window. The LATEST of the
  // three is the only candidate that satisfies all three constraints.
  const candidates = [resumeAfter ? nextDayKey(resumeAfter) : '', windowFloor, since].filter(Boolean);
  if (candidates.length === 0) return untouched;
  const start = candidates.reduce((a, b) => (a > b ? a : b));

  if (!isBeforeDay(start, today)) return untouched;

  const keys = [];
  for (let cursor = start; isBeforeDay(cursor, today) && keys.length < MAX_BACKFILL_LOOKBACK_DAYS; cursor = nextDayKey(cursor)) {
    keys.push(cursor);
  }
  if (keys.length === 0) return untouched;

  return { keys, lastBackfilledDay: keys[keys.length - 1] };
}

module.exports = {
  DAY_KEY_RE,
  DEFAULT_BACKFILL_LOOKBACK_DAYS,
  MAX_BACKFILL_LOOKBACK_DAYS,
  asDayKey,
  shiftDayKey,
  nextDayKey,
  isBeforeDay,
  planDaysToBackfill,
};
