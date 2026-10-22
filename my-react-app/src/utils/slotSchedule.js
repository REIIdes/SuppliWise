/**
 * Time windows for "Today's Supplements" — when a part of day is open, and
 * when it has closed for good.
 *
 * Run: node --test src/utils/slotSchedule.test.js
 *
 * THE RULE THIS ENCODES
 *
 *   A WINDOW CLOSING MARKS A CATEGORY MISSED — IT DOES NOT HIDE WHAT HAPPENED,
 *   AND IT DOES NOT PREVENT A LATE ENTRY.
 *
 * The three states, in the order they are evaluated:
 *
 *   upcoming — the window has not opened yet. Nothing is late, so nothing is
 *              missed. The user may still tick ahead (a 4am dose is a real dose).
 *   open     — inside the window. Normal state; tick freely.
 *   locked   — the window has closed. Whatever is still unticked is now marked
 *              MISSED and the row is visually closed.
 *
 * WHY MISSED IS NOT "BLOCKED"
 * A hard block would mean a forgotten dose could never be recorded, so that day
 * could never reach 100% and the user's streak would break over an alarm that
 * did not go off. Locking is a statement about the past ("this window is gone"),
 * not a punishment, so a locked row still offers a late entry and the day can
 * still be completed honestly.
 *
 * WHY "MISSED" NEEDS PENDING ITEMS TO SURVIVE
 * `locked` alone is not enough: a window that closed with everything ticked is a
 * SUCCESS, and labelling it "Missed" would be plainly wrong. Missed is therefore
 * derived — window closed AND something is still unticked.
 *
 * TIME ZONES
 * All of this is computed from the browser's local clock, because the window
 * belongs to the user's day, not the server's. A server-side check would lock a
 * user out at the wrong hour for most of the planet. The client is therefore
 * also the only place these windows are enforced — which is a real limitation,
 * not an oversight (see the note at the bottom of this file).
 *
 * THE EXCEPTION: A PLAN IS NOT HELD TO A WINDOW THAT PREDATES IT
 * A plan created at 3:00 PM arrives with a Morning stack whose window closed at
 * noon. Judged by the rule above, those doses are `locked`, so they are marked
 * MISSED and dropped into the red "Today Missed" tray — for a morning that ended
 * before the user had ever seen the plan, and directly underneath a wellness
 * score that had just been docked for it.
 *
 * So the server sends what it forgave (`planActivation.graceSlots`, resolved in
 * server/utils/planActivation.js) and a forgiven frame is treated as OPEN here.
 * The client does not re-derive it: `X-Client-Timezone` is this browser's own
 * zone, so a locally-derived answer could only ever agree by luck, and one
 * disagreement shows up as a score that says "nothing missed" above a red tray.
 * The exemption is anchored to the plan day the plan arrived on, so it expires
 * by itself at the 4 AM reset and the whole plan is judged normally from then on.
 */

/** Minutes from local midnight. End is EXCLUSIVE, so a window is half-open:
 *  morning's end of 720 means 11:59:59 is the last second inside it. */
export const SLOT_WINDOWS = {
  // Morning opens at 4:00 AM, the exact minute the dead hours end. They butt
  // against each other on purpose: 00:00–03:59 is the pause, 04:00 is the
  // reset, and there is no gap where the user has a day but nowhere to put it.
  morning: { start: 4 * 60, end: 12 * 60, opensAt: '4:00 AM', closesAt: '12:00 PM' },
  afternoon: { start: 12 * 60, end: 18 * 60, opensAt: '12:00 PM', closesAt: '6:00 PM' },
  evening: { start: 18 * 60, end: 22 * 60, opensAt: '6:00 PM', closesAt: '10:00 PM' },
  night: { start: 22 * 60, end: 24 * 60, opensAt: '10:00 PM', closesAt: '12:00 AM' },
};

/** No window at all: always tickable, never marked missed. */
export const ALWAYS_OPEN = 'always';

export const WINDOW_STATE = {
  UPCOMING: 'upcoming',
  OPEN: 'open',
  LOCKED: 'locked',
  ALWAYS: ALWAYS_OPEN,
};

/**
 * The dead hours: midnight until 4:00 AM, half-open like every window here.
 *
 * WHY THEY EXIST SEPARATELY FROM THE WINDOWS
 * A time window answers "when should this be taken". The dead hours answer a
 * different question — "is this a sane hour to be recording a dose at all".
 * They therefore cut across every category, INCLUDING Anytime, which otherwise
 * never locks: a 2:00 AM entry is mistimed no matter which slot it belongs to.
 *
 * The boundary is 04:00, not 04:59, matching how the other ranges in this file
 * are written (a window ends when the next one opens).
 *
 * WHAT DEAD HOURS ARE NOT
 * They are NOT "missed". Nothing has been late at 2 AM — Morning has not even
 * opened yet, so there is no window to have missed. Labelling a plan "Missed"
 * because the user happened to be awake would be a false statement about their
 * day, and it is why `isMissed` below deliberately ignores dead hours. This is
 * a lock, not an accusation.
 */
export const DEAD_HOURS = { start: 0, end: 4 * 60, endsAt: '4:00 AM' };

/**
 * The heading above the tray of doses whose window has closed.
 *
 * The page this lives on only ever shows ONE day — today's — so the day name is
 * a constant here rather than a parameter threaded through the call site. It is
 * exported so the wording can change in one place rather than in two page
 * components.
 */
export const MISSED_TRAY_TITLE = 'Today Missed';

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
 * Minutes since local midnight for a Date.
 *
 * Reads the local getters rather than deriving from a UTC timestamp, so a user
 * in UTC+5:30 gets their own 6:00 PM, not a shifted one. Seconds are dropped:
 * a window boundary is a minute-resolution concept.
 */
export function minutesOfDay(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  return date.getHours() * 60 + date.getMinutes();
}

/** Slot keys this build understands, `anytime` included. */
const KNOWN_SLOT_KEYS = new Set([...Object.keys(SLOT_WINDOWS), 'anytime']);

/** Day keys are zero-padded YYYY-MM-DD, so this is enough to trust one. */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The frames this plan is not held to on the plan day it arrived on.
 *
 * `activation` is `planActivation` from GET /api/dashboard, resolved by
 * utils/planActivation.js on the server. Only `activatedDayKey` and
 * `graceSlots` are read, so an older server — or a client that drops the block
 * — simply gets an empty list and the behaviour that has always existed.
 *
 * WHY THE DAY KEY IS RE-CHECKED HERE
 * The block describes ONE plan day. Comparing it against the day being drawn is
 * what stops a tab left open across the 4 AM reset from forgiving tomorrow's
 * missed morning with yesterday's plan: the keys stop matching, the list empties,
 * and the frame is judged normally again. It is also the only guard against a
 * stale payload, and it costs one string comparison.
 *
 * @param {{activatedDayKey?: string, graceSlots?: string[]}|null} activation
 * @param {Date} [now] The plan day being drawn — always the live day here.
 * @returns {string[]} slot keys, lowercase, deduped. Empty when there is no
 *   exemption to apply, which is every day but a plan's first.
 */
export function graceSlotsFor(activation, now = new Date()) {
  if (!activation || typeof activation !== 'object') return [];

  const activatedDayKey = asText(activation.activatedDayKey);
  if (!DAY_KEY_RE.test(activatedDayKey)) return [];
  if (activatedDayKey !== getPlanDayKey(now)) return [];

  const slots = Array.isArray(activation.graceSlots) ? activation.graceSlots : [];
  const exempt = [];
  for (const slot of slots) {
    const key = asText(slot).toLowerCase();
    if (KNOWN_SLOT_KEYS.has(key) && !exempt.includes(key)) exempt.push(key);
  }
  return exempt;
}

/**
 * Normalise whatever a caller passed as "the frames to forgive" into a Set.
 *
 * Accepts the server's `planActivation` block, a plain array of slot keys, or a
 * Set, so `layoutPlan`, `sectionPlacement` and `slotSectionState` can each be
 * called by a page or a test with whichever is to hand. Returns null for
 * "nothing is forgiven", which is the cheap path and the one every existing
 * caller takes.
 */
function toGraceSet(options) {
  if (!options) return null;

  const slots = options instanceof Set
    ? [...options]
    : Array.isArray(options)
      ? options
      : (Array.isArray(options.graceSlots) ? options.graceSlots : null);
  if (!slots || slots.length === 0) return null;

  const exempt = new Set();
  for (const slot of slots) {
    const key = asText(slot).toLowerCase();
    if (KNOWN_SLOT_KEYS.has(key)) exempt.add(key);
  }
  return exempt.size > 0 ? exempt : null;
}

/**
 * A slot's state, honouring a plan's arrival.
 *
 * A forgiven frame reads OPEN whatever the clock says. That is the whole point:
 * the window is genuinely over, but the plan did not exist while it was, so
 * nothing about the frame can be "locked" or "missed" today. Anything else would
 * mean a fourth state, and every consumer here already knows what to do with an
 * open frame — draw it, let it be ticked, count it as work to do.
 */
function placementState(slotKey, now, grace) {
  if (grace && grace.has(asText(slotKey).toLowerCase())) return WINDOW_STATE.OPEN;
  return windowState(slotKey, now);
}

/** The window for a slot key, or null when it has none (Anytime). */
export function windowFor(slotKey) {
  return SLOT_WINDOWS[asText(slotKey).toLowerCase()] || null;
}

/**
 * Time left until `targetMinutes`, as whole minutes past local midnight.
 *
 * Used for the countdowns the dead hours show on every field. Fails OPEN
 * (`isDue: true`) on an unusable clock, so a bad Date reads as "shortly" rather
 * than showing a nonsensical negative countdown.
 *
 * Never returns a negative remainder: a target earlier in the day than `now`
 * reads as due, because the alternative is a countdown counting UP.
 */
export function countdownTo(targetMinutes, now = new Date()) {
  const minutes = minutesOfDay(now);
  if (minutes === null) return { hours: 0, minutes: 0, total: 0, isDue: true, text: 'shortly' };

  const remaining = Math.max(0, targetMinutes - minutes);
  const hours = Math.floor(remaining / 60);
  const mins = remaining % 60;

  return {
    hours,
    minutes: mins,
    total: remaining,
    isDue: remaining === 0,
    // "2h 14m", "14m". An exact hour drops the minutes rather than reading
    // "2h 0m", which looks like a rendering bug.
    text: remaining === 0 ? 'now' : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`,
  };
}

/** The moment a slot's field becomes available, for its countdown. */
function opensAtMinutes(slotKey) {
  const window = windowFor(slotKey);
  // Anytime has no window of its own, so it opens when the day does.
  return window ? window.start : DEAD_HOURS.end;
}

/**
 * The dead-hours view: every field listed, every one of them empty.
 *
 * WHY SHOW EMPTY FIELDS AT ALL
 * Hiding the plan for four hours leaves the user staring at nothing, with no way
 * to tell whether the app is broken or they simply have nothing due. Listing
 * every field with a countdown to when it opens answers that — without offering
 * a single button, which is the whole point of the pause.
 */
export function deadHourPlaceholders(groups, now = new Date()) {
  const list = Array.isArray(groups) ? groups : [];
  return list.map((group) => {
    const key = asText(group?.key).toLowerCase();
    const items = Array.isArray(group?.items) ? group.items : [];
    const window = windowFor(key);
    return {
      key,
      label: asText(group?.label),
      // Carried through only so the header can say how much is waiting. The
      // rows themselves are never rendered during the dead hours.
      total: items.length,
      window: windowLabel(key),
      opensAt: window ? window.opensAt : DEAD_HOURS.endsAt,
      countdown: countdownTo(opensAtMinutes(key), now),
    };
  });
}

/**
 * Whether a recorded dose was taken OUTSIDE its own window.
 *
 * This is a statement about the timestamp, not about the current time: a dose
 * ticked at 2 AM for a 10 PM–midnight slot was taken late, and one ticked
 * normally this afternoon was not — even though both would otherwise read
 * "Taken".
 *
 * GRACE PERIOD FOR NEW ASSESSMENTS:
 * If a supplement was added to the plan TODAY (same plan day, checked against
 * the 4:00 AM boundary), it can NEVER be marked as "late" regardless of when
 * it's taken. This prevents the confusing case where a user completes an
 * assessment in the afternoon, gets morning supplements added to their plan,
 * and immediately sees "Took it Late" when they mark them as taken.
 * The "late" label only applies starting from the NEXT plan day (after 4:00 AM).
 *
 * Anytime can never be late, because it has no window. Without that exemption a
 * supplement with no schedule would be permanently branded as late, which is
 * meaningless and the fastest way to make a status word get ignored.
 *
 * Fails OPEN when the timestamp is missing or unparseable: an absent `takenAt`
 * is not evidence of lateness, and inventing a "Late" badge from it would brand
 * honest doses wrongly.
 */
export function isTakenLate(item, slotKey) {
  const window = windowFor(slotKey);
  // No window (Anytime, or a slot this client does not know) → never late.
  if (!window) return false;
  if (!item?.taken) return false;

  let takenAt;
  try {
    takenAt = new Date(item.takenAt);
  } catch {
    return false;
  }
  if (!item.takenAt || Number.isNaN(takenAt.getTime())) return false;

  // Grace period: if this supplement was added today (same plan day), never mark as late
  if (item.createdAt) {
    try {
      const createdAt = new Date(item.createdAt);
      if (!Number.isNaN(createdAt.getTime())) {
        // Check if created and taken on the same plan day
        // Plan day changes at 4:00 AM, so we need to compare adjusted dates
        const createdPlanDay = getPlanDayKey(createdAt);
        const takenPlanDay = getPlanDayKey(takenAt);
        
        // If added today (same plan day), never mark as late
        if (createdPlanDay === takenPlanDay) {
          return false;
        }
      }
    } catch {
      // If createdAt parsing fails, continue with normal late check
    }
  }

  // Local minutes, so "taken at 1:03 AM" is read against the user's own clock
  // rather than a UTC one the user never sees.
  const minutes = takenAt.getHours() * 60 + takenAt.getMinutes();
  return minutes < window.start || minutes >= window.end;
}

/**
 * Get the plan day key for a given date, adjusted for the 4:00 AM boundary.
 * Dates between midnight and 3:59 AM belong to the PREVIOUS plan day.
 * 
 * @param {Date} date - The date to get the plan day for
 * @returns {string} Plan day key in YYYY-MM-DD format
 */
function getPlanDayKey(date) {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const minutesOfDay = hours * 60 + minutes;
  
  // If before 4:00 AM (240 minutes), use previous calendar day
  const adjustedDate = new Date(date);
  if (minutesOfDay < 240) {
    adjustedDate.setDate(adjustedDate.getDate() - 1);
  }
  
  // Return YYYY-MM-DD format
  const year = adjustedDate.getFullYear();
  const month = String(adjustedDate.getMonth() + 1).padStart(2, '0');
  const day = String(adjustedDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Whether a slot's window is upcoming, open, or closed at `now`.
 * @returns {'upcoming'|'open'|'locked'|'always'}
 */
export function windowState(slotKey, now = new Date()) {
  const window = windowFor(slotKey);
  if (!window) return ALWAYS_OPEN;

  const minutes = minutesOfDay(now);
  // An unparseable clock must not lock anybody out of their own plan.
  if (minutes === null) return ALWAYS_OPEN;

  if (minutes < window.start) return WINDOW_STATE.UPCOMING;
  if (minutes < window.end) return WINDOW_STATE.OPEN;
  return WINDOW_STATE.LOCKED;
}

/** "5:00 AM – 12:00 PM", for the section header. Empty for Anytime. */
export function windowLabel(slotKey) {
  const window = windowFor(slotKey);
  return window ? `${window.opensAt} – ${window.closesAt}` : '';
}

/**
 * Whether `now` falls in the dead hours (midnight → 4:00 AM).
 *
 * Fails OPEN, like everything else here: an unusable clock must not lock a user
 * out of their own plan. The cost is a dead-hour window that lasts a minute or
 * two longer; the cost of failing closed is somebody unable to record a dose.
 */
export function isDeadHour(now = new Date()) {
  const minutes = minutesOfDay(now);
  if (minutes === null) return false;
  return minutes >= DEAD_HOURS.start && minutes < DEAD_HOURS.end;
}

/**
 * Everything the UI needs to render one time-slot section.
 *
 * @param {{key: string, items: Array}} group  A group from groupBySlot().
 * @param {Date} now
 * @returns {{
 *   key: string, state: string, label: string, window: string,
 *   total: number, taken: number, pending: number,
 *   isMissed: boolean, isComplete: boolean, isLocked: boolean,
 *   isDeadHour: boolean, isTickable: boolean,
 *   canTick: boolean, canTickAll: boolean
 * }}
 *
 * `canTick` is deliberately true even when locked: see the note at the top of
 * this file about late entries.
 *
 * @param {{key: string, items: Array}} group  A group from groupBySlot().
 * @param {Date} now
 * @param {object|Array|Set|null} [grace] Frames this plan is not held to — the
 *   server's `planActivation`, a list of slot keys, or a Set. Omit it and the
 *   section behaves exactly as it always has.
 */
export function slotSectionState(group, now = new Date(), grace = null) {
  const items = Array.isArray(group?.items) ? group.items : [];
  const key = asText(group?.key).toLowerCase();
  const exempt = toGraceSet(grace);
  const state = placementState(key, now, exempt);

  const taken = items.filter((item) => item?.taken).length;
  const pending = items.length - taken;

  // The two reasons a section closes, kept apart because they mean different
  // things to the user: `windowClosed` is "you ran out of time today",
  // `deadHour` is "this is the middle of the night".
  const windowClosed = state === WINDOW_STATE.LOCKED;

  // The dead hours deliberately skip Anytime. It is the one exemption asked for:
  // a supplement with no time of day must never become impossible to record,
  // because "any time" means any time — including 2 AM.
  const deadHour = isDeadHour(now) && windowFor(key) !== null;
  const isLocked = windowClosed || deadHour;

  return {
    key,
    label: asText(group?.label),
    window: windowLabel(key),
    total: items.length,
    taken,
    pending,
    // Missed requires something still unticked AND a window that actually
    // closed. A closed window with everything ticked is a completed day, and
    // calling that "Missed" would be a lie. Dead hours are excluded entirely:
    // at 2 AM nothing has been missed, because nothing was ever due.
    isMissed: windowClosed && pending > 0,
    isComplete: items.length > 0 && pending === 0,
    isLocked,
    isDeadHour: deadHour,
    // A finished section is never tickable, so it never reads as locked either —
    // otherwise a completed Morning would show "locked" at 3 AM.
    isTickable: pending > 0,
    // Late entries stay allowed even when locked.
    canTick: true,
    canTickAll: pending > 0,
    state,
  };
}

/**
 * Where a section belongs in the page, given the time.
 *
 *   'active'   — its window is open right now. THE ONLY timed frame on screen.
 *   'anytime'  — no window at all. Always shown, never locks, never hides.
 *   'missed'   — the window closed with something unticked; its unticked rows
 *                drop into the "Today Missed" tray.
 *   'hidden'   — not open yet, or closed with everything ticked. The frame is
 *                simply not on the page.
 */
export const SECTION_PLACEMENT = {
  ACTIVE: 'active',
  ANYTIME: 'anytime',
  MISSED: 'missed',
  HIDDEN: 'hidden',
};

/**
 * Whether a timed frame should be treated as already closed.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * The server keys days off UTC (`toISOString().split('T')[0]`) while these
 * windows are judged against the browser's LOCAL clock. For a user east of UTC
 * those disagree by up to half a day: someone in UTC+5:30 whose clock reads
 * 02:30 on 2 October is being served records for 1 October — a day whose
 * Morning, Afternoon and Evening frames all closed hours ago.
 *
 * Read purely off the local clock, every timed frame at 02:30 is "upcoming"
 * (Morning does not open until 05:00), so yesterday's unticked doses would be
 * HIDDEN rather than shown in the tray — a whole day of the user's plan quietly
 * disappearing off the page.
 *
 * So during the dead hours we ask a second question: has this day already run?
 * A frame with at least one ticked row is proof that it did, whatever the clock
 * says, and a closed frame that still has unticked rows belongs in the tray.
 *
 * A frame with nothing ticked stays hidden — which is the correct reading for a
 * genuinely fresh day that simply has not started yet.
 */
function treatAsClosed(group, now, grace = null) {
  const exempt = toGraceSet(grace);
  const state = placementState(asText(group?.key).toLowerCase(), now, exempt);
  if (state === WINDOW_STATE.LOCKED) return true;
  if (state !== WINDOW_STATE.UPCOMING) return false;

  if (!isDeadHour(now)) return false;

  const items = Array.isArray(group?.items) ? group.items : [];
  // Any ticked row means the day genuinely ran — so treat the frame as closed.
  return items.some((item) => item?.taken);
}

/** Whether a timed frame's window has closed for the day being shown. */
export function frameHasClosed(group, now = new Date(), grace = null) {
  return treatAsClosed(group, now, grace);
}

/**
 * Which section a group belongs in right now.
 *
 * @param {object} group From groupBySlot().
 * @param {Date} now
 * @param {object|Array|Set|null} [grace] Frames this plan is not held to; see
 *   `slotSectionState`. A forgiven frame is placed as ACTIVE, never MISSED —
 *   that is the whole difference between "your plan started mid-day" and a red
 *   tray the user cannot argue with.
 */
export function sectionPlacement(group, now = new Date(), grace = null) {
  const key = asText(group?.key).toLowerCase();

  // Anytime has no window, so it is never hidden and never becomes missed. This
  // is the one category that survives every rule below.
  if (!windowFor(key)) return SECTION_PLACEMENT.ANYTIME;

  if (placementState(key, now, toGraceSet(grace)) === WINDOW_STATE.OPEN) return SECTION_PLACEMENT.ACTIVE;

  if (treatAsClosed(group, now, grace)) {
    const items = Array.isArray(group?.items) ? group.items : [];
    const pending = items.filter((item) => !item?.taken).length;
    // Closed with nothing left is a finished frame, not a missed one.
    return pending > 0 ? SECTION_PLACEMENT.MISSED : SECTION_PLACEMENT.HIDDEN;
  }
  return SECTION_PLACEMENT.HIDDEN;
}

/** The wording a page prints above a plan's forgiven frames. */
export const GRACE_NOTE =
  'Your plan started after these times had passed, so they are not counted as missed. '
  + 'Everything runs normally from tomorrow.';

/**
 * The "your plan started mid-day" note, or an empty one.
 *
 * Only reported when a forgiven frame actually has something left to take, and
 * never for a frame the plan could not have used at all. A note that appears on
 * every plan page is a note nobody reads, and one that appears over an empty
 * section is a lie.
 *
 * @param {string[]} grace     Slot keys the server forgave, or none.
 * @param {Array} [active]     The active sections, when they are known.
 * @returns {{active: boolean, frames: string[], text: string}}
 */
function graceNote(grace, active = null) {
  const frames = Array.isArray(grace) ? [...grace] : [];
  if (frames.length === 0) return { active: false, frames: [], text: '' };

  // With the layout in hand, restrict the note to frames that are actually on
  // screen AND still have something to take. `null` (the dead-hours branch, and
  // any direct caller without a layout) falls back to "the plan started late".
  const sections = Array.isArray(active) ? active : null;
  if (!sections) return { active: true, frames, text: GRACE_NOTE };

  const pending = sections
    .filter(({ group }) => frames.includes(asText(group?.key).toLowerCase()))
    .filter(({ section }) => section && section.pending > 0);
  if (pending.length === 0) return { active: false, frames: [], text: '' };

  return {
    active: true,
    frames: pending.map(({ group }) => asText(group?.key).toLowerCase()),
    text: GRACE_NOTE,
  };
}

/**
 * The whole page, laid out for a given moment.
 *
 * WHY THIS IS ONE FUNCTION
 * "Which supplements are on screen" used to be answered separately by each page,
 * and the two disagreed at the boundaries — the dashboard showed a locked
 * Morning while the tracker had already moved it to the missed tray. Deciding
 * placement in one place is what keeps the two pages honest, and it makes the
 * rule testable without rendering anything.
 *
 * @param {Array<{key: string, label: string, items: Array}>} groups From groupBySlot().
 * @param {Date} now
 * @param {{activatedDayKey?: string, graceSlots?: string[]}|null} [activation]
 *   The server's `planActivation` block. A plan created after some of its own
 *   windows had closed is not judged against those windows on its first day —
 *   see `graceSlotsFor`. Omit it and the layout is exactly what it always was.
 * @returns {{
 *   active: Array, anytime: object|null, missed: object, grace: object,
 *   completedCount: number, upcomingCount: number, deadHour: boolean, hasWork: boolean
 * }}
 */
export function layoutPlan(groups, now = new Date(), activation = null) {
  const list = Array.isArray(groups) ? groups : [];
  const deadHour = isDeadHour(now);
  // Resolved once here and handed down as a plain list, so the three decisions
  // below cannot each read the payload differently.
  const grace = graceSlotsFor(activation, now);

  const active = [];
  const missedSections = [];
  let anytime = null;
  let completedCount = 0;
  let upcomingCount = 0;

  for (const group of list) {
    const section = slotSectionState(group, now, grace);
    const placement = sectionPlacement(group, now, grace);

    if (placement === SECTION_PLACEMENT.ANYTIME) {
      // First one wins if the data somehow carries two Anytime groups; a second
      // would otherwise silently vanish.
      if (!anytime) anytime = { group, section };
      continue;
    }
    if (placement === SECTION_PLACEMENT.ACTIVE) {
      active.push({ group, section });
      continue;
    }
    if (placement === SECTION_PLACEMENT.MISSED) {
      missedSections.push({ group, section });
      continue;
    }
    // Hidden from one cause or another. The SAME `frameHasClosed` decision that
    // placed it decides whether it finished or is still to come — deriving the
    // two separately is how a merely-upcoming frame with a ticked row ended up
    // counted as a completed day.
    if (frameHasClosed(group, now, grace)) completedCount += 1;
    else upcomingCount += 1;
  }

  // Only the rows that are actually late belong in the tray. A frame that closed
  // half-ticked contributes its unticked rows and quietly leaves the ticked ones
  // to disappear — the tray is called "Missed", so a taken pill in it would be a
  // lie.
  const missedItems = missedSections.flatMap(({ group }) =>
    group.items
      .filter((item) => !item?.taken)
      .map((item) => ({
        ...item,
        missedFrom: group.label,
        // The slot KEY, not just its label: judging whether a recorded dose was
        // late needs the window, and the label is only there for printing.
        missedSlot: asText(group.key).toLowerCase(),
      })),
  );

  // During the dead hours the whole plan is presented EMPTY, with a countdown on
  // every field. Nothing is ticked, nothing is late and nothing is waiting —
  // the values computed above describe a day the user is not being shown yet,
  // and surfacing yesterday's misses here would put a red tray in front of
  // someone at 2 AM who has not been given the chance to do anything about it.
  if (deadHour) {
    return {
      active: [],
      anytime: null,
      placeholders: deadHourPlaceholders(list, now),
      missed: {
        title: MISSED_TRAY_TITLE,
        items: [],
        total: 0,
        locked: false,
        endsAt: DEAD_HOURS.endsAt,
      },
      // The note is suppressed too: it describes a day that is not on screen.
      grace: graceNote([]),
      completedCount: 0,
      upcomingCount: list.length,
      deadHour: true,
      // Nothing can be recorded, so the page must not claim there is work to do.
      hasWork: false,
    };
  }

  return {
    active,
    anytime,
    placeholders: [],
    missed: {
      title: MISSED_TRAY_TITLE,
      items: missedItems,
      total: missedItems.length,
      // Missed rows stay recordable right up to the dead hours — that is the
      // window in which saying "I took it late" is still useful. Past 04:00 the
      // previous day is closed, so the tray is presented empty rather than
      // offering a button that cannot succeed.
      locked: false,
      endsAt: DEAD_HOURS.endsAt,
    },
    // Why a closed frame is on the page as a normal, takeable section instead of
    // in the tray above. Shown only when such a frame actually has something
    // left to take, so the common case stays silent.
    grace: graceNote(grace, active),
    completedCount,
    upcomingCount,
    deadHour: false,
    // "Is there anything to do?" drives the empty state, so it must not count
    // the dead-hours lock as work.
    hasWork: active.some(({ section }) => section.pending > 0)
      || Boolean(anytime && anytime.section.pending > 0)
      || missedItems.length > 0,
  };
}
