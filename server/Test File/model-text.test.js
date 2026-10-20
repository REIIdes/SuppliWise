/**
 * utils/modelText.js — the ASCII seam every prose guard is written against.
 *
 * Run: node --test "Test File/model-text.test.js"
 *
 * This is a spelling contract, not a meaning contract. Two things can go wrong,
 * and both are asserted: a character a guard needs to see left as it was (so
 * `can’t` still reads as a negation), or a character that carries the model's
 * meaning getting changed (so a normalisation cannot quietly soften a dose, a
 * number, or a word).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeModelText } = require('../utils/modelText');

const cp = (...codes) => codes.map((c) => String.fromCodePoint(c)).join('');

test('the characters the guards depend on are folded to ASCII', () => {
  assert.equal(normalizeModelText(`can${cp(0x2019)}t`), "can't");
  assert.equal(normalizeModelText(`doesn${cp(0x2019)}t`), "doesn't");
  assert.equal(normalizeModelText(`${cp(0x201C)}cures${cp(0x201D)}`), '"cures"');
  assert.equal(normalizeModelText(`400${cp(0x2011)}600 mg`), '400-600 mg');
  assert.equal(normalizeModelText(`no${cp(0x2010)}break`), 'no-break');
  assert.equal(normalizeModelText(`minus ${cp(0x2212)}5`), 'minus -5');
  assert.equal(normalizeModelText(`PMID:${cp(0x202F)}33417003`), 'PMID: 33417003');
  assert.equal(normalizeModelText(`no${cp(0x00A0)}break`), 'no break');
  assert.equal(normalizeModelText(`ellip${cp(0x2026)}`), 'ellip...');
  assert.equal(normalizeModelText(`in${cp(0x200B, 0x200C, 0x200D, 0xFEFF)}visible`), 'invisible');
});

test('en and em dashes are kept — they are punctuation, not a parser hazard', () => {
  // Folding these used to break idempotence: the app's own unsourced-statistic
  // line contains an em dash, so a second verifyProse pass rewrote copy the app
  // wrote itself. DOSE_NUMBER and CLAUSE_SPLIT already match [-–—], so nothing
  // downstream needs the fold.
  assert.equal(normalizeModelText(`400${cp(0x2013)}600 mg`), `400${cp(0x2013)}600 mg`);
  assert.equal(
    normalizeModelText(`well tolerated ${cp(0x2014)} ask a clinician`),
    `well tolerated ${cp(0x2014)} ask a clinician`,
  );
});

test('everything a model can say about a dose or a number survives verbatim', () => {
  // The whitelist half of the contract: nothing here may change, because a
  // normaliser that edits "1,200 IU" or "5-HTP" is editing medical advice.
  const text = 'Take 400 mg, or 1,200 IU of vitamin D3; 5-HTP at 50%. Caféine-free: yes (naïve too). 1/2 tablet.';
  assert.equal(normalizeModelText(text), text);
  assert.equal(normalizeModelText(''), '');
  assert.equal(normalizeModelText(null), '');
  assert.equal(normalizeModelText(undefined), '');
  assert.equal(normalizeModelText(42), '42');
});

test('normalising twice changes nothing, so no guard can be applied to half-edited text', () => {
  const messy = `It can${cp(0x2019)}t cure ${cp(0x201C)}arthritis${cp(0x201D)} — take 400${cp(0x2013)}600 mg${cp(0x2026)}`;
  const once = normalizeModelText(messy);
  assert.equal(normalizeModelText(once), once);
});
