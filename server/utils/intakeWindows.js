/**
 * When a supplement's time window opens and closes — the SERVER's copy of the
 * rulebook in my-react-app/src/utils/slotSchedule.js.
 *
 * THE PROBLEM THIS SOLVES
 * The wellness score has to answer one question about today's plan: "is this
 * dose late, or is it genuinely missed?" Those are different things and only one
 * of them may cost the user points.
 *
 *   A DOSE TAKEN LATE IS NOT MISSED.  Ticking "Evening" magnesium at 11 PM, or
 *   Vitamin D at 8 AM because the alarm went off late, is a dose that was
 *   taken. Charging for it would punish the user for an alarm, not for skipping
 *   anything.
 *
 *   A WINDOW THAT CLOSES UNTOUCHED IS MISSED.  Once 12:00 PM has passed, a
 *   morning pill that was never ticked can no longer be taken on time, and from
 *   that moment the plan is short.
 *
 *   A WINDOW THAT IS STILL OPEN IS NEITHER.  Being 20 minutes late to the
 *   8 AM stack is not a missed dose, and must not move the score at all.
 *
 * WHY THIS LIVES ON THE SERVER AT ALL
 * The tracker computes the same windows from the browser's clock so it can
 * lock a row the moment its window passes. But the score is persisted
 * (`DashboardMetrics.wellnessScore`) and read by Insights, the Web3 export and
 * the admin views, none of which have a browser clock. Deciding "missed" in
 * two places would let those readers and the tracker disagree, so the decision
 * is made once, here, and the client's own copy is only about what to *draw*.
 *
 * THE CLIENT COPY IS A DELIBERATE DUPLICATE
 * my-react-app/src/utils/slotSchedule.js holds the same minute ranges. The two
 * are not shared (one is CJS for the server, one is ESM for Vite) and must be
 * kept in step by hand. `npm test` in the server asserts the boundaries below,
 * and the client's slotSchedule.test.js asserts its own — change one and change
 * the other, or the dashboard starts locking rows the score has not penalised.
 *
 * TIME ZONES
 * A window belongs to the user's day, so it is judged against the user's own
 * clock — which the browser reports in `X-Client-Timezone` (see routes/dashboard
 * → timezoneFor). Judging it in UTC instead would close windows early for
 * anyone west of Greenwich and punish them for a morning dose they had not yet
 * had the chance to take. When the zone is unknown this module fails OPEN:
 * nothing is treated as missed, so the worst case is a late penalty rather than
 * a wrongful one.
 */

const { timeSlotFromText } = require('./dailyScheduleSlots');
// The zone-aware clock lives with the day-boundary rule that owns it
// (utils/planDay.js), so there is exactly one `Intl` reader in the server.
const { cleanTimeZone, zonedNowParts } = require('./planDay');

/** Minutes from local midnight. End is EXCLUSIVE, so a window is half-open:
 *  morning's end of 720 means 11:59:59 is the last second inside it. */
const SLOT_WINDOWS = {
  // Morning opens at 4:00 AM — the same boundary the client calls the end of its
  // dead hours, so the two rulebooks butt against each other with no gap.
  morning: { start: 4 * 60, end: 12 * 60 },
  afternoon: { start: 12 * 60, end: 18 * 60 },
  evening: { start: 18 * 60, end: 22 * 60 },
  night: { start: 22 * 60, end: 24 * 60 },
};

/** Slot keys that carry a window. `anytime` is deliberately absent. */
const TIMED_SLOTS = Object.keys(SLOT_WINDOWS);

/** Where Anytime doses are finally held to account: the end of the last window
 *  a plan actually uses, or 10:00 PM for a plan that has no timed doses at all.
 *
 *  WHY ANYTIME NEEDS A DEADLINE
 *  "Anytime" has no window, so the client never marks it missed — which is right
 *  for drawing a row, and useless for scoring. A plan whose AI output names no
 *  time of day at all (every recommendation defaults to "Anytime") would
 *  otherwise never lose a single point for a day of taking nothing, which is the
 *  exact opposite of what this feature is for. So an Anytime dose stays free
 *  until the day's own timed frames have closed, and is then held to account
 *  like any other. */
const ANYTIME_FALLBACK_DEADLINE = SLOT_WINDOWS.evening.end;

const WINDOW_STATE = {
  UPCOMING: 'upcoming',
  OPEN: 'open',
  CLOSED: 'closed',
  /** No window at all — Anytime, or a slot this build does not know. */
  ALWAYS: 'always',
};

const KNOWN_SLOT_KEYS = new Set([...TIMED_SLOTS, 'anytime']);

const asText = (value) => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
};

/**
 * Minutes since local midnight in `timeZone`.
 *
 * Delegates to `zonedNowParts`, which is the single reader of the user's wall
 * clock — the same one that decides which plan day it is (utils/planDay.js).
 * Having two readers would let the dose windows and the day they belong to come
 * from different clocks, which is precisely the class of bug that put a 4 AM
 * reset on a midnight-UTC boundary.
 *
 * @returns {number|null} null only when the INSTANT is unusable. A missing or
 *   unrecognised zone deliberately returns null too, so every caller here keeps
 *   its fail-OPEN behaviour: nothing is treated as missed rather than being
 *   scored against a guess.
 */
function localMinutesOfDay(now = new Date(), timeZone = '') {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  if (!cleanTimeZone(timeZone)) return null;
  const parts = zonedNowParts(date, timeZone);
  return parts ? parts.minutes : null;
}

/** The window for a slot key, or null when it has none. */
function windowFor(slotKey) {
  return SLOT_WINDOWS[asText(slotKey).toLowerCase()] || null;
}

/**
 * A time slot's state at a given minute of the user's day.
 * @returns {'upcoming'|'open'|'closed'|'always'}
 */
function windowStateForSlot(slotKey, minutes) {
  const window = windowFor(slotKey);
  if (!window) return WINDOW_STATE.ALWAYS;
  // An unusable clock fails OPEN: refusing to lock anybody out of their own plan
  // is worth more than a penalty that is a few hours early.
  if (!Number.isFinite(minutes)) return WINDOW_STATE.ALWAYS;
  if (minutes < window.start) return WINDOW_STATE.UPCOMING;
  if (minutes < window.end) return WINDOW_STATE.OPEN;
  return WINDOW_STATE.CLOSED;
}

/**
 * The slot a stored intake record belongs to.
 *
 * `timeSlot` is what the plan resolution wrote at seed time and is exact;
 * `scheduledTime` is the free text it was derived from and is the fallback for
 * rows created before the field existed (and for anything added by hand). An
 * unplaceable supplement is `anytime`, never null — the same floor the client
 * uses, so a row cannot silently vanish from scoring.
 */
function slotKeyForRecord(record) {
  const explicit = asText(record && record.timeSlot).toLowerCase();
  if (KNOWN_SLOT_KEYS.has(explicit)) return explicit;
  const fromText = timeSlotFromText(record && record.scheduledTime);
  return fromText || 'anytime';
}

/**
 * Split one day of intake records into what the score may and may not judge.
 *
 * @param {Array} records            Today's IntakeRecords.
 * @param {{now?: Date, timeZone?: string}} [options]
 * @returns {{
 *   total: number, taken: number, missed: number, awaiting: number,
 *   decided: number, adherence: number
 * }}
 *
 *   total    — every dose in today's plan.
 *   taken    — ticked, whenever it was ticked. Late counts. This is the whole
 *              point: `isTakenLate` is a badge for the UI, never a penalty.
 *   missed   — unticked AND its window has closed. The only thing that costs points.
 *   awaiting — unticked but still takeable on time. Counted, shown, and free.
 *   adherence— taken / decided, or 100 when nothing has closed yet. A morning
 *              where the afternoon has not arrived must not read as a failure.
 */
function evaluateToday(records, { now = new Date(), timeZone = '' } = {}) {
  const list = Array.isArray(records) ? records : [];
  const minutes = localMinutesOfDay(now, timeZone);

  const rows = list.map((record) => ({ record, slot: slotKeyForRecord(record) }));

  // When the day's own timed frames are all behind us. Drives Anytime, which
  // has no window of its own to close.
  const timedEnds = rows
    .filter(({ slot }) => windowFor(slot))
    .map(({ slot }) => SLOT_WINDOWS[slot].end);
  const anytimeDeadline = timedEnds.length > 0 ? Math.max(...timedEnds) : ANYTIME_FALLBACK_DEADLINE;

  const missedSlots = [];
  let taken = 0;
  let missed = 0;
  let awaiting = 0;

  for (const { record, slot } of rows) {
    if (record && record.taken) {
      taken += 1;
      continue;
    }
    const window = windowFor(slot);
    const closed = window
      ? windowStateForSlot(slot, minutes) === WINDOW_STATE.CLOSED
      : Number.isFinite(minutes) && minutes >= anytimeDeadline;

    if (closed) {
      missed += 1;
      missedSlots.push({ id: record?._id, name: record?.supplementName, slot });
    } else {
      awaiting += 1;
    }
  }

  const decided = taken + missed;
  return {
    total: rows.length,
    taken,
    missed,
    awaiting,
    decided,
    // No window has closed yet, so nothing has been lost yet: 100, not 0.
    adherence: decided > 0 ? Math.round((taken / decided) * 100) : 100,
    missedSlots,
  };
}

module.exports = {
  SLOT_WINDOWS,
  TIMED_SLOTS,
  WINDOW_STATE,
  ANYTIME_FALLBACK_DEADLINE,
  // Re-exported rather than redefined: the zone validator is shared with
  // utils/planDay.js, and routes/dashboard.js imports it from here.
  cleanTimeZone,
  localMinutesOfDay,
  windowFor,
  windowStateForSlot,
  slotKeyForRecord,
  evaluateToday,
};