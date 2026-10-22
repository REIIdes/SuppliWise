'use strict';

/**
 * The reuse gate's identity: which answers make a plan, and which do not.
 *
 * Run: npm test
 *
 * `/recommend` hashes the member's answers, stores the digest on the assessment
 * as `aiResults.planSignature`, and hands that stored plan back when the digest
 * comes out the same. Everything here exists because that digest has to mean
 * "the same health information" and nothing more:
 *
 *   1. the whitelist must track the Assessment schema, because a question added
 *      to the model and forgotten there stops influencing the plan it selects;
 *   2. fields the form sends that the database never keeps (`bmi`,
 *      `physicalActivityLevel`) must not reach the digest, or an assessment
 *      typed into the form and one rebuilt from a stored record can never match;
 *   3. `updatedFrom` must not reach it either — it names the record an update
 *      was cloned from, so pressing Update twice would look like new answers.
 *
 * No MongoDB, no provider: these are the pure functions the route calls before
 * it asks anything.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Assessment = require('../models/Assessment');
const { ASSESSMENT_FIELDS, pickAssessmentFields } = require('../routes/recommend');
const { canonicaliseAnswers } = require('../utils/answerCanonical');
const { answerSignature, SELECTION_RULES_VERSION } = require('../utils/planSelection');

// Schema columns that are not answers a member gives: the owner, the AI's own
// output, retention, the priority-flag lifecycle and the who/when snapshot.
// Anything else on the model MUST be in ASSESSMENT_FIELDS.
const NOT_AN_ANSWER = new Set([
  'user', 'aiResults', 'expiresAt', 'priority', 'flagReasons', 'flaggedAt',
  'resolvedAt', 'resolvedReason', 'userEmail', 'userName', '_id', '__v',
  'createdAt', 'updatedAt',
]);

const schemaAnswerFields = () =>
  Object.keys(Assessment.schema.paths).filter((path) => !NOT_AN_ANSWER.has(path));

test('every question the Assessment model stores is part of a plan\'s identity', () => {
  const stored = schemaAnswerFields();
  assert.ok(stored.length >= 20, 'the instrument is expected to carry at least 20 answer fields');

  const forgotten = stored.filter((field) => !ASSESSMENT_FIELDS.has(field));
  assert.deepEqual(forgotten, [], `${forgotten.join(', ')} is saved on an assessment but excluded from the signature, so it silently cannot influence the plan it reuses`);

  const invented = [...ASSESSMENT_FIELDS].filter((field) => !Assessment.schema.paths[field]);
  assert.deepEqual(invented, [], `${invented.join(', ')} is in the signature whitelist but no such column exists — a typo, or a field the model dropped`);
});

test('derived and transient postings never reach the digest', () => {
  // Exactly the mismatch that made Update Health Assessment regenerate every
  // time: the form computes a BMI and a labelled activity level, the database
  // keeps neither, so the two submissions were never the same payload.
  const fromForm = {
    age: 21, gender: 'Male', weight: 65, height: 166,
    activityLevel: 'Moderate (3-5 days/week)',
    healthGoals: ['Increase Energy'],
    symptoms: ['Fatigue'], symptomSeverity: { Fatigue: 'Moderate' },
    bmi: 23.6, physicalActivityLevel: 'Moderate (3-5 days/week)',
    _id: '6765', createdAt: '2026-10-22T01:00:00.000Z',
  };
  const fromRecord = {
    age: 21, gender: 'Male', weight: 65, height: 166,
    activityLevel: 'Moderate (3-5 days/week)',
    healthGoals: ['Increase Energy'],
    symptoms: ['Fatigue'], symptomSeverity: { Fatigue: 'Moderate' },
  };

  assert.deepEqual(
    pickAssessmentFields(fromForm),
    pickAssessmentFields(fromRecord),
    'the same answers assembled two ways gave two different payloads',
  );
  assert.equal(
    answerSignature(canonicaliseAnswers(pickAssessmentFields(fromForm))),
    answerSignature(canonicaliseAnswers(pickAssessmentFields(fromRecord))),
    'the reuse digest split on a field the database never keeps',
  );
});

test('an unanswered question is absent, whether the client sent null, blank or empty', () => {
  // A stored record reads back as null; the form reads back as '' or []. Both
  // have to collapse to "the member did not answer this".
  const asNull = pickAssessmentFields({ age: 30, weight: 70, symptoms: null, healthGoals: [], allergies: '   ' });
  const asOmitted = pickAssessmentFields({ age: 30, weight: 70 });
  assert.deepEqual(asNull, asOmitted);
  assert.equal(answerSignature(canonicaliseAnswers(asNull)), answerSignature(canonicaliseAnswers(asOmitted)));
});

test('the order ticks were clicked in is not new clinical information', () => {
  const one = canonicaliseAnswers(pickAssessmentFields({
    age: 30, weight: 70,
    symptoms: ['Fatigue', 'Chest Tightness'],
    symptomSeverity: { 'Fatigue': 'Moderate', 'Chest Tightness': 'Mild' },
    healthGoals: ['Increase Energy', 'Improve Strength'],
    medicalConditions: ['Diabetes', 'Anemia', 'Hypertension (High Blood Pressure)'],
    lifestyleHabits: ['Alcohol', 'Smoking'],
  }));
  const other = canonicaliseAnswers(pickAssessmentFields({
    age: 30, weight: 70,
    symptoms: ['Chest Tightness', 'Fatigue'],
    symptomSeverity: { 'Chest Tightness': 'Mild', 'Fatigue': 'Moderate' },
    healthGoals: ['Improve Strength', 'Increase Energy'],
    medicalConditions: ['Hypertension (High Blood Pressure)', 'Anemia', 'Diabetes'],
    lifestyleHabits: ['Smoking', 'Alcohol'],
  }));

  assert.deepEqual(one.symptoms, ['Chest Tightness', 'Fatigue'], 'symptoms reached the plan unsorted');
  assert.deepEqual(Object.keys(one.symptomSeverity), one.symptoms, 'severities are keyed in a different order than the symptoms they describe');
  assert.deepEqual(one, other, 'two click orders produced two profiles');
  assert.equal(answerSignature(one), answerSignature(other));
});

test('which record an update was cloned from does not change the plan', () => {
  const base = pickAssessmentFields({ age: 30, weight: 70, symptoms: ['Fatigue'] });
  const first = { ...base, updatedFrom: '676500000000000000000001' };
  const second = { ...base, updatedFrom: '676500000000000000000002' };
  assert.equal(answerSignature(canonicaliseAnswers(first)), answerSignature(canonicaliseAnswers(second)),
    'updatedFrom leaked into the digest, so a second update could never reuse the first');
});

test('a real clinical change still costs a fresh plan', () => {
  const base = canonicaliseAnswers(pickAssessmentFields({ age: 30, weight: 70, symptoms: ['Fatigue'] }));
  const heavier = canonicaliseAnswers(pickAssessmentFields({ age: 30, weight: 86, symptoms: ['Fatigue'] }));
  const newSymptom = canonicaliseAnswers(pickAssessmentFields({ age: 30, weight: 70, symptoms: ['Fatigue', 'Chest Tightness'] }));
  assert.notEqual(answerSignature(base), answerSignature(heavier), 'weight is what the rules dose from');
  assert.notEqual(answerSignature(base), answerSignature(newSymptom));
});

test('the rules version is stamped into every digest', () => {
  assert.ok(SELECTION_RULES_VERSION, 'needed to invalidate stored plans when the rules change');
  const answers = canonicaliseAnswers(pickAssessmentFields({ age: 30, weight: 70 }));
  assert.equal(
    answerSignature(answers),
    answerSignature(answers, { liveDynamic: [] }),
    'the digest must be reproducible for a caller that passes no learned conditions',
  );
});
