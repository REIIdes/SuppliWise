'use strict';

/**
 * Which past plan days a dashboard load is allowed to judge as missed.
 *
 * Run: npm test
 *
 * ── THE RULE UNDER TEST ─────────────────────────────────────────────────────
 *
 *   today ..................... never. Its windows are still open.
 *   a day with rows ........... never. It is already scored, taken or not.
 *   a day with NO rows ........ seeded as fully missed, bounded by the lookback
 *
 * The exclusions matter more than the inclusion: backfilling today would charge
 * doses whose window has not closed, and backfilling a day that already has rows
 * would double-count one the user was already scored on.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  shiftDayKey,
  nextDayKey,
  isBeforeDay,
  planDaysToBackfill,
  DEFAULT_BACKFILL_LOOKBACK_DAYS,
  MAX_BACKFILL_LOOKBACK_DAYS,
} = require('../utils/missedDayResolver');

// ── Day arithmetic ─────────────────────────────────────────────────────────

/** The running plan day every window test below is anchored to. */
const TODAY = '2026-10-14';

test('a day key shifts across month and year boundaries without a clock', () => {
  assert.equal(nextDayKey('2026-10-31'), '2026-11-01');
  assert.equal(nextDayKey('2026-12-31'), '2027-01-01');
  assert.equal(shiftDayKey('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDayKey('2028-03-01', -1), '2028-02-29', 'a leap day is a real day');
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31');
  // Junk in, '' out — never a wrong date.
  assert.equal(shiftDayKey('2026-13-40', 1), '');
  assert.equal(shiftDayKey('nonsense', 1), '');
  assert.equal(nextDayKey(''), '');
});

test('day order is string order, which is what every $gte on dayKey assumes', () => {
  assert.ok(isBeforeDay('2026-10-09', '2026-10-10'));
  assert.ok(isBeforeDay('2025-12-31', '2026-01-01'));
  assert.ok(!isBeforeDay('2026-10-10', '2026-10-10'));
  // A missing or malformed key is never "before" anything, so a bad pointer
  // cannot widen the window instead of narrowing it.
  assert.ok(!isBeforeDay('', '2026-10-10'));
  assert.ok(!isBeforeDay('2026-10-10', ''));
  assert.ok(!isBeforeDay('2026-10-10', 'not-a-day'));
});

// ── The window ─────────────────────────────────────────────────────────────

test('a first pass walks the whole gap since the plan opened, oldest first', () => {
  const { keys } = planDaysToBackfill({ sinceDayKey: '2026-10-01', todayKey: '2026-10-05' });
  assert.deepEqual(keys, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
});

test('today is never a candidate', () => {
  // The whole point: a dose whose window is still open must not be backfilled
  // into existence already-missed. GET / seeds today itself, window-aware.
  const { keys } = planDaysToBackfill({ sinceDayKey: '2026-10-01', todayKey: '2026-10-01' });
  assert.deepEqual(keys, []);
});

test('the plan is never judged before the day it opened', () => {
  const { keys } = planDaysToBackfill({ sinceDayKey: '2026-10-12', todayKey: '2026-10-14', lookbackDays: 30 });
  assert.deepEqual(keys, ['2026-10-12', '2026-10-13']);
});

test('one pass reaches back at most `lookbackDays`, and stops there', () => {
  const { keys } = planDaysToBackfill({ sinceDayKey: '2020-01-01', todayKey: '2026-10-14', lookbackDays: 7 });
  assert.equal(keys.length, 6, 'seven days counted back from today, and today is not one of them');
  assert.equal(keys[keys.length - 1], '2026-10-13');
  assert.equal(keys[0], '2026-10-08');

  const dflt = planDaysToBackfill({ sinceDayKey: '2020-01-01', todayKey: '2026-10-14' });
  assert.equal(dflt.keys.length, DEFAULT_BACKFILL_LOOKBACK_DAYS - 1);
});

test('a pass resumes where the last one stopped rather than re-walking', () => {
  const { keys, lastBackfilledDay } = planDaysToBackfill({
    sinceDayKey: '2026-10-01',
    lastBackfilledDay: '2026-10-08',
    todayKey: '2026-10-14',
    lookbackDays: 30,
  });
  assert.deepEqual(keys, ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']);
  assert.equal(lastBackfilledDay, '2026-10-13');
});

test('a pointer already at yesterday means there is nothing to judge', () => {
  const { keys, lastBackfilledDay } = planDaysToBackfill({
    sinceDayKey: '2026-09-01',
    lastBackfilledDay: '2026-10-13',
    todayKey: '2026-10-14',
  });
  assert.deepEqual(keys, []);
  // The pointer never moves backwards — a no-op pass must not re-open a window
  // that has already been decided.
  assert.equal(lastBackfilledDay, '2026-10-13');
});

test('a resume pointer older than the window still cannot escape the window', () => {
  // `lastBackfilledDay` is client-visible once it is in a metrics row, and a
  // hand-aged value must not turn one load into a thousand inserts.
  const { keys } = planDaysToBackfill({
    sinceDayKey: '2020-01-01',
    lastBackfilledDay: '2020-01-02',
    todayKey: '2026-10-14',
    lookbackDays: 10,
  });
  assert.equal(keys.length, 9);
  assert.equal(keys[0], '2026-10-05');
});

test('the number of keys one pass can return is hard-capped', () => {
  const { keys } = planDaysToBackfill({
    sinceDayKey: '2000-01-01',
    todayKey: '2026-10-14',
    lookbackDays: 5000,
  });
  assert.ok(keys.length <= MAX_BACKFILL_LOOKBACK_DAYS, `got ${keys.length}`);
  assert.equal(keys.length, MAX_BACKFILL_LOOKBACK_DAYS);
});

test('junk in any field yields an empty pass, not a crash or a huge window', () => {
  for (const bad of ['', 'nonsense', '2026-13-40', null, undefined, 42, '2026-1-4']) {
    const { keys } = planDaysToBackfill({ sinceDayKey: bad, todayKey: bad });
    assert.deepEqual(keys, [], `rejected ${JSON.stringify(bad)}`);
  }
  // A bad key in ONE field fails closed: the other field alone cannot widen the
  // window, so a corrupt pointer or a junk date in a request costs a pass, not a
  // thousand inserts.
  assert.deepEqual(planDaysToBackfill({ sinceDayKey: '2020-01-01', todayKey: 'nonsense' }).keys, []);
  assert.deepEqual(planDaysToBackfill({ sinceDayKey: 'nonsense', todayKey: TODAY }).keys, []);

  // A garbage lookback falls back to the default rather than to "unbounded".
  const a = planDaysToBackfill({ sinceDayKey: '2020-01-01', todayKey: TODAY, lookbackDays: 'x' });
  const b = planDaysToBackfill({ sinceDayKey: '2020-01-01', todayKey: TODAY });
  assert.deepEqual(a.keys, b.keys);
  assert.equal(b.keys.length, DEFAULT_BACKFILL_LOOKBACK_DAYS - 1);
  // One day of lookback leaves nothing but today, which is never a candidate.
  assert.deepEqual(planDaysToBackfill({ sinceDayKey: '2020-01-01', todayKey: TODAY, lookbackDays: 1 }).keys, []);
});
