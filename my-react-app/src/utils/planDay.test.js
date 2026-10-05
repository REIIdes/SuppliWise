/**
 * The client's copy of the 4 AM plan-day rule.
 *
 * Run: node --test src/utils/planDay.test.js
 *
 * This suite exists for one reason above all others: the boundary is written
 * down twice in this codebase (once per package, because one is CJS and one is
 * ESM) and a client that disagrees with the server about "today" shows the user
 * yesterday's plan on today's page. `server/Test File/plan-day.test.js` asserts
 * the same boundary over there, including the timezone cases that only the
 * server can exercise; the cases below are the ones a browser can get wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_DAY_RESET_MINUTES,
  PLAN_DAY_RESET_LABEL,
  minutesOfDay,
  parseDayKey,
  shiftDayKey,
  previousDayKey,
  planDayKey,
  resolveTodayKey,
  msToNextReset,
  planDayPollDelay,
} from './planDay.js';

/** A local Date at a given wall-clock time, regardless of the test's own zone. */
function local(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

test('the boundary is 4 AM, matching the dead hours the tracker already draws', () => {
  assert.equal(PLAN_DAY_RESET_MINUTES, 240);
  assert.equal(PLAN_DAY_RESET_LABEL, '4:00 AM');
});

test('minutesOfDay reads the LOCAL clock, not a shifted one', () => {
  // Built with the Date constructor, so this holds whatever zone the suite runs
  // in — which is the point. A user in UTC+5:30 must get their own 6 PM.
  assert.equal(minutesOfDay(local(2026, 10, 4, 18, 0)), 18 * 60);
  assert.equal(minutesOfDay(local(2026, 10, 4, 0, 0)), 0);
  assert.equal(minutesOfDay(local(2026, 10, 4, 3, 59)), 239);
  assert.equal(minutesOfDay(local(2026, 10, 4, 4, 0)), 240);
  assert.equal(minutesOfDay(new Date('nonsense')), null);
});

test('BEFORE 4 AM the running plan day is still the previous calendar date', () => {
  // A user opening the app at 2 AM is inside the day that began at 4 AM
  // yesterday — not inside a new one.
  assert.equal(planDayKey(local(2026, 10, 4, 0, 0)), '2026-10-03');
  assert.equal(planDayKey(local(2026, 10, 4, 2, 59)), '2026-10-03');
  assert.equal(planDayKey(local(2026, 10, 4, 3, 59)), '2026-10-03');
});

test('AT 4 AM the day rolls over — exactly there, not a minute either side', () => {
  assert.equal(planDayKey(local(2026, 10, 4, 3, 59)), '2026-10-03');
  assert.equal(planDayKey(local(2026, 10, 4, 4, 0)), '2026-10-04');
  assert.equal(planDayKey(local(2026, 10, 4, 4, 1)), '2026-10-04');
});

test('the rest of the day keeps the same key', () => {
  for (const hour of [4, 7, 12, 18, 23]) {
    assert.equal(planDayKey(local(2026, 10, 4, hour, 30)), '2026-10-04');
  }
});

test('the reset is not affected by when an assessment was created', () => {
  // Nothing here reads an assessment: the boundary is a property of the
  // calendar, so a plan started at 3:59 AM and one started at 4:01 AM are
  // governed by the same rule and the same day boundary.
  assert.equal(planDayKey(local(2026, 10, 4, 3, 59)), '2026-10-03');
  assert.equal(planDayKey(local(2026, 10, 4, 4, 1)), '2026-10-04');
  // Same instant, same answer, every time — a pure function of the clock.
  assert.equal(planDayKey(local(2026, 10, 4, 4, 1)), planDayKey(local(2026, 10, 4, 4, 1)));
});

test('month, year and leap-day boundaries are crossed correctly', () => {
  assert.equal(planDayKey(local(2026, 3, 1, 2, 0)), '2026-02-28');
  assert.equal(planDayKey(local(2026, 3, 1, 4, 0)), '2026-03-01');
  assert.equal(planDayKey(local(2026, 1, 1, 2, 0)), '2025-12-31');
  assert.equal(planDayKey(local(2028, 3, 1, 2, 0)), '2028-02-29');
});

test('a key is still produced from an unusable clock', () => {
  // '' would match no records; the calendar would be unable to tell today from
  // history, which is worse than being a moment wrong.
  const key = planDayKey(new Date('nonsense'));
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
});

test('day keys parse, and impossible dates are rejected', () => {
  assert.deepEqual(parseDayKey('2026-10-04'), { year: 2026, month: 10, day: 4 });
  assert.equal(parseDayKey('2026-10-04T00:00:00Z'), null);
  assert.equal(parseDayKey('2026-13-01'), null);
  assert.equal(parseDayKey('2026-02-31'), null);
  assert.equal(parseDayKey('nonsense'), null);
  assert.equal(parseDayKey(''), null);
  assert.equal(parseDayKey(null), null);
  assert.equal(parseDayKey(20261004), null);
});

test('shiftDayKey walks the calendar without a DST rule', () => {
  assert.equal(shiftDayKey('2026-10-04', -1), '2026-10-03');
  assert.equal(shiftDayKey('2026-10-04', 1), '2026-10-05');
  assert.equal(shiftDayKey('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDayKey('2028-03-01', -1), '2028-02-29');
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31');
  assert.equal(previousDayKey('2026-10-04'), '2026-10-03');
  assert.equal(shiftDayKey('nonsense', -1), '');
  assert.equal(shiftDayKey('2026-10-04', 'x'), '');
  assert.equal(previousDayKey(undefined), '');
});

test('a year below 100 is not mapped into the 1900s', () => {
  assert.equal(shiftDayKey('0026-10-04', -1), '0026-10-03');
});

test('keys are zero-padded, so they sort and compare as strings', () => {
  // Every range query on dayKey assumes lexicographic order is chronological.
  assert.equal(planDayKey(local(2026, 1, 9, 5, 0)), '2026-01-09');
  assert.ok('2026-01-09' < '2026-01-10');
  assert.ok('2026-01-09' < '2026-02-01');
});

test("the server's key wins, so the client stops guessing", () => {
  const now = local(2026, 10, 4, 9, 0);
  // Server says the 4th; the local rule would also say the 4th. The point is
  // that the SERVER's answer is used, so the two can never end up arguing.
  assert.equal(resolveTodayKey('2026-10-04', now), '2026-10-04');
  // Deliberately disagreeing: the server's answer still wins, because it is the
  // one that knows which key the records were written under.
  assert.equal(resolveTodayKey('2026-10-03', now), '2026-10-03');
});

test('a missing or unusable server key falls back to the local rule', () => {
  // A cached payload or an old service-worker shell has no `planDay`. Falling
  // back is safe — it is the same rule — whereas treating it as "no data" would
  // leave the calendar unable to tell today from history.
  const now = local(2026, 10, 4, 9, 0);
  assert.equal(resolveTodayKey(undefined, now), '2026-10-04');
  assert.equal(resolveTodayKey(null, now), '2026-10-04');
  assert.equal(resolveTodayKey('', now), '2026-10-04');
  assert.equal(resolveTodayKey('garbage', now), '2026-10-04');
  assert.equal(resolveTodayKey('2026-02-31', now), '2026-10-04');
  const deadHour = local(2026, 10, 4, 2, 0);
  assert.equal(resolveTodayKey(undefined, deadHour), '2026-10-03');
});

test('the reset timer counts down to 4 AM and then spans a whole day', () => {
  // Close to the boundary the delay is exact: the point of the timer is to wake
  // AT 4 AM, not an hour early.
  assert.equal(msToNextReset(local(2026, 10, 4, 3, 0)), 60 * 60 * 1000);
  assert.equal(msToNextReset(local(2026, 10, 4, 3, 59)), 60 * 1000);
  // Further out it is capped at an hour and the caller simply re-checks, so the
  // timer can never be parked past the point where `setTimeout` misbehaves.
  assert.equal(msToNextReset(local(2026, 10, 4, 4, 0)), 60 * 60 * 1000);
  assert.equal(msToNextReset(local(2026, 10, 4, 0, 0)), 60 * 60 * 1000);
  assert.equal(msToNextReset(local(2026, 10, 4, 12, 0)), 60 * 60 * 1000);
});

test('the reset timer is always a usable, finite delay', () => {
  // Never NaN, never 0, never past the ~24.8-day point where `setTimeout`
  // silently fires immediately — a month-long sleep must not become a loop.
  for (const hour of [0, 1, 3, 4, 8, 12, 18, 23]) {
    const delay = msToNextReset(local(2026, 10, 4, hour, 30));
    assert.ok(Number.isFinite(delay), `hour ${hour} produced ${delay}`);
    assert.ok(delay >= 1000, 'never sooner than a second');
    assert.ok(delay <= 60 * 60 * 1000, 'never more than an hour');
  }
  const bad = msToNextReset(new Date('nonsense'));
  assert.ok(Number.isFinite(bad) && bad > 0);
});

test('the poll delay floors at a second, so a reset cannot spin', () => {
  // At 03:59:59.9 the raw delay is under a second. Without a floor the timer
  // would fire immediately, compute the same near-zero delay again, and pin the
  // main thread until the boundary actually arrived.
  assert.ok(planDayPollDelay(local(2026, 10, 4, 3, 59)) >= 1000);
  assert.ok(planDayPollDelay(new Date('nonsense')) >= 1000);
});