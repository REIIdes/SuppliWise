/**
 * recommendationPlainLanguage — the plain half of a recommendation, for plans
 * produced by the rule engine instead of the model.
 *
 * Run: node --test "Test File/recommendation-plain-language.test.js"
 *
 * THE PROPERTY THAT MATTERS MOST
 *
 *   The plain-language text may only ever be built from what the PATIENT
 *   REPORTED. A "simplified" explanation that quietly invents a reason is worse
 *   than no simplified explanation at all, because it is trusted precisely
 *   because it is easier to read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  plainBenefitOf,
  plainDriverOf,
  simplifiedEvidenceFor,
  simplifiedReasonFor,
} = require('../utils/recommendationPlainLanguage');

/* ── The benefit lookup ─────────────────────────────────────────────────── */

test('a known supplement gets a plain-language benefit', () => {
  assert.equal(plainBenefitOf('Magnesium Glycinate'), 'sleep quality and muscle relaxation');
  assert.equal(plainBenefitOf('Vitamin D3'), 'immune function, bones and mood');
  assert.equal(plainBenefitOf('Omega-3 Fish Oil'), 'heart health, inflammation and brain function');
});

test('lookup is case-insensitive and matches on a substring', () => {
  const expected = plainBenefitOf('Magnesium Glycinate');
  assert.equal(plainBenefitOf('MAGNESIUM GLYCINATE'), expected);
  assert.equal(plainBenefitOf('magnesium'), expected);
  // The engine emits decorated names — forms, doses, qualifiers in brackets.
  assert.equal(plainBenefitOf('Creatine Monohydrate (micronized)'), 'strength, power and recovery');
  assert.equal(plainBenefitOf('Ashwagandha (KSM-66)'), 'stress levels and resilience');
});

test('the most specific keyword wins', () => {
  // A bare "vitamin" entry must not claim a record whose specific form is
  // B12 — that would describe the wrong nutrient entirely.
  assert.equal(plainBenefitOf('Vitamin B12 (Methylcobalamin)'), 'energy when your levels run low');
  assert.equal(plainBenefitOf('Vitamin D3 + K2'), 'immune function, bones and mood');
  assert.equal(plainBenefitOf('Omega-3 (high EPA)'), 'heart health, inflammation and brain function');
});

test('an unrecognised name yields nothing rather than a guess', () => {
  // A wrong benefit is worse than an absent one: the reader would be told a
  // supplement does something it does not.
  for (const name of ['', '   ', 'Unobtainium 9000', 'X', null, undefined, {}]) {
    assert.equal(plainBenefitOf(name), '', `plainBenefitOf(${JSON.stringify(name)})`);
  }
});

/* ── The driver ────────────────────────────────────────────────────────── */

test('the driver is the patient\'s own words, lowercased to read mid-sentence', () => {
  // The assessment stores its options in Title Case, and lowering only the
  // first letter produced "you reported poor Sleep" — which reads as a typo.
  assert.equal(plainDriverOf(['Poor Sleep'], [], [], 'Magnesium Glycinate'), 'poor sleep');
  assert.equal(plainDriverOf([], ['Muscle Gain'], [], 'Iron Bisglycinate'), 'muscle gain');
  assert.equal(plainDriverOf([], [], ['Heart Disease'], 'Berberine'), 'heart disease');
});

test('a symptom outranks a goal, which outranks a condition', () => {
  // Only one is used. A sentence listing all three stops being a sentence, and
  // the symptom is the strongest reason to start today.
  assert.equal(plainDriverOf(['Poor Sleep'], ['Muscle Gain'], ['Heart Disease'], 'Magnesium Glycinate'), 'poor sleep');
  assert.equal(plainDriverOf([], ['Muscle Gain'], ['Heart Disease'], 'Magnesium Glycinate'), 'muscle gain');
});

test('the driver relates to the supplement, so a plan is not one sentence repeated', () => {
  // This is the whole point of matching factors: fifteen cards that all end
  // "you reported poor sleep" reads as a bug, even when each one is true.
  const reported = ['Poor Sleep', 'Joint Pain', 'Frequent Colds', 'Fatigue'];
  assert.equal(plainDriverOf(reported, ['Muscle Gain'], [], 'Magnesium Glycinate'), 'poor sleep');
  assert.equal(plainDriverOf(reported, ['Muscle Gain'], [], 'Creatine Monohydrate'), 'muscle gain');
  assert.equal(plainDriverOf(reported, ['Muscle Gain'], [], 'Zinc Picolinate'), 'frequent colds');
  assert.equal(plainDriverOf(reported, ['Muscle Gain'], [], 'Collagen Peptides (Type II)'), 'joint pain');
  assert.equal(plainDriverOf(reported, ['Muscle Gain'], [], 'Iron Bisglycinate'), 'fatigue');
});

test('an unrelated first answer is still used when nothing matches', () => {
  // Falls back rather than dropping the "why you" half entirely.
  assert.equal(plainDriverOf(['Brain Fog'], [], [], 'Magnesium Glycinate'), 'brain fog');
  assert.equal(plainDriverOf(['Brain Fog'], [], [], 'Unobtainium 9000'), 'brain fog');
});

test('the driver is never a factor the patient did not report', () => {
  // The factors only SELECT among reported answers; they cannot introduce one.
  assert.equal(plainDriverOf([], ['Muscle Gain'], [], 'Magnesium Glycinate'), 'muscle gain');
  assert.match(
    simplifiedReasonFor({ name: 'Magnesium Glycinate', symptoms: ['Fatigue'], goals: [], conditions: [] }),
    /you reported fatigue\.$/,
  );
});

test('the placeholder answers are skipped', () => {
  // "No current symptoms" and "None" are the forms a patient picks to say
  // "nothing" — using one as the reason would read as a reason.
  assert.equal(plainDriverOf(['No current symptoms'], ['Muscle Gain'], [], 'Iron Bisglycinate'), 'muscle gain');
  assert.equal(plainDriverOf(['No current symptoms'], [], ['None'], 'Iron Bisglycinate'), '');
  assert.equal(plainDriverOf([], [], [], 'Iron Bisglycinate'), '');
});

test('junk in place of an answer never becomes the driver', () => {
  for (const bad of [null, undefined, '', '   ', 0, {}]) {
    assert.equal(plainDriverOf(bad, [], [], 'Iron Bisglycinate'), '', `driver from ${JSON.stringify(bad)}`);
    assert.equal(plainDriverOf([bad], [], [], 'Iron Bisglycinate'), '', `driver from [${JSON.stringify(bad)}]`);
  }
  assert.equal(plainDriverOf('a string', 'another string', 'a third', 'Iron Bisglycinate'), '');
});

/* ── The sentence ──────────────────────────────────────────────────────── */

test('the sentence says what it is for and why it is for this person', () => {
  const out = simplifiedReasonFor({
    name: 'Magnesium Glycinate',
    symptoms: ['Poor Sleep', 'Fatigue'],
    goals: ['Muscle Gain'],
  });
  assert.match(out, /^Helps support sleep quality and muscle relaxation/);
  assert.match(out, /you reported poor sleep\.$/);
  assert.equal(out.split('.').filter(Boolean).length, 1, 'one sentence');
});

test('with nothing reported it still says what the supplement is for', () => {
  assert.equal(
    simplifiedReasonFor({ name: 'Magnesium Glycinate', symptoms: [], goals: [], conditions: [] }),
    'Helps support sleep quality and muscle relaxation.',
  );
});

test('no invented reasons: the sentence never mentions an unreported factor', () => {
  // The load-bearing case. Nothing may be claimed about sleep, joints or
  // immunity unless the patient actually said so.
  const out = simplifiedReasonFor({
    name: 'Magnesium Glycinate',
    symptoms: ['Fatigue'],
    goals: [],
    conditions: [],
  });
  assert.match(out, /you reported fatigue\.$/);
  assert.ok(!/sleep/i.test(out.split('— you reported')[0].replace('sleep quality and muscle relaxation', '')),
    `the benefit clause should not claim sleep: ${out}`);
});

test('a benefit phrase never contains the clinical words it replaces', () => {
  // "Simplified" that keeps the mechanism is just the jargon with fewer
  // syllables, so the benefit phrases are checked for the vocabulary the
  // clinical reasons are full of.
  const BANNED = /\b(modulat|pathway|antioxidant defence|NMDA|GABA|recept|metabolis|homeostas|enzym)/i;
  for (const name of [
    'Magnesium Glycinate', 'Omega-3 Fish Oil', 'Vitamin D3', 'Zinc Picolinate',
    'Creatine Monohydrate', 'Probiotic (Multi-strain, 50B CFU)', 'Berberine',
    'CoQ10 (Ubiquinol)', 'Turmeric + Piperine', 'Electrolyte Complex',
  ]) {
    const out = simplifiedReasonFor({ name, symptoms: ['Fatigue'], goals: [] });
    assert.ok(out.length > 0, `no output for ${name}`);
    assert.ok(!BANNED.test(out), `${name} leaked clinical vocabulary: ${out}`);
  }
});

test('no outcome is promised outright', () => {
  // Possibility language, per the prompt's own rule. "Cures" or "will fix" on
  // a supplement card is a claim the product cannot support.
  const BANNED = /\b(cures?|will fix|guarantee[sd]?|reverses?|eliminates?|prevents?)\b/i;
  for (const name of ['Magnesium Glycinate', 'Vitamin D3', 'Fish Oil', 'Zinc Picolinate']) {
    const out = simplifiedReasonFor({ name, symptoms: ['Poor Sleep'], goals: [], conditions: [] });
    assert.ok(!BANNED.test(out), `${name} promises an outcome: ${out}`);
  }
});

test('an unrecognised or malformed record yields an empty string, never a crash', () => {
  for (const rec of [null, undefined, 'a string', 42, {}, { name: '' }, { name: null }]) {
    assert.equal(simplifiedReasonFor(rec), '', `simplifiedReasonFor(${JSON.stringify(rec)})`);
  }
});

/* ── The evidence line ─────────────────────────────────────────────────── */

test('the evidence line is short, honest, and says the claim is researched', () => {
  const out = simplifiedEvidenceFor('Magnesium Glycinate');
  assert.ok(out.length > 0);
  assert.ok(out.split(' ').length <= 12, `too long to be a stand-in: ${out}`);
  assert.match(out, /research supports/i);
  // It must never present itself as the citation.
  assert.ok(!/pmid|doi|https?:/i.test(out), `looks like a real citation: ${out}`);
  assert.ok(!/\(\d{4}\)/.test(out), `looks like a dated study: ${out}`);
});

test('the evidence line is long enough to pass the client\'s template filter', () => {
  // The client refuses anything under 15 characters as a citation template, so
  // a shorter line would be discarded and the block would silently vanish.
  for (const name of ['Magnesium Glycinate', 'Vitamin D3', 'Berberine', 'Biotin (Vitamin B7)']) {
    assert.ok(simplifiedEvidenceFor(name).length >= 15, `${name} would be filtered out`);
  }
});

test('an unrecognised supplement gets no evidence line rather than a generic one', () => {
  // "Research supports this." attached to an unknown compound is a claim about
  // something nobody has checked.
  for (const name of ['', '   ', 'Unobtainium 9000', null, undefined]) {
    assert.equal(simplifiedEvidenceFor(name), '');
  }
});

/* ── The contract both engines now share ───────────────────────────────── */

test('every supplement the rule engine can emit has a plain-language half', () => {
  // The names below are taken from the engine's own recs.push calls. A gap here
  // is exactly the bug this module was written to close: a plan the AI never
  // touched, showing a Simplified view identical to its Detailed one.
  const ENGINE_NAMES = [
    'Algae-based DHA (prenatal)', 'Algae-based Omega-3 (DHA+EPA)', 'Alpha-Lipoic Acid (ALA)',
    'Ashwagandha (KSM-66)', 'Berberine', 'Beta-Alanine', 'Biotin (Vitamin B7)',
    'Calcium Citrate', 'Calcium Citrate + Vitamin D3 + K2', 'Collagen Peptides (Type I & III)',
    'Collagen Peptides (Type I)', 'Collagen Peptides (Type II)', 'CoQ10', 'CoQ10 (Ubiquinol)',
    'Creatine Monohydrate', 'Curcumin + Piperine', 'Curcumin + Piperine (or Liposomal)',
    'Digestive Enzymes (broad-spectrum)',
    'Electrolyte Complex (Sodium, Potassium, Magnesium)', 'Folate (Methylfolate)',
    'Glucosamine Sulfate + Chondroitin', 'High-Calorie Protein Supplement (Whey or Plant)',
    'Inositol (Myo-Inositol + D-Chiro-Inositol 40:1)', 'Iron (as Iron Bisglycinate)',
    'Iron Bisglycinate', 'Iron Bisglycinate (gluten-free)', 'Iron Bisglycinate + Vitamin C',
    'L-Theanine', 'Magnesium Glycinate', 'Melatonin (low dose)',
    'Multivitamin (certified gluten-free)', 'N-Acetyl Cysteine (NAC)', 'Omega-3 (EPA+DHA)',
    'Omega-3 (EPA+DHA, pharmaceutical grade)', 'Omega-3 (Fish Oil or Algae)', 'Omega-3 (Fish Oil)',
    'Omega-3 (Fish Oil, high DHA)', 'Omega-3 (high EPA)',
    'Prenatal Multivitamin with Methylfolate', 'Probiotic (Multi-strain, 50B CFU)',
    'Protein Supplement (Whey or Plant-based)', 'Resveratrol', 'Riboflavin (Vitamin B2)',
    'Selenium (Selenomethionine)', 'Tart Cherry Extract',
    'Vitamin B Complex (T1, B6, B12, Folate)', 'Vitamin B12 (Methylcobalamin)',
    'Vitamin C (as Ascorbic Acid)', 'Vitamin C (moderate dose)', 'Vitamin D3',
    'Vitamin D3 + K2', 'Vitamin D3 + K2 (vegan certified)', 'Whey Protein (or Plant Protein)',
    'Zinc (pediatric)', 'Zinc Picolinate',
  ];

  const missingReason = ENGINE_NAMES.filter((name) => !simplifiedReasonFor({ name, symptoms: ['Fatigue'] }));
  const missingEvidence = ENGINE_NAMES.filter((name) => !simplifiedEvidenceFor(name));

  assert.deepEqual(missingReason, [], 'these would render Simplified as a copy of Detailed');
  assert.deepEqual(missingEvidence, [], 'these would show no research note in Simplified');
});
