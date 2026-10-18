/**
 * Plan consistency — canonical item ordering (the "Omega-3 before Magnesium"
 * guarantee).
 *
 * Run: npm test
 *
 * The property that matters:
 *
 *   THE ORDER OF A PLAN IS A PROPERTY OF THE SYSTEM, NOT OF THE MODEL.
 *   Whatever sequence a provider returns, enforcePlanConsistency re-emits it
 *   with priority tiers first (High → Medium → Low) and, inside a tier, the
 *   canonical nutrient order. The same profile must therefore produce the
 *   same item order on every run, across every model — which is exactly the
 *   output-consistency requirement the evaluation benchmark then measures.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifySupplement,
  canonicalRank,
  orderRecommendations,
  orderDailySchedule,
  enforcePlanConsistency,
  isCanonicalOrder,
} = require('../utils/planConsistency');

test('classifySupplement maps real product names to nutrient classes', () => {
  assert.equal(classifySupplement('Omega-3 (EPA+DHA, pharmaceutical grade)'), 'omega-3');
  assert.equal(classifySupplement('Magnesium Glycinate'), 'magnesium');
  assert.equal(classifySupplement('Vitamin D3 + K2'), 'vitamin-d');
  assert.equal(classifySupplement('Iron Bisglycinate + Vitamin C'), 'iron');
  assert.equal(classifySupplement('Vitamin B12 (Methylcobalamin)'), 'b-vitamin');
  assert.equal(classifySupplement('CoQ10 (Ubiquinol)'), 'coq10');
  assert.equal(classifySupplement('Some Novel Herb Blend'), null);
});

test('"Magnesium Glycinate" is magnesium, not glycine — specific classes win', () => {
  assert.equal(classifySupplement('Magnesium Glycinate'), 'magnesium');
  assert.equal(classifySupplement('L-Glycine'), 'amino-acid');
});

test('Omega-3 ranks before Magnesium in the canonical taxonomy', () => {
  assert.ok(canonicalRank('Omega-3 (EPA+DHA)') < canonicalRank('Magnesium Glycinate'));
  assert.ok(canonicalRank('Magnesium Glycinate') < canonicalRank('Zinc Picolinate'));
});

test('orderRecommendations: priority tier first, canonical order inside a tier', () => {
  const ordered = orderRecommendations([
    { name: 'Zinc', priority: 'Medium' },
    { name: 'Magnesium Glycinate', priority: 'High' },
    { name: 'Vitamin D3', priority: 'Low' },
    { name: 'Omega-3 (EPA+DHA)', priority: 'High' },
    { name: 'Calcium Citrate', priority: 'Medium' },
  ]);
  assert.deepEqual(ordered.map((r) => r.name), [
    'Omega-3 (EPA+DHA)', 'Magnesium Glycinate',
    'Calcium Citrate', 'Zinc',
    'Vitamin D3',
  ]);
});

test('unknown supplements go last inside their tier and keep their relative order (stable)', () => {
  const ordered = orderRecommendations([
    { name: 'Novel Herb B', priority: 'High' },
    { name: 'Iron Bisglycinate', priority: 'High' },
    { name: 'Novel Herb A', priority: 'High' },
  ]);
  assert.deepEqual(ordered.map((r) => r.name), ['Iron Bisglycinate', 'Novel Herb B', 'Novel Herb A']);
});

test('case-insensitive priority: "high" sorts as High', () => {
  const ordered = orderRecommendations([
    { name: 'Zinc', priority: 'HIGH' },
    { name: 'Vitamin C', priority: 'low' },
  ]);
  assert.equal(ordered[0].name, 'Zinc');
});

test('isCanonicalOrder detects a scrambled plan and accepts an ordered one', () => {
  assert.equal(isCanonicalOrder([
    { name: 'Magnesium Glycinate', priority: 'High' },
    { name: 'Omega-3 (EPA+DHA)', priority: 'High' },
  ]), false);
  assert.equal(isCanonicalOrder([
    { name: 'Omega-3 (EPA+DHA)', priority: 'High' },
    { name: 'Magnesium Glycinate', priority: 'High' },
  ]), true);
});

test('orderDailySchedule sorts time blocks through the day', () => {
  const slots = orderDailySchedule([
    { time: 'Before Bed', supplements: ['Magnesium Glycinate'] },
    { time: 'Morning', supplements: ['Vitamin D3'] },
    { time: 'Evening', supplements: ['Zinc'] },
  ]);
  assert.deepEqual(slots.map((s) => s.time), ['Morning', 'Evening', 'Before Bed']);
});

test('orderDailySchedule also orders supplements inside a block', () => {
  const slots = orderDailySchedule([
    { time: 'Morning', supplements: ['Magnesium Glycinate', 'Omega-3 (EPA+DHA)', 'Vitamin D3'] },
  ]);
  assert.deepEqual(slots[0].supplements, ['Vitamin D3', 'Omega-3 (EPA+DHA)', 'Magnesium Glycinate']);
});

test('enforcePlanConsistency never mutates the caller plan and passes partial plans through', () => {
  const plan = {
    recommendations: [{ name: 'Magnesium Glycinate', priority: 'High' }, { name: 'Omega-3', priority: 'High' }],
  };
  const before = JSON.stringify(plan);
  const out = enforcePlanConsistency(plan);
  assert.equal(JSON.stringify(plan), before, 'input must not be mutated');
  assert.equal(out.recommendations[0].name, 'Omega-3');
  assert.equal(enforcePlanConsistency(null), null);
  assert.deepEqual(enforcePlanConsistency({ summary: 'x' }), { summary: 'x' });
});

test('ordering is idempotent — a second pass changes nothing', () => {
  const plan = {
    recommendations: [
      { name: 'Zinc', priority: 'Low' },
      { name: 'Fish Oil', priority: 'High' },
      { name: 'Magnesium Glycinate', priority: 'High' },
    ],
  };
  const once = enforcePlanConsistency(plan);
  const twice = enforcePlanConsistency(once);
  assert.deepEqual(twice.recommendations.map((r) => r.name), once.recommendations.map((r) => r.name));
});
