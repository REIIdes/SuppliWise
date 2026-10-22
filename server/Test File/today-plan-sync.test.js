'use strict';

/**
 * Which doses of a plan become today's rows — and which wait for the next reset.
 *
 * Run: node --test "Test File/today-plan-sync.test.js"
 *
 * THE TWO BEHAVIOURS THIS PROVES
 *   A CLOSED FRAME IS NOT ASKED FOR. A plan made at 3 PM has a Morning stack
 *   whose window shut at noon. The score already forgave it (see
 *   Test File/plan-activation.test.js); these tests are about the other half —
 *   those rows are never written today, and are reported as starting at the next
 *   4 AM instead. The user's own words for this: "yung para sa umaga hindi na
 *   kailangan itake, kinabukasan ng alas-kwatro sya mag-aactivate."
 *
 *   AN UPDATE ADDS DOSES WITHOUT REPLAYING THE DAY. Updating an assessment makes
 *   a new assessment document. The old rule only seeded an EMPTY day, so the new
 *   supplements never appeared; and where the day did get re-seeded, a pill taken
 *   at 8 AM came back unticked. Now the plan syncs once per plan per day, and a
 *   dose already ticked on this plan day stays ticked whichever assessment the
 *   tick lives under.
 *
 * The day key, the activation and the clock are all handed in rather than read
 * from the wall clock, so every assertion here means the same at 03:00 as at
 * 15:00. The model is injected, so this needs no database and no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { splitTodayPlan, syncTodayPlan, isSynced } = require('../utils/todayPlanSync');
const { resolvePlanActivation } = require('../utils/planActivation');

const USER = '507f1f77bcf86cd799439011';
const OLD_ASSESSMENT = '507f1f77bcf86cd7994390aa';
const NEW_ASSESSMENT = '507f1f77bcf86cd7994390bb';
const UTC = 'UTC';

const DAY = '2031-04-17';
const NEXT_DAY = '2031-04-18';

/** A UTC instant on the fixed plan day. */
const at = (hour, minute = 0) => new Date(Date.UTC(2031, 3, 17, hour, minute, 0));

/** The activation of a plan that arrived at `hour` on DAY. */
const activationAt = (hour) => resolvePlanActivation({ createdAt: at(hour), timeZone: UTC });

const rec = (name, timing = 'Anytime') => ({ name, dosage: '1 cap', priority: 'Medium', timing });

/**
 * A plan with one dose in every frame, so "which frames survived" is readable
 * straight off the result.
 */
const FULL_PLAN = [
  rec('Morning Pill', 'Morning, with breakfast'),
  rec('Afternoon Pill', 'With lunch'),
  rec('Evening Pill', 'Evening, with dinner'),
  rec('Night Pill', '30 minutes before bed'),
  rec('Anytime Pill', 'Anytime'),
];

const names = (rows) => rows.map((row) => row.supplementName).sort();

/**
 * A stand-in for the IntakeRecord model, with the one Mongoose behaviour this
 * routine depends on: `$setOnInsert` on an upsert, filtered by the natural key.
 *
 * Emulated rather than stubbed flat, because "the row already exists, so nothing
 * is overwritten" is the property that protects a ticked dose — a no-op bulkWrite
 * would make every test here pass for the wrong reason.
 */
function fakeModel(seed = []) {
  const rows = seed.map((row, i) => ({
    _id: `507f1f77bcf86cd799439f${String(i).padStart(2, '0')}`,
    taken: false,
    takenAt: null,
    ...row,
  }));
  const matches = (filter) => rows.filter((row) => {
    if (filter.user !== undefined && String(row.user) !== String(filter.user)) return false;
    if (filter.assessment !== undefined && String(row.assessment) !== String(filter.assessment)) return false;
    if (filter.dayKey !== undefined && row.dayKey !== filter.dayKey) return false;
    if (filter.taken !== undefined && row.taken !== filter.taken) return false;
    if (filter.supplementName !== undefined && row.supplementName !== filter.supplementName) return false;
    return true;
  });

  const model = {
    rows,
    writes: 0,
    find(filter = {}) {
      const query = {
        select: () => query,
        limit: () => query,
        lean: async () => matches(filter).map((row) => ({ ...row })),
        then: (ok, err) => Promise.resolve(matches(filter).map((row) => ({ ...row }))).then(ok, err),
      };
      return query;
    },
    async bulkWrite(ops = []) {
      model.writes += 1;
      for (const op of ops) {
        const [existing] = matches(op.updateOne.filter);
        if (existing) continue; // $setOnInsert: a row that grew here stays as it is
        rows.push({ _id: `new-${rows.length}`, ...op.updateOne.update.$setOnInsert });
      }
      return { acknowledged: true, upsertedCount: ops.length };
    },
  };
  return model;
}

/** A metrics stand-in: `planSynced` is the only field this routine touches. */
const metricsFor = (planSynced) => ({ planSynced });

const run = ({ recommendations = FULL_PLAN, dailySchedule = [], model, metrics, todayKey = DAY, createdAt, now = at(15) } = {}) => syncTodayPlan({
  user: USER,
  assessment: NEW_ASSESSMENT,
  recommendations,
  dailySchedule,
  metrics,
  todayKey,
  now,
  activation: resolvePlanActivation({ createdAt, timeZone: UTC }),
  IntakeRecord: model,
});

// ── The split ───────────────────────────────────────────────────────────────

test('a plan made at 3 PM writes no Morning row today', () => {
  const { toWrite, waiting, deferredSlots } = splitTodayPlan(FULL_PLAN, [], {
    dayKey: DAY,
    date: at(15),
    activation: activationAt(15),
  });
  assert.deepEqual(deferredSlots, ['morning']);
  assert.deepEqual(names(toWrite), ['Afternoon Pill', 'Anytime Pill', 'Evening Pill', 'Night Pill']);
  assert.deepEqual(names(waiting), ['Morning Pill']);
});

test('Anytime is never deferred — "anytime" includes now', () => {
  // Even at 23:30, when the exemption list carries `anytime` so the day is not
  // born already failed. Being un-chargeable is not the same as being unwritten:
  // the user can still take it, tonight, and should be asked to.
  const { deferredSlots, waiting } = splitTodayPlan(FULL_PLAN, [], {
    dayKey: DAY,
    date: at(23, 30),
    activation: activationAt(23, 30),
  });
  assert.deepEqual(waiting.map((doc) => doc.supplementName), ['Morning Pill', 'Afternoon Pill', 'Evening Pill']);
  assert.deepEqual(deferredSlots, ['morning', 'afternoon', 'evening']);
});

test('a plan made at 5 AM writes the whole day and defers nothing', () => {
  const { toWrite, waiting, deferredSlots } = splitTodayPlan(FULL_PLAN, [], {
    dayKey: DAY,
    date: at(5),
    activation: activationAt(5),
  });
  assert.equal(toWrite.length, 5);
  assert.deepEqual(waiting, []);
  assert.deepEqual(deferredSlots, []);
});

test('the split only applies to the day the plan arrived on', () => {
  // Tomorrow the same activation forgives nothing, because the exemption is
  // anchored to one plan day — and a morning row that sat un-ticked tonight is a
  // real miss from the reset onwards.
  const { toWrite, waiting } = splitTodayPlan(FULL_PLAN, [], {
    dayKey: NEXT_DAY,
    date: new Date(Date.UTC(2031, 3, 18, 15)),
    activation: activationAt(15),
  });
  assert.equal(toWrite.length, 5);
  assert.deepEqual(waiting, []);
});

test('an unreadable activation defers nothing', () => {
  for (const activation of [null, undefined, {}, 'morning', { activatedDayKey: DAY, graceSlots: 'morning' }]) {
    const { toWrite, waiting } = splitTodayPlan(FULL_PLAN, [], { dayKey: DAY, date: at(15), activation });
    assert.equal(waiting.length, 0, JSON.stringify(activation));
    assert.equal(toWrite.length, 5, JSON.stringify(activation));
  }
});

test('a day key that is not a day key writes nothing', () => {
  // Writing rows keyed on junk would put a dose on no day at all — and the score
  // reads the whole day off that key.
  for (const dayKey of ['', 'not-a-day', undefined, '2031-4-17']) {
    const { toWrite, waiting } = splitTodayPlan(FULL_PLAN, [], { dayKey, date: at(15), activation: activationAt(15) });
    assert.deepEqual(toWrite, []);
    assert.deepEqual(waiting, []);
  }
});

// ── The write ───────────────────────────────────────────────────────────────

test('the deferred frames are not on today\'s page and are reported instead', async () => {
  const model = fakeModel();
  const metrics = metricsFor(undefined);
  const { records, deferred, synced } = await run({ model, metrics, createdAt: at(15) });

  assert.equal(synced, true, 'the first load of a plan day syncs');
  assert.deepEqual(names(records), ['Afternoon Pill', 'Anytime Pill', 'Evening Pill', 'Night Pill']);
  assert.equal(deferred.count, 1);
  assert.deepEqual(deferred.items.map((i) => i.name), ['Morning Pill']);
  assert.equal(deferred.items[0].timeSlot, 'morning');
  assert.equal(deferred.items[0].dosage, '1 cap');
  assert.equal(deferred.startsDayKey, NEXT_DAY, 'the reset that turns them into ordinary work');
  assert.equal(deferred.startsAtLabel, '4:00 AM');
});

test('the sync marker records the plan and the day together', async () => {
  const model = fakeModel();
  const metrics = metricsFor(undefined);
  await run({ model, metrics, createdAt: at(15) });
  assert.deepEqual(metrics.planSynced, { assessment: NEW_ASSESSMENT, dayKey: DAY });
  assert.equal(isSynced(metrics, NEW_ASSESSMENT, DAY), true);
  assert.equal(isSynced(metrics, OLD_ASSESSMENT, DAY), false, 'a different plan is a different sync');
  assert.equal(isSynced(metrics, NEW_ASSESSMENT, NEXT_DAY), false, 'a different day is a different sync');
});

test('the second load of the day writes nothing, so a removed dose stays removed', async () => {
  // This is why the sync is once per plan per day and not every load: POST
  // /remove-supplement hard-deletes today's row, and the plan still names that
  // supplement. A sync on every request would resurrect it, forever.
  const model = fakeModel();
  const metrics = metricsFor({ assessment: NEW_ASSESSMENT, dayKey: DAY });
  const { records, synced } = await run({ model, metrics, createdAt: at(15) });
  assert.equal(model.writes, 0, 'a day already synced is not written again');
  assert.deepEqual(records, []);
  assert.equal(synced, false);
});

test('a dose already ticked keeps its tick and its timestamp', async () => {
  // `$setOnInsert`, not `$set`: the sync adds what the plan is missing and leaves
  // what the user already recorded alone.
  const takenAt = at(13, 30);
  const model = fakeModel([
    { user: USER, assessment: NEW_ASSESSMENT, dayKey: DAY, supplementName: 'Afternoon Pill', taken: true, takenAt, timeSlot: 'afternoon' },
  ]);
  const { records } = await run({ model, metrics: metricsFor(undefined), createdAt: at(15) });
  const afternoon = records.find((row) => row.supplementName === 'Afternoon Pill');
  assert.equal(afternoon.taken, true);
  assert.equal(afternoon.takenAt.getTime(), takenAt.getTime());
  assert.equal(records.length, 4, 'the other three frames are added beside it');
});

// ── An update is not a new day ──────────────────────────────────────────────

test('an update adds its new supplement to a day that already has rows', async () => {
  // The bug the old `length === 0` guard shipped: the user updates their
  // assessment, the plan gains Vitamin D, and the tracker keeps showing the same
  // four doses, because the old plan's rows already filled the day.
  const model = fakeModel([
    { user: USER, assessment: OLD_ASSESSMENT, dayKey: DAY, supplementName: 'Morning Pill', taken: false, timeSlot: 'morning' },
    { user: USER, assessment: OLD_ASSESSMENT, dayKey: DAY, supplementName: 'Afternoon Pill', taken: false, timeSlot: 'afternoon' },
  ]);
  const { records } = await run({
    model,
    metrics: metricsFor(undefined),
    recommendations: [rec('Morning Pill', 'Morning'), rec('Afternoon Pill', 'With lunch'), rec('Vitamin D3', 'Morning')],
    createdAt: at(4, 30),
  });
  assert.deepEqual(names(records), ['Afternoon Pill', 'Morning Pill', 'Vitamin D3']);
});

test('a dose ticked under the replaced plan stays ticked on the new one', async () => {
  // The case the user named: "kung natake na nya o hindi pa, hindi na kailangan
  // itake ulit." The tick lives under the OLD assessment — the history migration
  // may not have run, or may have failed — and a pill taken at 8 AM must not come
  // back asking to be taken a second time.
  const takenAt = at(8, 5);
  const model = fakeModel([
    { user: USER, assessment: OLD_ASSESSMENT, dayKey: DAY, supplementName: 'Morning Pill', taken: true, takenAt, timeSlot: 'morning' },
  ]);
  const { records } = await run({
    model,
    metrics: metricsFor(undefined),
    recommendations: [rec('Morning Pill', 'Morning'), rec('Afternoon Pill', 'With lunch')],
    // 13:30 so Morning is closed: it is deferred rather than written, which is
    // what the next test pins down — here Morning is still open.
    createdAt: at(4, 30),
  });
  const morning = records.find((row) => row.supplementName === 'Morning Pill');
  assert.equal(morning.assessment, NEW_ASSESSMENT, 'the row belongs to the new plan');
  assert.equal(morning.taken, true, 'and the tick came across with it');
  assert.equal(morning.takenAt.getTime(), takenAt.getTime(), 'with the hour it was actually taken at');
});

test('inherited ticks survive a name written a different way', async () => {
  // The plans are AI output on both sides, so "Magnesium Glycinate" and
  // "magnesium glycinate " are the same dose. Matched by the same normalisation
  // the slot resolver uses, not by string equality.
  const model = fakeModel([
    { user: USER, assessment: OLD_ASSESSMENT, dayKey: DAY, supplementName: '  Magnesium Glycinate ', taken: true, takenAt: at(9), timeSlot: 'evening' },
  ]);
  const { records } = await run({
    model,
    metrics: metricsFor(undefined),
    recommendations: [rec('magnesium glycinate', 'Evening, with dinner')],
    createdAt: at(4, 30),
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].taken, true);
});

test('a tick from a different plan day is not inherited', async () => {
  const model = fakeModel([
    { user: USER, assessment: OLD_ASSESSMENT, dayKey: '2031-04-16', supplementName: 'Morning Pill', taken: true, takenAt: at(9), timeSlot: 'morning' },
  ]);
  const { records } = await run({
    model,
    metrics: metricsFor(undefined),
    recommendations: [rec('Morning Pill', 'Morning')],
    createdAt: at(4, 30),
  });
  assert.equal(records[0].taken, false, 'yesterday\'s dose says nothing about today\'s');
});

test('the deferred list never names a dose that is on the page', async () => {
  // Either today's row or tomorrow's start — never both, and never the same card
  // twice on one screen. This is what lets a day seeded before the rule existed
  // keep showing its Morning as today's work.
  const model = fakeModel([
    { user: USER, assessment: NEW_ASSESSMENT, dayKey: DAY, supplementName: 'Morning Pill', taken: false, timeSlot: 'morning' },
  ]);
  const { records, deferred } = await run({ model, metrics: metricsFor(undefined), createdAt: at(15) });
  assert.deepEqual(names(records), ['Afternoon Pill', 'Anytime Pill', 'Evening Pill', 'Morning Pill', 'Night Pill']);
  assert.equal(deferred.count, 0, 'the Morning row that exists is today\'s, not tomorrow\'s');
});

test('a ticked dose in a closed frame is a row, not a deferred item', async () => {
  // The user took their morning pill at 8, then the plan was updated at 3 PM. The
  // tick lives under the old assessment and the frame is now deferred — but the
  // row is written anyway, because a dose that was TAKEN is history, and history
  // belongs to today.
  const model = fakeModel([
    { user: USER, assessment: OLD_ASSESSMENT, dayKey: DAY, supplementName: 'Morning Pill', taken: true, takenAt: at(8), timeSlot: 'morning' },
  ]);
  const { records, deferred } = await run({
    model,
    metrics: metricsFor(undefined),
    recommendations: [rec('Morning Pill', 'Morning'), rec('Afternoon Pill', 'With lunch')],
    createdAt: at(15),
  });
  assert.equal(deferred.count, 0);
  assert.deepEqual(names(records), ['Afternoon Pill', 'Morning Pill']);
});

// ── Junk, and the shape that always comes back ──────────────────────────────

test('no recommendations means no rows and no deferred list, but the day is synced', async () => {
  // The marker still moves: an empty plan is a decision, not a failure, and
  // leaving it unset would re-run the sync on every load for a user who has no
  // supplements yet.
  const model = fakeModel();
  const metrics = metricsFor(undefined);
  const { records, deferred, synced } = await run({ model, metrics, recommendations: [], createdAt: at(15) });
  assert.deepEqual(records, []);
  assert.equal(deferred.count, 0);
  assert.deepEqual(deferred.items, []);
  assert.equal(synced, true);
});

test('a junk day key reads the day and reports nothing deferred', async () => {
  const model = fakeModel();
  const { records, deferred, synced } = await run({ model, metrics: metricsFor(undefined), todayKey: 'nonsense', createdAt: at(15) });
  assert.deepEqual(records, []);
  assert.equal(deferred.count, 0);
  assert.equal(synced, false, 'nothing was decided, so nothing may be remembered');
});

test('the deferred payload always carries its fields', async () => {
  const model = fakeModel();
  const { deferred } = await run({ model, metrics: metricsFor(undefined), recommendations: [], createdAt: at(15) });
  for (const field of ['count', 'items', 'startsDayKey', 'startsAtLabel']) {
    assert.ok(Object.prototype.hasOwnProperty.call(deferred, field), `planDeferred.${field}`);
  }
});

test('metrics without a place to put the marker still write the day', async () => {
  // A caller that hands in no metrics gets the rows and simply cannot remember
  // that it did, so it syncs again next load — which is the old behaviour, not a
  // new bug: every write it repeats is an idempotent upsert.
  const model = fakeModel();
  const { records, synced } = await run({ model, metrics: null, createdAt: at(4, 30) });
  assert.equal(records.length, 5);
  assert.equal(synced, true);
});
