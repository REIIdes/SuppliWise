/**
 * The sentence under the Wellness Score.
 *
 * Run: node --test src/utils/scoreSync.test.js
 *
 * The property worth protecting here is that the line never accuses anyone of
 * having missed a dose they are still on time for. Every assertion below that
 * mentions "still open" is that one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreSyncLine, scoreSyncTone } from './scoreSync.js';

/** An `awaiting` dose and a `missed` dose in the same day. */
const day = (over) => ({
  total: 4, taken: 1, missed: 1, awaiting: 2, decided: 2, adherence: 50, penaltyPoints: 15, ...over,
});

test('a day with nothing missed never implies one was', () => {
  const line = scoreSyncLine(day({ missed: 0, penaltyPoints: 0 }));
  assert.match(line, /In step/);
  assert.doesNotMatch(line, /missed/i);
  assert.doesNotMatch(line, /point/i);
});

test('an unticked dose inside an open window is described as still open', () => {
  const line = scoreSyncLine({ missed: 0, awaiting: 3, taken: 0, penaltyPoints: 0 });
  assert.match(line, /3 still open/);
  assert.match(line, /nothing has closed yet/);
  // Singular, so the sentence does not read "1 still open" next to "them".
  assert.match(scoreSyncLine({ missed: 0, awaiting: 1, taken: 1 }), /1 still open/);
});

test('a closed unticked dose names the cost', () => {
  const line = scoreSyncLine(day());
  assert.match(line, /^1 dose missed after their window closed, costing you 15 points\./);
  assert.match(line, /2 still open/);
});

test('nothing left to take says so, instead of leaving a dead end', () => {
  const line = scoreSyncLine({ total: 2, taken: 0, missed: 2, awaiting: 0, penaltyPoints: 24 });
  assert.match(line, /2 doses missed after its window closed, costing you 24 points\./);
  assert.match(line, /Nothing is left to take today\./);
  assert.doesNotMatch(line, /still open/);
});

test('a late entry is reported as free, which is the whole point of the feature', () => {
  const line = scoreSyncLine({ total: 3, taken: 3, missed: 0, awaiting: 0, penaltyPoints: 0 });
  assert.match(line, /Late entries count the same as on time\./);
});

test('a plan with nothing on it says nothing', () => {
  assert.equal(scoreSyncLine({ total: 0, taken: 0, missed: 0, awaiting: 0, penaltyPoints: 0 }), '');
});

test('an older server that omits the block renders nothing rather than guessing', () => {
  for (const missing of [undefined, null, 'nope', 7]) {
    assert.equal(scoreSyncLine(missing), '');
    assert.equal(scoreSyncTone(missing), 'ok');
  }
});

test('junk numbers cannot produce NaN or Infinity in the copy', () => {
  const line = scoreSyncLine({ missed: 'x', awaiting: -4, taken: null, penaltyPoints: NaN });
  assert.equal(typeof line, 'string');
  assert.doesNotMatch(line, /NaN|Infinity|undefined/);
});

test('the tone follows the misses and nothing else', () => {
  assert.equal(scoreSyncTone(day()), 'penalty');
  assert.equal(scoreSyncTone(day({ missed: 0 })), 'ok');
  assert.equal(scoreSyncTone(day({ missed: 0, penaltyPoints: 3 })), 'ok', 'a stale penalty must not paint a penalty');
});

// ── The plan-arrival exemption ──────────────────────────────────────────────

test('a plan created mid-day says why its early doses are not missed', () => {
  // Without this, a user who completed an assessment at 3 PM opens their first
  // dashboard, sees a stack of morning doses they were never on time for, and is
  // told "In step — nothing has closed yet". That is a sentence about a day the
  // clock already disagrees with, and it reads as a bug.
  const line = scoreSyncLine({ total: 5, taken: 2, missed: 0, awaiting: 1, exempt: 2, penaltyPoints: 0 });
  assert.match(line, /plan started mid-day/);
  assert.match(line, /2 doses from earlier are not held against you/);
  assert.match(line, /1 still open/);
  // And it points at what the user actually wants to know: from when it counts.
  assert.match(line, /from tomorrow/);
  assert.doesNotMatch(line, /missed/i);
  assert.equal(scoreSyncTone({ missed: 0, exempt: 2 }), 'ok', 'an exemption is not a penalty');
});

test('an exempt-only day with nothing left says the plan runs from tomorrow', () => {
  const line = scoreSyncLine({ total: 3, taken: 0, missed: 0, awaiting: 0, exempt: 3, penaltyPoints: 0 });
  assert.match(line, /3 doses from earlier/);
  assert.match(line, /runs normally from tomorrow/);
});

test('an exempt-only day where the rest is taken says exactly that', () => {
  const line = scoreSyncLine({ total: 4, taken: 2, missed: 0, awaiting: 0, exempt: 2, penaltyPoints: 0 });
  assert.match(line, /2 doses from earlier/);
  assert.match(line, /Everything else is taken\./);
});

test('a real miss is still reported when the plan also has forgiven frames', () => {
  // The exemption lifts the charge on the frames that closed before the plan
  // existed; it must not swallow the ones the user WAS given time for. This is a
  // plan created at 3 PM that never took its evening dose.
  const line = scoreSyncLine({ total: 6, taken: 2, missed: 1, awaiting: 1, exempt: 2, penaltyPoints: 8 });
  assert.match(line, /^1 dose missed after their window closed, costing you 8 points\./);
  assert.match(line, /1 still open/);
  assert.match(line, /2 doses from before your plan started are not counted against you\./);
  assert.equal(scoreSyncTone({ missed: 1, exempt: 2 }), 'penalty');
});

test('the exemption sentence agrees with its own number', () => {
  assert.match(scoreSyncLine({ total: 1, exempt: 1, taken: 0, awaiting: 0 }), /1 dose from earlier/);
});

test('a missing or junky exemption is treated as none', () => {
  // The block is additive, so an older server sends nothing at all. It must read
  // as "no exemption", not as a NaN in the middle of the sentence.
  for (const exempt of [undefined, null, 'x', -2, NaN, {}]) {
    const line = scoreSyncLine({ total: 2, taken: 0, missed: 0, awaiting: 2, exempt, penaltyPoints: 0 });
    assert.match(line, /2 still open/);
    assert.doesNotMatch(line, /NaN|undefined|mid-day/);
  }
});