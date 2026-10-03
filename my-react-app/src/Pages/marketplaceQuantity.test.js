/**
 * The marketplace quantity stepper.
 *
 * The interesting property is not the arithmetic in isolation — it is that no
 * input a person can produce leaves the control in a state where the number on
 * screen and the number that would be sent to the server disagree. That is
 * what these cases enumerate: a text field passes through every one of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clampQty } from './marketplaceQuantity.js';

test('a normal value passes through unchanged', () => {
  assert.equal(clampQty('2', 1, 4), 2);
  assert.equal(clampQty(2, 1, 4), 2);
});

test('an empty, zero, negative or unparseable field falls back to the minimum', () => {
  // A stepper that can display 0, -1 or NaN has no orderable state at all, and
  // the Buy button would send whatever it read.
  for (const raw of ['', ' ', 'abc', '0', '0abc', '-5', undefined, null, NaN, '1e3']) {
    assert.equal(clampQty(raw, 1, 4), 1, `clampQty(${JSON.stringify(raw)}) should be 1`);
  }
});

test('more than the seller has is capped at their stock', () => {
  assert.equal(clampQty('99', 1, 4), 4);
  assert.equal(clampQty(9999, 1, 4), 4);
});

test('a fraction is truncated, never rounded up past the cap', () => {
  assert.equal(clampQty('3.7', 1, 4), 3);
  assert.equal(clampQty('4.9', 1, 4), 4);
  assert.equal(clampQty('0.9', 1, 4), 1);
});

test('surrounding whitespace is tolerated, as a real field produces it', () => {
  assert.equal(clampQty(' 2 ', 1, 4), 2);
  assert.equal(clampQty('\t3\n', 1, 4), 3);
});

test('a sold-out listing still yields an orderable 1, never 0', () => {
  // The caller raises a stock of 0 to a max of 1 and disables the control, so
  // the displayed number must be 1 — showing 0 would read as "none left" on a
  // control that is already sold out, and 0 is not a legal order quantity.
  assert.equal(clampQty('1', 1, 1), 1);
  assert.equal(clampQty('5', 1, 1), 1);
});

test('a caller that passes max below min still gets a valid quantity', () => {
  // Defensive: `Math.min(max, …)` alone would return the smaller bound and put
  // 0 or a negative number back on screen.
  assert.equal(clampQty('5', 1, 0), 1);
  assert.equal(clampQty('5', 3, 1), 3);
});

test('every resolved value is a positive integer inside the range', () => {
  const inputs = ['', '0', '1', '4', '99', 'abc', '-2', '2.5', undefined, '  7  '];
  for (const raw of inputs) {
    const qty = clampQty(raw, 1, 4);
    assert.equal(Number.isInteger(qty), true, `${JSON.stringify(raw)} -> ${qty} is not an integer`);
    assert.ok(qty >= 1 && qty <= 4, `${JSON.stringify(raw)} -> ${qty} is outside [1, 4]`);
  }
});
