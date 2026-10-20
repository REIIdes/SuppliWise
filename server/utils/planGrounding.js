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
 * Names that are a FACT ABOUT A MEMBER rather than a wellness topic: lab
 * analytes and prescription drugs.
 *
 * They are not in the questionnaire's symptom/condition lists, so the vocabulary
 * built from it would never see them, and an invented "your ferritin is 12" or
 * "because you take warfarin" would sail through the patient-fact check while
 * reading exactly like a recollection. A model produces both shapes freely — one
 * to justify a dose, one to sound personal.
 *
 * Putting them in the vocabulary does not make them forbidden: they are advice
 * words as often as fact words ("your body absorbs iron better with vitamin C").
 * They are only ever acted on together with an attribution shape, and a member
 * who typed the value in their own medications or lab results licenses it through
 * `freeText`, like every other reported fact.
 *
 * The analyte list is deliberately made of names that are ONLY a lab value. Every
 * drug name below also feeds `MEDICATION_WORDS`, and "reduce sodium intake" is
 * sound advice for hypertension — when `sodium` was in this list it joined that
 * alternation and the verifier replaced a lifestyle line with a prescription
 * warning. Bare nutrient words (`iron`, `glucose`, `potassium`, `vitamin d`) are
 * left out for the same reason; the qualified forms stay, and they are the shape
 * a fabricated result actually arrives in ("your ferritin is 12").
 */
const LAB_FACT_TERMS = [
  'ferritin', 'hemoglobin', 'haemoglobin', 'hemoglobin a1c', 'hba1c', 'hb a1c',
  'ldl', 'hdl', 'vldl', 'apolipoprotein b', 'triglycerides', 'fasting glucose',
  'creatinine', 'kidney function', 'liver enzymes', 'tsh', 'thyroid panel',
  'cortisol', 'testosterone', 'estradiol', 'dheas', 'homocysteine', 'crp', 'hs-crp',
  'sed rate', 'uric acid', 'psa', 'albumin', 'bilirubin', 'c-peptide', 'serum iron',
  'tibc', 'transferrin saturation', 'vitamin d level', '25-oh vitamin d',
  'vitamin b12 level', 'folate level', 'omega-3 index', 'platelet count',
];

/**
 * Conditions a member can be told they have that the questionnaire never asks
 * about, so they can never be in anyone's answer list.
 *
 * The vocabulary otherwise comes straight from the instrument, which is right for
 * symptoms and goals — but an invented "since you mentioned your epilepsy" is the
 * most dangerous fabrication in this product, because it is the sentence that
 * justifies a dangerous interaction warning. A condition nobody can select can
 * still be selected BY the model, so the app keeps its own list of the ones that
 * change what is safe to recommend.
 */
const SERIOUS_CONDITION_TERMS = [
  'epilepsy', 'seizure disorder', 'seizures', 'cirrhosis', 'liver disease', 'kidney disease',
  'kidney failure', 'dialysis', 'organ transplant', 'transplant recipient', 'hiv', 'hepatitis',
  'lupus', 'multiple sclerosis', 'parkinson', 'parkinsons', 'alzheimer', 'alzheimers', 'dementia',
  'bipolar disorder', 'schizophrenia', 'ptsd', 'heart failure', 'arrhythmia', 'irregular heartbeat',
  'pacemaker', 'blood clot', 'thrombosis', 'deep vein thrombosis', 'stroke', 'cancer', 'tumour',
  'tumor', 'chemotherapy', 'crohn', "crohn's", 'ulcerative colitis', 'colitis', 'celiac', 'celiac disease',
  'gout', 'asthma', 'copd', 'emphysema', 'addison', 'myasthenia gravis', 'guillain-barre',
  'sickle cell', 'hemochromatosis', 'wilson disease', 'porphyria', 'thyroid storm',
  'parkinsonian', 'mesenteric ischemia', 'pulmonary fibrosis', 'sarcoidosis',
];

/** The common prescriptions a member of this app is actually on. */
const PRESCRIPTION_DRUG_NAMES = [
  'atorvastatin', 'simvastatin', 'rosuvastatin', 'pravastatin', 'fluvastatin', 'pitavastatin',
  'lisinopril', 'ramipril', 'enalapril', 'losartan', 'valsartan', 'amlodipine', 'metoprolol',
  'atenolol', 'carvedilol', 'propranolol', 'hydrochlorothiazide', 'furosemide', 'spironolactone',
  'warfarin', 'coumadin', 'apixaban', 'eliquis', 'rivaroxaban', 'xarelto', 'clopidogrel',
  'metformin', 'glipizide', 'glyburide', 'empagliflozin', 'semaglutide', 'ozempic', 'levothyroxine',
  'sertraline', 'fluoxetine', 'escitalopram', 'citalopram', 'paroxetine', 'duloxetine', 'venlafaxine',
  'bupropion', 'alprazolam', 'lorazepam', 'diazepam', 'clonazepam', 'zolpidem', 'gabapentin',
  'pregabalin', 'prednisone', 'dexamethasone', 'albuterol', 'salbutamol', 'omeprazole', 'pantoprazole',
  'esomeprazole', 'tramadol', 'oxycodone', 'hydrocodone', 'methotrexate', 'hydroxychloroquine',
  'adalimumab', 'finasteride', 'tamsulosin', 'tamoxifen', 'letrozole', 'aspirin',
];

const PERSONAL_FACT_TERMS = [...LAB_FACT_TERMS, ...PRESCRIPTION_DRUG_NAMES];

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
  // The condition list only: names a member can be *said to have*, as opposed to
  // a state of theirs the app may describe freely. See possessiveConditionMatcher.
  const conditionTerms = new Set();
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
  for (const label of MEDICAL_CONDITIONS) {
    const l = String(label).toLowerCase().trim();
    if (l.length >= 4) conditionTerms.add(l);
    labelTerms(l).forEach((t) => { if (t.length >= 5) conditionTerms.add(t); });
  }
  // Lab and drug names join the vocabulary (so an assertion using one is seen) and
  // a set of their own (so the possessive shape "your ferritin" is checked). They
  // stay out of `conditionTerms`: that set also feeds the "is being studied for"
  // claim rules, where a drug name would be nonsense.
  const personalTerms = new Set();
  for (const term of PERSONAL_FACT_TERMS) {
    const t = String(term).toLowerCase();
    personalTerms.add(t);
    if (!vocabulary.has(t)) vocabulary.set(t, term);
  }
  for (const term of SERIOUS_CONDITION_TERMS) {
    const t = String(term).toLowerCase();
    if (!vocabulary.has(t)) vocabulary.set(t, term);
    conditionTerms.add(t);
  }
  return {
    reported, reportedWords, freeText, vocabulary, goalTerms, conditionTerms, personalTerms,
    hasAnyReport: reportedLabels.length > 0,
  };
}

/**
 * "Your diabetes is the reason for this." attributes a condition to the member
 * without using any of the report verbs `PERSONAL_ATTRIBUTION` looks for.
 *
 * Restricted to listed MEDICAL_CONDITIONS, and deliberately not to symptoms or
 * goals: a condition name is never a friendly way of addressing the reader, so
 * "your endometriosis" can only be a claim about them — whereas "your sleep",
 * "your energy" or "your digestion" are ordinary prose the app uses when giving
 * advice ("take it at night for your sleep"), and deleting those true sentences
 * would be exactly the failure this verifier exists to avoid.
 *
 * Being possessed is only the SHAPE; the clause is still dropped only when
 * `unreportedClaims` says the member never named it, so a member who did select
 * PCOS keeps "your PCOS" in their own plan.
 */
function possessiveConditionMatcher(ctx) {
  if (!ctx._possessiveCondition) {
    const terms = new Set([...(ctx.conditionTerms || []), ...(ctx.personalTerms || [])]);
    const escaped = [...terms]
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // The two-word gap is the point: the instrument lists `Osteoporosis / Bone
    // Health`, so `arthritis` is a term and "your rheumatoid arthritis" — a
    // qualifier the questionnaire never offers — would otherwise slip past a
    // matcher that demands the term immediately after "your". Two words is enough
    // for "your severe rheumatoid arthritis" and "your recently diagnosed
    // diabetes" without reaching across a sentence to grab an unrelated noun.
    ctx._possessiveCondition = escaped.length
      ? new RegExp(`\\byour\\s+(?:[a-z0-9][a-z0-9'-]*\\s+){0,2}(?:${escaped.join('|')})\\b`, 'i')
      : /(?!)/;
  }
  return ctx._possessiveCondition;
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
const PERSONAL_ATTRIBUTION = /\b(you|your|you'r?e|since you|as you|given your|reported by you|patient reports?)\b[^.]{0,60}?\b(report(?:ed|ing)?|mention(?:ed|ing)?|state[ds]?|have|are experiencing|suffer(?:ing|ed)?|diagnos(?:ed|is|ing)|live with|deal(?:ing)? with|struggle(?:d|ing)? with|experience(?:d)?|tak(?:e|es|ing)|prescrib(?:e|es|ed|ing)|are on|were on|been on|tested positive for)\b/i;

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
  const possessive = possessiveConditionMatcher(ctx);
  return text
    .split(CLAUSE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s
      && (PERSONAL_ATTRIBUTION.test(s) || possessive.test(s))
      && unreportedClaims(s, ctx, { ignoreGoalLabels: true }).length > 0);
}

/** Drop the lying clauses; keep everything that is not a false attribution. */
const CLAUSE_TOKENS = new RegExp(`(${CLAUSE_SPLIT.source})`, 'g');

function groundProse(text, ctx, { fallback = '' } = {}) {
  const bad = fabricatedPersonalClaims(text, ctx);
  if (bad.length === 0) return { value: text, stripped: 0 };
  // Rebuilt clause by clause with the separators kept, because `split(CLAUSE_SPLIT)`
  // throws them away and a deletion then FUSES the neighbouring sentences:
  // "- Take 4000 mg daily - since you have X. Turmeric is a spice." came back as
  // "- Take 4000 mg daily Turmeric is a spice.", which the next pass read as one
  // instruction about turmeric and clamped the dose in it. Two things were wrong
  // with that: the member's sentence was rewritten again on the second trip — so a
  // guide re-verified on every cache read degrades a little each time — and the
  // clamp itself was now a lie about a figure that had never been a turmeric dose.
  // A boundary is owed wherever the deleted clause ended a sentence.
  const tokens = String(text).split(CLAUSE_TOKENS);
  let out = '';
  let dropped = 0;
  for (let i = 0; i < tokens.length; i += 2) {
    const clause = String(tokens[i]);
    const sep = tokens[i + 1] == null ? '' : String(tokens[i + 1]);
    const trimmed = clause.trim();
    if (!trimmed || !bad.includes(trimmed)) {
      out += clause + sep;
      continue;
    }
    dropped += 1;
    if (!/[.!?]$/.test(trimmed)) continue; // a dash fragment leaves no boundary to keep
    out = out.replace(/\s*[—–-]\s*$/, '').replace(/\s+$/, '');
    if (out && !/[.!?]$/.test(out)) out += '.';
    out += ' ';
  }
  return { value: out.trim() || fallback, stripped: dropped };
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

/** Metric mass is one quantity at three scales, so `5 g` is comparable to a 25,000 mg ceiling. */
const MG_PER_UNIT = { mcg: 1 / 1000, mg: 1, g: 1000 };

/** `null` means "not comparable" — IU measures activity, not mass, and never converts. */
function toMg(parsed) {
  if (!parsed) return null;
  const factor = MG_PER_UNIT[parsed.unit];
  return factor == null ? null : parsed.value * factor;
}

const ceilingOf = (entry) => (entry.ceiling.unit === 'IU'
  ? { unit: 'iu', value: entry.ceiling.value }
  : { unit: 'mg', value: toMg({ value: entry.ceiling.value, unit: entry.ceiling.unit }) });

/**
 * True when a stated amount sits past a nutrient's ceiling. Mass is compared in
 * mg, activity in IU, and the two are never compared against each other.
 */
function doseExceeds(entry, parsed) {
  const ceiling = ceilingOf(entry);
  if (ceiling.unit === 'iu') return parsed.unit === 'iu' && parsed.value > ceiling.value;
  const mg = toMg(parsed);
  return mg != null && mg > ceiling.value;
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
  if (!doseExceeds(entry, parsed)) return { ok: true, reason: '' };
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

  // Every member-facing string the row checks above do not own — the summary,
  // lifestyle advice, action plan, meals, warnings, avoid list, and the narrative
  // fields inside each row — gets the same six-step pass a chat reply gets.
  // `evidence`, `dosage` and `foods` are skipped because a dedicated verifier
  // already read them and knows more about those fields than prose rules can.
  //
  // This runs BEFORE the dose-clamp warnings are appended on purpose: the app's
  // own safety sentences must not be rewritten by the tool that exists to rewrite
  // the model's, and the one thing a clamped dose must still say is the number it
  // was clamped to.
  const prose = verifyDocumentDeep(out, { ctx, allowedPmids, fallback: '' });
  for (const r of prose.repairs) record(r.field, `prose-${r.kind}`, r.detail);
  const verified = compactSections(prose.value);

  // A clamped dose is a safety-relevant change; tell the member, in the section
  // the client already renders.
  if (clampedDoses.length > 0) {
    const warnings = Array.isArray(verified.warnings) ? [...verified.warnings] : [];
    for (const c of clampedDoses) {
      const text = `The dose suggested for ${c.name} was above this app's safety ceiling and was replaced with the standard range for it: ${c.standard}.`.slice(0, 300);
      if (!warnings.includes(text)) warnings.push(text);
    }
    verified.warnings = warnings;
  }

  const counts = {};
  for (const a of actions) counts[a.kind] = (counts[a.kind] || 0) + 1;
  // No timestamp: groundPlan is a pure function of (plan, profile), so running
  // it twice on an already-grounded plan changes nothing it can detect.
  verified.grounding = { verified: true, actions, counts };
  return verified;
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

// ---------------------------------------------------------------------------
// 7. Free prose (chat replies, supplement guides)
// ---------------------------------------------------------------------------

/** `PMID 12345678`, `PMID: 12345678`, `(PMID: 12345678)`, `PMIDs: 123, 456`. */
const PMID_TOKEN = /\bPMIDs?\b[:\s]*\d{4,8}(?:\s*,\s*\d{4,8})*/gi;
/** A bare citation-shaped number in parentheses, e.g. `(2019; 12: 3456)` is NOT matched — only numbers someone could look up. */
const DOI_TOKEN = /\bhttps?:\/\/doi\.org\/\S+|\b10\.\d{4,9}\/[^\s),;]+\b/gi;
/**
 * The other registries a model names when it wants a citation to look real: a
 * trial registration number, an arXiv id, or the bare host typed without a
 * scheme (`pubmed.ncbi.nlm.nih.gov/99999999/`), which a scheme-anchored URL
 * pattern never sees. Same reasoning as DOI_TOKEN — this app's registry holds no
 * trial ids, so any id it asserts is one it cannot check.
 */
const REGISTRY_TOKEN = /\b(?:NCT|NRCT|EudraCT|UDAP|ACTRN|ChiCTR)[-]?\d{6,12}\b|\barXiv[:\s]\S+\b|\b(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|clinicaltrials\.gov|doi\.org|scholar\.google\.com)[^\s.,;)]*/gi;

/**
 * Strip the hard identifiers a reply asserts but the app cannot vouch for.
 *
 * This is the prose-shaped version of `verifyCitation`, and it deliberately does
 * less. A plan row has a schema and a curated replacement for every field, so a
 * fabricated citation can be swapped for the registry copy. A chat reply is one
 * paragraph the member asked for: deleting sentences would remove advice that
 * may be perfectly sound, and the app cannot tell which. So only the
 * *identifier* goes — the lookup number nobody checked — and the sentence it sat
 * in stays. "Multiple trials (PMID: 32722093) support this" becomes "Multiple
 * trials support this": still the same claim, no longer one presented as
 * checkable when it is not.
 *
 * Same allowlist as the plan path, so chat and the results screen cannot
 * disagree about what the app is willing to stand behind.
 *
 * @param {string} text
 * @param {{allowedPmids?: Set<string>}} [options]
 * @returns {{value: string, removed: string[]}}
 */
function stripUnverifiableIdentifiers(text, { allowedPmids } = {}) {
  const raw = String(text == null ? '' : text);
  if (!raw) return { value: raw, removed: [] };
  const allowed = allowedPmids instanceof Set && allowedPmids.size
    ? allowedPmids
    : allowlistedPmids();
  const removed = [];

  const keepOrStrip = (whole) => {
    const ids = extractPmids(whole);
    const bad = ids.filter((id) => !allowed.has(String(id)));
    if (!bad.length) return whole;
    removed.push(...bad.map((id) => `PMID ${id}`));
    return '';
  };

  let value = raw.replace(PMID_TOKEN, keepOrStrip);
  value = value.replace(DOI_TOKEN, (whole) => {
    // No DOI is in the registry, so any DOI a model asserts is unverifiable here.
    removed.push(`DOI ${whole.slice(0, 40)}`);
    return '';
  });
  value = value.replace(REGISTRY_TOKEN, (whole, ...rest) => {
    // The last two args of a capture-free replace are (offset, string). A host
    // that is part of a full `https://…` URL belongs to URL_IN_TEXT below, which
    // keeps registry links whose PMIDs ARE in the allowlist — cutting the host
    // out of a citation the app stands behind would destroy a correct link.
    const offset = rest[rest.length - 2];
    const source = rest[rest.length - 1];
    if (source.slice(Math.max(0, offset - 9), offset).includes('://')) return whole;
    removed.push(String(whole).slice(0, 40));
    return '';
  });
  value = value.replace(URL_IN_TEXT, (whole) => {
    if (!ALLOWED_URL_HOSTS.some((host) => whole.toLowerCase().includes(host))) {
      removed.push(`URL ${whole.slice(0, 40)}`);
      return '';
    }
    // The host being allowed is not enough. `pubmed.ncbi.nlm.nih.gov/99999999/`
    // points at a study that does not exist, and it is the shape a model reaches
    // for when it wants a link to look real. Same rule `verifyCitation` applies.
    const ids = extractPmids(whole);
    const bad = ids.filter((id) => !allowed.has(String(id)));
    if (bad.length) {
      removed.push(...bad.map((id) => `PMID ${id}`));
      return '';
    }
    return whole;
  });

  // Stripping leaves the artefacts the identifier was wrapped in: "(PMID: …)"
  // becomes "()", "see  ." becomes "see  .". Repair those, because a reader who
  // sees an empty parenthesis immediately knows something was hidden from them —
  // which is worse than an answer that never cited a number at all.
  //
  // But only when something WAS taken. The repairs are whitespace-collapsing by
  // nature, and running them on an untouched paragraph turned every double
  // newline in a chat reply into a single space — the verifier reformatting an
  // answer it had nothing to correct.
  if (!removed.length) return { value: raw.trim(), removed };
  value = value
    .replace(/[（(]\s*[)）]/g, '')
    // An identifier that sat at the end of a clause leaves the connective that
    // introduced it behind: "read more at <URL> and <NCT12345678>." loses both
    // targets and becomes "read more at and .". These two shapes are the residue,
    // and a reader who sees them knows something was cut.
    .replace(/\s+(?:and|or)\s+(?=[.,;:!?]|$)/gi, ' ')
    .replace(/\b(?:see|read more(?:\s+at)?|at|in|from|via|available at|published in)\s+(?=[.,;:!?])/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();

  return { value, removed };
}

/**
 * Walk every string inside a parsed document and run it through `onString`.
 *
 * The supplement guide is JSON with nested arrays and objects, and a fabricated
 * claim can sit in any of them — most often a `keyBenefits[].description`. Doing
 * this per-field at the call site is how one field gets forgotten, and a guide
 * is written to the shared store BEFORE it is served: one missed field means
 * every later reader of that profile sees the invention, from cache, forever. So
 * the whole document is walked.
 *
 * Arrays and plain objects are rebuilt rather than mutated, because the parsed
 * reply is also what the caller returns to the client.
 *
 * `skipKeys` is how a field with its own owner stays out of the prose pass:
 * `evidence` is verified by `verifyCitation` against the registry, `dosage` by
 * `checkDose` against the row's nutrient, and the guide's `disclaimer` is text
 * the app writes — rewriting our own legal sentence would be the verifier
 * damaging the one string it cannot be wrong about.
 *
 * @param {*} node
 * @param {(text: string, key: string) => string} onString
 * @param {{skipKeys?: Iterable<string>, maxDepth?: number}} [options]
 */
function walkStrings(node, onString, options = {}, depth = 0) {
  const skip = options.skipKeys instanceof Set ? options.skipKeys : new Set(options.skipKeys || []);
  const maxDepth = options.maxDepth == null ? 6 : options.maxDepth;
  if (typeof node === 'string') return onString(node, options.key || '');
  if (depth > maxDepth || node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => walkStrings(item, onString, { ...options, key: '' }, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(node)) {
    out[key] = skip.has(key) ? item : walkStrings(item, onString, { ...options, key }, depth + 1);
  }
  return out;
}

function stripIdentifiersDeep(value, options = {}) {
  const removed = [];
  const value2 = walkStrings(value, (text) => {
    const cleaned = stripUnverifiableIdentifiers(text, options);
    removed.push(...cleaned.removed);
    return cleaned.value;
  }, options);
  return { value: value2, removed };
}

// ---------------------------------------------------------------------------
// 8. Free prose — what a paragraph is allowed to assert
// ---------------------------------------------------------------------------

/**
 * A plan has a schema; a chat reply and a supplement guide are paragraphs. The
 * prose surfaces were verified for exactly one thing until this section: a hard
 * identifier (PMID / DOI / URL) the app cannot resolve. Every other shape a model
 * produces with total confidence walked past that filter untouched:
 *
 *   "Magnesium reduces migraine frequency by 40%."    an invented effect size
 *   "Vitamin D deficiency affects 42% of adults."      an invented prevalence
 *   "A 2021 randomized trial in 200 patients showed…"  a recalled study, no identifier
 *   "Take 10,000 IU of vitamin D daily."               past this app's own ceiling
 *   "Ashwagandha cures anxiety."                       a curative claim the disclaimer denies
 *   "You can stop your metformin and use berberine instead."  a treatment change that can hurt someone
 *   "Since you mentioned your diabetes…"               a patient fact the patient never reported
 *
 * Each shape is repaired here, deterministically, always in the direction of
 * LESS certainty than the model wrote — the verifier never strengthens a claim,
 * so a passing sentence was never made truer by the app than the model asserted
 * it. That asymmetry is the whole safety argument for editing a member's answer
 * at all.
 */

/**
 * Sentence splitter that KEEPS its separators. `split` with a capture group
 * returns [text, sep, text, sep, …], so a rewrite can replace one sentence
 * without flattening the paragraph's line breaks — a guide description and a
 * chat reply are both multi-paragraph text, and collapsing them would be its own
 * kind of damage.
 */
const SENTENCE_SPLIT = /((?<=[.!?])\s+|\n+)/;

function mapSentences(text, rewrite) {
  const parts = String(text == null ? '' : text).split(SENTENCE_SPLIT);
  const repairs = [];
  for (let i = 0; i < parts.length; i += 2) { // odd slots are the captured separators
    const before = parts[i];
    if (!before) continue;
    parts[i] = rewrite(before, (kind, detail) => repairs.push({ kind, detail: String(detail).slice(0, 200) }));
  }
  return { value: parts.join(''), repairs };
}

// -- a. Treatment advice ------------------------------------------------------

/**
 * Drug words an assistant must never tell a member to change. Deliberately
 * narrow: "magnesium may interact with your thyroid medication" is correct,
 * useful safety advice and matches none of these patterns, because the patterns
 * require a VERB that changes the treatment, not a noun that names it.
 *
 * The named drugs are not decoration either. "Stop your medication" is caught by
 * the class word, but the sentence a model actually writes names the molecule —
 * "you can stop your atorvastatin" — and a rule that only knows the word
 * "statins" let that through. This is the highest-stakes hallucination the app
 * can produce, so the list is the common prescriptions a member of this app
 * would be on, taken from the same names PERSONAL_FACT_TERMS licenses.
 */
const PRESCRIPTION_NAME_WORDS = PRESCRIPTION_DRUG_NAMES.join('|');

const MEDICATION_WORDS = '(?:your |the |any |a |prescribed |doctor-prescribed )?'
  + '(?:medication|medicine|prescription|drugs?|treatment|statins?|insulin|metformin|'
  // `n?` is not decoration: "thinner" and "thinning" double the n, and a pattern
  // written as thin(er|ing) matches neither — the miss was found by testing the
  // plain sentence "this replaces your blood thinner".
  + 'blood[\\s-]+thin(?:n?er|n?ing)s?|levothyroxine|thyroid\\s+(?:medication|pill|drug)|'
  + `antidepressant|blood[- ]pressure\\s+(?:pill|medication|drugs?)|${PRESCRIPTION_NAME_WORDS})`;

const MED_SAFETY_PATTERNS = [
  new RegExp(`\\b(?:stop|stopping|quit|quitting|pause|pausing|skip|skipping|hold|holding|cut|cutting|reduc(?:e|es|ing)|lower|drop|halv(?:e|es|ing)|chang(?:e|es|ing))\\s+(?:out\\s+on\\s+)?${MEDICATION_WORDS}\\b`, 'i'),
  new RegExp(`\\bwean(?:s|ing|ed)?\\s+(?:off|onto)\\s+${MEDICATION_WORDS}\\b`, 'i'),
  new RegExp(`\\b(?:instead|replacement|alternative|substitut(?:e|es|ing|ion))\\b[^.!?]{0,48}?\\b(?:of|to|for)\\s+${MEDICATION_WORDS}\\b`, 'i'),
  // Equivalence claims are how a supplement gets offered as a substitute without
  // the words "instead of": "works as well as your lisinopril" is the same advice
  // wearing a comparison.
  new RegExp(`\\b(?:in place of|rather than|beats?|better than|stronger than|safer than|as effective as|as well as|works? (?:just )?as well as|as good as|just as good as)\\s+${MEDICATION_WORDS}\\b`, 'i'),
  new RegExp(`\\breplac(?:e|es|ing|ed)\\b[^.!?]{0,32}?${MEDICATION_WORDS}\\b`, 'i'),
  new RegExp(`\\b(?:no longer need|don'?t need|do not need|you can stop|skip taking)\\b[^.!?]{0,32}?${MEDICATION_WORDS}\\b`, 'i'),
  // `instead` on its own, when the sentence also names a drug: "take this instead"
  // is a treatment change even when the prepositional phrase is in the previous
  // sentence and therefore invisible to the patterns above.
  new RegExp(`\\b(?:take|use|try|switch to|move to)\\b[^.!?]{0,40}\\binstead\\b[^.!?]{0,20}${MEDICATION_WORDS}`, 'i'),
];

/**
 * The disclaimer shape: a negation in front of a change verb in front of a drug.
 * "This does not replace your medication" and "supplements are not an alternative
 * to your treatment" are the app telling a member to STAY on their prescription,
 * which is the opposite of what the patterns above hunt for. The negation has to
 * come first — "you can stop your statin, it is not risky" stays caught.
 */
const NOT_A_SUBSTITUTE = new RegExp(
  `\\b(?:not|never|without|cannot|can'?t|won'?t|doesn'?t|does not|don'?t|isn'?t|neither|no)\\b`
  + `[^.!?]{0,40}?\\b(?:replac(?:e|es|ing|ed|ement)|substitut(?:e|es|ion)|alternativ(?:e|es)|instead of|stop|skip|change|alter|reduce)\\b`
  + `[^.!?]{0,32}?${MEDICATION_WORDS}\\b`, 'i');

/**
 * What this app says instead — the same sentence, whoever it lands on.
 *
 * It is written so that it cannot match its own patterns. An earlier draft said
 * "do not stop or replace a prescribed medication", which the replacement rules
 * read as a fresh violation, so verifying an already-repaired reply appended a
 * second copy of the warning to itself. A safety line that re-triggers the
 * verifier is a bug factory, and the guard below is what keeps a future rewording
 * from quietly reintroducing it.
 */
const MED_SAFETY_LINE = 'Only the clinician who prescribes your treatment can safely change it. SuppliWise recommends food and supplements, never treatment changes.';
const MED_SAFETY_MARKER = 'Only the clinician who prescribes';

function enforceMedicationSafety(text) {
  let announced = false;
  let dropped = 0;
  const out = mapSentences(text, (sentence, report) => {
    if (sentence.includes(MED_SAFETY_MARKER)) { announced = true; return sentence; }
    // A negated mention is the app warning the member AWAY from a treatment
    // change — "this does not replace your blood pressure medication" is the
    // safest sentence a reply can contain. Replacing it with the safety line
    // would delete the one true thing the model said, so the negated span is
    // masked out and only what is left is tested against the patterns.
    const masked = sentence.replace(NOT_A_SUBSTITUTE, (whole) => `\u0001${whole.length}\u0001`);
    if (!MED_SAFETY_PATTERNS.some((re) => re.test(masked))) return sentence;
    report('medication-safety', sentence.slice(0, 140));
    // One warning per document. A guide that questions three prescriptions would
    // otherwise print the same sentence three times, which reads as a broken
    // template rather than as care — and a member who has already been told
    // cannot be told again by deleting the advice, so later copies go silent.
    if (announced) { dropped += 1; return ''; }
    announced = true;
    return MED_SAFETY_LINE;
  });
  // Only after a real removal: a paragraph taken out mid-document leaves its
  // flanking blank lines behind, and one at the end leaves the reader looking at
  // a hole where the advice was. Three newlines in a row reads as a broken page,
  // and untouched text keeps its own spacing.
  if (dropped === 0) return out;
  return {
    value: out.value.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, ''),
    repairs: out.repairs,
  };
}

// -- b. Curative and absolute claims -----------------------------------------

/**
 * Rewrites that keep the sentence and remove the certainty. Ordered so the
 * longer shapes go first: `will completely cure` must be consumed as one unit,
 * or the bare-verb rule would leave "will completely may help with" behind.
 */
const CLAIM_REWRITES = [
  // A named disease being treated or prevented — the claim the app's own
  // disclaimer explicitly denies ("does not diagnose, treat, cure, or prevent
  // any disease"). The condition is kept; only the verb changes.
  [/\b(?:treats?|prevents?|cures?)\s+(cancer|diabetes|type\s+2\s+diabetes|hypertension|high\s+blood\s+pressure|heart\s+disease|stroke|dementia|Alzheimer'?s(?:\s+disease)?|depression|anxiety\s+disorder|asthma|arthritis|infections?|inflammation)\b(?:\s+(?:completely|entirely|totally|fully|permanently|100%))?/gi,
    'is being studied for $1'],
  // The adverb has to go with the verb, not after it: rewriting "cures anxiety
  // completely" one rule at a time would leave "may help with anxiety
  // completely", which asserts more than the app means to.
  [/\b(?:cures?|heals?|reverses?|eliminates?|resolves?|gets?\s+rid\s+of)\s+([^.!?]{1,40}?)\s+(?:completely|entirely|totally|fully|permanently|100%)\b/gi,
    'may help with $1'],
  // "clinically proven to" is the marketing shape of a claim this app cannot
  // clear; "proven to" on its own is the same claim without the adjective.
  [/\b(?:clinically|scientifically|medically|statistically)\s+proven\s+(?:to|that)\b/gi, 'reported to'],
  [/\bproven\s+(?:to|that)\b/gi, 'shown in some studies to'],
  // Curative verbs, with the modal and intensifier that usually ride in front of
  // them, so the replacement stays grammatical.
  [/\b(?:will|can|could|may|might|helps?(?:\s+to)?)\s+(?:completely|entirely|totally|fully|permanently|rapidly|quickly|naturally|effectively)?\s*(?:cures?|cured|heals?|healed|reverses?|reversed|eliminates?|eliminated|resolves?|resolved|fixes?|fixed|gets?\s+rid\s+of)\b/gi,
    'may help with'],
  [/\b(?:cures?|heals?|reverses?|eliminates?|resolves?|fixes?)\b/gi, 'may help with'],
  [/\b(?:cured|healed|reversed|eliminated|resolved|fixed)\b/gi, 'improved'],
  // Safety absolutes: the claim a member is most likely to act on, and the one
  // no supplement has any basis for.
  [/\b(?:100%|100\s*percent|completely|absolutely|totally|entirely|perfectly)\s+(?:safe|harmless|risk[- ]free|side[- ]effect[- ]free|natural|pure|bioavailable)\b/gi,
    'generally well tolerated'],
  // The leading "with" is part of the claim, so it goes with it; leaving it would
  // produce "is generally well tolerated with side effects do happen".
  [/\bwith\s+(?:no|zero)\s+(?:known\s+|serious\s+|notable\s+)?side\s+effects?(?:\s+(?:whatsoever|at\s+all|observed|reported|noted|seen))?\b/gi,
    ', though side effects do happen'],
  // A trailing intensifier belongs to the verb, not to the replacement, or
  // "It has no side effects whatsoever" would come out as
  // "It may cause side effects whatsoever" — a repaired claim wearing a broken
  // sentence. Every one of these forms asserts that nothing is wrong with the
  // supplement; the app can only say it cannot rule something out.
  [/\b(?:has|have|had|causes?|causing|produce?s?|report(?:s|ed)?|carries?|show?s?|expect(?:s|ed)?|demonstrate?s?)\s+(?:no|zero)\s+(?:known\s+|serious\s+|notable\s+)?side\s+effects?(?:\s+(?:whatsoever|at\s+all|observed|reported|noted|seen))?\b/gi,
    'may cause side effects'],
  [/\bthere\s+(?:is|are|was|were|have\s+been|'s|'re|'ll)\s+(?:no|zero)\s+(?:known\s+|serious\s+|notable\s+)?side\s+effects?(?:\s+(?:whatsoever|at\s+all|observed|reported|noted|seen))?\b/gi,
    'side effects cannot be ruled out'],
  [/\b(?:with\s+)?no\s+(?:known\s+|serious\s+|notable\s+)?side\s+effects?(?:\s+(?:whatsoever|at\s+all|observed|reported|noted|seen))?\b/gi,
    ', though side effects do happen'],
  [/\bguaranteed\s+to\b/gi, 'likely to'],
  [/\bguaranteed\b/gi, 'promised'],
  [/\bguarantees?\b/gi, 'promises'],
  [/\bmiracle\b/gi, 'much-promoted'],
];

/**
 * A denied curative claim — the shape of this app's own disclaimer, "does not
 * diagnose, treat, or cure any disease".
 *
 * The curative-verb rules above are written to catch an assertion, and a
 * negation is the opposite of one; rewriting that disclaimer's "cure" produced
 * "does not diagnose, treat, or may help with any disease", i.e. the verifier
 * corrupting the single sentence whose job is to limit what the app claims.
 * Denied claims are therefore masked out before the rewrites and restored
 * afterwards, so the protection is scoped to this function and can never leak a
 * control character into text that gets stored.
 */
const NEGATED_CURATIVE = /\b(?:do(?:e)?s?\s+not|doesn'?t|will\s+not|cannot|can'?t|may\s+not|not)\s+[^.!?]{0,60}\b(?:cure|cures|treat|treats|heal|heals|reverse|reverses|prevent|prevents|fix|fixes|eliminate|eliminates|resolve|resolves|diagnos\w*)\b/gi;

function downgradeAbsoluteClaims(text) {
  const raw = String(text == null ? '' : text);
  const protectedPhrases = [];
  const value0 = raw.replace(NEGATED_CURATIVE, (whole) => {
    protectedPhrases.push(whole);
    return `\u0001${protectedPhrases.length - 1}\u0001`;
  });
  let value = value0;
  const repairs = [];
  for (const [re, to] of CLAIM_REWRITES) {
    re.lastIndex = 0;
    const hits = value.match(re);
    if (!hits) continue;
    value = value.replace(re, to);
    repairs.push({ kind: 'claim-downgraded', detail: `${hits.slice(0, 3).join(' | ')} → ${to}` });
  }
  if (protectedPhrases.length) {
    value = value.replace(/\u0001(\d+)\u0001/g, (m, i) => {
      const original = protectedPhrases[Number(i)];
      return original == null ? m : original;
    });
  }
  if (repairs.length) {
    // Two rules can fire on the same sentence ("clinically proven to eliminate
    // anxiety" → "reported to may help with anxiety"), which is grammatically
    // broken in a way the member would notice. The reporting frame is the part
    // that no longer adds anything once the verb is hedged, so it goes.
    value = value.replace(/\bis\s+(?:reported to|shown in some studies to)\s+(?=(?:may|might|can|could|helps?)\b)/gi, '');
    // A rewrite that swallows a sentence's first word ("There are no side
    // effects" → "side effects cannot be ruled out") would leave a lowercase
    // sentence start, which reads as a rendering bug rather than as a repair.
    // Only runs on text this pass already touched.
    value = mapSentences(value, (sentence) => sentence
      .replace(/^(\s*["'([]?)([a-z])/, (m, pre, ch) => pre + ch.toUpperCase())).value;
  }
  return { value, repairs };
}

// -- c. Statistics nobody supplied -------------------------------------------

/**
 * The honest sentence that replaces an unsourced population figure. With the
 * number deleted the sentence would be a fragment ("… of adults are
 * deficient"), and a fragment reads like a bug rather than like a limit, so the
 * app states its limit instead.
 */
const UNSOURCED_STAT_LINE = 'The evidence for that is modest and mixed, so this app will not quote a figure for it — ask a clinician about what applies to you.';

const EFFECT_NOUNS = '(reductions?|decreases?|drops?|falls?|declines?|lowerings?|improvements?|increases?|rises?|boosts?|gains?|losses?|lifts?)';
/**
 * `40% reduction`, `a 12 percent increase` — the figure in front of its outcome.
 * The leading article is part of the match: leaving it behind is how "a 30%
 * reduction" became "a a reduction" when only the number was removed.
 */
const EFFECT_PERCENT_BEFORE_NOUN = new RegExp(
  `\\b(?:a|an|the)?\\s*\\d+(?:[.,]\\d+)?\\s*(?:%|per\\s?cent|percent)\\s+(?:in\\s+)?${EFFECT_NOUNS}\\b`, 'gi');
/** `reduces LDL by 25%`, `by up to 60%`, `cut latency by 62 minutes` — the same figure behind its outcome. */
// No trailing `\b`: `%` is not a word character, so a boundary assertion after it
// fails against a following space and the whole rule silently matches nothing.
// The units are here because an effect size does not always arrive as a
// percentage: "melatonin cut sleep onset by 62 minutes" is the same invented
// magnitude with a clock on it, and only the number is unverifiable.
const EFFECT_UNITS = '(?:%|per\\s?cent|percent|minutes?|mins?|hours?|days?|weeks?|months?|points?|mm\\s?hg|mg\\s?/?\\s?dl|ng\\s?/?\\s?ml|IU|kcal|pounds?|lbs?|kilograms?|kg|units?|scores?)';
const BY_PERCENT = new RegExp(`\\s+by(?:\\s+(?:up\\s+to|approximately|about|roughly|nearly|over|under))?\\s+\\d+(?:[.,]\\d+)?\\s*${EFFECT_UNITS}(?![a-z0-9])`, 'gi');
/** `42% of adults` — the shape a model writes when it recalls a prevalence. */
const PREVALENCE = /\b\d+(?:[.,]\d+)?\s*(?:%|per\s?cent|percent)\s+of\s+(?:the\s+)?(?:adults?|patients?|participants?|subjects?|people|women|men|older\s+adults|general\s+population|population|Americans?|US\s+adults|UK\s+adults|Canadians?)\b/i;
/** `200 patients`, `in 45 women` — a sample size is a citation wearing a number. */
const SAMPLE_SIZE = /\b\d{2,}\s+(?:randomi[sz]ed\s+|double[- ]blind\s+|placebo[- ]controlled\s+)*(?:patients?|participants?|subjects?|women|men|older\s+adults)\b/i;
/** `across 14 studies`, `in 3 trials`. */
const STUDY_COUNT = /\b(?:across|in|among|including|from|spanning|over)\s+\d{1,4}\s+(?:published\s+|clinical\s+|randomi[sz]ed\s+)*(?:studies|trials|reviews|meta[- ]analyses?|articles|papers)\b/i;
/** `a 2021 randomized trial showed` — the recall shape that has no identifier to strip. */
const YEAR_CITATION = /\b(?:a|an|the|in|from|of)\s+(?:19|20)\d{2}\s+(?:randomi[sz]ed\s+|double[- ]blind\s+|placebo[- ]controlled\s+)*(?:trial|trials|study|studies|review|reviews|meta[- ]analyses?|publication|paper)s?\b/i;
const UNSOURCED_SHAPES = [PREVALENCE, SAMPLE_SIZE, STUDY_COUNT, YEAR_CITATION];

function stripUnsourcedStatistics(text, { allowedPmids } = {}) {
  const allowed = allowedPmids instanceof Set && allowedPmids.size ? allowedPmids : allowlistedPmids();
  const repairs = [];

  // Effect sizes lose the number and keep the direction: "reduces migraine
  // frequency by 40%" → "reduces migraine frequency" is still the same advice,
  // minus the figure nobody can check.
  const stripEffectNumbers = (sentence) => {
    let out = sentence.replace(EFFECT_PERCENT_BEFORE_NOUN, (whole, noun) => {
      repairs.push({ kind: 'statistic-removed', detail: String(whole).slice(0, 60) });
      const word = String(noun).toLowerCase();
      // "40% reduction" needs an article once the figure goes; "40% improvements"
      // must not gain one, or the repair would leave broken English behind.
      return /s$/.test(word) ? word : `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;
    });
    out = out.replace(BY_PERCENT, (whole) => {
      repairs.push({ kind: 'statistic-removed', detail: String(whole).trim().slice(0, 60) });
      return '';
    });
    return out;
  };

  // Deciding per sentence, before touching its numbers, is what keeps the record
  // honest: a figure inside a sentence that is going to be replaced outright was
  // never a separate repair, and logging it as one inflates the count the
  // benchmark reports.
  const pass = mapSentences(String(text == null ? '' : text), (sentence, report) => {
    const ids = extractPmids(sentence);
    // A sentence that carries an allowlisted PMID is quoting the registry the app
    // ships — the one place where a figure has a source behind it.
    const sourced = ids.length > 0 && ids.every((id) => allowed.has(String(id)));
    if (!sourced && UNSOURCED_SHAPES.some((re) => re.test(sentence))) {
      report('unsourced-statistic', sentence.slice(0, 140));
      return UNSOURCED_STAT_LINE;
    }
    return stripEffectNumbers(sentence);
  });
  return { value: pass.value, repairs: [...repairs, ...pass.repairs] };
}

// -- d. Doses stated in prose -------------------------------------------------

/**
 * Gram-scale bulks are excluded from the prose pass on purpose. Protein,
 * collagen, creatine, HMB and citrulline are eaten in food-scale amounts, and
 * "aim for 90 g of protein a day" is correct dietary advice — clamping it to a
 * supplement serving would be the verifier damaging information it does not
 * understand. The entries that stay in scope are the ones where a wrong number
 * is a toxicology problem: vitamins, minerals and actives.
 */
const PROSE_DOSE_MAX_MG = 10000;
const PROSE_QUANTITY = /\b(\d[\d,]*(?:\.\d+)?)\s*(mcg|µg|ug|mg|g|iu)\b/gi;
const proseUnit = (raw) => {
  const u = String(raw).toLowerCase();
  return u === 'µg' || u === 'ug' ? 'mcg' : u;
};

/** The nearest word-boundary position of any alias in the text, or -1. */
function aliasIndex(text, aliases) {
  const lower = String(text).toLowerCase();
  let best = -1;
  for (const alias of aliases) {
    const matcher = termMatcher(alias);
    matcher.lastIndex = 0;
    const hit = matcher.exec(lower);
    if (!hit) continue;
    const at = lower.indexOf(alias, hit.index);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

/**
 * The amount part of a standard dose, for dropping into a sentence.
 *
 * `entry.standard` is written as a plan instruction ("2000-4000 IU daily"), which
 * is right for a dosage field and wrong inside prose: replacing "take 10,000 IU
 * of vitamin D daily" with it produced "take 2000-4000 IU daily of vitamin D
 * daily". The numbers are the repair; the sentence keeps its own shape.
 */
const STANDARD_AMOUNT = /^(?:under\s+)?[\d.,]+\s*(?:[-–—]\s*[\d.,]+)?\s*(?:mg|mcg|µg|ug|g|iu)\b/i;

function standardAmount(entry) {
  const m = STANDARD_AMOUNT.exec(String(entry.standard || '').trim());
  return m ? m[0] : String(entry.standard || '').trim();
}

/**
 * A number that is being used as a THRESHOLD, not as a dose to take.
 *
 * "Long-term high doses (>40mg) may deplete copper" is a safety warning; clamping
 * its number to the 1-2mg copper range would silently rewrite a warning into
 * nonsense. Prose clamping therefore bows out when the figure is framed as a
 * limit. "up to" is deliberately NOT in this list: "up to 3000mg of vitamin C
 * daily" is a taken dose with a ceiling word in front of it, and that is the
 * shape a hallucination actually arrives in.
 */
const DOSE_THRESHOLD_FRAME = /(>|<|≥|≤|\babove\b|\bbelow\b|\bover\b|\bunder\b|more than|less than|exceed|limit|max(?:imum)?|at least)/i;

function clampDosesInProse(text) {
  return mapSentences(text, (sentence, report) => {
    // Collect every amount first, then decide. Editing while scanning would shift
    // the offsets the proximity test depends on, so replacements are applied from
    // the end of the sentence backwards.
    const quantities = [];
    PROSE_QUANTITY.lastIndex = 0;
    let m;
    while ((m = PROSE_QUANTITY.exec(sentence)) !== null) {
      quantities.push({ index: m.index, matched: m[0], value: m[1], unit: m[2] });
    }
    if (quantities.length === 0) return sentence;
    // One alias scan per sentence, reused for every amount in it.
    const aliases = [];
    for (const entry of DOSE_TABLE) {
      const ceilingMg = entry.ceiling.unit === 'IU' ? null : toMg(entry.ceiling);
      if (ceilingMg != null && ceilingMg >= PROSE_DOSE_MAX_MG) continue;
      const at = aliasIndex(sentence, entry.alias);
      if (at !== -1) aliases.push({ entry, at });
    }
    const edits = [];
    for (const q of quantities) {
      // Each amount belongs to the NUTRIENT IT IS CLOSEST TO, not to the first
      // table entry that happens to be nearby: "calcium (1300mg/day), protein and
      // iron" made the iron ceiling clamp a calcium figure, turning a correct
      // adolescent RDA into an adult iron dose.
      let nearest = null;
      for (const a of aliases) {
        const d = Math.abs(q.index - a.at);
        if (d > 70) continue;
        if (!nearest || d < nearest.distance) nearest = { entry: a.entry, distance: d };
      }
      if (!nearest) continue;
      const frame = sentence.slice(Math.max(0, q.index - 24), q.index);
      if (DOSE_THRESHOLD_FRAME.test(frame)) continue;
      const parsed = { value: Number(String(q.value).replace(/,/g, '')), unit: proseUnit(q.unit) };
      if (!Number.isFinite(parsed.value) || parsed.value <= 0) continue;
      if (!doseExceeds(nearest.entry, parsed)) continue;
      const amount = standardAmount(nearest.entry);
      edits.push({ ...q, amount, entry: nearest.entry });
    }
    if (edits.length === 0) return sentence;
    let out = sentence;
    for (const e of edits.sort((a, b) => b.index - a.index)) {
      report('dose-clamped', `${e.matched} for ${e.entry.alias[0]} → ${e.amount}`);
      out = `${out.slice(0, e.index)}${e.amount}${out.slice(e.index + e.matched.length)}`;
    }
    return out;
  });
}

// -- e. The prose pass --------------------------------------------------------

/**
 * What a member-facing paragraph may not assume about the member.
 *
 * A plan row's patient facts come from the validated assessment, which the route
 * already holds. A chat reply has two sources of fact: what the member selected
 * in the questionnaire AND what they typed here, in this conversation. Both
 * license a claim; neither alone is enough. A member who selected "Heavy Periods"
 * and never typed the word is legitimately told "you reported heavy periods" —
 * deleting that sentence would be the verifier destroying the true thing it
 * exists to protect. Conversely a member who has never taken the assessment can
 * still be corrected when the assistant invents a condition they did not name.
 */
function buildConversationContext(profile, memberText) {
  const ctx = buildFactContext(profile || {});
  const extra = String(memberText == null ? '' : memberText).toLowerCase();
  if (!extra.trim()) return ctx;
  for (const word of extra.split(/[^a-z0-9'+-]+/)) {
    if (word.length >= 4) ctx.reportedWords.add(word);
  }
  ctx.freeText = `${ctx.freeText} ${extra}`;
  // Typing anything at all is a report. Without this the whole check stays off
  // for a member who has never done an assessment, which is exactly who an
  // invented "since you mentioned your diabetes" is most likely to mislead.
  if (!ctx.hasAnyReport) ctx.hasAnyReport = true;
  return ctx;
}

/** Said when a reply was entirely built on facts the member never reported. */
const PROSE_FACT_FALLBACK = 'I can only speak to what you have told me, so I will not assume anything else about your health.';

/**
 * Prose fields that belong to another verifier, or to the app itself.
 *
 * `evidence` is checked against the citation registry by `verifyCitation`, and
 * `dosage` against the row's nutrient by `checkDose` — running the paragraph
 * rules over them would double-edit a value that already has an owner. `name`,
 * `timing`, `foods` and the schedule `items` are labels, not claims.
 * `disclaimer` is the app's own legal sentence: it is the one string here the
 * verifier must never rewrite, because a member reading a rewritten disclaimer
 * has no way to know it was ever anything else.
 */
const PLAN_PROSE_SKIP_KEYS = new Set([
  'name', 'id', '_id', '__v', 'evidence', 'dosage', 'timing', 'foods', 'items',
  'disclaimer', 'priority', 'confidenceScore', 'severityLevel', 'consultDoctor',
  'grounding', 'adaptation', 'createdAt', 'updatedAt', 'user', 'assessmentId',
  'symptoms', 'medicalConditions', 'healthGoals', 'lifestyleHabits', 'image', 'images',
]);

/**
 * Verify one paragraph. The order is the argument:
 *
 *   1. identifiers  — a PMID/DOI/URL is the claim's anchor, and removing it
 *                     changes what the sentence asserts, so everything after
 *                     this step reads the text the app actually stands behind;
 *   2. treatment advice — the only shape where the whole sentence is replaced,
 *                     and the only one that can physically harm someone;
 *   3. curative / absolute claims — verb-level rewrites, applied before the
 *                     numeric passes so a hedged sentence is not re-counted;
 *   4. statistics, 5. doses — number-level repairs inside sentences the earlier
 *                     steps kept;
 *   6. patient facts last, so the check against what the member reported runs on
 *                     the text that is actually going to be shown.
 *
 * Idempotent: every replacement is a string the same pass does not match again,
 * and `tidyProse` runs last to absorb the orphan spacing/punctuation a rewrite
 * can leave behind (a clause deleted before its comma yields " ,", which would
 * otherwise be re-cut on the second trip). That is what lets the guide verifier
 * run before a store AND on the way out of a cache read without the text
 * degrading on the second trip.
 */
function tidyProse(text) {
  // Spaces and tabs only. A newline is content here — bullet lists and
  // paragraph breaks travel inside these strings — so `\s+` would flatten them.
  return text
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}

function verifyProse(text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) return { value: text, repairs: [] };
  const repairs = [];
  let value = text;

  const ids = stripUnverifiableIdentifiers(value, options);
  for (const detail of ids.removed) repairs.push({ kind: 'identifier', detail });
  value = ids.value;

  for (const step of [
    () => enforceMedicationSafety(value),
    () => downgradeAbsoluteClaims(value),
    () => stripUnsourcedStatistics(value, options),
    () => clampDosesInProse(value),
    () => (options.ctx
      ? groundProse(value, options.ctx, { fallback: options.fallback == null ? PROSE_FACT_FALLBACK : options.fallback })
      : { value, stripped: 0 }),
  ]) {
    const result = step();
    if (typeof result.stripped === 'number') {
      if (result.stripped > 0) repairs.push({ kind: 'patient-fact', detail: `${result.stripped} clause(s) asserted an unreported patient fact` });
    } else {
      repairs.push(...result.repairs);
    }
    value = result.value;
  }

  return { value: tidyProse(value), repairs };
}

/** The same pass applied to every prose string in a parsed document. */
function verifyDocumentDeep(value, options = {}) {
  const repairs = [];
  const walked = walkStrings(value, (text, key) => {
    const result = verifyProse(text, options);
    for (const repair of result.repairs) repairs.push({ ...repair, field: key || 'text' });
    return result.value;
  }, { ...options, skipKeys: options.skipKeys || PLAN_PROSE_SKIP_KEYS });
  return { value: walked, repairs };
}

/**
 * Remove the list items the fact check emptied, and keep the two fields that are
 * read as sentences when they are the only thing on the page.
 *
 * The prose pass runs with `fallback: ''` on purpose: a warnings list where five
 * entries have been replaced by the same boilerplate is more damaged than one
 * with an entry missing, so an item whose entire content was a fabricated
 * attribution disappears instead of being padded. `summary` and
 * `simplifiedSummary` are the exception — an empty summary reads as a broken
 * result page, so those two get a sentence that claims nothing about the member.
 */
const PLAN_SUMMARY_FALLBACK = 'This plan is written from the answers you gave in your assessment.';
const PLAN_LIST_SECTIONS = ['warnings', 'avoidList', 'lifestyleAdvice', 'actionPlan', 'mealRecommendations', 'dailySchedule'];

function compactSections(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const out = plan;
  for (const field of PLAN_LIST_SECTIONS) {
    const list = out[field];
    if (!Array.isArray(list)) continue;
    out[field] = list
      .map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          // A meal/schedule card whose only prose is the meal itself.
          return Object.values(item).some((v) => typeof v === 'string' && v.trim()) ? item : null;
        }
        return typeof item === 'string' && !item.trim() ? null : item;
      })
      .filter((item) => item !== null);
  }
  for (const field of ['summary', 'simplifiedSummary']) {
    if (out[field] !== undefined && String(out[field] || '').trim() === '') out[field] = PLAN_SUMMARY_FALLBACK;
  }
  return out;
}

/** One line for the log: what the verifier did, in the order it did it. */
function describeProseRepairs(repairs) {
  if (!Array.isArray(repairs) || repairs.length === 0) return '';
  const kinds = {};
  for (const r of repairs) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  return `${repairs.length} repair(s): ${Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join(', ')}`;
}

module.exports = {
  NEUTRAL_TRIGGER,
  GOAL_OPTIONS,
  DOSE_TABLE,
  MED_SAFETY_LINE,
  UNSOURCED_STAT_LINE,
  PLAN_PROSE_SKIP_KEYS,
  CLAIM_REWRITES,
  buildFactContext,
  buildConversationContext,
  unreportedClaims,
  fabricatedPersonalClaims,
  groundTriggeredBy,
  groundProse,
  verifyCitation,
  checkDose,
  doseExceeds,
  parseFirstDose,
  doseEntry,
  rejectReason,
  normaliseTrustFields,
  groundPlan,
  groundingViolations,
  stripUnverifiableIdentifiers,
  stripIdentifiersDeep,
  walkStrings,
  enforceMedicationSafety,
  downgradeAbsoluteClaims,
  stripUnsourcedStatistics,
  clampDosesInProse,
  verifyProse,
  verifyDocumentDeep,
  describeProseRepairs,
  tidyProse,
};
