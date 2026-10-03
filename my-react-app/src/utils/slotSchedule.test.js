/**
 * slotSchedule — time windows for Today's Supplements.
 *
 * Run: npm test
 *
 * THE TWO PROPERTIES THAT MATTER:
 *
 *   1. A CLOSED WINDOW MARKS MISSED ONLY IF SOMETHING IS STILL UNTICKED.
 *      Otherwise a window the user completed gets relabelled "Missed", which is
 *      both wrong and the fastest way to make someone distrust the tracker.
 *
 *   2. MISSED IS NOT BLOCKED. A locked row can still be ticked, so a forgotten
 *      dose can be recorded and the day can still reach 100%.
 *
 * The boundary minutes are pinned explicitly because they are the whole feature:
 * 11:59 must be inside Morning and 12:00 must not be.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_WINDOWS,
  DEAD_HOURS,
  MISSED_TRAY_TITLE,
  SECTION_PLACEMENT,
  WINDOW_STATE,
  minutesOfDay,
  windowFor,
  windowState,
  windowLabel,
  isDeadHour,
  slotSectionState,
  sectionPlacement,
  layoutPlan,
  countdownTo,
  deadHourPlaceholders,
  isTakenLate,
} from './slotSchedule.js';

/** A local Date at a given hour/minute. Local so the assertions match the clock
 *  the code reads — using UTC would pass in London and fail in Kolkata. */
const at = (hours, minutes = 0) => new Date(2026, 8, 28, hours, minutes, 0, 0);

const group = (key, items, label = key) => ({ key, label, items });

// ── The windows themselves ─────────────────────────────────────────────────

test('each slot has the window that was asked for', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(SLOT_WINDOWS).map(([k, w]) => [k, [w.start, w.end]])),
    {
      morning: [240, 720],    // 4:00 AM  – 12:00 PM
      afternoon: [720, 1080], // 12:00 PM – 6:00 PM
      evening: [1080, 1320],  // 6:00 PM  – 10:00 PM
      night: [1320, 1440],    // 10:00 PM – midnight
    },
  );
});

test('Morning opens the minute the dead hours end', () => {
  // 00:00–03:59 is the pause and 04:00 is the reset. They must butt against
  // each other exactly: a gap where the day has begun but no frame is open is
  // the one state where the user has a plan and nowhere to put it.
  assert.equal(SLOT_WINDOWS.morning.start, DEAD_HOURS.end);
});

test('Anytime has no window', () => {
  assert.equal(windowFor('anytime'), null);
  assert.equal(windowLabel('anytime'), '');
  assert.equal(windowState('anytime', at(3)), WINDOW_STATE.ALWAYS);
});

// ── minutesOfDay ───────────────────────────────────────────────────────────

test('minutesOfDay reads the local clock', () => {
  assert.equal(minutesOfDay(at(0, 0)), 0);
  assert.equal(minutesOfDay(at(9, 30)), 570);
  assert.equal(minutesOfDay(at(23, 59)), 1439);
});

test('minutesOfDay drops seconds', () => {
  assert.equal(minutesOfDay(new Date(2026, 8, 28, 9, 30, 45)), 570);
});

test('minutesOfDay reports an unusable clock as null rather than a fake time', () => {
  assert.equal(minutesOfDay(new Date('nonsense')), null);
  assert.equal(minutesOfDay(undefined), null);
});

// ── windowState: the boundaries ────────────────────────────────────────────

test('Morning is open from 4:00 AM and closes at noon', () => {
  assert.equal(windowState('morning', at(3, 59)), WINDOW_STATE.UPCOMING);
  assert.equal(windowState('morning', at(4, 0)), WINDOW_STATE.OPEN);
  assert.equal(windowState('morning', at(11, 59)), WINDOW_STATE.OPEN);
  assert.equal(windowState('morning', at(12, 0)), WINDOW_STATE.LOCKED);
  assert.equal(windowState('morning', at(23, 59)), WINDOW_STATE.LOCKED);
});

test('Afternoon runs noon to 6 PM', () => {
  assert.equal(windowState('afternoon', at(11, 59)), WINDOW_STATE.UPCOMING);
  assert.equal(windowState('afternoon', at(12, 0)), WINDOW_STATE.OPEN);
  assert.equal(windowState('afternoon', at(17, 59)), WINDOW_STATE.OPEN);
  assert.equal(windowState('afternoon', at(18, 0)), WINDOW_STATE.LOCKED);
});

test('Evening runs 6 PM to 10 PM', () => {
  assert.equal(windowState('evening', at(17, 59)), WINDOW_STATE.UPCOMING);
  assert.equal(windowState('evening', at(18, 0)), WINDOW_STATE.OPEN);
  assert.equal(windowState('evening', at(21, 59)), WINDOW_STATE.OPEN);
  assert.equal(windowState('evening', at(22, 0)), WINDOW_STATE.LOCKED);
});

test('Before Bed runs 10 PM to midnight', () => {
  assert.equal(windowState('night', at(21, 59)), WINDOW_STATE.UPCOMING);
  assert.equal(windowState('night', at(22, 0)), WINDOW_STATE.OPEN);
  assert.equal(windowState('night', at(23, 59)), WINDOW_STATE.OPEN);
});

test('the windows tile the day with no overlap and no gap after 4 AM', () => {
  // Gaps or overlaps would leave the user with no section to act on, or two
  // claiming the same supplement. Walk the whole day in 15-minute steps.
  const keys = Object.keys(SLOT_WINDOWS);
  for (let minutes = 0; minutes < 1440; minutes += 15) {
    const now = new Date(2026, 8, 28, 0, 0, 0, 0);
    now.setMinutes(minutes);
    const open = keys.filter((key) => windowState(key, now) === WINDOW_STATE.OPEN);
    const expected = minutes < 240 ? 0 : 1;
    assert.equal(open.length, expected,
      `${minutes} minutes in: expected ${expected} open window(s), got ${open.join(',') || 'none'}`);
  }
});

test('before 4 AM nothing is open and nothing is missed', () => {
  // Midnight–4 AM is the dead hours, so those hours ARE locked (that is the
  // point of them). `isMissed` is the assertion that matters: a user opening the
  // app at 2 AM must not see yesterday's categories flagged MISSED.
  const keys = Object.keys(SLOT_WINDOWS);
  for (const hour of [0, 1, 2, 3]) {
    for (const key of keys) {
      const state = windowState(key, at(hour));
      assert.equal(state, WINDOW_STATE.UPCOMING, `${key} at ${hour}:00`);
      const section = slotSectionState(group(key, [{ taken: false }], key), at(hour));
      assert.equal(section.isMissed, false, `${key} at ${hour}:00`);
      assert.equal(section.isLocked, true, `${key} at ${hour}:00`);
      assert.equal(section.isDeadHour, true, `${key} at ${hour}:00`);
    }
  }
});

test('at 4:00 AM Morning is open and the dead hours are over', () => {
  // The reset. Exactly one boundary decides it, so 3:59 and 4:00 are the two
  // states either side.
  const before = layoutPlan([group('morning', [item(false)], 'Morning')], at(3, 59));
  const after = layoutPlan([group('morning', [item(false)], 'Morning')], at(4, 0));

  assert.equal(before.deadHour, true);
  assert.equal(before.active.length, 0);
  assert.equal(after.deadHour, false);
  assert.deepEqual(after.active.map(a => a.group.key), ['morning']);
  assert.equal(after.placeholders.length, 0, 'no placeholders once the day is open');
});

test('Anytime never locks', () => {
  for (const hour of [0, 3, 8, 13, 19, 23]) {
    assert.equal(windowState('anytime', at(hour)), WINDOW_STATE.ALWAYS);
  }
});

test('an unknown slot key is treated as Anytime, not locked out', () => {
  // A newer server could send a slot this client has no window for. Showing it
  // as untickable would silently hide supplements from the plan.
  assert.equal(windowState('midday', at(23)), WINDOW_STATE.ALWAYS);
  assert.equal(windowState('', at(23)), WINDOW_STATE.ALWAYS);
  assert.equal(windowState(undefined, at(23)), WINDOW_STATE.ALWAYS);
});

test('an unusable clock never locks anybody out', () => {
  // Failing open is deliberate: the cost is a window staying open a minute or
  // two long, the cost of failing closed is a user locked out of their own plan.
  assert.equal(windowState('morning', new Date('nonsense')), WINDOW_STATE.ALWAYS);

  // An omitted `now` defaults to the real clock. Pinning the assertion to "a
  // valid state" rather than a specific one is the point: this must not throw
  // and must not return ALWAYS by accident of the default argument.
  const defaulted = windowState('morning');
  assert.ok(Object.values(WINDOW_STATE).includes(defaulted), `unexpected state ${defaulted}`);
});

test('the slot key is matched case-insensitively', () => {
  assert.equal(windowState('MORNING', at(6)), WINDOW_STATE.OPEN);
  assert.equal(windowState('Night', at(23)), WINDOW_STATE.OPEN);
});

// ── windowLabel ────────────────────────────────────────────────────────────

test('windowLabel states the hours a human can check', () => {
  assert.equal(windowLabel('morning'), '4:00 AM – 12:00 PM');
  assert.equal(windowLabel('afternoon'), '12:00 PM – 6:00 PM');
  assert.equal(windowLabel('evening'), '6:00 PM – 10:00 PM');
  assert.equal(windowLabel('night'), '10:00 PM – 12:00 AM');
  assert.equal(windowLabel('anytime'), '');
});

// ── slotSectionState: missed is derived, not the window alone ─────────────

test('a closed window with unticked supplements is Missed', () => {
  const state = slotSectionState(group('morning', [{ taken: false }, { taken: false }], 'Morning'), at(15));
  assert.equal(state.isLocked, true);
  assert.equal(state.isMissed, true);
  assert.equal(state.pending, 2);
});

test('a closed window with EVERYTHING ticked is complete, never Missed', () => {
  // The bug this prevents: relabelling a finished window as "Missed" after the
  // fact. The day was a success.
  const state = slotSectionState(group('morning', [{ taken: true }, { taken: true }], 'Morning'), at(15));
  assert.equal(state.isLocked, true);
  assert.equal(state.isMissed, false);
  assert.equal(state.isComplete, true);
  assert.equal(state.taken, 2);
  assert.equal(state.pending, 0);
});

test('partly ticked then closed is Missed, and the count is honest', () => {
  const state = slotSectionState(group('morning', [{ taken: true }, { taken: false }], 'Morning'), at(15));
  assert.equal(state.isMissed, true);
  assert.equal(state.taken, 1);
  assert.equal(state.total, 2);
  assert.equal(state.pending, 1);
});

test('an open window is never Missed', () => {
  for (const [key, time] of [['morning', at(7)], ['afternoon', at(14)], ['evening', at(19)], ['night', at(23)]]) {
    const state = slotSectionState(group(key, [{ taken: false }], key), time);
    assert.equal(state.isMissed, false, key);
    assert.equal(state.state, WINDOW_STATE.OPEN, key);
  }
});

test('an upcoming window is never Missed', () => {
  // Nothing is late about a window that has not opened yet.
  const state = slotSectionState(group('evening', [{ taken: false }], 'Evening'), at(9));
  assert.equal(state.state, WINDOW_STATE.UPCOMING);
  assert.equal(state.isMissed, false);
  assert.equal(state.isLocked, false);
});

test('a completed section is Complete even while its window is still open', () => {
  const state = slotSectionState(group('morning', [{ taken: true }], 'Morning'), at(7));
  assert.equal(state.isComplete, true);
  assert.equal(state.isMissed, false);
  assert.equal(state.canTickAll, false, 'nothing left to tick');
});

// ── Locked is not blocked ──────────────────────────────────────────────────

test('a missed section can still be ticked', () => {
  // A hard lock would mean a forgotten dose could never be recorded, so the day
  // could never reach 100% and the streak would break over a missed alarm.
  const state = slotSectionState(group('morning', [{ taken: false }], 'Morning'), at(15));
  assert.equal(state.isMissed, true);
  assert.equal(state.canTick, true);
  assert.equal(state.canTickAll, true);
});

test('take-all is offered whenever something is unticked, open or not', () => {
  assert.equal(slotSectionState(group('morning', [{ taken: false }], 'M'), at(7)).canTickAll, true);
  assert.equal(slotSectionState(group('morning', [{ taken: false }], 'M'), at(15)).canTickAll, true);
  assert.equal(slotSectionState(group('morning', [{ taken: true }], 'M'), at(15)).canTickAll, false);
});

// ── Dead hours: midnight → 4:00 AM ─────────────────────────────────────────
//
// THE DISTINCTION THAT MATTERS HERE:
//   Dead hours are a LOCK, not a verdict. "Missed" claims something was late;
//   at 2 AM nothing was ever due, so nothing was missed. Conflating the two
//   would tell a user they failed their plan because they were awake at 2 AM.

test('the dead hours run midnight to 4:00 AM', () => {
  assert.deepEqual([DEAD_HOURS.start, DEAD_HOURS.end], [0, 240]);
  assert.equal(DEAD_HOURS.endsAt, '4:00 AM');
});

// ── The dead-hours view: every field, empty, with a countdown ──────────────

test('dead hours list every field, with nothing inside it', () => {
  // The requirement: all fields visible, none offering a supplement. Showing the
  // shape of the day stops the pause reading as a broken screen.
  const plan = layoutPlan([
    group('morning', [item(false), item(false)], 'Morning'),
    group('afternoon', [item(false)], 'Afternoon'),
    group('evening', [item(false)], 'Evening'),
    group('night', [item(false)], 'Before Bed'),
    group('anytime', [item(false)], 'Anytime'),
  ], at(2));

  assert.equal(plan.deadHour, true);
  assert.equal(plan.placeholders.length, 5, 'every field is listed');
  assert.deepEqual(
    plan.placeholders.map(p => p.key),
    ['morning', 'afternoon', 'evening', 'night', 'anytime'],
  );
  // No supplements anywhere: no active frame, no Anytime section, no tray.
  assert.equal(plan.active.length, 0);
  assert.equal(plan.anytime, null);
  assert.equal(plan.missed.total, 0);
  assert.equal(plan.hasWork, false);
});

test('each placeholder counts down to when its own field opens', () => {
  const plan = layoutPlan([
    group('morning', [item(false)], 'Morning'),
    group('evening', [item(false)], 'Evening'),
  ], at(2));
  const byKey = Object.fromEntries(plan.placeholders.map(p => [p.key, p]));

  assert.equal(byKey.morning.opensAt, '4:00 AM');
  assert.equal(byKey.morning.countdown.total, 120);   // 2:00 → 4:00
  assert.equal(byKey.evening.opensAt, '6:00 PM');
  assert.equal(byKey.evening.countdown.total, 16 * 60); // 2:00 → 18:00
});

test('a placeholder reports how much is waiting without listing it', () => {
  const plan = layoutPlan([group('morning', [item(false), item(false), item(false)], 'Morning')], at(2));
  assert.equal(plan.placeholders[0].total, 3);
  // The rows themselves are never handed to the view during the dead hours.
  assert.equal(plan.placeholders[0].items, undefined);
});

test('Anytime counts down to the start of the day', () => {
  // It has no window of its own, so it opens when the day does — otherwise it
  // would be the one field with no "opens at" and read as an oversight.
  const plan = layoutPlan([group('anytime', [item(false)], 'Anytime')], at(1));
  assert.equal(plan.placeholders[0].opensAt, DEAD_HOURS.endsAt);
  assert.equal(plan.placeholders[0].countdown.total, 180); // 1:00 → 4:00
});

test('placeholders vanish once the dead hours are over', () => {
  for (const hour of [4, 7, 14, 23]) {
    const plan = layoutPlan([group('morning', [item(false)], 'Morning')], at(hour));
    assert.equal(plan.placeholders.length, 0, `${hour}:00`);
  }
});

test('the dead-hours view hides even a day that already ran', () => {
  // Yesterday's misses are real, but putting a red tray in front of someone at
  // 2 AM — who has not been given the chance to do anything about it — is not.
  const plan = layoutPlan([
    group('morning', [item(true), item(false)], 'Morning'),
    group('evening', [item(true)], 'Evening'),
  ], at(2));
  assert.equal(plan.missed.total, 0);
  assert.equal(plan.active.length, 0);
  assert.equal(plan.placeholders.length, 2, 'but the fields are still listed');
});

test('deadHourPlaceholders works on its own, and never leaks rows', () => {
  // Called directly rather than only through layoutPlan, because that is how it
  // is imported in isolation and a bug here must not be masked by the wrapper.
  const list = deadHourPlaceholders([
    group('morning', [item(false), item(false)], 'Morning'),
    group('anytime', [item(false)], 'Anytime'),
  ], at(1, 30));

  assert.equal(list.length, 2);
  assert.equal(list[0].total, 2, 'the count survives');
  assert.equal(list[0].countdown.total, 150); // 1:30 → 4:00
  for (const entry of list) {
    assert.equal(entry.items, undefined, 'no rows may reach the view');
    assert.equal(typeof entry.opensAt, 'string');
    assert.equal(typeof entry.countdown.text, 'string');
  }
});

test('deadHourPlaceholders survives junk', () => {
  assert.deepEqual(deadHourPlaceholders(undefined, at(1)), []);
  assert.deepEqual(deadHourPlaceholders(null, at(1)), []);
  assert.deepEqual(deadHourPlaceholders([], at(1)), []);
  assert.equal(deadHourPlaceholders([null, {}, { key: 'morning' }], at(1)).length, 3);
});

test('the dead-hours view survives junk', () => {
  const plan = layoutPlan([undefined, null, {}, { key: 'morning' }, group('morning', 'nope')], at(2));
  assert.equal(plan.deadHour, true);
  assert.equal(plan.placeholders.length, 5);
  assert.equal(plan.hasWork, false);
});

// ── isTakenLate: "Took it Late" instead of "Taken" ─────────────────────────
//
// A statement about the TIMESTAMP, not about now. A dose recorded at 1:03 AM
// for a 10 PM–midnight slot was taken late, and keeps saying so even when it is
// looked at again at lunchtime.

/** A dose recorded at a given local hour/minute on the test day. */
const takenAt = (hours, minutes = 0) =>
  new Date(2026, 8, 28, hours, minutes, 0, 0).toISOString();

test('a dose taken inside its own window is not late', () => {
  // Morning runs 4:00 AM – noon; this is 7:15 AM.
  assert.equal(isTakenLate({ taken: true, takenAt: takenAt(7, 15) }, 'morning'), false);
  // Before Bed runs 10 PM – midnight; this is 11:30 PM.
  assert.equal(isTakenLate({ taken: true, takenAt: takenAt(23, 30) }, 'night'), false);
});

test('a dose taken before its window is late', () => {
  // 1:03 AM for a 10 PM slot — the case in the screenshot.
  assert.equal(isTakenLate({ taken: true, takenAt: takenAt(1, 3) }, 'night'), true);
  // 3 AM for a 6 PM slot.
  assert.equal(isTakenLate({ taken: true, takenAt: takenAt(3) }, 'evening'), true);
});

test('a dose taken after its window is late', () => {
  // 9 PM for a morning slot that closed at noon.
  assert.equal(isTakenLate({ taken: true, takenAt: takenAt(21) }, 'morning'), true);
  // The exact closing minute is outside — windows are half-open.
  assert.equal(isTakenLate({ taken: true, takenAt: takenAt(12, 0) }, 'morning'), true);
});

test('the window boundaries themselves are on time', () => {
  // 4:00 AM is inside Morning, because that is when it opens.
  assert.equal(isTakenLate({ taken: true, takenAt: takenAt(4, 0) }, 'morning'), false);
  // 10:00 PM is inside Before Bed.
  assert.equal(isTakenLate({ taken: true, takenAt: takenAt(22, 0) }, 'night'), false);
});

test('Anytime can never be late', () => {
  // No window means no lateness. Otherwise every unscheduled supplement would
  // be permanently branded "Took it Late", and the badge would stop meaning
  // anything at all.
  for (const hour of [0, 2, 7, 15, 23]) {
    assert.equal(isTakenLate({ taken: true, takenAt: takenAt(hour) }, 'anytime'), false, `${hour}:00`);
  }
});

test('an unknown slot is never late', () => {
  // A newer server could send a slot this client has no window for. Treating it
  // as late would brand every one of those doses wrongly.
  assert.equal(isTakenLate({ taken: true, takenAt: takenAt(1) }, 'midday'), false);
  assert.equal(isTakenLate({ taken: true, takenAt: takenAt(1) }, ''), false);
});

test('an untaken dose is never "late"', () => {
  // Lateness describes something that happened. Nothing happened here.
  assert.equal(isTakenLate({ taken: false, takenAt: takenAt(1) }, 'night'), false);
  assert.equal(isTakenLate({}, 'night'), false);
});

test('a missing or unreadable timestamp is never "late"', () => {
  // Fails OPEN. An absent takenAt is not evidence of lateness, and inventing a
  // badge from it would brand honest doses as late.
  assert.equal(isTakenLate({ taken: true }, 'night'), false);
  assert.equal(isTakenLate({ taken: true, takenAt: null }, 'night'), false);
  assert.equal(isTakenLate({ taken: true, takenAt: '' }, 'night'), false);
  assert.equal(isTakenLate({ taken: true, takenAt: 'nonsense' }, 'night'), false);
  assert.equal(isTakenLate({ taken: true, takenAt: {} }, 'night'), false);
});

test('isTakenLate survives junk in either position', () => {
  for (const item of [undefined, null, 'nonsense', 42, [], {}]) {
    for (const key of ['morning', 'anytime', undefined, '', 42]) {
      assert.equal(isTakenLate(item, key), false, `${JSON.stringify(item)} / ${JSON.stringify(key)}`);
    }
  }
});

test('every hour of the day classifies against every slot without throwing', () => {
  // Exhaustive rather than sampled: a boundary mistake would hide between
  // sampled points, and this is the check that reads every single minute.
  for (const key of Object.keys(SLOT_WINDOWS)) {
    for (let minutes = 0; minutes < 1440; minutes += 5) {
      const when = new Date(2026, 8, 28, 0, 0, 0, 0);
      when.setMinutes(minutes);
      const out = isTakenLate({ taken: true, takenAt: when.toISOString() }, key);
      assert.equal(typeof out, 'boolean', `${key} @ ${minutes}`);
    }
  }
});

// ── countdownTo ────────────────────────────────────────────────────────────

test('countdownTo counts down, and never up', () => {
  assert.equal(countdownTo(240, at(2, 0)).total, 120);
  assert.equal(countdownTo(240, at(0, 0)).total, 240);
  // A target already past reads as due. A negative countdown would be worse
  // than useless on a screen the user is being asked to trust.
  assert.equal(countdownTo(240, at(9, 0)).total, 0);
  assert.equal(countdownTo(240, at(9, 0)).isDue, true);
});

test('countdownTo formats hours and minutes readably', () => {
  assert.equal(countdownTo(240, at(2, 0)).text, '2h 0m'.replace('0m', '0m'));
  assert.equal(countdownTo(240, at(2, 0)).hours, 2);
  assert.equal(countdownTo(300, at(4, 0)).text, '1h 0m');
  assert.equal(countdownTo(300, at(4, 45)).text, '15m');
  assert.equal(countdownTo(240, at(4, 0)).text, 'now');
});

test('countdownTo fails open on an unusable clock', () => {
  const out = countdownTo(240, new Date('nonsense'));
  assert.equal(out.isDue, true);
  assert.equal(out.total, 0);
  assert.equal(typeof out.text, 'string');
});

test('countdownTo never produces a negative field', () => {
  for (let minutes = 0; minutes < 1440; minutes += 7) {
    const now = new Date(2026, 8, 28, 0, 0, 0, 0);
    now.setMinutes(minutes);
    for (const target of [0, 240, 720, 1080, 1320, 1439]) {
      const out = countdownTo(target, now);
      assert.ok(out.total >= 0, `${minutes} → ${target}`);
      assert.ok(out.hours >= 0 && out.minutes >= 0);
      assert.ok(out.minutes < 60, 'minutes must be a remainder, not a total');
    }
  }
});

test('isDeadHour covers 12:00 AM up to but not including 4:00 AM', () => {
  assert.equal(isDeadHour(at(0, 0)), true);
  assert.equal(isDeadHour(at(1, 30)), true);
  assert.equal(isDeadHour(at(3, 59)), true);
  assert.equal(isDeadHour(at(4, 0)), false, '4:00 AM is the end of the dead hours');
  assert.equal(isDeadHour(at(4, 1)), false);
  assert.equal(isDeadHour(at(9, 0)), false);
  assert.equal(isDeadHour(at(23, 59)), false);
});

test('dead hours fail OPEN on an unusable clock', () => {
  // Failing closed here would lock somebody out of their own plan because of a
  // bad Date, which is a far worse outcome than a dead hour lasting an extra
  // minute or two.
  assert.equal(isDeadHour(new Date('nonsense')), false);
});

test('dead hours lock every TIMED category', () => {
  // The four frames have a window, so a 2 AM entry to one of them is mistimed.
  for (const key of ['morning', 'afternoon', 'evening', 'night']) {
    const section = slotSectionState(group(key, [{ taken: false }], key), at(2));
    assert.equal(section.isLocked, true, key);
    assert.equal(section.isDeadHour, true, key);
  }
});

test('Anytime is EXEMPT from the dead hours', () => {
  // The one exemption asked for. "Any time" has to mean any time, or a
  // supplement with no schedule becomes impossible to record overnight — which
  // is exactly when the user most needs to note that they took it.
  const section = slotSectionState(group('anytime', [{ taken: false }], 'Anytime'), at(2));
  assert.equal(section.isLocked, false);
  assert.equal(section.isDeadHour, false);
  assert.equal(section.isMissed, false);
  assert.equal(section.canTick, true);
});

test('dead hours lock, but never mark anything Missed', () => {
  // The property the whole feature rests on. Nothing is late at 2 AM.
  for (const key of ['morning', 'afternoon', 'evening', 'night', 'anytime']) {
    const section = slotSectionState(group(key, [{ taken: false }], key), at(2));
    assert.equal(section.isMissed, false, key);
  }
});

test('an already-ticked day is NOT locked during dead hours', () => {
  // "Except those already taken": a section with nothing left to record has
  // nothing to lock, so it must not read as locked at 3 AM.
  const section = slotSectionState(group('morning', [{ taken: true }, { taken: true }], 'Morning'), at(2));
  assert.equal(section.isComplete, true);
  assert.equal(section.pending, 0);
  assert.equal(section.isTickable, false);
  assert.equal(section.canTickAll, false);
  assert.equal(section.isMissed, false);
});

test('dead hours still allow a late entry', () => {
  // Locked, not blocked — same call as the missed windows.
  const section = slotSectionState(group('morning', [{ taken: false }], 'Morning'), at(2));
  assert.equal(section.isLocked, true);
  assert.equal(section.canTick, true);
  assert.equal(section.canTickAll, true);
});

test('a partly-ticked section is locked and the counts stay honest', () => {
  const section = slotSectionState(group('evening', [{ taken: true }, { taken: false }], 'Evening'), at(2));
  assert.equal(section.isLocked, true);
  assert.equal(section.isMissed, false);
  assert.equal(section.taken, 1);
  assert.equal(section.total, 2);
  assert.equal(section.pending, 1);
});

test('dead hours end cleanly and nothing stays locked afterwards', () => {
  // The 4:00 AM boundary: one minute before is locked, at 4:00 AM it is not.
  const before = slotSectionState(group('morning', [{ taken: false }], 'Morning'), at(3, 59));
  const after = slotSectionState(group('morning', [{ taken: false }], 'Morning'), at(4, 0));
  assert.equal(before.isDeadHour, true);
  assert.equal(before.isLocked, true);
  assert.equal(after.isDeadHour, false);
  // At 4:00 AM Morning's own window OPENS, so the section is live rather than
  // locked — the pause released into a working day rather than a stale lock.
  assert.equal(after.state, WINDOW_STATE.OPEN);
  assert.equal(after.isLocked, false);
  assert.equal(after.isMissed, false);
});

test('a window that genuinely closed still reports Missed after 4 AM', () => {
  // Dead hours must not swallow the real missed case: at 3 PM an unticked
  // Morning window really is missed.
  const section = slotSectionState(group('morning', [{ taken: false }], 'Morning'), at(15));
  assert.equal(section.isDeadHour, false);
  assert.equal(section.isMissed, true);
  assert.equal(section.isLocked, true);
});

test('an empty group is never locked by dead hours', () => {
  const section = slotSectionState(group('morning', [], 'Morning'), at(2));
  assert.equal(section.total, 0);
  assert.equal(section.isLocked, true);
  assert.equal(section.isComplete, false);
  assert.equal(section.canTickAll, false);
});

test('a junk group survives the dead hours without throwing', () => {
  for (const value of [undefined, null, {}, { key: 'morning' }, group('morning', 'nope')]) {
    const section = slotSectionState(value, at(2));
    assert.equal(section.total, 0, JSON.stringify(value));
    assert.equal(section.isMissed, false, JSON.stringify(value));
  }
});

// ── Anytime never becomes missed ───────────────────────────────────────────

test('Anytime is never missed, and never locked outside the dead hours', () => {
  // 1 AM is deliberately excluded from the hours below: it is inside the dead
  // hours, where Anytime IS locked. See the dead-hours block above.
  for (const hour of [5, 7, 13, 20, 23]) {
    const state = slotSectionState(group('anytime', [{ taken: false }], 'Anytime'), at(hour));
    assert.equal(state.isMissed, false, `${hour}:00`);
    assert.equal(state.isLocked, false, `${hour}:00`);
    assert.equal(state.canTick, true, `${hour}:00`);
  }
});

// ── Page layout: one frame at a time ───────────────────────────────────────
//
// THE RULE: only the frame whose window is open right now is on the page.
// A finished frame vanishes. A frame whose window closed with something
// unticked drops those rows into the "Today Missed" tray at the bottom.

const item = (taken = false) => ({ id: `i${taken}`, taken });

test('only the open frame is on the page', () => {
  const plan = layoutPlan([
    group('morning', [item(true)], 'Morning'),
    group('afternoon', [item(false)], 'Afternoon'),
    group('evening', [item(false)], 'Evening'),
    group('night', [item(false)], 'Before Bed'),
  ], at(7));

  assert.deepEqual(plan.active.map(a => a.group.key), ['morning']);
  // Nothing else on screen: the future frames are not shown, and nothing has
  // closed yet so there is no tray.
  assert.equal(plan.missed.total, 0);
});

test('the active frame moves as the day advances', () => {
  const groups = [
    group('morning', [item(true)], 'Morning'),
    group('afternoon', [item(false)], 'Afternoon'),
    group('evening', [item(false)], 'Evening'),
    group('night', [item(false)], 'Before Bed'),
  ];
  assert.deepEqual(layoutPlan(groups, at(7)).active.map(a => a.group.key), ['morning']);
  assert.deepEqual(layoutPlan(groups, at(14)).active.map(a => a.group.key), ['afternoon']);
  assert.deepEqual(layoutPlan(groups, at(19)).active.map(a => a.group.key), ['evening']);
  assert.deepEqual(layoutPlan(groups, at(23)).active.map(a => a.group.key), ['night']);
});

test('a frame that closed with everything ticked vanishes', () => {
  const plan = layoutPlan([
    group('morning', [item(true), item(true)], 'Morning'),
    group('afternoon', [item(false)], 'Afternoon'),
  ], at(14));
  // Morning is done, so it is gone — not in the active list and not in the tray.
  assert.deepEqual(plan.active.map(a => a.group.key), ['afternoon']);
  assert.equal(plan.missed.total, 0);
  assert.equal(plan.completedCount, 1);
});

test('a frame that closed unticked drops its rows into the missed tray', () => {
  const plan = layoutPlan([
    group('morning', [item(true), item(false)], 'Morning'),
    group('afternoon', [item(false)], 'Afternoon'),
  ], at(14));
  assert.equal(plan.missed.total, 1, 'only the unticked row is late');
  assert.equal(plan.missed.items[0].missedFrom, 'Morning');
  assert.deepEqual(plan.active.map(a => a.group.key), ['afternoon']);
});

test('the taken rows of a part-ticked frame are NOT in the tray', () => {
  // The tray is called "Missed". A taken pill sitting in it would be a lie.
  const plan = layoutPlan([group('morning', [item(true), item(true), item(false)], 'Morning')], at(14));
  assert.equal(plan.missed.total, 1);
  assert.equal(plan.missed.items.every(i => !i.taken), true);
});

test('the tray carries the day name', () => {
  const plan = layoutPlan([group('morning', [item(false)], 'Morning')], at(14));
  assert.equal(plan.missed.title, MISSED_TRAY_TITLE);
  assert.equal(plan.missed.title, 'Today Missed');
});

test('missed rows stay recordable right up to the dead hours', () => {
  const groups = [group('morning', [item(false)], 'Morning')];
  // 11:59 PM — the window closed hours ago, but the day has not turned over.
  const lateEvening = layoutPlan(groups, at(23, 59));
  assert.equal(lateEvening.missed.locked, false);
  assert.equal(lateEvening.missed.total, 1);
});

test('a day that already ran is not hidden by the UTC/local day mismatch', () => {
  // THE BUG THIS PINS. The server keys days off UTC while these windows read
  // the local clock, so a user east of UTC can be served YESTERDAY's records
  // while their clock reads 02:30 — a time at which every timed frame is
  // "upcoming". Read naively, yesterday's unticked doses would vanish off the
  // page instead of appearing in the tray.
  //
  // The signal that the day genuinely ran is a ticked row in the frame.
  const groups = [
    group('morning', [item(true), item(false)], 'Morning'),
    group('evening', [item(true), item(true)], 'Evening'),
    group('anytime', [item(false)], 'Anytime'),
  ];

  const atNight = layoutPlan(groups, at(2));
  assert.equal(atNight.deadHour, true);
  assert.equal(atNight.missed.total, 0, 'no tray at 2 AM');
  assert.equal(atNight.active.length, 0);
  assert.equal(atNight.placeholders.length, 3, 'but every field is listed');

  // 4:00 AM is the reset: the plan is back, and the unticked row is reachable.
  const atDawn = layoutPlan(groups, at(4, 0));
  assert.equal(atDawn.deadHour, false);
  assert.deepEqual(atDawn.active.map(a => a.group.key), ['morning']);
  assert.equal(atDawn.active[0].section.pending, 1);
  assert.equal(atDawn.hasWork, true);
});

test('a day that has not started yet stays hidden, not "missed"', () => {
  // The opposite case, and the reason the rule above is narrow: nothing ticked
  // means nothing ran, so there is no day to have missed. A user opening the app
  // at 2 AM to a fresh day must not be shown a tray of things they never had a
  // chance to take.
  const plan = layoutPlan([
    group('morning', [item(false)], 'Morning'),
    group('afternoon', [item(false)], 'Afternoon'),
  ], at(2));
  assert.equal(plan.active.length, 0);
  assert.equal(plan.missed.total, 0);
  assert.equal(plan.missed.locked, false, 'an empty tray is not "locked"');
  assert.equal(plan.upcomingCount, 2);
});

test('outside the dead hours the UTC/local rule does not apply', () => {
  // The mismatch heuristic is gated on the dead hours. An Afternoon frame with
  // a ticked row at 9 AM has not closed and must stay merely upcoming — if the
  // heuristic fired here it would declare the frame already finished and hide a
  // part of the day that is still four hours away.
  const plan = layoutPlan([group('afternoon', [item(true), item(false)], 'Afternoon')], at(9));
  assert.equal(plan.missed.total, 0);
  assert.equal(plan.completedCount, 0);
  assert.equal(plan.upcomingCount, 1);
  assert.deepEqual(plan.active, []);
});

test('Anytime is on the page and never in the tray', () => {
  // 2 AM is excluded: that is inside the dead hours, where Anytime appears as
  // an empty placeholder rather than a section — every field does.
  for (const hour of [4, 7, 14, 19, 23]) {
    const plan = layoutPlan([
      group('morning', [item(false)], 'Morning'),
      group('afternoon', [item(false)], 'Afternoon'),
      group('anytime', [item(false)], 'Anytime'),
    ], at(hour));
    assert.ok(plan.anytime, `Anytime missing at ${hour}:00`);
    assert.equal(plan.missed.items.some(i => i.missedFrom === 'Anytime'), false, `${hour}:00`);
  }
});

test('before 5 AM no timed frame is active', () => {
  // 2 AM: Morning has not opened, and nothing has closed. There is no frame to
  // show, and nothing is late.
  const plan = layoutPlan([
    group('morning', [item(false)], 'Morning'),
    group('afternoon', [item(false)], 'Afternoon'),
  ], at(2));
  assert.equal(plan.active.length, 0);
  assert.equal(plan.missed.total, 0);
  assert.equal(plan.deadHour, true);
});

test('an unknown slot is treated as Anytime rather than dropped', () => {
  // A newer server could send a slot this client has no window for. Hiding it
  // would silently remove supplements from the plan. Checked at 5 AM, outside
  // the dead hours, where sections are actually rendered.
  const plan = layoutPlan([group('midday', [item(false)], 'Midday')], at(5));
  assert.ok(plan.anytime);
  assert.equal(plan.missed.total, 0);
});

test('two Anytime groups do not make one vanish', () => {
  const plan = layoutPlan([
    group('anytime', [item(false)], 'Anytime'),
    group('anytime', [item(false)], 'Anytime'),
  ], at(14));
  assert.ok(plan.anytime, 'at least one must survive');
});

// ── hasWork: what the empty state is allowed to claim ──────────────────────

test('hasWork is false only when the day genuinely has nothing left', () => {
  const allDone = layoutPlan([
    group('morning', [item(true)], 'Morning'),
    group('afternoon', [item(true)], 'Afternoon'),
  ], at(14));
  assert.equal(allDone.hasWork, false);
});

test('hasWork is true when a missed dose is still on record', () => {
  // Even though the frame is gone from the page, there is still something to do
  // about it — so the page must not claim to be finished.
  const plan = layoutPlan([
    group('morning', [item(true), item(false)], 'Morning'),
    group('afternoon', [item(true)], 'Afternoon'),
  ], at(14));
  assert.equal(plan.hasWork, true);
});

test('a tray with rows always counts as outstanding work', () => {
  // Whether or not the tray is locked, rows in it mean the day is not finished.
  const plan = layoutPlan([
    group('morning', [item(true), item(false)], 'Morning'),
    group('evening', [item(true)], 'Evening'),
  ], at(14));
  assert.equal(plan.missed.total, 1);
  assert.equal(plan.missed.locked, false, 'not dead hours yet, so still recordable');
  assert.equal(plan.hasWork, true);
});

test('a tray is only ever "locked" when it actually has rows in it', () => {
  // Locking an empty tray would render a dead "Today Missed" heading all night
  // for nothing. `locked` is defined as `deadHour && total > 0`, so the two can
  // never disagree; this pins that relationship rather than a wall-clock value.
  for (const hour of [0, 2, 3, 7, 14, 23]) {
    for (const groups of [
      [],
      [group('morning', [item(true), item(true)], 'Morning')],
      [group('morning', [item(false)], 'Morning')],
      [group('anytime', [item(false)], 'Anytime')],
    ]) {
      const plan = layoutPlan(groups, at(hour));
      if (plan.missed.locked) {
        assert.ok(plan.missed.total > 0, `locked tray with no rows at ${hour}:00`);
        assert.equal(plan.deadHour, true, `locked tray outside dead hours at ${hour}:00`);
      }
    }
  }
});

// ── sectionPlacement ───────────────────────────────────────────────────────

test('sectionPlacement answers the four cases directly', () => {
  assert.equal(sectionPlacement(group('morning', [item(false)], 'M'), at(7)), SECTION_PLACEMENT.ACTIVE);
  assert.equal(sectionPlacement(group('morning', [item(false)], 'M'), at(3)), SECTION_PLACEMENT.HIDDEN);
  assert.equal(sectionPlacement(group('morning', [item(true)], 'M'), at(14)), SECTION_PLACEMENT.HIDDEN);
  assert.equal(sectionPlacement(group('morning', [item(false)], 'M'), at(14)), SECTION_PLACEMENT.MISSED);
  assert.equal(sectionPlacement(group('anytime', [item(false)], 'A'), at(23)), SECTION_PLACEMENT.ANYTIME);
});

// ── layoutPlan survives junk ───────────────────────────────────────────────

test('layoutPlan survives an empty, missing or invalid group list', () => {
  for (const value of [undefined, null, [], 'nonsense', {}]) {
    const plan = layoutPlan(value, at(14));
    assert.deepEqual(plan.active, [], JSON.stringify(value));
    assert.equal(plan.anytime, null, JSON.stringify(value));
    assert.equal(plan.missed.total, 0, JSON.stringify(value));
    assert.equal(plan.hasWork, false, JSON.stringify(value));
  }
});

test('layoutPlan survives junk inside a group', () => {
  const plan = layoutPlan([
    undefined, null, {}, { key: 'morning' }, group('morning', 'nope'),
  ], at(14));
  // A group with no usable items has nothing pending, so its closed frame reads
  // as completed and vanishes rather than inventing a missed row.
  assert.equal(plan.missed.total, 0, JSON.stringify(plan.missed));
  assert.equal(plan.hasWork, false);
});

test('rows with no taken flag count as unticked, so they are late', () => {
  // Absent is not "yes". A record the server sent without a flag is unticked,
  // and hiding it would quietly drop a supplement from the user's day.
  const plan = layoutPlan([group('morning', [null, undefined, {}], 'Morning')], at(14));
  assert.equal(plan.missed.total, 3);
  assert.equal(plan.hasWork, true);
});

test('every field the UI reads is present', () => {
  const plan = layoutPlan([group('morning', [item(false)], 'Morning')], at(14));
  for (const field of ['active', 'anytime', 'missed', 'completedCount', 'upcomingCount', 'deadHour', 'hasWork']) {
    assert.ok(field in plan, `missing ${field}`);
  }
  for (const field of ['title', 'items', 'total', 'locked', 'endsAt']) {
    assert.ok(field in plan.missed, `missing missed.${field}`);
  }
});

// ── Junk in must not throw ─────────────────────────────────────────────────

test('an empty or invalid group does not throw', () => {
  for (const value of [undefined, null, {}, { key: 'morning' }, group('morning', null), group('morning', 'nope')]) {
    const state = slotSectionState(value, at(15));
    assert.equal(state.total, 0, JSON.stringify(value));
    assert.equal(state.isMissed, false, JSON.stringify(value));
    assert.equal(state.isComplete, false, JSON.stringify(value));
    assert.equal(state.canTickAll, false, JSON.stringify(value));
  }
});

test('items missing a taken flag count as unticked', () => {
  // Absent is not "yes": a row the server sent without a flag is unticked, and
  // counting it as done would mark a live section complete.
  const state = slotSectionState(group('morning', [{}, { taken: false }], 'Morning'), at(15));
  assert.equal(state.taken, 0);
  assert.equal(state.pending, 2);
  assert.equal(state.isMissed, true);
});

test('the section carries the key, label and window the header prints', () => {
  const state = slotSectionState(group('night', [{ taken: true }], 'Before Bed'), at(23));
  assert.equal(state.key, 'night');
  assert.equal(state.label, 'Before Bed');
  assert.equal(state.window, '10:00 PM – 12:00 AM');
});

test('every field the UI reads is present and correctly typed', () => {
  const state = slotSectionState(group('morning', [{ taken: true }], 'Morning'), at(7));
  for (const field of ['key', 'state', 'label', 'window', 'total', 'taken', 'pending', 'isMissed', 'isComplete', 'isLocked', 'isDeadHour', 'isTickable', 'canTick', 'canTickAll']) {
    assert.ok(field in state, `missing ${field}`);
  }
  assert.equal(typeof state.total, 'number');
  assert.equal(typeof state.isMissed, 'boolean');
  assert.equal(typeof state.isDeadHour, 'boolean');
});
