/**
 * Selection consistency — the guarantee that identical answers give identical
 * plans.
 *
 * Run: npm test
 *
 * The requirement this suite exists for, stated precisely:
 *
 *   WHICH supplements a member is shown is decided by the app, from the answers
 *   on file.  The model decides only what the rows say.  Prompt wording and a
 *   low temperature reduce how much the prose varies between runs; neither can
 *   promise identical output, so neither is relied on for membership.  Every
 *   test below separates the two: selection assertions compare item names and
 *   order, description assertions compare the model's own text.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPlanSpine, generateClinicalFallback } = require('../routes/recommend');
const {
  SELECTION_RULES_VERSION,
  answerSignature,
  alignPlanToSpine,
  selectionKey,
  validateModelPlan,
} = require('../utils/planSelection');
const { enforcePlanConsistency, classifySupplement } = require('../utils/planConsistency');
const { canonicaliseAnswers } = require('../utils/answerCanonical');
const { samplingFields, SAMPLING_CAPABILITIES, AI_ROUTES } = require('../utils/aiRouter');
const { buildAssessmentPrompt } = require('../utils/assessmentPrompt');
const { NEUTRAL_TRIGGER } = require('../utils/planGrounding');
const baselineProfiles = require('../eval/baseline-profiles.json');

/** The authoritative item list the route would build for these answers. */
function spineFor(rawAnswers) {
  // Mirrors the route: the rule engine and the preventive pool are both screened
  // against canonical answers, so a test that skipped this would score a profile
  // the product never builds.
  const answers = canonicaliseAnswers(rawAnswers);
  const engine = enforcePlanConsistency(generateClinicalFallback(answers));
  return buildPlanSpine(engine.recommendations, answers);
}

const names = (rows) => rows.map((row) => row.name);

const ADULT = { ...baselineProfiles[0] };

test('the same answers, submitted five times, select the same supplements in the same order', () => {
  for (const profile of baselineProfiles) {
    const first = spineFor(profile);
    assert.ok(first.length >= 10, `${profile.id}: expected a full plan, got ${first.length} rows`);
    for (let run = 1; run < 5; run += 1) {
      const again = spineFor(JSON.parse(JSON.stringify(profile)));
      assert.deepEqual(names(again), names(first), `${profile.id}: selection moved on run ${run + 1}`);
      assert.deepEqual(again.map((row) => row.priority), first.map((row) => row.priority), `${profile.id}: priority moved`);
      assert.deepEqual(again.map((row) => row.reason), first.map((row) => row.reason), `${profile.id}: the engine prose moved`);
    }
  }
});

test('answers that differ only in spacing, case or tick order are the same answers', () => {
  const base = { ...ADULT, symptoms: ['Migraine', 'Fatigue', 'Nausea'], healthGoals: ['Reduce Headaches', 'Boost Energy'] };
  const messy = {
    ...base,
    symptoms: ['  nausea  ', 'fatigue', 'MIGRAINE'],
    healthGoals: ['boost  energy', 'Reduce Headaches '],
    sleepQuality: ' poor ',
  };
  assert.equal(answerSignature(messy), answerSignature(base), 'the reuse digest split on formatting');
  assert.deepEqual(names(spineFor(messy)), names(spineFor(base)), 'the selection split on formatting');

  const realChange = { ...base, symptoms: [...base.symptoms, 'Hair loss'] };
  assert.notEqual(answerSignature(realChange), answerSignature(base), 'a new symptom did not change the digest');
});

test('the digest ignores identifiers and results, and changes with the rules version', () => {
  const a = answerSignature({ ...ADULT, _id: '6765', createdAt: '2026-01-01T00:00:00.000Z', aiResults: { recommendations: [1] } });
  const b = answerSignature({ ...ADULT, _id: '9999', createdAt: '2026-10-20T09:00:00.000Z' });
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.equal(a, b, 'an identifier or a stored result leaked into the answer digest');

  const withKnowledge = answerSignature(ADULT, { liveDynamic: [{ name: 'PCOS', supplements: ['Inositol'] }] });
  assert.notEqual(withKnowledge, answerSignature(ADULT, { liveDynamic: [] }), 'published conditions did not affect the digest');
  assert.equal(withKnowledge, answerSignature(ADULT, { liveDynamic: [{ name: 'PCOS', supplements: ['Inositol'] }] }));
  assert.ok(SELECTION_RULES_VERSION, 'the rules version is what invalidates old digests when the rules change');
});

test('different answers still produce different plans', () => {
  const seen = new Set();
  for (const profile of baselineProfiles) {
    const key = names(spineFor(profile)).join('|');
    assert.ok(!seen.has(key), `${profile.id} selected exactly the same plan as another profile`);
    seen.add(key);
  }
  const pregnant = { ...ADULT, pregnancyStatus: 'Pregnant', healthGoals: ['Healthy pregnancy'] };
  assert.notDeepEqual(names(spineFor(pregnant)), names(spineFor(ADULT)));
});

test('a plan is padded toward the presented length without ignoring what this member reported', () => {
  const spine = spineFor(ADULT);
  // Fifteen is what the app presents, not a quota: the preventive pool is
  // screened against this member's allergens, diet, age band, pregnancy and
  // conditions, and against the nutrient already in every clinical row, so a
  // plan stops when nothing safe and non-duplicating is left to add.
  assert.ok(spine.length >= 12 && spine.length <= 15, `expected a near-full plan, got ${spine.length} rows`);
  // The rows the clinical rules chose carry the member's own triggers; the
  // padding rows are explicitly labelled preventive, so nothing is claimed about
  // a symptom the member never mentioned.
  for (const row of spine.filter((item) => item.preventiveSupport)) {
    assert.equal(row.triggeredBy, NEUTRAL_TRIGGER, `${row.name} claims a trigger the member did not report`);
    assert.equal(row.priority, 'Low');
    assert.match(row.reason, /preventive nutritional support/);
  }
  for (const row of spine.filter((item) => !item.preventiveSupport)) {
    assert.equal(row.preventiveSupport, undefined);
  }
  const newKeys = spine.map((row) => selectionKey(row.name));
  assert.equal(new Set(newKeys).size, newKeys.length, 'the same supplement appears twice in one plan');
  const classes = spine.map((row) => classifySupplement(row.name)).filter(Boolean);
  assert.equal(new Set(classes).size, classes.length, 'one nutrient was dosed twice in the same plan');
});

test('two rule branches that reach the same nutrient leave one row, the urgent one', () => {
  const spine = buildPlanSpine([
    { name: 'Iron Bisglycinate', dosage: '18mg daily', priority: 'Low', interactions: 'None identified' },
    { name: 'Iron Bisglycinate + Vitamin C', dosage: '25mg + 500mg', priority: 'High', interactions: 'None identified' },
  ], canonicaliseAnswers(ADULT));
  const iron = spine.filter((row) => classifySupplement(row.name) === 'iron');
  assert.equal(iron.length, 1, 'a member was told to take iron twice');
  assert.equal(iron[0].name, 'Iron Bisglycinate + Vitamin C', 'the more urgent row was dropped for the less urgent one');
  assert.equal(spine.length <= 15, true, 'the plan overran the presented length');
  assert.ok(spine.length >= 12, `deduplicating a row should leave the pool room to refill, got ${spine.length}`);
});

test('a child, a pregnancy, a vegan diet and kidney stones each remove their own rows', () => {
  const adultOnly = ['CoQ10 (Ubiquinol)', 'Curcumin + Piperine', 'L-Theanine', 'Creatine Monohydrate', 'Collagen Peptides (Type I & III)'];
  const child = spineFor({ ...ADULT, age: 11 });
  for (const name of adultOnly) assert.ok(!names(child).includes(name), `${name} reached an 11-year-old`);

  const pregnant = spineFor({ ...ADULT, pregnancyStatus: 'Pregnant' });
  for (const name of ['Curcumin + Piperine', 'Creatine Monohydrate']) assert.ok(!names(pregnant).includes(name), `${name} reached a pregnancy`);

  const vegan = spineFor({ ...ADULT, dietType: 'Vegan' });
  for (const name of ['Collagen Peptides (Type I & III)', 'Omega-3 (EPA+DHA)']) assert.ok(!names(vegan).includes(name), `${name} is animal-derived and this member is vegan`);

  const stones = spineFor({ ...ADULT, medicalConditions: ['Kidney Stones'] });
  for (const name of ['Calcium Citrate', 'Creatine Monohydrate']) assert.ok(!names(stones).includes(name), `${name} is contraindicated for kidney stones`);

  // An allergic member never receives the allergen by name.
  const allergic = spineFor({ ...ADULT, allergies: 'Soy' });
  assert.ok(!names(allergic).some((name) => /soy/i.test(name)), 'a soy row reached a soy-allergic member');
});

test('a blood thinner turns the interaction note into a written caution, not a silent row', () => {
  const thin = spineFor({ ...ADULT, currentMedications: 'Warfarin' });
  const flagged = thin.filter((row) => /Vitamin K2|Omega-3|Curcumin/i.test(row.name));
  for (const row of flagged) {
    assert.match(row.interactions, /blood thinner|warfarin|thinning/i, `${row.name} sat in a warfarin plan with no interaction text`);
  }
  // The same rows for a member on no blood thinner must not carry it.
  const plain = spineFor({ ...ADULT, currentMedications: 'None' })
    .find((row) => /Vitamin K2/i.test(row.name));
  if (plain) assert.doesNotMatch(plain.interactions, /warfarin/i, 'a warfarin warning was printed for a member who names no warfarin');
});

test('nothing that this app rejects can enter the spine', () => {
  const spine = spineFor(ADULT);
  for (const row of spine) {
    assert.ok(row.name && row.name.trim().length > 2, 'a spine row has no usable name');
    assert.ok(row.dosage && row.dosage.length > 2, `${row.name} has no dosage for the report to print`);
    assert.ok(row.evidence, `${row.name} has no evidence field`);
    assert.ok(!/complex|matrix|activator|booster/i.test(row.name), `${row.name} reads like an invented product`);
    assert.ok(!/^\s*(metformin|atorvastatin|levothyroxine|warfarin|amoxicillin)\b/i.test(row.name), `${row.name} is a prescription medicine`);
  }
});

test('the model decides the prose, never the membership', () => {
  const spine = spineFor(ADULT);
  const modelRows = [
    // In the same order, but every name is capitalised differently and one row
    // is missing; two extra rows are invented products and a duplicate nutrient.
    ...spine.slice(1).map((row) => ({
      ...row,
      name: row.name.toUpperCase(),
      reason: `Model-written rationale for ${row.name}.`,
      evidence: row.evidence,
    })),
    { name: 'Adrenal Support Matrix', reason: 'Invented.', dosage: '2 capsules', evidence: 'Made up (2026).' },
    { name: 'Vitamin D3 (Cholecalciferol) Extra Strong', reason: 'Duplicate nutrient.', dosage: '5000 IU', evidence: 'Made up (2026).' },
  ];
  const modelPlan = { summary: 'Model summary', recommendations: modelRows };
  const { plan, audit } = alignPlanToSpine(modelPlan, spine);

  assert.deepEqual(names(plan.recommendations), names(spine), 'the model changed which supplements this member is shown');
  assert.equal(audit.mode, 'spine');
  assert.equal(audit.slots, spine.length);
  assert.ok(audit.dropped.length >= 1, 'off-spine rows were kept instead of dropped');
  // An off-spine row is not dropped only when its nutrient class is already in
  // the plan, in which case its text is adopted onto the spine row it belongs to.
  // Either way, what leaves the gate is the spine: no invented product name and
  // no member receiving two rows for one nutrient.
  assert.ok(!names(plan.recommendations).some((name) => /Adrenal Support Matrix/i.test(name)), 'an invented product survived the gate');
  for (const droppedName of audit.dropped) assert.ok(!names(spine).includes(String(droppedName)), 'a spine item was reported as dropped');
  const planClasses = plan.recommendations.map((row) => classifySupplement(row.name)).filter(Boolean);
  assert.equal(new Set(planClasses).size, planClasses.length, 'one nutrient class ended up dosed twice');

  // Selection and description are asserted separately, on purpose.
  const first = plan.recommendations[0];
  assert.equal(first.name, spine[0].name, 'the back-filled row did not adopt the spine name');
  assert.equal(first.selectionSource, 'spine-class', 'the row the model omitted was not marked as back-filled');
  assert.match(first.reason, /preventive|role|support|nutrient|clinica/i, 'a back-filled row lost its rationale text');

  const matched = plan.recommendations.find((row) => /Magnesium/i.test(row.name));
  const modelMatch = modelRows.find((row) => /MAGNESIUM/i.test(row.name));
  if (matched && modelMatch) {
    assert.equal(matched.reason, modelMatch.reason, 'the model\'s own description was replaced instead of kept');
    assert.ok(['model+spine', 'spine-class'].includes(matched.selectionSource));
  }

  // Every item in the plan keeps the priority the app assigned, not the model's.
  assert.deepEqual(plan.recommendations.map((row) => row.priority), spine.map((row) => row.priority));
});

test('an already-correct reply passes the gate untouched', () => {
  const spine = spineFor(ADULT);
  const modelPlan = { summary: 'ok', recommendations: spine.map((row) => ({ ...row, reason: `Model prose for ${row.name}` })) };
  const { plan, audit } = alignPlanToSpine(modelPlan, spine);
  assert.deepEqual(names(plan.recommendations), names(spine));
  assert.equal(audit.backfilled, 0);
  assert.equal(audit.dropped.length, 0);
  assert.deepEqual(plan.recommendations.map((row) => row.reason), modelPlan.recommendations.map((row) => row.reason));
});

test('a malformed or incomplete reply is reported, and the usable part is kept', () => {
  assert.equal(validateModelPlan(null).ok, false);
  assert.equal(validateModelPlan('not json').issues.length, 1);
  assert.match(validateModelPlan(undefined).issues.join(), /not a JSON object/);
  assert.match(validateModelPlan({ recommendations: 'Magnesium' }).issues.join(), /not a list/);
  assert.match(validateModelPlan({ recommendations: [] }).issues.join(), /recommendations was empty/);
  assert.match(validateModelPlan({ recommendations: [{ dosage: '1 cap' }, null, { reason: 'no name' }] }).issues.join(), /no row named a supplement/);

  // A row that only lacks a name is dropped, and the rest is still usable.
  const partial = validateModelPlan({
    summary: 'S',
    simplifiedSummary: 'P',
    wellnessBaseline: 12,
    consultDoctor: false,
    recommendations: [{ name: 'Magnesium Glycinate', reason: 'r' }, { dosage: '2 caps' }, null],
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.usable.length, 1, 'a nameless row was kept, or the whole reply was discarded');
  // The dropped rows are reported as an issue even though the reply is usable:
  // the audit is what tells the team that a model is losing rows.
  assert.equal(partial.issues.length, 1);
  assert.match(partial.issues[0], /2 row\(s\) without a usable supplement name/);

  // Missing required top-level fields are named, not guessed.
  const missing = validateModelPlan({ recommendations: [{ name: 'Zinc Picolinate' }] });
  for (const field of ['summary', 'simplifiedSummary', 'wellnessBaseline', 'consultDoctor']) {
    assert.ok(missing.issues.some((issue) => issue.includes(field)), `${field} was not reported as missing`);
  }
});

test('sampling parameters are only sent to providers that accept them', () => {
  const wanted = { seed: 12345, topP: 0.1 };
  assert.deepEqual(samplingFields('openrouter', wanted, 'openai'), { seed: 12345, top_p: 0.1 });
  assert.deepEqual(samplingFields('groq', wanted, 'openai'), { top_p: 0.1 }, 'groq has no seed parameter');
  assert.deepEqual(samplingFields('anthropic', wanted, 'anthropic'), { top_p: 0.1 }, 'anthropic has no seed parameter');
  assert.deepEqual(samplingFields('no-such-provider', wanted, 'openai'), { top_p: 0.1 });
  assert.deepEqual(samplingFields('openrouter', { seed: 12345, topP: 0 }, 'openai'), { seed: 12345 }, 'an out-of-range top_p was sent');
  assert.deepEqual(samplingFields('openrouter', { seed: null, topP: 0.1 }, 'openai'), { top_p: 0.1 }, 'a null seed was sent as 0');

  for (const route of Object.values(AI_ROUTES)) {
    for (const provider of route.chain || []) {
      const caps = SAMPLING_CAPABILITIES[provider];
      if (!caps) continue;
      assert.ok('seed' in caps && 'topP' in caps, `${provider} has an incomplete capability entry`);
    }
  }
});

test('the prompt hands the model a fixed item list when the app has decided it', () => {
  const spine = spineFor(ADULT);
  const constrained = buildAssessmentPrompt({ ...ADULT, _planSpine: spine });
  assert.match(constrained, /\[PLAN SPINE/);
  assert.match(constrained, /one recommendation per \[PLAN SPINE\] item/i);
  for (const row of spine.slice(0, 5)) assert.ok(constrained.includes(row.name), `${row.name} was not given to the model`);

  const unconstrained = buildAssessmentPrompt(ADULT);
  assert.doesNotMatch(unconstrained, /\[PLAN SPINE/, 'the spine block leaked into a run with no spine');
  assert.match(unconstrained, /Provide exactly 15 recommendations/, 'the free-choice instruction changed for no reason');
});
