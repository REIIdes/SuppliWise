'use strict';

/**
 * POST /api/assessment/:id/migrate-history — the update-assessment handover.
 *
 * Run: npm test
 *
 * ── What this route is for ──────────────────────────────────────────────────
 * Updating a plan creates a NEW assessment, and every row the tracker reads is
 * filed under an assessment id. Without a handover the user's streak, their
 * adherence, and — worst — the doses they ticked THIS MORNING would all be
 * stranded under the record they just replaced, and the tracker would ask them to
 * take them again. That is the whole complaint this feature answers.
 *
 * ── Why the metrics assertion is the important one ──────────────────────────
 * The metrics copy is a `findOneAndUpdate` with `upsert: true`, and Mongoose does
 * NOT run document validation on an update. It will happily file a row missing a
 * required path. Reading it back works; the next `GET /api/dashboard` calls
 * `metrics.save()`, which validates the WHOLE document, throws, and the dashboard
 * answers 500 for the rest of the day — on every day after an update, which is
 * exactly the sequence this route exists to serve.
 *
 * So the copy is asserted against the real schema, not against a list of field
 * names a stub would accept whatever it was handed.
 *
 * No MongoDB and no network: the models are replaced for the duration of each
 * test and restored after it.
 */

const express = require('express');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Assessment = require('../models/Assessment');
const IntakeRecord = require('../models/IntakeRecord');
const DashboardMetrics = require('../models/DashboardMetrics');
const authMiddleware = require('../middleware/auth');
const { planDayKey } = require('../utils/planDay');

const USER_ID = '507f1f77bcf86cd799439011';
const OLD_ID = '507f1f77bcf86cd7994390aa';
const NEW_ID = '507f1f77bcf86cd7994390ab';
const UTC = 'UTC';

const dayKey = () => planDayKey(new Date(), UTC);

/** A dose row, in the shape `.select('_id dayKey supplementName taken takenAt')` returns. */
const row = (id, assessment, day, name, taken = false) => ({
  _id: id, user: USER_ID, assessment, dayKey: day, supplementName: name,
  taken, takenAt: taken ? new Date('2026-01-01T08:00:00.000Z') : null,
});

/**
 * A tiny stand-in for the rows collection.
 *
 * `updateMany` and `deleteMany` only have to understand the filters this route
 * actually sends — equality plus `_id: { $in / $nin }` — so the matcher is
 * deliberately small instead of a Mongo reimplementation.
 */
function store(rows) {
  const live = rows.slice();
  const matches = (doc, filter = {}) => Object.entries(filter).every(([key, want]) => {
    if (want && typeof want === 'object' && '$in' in want) return want.$in.some((v) => String(v) === String(doc[key]));
    if (want && typeof want === 'object' && '$nin' in want) return !want.$nin.some((v) => String(v) === String(doc[key]));
    return String(doc[key]) === String(want);
  });
  const list = (filter) => live.filter((doc) => matches(doc, filter));
  const chain = (docs) => ({
    select: () => chain(docs),
    lean: async () => docs.map((d) => ({ ...d })),
    then: (ok, bad) => Promise.resolve(docs).then(ok, bad),
  });
  return {
    live,
    find: (filter) => chain(list(filter)),
    async updateMany(filter, update) {
      const docs = list(filter);
      for (const doc of docs) Object.assign(doc, update.$set);
      return { modifiedCount: docs.length };
    },
    async updateOne(filter, update) {
      const doc = list(filter)[0];
      if (doc) Object.assign(doc, update.$set);
      return { modifiedCount: doc ? 1 : 0 };
    },
    async deleteMany(filter) {
      const doomed = new Set(list(filter).map((d) => String(d._id)));
      for (let i = live.length - 1; i >= 0; i -= 1) if (doomed.has(String(live[i]._id))) live.splice(i, 1);
      return { deletedCount: doomed.size };
    },
  };
}

const OLD_PLAN = {
  recommendations: [
    { name: 'Vitamin D3 (Cholecalciferol)' },
    { name: 'Zinc Picolinate' },
    { name: 'Magnesium Glycinate' },
  ],
};
// The update drops Zinc and adds Omega-3.
const NEW_PLAN = {
  recommendations: [
    { name: 'Vitamin D3 (Cholecalciferol)' },
    { name: 'Magnesium Glycinate' },
    { name: 'Omega-3 Fish Oil (EPA/DHA)' },
  ],
};

let restore = null;
afterEach(() => {
  if (!restore) return;
  const r = restore;
  restore = null;
  r();
});

/**
 * Mount the real router over stubbed models and POST the migration.
 * Returns the response plus the metrics `$set` the route tried to write.
 */
async function migrate({ rows, oldMetrics = {}, timezone = UTC }) {
  const records = store(rows);
  const assessments = {
    [OLD_ID]: { _id: OLD_ID, user: USER_ID, aiResults: OLD_PLAN, createdAt: new Date('2026-01-01T00:00:00.000Z') },
    [NEW_ID]: { _id: NEW_ID, user: USER_ID, aiResults: NEW_PLAN, createdAt: new Date('2026-01-05T00:00:00.000Z') },
  };
  const metricsWrites = [];

  const originals = {
    protect: authMiddleware.protect,
    assessmentFindOne: Assessment.findOne,
    intakeFind: IntakeRecord.find,
    intakeUpdateMany: IntakeRecord.updateMany,
    intakeUpdateOne: IntakeRecord.updateOne,
    intakeDeleteMany: IntakeRecord.deleteMany,
    metricsFindOne: DashboardMetrics.findOne,
    metricsFindOneAndUpdate: DashboardMetrics.findOneAndUpdate,
  };
  restore = () => {
    authMiddleware.protect = originals.protect;
    Assessment.findOne = originals.assessmentFindOne;
    IntakeRecord.find = originals.intakeFind;
    IntakeRecord.updateMany = originals.intakeUpdateMany;
    IntakeRecord.updateOne = originals.intakeUpdateOne;
    IntakeRecord.deleteMany = originals.intakeDeleteMany;
    DashboardMetrics.findOne = originals.metricsFindOne;
    DashboardMetrics.findOneAndUpdate = originals.metricsFindOneAndUpdate;
    delete require.cache[require.resolve('../routes/assessment')];
  };

  authMiddleware.protect = (req, res, next) => {
    req.user = { _id: USER_ID, timeZone: '' };
    next();
  };
  Assessment.findOne = (filter) => {
    const found = assessments[String(filter._id)];
    return { then: (ok, bad) => Promise.resolve(found && String(found.user) === String(filter.user) ? found : null).then(ok, bad) };
  };
  IntakeRecord.find = records.find;
  IntakeRecord.updateMany = records.updateMany;
  IntakeRecord.updateOne = records.updateOne;
  IntakeRecord.deleteMany = records.deleteMany;
  DashboardMetrics.findOne = () => Promise.resolve(oldMetrics ? { user: USER_ID, assessment: OLD_ID, ...oldMetrics } : null);
  DashboardMetrics.findOneAndUpdate = async (filter, update) => {
    metricsWrites.push({ filter, set: update.$set });
    return null;
  };

  delete require.cache[require.resolve('../routes/assessment')];
  const app = express();
  app.use(express.json());
  app.use('/api/assessment', require('../routes/assessment'));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/assessment`;
    const res = await fetch(`${base}/${OLD_ID}/migrate-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Timezone': timezone },
      body: JSON.stringify({ newAssessmentId: NEW_ID }),
    });
    const body = await res.json();
    return { status: res.status, body, records, metricsWrites };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ── The rows ───────────────────────────────────────────────────────────────

test('every dose the replacement plan still has moves across, and nothing is stranded', async () => {
  const today = dayKey();
  const { status, body, records } = await migrate({
    rows: [
      row('r1', OLD_ID, '2031-04-15', 'Vitamin D3 (Cholecalciferol)', true),
      row('r2', OLD_ID, '2031-04-16', 'Vitamin D3 (Cholecalciferol)', true),
      row('r3', OLD_ID, today, 'Vitamin D3 (Cholecalciferol)', true),
    ],
  });

  assert.equal(status, 200);
  assert.equal(body.recordsMigrated, 3);
  assert.equal(records.live.filter((r) => String(r.assessment) === OLD_ID).length, 0, 'nothing left under the replaced plan');
  assert.equal(records.live.filter((r) => String(r.assessment) === NEW_ID).length, 3);
  assert.ok(records.live.every((r) => r.taken), 'a ticked dose is still ticked after the move');
});

test('a dose the new plan already has a row for is not moved onto it', async () => {
  // GET / may have seeded today under the new assessment before this route runs.
  // Moving the old row as well would give the same (day, dose) twice, and the
  // tracker would count that dose twice against a day of three.
  const today = dayKey();
  const { body, records } = await migrate({
    rows: [
      row('r1', OLD_ID, today, 'Magnesium Glycinate', true),
      row('r2', NEW_ID, today, 'Magnesium Glycinate', false),
    ],
  });

  const magnesium = records.live.filter((r) => r.supplementName === 'Magnesium Glycinate');
  const onNew = magnesium.filter((r) => String(r.assessment) === NEW_ID);
  assert.equal(onNew.length, 1, 'the replacement has exactly one row for that (day, dose)');
  assert.equal(String(onNew[0]._id), 'r2', 'and it is the one the tracker renders');
  assert.equal(magnesium.find((r) => String(r._id) === 'r1').taken, true, 'the old row stays where it is, as history');
  assert.equal(body.dosesInherited, 1);
});

test('the taken state crosses onto the row the tracker renders', async () => {
  const today = dayKey();
  const takenAt = new Date('2026-01-05T00:30:00.000Z');
  const { records } = await migrate({
    rows: [
      { ...row('r1', OLD_ID, today, 'Vitamin D3 (Cholecalciferol)', true), takenAt },
      row('r2', NEW_ID, today, 'Vitamin D3 (Cholecalciferol)', false),
    ],
  });

  const onNew = records.live.find((r) => String(r._id) === 'r2');
  assert.equal(onNew.taken, true, 'the morning dose is not asked for again');
  assert.equal(String(onNew.takenAt), String(takenAt), 'with the timestamp it was actually taken at');
});

// ── What gets deleted ──────────────────────────────────────────────────────

test('today\'s placeholder for a dropped supplement is pruned', async () => {
  const today = dayKey();
  const { body, records } = await migrate({
    rows: [
      row('r1', OLD_ID, today, 'Zinc Picolinate', false), // the new plan has no Zinc
      row('r2', OLD_ID, '2031-04-16', 'Zinc Picolinate', false), // but yesterday is history
    ],
  });

  assert.equal(body.staleDosesPruned, 1);
  assert.ok(records.live.some((r) => String(r._id) === 'r2'), 'a past day\'s row is never touched');
  assert.ok(!records.live.some((r) => String(r._id) === 'r1'));
});

test('a dose the user added by hand is left alone', async () => {
  // It appears in neither plan, so this route has no idea whether it is wanted.
  const today = dayKey();
  const { body, records } = await migrate({
    rows: [
      row('r1', OLD_ID, today, 'Ashwagandha KSM-66', false),
      row('r2', OLD_ID, today, 'Zinc Picolinate', false),
    ],
  });

  assert.equal(body.staleDosesPruned, 1, 'only the plan-dropped one');
  assert.ok(records.live.some((r) => String(r._id) === 'r1'));
});

test('a ticked dose the new plan dropped is history, not clutter', async () => {
  const today = dayKey();
  const { body, records } = await migrate({
    rows: [row('r1', OLD_ID, today, 'Zinc Picolinate', true)],
  });

  assert.equal(body.staleDosesPruned, 0);
  assert.equal(records.live.length, 1, 'pruning a taken dose would erase the proof they took it');
});

test('yesterday\'s untaken placeholder is not pruned either', async () => {
  const { body, records } = await migrate({
    rows: [row('r1', OLD_ID, '2031-04-16', 'Zinc Picolinate', false)],
  });
  assert.equal(body.staleDosesPruned, 0);
  assert.equal(records.live.length, 1);
});

// ── The metrics ────────────────────────────────────────────────────────────

test('the copied metrics document satisfies the real DashboardMetrics schema', async () => {
  const { metricsWrites } = await migrate({
    rows: [],
    oldMetrics: {
      assessmentStartDate: new Date('2026-01-01T00:00:00.000Z'),
      currentStreak: 4, longestStreak: 9, totalDaysTracked: 21,
      overallAdherence: 83, energyLevel: 'High', streakAwardedToday: true,
      lastTrackedDate: new Date('2026-01-05T00:00:00.000Z'), lastCompletedDay: '2031-04-16',
    },
  });

  assert.equal(metricsWrites.length, 1, 'the metrics copy must run');
  const set = metricsWrites[0].set;

  // This is the assertion that catches the bug the live run found: an upsert with
  // `$set` writes whatever it is given, so a missing required path only shows up
  // the next time something calls `save()` on the row — which is the dashboard.
  const doc = new DashboardMetrics({ user: USER_ID, assessment: NEW_ID, ...set });
  const error = await doc.validate().then(() => null, (err) => err);
  assert.equal(error, null, `the copied metrics would fail validation: ${error && error.message}`);

  assert.equal(set.currentStreak, 4, 'the streak survives the update');
  assert.equal(set.longestStreak, 9);
  assert.equal(set.totalDaysTracked, 21);
  assert.equal(set.overallAdherence, 83);
  assert.equal(set.lastCompletedDay, '2031-04-16');
  assert.equal(set.isActive, true);
});

test('the metrics copy carries the streak, not fields the model does not have', async () => {
  const { metricsWrites } = await migrate({
    rows: [],
    // `streak` and `lastStreakUpdate` are what this copy used to read. Neither is
    // a DashboardMetrics path, so every update silently stored nothing at all.
    oldMetrics: { streak: 7, lastStreakUpdate: new Date(), currentStreak: 2 },
  });

  const set = metricsWrites[0].set;
  assert.equal('streak' in set, false, 'a field the schema has no path for is a silent no-op');
  assert.equal(set.currentStreak, 2);
});

test('an account with no metrics yet gets a document that still validates', async () => {
  const { metricsWrites, body } = await migrate({ rows: [], oldMetrics: null });
  assert.equal(metricsWrites.length, 0, 'nothing to copy');
  assert.equal(body.metricsCopied, false);
  assert.equal(body.message, 'History migrated successfully.');
});

// ── Refusals ───────────────────────────────────────────────────────────────

test('a migration to somebody else\'s assessment is refused', async () => {
  const app = express();
  app.use(express.json());
  const originals = { protect: authMiddleware.protect, findOne: Assessment.findOne };
  authMiddleware.protect = (req, res, next) => { req.user = { _id: USER_ID }; next(); };
  Assessment.findOne = (filter) => ({
    then: (ok, bad) => Promise.resolve(
      String(filter._id) === OLD_ID && String(filter.user) === USER_ID
        ? { _id: OLD_ID, user: USER_ID, aiResults: OLD_PLAN }
        : null,
    ).then(ok, bad),
  });
  delete require.cache[require.resolve('../routes/assessment')];
  app.use('/api/assessment', require('../routes/assessment'));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/assessment/${OLD_ID}/migrate-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newAssessmentId: NEW_ID }),
    });
    assert.equal(res.status, 404, 'the target must belong to this user too');
  } finally {
    authMiddleware.protect = originals.protect;
    Assessment.findOne = originals.findOne;
    delete require.cache[require.resolve('../routes/assessment')];
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a missing or malformed target id is a 400, not a CastError', async () => {
  const app = express();
  app.use(express.json());
  const originals = { protect: authMiddleware.protect };
  authMiddleware.protect = (req, res, next) => { req.user = { _id: USER_ID }; next(); };
  delete require.cache[require.resolve('../routes/assessment')];
  app.use('/api/assessment', require('../routes/assessment'));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/assessment/${OLD_ID}/migrate-history`;
    for (const newAssessmentId of [undefined, 'not-an-id']) {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newAssessmentId === undefined ? {} : { newAssessmentId }),
      });
      assert.equal(res.status, 400, `${newAssessmentId} must be rejected before it reaches a query`);
    }
  } finally {
    authMiddleware.protect = originals.protect;
    delete require.cache[require.resolve('../routes/assessment')];
    await new Promise((resolve) => server.close(resolve));
  }
});
