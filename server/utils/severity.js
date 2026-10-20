/**
 * Severe-case detection for health assessments.
 * Rule-based (no AI call): flags assessments that need admin attention and
 * a user notification. Runs on assessment create + when AI results are saved.
 *
 * FIXED: previous version flagged empty/minimal inputs as severe due to
 *  - generic AI warning word "severe" matching every disclaimer
 *  - underlying condition alone (e.g. depression/anxiety) triggering flag
 *  - "None" placeholder values not being ignored
 *
 * MULTILINGUAL: every needle below is English, because each one names a symptom this
 * app's own questionnaire already publishes in English. A member describing a symptom in
 * Filipino typed it into a free-text box, and "hindi ako makapag-hinga" contains none of
 * the needles above — so the life-threatening case did NOT flag. utils/languageAnchors.js
 * appends the English wording for what the member said, which is why `anchored()` wraps
 * the free text and the symptom names here. Safety is the one surface where the anchor
 * list must err wide: an over-flag costs an admin a look, a missed flag costs a member
 * their emergency response.
 */

const { anchorText } = require('./languageAnchors');

const SEVERE_SYMPTOMS = [
  'chest pain', 'difficulty breathing', 'shortness of breath', 'fainting',
  'severe headache', 'chest tightness', 'heart palpitations', 'numbness',
  'severe abdominal pain', 'blood in', 'bleeding', 'suicidal', 'self-harm',
];

// CRITICAL symptoms that require immediate medical attention and block assessments
const CRITICAL_SYMPTOMS = [
  'severe chest pain',
  'severe shortness of breath',
  'coughing up blood',
  'suicidal thoughts',
  'unable to breathe',
  'severe bleeding',
  'loss of consciousness',
];

// The crisis wording, in one place, because two surfaces have to agree on it:
// this module's critical tier and the consult-doctor trigger in routes/recommend.js.
// It used to be a regex that only lived in recommend.js
// ('suicid|self.harm|hopeless|want to die'), and "I want to harm myself" or
// "I want to end my life" matched none of those needles — so an English member
// writing the plainest possible cry for help got a wellness plan and no flag.
// Deliberately wide: an over-flag costs a clinician one look, a missed flag costs
// a member the emergency response. Every entry is lowercase because matching
// happens on lowercased, anchor-expanded text (utils/languageAnchors.js maps the
// Filipino and Bisaya crisis phrasing onto 'suicidal thoughts self-harm want to
// die', which is why the member does not have to write English to be flagged).
const CRISIS_PHRASES = [
  'suicid',
  'self-harm', 'self harm', 'harm myself', 'hurt myself on purpose',
  'kill myself', 'killing myself', 'take my own life',
  'end my life', 'end it all',
  'want to die', 'wanna die',
  'better off dead', 'no reason to live', 'wish i was dead', 'wish i were dead',
  'hopeless',
];

// Emergency phrases that indicate critical situations.
// 'want to die' and 'hopeless' live in CRISIS_PHRASES above, not here — they are the
// same list, and a needle in two places is a needle that drifts out of sync.
const EMERGENCY_PHRASES = [
  "can't breathe",
  'chest crushing',
  'bleeding heavily',
  'severe pain',
  'passing out',
  'feeling faint',
  'extreme pain',
  ...CRISIS_PHRASES,
  // FAST signs — a stroke is the one flag where the response time IS the treatment.
  'slurred speech', 'facial drooping', 'face drooping', 'drooping face',
];

const CRITICAL_CONDITIONS = [
  'heart / cardiovascular disease', 'heart disease', 'diabetes',
  'hypertension (high blood pressure)', 'high blood pressure',
];

// Conditions that are common and should NOT auto-flag alone (only with another severe signal)
const SECONDARY_CONDITIONS = [
  'asthma', 'autoimmune disorders', 'depression', 'anxiety disorder',
];

const RED_FLAG_PHRASES = [
  'chest pain', 'difficulty breathing', "can't breathe", 'faint',
  'suicid', 'self-harm', 'severe pain', 'emergency', 'blood in stool',
  'blood in urine', 'coughing blood',
  // Both of these are already red-flag SYMPTOM NAMES in SEVERE_SYMPTOMS above, so a
  // member who picks "Numbness" from the questionnaire is flagged while a member who
  // types "my whole left arm went numb" is not. Free text is where the second member
  // lives, and where every Filipino description lands (utils/languageAnchors.js
  // anchors "namamanhid ang kamay ko" onto this exact wording).
  'numbness', 'heart palpitations',
  // Same reason: the words exist in the English corpus of complaints, they simply were
  // never listed. 'sudden weakness' is what utils/languageAnchors.js anchors the
  // stroke-sign phrases onto.
  'sudden weakness', 'sudden numbness', 'paralysis', 'paralysed', 'one side of my body',
  // The two FAST words on their own, because English writes them in either
  // order — 'my speech went slurred' carries the needle 'slurred speech' nowhere.
  'slurred', 'drooping',
];

// AI warnings are generic disclaimers — only flag on explicit emergency language, not the word "severe" alone
const AI_EMERGENCY_PHRASES = [
  'emergency room', 'emergency department', 'call emergency', 'call 911',
  'immediate medical attention', 'seek immediate', 'life-threatening',
  'go to hospital', 'seek emergency care', 'urgent medical',
];

const IGNORE_VALUES = new Set(['none', 'no current symptoms', 'no symptoms', 'no medical conditions', 'no conditions', 'n/a', 'na', 'no', '']);

const MAX_REASONS = 5;

function normalizeList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(v => String(v).trim().toLowerCase())
    .filter(v => v && !IGNORE_VALUES.has(v));
}

function containsAny(haystack, needles) {
  const found = [];
  for (const needle of needles) {
    if (haystack.includes(needle)) found.push(needle);
  }
  return found;
}

/**
 * The member's own free-text answers, joined the way this module has always joined
 * them, plus the English wording for anything written in another language. Placeholder
 * values and sub-three-character answers are dropped BEFORE anchoring, which is the
 * order that keeps the "empty input never flags" fix intact: an anchored "None" would
 * otherwise become a symptom description.
 */
function anchoredFreeText(input = {}) {
  const raw = [
    input.feelingDescription, input.currentMedications, input.allergies,
    input.recentBloodTest, input.bloodTestResults,
  ].filter(v => typeof v === 'string')
   .map(v => v.trim())
   .filter(v => v && !IGNORE_VALUES.has(v.toLowerCase()) && v.length > 3)
   .join('\n')
   .toLowerCase();
  return anchorText(raw, ['safety', 'health']);
}

/**
 * Determine severity tier based on symptoms and conditions
 * @returns {'critical' | 'high' | 'medium' | null}
 */
function getSeverityTier(input = {}, aiResults = null) {
  const symptoms = normalizeList(input.symptoms);
  const severity = input.symptomSeverity && typeof input.symptomSeverity === 'object' ? input.symptomSeverity : {};
  const conditions = normalizeList(input.medicalConditions);

  // Build freeText from free-text fields
  const rawFreeText = anchoredFreeText(input);

  const symptomNames = symptoms.join('\n').toLowerCase();

  // CRITICAL tier: life-threatening symptoms
  const criticalSymptomMatches = containsAny(symptomNames, CRITICAL_SYMPTOMS);
  const emergencyPhraseMatches = containsAny(rawFreeText, EMERGENCY_PHRASES);
  
  if (criticalSymptomMatches.length > 0 || emergencyPhraseMatches.length > 0) {
    return 'critical';
  }

  // Check AI results for emergency language
  if (aiResults && typeof aiResults === 'object') {
    const warnings = Array.isArray(aiResults.warnings) ? aiResults.warnings.join('\n').toLowerCase() : '';
    const avoid = Array.isArray(aiResults.avoidList) ? aiResults.avoidList.join('\n').toLowerCase() : '';
    const combined = `${warnings}\n${avoid}`;
    if (combined.trim() && containsAny(combined, AI_EMERGENCY_PHRASES).length > 0) {
      return 'critical';
    }
  }

  // HIGH tier: multiple severe symptoms OR critical condition + severe symptom
  const severityLower = {};
  for (const [k, v] of Object.entries(severity)) {
    severityLower[String(k).toLowerCase()] = v;
  }
  const severeRatedCount = symptoms.filter(s => {
    const base = String(s).split('::').pop().toLowerCase();
    const level = String(severityLower[s] || severityLower[base] || severity[s] || '').toLowerCase();
    return level === 'severe';
  }).length;

  const hasCriticalCondition = conditions.some(c => CRITICAL_CONDITIONS.includes(c));

  if (severeRatedCount >= 2 || (hasCriticalCondition && severeRatedCount >= 1)) {
    return 'high';
  }

  // MEDIUM tier: 1 severe symptom OR red-flag phrase
  if (severeRatedCount === 1 || containsAny(rawFreeText, RED_FLAG_PHRASES).length > 0) {
    return 'medium';
  }

  return null;
}

/**
 * @param {object} input assessment fields (symptoms, symptomSeverity,
 *   medicalConditions, feelingDescription, currentMedications, allergies)
 * @param {object} [aiResults] optional AI results (scans warnings text)
 * @returns {{ flagged: boolean, reasons: string[], tier: string | null }}
 */
function analyzeSeverity(input = {}, aiResults = null) {
  const reasons = [];

  const symptoms = normalizeList(input.symptoms);
  const severity = input.symptomSeverity && typeof input.symptomSeverity === 'object' ? input.symptomSeverity : {};
  const conditions = normalizeList(input.medicalConditions);

  // Build freeText from free-text fields, ignoring placeholder "None" values and very short text
  const rawFreeText = anchoredFreeText(input);
  const freeText = rawFreeText;

  // 1. Explicitly severe symptom ratings — only for non-ignored symptoms (case-insensitive key lookup)
  const severityLower = {};
  for (const [k, v] of Object.entries(severity)) {
    severityLower[String(k).toLowerCase()] = v;
  }
  const severeRated = symptoms.filter(s => {
    const base = String(s).split('::').pop().toLowerCase();
    const level = String(severityLower[s] || severityLower[base] || severity[s] || '').toLowerCase();
    return level === 'severe';
  });
  for (const s of severeRated.slice(0, MAX_REASONS)) {
    reasons.push(`Symptom rated severe: ${String(s).split('::').pop()}`);
  }

  // 2. Red-flag symptoms by name
  const symptomNames = symptoms.join('\n');
  for (const hit of containsAny(symptomNames, SEVERE_SYMPTOMS).slice(0, MAX_REASONS)) {
    reasons.push(`Red-flag symptom reported: ${hit}`);
  }

  // 3. Critical underlying conditions — only flag alone if critical heart/diabetes/hypertension
  // Secondary conditions (depression/anxiety/asthma) only flag when accompanied by another severe signal
  const criticalHits = conditions.filter(c => CRITICAL_CONDITIONS.includes(c));
  const secondaryHits = conditions.filter(c => SECONDARY_CONDITIONS.includes(c));

  for (const c of criticalHits) {
    reasons.push(`Underlying condition: ${c}`);
  }
  // Secondary conditions are recorded but will be filtered out if they are the ONLY signal (see final gate below)
  const secondaryReasons = secondaryHits.map(c => `Underlying condition: ${c}`);

  // 4. Red-flag phrases in free text — requires meaningful free text (>3 chars already filtered)
  if (freeText) {
    for (const hit of containsAny(freeText, RED_FLAG_PHRASES).slice(0, MAX_REASONS)) {
      reasons.push(`Concerning description: "${hit}"`);
    }
  }

  // 5. AI warnings — only explicit emergency language, not generic "severe" disclaimer
  if (aiResults && typeof aiResults === 'object') {
    const warnings = Array.isArray(aiResults.warnings) ? aiResults.warnings.join('\n').toLowerCase() : '';
    const avoid = Array.isArray(aiResults.avoidList) ? aiResults.avoidList.join('\n').toLowerCase() : '';
    const combined = `${warnings}\n${avoid}`;
    if (combined.trim()) {
      for (const hit of containsAny(combined, AI_EMERGENCY_PHRASES).slice(0, 2)) {
        reasons.push(`AI warning mentions: "${hit}"`);
      }
    }
  }

  let unique = [...new Set(reasons)].slice(0, MAX_REASONS);

  // Final gate: if the ONLY reason is a secondary condition (depression/anxiety/asthma) with no other severe signal, don't flag.
  // This prevents "I didn't put anything severe but have depression" from being flagged as Priority.
  if (unique.length === 0 && secondaryReasons.length > 0) {
    // No strong signal — secondary condition alone is not enough
    return { flagged: false, reasons: [], tier: null };
  }
  if (unique.length > 0 && secondaryReasons.length > 0) {
    // Has strong signal plus secondary condition — include secondary for context
    unique = [...new Set([...unique, ...secondaryReasons])].slice(0, MAX_REASONS);
  }

  // Get severity tier
  const tier = getSeverityTier(input, aiResults);

  // Empty/minimal input should never flag — require at least one strong reason
  // If unique is empty, already not flagged
  return { flagged: unique.length > 0, reasons: unique, tier };
}

module.exports = { analyzeSeverity, getSeverityTier, CRITICAL_SYMPTOMS, EMERGENCY_PHRASES, CRISIS_PHRASES };
