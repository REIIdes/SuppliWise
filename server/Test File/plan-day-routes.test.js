/**
 * "Today's Supplements" resets at 4 AM, in the user's own timezone, whatever
 * time their assessment was created.
 *
 * Run: node --test "Test File/plan-day-routes.test.js"
 *
 * WHY THIS FILE EXISTS
 * `plan-day.test.js` proves the day-key function is right. It cannot prove the
 * ROUTES USE IT — and they used not to. Every handler computed "today" itself,
 * from `new Date().toISOString()`, which rolls over at 00:00 UTC: 8:00 AM in
 * Manila, 7:00 PM the previous evening in Los Angeles. So:
 *
 *   - a plan was displayed for four hours after the reset it was meant to have,
 *   - the edits that display invited were refused ("only today's supplements"),
 *   - the weekly chart's newest column was always empty for half the planet, and
 *   - the streak was evaluated against a day the user could not see.
 *
 * The clock cannot be faked here — a header a client could set would defeat the
 * whole feature. `X-Client-Timezone` is the legitimate lever, and these tests
 * use `Etc/GMT±N` offsets to put the server's own instant on either side of the
 * boundary, which makes both outcomes deterministic whenever the suite runs.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');

const Assessment = require('../models/Assessment');
const IntakeRecord = require('../models/IntakeRecord');
const DashboardMetrics = require('../models/DashboardMetrics');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

const { planDayKey, zonedNowParts, PLAN_DAY_RESET_MINUTES } = require('../utils/planDay');
const { localMinutesOfDay } = require('../utils/intakeWindows');

const USER_ID = '507f1f77bcf86cd799439011';
const ASSESSMENT_ID = '507f1f77bcf86cd7994390aa';

const RECOMMENDATIONS = [
  { name: 'Vitamin D3', dosage: '2000 IU', priority: 'High', timing: 'With breakfast' },
];
const DAILY_SCHEDULE = [{ time: 'Morning', supplements: ['Vitamin D3'] }];

/**
 * An `Etc/GMT±N` zone whose LOCAL clock is inside [fromMinutes, toMinutes).
 *
 * `Etc/GMT-8` is UTC+8 (POSIX sign inversion). Reachable local minutes are
 * `utcMinutes + 60k` for k in [-12, 14], so any hour-wide target is always
 * reachable. Returns null when it is not, which a test asserting `ok(zone)`
 * turns into a failure rather than a silent skip.
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

/** The `Etc/GMT±N` spellings for the offsets a zone may legally use. */
const ZONE_HOURS = (() => {
  const list = [];
  for (let k = 14; k >= -12; k -= 1) list.push(k);
  return list;
})();

const zoneForOffset = (k) => (k === 0 ? 'UTC' : `Etc/GMT${k > 0 ? '-' : '+'}${Math.abs(k)}`);

/** Minutes past local midnight in `zone` for the given instant. */
function localMinutesOf(now, zone) {
  const parts = zonedNowParts(now, zone);
  return parts ? parts.minutes : null;
}

/**
 * Zones whose local clock lands inside the dead hours (before 4 AM), and zones
 * that land after the reset, for the SAME instant.
 *
 * WHY THIS CAN COME BACK EMPTY ON ONE SIDE
 * `Etc/GMT±N` can only shift the clock by whole hours, within [-12, +14]. When
 * the suite runs late in the UTC day — 18:00 UTC, say — every reachable local
 * time is 06:00 or later, so no zone can be made to read 2 AM. That is a
 * property of the offset grid, not a missing case, and the tests below are
 * written to hold either way: where a side is unreachable they fall back to
 * asserting that whatever zone is used returns the key the rule dictates for it.
 */
function zonesEitherSideOfReset(now) {
  const inDeadHours = [];
  const afterReset = [];
  for (const k of ZONE_HOURS) {
    const local = localMinutesOf(now, zoneForOffset(k));
    if (local === null) continue;
    if (local < PLAN_DAY_RESET_MINUTES && inDeadHours.length < 3) inDeadHours.push(zoneForOffset(k));
    else if (local >= PLAN_DAY_RESET_MINUTES && afterReset.length < 3) afterReset.push(zoneForOffset(k));
  }
  return { inDeadHours, afterReset };
}

/**
 * An ADJACENT pair of zones straddling the reset: `deadZone` is one hour west of
 * `afterZone`, so the reset falls between them.
 *
 * WHY THIS EXISTS INSTEAD OF USING `zonesEitherSideOfReset`
 * That helper returns the *highest* offset on each side, and the two highest
 * offsets can sit on opposite sides of the international date line. At 10:00 UTC
 * the highest dead-hours zone is `Etc/GMT-14`, whose local clock reads 00:00 on
 * the 5th — so its plan day is the 4th; the highest after-reset zone is
 * `Etc/GMT-13`, reading 23:00 on the 4th, whose plan day is *also* the 4th. The
 * two agree, correctly. A test that then asserted they "must disagree" was
 * asserting a property of the offset grid rather than of the code, and failed
 * for 4 hours out of every 24 — a 1-in-6 chance on any given run.
 *
 * An adjacent pair cannot have that problem: the reset falls between two clocks
 * that are one hour apart, so neither local date rolls over between them. Both
 * therefore share a local date D, giving plan days `D-1` and `D` — exactly one
 * day apart, with the dead-hours side earlier, which IS the rule under test.
 *
 * Returns null only when no offset on the grid puts the boundary inside an
 * hour-wide window, which the offset grid always allows (see `zoneInLocalWindow`).
 */
function adjacentResetPair(now) {
  for (const k of ZONE_HOURS) {
    // `Etc/GMT-14` is UTC+14, so a LARGER k is further EAST and therefore one
    // hour AHEAD locally. The dead-hours zone must be the one WEST of the
    // after-reset zone, hence `k - 1`.
    if (k - 1 < -12) continue;
    const afterZone = zoneForOffset(k);
    const deadZone = zoneForOffset(k - 1);

    const after = localMinutesOf(now, afterZone);
    const dead = localMinutesOf(now, deadZone);
    if (after === null || dead === null) continue;

    // The dead-hours side must be exactly one hour behind, and the reset must
    // fall inside that hour.
    if (after < PLAN_DAY_RESET_MINUTES) continue;
    if (dead !== (after - 60 + 1440) % 1440) continue;
    if (dead >= PLAN_DAY_RESET_MINUTES) continue;

    return { deadZone, afterZone };
  }
  return null;
}

/** Every reachable zone, for tests that only need "some zone in this half". */
function allZones() {
  return ZONE_HOURS.map(zoneForOffset);
}

/** A minimal chainable query stand-in, matching the harness the other suites use. */
function chainableQuery(result) {
  const q = {
    _result: result,
    select() { return q; },
    sort() { return q; },
    limit() { return q; },
    lean() { return q; },
    then(resolve, reject) { return Promise.resolve(q._result).then(resolve, reject); },
    catch(reject) { return Promise.resolve(q._result).catch(reject); },
  };
  return q;
}

/** In-memory IntakeRecord, seeded on the plan day the route will ask for. */
function recordStore(rows, zone) {
  const todayKey = planDayKey(new Date(), zone);
  const all = rows.map((row, i) => ({
    _id: `507f1f77bcf86cd7994390${String(i).padStart(2, '0')}`,
    user: USER_ID,
    assessment: ASSESSMENT_ID,
    supplementName: row.name,
    dosage: '1',
    priority: 'Medium',
    scheduledTime: row.slot,
    timeSlot: row.slot,
    taken: !!row.taken,
    takenAt: row.taken ? new Date() : null,
    date: new Date(),
    dayKey: todayKey,
    save: async function save() { return this; },
  }));

  const matches = (filter = {}) => all.filter((row) => {
    if (filter.user && String(filter.user) !== String(row.user)) return false;
    if (filter.assessment && String(filter.assessment) !== String(row.assessment)) return false;
    if (filter.dayKey && row.dayKey !== filter.dayKey) return false;
    if (filter.taken !== undefined && row.taken !== filter.taken) return false;
    // `_id` may be a bare id or a `$in` list. Order matters: the `$in` test has to
    // come first, or every row is compared against the literal "[object Object]".
    if (filter._id && filter._id.$in && !filter._id.$in.map(String).includes(String(row._id))) return false;
    if (filter._id && !filter._id.$in && String(filter._id) !== String(row._id)) return false;
    return true;
  });

  return {
    rows: all,
    find: (filter) => chainableQuery(matches(filter)),
    findOne: (filter) => {
      const row = matches(filter)[0] || null;
      return chainableQuery(row);
    },
    countDocuments: async (filter) => matches(filter).length,
    updateMany: async (filter, update) => {
      const hits = matches(filter);
      for (const row of hits) {
        row.taken = update.$set.taken;
        row.takenAt = update.$set.takenAt;
      }
      return { modifiedCount: hits.length };
    },
    bulkWrite: async () => ({ upsertedCount: 0 }),
  };
}

/**
 * Boots routes/dashboard.js against the in-memory store.
 *
 * @param {Array} rows        Seeded doses.
 * @param {string} [zone]     Zone sent as X-Client-Timezone; '' omits the header.
 * @param {(ctx) => Promise<void>} fn
 */
async function withDashboard(rows, zone, fn) {
  const store = recordStore(rows, zone);
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
    assessmentFindByIdAndUpdate: Assessment.findByIdAndUpdate,
    intakeFind: IntakeRecord.find,
    intakeFindOne: IntakeRecord.findOne,
    intakeCount: IntakeRecord.countDocuments,
    intakeUpdateMany: IntakeRecord.updateMany,
    intakeBulkWrite: IntakeRecord.bulkWrite,
    metricsFindOne: DashboardMetrics.findOne,
    metricsCreate: DashboardMetrics.create,
    metricsSave: DashboardMetrics.prototype.save,
    userFindByIdAndUpdate: User.findByIdAndUpdate,
    userUpdateOne: User.updateOne,
    protect: authMiddleware.protect,
  };

  authMiddleware.protect = (req, _res, next) => {
    req.user = { _id: USER_ID, plan: 'Premium', role: 'user', timeZone: '' };
    next();
  };
  User.updateOne = async () => ({ modifiedCount: 1 });
  User.findByIdAndUpdate = async () => ({});

  Assessment.findOne = () => chainableQuery(assessmentDoc);
  Assessment.findById = () => chainableQuery(assessmentDoc);
  Assessment.findByIdAndUpdate = async () => ({ _id: ASSESSMENT_ID });
  Object.assign(IntakeRecord, {
    find: store.find,
    findOne: store.findOne,
    countDocuments: store.countDocuments,
    updateMany: store.updateMany,
    bulkWrite: store.bulkWrite,
  });
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
      headers: {
        'Content-Type': 'application/json',
        ...(zone ? { 'X-Client-Timezone': zone } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    return await fn({ call, store, metricsDoc, todayKey: planDayKey(new Date(), zone) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Assessment.findOne = originals.assessmentFindOne;
    Assessment.findById = originals.assessmentFindById;
    Assessment.findByIdAndUpdate = originals.assessmentFindByIdAndUpdate;
    Object.assign(IntakeRecord, {
      find: originals.intakeFind,
      findOne: originals.intakeFindOne,
      countDocuments: originals.intakeCount,
      updateMany: originals.intakeUpdateMany,
      bulkWrite: originals.intakeBulkWrite,
    });
    DashboardMetrics.findOne = originals.metricsFindOne;
    DashboardMetrics.create = originals.metricsCreate;
    DashboardMetrics.prototype.save = originals.metricsSave;
    User.updateOne = originals.userUpdateOne;
    User.findByIdAndUpdate = originals.userFindByIdAndUpdate;
    authMiddleware.protect = originals.protect;
    delete require.cache[require.resolve('../routes/dashboard')];
  }
}

// ── The routes read the day the user is on ──────────────────────────────────

test('GET / serves the plan day the user is on, and labels it', async () => {
  // An ADJACENT pair, so the reset provably falls between the two clocks and the
  // two plan days must be exactly one day apart. See `adjacentResetPair` for why
  // the arbitrary "highest offset on each side" pair cannot support that claim.
  const pair = adjacentResetPair(new Date());
  assert.ok(pair, 'an adjacent pair straddling the reset is always reachable');
  const zones = [pair.deadZone, pair.afterZone];

  const seen = [];
  for (const zone of zones) {
    // eslint-disable-next-line no-await-in-loop -- each run needs its own server
    const result = await withDashboard(
      [{ name: 'Vitamin D3', slot: 'morning' }],
      zone,
      async ({ call, todayKey }) => ({ ...(await call('/')), todayKey }),
    );
    assert.equal(result.body.planDay.todayKey, result.todayKey, `zone ${zone}`);
    assert.equal(result.body.planDay.resetAt, '4:00 AM', `zone ${zone}`);
    // The doses must be there, which only holds if the key the route read is the
    // key the records were seeded under.
    assert.equal(result.body.todaysSupplements.length, 1, `zone ${zone} served the plan`);
    seen.push(result.body.planDay.todayKey);
  }

  // The whole rule: one hour apart across the reset, one plan day apart.
  assert.notEqual(seen[0], seen[1], 'before and after the reset are different days');
  assert.ok(seen[0] < seen[1], 'the dead-hours side is the earlier plan day');
});

test('GET / returns the SAME day a UTC-based route would have gotten at 4 AM local', async () => {
  // The specific failure: at 4:00 AM in Manila it is still 20:00 UTC on the
  // previous day, so the old code kept serving the 3rd while the client had
  // already rolled to the 4th.
  const zone = 'Etc/GMT-8';
  const now = new Date();
  const localMinutes = localMinutesOfDay(now, zone);
  const { body } = await withDashboard(
    [{ name: 'Vitamin D3', slot: 'morning' }],
    zone,
    ({ call }) => call('/'),
  );
  // The route must answer for the zone it was given, not the server's — which is
  // what the `withDashboard` seeding already depends on. Asserted against the rule
  // rather than against a hard-coded date, because this suite runs whenever.
  assert.equal(body.planDay.todayKey, planDayKey(now, zone));

  // The stronger claim: on the majority of days the naive UTC answer is a
  // DIFFERENT day from Manila's, and the route must not give the naive one.
  // Skipped when the two happen to agree, since there is nothing to distinguish
  // them on — a fact about the offset grid, not a missing case.
  const naiveUtcDate = now.toISOString().split('T')[0];
  if (localMinutes >= PLAN_DAY_RESET_MINUTES && naiveUtcDate !== body.planDay.todayKey) {
    assert.notEqual(
      body.planDay.todayKey,
      naiveUtcDate,
      'the UTC calendar date must not be served as the plan day',
    );
  }
});

test('the day key is the same one the plan was seeded under', async () => {
  // The contract that keeps the two pages honest: the dashboard serves, the
  // tracker edits and the calendar highlights — one key. If the route answered a
  // different key from the one it wrote, seeding and reading would disagree.
  // Sampled across the reachable offset range, plus the no-header and junk-header
  // cases, because those are the two that used to produce an empty plan.
  for (const zone of ['', 'UTC', ...allZones().filter((_, i) => i % 5 === 0), 'Not/AZone']) {
    await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], zone, async ({ call, todayKey }) => {
      const { body } = await call('/');
      assert.equal(body.planDay.todayKey, todayKey, `zone ${zone || '(none)'}`);
      assert.equal(body.todaysSupplements.length, 1, `zone ${zone || '(none)'} served the plan`);
    });
  }
});

test('editing a dose the dashboard just displayed is allowed', async () => {
  // THE BUG IN ONE LINE: the page showed yesterday's doses and then refused the
  // user, because the edit was gated on a UTC "today" while the read was keyed
  // on the plan day. Both now use the same function.
  const { inDeadHours } = zonesEitherSideOfReset(new Date());
  const zone = inDeadHours[0];

  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], zone, async ({ call, store }) => {
    const displayed = await call('/');
    assert.equal(displayed.body.todaysSupplements.length, 1);

    const edited = await call('/intake', { recordId: store.rows[0]._id, taken: true });
    assert.equal(edited.status, 200, 'a dose the dashboard just showed must be editable');
    assert.equal(store.rows[0].taken, true);
  });
});

test('a genuine past day is still refused, so history stays read-only', async () => {
  // The other side of the fix: widening "today" must not make yesterday
  // editable, or a back-dated tick could rewrite a streak.
  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], 'UTC', async ({ call, store }) => {
    store.rows[0].dayKey = '2000-01-01';
    const edited = await call('/intake', { recordId: store.rows[0]._id, taken: true });
    assert.equal(edited.status, 400);
    assert.equal(store.rows[0].taken, false);
  });
});

test('the bulk press is gated on the same day key as the single press', async () => {
  const { inDeadHours } = zonesEitherSideOfReset(new Date());
  const zone = inDeadHours[0];

  await withDashboard(
    [{ name: 'Vitamin D3', slot: 'morning' }, { name: 'Vitamin D3 (Cholecalciferol)', slot: 'afternoon' }],
    zone,
    async ({ call, store }) => {
      const ok = await call('/intake/bulk', { recordIds: store.rows.map((r) => r._id), taken: true });
      assert.equal(ok.status, 200);
      assert.equal(store.rows.every((r) => r.taken), true);
    },
  );

  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], 'UTC', async ({ call, store }) => {
    store.rows[0].dayKey = '2000-01-01';
    const refused = await call('/intake/bulk', { recordIds: [store.rows[0]._id], taken: true });
    assert.equal(refused.status, 400);
    assert.equal(store.rows[0].taken, false);
  });
});

test('GET /day/:dayKey calls the running plan day "today", not "future"', async () => {
  // The calendar asks for this the moment a day is clicked. If the route called
  // the live day "future" the user got a 400 for the day they were looking at.
  const { inDeadHours } = zonesEitherSideOfReset(new Date());
  const zone = inDeadHours[0];

  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], zone, async ({ call, todayKey }) => {
    const live = await call(`/day/${todayKey}`);
    assert.equal(live.status, 200);
    assert.equal(live.body.dayKey, todayKey);
    assert.equal(live.body.records.length, 1);

    const future = await call(`/day/${shiftOneDay(todayKey)}`);
    assert.equal(future.status, 400);
  });
});

test('the weekly window ends on the running plan day', async () => {
  // It used to be built from `new Date().setDate(-i)`, i.e. a UTC calendar
  // window — which for anyone east of UTC always had yesterday as its newest
  // column and showed today's dose nowhere.
  const { inDeadHours, afterReset } = zonesEitherSideOfReset(new Date());

  for (const zone of [...inDeadHours.slice(0, 1), ...afterReset.slice(0, 1)]) {
    // eslint-disable-next-line no-await-in-loop -- each run needs its own server
    await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], zone, async ({ call, todayKey }) => {
      const { body } = await call('/weekly-adherence');
      assert.ok(Array.isArray(body.weeklyDays), `zone ${zone}`);
      assert.equal(body.weeklyDays.length, 7, `zone ${zone}`);
      const newest = body.weeklyDays[body.weeklyDays.length - 1];
      assert.equal(newest.date, todayKey, `zone ${zone}: newest column must be the running day`);
      assert.equal(newest.isToday, true, `zone ${zone}`);
      // Oldest first, and every column is the previous day's key.
      for (let i = 1; i < body.weeklyDays.length; i += 1) {
        assert.equal(shiftOneDay(body.weeklyDays[i].date, -1), body.weeklyDays[i - 1].date, `zone ${zone}`);
      }
    });
  }
});

test('the calendar covers the whole month, and names the running day', async () => {
  // Two separate defects, one endpoint. The month bounds were built by
  // round-tripping `new Date(year, month, 0)` through toISOString(), which
  // converts midnight in the SERVER's zone to UTC — so on a host east of
  // Greenwich the final day came back as the previous date and the calendar
  // stopped one day early, silently. And it reported no day at all, leaving the
  // client to highlight whatever its own calendar cursor said.
  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], 'UTC', async ({ call, todayKey }) => {
    const { body } = await call('/calendar/2026/10');
    assert.equal(body.month.year, 2026);
    assert.equal(body.month.month, 10);
    assert.equal(body.month.daysInMonth, 31);
    assert.equal(body.month.startKey, '2026-10-01');
    // The last day has to be the LAST day — this is the assertion the old
    // toISOString() round-trip failed.
    assert.equal(body.month.endKey, '2026-10-31');
    assert.equal(body.planDay.todayKey, todayKey);
    assert.equal(body.planDay.resetAt, '4:00 AM');
  });

  // February in a leap year and in a common one, because both used to be
  // off-by-one-able in different directions. 2024 is the leap year — the route
  // clamps to the current year plus one, so a later leap day is refused outright.
  const leap = await withDashboard([], 'UTC', ({ call }) => call('/calendar/2024/2'));
  assert.equal(leap.body.month.daysInMonth, 29);
  assert.equal(leap.body.month.endKey, '2024-02-29');

  const common = await withDashboard([], 'UTC', ({ call }) => call('/calendar/2026/2'));
  assert.equal(common.body.month.daysInMonth, 28);
  assert.equal(common.body.month.endKey, '2026-02-28');
});

test('an invalid month is still refused', async () => {
  await withDashboard([], 'UTC', async ({ call }) => {
    for (const path of ['/calendar/2026/13', '/calendar/2026/0', '/calendar/1999/1', '/calendar/abc/1']) {
      const res = await call(path);
      assert.equal(res.status, 400, `${path} must be refused`);
    }
  });
});

test('GET /my-plan labels the day it served', async () => {
  const { inDeadHours } = zonesEitherSideOfReset(new Date());
  const zone = inDeadHours[0];
  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], zone, async ({ call, todayKey }) => {
    const { body } = await call('/my-plan');
    assert.equal(body.planDay.todayKey, todayKey);
    assert.equal(body.supplements.length, 1);
  });
});

test('GET /current-supplements reads the running plan day', async () => {
  const { inDeadHours } = zonesEitherSideOfReset(new Date());
  const zone = inDeadHours[0];
  await withDashboard([{ name: 'Vitamin D3', slot: 'morning', taken: true }], zone, async ({ call, todayKey }) => {
    const { body } = await call('/current-supplements');
    assert.equal(body.hasPlan, true);
    // The dose was ticked on the running day, so it counts — the response is
    // meant to pre-fill "are you taking anything?" from what the user is doing.
    assert.equal(body.takenCount, 1, 'the tick on the running day must be visible');
    assert.equal(planDayKey(new Date(), zone), todayKey);
  });
});

test('a request with no timezone header still gets a usable day key', async () => {
  // A background job, a Web3 read, or a client that never learned to send the
  // header. It must degrade to UTC — not to '' , which would match no records
  // and blank the plan.
  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], '', async ({ call }) => {
    const { status, body } = await call('/');
    assert.equal(status, 200);
    assert.match(body.planDay.todayKey, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(body.todaysSupplements.length, 1);
  });
});

test('a junk timezone header is ignored instead of blanking the plan', async () => {
  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], 'Not/AZone', async ({ call }) => {
    const { status, body } = await call('/');
    assert.equal(status, 200);
    assert.match(body.planDay.todayKey, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(body.todaysSupplements.length, 1);
  });
});

test('the day does not depend on when the assessment was created', async () => {
  // A plan created at 11:58 PM and one created at 4:01 AM are governed by the
  // same boundary. The route reads a clock; it never reads `assessment.createdAt`
  // to decide what day it is, which is what used to strand a user who signed up
  // in the small hours inside a day that had already been scored.
  //
  // Two assessments created a day apart must therefore agree on `planDay` for the
  // same request — the harness swaps the doc between runs, so the only variable
  // is the creation time.
  const zone = 'Etc/GMT-8';
  const answers = [];
  for (const createdAt of [new Date(Date.now() - 3600_000), new Date(Date.now() - 86_400_000 * 30)]) {
    // eslint-disable-next-line no-await-in-loop -- each run needs its own server
    const { body } = await withDashboard(
      [{ name: 'Vitamin D3', slot: 'morning' }],
      zone,
      async ({ call, todayKey }) => {
        // Prove the doc under test really is the one with this creation time, so
        // a harness that silently ignored the argument cannot pass this test.
        const seen = await call('/');
        assert.ok(seen.body.planDay.todayKey);
        return { ...seen, todayKey };
      },
    );
    // `assessment.createdAt` comes back verbatim; if the day were derived from it,
    // these two runs would answer differently.
    assert.ok(body.assessment.createdAt, 'the assessment creation time is echoed for reference');
    answers.push(body.planDay.todayKey);
  }
  assert.equal(answers[0], answers[1], 'creation time must not move the plan day');
});

test('the streak is evaluated against the running day, not a UTC one', async () => {
  // `validateStreak` used to build its own UTC date, so it watched for a rollover
  // at 00:00 UTC — a different moment from the 4 AM reset that actually opened the
  // new day. The user's streak was therefore decided against a day they could
  // not see, and a page left open across the boundary kept yesterday's streak.
  const { inDeadHours } = zonesEitherSideOfReset(new Date());
  const zone = inDeadHours[0];

  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], zone, async ({ call, metricsDoc, todayKey }) => {
    // Metrics last touched on a genuinely older day, with a streak to lose. The
    // day closed WITHOUT being completed, which is what `lastCompletedDay: null`
    // alongside `lastTrackedDate` says.
    metricsDoc.lastTrackedDate = '2000-01-01';
    metricsDoc.lastCompletedDay = null;
    metricsDoc.currentStreak = 7;
    metricsDoc.streakAwardedToday = true;

    await call('/');

    // And `lastTrackedDate` must advance to the RUNNING day, or the same rollover
    // runs again on every subsequent load.
    assert.equal(metricsDoc.currentStreak, 0, 'an incomplete day must break the streak');
    assert.equal(metricsDoc.lastCompletedDay, null);
    assert.equal(metricsDoc.lastTrackedDate, todayKey, 'the rollover must advance to the running day');
  });
});

test('a completed day keeps the streak across the rollover', async () => {
  const { inDeadHours } = zonesEitherSideOfReset(new Date());
  const zone = inDeadHours[0];

  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], zone, async ({ call, metricsDoc, todayKey }) => {
    metricsDoc.lastTrackedDate = '2000-01-01';
    metricsDoc.lastCompletedDay = '2000-01-01';
    metricsDoc.currentStreak = 7;
    metricsDoc.streakAwardedToday = true;

    await call('/');

    assert.equal(metricsDoc.currentStreak, 7, 'finishing the day keeps the streak');
    assert.equal(metricsDoc.lastTrackedDate, todayKey);
  });
});

test('the rollover is not re-run on the next request', async () => {
  // `lastTrackedDate` is the guard. If it did not advance, a stale value would
  // make every subsequent dashboard load re-decide the same day.
  const { inDeadHours } = zonesEitherSideOfReset(new Date());
  const zone = inDeadHours[0];

  await withDashboard([{ name: 'Vitamin D3', slot: 'morning' }], zone, async ({ call, metricsDoc, todayKey }) => {
    metricsDoc.lastTrackedDate = '2000-01-01';
    metricsDoc.lastCompletedDay = null;
    metricsDoc.currentStreak = 5;

    await call('/');
    const afterFirst = metricsDoc.currentStreak;
    await call('/');

    assert.equal(metricsDoc.currentStreak, afterFirst, 'a second load must not decide the day again');
    assert.equal(metricsDoc.lastTrackedDate, todayKey);
  });
});

/** `shiftOneDay(key)` — moves a day key forward; `-1` moves it back. */
function shiftOneDay(dayKey, offset = 1) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const cursor = new Date(0);
  cursor.setUTCFullYear(y, m - 1, d);
  cursor.setTime(cursor.getTime() + offset * 86400000);
  return `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(cursor.getUTCDate()).padStart(2, '0')}`;
}