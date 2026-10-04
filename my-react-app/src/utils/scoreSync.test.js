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