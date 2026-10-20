/**
 * Plan grounding — the verifier that stands between a generated plan and the
 * member who reads it.
 *
 * Run: node --test "Test File/plan-grounding.test.js"
 *
 * The prompt ASKS the model for real citations, patient-reported triggers and
 * safe doses. These tests pin what the code GUARANTEES instead, from both sides:
 * what a hallucinated answer gets repaired into, and what a correct answer must
 * never lose. The second half matters more — a verifier that deletes true
 * sentences is a worse product than one that lets a hedged claim through.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NEUTRAL_TRIGGER,
  DOSE_TABLE,
  buildFactContext,
  unreportedClaims,
  fabricatedPersonalClaims,
  groundTriggeredBy,
  groundProse,
  verifyCitation,
  checkDose,
  parseFirstDose,
  rejectReason,
  groundPlan,
  groundingViolations,
} = require('../utils/planGrounding');
const {
  ENTRIES,
  HONEST_MARKER,
  evidenceEntry,
  registeredEvidence,
  extractPmids,
  allowlistedPmids,
} = require('../utils/supplementEvidenceRegistry');
const { generateClinicalFallback } = require('../routes/recommend');
const { enforcePlanConsistency } = require('../utils/planConsistency');
const baselineProfiles = require('../eval/baseline-profiles.json');

const PROFILE = {
  age: 34,
  gender: 'Female',
  weight: 58,
  height: 162,
  activityLevel: 'Sedentary',
  dietType: 'Vegan',
  healthGoals: ['Increase Energy'],
  symptoms: ['Fatigue'],
  symptomSeverity: { Fatigue: 'Moderate' },
  sleepQuality: 'Poor',
  stressLevel: 'None',
  waterIntake: 'Low',
  lifestyleHabits: ['None'],
  medicalConditions: ['None'],
  currentMedications: 'None',
  allergies: 'None known',
  pregnancyStatus: 'Not applicable',
};

const rec = (over = {}) => ({
  name: 'Magnesium Glycinate',
  reason: 'Magnesium supports nerve signaling and muscle relaxation.',
  simplifiedReason: 'Magnesium may help your muscles and sleep.',
  dosage: '400mg daily',
  timing: 'Evening with dinner',
  priority: 'High',
  confidenceScore: 85,
  interactions: 'None identified',
  evidence: registeredEvidence('Magnesium Glycinate'),
  foods: 'Pumpkin seeds, spinach, tofu, almonds',
  sideEffects: 'Loose stools at high doses',
  triggeredBy: 'Fatigue (Moderate)',
  ...over,
});

const plan = (recommendations, over = {}) => ({
  summary: 's',
  simplifiedSummary: 'ss',
  recommendations,
  lifestyleAdvice: [{ category: 'Sleep', advice: 'a' }],
  mealRecommendations: [{ meal: 'Breakfast', suggestion: 'Oatmeal' }],
  actionPlan: [{ week: 1, task: 't' }],
  dailySchedule: [{ time: 'evening', supplements: ['Magnesium Glycinate'] }],
  warnings: [],
  avoidList: ['Alcohol'],
  disclaimer: 'd',
  ...over,
});

const kinds = (grounded) => (grounded.grounding.actions || []).map((a) => a.kind);

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

test('a fabricated PMID is replaced by the registry citation for that nutrient', () => {
  const forged = 'Journal of Nutrition (2023). Magnesium and sleep quality. PMID: 37123456.';
  const out = groundPlan(plan([rec({ evidence: forged })]), PROFILE);
  assert.equal(out.recommendations[0].evidence, evidenceEntry('Magnesium Glycinate').citation);
  assert.ok(kinds(out).includes('citation-replaced'));
  assert.equal(groundingViolations(out, PROFILE).filter((v) => v.kind === 'citation').length, 0);
});

test('the citation the app itself ships always survives the verifier', () => {
  const out = groundPlan(plan([rec()]), PROFILE);
  assert.equal(out.recommendations[0].evidence, registeredEvidence('Magnesium Glycinate'));
  assert.ok(!kinds(out).includes('citation-replaced'));
});

test('a real-looking PubMed link to an unchecked number is refused', () => {
  const r = verifyCitation('See https://pubmed.ncbi.nlm.nih.gov/32722093/ for evidence.', 'L-Theanine');
  assert.equal(r.ok, false);
  assert.match(r.reason, /PMID|URL/);
});

test('a URL outside the medical sources is refused even with no identifier', () => {
  const r = verifyCitation('Supported by NIH guidelines, details at https://example.com/study', 'Vitamin D');
  assert.equal(r.ok, false);
  assert.match(r.reason, /allowlist/);
});

test('an off-registry citation for a registered nutrient is upgraded to the registry copy', () => {
  const r = verifyCitation('Supported by a 2021 NIH meta-analysis of magnesium.', 'Magnesium');
  assert.equal(r.ok, true);
  assert.equal(r.upgraded, true);
  assert.equal(r.replacement, evidenceEntry('Magnesium').citation);
});

test('a nutrient the registry does not cover gets the honest marker, not a study', () => {
  const r = verifyCitation("Supported by Li X et al. (2019) Journal of Herbology. PMID: 31112223.", "Devil's Claw");
  assert.equal(r.ok, false);
  assert.equal(r.replacement, HONEST_MARKER);
  assert.equal(evidenceEntry("Devil's Claw"), null);
});

test('PMIDs cleared by the evidence gate for AI-published conditions are vouchable', () => {
  const allowed = new Set(['99999999']);
  const r = verifyCitation('Supported by a 2024 randomized trial (PMID: 99999999).', 'Berberine', { allowedPmids: allowed });
  assert.equal(r.ok, true);
});

test('every registry citation verifies for its own nutrient', () => {
  for (const entry of ENTRIES) {
    const r = verifyCitation(entry.citation, entry.nutrient);
    assert.equal(r.ok, true, `${entry.nutrient}: ${r.reason}`);
    assert.equal(r.replacement, entry.citation, entry.nutrient);
    for (const id of extractPmids(entry.citation)) assert.ok(allowlistedPmids().has(id), `${entry.nutrient} PMID ${id}`);
  }
});

// ---------------------------------------------------------------------------
// Patient facts
// ---------------------------------------------------------------------------

test('a symptom the patient never reported is stripped from triggeredBy', () => {
  const ctx = buildFactContext(PROFILE);
  assert.equal(unreportedClaims('Diabetes reported', ctx).length, 1);
  const out = groundPlan(plan([rec({ triggeredBy: 'Diabetes (Severe)' })]), PROFILE);
  assert.equal(out.recommendations[0].triggeredBy, NEUTRAL_TRIGGER);
  assert.ok(kinds(out).includes('trigger-stripped'));
});

test('a reported symptom is kept, with its severity', () => {
  const out = groundPlan(plan([rec({ triggeredBy: 'Fatigue (Moderate)' })]), PROFILE);
  assert.equal(out.recommendations[0].triggeredBy, 'Fatigue (Moderate)');
});

test('only the lying clause of a reason is deleted, not the nutrition science', () => {
  const text = 'Magnesium supports nerve signaling. You reported diabetes, which makes insufficiency likely. Your goal of more energy may benefit.';
  const out = groundPlan(plan([rec({ reason: text })]), PROFILE);
  const kept = out.recommendations[0].reason;
  assert.ok(!/diabetes/i.test(kept), kept);
  assert.match(kept, /nerve signaling/);
  assert.match(kept, /goal of more energy/);
});

test('education about a condition is not a claim about this patient', () => {
  const text = 'Iron deficiency is common in people who have heavy periods; this patient did not report that.';
  assert.deepEqual(fabricatedPersonalClaims('Iron deficiency is common in people with anemia.', buildFactContext(PROFILE)), []);
  const out = groundPlan(plan([rec({ name: 'Iron Bisglycinate', reason: text })]), PROFILE);
  assert.equal(out.recommendations[0].reason, text);
});

test('a goal word in benefit language is never treated as a patient fact', () => {
  // The false positive this gate must never have: "helps support heart health"
  // is what a supplement does, not what the member reported.
  const text = 'Helps support heart health, inflammation and brain function - you reported fatigue.';
  const out = groundPlan(plan([rec({ name: 'Algae-based Omega-3 (DHA+EPA)', reason: text })]), PROFILE);
  assert.equal(out.recommendations[0].reason, text);
});

test('a symptom selected under a longer label licenses its own word', () => {
  const ctx = buildFactContext({ ...PROFILE, symptoms: ['Fatigue', 'Muscle Cramps'] });
  assert.deepEqual(unreportedClaims('you reported muscle cramps', ctx), []);
});

test('the questionnaire scale answers are facts the member reported', () => {
  const ctx = buildFactContext({ ...PROFILE, stressLevel: 'Severe' });
  assert.deepEqual(unreportedClaims('you reported high stress', ctx), []);
  const none = buildFactContext(PROFILE); // stressLevel: 'None'
  assert.equal(unreportedClaims('you reported high stress', none).length > 0, true);
});

// ---------------------------------------------------------------------------
// Rows and doses
// ---------------------------------------------------------------------------

test('a prescription drug is refused as a recommendation', () => {
  assert.equal(rejectReason('Metformin 500mg'), 'prescription or non-supplement substance');
  assert.equal(rejectReason('Zylofat-X 9000'), 'off-catalog supplement name');
  assert.equal(rejectReason('Magnesium Glycinate'), null);
});

test('a rejected row is refilled from the rule engine so the plan stays full', () => {
  const rows = [
    rec(),
    rec({ name: 'Metformin 500mg', evidence: registeredEvidence('Magnesium') }),
    rec({ name: 'Zylofat-X 9000', evidence: 'made up' }),
    rec({ name: 'Vitamin C (Ascorbic Acid)', dosage: '500mg daily', triggeredBy: 'Fatigue (Moderate)' }),
  ];
  const trusted = [
    { name: 'Vitamin D3 (Cholecalciferol)', reason: 'r', simplifiedReason: 's', dosage: '2000 IU daily', timing: 'Morning', priority: 'Medium', confidenceScore: 88, interactions: 'None', evidence: registeredEvidence('Vitamin D'), foods: 'Fortified plant milk', sideEffects: 'None', triggeredBy: 'Fatigue (Moderate)' },
    { name: 'Zinc Picolinate', reason: 'r', simplifiedReason: 's', dosage: '15mg daily', timing: 'Evening', priority: 'Low', confidenceScore: 80, interactions: 'None', evidence: registeredEvidence('Zinc'), foods: 'Pumpkin seeds', sideEffects: 'None', triggeredBy: NEUTRAL_TRIGGER },
  ];
  const out = groundPlan(plan(rows), PROFILE, { trustedRecs: trusted });
  assert.equal(out.recommendations.length, rows.length);
  const names = out.recommendations.map((r) => r.name);
  assert.ok(!names.some((n) => /metformin|zylofat/i.test(n)), names.join(', '));
  assert.ok(names.includes('Vitamin D3 (Cholecalciferol)'));
  assert.ok(out.recommendations.some((r) => r.groundingBackfilled === true));
  assert.ok(kinds(out).includes('row-dropped') && kinds(out).includes('row-backfilled'));
});

test('a row containing a declared allergen is removed', () => {
  const out = groundPlan(plan([rec({ name: 'Omega-3 (Fish Oil)' })]), { ...PROFILE, allergies: 'Fish' });
  assert.equal(out.recommendations.length, 0);
  assert.ok(kinds(out).includes('row-dropped'));
});

test('an allergen is stripped from a food list without deleting the row', () => {
  const out = groundPlan(plan([rec({ foods: 'Spinach, salmon, tofu, pumpkin seeds' })]), { ...PROFILE, allergies: 'Salmon' });
  assert.equal(out.recommendations[0].foods, 'Spinach, tofu, pumpkin seeds');
  assert.ok(kinds(out).includes('foods-stripped'));
});

test('a dose past the safety ceiling is clamped and the member is told', () => {
  const out = groundPlan(plan([rec({ dosage: '5000mg daily' })]), PROFILE);
  assert.equal(out.recommendations[0].dosage, '300-400mg daily');
  assert.ok(kinds(out).includes('dose-clamped'));
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /safety ceiling/);
  assert.match(out.warnings[0], /300-400mg daily/);
});

test('a legitimate dose is left untouched', () => {
  for (const [name, dosage] of [['Magnesium Glycinate', '400mg daily'], ['Iron Bisglycinate', '25mg daily'], ['Vitamin D3', '4000 IU daily'], ['Zinc', '30mg daily']]) {
    assert.equal(checkDose(name, dosage).ok, true, `${name} ${dosage}`);
  }
});

test('units are never converted across systems', () => {
  // 5000 mg of vitamin D is nonsense, but mg is not the unit the ceiling is
  // stated in, so the verifier refuses to guess and leaves it to the clinician.
  assert.equal(checkDose('Vitamin D3', '5000mg daily').ok, true);
});

test('the dose parser reads the stated range, not the total', () => {
  assert.deepEqual(parseFirstDose('1,500mg daily'), { value: 1500, unit: 'mg' });
  assert.deepEqual(parseFirstDose('0.5–1mg before bed'), { value: 1, unit: 'mg' });
  assert.deepEqual(parseFirstDose('2000 IU daily'), { value: 2000, unit: 'iu' });
  assert.equal(parseFirstDose('Per label'), null);
  assert.equal(checkDose('Magnesium', 'As directed by your provider').ok, true);
});

test('every standard dose in the table passes its own ceiling', () => {
  for (const entry of DOSE_TABLE) {
    assert.equal(checkDose(entry.alias[0], entry.standard).ok, true, `${entry.alias[0]}: ${entry.standard}`);
  }
});

// ---------------------------------------------------------------------------
// Schema trust fields
// ---------------------------------------------------------------------------

test('priority and confidence are normalised into the range the client renders', () => {
  const out = groundPlan(plan([rec({ priority: 'URGENT', confidenceScore: 45 }), rec({ name: 'Vitamin C (Ascorbic Acid)', priority: 'low', confidenceScore: 900, triggeredBy: NEUTRAL_TRIGGER })]), PROFILE);
  assert.equal(out.recommendations[0].priority, 'Medium');
  assert.equal(out.recommendations[0].confidenceScore, 70);
  assert.equal(out.recommendations[1].priority, 'Low');
  assert.equal(out.recommendations[1].confidenceScore, 100);
});

test('duplicate supplement rows are collapsed', () => {
  const out = groundPlan(plan([rec(), rec({ dosage: '300mg daily' })]), PROFILE);
  assert.equal(out.recommendations.length, 1);
});

// ---------------------------------------------------------------------------
// Guarantees about the gate itself
// ---------------------------------------------------------------------------

test('grounding is idempotent and never mutates the plan it is given', () => {
  const input = plan([rec({ evidence: 'Invented (2020) Acta Fantastica. PMID: 12121212.' }), rec({ name: 'Metformin' })]);
  const snapshot = JSON.stringify(input);
  const once = groundPlan(input, PROFILE, { trustedRecs: [{ name: 'Vitamin B12 (Methylcobalamin)', dosage: '1000mcg daily', priority: 'Medium', confidenceScore: 90, evidence: registeredEvidence('Vitamin B12'), triggeredBy: NEUTRAL_TRIGGER, reason: 'r', simplifiedReason: 's', timing: 'Morning', interactions: 'None', foods: 'Fortified plant milk', sideEffects: 'None' }] });
  assert.equal(JSON.stringify(input), snapshot, 'input plan was mutated');
  const twice = groundPlan(once, PROFILE, { trustedRecs: once.recommendations });
  assert.deepEqual(twice.recommendations, once.recommendations);
  assert.deepEqual(twice.warnings, once.warnings);
});

test('a plan with no recommendations is passed through, not crashed', () => {
  assert.deepEqual(groundPlan(null, PROFILE), null);
  assert.deepEqual(groundPlan({ summary: 'x' }, PROFILE), { summary: 'x' });
  const empty = groundPlan(plan([]), PROFILE);
  assert.equal(empty.recommendations.length, 0);
});

// ---------------------------------------------------------------------------
// Calibration: the shipped baseline must already be grounded
// ---------------------------------------------------------------------------

test('every rule-engine baseline plan passes the gate untouched', () => {
  for (const profile of baselineProfiles) {
    const enginePlan = enforcePlanConsistency(generateClinicalFallback(profile));
    const violations = groundingViolations(enginePlan, profile);
    assert.deepEqual(violations, [], `${profile.id}: ${JSON.stringify(violations)}`);
    const out = groundPlan(enginePlan, profile);
    const before = enginePlan.recommendations;
    assert.deepEqual(out.recommendations.map((r) => r.name), before.map((r) => r.name), profile.id);
    assert.deepEqual(out.recommendations.map((r) => r.dosage), before.map((r) => r.dosage), profile.id);
    assert.deepEqual(out.recommendations.map((r) => r.evidence), before.map((r) => r.evidence), profile.id);
    assert.deepEqual(out.recommendations.map((r) => r.triggeredBy), before.map((r) => r.triggeredBy), profile.id);
    assert.deepEqual(out.recommendations.map((r) => r.reason), before.map((r) => r.reason), profile.id);
    for (const k of ['row-dropped', 'citation-replaced', 'citation-grounded', 'dose-clamped', 'trigger-stripped', 'reason-claim-removed', 'simplifiedReason-claim-removed', 'foods-stripped', 'row-backfilled']) {
      assert.ok(!kinds(out).includes(k), `${profile.id} had ${k}`);
    }
    // The only change a curated plan may see is a field the engine never wrote.
    for (const a of out.grounding.actions) assert.equal(a.kind, 'field-normalised', `${profile.id}: ${a.kind}`);
  }
});

// ---------------------------------------------------------------------------
// The registry is the single source the route uses
// ---------------------------------------------------------------------------

test('inferEvidence delegates to the registry, so engine and verifier agree', () => {
  const names = ['Magnesium Glycinate', 'Vitamin D3 (Cholecalciferol)', 'Omega-3 (EPA+DHA)', 'Iron Bisglycinate', 'Zinc Picolinate', 'Berberine', "Devil's Claw"];
  for (const name of names) assert.equal(registeredEvidence(name), evidenceEntry(name) ? evidenceEntry(name).citation : registeredEvidence('unknown-thing'));
  assert.equal(registeredEvidence('Magnesium Glycinate'), evidenceEntry('Magnesium').citation);
  assert.notEqual(registeredEvidence("Devil's Claw"), HONEST_MARKER, 'the engine default is the generic source line');
});
