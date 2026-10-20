/**
 * Answer canonicalisation — the formatting-equivalence requirement.
 *
 * Run: npm test
 *
 * "Test with equivalent inputs that differ only in irrelevant details such as
 * extra spaces or capitalization." The clinical rule engine reads answer
 * strings, so an untrimmed or differently-cased tick is a different profile to
 * it unless something normalises first. This suite pins what that normaliser is
 * allowed to do — which includes what it is NOT allowed to do: it may never
 * turn an answer the member gave into a different answer.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonicaliseAnswers, fold } = require('../utils/answerCanonical');
const { ITEMS } = require('../utils/healthAssessmentInstrument');

const optionOf = (id) => (ITEMS.find((item) => item.id === id) || {}).options || [];

test('spacing and case variants are folded onto the instrument\'s own option text', () => {
  const sleep = optionOf('sleepQuality');
  assert.ok(sleep.length > 1, 'the instrument is expected to offer sleep options');
  const messy = canonicaliseAnswers({ ...{ sleepQuality: `  ${sleep[1].toUpperCase().replace(/ /g, '  ')}  ` } });
  assert.equal(messy.sleepQuality, sleep[1], 'a shouted, padded option did not land back on the option list');

  const symptoms = optionOf('symptoms');
  const picked = canonicaliseAnswers({ symptoms: [`  ${symptoms[0].toUpperCase()} `, symptoms[1]] });
  assert.deepEqual(picked.symptoms, [symptoms[0], symptoms[1]]);
});

test('multi-select answers become lists in a stable form, whatever the client sent', () => {
  const commaString = canonicaliseAnswers({ symptoms: 'Fatigue,  Headache ,Brain Fog' });
  const list = canonicaliseAnswers({ symptoms: ['Brain Fog', 'Headache', 'Fatigue'] });
  assert.ok(Array.isArray(commaString.symptoms), 'a comma string never became a list, so .filter() would throw downstream');
  assert.equal(commaString.symptoms.length, 3);
  assert.deepEqual(new Set(commaString.symptoms), new Set(list.symptoms));
});

test('an answer the app does not recognise is kept as the member wrote it', () => {
  // Never invent a recognised option the member did not choose: that would put
  // a false statement about them into their own health record.
  const odd = canonicaliseAnswers({
    symptoms: ['Weird thing I read about'],
    medicalConditions: ['Rare lipase deficiency'],
    feelingDescription: '  I feel foggy  most mornings ',
  });
  assert.deepEqual(odd.symptoms, ['Weird thing I read about']);
  assert.deepEqual(odd.medicalConditions, ['Rare lipase deficiency']);
  assert.equal(odd.feelingDescription, 'I feel foggy most mornings', 'free text lost more than its spacing');
});

test('per-symptom severities follow their symptom keys', () => {
  const messy = canonicaliseAnswers({
    symptoms: ['FATIGUE'],
    symptomSeverity: { '  fatigue ': '  MODERATE  ' },
  });
  assert.deepEqual(messy.symptoms, ['Fatigue']);
  const keys = Object.keys(messy.symptomSeverity);
  assert.deepEqual(keys, [messy.symptoms[0]], 'the severity map was keyed on a string the plan never asks about');
  assert.equal(messy.symptomSeverity[keys[0]], 'Moderate');
});

test('identifiers, numbers and absent fields pass through untouched', () => {
  const input = { _id: '6765', userId: 'a', age: 34, weight: 70.5, recentBloodTest: 'Yes', bloodTestResults: null, aiResults: { recommendations: [1] } };
  const out = canonicaliseAnswers(input);
  assert.equal(out._id, '6765');
  assert.equal(out.age, 34);
  assert.equal(out.weight, 70.5);
  assert.equal(out.bloodTestResults, null);
  assert.deepEqual(out.aiResults, input.aiResults);
  assert.ok(!('symptoms' in out), 'canonicalising invented a field the member never answered');

  assert.equal(canonicaliseAnswers(null), null);
  assert.equal(canonicaliseAnswers('nope'), 'nope');
});

test('canonicalising twice changes nothing the second time', () => {
  const once = canonicaliseAnswers({ symptoms: ['  fatigue ', 'Headache'], sleepQuality: ' POOR ' });
  assert.deepEqual(canonicaliseAnswers(once), once, 'the normaliser is not idempotent, so a retry could keep shifting the profile');
});

test('the comparison form used by the vocabulary is the one the digest needs', () => {
  assert.equal(fold('  MIGRAINE   '), 'migraine');
  assert.equal(fold(null), '');
  assert.equal(fold(undefined), '');
  assert.equal(fold(42), '42');
});
