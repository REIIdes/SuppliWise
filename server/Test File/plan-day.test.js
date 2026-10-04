/**
 * The 4 AM plan-day boundary.
 *
 * Run: node --test "Test File/plan-day.test.js"
 *
 * These assertions are the contract the rest of the product leans on: which day
 * a dose belongs to, when "today" rolls over, and — the reason the file exists
 * at all — that the rollover happens at 4 AM for a user in every timezone rather
 * than at whatever hour UTC happens to land on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PLAN_DAY_RESET_MINUTES,
  PLAN_DAY_RESET_LABEL,
  cleanTimeZone,
  zonedNowParts,
  parseDayKey,
  shiftDayKey,
  previousDayKey,
  planDayKey,
  isInDeadHours,
  minutesToNextReset,
  recentPlanDayKeys,
} = require('../utils/planDay');

/**
 * An instant expressed in `timeZone`'s wall clock.
 *
 * Built by walking the offset rather than by parsing "YYYY-MM-DDTHH:mm", because
 * the latter silently means UTC in JavaScript and is exactly the confusion these
 * tests exist to rule out.
 */
function at(timeZone, year, month, day, hour = 0, minute = 0) {
  // Guess an offset with the zone asked to render the same wall clock, then
  // correct once. Two passes converge for every real-world offset.
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const parts = zonedNowParts(new Date(guess), timeZone);
    if (!parts) throw new Error(`unusable zone: ${timeZone}`);
    const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const drift = target - rendered;
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess);
}

const MANILA = 'Asia/Manila'; // UTC+8, no DST
const KOLKATA = 'Asia/Kolkata'; // UTC+5:30 — the half-hour zone
const NEW_YORK = 'America/New_York'; // UTC-5/-4, observes DST
const LA = 'America/Los_Angeles'; // UTC-8/-7

test('the boundary is written down once, at 4 AM', () => {
  assert.equal(PLAN_DAY_RESET_MINUTES, 240);
  assert.equal(PLAN_DAY_RESET_LABEL, '4:00 AM');
});

test('a zone it does not know is rejected rather than thrown on', () => {
  assert.equal(cleanTimeZone('Asia/Manila'), 'Asia/Manila');
  assert.equal(cleanTimeZone(' UTC '), 'UTC');
  assert.equal(cleanTimeZone(''), '');
  assert.equal(cleanTimeZone(undefined), '');
  assert.equal(cleanTimeZone(null), '');
  assert.equal(cleanTimeZone('Not/AZone') , '');
  assert.equal(cleanTimeZone('Asia/Manila; DROP'), '');
  assert.equal(cleanTimeZone('$where'), '');
  assert.equal(cleanTimeZone('a'.repeat(200)), '');
  // A number or a boolean must not be coerced into something that then reads as
  // a zone. Both fail the "starts with a letter" test.
  assert.equal(cleanTimeZone(123), '');
  assert.equal(cleanTimeZone(true), '');
  // An object IS coerced, which is why a request body can never smuggle a zone
  // past validation: whatever it becomes, `Intl` has the final say.
  assert.doesNotThrow(() => cleanTimeZone({ toString: () => 'Not/AZone' }));
});

test('an unusable zone still produces a clock, rather than no answer', () => {
  // Falls back to UTC. A missing zone must not blank the plan for every reader
  // at once, which is what returning null here would have done.
  const parts = zonedNowParts(new Date('2026-10-04T12:00:00Z'), 'Not/AZone');
  assert.ok(parts);
  assert.equal(parts.timeZone, 'UTC');
  assert.equal(parts.hour, 12);
});

test('an unusable instant produces no clock at all', () => {
  assert.equal(zonedNowParts(new Date('nonsense')), null);
  assert.equal(zonedNowParts(undefined, 'Asia/Manila') === null, false); // default is now
});

test('half past midnight in a half-hour zone lands on the right minute', () => {
  const parts = zonedNowParts(at(KOLKATA, 2026, 10, 4, 9, 30), KOLKATA);
  assert.equal(parts.hour, 9);
  assert.equal(parts.minute, 30);
  assert.equal(parts.minutes, 570);
});

test('BEFORE 4 AM the running plan day is still the previous calendar date', () => {
  // This is the whole point: a user who opens the app at 2 AM is looking at the
  // day that began at 4 AM yesterday, not at a new one.
  assert.equal(planDayKey(at(MANILA, 2026, 10, 4, 0, 0), MANILA), '2026-10-03');
  assert.equal(planDayKey(at(MANILA, 2026, 10, 4, 2, 59), MANILA), '2026-10-03');
  assert.equal(planDayKey(at(MANILA, 2026, 10, 4, 3, 59), MANILA), '2026-10-03');
});

test('AT 4 AM the plan day rolls over — exactly there, not a minute either side', () => {
  assert.equal(planDayKey(at(MANILA, 2026, 10, 4, 3, 59), MANILA), '2026-10-03');
  assert.equal(planDayKey(at(MANILA, 2026, 10, 4, 4, 0), MANILA), '2026-10-04');
  assert.equal(planDayKey(at(MANILA, 2026, 10, 4, 4, 1), MANILA), '2026-10-04');
});

test('the rest of the calendar day keeps the same key', () => {
  for (const hour of [4, 7, 12, 18, 23]) {
    assert.equal(
      planDayKey(at(MANILA, 2026, 10, 4, hour, 30), MANILA),
      '2026-10-04',
      `hour ${hour} belongs to the plan day that opened at 4 AM`
    );
  }
});

test('THE BUG THIS FIXES: the rollover is 4 AM local, not 00:00 UTC', () => {
  // 4:00 AM in Manila is 20:00 UTC the previous evening. The old code keyed days
  // off `toISOString()`, so a user here saw their plan keep filling in for four
  // hours after being told it had restarted, and the day's boundary sat at
  // 8:00 AM their time.
  const manila4am = at(MANILA, 2026, 10, 4, 4, 0);
  assert.equal(manila4am.toISOString(), '2026-10-03T20:00:00.000Z');
  assert.equal(planDayKey(manila4am, MANILA), '2026-10-04');
  assert.equal(manila4am.toISOString().slice(0, 10), '2026-10-03'); // the old answer

  // And in Los Angeles, where 00:00 UTC is 4 PM the previous day: their day used
  // to be cut short at dinnertime.
  const la4am = at(LA, 2026, 10, 4, 4, 0);
  assert.equal(la4am.toISOString().slice(0, 10), '2026-10-04');
  assert.equal(planDayKey(la4am, LA), '2026-10-04');
});

test('the same instant is different days for different users, and both are right', () => {
  // 2026-10-04T02:00:00Z — Tokyo is 11 AM on the 4th, Los Angeles 7 PM on the 3rd.
  const instant = new Date('2026-10-04T02:00:00.000Z');
  assert.equal(planDayKey(instant, 'Asia/Tokyo'), '2026-10-04');
  assert.equal(planDayKey(instant, LA), '2026-10-03');
  // Two users, one server, one instant, no disagreement about the rule.
});

test('the reset does not move with daylight saving', () => {
  // New York switches at 02:00 on 8 March 2026. On both sides of that, 4 AM is
  // 4 AM local — a fixed wall-clock boundary, which a fixed UTC offset would
  // have drifted by an hour.
  assert.equal(planDayKey(at(NEW_YORK, 2026, 3, 7, 4, 0), NEW_YORK), '2026-03-07');
  assert.equal(planDayKey(at(NEW_YORK, 2026, 3, 8, 4, 0), NEW_YORK), '2026-03-08');
  assert.equal(planDayKey(at(NEW_YORK, 2026, 3, 8, 3, 30), NEW_YORK), '2026-03-07');
});

test('the boundary is unaffected by when an assessment was created', () => {
  // Two plans created hours apart, on either side of the old wall: both are on
  // the same plan day, because the day is a property of the calendar, not of any
  // one assessment. Nothing here reads an assessment.
  const threeAm = planDayKey(at(MANILA, 2026, 10, 4, 3, 0), MANILA);
  const fiveAm = planDayKey(at(MANILA, 2026, 10, 4, 5, 0), MANILA);
  assert.equal(threeAm, '2026-10-03');
  assert.equal(fiveAm, '2026-10-04');
  // The rule is a pure function of (instant, zone): same inputs, same answer,
  // no assessment id in sight.
  assert.equal(planDayKey(at(MANILA, 2026, 10, 4, 5, 0), MANILA), planDayKey(at(MANILA, 2026, 10, 4, 5, 0), MANILA));
});

test('a month boundary is crossed correctly', () => {
  assert.equal(planDayKey(at(MANILA, 2026, 3, 1, 2, 0), MANILA), '2026-02-28');
  assert.equal(planDayKey(at(MANILA, 2026, 3, 1, 4, 0), MANILA), '2026-03-01');
  assert.equal(planDayKey(at(MANILA, 2026, 1, 1, 2, 0), MANILA), '2025-12-31');
});

test('a leap day is crossed correctly', () => {
  assert.equal(planDayKey(at(MANILA, 2028, 3, 1, 2, 0), MANILA), '2028-02-29');
  assert.equal(planDayKey(at(MANILA, 2028, 2, 29, 4, 0), MANILA), '2028-02-29');
});

test('an unusable clock still yields a usable key rather than an empty one', () => {
  // '' would match no records and silently blank the plan — the worst possible
  // failure for a function every read path depends on.
  const key = planDayKey(new Date('nonsense'), MANILA);
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
});

test('day keys parse, and impossible dates are rejected', () => {
  assert.deepEqual(parseDayKey('2026-10-04'), { year: 2026, month: 10, day: 4 });
  assert.equal(parseDayKey('2026-10-04T00:00:00Z'), null);
  assert.equal(parseDayKey('2026-13-01'), null);
  assert.equal(parseDayKey('2026-02-31'), null); // does not exist
  assert.equal(parseDayKey('nonsense'), null);
  assert.equal(parseDayKey(''), null);
});

test('shiftDayKey walks the calendar without a zone or a DST rule', () => {
  assert.equal(shiftDayKey('2026-10-04', -1), '2026-10-03');
  assert.equal(shiftDayKey('2026-10-04', 1), '2026-10-05');
  assert.equal(shiftDayKey('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDayKey('2028-03-01', -1), '2028-02-29');
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31');
  // Crosses a non-leap February correctly (2025-08-30, not a 35-day-short guess).
  assert.equal(shiftDayKey('2026-10-04', -400), '2025-08-30');
  assert.equal(previousDayKey('2026-10-04'), '2026-10-03');
  // Junk in, empty out — never a wrong-but-plausible date.
  assert.equal(shiftDayKey('nonsense', -1), '');
  assert.equal(shiftDayKey('2026-10-04', 'x'), '');
  assert.equal(previousDayKey(''), '');
});

test('a year below 100 is not silently mapped into the 1900s', () => {
  // `Date.UTC(26, ...)` means 1926. A user whose plan reaches a low year would
  // otherwise address a day a century away.
  assert.equal(shiftDayKey('0026-10-04', -1), '0026-10-03');
  assert.equal(shiftDayKey('0099-12-31', 1), '0100-01-01');
});

test('the dead hours are the four before the reset, in the user\u2019s own clock', () => {
  assert.equal(isInDeadHours(at(MANILA, 2026, 10, 4, 0, 0), MANILA), true);
  assert.equal(isInDeadHours(at(MANILA, 2026, 10, 4, 3, 59), MANILA), true);
  assert.equal(isInDeadHours(at(MANILA, 2026, 10, 4, 4, 0), MANILA), false);
  assert.equal(isInDeadHours(at(MANILA, 2026, 10, 4, 12, 0), MANILA), false);
  // Fail OPEN: an unusable clock must not park a user in a pause they cannot end.
  assert.equal(isInDeadHours(new Date('nonsense'), MANILA), false);
});

test('the countdown to the next reset counts down, then counts a whole day', () => {
  assert.equal(minutesToNextReset(at(MANILA, 2026, 10, 4, 3, 0), MANILA), 60);
  assert.equal(minutesToNextReset(at(MANILA, 2026, 10, 4, 3, 59), MANILA), 1);
  assert.equal(minutesToNextReset(at(MANILA, 2026, 10, 4, 4, 0), MANILA), 1440);
  assert.equal(minutesToNextReset(at(MANILA, 2026, 10, 4, 12, 0), MANILA), 960);
  assert.equal(minutesToNextReset(new Date('nonsense'), MANILA), 0);
});

test('the recent-days window ends on the running plan day and is contiguous', () => {
  const keys = recentPlanDayKeys(7, at(MANILA, 2026, 10, 4, 5, 0), MANILA);
  assert.equal(keys.length, 7);
  assert.equal(keys[keys.length - 1], '2026-10-04');
  assert.deepEqual(keys, [
    '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01',
    '2026-10-02', '2026-10-03', '2026-10-04',
  ]);
  // Oldest first, and every step is the previous day's key — the axis a weekly
  // chart is drawn against.
  for (let i = 1; i < keys.length; i += 1) {
    assert.equal(previousDayKey(keys[i]), keys[i - 1]);
  }
});

test('the recent-days window is bounded', () => {
  assert.deepEqual(recentPlanDayKeys(0), []);
  assert.deepEqual(recentPlanDayKeys(-5), []);
  assert.deepEqual(recentPlanDayKeys('x'), []);
  assert.equal(recentPlanDayKeys(1, at(MANILA, 2026, 10, 4, 5, 0), MANILA).length, 1);
  // A crafted count cannot build an unbounded $in.
  assert.equal(recentPlanDayKeys(100000, at(MANILA, 2026, 10, 4, 5, 0), MANILA).length, 366);
});

test('during the dead hours the window ends on the day still running', () => {
  const keys = recentPlanDayKeys(7, at(MANILA, 2026, 10, 4, 2, 0), MANILA);
  assert.equal(keys[keys.length - 1], '2026-10-03');
});

test('day keys are zero-padded, so they still sort and compare as strings', () => {
  // Every `$gte`/`$lte`/`sort()` on dayKey relies on lexicographic order being
  // chronological. A non-padded key would put '2026-1-9' after '2026-10-04'.
  const key = planDayKey(at(MANILA, 2026, 1, 9, 5, 0), MANILA);
  assert.equal(key, '2026-01-09');
  assert.ok(key < '2026-01-10');
  assert.ok(key < '2026-02-01');
});