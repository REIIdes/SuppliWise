'use strict';

/**
 * The rows a backfilled day is made of, and the routine that writes them.
 *
 * Run: npm test
 *
 * ── WHAT THIS PINS DOWN ─────────────────────────────────────────────────────
 *
 *   a backfilled day is the SAME plan GET / would have seeded that day
 *   a day that already has rows is never written to
 *   the resume pointer survives a throw half-way through a long gap
 *
 * The first is the one that could silently rot: if the two seeders drifted, a
 * dose from a backfilled day would be judged by a different slot than the same
 * dose on a live day, and the calendar would disagree with the score. So the
 * builder is called with the same inputs here that GET / gives it, and the slot
 * it lands on is asserted, not assumed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildDayDoseDocs, backfillMissedDays } = require('../utils/missedDayDoses');

const USER = '507f1f77bcf86cd799439011';
const ASSESSMENT = '507f1f77bcf86cd7994390aa';

const RECOMMENDATIONS = [
  { name: 'Vitamin D3', dosage: '2000 IU', priority: 'High', timing: 'With breakfast' },
  { name: 'Magnesium Glycinate', dosage: '350 mg', priority: 'Medium', timing: 'Evening with dinner' },
];
const DAILY_SCHEDULE = [
  { time: 'Morning', supplements: ['Vitamin D3'] },
  { time: 'Evening', supplements: ['Magnesium Glycinate'] },
];

/** A day key in the tests' own frame. These tests never read a wall clock. */
const DAY = '2026-10-12';
const TODAY = '2026-10-14';

/** An in-memory stand-in for IntakeRecord, matching on the fields the helper uses. */
function fakeModel(rows = [], { failOnBulkWriteFor = null } = {}) {
  const store = { rows: rows.slice(), writes: [] };

  const matches = (row, filter) => Object.entries(filter || {}).every(([field, value]) => {
    if (value instanceof Date) return true;
    return String(row[field]) === String(value);
  });

  return {
    store,
    async countDocuments(filter) {
      return store.rows.filter((row) => matches(row, filter)).length;
    },
    async bulkWrite(ops) {
      if (failOnBulkWriteFor && ops.some((op) => op.updateOne.filter.dayKey === failOnBulkWriteFor)) {
        throw new Error('write concern failed');
      }
      let upserted = 0;
      for (const op of ops) {
        const doc = op.updateOne.update.$setOnInsert;
        if (store.rows.some((row) => matches(row, op.updateOne.filter))) continue;
        store.rows.push({ _id: `r${store.rows.length}`, ...doc });
        upserted += 1;
      }
      store.writes.push(ops.length);
      return { upsertedCount: upserted };
    },
  };
}

// ── The doc builder ────────────────────────────────────────────────────────

test('a backfilled dose carries the same slot the live seeder would have given it', () => {
  const docs = buildDayDoseDocs(RECOMMENDATIONS, DAILY_SCHEDULE, { dayKey: DAY });
  assert.equal(docs.length, 2);
  assert.deepEqual(
    docs.map((d) => [d.supplementName, d.timeSlot, d.scheduledTime, d.priority, d.taken]),
    [
      ['Vitamin D3', 'morning', 'Morning', 'High', false],
      ['Magnesium Glycinate', 'evening', 'Evening', 'Medium', false],
    ],
  );
  // Unticked, and keyed to the day being judged — the day must not inherit
  // today's key or a missed Wednesday would show up as a missed Saturday.
  assert.ok(docs.every((d) => d.dayKey === DAY && d.taken === false && d.user === undefined));
});

test('the builder is total over junk plan output', () => {
  for (const junk of [null, undefined, 'nope', 42, {}]) {
    assert.deepEqual(buildDayDoseDocs(junk, junk, { dayKey: DAY }), [], JSON.stringify(junk));
  }
  // A recommendation with no name is dropped, not seeded as an empty row.
  assert.deepEqual(buildDayDoseDocs([{ dosage: '1', timing: 'Morning' }], [], { dayKey: DAY }), []);
  // And the daily schedule is optional — without it the timing text still places
  // the dose, which is what an Anytime-only plan is made of.
  const [d] = buildDayDoseDocs([{ name: 'Zinc', dosage: '15 mg', timing: 'With lunch' }], [], { dayKey: DAY });
  assert.equal(d.timeSlot, 'afternoon');
});

test('a day is capped at the same 20 doses the live seeder caps at', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `Pill ${i + 1}`, dosage: '1' }));
  assert.equal(buildDayDoseDocs(many, [], { dayKey: DAY }).length, 20);
});

// ── The backfill ───────────────────────────────────────────────────────────

test('a gap of two untouched days seeds both, and the pointer lands on yesterday', async () => {
  const Model = fakeModel();
  const metrics = { lastBackfilledDay: '' };

  const result = await backfillMissedDays({
    user: USER,
    assessment: ASSESSMENT,
    recommendations: RECOMMENDATIONS,
    dailySchedule: DAILY_SCHEDULE,
    metrics,
    todayKey: TODAY,
    sinceDayKey: DAY,
    IntakeRecord: Model,
  });

  assert.equal(result.days, 2);
  assert.equal(result.doses, 4);
  assert.equal(metrics.lastBackfilledDay, '2026-10-13', 'yesterday, never today');
  assert.deepEqual(
    Model.store.rows.map((r) => [r.dayKey, r.supplementName, r.taken]),
    [
      [DAY, 'Vitamin D3', false],
      [DAY, 'Magnesium Glycinate', false],
      ['2026-10-13', 'Vitamin D3', false],
      ['2026-10-13', 'Magnesium Glycinate', false],
    ],
  );
});

test('today is never seeded by the backfill, only judged', async () => {
  const Model = fakeModel();
  await backfillMissedDays({
    user: USER,
    assessment: ASSESSMENT,
    recommendations: RECOMMENDATIONS,
    dailySchedule: DAILY_SCHEDULE,
    metrics: {},
    todayKey: TODAY,
    sinceDayKey: '2026-10-11',
    IntakeRecord: Model,
  });
  assert.ok(Model.store.rows.every((r) => r.dayKey !== TODAY), 'a running day must stay window-aware');
});

test('a day that already has rows is left alone, ticked or not', async () => {
  // The 12th was opened and ignored: two unticked rows already scored. The 13th
  // was never opened at all.
  const Model = fakeModel([
    { user: USER, assessment: ASSESSMENT, dayKey: DAY, supplementName: 'Vitamin D3', taken: false },
    { user: USER, assessment: ASSESSMENT, dayKey: DAY, supplementName: 'Magnesium Glycinate', taken: false },
  ]);
  const metrics = { lastBackfilledDay: '' };

  const result = await backfillMissedDays({
    user: USER,
    assessment: ASSESSMENT,
    recommendations: RECOMMENDATIONS,
    dailySchedule: DAILY_SCHEDULE,
    metrics,
    todayKey: TODAY,
    sinceDayKey: DAY,
    IntakeRecord: Model,
  });

  assert.equal(result.days, 1, 'only the never-opened day is written');
  assert.equal(result.judged, 2, 'but both days are decided, so neither is re-tested next load');
  assert.equal(Model.store.rows.filter((r) => r.dayKey === DAY).length, 2, 'the attended day keeps exactly its own rows');
  assert.equal(metrics.lastBackfilledDay, '2026-10-13');
});

test('a pass over an already-decided window still moves the pointer forward', async () => {
  const Model = fakeModel();
  const metrics = { lastBackfilledDay: '2026-10-13' };
  const result = await backfillMissedDays({
    user: USER,
    assessment: ASSESSMENT,
    recommendations: RECOMMENDATIONS,
    dailySchedule: DAILY_SCHEDULE,
    metrics,
    todayKey: TODAY,
    sinceDayKey: DAY,
    IntakeRecord: Model,
  });
  assert.equal(result.days, 0);
  assert.equal(Model.store.writes.length, 0, 'nothing was asked of the database');
  assert.equal(metrics.lastBackfilledDay, '2026-10-13', 'the pointer never moves backwards');
});

test('a throw during the gap write leaves the pointer where it was', async () => {
  // The whole gap goes out in one bulkWrite. If it throws, nothing may be
  // claimed as decided — the pointer has to stay behind, so the next load
  // re-judges these days. That is safe precisely because every write is an
  // idempotent upsert on (user, assessment, supplementName, dayKey).
  const Model = fakeModel([], { failOnBulkWriteFor: '2026-10-13' });
  const metrics = { lastBackfilledDay: '' };

  await assert.rejects(
    () => backfillMissedDays({
      user: USER,
      assessment: ASSESSMENT,
      recommendations: [{ name: 'Vitamin D3', dosage: '2000 IU', timing: 'Morning' }],
      dailySchedule: DAILY_SCHEDULE,
      metrics,
      todayKey: TODAY,
      sinceDayKey: DAY,
      IntakeRecord: Model,
    }),
    /write concern failed/,
  );

  assert.equal(metrics.lastBackfilledDay, '', 'nothing was written, so nothing is claimed');
  assert.equal(Model.store.rows.length, 0);
});

test('a retried pass does not duplicate a day the first pass partly wrote', async () => {
  // `ordered: false` means a bulkWrite can land some days and reject others, or
  // the process can die mid-response. Either way the next pass must find the
  // rows and leave them alone, not stack a second copy of the same dose.
  const Model = fakeModel([
    { user: USER, assessment: ASSESSMENT, dayKey: DAY, supplementName: 'Vitamin D3', taken: false },
  ]);

  const result = await backfillMissedDays({
    user: USER,
    assessment: ASSESSMENT,
    recommendations: RECOMMENDATIONS,
    dailySchedule: DAILY_SCHEDULE,
    metrics: { lastBackfilledDay: '' },
    todayKey: TODAY,
    sinceDayKey: DAY,
    IntakeRecord: Model,
  });

  assert.equal(result.days, 1, 'only the still-empty day is written');
  assert.equal(Model.store.rows.filter((r) => r.dayKey === DAY).length, 1);
  assert.equal(Model.store.rows.filter((r) => r.dayKey === '2026-10-13').length, 2);
});

test('an empty plan has no days to have missed, and the pass is a no-op', async () => {
  const Model = fakeModel();
  const result = await backfillMissedDays({
    user: USER,
    assessment: ASSESSMENT,
    recommendations: [],
    dailySchedule: [],
    metrics: { lastBackfilledDay: '' },
    todayKey: TODAY,
    sinceDayKey: DAY,
    IntakeRecord: Model,
  });
  assert.equal(result.days, 0, 'nothing written');
  assert.equal(result.doses, 0);
  assert.equal(Model.store.rows.length, 0);
  assert.equal(result.judged, 2, 'the gap is still decided, so a plan-less user is re-walked once, not forever');
});

test('the lookback can be narrowed by the caller', async () => {
  const Model = fakeModel();
  const result = await backfillMissedDays({
    user: USER,
    assessment: ASSESSMENT,
    recommendations: RECOMMENDATIONS,
    dailySchedule: DAILY_SCHEDULE,
    metrics: {},
    todayKey: TODAY,
    sinceDayKey: '2020-01-01',
    lookbackDays: 3,
    IntakeRecord: Model,
  });
  assert.equal(result.days, 2, 'only the two days inside the window, today excluded');
  assert.deepEqual([...new Set(Model.store.rows.map((r) => r.dayKey))], ['2026-10-12', '2026-10-13']);
});
