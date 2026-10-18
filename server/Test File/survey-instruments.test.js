/**
 * Evaluation instruments — scoring and reliability statistics.
 *
 * Run: npm test
 *
 * The properties that matter:
 *
 *   1. THE SCORING IS THE PUBLISHED ONE. SUS is only comparable to the
 *      thousands of published administrations if the items, the reverse
 *      scoring and the x2.5 transform are verbatim; the test vectors are
 *      computed independently of this codebase.
 *   2. THE RELIABILITY STATISTIC IS CORRECT. Cronbach's alpha is the number
 *      a statistician validates an instrument with; a wrong formula silently
 *      "validates" a bad questionnaire.
 *   3. REVERSE-SCORED ITEMS ARE FLIPPED BEFORE ALPHA. Alpha over a matrix
 *      where half the items run backwards produces a near-zero alpha for a
 *      perfectly good instrument.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mean, sampleStandardDeviation, cronbachAlpha, alphaIfItemDeleted, describeInstrument,
} = require('../utils/surveyStats');
const {
  INSTRUMENTS, SUS, EFFICIENCY, SATISFACTION, scoreSUS, scoreLikert, scoreInstrument,
} = require('../utils/surveyInstruments');

test('descriptive stats basics', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(mean([]), null);
  assert.equal(sampleStandardDeviation([5]), null);
  assert.ok(Math.abs(sampleStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9]) - 2.13808993) < 1e-6);
});

test('cronbachAlpha matches an independently computed reference (0.984)', () => {
  // 5 respondents x 3 items; reference value computed by hand from the
  // variance formula, not by this code.
  const data = [[4, 4, 5], [3, 3, 4], [2, 2, 3], [1, 1, 2], [3, 4, 4]];
  assert.ok(Math.abs(cronbachAlpha(data) - 0.984) < 1e-3);
});

test('cronbachAlpha: perfectly parallel items -> 1; noise -> low; guards -> null', () => {
  const parallel = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]];
  assert.ok(Math.abs(cronbachAlpha(parallel) - 1) < 1e-9);
  const noise = [[1, 5], [5, 1], [2, 4], [4, 2], [3, 3], [1, 4]];
  assert.ok(cronbachAlpha(noise) < 0.5);
  assert.equal(cronbachAlpha([[1, 2], [3, 4]]), null); // < 3 respondents
  assert.equal(cronbachAlpha([[1], [2], [3]]), null); // < 2 items
  assert.equal(cronbachAlpha([[1, 1], [1, 1], [1, 1]]), null); // zero variance
});

test('alphaIfItemDeleted finds the weak item', () => {
  const good = [[1, 2], [2, 4], [3, 6], [4, 8], [5, 10]];
  const withNoise = [[1, 2, 4], [2, 4, 1], [3, 6, 5], [4, 8, 2], [5, 10, 3]];
  const dropped = alphaIfItemDeleted(withNoise);
  assert.ok(dropped[2] > cronbachAlpha(withNoise), 'deleting the noise item must raise alpha');
  assert.equal(alphaIfItemDeleted(good).length, 2);
});

test('describeInstrument reports respondents, alpha and per-item stats', () => {
  const data = [[4, 4, 5], [3, 3, 4], [2, 2, 3], [1, 1, 2], [3, 4, 4]];
  const report = describeInstrument(data);
  assert.equal(report.respondents, 5);
  assert.equal(report.items, 3);
  assert.ok(report.alpha > 0.9);
  assert.equal(report.perItem.length, 3);
  assert.equal(report.perItem[0].mean, 2.6);
});

test('SUS has the 10 canonical items with even-position reverse scoring', () => {
  assert.equal(SUS.items.length, 10);
  SUS.items.forEach((item, i) => {
    assert.equal(item.reverse, i % 2 === 1, `item ${i + 1} reverse flag`);
  });
});

test('scoreSUS matches published worked examples', () => {
  // All-3 answers: every item contributes 2 -> 20 x 2.5 = 50.
  assert.equal(scoreSUS([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]), 50);
  // [5,4,5,4,5,4,5,4,5,4]: odd->4 each (20), even->1 each (5), 25 x 2.5 = 62.5.
  assert.equal(scoreSUS([5, 4, 5, 4, 5, 4, 5, 4, 5, 4]), 62.5);
  // Best possible / worst possible bounds.
  assert.equal(scoreSUS([5, 1, 5, 1, 5, 1, 5, 1, 5, 1]), 100);
  assert.equal(scoreSUS([1, 5, 1, 5, 1, 5, 1, 5, 1, 5]), 0);
  // Reject malformed answer sets.
  assert.equal(scoreSUS([5, 4, 5]), null);
  assert.equal(scoreSUS([5, 4, 5, 4, 5, 4, 5, 4, 5, 6]), null);
  assert.equal(scoreSUS([5, 4, 5, 4, 5, 4, 5, 4, 5, 'x']), null);
});

test('Likert instruments score as the 0-100 transform of the item mean', () => {
  assert.equal(scoreLikert(EFFICIENCY, [5, 5, 5, 5]), 100);
  assert.equal(scoreLikert(EFFICIENCY, [1, 1, 1, 1]), 0);
  assert.equal(scoreLikert(SATISFACTION, [3, 3, 3, 3, 3]), 50);
  assert.equal(scoreLikert(SATISFACTION, [4, 5, 3, 4, 4]), 75);
});

test('scoreInstrument validates ids, lengths and returns reverse-flipped matrices', () => {
  const sus = scoreInstrument('sus', [5, 4, 5, 4, 5, 4, 5, 4, 5, 4]);
  assert.equal(sus.score, 62.5);
  // Even (reverse) items flipped: 4 -> 2, so the alpha matrix is unidirectional.
  assert.deepEqual(sus.reversed, [5, 2, 5, 2, 5, 2, 5, 2, 5, 2]);
  const eff = scoreInstrument('efficiency', [4, 4, 4, 4]);
  assert.equal(eff.score, 75);
  assert.ok(scoreInstrument('nope', [1]).error);
  assert.ok(scoreInstrument('sus', [1, 2, 3]).error);
});

test('the three instruments cover usability, efficiency and satisfaction from named standards', () => {
  const measures = INSTRUMENTS.map((i) => i.measures).sort();
  assert.deepEqual(measures, ['efficiency', 'satisfaction', 'usability']);
  for (const instrument of INSTRUMENTS) {
    assert.ok(instrument.source.length > 20, `${instrument.id} must cite its standard`);
    assert.ok(instrument.items.length >= 4);
    assert.equal(instrument.scale.max, 5);
  }
});
