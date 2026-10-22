'use strict';

/**
 * End-to-end tests for the two intake behaviours this change adds:
 *
 *   1. "Today's Supplements" is grouped by the AI daily schedule's
 *      Morning / Afternoon / Evening slots, and
 *   2. a whole slot can be marked taken in one press (POST /intake/bulk).
 *
 * Run: npm test
 *
 * ── Why these are HTTP tests and not unit tests ─────────────────────────────
 *
 * The interesting property of the bulk endpoint is not that it writes `taken:
 * true` — it is that it produces the SAME streak, adherence, wellness and
 * priority bookkeeping as five separate single presses would, but computed once
 * from the final state. Those rules live behind ~180 lines of metrics logic in
 * the route, and the only way to prove the two paths agree is to exercise the
 * real router with a stubbed database and compare the two responses.
 *
 * The other property is refusal: a bulk request must never be able to touch a
 * past day's read-only history, another user's records, or a plan belonging to
 * two assessments at once. Each of those is a 4xx here.
 *
 * No MongoDB and no network: the models are stubbed with a local chainable
 * query helper — these routes chain `.select()`, `.sort()` and `.lean()` and
 * then await the result, so the double has to support all three (the shared
 * `stubQuery` covers `.select().lean()` but not `.sort()`, which is what the
 * "latest assessment" lookups use). node's runner isolates this file's
 * process.
 */

const express = require('express');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Assessment = require('../models/Assessment');
const IntakeRecord = require('../models/IntakeRecord');
const DashboardMetrics = require('../models/DashboardMetrics');
const UserNotification = require('../models/UserNotification');
const AdminEvent = require('../models/AdminEvent');
const authMiddleware = require('../middleware/auth');

const USER_ID = '507f1f77bcf86cd799439011';
const OTHER_USER_ID = '507f1f77bcf86cd799439099';
const ASSESSMENT_ID = '507f1f77bcf86cd7994390aa';
// The plan this user had BEFORE the update. Rows ticked under it are what the
// new plan must inherit — see the plan-sync tests at the bottom of this file.
const PREVIOUS_ASSESSMENT_ID = '507f1f77bcf86cd7994390ab';

/**
 * The plan day these rows are seeded under.
 *
 * This was `new Date().toISOString().split('T')[0]` — the UTC calendar date —
 * which is NOT the key the dashboard routes read IntakeRecord by any more. A
 * plan day runs 04:00 -> 04:00, so between 00:00 and 04:00 UTC the running plan
 * day is the PREVIOUS date, and this suite then seeded a day's records under a
 * key no route would ask for: the plan rendered empty, and POST /intake/bulk
 * refused every press with "Only today's supplements can be updated". The whole
 * file failed for those four hours and passed for the other twenty — which is the
 * worst kind of suite failure, because it looks like a flaky environment rather
 * than a clock-dependent assertion.
 *
 * Derived from `planDayKey` rather than restated, so this suite cannot drift from
 * the rule it is testing. Same fix as Test File/admin-override.test.js.
 */
const { planDayKey, shiftDayKey } = require('../utils/planDay');

const dayKey = () => planDayKey(new Date(), 'UTC');

/** The plan day after the one running now. */
const nextDayKey = () => shiftDayKey(dayKey(), 1);

/**
 * "Now", but pinned to the opening minute of the RUNNING plan day.
 *
 * The suite's stub assessment used to be created at `new Date()`, which is a clock
 * reading rather than a fact about the plan — and it silently made every
 * assertion below depend on what time of day the suite happened to run. That was
 * already true of the plan-day key; adding the plan-arrival rule (see
 * utils/planActivation.js) made it worse, because an assessment created "now" in
 * the afternoon has a morning window that closed before it existed.
 *
 * 04:00 is the one instant on a plan day that is unambiguously the beginning of
 * it: no window has closed, so there is nothing to forgive, and the backfill floor
 * is today. Every test that wants a different activation passes its own instant.
 */
const planDayOpening = () => {
  const [y, m, d] = dayKey().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 4, 0, 0));
};

/** A UTC instant at `hour`:`minute` on the current plan day's calendar date. */
const planDayAt = (hour, minute = 0) => {
  const [y, m, d] = dayKey().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour, minute, 0));
};

/** The plan as the results page renders it, so the test mirrors a real plan. */
const DAILY_SCHEDULE = [
  { time: 'Morning', supplements: ['Omega-3 Fish Oil (EPA/DHA)', 'Vitamin D3 (Cholecalciferol)'] },
  { time: 'Afternoon', supplements: ['Zinc Picolinate'] },
  { time: 'Evening', supplements: ['Magnesium Glycinate'] },
];

const RECOMMENDATIONS = [
  { name: 'Omega-3 Fish Oil (EPA/DHA)', dosage: '1000 mg', priority: 'High', timing: 'With meals' },
  { name: 'Vitamin D3 (Cholecalciferol)', dosage: '2000 IU', priority: 'High', timing: 'With a meal containing fat' },
  { name: 'Zinc Picolinate', dosage: '30 mg', priority: 'Medium', timing: 'With lunch' },
  { name: 'Magnesium Glycinate', dosage: '350 mg', priority: 'Medium', timing: 'Evening with dinner' },
];

/** In-memory stand-in for IntakeRecord, scoped to one user + one day. */
function recordStore() {
  const rows = [];
  return {
    rows,
    reset() { rows.length = 0; },
    seed(items) {
      rows.length = 0;
      let n = 0;
      for (const item of items) {
        n += 1;
        rows.push({
          // Real ObjectId-shaped ids: the route validates incoming ids with
          // `mongoose.isValidObjectId`, so a stub id like "rec1" would be
          // rejected as malformed and the test would pass for the wrong reason.
          _id: `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}`,
          user: USER_ID,
          assessment: ASSESSMENT_ID,
          supplementName: item.name,
          dosage: item.dosage || '',
          priority: item.priority || 'Medium',
          scheduledTime: item.scheduledTime || item.timing || 'Anytime',
          // What the seeder stores, and what "is this dose missed?" is decided
          // from (utils/intakeWindows.js). Passed through so a test can state the
          // slot directly instead of relying on the wording of `scheduledTime`;
          // left undefined, the real fallback to the text still applies.
          timeSlot: item.timeSlot,
          taken: !!item.taken,
          takenAt: item.taken ? new Date() : null,
          date: new Date(),
          dayKey: item.dayKey || dayKey(),
        });
      }
      return rows;
    },
    find(filter = {}) {
      return rows.filter((row) => {
        if (filter.user && String(row.user) !== String(filter.user)) return false;
        if (filter.assessment && String(row.assessment) !== String(filter.assessment)) return false;
        if (filter.dayKey && row.dayKey !== filter.dayKey) return false;
        if (filter.taken !== undefined && row.taken !== filter.taken) return false;
        if (filter._id) {
          // Supports both the `$in` list form (bulk) and a bare id (single).
          const wanted = filter._id.$in
            ? filter._id.$in.map(String)
            : [String(filter._id)];
          if (!wanted.includes(String(row._id))) return false;
        }
        return true;
      });
    },
    countDocuments(filter = {}) {
      return this.find(filter).length;
    },
    async updateMany(filter, update) {
      const hits = this.find(filter);
      for (const row of hits) {
        row.taken = update.$set.taken;
        row.takenAt = update.$set.takenAt;
      }
      return { modifiedCount: hits.length };
    },
    /**
     * The one Mongoose behaviour the plan seeder relies on: `$setOnInsert` on an
     * upsert keyed by (user, assessment, supplementName, dayKey). Emulated rather
     * than stubbed flat, because "a row that is already here keeps its tick" is
     * the property that stops an Update replaying a dose the user took at 8 AM —
     * a no-op bulkWrite would let the seeding tests pass for the wrong reason.
     */
    async bulkWriteUpsert(ops = []) {
      for (const op of ops) {
        const filter = op.updateOne.filter;
        const exists = rows.some((row) => String(row.user) === String(filter.user)
          && String(row.assessment) === String(filter.assessment)
          && row.dayKey === filter.dayKey
          && row.supplementName === filter.supplementName);
        if (exists) continue;
        rows.push({
          _id: `507f1f77bcf86cd799439e${String(rows.length).padStart(2, '0')}`,
          takenAt: null,
          ...op.updateOne.update.$setOnInsert,
        });
      }
      return { acknowledged: true, upsertedCount: ops.length };
    },
    /** The single-record endpoint saves a hydrated doc; write it back in place. */
    persist(row) {
      const index = this.rows.findIndex(r => String(r._id) === String(row._id));
      if (index >= 0) this.rows[index] = row;
      return row;
    },
  };
}

let store;
let metricsDoc;
let server;
let base;

/**
 * A Mongoose-shaped query double: thenable AND chainable, because the dashboard
 * routes mix both — `Assessment.findOne({...}).sort({createdAt: -1})` and
 * `IntakeRecord.find({...}).select('taken').lean()`.
 */
function chainableQuery(source) {
  const resolve = () => Promise.resolve(typeof source === 'function' ? source() : source);
  const query = {
    select: () => query,
    sort: () => query,
    limit: () => query,
    // `.lean()` must preserve ARRAYS as arrays. Spreading one into `{...value}`
    // turns a find() result into an object keyed by index, and every caller that
    // then does `.filter()` on it throws — which is exactly what happened here.
    lean: async () => {
      const value = await resolve();
      if (Array.isArray(value)) return value.map((row) => ({ ...row }));
      return value ? { ...value } : null;
    },
    then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected),
    catch: (onRejected) => resolve().catch(onRejected),
  };
  return query;
}

/** Mount the real dashboard router with the DB stubbed out. */
async function withDashboard(fn, { assessment, emulateUpsert = false } = {}) {
  const originals = {
    assessmentFindOne: Assessment.findOne,
    intakeFind: IntakeRecord.find,
    intakeFindOne: IntakeRecord.findOne,
    intakeCount: IntakeRecord.countDocuments,
    intakeUpdateMany: IntakeRecord.updateMany,
    intakeBulkWrite: IntakeRecord.bulkWrite,
    metricsFindOne: DashboardMetrics.findOne,
    metricsSave: DashboardMetrics.prototype.save,
    metricsCreate: DashboardMetrics.create,
    userFindByIdAndUpdate: require('../models/User').findByIdAndUpdate,
    assessmentFindById: Assessment.findById,
    assessmentUpdate: Assessment.findByIdAndUpdate,
    notificationCreate: UserNotification.create,
    adminEventCreate: AdminEvent.create,
    protect: authMiddleware.protect,
  };

  // `protect` stands in for a real session: the router only ever needs a user
  // object, and stubbing it here keeps every test off the token path.
  authMiddleware.protect = (req, _res, next) => {
    req.user = { _id: USER_ID, plan: 'Premium', role: 'user' };
    next();
  };

  const assessmentDoc = assessment === null ? null : (assessment || {
    _id: ASSESSMENT_ID,
    user: USER_ID,
    createdAt: planDayOpening(),
    aiResults: { recommendations: RECOMMENDATIONS, dailySchedule: DAILY_SCHEDULE },
  });

  Assessment.findOne = () => chainableQuery(assessmentDoc);
  Assessment.findById = () => chainableQuery(assessmentDoc);
  Assessment.findByIdAndUpdate = async () => ({ _id: ASSESSMENT_ID });
  IntakeRecord.find = (filter) => chainableQuery(store.find(filter || {}));
  // Unstubbed, this buffers for 10s and then 500s — which is how the
  // single-record comparison below first "failed" for a reason that had
  // nothing to do with the behaviour under test. It returns the LIVE row with a
  // `save()`, because the single endpoint mutates a hydrated document and saves
  // it, whereas the bulk endpoint writes through updateMany.
  IntakeRecord.findOne = (filter) => {
    const row = store.find({ ...(filter || {}) })[0] || null;
    if (row && typeof row.save !== 'function') {
      row.save = async function save() {
        store.persist(row);
        return row;
      };
    }
    return chainableQuery(row);
  };
  IntakeRecord.countDocuments = async (filter) => store.countDocuments(filter || {});
  IntakeRecord.updateMany = async (filter, update) => store.updateMany(filter, update);
  // Flat by default: most of this file seeds its day through `store.seed`, so a
  // seeder that also wrote rows would change what those tests read. A test that
  // is ABOUT the seeder passes `emulateUpsert` and gets the real behaviour.
  IntakeRecord.bulkWrite = emulateUpsert
    ? async (ops) => store.bulkWriteUpsert(ops)
    : async () => ({ upsertedCount: 0 });
  DashboardMetrics.findOne = () => chainableQuery(metricsDoc);
  DashboardMetrics.create = async () => metricsDoc;
  DashboardMetrics.prototype.save = async function save() { return this; };
  require('../models/User').findByIdAndUpdate = async () => ({});
  UserNotification.create = async () => ({ _id: 'note' });
  AdminEvent.create = async () => ({ _id: 'event' });

  delete require.cache[require.resolve('../routes/dashboard')];
  const router = require('../routes/dashboard');
  const app = express();
  app.use(express.json());
  app.use('/api/dashboard', router);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/dashboard`;

  const call = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };

  try {
    return await fn({ call });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    authMiddleware.protect = originals.protect;
    Assessment.findOne = originals.assessmentFindOne;
    Assessment.findById = originals.assessmentFindById;
    Assessment.findByIdAndUpdate = originals.assessmentUpdate;
    IntakeRecord.find = originals.intakeFind;
    IntakeRecord.findOne = originals.intakeFindOne;
    IntakeRecord.countDocuments = originals.intakeCount;
    IntakeRecord.updateMany = originals.intakeUpdateMany;
    IntakeRecord.bulkWrite = originals.intakeBulkWrite;
    DashboardMetrics.findOne = originals.metricsFindOne;
    DashboardMetrics.create = originals.metricsCreate;
    DashboardMetrics.prototype.save = originals.metricsSave;
    require('../models/User').findByIdAndUpdate = originals.userFindByIdAndUpdate;
    UserNotification.create = originals.notificationCreate;
    AdminEvent.create = originals.adminEventCreate;
    delete require.cache[require.resolve('../routes/dashboard')];
  }
}

beforeEach(() => {
  store = recordStore();
  metricsDoc = {
    _id: 'metrics1',
    user: USER_ID,
    assessment: ASSESSMENT_ID,
    currentStreak: 0,
    longestStreak: 0,
    overallAdherence: 0,
    wellnessScore: 0,
    streakAwardedToday: false,
    lastCompletedDay: null,
    lastTrackedDate: null,
    isActive: true,
    save: async function save() { return this; },
  };
});

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});

// ── GET / — the grouping the tracker renders ────────────────────────────────

test('GET / groups today\'s plan by the AI daily schedule slots', async () => {
  store.seed([
    { name: 'Magnesium Glycinate', dosage: '350 mg', taken: false },
    { name: 'Vitamin D3 (Cholecalciferol)', dosage: '2000 IU', taken: false },
    { name: 'Omega-3 Fish Oil (EPA/DHA)', dosage: '1000 mg', taken: false },
    { name: 'Zinc Picolinate', dosage: '30 mg', taken: false },
  ]);

  await withDashboard(async ({ call }) => {
    const { status, body } = await call('/');
    assert.equal(status, 200);

    const byName = Object.fromEntries(body.todaysSupplements.map((s) => [s.name, s]));

    // The schedule decides, even where the recommendation's own timing text
    // points somewhere else (both say "With meals").
    assert.equal(byName['Omega-3 Fish Oil (EPA/DHA)'].timeSlot, 'morning');
    assert.equal(byName['Vitamin D3 (Cholecalciferol)'].timeSlot, 'morning');
    assert.equal(byName['Zinc Picolinate'].timeSlot, 'afternoon');
    assert.equal(byName['Magnesium Glycinate'].timeSlot, 'evening');

    // Everything the client renders is present and non-empty.
    for (const supplement of body.todaysSupplements) {
      assert.ok(typeof supplement.timeSlotLabel === 'string');
      assert.equal(typeof supplement.timeSlotOrder, 'number');
      assert.ok(supplement.scheduleTime);
    }

    // Every slot carries a distinct clock position, so a client that sorts by
    // it groups correctly. (The endpoint does not itself order the array —
    // the client owns display order — so this checks the set, not the order.)
    const orders = body.todaysSupplements.map((s) => s.timeSlotOrder);
    assert.deepEqual([...orders].sort((a, b) => a - b), [0, 0, 1, 2]);

    // The existing fields are untouched — nothing downstream regressed.
    assert.equal(body.stats.todaysProgress.total, 4);
    assert.equal(body.stats.todaysProgress.taken, 0);
    assert.equal(byName['Zinc Picolinate'].scheduledTime, 'With lunch');
  }, {});
});

test('GET / reports Anytime rather than dropping a supplement it cannot place', async () => {
  store.seed([
    { name: 'Melatonin', dosage: '3 mg', taken: false },
    { name: 'Zinc Picolinate', dosage: '30 mg', taken: false },
  ]);

  await withDashboard(async ({ call }) => {
    const { body } = await call('/');
    const melatonin = body.todaysSupplements.find((s) => s.name === 'Melatonin');
    // Melatonin is not in the schedule; its stored time names no part of day.
    assert.equal(melatonin.timeSlot, 'anytime');
    assert.equal(body.todaysSupplements.length, 2, 'nothing may be hidden');
  }, {});
});

test('GET / survives an assessment with no daily schedule at all', async () => {
  store.seed([{ name: 'Zinc Picolinate', dosage: '30 mg', taken: false }]);

  await withDashboard(async ({ call }) => {
    const { status, body } = await call('/');
    assert.equal(status, 200);
    // Falls back to the recommendation's own timing.
    assert.equal(body.todaysSupplements[0].timeSlot, 'afternoon');
  }, {
    assessment: {
      _id: ASSESSMENT_ID,
      user: USER_ID,
      createdAt: new Date(),
      aiResults: { recommendations: RECOMMENDATIONS, dailySchedule: [] },
    },
  });
});

// ── POST /intake/bulk — one press for a whole slot ─────────────────────────

test('POST /intake/bulk marks every record in the request taken', async () => {
  store.seed([
    { name: 'Vitamin D3 (Cholecalciferol)', taken: false },
    { name: 'Omega-3 Fish Oil (EPA/DHA)', taken: false },
    { name: 'Magnesium Glycinate', taken: false },
  ]);

  await withDashboard(async ({ call }) => {
    const ids = store.rows.slice(0, 2).map((r) => r._id);
    const { status, body } = await call('/intake/bulk', { recordIds: ids, taken: true });

    assert.equal(status, 200);
    assert.equal(body.updated, 2);
    assert.equal(store.rows[0].taken, true);
    assert.equal(store.rows[1].taken, true);
    assert.ok(store.rows[0].takenAt instanceof Date);
    // The untouched supplement stays untouched — a slot press is not "take all".
    assert.equal(store.rows[2].taken, false);
  }, {});
});

test('POST /intake/bulk returns the same stats as ticking the same rows one by one', async () => {
  // The property that justifies the endpoint existing: pressing "take all
  // morning" five times must not award and then revoke the day-complete streak
  // five times on the way through, so bulk and single have to converge.
  const runBulk = async () => {
    store.seed([
      { name: 'Omega-3 Fish Oil (EPA/DHA)', taken: false },
      { name: 'Vitamin D3 (Cholecalciferol)', taken: false },
      { name: 'Zinc Picolinate', taken: false },
    ]);
    metricsDoc.currentStreak = 2;
    metricsDoc.longestStreak = 2;
    return withDashboard(async ({ call }) => {
      const ids = store.rows.slice(0, 2).map((r) => r._id);
      const { body } = await call('/intake/bulk', { recordIds: ids, taken: true });
      return body.stats;
    }, {});
  };

  const runSingles = async () => {
    store.seed([
      { name: 'Omega-3 Fish Oil (EPA/DHA)', taken: false },
      { name: 'Vitamin D3 (Cholecalciferol)', taken: false },
      { name: 'Zinc Picolinate', taken: false },
    ]);
    metricsDoc.currentStreak = 2;
    metricsDoc.longestStreak = 2;
    return withDashboard(async ({ call }) => {
      let last;
      for (const id of store.rows.slice(0, 2).map((r) => r._id)) {
        last = (await call('/intake', { recordId: id, taken: true })).body;
      }
      return last.stats;
    }, {});
  };

  const bulk = await runBulk();
  const singles = await runSingles();
  assert.deepEqual(bulk, singles);
  assert.equal(bulk.todaysProgress.taken, 2);
  assert.equal(bulk.todaysProgress.total, 3);
});

test('POST /intake/bulk awards the streak once when it completes the day', async () => {
  store.seed([
    { name: 'Omega-3 Fish Oil (EPA/DHA)', taken: false },
    { name: 'Magnesium Glycinate', taken: false },
  ]);

  await withDashboard(async ({ call }) => {
    const ids = store.rows.map((r) => r._id);
    const { body } = await call('/intake/bulk', { recordIds: ids, taken: true });
    assert.equal(body.stats.todaysProgress.taken, 2);
    assert.equal(body.stats.todaysProgress.percentage, 100);
    assert.equal(body.stats.daysStreak, 1, 'one completion, one point');
    assert.equal(metricsDoc.streakAwardedToday, true);
    assert.equal(metricsDoc.lastCompletedDay, dayKey());
  }, {});
});

test('POST /intake/bulk does not award the streak while the day is incomplete', async () => {
  store.seed([
    { name: 'Omega-3 Fish Oil (EPA/DHA)', taken: false },
    { name: 'Magnesium Glycinate', taken: false },
  ]);

  await withDashboard(async ({ call }) => {
    const ids = [store.rows[0]._id];
    const { body } = await call('/intake/bulk', { recordIds: ids, taken: true });
    assert.equal(body.stats.todaysProgress.percentage, 50);
    assert.equal(body.stats.daysStreak, 0);
  }, {});
});

test('POST /intake/bulk cannot rewrite past days', async () => {
  store.seed([{ name: 'Omega-3 Fish Oil (EPA/DHA)', taken: false, dayKey: '2020-01-01' }]);

  await withDashboard(async ({ call }) => {
    const { status, body } = await call('/intake/bulk', {
      recordIds: [store.rows[0]._id],
      taken: true,
    });
    assert.equal(status, 400);
    assert.match(body.message, /Past days are read-only/i);
    assert.equal(store.rows[0].taken, false, 'history must be unchanged');
  }, {});
});

test('POST /intake/bulk skips past-day rows when the batch is mixed, and says so', async () => {
  store.seed([
    { name: 'Omega-3 Fish Oil (EPA/DHA)', taken: false },
    { name: 'Vitamin D3 (Cholecalciferol)', taken: false, dayKey: '2020-01-01' },
  ]);

  await withDashboard(async ({ call }) => {
    const ids = store.rows.map((r) => r._id);
    const { status, body } = await call('/intake/bulk', { recordIds: ids, taken: true });
    assert.equal(status, 200);
    assert.equal(body.updated, 1);
    assert.equal(body.skipped, 1);
    assert.equal(store.rows[0].taken, true);
    assert.equal(store.rows[1].taken, false);
  }, {});
});

test('POST /intake/bulk cannot reach another user\'s records', async () => {
  store.seed([{ name: 'Omega-3 Fish Oil (EPA/DHA)', taken: false }]);
  // The stubbed `protect` always attaches USER_ID, so a row owned by somebody
  // else is simply never found — the route must 404, not update it.
  store.rows[0].user = OTHER_USER_ID;

  await withDashboard(async ({ call }) => {
    const { status, body } = await call('/intake/bulk', {
      recordIds: [store.rows[0]._id],
      taken: true,
    });
    assert.equal(status, 404);
    assert.match(body.message, /not found/i);
    assert.equal(store.rows[0].taken, false);
  }, {});
});

test('POST /intake/bulk rejects a batch spanning two assessments', async () => {
  store.seed([
    { name: 'Omega-3 Fish Oil (EPA/DHA)', taken: false },
    { name: 'Zinc Picolinate', taken: false },
  ]);
  store.rows[1].assessment = '507f1f77bcf86cd7990999ff';

  await withDashboard(async ({ call }) => {
    const { status, body } = await call('/intake/bulk', {
      recordIds: store.rows.map((r) => r._id),
      taken: true,
    });
    assert.equal(status, 400);
    assert.match(body.message, /different plans/i);
    assert.equal(store.rows[0].taken, false);
    assert.equal(store.rows[1].taken, false);
  }, {});
});

test('POST /intake/bulk refuses malformed input instead of 500-ing', async () => {
  store.seed([{ name: 'Omega-3 Fish Oil (EPA/DHA)', taken: false }]);

  await withDashboard(async ({ call }) => {
    const cases = [
      [{}, /at least one/i],
      [{ recordIds: [], taken: true }, /at least one/i],
      [{ recordIds: ['not-an-id'], taken: true }, /No valid supplements/i],
      [{ recordIds: [{ $ne: null }], taken: true }, /No valid supplements/i],
      [{ recordIds: [store.rows[0]._id] }, /Taken status is required/i],
      [{ recordIds: [store.rows[0]._id], taken: 'yes' }, /Taken status is required/i],
      [{ recordIds: Array.from({ length: 61 }, (_, i) => `507f1f77bcf86cd79943910${String(i).padStart(2, '0')}`), taken: true }, /Too many supplements/i],
    ];

    for (const [body, matcher] of cases) {
      const res = await call('/intake/bulk', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.message, matcher, JSON.stringify(body));
    }
    assert.equal(store.rows[0].taken, false, 'no rejected request may write');
  }, {});
});

test('POST /intake/bulk can mark a slot not-taken again', async () => {
  store.seed([
    { name: 'Omega-3 Fish Oil (EPA/DHA)', taken: true },
    { name: 'Vitamin D3 (Cholecalciferol)', taken: true },
  ]);

  await withDashboard(async ({ call }) => {
    const ids = store.rows.map((r) => r._id);
    const { status, body } = await call('/intake/bulk', { recordIds: ids, taken: false });
    assert.equal(status, 200);
    assert.equal(store.rows[0].taken, false);
    assert.equal(store.rows[0].takenAt, null, 'takenAt must be cleared, not left stale');
  }, {});
});

// ── GET /current-supplements — the assessment pre-fill ─────────────────────

test('GET /current-supplements detects a user already on a plan', async () => {
  store.seed([
    { name: 'Omega-3 Fish Oil (EPA/DHA)', taken: true },
    { name: 'Magnesium Glycinate', taken: false },
  ]);

  await withDashboard(async ({ call }) => {
    const { status, body } = await call('/current-supplements');
    assert.equal(status, 200);
    assert.equal(body.takingSupplements, true);
    assert.equal(body.hasPlan, true);
    assert.equal(body.takenCount, 1);
    assert.deepEqual(body.supplements, ['Omega-3 Fish Oil (EPA/DHA)', 'Magnesium Glycinate']);
  }, {});
});

test('GET /current-supplements counts an unticked plan as taking something', async () => {
  store.seed([{ name: 'Zinc Picolinate', taken: false }]);

  await withDashboard(async ({ call }) => {
    const { body } = await call('/current-supplements');
    assert.equal(body.takingSupplements, true);
    assert.equal(body.takenCount, 0);
  }, {});
});

test('GET /current-supplements says No for a user with no assessment', async () => {
  await withDashboard(async ({ call }) => {
    const { status, body } = await call('/current-supplements');
    assert.equal(status, 200);
    // The client leaves the question blank on this, so the user answers it.
    assert.equal(body.takingSupplements, false);
    assert.equal(body.hasPlan, false);
    assert.deepEqual(body.supplements, []);
  }, { assessment: null });
});

test('GET /current-supplements falls back to recommendations when no plan exists', async () => {
  // A user who took an assessment but never opened the tracker still has a plan.
  await withDashboard(async ({ call }) => {
    const { body } = await call('/current-supplements');
    assert.equal(body.takingSupplements, true);
    assert.ok(body.supplements.includes('Magnesium Glycinate'));
  }, {});
});

// ── GET /my-plan — same grouping, one endpoint apart ───────────────────────

test('GET /my-plan carries the same slot grouping as GET /', async () => {
  store.seed([
    { name: 'Magnesium Glycinate', taken: false },
    { name: 'Omega-3 Fish Oil (EPA/DHA)', taken: false },
  ]);

  await withDashboard(async ({ call }) => {
    const { body } = await call('/my-plan');
    const byName = Object.fromEntries(body.supplements.map((s) => [s.name, s]));
    assert.equal(byName['Magnesium Glycinate'].timeSlot, 'evening');
    assert.equal(byName['Omega-3 Fish Oil (EPA/DHA)'].timeSlot, 'morning');
  }, {});
});

// ── A PLAN IS NOT HELD TO A WINDOW THAT CLOSED BEFORE IT EXISTED ───────────
//
// The case in the bug report, end to end. A user completes an assessment in the
// afternoon; the plan that comes back has a Morning stack whose window shut at
// noon. Opening the dashboard must not dock their score for it, must not call it
// missed, and must not backfill it as missed if they never come back. The unit
// rule is asserted in Test File/plan-activation.test.js; these prove the ROUTE
// actually passes the activation through — the wiring is the part a unit test
// cannot reach.

test('a plan created this afternoon is not charged for this morning', async () => {
  // Three unticked doses across three frames, and the plan arrived at 15:00 —
  // after Morning (04:00-12:00) closed, before Afternoon (12:00-18:00) shut.
  store.seed([
    { name: 'Omega-3 Fish Oil (EPA/DHA)', timeSlot: 'morning', taken: false },
    { name: 'Vitamin D3 (Cholecalciferol)', timeSlot: 'morning', taken: false },
    { name: 'Zinc Picolinate', timeSlot: 'afternoon', taken: false },
    { name: 'Magnesium Glycinate', timeSlot: 'evening', taken: false },
  ]);

  await withDashboard(async ({ call }) => {
    const { status, body } = await call('/');
    assert.equal(status, 200);

    // The two morning doses are still in the day — visible, and recordable.
    const names = body.todaysSupplements.map((s) => s.name);
    assert.ok(names.includes('Omega-3 Fish Oil (EPA/DHA)'), 'the morning dose is not hidden');
    assert.ok(names.includes('Vitamin D3 (Cholecalciferol)'));

    const today = body.stats.wellnessToday;
    assert.equal(today.missed, 0, 'a window that closed before the plan existed cannot be missed');
    assert.equal(today.exempt, 2, 'and the exemption is reported, not silently dropped');
    assert.equal(today.penaltyPoints, 0, 'nothing to pay for doses the user was never given time for');
    // Afternoon is open and Evening has not opened — two different situations,
    // kept apart rather than folded into the exempted count.
    assert.equal(today.awaiting, 2);

    // The tracker lays the page out from this block, so the client cannot put the
    // morning stack in a red tray while the score above it says nothing is missed.
    assert.equal(body.planActivation.activatedDayKey, dayKey());
    assert.deepEqual(body.planActivation.graceSlots, ['morning', 'anytime']);
    assert.equal(body.planActivation.isGraceDay, true);
    // Everything is judged normally from the next plan day — which is 4 AM
    // tomorrow, not midnight, so the key is derived from the rule.
    assert.equal(body.planActivation.firstJudgedDayKey, nextDayKey());
  }, { assessment: { _id: ASSESSMENT_ID, user: USER_ID, createdAt: planDayAt(15), aiResults: { recommendations: RECOMMENDATIONS, dailySchedule: DAILY_SCHEDULE } } });
});

test('a plan created before its first window closed is still judged in full', async () => {
  // The other side of the rule: nothing is forgiven for a plan that arrived
  // before any window shut, so the exemption cannot become a quiet way to avoid
  // the morning.
  store.seed([
    { name: 'Omega-3 Fish Oil (EPA/DHA)', timeSlot: 'morning', taken: false },
    { name: 'Vitamin D3 (Cholecalciferol)', timeSlot: 'morning', taken: false },
  ]);

  await withDashboard(async ({ call }) => {
    const { body } = await call('/');
    assert.deepEqual(body.planActivation.graceSlots, []);
    assert.equal(body.planActivation.isGraceDay, false);
    assert.equal(body.planActivation.firstJudgedDayKey, dayKey());
    assert.equal(body.stats.wellnessToday.exempt, 0);
  }, { assessment: { _id: ASSESSMENT_ID, user: USER_ID, createdAt: planDayOpening(), aiResults: { recommendations: RECOMMENDATIONS, dailySchedule: DAILY_SCHEDULE } } });
});

test('the activation is sent even when there is nothing to forgive', async () => {
  // A client that branches on the block must not have to guess whether it was
  // omitted because nothing applied or because the server forgot.
  store.seed([{ name: 'Magnesium Glycinate', taken: true }]);

  await withDashboard(async ({ call }) => {
    const { body } = await call('/');
    assert.ok(body.planActivation, 'the block is always present on a real response');
    assert.equal(typeof body.planActivation.activatedAt, 'string');
    assert.deepEqual(body.planActivation.graceSlots, []);
  }, {});
});

test('ticking a forgiven morning does not change what was forgiven', async () => {
  // The exemption is anchored to the plan day, not to the state of the plan, so
  // the recompute on POST /intake has to reach the same answer GET / did. If the
  // recompute forgot the activation it would re-decide the afternoon of the very
  // day the user was forgiven on, and the score would move under them.
  store.seed([
    { name: 'Omega-3 Fish Oil (EPA/DHA)', timeSlot: 'morning', taken: false },
    { name: 'Zinc Picolinate', timeSlot: 'afternoon', taken: false },
  ]);

  const assessment = {
    _id: ASSESSMENT_ID,
    user: USER_ID,
    createdAt: planDayAt(15),
    aiResults: { recommendations: RECOMMENDATIONS, dailySchedule: DAILY_SCHEDULE },
  };

  await withDashboard(async ({ call }) => {
    const before = (await call('/')).body.stats.wellnessToday;
    assert.equal(before.exempt, 1);

    const id = store.rows.find((r) => r.supplementName === 'Omega-3 Fish Oil (EPA/DHA)')._id;
    const { status, body } = await call('/intake', { recordId: id, taken: true });
    assert.equal(status, 200);

    assert.equal(body.stats.wellnessToday.missed, 0, 'a taken morning dose is taken, not missed');
    assert.equal(body.stats.wellnessToday.exempt, 0);
    // The other frame is unticked and its window is open, so the day is still
    // open work rather than complete — which is honest, and is what keeps the
    // streak from being awarded on a partly-unreachable day.
    assert.equal(body.stats.wellnessToday.awaiting, 1);
    assert.equal(body.stats.todaysProgress.taken, 1);
  }, { assessment });
});

test('the missed-day backfill does not resurrect the day the plan arrived on', async () => {
  // The floor handed to the backfill is the plan's first fully-judged day, not
  // the day it happened to be created. Asserted through the pointer the pass
  // writes, since the stubbed bulkWrite does not materialise the rows: if the
  // floor were the creation day, the pointer would move onto a day the user was
  // never held to.
  store.seed([]);

  await withDashboard(async ({ call }) => {
    const { body } = await call('/');
    assert.equal(body.hasAssessment, true);
    assert.equal(body.planActivation.firstJudgedDayKey, nextDayKey());
    // Nothing was walked, so the pointer never advanced past today.
    assert.equal(metricsDoc.lastBackfilledDay, undefined);
  }, { assessment: { _id: ASSESSMENT_ID, user: USER_ID, createdAt: planDayAt(15), aiResults: { recommendations: RECOMMENDATIONS, dailySchedule: DAILY_SCHEDULE } } });
});

// ── THE DAY IS WRITTEN FROM THE PLAN, ONCE PER PLAN PER DAY ─────────────────
//
// Everything above hands the route a day that already exists. These tests let it
// build one — the wiring in routes/dashboard.js → utils/todayPlanSync.js that a
// unit test cannot reach. `emulateUpsert` makes the stub honour `$setOnInsert`,
// which is what makes "the row that is already ticked keeps its tick" a real
// assertion rather than a description of a no-op.

const afternoonAssessment = () => ({
  _id: ASSESSMENT_ID,
  user: USER_ID,
  createdAt: planDayAt(15),
  aiResults: { recommendations: RECOMMENDATIONS, dailySchedule: DAILY_SCHEDULE },
});

test('GET / does not write a closed frame of an afternoon plan into today', async () => {
  // The user's rule, end to end: an assessment made in the afternoon does not
  // have to be taken for this morning; the Morning stack activates at the next
  // 4 AM reset.
  await withDashboard(async ({ call }) => {
    const { status, body } = await call('/');
    assert.equal(status, 200);

    const names = body.todaysSupplements.map((s) => s.name);
    assert.deepEqual(names.sort(), ['Magnesium Glycinate', 'Zinc Picolinate']);
    assert.ok(!names.includes('Omega-3 Fish Oil (EPA/DHA)'), 'the morning the plan never saw is not today\'s row');

    assert.equal(body.planDeferred.count, 2);
    assert.deepEqual(body.planDeferred.items.map((i) => i.name).sort(),
      ['Omega-3 Fish Oil (EPA/DHA)', 'Vitamin D3 (Cholecalciferol)']);
    assert.equal(body.planDeferred.items[0].timeSlot, 'morning');
    assert.equal(body.planDeferred.startsDayKey, nextDayKey(), 'and it says WHEN they start');
    assert.equal(body.planDeferred.startsAtLabel, '4:00 AM');

    // A day with nothing chargeable in it is not a failed day.
    assert.equal(body.stats.wellnessToday.total, 2);
    assert.equal(body.stats.wellnessToday.missed, 0);
    assert.equal(body.stats.wellnessToday.exempt, 0, 'nothing to exempt: the forgiven frames were never written');
  }, { assessment: afternoonAssessment(), emulateUpsert: true });
});

test('the deferred doses are reported on every load, not only the first', async () => {
  // The rows are written once per plan per day; the LIST is a read of the plan,
  // so it cannot expire when the write does. A user who refreshes at 9 PM must
  // still see the Morning they are being given until tomorrow.
  await withDashboard(async ({ call }) => {
    const first = (await call('/')).body;
    assert.equal(first.planDeferred.count, 2);

    const again = (await call('/')).body;
    assert.equal(again.planDeferred.count, 2);
    assert.deepEqual(again.todaysSupplements.map((s) => s.name).sort(), first.todaysSupplements.map((s) => s.name).sort());
  }, { assessment: afternoonAssessment(), emulateUpsert: true });
});

test('GET / adds what an Update put into the plan beside the rows already there', async () => {
  // The bug the old `todayIntakeRecords.length === 0` guard shipped: the day was
  // only ever seeded when it was empty, so a supplement added by updating the
  // assessment never reached the page.
  store.seed([{ name: 'Zinc Picolinate', timeSlot: 'afternoon', taken: false }]);

  await withDashboard(async ({ call }) => {
    const { body } = await call('/');
    const names = body.todaysSupplements.map((s) => s.name);
    assert.ok(names.includes('Magnesium Glycinate'), 'the rest of the plan is written beside the row that was here');
    assert.equal(names.filter((n) => n === 'Zinc Picolinate').length, 1, 'and the existing row is not duplicated');
  }, {
    assessment: {
      ...afternoonAssessment(),
      createdAt: planDayAt(4, 30),
    },
    emulateUpsert: true,
  });
});

test('GET / keeps a dose ticked under the replaced plan ticked', async () => {
  // "Hindi na kailangan itake ulit yung mga natake na." The tick lives on the OLD
  // assessment's row for this plan day — the history migration may not have run,
  // or may have failed — and the new plan must not ask for the pill a second time.
  const takenAt = planDayAt(8, 5);
  store.seed([
    { name: 'Omega-3 Fish Oil (EPA/DHA)', timeSlot: 'morning', taken: true },
    { name: 'Zinc Picolinate', timeSlot: 'afternoon', taken: false },
  ]);
  // Move the morning tick onto a row the new assessment cannot see.
  store.rows[0].assessment = PREVIOUS_ASSESSMENT_ID;
  store.rows[0].takenAt = takenAt;

  await withDashboard(async ({ call }) => {
    const { body } = await call('/');
    const omega = body.todaysSupplements.find((s) => s.name === 'Omega-3 Fish Oil (EPA/DHA)');
    assert.ok(omega, 'the dose taken today is still on today\'s page');
    assert.equal(omega.taken, true, 'taken, not re-asked');
    assert.equal(new Date(omega.takenAt).getTime(), takenAt.getTime(), 'with the hour it was actually taken at');
    assert.equal(body.planDeferred.count, 1, 'and the other morning dose is the one that waits');
  }, { assessment: afternoonAssessment(), emulateUpsert: true });
});

test('a dose already on the page is never also listed as deferred', async () => {
  // Either today's row or tomorrow's start — the same card must not appear twice.
  store.seed([{ name: 'Omega-3 Fish Oil (EPA/DHA)', timeSlot: 'morning', taken: false }]);

  await withDashboard(async ({ call }) => {
    const { body } = await call('/');
    assert.ok(body.todaysSupplements.some((s) => s.name === 'Omega-3 Fish Oil (EPA/DHA)'));
    assert.ok(!body.planDeferred.items.some((i) => i.name === 'Omega-3 Fish Oil (EPA/DHA)'));
    assert.equal(body.planDeferred.count, 1);
  }, { assessment: afternoonAssessment(), emulateUpsert: true });
});

test('a plan made before noon writes its whole day and defers nothing', async () => {
  await withDashboard(async ({ call }) => {
    const response = await call('/');
    assert.equal(response.body.todaysSupplements.length, 4);
    assert.equal(response.body.planDeferred.count, 0);
    assert.deepEqual(response.body.planDeferred.items, []);
    assert.ok(response.body.planDeferred.startsAt, 'the block is well-formed even when it is empty');
  }, {
    assessment: { ...afternoonAssessment(), createdAt: planDayAt(9) },
    emulateUpsert: true,
  });
});

test('a dashboard with no assessment still answers with an empty deferred block', async () => {
  // A client reads `planDeferred.count` without a null check on every response.
  await withDashboard(async ({ call }) => {
    const { status, body } = await call('/');
    assert.equal(status, 200);
    assert.equal(body.hasAssessment, false);
    assert.equal(body.planDeferred.count, 0);
    assert.deepEqual(body.planDeferred.items, []);
    assert.equal(body.planDeferred.startsAtLabel, '4:00 AM');
  }, { assessment: null });
});
