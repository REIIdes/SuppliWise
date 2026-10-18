/**
 * dynamicAssessment — the client merge layer for AI-published conditions.
 *
 * Run: npm test
 *
 * THE PROPERTIES THAT MATTER:
 *   1. Offline-safe. With no live bundle the form is byte-for-byte the
 *      hard-coded questionnaire — the merge is purely additive.
 *   2. No duplicates, ever. A published label that collides with a built-in
 *      (even with different case or spacing) must not render twice.
 *   3. The sex gate is enforced at RENDER time, so a Male-only condition
 *      never appears for a Female answer and vice versa.
 *   4. Update-mode repair only touches plain symptom names that genuinely
 *      belong to a SELECTED published condition — everything else passes
 *      through untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeConditionGroups,
  dynamicSymptomsFor,
  dynamicTooltip,
  prefixDynamicSymptoms,
} from './dynamicAssessment.js';

const GROUPS = [
  { group: 'Cardiovascular & Metabolic', items: ['Diabetes', 'High Cholesterol'] },
  { group: 'Mental Health', items: ['Depression'] },
  { group: 'Other', items: ['Thyroid Disorders'] },
];

const LIVE = [
  {
    label: 'Sleep Apnea',
    group: 'Respiratory & Immune',
    sexGate: '',
    rationale: 'Reported snoring with no condition selected.',
    symptomPool: ['Loud Snoring', 'Daytime Sleepiness'],
    evidence: [{ name: 'Magnesium Glycinate', citation: 'NIH Office of Dietary Supplements.' }],
  },
  {
    label: 'Endometriosis',
    group: 'Other',
    sexGate: 'Female',
    rationale: 'Heavy periods and pelvic pain.',
    symptomPool: ['Heavy Periods'],
    evidence: [{ name: 'Iron Bisglycinate', citation: 'ACOG guideline.' }],
  },
];

test('no live bundle = the built-in groups, untouched', () => {
  assert.equal(mergeConditionGroups(GROUPS, [], 'Female'), GROUPS);
  assert.equal(mergeConditionGroups(GROUPS, null, 'Female'), GROUPS);
});

test('new groups are synthesised and unknown groups fall back to Other', () => {
  const merged = mergeConditionGroups(GROUPS, LIVE, 'Male');
  const resp = merged.find((g) => g.group === 'Respiratory & Immune');
  assert.ok(resp && resp.items.includes('Sleep Apnea'));
  const other = merged.find((g) => g.group === 'Other');
  assert.ok(!other.items.includes('Endometriosis'), 'Female-gated label hidden for Male');
  assert.deepEqual(GROUPS[2].items, ['Thyroid Disorders'], 'input groups are not mutated');
});

test('gender-gated labels appear only for the matching answer, and empty gender shows everything', () => {
  assert.ok(mergeConditionGroups(GROUPS, LIVE, 'Female')
    .find((g) => g.group === 'Other').items.includes('Endometriosis'));
  assert.ok(mergeConditionGroups(GROUPS, LIVE, '')
    .find((g) => g.group === 'Other').items.includes('Endometriosis'), 'unanswered gender must not hide content');
});

test('a published label that duplicates a built-in is never rendered twice', () => {
  const live = [{ label: ' diabetes ', group: 'Cardiovascular & Metabolic', symptomPool: [] }];
  const merged = mergeConditionGroups(GROUPS, live, '');
  const cardio = merged.find((g) => g.group === 'Cardiovascular & Metabolic');
  assert.equal(cardio.items.filter((i) => i.toLowerCase() === 'diabetes').length, 1);
});

test('dynamic symptoms render from the bundle pool; built-ins fall through as null', () => {
  assert.deepEqual(dynamicSymptomsFor(LIVE, 'Sleep Apnea').map((s) => s.name),
    ['Loud Snoring', 'Daytime Sleepiness']);
  assert.equal(dynamicSymptomsFor(LIVE, 'Diabetes'), null);
  assert.deepEqual(dynamicSymptomsFor(LIVE, 'sleep   apnea').length, 2, 'label matching is normalised');
});

test('tooltips cite the professional sources for published labels and stay null for built-ins', () => {
  const tip = dynamicTooltip(LIVE, 'Sleep Apnea');
  assert.match(tip, /Reported snoring/);
  assert.match(tip, /Magnesium Glycinate: NIH Office of Dietary Supplements/);
  assert.equal(dynamicTooltip(LIVE, 'Depression'), null);
});

test('update-mode repair prefixes only plain symptoms owned by a selected published condition', () => {
  const form = {
    medicalConditions: ['Diabetes', 'Sleep Apnea', 'None'],
    symptoms: ['Loud Snoring', 'Fatigue', 'Diabetes::Blurred Vision', 'No current symptoms'],
    symptomSeverity: { 'Loud Snoring': 'Severe', 'Fatigue': 'Mild' },
  };
  const fixed = prefixDynamicSymptoms(form, LIVE);
  assert.ok(fixed.symptoms.includes('Sleep Apnea::Loud Snoring'));
  assert.ok(!fixed.symptoms.includes('Loud Snoring'));
  assert.ok(fixed.symptoms.includes('Fatigue'), 'unowned plain symptom passes through');
  assert.ok(fixed.symptoms.includes('Diabetes::Blurred Vision'));
  assert.ok(fixed.symptoms.includes('No current symptoms'));
  assert.equal(fixed.symptomSeverity['Sleep Apnea::Loud Snoring'], 'Severe', 'severity key moves with the row');
  assert.ok(fixed.symptomSeverity['Fatigue'], 'unowned severity untouched');

  // Idempotent: running it again changes nothing.
  assert.equal(prefixDynamicSymptoms(fixed, LIVE), fixed);
  // Offline: no bundle = same object back.
  assert.equal(prefixDynamicSymptoms(form, []), form);
});
