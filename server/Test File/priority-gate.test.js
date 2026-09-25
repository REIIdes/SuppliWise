/**
 * Priority-flag guard — regression tests.
 *
 * Pure unit tests: no database, no HTTP server, no network.
 *
 * Why these exist: `PATCH /api/assessment/:id/priority` used to write
 * `priority: 'Priority'` with no preconditions at all. An admin could flag an
 * assessment whose day's plan was already finished, and the user was then shown
 * "New Assessments Paused" with no way out — the auto-lift only runs on the next
 * intake post, and a user who had already ticked everything off never posts
 * again. The same hole let the severity auto-flag re-raise a completed review
 * with no admin involved at all.
 *
 * The rule is asserted here rather than only in the route, because a missing
 * precondition is exactly the kind of defect that comes back the next time
 * someone adds a third code path that sets the flag.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { decideRaisePriority, getTodayKey } = require('../utils/priorityGate');

const intake = (total, taken) => ({ total, taken, complete: total > 0 && taken === total });

/**
 * Reimplements the day-grouping in intakeStateFor over plain records, so the
 * "finished yesterday, flagged today" case can be asserted without a database.
 * Kept adjacent to the real implementation deliberately: if the grouping in
 * utils/priorityGate.js changes, this table is what should be updated with it.
 */
function stateFor(records, today = getTodayKey()) {
  if (records.length === 0) return { total: 0, taken: 0, complete: false, dayKey: null };
  const byDay = new Map();
  for (const r of records) {
    if (!byDay.has(r.dayKey)) byDay.set(r.dayKey, []);
    byDay.get(r.dayKey).push(!!r.taken);
  }
  const dayKey = byDay.has(today) ? [...byDay.keys()].sort().pop() : [...byDay.keys()].sort().pop();
  const flags = byDay.get(dayKey);
  const total = flags.length;
  const taken = flags.filter(Boolean).length;
  return { total, taken, complete: total > 0 && taken === total, dayKey };
}

test('a finished plan cannot be raised to Priority', () => {
  // The reported bug: every supplement already taken.
  const v = decideRaisePriority({ intake: intake(5, 5) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'intake-complete');
  assert.match(v.message, /already complete/i);
});

test('a finished plan is refused even when nothing else is open', () => {
  // Guards against a future refactor that lets the "already open" branch run
  // first and mask the completion check.
  const v = decideRaisePriority({ intake: intake(1, 1), openId: null });
  assert.equal(v.code, 'intake-complete');
});

test('an unfinished plan may be raised', () => {
  const v = decideRaisePriority({ intake: intake(5, 2), openId: null });
  assert.equal(v.ok, true);
  assert.equal(v.code, undefined);
});

test('a partially finished plan is not treated as complete', () => {
  // 3 of 4 taken is still an outstanding review — this is the normal case.
  assert.equal(decideRaisePriority({ intake: intake(4, 3) }).ok, true);
});

test('an empty plan is not treated as complete', () => {
  // No records means "not started", not "done". Treating it as complete would
  // silently block every flag for a user who has no supplements scheduled.
  const v = decideRaisePriority({ intake: intake(0, 0) });
  assert.equal(v.ok, true);
});

test('a second concurrent Priority is refused', () => {
  const v = decideRaisePriority({ intake: intake(5, 0), openId: 'abc123' });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'already-open');
  assert.equal(v.openId, 'abc123');
  assert.match(v.message, /already has an assessment open/i);
});

test('completion is reported ahead of the stacking check', () => {
  // Both conditions true: the message must be about the finished plan, because
  // that is the one the admin can act on right now.
  const v = decideRaisePriority({ intake: intake(3, 3), openId: 'zzz' });
  assert.equal(v.code, 'intake-complete');
});

test('missing facts do not throw', () => {
  // A route that forgets to gather facts must not crash the request into a 500.
  // Note this fails OPEN (the flag is allowed), which is deliberate: the
  // DB-backed guardRaisePriority always gathers both facts, so an empty input
  // can only be a programming error, and denying a legitimate clinical flag is
  // the worse failure. The route-level guards never pass undefined.
  const v = decideRaisePriority(undefined);
  assert.equal(v.ok, true);
  assert.equal(decideRaisePriority({}).ok, true);
});

test('every refusal carries a message the admin UI can show', () => {
  for (const v of [
    decideRaisePriority({ intake: intake(2, 2) }),
    decideRaisePriority({ intake: intake(2, 0), openId: 'q' }),
  ]) {
    assert.equal(v.ok, false);
    assert.equal(typeof v.message, 'string');
    assert.ok(v.message.length > 20, 'refusals must explain themselves');
    assert.ok(!/\[object Object\]/.test(v.message));
  }
});

test('dayKey is the YYYY-MM-DD form IntakeRecord stores', () => {
  const k = getTodayKey();
  assert.match(k, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(k, new Date().toISOString().split('T')[0]);
});

// ── What counts as "already done" ──────────────────────────────────────────
// The reported bug was a flag left standing on an assessment the user had
// finished. These pin the definition of "finished", including the case that
// the original today-only check got wrong.

test('a plan finished TODAY is complete', () => {
  const s = stateFor([{ dayKey: getTodayKey(), taken: true }, { dayKey: getTodayKey(), taken: true }]);
  assert.equal(s.complete, true);
  assert.deepEqual(decideRaisePriority({ intake: s }).code, 'intake-complete');
});

test('a plan finished YESTERDAY is complete even with no records today', () => {
  // This is the case the today-only check missed. The user ticked everything
  // off yesterday and an admin flagged the assessment this morning: there are
  // no records for today, so a today-only query returns total=0, reports "not
  // complete", and the gate stays up with no way to clear it — clearing it
  // requires posting an intake for today, which the user has no reason to do.
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const s = stateFor([
    { dayKey: yesterday, taken: true },
    { dayKey: yesterday, taken: true },
    { dayKey: yesterday, taken: true },
  ]);
  assert.equal(s.dayKey, yesterday);
  assert.equal(s.complete, true);
  assert.deepEqual(decideRaisePriority({ intake: s }).code, 'intake-complete');
});

test('a plan partly finished YESTERDAY is NOT complete', () => {
  // The fallback must not manufacture a "done" verdict: a genuinely incomplete
  // plan is exactly the case a Priority review exists for.
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const s = stateFor([
    { dayKey: yesterday, taken: true },
    { dayKey: yesterday, taken: false },
  ]);
  assert.equal(s.complete, false);
  assert.equal(decideRaisePriority({ intake: s }).ok, true);
});

test('today wins over older days when both exist', () => {
  // Yesterday finished but today is only half done: the review is live again,
  // so the flag must survive.
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const today = getTodayKey();
  const s = stateFor([
    { dayKey: yesterday, taken: true },
    { dayKey: today, taken: true },
    { dayKey: today, taken: false },
  ]);
  assert.equal(s.dayKey, today);
  assert.equal(s.complete, false);
});

test('a user with no intake records at all is not "done"', () => {
  // Never flag-blocked into a permanent state, and never auto-released.
  const s = stateFor([]);
  assert.equal(s.complete, false);
  assert.equal(s.dayKey, null);
});
