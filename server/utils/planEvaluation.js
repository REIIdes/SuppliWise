/**
 * Numerical evaluation metrics for generated wellness plans.
 *
 * WHY THIS EXISTS
 * ---------------
 * The system's accuracy claims were, until now, anecdotal: "the plan looks
 * good". A research evaluation needs numbers per submission, and a benchmark
 * needs those numbers to be computed the same way for the rule-based BASELINE
 * and for the LLM output, so the two are directly comparable.
 *
 * Every metric here is a pure function returning a 0..1 rate (plus the raw
 * counts, because a rate without its denominator is how a 1/1 sample looks the
 * same as a 15/15 one). None of them call a model or the network — they score
 * a plan object — so they run in tests, offline, and against recorded output.
 *
 * The set:
 *   schemaValidity      — is the plan even a complete, well-shaped plan?
 *   orderCompliance     — does the item order follow the canonical taxonomy?
 *   catalogAdherence    — is every recommendation a real, known supplement?
 *   dietCompliance      — do foods respect the patient's diet type?
 *   allergenCompliance  — does anything contain a declared allergen?
 *   citationValidity    — is every evidence line a dated, sourced citation?
 *   personalizationRate — is each rec actually triggered by patient data?
 *   severityCarryRate   — are symptoms quoted WITH their severity, as asked?
 *
 * and the comparisons against baseline:
 *   comparePlans        — Jaccard overlap of item sets + Kendall tau of order.
 */

const { classifySupplement, isCanonicalOrder } = require('./planConsistency');
const { verifyCitation, checkDose, rejectReason, unreportedClaims, fabricatedPersonalClaims, buildFactContext } = require('./planGrounding');

const REQUIRED_TOP_FIELDS = [
  'summary', 'simplifiedSummary', 'recommendations', 'lifestyleAdvice',
  'mealRecommendations', 'actionPlan', 'dailySchedule', 'warnings', 'avoidList', 'disclaimer',
];

const REQUIRED_REC_FIELDS = [
  'name', 'reason', 'simplifiedReason', 'dosage', 'timing', 'priority',
  'confidenceScore', 'interactions', 'evidence', 'foods', 'sideEffects',
];

/** A rate plus its counts, so every number printed carries its denominator. */
function rate(numerator, denominator) {
  return {
    passed: numerator,
    total: denominator,
    value: denominator === 0 ? 1 : numerator / denominator,
  };
}

const recsOf = (plan) => (Array.isArray(plan?.recommendations) ? plan.recommendations : []);

/** 1. Schema validity: required top-level sections + complete recommendation fields. */
function schemaValidity(plan) {
  let checks = 0;
  let passed = 0;
  for (const field of REQUIRED_TOP_FIELDS) {
    checks += 1;
    const v = plan?.[field];
    const ok = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '';
    if (ok) passed += 1;
  }
  const recs = recsOf(plan);
  for (const rec of recs) {
    for (const field of REQUIRED_REC_FIELDS) {
      checks += 1;
      if (rec?.[field] !== undefined && rec?.[field] !== null && rec?.[field] !== '') passed += 1;
    }
    checks += 1;
    if (['High', 'Medium', 'Low'].includes(rec?.priority)) passed += 1;
    checks += 1;
    const cs = Number(rec?.confidenceScore);
    if (Number.isFinite(cs) && cs >= 0 && cs <= 100) passed += 1;
  }
  checks += 1;
  if (recs.length === 15) passed += 1;
  return rate(passed, checks);
}

/** 2. Order compliance: recommendations already in canonical (priority, class) order. */
function orderCompliance(plan) {
  return { value: isCanonicalOrder(recsOf(plan)) ? 1 : 0 };
}

/** 3. Catalog adherence: every rec name maps to a known nutrient class. */
function catalogAdherence(plan) {
  const recs = recsOf(plan);
  const known = recs.filter((r) => classifySupplement(r?.name) !== null).length;
  return rate(known, recs.length);
}

// Forbidden food tokens per diet, matched against every food string in the
// plan. Deliberately conservative: only unambiguous violations count, so the
// metric measures real diet breaks rather than regex appetite.
const DIET_FORBIDDEN = {
  vegan: /\b(beef|pork|chickens?|turkeys?|livers?|bacon|eggs?|salmon|tunas?|sardines?|anchov(?:y|ies)|fish|trout|herring|mackerel|cod|halibut|tilapia|krill|squid|shrimps?|prawns?|clams?|oysters?|scallops?|crab|lobster|caviar|milk|cheeses?|butter|cream|yogurts?|whey|casein|gelatin|honey)\b/i,
  vegetarian: /\b(beef|pork|chickens?|turkeys?|livers?|bacon|salmon|tunas?|sardines?|anchov(?:y|ies)|fish|trout|herring|mackerel|cod|halibut|tilapia|krill|squid|shrimps?|prawns?|clams?|oysters?|scallops?|crab|lobster|caviar)\b/i,
  pescatarian: /\b(beef|pork|chickens?|turkeys?|livers?|bacon|ham|veal|lamb)\b/i,
  keto: /\b(breads?|pastas?|rice|cereals?|oatmeal|potatoes?|sugars?|cand(?:y|ies)|sodas?)\b/i,
};

// "Almond butter", "coconut milk", "plant milk", "soy yogurt" are vegan
// STAPLES, not dairy; matched before the forbidden regex so the metric does
// not cry wolf.
const PLANT_LOOKALIKE = /\b(almond|peanut|cashew|coconut|oat|soy|rice|nut|seed|sunflower|macadamia|pistachio|shea|hemp|flax|plant|plant-based|sesame|pea|almond)\s+(butter|milk|cream|cheese|yogurt)\b/gi;

/** True when a text contains a food forbidden on the given diet. */
function containsForbiddenFood(text, dietType) {
  const forbidden = DIET_FORBIDDEN[String(dietType || '').toLowerCase()];
  if (!forbidden) return false;
  return forbidden.test(String(text || '').replace(PLANT_LOOKALIKE, 'plant staple'));
}

function foodStrings(plan) {
  const out = [];
  for (const rec of recsOf(plan)) {
    if (typeof rec?.foods === 'string') out.push(rec.foods);
    else if (Array.isArray(rec?.foods)) out.push(...rec.foods.map(String));
  }
  for (const meal of plan?.mealRecommendations || []) {
    if (typeof meal?.suggestion === 'string') out.push(meal.suggestion);
  }
  return out;
}

/** 4. Diet compliance: no forbidden food appears anywhere in the plan. */
function dietCompliance(plan, dietType) {
  const forbidden = DIET_FORBIDDEN[String(dietType || '').toLowerCase()];
  if (!forbidden) return { value: 1, violations: [] };
  const foods = foodStrings(plan);
  const violations = foods.filter((f) => containsForbiddenFood(f, dietType));
  return { passed: foods.length - violations.length, total: foods.length, violations, value: rate(foods.length - violations.length, foods.length).value };
}

/** 5. Allergen compliance: no declared allergen in any rec name or food list. */
function allergenCompliance(plan, allergies) {
  const terms = String(allergies || '')
    .toLowerCase()
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !/^(none|nkda|not specified|no known allergies?|n\/a)$/.test(t));
  if (terms.length === 0) return { value: 1, violations: [] };
  const haystacks = [
    ...recsOf(plan).map((r) => String(r?.name || '')),
    ...foodStrings(plan),
  ].map((h) => h.toLowerCase());
  const violations = [];
  for (const term of terms) {
    if (haystacks.some((h) => h.includes(term))) violations.push(term);
  }
  return { value: violations.length === 0 ? 1 : 0, violations };
}

/** 6. Citation validity: "Org (Year)" style, or the honest empty marker. */
function citationValidity(plan) {
  const recs = recsOf(plan);
  const ok = recs.filter((r) => {
    const e = String(r?.evidence || '');
    return /\((19|20)\d{2}\)/.test(e) || /no specific source identified/i.test(e);
  }).length;
  return rate(ok, recs.length);
}

/** 7. Personalisation: every rec names what in the patient triggered it. */
function personalizationRate(plan) {
  const recs = recsOf(plan);
  const ok = recs.filter((r) => typeof r?.triggeredBy === 'string' && r.triggeredBy.trim().length > 1).length;
  return rate(ok, recs.length);
}

/** 8. Severity carry: when a rec quotes a symptom, severity language is present. */
function severityCarryRate(plan) {
  const recs = recsOf(plan);
  const quoting = recs.filter((r) => /\b(nausea|fatigue|headache|migraine|insomnia|anxiety|pain|dizzy|cramp)\w*\b/i.test(String(r?.triggeredBy || '')));
  if (quoting.length === 0) return { value: 1, passed: 0, total: 0 };
  const withSeverity = quoting.filter((r) => /\b(severe|moderate|mild|high|acute|chronic)\b/i.test(String(r?.triggeredBy || ''))).length;
  return rate(withSeverity, quoting.length);
}

/**
 * 9-11. Grounding: does what the plan asserts survive the verifier in
 * `planGrounding.js`? These are the metrics that answer "how often does it
 * hallucinate" with a number — a citation the app cannot resolve, a symptom the
 * patient never reported, or a dose past the safety ceiling each cost a row.
 */
function citationGroundingRate(plan, profile = {}) {
  const recs = recsOf(plan);
  const allowedPmids = profile._allowedPmids instanceof Set ? profile._allowedPmids : undefined;
  const ok = recs.filter((r) => verifyCitation(r?.evidence, r?.name, { allowedPmids }).ok).length;
  return rate(ok, recs.length);
}

function patientFactGroundingRate(plan, profile) {
  const recs = recsOf(plan);
  const ctx = buildFactContext(profile || {});
  const ok = recs.filter((r) => unreportedClaims(r?.triggeredBy, ctx).length === 0
    && fabricatedPersonalClaims(r?.reason, ctx).length === 0).length;
  return rate(ok, recs.length);
}

function dosageSafetyRate(plan) {
  const recs = recsOf(plan);
  const ok = recs.filter((r) => !rejectReason(r?.name) && checkDose(r?.name, r?.dosage).ok).length;
  return rate(ok, recs.length);
}

/**
 * Aggregate a plan into one numeric score card. `profile` is the assessment
 * payload (used for diet/allergy context). Weights per family: structure
 * (schema, order, catalog) 40%, safety (diet, allergen) 25%, grounding
 * (citations, patient facts, doses) 20%, quality (citations style,
 * personalisation, severity) 15%.
 */
function scorePlan(plan, profile = {}) {
  const metrics = {
    schemaValidity: schemaValidity(plan),
    orderCompliance: orderCompliance(plan),
    catalogAdherence: catalogAdherence(plan),
    dietCompliance: dietCompliance(plan, profile.dietType),
    allergenCompliance: allergenCompliance(plan, profile.allergies),
    citationValidity: citationValidity(plan),
    personalizationRate: personalizationRate(plan),
    severityCarryRate: severityCarryRate(plan),
    citationGroundingRate: citationGroundingRate(plan, profile),
    patientFactGroundingRate: patientFactGroundingRate(plan, profile),
    dosageSafetyRate: dosageSafetyRate(plan),
  };
  const overall = (
    (metrics.schemaValidity.value + metrics.orderCompliance.value + metrics.catalogAdherence.value) / 3 * 40
    + (metrics.dietCompliance.value + metrics.allergenCompliance.value) / 2 * 25
    + (metrics.citationGroundingRate.value + metrics.patientFactGroundingRate.value + metrics.dosageSafetyRate.value) / 3 * 20
    + (metrics.citationValidity.value + metrics.personalizationRate.value + metrics.severityCarryRate.value) / 3 * 15
  );
  return { metrics, overall: Math.round(overall * 10) / 10 };
}

/** Set overlap of two plans' supplement names (normalised), 0..1. */
function jaccard(a, b) {
  const norm = (list) => new Set(list.map((r) => String(r?.name || '').toLowerCase().replace(/[^a-z0-9+ ]/g, '').trim()).filter(Boolean));
  const setA = norm(a);
  const setB = norm(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let shared = 0;
  for (const x of setA) if (setB.has(x)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/**
 * Kendall's tau between the two plans over the supplements they SHARE —
 * how much the ordering agrees, independent of which items were chosen.
 * Returns -1..1 (1 = identical relative order).
 */
function kendallTau(a, b) {
  const namesA = a.map((r) => String(r?.name || '').toLowerCase().trim());
  const namesB = b.map((r) => String(r?.name || '').toLowerCase().trim());
  const common = namesA.filter((n) => namesB.includes(n));
  const seqA = common.map((n) => namesA.indexOf(n));
  const seqB = common.map((n) => namesB.indexOf(n));
  const n = common.length;
  if (n < 2) return 1;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const da = seqA[i] - seqA[j];
      const db = seqB[i] - seqB[j];
      if (da === db) concordant += 1;
      else discordant += 1;
    }
  }
  return (concordant - discordant) / (concordant + discordant);
}

/** Compare a candidate plan against a baseline plan. */
function comparePlans(candidate, baseline) {
  const a = recsOf(candidate);
  const b = recsOf(baseline);
  return {
    itemOverlap: Math.round(jaccard(a, b) * 1000) / 1000,
    orderAgreement: Math.round(kendallTau(a, b) * 1000) / 1000,
    candidateCount: a.length,
    baselineCount: b.length,
  };
}

/** Priority-tier sanity: High recs must not be fewer than the plan claims. */
function priorityDistribution(plan) {
  const dist = { High: 0, Medium: 0, Low: 0, Other: 0 };
  for (const rec of recsOf(plan)) {
    const key = ['High', 'Medium', 'Low'].includes(rec?.priority) ? rec.priority : 'Other';
    dist[key] += 1;
  }
  return dist;
}

module.exports = {
  REQUIRED_TOP_FIELDS,
  REQUIRED_REC_FIELDS,
  DIET_FORBIDDEN,
  containsForbiddenFood,
  schemaValidity,
  orderCompliance,
  catalogAdherence,
  dietCompliance,
  allergenCompliance,
  citationValidity,
  personalizationRate,
  severityCarryRate,
  citationGroundingRate,
  patientFactGroundingRate,
  dosageSafetyRate,
  scorePlan,
  comparePlans,
  priorityDistribution,
  jaccard,
  kendallTau,
};
