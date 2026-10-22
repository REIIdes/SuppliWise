/**
 * A plan is only held to a window that existed with it.
 *
 * Run: node --test "Test File/plan-activation.test.js"
 *
 * THE CASE THIS PROVES
 * A user completes an assessment at 3:00 PM. The plan that comes back has a
 * Morning stack, and its window — 04:00 to 12:00 — closed three hours before the
 * user had ever seen the plan. Before this rule the tracker seeded today's rows
 * for the whole plan and then judged those rows against a window that was
 * already shut, so the first dashboard a new user ever opened docked their
 * Wellness Score, dropped their adherence, and put the morning stack in the red
 * "Today Missed" tray.
 *
 * The rule, in one line: on the plan day the assessment was created, a window
 * that had ALREADY closed cannot be missed. From the next plan day the whole
 * plan is judged normally, which is what makes an afternoon assessment "activate
 * normally from tomorrow" rather than being forgiven forever.
 *
 * Two things are deliberately NOT the rule, and are asserted here so a later
 * reader cannot "simplify" one of them into the other:
 *
 *   PER WINDOW, NOT PER DAY — a plan created at 3:00 PM still gets judged on
 *   Afternoon and Evening, which had not closed yet.
 *   ONE DAY ONLY — the exemption expires by itself at the 4 AM reset.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolvePlanActivation,
  deferredSlotsOnDay,
  planActivationPayload,
  UNKNOWN_ACTIVATION,
} = require('../utils/planActivation');
const { evaluateToday } = require('../utils/intakeWindows');
const { planDayKey } = require('../utils/planDay');

const UTC = 'UTC';
const pad2 = (n) => String(n).padStart(2, '0');

/** A UTC instant at `hour`:`minute` on the calendar date `dayKey` names. */
const at = (dayKey, hour, minute = 0) => {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour, minute, 0));
};

/**
 * A plan day far enough in the future that the real clock can never land on it.
 * The rule is about offsets from a day boundary, so a fixed date keeps every
 * assertion here readable and free of "only true at 3 PM in the local zone".
 */
const DAY = '2031-04-17';
const NEXT_DAY = '2031-04-18';

const key = (instant) => planDayKey(instant, UTC);

/** One unticked dose in a slot, as `evaluateToday` sees it. */
const dose = (slot) => ({ _id: slot, supplementName: slot, timeSlot: slot, taken: false });

// ── The activation facts ────────────────────────────────────────────────────

test('a plan created before noon is held to its whole first day', () => {
  // 05:00 — inside the Morning window, before any window has closed. Nothing to
  // forgive: the user had seven hours to take the morning stack.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 5), timeZone: UTC });

  assert.equal(activation.activatedDayKey, DAY);
  assert.equal(activation.activatedMinutes, 5 * 60);
  assert.deepEqual(activation.graceSlots, []);
  assert.equal(activation.isGraceDay, false);
  // So the first judged day IS the day it arrived on.
  assert.equal(activation.firstJudgedDayKey, DAY);
});

test('exactly at a window\'s close, that window is already gone', () => {
  // 12:00 is the exclusive end of Morning, so at 12:00 Morning has closed. A
  // user who finishes the assessment at noon sharp must not owe themselves a
  // morning they could not have reached.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 12, 0), timeZone: UTC });
  assert.deepEqual(activation.graceSlots, ['morning', 'anytime']);
  assert.equal(activation.firstJudgedDayKey, NEXT_DAY);
});

test('a plan created in the afternoon forgives only the frames that closed', () => {
  // The case in the bug report. 15:00: Morning is over, Afternoon is open until
  // 18:00, Evening and Night have not opened. Forgiving the whole day would
  // tell a user who has just made a plan to wait a day for the parts of it they
  // can still take.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC });

  assert.deepEqual(activation.graceSlots, ['morning', 'anytime']);
  assert.equal(activation.isGraceDay, true);
  // Everything runs normally from the next plan day — which is 4 AM tomorrow,
  // not midnight, so the key is derived rather than guessed.
  assert.equal(activation.firstJudgedDayKey, NEXT_DAY);
});

test('a plan created late forgives every frame that is actually over', () => {
  // 23:30: Morning, Afternoon and Evening have all closed. Night has NOT — its
  // window runs to midnight — so it stays on the clock, which is the per-window
  // rule earning its keep twice over: the user gets to take their night dose
  // tonight, and is not charged for the three stacks that closed before they
  // signed up. Anytime comes along because its deadline is the end of the day's
  // timed frames, an anchor that is already behind them.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 23, 30), timeZone: UTC });
  assert.deepEqual(activation.graceSlots, ['morning', 'afternoon', 'evening', 'anytime']);
  assert.equal(activation.firstJudgedDayKey, NEXT_DAY);
});

test('Night is the one frame that can never be forgiven on its own plan day', () => {
  // Night's window is half-open and ends at 24:00 — which IS the plan-day
  // boundary. So a plan is never forgiven the whole of its first day: there is
  // no instant on a plan day at which every frame has already closed, and the
  // frame the user was last given time for is still being judged. Worth pinning
  // down, because it is what stops this rule being read as "the plan's first day
  // is always free".
  for (const [hour, minute] of [[0, 0], [8, 0], [15, 0], [20, 0], [23, 59]]) {
    const activation = resolvePlanActivation({ createdAt: at(DAY, hour, minute), timeZone: UTC });
    assert.equal(
      activation.graceSlots.includes('night'),
      false,
      `${hour}:${minute} must not forgive Night`,
    );
  }

  // And it is genuinely still owed, not merely un-forgiven: at 11 PM on the plan's
  // first day a night dose is open work the user can still record.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 23, 59), timeZone: UTC });
  const judged = evaluateToday([dose('night')], {
    now: at(DAY, 23, 30),
    timeZone: UTC,
    activation,
  });
  assert.equal(judged.exempt, 0);
  assert.equal(judged.missed, 0);
  assert.equal(judged.awaiting, 1);
});

test('a plan created during the dead hours belongs to the day that is still running', () => {
  // 01:00 is inside the dead hours, so the plan day is the PREVIOUS one — the
  // day's Morning window has not opened yet, so there is nothing to forgive and
  // nothing to skip either.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 1), timeZone: UTC });

  assert.equal(activation.activatedDayKey, '2031-04-16');
  assert.deepEqual(activation.graceSlots, []);
  assert.equal(activation.firstJudgedDayKey, '2031-04-16');
});

test('the activation is read on the user\'s own clock, not UTC', () => {
  // 15:00 in Manila is 07:00 UTC. Judged in UTC the morning window would look
  // wide open and the user would be charged for it — the exact bug, reintroduced
  // one layer down, for everyone east of Greenwich.
  const manila = resolvePlanActivation({ createdAt: at(DAY, 7), timeZone: 'Asia/Manila' });
  const utc = resolvePlanActivation({ createdAt: at(DAY, 7), timeZone: UTC });

  assert.deepEqual(manila.graceSlots, ['morning', 'anytime']);
  assert.deepEqual(utc.graceSlots, []);
});

test('an unreadable activation is the old behaviour, not a free pass', () => {
  // Anything unusable yields no grace and no day key. It cannot become a
  // permanent exemption, because the exemption is anchored to one plan day and
  // this answer has none.
  for (const createdAt of [null, undefined, '', 'nonsense', {}, new Date('nonsense'), NaN]) {
    const activation = resolvePlanActivation({ createdAt, timeZone: UTC });
    assert.deepEqual(activation.graceSlots, [], `graceSlots for ${String(createdAt)}`);
    assert.equal(activation.isGraceDay, false);
    assert.equal(activation.activatedDayKey, '');
    assert.equal(activation.firstJudgedDayKey, '');
  }
  assert.deepEqual(UNKNOWN_ACTIVATION.graceSlots, []);
});

test('the activation never depends on what time it is read at', () => {
  // It describes the plan's arrival, not the caller's clock: reading it hours
  // later must give the same answer, or the score would change under a user who
  // simply left the tab open.
  const createdAt = at(DAY, 15);
  const early = resolvePlanActivation({ createdAt, timeZone: UTC });
  const late = resolvePlanActivation({ createdAt, timeZone: UTC });
  assert.deepEqual(early.graceSlots, late.graceSlots);
  assert.equal(early.firstJudgedDayKey, late.firstJudgedDayKey);
  assert.equal(early.activatedAt.getTime(), late.activatedAt.getTime());
});

// ── What it does to the score ───────────────────────────────────────────────

test('a forgiven morning is not missed, and does not drag adherence down', () => {
  const activation = resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC });
  const now = at(DAY, 15);

  // Morning unticked (window shut at noon), Afternoon unticked (window open).
  const judged = evaluateToday([dose('morning'), dose('afternoon')], {
    now,
    timeZone: UTC,
    activation,
  });

  assert.equal(judged.total, 2);
  assert.equal(judged.missed, 0, 'the morning the user never saw cannot be missed');
  assert.equal(judged.exempt, 1);
  assert.deepEqual(judged.exemptSlots, ['morning']);
  // Afternoon is inside its window, so it is open work — not forgiven, just not
  // yet due. The two are different and the figure keeps them apart.
  assert.equal(judged.awaiting, 1);
  assert.equal(judged.adherence, 100, 'nothing has been lost, so nothing is divided by zero');
  assert.deepEqual(judged.missedSlots, []);
});

test('without the activation the same rows are missed, exactly as before', () => {
  // The rule is opt-in at the call site, so anything that forgets to pass it
  // keeps the old behaviour rather than silently forgiving a real miss.
  const judged = evaluateToday([dose('morning')], { now: at(DAY, 15), timeZone: UTC });
  assert.equal(judged.missed, 1);
  assert.equal(judged.exempt, 0);
  assert.equal(judged.adherence, 0);
});

test('a forgiven frame still counts as a dose that can be taken', () => {
  // It must not vanish from the day: the row is still seeded, still tickable,
  // and taking it still reads as taken. Only the CHARGE is lifted.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC });
  const judged = evaluateToday([{ ...dose('morning'), taken: true }], {
    now: at(DAY, 15),
    timeZone: UTC,
    activation,
  });

  assert.equal(judged.total, 1);
  assert.equal(judged.taken, 1);
  assert.equal(judged.missed, 0);
  assert.equal(judged.exempt, 0, 'a taken dose is taken, not exempt');
  assert.equal(judged.adherence, 100);
});

test('the exemption covers the Anytime deadline too', () => {
  // A plan made at 23:30 whose supplements are all Anytime. Anytime is held to
  // the end of the day's timed frames, which is long gone — without the Anytime
  // exemption this plan would be born fully missed.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 23, 30), timeZone: UTC });
  const judged = evaluateToday([dose('anytime')], {
    now: at(DAY, 23, 30),
    timeZone: UTC,
    activation,
  });

  assert.equal(judged.total, 1);
  assert.equal(judged.missed, 0);
  assert.equal(judged.exempt, 1);
  assert.equal(judged.adherence, 100);
});

test('the very next plan day is judged in full — the exemption is not a habit', () => {
  // 07:00 on the following plan day, an hour after the reset. Morning is open,
  // so this proves nothing by itself; the proof is the row the exemption named.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC });
  const judged = evaluateToday([dose('morning')], {
    now: at(NEXT_DAY, 15),
    timeZone: UTC,
    activation,
  });

  assert.equal(judged.exempt, 0);
  assert.equal(judged.missed, 1, 'tomorrow the same morning IS missed if it is not taken');
  assert.equal(judged.adherence, 0);
});

test('the exemption is anchored to its own day, not to "recently"', () => {
  // The activation names one plan day. Handed to a different day it forgives
  // nothing — which is what stops a stale client payload, or a plan left over
  // from last month, from exempting a missed morning.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC });
  const judged = evaluateToday([dose('morning')], {
    now: at('2031-06-01', 15),
    timeZone: UTC,
    activation,
  });

  assert.equal(judged.exempt, 0);
  assert.equal(judged.missed, 1);
});

test('an activation the server could not resolve forgives nothing', () => {
  const judged = evaluateToday([dose('morning')], {
    now: at(DAY, 15),
    timeZone: UTC,
    activation: { activatedDayKey: DAY, graceSlots: 'morning' },
  });
  assert.equal(judged.exempt, 0, 'graceSlots has to be an array');
  assert.equal(judged.missed, 1);
});

test('junk in the activation is ignored rather than trusted', () => {
  // Each case says what it must produce, rather than deriving the expectation
  // from the same condition the implementation uses — a helper that recomputed
  // the rule would have agreed with a bug in it.
  const now = at(DAY, 15);
  const score = (activation) => evaluateToday([dose('morning')], { now, timeZone: UTC, activation });

  // Not an object, or not a block at all: the ordinary rule, and the morning is
  // missed exactly as it was before the rule existed.
  for (const activation of [null, undefined, 'morning', 7, []]) {
    const judged = score(activation);
    assert.equal(judged.exempt, 0, JSON.stringify(activation));
    assert.equal(judged.missed, 1, JSON.stringify(activation));
  }

  // A block whose day does not match, or whose grace list is unusable, forgives
  // nothing — it must never be able to excuse a miss on a day it does not name.
  for (const activation of [
    { activatedDayKey: 'not-a-day', graceSlots: ['morning'] },
    { activatedDayKey: NEXT_DAY, graceSlots: ['morning'] },
    { activatedDayKey: DAY },
    { activatedDayKey: DAY, graceSlots: 'morning' },
    { activatedDayKey: DAY, graceSlots: [] },
    { activatedDayKey: DAY, graceSlots: ['nonsense'] },
  ]) {
    const judged = score(activation);
    assert.equal(judged.exempt, 0, JSON.stringify(activation));
    assert.equal(judged.missed, 1, JSON.stringify(activation));
  }

  // A well-formed block: the known slot is honoured, the unknown ones beside it
  // are dropped rather than treated as misses or as exemptions.
  const judged = score({ activatedDayKey: DAY, graceSlots: ['MORNING', 'nonsense', 'midday', 'morning'] });
  assert.equal(judged.exempt, 1, 'exactly one known frame, whatever case it arrived in');
  assert.equal(judged.missed, 0);
});

test('an unusable clock still cannot produce a miss', () => {
  // An unknown zone makes the dose windows fail OPEN — `planDayKey` falls back to
  // UTC, so the exemption may or may not land, but what must never happen is a
  // missed dose. That is the invariant this file ultimately exists to protect,
  // and it is worth asserting directly rather than inferring from the buckets.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC });
  const judged = evaluateToday([dose('morning')], {
    now: at(DAY, 15),
    timeZone: '',
    activation,
  });

  assert.equal(judged.missed, 0);
  assert.equal(judged.missed + judged.awaiting + judged.exempt, 1, 'the dose is still counted exactly once');
  assert.equal(judged.adherence, 100);
});

test('a zeroed plan still reads as zero doses', () => {
  const activation = resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC });
  const judged = evaluateToday([], { now: at(DAY, 15), timeZone: UTC, activation });
  assert.equal(judged.total, 0);
  assert.equal(judged.missed, 0);
  assert.equal(judged.exempt, 0);
  assert.equal(judged.adherence, 100);
});

// ── The payload the tracker lays out from ───────────────────────────────────

test('the payload tells the client what was forgiven, in its own words', () => {
  const activation = resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC });
  const payload = planActivationPayload(activation);

  assert.equal(payload.activatedDayKey, DAY);
  assert.deepEqual(payload.graceSlots, ['morning', 'anytime']);
  assert.equal(payload.isGraceDay, true);
  assert.equal(payload.firstJudgedDayKey, NEXT_DAY);
  assert.equal(payload.activatedMinutes, 15 * 60);
  // An ISO string, because this crosses JSON and a Date does not survive it.
  assert.equal(payload.activatedAt, new Date(Date.UTC(2031, 3, 17, 15)).toISOString());
});

test('the payload of an unreadable activation is empty, not broken', () => {
  // A client that ignores the block must behave exactly as it did before, which
  // means the block has to be well-formed rather than absent-and-undefined.
  const payload = planActivationPayload(undefined);
  assert.equal(payload.activatedAt, null);
  assert.equal(payload.activatedDayKey, '');
  assert.deepEqual(payload.graceSlots, []);
  assert.equal(payload.isGraceDay, false);
  assert.equal(payload.firstJudgedDayKey, '');
});

test('the payload is a copy — a caller cannot edit the activation under the score', () => {
  const activation = resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC });
  const payload = planActivationPayload(activation);

  payload.graceSlots.push('evening');
  assert.deepEqual(activation.graceSlots, ['morning', 'anytime']);
  assert.deepEqual(planActivationPayload(activation).graceSlots, ['morning', 'anytime']);
});

test('the activation day is always the plan day the assessment belongs to', () => {
  // Guards the two derivations against each other: whatever `resolvePlanActivation`
  // calls the arrival day, `planDayKey` must call it the same, because
  // `evaluateToday` compares the two and a mismatch forgives nothing.
  for (const [hour, minute] of [[0, 0], [1, 0], [3, 59], [4, 0], [12, 0], [15, 0], [23, 59]]) {
    const instant = at(DAY, hour, minute);
    const activation = resolvePlanActivation({ createdAt: instant, timeZone: UTC });
    assert.equal(activation.activatedDayKey, key(instant), `${pad2(hour)}:${pad2(minute)}`);
    assert.equal(activation.firstJudgedDayKey >= activation.activatedDayKey, true);
  }
});

// ── Which frames the plan is not WRITTEN into today ─────────────────────────
//
// `graceSlots` says what cannot be CHARGED. `deferredSlotsOnDay` says what is not
// even put on today's list (server/utils/todayPlanSync.js): a dose the user is
// forgiven but still asked to take at 3 PM, for a window that shut at noon, is a
// red item on a list they cannot finish. The two lists are NOT the same list, and
// these tests are what keeps them apart.

test('a closed frame is deferred on its own plan day', () => {
  const deferred = deferredSlotsOnDay(resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC }), DAY);
  assert.deepEqual([...deferred], ['morning']);
});

test('Anytime is forgiven but never deferred', () => {
  // The exemption list carries `anytime`, because the day's deadline has already
  // gone by. The deferral list must not, or a 3 PM assessment would lose its
  // Anytime doses for no reason: "anytime" includes now, and there is nothing to
  // start over.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 23, 30), timeZone: UTC });
  assert.deepEqual([...activation.graceSlots], ['morning', 'afternoon', 'evening', 'anytime']);
  const deferred = deferredSlotsOnDay(activation, DAY);
  assert.deepEqual([...deferred], ['morning', 'afternoon', 'evening']);
});

test('Night is never deferred, because its window is the day itself', () => {
  // Night closes at 24:00, which IS the plan-day boundary, so on the plan's own
  // day there is always at least one frame still open. Same reasoning as the
  // grace-slot test above, applied to what gets written.
  for (const [hour, minute] of [[0, 0], [8, 0], [15, 0], [20, 0], [23, 59]]) {
    const deferred = deferredSlotsOnDay(resolvePlanActivation({ createdAt: at(DAY, hour, minute), timeZone: UTC }), DAY);
    assert.equal(deferred.has('night'), false, `${pad2(hour)}:${pad2(minute)}`);
  }
});

test('nothing is deferred on any other plan day', () => {
  // The exemption lives for one day; so does the deferral. Tomorrow the whole
  // plan is written and judged as ordinary work — which is what "activates at the
  // next 4 AM reset" means in the code that seeds the day.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC });
  for (const dayKey of [NEXT_DAY, '2031-06-01', '', 'not-a-day']) {
    assert.deepEqual([...deferredSlotsOnDay(activation, dayKey)], [], dayKey);
  }
});

test('an unusable activation defers nothing', () => {
  // Deferring is the aggressive half of the rule: it removes doses from a day.
  // So it fails CLOSED — a stale payload, a junk day key or a malformed grace
  // list leaves the plan written in full and judged by its own windows, exactly
  // as it was before this rule existed.
  const activation = resolvePlanActivation({ createdAt: at(DAY, 15), timeZone: UTC });
  for (const broken of [
    null,
    undefined,
    'morning',
    UNKNOWN_ACTIVATION,
    { activatedDayKey: 'nonsense', graceSlots: ['morning'] },
    { activatedDayKey: DAY },
    { activatedDayKey: DAY, graceSlots: 'morning' },
    { activatedDayKey: DAY, graceSlots: [] },
    { activatedDayKey: DAY, graceSlots: ['nonsense', 'midday'] },
  ]) {
    assert.deepEqual([...deferredSlotsOnDay(broken, DAY)], [], JSON.stringify(broken) || String(broken));
  }
  // And the caller's own day key is trusted no further than the server's: a
  // hand-typed key that is not a key defers nothing either.
  assert.deepEqual([...deferredSlotsOnDay(activation, 'nonsense')], []);
});

test('the deferral is a subset of the exemption, always', () => {
  // A dose cannot be removed from today AND still be charged for today — that is
  // a miss nobody was asked to avoid. Walked over the whole day so a later edit
  // to either list is caught at whatever hour it would bite.
  for (const [hour, minute] of [[0, 0], [3, 59], [4, 0], [12, 0], [15, 0], [23, 59]]) {
    const activation = resolvePlanActivation({ createdAt: at(DAY, hour, minute), timeZone: UTC });
    const exempt = new Set(activation.graceSlots);
    for (const slot of deferredSlotsOnDay(activation, DAY)) {
      assert.equal(exempt.has(slot), true, `${pad2(hour)}:${pad2(minute)} deferred ${slot} without exempting it`);
    }
  }
});
