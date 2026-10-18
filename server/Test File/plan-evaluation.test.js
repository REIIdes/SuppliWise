/**
 * Plan evaluation metrics — the numbers behind "the AI is accurate".
 *
 * Run: npm test
 *
 * These metrics are the scoring half of eval/aiBenchmark.js. They are pure
 * functions over a plan object, so the whole research measurement surface is
 * testable offline: a synthetic GOOD plan must score near-perfect, a synthetic
 * BAD plan must lose points on exactly the metrics it violates, and the
 * baseline-vs-candidate comparison must be symmetric and bounded.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  schemaValidity,
  catalogAdherence,
  dietCompliance,
  allergenCompliance,
  citationValidity,
  personalizationRate,
  scorePlan,
  comparePlans,
  priorityDistribution,
  containsForbiddenFood,
} = require('../utils/planEvaluation');
const { generateClinicalFallback } = require('../routes/recommend');
const { enforcePlanConsistency } = require('../utils/planConsistency');

const rec = (over = {}) => ({
  name: 'Magnesium Glycinate',
  reason: 'Magnesium supports nerve signaling and may ease the severe migraines reported.',
  simplifiedReason: 'Helps ease your migraines.',
  triggeredBy: 'Migraine (Severe)',
  conditionContext: 'Given your severe migraines and poor sleep.',
  dosage: '300mg daily',
  timing: 'Evening with dinner',
  priority: 'High',
  confidenceScore: 85,
  severityLevel: 'Moderate',
  interactions: 'None identified',
  evidence: 'NIH ODS (2024). Magnesium Fact Sheet. https://ods.od.nih.gov',
  foods: 'pumpkin seeds, spinach, black beans, almonds, avocado',
  sideEffects: 'Mild digestive comfort changes at high doses',
  ...over,
});

const goodPlan = (n = 15) => ({
  summary: 'A 34-year-old female patient with BMI 22.1 (normal weight) reports migraines.',
  simplifiedSummary: 'This plan helps your migraines and energy.',
  consultDoctor: false,
  consultReason: null,
  wellnessBaseline: 12,
  recommendations: Array.from({ length: n }, (_, i) => rec({
    name: ['Vitamin D3', 'Omega-3 (EPA+DHA)', 'Magnesium Glycinate', 'Zinc', 'Vitamin C'][i % 5],
    priority: i < 8 ? 'High' : 'Medium',
  })),
  lifestyleAdvice: [{ category: 'Sleep', advice: 'Keep a consistent sleep window.' }],
  mealRecommendations: [{ meal: 'Breakfast', suggestion: 'Tofu scramble with spinach.' }],
  dailySchedule: [{ time: 'Morning', supplements: ['Vitamin D3'] }, { time: 'Evening', supplements: ['Magnesium Glycinate'] }],
  actionPlan: [{ phase: 'Week 1', focus: 'Start basics', steps: ['Start Vitamin D3'], expectedChanges: ['Better energy'] }],
  warnings: ['Discuss with your doctor if symptoms persist.'],
  avoidList: ['High-dose Vitamin A'],
  disclaimer: 'Educational purposes only.',
});

test('a complete, ordered plan scores full marks on structure', () => {
  const plan = enforcePlanConsistency(goodPlan());
  const score = scorePlan(plan, { dietType: 'Vegan', allergies: 'None known' });
  assert.equal(score.metrics.orderCompliance.value, 1);
  assert.equal(score.metrics.catalogAdherence.value, 1);
  assert.equal(score.metrics.citationValidity.value, 1);
  assert.equal(score.metrics.personalizationRate.value, 1);
  assert.ok(score.metrics.schemaValidity.value > 0.99, `schema was ${score.metrics.schemaValidity.value}`);
  assert.ok(score.overall >= 90, `overall was ${score.overall}`);
});

test('schemaValidity counts the denominator honestly', () => {
  const full = schemaValidity(goodPlan());
  const broken = schemaValidity({ recommendations: [rec()] });
  assert.ok(broken.value < full.value);
  assert.equal(broken.total > 0, true);
});

test('catalogAdherence punishes invented supplements', () => {
  const plan = goodPlan(5);
  plan.recommendations[0].name = 'Moonshine Berry Extract';
  const r = catalogAdherence(plan);
  assert.equal(r.passed, 4);
  assert.equal(r.total, 5);
});

test('dietCompliance catches animal foods for a vegan and ignores plant lookalikes', () => {
  const bad = goodPlan(5);
  bad.recommendations[0].foods = 'clams, sardines, Atlantic salmon, eggs, Greek yogurt';
  assert.ok(dietCompliance(bad, 'Vegan').value < 1);
  assert.equal(dietCompliance(bad, 'Omnivore').value, 1);
  assert.equal(containsForbiddenFood('almond butter with oat milk', 'vegan'), false);
  assert.equal(containsForbiddenFood('plant milk, nutritional yeast, tempeh', 'vegan'), false);
  assert.equal(containsForbiddenFood('Beef liver and clams', 'vegan'), true);
  assert.equal(containsForbiddenFood('grilled eggplant salad', 'vegan'), false);
});

test('allergenCompliance flags a declared allergen anywhere in the plan', () => {
  const plan = goodPlan(5);
  plan.recommendations[2].foods = 'salmon, mackerel, sardines, tofu, lentils';
  const r = allergenCompliance(plan, 'Shellfish');
  assert.equal(r.value, 1, 'shellfish not present');
  const r2 = allergenCompliance(plan, 'Sardines');
  assert.equal(r2.value, 0);
  assert.deepEqual(r2.violations, ['sardines']);
});

test('citationValidity accepts real dated citations and the honest empty marker', () => {
  const plan = goodPlan(3);
  plan.recommendations[0].evidence = 'No specific source identified';
  plan.recommendations[1].evidence = 'A study says it works';
  const r = citationValidity(plan);
  assert.equal(r.passed, 2);
  assert.equal(r.total, 3);
});

test('scorePlan weights safety: a diet break costs points even if structure is perfect', () => {
  const clean = scorePlan(goodPlan(15), { dietType: 'Vegan' });
  const violating = goodPlan(15);
  violating.recommendations[0].foods = 'beef liver, eggs, whole milk';
  const dirty = scorePlan(violating, { dietType: 'Vegan' });
  assert.ok(dirty.overall < clean.overall);
});

test('comparePlans: identical plans overlap fully; disjoint plans not at all', () => {
  const a = goodPlan(5);
  const b = JSON.parse(JSON.stringify(a));
  const same = comparePlans(a, b);
  assert.equal(same.itemOverlap, 1);
  assert.equal(same.orderAgreement, 1);
  const c = goodPlan(5);
  c.recommendations = c.recommendations.map((r) => ({ ...r, name: `Novital ${r.name}` }));
  const disjoint = comparePlans(a, c);
  assert.equal(disjoint.itemOverlap, 0);
});

test('comparePlans: a reversed order scores negative agreement', () => {
  const a = goodPlan(3);
  const b = { ...a, recommendations: [...a.recommendations].reverse() };
  assert.ok(comparePlans(a, b).orderAgreement < 0);
});

test('priorityDistribution buckets every rec', () => {
  const dist = priorityDistribution(goodPlan(15));
  assert.equal(dist.High + dist.Medium + dist.Low + dist.Other, 15);
});

test('the rule-based baseline itself scores above the quality bar on every profile', () => {
  // This is the regression guard behind eval/aiBenchmark.js: the baseline is
  // the reference the LLM is graded against, so IT must be structurally and
  // safety clean (the vegan food bug this suite was written for stays fixed).
  const profiles = require('../eval/baseline-profiles.json');
  for (const profile of profiles) {
    const plan = enforcePlanConsistency(generateClinicalFallback(profile));
    const score = scorePlan(plan, profile);
    assert.ok(score.metrics.dietCompliance.value === 1, `${profile.id} diet violations: ${JSON.stringify(score.metrics.dietCompliance.violations)}`);
    assert.ok(score.metrics.allergenCompliance.value === 1, `${profile.id} allergen violations: ${JSON.stringify(score.metrics.allergenCompliance.violations)}`);
    assert.ok(score.metrics.orderCompliance.value === 1, `${profile.id} not in canonical order`);
    assert.ok(score.overall >= 70, `${profile.id} overall ${score.overall}`);
  }
});
