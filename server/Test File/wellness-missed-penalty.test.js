'use strict';

/**
 * The wellness score has to react to TODAY, and only punish what is genuinely
 * missed. These tests pin that rule down.
 *
 * Run: npm test
 *
 * ── THE RULE UNDER TEST ─────────────────────────────────────────────────────
 *
 *   ticked, whenever it was ticked ........ no penalty, however late
 *   unticked, window still open ........... no penalty
 *   unticked, window closed ............... full penalty
 *
 * The middle row is the one that is easy to get wrong and expensive to get
 * wrong: a user who opens the app at 8:30 AM and has not ticked their Vitamin D
 * yet must not be charged for it, and a user who ticks it at 11:55 must not be
 * charged either. Only a window that has actually closed can take points away.
 *
 * ── WHY THE ROUTE TESTS PIN THE CLOCK WITH A TIME ZONE ──────────────────────
 *
 * `Date.now()` cannot be faked here, and the routes are not going to grow a test
 * hook for it — a clock that arrived in a request header would be a clock any
 * client could set, which is exactly the thing this feature must never allow.
 *
 * So the tests use the one lever that is legitimate: `X-Client-Timezone`. An
 * `Etc/GMT±N` zone shifts the server's UTC clock by a whole number of hours, and
 * `zoneInLocalWindow()` below finds the shift that lands local time inside a
 * window we choose. The reachable local minutes are spaced an hour apart, so any
 * hour-wide target is always reachable — which makes "morning window still open"
 * and "morning window already closed" both deterministic regardless of when the
 * suite runs.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SLOT_WINDOWS,
  cleanTimeZone,
  localMinutesOfDay,
  windowStateForSlot,
  slotKeyForRecord,
  evaluateToday,
} = require('../utils/intakeWindows');

const {
  calculateWellnessScore,
  getWellnessBaseline,
  penaltyForMisses,
  BASELINE_MAX,
  ADHERENCE_MAX,
  STREAK_MAX,
} = require('../utils/wellnessScore');

// The day key the route will read and write. Seeded records have to carry this
// exact string or the route finds nothing and every score assertion below reads
// as "this user has no doses today".
const { planDayKey } = require('../utils/planDay');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Minutes past local midnight in `timeZone`, computed the way the server does. */
const localMinutes = (now, timeZone) => localMinutesOfDay(now, timeZone);

const at = (hour, minute = 0) => {
  const date = new Date('2026-10-03T00:00:00.000Z');
  date.setUTCHours(hour, minute, 0, 0);
  return date;
};

/**
 * An `Etc/GMT±N` zone that puts `now` at a local time inside [fromMinutes, toMinutes).
 *
 * `Etc/GMT-8` is UTC+8 (POSIX sign inversion), so a desired offset of +N hours is
 * spelled `Etc/GMT-N`. Reachable local minutes are `utcMinutes + 60k` for
 * k in [-12, 14], so any window at least an hour wide always contains one.
 * Returns null when the window is unreachable, which a test asserting `ok(zone)`
 * will catch rather than silently skip.
 */
function zoneInLocalWindow(now, fromMinutes, toMinutes) {
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (let k = 14; k >= -12; k -= 1) {
    const local = utcMinutes + 60 * k;
    if (local >= fromMinutes && local < toMinutes) {
      return k === 0 ? 'UTC' : `Etc/GMT${k > 0 ? '-' : '+'}${Math.abs(k)}`;
    }
  }
  return null;
}

/** The `evaluateToday` inputs, kept terse: these tests are about the rule, not the fields. */
const dose = (overrides) => ({
  _id: overrides._id || 'r1',
  supplementName: overrides.name || 'Vitamin D3',
  taken: !!overrides.taken,
  takenAt: overrides.takenAt || null,
  timeSlot: overrides.slot || 'morning',
  ...overrides,
});

// ── Windows ────────────────────────────────────────────────────────────────

test('the server windows match the client windows they are duplicated from', () => {
  // These ranges are written out twice on purpose — once in CommonJS here, once
  // in my-react-app/src/utils/slotSchedule.js — because one is a Node module and
  // the other is bundled by Vite. Nothing but this test stops the two copies
  // from drifting, and a drift is silent and nasty: the tracker would lock a
  // row the score had not penalised, or worse, the reverse.
  const fs = require('node:fs');
  const path = require('node:path');
  const clientFile = path.join(__dirname, '..', '..', 'my-react-app', 'src', 'utils', 'slotSchedule.js');
  const source = fs.readFileSync(clientFile, 'utf8');

  const block = source.match(/export const SLOT_WINDOWS = \{[\s\S]*?\n\};/);
  assert.ok(block, 'the client must still export SLOT_WINDOWS');

  for (const [slot, window] of Object.entries(SLOT_WINDOWS)) {
    const line = block[0].match(new RegExp(`${slot}:\\s*\\{[^}]*start:\\s*(\\d+)\\s*\\*\\s*60[^}]*end:\\s*(\\d+)\\s*\\*\\s*60`));
    assert.ok(line, `the client must still define a ${slot} window`);
    assert.equal(Number(line[1]) * 60, window.start, `${slot} start drifted`);
    assert.equal(Number(line[2]) * 60, window.end, `${slot} end drifted`);
  }
});

test('a window closes exactly at its end, not a minute early', () => {
  assert.equal(windowStateForSlot('morning', 4 * 60), 'open', 'opens at 04:00 sharp');
  assert.equal(windowStateForSlot('morning', 12 * 60 - 1), 'open', '11:59 is still inside');
  assert.equal(windowStateForSlot('morning', 12 * 60), 'closed', '12:00 is the first minute out');
  assert.equal(windowStateForSlot('anytime', 12 * 60), 'always', 'Anytime never closes');
});

test('an unusable clock fails open rather than locking the user out', () => {
  // Every "missed" verdict the score produces goes through this. Failing closed
  // would mark a whole day missed because a timezone string was misspelled.
  assert.equal(windowStateForSlot('morning', null), 'always');
  assert.equal(windowStateForSlot('morning', NaN), 'always');
  assert.equal(localMinutesOfDay(new Date('nonsense'), 'Europe/London'), null);
  assert.equal(localMinutesOfDay(new Date(), 'Mars/Olympus_Mons'), null);
  assert.equal(localMinutesOfDay(new Date(), ''), null);
});

test('cleanTimeZone rejects anything Intl would throw on', () => {
  assert.equal(cleanTimeZone('Europe/London'), 'Europe/London');
  assert.equal(cleanTimeZone('America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires');
  assert.equal(cleanTimeZone('UTC'), 'UTC');
  assert.equal(cleanTimeZone('Not/AZone'), '');
  assert.equal(cleanTimeZone('Europe/London"; DROP'), '');
  assert.equal(cleanTimeZone({ $ne: null }), '');
  assert.equal(cleanTimeZone('x'.repeat(200)), '');
});

test('the clock is read in the user\'s own zone, not the server\'s', () => {
  const now = at(12, 0); // 12:00 UTC
  // 3 October is inside British Summer Time, so London is an hour AHEAD of UTC.
  // The same instant is 11:00 in UTC and 13:00 in London — and it is the
  // difference between "the morning window is still open" and "it has closed".
  assert.equal(localMinutesOfDay(now, 'UTC'), 12 * 60);
  assert.equal(localMinutesOfDay(now, 'Europe/London'), 13 * 60);
  // A half-hour zone is the case a hand-rolled offset subtraction always gets
  // wrong: Kolkata is +05:30, so 12:00 UTC is 17:30 there.
  assert.equal(localMinutesOfDay(now, 'Asia/Kolkata'), 17 * 60 + 30);
  // And the whole reason the client reports its zone at all.
  assert.notEqual(
    windowStateForSlot('morning', localMinutesOfDay(now, 'Etc/GMT-5')),
    windowStateForSlot('morning', localMinutesOfDay(now, 'Etc/GMT+5')),
  );
});

test('a record is placed by its stored slot, then its schedule text, then Anytime', () => {
  assert.equal(slotKeyForRecord({ timeSlot: 'night', scheduledTime: 'Morning' }), 'night');
  assert.equal(slotKeyForRecord({ timeSlot: 'junk', scheduledTime: 'With lunch' }), 'afternoon');
  assert.equal(slotKeyForRecord({ scheduledTime: 'Evening, 30 min before bed' }), 'night');
  assert.equal(slotKeyForRecord({ scheduledTime: 'Anytime' }), 'anytime');
  assert.equal(slotKeyForRecord({}), 'anytime', 'an unplaceable dose is never dropped');
});

// ── The rule ───────────────────────────────────────────────────────────────

test('an unticked dose inside an open window costs nothing', () => {
  const today = evaluateToday([dose({ slot: 'morning' })], {
    now: at(8, 30),
    timeZone: 'UTC',
  });
  assert.equal(today.total, 1);
  assert.equal(today.awaiting, 1);
  assert.equal(today.missed, 0);
  // Not decided yet — which is what keeps the score whole. Scoring 0% here is
  // the bug this feature exists to fix.
  assert.equal(today.decided, 0);
  assert.equal(today.adherence, 100);
});

test('the same dose costs everything the moment its window closes', () => {
  const today = evaluateToday([dose({ slot: 'morning' })], {
    now: at(12, 0),
    timeZone: 'UTC',
  });
  assert.equal(today.missed, 1);
  assert.equal(today.awaiting, 0);
  assert.equal(today.decided, 1);
  assert.equal(today.adherence, 0);
  assert.equal(today.missedSlots[0].slot, 'morning', 'the miss is attributable to a slot');
});

test('a dose taken LATE is not a missed dose', () => {
  // 21:00 is three hours outside the evening window (18:00-22:00) and eleven
  // hours outside the morning window. It still counts in full.
  const today = evaluateToday(
    [dose({ slot: 'morning', taken: true, takenAt: at(21, 0) })],
    { now: at(21, 0), timeZone: 'UTC' },
  );
  assert.equal(today.taken, 1);
  assert.equal(today.missed, 0);
  assert.equal(today.adherence, 100);
});

test('an unknown timezone marks nothing missed rather than marking everything', () => {
  const today = evaluateToday([dose({ slot: 'morning' }), dose({ _id: 'r2', slot: 'evening' })], {
    now: at(23, 0),
    timeZone: '', // no header, nothing stored
  });
  assert.equal(today.missed, 0);
  assert.equal(today.awaiting, 2);
  assert.equal(today.adherence, 100);
});

test('Anytime is held to account only once the day\'s timed frames are behind us', () => {
  // A plan whose AI output names no time of day at all still has to be able to
  // lose points, or "I took nothing today" is free forever.
  const untimed = [dose({ slot: 'anytime' }), dose({ _id: 'r2', slot: 'anytime' })];

  assert.equal(evaluateToday(untimed, { now: at(9, 0), timeZone: 'UTC' }).missed, 0);
  assert.equal(evaluateToday(untimed, { now: at(21, 0), timeZone: 'UTC' }).missed, 0);
  assert.equal(evaluateToday(untimed, { now: at(22, 30), timeZone: 'UTC' }).missed, 2);
});

test('a plan with a morning frame holds its Anytime doses to that frame\'s deadline', () => {
  // The deadline is the last window the plan actually uses, not a fixed hour:
  // at 12:01 this plan's morning frame has closed, so its Anytime row is late.
  const plan = [dose({ slot: 'morning' }), dose({ _id: 'r2', slot: 'anytime' })];
  const after = evaluateToday(plan, { now: at(12, 30), timeZone: 'UTC' });
  assert.equal(after.missed, 2, 'the missed morning frame and the overdue Anytime row');

  // With an evening frame instead, noon is still mid-plan and nothing is late.
  const later = [dose({ slot: 'evening' }), dose({ _id: 'r2', slot: 'anytime' })];
  assert.equal(evaluateToday(later, { now: at(12, 30), timeZone: 'UTC' }).missed, 0);
});

test('an empty day is not a failed day', () => {
  const today = evaluateToday([], { now: at(23, 0), timeZone: 'UTC' });
  assert.equal(today.total, 0);
  assert.equal(today.decided, 0);
  assert.equal(today.adherence, 100, 'no doses means no doses missed');
});

test('junk input cannot make the score NaN', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    const today = evaluateToday(bad, { now: at(12, 0), timeZone: 'UTC' });
    assert.equal(today.total, 0);
    assert.equal(today.adherence, 100);
  }
});

// ── The score ──────────────────────────────────────────────────────────────

test('the three terms still add up to 100', () => {
  assert.equal(BASELINE_MAX + ADHERENCE_MAX + STREAK_MAX, 100);
  assert.equal(
    calculateWellnessScore({ baseline: 30, overallAdherence: 100, todayAdherence: 100, streak: 30 }),
    100,
  );
  // Nothing at all: no baseline, no history, no streak, and a day where every
  // window is still open (todayAdherence 100 is its default for that reason).
  assert.equal(calculateWellnessScore({ baseline: 0, overallAdherence: 0, todayAdherence: 0, streak: 0 }), 0);
  // A plan with no AI baseline still starts from the neutral 15, not from zero,
  // so there is something to improve.
  assert.equal(calculateWellnessScore({}), 15 + Math.round(ADHERENCE_MAX * 0.6));
  // Out-of-range inputs are clamped, never trusted.
  assert.equal(calculateWellnessScore({ baseline: 1e9, overallAdherence: 1e9, todayAdherence: 1e9, streak: 1e9 }), 100);
  assert.equal(calculateWellnessScore({ baseline: -1e9, overallAdherence: -1e9, todayAdherence: -1e9, streak: -1e9 }), 0);
});

test('missing a closed dose lowers the score, and taking it late does not', () => {
  const base = { baseline: 20, overallAdherence: 90, streak: 10 };
  // Both doses ticked, one of them fifteen hours outside its own window, and
  // the second one ticked after its window had already closed.
  const lateButTaken = evaluateToday(
    [
      dose({ slot: 'morning', taken: true, takenAt: at(21, 0) }),
      dose({ _id: 'r2', slot: 'evening', taken: true, takenAt: at(23, 0) }),
    ],
    { now: at(23, 30), timeZone: 'UTC' },
  );
  const missed = evaluateToday(
    [dose({ slot: 'morning' }), dose({ _id: 'r2', slot: 'evening' })],
    { now: at(23, 30), timeZone: 'UTC' },
  );
  const allTaken = evaluateToday(
    [dose({ slot: 'morning', taken: true }), dose({ _id: 'r2', slot: 'evening', taken: true })],
    { now: at(23, 30), timeZone: 'UTC' },
  );

  const withLate = calculateWellnessScore({ ...base, todayAdherence: lateButTaken.adherence });
  const withMiss = calculateWellnessScore({ ...base, todayAdherence: missed.adherence });
  const withAll = calculateWellnessScore({ ...base, todayAdherence: allTaken.adherence });

  assert.equal(lateButTaken.adherence, 100, 'late but taken is full credit');
  assert.equal(withLate, withAll, 'being 15 hours late must cost exactly nothing');
  assert.ok(withMiss < withLate, `a missed dose must cost points (${withMiss} vs ${withLate})`);
});

test('the score reacts to today, not to a lifetime average', () => {
  // The regression this feature exists for: on a long history, today's weight
  // is enough to move the number on its own.
  const history = { baseline: 15, overallAdherence: 95, streak: 20 };
  const full = calculateWellnessScore({ ...history, todayAdherence: 100 });
  const empty = calculateWellnessScore({ ...history, todayAdherence: 0 });
  assert.ok(full - empty >= 25, `today must be worth at least 25 points, got ${full - empty}`);
});

test('penaltyForMisses is the gap between the score and the score without them', () => {
  const args = { baseline: 22, overallAdherence: 80, streak: 5 };
  const today = evaluateToday([dose({})], { now: at(12, 0), timeZone: 'UTC' });
  const { points, unpenalisedScore } = penaltyForMisses({ ...args, today });

  assert.equal(unpenalisedScore, calculateWellnessScore({ ...args, todayAdherence: 100 }));
  assert.equal(points, unpenalisedScore - calculateWellnessScore({ ...args, todayAdherence: today.adherence }));
  assert.ok(points > 0);
});

test('nothing to have missed means nothing to lose', () => {
  const open = evaluateToday([dose({})], { now: at(9, 0), timeZone: 'UTC' });
  const { points } = penaltyForMisses({ baseline: 20, overallAdherence: 70, streak: 3, today: open });
  assert.equal(points, 0, 'a 9 AM dose that has not closed yet costs nothing to leave');
});

test('the baseline is clamped, defaulted, and never NaN', () => {
  assert.equal(getWellnessBaseline({ aiResults: { wellnessBaseline: 18 } }), 18);
  assert.equal(getWellnessBaseline({ aiResults: { wellnessBaseline: 999 } }), BASELINE_MAX);
  assert.equal(getWellnessBaseline({ aiResults: { wellnessBaseline: -40 } }), 0);
  assert.equal(getWellnessBaseline({ aiResults: {} }), 15);
  assert.equal(getWellnessBaseline(null), 15);
  assert.ok(Number.isFinite(calculateWellnessScore({ baseline: 'x', streak: 'y', overallAdherence: null })));
});

// ── Through the real route ─────────────────────────────────────────────────

const express = require('express');
const Assessment = require('../models/Assessment');
const IntakeRecord = require('../models/IntakeRecord');
const DashboardMetrics = require('../models/DashboardMetrics');
const authMiddleware = require('../middleware/auth');

const USER_ID = '507f1f77bcf86cd799439011';
const ASSESSMENT_ID = '507f1f77bcf86cd7994390aa';
// Seeded records must carry the SAME day key the route will ask for, or the
// route finds nothing and every assertion below reads as "no doses at all".
// That key is the plan day (04:00 → 04:00 in the request's zone), not the UTC
// date — so it is derived from the zone under test rather than hard-coded.
// Getting this wrong is invisible until the suite happens to run in a window
// where the two dates differ, which is what made it worth pinning here.
const dayKey = (zone) => planDayKey(new Date(), zone);

const RECOMMENDATIONS = [
  { name: 'Vitamin D3', dosage: '2000 IU', priority: 'High', timing: 'With breakfast' },
  { name: 'Magnesium Glycinate', dosage: '350 mg', priority: 'Medium', timing: 'Evening with dinner' },
];
const DAILY_SCHEDULE = [
  { time: 'Morning', supplements: ['Vitamin D3'] },
  { time: 'Evening', supplements: ['Magnesium Glycinate'] },
];

/** In-memory IntakeRecord scoped to one user + one day, with `timeSlot` stored. */
function recordStore(rows, zone) {
  const all = rows.map((row, i) => ({
    _id: `507f1f77bcf86cd7994390${String(i).padStart(2, '0')}`,
    user: USER_ID,
    assessment: ASSESSMENT_ID,
    supplementName: row.name,
    dosage: '1',
    priority: row.priority || 'Medium',
    scheduledTime: row.scheduledTime || row.slot,
    timeSlot: row.slot,
    taken: !!row.taken,
    takenAt: row.taken ? new Date() : null,
    date: new Date(),
    dayKey: dayKey(zone),
  }));

  return {
    rows: all,
    find(filter = {}) {
      return all.filter((row) => {
        if (filter.user && String(row.user) !== String(filter.user)) return false;
        if (filter.assessment && String(filter.assessment) !== String(filter.assessment)) return false;
        if (filter.dayKey && row.dayKey !== filter.dayKey) return false;
        if (filter.taken !== undefined && row.taken !== filter.taken) return false;
        if (filter._id && !filter._id.$in.map(String).includes(String(row._id))) return false;
        return true;
      });
    },
    countDocuments(filter = {}) { return this.find(filter).length; },
    async updateMany(filter, update) {
      const hits = this.find(filter);
      for (const row of hits) { row.taken = update.$set.taken; row.takenAt = update.$set.takenAt; }
      return { modifiedCount: hits.length };
    },
  };
}

const chainableQuery = (source) => {
  const resolve = () => Promise.resolve(typeof source === 'function' ? source() : source);
  const query = {
    select: () => query,
    sort: () => query,
    limit: () => query,
    lean: async () => {
      const value = await resolve();
      if (Array.isArray(value)) return value.map((row) => ({ ...row }));
      return value ? { ...value } : null;
    },
    then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected),
    catch: (onRejected) => resolve().catch(onRejected),
  };
  return query;
};

/**
 * Mount the real dashboard router with the DB stubbed, and call it as a user
 * whose local clock lands inside `window`.
 */
async function withDashboard(rows, window, fn) {
  const store = recordStore(rows, window);
  const metricsDoc = {
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
  const assessmentDoc = {
    _id: ASSESSMENT_ID,
    user: USER_ID,
    createdAt: new Date(),
    aiResults: { wellnessBaseline: 20, recommendations: RECOMMENDATIONS, dailySchedule: DAILY_SCHEDULE },
  };

  const originals = {
    assessmentFindOne: Assessment.findOne,
    assessmentFindById: Assessment.findById,
    assessmentUpdate: Assessment.findByIdAndUpdate,
    intakeFind: IntakeRecord.find,
    intakeFindOne: IntakeRecord.findOne,
    intakeCount: IntakeRecord.countDocuments,
    intakeUpdateMany: IntakeRecord.updateMany,
    intakeBulkWrite: IntakeRecord.bulkWrite,
    metricsFindOne: DashboardMetrics.findOne,
    metricsCreate: DashboardMetrics.create,
    metricsSave: DashboardMetrics.prototype.save,
    userUpdateOne: require('../models/User').updateOne,
    userFindByIdAndUpdate: require('../models/User').findByIdAndUpdate,
    protect: authMiddleware.protect,
  };

  authMiddleware.protect = (req, _res, next) => {
    req.user = { _id: USER_ID, plan: 'Premium', role: 'user', timeZone: '' };
    next();
  };
  const userWrites = [];
  // Stands in for Mongo's own match: the route puts "already equals this zone"
  // in the query filter, so the second dashboard load writes nothing. Emulating
  // that here is what makes the assertion below meaningful rather than a
  // restatement of how many times the route called updateOne.
  let storedZone = '';
  require('../models/User').updateOne = async (filter, update) => {
    const next = update && update.$set && update.$set.timeZone;
    const guard = filter && filter.$or && filter.$or[0] && filter.$or[0].timeZone && filter.$or[0].timeZone.$ne;
    if (typeof next === 'string' && guard === next && storedZone === next) {
      return { modifiedCount: 0, matchedCount: 0 };
    }
    storedZone = next;
    userWrites.push(next);
    return { modifiedCount: 1, matchedCount: 1 };
  };
  // GET / stamps `hasVisitedDashboard` on the first visit. Unstubbed, this
  // buffers for 10s and then 500s the whole dashboard.
  require('../models/User').findByIdAndUpdate = async () => ({});
  Assessment.findOne = () => chainableQuery(assessmentDoc);
  Assessment.findById = () => chainableQuery(assessmentDoc);
  Assessment.findByIdAndUpdate = async () => ({ _id: ASSESSMENT_ID });
  IntakeRecord.find = (filter) => chainableQuery(store.find(filter || {}));
  IntakeRecord.findOne = (filter) => {
    const row = store.find({ ...(filter || {}) })[0] || null;
    if (row && typeof row.save !== 'function') {
      row.save = async function save() { store.rows[store.rows.indexOf(row)] = row; return row; };
    }
    return chainableQuery(row);
  };
  IntakeRecord.countDocuments = async (filter) => store.countDocuments(filter || {});
  IntakeRecord.updateMany = async (filter, update) => store.updateMany(filter, update);
  IntakeRecord.bulkWrite = async () => ({ upsertedCount: 0 });
  DashboardMetrics.findOne = () => chainableQuery(metricsDoc);
  DashboardMetrics.create = async () => metricsDoc;
  DashboardMetrics.prototype.save = async function save() { return this; };

  delete require.cache[require.resolve('../routes/dashboard')];
  const app = express();
  app.use(express.json());
  app.use('/api/dashboard', require('../routes/dashboard'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/dashboard`;

  const call = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(window ? { 'X-Client-Timezone': window } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    return await fn({ call, store, metricsDoc, userWrites });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(Assessment, { findOne: originals.assessmentFindOne, findById: originals.assessmentFindById, findByIdAndUpdate: originals.assessmentUpdate });
    Object.assign(IntakeRecord, { find: originals.intakeFind, findOne: originals.intakeFindOne, countDocuments: originals.intakeCount, updateMany: originals.intakeUpdateMany, bulkWrite: originals.intakeBulkWrite });
    DashboardMetrics.findOne = originals.metricsFindOne;
    DashboardMetrics.create = originals.metricsCreate;
    DashboardMetrics.prototype.save = originals.metricsSave;
    require('../models/User').updateOne = originals.userUpdateOne;
    require('../models/User').findByIdAndUpdate = originals.userFindByIdAndUpdate;
    authMiddleware.protect = originals.protect;
    delete require.cache[require.resolve('../routes/dashboard')];
  }
}

/** Morning still open (04:00-11:59) / morning already closed (12:00-16:59). */
const MORNING_OPEN = [300, 660];
const MORNING_CLOSED = [750, 1050];

test('GET / charges nothing for a dose whose window is still open', async () => {
  const zone = zoneInLocalWindow(new Date(), ...MORNING_OPEN);
  assert.ok(zone, 'a morning-open window must always be reachable');

  const { body } = await withDashboard(
    [{ name: 'Vitamin D3', slot: 'morning' }],
    zone,
    ({ call }) => call('/'),
  );

  assert.equal(body.stats.wellnessToday.missed, 0);
  assert.equal(body.stats.wellnessToday.awaiting, 1);
  assert.equal(body.stats.wellnessToday.penaltyPoints, 0);
  // The whole score, because today's term reads 100% while nothing has closed.
  assert.equal(body.stats.wellnessScore, calculateWellnessScore({
    baseline: 20, overallAdherence: 0, todayAdherence: 100, streak: 0,
  }));
});

test('GET / charges for the same dose once its window has closed', async () => {
  const zone = zoneInLocalWindow(new Date(), ...MORNING_CLOSED);
  assert.ok(zone, 'a morning-closed window must always be reachable');

  const { body } = await withDashboard(
    [{ name: 'Vitamin D3', slot: 'morning' }],
    zone,
    ({ call }) => call('/'),
  );

  assert.equal(body.stats.wellnessToday.missed, 1);
  assert.equal(body.stats.wellnessToday.awaiting, 0);
  assert.ok(body.stats.wellnessToday.penaltyPoints > 0, 'a closed, unticked dose must cost points');
  assert.ok(
    body.stats.wellnessScore < calculateWellnessScore({ baseline: 20, streak: 0 }),
    'and the score must actually fall',
  );
});

test('GET / does not charge for a dose ticked late', async () => {
  const zone = zoneInLocalWindow(new Date(), ...MORNING_CLOSED);
  assert.ok(zone);

  const { body } = await withDashboard(
    [{ name: 'Vitamin D3', slot: 'morning', taken: true }],
    zone,
    ({ call }) => call('/'),
  );

  assert.equal(body.stats.wellnessToday.missed, 0);
  assert.equal(body.stats.wellnessToday.penaltyPoints, 0);
  // `overallAdherence` is 0 here because GET / reads the stored lifetime figure
  // rather than recounting history (POST /intake is what refreshes it), so the
  // whole score comes from today's 100% plus the 20-point baseline.
  assert.equal(body.stats.wellnessScore, calculateWellnessScore({
    baseline: 20, overallAdherence: 0, todayAdherence: 100, streak: 0,
  }));
});

test('the client timezone header is stored once and reused', async () => {
  const zone = zoneInLocalWindow(new Date(), ...MORNING_CLOSED);
  assert.ok(zone);

  // First call learns the zone; the second must not write again, because the
  // write is a no-op in the database when the stored zone already matches.
  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], zone, async ({ call, userWrites }) => {
    await call('/');
    assert.deepEqual(userWrites, [zone]);
    await call('/');
    assert.deepEqual(userWrites, [zone], 'an unchanged zone must not be rewritten');
  });
});

test('a junk timezone header is ignored instead of 500-ing', async () => {
  const { body } = await withDashboard(
    [{ name: 'Vitamin D3', slot: 'morning' }],
    'Not/AZone',
    ({ call, userWrites }) => call('/'),
  );
  // Falls back to the stored zone, which is empty here, so UTC. No throw, no
  // write, and no penalty for something the server could not read.
  assert.equal(body.hasAssessment, true);
});

test('wellnessToday is internally consistent and the bulk press updates it', async () => {
  const zone = zoneInLocalWindow(new Date(), ...MORNING_OPEN);
  assert.ok(zone);

  await withDashboard(
    [
      { name: 'Vitamin D3', slot: 'morning' },
      { name: 'Magnesium Glycinate', slot: 'evening' },
    ],
    zone,
    async ({ call, store }) => {
      const before = (await call('/')).body.stats.wellnessToday;
      assert.equal(before.total, 2);
      assert.equal(before.total, before.taken + before.missed + before.awaiting);
      assert.equal(before.decided, before.taken + before.missed);
      assert.equal(before.adherence, 100);

      const result = await call('/intake/bulk', {
        recordIds: store.rows.map((r) => r._id),
        taken: true,
      });
      assert.equal(result.status, 200);

      const after = result.body.stats.wellnessToday;
      assert.equal(after.taken, 2);
      assert.equal(after.missed, 0);
      assert.equal(after.awaiting, 0);
      assert.equal(after.penaltyPoints, 0);
      assert.equal(after.total, after.taken + after.missed + after.awaiting);
    },
  );
});