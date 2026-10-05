/**
 * Which PLAN DAY is it? — the one definition of "today" for IntakeRecord.
 *
 * Run: node --test "Test File/plan-day.test.js"
 *
 * THE RULE
 * A plan day is a 24-hour window that runs from 04:00 to 04:00 in the USER'S OWN
 * timezone, and it is labelled with the calendar date it OPENS on:
 *
 *   00:00 → 03:59 on 4 Oct   →  plan day 2026-10-03   (3 Oct has not ended yet)
 *   04:00 → 23:59 on 4 Oct   →  plan day 2026-10-04   (the day has rolled over)
 *
 * So the reset happens at 4:00 AM and at no other time, ever.
 *
 * WHY "TODAY" IS NOT GOOD ENOUGH
 * Every reader of "today" used to compute it as `new Date().toISOString().split
 * ('T')[0]` — the UTC calendar date. That rolls over at 00:00 UTC, which is 8:00
 * AM in Manila, 3:30 AM in Kolkata and 7:00 PM the previous evening in Los
 * Angeles. A user in Manila therefore saw their plan keep filling in for four
 * hours after they were told it had restarted, and a user in Los Angeles had
 * their day cut short at dinnertime. Worse, the deadline sat at whatever hour
 * UTC happened to fall on — so for most of the planet "the reset" was not 4 AM
 * at all, and for a user in UTC+4 it was not a fixed hour of their morning.
 *
 * It is also the reason the boundary was never felt to hold: the clock that
 * decided it was the SERVER's, so nothing about it lined up with the dead hours
 * and 4:00 AM reset that the tracker already draws on the client
 * (my-react-app/src/utils/slotSchedule.js).
 *
 * WHY 4:00 AM, AND WHY IT IS NOT DERIVED FROM THE ASSESSMENT
 * The boundary is a property of a plan day, not of any one plan, so it is
 * written down once here as a constant. Nothing about it reads an assessment —
 * an assessment created at 11:58 PM and one created at 4:01 AM get exactly the
 * same boundary, and both belong to the plan day that is currently running. A
 * reset anchored to "the moment this assessment was created" is what produced
 * the original complaint: people creating a plan in the small hours landed in a
 * day that had already been scored, closed or half-rolled over.
 *
 * WHY 4 AM AND NOT MIDNIGHT
 * Nobody plans a supplement dose for 12:30 AM, and a day that starts at midnight
 * has to spend its first four hours in a state where nothing may be recorded —
 * with no way to tell "you have nothing due" from "the app is broken". 4 AM is
 * also where the client already puts the boundary (DEAD_HOURS is 00:00–04:00),
 * so the two sides butt against each other with no gap: 00:00–03:59 is the
 * pause, 04:00 is the reset, and every dose window on either side of it is
 * contiguous.
 *
 * TIME ZONES
 * A plan day belongs to the user, so it is read from the user's own wall clock —
 * which the browser reports in `X-Client-Timezone` and the server persists on
 * the user document (see routes/dashboard.js → timezoneFor). Judging it in UTC
 * instead is the bug this file exists to remove.
 *
 * WHEN THE ZONE IS UNKNOWN
 * `zonedNowParts` falls back to UTC rather than returning nothing, so the caller
 * always gets a usable clock. UTC with the same 4 AM rule is a defensible answer
 * (it is exactly what the old code did, one boundary earlier) and, crucially, it
 * is a *consistent* answer: every reader lands on the same key rather than some
 * readers guessing. `Intl` is only reached with a zone `cleanTimeZone` has
 * already proved it understands, so it cannot throw a RangeError here — and an
 * exception inside day-key arithmetic would turn a wrong plan into a 500.
 */

/** Minutes from local midnight at which a plan day rolls over. 04:00. */
const PLAN_DAY_RESET_MINUTES = 4 * 60;

/** The same boundary in words, for logs and API payloads. */
const PLAN_DAY_RESET_LABEL = '4:00 AM';

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = MINUTES_PER_DAY * 60 * 1000;

/** Used when no usable zone is known. */
const FALLBACK_TIME_ZONE = 'UTC';

/** A bound on `recentPlanDayKeys`, so a crafted value cannot build a huge $in. */
const MAX_RECENT_DAYS = 366;

/** Day keys are zero-padded YYYY-MM-DD, so lexicographic order IS chronological
 *  order — which is what every `$gte`/`$lte`/`sort()` on `dayKey` relies on. */
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const asText = (value) => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
};

/** Zero-pad so the key sorts and compares as a string. */
const pad2 = (n) => String(n).padStart(2, '0');

const formatDayKey = (year, month, day) =>
  `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;

/**
 * Normalise a client-supplied IANA timezone.
 *
 * Returns '' for anything unusable so a bad header can never reach
 * `Intl.DateTimeFormat`, which throws a RangeError on a zone it does not know —
 * and an exception inside the day-key path would turn a wrong plan into a 500.
 *
 * @param {*} value
 * @returns {string} the zone, or '' when it is missing or not recognisable
 */
function cleanTimeZone(value) {
  const tz = asText(value).trim();
  if (!tz || tz.length > 64) return '';
  // IANA zone names are slash/dash/underscore separated words, e.g.
  // "Europe/London", "America/Argentina/Buenos_Aires", "UTC".
  if (!/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) return '';
  if (!/^[A-Za-z]/.test(tz)) return '';
  try {
    // The only reliable validation available without a tz database of our own:
    // ask Intl. A zone it accepts now is a zone it will accept in an hour.
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return '';
  }
}

/**
 * The user's own calendar date and time-of-day for an instant.
 *
 * Reads the zone's wall clock rather than subtracting an offset, so a half-hour
 * zone (Asia/Kolkata, +05:30) lands on the right minute and a daylight-saving
 * change is handled by the platform instead of by a rule we would have to keep
 * updating by hand.
 *
 * @param {Date|string|number} [input]
 * @param {string} [timeZone] IANA zone; '' or junk falls back to UTC.
 * @returns {{year:number, month:number, day:number, hour:number, minute:number,
 *            minutes:number, timeZone:string}|null}
 *   null only when `input` is not a usable instant — never for a bad zone.
 */
function zonedNowParts(input = new Date(), timeZone = '') {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;

  const tz = cleanTimeZone(timeZone) || FALLBACK_TIME_ZONE;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23', // not hour12:false — that can render midnight as "24"
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);

    const read = (type) => {
      const part = parts.find((p) => p.type === type);
      return part ? Number(part.value) : NaN;
    };
    const year = read('year');
    const month = read('month');
    const day = read('day');
    const hour = read('hour');
    const minute = read('minute');
    if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Belt and braces against a stray "24" from a locale quirk.
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { year, month, day, hour, minute, minutes: hour * 60 + minute, timeZone: tz };
  } catch {
    // cleanTimeZone already proved the zone is usable, so this is unreachable in
    // practice. Falling back to UTC keeps the function total.
    try {
      return zonedNowParts(date, FALLBACK_TIME_ZONE);
    } catch {
      return null;
    }
  }
}

/** Parse a YYYY-MM-DD key into numbers, or null when it is not one. */
function parseDayKey(dayKey) {
  const match = DAY_KEY_RE.exec(asText(dayKey));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject dates that do not exist (2026-02-31) rather than silently rolling them
  // over, so a hand-typed key cannot quietly address a different day.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** The same day, `offset` days away. `offset` may be negative. */
function shiftDayKey(dayKey, offset) {
  const parsed = parseDayKey(dayKey);
  if (!parsed) return '';
  const days = Number(offset);
  if (!Number.isFinite(days)) return '';

  // Calendar arithmetic on a UTC cursor, so no zone offset or DST rule can shift
  // the result. `setUTCFullYear` is used rather than `Date.UTC` because the
  // latter maps years 0–99 into the 1900s.
  const cursor = new Date(0);
  cursor.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day);
  cursor.setTime(cursor.getTime() + Math.trunc(days) * MS_PER_DAY);
  return formatDayKey(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate());
}

/** The plan day before `dayKey`. */
const previousDayKey = (dayKey) => shiftDayKey(dayKey, -1);

/**
 * The plan day `now` falls in, as YYYY-MM-DD.
 *
 * THE ONE FUNCTION EVERY CALLER SHOULD USE
 * Seeding a day's records, reading them, refusing to edit yesterday, scoring
 * "today" and drawing the calendar all have to agree on this string, or the
 * product shows yesterday's unticked doses on a fresh page. They used to each
 * compute it themselves — three copies on the server plus a fourth, local-
 * midnight, copy in the tracker — and four copies of one boundary is four
 * chances to disagree.
 *
 * @param {Date|string|number} [now]
 * @param {string} [timeZone] IANA zone; '' or junk falls back to UTC.
 * @returns {string} YYYY-MM-DD, never empty
 */
function planDayKey(now = new Date(), timeZone = '') {
  const parts = zonedNowParts(now, timeZone);
  if (!parts) {
    // Unusable instant. There is no honest key to return, but the callers that
    // reach here are already on a failing request, so a key derived from the
    // real clock is far more useful than '' (which would match no records and
    // silently blank the plan).
    return planDayKey(new Date(), FALLBACK_TIME_ZONE);
  }

  // 04:00 onwards the plan day carries today's date; before it, the plan day
  // still running is the one that opened yesterday.
  if (parts.minutes >= PLAN_DAY_RESET_MINUTES) {
    return formatDayKey(parts.year, parts.month, parts.day);
  }
  return previousDayKey(formatDayKey(parts.year, parts.month, parts.day));
}

/**
 * Whether `now` is inside the dead hours (00:00–04:00) of the user's day — i.e.
 * inside the pause that precedes a reset.
 *
 * The SERVER's copy of `isDeadHour` in my-react-app/src/utils/slotSchedule.js,
 * needed here so a request that lands during the pause is scored against the
 * plan day that is actually still running rather than against a fresh, empty
 * one. Failing OPEN here would mean penalising a user for the four hours in
 * which nothing may be recorded, so an unusable clock returns false.
 */
function isInDeadHours(now = new Date(), timeZone = '') {
  const parts = zonedNowParts(now, timeZone);
  if (!parts) return false;
  return parts.minutes < PLAN_DAY_RESET_MINUTES;
}

/**
 * How many minutes are left before the next reset, on the user's wall clock.
 *
 * Exposed so a caller (or a test) can describe the boundary without repeating
 * the arithmetic. Ranges 1..1440, and is 1440 when the clock is exactly on the
 * boundary.
 */
function minutesToNextReset(now = new Date(), timeZone = '') {
  const parts = zonedNowParts(now, timeZone);
  if (!parts) return 0;
  const elapsed = parts.minutes;
  const remaining = PLAN_DAY_RESET_MINUTES - elapsed;
  return remaining > 0 ? remaining : remaining + MINUTES_PER_DAY;
}

/**
 * The last `count` plan days, oldest first, ending with the one `now` falls in.
 *
 * Used by the weekly-adherence endpoint, which used to build its window from
 * `new Date()` minus N — walking the UTC calendar backwards from a boundary that
 * is not the one the records are keyed by, which slid every column by four hours
 * for anyone east of UTC.
 *
 * @returns {string[]} YYYY-MM-DD keys, oldest → newest, never containing ''.
 */
function recentPlanDayKeys(count, now = new Date(), timeZone = '') {
  const days = Number(count);
  if (!Number.isFinite(days) || days <= 0) return [];
  const steps = Math.min(Math.trunc(days), MAX_RECENT_DAYS);
  const current = planDayKey(now, timeZone);
  const keys = [];
  for (let i = steps - 1; i >= 0; i -= 1) keys.push(shiftDayKey(current, -i));
  return keys.filter(Boolean);
}

module.exports = {
  PLAN_DAY_RESET_MINUTES,
  PLAN_DAY_RESET_LABEL,
  FALLBACK_TIME_ZONE,
  DAY_KEY_RE,
  cleanTimeZone,
  zonedNowParts,
  parseDayKey,
  shiftDayKey,
  previousDayKey,
  planDayKey,
  isInDeadHours,
  minutesToNextReset,
  recentPlanDayKeys,
};