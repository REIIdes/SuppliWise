const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCorpus, fieldStudyDocs } = require('../utils/ragCorpus');
const { retrieve, referencesBlock } = require('../utils/ragRetriever');
const {
  verifyProse,
  buildConversationContext,
  groundPlan,
  groundingViolations,
  enforceMedicationSafety,
} = require('../utils/planGrounding');
const { enforcePlanConsistency } = require('../utils/planConsistency');
const { generateClinicalFallback } = require('../routes/recommend');

const fieldProfiles = require('../eval/field-study-profiles.json');

/**
 * The project's own field research is now an input to the AI surfaces. That is only safe if
 * its shape is checked, because the failure mode of adding real-world data to a health
 * assistant is not an error — it is a confident sentence the app never earned. These tests
 * pin the three things that keep it honest: the notes carry no evidence and no doses, the
 * brand note refuses on the model's behalf, and the one vocabulary change the interview
 * bought (a prescription name the guards could not previously see) actually works.
 */

const docsById = new Map(buildCorpus().map((d) => [d.id, d]));

test('the field notes are in the corpus and are the only field documents', () => {
  assert.equal(fieldStudyDocs().length, 3);
  for (const doc of fieldStudyDocs()) assert.ok(docsById.has(doc.id), `${doc.id} never reached buildCorpus()`);
  assert.equal(
    buildCorpus().filter((d) => d.kind === 'field').length,
    fieldStudyDocs().length,
  );
});

test('a field note carries no citation and no nutrient, so it cannot license either', () => {
  for (const doc of fieldStudyDocs()) {
    assert.deepEqual(doc.pmids, [], `${doc.id} would let the verifier allowlist a PMID`);
    assert.deepEqual(doc.nutrients, [], `${doc.id} would name a supplement the app has evidence for`);
  }
});

test('a field note never states a dose, a percentage or an amount', () => {
  // The corpus is read out to members. A number in here is a number the model may repeat,
  // and the interview recorded brands and ages, not clinical quantities.
  for (const doc of fieldStudyDocs()) {
    assert.doesNotMatch(doc.text, /\d+\s?(?:mg|mcg|g|IU|%)\b/i, doc.id);
  }
});

test('every field note names where it came from and what it is not', () => {
  for (const doc of fieldStudyDocs()) {
    assert.match(doc.text, /interview/i, `${doc.id} has no provenance line`);
    assert.match(
      doc.text,
      /not a clinical claim|cannot verify|no .{0,40}entry|not a statement about any individual/i,
      `${doc.id} states an observation without saying what it does not mean`,
    );
  }
});

test('a brand question retrieves the refusal, not a guess about the brand', () => {
  const picked = retrieve('is Santonn Plus good for my eyes');
  assert.equal(picked.docs[0].id, 'field:supplement-brands');
  assert.match(referencesBlock(picked), /cannot verify that brand/i);
});

test('the brand note refuses to describe a brand it has no evidence for', () => {
  const doc = docsById.get('field:supplement-brands');
  // Composition must not be asserted. The interview named products, not ingredients.
  assert.doesNotMatch(doc.text, /contains|is made of|provides \d/i);
  assert.match(doc.text, /A brand name is not an ingredient\./);
});

test('a local purchasing question retrieves the medication note first', () => {
  const picked = retrieve('what blood pressure medicines do people around here take');
  assert.ok(picked.docs.some((d) => d.id === 'field:maintenance-medications'),
    `retrieved: ${picked.docs.map((d) => d.id).join(' | ')}`);
});

// ---------------------------------------------------------------------------
// The vocabulary the interview bought: a named prescription the guards could not see
// ---------------------------------------------------------------------------

const ON_TELMISARTAN = fieldProfiles.find((p) => p.id === 'pharmacy-hypertensive-58f');
const NO_MEDS = require('../eval/baseline-profiles.json').find((p) => p.id === 'vegan-migraine');

const ship = (text, profile) => verifyProse(text, { ctx: buildConversationContext(profile, '') }).value;

test('a prescription the member never reported is not assumed about them', () => {
  const out = ship('Your telmisartan is why we add potassium.', NO_MEDS);
  assert.ok(!/telmisartan/i.test(out), out);
  assert.match(out, /only speak to what you have told me/i);
});

test('a general interaction sentence naming the same drug is left alone', () => {
  // The guard catches a claim ABOUT the member, not the word. Over-firing here would
  // delete correct interaction advice, which is a worse failure than the one above.
  const text = 'Magnesium can be taken alongside telmisartan without any issue.';
  assert.equal(ship(text, NO_MEDS), text);
});

test('a prescription the member DID report survives untouched', () => {
  const text = 'Keep taking your telmisartan as prescribed and raise any changes with your clinician.';
  const out = ship(text, ON_TELMISARTAN);
  assert.match(out, /telmisartan/i);
  assert.equal(out, text, 'a true statement about a reported medication must not be edited');
});

test('the app will not tell a member to stop or swap a telmisartan', () => {
  const text = 'Stop your telmisartan and take hibiscus instead.';
  const once = enforceMedicationSafety(text);
  assert.notEqual(once.value, text, 'a named prescription must be recognised by the safety guard');
  assert.equal(once.value, enforceMedicationSafety(once.value).value, 'the repair must be stable');
});

// ---------------------------------------------------------------------------
// The profiles the interview shaped
// ---------------------------------------------------------------------------

test('field profiles are labelled, unique, and not passed off as baseline cases', () => {
  const ids = fieldProfiles.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of fieldProfiles) {
    assert.ok(String(p.source || '').length > 40, `${p.id} has no provenance note`);
    assert.match(String(p.source), /interview|pharmacy/i, `${p.id} does not say where it came from`);
  }
});

test('the engine answers a field-shaped member without inventing anything', () => {
  for (const profile of fieldProfiles) {
    const plan = groundPlan(enforcePlanConsistency(generateClinicalFallback(profile)), profile);
    assert.deepEqual(
      groundingViolations(plan, profile).map((v) => `${v.kind}/${v.name}`),
      [],
      `${profile.id} shipped an unverifiable row`,
    );
    assert.ok(plan.recommendations.length > 0, `${profile.id} produced no plan at all`);
    for (const rec of plan.recommendations) {
      assert.doesNotMatch(
        String(rec.name),
        /santon|eyeberry|liveraid|barley/i,
        `${profile.id}: ${rec.name} is a brand the app has no evidence entry for`,
      );
    }
  }
});

test('a benefit claim about a brand the app cannot look up does not ship, hedged or not', () => {
  const profile = fieldProfiles.find((p) => p.id === 'pharmacy-hypertensive-67m');
  for (const text of [
    'Santonn Plus is clinically proven to improve your vision.',
    'Santonn Plus is reported to improve your vision.',
    'Eyeberry supports eye health in most people.',
    'Liveraid helps detox the liver.',
  ]) {
    const out = ship(text, profile);
    assert.doesNotMatch(out, /santonn|eyeberry|liveraid/i, text);
    assert.doesNotMatch(out, /improve|supports?|detox|clinically/i, text);
    assert.match(out, /no evidence entry for that product/i, text);
  }
});

test('the brand guard is not a diet guard, and not a name-mention guard', () => {
  const profile = fieldProfiles.find((p) => p.id === 'pharmacy-hypertensive-58f');
  // Barley is an ordinary food the interview also named. Over-firing here would delete
  // true sentences about what a member eats, which is a worse bug than the one fixed above.
  const diet = 'Barley water is part of your breakfast, which is a reasonable habit.';
  assert.equal(ship(diet, profile), diet);
  // A sentence that merely names the product without claiming a benefit is the member's
  // own words, and the app has no business rewriting them.
  const mention = 'You mentioned Eyeberry, and the label is what we would need to read.';
  assert.equal(ship(mention, profile), mention);
});

test('a repaired brand claim stays repaired on a second pass', () => {
  const profile = fieldProfiles.find((p) => p.id === 'pharmacy-hypertensive-67m');
  const first = verifyProse('Eyeberry improves vision.', { ctx: buildConversationContext(profile, '') });
  const second = verifyProse(first.value, { ctx: buildConversationContext(profile, '') });
  assert.equal(second.value, first.value);
  assert.deepEqual(second.repairs, []);
});
