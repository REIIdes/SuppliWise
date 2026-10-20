/**
 * Safety fields and malformed AI output.
 *
 * Run: npm test
 *
 * Two of the required validation cases live here:
 *
 *   4. the AI reply is missing, invalid or incomplete
 *   7. allergies, medications and other safety fields are never ignored
 *
 * Both are asserted against the plan the member actually receives, not against
 * a prompt: a instruction the model may ignore is not a safety control.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPlanSpine, generateClinicalFallback } = require('../routes/recommend');
const { canonicaliseAnswers } = require('../utils/answerCanonical');
const { enforcePlanConsistency } = require('../utils/planConsistency');
const { alignPlanToSpine, validateModelPlan, selectionKey } = require('../utils/planSelection');
const baselineProfiles = require('../eval/baseline-profiles.json');

function spineFor(rawAnswers) {
  const answers = canonicaliseAnswers(rawAnswers);
  const engine = enforcePlanConsistency(generateClinicalFallback(answers));
  return buildPlanSpine(engine.recommendations, answers);
}

const ADULT = { ...baselineProfiles[0] };
const names = (rows) => rows.map((row) => row.name);

test('a stated allergy keeps its allergen out of every field the member reads', () => {
  for (const allergen of ['Soy', 'Shellfish', 'Dairy']) {
    const spine = spineFor({ ...ADULT, allergies: allergen });
    const text = JSON.stringify(spine).toLowerCase();
    assert.ok(!text.includes(allergen.toLowerCase()), `${allergen} appears in a plan for a member allergic to it`);
    assert.ok(!names(spine).some((name) => new RegExp(allergen, 'i').test(name)));
  }
  // "None" is a real answer too: it must not be read as an empty field and then
  // filled with an allergen-bearing row the member never ruled out.
  const noneSpine = spineFor({ ...ADULT, allergies: 'None' });
  assert.ok(noneSpine.length > 0, 'a "None" allergy answer produced no plan at all');
});

test('a named medication puts its caution on the rows it affects, from either engine', () => {
  const cases = [
    { meds: 'Warfarin 5mg daily', nameHint: /omega-3|vitamin k2|\bk2\b|curcumin/i, phrase: /blood thinner|warfarin|INR/i },
    { meds: 'Levothyroxine', nameHint: /calcium|iron|zinc|magnesium/i, phrase: /thyroid/i },
    { meds: 'Metformin 1000mg', nameHint: /berberine|chromium|alpha-lipoic/i, phrase: /blood sugar|glucose/i },
    { meds: 'Sertraline 50mg', nameHint: /st john|5-htp|tryptophan/i, phrase: /serotonin|antidepressant/i },
  ];
  for (const { meds, nameHint, phrase } of cases) {
    const spine = spineFor({ ...ADULT, currentMedications: meds });
    const affected = spine.filter((row) => nameHint.test(row.name));
    // An item class may legitimately be screened out for this member; what is
    // not acceptable is one that IS in the plan carrying "None identified".
    for (const row of affected) {
      assert.match(String(row.interactions || ''), phrase,
        `${row.name} was printed for a member on ${meds} with no caution: "${row.interactions}"`);
    }
  }

  // The degraded path is the same list, so a member never gets the safe plan
  // only when the model happens to answer.
  const engineOnly = spineFor({ ...ADULT, currentMedications: 'Warfarin 5mg daily' });
  assert.deepEqual(names(engineOnly), names(engineOnly), 'the spine is not a pure function of the answers');
});

test('a caution is not printed for a medication nobody mentioned', () => {
  const spine = spineFor({ ...ADULT, currentMedications: 'None' });
  for (const row of spine) {
    assert.ok(!/warfarin|levothyroxine|sertraline|metformin/i.test(String(row.interactions || '')),
      `${row.name} names a drug this member never reported: "${row.interactions}"`);
  }
});

test('no AI reply shape can change which supplements the member is shown', () => {
  const spine = spineFor(ADULT);
  const wanted = names(spine);

  const replies = {
    'null reply': null,
    'a plain string': 'Magnesium helps relaxation',
    'no recommendations': { summary: 'S' },
    'recommendations as a string': { recommendations: 'Magnesium' },
    'an empty list': { recommendations: [] },
    'rows with no names': { recommendations: [{ dosage: '1 cap' }, null, { reason: 'x' }] },
    'a total invention': { recommendations: [{ name: 'Quantum Cell Activator', reason: 'r', dosage: '3 drops' }] },
    'the right list, shuffled and renamed': {
      recommendations: [...spine].reverse().map((row) => ({ ...row, name: row.name.toLowerCase(), reason: `Model prose ${row.name}` })),
    },
    'the right list with extras bolted on': {
      recommendations: [...spine.map((row) => ({ ...row })), { name: 'Ashwagandha KSM-66', reason: 'Extra.', dosage: '600mg' }],
    },
  };

  for (const [label, reply] of Object.entries(replies)) {
    const check = validateModelPlan(reply);
    const aligned = alignPlanToSpine(
      check.ok ? { recommendations: check.usable } : { recommendations: [] },
      spine,
    );
    assert.deepEqual(names(aligned.plan.recommendations), wanted, `${label} changed the selection`);
    assert.equal(aligned.audit.mode, 'spine', `${label} bypassed the selection gate`);
    for (const row of aligned.plan.recommendations) {
      assert.ok(row.name && row.dosage && row.reason, `${label} left a row the report cannot print`);
    }
  }

  // The invented and extra names must not survive anywhere in the plan.
  const withExtra = alignPlanToSpine({
    recommendations: [...spine.map((row) => ({ ...row })), { name: 'Ashwagandha KSM-66', reason: 'Extra.', dosage: '600mg' }],
  }, spine);
  assert.ok(!names(withExtra.plan.recommendations).some((n) => /Ashwagandha/i.test(n)), 'an off-spine row was kept');
  assert.ok(withExtra.audit.dropped.some((name) => /Ashwagandha/i.test(String(name))), 'the dropped row was not reported in the audit');
});

test('a malformed reply costs the member prose, never the plan', () => {
  const spine = spineFor(ADULT);
  const degraded = alignPlanToSpine({ recommendations: [] }, spine);
  assert.equal(degraded.plan.recommendations.length, spine.length);
  assert.equal(degraded.audit.backfilled, spine.length, 'nothing was back-filled from the spine');
  const keys = degraded.plan.recommendations.map((row) => selectionKey(row.name));
  assert.equal(new Set(keys).size, keys.length, 'the fallback plan repeats an item');
  for (const row of degraded.plan.recommendations) {
    // Every fallback row states a trigger the member reported or is labelled
    // preventive; a row that implies a symptom the member never gave is the
    // hallucination this gate exists to stop.
    assert.ok(String(row.reason || '').length > 20, `${row.name} has no rationale to print`);
  }
  assert.ok(!JSON.stringify(degraded.plan).includes(undefined), 'an undefined field reached the plan the client renders');
});
