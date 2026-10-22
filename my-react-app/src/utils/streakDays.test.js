/**
 * The pledge-streak counter.
 *
 * This one exists because the panel first shipped showing "0 consecutive days"
 * directly underneath a pledge minted today: the counter was a React component
 * being called with a positional array, so its destructured `days` prop was
 * undefined and every lookup missed. Extracting the arithmetic is what makes
 * that class of mistake testable — the number is a product promise ("stack a
 * pledge every day") and it must not silently read as zero.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { dayKey, streakDays } from './streakDays.js';

const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);
const keys = (start, count) => {
  const out = [];
  const d = new Date(start);
  for (let i = 0; i < count; i += 1) {
    out.push(dayKey(d));
    d.setDate(d.getDate() - 1);
  }
  return out;
};

test('a day key is zero-padded so string order is calendar order', () => {
  assert.equal(dayKey(at(2026, 1, 5)), '2026-01-05');
  assert.equal(dayKey(at(2026, 10, 23)), '2026-10-23');
});

test('no pledges is no streak', () => {
  assert.equal(streakDays([], at(2026, 10, 23)), 0);
  assert.equal(streakDays(undefined, at(2026, 10, 23)), 0);
});

test('a pledge minted today counts today', () => {
  assert.equal(streakDays(['2026-10-23'], at(2026, 10, 23)), 1);
});

test('a streak survives a day that has not been minted yet', () => {
  // The member mints in the evening: at 8am the run is still alive, and the
  // panel must not tell them they lost three days they actually kept.
  assert.equal(streakDays(['2026-10-22', '2026-10-21', '2026-10-20'], at(2026, 10, 23)), 3);
});

test('a gap ends the run at the gap, not at the oldest entry', () => {
  assert.equal(streakDays(['2026-10-23', '2026-10-21', '2026-10-20'], at(2026, 10, 23)), 1);
  assert.equal(streakDays(['2026-10-23', '2026-10-22', '2026-10-20'], at(2026, 10, 23)), 2);
});

test('two days without a pledge break it outright', () => {
  assert.equal(streakDays(['2026-10-20', '2026-10-19'], at(2026, 10, 23)), 0);
});

test('input arrives in whatever order the server sent it', () => {
  const scrambled = keys(at(2026, 10, 23), 5).reverse();
  assert.equal(streakDays(scrambled, at(2026, 10, 23)), 5);
  assert.equal(streakDays([...scrambled, ...scrambled], at(2026, 10, 23)), 5, 'duplicates must not double-count');
});

test('the run walks back across a month and a year boundary', () => {
  assert.equal(streakDays(['2026-05-31', '2026-05-30', '2026-05-29'], at(2026, 5, 31)), 3);
  assert.equal(streakDays(['2026-01-01', '2025-12-31', '2025-12-30'], at(2026, 1, 1)), 3);
});

test('a future entry never inflates the run', () => {
  // A clock that disagrees with the server's day key must not produce a streak
  // the member has not earned.
  assert.equal(streakDays(['2026-10-29', '2026-10-23'], at(2026, 10, 23)), 1);
});
