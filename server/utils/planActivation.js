/**
 * When did this plan arrive, and which of today's windows may it be held to?
 *
 * Run: node --test "Test File/plan-activation.test.js"
 *
 * THE BUG THIS EXISTS TO CLOSE
 * An assessment completed at 3:00 PM produces a plan whose Morning stack had
 * already had its window — 04:00 to 12:00 — close hours before the user ever saw
 * it. Nothing in the rulebook knew the plan had not existed, so on the very first
 * dashboard load:
 *
 *   - GET /api/dashboard seeded today's rows for the whole plan (correct — those
 *     rows exist so the day can be recorded), and
 *   - evaluateToday judged the Morning rows against a window that had closed
 *     before the plan was born, so they were counted MISSED immediately;
 *   - the Wellness Score took the hit, dragging `adherenceRate` and the 60%
 *     "today" term with it;
 *   - the tracker's own copy of the rulebook (my-react-app/src/utils/
 *     slotSchedule.js) put the same rows in the red "Today Missed" tray;
 *   - the missed-day backfill would have judged the same day again if the user
 *     never came back, so the penalty outlived the session that caused it.
 *
 * A brand-new plan charging its owner for a morning they could not have known
 * about is the exact opposite of what a plan is for.
 *
 * THE RULE
 * A plan is held to a window only from the moment it existed. On the plan day the
 * assessment was created, every window that had ALREADY closed is exempt: those
 * doses stay visible and recordable, but can never read as missed. From the next
 * plan day the whole plan is judged normally — so an assessment created in the
 * afternoon activates in full from tomorrow morning.
 *
 * WHAT THAT MEANS FOR TODAY'S PLAN (`deferredSlotsOnDay`)
 * "Cannot be charged" is half of it. A dose the user is never charged for, but is
 * still asked to take at 3 PM for a window that shut at noon, is still a red item
 * on a list they cannot finish. So the frames named here are also the frames the
 * plan is NOT written into today: today's rows carry only what the day can still
 * be judged on, and the rest is presented as starting at the next 4 AM reset —
 * which is when it becomes ordinary, chargeable work. `anytime` is deliberately
 * never deferred: it has no window to have missed, and "anytime" includes now.
 *
 * TWO DELIBERATE CHOICES
 *
 *   PER WINDOW, NOT PER DAY. Created at 3:00 PM, Afternoon (12:00–18:00) is still
 *   open and Evening has not opened, so only Morning is exempt. The user can
 *   still take the rest of today's plan instead of being told to wait a day for a
 *   plan they have just made.
 *
 *   ANYTIME JOINS THE EXEMPT LIST. "Anytime" has no window of its own; it is held
 *   to the end of the day's timed frames (utils/intakeWindows.js). Once one of
 *   those frames has closed without the plan existing, that anchor is already
 *   behind the user and there is nothing left to hold the day to — so on a plan's
 *   first, partial day Anytime is free. Tomorrow the normal deadline applies,
 *   which is what stops "Anytime" from becoming a permanent free pass.
 *
 * WHY IT IS A SEPARATE FILE
 * The rule needs the window table (utils/intakeWindows.js), the plan-day rule and
 * the zone-aware clock (utils/planDay.js). Only utils/dashboard.js calls it, and
 * it calls it ONCE per request so every number in a response is judged against
 * one activation — the same reason the day and the zone are resolved once at the
 * top of that handler. utils/intakeWindows.js deliberately does NOT import this:
 * the dependency runs one way, so there is no require cycle between the two
 * rulebooks, and `evaluateToday` stays importable (and testable) on its own.
 *
 * WHEN THE ACTIVATION IS NOT KNOWABLE
 * A missing or unparseable `createdAt` yields no grace and no day key, which is
 * deliberately the OLD behaviour: today's plan is judged by its own windows and
 * nothing is backfilled. It is the only answer that cannot hand a user a free
 * pass for the rest of their life, because the exemption is anchored to exactly
 * one plan day — a bad read of the activation cannot leak past the 4 AM reset.
 */

const { SLOT_WINDOWS, TIMED_SLOTS } = require('./intakeWindows');
const { planDayKey, shiftDayKey, zonedNowParts } = require('./planDay');

/** The slot with no window of its own. See the note about the deadline above. */
const ANYTIME_SLOT = 'anytime';

/** Day keys are zero-padded YYYY-MM-DD, so this is enough to trust one. */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A usable instant, or null. Never throws on junk — this runs on a request path. */
const asDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const asText = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

/** The shape returned when the plan's arrival cannot be read at all. */
const UNKNOWN_ACTIVATION = Object.freeze({
  activatedAt: null,
  activatedDayKey: '',
  activatedMinutes: null,
  graceSlots: Object.freeze([]),
  isGraceDay: false,
  firstJudgedDayKey: '',
});

/**
 * When a plan came into existence, and what it may be held to today.
 *
 * @param {{createdAt?: Date|string|number, timeZone?: string}} [options]
 *   `createdAt` — the assessment's creation instant. Read on the user's own
 *                 clock, because "3:00 PM" has to mean 3:00 PM where they are.
 *   `timeZone`  — IANA zone, as resolved by routes/dashboard.js → timezoneFor.
 *                 A zone this build cannot understand falls back to UTC inside
 *                 `zonedNowParts`, which is the same fallback the plan day and
 *                 the dose windows already use — so all three keep agreeing.
 * @returns {{
 *   activatedAt: Date|null,
 *   activatedDayKey: string,
 *   activatedMinutes: number|null,
 *   graceSlots: readonly string[],
 *   isGraceDay: boolean,
 *   firstJudgedDayKey: string
 * }}
 */
function resolvePlanActivation({ createdAt, timeZone = '' } = {}) {
  const activatedAt = asDate(createdAt);
  if (!activatedAt) return UNKNOWN_ACTIVATION;

  const activatedDayKey = planDayKey(activatedAt, timeZone);
  const parts = zonedNowParts(activatedAt, timeZone);
  const activatedMinutes = parts ? parts.minutes : null;

  // No readable clock means no window can be shown to have closed, so nothing is
  // exempt — the same fail-OPEN the dose windows use for an unusable zone
  // (utils/intakeWindows.js → localMinutesOfDay returns null, nothing closes).
  const closed = Number.isFinite(activatedMinutes)
    ? TIMED_SLOTS.filter((slotKey) => SLOT_WINDOWS[slotKey].end <= activatedMinutes)
    : [];

  const isGraceDay = closed.length > 0;
  // `shiftDayKey` only fails on a key it cannot parse, and planDayKey always
  // returns one; the fallback keeps the return value total regardless.
  const firstJudgedDayKey = isGraceDay ? (shiftDayKey(activatedDayKey, 1) || activatedDayKey) : activatedDayKey;

  return Object.freeze({
    activatedAt,
    activatedDayKey,
    activatedMinutes,
    graceSlots: Object.freeze(isGraceDay ? [...closed, ANYTIME_SLOT] : []),
    isGraceDay,
    firstJudgedDayKey,
  });
}

/**
 * The frames a plan must NOT be written into for `dayKey`, as a Set of slot keys.
 *
 * Only the plan's own, partial day defers anything, and only the TIMED frames:
 * `anytime` has no window that could have closed before the plan existed, so its
 * doses are today's work like any other. An unreadable activation — no day key,
 * or one belonging to another day — defers nothing, which is the same fail-
 * CLOSED the exemption itself uses: a stale block cannot blank a day out.
 *
 * @param {object} activation From `resolvePlanActivation`.
 * @param {string} dayKey     The plan day being written, YYYY-MM-DD.
 * @returns {Set<string>}
 */
function deferredSlotsOnDay(activation, dayKey) {
  const out = new Set();
  if (!activation || typeof activation !== 'object') return out;

  const activatedDayKey = asText(activation.activatedDayKey);
  if (!DAY_KEY_RE.test(activatedDayKey)) return out;
  if (activatedDayKey !== asText(dayKey)) return out;

  const slots = Array.isArray(activation.graceSlots) ? activation.graceSlots : [];
  for (const slot of slots) {
    const key = asText(slot).toLowerCase();
    if (TIMED_SLOTS.includes(key)) out.add(key);
  }
  return out;
}

/**
 * The activation, shaped for the API.
 *
 * The tracker lays the plan out from its OWN copy of the rulebook
 * (my-react-app/src/utils/slotSchedule.js), so it needs to know which frames the
 * server forgave rather than re-deriving it — otherwise the score would say
 * "nothing missed" above a red "Today Missed" tray. Sending the answer is also
 * why the two sides cannot disagree about the plan's first, partial day.
 *
 * `activatedAt` goes out as an ISO string, and `null` for the unknown case, so a
 * client that ignores this block behaves exactly as it did before.
 *
 * @param {object} activation From `resolvePlanActivation`.
 */
function planActivationPayload(activation) {
  const safe = activation && typeof activation === 'object' ? activation : UNKNOWN_ACTIVATION;
  return {
    activatedAt: safe.activatedAt instanceof Date ? safe.activatedAt.toISOString() : null,
    activatedDayKey: safe.activatedDayKey || '',
    activatedMinutes: Number.isFinite(safe.activatedMinutes) ? safe.activatedMinutes : null,
    graceSlots: Array.isArray(safe.graceSlots) ? [...safe.graceSlots] : [],
    isGraceDay: !!safe.isGraceDay,
    firstJudgedDayKey: safe.firstJudgedDayKey || '',
  };
}

module.exports = {
  ANYTIME_SLOT,
  DAY_KEY_RE,
  UNKNOWN_ACTIVATION,
  resolvePlanActivation,
  deferredSlotsOnDay,
  planActivationPayload,
};
