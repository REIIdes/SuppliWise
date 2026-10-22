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
 *   5. What the form renders is what the form demands. A row hidden by the
 *      gender gate, or an AI-published label whose bundle never arrived, must
 *      not be required by Step 3: an unsatisfiable requirement is a Next button
 *      that silently does nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeConditionGroups,
  dynamicSymptomsFor,
  dynamicTooltip,
  prefixDynamicSymptoms,
  symptomRowsForCondition,
  conditionBlockRenders,
  generalBlockRenders,
  visibleSymptomKeys,
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

// ── Step 3 visibility: the rows the form can actually show ─────────────
// A trimmed stand-in for the page's ALL_SYMPTOMS, carrying the same three gates:
// condition membership, a gender list, and the pregnancy carve-out on Low Libido.
const SYMPTOMS = [
  { name: 'Irregular Periods', genders: ['Female'], conditions: ['PCOS'] },
  { name: 'Fatigue', genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Diabetes', 'Anemia'] },
  { name: 'Low Libido', genders: ['Male'], conditions: ['Diabetes'] },
  { name: 'Unscoped', genders: ['Male', 'Female'], conditions: [] },
];
const GENERAL = ['Fatigue', 'Low Energy'];
const names = (rows) => rows.map((r) => r.name);

test('a published condition answers from its own pool, not the built-in scoping', () => {
  assert.deepEqual(names(symptomRowsForCondition({ gender: 'Male' }, 'Sleep Apnea', LIVE, SYMPTOMS)),
    ['Loud Snoring', 'Daytime Sleepiness']);
});

test('built-in rows keep the gender and pregnancy gates', () => {
  assert.deepEqual(names(symptomRowsForCondition({ gender: 'Female' }, 'Diabetes', [], SYMPTOMS)), ['Fatigue']);
  assert.deepEqual(names(symptomRowsForCondition({ gender: 'Male' }, 'Diabetes', [], SYMPTOMS)), ['Fatigue', 'Low Libido']);
  assert.deepEqual(
    names(symptomRowsForCondition({ gender: 'Male', isBreastfeeding: 'Yes' }, 'Diabetes', [], SYMPTOMS)),
    ['Fatigue'],
  );
  assert.deepEqual(names(symptomRowsForCondition({ gender: 'Prefer not to say' }, 'Diabetes', [], SYMPTOMS)), ['Fatigue']);
  assert.deepEqual(symptomRowsForCondition({ gender: 'Female' }, 'Nope', [], SYMPTOMS), []);
});

test('a symptom with no condition scoping is never offered', () => {
  assert.ok(!names(symptomRowsForCondition({ gender: 'Female' }, 'PCOS', [], SYMPTOMS)).includes('Unscoped'));
});

test('THE DEADLOCK: a built-in whose every row is gated out renders no block, so it cannot be required', () => {
  // A member selects PCOS as Female, then changes gender to "Prefer not to say".
  // The prune effect only removes female-only conditions on "Male", so PCOS stays
  // selected while its rows vanish — and the "No symptoms for PCOS" escape lives
  // inside that block, so nothing on screen can clear the requirement.
  const data = { gender: 'Prefer not to say', medicalConditions: ['PCOS'] };
  assert.deepEqual(symptomRowsForCondition(data, 'PCOS', [], SYMPTOMS), []);
  assert.equal(conditionBlockRenders(data, 'PCOS', [], SYMPTOMS), false);
});

test('an AI-published label renders even with an empty pool — that is its only answer path', () => {
  const data = { gender: '', medicalConditions: ['Sleep Apnea'] };
  assert.equal(conditionBlockRenders(data, 'Sleep Apnea', [{ label: 'Sleep Apnea', symptomPool: [] }], SYMPTOMS), true);
});

test('THE REPORTED BUG: an AI-published label whose bundle never arrived must not be required', () => {
  // A draft or an update carries an AI-published condition, but live-extensions
  // failed, 500ed or has not landed yet, so nothing renders for it. Requiring an
  // answer there stops Step 3 with an error no checkbox can clear, which is what
  // makes the Next button look dead.
  const data = { gender: '', medicalConditions: ['Sleep Apnea'], symptoms: [], symptomSeverity: {} };
  assert.equal(dynamicSymptomsFor([], 'Sleep Apnea'), null);
  assert.equal(conditionBlockRenders(data, 'Sleep Apnea', [], SYMPTOMS), false);
  assert.equal(conditionBlockRenders(data, 'Sleep Apnea', LIVE, SYMPTOMS), true);
});

test('the general-symptom block exists only while None is the sole answer', () => {
  assert.equal(generalBlockRenders({ medicalConditions: ['None'] }), true);
  assert.equal(generalBlockRenders({ medicalConditions: ['None', 'Diabetes'] }), false);
  assert.equal(generalBlockRenders({ medicalConditions: ['Diabetes'] }), false);
  assert.equal(generalBlockRenders({ medicalConditions: [] }), false);
  assert.equal(generalBlockRenders({}), false);
});

test('visibleSymptomKeys lists exactly the checkboxes on screen', () => {
  const none = visibleSymptomKeys({ medicalConditions: ['None'] }, [], SYMPTOMS, GENERAL);
  assert.ok(none.has('General::Fatigue') && none.has('General::Low Energy'));
  assert.ok(none.has('No current symptoms'));

  // "None" plus a condition: the general list is replaced, so its keys are gone.
  const mixed = visibleSymptomKeys({ medicalConditions: ['None', 'Diabetes'], gender: 'Female' }, [], SYMPTOMS, GENERAL);
  assert.ok(!mixed.has('General::Fatigue'));
  assert.ok(mixed.has('Diabetes::Fatigue'));

  const published = visibleSymptomKeys({ gender: '', medicalConditions: ['Sleep Apnea'] }, LIVE, SYMPTOMS, GENERAL);
  assert.ok(published.has('Sleep Apnea::Loud Snoring'));

  const stale = visibleSymptomKeys(
    { gender: 'Prefer not to say', medicalConditions: ['Diabetes', 'PCOS'], symptoms: ['PCOS::Irregular Periods'] },
    [], SYMPTOMS, GENERAL,
  );
  assert.ok(stale.has('Diabetes::Fatigue'));
  assert.ok(!stale.has('Diabetes::Low Libido'));
  assert.ok(!stale.has('PCOS::Irregular Periods'));

  // Marking "no symptoms" collapses that condition's rows away.
  const collapsed = visibleSymptomKeys(
    { gender: 'Female', medicalConditions: ['Diabetes'], noSymptomsForConditions: ['Diabetes'] },
    [], SYMPTOMS, GENERAL,
  );
  assert.ok(!collapsed.has('Diabetes::Fatigue'));
});

test('the page derives Step 3 validation and Step 3 rendering from the same predicate', async () => {
  // The bug was structural: the validator answered "what can this member answer?"
  // from the saved answers alone while the renderer also consulted the live
  // bundle, gender and pregnancy. node --test cannot import a .jsx file, so this
  // is the guard against splitting the two views apart again.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../Pages/AssessmentPage.jsx', import.meta.url), 'utf8');
  assert.match(src, /function validateStep\(step, formData, live = \[\]\)/);
  assert.match(src, /conditionBlockRenders\(formData, c, live, ALL_SYMPTOMS\)/);
  assert.match(src, /visibleSymptomKeys\(formData, live, ALL_SYMPTOMS, GENERAL_SYMPTOMS\)/);
  assert.match(src, /noneSelected && selectedConditions\.length === 0 && generalBlockRenders\(formData\)/);
  assert.match(src, /const conditionSymptoms = symptomRowsForCondition\(data, condition, live, ALL_SYMPTOMS\)/);
  assert.equal((src.match(/validateStep\(step, formData, liveConditions\)/g) || []).length, 2);
  assert.ok(!src.includes('filtered.filter(sym => !symptomSeverity[sym])'));
});
