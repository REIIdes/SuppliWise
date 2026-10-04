/**
 * Which PLAN DAY is it? — the client's copy of the server's rule.
 *
 * Run: node --test src/utils/planDay.test.js
 *
 * THE SERVER OWNS THE ANSWER, AND THIS IS ONLY ITS SHADOW
 *
 * A plan day runs from 04:00 to 04:00 in the user's own timezone and is labelled
 * with the calendar date it OPENS on:
 *
 *   00:00 → 03:59 on 4 Oct   →  plan day 2026-10-03   (3 Oct has not ended yet)
 *   04:00 → 23:59 on 4 Oct   →  plan day 2026-10-04   (the day has rolled over)
 *
 * The authoritative implementation is `server/utils/planDay.js`, and the
 * dashboard response carries it as `planDay.todayKey`. This module exists for the
 * moments where the client has to answer before the response arrives — deciding
 * which calendar cell is "today", and knowing when the page must refetch.
 *
 * WHY THE CLIENT MUST NOT GUESS INSTEAD
 * The tracker used to compute its own day key from `getFullYear()/getMonth()/
 * getDate()` — the calendar date — while the server keyed records off UTC. The
 * two disagreed for the four hours after midnight, and the disagreement was
 * visible: the calendar would mark a day "today" whose doses the plan below had
 * already rolled past, and clicking it opened a day the server called history.
 * Both sides must apply one boundary, so both implement it — the server's is the
 * rule, this one mirrors it and is held to the same boundary by its own tests.
 *
 * WHY 4 AM AND NOT MIDNIGHT
 * Nobody plans a dose for 12:30 AM, and a day starting at midnight spends its
 * first four hours in a state where nothing may be recorded. 4:00 AM is also
 * where the client already put the boundary — `DEAD_HOURS` in slotSchedule.js is
 * 00:00–04:00 — so the two butt against each other with no gap: 00:00–03:59 is
 * the pause, 04:00 is the reset, and every dose window on either side of it is
 * contiguous. Both constants live here, one file apart from that one, and each
 * package asserts its own copy of the boundary in tests.
 *
 * WHY IT IS NOT DERIVED FROM AN ASSESSMENT
 * Nothing here reads an assessment. The boundary is a property of a plan day,
 * not of any one plan, so an assessment created at 11:58 PM and one created at
 * 4:01 AM land on the same rule and the same day. A reset keyed to "the moment
 * this assessment was created" is what made people who signed up in the small
 * hours end up inside a day that had already been scored or closed.
 */

/** Minutes from local midnight at which a plan day rolls over. */
export const PLAN_DAY_RESET_MINUTES = 4 * 60;

/** The same boundary in words, for the copy that names it. */
export const PLAN_DAY_RESET_LABEL = '4:00 AM';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Matches `server/utils/planDay.js`. The two are NOT shared — one is CJS for the
 * server, one is ESM for Vite — and must be kept in step by hand. Both packages
 * assert their own copy in tests, so changing one without the other fails a
 * suite rather than silently shipping a disagreeing tracker.
 */
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (n) => String(n).padStart(2, '0');

/** Zero-padded, so day keys sort and compare as strings the way the DB does. */
const formatDayKey = (year, month, day) =>
  `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;

/** Minutes since local midnight, or null for an unusable instant. */
export function minutesOfDay(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  return date.getHours() * 60 + date.getMinutes();
}

/** Parse a YYYY-MM-DD key, or null when it is not a real one. */
export function parseDayKey(dayKey) {
  const match = typeof dayKey === 'string' ? DAY_KEY_RE.exec(dayKey.trim()) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject dates that do not exist (2026-02-31) rather than rolling them over.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/**
 * The same calendar date, `offset` days away.
 *
 * Pure calendar arithmetic on a UTC cursor, so no local offset and no DST rule
 * can shift the result. `setUTCFullYear` rather than `Date.UTC`, because the
 * latter maps years 0–99 into the 1900s.
 */
export function shiftDayKey(dayKey, offset) {
  const parsed = parseDayKey(dayKey);
  if (!parsed) return '';
  const days = Number(offset);
  if (!Number.isFinite(days)) return '';
  const cursor = new Date(0);
  cursor.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day);
  cursor.setTime(cursor.getTime() + Math.trunc(days) * MS_PER_DAY);
  return formatDayKey(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate());
}

/** The plan day before `dayKey`. */
export const previousDayKey = (dayKey) => shiftDayKey(dayKey, -1);

/**
 * The plan day `now` falls in, as YYYY-MM-DD, on the browser's own clock.
 *
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD, never empty
 */
export function planDayKey(now = new Date()) {
  const minutes = minutesOfDay(now);
  if (minutes === null) {
    // An unusable clock still has to produce a usable key: '' matches no records
    // and would blank the plan outright.
    return planDayKey(new Date());
  }
  const base = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  // 04:00 onwards the plan day carries today's date; before it, the plan day
  // still running is the one that opened yesterday.
  return minutes >= PLAN_DAY_RESET_MINUTES ? base : previousDayKey(base);
}

/**
 * Whether the day key from the server is usable, falling back to the local rule.
 *
 * Every plan-day comparison the client makes has to tolerate a response that
 * predates this field — a cached payload, a service worker serving an old shell,
 * or a backend that has not been redeployed. Falling back to the local rule is
 * safe because it is the same rule; the alternative (treating it as "no data")
 * would leave the calendar unable to tell today from history.
 */
export function resolveTodayKey(serverKey, now = new Date()) {
  return parseDayKey(serverKey) ? serverKey.trim() : planDayKey(now);
}

/**
 * Milliseconds until the next 4 AM reset, for scheduling a refetch.
 *
 * WHY THE CLIENT SCHEDULES A REFETCH AT ALL
 * A page left open across 4:00 AM would otherwise keep showing yesterday's plan:
 * every dose already ticked, nothing to do, until the user happened to reload.
 * Watching for the key to change and refetching is what makes the reset happen
 * on screen rather than on navigation.
 *
 * Capped at one hour per tick. `setTimeout` silently fires immediately for a
 * delay past ~24.8 days, and a user who closed the laptop for a month must not
 * come back to a tight refetch loop; waking hourly instead re-reads the clock
 * and settles on the right instant.
 *
 * @returns {number} 1..3_600_000, never NaN
 */
export function msToNextReset(now = new Date()) {
  const minutes = minutesOfDay(now);
  if (minutes === null) return 60_000;
  const remaining = PLAN_DAY_RESET_MINUTES - minutes;
  const until = (remaining > 0 ? remaining : remaining + 24 * 60) * 60 * 1000;
  return Math.min(Math.max(until, 1000), 60 * 60 * 1000);
}

/**
 * How long to wait before re-checking the plan day.
 *
 * Zero means "check now" — which the caller should read as refetch
 * immediately rather than as a zero-delay loop, so it is floored at a second.
 */
export function planDayPollDelay(now = new Date()) {
  return Math.max(msToNextReset(now), 1000);
}