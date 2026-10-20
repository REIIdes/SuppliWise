/**
 * Prose grounding — the verifier that runs over free text before a member reads
 * it (chat replies, supplement guides, and the prose fields of a plan).
 *
 * Run: node --test "Test File/prose-grounding.test.js"
 *
 * Same contract as plan grounding, in both directions: a hallucination is
 * removed, and a true sentence is never removed. The second half is what these
 * tests protect hardest, because prose has no schema to fall back on — the only
 * way to be safe in a paragraph is to edit the paragraph, and an over-eager edit
 * silently turns good advice into boilerplate.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const {
  MED_SAFETY_LINE,
  UNSOURCED_STAT_LINE,
  buildFactContext,
  buildConversationContext,
  verifyProse,
  verifyDocumentDeep,
  stripUnverifiableIdentifiers,
  enforceMedicationSafety,
  downgradeAbsoluteClaims,
  stripUnsourcedStatistics,
  clampDosesInProse,
  groundPlan,
  groundingViolations,
  tidyProse,
} = require('../utils/planGrounding');
const { registeredEvidence, allowlistedPmids } = require('../utils/supplementEvidenceRegistry');
const { generateClinicalFallback } = require('../routes/recommend');
const baselineProfiles = require('../eval/baseline-profiles.json');

const ON_STATIN = baselineProfiles.find((p) => p.id === 'senior-statin');
const NO_MEDS = baselineProfiles.find((p) => p.id === 'vegan-migraine');

const ctxFor = (profile, words = '') => buildConversationContext(profile, words);

/** Verify as chat does, and return just the text the member would see. */
const ship = (text, profile = NO_MEDS, words = '') => verifyProse(text, { ctx: ctxFor(profile, words) }).value;

const kindsOf = (result) => result.repairs.map((r) => r.kind);

// ---------------------------------------------------------------------------
// Identifiers the app cannot look up
// ---------------------------------------------------------------------------

test('a trial registration number is stripped like any other unverifiable id', () => {
  const out = ship('The protocol is registered as NCT04000000 with ClinicalTrials.gov.');
  assert.ok(!/NCT\d{6,}/i.test(out), out);
  assert.ok(!/clinicaltrials\.gov/i.test(out), out);
});

test('a bare PubMed host with no scheme is still stripped', () => {
  const out = ship('See pubmed.ncbi.nlm.nih.gov/99999999/ for the details.');
  assert.ok(!/99999999/.test(out), out);
  assert.ok(!/pubmed/i.test(out), out);
});

test('a registry link the app does stand behind is left completely whole', () => {
  const [pmid] = [...allowlistedPmids()];
  assert.ok(pmid, 'the registry must contain at least one allowlisted PMID');
  const text = `The full record is at https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  const { value, removed } = stripUnverifiableIdentifiers(text, { ctx: ctxFor(NO_MEDS) });
  assert.deepEqual(removed, [], 'an allowlisted citation is not a violation');
  assert.equal(value, text, 'not even the host may be cut out of a kept link');
});

test('removing an identifier does not leave "read more at and ." behind', () => {
  const out = ship('Read more at https://example.com/study and NCT04000000.');
  assert.ok(!/and\s*\./.test(out), out);
  assert.ok(!/\bat\s*\./.test(out), out);
});

// ---------------------------------------------------------------------------
// Treatment advice — the failure that can physically harm someone
// ---------------------------------------------------------------------------

test('advice naming a member\'s own drug is replaced by the safety line', () => {
  const out = ship('You should stop your atorvastatin and take red yeast rice instead.', ON_STATIN, 'can I stop my statin');
  assert.equal(out, MED_SAFETY_LINE);
});

test('a supplement offered as an equal to a prescription is the same failure', () => {
  const out = ship('Hibiscus works as well as your lisinopril, so you can skip doses on exercise days.', ON_STATIN);
  assert.equal(out, MED_SAFETY_LINE);
});

test('telling a member to lower a prescription dose is refused', () => {
  const out = ship('Once you start berberine you can reduce your metformin to half.', ON_STATIN);
  assert.equal(out, MED_SAFETY_LINE);
});

test('the app\'s own warning away from a treatment change is never edited', () => {
  for (const text of [
    'This does not replace your blood pressure medication.',
    'Supplements are not an alternative to your statin, and no supplement should make you stop it.',
  ]) {
    const result = enforceMedicationSafety(text);
    assert.equal(result.value, text, `"${text}" is the safest sentence a reply can contain`);
    assert.deepEqual(result.repairs, []);
  }
});

test('interaction advice that names a medication survives', () => {
  const text = 'Magnesium may interact with your thyroid medication, so separate the doses by four hours.';
  assert.equal(enforceMedicationSafety(text).value, text);
});

test('the safety line does not re-trigger its own verifier', () => {
  const once = enforceMedicationSafety('Stop your statin.');
  const twice = enforceMedicationSafety(once.value);
  assert.equal(twice.value, once.value);
  assert.deepEqual(twice.repairs, []);
});

// A live Red Yeast Rice guide asked the model about stopping a statin and got
// back four separate sentences of treatment-change advice. Replacing each with
// the warning printed the same paragraph four times, which reads as a broken
// template — so the document says it once and the later copies go quiet without
// leaving a hole where the advice was.
test('three violations in one document get one warning, not three copies', () => {
  const text = 'You should stop your atorvastatin and take red yeast rice instead.\n\n'
    + 'Also lower the lisinopril dose if you feel fine.\n\n'
    + 'Curcumin may support sleep.\n\n'
    + 'And quit your metformin if your sugar drops.';
  const once = enforceMedicationSafety(text);
  assert.equal(once.repairs.length, 3, 'every unsafe sentence is still counted');
  assert.equal(once.value.split(MED_SAFETY_LINE).length - 1, 1);
  assert.ok(once.value.includes('Curcumin may support sleep.'), 'true prose is untouched');
  assert.ok(!/\n{3,}/.test(once.value), 'no blank hole left where a paragraph was');
  assert.ok(!/\s$/.test(once.value), 'no trailing whitespace');
  const twice = enforceMedicationSafety(once.value);
  assert.equal(twice.value, once.value);
  assert.deepEqual(twice.repairs, []);
});

// ---------------------------------------------------------------------------
// Curative and absolute claims
// ---------------------------------------------------------------------------

test('a cure claim keeps its subject and loses its certainty', () => {
  const out = ship('Curcumin cures cancer completely.');
  assert.ok(!/cure/i.test(out), out);
  assert.match(out, /cancer/);
});

test('two rules firing on one sentence do not leave broken grammar', () => {
  const out = ship('Ashwagandha is clinically proven to eliminate anxiety.', NO_MEDS, 'ashwagandha for stress');
  assert.ok(!/proven/i.test(out), out);
  assert.ok(!/eliminat/i.test(out), out);
  assert.ok(!/to may/i.test(out), `"${out}" would read as a botched edit`);
});

test('"no side effects whatsoever" is hedged, and the hedge survives a second pass', () => {
  const once = downgradeAbsoluteClaims('It has no side effects whatsoever.');
  assert.ok(once.repairs.length > 0);
  assert.ok(!/no side effects/i.test(once.value), once.value);
  assert.ok(!/whatsoever/i.test(once.value), once.value);
  assert.deepEqual(downgradeAbsoluteClaims(once.value).repairs, [], 'not idempotent');
});

test('the product disclaimer is left exactly as written', () => {
  const text = 'SuppliWise does not diagnose, treat, cure, or prevent any disease.';
  const result = downgradeAbsoluteClaims(text);
  assert.equal(result.value, text);
  assert.deepEqual(result.repairs, []);
});

// ---------------------------------------------------------------------------
// Statistics nobody supplied
// ---------------------------------------------------------------------------

test('an effect size in minutes loses the number', () => {
  const out = ship('In one trial, melatonin cut sleep onset latency by 62 minutes.', NO_MEDS, 'melatonin for insomnia');
  assert.ok(!/62/.test(out), out);
});

test('a citation the app ships keeps its sentence; a figure the model invented does not', () => {
  const [pmid] = [...allowlistedPmids()];
  const cited = `In one trial (PMID: ${pmid}), magnesium reduced attack frequency by 50%.`;
  const kept = stripUnsourcedStatistics(cited, { allowedPmids: new Set([String(pmid)]) });
  assert.ok(!kept.value.startsWith(UNSOURCED_STAT_LINE), kept.value);
  assert.match(kept.value, new RegExp(String(pmid)), 'the citation itself is the app\'s own, so it stays');
  assert.ok(!/50%/.test(kept.value), kept.value);
  // The number is the model's, not the registry's: a real PMID attached to a
  // sentence the model wrote does not make its effect size checkable.
  assert.match(stripUnsourcedStatistics('Magnesium reduced attack frequency.').value, /reduced attack frequency/);
  // An effect size loses only its figure — the direction is still true and the
  // member needs it. A whole population claim has nothing left to say without its
  // number, so that one becomes the honest sentence instead.
  assert.equal(stripUnsourcedStatistics('Magnesium reduced attack frequency by 50%.').value, 'Magnesium reduced attack frequency.');
  assert.equal(stripUnsourcedStatistics('50% of adults are deficient.').value, UNSOURCED_STAT_LINE);
});

test('a whole sentence of invented figures becomes one honest sentence, not a fragment', () => {
  const out = ship('Over 70% of adults are deficient, and 42% of women report low iron intake.', NO_MEDS);
  assert.ok(!/70%|42%/.test(out), out);
  assert.equal(out, UNSOURCED_STAT_LINE);
});

test('a dose ceiling quoted as a threshold is not statistics', () => {
  const text = 'Intakes above 40 mg of zinc taken long term may deplete copper.';
  assert.equal(ship(text, NO_MEDS), text);
});

// ---------------------------------------------------------------------------
// Doses stated in prose
// ---------------------------------------------------------------------------

test('a prose dose past the ceiling is replaced with the standard range', () => {
  const out = ship('Take 4000 mg of magnesium oxide every morning.');
  assert.ok(!/4000/.test(out), out);
  assert.match(out, /300-400mg/, out);
});

test('each amount belongs to the nutrient next to it', () => {
  const text = 'Calcium (1300mg/day) supports bone density, and iron helps carry oxygen.';
  assert.equal(clampDosesInProse(text).value, text, 'the iron ceiling must not clamp a calcium figure');
});

test('gram-scale food bulks are not supplement doses', () => {
  const text = 'Aim for 90 g of protein a day to support your muscle gain goal.';
  assert.equal(clampDosesInProse(text).value, text);
});

// ---------------------------------------------------------------------------
// Facts about the member
// ---------------------------------------------------------------------------

test('a lab value the member never reported is not quoted back at them', () => {
  const out = ship('Your ferritin of 12 is what explains the fatigue.', NO_MEDS, 'why am I tired');
  assert.ok(!/ferritin/i.test(out), out);
});

test('a lab value the member DID supply is theirs to hear', () => {
  const profile = { ...NO_MEDS, bloodTestResults: 'Ferritin 12 ng/mL (low)' };
  const text = 'Your ferritin of 12 is what explains the fatigue.';
  assert.equal(ship(text, profile), text);
});

test('a medication the member never named is not attributed to them', () => {
  const out = ship('Because you take warfarin, vitamin K needs careful dosing.', NO_MEDS, 'can i take vitamin k');
  assert.ok(!/warfarin/i.test(out), out);
});

test('a medication they did list is licensed like any other report', () => {
  const text = 'Because you take warfarin, vitamin K needs careful dosing.';
  assert.equal(ship(text, ON_STATIN, 'i take warfarin'), text);
});

test('a condition claimed possessively is checked, and kept when true', () => {
  const invented = ship('Your rheumatoid arthritis is why this plan chose omega-3.', NO_MEDS, 'joint pain');
  assert.ok(!/rheumatoid/i.test(invented), invented);

  const withPcos = { ...NO_MEDS, medicalConditions: ['PCOS'] };
  const text = 'Your PCOS is why this plan chose inositol.';
  assert.equal(ship(text, withPcos), text);
});

test('ordinary prose about sleep, energy and digestion is not a patient fact', () => {
  for (const text of [
    'Take it at night for your sleep.',
    'This supports your energy through the afternoon.',
    'Ginger is often used for your digestion after meals.',
  ]) {
    assert.equal(ship(text, NO_MEDS), text);
  }
});

test('a member who never reported anything still cannot be told invented facts', () => {
  const blank = buildConversationContext({}, 'is ashwagandha safe for me');
  const out = verifyProse('Since you mentioned your epilepsy, this is risky for you.', { ctx: blank }).value;
  assert.ok(!/epilepsy/i.test(out), out);
});

// ---------------------------------------------------------------------------
// The pass as a whole
// ---------------------------------------------------------------------------

test('a deleted clause does not fuse the sentences around it', () => {
  // Found by fuzzing for idempotence. The clause deletion used to drop the
  // separator with the clause, so this became "Take 4000 mg daily Turmeric is a
  // spice." — one instruction about turmeric — and a SECOND pass clamped a dose
  // that had never been a turmeric dose.
  const text = '- Take 4000 mg daily - since you live with Crohn disease. Turmeric is a spice.';
  const first = verifyProse(text, { ctx: ctxFor(NO_MEDS, 'turmeric and my joint pain') });
  assert.ok(!/crohn/i.test(first.value), first.value);
  assert.match(first.value, /4000 mg daily\.\s*Turmeric/, 'the sentence boundary must survive the deletion');
  const second = verifyProse(first.value, { ctx: ctxFor(NO_MEDS, 'turmeric and my joint pain') });
  assert.deepEqual(second.repairs, [], `second pass rewrote it again: ${second.value}`);
  assert.equal(second.value, first.value);
});

test('verifyProse reports each category it repaired and stays idempotent', () => {
  const bad = 'Turmeric cures inflammation. Take 5000 mg daily (PMID: 99999999). Stop your statin, since you mentioned your arthritis.';
  const first = verifyProse(bad, { ctx: ctxFor(ON_STATIN, 'turmeric') });
  for (const kind of ['identifier', 'medication-safety', 'claim-downgraded']) {
    assert.ok(kindsOf(first).includes(kind), `${kind} missing from ${JSON.stringify(kindsOf(first))}`);
  }
  const second = verifyProse(first.value, { ctx: ctxFor(ON_STATIN, 'turmeric') });
  assert.deepEqual(second.repairs, [], 'a second pass must find nothing left to fix');
  assert.equal(second.value, first.value);
});

test('a vendor\'s typography cannot decide whether a true denial survives', () => {
  // Live incident, 2026-10-20: the chat accuracy gate failed `refuse-reminders`
  // because Groq's model answers with U+2019. Every negation guard in this file is
  // `can'?t` / `doesn'?t`, so `doesn’t include reminders … can’t send one` matched
  // NONE of them, read as an un-negated capability claim, and the verifier rewrote
  // a correct answer into boilerplate the member then read.
  const denial = 'The SuppliWise app doesn\u2019t include reminder notifications, so it can\u2019t send you a reminder at 8 a.m.';
  const out = verifyProse(denial, { ctx: ctxFor(NO_MEDS, 'remind me at 8am') });
  assert.deepEqual(out.repairs, [], `a correct denial must not be edited: ${JSON.stringify(out.repairs)}`);
  assert.equal(
    out.value,
    "The SuppliWise app doesn't include reminder notifications, so it can't send you a reminder at 8 a.m.",
  );
  assert.equal(
    ship('Magnesium can\u2019t cure your migraine, but it may help.', NO_MEDS, 'magnesium for migraine'),
    "Magnesium can't cure your migraine, but it may help.",
  );

  // And the normalisation must not weaken a guard: the same claim in curly quotes
  // is still the same claim, so it is still downgraded.
  const curly = 'Turmeric \u201Ccures\u201D inflammation.';
  assert.notEqual(ship(curly), curly, 'a smart-quoted curative verb must still be caught');
  assert.match(ship(curly), /may|can help|support/i, ship(curly));
});

test('a denial of a guarantee is a hedge the verifier leaves alone', () => {
  // Live gate, 2026-10-20: Groq answered a citation question with "The evidence
  // isn't a guarantee, but many people find…". The rewrite table turned the noun
  // into its plural replacement and shipped "isn't a promises" to the member. A
  // denied guarantee already asserts less than the model did, so there is nothing
  // for the pass to protect against — and no grammatical replacement exists.
  for (const sentence of [
    "The evidence isn't a guarantee, but many people find magnesium helps.",
    "This doesn't guarantee anything, and that is the honest position.",
    'There is no guarantee that it works for you specifically.',
    'They are not promises, only early signals.',
  ]) {
    assert.equal(ship(sentence, NO_MEDS, 'magnesium evidence'), sentence, sentence);
  }

  // The assertion half still downgrades, and now agrees in number with the
  // article it sits next to.
  assert.equal(ship('It guarantees better sleep.'), 'It promises better sleep.');
  assert.equal(ship('This supplement is a guarantee of results.'), 'This supplement is a promise of results.');
  assert.match(ship('Ashwagandha is guaranteed to lower cortisol.'), /likely to lower cortisol/);
});

test('verifyDocumentDeep reaches nested guide fields and skips the owned ones', () => {
  const guide = {
    name: 'Magnesium Glycinate',
    dosage: '400mg daily',
    evidence: registeredEvidence('Magnesium Glycinate'),
    keyBenefits: [{ title: 'Sleep', description: 'It has no side effects whatsoever and cures insomnia.' }],
    disclaimer: 'SuppliWise does not diagnose, treat, cure, or prevent any disease.',
  };
  const out = verifyDocumentDeep(guide, { ctx: ctxFor(NO_MEDS) });
  assert.match(out.value.keyBenefits[0].description, /may|tolerat/i);
  assert.ok(!/no side effects/i.test(out.value.keyBenefits[0].description));
  assert.equal(out.value.dosage, guide.dosage, 'dosage belongs to checkDose, not the prose pass');
  assert.equal(out.value.evidence, guide.evidence, 'evidence belongs to verifyCitation');
  assert.equal(out.value.disclaimer, guide.disclaimer, 'the app never rewrites its own disclaimer');
  assert.equal(out.value.name, guide.name);
});

test('tidyProse closes the gaps a clause deletion leaves without flattening lines', () => {
  assert.equal(tidyProse('Take it  ,  with food .'), 'Take it, with food.');
  assert.equal(tidyProse('First line.\nSecond line.'), 'First line.\nSecond line.');
});

test('groundPlan records its prose repairs and ships a plan with zero violations', () => {
  const plan = {
    summary: 'A 34-year-old with severe migraines.',
    recommendations: [{
      name: 'Magnesium Glycinate',
      dosage: '400mg daily',
      evidence: registeredEvidence('Magnesium Glycinate'),
      reason: 'Because you take warfarin and your ferritin is low, this may help your severe migraines.',
      triggeredBy: 'Migraine (Severe)',
      timing: 'Evening',
    }],
    warnings: ['Your rheumatoid arthritis makes this risky.'],
  };
  const grounded = groundPlan(plan, NO_MEDS);
  const proseActions = (grounded.grounding.actions || []).filter((a) => String(a.kind).startsWith('prose-'));
  assert.ok(proseActions.length > 0, 'the fabricated attributions must be recorded');
  assert.deepEqual(groundingViolations(grounded, NO_MEDS), []);
  assert.ok(!/warfarin|ferritin/i.test(JSON.stringify(grounded)), JSON.stringify(grounded));
  assert.ok(Array.isArray(grounded.warnings), 'a warnings list emptied by the check stays a list');
});

test('the shipped rule-engine baselines need no prose repair at all', () => {
  for (const profile of baselineProfiles) {
    const plan = generateClinicalFallback(profile);
    const found = verifyDocumentDeep(plan, { ctx: buildFactContext(profile), fallback: '' });
    assert.deepEqual(found.repairs.map((r) => `${r.field}:${r.kind}`), [], `${profile.id}: ${JSON.stringify(found.repairs)}`);
  }
});

test('the adversarial audit gate passes', () => {
  // The audit is the contract this file re-tests piece by piece: every canned
  // hallucination repaired, every true sentence untouched, verifier idempotent.
  // Running it here means a rule change that breaks one of those cannot reach CI
  // unnoticed just because nobody ran the script.
  const script = path.join(__dirname, '..', 'eval', 'hallucinationAudit.js');
  const out = execFileSync(process.execPath, [script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.match(out, /HALLUCINATION AUDIT PASSED/);
});
