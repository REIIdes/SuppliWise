/**
 * The client half of the plan-activation rule.
 *
 * Run: node --test src/utils/planActivation.test.js
 *
 * WHY THE CLIENT NEEDS A RULEBOOK FOR THIS AT ALL
 * The server decides what is missed and what is merely forgiven
 * (server/utils/planActivation.js), and the tracker draws from the server's
 * answer rather than re-deriving it. That is not tidiness — it is the only way
 * the two can be guaranteed to agree, because the wellness score is persisted
 * server-side and read by Insights and the Web3 export, which have no browser to
 * ask. If this file decided for itself which frames to forgive, a disagreement
 * would show up on screen as a score reading "nothing missed" directly above a
 * red "Today Missed" tray.
 *
 * So what is tested here is narrow and deliberate:
 *
 *   1. the server's answer is honoured, and only on the day it names;
 *   2. a forgiven frame is placed and drawn as OPEN, never as missed;
 *   3. everything else about the layout is untouched — the exemption has to be
 *      the ONLY thing that changes, or it is a second rulebook.
 *
 * The windows themselves are asserted in slotSchedule.test.js; this file never
 * restates them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  layoutPlan,
  sectionPlacement,
  slotSectionState,
  frameHasClosed,
  graceSlotsFor,
  SECTION_PLACEMENT,
  WINDOW_STATE,
} from './slotSchedule.js';

/** A local instant at `hour`:`minute` on the calendar date `dayKey` names. */
const at = (dayKey, hour, minute = 0) => {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute, 0);
};

/** The local plan day key for an instant — the same 4 AM rule the server uses. */
const planDayOf = (date) => {
  const shifted = new Date(date);
  if (date.getHours() * 60 + date.getMinutes() < 240) shifted.setDate(shifted.getDate() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`;
};

const DAY = '2031-04-17';
const NEXT_DAY = '2031-04-18';

const group = (key, items, label = key) => ({ key, label, items });
const untaken = { taken: false };
const taken = { taken: true, takenAt: at(DAY, 8) };

/** What the server sends for a plan created at `createdAt` on `dayKey`. */
const activationFor = (dayKey, createdAtHour, graceSlots) => ({
  activatedAt: at(dayKey, createdAtHour).toISOString(),
  activatedDayKey: dayKey,
  activatedMinutes: createdAtHour * 60,
  graceSlots,
  isGraceDay: graceSlots.length > 0,
  firstJudgedDayKey: graceSlots.length > 0 ? NEXT_DAY : dayKey,
});

// ── Reading the server's answer ─────────────────────────────────────────────

test('the frames the server forgave are the frames this client forgives', () => {
  const activation = activationFor(DAY, 15, ['morning', 'anytime']);
  assert.deepEqual(graceSlotsFor(activation, at(DAY, 15)), ['morning', 'anytime']);
});

test('the exemption only applies on the plan day it names', () => {
  // Handed to any other day it forgives nothing. This is the guard against a tab
  // left open across the 4 AM reset carrying yesterday's leniency into today.
  const activation = activationFor(DAY, 15, ['morning']);
  assert.deepEqual(graceSlotsFor(activation, at(NEXT_DAY, 15)), []);
  assert.deepEqual(graceSlotsFor(activation, at('2031-06-01', 15)), []);
});

test('the day is matched on the 4 AM boundary, not at midnight', () => {
  // 02:00 is still the PREVIOUS plan day. A plan activated then must keep its
  // exemption at 02:00, and lose it at 04:00 — the same instant the server rolls
  // the day over, or the two would disagree for four hours every night.
  const planDay = planDayOf(at(DAY, 2));
  const activation = activationFor(planDay, 2, ['morning', 'anytime']);

  assert.notEqual(planDay, DAY, '02:00 belongs to the day that opened yesterday');
  assert.deepEqual(graceSlotsFor(activation, at(DAY, 2)), ['morning', 'anytime']);
  assert.deepEqual(graceSlotsFor(activation, at(DAY, 4)), []);
});

test('a day with no exemption is the same as no block at all', () => {
  const plain = activationFor(DAY, 5, []);
  assert.deepEqual(graceSlotsFor(plain, at(DAY, 15)), []);
  assert.deepEqual(graceSlotsFor(null, at(DAY, 15)), []);
});

test('an older server, or a dropped block, changes nothing', () => {
  // `planActivation` is additive: a client that never sees it must render exactly
  // what it rendered before, which is what makes the rule safe to roll out.
  for (const activation of [undefined, null, 0, '', 'morning', [], { graceSlots: ['morning'] }]) {
    assert.deepEqual(graceSlotsFor(activation, at(DAY, 15)), [], JSON.stringify(activation));
  }
});

test('a malformed day key forgives nothing', () => {
  for (const activatedDayKey of ['', 'nonsense', '2031-4-17', '17-04-2031', 20310417]) {
    assert.deepEqual(
      graceSlotsFor({ activatedDayKey, graceSlots: ['morning'] }, at(DAY, 15)),
      [],
      String(activatedDayKey),
    );
  }
});

test('unknown slot keys are dropped, and the rest survive', () => {
  // The server's list is trusted to be well-formed but not to be correct: a slot
  // this build does not know must not become an exemption, and must not take the
  // real ones down with it.
  assert.deepEqual(
    graceSlotsFor({ activatedDayKey: DAY, graceSlots: ['MORNING', 'midday', 'morning', '', null] }, at(DAY, 15)),
    ['morning'],
  );
  assert.deepEqual(graceSlotsFor({ activatedDayKey: DAY, graceSlots: 'morning' }, at(DAY, 15)), []);
});

// ── A forgiven frame is drawn as open, not as missed ────────────────────────

test('a closed frame the server forgave is ACTIVE, not MISSED', () => {
  const activation = activationFor(DAY, 15, ['morning']);
  const morning = group('morning', [untaken], 'Morning');

  assert.equal(sectionPlacement(morning, at(DAY, 15), activation), SECTION_PLACEMENT.ACTIVE);

  const plan = layoutPlan([morning], at(DAY, 15), activation);
  assert.deepEqual(plan.active.map((a) => a.group.key), ['morning']);
  assert.equal(plan.missed.total, 0, 'nothing may reach the red tray');
  assert.deepEqual(plan.missed.items, []);
});

test('the same frame is MISSED when the server did not forgive it', () => {
  // Without the block, 3 PM on a plan made at 5 AM is exactly what it always was.
  const morning = group('morning', [untaken], 'Morning');
  assert.equal(sectionPlacement(morning, at(DAY, 15)), SECTION_PLACEMENT.MISSED);
  assert.equal(layoutPlan([morning], at(DAY, 15)).missed.total, 1);
});

test('a forgiven frame is drawn unlocked, with its work still on the page', () => {
  const activation = activationFor(DAY, 15, ['morning']);
  const section = slotSectionState(group('morning', [untaken, untaken], 'Morning'), at(DAY, 15), activation);

  assert.equal(section.state, WINDOW_STATE.OPEN);
  assert.equal(section.isLocked, false);
  assert.equal(section.isMissed, false, 'a window the plan never saw cannot report a miss');
  assert.equal(section.total, 2);
  assert.equal(section.pending, 2);
  // The rows still have to be recordable — the exemption lifts the charge, not
  // the user's ability to take the dose.
  assert.equal(section.canTick, true);
  assert.equal(section.canTickAll, true);

  const plan = layoutPlan([group('morning', [untaken, untaken], 'Morning')], at(DAY, 15), activation);
  assert.equal(plan.hasWork, true, 'the empty state must still offer something to do');
});

test('a forgiven frame that is finished is complete, not missed', () => {
  const activation = activationFor(DAY, 15, ['morning']);
  const plan = layoutPlan([group('morning', [taken], 'Morning')], at(DAY, 15), activation);
  assert.equal(plan.missed.total, 0);
  assert.equal(plan.completedCount, 0);
});

test('the exemption is per frame, not a blanket pass for the day', () => {
  // A plan made at 3 PM forgives Morning only. Evening had not opened yet, and
  // must be placed by its own window — a rule that forgave everything still open
  // would hide the rest of the day.
  const activation = activationFor(DAY, 15, ['morning']);
  const groups = [
    group('morning', [untaken], 'Morning'),
    group('afternoon', [untaken], 'Afternoon'),
    group('evening', [untaken], 'Evening'),
    group('night', [untaken], 'Night'),
  ];

  const at15 = layoutPlan(groups, at(DAY, 15), activation);
  assert.deepEqual(at15.active.map((a) => a.group.key), ['morning', 'afternoon']);
  assert.equal(at15.upcomingCount, 2, 'Evening and Night are still to come');
  assert.equal(at15.missed.total, 0);

  // Later the same day, Morning is forgiven and Afternoon is not — Afternoon has
  // now closed unticked, and that IS a miss the user could have prevented. The
  // forgiven frame stays on the page, takeable, right beside the tray.
  const at19 = layoutPlan(groups, at(DAY, 19), activation);
  assert.deepEqual(at19.active.map((a) => a.group.key), ['morning', 'evening']);
  assert.equal(at19.missed.total, 1, 'Afternoon closed after the plan existed');
  assert.deepEqual(at19.missed.items.map((i) => i.missedFrom), ['Afternoon']);
});

test('frameHasClosed agrees with the placement it decided', () => {
  // The two must not disagree, or a hidden frame would be counted as completed
  // and a day would read as finished while its doses sat unticked.
  const activation = activationFor(DAY, 15, ['morning']);
  const morning = group('morning', [untaken], 'Morning');
  assert.equal(frameHasClosed(morning, at(DAY, 15), activation), false);
  assert.equal(sectionPlacement(morning, at(DAY, 15), activation), SECTION_PLACEMENT.ACTIVE);
});

test('Anytime is unaffected by the exemption, because it never closes', () => {
  const activation = activationFor(DAY, 23, ['morning', 'afternoon', 'evening', 'anytime']);
  const plan = layoutPlan([group('anytime', [untaken], 'Anytime')], at(DAY, 23, 30), activation);
  assert.equal(plan.anytime.group.key, 'anytime');
  assert.equal(plan.missed.total, 0);
});

// ── The note, and the fact that nothing else moved ──────────────────────────

test('the note appears only for a forgiven frame that still has work to do', () => {
  const activation = activationFor(DAY, 15, ['morning']);

  const withWork = layoutPlan([group('morning', [untaken], 'Morning')], at(DAY, 15), activation);
  assert.equal(withWork.grace.active, true);
  assert.deepEqual(withWork.grace.frames, ['morning']);
  assert.match(withWork.grace.text, /not counted as missed/);

  // All of it ticked: there is nothing to explain any more.
  const finished = layoutPlan([group('morning', [taken], 'Morning')], at(DAY, 15), activation);
  assert.equal(finished.grace.active, false);
  assert.equal(finished.grace.text, '');

  // Nothing forgiven at all: silent, as on every other day.
  const ordinary = layoutPlan([group('morning', [untaken], 'Morning')], at(DAY, 15));
  assert.equal(ordinary.grace.active, false);
  assert.equal(ordinary.grace.text, '');
});

test('the note says what happens next', () => {
  // "Not counted as missed" invites the obvious question. The note answers it in
  // the same sentence rather than leaving the user to guess whether this is
  // permanent.
  const plan = layoutPlan([group('morning', [untaken], 'Morning')], at(DAY, 15), activationFor(DAY, 15, ['morning']));
  assert.match(plan.grace.text, /from tomorrow/i);
});

test('the dead hours stay empty, and the note goes with them', () => {
  // Nothing is drawn at 2 AM — including the explanation. Showing "your plan
  // started mid-day" above an empty page at 2 AM would be noise, and the values
  // it describes belong to a day the user is not being shown.
  const plan = layoutPlan([group('morning', [untaken], 'Morning')], at(DAY, 2), activationFor(DAY, 2, ['morning']));
  assert.equal(plan.deadHour, true);
  assert.equal(plan.grace.active, false);
  assert.equal(plan.grace.text, '');
  assert.equal(plan.hasWork, false);
  assert.equal(plan.missed.total, 0);
});

test('the exemption changes nothing about a plan with no past frames', () => {
  // Byte-for-byte the layout a user has always seen, which is the promise the
  // second rulebook has to keep.
  const groups = [
    group('morning', [taken, untaken], 'Morning'),
    group('afternoon', [untaken], 'Afternoon'),
    group('anytime', [taken], 'Anytime'),
  ];
  for (const hour of [6, 9, 13, 19, 23]) {
    const now = at(DAY, hour);
    assert.deepEqual(
      layoutPlan(groups, now, { activatedDayKey: DAY, graceSlots: [] }),
      layoutPlan(groups, now),
      `${hour}:00 must be unchanged`,
    );
  }
});

test('an unrecognised third argument cannot crash the layout', () => {
  const morning = group('morning', [untaken], 'Morning');
  for (const activation of [undefined, null, 0, '', 'morning', [], [ 'morning' ], { graceSlots: 42 }]) {
    const plan = layoutPlan([morning], at(DAY, 15), activation);
    assert.equal(plan.missed.total, 1, JSON.stringify(activation));
  }
});
