/**
 * The clinical evidence gate — the automated decider that replaced the
 * admin approval click.
 *
 * Run: node --test "Test File/evidence-gate.test.js"
 *
 * The "suggested and proven by health professionals" claim now rests on
 * this rule, not on a human button: a condition publishes only when every
 * surviving supplement intervention cites an authoritative professional
 * source and none of them is a prescription or listed danger. These tests
 * pin that rule from both sides — what clears it, and exactly how a
 * fabricated citation or a drug is refused and recorded.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  citationIsAuthoritative,
  isPrescriptionOrDangerous,
  isKnownApprovedSupplement,
} = require('../utils/clinicalEvidenceStandards');
const {
  gateCandidate,
  gateRanked,
  gateVerdictEntry,
  GATE_REVIEWER,
} = require('../utils/evidenceGate');
const DynamicCondition = require('../models/DynamicCondition');
const {
  mergeSelectedBundles,
  kbBlockForPrompt,
  norm,
} = require('../utils/dynamicConditions');

const GOOD_CITATION = 'American Diabetes Association (2025). Standards of Care in Diabetes — supplements section. ADA.';
const CoCHRANE_CITATION = 'Cochrane Database of Systematic Reviews (2023). Berberine for glycaemic control. Cochrane Review.';

function bundle(over = {}) {
  return {
    name: 'Prediabetes / Insulin Resistance',
    group: 'Cardiovascular & Metabolic',
    sexGate: '',
    rationale: 'High fasting-glucose narratives with no condition selected.',
    symptomPool: ['Increased Thirst', 'Blurred Vision'],
    supplements: [
      {
        name: 'Berberine',
        reason: 'Supports glucose metabolism.',
        dosage: '500 mg twice daily',
        timing: 'With meals',
        priority: 'High',
        interactions: 'May amplify metformin effects — inform your doctor.',
        evidence: GOOD_CITATION,
      },
      {
        name: 'Alpha-Lipoic Acid',
        reason: 'Antioxidant support for nerve health.',
        dosage: '300 mg daily',
        timing: 'Morning',
        priority: 'Medium',
        evidence: CoCHRANE_CITATION,
      },
    ],
    warnings: ['Supplements do not replace glucose monitoring.'],
    avoid: ['Sugar-sweetened drinks'],
    lifestyle: [{ category: 'Diet', advice: 'Pair carbohydrates with protein and fibre.' }],
    ...over,
  };
}

// ── citation authority ──────────────────────────────────────────────────
test('authoritative citations are recognised across guideline bodies, Cochrane, meta-analyses and well-formed PMIDs', () => {
  assert.equal(citationIsAuthoritative(GOOD_CITATION), true);
  assert.equal(citationIsAuthoritative(CoCHRANE_CITATION), true);
  assert.equal(citationIsAuthoritative('NIH Office of Dietary Supplements fact sheet.'), true);
  assert.equal(citationIsAuthoritative('Randomized controlled trial, PMID: 31234567.'), true);
  assert.equal(citationIsAuthoritative('WHO guideline on sodium.'), true);
});

test('invented, vague or malformed citations never clear the authority bar', () => {
  assert.equal(citationIsAuthoritative(''), false);
  assert.equal(citationIsAuthoritative('Doctors say this helps.'), false);
  assert.equal(citationIsAuthoritative('A study from 2021 (trust me).'), false);
  // A claimed PMID must be well-formed — a dangling "PMID: abc" is a fabrication tell.
  assert.equal(citationIsAuthoritative('PMID: 12'), false);
});

test('prescription/danger filter and known-ingredient tagging', () => {
  assert.equal(isPrescriptionOrDangerous('Metformin'), true);
  assert.equal(isPrescriptionOrDangerous('Insulin'), true);
  assert.equal(isPrescriptionOrDangerous('Phenibut'), true);
  assert.equal(isPrescriptionOrDangerous('Magnesium Glycinate'), false);
  assert.equal(isKnownApprovedSupplement('Magnesium Glycinate'), true);
  assert.equal(isKnownApprovedSupplement('Saffron Extract'), false);
});

// ── gateCandidate ───────────────────────────────────────────────────────
test('a fully cited supplement bundle passes and normalises with safe defaults', () => {
  const v = gateCandidate(bundle());
  assert.equal(v.ok, true, JSON.stringify(v.reasons));
  assert.equal(v.normalized.supplements.length, 2);
  assert.equal(v.normalized.supplements[0].knownApprovedIngredient, true, 'berberine is in the curated list');
  assert.equal(v.normalized.supplements[1].interactions, 'Inform your doctor', 'missing interactions gets the disclosure default');
  assert.equal(v.normalized.supplements[1].priority, 'Medium');
});

test('a prescription drug inside the bundle hard-rejects the whole candidate', () => {
  const v = gateCandidate(bundle({
    supplements: [
      bundle().supplements[0],
      { name: 'Glipizide', reason: 'r', dosage: '5 mg', priority: 'High', evidence: GOOD_CITATION },
    ],
  }));
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => /Glipizide.*prescription/i.test(r)));
});

test('every supplement row must cite an authoritative source or the candidate is refused', () => {
  const v = gateCandidate(bundle({
    supplements: [{
      name: 'Chromium',
      reason: 'r',
      dosage: '200 mcg',
      priority: 'Low',
      evidence: 'Health influencers recommend it (2024).',
    }],
  }));
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => /Chromium.*no authoritative professional source/i.test(r)));
  assert.ok(v.reasons.some((r) => /no supplement survived/i.test(r)));
});

test('one bad row does not sink a good bundle — it publishes with the survivors and keeps the reason as an annotation', () => {
  const v = gateCandidate(bundle({
    supplements: [
      bundle().supplements[0],
      { name: 'Vitamin C', reason: 'r', dosage: '500 mg', priority: 'Medium', evidence: 'My dentist mentioned it.' },
    ],
  }));
  assert.equal(v.ok, true, 'Berberine survives, so the condition publishes');
  assert.equal(v.normalized.supplements.length, 1);
  assert.ok(v.reasons.some((r) => /Vitamin C.*cites no authoritative/i.test(r)));
});

test('a candidate with no supplement interventions is unprovable and rejected', () => {
  const v = gateCandidate(bundle({ supplements: [] }));
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => /nothing provable/i.test(r)));
});

test('invalid priorities are corrected to Medium and flagged, not silently trusted', () => {
  const v = gateCandidate(bundle({
    supplements: [{ ...bundle().supplements[0], priority: 'Urgent!!' }],
  }));
  assert.equal(v.ok, true);
  assert.equal(v.normalized.supplements[0].priority, 'Medium');
  assert.ok(v.reasons.some((r) => /no valid priority/i.test(r)));
});

test('sexGate keeps only Male|Female; oversized pools are capped', () => {
  const v = gateCandidate(bundle({
    sexGate: 'Everyone',
    symptomPool: Array.from({ length: 40 }, (_, i) => `Symptom ${i}`),
    warnings: Array.from({ length: 20 }, (_, i) => `w${i}`),
  }));
  assert.equal(v.normalized.sexGate, '');
  assert.equal(v.normalized.symptomPool.length, 25);
  assert.equal(v.normalized.warnings.length, 8);
  const f = gateCandidate(bundle({ sexGate: 'female' }));
  assert.equal(f.normalized.sexGate, '', 'case must match the enum exactly');
  const f2 = gateCandidate(bundle({ sexGate: 'Female' }));
  assert.equal(f2.normalized.sexGate, 'Female');
});

test('invisible characters are scrubbed out of gate output', () => {
  const v = gateCandidate(bundle({ name: 'Prediabetes​ \u202e/ Insulin Resistance' }));
  assert.ok(!/[\u200B-\u200F\u202A-\u202E]/.test(v.normalized.label));
});

// ── gateRanked + verdict trail ─────────────────────────────────────────
test('gateRanked splits a ranked payload into accepted and rejected with reasons', () => {
  const g = gateRanked({
    candidates: [
      bundle(),
      bundle({ name: 'Sleep Apnea', supplements: [{ name: 'Melatonin', evidence: 'Blog post says it works.' }] }),
      'garbage row',
    ],
  });
  assert.equal(g.accepted.length, 1);
  assert.equal(g.accepted[0].raw.name, 'Prediabetes / Insulin Resistance', 'the original payload stays attached');
  assert.ok(Array.isArray(g.accepted[0].annotationReasons));
  assert.equal(g.rejected.length, 2);
  assert.ok(g.rejected[0].reasons.join(' ').length > 0);
  assert.ok(g.rejected[1].reasons.some((r) => /no condition name/i.test(r)));
});

test('registry collisions: built-ins refuse even their exact label; live rows refresh only verbatim', () => {
  const registry = { builtin: ['PCOS', 'Chronic Kidney Disease', 'Diabetes'], live: ['Cancer (General)'] };
  const g = gateRanked({
    candidates: [
      bundle({ name: 'Polycystic Ovary Syndrome (PCOS)' }),
      bundle({ name: 'Diabetes' }),
      bundle({ name: 'Prediabetes / Insulin Resistance' }),
      bundle({ name: 'cancer (general)' }),
      bundle({ name: 'Cancer' }),
      bundle({ name: 'Gestational Diabetes History' }),
    ],
  }, registry);
  const refused = g.rejected.map((r) => r.candidate.label);
  assert.ok(refused.includes('Polycystic Ovary Syndrome (PCOS)'), 'synonym of a built-in is a reworded duplicate');
  assert.ok(refused.includes('Diabetes'), 'exact built-in must not shadow the hard-coded scoping');
  assert.ok(refused.includes('Cancer'), 'reworded synonym of a live row must not fork the option');
  assert.ok(refused.includes('Gestational Diabetes History'),
    'conservative by design: a label carrying the standalone built-in word is refused rather than silently forked');
  const acceptedNames = g.accepted.map((a) => a.label);
  assert.ok(acceptedNames.includes('Prediabetes / Insulin Resistance'),
    'word-boundary rule: "diabetes" inside "prediabetes" is not a collision');
  assert.ok(acceptedNames.includes('cancer (general)'),
    'verbatim re-proposal of a live label passes through so publishAccepted REFRESHES it');
  assert.equal(g.accepted.length, 2, 'prediabetes + the verbatim cancer refresh');
});

test('gateVerdictEntry writes an automated-reviewer audit row for both decisions', () => {
  const approve = gateVerdictEntry('approve', [], [GOOD_CITATION, CoCHRANE_CITATION]);
  assert.equal(approve.reviewerAlias, GATE_REVIEWER.reviewerAlias);
  assert.equal(approve.discipline, 'clinical-evidence-standard');
  assert.equal(approve.decision, 'approve');
  assert.match(approve.comment, /^Auto-published: every supplement cites/);
  assert.ok(approve.comment.includes('American Diabetes Association'));

  const reject = gateVerdictEntry('reject', ['"X" cites no authoritative professional source'], []);
  assert.equal(reject.decision, 'reject');
  assert.match(reject.comment, /^Auto-rejected: /);
  assert.ok(reject.at instanceof Date);
});

// ── publish path (mocked driver) ────────────────────────────────────────
test('publishAccepted is idempotent by normalizedLabel and refreshes live rows', async () => {
  const originals = { findOne: DynamicCondition.findOne, create: DynamicCondition.create, updateOne: DynamicCondition.updateOne };
  const store = [];
  try {
    DynamicCondition.findOne = async (f) => store.find((r) => r.normalizedLabel === f.normalizedLabel) || null;
    DynamicCondition.create = async (doc) => { store.push({ _id: `d${store.length}`, ...doc }); return doc; };
    DynamicCondition.updateOne = async (f, u) => {
      const row = store.find((r) => String(r._id) === String(f._id));
      Object.assign(row, u.$set ?? u);
      return { modifiedCount: 1 };
    };
    const g = gateRanked({ candidates: [bundle()] });
    const first = await DynamicCondition.publishAccepted(g.accepted, { script: 'conditionGapAnalysis', assessmentsScanned: 12 });
    assert.deepEqual({ ...first }, { published: 1, refreshed: 0 });
    const second = await DynamicCondition.publishAccepted(g.accepted, { script: 'conditionGapAnalysis', assessmentsScanned: 25 });
    assert.deepEqual({ ...second }, { published: 0, refreshed: 1 });
    assert.equal(store.length, 1, 'no duplicate condition rows');
    assert.equal(store[0].source.assessmentsScanned, 25, 're-publish refreshes the evidence meta');
    assert.equal(store[0].status, 'live');
  } finally {
    Object.assign(DynamicCondition, originals);
  }
});

// ── consumption path ────────────────────────────────────────────────────
test('mergeSelectedBundles only takes exact label matches, respects the sex gate and tags provenance', () => {
  const live = [{
    label: 'Prediabetes / Insulin Resistance',
    normalizedLabel: norm('Prediabetes / Insulin Resistance'),
    sexGate: '',
    supplements: [{ name: 'Berberine', reason: 'r', dosage: '500 mg', timing: 'With meals', priority: 'High', interactions: 'i', evidence: GOOD_CITATION }],
    warnings: ['w1'],
    avoid: ['a1'],
    lifestyle: [{ category: 'Diet', advice: 'l1' }],
  }];
  const hit = mergeSelectedBundles(live, ['prediabetes / INSULIN  resistance'], 'Female');
  assert.equal(hit.recs.length, 1);
  assert.match(hit.recs[0].triggeredBy, /AI-published, professionally cited evidence/);
  assert.deepEqual([hit.warnings, hit.avoidList, hit.lifestyleAdvice], [['w1'], ['a1'], [{ category: 'Diet', advice: 'l1' }]]);
  const miss = mergeSelectedBundles(live, ['Gout'], 'Female');
  assert.equal(miss.recs.length, 0);

  const gated = [{ ...live[0], sexGate: 'Female' }];
  assert.equal(mergeSelectedBundles(gated, ['Prediabetes / Insulin Resistance'], 'Male').recs.length, 0);
  assert.equal(mergeSelectedBundles(gated, ['Prediabetes / Insulin Resistance'], 'Female').recs.length, 1);
});

test('kbBlockForPrompt turns live bundles into a numbered learned-KB section, empty when nothing is live', () => {
  assert.equal(kbBlockForPrompt([]), '');
  const kb = kbBlockForPrompt([{
    label: 'Sleep Apnea',
    sexGate: '',
    supplements: [{ name: 'Magnesium Glycinate', dosage: '200 mg', priority: 'Low', evidence: 'NIH ODS fact sheet.' }],
    warnings: ['Supplements cannot treat sleep apnoea — prioritise a sleep study.'],
    avoid: [],
  }]);
  assert.match(kb, /^9\. LEARNED KNOWLEDGE BASE/);
  assert.ok(kb.includes('- Sleep Apnea'));
  assert.ok(kb.includes('NIH ODS fact sheet'));
  assert.ok(kb.includes('warnings:'));
});
