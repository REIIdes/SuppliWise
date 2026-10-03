/**
 * Assertions over SOURCE files, without the 80 KB failure dump.
 *
 * `assert.match(source, /…/)` prints the entire string it was given when it
 * fails. On a real module that is tens of kilobytes of unrelated code pushed
 * into the test output — the actual failure is a single line at the very end, so
 * a genuine regression is easy to miss. These helpers keep the diagnostic to the
 * one sentence that matters.
 */
import assert from 'node:assert/strict';

/**
 * Assert `source` matches `pattern`, reporting only the label on failure.
 *
 * @param {string} source
 * @param {RegExp} pattern
 * @param {string} label  what is expected, phrased so it reads as the failure
 */
export function assertSourceHas(source, pattern, label) {
  if (!pattern.test(source)) {
    assert.fail(`${label}\n  expected to find: ${pattern}`);
  }
}

/**
 * Assert `source` does NOT match `pattern`, reporting only the label.
 *
 * @param {string} source
 * @param {RegExp} pattern
 * @param {string} label
 */
export function assertSourceLacks(source, pattern, label) {
  if (pattern.test(source)) {
    assert.fail(`${label}\n  expected NOT to find: ${pattern}`);
  }
}
