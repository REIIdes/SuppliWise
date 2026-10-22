const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { preprocessUserInput, sanitizeMedicalField } = require('../utils/sanitize');
const { completeWithFallback, safeAttemptSummary } = require('../utils/aiRouter');
const { simplifiedReasonFor, simplifiedEvidenceFor } = require('../utils/recommendationPlainLanguage');
const { promptSafe, ASSESSMENT_SYSTEM_PROMPT, buildAssessmentPrompt } = require('../utils/assessmentPrompt');
const { enforcePlanConsistency, classifySupplement } = require('../utils/planConsistency');
const { containsForbiddenFood } = require('../utils/planEvaluation');
const { getLiveConditions, mergeSelectedBundles, kbBlockForPrompt } = require('../utils/dynamicConditions');
const { registeredEvidence, extractPmids } = require('../utils/supplementEvidenceRegistry');
const { groundPlan, doseEntry, NEUTRAL_TRIGGER, rejectReason } = require('../utils/planGrounding');
const { loadMemberHistory, applyAdaptation } = require('../utils/memberHistory');
const { answerSignature, alignPlanToSpine, validateModelPlan, selectionKey } = require('../utils/planSelection');
const { canonicaliseAnswers } = require('../utils/answerCanonical');
// The free-text rules in this file are written in English because that is what a
// questionnaire option looks like; a member typing their own words writes Tagalog.
// anchorText appends the English equivalent of a Filipino symptom phrase
// (utils/languageAnchors.js) so the same complaint reaches the same branch here that
// it would have reached in English. Appended, never substituted: the member’s own
// sentence is still the text that gets stored, shown and polished.
const { anchorText } = require('../utils/languageAnchors');
const { CRISIS_PHRASES } = require('../utils/severity');
const Assessment = require('../models/Assessment');

/**
 * True when the member's own words name a mental-health crisis.
 *
 * The list is severity.js's, not a local regex: the critical tier and the
 * consult-doctor flag must agree on what a crisis sounds like, and they used to
 * be written twice — once here as `suicid|self.harm|hopeless|want to die`, once
 * there — so "I want to harm myself" cleared both.
 */
function mentionsCrisis(text) {
  const lower = String(text || '').toLowerCase();
  return CRISIS_PHRASES.some((phrase) => lower.includes(phrase));
}

// Kept on the route's public surface because existing probes import it from
// here; the implementation now lives in utils/assessmentPrompt.js.
// Replaces em/en dashes, smart quotes, and other problematic Unicode
// that renders as ? in some fonts/environments
// -- Recursively sanitize all strings in a JSON object ---------------------
// Replaces em/en dashes, smart quotes, and other problematic Unicode
// that renders as ? in some fonts/environments
function cleanStr(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\u2014/g, ' - ')   // em dash
    .replace(/\u2013/g, ' - ')   // en dash
    .replace(/\u2018|\u2019/g, "'")  // smart single quotes
    .replace(/\u201C|\u201D/g, '"')  // smart double quotes
    .replace(/\u2026/g, '...')       // ellipsis
    .replace(/\u00e9/g, 'e').replace(/\u00e8/g, 'e')
    .replace(/\u00e0/g, 'a').replace(/\u00f3/g, 'o')
    .replace(/\u00fa/g, 'u').replace(/\u00f1/g, 'n')
    .replace(/\u00e7/g, 'c').replace(/\u00df/g, 'ss')
    .replace(/[\u0080-\u00FF]/g, (c) => c) // keep other latin-1
    .replace(/[^\x00-\xFF]/g, '');  // strip anything above latin extended
}

/**
 * A request seed from the answer digest. The digest is a hash, so this carries
 * no answer text, and taking it modulo 2^31 keeps it inside the integer range
 * every provider that accepts `seed` documents.
 */
function seedFromSignature(signature) {
  const head = String(signature || '').slice(0, 8);
  const parsed = /^[0-9a-f]{1,8}$/i.test(head) ? parseInt(head, 16) : 0;
  return parsed % 2147483647;
}

/**
 * How many general-support rows to assemble when the clinical rules found
 * NOTHING to recommend for this member. It is a floor for an empty plan, not a
 * quota to fill: a padded plan grew the same eight-to-eleven-item tail on
 * nearly every member, and each extra item is a thing a member may actually
 * start taking. A plan contains what these answers justify.
 */
const PREVENTIVE_FLOOR = 5;

/**
 * Preventive support items, in canonical nutrient order, used to assemble a
 * plan the rules had no rows for.
 *
 * These are NOT "one set of supplements for every user". Every entry is
 * screened against the member's own answers before it can be added: declared
 * allergens, diet (a vegan never gets a bovine collagen or fish-derived row),
 * age band (nothing adult-dosed reaches a child or adolescent), pregnancy or
 * breastfeeding (nothing hormonal or herb-like), and named conditions a row is
 * documented to aggravate. Rows already chosen for a clinical reason are never
 * duplicated, and a nutrient class already in the plan is not added twice.
 *
 * `role` is what the app can say about the nutrient in general — the reason a
 * dietitian lists it as preventive support. It asserts nothing about the reader.
 */
const GENERAL_SUPPORT_POOL = [
  { name: 'Vitamin D3 (Cholecalciferol)', role: 'bone density, calcium absorption and immune function' },
  { name: 'Omega-3 (EPA+DHA)', role: 'heart, brain and eye health', animalDerived: true, bloodThinnerNote: 'High-dose omega-3 can add to a blood thinner — keep to 1g daily and inform your doctor' },
  { name: 'Magnesium Glycinate', role: 'nerve signalling, muscle relaxation and sleep quality' },
  { name: 'Calcium Citrate', role: 'bone mineral density, especially when dietary calcium is low', avoidConditions: ['kidney stone', 'kidney disease'] },
  { name: 'Vitamin B12 (Methylcobalamin)', role: 'energy metabolism, red blood cells and nerve function' },
  { name: 'Folate (Methylfolate)', role: 'cell division and homocysteine metabolism' },
  { name: 'Vitamin C (Ascorbic Acid)', role: 'antioxidant defence, collagen formation and iron absorption' },
  { name: 'Zinc Picolinate', role: 'immune function, wound healing and protein synthesis' },
  { name: 'Vitamin K2 (MK-7)', role: 'directing calcium into bone rather than soft tissue', bloodThinnerNote: 'Vitamin K can blunt warfarin effect — discuss with your doctor' },
  { name: 'Probiotic (Multi-strain)', role: 'gut microbiome diversity and digestive regularity' },
  { name: 'Fiber (Psyllium Husk)', role: 'bowel regularity and satiety' },
  { name: 'CoQ10 (Ubiquinol)', role: 'cellular energy production, particularly relevant with statin therapy', adultOnly: true },
  { name: 'Curcumin + Piperine', role: 'exercise-related inflammation and joint comfort', pregnancyAvoid: true, adultOnly: true, bloodThinnerNote: 'Curcumin has mild blood-thinning activity — discuss with your doctor' },
  { name: 'L-Theanine', role: 'calm alertness without sedation', adultOnly: true },
  { name: 'Creatine Monohydrate', role: 'muscle strength, power and recovery', adultOnly: true, pregnancyAvoid: true, avoidConditions: ['kidney disease', 'kidney stone'] },
  { name: 'Collagen Peptides (Type I & III)', role: 'skin, hair and connective-tissue support', animalDerived: true, adultOnly: true },
];

/**
 * The nutrient words inside a supplement name, stripped of the marketing and
 * form fluff: "Vitamin D3 + K2" → d3, k2; "Iron Bisglycinate + Vitamin C" →
 * iron, bisglycinate, c; "Probiotic (Multi-strain, 50B CFU)" → probiotic,
 * multi-strain, 50b cfu.
 *
 * This is what stops a preventive row doubling a nutrient the rules already
 * selected. The canonical CLASS alone is not enough: a combined D3+K2 row
 * classifies as vitamin-D, so without the token comparison a separate Vitamin
 * K2 row would be added on top of the K2 it already contains — and a member
 * taking two sources of one nutrient is a dosing error, not a fuller plan.
 */
function nameNutrientTokens(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[+&(),/]| and | with /)
    .map((part) => part.trim().replace(/^(vitamin|mineral|natural|pure)\s+/, '').replace(/\s+/g, ' '))
    // Single letters stay: "Vitamin C" reduces to "c", and dropping it is exactly
    // how a preventive Vitamin C row ended up on top of "Iron + Vitamin C".
    .filter((part) => part.length > 0);
}

/**
 * A medication the member named changes what must be written on a row, whoever
 * chose that row. The rule engine states these cautions inside whichever branch
 * happens to emit the nutrient, and the preventive pool only carries the one its
 * own table knows about, so an algae omega-3 selected for a vegan on warfarin
 * could still print "None identified". This pass runs over the finished spine so
 * the caution is a property of the plan, not of the code path that built a row.
 */
const MEDICATION_CAUTIONS = [
  {
    on: /warfarin|coumadin|blood thinner|anticoagulant|apixaban|eliquis|rivaroxaban|xarelto|clopidogrel|plavix|aspirin/i,
    says: /blood thinner|warfarin|INR/i,
    names: /omega-3|fish oil|algae|krill|vitamin k2|\bk2\b|nattokinase|vitamin e|curcumin|turmeric|ginger|garlic|ginkgo|dong quai/i,
    caution: 'May add to the effect of a blood thinner - keep to the stated dose and have your doctor monitor INR',
  },
  {
    on: /levothyroxine|synthroid|eltroxin|euthyrox|thyroid hormone|thyroid medication/i,
    says: /thyroid/i,
    names: /calcium|iron|zinc|magnesium/i,
    caution: 'Take 4+ hours apart from thyroid medication - this nutrient blocks its absorption if timed together',
  },
  {
    on: /metformin|glucophage|insulin|glipizide|sulfonylurea/i,
    says: /blood sugar|glucose|hypoglycemi/i,
    names: /berberine|chromium|alpha-lipoic|fenugreek|cinnamon|bitter melon/i,
    caution: 'Can lower blood sugar alongside this medication - monitor glucose when starting and tell your doctor',
  },
  {
    on: /ssri|snri|sertraline|fluoxetine|escitalopram|citalopram|paroxetine|antidepressant|trazodone/i,
    says: /serotonin|antidepressant/i,
    names: /st john|5-htp|tryptophan|sam-e/i,
    caution: 'Acts on serotonin - do not combine with an antidepressant without prescriber approval',
  },
];

function applyMedicationCautions(rows, medicationsText) {
  const meds = String(medicationsText || '');
  if (!meds) return rows;
  for (const row of rows) {
    const name = String(row.name || '');
    for (const rule of MEDICATION_CAUTIONS) {
      if (!rule.on.test(meds) || !rule.names.test(name)) continue;
      const current = String(row.interactions || '');
      // "None identified" is a claim about interactions, not a caution, so a
      // stated medication replaces it rather than stacking underneath it.
      if (rule.says.test(current)) continue;
      row.interactions = (!current || /none identified/i.test(current))
        ? rule.caution
        : `${current} - ${rule.caution}`;
    }
  }
  return rows;
}

/** Whether this member's own answers rule a preventive row out. */
function preventiveRowIsBlocked(item, a) {
  const name = String(item.name).toLowerCase();
  const allergens = String(a.allergies || '')
    .toLowerCase().split(/[,;]/).map((t) => t.trim())
    .filter((t) => t.length > 2 && !/^(none|nkda|not specified|no known allergies?|n\/a)/.test(t));
  if (allergens.some((t) => name.includes(t) || t.includes(name.split(' ')[0]))) return true;

  const age = Number(a.age);
  if (item.adultOnly && (!Number.isFinite(age) || age < 18)) return true;

  const preg = String(a.pregnancyStatus || '').toLowerCase();
  const isExpecting = preg.includes('pregnant') || preg.includes('breast') || preg.includes('lactat');
  if (item.pregnancyAvoid && isExpecting) return true;

  const conditions = (Array.isArray(a.medicalConditions) ? a.medicalConditions : String(a.medicalConditions || '').split(','))
    .map((c) => String(c).toLowerCase()).join(' ');
  if ((item.avoidConditions || []).some((c) => conditions.includes(c))) return true;

  const diet = String(a.dietType || '').toLowerCase();
  if (item.animalDerived && (diet.includes('vegan') || diet.includes('vegetarian'))) return true;
  // An algae omega-3 is the plant form and is already what the rules emit for a
  // plant-based diet, so the fish-derived entry must not be added on top of it.
  if (item.animalDerived && diet.includes('pescatarian') && name.includes('collagen')) return true;

  // A name this app will refuse outright (a prescription medicine, an invented
  // "complex") must not enter the spine, where it would be re-checked per row.
  if (rejectReason(item.name)) return true;
  return false;
}

/**
 * The authoritative item list for this member: every row the clinical rules
 * selected from their answers, de-duplicated per nutrient, with any medication
 * caution written onto it, re-sorted into canonical order. A member the rules
 * found nothing for gets a small general-support plan instead of an empty one.
 *
 * Pure function of (answers, rule output), so two submissions of the same
 * answers select the same supplements — which is what the model alone cannot
 * promise, and the reason this runs before the prompt is built rather than
 * after the reply arrives.
 */
function buildPlanSpine(baseRecs, a, { floor = PREVENTIVE_FLOOR } = {}) {
  // Two engine branches can reach the same nutrient for one member — the anemia
  // branch emits "Iron Bisglycinate + Vitamin C" while a depletion branch emits
  // "Iron Bisglycinate" — and a member who follows both takes one nutrient twice.
  // That is a dosing error, not a fuller plan, so the spine keeps one row per
  // nutrient class: the more urgent of the two, or the first if they tie.
  const rank = { High: 0, Medium: 1, Low: 2 };
  const bestByClass = new Map();
  for (const row of (Array.isArray(baseRecs) ? baseRecs : [])) {
    if (!row || typeof row.name !== 'string' || !row.name.trim()) continue;
    const classId = classifySupplement(row.name);
    if (!classId) { bestByClass.set(`name:${selectionKey(row.name)}`, { ...row }); continue; }
    const existing = bestByClass.get(`class:${classId}`);
    const next = { ...row };
    if (!existing || (rank[next.priority] ?? 1) < (rank[existing.priority] ?? 1)) {
      bestByClass.set(`class:${classId}`, next);
    }
  }
  const spine = [...bestByClass.values()];

  const keys = new Set(spine.map((r) => selectionKey(r.name)));
  const classes = new Set(spine.map((r) => classifySupplement(r.name)).filter(Boolean));
  const takenTokens = new Set(spine.flatMap((r) => nameNutrientTokens(r.name)));
  const symptoms = Array.isArray(a.symptoms) ? a.symptoms : [];
  const goals = Array.isArray(a.healthGoals) ? a.healthGoals : [];
  const conditions = Array.isArray(a.medicalConditions) ? a.medicalConditions : [];

  // Only a plan the rules could say nothing about gets assembled from the
  // general-support pool. Anything else is filler that the member did not earn
  // from their own answers, and filler is what made an update look like it had
  // added supplements by itself.
  const padding = spine.length === 0 ? GENERAL_SUPPORT_POOL.slice(0, floor * 3) : [];
  for (const item of padding) {
    if (spine.length >= floor) break;
    if (preventiveRowIsBlocked(item, a)) continue;
    const key = selectionKey(item.name);
    if (keys.has(key)) continue;
    if (nameNutrientTokens(item.name).some((t) => takenTokens.has(t))) continue;
    const classId = classifySupplement(item.name);
    if (classId && classes.has(classId)) continue;

    const onBloodThinner = /warfarin|coumadin|blood thinner|apixaban|rivaroxaban|clopidogrel|aspirin/i
      .test(String(a.currentMedications || ''));
    const dosage = (doseEntry(item.name) || {}).standard || 'per product label';
    const row = {
      name: item.name,
      reason: `${item.name} is listed as preventive nutritional support rather than for a symptom reported on this assessment. It contributes to ${item.role}, and intake of these nutrients is often below recommended levels from diet alone. Supplementation is generally considered when food intake does not cover the difference.`,
      simplifiedReason: simplifiedReasonFor({ name: item.name, symptoms, goals, conditions })
        || `${item.name} supports general wellness as part of this plan.`,
      conditionContext: null,
      triggeredBy: NEUTRAL_TRIGGER,
      dosage,
      timing: /magnesium|calcium|iron|zinc|creatine|coq10/i.test(item.name)
        ? 'With a meal, split from any thyroid medication by 4+ hours'
        : 'With a meal containing some fat',
      priority: 'Low',
      confidenceScore: 72,
      severityLevel: 'Low',
      interactions: item.bloodThinnerNote && onBloodThinner
        ? item.bloodThinnerNote
        : (/calcium|iron|zinc/.test(key)
          ? 'Separate by 4+ hours from thyroid medication and antibiotics'
          : 'None identified'),
      evidence: inferEvidence(item.name),
      simplifiedEvidence: simplifiedEvidenceFor(item.name),
      foods: dietAdjustFoods(inferFoods(item.name), a.dietType),
      sideEffects: inferSideEffects(item.name),
      preventiveSupport: true,
    };
    spine.push(row);
    keys.add(key);
    for (const t of nameNutrientTokens(item.name)) takenTokens.add(t);
    if (classId) classes.add(classId);
  }

  applyMedicationCautions(spine, a.currentMedications);
  return orderForPresentation(spine);
}

/** Canonical order without touching anything else about the rows. */
function orderForPresentation(recs) {
  return enforcePlanConsistency({ recommendations: recs }).recommendations;
}

function sanitizeStrings(obj) {
  if (typeof obj === 'string') return cleanStr(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeStrings);
  if (obj !== null && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = sanitizeStrings(v);
    return out;
  }
  return obj;
}

// The answers a plan is actually built from: every question the Assessment
// schema persists, and nothing else. Kept as an explicit list rather than read
// off the schema because the schema also carries bookkeeping (`aiResults`,
// `priority`, `expiresAt`, the flag lifecycle) that must not leak into a plan's
// identity — a member who was flagged, then resolved, would otherwise look like
// a different person asking the same questions.
//
// `ASSESSMENT_FIELDS.test.js` pins this list against the schema, because a
// question added to the model and forgotten here silently stops influencing the
// signature — two different health profiles then share one cached plan.
const ASSESSMENT_FIELDS = new Set([
  'age', 'gender', 'weight', 'height', 'activityLevel',
  'dietType', 'healthGoals',
  'symptoms', 'symptomSeverity', 'stressLevel', 'sleepQuality', 'waterIntake',
  'medicalConditions', 'currentMedications', 'allergies', 'feelingDescription',
  'lifestyleHabits', 'pregnancyStatus', 'takingSupplements', 'currentSupplements',
  'recentBloodTest', 'bloodTestResults',
  'sunExposure', 'fitnessFocus', 'proteinIntake', 'recreationalDrugTypes',
  'updatedFrom',
]);

function pickAssessmentFields(body) {
  const out = {};
  for (const key of Object.keys(body || {})) {
    if (!ASSESSMENT_FIELDS.has(key)) continue;
    // An unanswered question is dropped rather than kept as null, '' or []. The
    // form posts every field it knows about; a record read back from the
    // database posts the ones the schema happened to write. Those two sets are
    // only the same submission to the reuse gate if "not answered" is expressed
    // the same way in both — which is "absent".
    const value = body[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

router.post('/', protect, async (req, res) => {
  // Declared outside the try so the catch handler can still reach it: this used
  // to be a `const` inside the block, which meant the degraded path threw
  // "liveDynamic is not defined" and the member got a 500 instead of a plan.
  let liveDynamic = [];

  // Canonical answers, also declared outside the try: an assessment that throws
  // halfway must be rescued from the same answers the main path was reading, or
  // the retry after an outage would be scored against a different profile.
  //
  // The signature is hashed from these answers and stored on the assessment, so
  // "the same answers" must mean the same SET of fields too. The form posts
  // derived values that the Assessment schema never keeps (`bmi`,
  // `physicalActivityLevel`), and Update Health Assessment rebuilds its payload
  // from a stored record that has no room for them. Hashed raw, the two
  // submissions were never identical no matter what the member answered, so the
  // reuse gate missed every time and an unchanged update cost a fresh
  // generation. Keeping only what the schema persists makes one submission
  // produce one digest whichever way it was assembled.
  const answers = canonicaliseAnswers(pickAssessmentFields(req.body));

  try {
    const a = req.body;

    // -- Input length guards (prevent prompt injection via oversized fields) --
    const TEXT_MAX = 1000;
    const SHORT_MAX = 200;
    if (a.currentMedications && a.currentMedications.length > TEXT_MAX)
      return res.status(400).json({ message: `Current medications must be ${TEXT_MAX} characters or fewer.` });
    if (a.allergies && a.allergies.length > SHORT_MAX)
      return res.status(400).json({ message: `Allergies must be ${SHORT_MAX} characters or fewer.` });
    if (a.currentSupplements && a.currentSupplements.length > SHORT_MAX)
      return res.status(400).json({ message: `Current supplements must be ${SHORT_MAX} characters or fewer.` });
    if (a.bloodTestResults && a.bloodTestResults.length > TEXT_MAX)
      return res.status(400).json({ message: `Blood test results must be ${TEXT_MAX} characters or fewer.` });
    
    // Preprocess user text inputs. Read from the canonical copy so the string the
    // safety checks see is the one the rules are scored against.
    const processedMedications = sanitizeMedicalField(answers.currentMedications);
    const processedAllergies = sanitizeMedicalField(answers.allergies);
    const processedSupplements = sanitizeMedicalField(answers.currentSupplements);

    // AI-published conditions (60s-cached): the learned knowledge enters BOTH
    // paths — section 9 of the prompt KB for the LLM, and a deterministic
    // bundle merge for the rule fallback — so a published condition behaves
    // identically to a hard-coded one regardless of which engine answers.
    liveDynamic = await getLiveConditions();

    // PMIDs the evidence gate already cleared for AI-published conditions. They
    // are vouchable, so grounding must not strip a citation that quotes them.
    const dynamicPmids = new Set(liveDynamic.flatMap((d) => (d.supplements || [])
      .flatMap((s) => extractPmids(s.evidence))));

    // The clinical rule engine's own answer for THIS profile, de-duplicated per
    // nutrient. This list is the SPINE: it is what the plan will contain, whether
    // the model answers or not, and it is a pure function of these answers — so
    // which supplements a member is offered is decided by rules, not by sampling.
    // It is also the degraded path and the source that refills a slot when
    // grounding deletes a row, so a member never loses an item because a model
    // invented a supplement.
    const spineProfile = { ...answers, currentMedications: processedMedications, allergies: processedAllergies };
    const engineRows = enforcePlanConsistency(generateClinicalFallback(answers, liveDynamic));
    engineRows.recommendations = buildPlanSpine(engineRows.recommendations, spineProfile);
    engineRows.dailySchedule = buildDailySchedule(engineRows.recommendations);
    const clinicalPlan = enforcePlanConsistency(engineRows);

    // Everything the app already knows about THIS member: the plan they are
    // holding, what they reported then versus now, and how they actually followed
    // it. A plan generated from one questionnaire alone cannot say "the fatigue
    // you reported six weeks ago is gone", which is the whole point of retaking
    // one. Declared outside the try so the degraded paths can still see it; a
    // failure here costs the member the nicety, never their results.
    let member = { block: null, previous: null, delta: { newlyReported: [], resolved: [], hasBaseline: false }, adherence: { percent: null } };
    try {
      member = await loadMemberHistory(req.user?._id, {
        ...answers,
        currentMedications: processedMedications,
        allergies: processedAllergies,
        currentSupplements: processedSupplements,
      }, { timeZone: req.headers['x-client-timezone'] || req.user?.timeZone || '' });
    } catch (historyError) {
      console.error('[recommend] member history unavailable, generating without it:', historyError.message);
    }

    // REUSE GATE — these exact answers already produced a finalised plan for
    // this member (a repeated submission, or the same form submitted from the
    // app again), so that plan is what they get. Regenerating identical answers
    // through a sampling model is the single largest source of "I submitted the
    // same thing and got a different plan", and it costs a generation to do it.
    // Only the digest is compared; no answer text is logged or sent to the query.
    const signature = answerSignature(answers, { liveDynamic });
    try {
      const prior = await Assessment.findOne({
        user: req.user?._id,
        'aiResults.planSignature': signature,
      }).sort({ createdAt: -1 }).select('aiResults').lean();
      const stored = prior?.aiResults;
      if (stored && Array.isArray(stored.recommendations) && stored.recommendations.length > 0) {
        console.log(`[recommend] reusing finalised plan ${signature} from assessment ${prior._id}`);
        return res.json(sanitizeStrings({ ...stored, reusedFinalisedPlan: true }));
      }
    } catch (reuseError) {
      // A lookup failure costs the member a regeneration, never their results.
      console.error('[recommend] finalised-plan lookup failed:', reuseError.message);
    }

    // The structured prompt (ROLE / DOMAIN KNOWLEDGE BASE / INSTRUCTIONS /
    // TONE / PATIENT DATA / OUTPUT FORMAT) is built in utils/assessmentPrompt
    // so the benchmark harness (eval/aiBenchmark.js) scores the exact prompt
    // the product sends. Free-text fields are sanitised before interpolation.
    const prompt = buildAssessmentPrompt({
      ...answers,
      currentMedications: processedMedications,
      allergies: processedAllergies,
      currentSupplements: processedSupplements,
      _dynamicKb: kbBlockForPrompt(liveDynamic),
      _historyBlock: member.block || null,
      // Which supplements are in the plan is decided by the rules above, not by
      // the model. The spine is named-only (no member data), and telling the
      // model it means its own reasoning lands on the right row instead of
      // being re-hosted onto one by utils/planSelection.
      _planSpine: clinicalPlan.recommendations,
    });

    // -- Default AI call (assessment) ---------------------------------------
    // Provider, endpoint, model AND fallback all come from the routing table, so
    // this route can no longer drift from the model the admin panel reports —
    // which is exactly what happened when this file, chat.js and polish.js each
    // hard-coded their own model string and two of them disagreed with the
    // panel. It used to resolve one target and hand-roll its own `fetch`, which
    // meant a provider that could not answer sent the whole assessment straight
    // to the rule-based engine without ever trying the next one.
    //
    // `json: true` asks for and parses an object, which is exactly what the
    // parsing below used to do by hand — including the fence-stripping and the
    // "reply was not JSON" case. The router also retries once without JSON mode
    // on a 400, which the hand-rolled version could not.
    const assessment = await completeWithFallback('assessment', {
      system: ASSESSMENT_SYSTEM_PROMPT,
      user: prompt,
      maxTokens: 16000,
      // 0.2, not 0.4. The reviewer requirement is that the same profile
      // produces the same shape of answer run after run; sampling temperature
      // is the dial that trades creativity for that reproducibility, and a
      // clinical plan with a fixed JSON schema is on the reproducibility side.
      // Variety inside the plan (varied sentence openers, per-patient wording)
      // is carried by the prompt's TONE section, not by random sampling.
      temperature: 0.2,
      // Deterministic sampling, where the provider supports it. The seed is
      // derived from the digest of THESE ANSWERS, so the same submission asks for
      // the same walk of the sampling pool and two different members do not share
      // one seed. `top_p: 0.1` narrows the pool to the tokens the model is most
      // confident about, which is what a fixed-schema clinical plan wants.
      //
      // Honest scope: this REDUCES run-to-run variation. It cannot remove it —
      // a gateway may ignore `seed` for a given model, batch differently, or ship
      // a model update — and groq/anthropic have no `seed` field at all, so
      // utils/aiRouter drops it rather than sending a key the vendor 400s on.
      // The part that is actually guaranteed not to vary is WHICH SUPPLEMENTS
      // appear: that is decided in code by utils/planSelection (see SELECTION
      // GATE below), not here.
      seed: seedFromSignature(signature),
      topP: 0.1,
      timeoutMs: 180000, // 3 minutes — the longest single generation in the product
      json: true,
      // `reasoning.effort` is an OpenRouter-GATEWAY field. Scoped by provider key
      // so it is never sent to a provider that would reject it as unknown.
      extraBody: (target) => (target.provider === 'openrouter'
        ? { reasoning: { effort: 'none' } }
        : null),
    });

    let aiResult = null;
    if (assessment.ok && assessment.data) {
      aiResult = assessment.data;
      console.log(`AI result parsed successfully (via ${assessment.provider})`);
    } else if (Array.isArray(assessment.attempts) && assessment.attempts.length) {
      // Name every provider tried and why each one failed. A silent drop to the
      // rule engine is how an exhausted account keeps looking like a working one.
      // The summary, not the raw attempts — a provider that refuses a prompt often
      // quotes the member's answers back, and those are health data.
      console.error(`[recommend] no provider answered: ${JSON.stringify(safeAttemptSummary(assessment.attempts))}`);
    }

    // Use AI result if valid, otherwise rule-based fallback.
    //
    // "Valid" used to mean "has a `recommendations` key", which let
    // `{recommendations: "n/a"}`, a list of nameless rows or a plan with no
    // summary through to the member. validateModelPlan is the shape check;
    // anything it can repair (a missing summary, a row with no name) is taken
    // from the rule engine's answer for the same answers, and only a reply with
    // nothing usable in it at all is discarded.
    const shape = validateModelPlan(aiResult);
    if (!shape.ok && aiResult) {
      console.error(`[recommend] model reply unusable, using rule engine: ${shape.issues.join('; ')}`);
    }
    if (shape.ok) {
      aiResult.recommendations = shape.usable;
      for (const field of ['summary', 'simplifiedSummary', 'wellnessBaseline', 'consultDoctor', 'consultReason']) {
        if (aiResult[field] === undefined || aiResult[field] === null || aiResult[field] === '') {
          aiResult[field] = clinicalPlan[field];
        }
      }
      // SELECTION GATE — the rule engine's list for these answers decides which
      // supplements appear, at which tier and in which order; the model keeps
      // its own wording for each row. This is what makes an identical submission
      // produce an identical set of supplements on every provider, which prompt
      // wording and a low temperature can only make more likely, never certain.
      const aligned = alignPlanToSpine(aiResult, clinicalPlan.recommendations);
      if (aligned.audit.dropped.length) {
        console.log(`[recommend] selection gate dropped ${aligned.audit.dropped.length} off-spine row(s)`);
      }
      aiResult = aligned.plan;
      // Enrich AI recs with fallback evidence/foods/sideEffects if the AI omitted them
      aiResult.recommendations = aiResult.recommendations.map(rec => ({
        ...rec,
        evidence:    rec.evidence    || inferEvidence(rec.name),
        foods:       dietAdjustFoods(rec.foods || inferFoods(rec.name), answers.dietType),
        sideEffects: rec.sideEffects || inferSideEffects(rec.name),
      }));
      // Ensure seekingSupport is injected if user listed drugs (AI may omit it)
      const hasRecDrugs = (answers.lifestyleHabits || []).includes('Recreational Drugs');
      if (hasRecDrugs && (!aiResult.seekingSupport || !aiResult.seekingSupport.include)) {
        aiResult.seekingSupport = buildSeekingSupport();
      }
      // GROUNDING GATE — the prompt asks for real citations, patient-reported
      // triggers and safe doses; this checks them. Anything the app cannot
      // vouch for is replaced from its own curated tables before the reply
      // leaves the server, and `plan.grounding` records what was changed.
      // It runs BEFORE the consistency gate so a backfilled row is ordered too.
      const grounded = groundPlan(aiResult, {
        ...answers,
        currentMedications: processedMedications,
        allergies: processedAllergies,
        currentSupplements: processedSupplements,
      }, {
        trustedRecs: clinicalPlan.recommendations,
        adjustFoods: dietAdjustFoods,
        allowedPmids: dynamicPmids,
      });
      // ADAPTATION GATE — a symptom this member has never reported before is
      // raised to High, and `plan.adaptation` records what the plan did with
      // their history. Runs after grounding (it reads the verified `triggeredBy`
      // text) and before the order gate (a raised row belongs in the High tier).
      // CONSISTENCY GATE — the prompt asks for priority tiers and the canonical
      // nutrient order (Omega-3 before Magnesium); this enforces them, so the
      // item order a member sees is a property of the system, not of the model's
      // sampling luck. It only ever re-orders, never adds or removes.
      //
      // `planSignature` is what lets the next identical submission be answered
      // with this finalised plan instead of a new generation; `selection` is the
      // audit of what the selection gate did with the model's rows.
      const finalised = enforcePlanConsistency(applyAdaptation(grounded, member));
      return res.json(sanitizeStrings({ ...finalised, planSignature: signature, selection: aligned.audit }));
    }

    console.log('Using rule-based clinical fallback');
    // The engine is checked by the same gate it applies to the model: its rows
    // were the source of the fabricated PMIDs this audit found, so "curated" is
    // not a licence to skip verification. It adapts on the same terms, so a
    // degraded plan and an AI plan treat a newly-reported symptom identically.
    const engineGrounded = groundPlan(clinicalPlan, {
      ...answers,
      currentMedications: processedMedications,
      allergies: processedAllergies,
      currentSupplements: processedSupplements,
    }, { adjustFoods: dietAdjustFoods, allowedPmids: dynamicPmids });
    const engineFinalised = enforcePlanConsistency(applyAdaptation(engineGrounded, member));
    // Stamped on the degraded path too: an engine plan is just as finalised as
    // an AI one, and a member who retries after a provider outage should not get
    // a different plan than the one they were already shown.
    return res.json(sanitizeStrings({ ...engineFinalised, planSignature: signature }));

  } catch (error) {
    console.error('Recommend route error:', error.message);
    // Same spine as every other path, so a member whose request threw halfway
    // through is not handed a shorter or differently-ordered plan.
    const rescue = enforcePlanConsistency(generateClinicalFallback(answers, liveDynamic));
    rescue.recommendations = buildPlanSpine(rescue.recommendations, answers || {});
    rescue.dailySchedule = buildDailySchedule(rescue.recommendations);
    return res.json(sanitizeStrings(enforcePlanConsistency(rescue)));
  }
});

// -- Clinical rule-based fallback -------------------------------------------

// -- Seeking Support block (drug use) --
function buildSeekingSupport() {
  return {
    include: true,
    title: 'Seeking Support',
    intro: 'Prolonged use of many recreational substances can alter brain chemistry, deplete key nutrients (including B vitamins, magnesium, and zinc), and increase the risk of substance use disorder. This is shared without judgment -- confidential support and recovery resources are available in the Philippines for anyone who needs them.',
    resources: [
      {
        label: 'Crisis Helpline',
        name: 'DOH Substance Abuse Helpline -- Call 1550',
        description: 'Free and confidential Department of Health hotline for individuals dealing with substance abuse. Provides treatment referrals, psychosocial support, and information on rehabilitation services.',
        url: 'https://doh.gov.ph/press-release/doh-launches-substance-abuse-1550-helpline/',
      },
      {
        label: 'Government Agency',
        name: 'Dangerous Drugs Board (DDB)',
        description: 'The primary Philippine government body for drug prevention and control. Provides education, treatment referrals, and information on rehabilitation programs nationwide.',
        url: 'https://ddb.gov.ph',
      },
      {
        label: 'Rehabilitation & Reintegration',
        name: 'DSWD Yakap Bayan Program',
        description: 'A DSWD program providing comprehensive services to recovering persons who used drugs (RPWUDs), supporting their reintegration into family and community.',
        url: 'https://assistance.ph/dswd-yakap-bayan-program/',
      },
      {
        label: 'Mental Health Crisis Line',
        name: 'NCMH Crisis Hotline -- Call 1553',
        description: 'Free 24/7 National Center for Mental Health hotline supporting substance use, emotional distress, and co-occurring mental health concerns. Call 1553.',
        url: 'https://ncmh.gov.ph',
      },
    ],
  };
}

function generateClinicalFallback(a, liveDynamic = []) {
  // Helper function to check allergies
  const hasAllergy = (substance) => {
    const allergies = (a.allergies || '').toLowerCase();
    if (!allergies || allergies === 'none known' || allergies === 'not specified') return false;
    const allergyTerms = substance.toLowerCase().split('|');
    return allergyTerms.some(term => allergies.includes(term.trim()));
  };

  // Helper function to check if already taking supplement
  const alreadyTaking = (suppName) => {
    const currentSupps = (a.currentSupplements || '').toLowerCase();
    if (!currentSupps || currentSupps === 'none reported' || currentSupps === 'not specified') return false;
    const suppTerms = suppName.toLowerCase().split('|');
    return suppTerms.some(term => currentSupps.includes(term.trim()));
  };

  // Interpret blood test results
  const bloodTest = (a.recentBloodTest || '').toLowerCase();
  const bloodTestShows = {
    lowIron: /low.*iron|anemi|ferritin.*low|iron.*deficien/i.test(bloodTest),
    lowVitD: /low.*vitamin d|vitamin d.*low|d.*deficien/i.test(bloodTest),
    lowB12: /low.*b12|b12.*low|cobalamin.*low/i.test(bloodTest),
    highCholesterol: /high.*cholesterol|cholesterol.*high|hyperlipid/i.test(bloodTest),
    thyroidIssue: /thyroid|tsh|hypothyroid|hyperthyroid/i.test(bloodTest),
    normalIron: /iron.*normal|ferritin.*normal/i.test(bloodTest),
    normalVitD: /vitamin d.*normal|d.*normal/i.test(bloodTest),
    normalB12: /b12.*normal|cobalamin.*normal/i.test(bloodTest),
  };

  const recs = [];
  const symptoms = (a.symptoms || []).filter(s => s !== 'No current symptoms');
  const symptomSeverity = a.symptomSeverity || {};
  const goals = a.healthGoals || [];
  const diet = a.dietType || '';
  const conditions = a.medicalConditions?.filter(c => c !== 'None') || [];
  const meds = (a.currentMedications || '').toLowerCase();
  const allergies = (a.allergies || '').toLowerCase();
  const stressLevel = a.stressLevel || '';
  const sleepQuality = a.sleepQuality || '';
  const waterIntake = a.waterIntake || '';
  const lifestyleHabits = a.lifestyleHabits || [];
  const pregnancyStatus = a.pregnancyStatus || '';
  const isPregnant = pregnancyStatus === 'Pregnant';
  const isBreastfeeding = pregnancyStatus === 'Breastfeeding';
  const warnings = [];
  const avoidList = [];
  const lifestyleAdvice = [];
  const actionPlan = [];

  const age = Number(a.age) || 0;
  const onBloodThinner = /warfarin|coumadin|eliquis|xarelto/.test(meds);
  const onStatin = /statin|atorvastatin|simvastatin|rosuvastatin|lipitor|crestor/.test(meds);
  const onThyroid = /levothyroxine|synthroid|thyroid/.test(meds);
  const onMetformin = meds.includes('metformin');
  const onAntidepressant = /ssri|sertraline|fluoxetine|escitalopram|prozac|zoloft/.test(meds);
  const onACE = /lisinopril|enalapril|ramipril/.test(meds);

  // -- Pregnancy / Breastfeeding safeguards --
  const weight = Number(a.weight) || 0;
  const height = Number(a.height) || 0;

  // -- Insufficient data check --
  const hasBasics = age > 0 && a.gender && weight > 0 && height > 0;
  const hasSymptomOrGoal = symptoms.length > 0 || goals.length > 0;
  const isPartialData = !hasBasics || !hasSymptomOrGoal;

  // -- Age group classification --
  const isInfantToddler = age > 0 && age <= 3;
  const isChild = age >= 4 && age <= 12;
  const isTeen = age >= 13 && age <= 17;
  const isAdult = age >= 18 && age <= 64;
  const isSenior = age >= 65;

  // -- Infants/Toddlers (0-3): Do not recommend adult supplements --
  if (isInfantToddler) {
    return {
      summary: `This ${age}-year-old patient is an infant or toddler. Supplement and nutritional needs at this age are highly specialized and must be managed exclusively by a pediatrician or registered dietitian. Self-supplementation is not appropriate for children under 4 years of age.`,
      recommendations: [
        {
          name: 'Vitamin D drops (pediatric)',
          reason: 'The American Academy of Pediatrics recommends 400 IU of Vitamin D daily for all breastfed infants from birth. Formula-fed infants consuming less than 1L/day of formula also require supplementation.',
          dosage: '400 IU daily (pediatric drops)',
          timing: 'Once daily, can be added to breast milk or formula',
          priority: 'High',
          interactions: 'Use only pediatric-formulated drops. Consult pediatrician before starting.'
        }
      ],
      lifestyleAdvice: [
        { category: 'Nutrition', advice: 'Breast milk or iron-fortified formula should be the primary nutrition source for infants under 12 months. Introduce solid foods around 6 months under pediatric guidance.' },
        { category: 'Medical', advice: 'All nutritional supplementation for children under 4 must be prescribed or approved by a licensed pediatrician. Do not administer adult supplements to young children.' }
      ],
      actionPlan: [
        'Consult your child\'s pediatrician before giving any supplement.',
        'Ensure regular well-child visits to monitor growth and nutritional status.',
        'Follow age-appropriate feeding guidelines from your healthcare provider.'
      ],
      warnings: ['Children under 4 years old should NOT receive adult supplement doses. Always consult a pediatrician.'],
      avoidList: ['All adult-dose supplements � dosages are unsafe for infants and toddlers'],
      disclaimer: 'These recommendations are for informational purposes only. For children under 4, all supplementation must be supervised by a licensed pediatrician.'
    };
  }

  // -- Children (4-12): Pediatric-appropriate only --
  if (isChild) {
    warnings.push('All supplements for children aged 4-12 should be in pediatric formulations and doses. Consult a pediatrician before starting any supplement regimen.');
    recs.push({ name: 'Children\'s Multivitamin', reason: 'A complete pediatric multivitamin covers common nutritional gaps in children\'s diets, supporting healthy growth, immune function, and cognitive development.', dosage: '1 pediatric serving daily (per label)', timing: 'With breakfast', priority: 'High', interactions: 'Use age-appropriate pediatric formulation only' });
    recs.push({ name: 'Vitamin D3 (pediatric)', reason: 'Vitamin D deficiency is common in children and critical for bone development, immune function, and mood regulation. Most children do not get adequate sun exposure.', dosage: '600-1000 IU daily (pediatric)', timing: 'With a meal containing fat', priority: 'High', interactions: 'None identified at pediatric doses' });
    recs.push({ name: 'Omega-3 (children\'s DHA)', reason: 'DHA is essential for brain development and cognitive function in growing children. Supports focus, learning, and mood stability.', dosage: '250-500mg DHA daily (children\'s formulation)', timing: 'With meals', priority: 'Medium', interactions: 'None identified at pediatric doses' });
    if (symptoms.includes('Frequent Colds') || goals.includes('Boost Immunity'))
      recs.push({ name: 'Zinc (pediatric)', reason: 'Zinc supports immune function and reduces the duration of colds in children. Essential for growth and wound healing.', dosage: '5-10mg daily (pediatric dose)', timing: 'With meals', priority: 'Medium', interactions: 'Use pediatric dose only � adult doses are too high for children' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'Ensure a balanced diet with fruits, vegetables, whole grains, lean protein, and dairy. Limit processed foods, sugary drinks, and excessive screen time during meals.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Children need at least 60 minutes of moderate-to-vigorous physical activity daily. Encourage outdoor play, sports, and active games to support healthy development.' });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Children aged 6-12 need 9-12 hours of sleep per night. Establish a consistent bedtime routine and limit screens at least 1 hour before bed.' });
  actionPlan.push({ phase: 'Week 1 -- Start Safely', focus: 'Consult pediatrician and introduce the safest foundational supplements.', supplements: ['Children Multivitamin', 'Vitamin D3 (pediatric)'], habits: ['Establish consistent meal times', 'Limit sugary snacks and drinks'], activity: ['60 minutes of active play daily', 'Outdoor activities'], expectedChanges: ['Improved appetite', 'Better energy for play'] });
  actionPlan.push({ phase: 'Week 2-3 -- Monitor & Adjust', focus: 'Monitor tolerance and maintain consistent routine.', supplements: ['Continue multivitamin and Vitamin D'], habits: ['Consistent bedtime routine', 'Balanced meals with fruits and vegetables'], activity: ['Continue active play', 'Encourage sports or group activities'], expectedChanges: ['Improved sleep', 'Better mood and energy'] });
  actionPlan.push({ phase: 'Month 2 -- Assess Growth & Immunity', focus: 'Evaluate immunity and energy improvements.', supplements: ['Add Omega-3 DHA if approved by pediatrician'], habits: ['Maintain all established habits'], activity: ['Maintain 60 min/day active play'], expectedChanges: ['Fewer colds or faster recovery', 'Improved focus and learning'] });
  actionPlan.push({ phase: 'Month 3+ -- Long-Term Healthy Development', focus: 'Sustain healthy habits and schedule well-child visit.', supplements: ['Schedule well-child visit to check nutritional status and growth milestones'], habits: ['Annual nutritional review with pediatrician'], activity: ['Continue regular physical activity'], expectedChanges: ['Healthy growth milestones', 'Strong immune system', 'Good energy and focus for school'] });
    return buildResult(a, recs, lifestyleAdvice, actionPlan, warnings, avoidList, conditions, symptoms, goals);
  }

  // -- Teens (13-17): Adolescent-appropriate --
  if (isTeen) {
    warnings.push('Adolescents should consult a healthcare provider before starting supplements, especially if involved in sports or taking medications.');
    // Teen-specific baseline
    recs.push({ name: 'Vitamin D3', reason: 'Adolescence is a critical period for bone density development. Vitamin D deficiency is extremely common in teenagers due to indoor lifestyles and is linked to poor mood, fatigue, and weakened immunity.', dosage: '1000-2000 IU daily', timing: 'With a meal containing fat', priority: 'High', interactions: 'None identified' });
    if (a.gender === 'Female')
      recs.push({ name: 'Iron (as Iron Bisglycinate)', reason: 'Adolescent females have significantly increased iron requirements due to menstruation. Iron deficiency is the most common nutritional deficiency in teenage girls and causes fatigue, poor concentration, and reduced athletic performance.', dosage: '18mg daily', timing: 'Morning with Vitamin C on empty stomach', priority: 'High', interactions: 'None identified' });
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is critical during adolescent growth spurts and is commonly deficient. Supports bone development, muscle function, sleep quality, and stress management � all key concerns for teenagers.', dosage: '200-300mg daily', timing: 'Evening with dinner', priority: 'Medium', interactions: 'None identified' });
    if (symptoms.includes('Anxiety/Stress') || symptoms.includes('Brain Fog'))
      recs.push({ name: 'Omega-3 (Fish Oil or Algae)', reason: 'DHA supports brain development which continues through age 25. Particularly important for academic performance, mood stability, and reducing anxiety in adolescents.', dosage: '500-1000mg DHA+EPA daily', timing: 'With meals', priority: 'Medium', interactions: 'None identified' });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Teenagers need 8-10 hours of sleep per night. Adolescent circadian rhythms naturally shift later, but consistent sleep schedules are critical for mental health, academic performance, and physical development.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Aim for 60 minutes of moderate-to-vigorous activity daily. Resistance training 2-3x/week supports bone density and healthy body composition during this critical growth period.' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'Adolescents need increased calcium (1300mg/day), protein, and iron. Prioritize dairy or fortified alternatives, lean proteins, and iron-rich foods. Avoid skipping meals, especially breakfast.' });
  actionPlan.push({ phase: 'Week 1 -- Build Foundations', focus: 'Start with the most impactful supplements for adolescent health.', supplements: ['Vitamin D3', 'Magnesium Glycinate'], habits: ['Establish consistent meal times', 'Reduce screen time before bed'], activity: ['60 minutes of moderate activity daily', 'Outdoor play or sports'], expectedChanges: ['Slight improvement in sleep', 'Reduced muscle tension'] });
  actionPlan.push({ phase: 'Week 2-3 -- Support Energy & Focus', focus: 'Add targeted supplements and increase physical activity.', supplements: recs.filter(r => r.priority === 'Medium').map(r => r.name), habits: ['Increase calcium-rich foods', 'Prioritize breakfast daily'], activity: ['Add resistance training 2x/week', 'Active commuting or sports'], expectedChanges: ['Better focus and academic performance', 'Improved mood stability'] });
  actionPlan.push({ phase: 'Month 2 -- Assess Progress', focus: 'Evaluate energy, mood, and sleep improvements.', supplements: ['Continue full supplement routine'], habits: ['Maintain consistent sleep schedule', 'Balanced nutrition with lean proteins and vegetables'], activity: ['Maintain 60 min/day activity'], expectedChanges: ['Measurable improvement in energy and mood', 'Better sleep quality'] });
  actionPlan.push({ phase: 'Month 3+ -- Long-Term Health', focus: 'Sustain healthy habits and reassess with a healthcare provider.', supplements: ['Consult doctor to check Vitamin D and iron levels via blood test'], habits: ['Maintain all established habits', 'Annual nutritional check-up'], activity: ['Continue regular physical activity'], expectedChanges: ['Sustained energy and focus', 'Strong bone development', 'Healthy growth milestones'] });
    return buildResult(a, recs, lifestyleAdvice, actionPlan, warnings, avoidList, conditions, symptoms, goals);
  }

  // -- Senior (65+): Age-adjusted priorities --
  if (isSenior) {
    warnings.push('Adults over 65 should consult their physician before starting supplements, as absorption, metabolism, and drug interactions change significantly with age.');
    recs.push({ name: 'Vitamin D3 + K2', reason: 'Vitamin D deficiency is common in adults over 65 and is directly linked to falls, fractures, cognitive decline, and immune dysfunction. K2 (MK-7) directs calcium to bones rather than arteries, critical for cardiovascular health in older adults.', dosage: '2000-4000 IU D3 + 100-200mcg K2 daily', timing: 'With largest meal', priority: 'High', interactions: onBloodThinner ? 'K2 may interact with warfarin � consult doctor' : 'None identified' });
    recs.push({ name: 'Calcium Citrate', reason: 'Bone density declines accelerate after 65. Calcium citrate is better absorbed than carbonate in older adults with reduced stomach acid. Essential for fracture prevention.', dosage: '500mg twice daily (do not exceed 1200mg total)', timing: 'With meals, split into two doses', priority: 'High', interactions: onThyroid ? 'Take 4+ hours away from thyroid medication' : 'None identified' });
    recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'Gastric acid production declines with age, significantly reducing B12 absorption from food. Deficiency in seniors causes cognitive decline, neuropathy, and anemia � often misdiagnosed as dementia.', dosage: '1000mcg daily (sublingual preferred)', timing: 'Morning, sublingual for best absorption', priority: 'High', interactions: onMetformin ? 'Critical � metformin further depletes B12' : 'None identified' });
    recs.push({ name: 'Omega-3 (EPA+DHA)', reason: 'Strong evidence for reducing cardiovascular risk, inflammation, cognitive decline, and depression in older adults. EPA reduces inflammation while DHA protects brain structure.', dosage: '1000-2000mg EPA+DHA daily', timing: 'With meals', priority: 'High', interactions: onBloodThinner ? 'Use 1g max on blood thinners � monitor INR' : 'None identified' });
    recs.push({ name: 'CoQ10 (Ubiquinol)', reason: 'CoQ10 production declines with age. Ubiquinol (active form) supports heart function, energy production, and reduces oxidative stress. Particularly important for seniors on statins.', dosage: '100-200mg daily', timing: 'With fat-containing meal', priority: 'Medium', interactions: onStatin ? 'Essential � statins further deplete CoQ10' : 'None identified' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Resistance training 2-3x/week is the single most important intervention for healthy aging � prevents muscle loss (sarcopenia), maintains bone density, and reduces fall risk. Balance exercises like tai chi reduce falls.' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'Protein needs increase with age to prevent muscle loss. Aim for 1.2-1.6g protein per kg body weight daily. Prioritize leucine-rich proteins (eggs, fish, dairy) which most effectively stimulate muscle synthesis.' });
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Thirst sensation diminishes with age, making dehydration common and dangerous in seniors. Drink 6-8 glasses of water daily regardless of thirst. Dehydration worsens cognitive function, constipation, and fall risk.' });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Sleep architecture changes with age � less deep sleep, more frequent waking. Maintain consistent sleep/wake times, limit naps to 20 minutes before 3pm, and avoid alcohol which fragments sleep quality.' });
  actionPlan.push({ phase: 'Week 1 -- Build Foundations', focus: 'Start with the most critical supplements for senior health.', supplements: ['Vitamin D3 + K2', 'Vitamin B12 (Methylcobalamin)'], habits: ['Drink 6-8 glasses of water daily', 'Establish consistent meal and sleep times'], activity: ['10-15 minute daily walks', 'Chair-based stretching exercises'], expectedChanges: ['Slight improvement in energy', 'Reduced fatigue'] });
  actionPlan.push({ phase: 'Week 2-3 -- Support Bone & Heart Health', focus: 'Add bone and cardiovascular support supplements.', supplements: ['Calcium Citrate', 'Omega-3 (EPA+DHA)'], habits: ['Increase calcium-rich foods', 'Reduce sodium intake'], activity: ['20-30 minutes of daily movement', 'Balance exercises to reduce fall risk'], expectedChanges: ['Reduced joint stiffness', 'Improved cardiovascular comfort'] });
  actionPlan.push({ phase: 'Month 2 -- Build Strength & Clarity', focus: 'Increase physical activity and assess cognitive and physical improvements.', supplements: ['Add CoQ10 if on statins', 'Continue full routine'], habits: ['Maintain consistent supplement schedule', 'Social engagement for cognitive health'], activity: ['Begin resistance training 2x/week', 'Even chair-based exercises improve strength significantly'], expectedChanges: ['Improved cognitive clarity', 'Better bone and cardiovascular health', 'Increased strength'] });
  actionPlan.push({ phase: 'Month 3+ -- Long-Term Maintenance', focus: 'Sustain progress with quarterly medical check-ins.', supplements: ['Schedule quarterly review with doctor', 'Check Vitamin D, B12, and bone density labs'], habits: ['Maintain all established habits', 'Annual comprehensive health review'], activity: ['Maintain regular exercise routine'], expectedChanges: ['Sustained bone density protection', 'Stable cognitive function', 'Reduced fall risk and improved quality of life'] });
    return buildResult(a, recs, lifestyleAdvice, actionPlan, warnings, avoidList, conditions, symptoms, goals);
  }

  // -- Medication flags --
  if (isPregnant || isBreastfeeding) {
    warnings.push(`${isPregnant ? 'Pregnancy' : 'Breastfeeding'}: Supplement needs are significantly different. Prioritize prenatal vitamins with folate (400-800mcg), iron, DHA, and iodine. Avoid high-dose Vitamin A (>10,000 IU), herbal supplements (ashwagandha, St. John's Wort, valerian), and high-dose Vitamin D without medical supervision.`);
    avoidList.push('Ashwagandha � avoid during pregnancy/breastfeeding');
    avoidList.push('St. John\'s Wort � avoid during pregnancy/breastfeeding');
    avoidList.push('High-dose Vitamin A (>10,000 IU) � teratogenic risk');
    recs.push({ name: 'Prenatal Multivitamin with Methylfolate', reason: `${isPregnant ? 'Pregnancy' : 'Breastfeeding'} significantly increases requirements for folate, iron, iodine, and DHA. A comprehensive prenatal multivitamin covers these critical needs.`, dosage: '1 serving daily per label', timing: 'With food to reduce nausea', priority: 'High', interactions: 'Use prenatal-specific formulation only' });
    recs.push({ name: 'Algae-based DHA (prenatal)', reason: 'DHA is critical for fetal brain and eye development. Algae-based DHA is the safest form during pregnancy, avoiding mercury concerns from fish oil.', dosage: '200-300mg DHA daily', timing: 'With meals', priority: 'High', interactions: 'None identified at recommended doses' });
  }

  // -- Lifestyle habit safeguards --
  if (lifestyleHabits.includes('Smoking')) {
    warnings.push('Smoking significantly depletes Vitamin C, Vitamin E, and antioxidants. Higher doses of antioxidants are recommended. Smoking also increases cardiovascular risk � prioritize heart-protective supplements.');
    recs.push({ name: 'Vitamin C (as Ascorbic Acid)', reason: 'Smokers require 35mg more Vitamin C daily than non-smokers per NIH guidelines. Smoking depletes antioxidant reserves rapidly, increasing oxidative stress and cardiovascular risk.', dosage: '500-1000mg daily', timing: 'With meals, split into 2 doses', priority: 'High', interactions: 'None identified' });
    recs.push({ name: 'N-Acetyl Cysteine (NAC)', reason: 'NAC is a precursor to glutathione, the body\'s master antioxidant. Smoking depletes glutathione significantly. NAC also supports lung health and mucus clearance.', dosage: '600mg twice daily', timing: 'With meals', priority: 'Medium', interactions: 'None identified' });
  }
  if (lifestyleHabits.includes('Alcohol')) {
    warnings.push('Regular alcohol consumption depletes B vitamins (especially B1, B6, B12, folate), magnesium, and zinc. These should be prioritized in your supplement plan.');
    if (!recs.find(r => r.name.includes('B12')))
      recs.push({ name: 'Vitamin B Complex (B1, B6, B12, Folate)', reason: 'Alcohol directly impairs absorption and increases excretion of B vitamins. Deficiency causes fatigue, neuropathy, and cognitive decline. A complete B complex addresses all alcohol-depleted B vitamins.', dosage: '1 B-complex daily', timing: 'Morning with breakfast', priority: 'High', interactions: 'None identified' });
  }

  // -- Stress level logic --
  if (stressLevel === 'High' || stressLevel === 'Severe') {
    if (!recs.find(r => r.name.includes('Ashwagandha')) && !onAntidepressant && !isPregnant && !isBreastfeeding)
      recs.push({ name: 'Ashwagandha (KSM-66)', reason: `${stressLevel} stress level detected. KSM-66 ashwagandha has the strongest clinical evidence among adaptogens for cortisol and perceived stress; randomised trials report lower cortisol and less perceived stress versus placebo.`, dosage: stressLevel === 'Severe' ? '600mg daily' : '300-600mg daily', timing: 'Morning or evening with food', priority: stressLevel === 'Severe' ? 'High' : 'Medium', interactions: 'None identified', triggeredBy: `${stressLevel} stress level reported` });
    if (!recs.find(r => r.name.includes('Magnesium')))
      recs.push({ name: 'Magnesium Glycinate', reason: 'Chronic stress rapidly depletes magnesium stores. Magnesium is essential for the stress response and GABA activation. Glycinate form crosses the blood-brain barrier effectively.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified', triggeredBy: `${stressLevel} stress level reported` });
    lifestyleAdvice.push({ category: 'Stress Management', advice: stressLevel === 'Severe' ? 'Severe stress requires immediate intervention. Consider speaking with a mental health professional. Daily practices: 15-20 minutes of mindfulness meditation, journaling, and at least one screen-free hour. Chronic severe stress is linked to adrenal fatigue, immune suppression, and cardiovascular disease.' : 'Practice daily stress management: 10 minutes of mindfulness meditation, 4-7-8 breathing (inhale 4s, hold 7s, exhale 8s), and regular physical activity. Chronic stress depletes magnesium, B vitamins, and Vitamin C.' });
  } else if (stressLevel === 'Moderate') {
    recs.push({ name: 'L-Theanine', reason: 'Moderate stress detected. L-Theanine promotes calm alertness by increasing alpha brain waves without causing drowsiness. Particularly effective for daily stress management.', dosage: '200mg daily', timing: 'Morning or during stressful periods', priority: 'Medium', interactions: onAntidepressant ? 'Safe with SSRIs' : 'None identified', triggeredBy: 'Moderate stress level reported' });
  }

  // -- Sleep quality logic --
  if (sleepQuality === 'Very Poor' || sleepQuality === 'Poor') {
    if (!recs.find(r => r.name.includes('Magnesium')))
      recs.push({ name: 'Magnesium Glycinate', reason: `${sleepQuality} sleep quality detected. Magnesium glycinate activates GABA receptors to quiet the nervous system. It is the most clinically studied supplement for sleep quality improvement.`, dosage: sleepQuality === 'Very Poor' ? '400mg daily' : '300-400mg daily', timing: '30-60 minutes before bed', priority: sleepQuality === 'Very Poor' ? 'High' : 'High', interactions: 'None identified', triggeredBy: `${sleepQuality} sleep quality reported` });
    recs.push({ name: 'Melatonin (low dose)', reason: `${sleepQuality} sleep quality reported. Low-dose melatonin helps reset the circadian rhythm and reduce sleep onset time. Lower doses (0.5-1mg) are more physiologically appropriate than high doses.`, dosage: '0.5�1mg', timing: '30 minutes before target bedtime', priority: 'Medium', interactions: 'Avoid with sedatives or alcohol', triggeredBy: `${sleepQuality} sleep quality reported` });
    lifestyleAdvice.push({ category: 'Sleep', advice: sleepQuality === 'Very Poor' ? 'Very poor sleep requires a structured sleep hygiene protocol: strict consistent bedtime/wake time (even weekends), bedroom temperature 65-68�F/18-20�C, complete darkness, no screens 1 hour before bed, no caffeine after 1pm, and no alcohol (it fragments sleep architecture). Consider a sleep study if this persists.' : 'Improve sleep quality: consistent sleep schedule, dark and cool bedroom, avoid screens 1 hour before bed, limit caffeine after 2pm. Try 4-7-8 breathing to fall asleep faster.' });
  }

  // -- Water intake logic --
  if (waterIntake === '<1L') {
    warnings.push('Very low water intake (<1L/day) detected. Chronic dehydration causes fatigue, brain fog, headaches, poor digestion, and impaired kidney function. Aim for at least 2L daily.');
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Critical: You are significantly under-hydrated. Start each morning with 500ml of water before coffee. Set hourly reminders to drink. Aim for 2-3L daily. Dehydration mimics fatigue, brain fog, and hunger � many symptoms may improve with adequate hydration alone.' });
  } else if (waterIntake === '1�2L') {
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Your water intake is below optimal. Aim for 2-3L daily. Carry a 1L water bottle and refill it twice. Add electrolytes (sodium, potassium, magnesium) if you exercise or sweat heavily.' });
  }

  if (onBloodThinner) {
    warnings.push('IMPORTANT: You are on a blood thinner. High-dose Vitamin K, fish oil >1g, CoQ10, and Vitamin E can affect INR. Consult your doctor before any supplement.');
    avoidList.push('High-dose Vitamin K (interferes with warfarin)');
    avoidList.push('Fish oil >3g daily (bleeding risk on blood thinners)');
  }
  if (onStatin) {
    warnings.push('Statins deplete CoQ10. Supplementation is strongly recommended to prevent muscle fatigue.');
    recs.unshift({ name: 'CoQ10 (Ubiquinol)', reason: 'Statins deplete CoQ10 essential for cellular energy and heart function. Ubiquinol is the active form with superior absorption, especially for patients over 40.', dosage: '100-200mg daily', timing: 'With largest fat-containing meal', priority: 'High', interactions: 'Directly counteracts statin-induced CoQ10 depletion' });
  }
  if (onThyroid) {
    warnings.push('Levothyroxine absorption is reduced by calcium, iron, and magnesium. Take thyroid medication on empty stomach, wait 4 hours before these supplements.');
    recs.push({ name: 'Selenium (Selenomethionine)', reason: 'Essential for T4-to-T3 thyroid hormone conversion. Deficiency worsens hypothyroid symptoms. Selenomethionine is the most bioavailable form.', dosage: '100-200mcg daily', timing: 'With breakfast, 4+ hours after thyroid medication', priority: 'High', interactions: 'Safe with levothyroxine when timed correctly' });
  }
  if (onMetformin) {
    warnings.push('Metformin depletes B12 over time. B12 supplementation is clinically recommended for all long-term metformin users.');
    recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'Metformin blocks B12 gut absorption. Long-term deficiency causes neuropathy, fatigue, and cognitive decline. Methylcobalamin is the neurologically active form.', dosage: '1000mcg daily', timing: 'Morning with breakfast', priority: 'High', interactions: 'Counteracts metformin-induced B12 depletion' });
  }
  if (onAntidepressant) {
    warnings.push('On SSRI antidepressant: Avoid St. John\'s Wort and 5-HTP � serotonin syndrome risk. Magnesium and omega-3 are safe and beneficial.');
    avoidList.push('St. John\'s Wort (serotonin syndrome risk with SSRIs)');
    avoidList.push('5-HTP (serotonin syndrome risk with SSRIs)');
  }

  // -- Allergy checks --
  if (/fish|seafood/.test(allergies)) avoidList.push('Fish oil / krill oil � use algae-based omega-3 instead');
  if (allergies.includes('soy')) avoidList.push('Soy-based supplements and protein powders');
  if (/gluten|celiac/.test(allergies)) warnings.push('Celiac/gluten sensitivity: Always verify supplements are certified gluten-free.');

  // -- Condition-based --
  if (conditions.includes('Kidney Disease')) {
    warnings.push('Kidney disease: Avoid high-dose potassium, magnesium >200mg, phosphorus, and Vitamin C >500mg. Supplement only under nephrologist supervision.');
    avoidList.push('High-dose potassium (dangerous with kidney disease)');
    avoidList.push('Magnesium >200mg (accumulates with reduced kidney function)');
    avoidList.push('Vitamin C >500mg (oxalate buildup risk)');
  }
  if (conditions.includes('Diabetes')) {
    recs.push({ name: 'Berberine', reason: 'Clinical evidence shows berberine improves insulin sensitivity comparable to metformin. Particularly beneficial for Type 2 diabetes blood glucose management.', dosage: '500mg twice daily with meals', timing: 'With breakfast and dinner', priority: 'High', interactions: 'Enhances blood sugar lowering � monitor glucose closely with doctor' });
    recs.push({ name: 'Alpha-Lipoic Acid (ALA)', reason: 'Improves insulin sensitivity and reduces diabetic neuropathy symptoms including tingling and numbness.', dosage: '600mg daily', timing: 'Before meals', priority: 'Medium', interactions: 'May lower blood sugar � monitor glucose when starting' });
    warnings.push('Diabetes: Berberine and ALA lower blood sugar. Monitor glucose closely and inform your doctor.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Follow a low-glycemic diet. Prioritize fiber-rich vegetables, legumes, and whole grains. Limit refined carbohydrates and sugary drinks. Eat smaller, more frequent meals to stabilize blood sugar.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Aim for 30 minutes of moderate exercise 5 days/week. Even a 10-minute walk after meals significantly reduces post-meal blood sugar spikes.' });
  }
  if (conditions.includes('High Blood Pressure')) {
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium deficiency is common in hypertension. Relaxes blood vessel walls with clinical evidence for blood pressure reduction. Glycinate avoids digestive side effects.', dosage: '400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: onACE ? 'Safe with ACE inhibitors � monitor potassium' : 'Inform your doctor' });
    recs.push({ name: 'CoQ10', reason: 'CoQ10 levels fall with statin therapy, and supplementing restores them; blood-pressure effects are studied but not settled. Essential for heart muscle energy.', dosage: '100-200mg daily', timing: 'With fat-containing meal', priority: 'High', interactions: 'May enhance antihypertensive effect � monitor BP' });
    warnings.push('High blood pressure: CoQ10 and magnesium can lower BP. Monitor and inform your doctor.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Follow the DASH diet: reduce sodium to <2300mg/day, increase potassium-rich foods (bananas, sweet potatoes, spinach), limit alcohol, and avoid processed foods.' });
    lifestyleAdvice.push({ category: 'Stress', advice: 'Chronic stress directly raises blood pressure. Practice daily deep breathing (4-7-8 technique), meditation, or progressive muscle relaxation for 10-15 minutes.' });
  }
  if (conditions.includes('Heart Disease')) {
    recs.push({ name: 'Omega-3 (EPA+DHA, pharmaceutical grade)', reason: 'Strongest cardiovascular evidence of any supplement � reduces triglycerides, inflammation, and cardiac event risk.', dosage: '2000-4000mg EPA+DHA daily', timing: 'With meals', priority: 'High', interactions: onBloodThinner ? 'Use with caution on blood thinners � discuss with cardiologist' : 'Inform cardiologist' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Cardiac rehabilitation exercise is essential. Start with 20-30 minutes of low-intensity walking daily, gradually increasing. Always follow your cardiologist\'s exercise guidelines.' });
  }

  // -- New conditions --
  if (conditions.includes('Anemia')) {
    recs.push({ name: 'Iron Bisglycinate + Vitamin C', reason: 'Anemia reported. Iron bisglycinate is the most absorbable and gentlest form. Vitamin C co-administration triples absorption. Essential for red blood cell production.', dosage: '25-50mg iron + 500mg Vitamin C daily', timing: 'Morning on empty stomach, away from coffee/tea', priority: 'High', interactions: 'Take 4+ hours from thyroid medication if applicable', triggeredBy: 'Anemia reported' });
    recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'B12 deficiency is a common cause of megaloblastic anemia. Methylcobalamin is the neurologically active form with superior absorption.', dosage: '1000mcg daily (sublingual preferred)', timing: 'Morning', priority: 'High', interactions: 'None identified', triggeredBy: 'Anemia reported' });
    recs.push({ name: 'Folate (Methylfolate)', reason: 'Folate deficiency causes megaloblastic anemia. Methylfolate bypasses MTHFR gene variants that impair folic acid conversion.', dosage: '400-800mcg daily', timing: 'With breakfast', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Anemia reported' });
    warnings.push('Anemia: Iron supplementation should be guided by blood test results (ferritin, hemoglobin). Do not exceed 45mg iron/day without medical supervision.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Eat iron-rich foods with Vitamin C at every meal: spinach with lemon, lentils with tomatoes, red meat with bell peppers. Avoid coffee and tea within 1 hour of iron-rich meals as tannins block absorption.' });
  }
  if (conditions.includes('PCOS')) {
    recs.push({ name: 'Inositol (Myo-Inositol + D-Chiro-Inositol 40:1)', reason: 'The 40:1 ratio is the most clinically validated supplement for PCOS. Improves insulin sensitivity, restores ovulation, and reduces androgen levels.', dosage: '4g myo-inositol + 100mg D-chiro-inositol daily', timing: 'Split into 2 doses with meals', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium deficiency is common in PCOS and worsens insulin resistance. Supports hormonal balance and reduces anxiety.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    recs.push({ name: 'Vitamin D3', reason: 'Vitamin D deficiency is common in women with PCOS and is directly linked to insulin resistance and hormonal imbalance.', dosage: '2000-4000 IU daily', timing: 'With largest meal', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    warnings.push('PCOS: Inositol can lower blood sugar. Monitor glucose if on metformin or diabetes medications.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'A low-glycemic diet is the most evidence-based dietary intervention for PCOS. Prioritize fiber-rich vegetables, legumes, and whole grains. Reduce refined carbohydrates and sugar which spike insulin and worsen androgen levels.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Resistance training 3x/week combined with moderate cardio significantly improves insulin sensitivity in PCOS. Even 30 minutes of brisk walking daily reduces androgen levels measurably.' });
  }
  if (conditions.includes('Osteoporosis')) {
    recs.push({ name: 'Calcium Citrate + Vitamin D3 + K2', reason: 'Gold standard for osteoporosis. Calcium citrate is better absorbed than carbonate. D3 enables calcium absorption. K2 (MK-7) directs calcium into bones rather than arteries.', dosage: '500mg calcium citrate + 2000 IU D3 + 100mcg K2 daily', timing: 'With meals, split calcium into 2 doses', priority: 'High', interactions: 'K2 may interact with warfarin ? consult doctor if on blood thinners', triggeredBy: 'Osteoporosis reported' });
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is essential for bone matrix formation and activates Vitamin D. 50-60% of total body magnesium is stored in bone.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified', triggeredBy: 'Osteoporosis reported' });
    recs.push({ name: 'Collagen Peptides (Type I)', reason: 'Collagen makes up 90% of bone organic matrix. Supplementation with Vitamin C stimulates osteoblast activity and has shown measurable bone density improvements in clinical trials.', dosage: '10g daily', timing: 'Morning with Vitamin C', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Osteoporosis reported' });
    warnings.push('Osteoporosis: Do not exceed 1200mg total calcium daily. Excess calcium without K2 may increase cardiovascular risk. Consult your doctor about bone density monitoring.');
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Weight-bearing exercise is the most effective non-pharmacological intervention for osteoporosis. Walking, dancing, and resistance training stimulate bone remodeling. Aim for 30 minutes of weight-bearing activity daily.' });
  }
  if (conditions.includes('Depression/Anxiety')) {
    if (!onAntidepressant) {
      recs.push({ name: 'Omega-3 (High EPA)', reason: 'EPA-dominant omega-3 has the strongest evidence for mood support. Multiple meta-analyses show significant antidepressant effects with EPA doses above 1g/day.', dosage: '1000-2000mg EPA daily', timing: 'With meals', priority: 'High', interactions: 'None identified', triggeredBy: 'Depression/Anxiety reported' });
      recs.push({ name: 'Vitamin D3', reason: 'Vitamin D receptors are found throughout the brain. Low D is strongly correlated with depression and anxiety. Supplementation improves mood in deficient individuals.', dosage: '2000-4000 IU daily', timing: 'With a fat-containing meal', priority: 'High', interactions: 'None identified', triggeredBy: 'Depression/Anxiety reported' });
    }
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is essential for GABA and serotonin synthesis. Deficiency is found in the majority of people with anxiety and depression.', dosage: '300-400mg daily', timing: 'Evening', priority: 'High', interactions: 'Safe with SSRIs', triggeredBy: 'Depression/Anxiety reported' });
    warnings.push('Depression/Anxiety: Supplements support but do not replace professional mental health care. If symptoms are severe, please consult a psychiatrist or psychologist.');
    if (onAntidepressant) { avoidList.push("St. John's Wort ? serotonin syndrome risk with antidepressants"); avoidList.push('5-HTP ? serotonin syndrome risk with SSRIs/SNRIs'); }
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Exercise is as effective as antidepressants for mild-to-moderate depression. 30 minutes of moderate cardio 5x/week increases BDNF, serotonin, and dopamine.' });
  }
  if (conditions.includes('Celiac/Gluten Sensitivity')) {
    warnings.push('Celiac/Gluten Sensitivity: Always verify all supplements are certified gluten-free. Celiac disease causes malabsorption of iron, B12, folate, calcium, and Vitamin D.');
    recs.push({ name: 'Multivitamin (certified gluten-free)', reason: 'Celiac disease causes widespread nutrient malabsorption. A comprehensive gluten-free multivitamin addresses multiple simultaneous deficiencies.', dosage: '1 serving daily per label', timing: 'With breakfast', priority: 'High', interactions: 'Ensure certified gluten-free label', triggeredBy: 'Celiac/Gluten Sensitivity reported' });
    recs.push({ name: 'Iron Bisglycinate (gluten-free)', reason: 'Iron deficiency anemia is the most common presentation of celiac disease due to duodenal malabsorption.', dosage: '25mg daily', timing: 'Morning with Vitamin C', priority: 'High', interactions: 'None identified', triggeredBy: 'Celiac/Gluten Sensitivity reported' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Strict gluten-free diet is the only treatment for celiac disease. Even trace amounts cause intestinal damage. Focus on naturally gluten-free whole foods: rice, quinoa, potatoes, meat, fish, and vegetables.' });
  }
  if (conditions.includes('Gout')) {
    avoidList.push('High-dose Niacin (raises uric acid levels)');
    avoidList.push('Vitamin C megadoses >2g (may paradoxically raise uric acid in some individuals)');
    recs.push({ name: 'Tart Cherry Extract', reason: 'Tart cherry reduces uric acid levels and gout flare frequency in clinical trials. Contains anthocyanins that inhibit uric acid production.', dosage: '480mg concentrated extract daily', timing: 'With meals', priority: 'High', interactions: 'None identified', triggeredBy: 'Gout reported' });
    recs.push({ name: 'Vitamin C (moderate dose)', reason: 'Vitamin C at 500-1000mg/day reduces serum uric acid by increasing renal excretion. Multiple studies confirm a 0.5mg/dL reduction per 500mg Vitamin C.', dosage: '500mg daily', timing: 'With meals', priority: 'Medium', interactions: 'Avoid megadoses >2g', triggeredBy: 'Gout reported' });
    warnings.push('Gout: Avoid high-purine foods (organ meats, anchovies, sardines, shellfish, beer). Stay well hydrated (3L+ water daily) to promote uric acid excretion.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Gout management: avoid organ meats, shellfish, red meat, and alcohol (especially beer). Increase low-fat dairy, cherries, and water. Coffee (2-4 cups/day) is associated with lower uric acid levels.' });
  }
  // -- Diet-based --
  // -- New conditions ------------------------------------------------------
  if (conditions.includes('Anemia')) {
    recs.push({ name: 'Iron Bisglycinate + Vitamin C', reason: 'Anemia reported. Iron bisglycinate is the most absorbable and gentlest form. Vitamin C co-administration triples absorption. Essential for red blood cell production.', dosage: '25-50mg iron + 500mg Vitamin C daily', timing: 'Morning on empty stomach, away from coffee/tea', priority: 'High', interactions: onThyroid ? 'Take 4+ hours away from thyroid medication' : 'None identified', triggeredBy: 'Anemia reported' });
    recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'B12 deficiency is a common cause of megaloblastic anemia. Methylcobalamin is the neurologically active form with superior absorption.', dosage: '1000mcg daily (sublingual preferred)', timing: 'Morning', priority: 'High', interactions: onMetformin ? 'Critical - metformin depletes B12' : 'None identified', triggeredBy: 'Anemia reported' });
    recs.push({ name: 'Folate (Methylfolate)', reason: 'Folate deficiency causes megaloblastic anemia. Methylfolate is the active form, bypassing MTHFR gene variants that impair folic acid conversion.', dosage: '400-800mcg daily', timing: 'With breakfast', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Anemia reported' });
    warnings.push('Anemia: Iron supplementation should ideally be guided by blood test results (ferritin, hemoglobin). Do not exceed 45mg iron/day without medical supervision.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Eat iron-rich foods with Vitamin C at every meal: spinach with lemon, lentils with tomatoes, red meat with bell peppers. Avoid coffee and tea within 1 hour of iron-rich meals as tannins block absorption.' });
  }
  if (conditions.includes('PCOS')) {
    recs.push({ name: 'Inositol (Myo-Inositol + D-Chiro-Inositol 40:1)', reason: 'The 40:1 ratio is the most clinically validated supplement for PCOS. Improves insulin sensitivity, restores ovulation, and reduces androgen levels.', dosage: '4g myo-inositol + 100mg D-chiro-inositol daily', timing: 'Split into 2 doses with meals', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium deficiency is common in PCOS and worsens insulin resistance. Glycinate form supports hormonal balance and reduces anxiety.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    recs.push({ name: 'Vitamin D3', reason: 'Vitamin D deficiency is common in women with PCOS and is directly linked to insulin resistance and hormonal imbalance.', dosage: '2000-4000 IU daily', timing: 'With largest meal', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    warnings.push('PCOS: Inositol and berberine can lower blood sugar. Monitor glucose if on metformin or other diabetes medications.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'A low-glycemic diet is the most evidence-based dietary intervention for PCOS. Prioritize fiber-rich vegetables, legumes, and whole grains. Reduce refined carbohydrates and sugar which spike insulin and worsen androgen levels.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Resistance training 3x/week combined with moderate cardio significantly improves insulin sensitivity in PCOS. Even 30 minutes of brisk walking daily reduces androgen levels measurably.' });
  }
  if (conditions.includes('Osteoporosis')) {
    recs.push({ name: 'Calcium Citrate + Vitamin D3 + K2', reason: 'Gold standard for osteoporosis. Calcium citrate is better absorbed than carbonate. D3 enables calcium absorption. K2 (MK-7) directs calcium into bones rather than arteries.', dosage: '500mg calcium citrate + 2000 IU D3 + 100mcg K2 daily', timing: 'With meals, split calcium into 2 doses', priority: 'High', interactions: onBloodThinner ? 'K2 may interact with warfarin - consult doctor' : onThyroid ? 'Take 4+ hours from thyroid medication' : 'None identified', triggeredBy: 'Osteoporosis reported' });
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is essential for bone matrix formation and activates Vitamin D. 50-60% of total body magnesium is stored in bone.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified', triggeredBy: 'Osteoporosis reported' });
    recs.push({ name: 'Collagen Peptides (Type I)', reason: 'Collagen makes up 90% of bone organic matrix. Supplementation with Vitamin C stimulates osteoblast activity and has shown measurable bone density improvements in clinical trials.', dosage: '10g daily', timing: 'Morning with Vitamin C', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Osteoporosis reported' });
    warnings.push('Osteoporosis: Do not exceed 1200mg total calcium daily (food + supplement). Excess calcium without K2 may increase cardiovascular risk. Consult your doctor about bone density monitoring.');
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Weight-bearing exercise is the most effective non-pharmacological intervention for osteoporosis. Walking, dancing, and resistance training stimulate bone remodeling. Aim for 30 minutes of weight-bearing activity daily.' });
  }
  if (conditions.includes('Depression/Anxiety')) {
    if (!onAntidepressant) {
      recs.push({ name: 'Omega-3 (High EPA)', reason: 'EPA-dominant omega-3 has the strongest evidence for mood support. Multiple meta-analyses show significant antidepressant effects with EPA doses above 1g/day.', dosage: '1000-2000mg EPA daily', timing: 'With meals', priority: 'High', interactions: 'None identified', triggeredBy: 'Depression/Anxiety reported' });
      recs.push({ name: 'Vitamin D3', reason: 'Vitamin D receptors are found throughout the brain. Low D is strongly correlated with depression and anxiety. Supplementation improves mood in deficient individuals.', dosage: '2000-4000 IU daily', timing: 'With a fat-containing meal', priority: 'High', interactions: 'None identified', triggeredBy: 'Depression/Anxiety reported' });
    }
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is essential for GABA and serotonin synthesis. Deficiency is found in the majority of people with anxiety and depression.', dosage: '300-400mg daily', timing: 'Evening', priority: 'High', interactions: onAntidepressant ? 'Safe with SSRIs' : 'None identified', triggeredBy: 'Depression/Anxiety reported' });
    warnings.push('Depression/Anxiety: Supplements support but do not replace professional mental health care. If symptoms are severe, please consult a psychiatrist or psychologist.');
    if (onAntidepressant) {
      avoidList.push("St. John's Wort - serotonin syndrome risk with antidepressants");
      avoidList.push('5-HTP - serotonin syndrome risk with SSRIs/SNRIs');
    }
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Exercise is as effective as antidepressants for mild-to-moderate depression. 30 minutes of moderate cardio 5x/week increases BDNF, serotonin, and dopamine.' });
  }
  if (conditions.includes('Celiac/Gluten Sensitivity')) {
    warnings.push('Celiac/Gluten Sensitivity: Always verify all supplements are certified gluten-free. Celiac disease causes malabsorption of iron, B12, folate, calcium, and Vitamin D.');
    recs.push({ name: 'Multivitamin (certified gluten-free)', reason: 'Celiac disease causes widespread nutrient malabsorption. A comprehensive gluten-free multivitamin addresses multiple simultaneous deficiencies.', dosage: '1 serving daily per label', timing: 'With breakfast', priority: 'High', interactions: 'Ensure certified gluten-free label', triggeredBy: 'Celiac/Gluten Sensitivity reported' });
    recs.push({ name: 'Iron Bisglycinate (gluten-free)', reason: 'Iron deficiency anemia is the most common presentation of celiac disease due to duodenal malabsorption.', dosage: '25mg daily', timing: 'Morning with Vitamin C', priority: 'High', interactions: onThyroid ? '4+ hours from thyroid medication' : 'None identified', triggeredBy: 'Celiac/Gluten Sensitivity reported' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Strict gluten-free diet is the only treatment for celiac disease. Focus on naturally gluten-free whole foods: rice, quinoa, potatoes, meat, fish, vegetables, and certified GF oats.' });
  }
  if (conditions.includes('Gout')) {
    avoidList.push('High-dose Niacin (raises uric acid levels)');
    avoidList.push('Vitamin C megadoses >2g (may paradoxically raise uric acid in some individuals)');
    recs.push({ name: 'Tart Cherry Extract', reason: 'Tart cherry has the strongest evidence for gout prevention - reduces uric acid levels and gout flare frequency in clinical trials.', dosage: '480mg concentrated extract or 240ml juice daily', timing: 'With meals', priority: 'High', interactions: 'None identified', triggeredBy: 'Gout reported' });
    recs.push({ name: 'Vitamin C (moderate dose)', reason: 'Vitamin C at 500-1000mg/day reduces serum uric acid by increasing renal excretion. Multiple studies confirm a 0.5mg/dL reduction per 500mg Vitamin C.', dosage: '500mg daily', timing: 'With meals', priority: 'Medium', interactions: 'None identified - avoid megadoses >2g', triggeredBy: 'Gout reported' });
    warnings.push('Gout: Avoid high-purine foods (organ meats, anchovies, sardines, shellfish, beer). Stay well hydrated (3L+ water daily) to promote uric acid excretion.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Gout management diet: avoid organ meats, shellfish, red meat, and alcohol (especially beer). Increase low-fat dairy, cherries, and water. Coffee (2-4 cups/day) is associated with lower uric acid levels.' });
  }
  // -- Expanded conditions (2026-10 gap audit, scripts/conditionGapAnalysis.js) --
  // Safety scoping is the whole reason these checkboxes exist: each branch is
  // what the option UNLOCKS in an offline (rule-engine) plan. The AI path gets
  // the same facts through the knowledge-base prompt.
  if (conditions.includes('GERD / Acid Reflux (Suan)')) {
    avoidList.push('Peppermint oil capsules (relax the valve between stomach and esophagus, worsening reflux)');
    warnings.push('GERD/acid reflux: choose buffered Vitamin C (ascorbate, not ascorbic acid), skip effervescent or mint-flavored forms, and take iron with food.');
  }
  if (conditions.includes('Gastritis / Stomach Ulcer')) {
    warnings.push('Gastritis/ulcer: take iron, zinc, and magnesium with food — never on an empty stomach. Avoid capsicum/cayenne capsules and Vitamin C above 1g.');
  }
  if (conditions.includes('Fatty Liver (NAFLD)')) {
    avoidList.push('Kava (liver injury risk)');
    avoidList.push('Green-tea extract above ~800mg EGCG daily (liver injury reports)');
    warnings.push('Fatty liver: keep Vitamin A below 5,000 IU/day, favor choline-rich foods and omega-3, and skip unlisted "liver cleanse" herb blends.');
  }
  if (conditions.includes('Kidney Stones')) {
    warnings.push('Kidney stones: keep supplemental calcium ≤500mg taken WITH meals (food-first is safer), cap Vitamin C at 500mg/day (oxalate), and drink enough to reach 2.5L+ urine output daily.');
  }
  if (conditions.includes('Prediabetes / Insulin Resistance')) {
    warnings.push('Prediabetes: berberine and chromium can lower blood sugar — monitor if medication is started, and pick sugar-free supplement forms (not gummies or syrups).');
  }
  if (conditions.includes('Sleep Apnea (Snoring / Paused Breathing)')) {
    warnings.push('Sleep apnea is an airway condition that supplements cannot treat — ask a clinician about a sleep study. Avoid leaning on sedating sleep aids (valerian, high-dose melatonin), which can worsen airway relaxation.');
  }
  // -- New goals handling ---------------------------------------------------
  if (goals.includes('Muscle Gain') || a.fitnessFocus === 'Muscle Gain') {
    recs.push({ name: 'Creatine Monohydrate', reason: 'Most researched sports supplement. Increases ATP regeneration for strength, power, and muscle recovery. Also has cognitive benefits.', dosage: '3-5g daily', timing: 'Post-workout or with any meal', priority: 'High', interactions: 'Safe for healthy kidneys. Stay well hydrated.', triggeredBy: 'Muscle Gain goal' });
    recs.push({ name: 'Whey Protein (or Plant Protein)', reason: 'Adequate protein is the primary driver of muscle protein synthesis. Supplementation helps reach the 1.6-2.2g/kg target needed for muscle gain.', dosage: '20-30g per serving, 1-2x daily', timing: 'Post-workout and/or between meals', priority: 'High', interactions: 'None identified', triggeredBy: 'Muscle Gain goal' });
    if (!recs.find(r => r.name.includes('Magnesium')))
      recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is essential for muscle contraction, protein synthesis, and recovery. Deficiency impairs strength gains and increases injury risk.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Muscle Gain goal' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'For muscle gain: progressive overload resistance training 3-5x/week is essential. Increase weight or reps each session. Compound movements (squat, deadlift, bench, row) give the most muscle-building stimulus.' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'Muscle gain requires a caloric surplus of 200-300 calories above maintenance. Eat 1.6-2.2g protein per kg bodyweight daily. Distribute protein across 4-5 meals for optimal muscle protein synthesis.' });
  }
  if (goals.includes('Athletic Performance') || a.fitnessFocus === 'Endurance / Cardio') {
    recs.push({ name: 'Beta-Alanine', reason: 'Increases muscle carnosine levels, buffering lactic acid during high-intensity exercise. Improves endurance performance by 2-3% in activities lasting 1-4 minutes.', dosage: '3.2-6.4g daily (split doses to reduce tingling)', timing: 'Pre-workout or with meals', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Athletic Performance goal' });
    recs.push({ name: 'Electrolyte Complex (Sodium, Potassium, Magnesium)', reason: 'Electrolyte loss during exercise impairs performance and causes cramping. A balanced electrolyte supplement maintains hydration and muscle function during training.', dosage: 'Per label, especially during/after exercise', timing: 'During and after workouts', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Athletic Performance goal' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'For athletic performance: carbohydrate timing matters. Eat 30-60g carbs 1-2 hours before training for fuel. Post-workout: 20-30g protein + 40-60g carbs within 30 minutes for optimal recovery.' });
  }
  if (goals.includes('Skin & Hair Health')) {
    recs.push({ name: 'Biotin (Vitamin B7)', reason: 'Biotin is essential for keratin production - the structural protein of hair and nails. Deficiency causes hair thinning and brittle nails.', dosage: '2500-5000mcg daily', timing: 'With breakfast', priority: 'Medium', interactions: 'May interfere with thyroid lab tests - inform your doctor', triggeredBy: 'Skin & Hair Health goal' });
    recs.push({ name: 'Collagen Peptides (Type I & III)', reason: 'Collagen provides the structural framework for skin elasticity and hair strength. Hydrolyzed peptides are absorbed and stimulate fibroblast activity.', dosage: '10g daily', timing: 'Morning with Vitamin C (enhances collagen synthesis)', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Skin & Hair Health goal' });
    if (!recs.find(r => r.name.toLowerCase().includes('omega')))
      recs.push({ name: 'Omega-3 (Fish Oil)', reason: 'Omega-3 fatty acids strengthen the skin barrier, reduce inflammation, and improve skin hydration. EPA reduces acne-causing inflammation.', dosage: '1000-2000mg EPA+DHA daily', timing: 'With meals', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Skin & Hair Health goal' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'For skin and hair health: eat foods rich in antioxidants (berries, leafy greens), healthy fats (avocado, salmon, nuts), and zinc (pumpkin seeds, oysters). Avoid excess sugar which causes glycation and accelerates skin aging.' });
  }
  if (goals.includes('Hormonal Balance')) {
    recs.push({ name: 'Ashwagandha (KSM-66)', reason: 'Ashwagandha is linked to lower cortisol and reduced perceived stress in randomised trials, which is why it is used for hormonal balance. Evidence for thyroid and testosterone effects is limited.', dosage: '300-600mg daily', timing: 'Morning or evening with food', priority: 'Medium', interactions: onAntidepressant ? 'Use with caution - consult doctor' : 'None identified', triggeredBy: 'Hormonal Balance goal' });
    if (!recs.find(r => r.name.includes('Magnesium')))
      recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is a cofactor in over 300 hormonal reactions. Deficiency disrupts cortisol, insulin, thyroid, and sex hormone balance.', dosage: '300-400mg daily', timing: 'Evening', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Hormonal Balance goal' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'For hormonal balance: eat adequate healthy fats (avocado, olive oil, nuts) as hormones are made from cholesterol. Avoid crash dieting which disrupts cortisol and thyroid hormones. Prioritize fiber to support estrogen metabolism.' });
  }
  if (goals.includes('Anti-Aging')) {
    recs.push({ name: 'CoQ10 (Ubiquinol)', reason: 'CoQ10 production declines with age. Ubiquinol (active form) supports mitochondrial energy production, reduces oxidative stress, and has anti-aging effects on skin and cardiovascular tissue.', dosage: '100-200mg daily', timing: 'With fat-containing meal', priority: 'Medium', interactions: onStatin ? 'Essential - statins further deplete CoQ10' : 'None identified', triggeredBy: 'Anti-Aging goal' });
    recs.push({ name: 'Resveratrol', reason: 'Activates sirtuins (longevity genes) and AMPK. Clinical evidence for cardiovascular protection, anti-inflammatory effects, and metabolic health.', dosage: '150-500mg daily', timing: 'With meals', priority: 'Low', interactions: onBloodThinner ? 'Mild blood-thinning effect - monitor' : 'None identified', triggeredBy: 'Anti-Aging goal' });
    lifestyleAdvice.push({ category: 'Lifestyle', advice: 'The most evidence-based anti-aging interventions: resistance training (preserves muscle and bone), caloric moderation (not restriction), quality sleep (cellular repair), stress management (reduces telomere shortening), and social connection.' });
  }
  // -- Sun exposure - Vitamin D adjustment ---------------------------------
  if (a.sunExposure === '< 15 min' || a.sunExposure === '15-30 min') {
    if (!recs.find(r => r.name.toLowerCase().includes('vitamin d')))
      recs.push({ name: 'Vitamin D3 + K2', reason: 'Low sun exposure reported. Vitamin D synthesis requires 15-30 minutes of midday sun on large skin areas. Supplementation is essential for those with limited sun exposure.', dosage: '2000-4000 IU D3 + 100mcg K2 daily', timing: 'With largest meal', priority: 'High', interactions: onBloodThinner ? 'K2 may interact with warfarin' : 'None identified', triggeredBy: 'Low sun exposure reported' });
  }
  // -- Protein intake - muscle/recovery adjustment --------------------------
  if (a.proteinIntake === 'Very Low (< 50g)' || a.proteinIntake === 'Low (50-80g)') {
    if (!recs.find(r => r.name.toLowerCase().includes('protein')))
      recs.push({ name: 'Protein Supplement (Whey or Plant-based)', reason: 'Low protein intake reported. Adequate protein (0.8-1.6g/kg bodyweight) is essential for muscle maintenance, immune function, enzyme production, and tissue repair.', dosage: '20-30g per serving, 1-2x daily', timing: 'Between meals or post-workout', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Low protein intake reported' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'Your protein intake appears low. Aim for at least 0.8g per kg bodyweight daily (more if active). Include a protein source at every meal: eggs, meat, fish, dairy, legumes, or tofu.' });
  }
  if (['Vegan', 'Vegetarian'].includes(diet)) {
    if (!recs.find(r => r.name.includes('B12')))
      recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'B12 is found almost exclusively in animal products. Deficiency is near-universal in vegans without supplementation and causes irreversible neurological damage.', dosage: '1000mcg daily', timing: 'Morning with breakfast', priority: 'High', interactions: 'None identified' });
    recs.push({ name: 'Algae-based Omega-3 (DHA+EPA)', reason: 'Vegan source of omega-3 � algae is where fish get their DHA/EPA. Equally effective for brain function and inflammation control.', dosage: '500-1000mg DHA+EPA daily', timing: 'With fat-containing meal', priority: 'High', interactions: 'None identified' });
    recs.push({ name: 'Vitamin D3 + K2 (vegan certified)', reason: 'D3 from lichen is the vegan form. K2 (MK-7) directs calcium to bones. Both commonly deficient in plant-based diets.', dosage: '2000 IU D3 + 100mcg K2 daily', timing: 'With largest meal', priority: 'High', interactions: onBloodThinner ? 'K2 may interact with warfarin � consult doctor' : 'None identified' });
    recs.push({ name: 'Iron Bisglycinate + Vitamin C', reason: 'Plant-based iron has lower absorption. Bisglycinate is gentlest form. Vitamin C triples absorption when taken together.', dosage: '18-25mg iron + 500mg Vitamin C', timing: 'Morning on empty stomach, away from coffee', priority: 'Medium', interactions: onThyroid ? '4+ hours away from thyroid medication' : 'None identified' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Ensure adequate protein from varied plant sources: combine legumes with grains, include tofu, tempeh, seitan, and hemp seeds. Aim for 0.8-1g protein per kg body weight daily.' });
  }

  // -- Symptom-based --
  if (symptoms.includes('Fatigue') || goals.includes('Increase Energy')) {
    const sev = symptomSeverity['Fatigue'] || 'Moderate';
    if (!recs.find(r => r.name.includes('B12')))
      recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: `B12 deficiency is one of the most overlooked causes of fatigue.${sev === 'Severe' ? ' Severe fatigue warrants priority B12 supplementation.' : ''} Methylcobalamin is directly usable by the nervous system.`, dosage: sev === 'Severe' ? '2000mcg daily (sublingual)' : '1000mcg daily', timing: 'Morning', priority: sev === 'Severe' ? 'High' : 'High', interactions: onMetformin ? 'Critical � metformin depletes B12' : 'None identified', triggeredBy: `Fatigue (${sev}) reported` });
    recs.push({ name: 'Iron Bisglycinate', reason: `Iron deficiency anemia is the leading cause of fatigue, especially in women.${sev === 'Severe' ? ' Severe fatigue may indicate significant iron deficiency.' : ''} Bisglycinate is highly absorbable without constipation.`, dosage: '18-25mg daily', timing: 'Morning on empty stomach with Vitamin C', priority: sev === 'Severe' ? 'High' : 'Medium', interactions: onThyroid ? '4+ hours from levothyroxine' : 'None identified', triggeredBy: `Fatigue (${sev}) reported` });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Fatigue is often worsened by poor sleep quality. Maintain a consistent sleep schedule (same bedtime/wake time daily), keep bedroom cool (65-68�F/18-20�C), and avoid screens 1 hour before bed.' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Eat iron-rich foods with Vitamin C: spinach with lemon juice, lentils with tomatoes. Avoid coffee/tea within 1 hour of iron-rich meals as they block absorption.' });
  }
  if (symptoms.includes('Poor Sleep') || goals.includes('Improve Sleep') || sleepQuality === 'Very Poor' || sleepQuality === 'Poor') {
    if (!recs.find(r => r.name.includes('Magnesium'))) {
      recs.push({ name: 'Magnesium Glycinate', reason: 'Activates GABA receptors to quiet the nervous system. Glycinate crosses the blood-brain barrier and is the most studied form for sleep quality.', dosage: '300-400mg daily', timing: '30-60 minutes before bed', priority: 'High', interactions: onAntidepressant ? 'Safe with antidepressants' : 'None identified', triggeredBy: 'Poor sleep reported' });
    }
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Establish a wind-down routine: dim lights 2 hours before bed, avoid caffeine after 2pm, keep a consistent sleep schedule even on weekends. Try 4-7-8 breathing (inhale 4s, hold 7s, exhale 8s) to fall asleep faster.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Regular moderate exercise improves sleep quality significantly. However, avoid intense exercise within 3 hours of bedtime as it raises cortisol and body temperature.' });
  }
  if (symptoms.includes('Brain Fog') || goals.includes('Enhance Mental Clarity')) {
    if (!allergies.includes('fish'))
      recs.push({ name: 'Omega-3 (Fish Oil, high DHA)', reason: 'DHA makes up 40% of brain fatty acids. Improves cognitive function, reduces brain fog, and protects against neurodegeneration.', dosage: '1000-2000mg DHA+EPA daily', timing: 'With meals', priority: 'Medium', interactions: onBloodThinner ? 'Use 1g max on blood thinners' : 'None identified' });
    recs.push({ name: "Lion's Mane Mushroom Extract", reason: 'Stimulates Nerve Growth Factor (NGF) production supporting neuroplasticity. Clinical trials show improvement in mild cognitive impairment.', dosage: '500-1000mg daily', timing: 'Morning with breakfast', priority: 'Medium', interactions: 'None identified' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Brain fog is often caused by blood sugar fluctuations. Eat balanced meals with protein, healthy fats, and complex carbs every 3-4 hours. Avoid skipping meals and limit refined sugar.' });
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Even mild dehydration (1-2%) significantly impairs cognitive function. Drink at least 8 glasses (2L) of water daily. Start each morning with a large glass of water before coffee.' });
  }
  if (symptoms.includes('Anxiety/Stress')) {
    if (!onAntidepressant)
      recs.push({ name: 'Ashwagandha (KSM-66)', reason: 'KSM-66 is the most clinically studied extract. Randomised trials report lower cortisol and reduced perceived stress versus placebo.', dosage: '300-600mg daily', timing: 'Morning or evening with food', priority: 'Medium', interactions: 'None identified' });
    recs.push({ name: 'L-Theanine', reason: 'Promotes alpha brain wave activity � calm alertness without sedation. Works with caffeine to reduce jitteriness. No dependency risk.', dosage: '200mg daily', timing: 'Morning or as needed', priority: 'Medium', interactions: onAntidepressant ? 'Safe with SSRIs' : 'None identified' });
    lifestyleAdvice.push({ category: 'Stress', advice: 'Practice daily stress management: 10 minutes of mindfulness meditation, journaling, or deep breathing. The 4-7-8 breathing technique activates the parasympathetic nervous system within minutes.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Exercise is one of the most effective anxiety treatments. 30 minutes of moderate cardio 3-5x/week reduces cortisol and increases GABA and serotonin naturally.' });
  }
  if (symptoms.includes('Joint Pain')) {
    recs.push({ name: 'Curcumin + Piperine (or Liposomal)', reason: 'Anti-inflammatory evidence comparable to NSAIDs for joint pain without GI side effects. Must include piperine or liposomal form for absorption.', dosage: '500-1000mg curcumin + 5mg piperine daily', timing: 'With meals', priority: 'Medium', interactions: onBloodThinner ? 'Mild blood-thinning � use with caution' : 'None identified' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Low-impact exercise reduces joint pain by strengthening surrounding muscles. Try swimming, cycling, or water aerobics. Avoid high-impact activities during flare-ups. Gentle stretching and yoga improve joint mobility.' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Anti-inflammatory diet reduces joint pain: increase omega-3 rich foods (fatty fish, walnuts, flaxseed), colorful vegetables, and berries. Reduce processed foods, refined sugar, and vegetable oils high in omega-6.' });
  }
  if (symptoms.includes('Digestive Issue') || goals.includes('Digestive Health')) {
    recs.push({ name: 'Probiotic (Multi-strain, 50B CFU)', reason: 'Restores gut microbiome diversity. Key strains: L. acidophilus, B. longum, L. rhamnosus GG � the most clinically validated for digestive health.', dosage: '50 billion CFU daily', timing: 'Morning before breakfast', priority: 'Medium', interactions: 'Safe with all medications' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Feed your gut bacteria with prebiotic foods: garlic, onions, leeks, asparagus, bananas, and oats. Eat slowly and chew thoroughly. Avoid eating when stressed as it impairs digestion.' });
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Drink 2L of water daily to support digestion and prevent constipation. Warm water with lemon in the morning stimulates digestive enzymes.' });
  }
  if (symptoms.includes('Frequent Colds') || goals.includes('Boost Immunity')) {
    recs.push({ name: 'Zinc Picolinate', reason: 'Most bioavailable zinc form. Essential for T-cell immune function. Reduces cold duration and severity in clinical trials.', dosage: '15-30mg daily', timing: 'With meals to prevent nausea', priority: 'Medium', interactions: onThyroid ? '2+ hours from thyroid medication' : 'None identified' });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Sleep is the most powerful immune booster. During sleep, your body produces cytokines that fight infection. Aim for 7-9 hours. Even a single night of poor sleep measurably dampens immune cell activity.' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Eat immune-supporting foods daily: citrus fruits, bell peppers (highest Vitamin C), garlic, ginger, turmeric, and fermented foods like yogurt and kefir.' });
  }
  if (symptoms.includes('Muscle Weakness') || a.activityLevel === 'Very') {
    recs.push({ name: 'Creatine Monohydrate', reason: 'Most researched sports supplement. Increases ATP regeneration for strength, power, and muscle recovery. Also has cognitive benefits.', dosage: '3-5g daily', timing: 'Post-workout or with any meal', priority: 'Medium', interactions: 'Safe for healthy kidneys' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'For muscle weakness, progressive resistance training 2-3x/week is essential. Start with bodyweight exercises and gradually increase resistance. Ensure adequate protein intake (1.6-2.2g per kg body weight) for muscle repair.' });
  }

  // -- Free-text feeling description keyword parser --
  if (a.feelingDescription && a.feelingDescription.trim()) {
    const fd = anchorText(a.feelingDescription.toLowerCase(), ['health', 'safety']);

    if (/back\s*pain|backache|spine|lower back|upper back/.test(fd)) {
      if (!recs.find(r => r.name.includes('Magnesium')))
        recs.push({ name: 'Magnesium Glycinate', reason: 'Back pain is frequently associated with magnesium deficiency, which causes muscle tension and spasms. Magnesium glycinate relaxes skeletal muscle and reduces pain signaling.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified' });
      recs.push({ name: 'Curcumin + Piperine', reason: 'Curcumin has strong anti-inflammatory evidence for musculoskeletal pain including back pain. Piperine is required for adequate absorption.', dosage: '500-1000mg curcumin + 5mg piperine daily', timing: 'With meals', priority: 'High', interactions: onBloodThinner ? 'Mild blood-thinning � use with caution' : 'None identified' });
      lifestyleAdvice.push({ category: 'Exercise', advice: 'For back pain, focus on core strengthening exercises (planks, bird-dogs, dead bugs) 3x/week. Weak core muscles are the primary driver of chronic back pain. Avoid prolonged sitting � stand or walk every 30 minutes.' });
      lifestyleAdvice.push({ category: 'Posture', advice: 'Poor posture is a leading cause of back pain. Ensure your workstation is ergonomically set up: monitor at eye level, feet flat on floor, lower back supported. Stretch your hip flexors and hamstrings daily as tightness pulls on the lower back.' });
    }

    if (/headache|migraine|head\s*pain|head\s*ache/.test(fd)) {
      if (!recs.find(r => r.name.includes('Magnesium')))
        recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium deficiency is more common among people with migraines, and randomised trials suggest supplementation can reduce how often they occur. It relaxes blood vessels and reduces neurological excitability.', dosage: '400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified' });
      recs.push({ name: 'Riboflavin (Vitamin B2)', reason: 'Riboflavin at high doses has strong clinical evidence for migraine prevention, reducing attack frequency in trials. It improves mitochondrial energy production in brain cells.', dosage: '400mg daily', timing: 'With breakfast', priority: 'High', interactions: 'None identified � very safe' });
      lifestyleAdvice.push({ category: 'Hydration', advice: 'Dehydration is one of the most common headache triggers. Drink at least 2-3L of water daily. Keep a water bottle visible as a reminder. Electrolyte imbalance (low sodium, magnesium) also triggers headaches.' });
      lifestyleAdvice.push({ category: 'Sleep', advice: 'Irregular sleep is a major headache trigger. Maintain consistent sleep and wake times even on weekends. Both too little and too much sleep can trigger migraines.' });
    }

    if (/knee\s*pain|knee\s*ache|knee\s*hurt/.test(fd)) {
      recs.push({ name: 'Glucosamine Sulfate + Chondroitin', reason: 'Glucosamine sulfate has the strongest evidence for knee osteoarthritis pain relief, comparable to ibuprofen in long-term trials. Chondroitin helps maintain cartilage hydration and elasticity.', dosage: '1500mg glucosamine + 1200mg chondroitin daily', timing: 'With meals, split into 2-3 doses', priority: 'High', interactions: onBloodThinner ? 'Glucosamine may mildly affect INR � monitor' : 'None identified' });
      recs.push({ name: 'Collagen Peptides (Type II)', reason: 'Type II collagen specifically targets joint cartilage. Clinical studies show it reduces knee pain and stiffness by stimulating cartilage regeneration.', dosage: '10g daily', timing: 'Morning on empty stomach with Vitamin C', priority: 'Medium', interactions: 'None identified' });
      lifestyleAdvice.push({ category: 'Exercise', advice: 'Strengthen the muscles around the knee to reduce joint load. Focus on quad sets, straight leg raises, and step-ups. Swimming and cycling are excellent low-impact options. Avoid running on hard surfaces until pain improves.' });
    }

    if (/neck\s*pain|neck\s*stiff|stiff\s*neck/.test(fd)) {
      if (!recs.find(r => r.name.includes('Magnesium')))
        recs.push({ name: 'Magnesium Glycinate', reason: 'Neck stiffness and pain are commonly caused by muscle tension from magnesium deficiency. Magnesium relaxes smooth and skeletal muscle effectively.', dosage: '300-400mg daily', timing: 'Evening', priority: 'High', interactions: 'None identified' });
      lifestyleAdvice.push({ category: 'Posture', advice: 'Neck pain is often caused by forward head posture from screen use. Keep your phone at eye level, take screen breaks every 30 minutes, and do chin tucks (gently pull chin back) 10 reps hourly to strengthen deep neck flexors.' });
    }

    if (/tired|exhausted|no energy|low energy|drained|lethargic/.test(fd) && !symptoms.includes('Fatigue')) {
      if (!recs.find(r => r.name.includes('B12')))
        recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'The patient reports persistent tiredness and low energy. B12 deficiency is one of the most common and overlooked causes of fatigue. Methylcobalamin is the neurologically active form with superior absorption.', dosage: '1000mcg daily', timing: 'Morning', priority: 'High', interactions: onMetformin ? 'Critical � metformin depletes B12' : 'None identified' });
      if (!recs.find(r => r.name.includes('D3')))
        recs.push({ name: 'Vitamin D3', reason: 'Low energy and fatigue are hallmark symptoms of Vitamin D deficiency, which is common in adults. Vitamin D is essential for mitochondrial energy production.', dosage: '2000 IU daily', timing: 'With a fat-containing meal', priority: 'High', interactions: 'None identified' });
      lifestyleAdvice.push({ category: 'Sleep', advice: 'Persistent tiredness despite adequate sleep may indicate poor sleep quality. Evaluate sleep hygiene: consistent schedule, dark/cool room, no screens 1 hour before bed, and limit caffeine after 2pm.' });
    }

    if (/stress|overwhelm|anxious|anxiety|worried|burnout/.test(fd) && !symptoms.includes('Anxiety/Stress')) {
      if (!onAntidepressant)
        recs.push({ name: 'Ashwagandha (KSM-66)', reason: 'The patient reports stress and anxiety. KSM-66 ashwagandha has the strongest clinical evidence for cortisol reduction and stress relief among adaptogens; randomised trials report lower cortisol and reduced perceived stress versus placebo.', dosage: '300-600mg daily', timing: 'Morning or evening with food', priority: 'High', interactions: 'None identified' });
      recs.push({ name: 'L-Theanine', reason: 'L-Theanine promotes calm alertness by increasing alpha brain waves. Particularly effective for stress-related tension without causing drowsiness.', dosage: '200mg as needed', timing: 'During stressful periods or morning', priority: 'Medium', interactions: onAntidepressant ? 'Safe with SSRIs' : 'None identified' });
      lifestyleAdvice.push({ category: 'Stress', advice: 'For burnout and chronic stress, implement daily recovery practices: 10-minute morning meditation, journaling before bed, and at least one screen-free hour daily. Chronic stress depletes magnesium, B vitamins, and Vitamin C � all addressed in your supplement plan.' });
    }

    if (/sleep|insomnia|can't sleep|cant sleep|wake up|waking up|restless/.test(fd) && !symptoms.includes('Poor Sleep')) {
      if (!recs.find(r => r.name.includes('Magnesium')))
        recs.push({ name: 'Magnesium Glycinate', reason: 'The patient reports sleep difficulties. Magnesium glycinate activates GABA receptors to quiet the nervous system and is the most clinically studied supplement for sleep quality improvement.', dosage: '300-400mg daily', timing: '30-60 minutes before bed', priority: 'High', interactions: 'None identified' });
      lifestyleAdvice.push({ category: 'Sleep', advice: 'For insomnia: keep a strict sleep schedule (same time every day), use your bed only for sleep, get bright light exposure in the morning to reset your circadian rhythm, and avoid alcohol which fragments sleep architecture.' });
    }

    if (/digest|bloat|stomach|gut|constipat|diarrhea|ibs|acid|reflux|nausea/.test(fd) && !symptoms.includes('Digestive Issue')) {
      if (!recs.find(r => r.name.includes('Probiotic')))
        recs.push({ name: 'Probiotic (Multi-strain, 50B CFU)', reason: 'The patient reports digestive discomfort. A high-potency multi-strain probiotic restores gut microbiome balance, reduces bloating, and improves bowel regularity.', dosage: '50 billion CFU daily', timing: 'Morning before breakfast', priority: 'High', interactions: 'Safe with all medications' });
      recs.push({ name: 'Digestive Enzymes (broad-spectrum)', reason: 'Digestive enzyme deficiency causes bloating, gas, and incomplete nutrient absorption. A broad-spectrum enzyme supplement containing amylase, protease, and lipase improves digestion of all macronutrients.', dosage: '1-2 capsules per meal', timing: 'At the start of each meal', priority: 'Medium', interactions: 'None identified' });
      lifestyleAdvice.push({ category: 'Diet', advice: 'For digestive issues: eat slowly and chew thoroughly (20+ chews per bite), avoid drinking large amounts of water with meals as it dilutes digestive enzymes, and identify trigger foods by keeping a food diary.' });
    }

    if (/weight|fat|overweight|obese|slim|thin|lose weight|gain weight/.test(fd)) {
      lifestyleAdvice.push({ category: 'Nutrition', advice: 'For weight management, focus on protein at every meal (it increases satiety), eat fiber-rich vegetables to fill up on fewer calories, and avoid liquid calories (sodas, juices, alcohol). Meal timing matters � avoid eating within 3 hours of bedtime.' });
      lifestyleAdvice.push({ category: 'Exercise', advice: 'Combine cardio (150 min/week) with resistance training (2-3x/week) for optimal body composition. Resistance training builds muscle which increases resting metabolic rate, burning more calories even at rest.' });
    }

    if (/depress|sad|low mood|mood|unhappy|hopeless/.test(fd)) {
      if (!onAntidepressant) {
        recs.push({ name: 'Omega-3 (high EPA)', reason: 'EPA-dominant omega-3 has the strongest evidence for mood support among supplements. Multiple meta-analyses show significant antidepressant effects, particularly with EPA doses above 1g/day.', dosage: '1000-2000mg EPA daily', timing: 'With meals', priority: 'High', interactions: onBloodThinner ? 'Use 1g max on blood thinners' : 'None identified' });
        recs.push({ name: 'Vitamin D3', reason: 'Low Vitamin D is strongly correlated with depression. Vitamin D receptors are found throughout the brain and it plays a key role in serotonin synthesis.', dosage: '2000-4000 IU daily', timing: 'With a fat-containing meal', priority: 'High', interactions: 'None identified' });
      }
      lifestyleAdvice.push({ category: 'Exercise', advice: 'Exercise is one of the most evidence-based interventions for depression � as effective as antidepressants in mild-to-moderate cases. Aim for 30 minutes of moderate cardio 5x/week. Even a 10-minute walk improves mood immediately.' });
      warnings.push('If you are experiencing persistent low mood or depression, please consult a mental health professional. Supplements support but do not replace professional mental health care.');
    }
  }

  // -- BMI-aware advice for adults --
  if (weight > 0 && height > 0) {
    const bmi = weight / ((height / 100) ** 2);
    if (bmi < 18.5) {
      lifestyleAdvice.push({ category: 'Nutrition', advice: 'Your BMI indicates you are underweight. Focus on calorie-dense, nutrient-rich foods: nuts, avocados, whole grains, lean proteins, and healthy oils. Aim for 3 meals and 2-3 snacks daily. Consider a high-quality protein supplement if appetite is poor.' });
      recs.push({ name: 'High-Calorie Protein Supplement (Whey or Plant)', reason: 'Underweight individuals often have difficulty meeting caloric and protein needs through diet alone. Protein supplementation supports muscle mass maintenance and healthy weight gain.', dosage: '20-30g protein per serving, 1-2x daily', timing: 'Between meals or post-exercise', priority: 'Medium', interactions: 'None identified' });
    } else if (bmi >= 30) {
      lifestyleAdvice.push({ category: 'Nutrition', advice: 'Your BMI indicates obesity, which increases risk for diabetes, heart disease, and joint problems. Focus on a whole-food, high-fiber diet. Reduce ultra-processed foods, sugary beverages, and refined carbohydrates. A Mediterranean-style diet has the strongest evidence for sustainable weight management.' });
      lifestyleAdvice.push({ category: 'Exercise', advice: 'Start with low-impact exercise to protect joints: walking, swimming, or cycling. Aim for 30 minutes daily, 5 days/week. Even modest weight loss of 5-10% significantly reduces cardiovascular and metabolic risk.' });
      if (!recs.find(r => r.name.includes('Berberine')) && !conditions.includes('Diabetes'))
        recs.push({ name: 'Berberine', reason: 'Berberine improves insulin sensitivity and supports healthy weight management by activating AMPK, the body\'s metabolic master switch. Clinical trials show modest but meaningful weight reduction alongside metabolic improvements.', dosage: '500mg twice daily with meals', timing: 'With breakfast and dinner', priority: 'Medium', interactions: 'Monitor blood sugar if on diabetes medications' });
    }
  }

  // -- AI-published conditions (evidence-gated, scripts/conditionGapAnalysis) --
  {
    const dyn = mergeSelectedBundles(liveDynamic, conditions, a.gender);
    recs.push(...dyn.recs);
    warnings.push(...dyn.warnings);
    avoidList.push(...dyn.avoidList);
    lifestyleAdvice.push(...dyn.lifestyleAdvice);
  }

  // -- General lifestyle if not enough specific advice --
  if (lifestyleAdvice.length < 3) {
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Drink 2-3 liters of water daily. Dehydration causes fatigue, brain fog, headaches, and poor digestion. Start each morning with 500ml of water before coffee or food.' });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Prioritize 7-9 hours of quality sleep. Sleep is when your body repairs, detoxifies, and consolidates memory. Consistent sleep and wake times regulate your circadian rhythm.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Aim for 150 minutes of moderate exercise per week. Even 30-minute daily walks reduce all-cause mortality, improve mood, and support metabolic health.' });
  }

  // -- Action plan --
  actionPlan.push({ phase: 'Week 1 -- Build Foundations', focus: 'Introduce the most critical supplements and establish basic healthy habits.', supplements: recs.filter(r => r.priority === 'High').slice(0,2).map(r => r.name), habits: ['Improve hydration (6-8 glasses of water daily)', 'Establish a consistent sleep schedule', 'Reduce sugary drinks and processed foods'], activity: ['10-15 minute daily walks', 'Light stretching or mobility exercises'], expectedChanges: ['Slight improvement in sleep quality', 'Reduced muscle tension', 'Small increase in energy'] });
  actionPlan.push({ phase: 'Week 2 -- Improve Energy & Recovery', focus: 'Add remaining high-priority supplements and increase daily movement.', supplements: recs.filter(r => r.priority === 'High').slice(2).map(r => r.name), habits: ['Increase protein and whole foods intake', 'Track symptoms daily to note improvements'], activity: ['20-30 minutes of daily movement', 'Light resistance or bodyweight exercises'], expectedChanges: ['Better daytime energy', 'Improved recovery and focus', 'Reduced sluggishness'] });
  actionPlan.push({ phase: 'Weeks 3-4 -- Build Sustainable Habits', focus: 'Add medium-priority supplements and focus on consistency.', supplements: recs.filter(r => r.priority === 'Medium').map(r => r.name), habits: ['Improve meal consistency and portion control', 'Prioritize sleep hygiene: less screen time before bed, regular bedtime'], activity: ['Maintain regular exercise routine', 'Add one new physical activity you enjoy'], expectedChanges: ['Better stamina', 'Improved sleep quality', 'Better mood and physical comfort'] });
  actionPlan.push({ phase: 'Month 2 -- Assess Progress', focus: 'Evaluate improvements and refine your routine based on how your body has responded.', supplements: ['Continue full supplement routine consistently'], habits: ['Review which habits are working and double down on them', 'Address any remaining symptoms with targeted changes'], activity: ['Increase exercise intensity or duration gradually'], expectedChanges: ['Noticeable improvement in primary symptoms', 'More stable energy throughout the day', 'Improved overall wellbeing'] });
  actionPlan.push({ phase: 'Month 3+ -- Long-Term Recovery', focus: 'Sustain progress and reassess with a healthcare provider for long-term optimization.', supplements: ['Reassess supplement stack with a healthcare provider', 'Check relevant lab values (Vitamin D, B12, iron if applicable)'], habits: ['Maintain all established healthy habits', 'Schedule a check-in with your doctor to review progress'], activity: ['Maintain consistent exercise routine', 'Consider adding strength training if not already included'], expectedChanges: ['Full therapeutic effect of supplements reached', 'Sustained symptom relief', 'Long-term health improvements consolidated'] });

  // -- Minimum supplements --
  if (recs.length < 4) {
    if (!recs.find(r => r.name.includes('D3')))
      recs.push({ name: 'Vitamin D3 + K2', reason: 'Deficiency affects 40%+ of adults. Linked to fatigue, immune dysfunction, mood disorders, and bone loss. K2 directs calcium to bones.', dosage: '2000 IU D3 + 100mcg K2 daily', timing: 'With largest meal', priority: 'Medium', interactions: onBloodThinner ? 'K2 may interact with warfarin' : 'None identified' });
    if (!recs.find(r => r.name.includes('Magnesium')))
      recs.push({ name: 'Magnesium Glycinate', reason: 'Involved in 300+ enzymatic reactions. Deficiency linked to fatigue, cramps, poor sleep, anxiety, and cardiovascular issues. Glycinate is best-tolerated form.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'Medium', interactions: 'None identified' });
  }

  return buildResult(a, recs, lifestyleAdvice, actionPlan, warnings, avoidList, conditions, symptoms, goals);
}

// -- Shared result builder --------------------------------------------------
function buildResult(a, recs, lifestyleAdvice, actionPlan, warnings, avoidList, conditions, symptoms, goals) {
  const noMedPhrases = /^(none|no|n\/a|nil|nothing|not taking|no meds|no medication|im not|i'm not|i am not|nope|negative|na$)/i;
  const noAllergyPhrases = /^(none|no|n\/a|nil|nothing|not allergic|no allerg|no known|nkda|nope|negative|na$)/i;

  const hasMeds = a.currentMedications && a.currentMedications.trim() && !noMedPhrases.test(a.currentMedications.trim());
  const hasAllergies = a.allergies && a.allergies.trim() && !noAllergyPhrases.test(a.allergies.trim());

  const agePart = a.age ? `${a.age}-year-old` : null;
  const genderPart = a.gender ? a.gender.toLowerCase() : null;
  let opening = [agePart, genderPart].filter(Boolean).join(' ') || 'patient';
  opening = `A ${opening} patient`;

  let bmiLine = '';
  if (a.weight && a.height) {
    const bmi = (a.weight / ((a.height / 100) ** 2)).toFixed(1);
    const bmiCat = bmi < 18.5 ? 'underweight' : bmi < 25 ? 'normal weight' : bmi < 30 ? 'overweight' : 'obese';
    const bmiStatus = bmi < 18.5 ? 'indicating underweight status' : bmi < 25 ? 'within the normal weight range' : bmi < 30 ? 'indicating overweight status' : 'indicating obesity';
    bmiLine = `with a BMI of ${bmi}, ${bmiStatus},`;
  }
  opening = bmiLine ? `${opening} ${bmiLine}` : `${opening}`;

  // Partial data notice
  const hasBasics = a.age && a.gender && a.weight && a.height;
  const hasSymptomOrGoal = symptoms.length > 0 || goals.length > 0;
  const isPartialData = !hasBasics || !hasSymptomOrGoal;
  const partialNotice = isPartialData
    ? 'Note: Incomplete health profile provided. More information is needed for fully personalized recommendations. The following suggestions are based on available data and carry lower confidence. '
    : '';

  const conditionSentence = conditions.length
    ? `Medical history is notable for ${conditions.join(' and ')}.`
    : 'No significant medical history reported.';

  const medSentence = hasMeds
    ? `Current medications include ${a.currentMedications.trim()}. Supplement recommendations have been reviewed for potential drug interactions.`
    : 'Patient is not currently taking any prescription medications.';

  const allergySentence = hasAllergies
    ? `Known allergies: ${a.allergies.trim()}.`
    : 'No known drug or food allergies reported.';

  // New fields in summary
  const stressSentence = a.stressLevel ? `Reported stress level: ${a.stressLevel}.` : '';
  const sleepSentence = a.sleepQuality ? `Sleep quality: ${a.sleepQuality}.` : '';
  const lifestyleSentence = a.lifestyleHabits?.filter(h => h !== 'None').length
    ? `Lifestyle factors noted: ${a.lifestyleHabits.filter(h => h !== 'None').join(', ')}.`
    : '';
  const pregnancySentence = (a.pregnancyStatus && a.pregnancyStatus !== 'Not applicable')
    ? `Pregnancy/breastfeeding status: ${a.pregnancyStatus}.`
    : '';

  let complaintSentence = '';
  const filteredSymptoms = symptoms.filter(s => s !== 'No current symptoms');
  if (filteredSymptoms.length && goals.length) complaintSentence = `reports ${filteredSymptoms.join(', ')}, with wellness goals focused on ${goals.join(', ')}.`;
  else if (filteredSymptoms.length) complaintSentence = `reports ${filteredSymptoms.join(', ')}.`;
  else if (goals.length) complaintSentence = `presents with wellness goals including ${goals.join(', ')}.`;

  let feelingSentence = '';
  if (a.feelingDescription && a.feelingDescription.trim() && !noMedPhrases.test(a.feelingDescription.trim())) {
    const raw = a.feelingDescription.trim().replace(/^["']|["']$/g, '');
    const normalized = raw
      .replace(/\bi\s+feel\b/gi, 'The patient reports feeling')
      .replace(/\bi\s+have\b/gi, 'The patient has')
      .replace(/\bi\s+am\b/gi, 'The patient is')
      .replace(/\bi\s+experience\b/gi, 'The patient experiences')
      .replace(/\bmy\b/gi, 'their')
      .replace(/\bi\b/gi, 'the patient');
    feelingSentence = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    if (!feelingSentence.endsWith('.')) feelingSentence += '.';
  }

  const summary = [
    partialNotice,
    `${opening} ${complaintSentence}`,
    conditionSentence, medSentence, allergySentence,
    stressSentence, sleepSentence, lifestyleSentence, pregnancySentence,
    feelingSentence,
    'The following evidence-based wellness plan addresses targeted supplementation alongside lifestyle modifications to support overall health improvement.'
  ].filter(Boolean).join(' ');

  // -- Consult doctor triggers --
  const fd = anchorText((a.feelingDescription || '').toLowerCase(), ['health', 'safety']);
  const consultTriggers = [
    { test: /chest\s*pain|heart\s*attack|palpitation/.test(fd), reason: 'Reported chest pain or heart-related symptoms require immediate medical evaluation.' },
    { test: /rapid\s*weight\s*loss|losing weight fast|unexplained weight/.test(fd), reason: 'Unexplained rapid weight loss should be evaluated by a physician.' },
    { test: mentionsCrisis(fd), reason: 'Reported mental health crisis symptoms require immediate professional support.' },
    { test: symptoms.includes('Anxiety/Stress') && conditions.length > 1, reason: 'Multiple medical conditions combined with anxiety symptoms warrant physician oversight.' },
    { test: conditions.includes('Heart Disease') || conditions.includes('Kidney Disease'), reason: 'Your medical conditions require physician supervision before starting any supplement regimen.' },
  ];
  const triggered = consultTriggers.find(t => t.test);
  const consultDoctor = !!triggered;
  const consultReason = triggered?.reason || null;

  // -- Enrich recs with new fields --
  //
  // EVERY field the reader can be shown is filled here, including the two
  // plain-language ones. They used to be the exception, which meant a plan
  // produced by this engine rendered its Simplified view as a copy of the
  // clinical one: the control looked broken rather than simply unavailable.
  // See utils/recommendationPlainLanguage.js.
  const enrichedRecs = recs.map(rec => ({
    ...rec,
    simplifiedReason: rec.simplifiedReason
      || simplifiedReasonFor({ name: rec.name, symptoms, goals, conditions }),
    simplifiedEvidence: rec.simplifiedEvidence || simplifiedEvidenceFor(rec.name),
    triggeredBy: rec.triggeredBy || inferTriggeredBy(rec.name, symptoms, goals, conditions, a),
    confidenceScore: rec.confidenceScore || inferConfidence(rec.name, symptoms, goals, conditions, a),
    severityLevel: rec.severityLevel || inferSeverity(rec.priority, symptoms, a),
    evidence: rec.evidence || inferEvidence(rec.name),
    foods: dietAdjustFoods(rec.foods || inferFoods(rec.name), a.dietType),
    sideEffects: rec.sideEffects || inferSideEffects(rec.name),
  }));

  // -- Meal recommendations --
  const mealRecommendations = buildMealRecs(symptoms, goals, conditions, a);

  // -- Daily schedule --
  const dailySchedule = buildDailySchedule(enrichedRecs);

  return {
    summary,
    consultDoctor,
    consultReason,
    recommendations: enrichedRecs,
    lifestyleAdvice: lifestyleAdvice.slice(0, 6),
    mealRecommendations,
    dailySchedule,
    actionPlan,
    warnings: warnings.length ? warnings : ['Always inform your healthcare provider about supplements, especially with chronic conditions or prescription medications.'],
    avoidList: avoidList.length ? avoidList : [],
    seekingSupport: (a.lifestyleHabits || []).includes('Recreational Drugs') ? buildSeekingSupport() : null,
    disclaimer: 'This information is for educational and wellness purposes only and does not diagnose, treat, or cure any disease. Always consult a licensed healthcare professional before starting any supplement regimen, especially if you have existing medical conditions or take prescription medications.',
  };
}

// -- Helper: infer what triggered a recommendation --
function inferTriggeredBy(name, symptoms, goals, conditions, a) {
  const n = name.toLowerCase();
  if (n.includes('b12')) return symptoms.includes('Fatigue') ? 'Reported fatigue' : 'Nutritional support';
  if (n.includes('magnesium')) return symptoms.includes('Poor Sleep') ? 'Poor sleep reported' : symptoms.includes('Anxiety/Stress') ? 'Anxiety/stress reported' : 'General wellness';
  if (n.includes('omega')) return symptoms.includes('Brain Fog') ? 'Brain fog reported' : goals.includes('Support Heart Health') ? 'Heart health goal' : 'Anti-inflammatory support';
  if (n.includes('vitamin d')) return 'General deficiency prevention';
  if (n.includes('iron')) return symptoms.includes('Fatigue') ? 'Fatigue and possible low iron' : 'Nutritional support';
  if (n.includes('zinc')) return symptoms.includes('Frequent Colds') ? 'Frequent illness reported' : 'Immune support goal';
  if (n.includes('ashwagandha') || n.includes('theanine')) return 'Stress/anxiety reported';
  if (n.includes('probiotic')) return symptoms.includes('Digestive Issue') ? 'Digestive issues reported' : 'Gut health goal';
  if (n.includes('coq10')) return conditions.includes('High Blood Pressure') ? 'High blood pressure' : 'Cardiovascular support';
  if (n.includes('curcumin')) return symptoms.includes('Joint Pain') ? 'Joint pain reported' : 'Anti-inflammatory support';
  return 'Based on overall health profile';
}

// -- Helper: infer confidence score --
function inferConfidence(name, symptoms, goals, conditions, a) {
  const n = name.toLowerCase();
  const sev = a?.symptomSeverity || {};
  // High confidence when directly matching a symptom with severity
  if (n.includes('magnesium') && symptoms.includes('Poor Sleep')) return sev['Poor Sleep'] === 'Severe' ? 95 : 92;
  if (n.includes('b12') && symptoms.includes('Fatigue')) return sev['Fatigue'] === 'Severe' ? 92 : 88;
  if (n.includes('omega') && symptoms.includes('Brain Fog')) return sev['Brain Fog'] === 'Severe' ? 90 : 85;
  if (n.includes('ashwagandha') && symptoms.includes('Anxiety/Stress')) return sev['Anxiety/Stress'] === 'Severe' ? 92 : 87;
  if (n.includes('probiotic') && symptoms.includes('Digestive Issue')) return 90;
  if (n.includes('zinc') && symptoms.includes('Frequent Colds')) return 86;
  if (n.includes('curcumin') && symptoms.includes('Joint Pain')) return sev['Joint Pain'] === 'Severe' ? 90 : 84;
  if (n.includes('iron') && symptoms.includes('Fatigue')) return 80;
  if (n.includes('coq10') && conditions.includes('High Blood Pressure')) return 89;
  // Stress/sleep-triggered
  if (n.includes('ashwagandha') && (a?.stressLevel === 'High' || a?.stressLevel === 'Severe')) return 88;
  if (n.includes('magnesium') && (a?.sleepQuality === 'Very Poor' || a?.sleepQuality === 'Poor')) return 91;
  if (n.includes('melatonin') && (a?.sleepQuality === 'Very Poor' || a?.sleepQuality === 'Poor')) return 82;
  // Medium confidence for general recommendations
  if (n.includes('vitamin d')) return 78;
  if (n.includes('omega')) return 75;
  // Lower confidence for partial data
  if (!a?.age || !a?.gender) return 60;
  return 72;
}

// -- Helper: infer severity level --
function inferSeverity(priority, symptoms, a) {
  const sev = a?.symptomSeverity || {};
  const sevValues = Object.values(sev);
  if (sevValues.includes('Severe')) return 'Severe';
  if (sevValues.includes('Moderate')) return 'Moderate';
  if (priority === 'High' && symptoms.length >= 3) return 'Moderate';
  if (priority === 'High') return 'Mild to Moderate';
  if (priority === 'Medium') return 'Mild';
  return 'Preventive';
}

// -- Helper: infer evidence reference --
// The strings themselves moved to utils/supplementEvidenceRegistry.js so the
// prompt can show the model the same table and planGrounding.js can check the
// reply against it. One copy of the curated citations, three uses.
function inferEvidence(name) {
  return registeredEvidence(name);
}

// -- Helper: infer food sources --
// -- Diet-aware food adjustment ----------------------------------------------
// Both inferFoods and the model return the GENERICALLY richest food sources
// for a nutrient — "Beef liver, clams, sardines" for B12 — which is correct
// nutrition science and wrong for a vegan. The prompt forbids it and the
// benchmark (eval/aiBenchmark.js) measures it; this is where it is GUARANTEED:
// forbidden items are dropped and the diet's own top sources backfill.
const DIET_SAFE_POOL = {
  vegan: ['fortified plant milk', 'nutritional yeast', 'tempeh', 'tofu', 'algae oil', 'pumpkin seeds', 'lentils', 'chia seeds'],
  vegetarian: ['hard-boiled eggs', 'Greek yogurt', 'cheese', 'milk', 'tofu', 'lentils', 'almonds'],
  pescatarian: ['salmon', 'sardines', 'mackerel', 'Greek yogurt', 'lentils', 'tofu'],
  keto: ['eggs', 'salmon', 'avocado', 'cheese', 'sardines', 'nuts'],
};

function dietAdjustFoods(foods, dietType) {
  const diet = String(dietType || '').toLowerCase();
  const pool = DIET_SAFE_POOL[diet];
  if (!pool) return foods;
  const items = (Array.isArray(foods) ? foods : String(foods || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
  const kept = items.filter((it) => !containsForbiddenFood(it, diet));
  for (const option of pool) {
    if (kept.length >= 5) break;
    if (!kept.some((k) => k.toLowerCase().includes(option))) kept.push(option);
  }
  return Array.isArray(foods) ? kept : kept.join(', ');
}

function inferFoods(name) {
  const n = name.toLowerCase();
  if (n.includes('magnesium')) return 'Dark chocolate (70%+), almonds, pumpkin seeds, spinach, black beans, avocado, cashews';
  if (n.includes('b12')) return 'Beef liver, clams, sardines, Atlantic salmon, hard-boiled eggs, Greek yogurt';
  if (n.includes('omega') || n.includes('fish oil')) return 'Atlantic salmon, mackerel, sardines, herring, anchovies, walnuts, chia seeds, flaxseeds';
  if (n.includes('vitamin d')) return 'Sockeye salmon, canned tuna, rainbow trout, UV-exposed portobello mushrooms, fortified whole milk, egg yolks';
  if (n.includes('zinc')) return 'Oysters, beef chuck, pumpkin seeds, chickpeas, cashews, hemp seeds, crab';
  if (n.includes('iron')) return 'Beef liver, grass-fed ground beef, lentils, tofu, pumpkin seeds, dark chocolate (85%+), spinach';
  if (n.includes('vitamin c')) return 'Red bell peppers, guava, kiwi, strawberries, broccoli, papaya, orange juice';
  if (n.includes('calcium')) return 'Plain Greek yogurt, canned sardines with bones, kale, bok choy, fortified oat milk, almonds, white beans';
  if (n.includes('potassium')) return 'Sweet potatoes, avocado, spinach, white beans, bananas, Atlantic salmon, beet greens';
  if (n.includes('selenium')) return 'Brazil nuts (1-2 per day), yellowfin tuna, sardines, hard-boiled eggs, sunflower seeds, chicken breast';
  if (n.includes('vitamin k')) return 'Kale, Swiss chard, spinach, Brussels sprouts, broccoli, natto, parsley';
  if (n.includes('vitamin b6') || n.includes('b6')) return 'Chickpeas, yellowfin tuna, chicken breast, potatoes, bananas, pistachio nuts';
  if (n.includes('folate') || n.includes('folic')) return 'Beef liver, edamame, lentils, asparagus, spinach, avocado, black-eyed peas';
  if (n.includes('iodine')) return 'Seaweed (nori, wakame), cod, plain yogurt, iodized salt, shrimp, eggs';
  if (n.includes('coq10')) return 'Beef heart, herring, chicken liver, rainbow trout, peanuts, sesame seeds, broccoli';
  if (n.includes('collagen')) return 'Bone broth, chicken skin, pork rinds, sardines, egg whites, citrus fruits (for Vitamin C to support collagen synthesis)';
  if (n.includes('probiotic')) return 'Plain Greek yogurt, kefir, kimchi, sauerkraut, miso, tempeh, kombucha';
  if (n.includes('curcumin') || n.includes('turmeric')) return 'Turmeric root, curry powder, golden milk, turmeric tea (pair with black pepper to enhance absorption)';
  if (n.includes('ashwagandha')) return 'Ashwagandha root powder (supplement form ? not widely available in common foods)';
  if (n.includes('creatine')) return 'Beef, pork, herring, salmon, tuna, chicken breast (creatine is found almost exclusively in animal muscle tissue)';
  if (n.includes('melatonin')) return 'Tart cherries, walnuts, almonds, oats, bananas, tomatoes, grapes';
  if (n.includes('inositol')) return 'Cantaloupe, citrus fruits, beans, brown rice, corn, sesame seeds, wheat germ';
  if (n.includes('copper')) return 'Beef liver, oysters, dark chocolate, almonds, cashews, sunflower seeds, shiitake mushrooms';
  if (n.includes('manganese')) return 'Mussels, hazelnuts, pecans, brown rice, chickpeas, spinach, pineapple, black tea';
  if (n.includes('molybdenum')) return 'Legumes (lentils, black beans, peas), whole grains, nuts, leafy vegetables, liver';
  if (n.includes('chromium')) return 'Broccoli, grape juice, whole wheat bread, beef, orange juice, turkey breast, potatoes';
  if (n.includes('vitamin c')) return 'Red bell peppers, guava, kiwi, strawberries, broccoli, papaya, orange juice, Brussels sprouts';
  if (n.includes('vitamin a') || n.includes('retinol')) return 'Beef liver, sweet potatoes, carrots, spinach, kale, butternut squash, eggs, fortified dairy';
  if (n.includes('vitamin e') || n.includes('tocopherol')) return 'Sunflower seeds, almonds, hazelnuts, peanut butter, spinach, broccoli, avocado, wheat germ oil';
  if (n.includes('vitamin b6') || n.includes('pyridoxine')) return 'Chickpeas, yellowfin tuna, chicken breast, potatoes, bananas, pistachio nuts, avocado';
  if (n.includes('riboflavin') || n.includes('vitamin b2')) return 'Beef liver, lamb, milk, natural yogurt, mushrooms, almonds, eggs, quinoa';
  if (n.includes('niacin') || n.includes('vitamin b3')) return 'Chicken breast, tuna, turkey, salmon, beef, peanuts, mushrooms, avocado, brown rice';
  if (n.includes('thiamine') || n.includes('vitamin b1')) return 'Pork, trout, black beans, edamame, sunflower seeds, fortified cereals, asparagus, acorn squash';
  if (n.includes('pantothenic') || n.includes('vitamin b5')) return 'Beef liver, sunflower seeds, chicken, tuna, avocado, mushrooms, sweet potatoes, lentils';
  if (n.includes('biotin') || n.includes('vitamin b7')) return 'Beef liver, eggs, salmon, avocado, pork, sweet potatoes, almonds, sunflower seeds';
  if (n.includes('vitamin k2') || n.includes('mk-7') || n.includes('menaquinone')) return 'Natto (fermented soybeans), hard cheeses, soft cheeses, egg yolks, butter, chicken liver, salami';
  if (n.includes('vitamin k')) return 'Kale, Swiss chard, spinach, Brussels sprouts, broccoli, natto, parsley, collard greens';
  if (n.includes('rhodiola')) return 'Rhodiola rosea root (supplement form ? grows in cold mountainous regions, not a common food)';
  if (n.includes('ginseng') || n.includes('panax')) return 'Ginseng root (supplement form ? not commonly found in everyday foods)';
  if (n.includes('maca')) return 'Maca root powder (supplement form ? can be added to smoothies, oatmeal, or baked goods)';
  if (n.includes('valerian')) return 'Valerian root (supplement form ? not commonly found in food)';
  if (n.includes('elderberry') || n.includes('sambucus')) return 'Elderberries (cooked or processed ? raw berries are toxic), elderberry syrup, elderberry tea';
  if (n.includes('echinacea')) return 'Echinacea (supplement form ? not commonly found in food)';
  if (n.includes('milk thistle') || n.includes('silymarin')) return 'Milk thistle seeds (supplement form ? not commonly found in everyday foods)';
  if (n.includes('ginkgo')) return 'Ginkgo biloba leaves (supplement form ? not commonly found in food)';
  if (n.includes('bacopa')) return 'Bacopa monnieri (supplement form ? not commonly found in food)';
  if (n.includes('theanine') || n.includes('l-theanine')) return 'Green tea, black tea, white tea, matcha (L-theanine is found almost exclusively in tea leaves)';
  if (n.includes('alpha-lipoic') || n.includes('lipoic')) return 'Beef liver, spinach, broccoli, Brussels sprouts, tomatoes, peas, rice bran (small amounts in food)';
  if (n.includes('resveratrol')) return 'Red grapes, red wine, blueberries, cranberries, peanuts, dark chocolate, mulberries';
  if (n.includes('glucosamine')) return 'Shellfish shells (supplement derived ? not found in significant amounts in common foods)';
  if (n.includes('chondroitin')) return 'Animal cartilage (supplement derived ? bone broth contains small amounts)';
  if (n.includes('boswellia')) return 'Boswellia serrata resin (supplement form ? not commonly found in food)';
  if (n.includes('tart cherry')) return 'Tart cherries (Montmorency variety), tart cherry juice, tart cherry extract';
  if (n.includes('garlic') || n.includes('allicin')) return 'Fresh garlic, garlic powder, black garlic, garlic oil, leeks, onions, chives';
  if (n.includes('saw palmetto')) return 'Saw palmetto berries (supplement form ? not commonly found in food)';
  if (n.includes('vitex') || n.includes('chaste')) return 'Vitex agnus-castus berries (supplement form ? not commonly found in food)';
  if (n.includes('tribulus')) return 'Tribulus terrestris (supplement form ? not commonly found in food)';
  if (n.includes('hyaluronic')) return 'Bone broth, chicken combs, soy-based foods, root vegetables (small amounts ? supplement form most effective)';
  if (n.includes('astaxanthin')) return 'Wild-caught salmon, shrimp, lobster, crab, trout, microalgae (Haematococcus pluvialis)';
  if (n.includes('phosphatidylserine')) return 'Soy lecithin, white beans, egg yolks, chicken liver, Atlantic mackerel, herring';
  if (n.includes('hmb') || n.includes('beta-hydroxy')) return 'Alfalfa, catfish, grapefruit, avocado (very small amounts ? supplement form needed for therapeutic doses)';
  if (n.includes('citrulline')) return 'Watermelon, cucumber, pumpkin, squash, bitter melon (citrulline is highest in watermelon rind)';
  if (n.includes('beta-alanine')) return 'Chicken breast, turkey, beef, pork, fish (beta-alanine is found in animal muscle tissue)';
  if (n.includes('whey') || (n.includes('protein') && n.includes('supplement'))) return 'Whey protein powder, Greek yogurt, cottage cheese, ricotta, milk (whey is a dairy byproduct)';
  if (n.includes('5-htp')) return 'Griffonia simplicifolia seeds (supplement source ? small amounts in turkey, chicken, milk, pumpkin seeds)';
  if (n.includes('glycine')) return 'Bone broth, gelatin, pork skin, chicken skin, beef, fish, dairy, legumes';
  if (n.includes('nattokinase')) return 'Natto (fermented soybeans) ? the only significant food source of nattokinase';
  if (n.includes('hawthorn')) return 'Hawthorn berries, hawthorn tea, hawthorn extract (supplement form most effective)';
  return 'Obtain from a varied whole-food diet including lean proteins, leafy greens, legumes, nuts, seeds, and whole grains';
}

// -- Helper: infer side effects --
function inferSideEffects(name) {
  const n = name.toLowerCase();
  if (n.includes('magnesium')) return 'Loose stools at high doses (>400mg). Glycinate form minimizes this. Upper limit: 350mg supplemental.';
  if (n.includes('iron')) return 'Constipation, nausea, dark stools. Take with food if stomach upset occurs. Do not exceed 45mg/day without medical supervision.';
  if (n.includes('zinc')) return 'Nausea if taken on empty stomach. Long-term high doses (>40mg) may deplete copper. Take with food.';
  if (n.includes('vitamin d')) return 'Toxicity possible above 4000 IU/day long-term. Symptoms: nausea, weakness, frequent urination. Get levels tested before high-dose use.';
  if (n.includes('omega') || n.includes('fish oil')) return 'Fishy aftertaste, mild GI upset. Take with meals. High doses (>3g) may thin blood.';
  if (n.includes('ashwagandha')) return 'May cause drowsiness in some. Avoid in pregnancy. Rare: liver sensitivity at very high doses.';
  if (n.includes('b12')) return 'Very safe � water soluble, excess is excreted. No known toxicity at recommended doses.';
  if (n.includes('coq10')) return 'Generally well tolerated. Mild GI upset possible. May lower blood pressure � monitor if on BP medications.';
  if (n.includes('curcumin')) return 'May cause GI upset at high doses. Avoid high doses in pregnancy or with blood thinners.';
  if (n.includes('berberine')) return 'May cause GI discomfort initially. Can lower blood sugar � monitor if diabetic. Avoid in pregnancy.';
  if (n.includes('vitamin c')) return 'GI upset and diarrhea at doses above 2000mg. Upper limit: 2000mg/day.';
  if (n.includes('vitamin d')) return 'Toxicity possible above 4000 IU/day long-term. Symptoms: nausea, weakness, frequent urination. Get levels tested before high-dose use.';
  if (n.includes('vitamin a') || n.includes('retinol')) return 'Toxicity at high doses (>10,000 IU/day). Avoid in pregnancy. Symptoms: nausea, headache, liver damage. Upper limit: 3000 mcg RAE/day.';
  if (n.includes('vitamin e')) return 'High doses (>1000mg) may increase bleeding risk. Upper limit: 1000mg/day.';
  if (n.includes('vitamin k')) return 'Interferes with warfarin (blood thinners) ? consult doctor before use. Generally safe at food levels.';
  if (n.includes('folate') || n.includes('folic')) return 'High doses may mask B12 deficiency. Upper limit: 1000mcg synthetic folic acid/day.';
  if (n.includes('niacin')) return 'Flushing, itching, and redness at doses above 50mg. Extended-release forms reduce flushing. Upper limit: 35mg/day for flushing form.';
  if (n.includes('calcium')) return 'Constipation, kidney stones at very high doses. Upper limit: 2500mg/day total from all sources.';
  if (n.includes('selenium')) return 'Selenosis (toxicity) above 400mcg/day: hair loss, nail brittleness, GI issues. Upper limit: 400mcg/day.';
  if (n.includes('iodine')) return 'Excess iodine can worsen thyroid conditions. Upper limit: 1100mcg/day. Avoid high doses with thyroid disease.';
  if (n.includes('potassium')) return 'High-dose supplements can cause GI upset and dangerous heart rhythm changes. Do not exceed 99mg without medical supervision.';
  if (n.includes('copper')) return 'Nausea, vomiting at high doses. Upper limit: 10mg/day. Long-term excess may cause liver damage.';
  if (n.includes('manganese')) return 'Neurological symptoms at very high doses. Upper limit: 11mg/day. Generally safe at recommended doses.';
  if (n.includes('chromium')) return 'Generally well tolerated. Rare: kidney and liver damage at very high doses. Avoid with kidney disease.';
  if (n.includes('omega') || n.includes('fish oil') || n.includes('krill')) return 'Fishy aftertaste, mild GI upset. Take with meals. High doses (>3g) may thin blood. Upper limit: 3g/day without medical supervision.';
  if (n.includes('rhodiola')) return 'Generally well tolerated. Mild insomnia or irritability if taken late in the day. Avoid in bipolar disorder.';
  if (n.includes('ginseng') || n.includes('panax')) return 'Insomnia, headache, GI upset at high doses. Avoid with blood thinners and stimulants. Cycle use recommended.';
  if (n.includes('maca')) return 'Generally well tolerated. Mild GI upset initially. Avoid in hormone-sensitive conditions without medical advice.';
  if (n.includes('valerian')) return 'Drowsiness, dizziness. Do not drive after taking. Avoid with sedatives or alcohol.';
  if (n.includes('elderberry')) return 'Generally safe. Raw elderberries are toxic ? use only processed supplements. Avoid with immunosuppressants.';
  if (n.includes('echinacea')) return 'Rare allergic reactions, especially in those allergic to ragweed. Avoid with autoimmune conditions.';
  if (n.includes('milk thistle') || n.includes('silymarin')) return 'Generally well tolerated. Mild laxative effect. Rare: allergic reaction in those sensitive to ragweed family.';
  if (n.includes('ginkgo')) return 'May increase bleeding risk. Avoid with blood thinners. Rare: headache, GI upset, dizziness.';
  if (n.includes('bacopa')) return 'GI upset, nausea, dry mouth. Take with food. May slow heart rate ? caution with bradycardia medications.';
  if (n.includes('theanine') || n.includes('l-theanine')) return 'Generally very safe. Mild drowsiness at high doses. No known upper limit.';
  if (n.includes('alpha-lipoic') || n.includes('lipoic')) return 'May lower blood sugar ? monitor if diabetic. Rare: skin rash, GI upset. Avoid with thyroid medications.';
  if (n.includes('resveratrol')) return 'Generally well tolerated. High doses may have mild blood-thinning effect. Avoid before surgery.';
  if (n.includes('glucosamine')) return 'Mild GI upset. May affect blood sugar in diabetics. Shellfish allergy: use non-shellfish derived forms.';
  if (n.includes('chondroitin')) return 'Generally well tolerated. Mild GI upset. May have mild blood-thinning effect at high doses.';
  if (n.includes('collagen')) return 'Generally well tolerated. Rare: mild GI discomfort, allergic reaction in those sensitive to fish or eggs.';
  if (n.includes('boswellia')) return 'Mild GI upset. Rare: skin rash. Generally well tolerated at recommended doses.';
  if (n.includes('creatine')) return 'Water retention (intracellular), mild GI upset if taken without adequate water. Safe at 3-5g/day long-term.';
  if (n.includes('melatonin')) return 'Drowsiness, headache, dizziness. Do not drive after taking. Start with lowest effective dose (0.5mg). Avoid long-term high doses.';
  if (n.includes('5-htp')) return 'Nausea, GI upset especially at start. Do not combine with SSRIs or MAOIs (serotonin syndrome risk).';
  if (n.includes('tart cherry')) return 'Generally very safe. High in natural sugars ? monitor if diabetic. Mild GI upset at high doses.';
  if (n.includes('garlic') || n.includes('allicin')) return 'Bad breath, GI upset, heartburn. May increase bleeding risk ? avoid before surgery or with blood thinners.';
  if (n.includes('saw palmetto')) return 'Mild GI upset, headache, dizziness. Rare: liver damage at high doses. Avoid in pregnancy.';
  if (n.includes('vitex') || n.includes('chaste')) return 'Mild GI upset, headache, acne-like rash. Avoid with hormonal medications or in pregnancy.';
  if (n.includes('tribulus')) return 'Mild GI upset. Rare: liver and kidney toxicity at very high doses. Avoid with diabetes medications.';
  if (n.includes('hyaluronic')) return 'Generally very safe orally. Rare: mild GI upset. Avoid with active infections or cancer history.';
  if (n.includes('astaxanthin')) return 'Generally very safe. Mild skin yellowing at very high doses. No established upper limit.';
  if (n.includes('phosphatidylserine')) return 'Generally well tolerated. Mild GI upset at high doses. Avoid with blood thinners.';
  if (n.includes('hmb') || n.includes('beta-hydroxy')) return 'Generally well tolerated. Mild GI upset. No significant adverse effects at recommended doses.';
  if (n.includes('citrulline')) return 'Generally well tolerated. Mild GI upset at high doses. May lower blood pressure ? monitor if on antihypertensives.';
  if (n.includes('beta-alanine')) return 'Tingling/flushing sensation (paresthesia) ? harmless and dose-dependent. Reduces with sustained-release forms.';
  if (n.includes('whey') || (n.includes('protein') && n.includes('supplement'))) return 'GI upset in lactose-intolerant individuals. Use isolate form to minimize lactose. Avoid with kidney disease at high doses.';
  return 'Generally well tolerated at recommended doses. Consult a healthcare provider if you experience adverse effects.';
}

// -- Helper: build meal recommendations (diet/allergy/condition-aware) --
function buildMealRecs(symptoms, goals, conditions, a) {
  const age = Number(a.age) || 0;
  const isChild = age > 0 && age <= 12;
  const diet = (a.dietType || '').toLowerCase();
  const allergiesRaw = (a.allergies || '').toLowerCase();

  // Allergy helpers
  const hasAllergy = (...terms) => terms.some(t => allergiesRaw.includes(t.toLowerCase()));
  const noFish      = hasAllergy('fish','seafood','salmon','tuna','anchov','sardine');
  const noShellfish = hasAllergy('shellfish','shrimp','prawn','crab','lobster','oyster','clam','mussel','scallop');
  const noNuts      = hasAllergy('nut','almond','walnut','cashew','peanut','pistachio','pecan','hazelnut');
  const noDairy     = hasAllergy('dairy','milk','cheese','yogurt','lactose','whey','casein');
  const noEgg       = hasAllergy('egg');
  const noGluten    = hasAllergy('gluten','wheat','barley','rye','spelt') || conditions.includes('Celiac Disease / Gluten Sensitivity');
  const noSoy       = hasAllergy('soy','tofu','tempeh','edamame','miso');
  const noLegume    = hasAllergy('legume','bean','lentil','chickpea','pea');

  // Diet helpers
  const isVegan       = diet === 'vegan';
  const isKeto        = diet === 'keto';
  const isPaleo       = diet === 'paleo';
  const isCarnivore   = diet === 'carnivore';
  const isPescatarian = diet === 'pescatarian';
  const isPlantBased  = isVegan || diet === 'vegetarian';
  const noMeat        = isPlantBased;
  const noAnimal      = isVegan;
  const noGrainsDiet  = isKeto || isPaleo || isCarnivore;
  const noDairyDiet   = isVegan || isPaleo;
  const noDairyAll    = noDairy || noDairyDiet;
  const noFishDiet    = isPlantBased;
  const noFishAll     = noFish || noFishDiet;

  // Condition flags
  const isDiabetic   = conditions.includes('Diabetes');
  const isHypertension = conditions.includes('Hypertension (High Blood Pressure)');
  const isKidney     = conditions.includes('Chronic Kidney Disease');
  const isIBS        = conditions.includes('Irritable Bowel Syndrome (IBS)');

  // Protein picker
  const pickProtein = (...prefer) => {
    if (isCarnivore) return noMeat ? 'grilled portobello' : 'grilled chicken';
    const opts = [];
    if (!noMeat)                    opts.push('grilled chicken breast','lean turkey');
    if (!noFishAll && !isKidney)    opts.push('grilled salmon','canned tuna','sardines');
    if (!noAnimal && !noEgg)        opts.push('boiled eggs','scrambled eggs');
    if (!noAnimal && !noDairyAll)   opts.push('Greek yogurt','cottage cheese');
    if (!noSoy && !isCarnivore)     opts.push('firm tofu','tempeh');
    if (!noLegume && !isCarnivore && !isKeto) opts.push('lentils','chickpeas','black beans');
    for (const p of prefer) { const m = opts.find(o => o.includes(p)); if (m) return m; }
    return opts[0] || 'grilled chicken breast';
  };

  // Base picker (carb)
  const pickBase = () => {
    if (noGrainsDiet || isCarnivore) return null;
    if (noGluten)  return 'quinoa';
    if (isDiabetic) return 'brown rice';
    return 'brown rice';
  };

  // Veggie picker
  const pickVeg = (...prefer) => {
    if (isIBS)    return 'steamed carrots and zucchini';
    if (isKidney) return 'steamed green beans and cabbage';
    const opts = ['steamed broccoli','wilted spinach','roasted sweet potato','mixed greens','steamed asparagus','kale salad'];
    for (const p of prefer) { const m = opts.find(o => o.includes(p)); if (m) return m; }
    return opts[0];
  };

  const base = pickBase();
  const meals = [];

  // BREAKFAST
  if (isKeto || isCarnivore) {
    const item = noEgg ? 'smoked salmon with avocado' : 'scrambled eggs with' + (isCarnivore ? ' bacon' : ' avocado and spinach');
    meals.push({ meal: 'Breakfast', suggestion: item + ' -- high-protein, zero-carb start to support energy and ketosis.' });
  } else if (isPlantBased) {
    const oat = noGluten ? 'buckwheat porridge' : 'overnight oats';
    const top = noNuts ? 'blueberries and chia seeds' : 'walnuts, blueberries, and chia seeds';
    meals.push({ meal: 'Breakfast', suggestion: oat + ' with ' + top + ' -- plant-based omega-3, antioxidants, and slow-release energy.' });
  } else if (isDiabetic) {
    const p = noEgg ? (noDairyAll ? 'avocado' : 'Greek yogurt') : 'boiled eggs';
    const b = noGluten ? 'rice cakes' : 'whole grain toast';
    meals.push({ meal: 'Breakfast', suggestion: p + ' with ' + b + ' and cucumber -- low-GI start to stabilize morning blood sugar.' });
  } else if (isHypertension) {
    const oat = noGluten ? 'quinoa porridge' : 'oatmeal';
    meals.push({ meal: 'Breakfast', suggestion: oat + ' with banana and ' + (noDairyAll ? 'oat milk' : 'low-fat milk') + ' -- potassium, magnesium, and fiber to support healthy blood pressure (DASH diet).' });
  } else {
    const p = noEgg ? (noDairyAll ? 'avocado on rice cakes' : 'cottage cheese') : 'spinach and egg omelette';
    const b = noGluten ? '' : ' with whole grain toast';
    meals.push({ meal: 'Breakfast', suggestion: p + b + ' -- protein, B vitamins, and iron for sustained morning energy.' });
  }

  // LUNCH
  if (isKidney) {
    const p = noMeat ? 'tofu' : 'grilled chicken';
    meals.push({ meal: 'Lunch', suggestion: p + ' with white rice and steamed green beans -- kidney-friendly, controlled phosphorus and potassium.' });
  } else if (isDiabetic) {
    const p = pickProtein('chicken','salmon','lentil');
    meals.push({ meal: 'Lunch', suggestion: p.charAt(0).toUpperCase()+p.slice(1) + ' salad with mixed greens, cucumber, olive oil, and apple cider vinegar -- low-GI, high-fiber, supports blood sugar stability.' });
  } else if (isHypertension) {
    const p = pickProtein('salmon','chicken','lentil');
    meals.push({ meal: 'Lunch', suggestion: p.charAt(0).toUpperCase()+p.slice(1) + ' with steamed spinach and sweet potato -- potassium-rich, low-sodium, DASH-aligned.' });
  } else if (isPlantBased) {
    const legume = (noLegume || isKeto) ? (noSoy ? 'roasted pumpkin seeds' : 'edamame') : 'chickpeas';
    const v = pickVeg('spinach','broccoli');
    meals.push({ meal: 'Lunch', suggestion: legume.charAt(0).toUpperCase()+legume.slice(1) + ' power bowl with ' + v + ', avocado' + (noNuts ? '' : ', and pumpkin seeds') + ' -- complete plant protein, healthy fats, and fiber.' });
  } else {
    const p = pickProtein('chicken','tuna','lentil');
    const v = pickVeg('spinach','broccoli');
    const bStr = base ? ' and ' + base : '';
    meals.push({ meal: 'Lunch', suggestion: p.charAt(0).toUpperCase()+p.slice(1) + ' with ' + v + bStr + ' -- balanced protein, complex carbs, and key micronutrients.' });
  }

  // DINNER
  const wantsSleep = goals.includes('Improve Sleep') || symptoms.some(s => /sleep|insomnia|unrefreshed/i.test(s));
  if (isKeto || isCarnivore) {
    const d = noMeat ? 'roasted portobello mushrooms' : (noFishAll ? 'grilled chicken thighs' : 'baked salmon');
    meals.push({ meal: 'Dinner', suggestion: d.charAt(0).toUpperCase()+d.slice(1) + ' with sauteed zucchini and olive oil -- high-fat, low-carb dinner supporting ketone production.' });
  } else if (wantsSleep) {
    const d = noFishAll ? (noMeat ? (noSoy ? 'chickpea stew' : 'tofu stir-fry') : 'turkey breast') : 'baked salmon';
    const bStr = base ? ' over ' + base + ' and ' : ' with ';
    meals.push({ meal: 'Dinner', suggestion: d.charAt(0).toUpperCase()+d.slice(1) + bStr + pickVeg('broccoli','asparagus') + ' -- tryptophan, magnesium, and B6 to support melatonin production for better sleep.' });
  } else if (isPlantBased) {
    const d = noLegume ? (noSoy ? 'roasted cauliflower' : 'tofu') : 'lentil dal';
    const bStr = base ? ' with ' + base + ' and ' : ' with ';
    meals.push({ meal: 'Dinner', suggestion: d.charAt(0).toUpperCase()+d.slice(1) + bStr + pickVeg('broccoli','kale') + ' -- iron, fiber, and plant protein for recovery.' });
  } else {
    const d = pickProtein('salmon','chicken','beef');
    const bStr = base ? ' and ' + base : '';
    meals.push({ meal: 'Dinner', suggestion: d.charAt(0).toUpperCase()+d.slice(1) + ' with ' + pickVeg('broccoli','asparagus') + bStr + ' -- lean protein, omega-3, and micronutrients for recovery.' });
  }

  // SNACK
  const wantsEnergy  = symptoms.some(s => /fatigue|energy/i.test(s)) || goals.includes('Increase Energy');
  const wantsStress  = symptoms.some(s => /anxiety|stress|tense|overwhelm|irritab/i.test(s)) || goals.includes('Stress Reduction');
  const wantsMuscle  = goals.includes('Muscle Gain') || goals.includes('Improve Strength');
  if (isDiabetic) {
    // diabetics need controlled-sugar snacks
    const snk = noNuts ? 'celery with avocado dip' : 'a small handful of almonds with cucumber slices';
    meals.push({ meal: 'Snack', suggestion: snk + ' -- low-GI, steady blood sugar between meals.' });
  } else if (wantsEnergy) {
    const snk = noNuts ? 'banana with chia seeds' : 'apple with almond butter';
    meals.push({ meal: 'Snack', suggestion: snk + ' -- magnesium and natural sugars for an energy boost without a crash.' });
  } else if (wantsStress) {
    const snk = noDairyAll ? 'dark chocolate (70%+) with banana' : (noNuts ? 'Greek yogurt with honey' : 'Greek yogurt with walnuts');
    meals.push({ meal: 'Snack', suggestion: snk + ' -- magnesium, tryptophan, and probiotics for a calm stress response.' });
  } else if (wantsMuscle) {
    const snk = noDairyAll ? (noNuts ? 'edamame with sea salt' : 'handful of mixed nuts') : (noEgg ? 'cottage cheese with berries' : 'hard-boiled eggs with avocado');
    meals.push({ meal: 'Snack', suggestion: snk + ' -- protein and healthy fats to support muscle protein synthesis.' });
  } else if (isChild) {
    const snk = noNuts ? 'sliced banana with sunflower seed butter' : 'apple slices with peanut butter';
    meals.push({ meal: 'Snack', suggestion: snk + ' -- energy, healthy fats, and vitamins for growing children.' });
  } else {
    const snk = noNuts ? (noDairyAll ? 'hummus with carrot sticks' : 'Greek yogurt with berries') : 'a small handful of mixed nuts and dried fruit';
    meals.push({ meal: 'Snack', suggestion: snk + ' -- balanced macros for sustained afternoon energy.' });
  }

  return meals.slice(0, 4);
}

// -- Helper: build daily schedule --
function buildDailySchedule(recs) {
  const morning = recs.filter(r => /morning|breakfast|empty stomach|wake/i.test(r.timing)).map(r => r.name);
  const withLunch = recs.filter(r => /lunch|midday|noon|with meal/i.test(r.timing) && !/morning|evening|bed/i.test(r.timing)).map(r => r.name);
  const evening = recs.filter(r => /evening|dinner|night/i.test(r.timing) && !/bed/i.test(r.timing)).map(r => r.name);
  const beforeBed = recs.filter(r => /bed|sleep|before bed/i.test(r.timing)).map(r => r.name);

  // Catch anything not yet scheduled
  const scheduled = new Set([...morning, ...withLunch, ...evening, ...beforeBed]);
  const unscheduled = recs.filter(r => !scheduled.has(r.name)).map(r => r.name);
  if (unscheduled.length) morning.push(...unscheduled);

  const schedule = [];
  if (morning.length) schedule.push({ time: 'Morning (with breakfast)', supplements: morning });
  if (withLunch.length) schedule.push({ time: 'Afternoon', supplements: withLunch });
  if (evening.length) schedule.push({ time: 'Evening (with dinner)', supplements: evening });
  if (beforeBed.length) schedule.push({ time: 'Before Bed', supplements: beforeBed });
  return schedule;
}

module.exports = router;
module.exports.promptSafe = promptSafe;
// The benchmark harness scores the rule-based engine as the BASELINE the LLM
// output is compared against, so it needs the generator, not just the route.
module.exports.generateClinicalFallback = generateClinicalFallback;
// Exposed for the determinism suite (Test File/plan-selection.test.js): the
// selection rules have to be testable without calling a provider.
module.exports.buildPlanSpine = buildPlanSpine;
// Exposed for Test File/assessment-fields.test.js: the whitelist is only
// correct while it mirrors the Assessment schema, and that has to be checked
// against the schema itself rather than remembered by whoever adds a question.
module.exports.ASSESSMENT_FIELDS = ASSESSMENT_FIELDS;
module.exports.pickAssessmentFields = pickAssessmentFields;











