/**
 * Plan grounding — what a generated wellness plan is allowed to assert.
 *
 * WHY THIS EXISTS
 * ---------------
 * The assessment prompt *asks* the model not to invent citations, not to invent
 * symptoms, and not to suggest unsafe doses. Asking is not verifying. Before
 * this module, whatever came back from the provider went straight into the
 * member's plan with only two corrections applied (fill missing fields,
 * re-order items). Measured on 2026-10-20, that meant a member could be shown:
 *
 *   - a PMID that resolves to a study about something else entirely — the app's
 *     own curated citation table contained 33 of these;
 *   - a symptom or condition the patient never reported ("given your diabetes")
 *     presented as the reason for a supplement;
 *   - a supplement that is not a supplement at all (a prescription drug, or an
 *     invented product name) occupying one of the fifteen rows;
 *   - a dose several times above the established upper intake level, stated as
 *     the plan's own instruction.
 *
 * This module is the deterministic answer, in the same spirit as
 * `planConsistency.js`: the prompt requests, the code guarantees. It can only
 * ever do things that make a plan LESS assertive —
 *
 *   REPLACE  an unverifiable citation with the registry's real one for that
 *            nutrient, or with the honest "No specific source identified";
 *   STRIP    a patient fact the patient did not report;
 *   DROP     a row that is a prescription/dangerous substance or a name no
 *            clinical taxonomy recognises — then BACKFILL the slot from the
 *            rule-based engine's own clinically-reviewed rows for this profile,
 *            so a member still receives a full plan;
 *   CLAMP    a dose above the nutrient's safety ceiling, to the app's standard
 *            dose for that nutrient, and say so in a warning;
 *   NORMALISE priority / confidence / severity to the values the schema allows.
 *
 * It never writes a clinical claim of its own. Everything it substitutes comes
 * from `supplementEvidenceRegistry.js` (PMIDs verified at NCBI by
 * `eval/citationAudit.js`) or from the rule engine's curated rows.
 *
 * The audit object it returns (`plan.grounding`) is the evidence that the check
 * ran and what it changed — the reviewer asked who ratified each claim; this is
 * the answer for the plan itself.
 */

const { classifySupplement } = require('./planConsistency');
const {
  HONEST_MARKER,
  GENERIC_EVIDENCE,
  evidenceEntry,
  extractPmids,
  allowlistedPmids,
  registeredEvidence,
} = require('./supplementEvidenceRegistry');
const {
  citationIsAuthoritative,
  isPrescriptionOrDangerous,
  isKnownApprovedSupplement,
} = require('./clinicalEvidenceStandards');
const {
  GENERAL_SYMPTOMS,
  CONDITION_SYMPTOMS,
  MEDICAL_CONDITIONS,
  ITEMS,
} = require('./healthAssessmentInstrument');

// The instrument owns the option list; this reads it instead of copying it, so
// a goal added to the questionnaire is a goal the verifier knows about.
const GOAL_OPTIONS = (ITEMS.find((item) => item.id === 'healthGoals') || { options: [] }).options;

/** What a triggeredBy may say when nothing verifiable triggered the row. */
const NEUTRAL_TRIGGER = 'Preventive wellness support';

// ---------------------------------------------------------------------------
// 1. What the patient actually reported
// ---------------------------------------------------------------------------

/** Distinctive words of a questionnaire label: segments long enough to name. */
function labelTerms(label) {
  return String(label || '')
    .toLowerCase()
    .split(/[/,()]+/)
    .map((s) => s.replace(/[^a-z\s'-]/g, '').trim())
    .filter((s) => s.length >= 5 && !/^(reported|history|issues?|problems?|or)$/.test(s));
}

/**
 * Scale answers the member chose are facts too — the questionnaire's stress and
 * sleep items ARE the report of stress and sleep problems. Without this, a
 * triggeredBy line like "Severe stress reported" would be stripped as
 * unreported even though the member selected it, so each scored answer licenses
 * the symptoms that answer measures.
 */
const ANSWER_LICENSES = [
  { field: 'stressLevel', unless: /^(none|no|never|rarely|low|minimal)$/i, terms: ['stress', 'anxiety'] },
  { field: 'sleepQuality', unless: /^(excellent|very good|good|great)$/i, terms: ['sleep', 'insomnia'] },
  { field: 'proteinIntake', unless: null, terms: ['protein', 'muscle'] },
  { field: 'fitnessFocus', unless: null, terms: ['muscle', 'strength', 'endurance'] },
  { field: 'waterIntake', unless: /^(none|never|rarely)$/i, terms: ['water', 'hydration'] },
  { field: 'activityLevel', unless: null, terms: ['activity', 'sedentary'] },
];

/**
 * A plan may only name a symptom/condition the member selected. The vocabulary
 * is the questionnaire's own option list, so this can never flag a fact about
 * a condition the app does not ask about (and therefore cannot claim).
 */
function buildFactContext(profile = {}) {
  const reportedLabels = [
    ...(Array.isArray(profile.symptoms) ? profile.symptoms : []),
    ...(Array.isArray(profile.medicalConditions) ? profile.medicalConditions : []),
    ...(Array.isArray(profile.healthGoals) ? profile.healthGoals : []),
    ...(Array.isArray(profile.lifestyleHabits) ? profile.lifestyleHabits : []),
    ...(profile.pregnancyStatus && profile.pregnancyStatus !== 'Not applicable' ? [profile.pregnancyStatus] : []),
    ...Object.keys(profile.symptomSeverity || {}),
  ].map((s) => String(s).toLowerCase().trim()).filter(Boolean);

  // A selected label also licenses its own segments ("Anxiety / Stress" permits
  // the model to write "anxiety"), and free text the member typed (medications,
  // blood results, their own words) licenses anything named in it.
  const freeText = [
    profile.currentMedications, profile.bloodTestResults, profile.feelingDescription,
    profile.currentSupplements, profile.allergies, profile.dietType, profile.sleepQuality,
    profile.stressLevel, profile.proteinIntake, profile.fitnessFocus, profile.waterIntake,
    profile.activityLevel, profile.sunExposure, profile.recentBloodTest, profile.takingSupplements,
    profile.recreationalDrugTypes,
  ].map((v) => String(v || '').toLowerCase()).join(' ');

  const reported = new Set();
  for (const label of reportedLabels) {
    reported.add(label);
    labelTerms(label).forEach((t) => reported.add(t));
  }
  for (const rule of ANSWER_LICENSES) {
    const value = String(profile[rule.field] || '').trim();
    if (!value || /^(none|nkda|not applicable|no|prefer not to say)$/i.test(value)) continue;
    if (rule.unless && rule.unless.test(value)) continue;
    rule.terms.forEach((t) => reported.add(t));
  }

  // Every WORD the member actually chose or typed licenses itself. Without this
  // the check collides with itself: a member who selected the "Muscle Cramps"
  // symptom, or the "Support Heart Health" goal, is legitimately described as
  // having reported cramps, or heart health, even though "cramps" and "heart"
  // are also fragments of other questionnaire labels. Deleting a true sentence
  // is a worse failure than letting a hedged one stand.
  const reportedWords = new Set();
  const addWords = (text) => String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9'+-]+/)
    .forEach((w) => { if (w.length >= 4) reportedWords.add(w); });
  for (const label of reportedLabels) addWords(label);
  for (const rule of ANSWER_LICENSES) {
    const value = String(profile[rule.field] || '').trim();
    if (!value || /^(none|nkda|not applicable|no|prefer not to say)$/i.test(value)) continue;
    if (rule.unless && rule.unless.test(value)) continue;
    rule.terms.forEach(addWords);
  }
  addWords(freeText);

  const vocabulary = new Map(); // term -> full label it came from
  const goalTerms = new Set(); // terms that come from a GOAL option
  for (const label of [...GENERAL_SYMPTOMS, ...CONDITION_SYMPTOMS, ...MEDICAL_CONDITIONS, ...GOAL_OPTIONS]) {
    const l = String(label).toLowerCase();
    const isGoal = GOAL_OPTIONS.includes(label);
    vocabulary.set(l, label);
    if (isGoal) goalTerms.add(l);
    for (const t of labelTerms(l)) {
      if (!vocabulary.has(t)) vocabulary.set(t, label);
      if (isGoal) goalTerms.add(t);
    }
  }
  return { reported, reportedWords, freeText, vocabulary, goalTerms, hasAnyReport: reportedLabels.length > 0 };
}

// One compiled matcher per questionnaire term, cached across plans. The
// vocabulary is static, so this runs once per distinct term for the process.
const TERM_MATCHERS = new Map();

function termMatcher(term) {
  let re = TERM_MATCHERS.get(term);
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    TERM_MATCHERS.set(term, re);
  }
  return re;
}

/**
 * Terms this text asserts that the patient never reported.
 * `ignoreGoalLabels` is used for prose: a wellness plan legitimately says a
 * supplement "supports heart health" or "boosts immunity" — those are the
 * goal words, not a claim about what this patient reported.
 */
function unreportedClaims(text, ctx, { ignoreGoalLabels = false } = {}) {
  if (typeof text !== 'string' || !text.trim() || !ctx.hasAnyReport) return [];
  const lower = text.toLowerCase();
  const hits = [];
  for (const [term, label] of ctx.vocabulary) {
    if (ignoreGoalLabels && ctx.goalTerms.has(term)) continue;
    if (ctx.reported.has(term)) continue;
    if (!term.includes(' ') && ctx.reportedWords.has(term)) continue; // a word they did report
    if (ctx.freeText.includes(term)) continue; // the member named it themselves
    if (termMatcher(term).test(lower)) hits.push({ term, label });
  }
  return hits;
}

/**
 * Keep only the clauses of a triggeredBy line that the patient reported. The
 * field's whole contract is "what triggered this for YOU", so an unreported
 * claim inside it is a fabrication, not a flourish.
 */
function groundTriggeredBy(text, ctx) {
  if (typeof text !== 'string') return { value: text, stripped: [] };
  const parts = text.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { value: text, stripped: [] };
  const kept = [];
  const stripped = [];
  for (const part of parts) {
    const claims = unreportedClaims(part, ctx);
    if (claims.length === 0) kept.push(part);
    else stripped.push(claims.map((c) => c.label).join(' / '));
  }
  return { value: kept.length ? kept.join(', ') : NEUTRAL_TRIGGER, stripped };
}

// The prose fields are different: general nutrition education may legitimately
// mention a condition the patient does not have ("iron is often low in people
// with heavy periods"). Only an assertion that THIS patient has it is a lie, so
// the check fires on a second-person attribution, not on the word alone.
const PERSONAL_ATTRIBUTION = /\b(you|your|you'r?e|since you|as you|given your|reported by you|patient reports?)\b[^.]{0,60}?\b(report(?:ed|ing)?|mention(?:ed|ing)?|state[ds]?|have|are experiencing|suffer(?:ing|ed)?|diagnos(?:ed|is|ing)|live with|deal(?:ing)? with|struggle(?:d|ing)? with|experience(?:d)?)\b/i;

// Clauses, not sentences: a plan row is often written as one breath — "Helps
// support bone density — you reported muscle cramps." Deleting the whole
// sentence over its second half would throw away the true first half, so the
// unit of removal is the clause that actually makes the false attribution.
// The spaced hyphen is included because the route's own text cleaner turns an
// em dash into " - " before the plan is stored.
const CLAUSE_SPLIT = /\s+[—–-]\s+|(?<=[.!?])\s+/;

/** Clauses that claim the patient personally has an unreported condition. */
function fabricatedPersonalClaims(text, ctx) {
  if (typeof text !== 'string' || !text.trim() || !ctx.hasAnyReport) return [];
  return text
    .split(CLAUSE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s
      && PERSONAL_ATTRIBUTION.test(s)
      && unreportedClaims(s, ctx, { ignoreGoalLabels: true }).length > 0);
}

/** Drop the lying clauses; keep everything that is not a false attribution. */
function groundProse(text, ctx, { fallback = '' } = {}) {
  const bad = fabricatedPersonalClaims(text, ctx);
  if (bad.length === 0) return { value: text, stripped: 0 };
  const kept = String(text)
    .split(CLAUSE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s && !bad.includes(s))
    .join(' ');
  return { value: kept.trim() || fallback, stripped: bad.length };
}

// ---------------------------------------------------------------------------
// 2. Citations
// ---------------------------------------------------------------------------

const URL_IN_TEXT = /https?:\/\/\S+/gi;
const ALLOWED_URL_HOSTS = [
  'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'ods.nih.gov', 'ods.od.nih.gov',
  'nih.gov', 'who.int', 'cancer.gov', 'healthdirect.gov.au', 'mayo.edu',
  'doh.gov.ph', 'ddb.gov.ph', 'ncmh.gov.ph', 'cochrane.org', 'efsaweb.eu',
];

/**
 * A citation is only kept when the app can vouch for every hard identifier in
 * it. Three shapes pass: a registry citation, the honest marker, or prose that
 * names an authoritative body and asserts no verifiable identifier. Everything
 * else — an invented PMID, a PubMed link to a number nobody checked, a
 * non-medical URL — is replaced.
 */
function verifyCitation(text, name, { allowedPmids } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: 'no citation given', replacement: registeredEvidence(name) };
  if (raw === HONEST_MARKER || raw === GENERIC_EVIDENCE) return { ok: true, reason: '', replacement: raw };

  const allowed = allowedPmids || allowlistedPmids();
  const claimed = extractPmids(raw);
  const unknown = claimed.filter((id) => !allowed.has(String(id)));

  URL_IN_TEXT.lastIndex = 0;
  const urls = raw.match(URL_IN_TEXT) || [];
  const badUrl = urls.find((u) => !ALLOWED_URL_HOSTS.some((host) => u.toLowerCase().includes(host)));

  if (unknown.length > 0) {
    return { ok: false, reason: `unverifiable PMID: ${unknown.join(', ')}`, replacement: registryOrHonest(name) };
  }
  if (badUrl) {
    return { ok: false, reason: `URL outside the medical sources allowlist: ${badUrl.slice(0, 60)}`, replacement: registryOrHonest(name) };
  }
  // A citation that asserts no identifier still has to be an authoritative
  // source, and if the registry holds one for this nutrient, prefer the one the
  // app actually ships — it is the string a reviewer can check.
  if (!citationIsAuthoritative(raw)) {
    return { ok: false, reason: 'names no authoritative source', replacement: registryOrHonest(name) };
  }
  const curated = evidenceEntry(name);
  if (curated && raw !== curated.citation) {
    return { ok: true, reason: '', replacement: curated.citation, upgraded: true };
  }
  return { ok: true, reason: '', replacement: raw };
}

const registryOrHonest = (name) => {
  const entry = evidenceEntry(name);
  return entry ? entry.citation : HONEST_MARKER;
};

// ---------------------------------------------------------------------------
// 3. Doses
// ---------------------------------------------------------------------------

/**
 * Safety ceilings and the app's standard dose, first match wins, keyed by the
 * name-alias the plan uses. The ceiling is NOT the therapeutic dose: it is the
 * level past which the number is certainly wrong, set well above every dose the
 * rule engine itself ships, so a legitimate plan is never rewritten. The unit
 * must match the parsed unit (IU is never compared against an mg ceiling).
 */
const DOSE_TABLE = [
  { alias: ['magnesium'], ceiling: { value: 1000, unit: 'mg' }, standard: '300-400mg daily' },
  { alias: ['calcium'], ceiling: { value: 2000, unit: 'mg' }, standard: '500mg twice daily with meals (max 1,200mg total)' },
  { alias: ['iron', 'ferrous'], ceiling: { value: 60, unit: 'mg' }, standard: '18-25mg daily' },
  { alias: ['zinc'], ceiling: { value: 110, unit: 'mg' }, standard: '15-30mg daily' },
  { alias: ['selenium'], ceiling: { value: 800, unit: 'mcg' }, standard: '100-200mcg daily' },
  { alias: ['iodine', 'kelp'], ceiling: { value: 2000, unit: 'mcg' }, standard: '150-300mcg daily' },
  { alias: ['copper'], ceiling: { value: 20, unit: 'mg' }, standard: '1-2mg daily' },
  { alias: ['manganese'], ceiling: { value: 20, unit: 'mg' }, standard: '2-5mg daily' },
  { alias: ['chromium'], ceiling: { value: 1000, unit: 'mcg' }, standard: '200mcg daily' },
  { alias: ['folate', 'folic'], ceiling: { value: 1500, unit: 'mcg' }, standard: '400-800mcg daily' },
  { alias: ['b12', 'cobalamin', 'methylcobalamin'], ceiling: { value: 5000, unit: 'mcg' }, standard: '1000mcg daily' },
  { alias: ['vitamin c', 'ascorbic'], ceiling: { value: 3000, unit: 'mg' }, standard: '250-500mg daily' },
  { alias: ['vitamin d', 'd3', 'cholecalciferol'], ceiling: { value: 6000, unit: 'IU' }, standard: '2000-4000 IU daily' },
  { alias: ['vitamin e', 'tocopherol'], ceiling: { value: 1000, unit: 'mg' }, standard: '200-400 IU daily' },
  { alias: ['vitamin a', 'retinol', 'beta-carotene'], ceiling: { value: 10000, unit: 'IU' }, standard: 'under 5,000 IU daily (preformed retinol)' },
  { alias: ['melatonin'], ceiling: { value: 15, unit: 'mg' }, standard: '0.5-1mg before bed' },
  { alias: ['omega', 'fish oil', 'dha', 'epa', 'krill'], ceiling: { value: 6000, unit: 'mg' }, standard: '1000-2000mg EPA+DHA daily' },
  { alias: ['coq10', 'coenzyme q', 'ubiquinol'], ceiling: { value: 1500, unit: 'mg' }, standard: '100-200mg daily' },
  { alias: ['creatine'], ceiling: { value: 25000, unit: 'mg' }, standard: '3-5g daily' },
  { alias: ['collagen'], ceiling: { value: 60000, unit: 'mg' }, standard: '10-20g daily' },
  { alias: ['ashwagandha', 'ksm-66'], ceiling: { value: 3000, unit: 'mg' }, standard: '300-600mg daily' },
  { alias: ['curcumin', 'turmeric'], ceiling: { value: 3000, unit: 'mg' }, standard: '500-1,000mg daily' },
  { alias: ['berberine'], ceiling: { value: 3000, unit: 'mg' }, standard: '500mg 2-3 times daily with meals' },
  { alias: ['theanine'], ceiling: { value: 1200, unit: 'mg' }, standard: '100-200mg daily' },
  { alias: ['5-htp', 'tryptophan'], ceiling: { value: 1200, unit: 'mg' }, standard: '100mg 1-3 times daily' },
  { alias: ['bacopa'], ceiling: { value: 1500, unit: 'mg' }, standard: '300mg daily with food' },
  { alias: ['rhodiola'], ceiling: { value: 3000, unit: 'mg' }, standard: '200-400mg daily' },
  { alias: ['ginkgo'], ceiling: { value: 600, unit: 'mg' }, standard: '120-240mg daily' },
  { alias: ['valerian'], ceiling: { value: 3000, unit: 'mg' }, standard: '300-600mg at night' },
  { alias: ['milk thistle', 'silymarin'], ceiling: { value: 4200, unit: 'mg' }, standard: '140-420mg daily' },
  { alias: ['saw palmetto', 'serenoa'], ceiling: { value: 2000, unit: 'mg' }, standard: '320mg daily' },
  { alias: ['vitex', 'agnus'], ceiling: { value: 4000, unit: 'mg' }, standard: '20-40mg daily' },
  { alias: ['maca'], ceiling: { value: 5000, unit: 'mg' }, standard: '1.5-3g daily' },
  { alias: ['tribulus'], ceiling: { value: 3000, unit: 'mg' }, standard: '500-750mg daily' },
  { alias: ['astaxanthin'], ceiling: { value: 50, unit: 'mg' }, standard: '4-12mg daily' },
  { alias: ['nac', 'n-acetyl'], ceiling: { value: 3000, unit: 'mg' }, standard: '600-1,200mg daily' },
  { alias: ['lipoic'], ceiling: { value: 1800, unit: 'mg' }, standard: '300-600mg daily' },
  { alias: ['resveratrol'], ceiling: { value: 3000, unit: 'mg' }, standard: '150-500mg daily' },
  { alias: ['quercetin'], ceiling: { value: 2000, unit: 'mg' }, standard: '500-1,000mg daily' },
  { alias: ['glucosamine'], ceiling: { value: 3000, unit: 'mg' }, standard: '1,500mg daily' },
  { alias: ['chondroitin'], ceiling: { value: 2400, unit: 'mg' }, standard: '800-1,200mg daily' },
  { alias: ['boswellia'], ceiling: { value: 4200, unit: 'mg' }, standard: '100-400mg daily' },
  { alias: ['hmb', 'beta-hydroxy'], ceiling: { value: 12000, unit: 'mg' }, standard: '3g daily' },
  { alias: ['citrulline'], ceiling: { value: 15000, unit: 'mg' }, standard: '3-6g daily' },
  { alias: ['beta-alanine'], ceiling: { value: 6000, unit: 'mg' }, standard: '2-5g daily split doses' },
  { alias: ['hyaluronic'], ceiling: { value: 500, unit: 'mg' }, standard: '120-240mg daily' },
  { alias: ['whey', 'protein'], ceiling: { value: 60000, unit: 'mg' }, standard: '20-30g per serving' },
];

const doseEntry = (name) => {
  const n = String(name || '').toLowerCase();
  return DOSE_TABLE.find((e) => e.alias.some((a) => n.includes(a))) || null;
};

// "300-400mg", "0.5–1mg", "1,500 mg", "2000 IU": the FIRST stated amount is the
// one the nutrient is dosed at (multi-nutrient strings like "18-25mg iron +
// 500mg vitamin C" name the primary first), and a range is read at its top.
const DOSE_NUMBER = /^\s*(\d+(?:[.,]\d+)?)\s*(?:[-–—]\s*(\d+(?:[.,]\d+)?))?\s*(mcg|µg|ug|mg|g|iu)?/i;

function parseFirstDose(text) {
  const m = DOSE_NUMBER.exec(String(text || ''));
  if (!m) return null;
  const value = Number(String(m[2] ?? m[1]).replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  const rawUnit = String(m[3] || 'mg').toLowerCase().replace('.', '');
  const unit = rawUnit === 'µg' || rawUnit === 'ug' ? 'mcg' : rawUnit;
  return { value, unit };
}

/**
 * True when the stated dose is within the app's ceiling for that nutrient, or
 * when the app has no ceiling to assert (unknown nutrient, or IU-vs-mg mismatch
 * — never convert across unit systems in a safety check).
 */
function checkDose(name, dosageText) {
  const entry = doseEntry(name);
  if (!entry) return { ok: true, reason: '' };
  const parsed = parseFirstDose(dosageText);
  if (!parsed) return { ok: true, reason: '' }; // "Per label", "as directed"
  if (parsed.unit !== entry.ceiling.unit) return { ok: true, reason: '' };
  if (parsed.value <= entry.ceiling.value) return { ok: true, reason: '' };
  return {
    ok: false,
    reason: `${parsed.value}${parsed.unit} exceeds the ${entry.ceiling.value}${entry.ceiling.unit} ceiling this app will dose ${entry.alias[0]} at`,
    standard: entry.standard,
  };
}

// ---------------------------------------------------------------------------
// 4. Row-level safety
// ---------------------------------------------------------------------------

/** Rows the plan may not carry at all. */
function rejectReason(name) {
  const n = String(name || '').trim();
  if (!n) return 'no supplement name';
  if (isPrescriptionOrDangerous(n)) return 'prescription or non-supplement substance';
  // A name the taxonomy cannot classify is a name the product cannot vouch for.
  // Known-approved ingredients from the evidence standard are still allowed so
  // an itemised form ("Devil's Claw") is not dropped for a formatting reason.
  if (classifySupplement(n) === null && !isKnownApprovedSupplement(n)) return 'off-catalog supplement name';
  return null;
}

const PRIORITIES = ['High', 'Medium', 'Low'];
const SEVERITIES = ['High', 'Moderate', 'Low'];

function normaliseTrustFields(rec) {
  const out = { ...rec };
  const changed = [];
  const p = PRIORITIES.find((x) => String(out.priority || '').trim().toLowerCase() === x.toLowerCase());
  if (!p) { out.priority = 'Medium'; changed.push('priority'); }
  else if (p !== out.priority) { out.priority = p; changed.push('priority'); }

  const cs = Number(out.confidenceScore);
  if (!Number.isFinite(cs)) { out.confidenceScore = 80; changed.push('confidenceScore'); }
  else {
    // The schema promises 70-100. A model that outputs 45 or 1000 is not
    // measuring anything, so clamp into the range the client displays.
    const clamped = Math.max(70, Math.min(100, Math.round(cs)));
    if (clamped !== out.confidenceScore) changed.push('confidenceScore');
    out.confidenceScore = clamped;
  }

  const sev = SEVERITIES.find((x) => String(out.severityLevel || '').trim().toLowerCase() === x.toLowerCase());
  if (!sev) {
    out.severityLevel = out.priority === 'High' ? 'High' : out.priority === 'Medium' ? 'Moderate' : 'Low';
    changed.push('severityLevel');
  } else if (sev !== out.severityLevel) { out.severityLevel = sev; changed.push('severityLevel'); }

  if (typeof out.consultDoctor !== 'boolean') out.consultDoctor = String(out.consultDoctor || '').toLowerCase() === 'true';
  return { rec: out, changed };
}

// ---------------------------------------------------------------------------
// 5. The pass
// ---------------------------------------------------------------------------

const MAX_AUDIT_ACTIONS = 60;

/**
 * Ground one plan. Returns a NEW plan; never mutates the caller's.
 *
 *   plan      — the AI plan, or the rule engine's own output (both are checked:
 *               the rule engine has historically shipped fabricated PMIDs too)
 *   profile   — the validated assessment payload, the only source of patient fact
 *   options   — { trustedRecs, adjustFoods, allowedPmids }
 *       trustedRecs: the rule engine's rows for this profile, used to refill a
 *                    slot freed by a rejected row so a member still gets a plan
 *       adjustFoods: the route's diet repair, applied per row
 *       allowedPmids: extra identifiers the app can vouch for (AI-published
 *                    condition bundles that cleared the evidence gate)
 */
function groundPlan(plan, profile = {}, options = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.recommendations)) return plan;
  const ctx = buildFactContext(profile);
  const allowedPmids = options.allowedPmids instanceof Set
    ? options.allowedPmids
    : new Set([...allowlistedPmids(), ...(options.allowedPmids || []).map(String)]);

  const actions = [];
  const record = (name, kind, detail) => {
    if (actions.length < MAX_AUDIT_ACTIONS) actions.push({ item: String(name || '').slice(0, 80), kind, detail: String(detail || '').slice(0, 200) });
  };

  const allergyTerms = String(profile.allergies || '')
    .toLowerCase().split(/[,;]/).map((t) => t.trim())
    .filter((t) => t.length > 2 && !/^(none|nkda|not specified|no known allergies?|n\/a)/.test(t));

  const clampedDoses = [];

  let recs = [];
  for (const raw of plan.recommendations) {
    if (!raw || typeof raw !== 'object') continue;
    let rec = { ...raw };

    const reject = rejectReason(rec.name);
    if (reject) {
      record(rec.name, 'row-dropped', reject);
      continue;
    }
    if (allergyTerms.some((t) => String(rec.name).toLowerCase().includes(t))) {
      record(rec.name, 'row-dropped', 'contains a declared allergen');
      continue;
    }

    // Fields first, so a citation is verified against a name that survived.
    const { rec: normalised, changed } = normaliseTrustFields(rec);
    rec = normalised;
    if (changed.length) record(rec.name, 'field-normalised', changed.join(', '));

    const cite = verifyCitation(rec.evidence, rec.name, { allowedPmids });
    if (!cite.ok) record(rec.name, 'citation-replaced', cite.reason);
    else if (cite.upgraded) record(rec.name, 'citation-grounded', 'replaced with the registry copy for this nutrient');
    rec.evidence = cite.replacement;

    const trig = groundTriggeredBy(rec.triggeredBy, ctx);
    if (trig.stripped.length) record(rec.name, 'trigger-stripped', `unreported: ${trig.stripped.join('; ')}`.slice(0, 160));
    if (typeof rec.triggeredBy === 'string' || rec.triggeredBy === undefined) rec.triggeredBy = trig.value;

    for (const field of ['reason', 'conditionContext']) {
      if (typeof rec[field] !== 'string') continue; // nothing written, nothing to ground
      const prose = groundProse(rec[field], ctx, {
        fallback: field === 'reason'
          ? `${rec.name} is included as a preventive nutrition support item for this profile.`
          : null,
      });
      if (prose.stripped > 0) record(rec.name, field + '-claim-removed', `${prose.stripped} clause(s) asserted an unreported patient fact`);
      rec[field] = prose.value;
    }
    if (typeof rec.simplifiedReason === 'string') {
      const simplified = groundProse(rec.simplifiedReason, ctx, {
        fallback: `${rec.name} may support your stated wellness goals.`,
      });
      if (simplified.stripped > 0) record(rec.name, 'simplifiedReason-claim-removed', `${simplified.stripped} clause(s)`);
      rec.simplifiedReason = simplified.value;
    }

    const dose = checkDose(rec.name, rec.dosage);
    if (!dose.ok) {
      record(rec.name, 'dose-clamped', dose.reason);
      clampedDoses.push({ name: rec.name, standard: dose.standard });
      rec.dosage = dose.standard;
    }

    if (typeof rec.foods === 'string' && allergyTerms.length > 0) {
      const keptList = rec.foods.split(/[,;]/).map((f) => f.trim())
        .filter((f) => f && !allergyTerms.some((t) => f.toLowerCase().includes(t)));
      if (keptList.length < rec.foods.split(/[,;]/).filter((f) => f.trim()).length) {
        record(rec.name, 'foods-stripped', 'allergen-containing item(s) removed');
        rec.foods = keptList.join(', ');
      }
    }
    if (typeof options.adjustFoods === 'function') rec.foods = options.adjustFoods(rec.foods, profile.dietType);

    recs.push(rec);
  }

  // Duplicate names make a plan look padded; keep the first, it is the higher
  // priority one once planConsistency re-orders.
  const seenNames = new Set();
  recs = recs.filter((r) => {
    const key = String(r.name || '').toLowerCase().replace(/[^a-z0-9+ ]/g, '').trim();
    if (!key || seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });

  // Refill the slots freed by rejected rows from the rule engine's curated rows.
  const trusted = Array.isArray(options.trustedRecs) ? options.trustedRecs : [];
  const target = plan.recommendations.length;
  for (const t of trusted) {
    if (recs.length >= target) break;
    const key = String(t?.name || '').toLowerCase().replace(/[^a-z0-9+ ]/g, '').trim();
    if (!key || seenNames.has(key)) continue;
    if (rejectReason(t?.name)) continue;
    seenNames.add(key);
    recs.push({ ...normaliseTrustFields(t).rec, groundingBackfilled: true });
    record(t.name, 'row-backfilled', 'replaced a rejected row with the rule engine curated recommendation');
  }

  const out = { ...plan, recommendations: recs };

  // A clamped dose is a safety-relevant change; tell the member, in the section
  // the client already renders.
  if (clampedDoses.length > 0) {
    const warnings = Array.isArray(out.warnings) ? [...out.warnings] : [];
    for (const c of clampedDoses) {
      const text = `The dose suggested for ${c.name} was above this app's safety ceiling and was replaced with the standard range for it: ${c.standard}.`.slice(0, 300);
      if (!warnings.includes(text)) warnings.push(text);
    }
    out.warnings = warnings;
  }

  const counts = {};
  for (const a of actions) counts[a.kind] = (counts[a.kind] || 0) + 1;
  // No timestamp: groundPlan is a pure function of (plan, profile), so running
  // it twice on an already-grounded plan changes nothing it can detect.
  out.grounding = { verified: true, actions, counts };
  return out;
}

/**
 * Read-only version of the three hard checks, for the benchmark and the metrics:
 * a plan is grounded when nothing it shows would fail the verifier.
 */
function groundingViolations(plan, profile = {}, options = {}) {
  if (!plan || !Array.isArray(plan.recommendations)) return [];
  const ctx = buildFactContext(profile);
  const allowedPmids = options.allowedPmids instanceof Set
    ? options.allowedPmids
    : new Set([...allowlistedPmids(), ...(options.allowedPmids || []).map(String)]);
  const out = [];
  for (const rec of plan.recommendations) {
    const name = rec?.name;
    const reject = rejectReason(name);
    if (reject) out.push({ name, kind: 'row', reason: reject });
    const cite = verifyCitation(rec?.evidence, name, { allowedPmids });
    if (!cite.ok) out.push({ name, kind: 'citation', reason: cite.reason });
    const dose = checkDose(name, rec?.dosage);
    if (!dose.ok) out.push({ name, kind: 'dose', reason: dose.reason });
    if (unreportedClaims(rec?.triggeredBy, ctx).length > 0) out.push({ name, kind: 'trigger', reason: 'names a symptom or condition the patient did not report' });
    if (fabricatedPersonalClaims(rec?.reason, ctx).length > 0) out.push({ name, kind: 'reason', reason: 'asserts an unreported patient fact' });
  }
  return out;
}

module.exports = {
  NEUTRAL_TRIGGER,
  GOAL_OPTIONS,
  DOSE_TABLE,
  buildFactContext,
  unreportedClaims,
  fabricatedPersonalClaims,
  groundTriggeredBy,
  groundProse,
  verifyCitation,
  checkDose,
  parseFirstDose,
  doseEntry,
  rejectReason,
  normaliseTrustFields,
  groundPlan,
  groundingViolations,
};
