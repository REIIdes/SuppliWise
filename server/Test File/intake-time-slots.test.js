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
const { planDayKey } = require('../utils/planDay');

const dayKey = () => planDayKey(new Date(), 'UTC');

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
async function withDashboard(fn, { assessment } = {}) {
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
    createdAt: new Date(),
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
  IntakeRecord.bulkWrite = async () => ({ upsertedCount: 0 });
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
