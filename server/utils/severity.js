/**
 * Severe-case detection for health assessments.
 * Rule-based (no AI call): flags assessments that need admin attention and
 * a user notification. Runs on assessment create + when AI results are saved.
 *
 * FIXED: previous version flagged empty/minimal inputs as severe due to
 *  - generic AI warning word "severe" matching every disclaimer
 *  - underlying condition alone (e.g. depression/anxiety) triggering flag
 *  - "None" placeholder values not being ignored
 */

const SEVERE_SYMPTOMS = [
  'chest pain', 'difficulty breathing', 'shortness of breath', 'fainting',
  'severe headache', 'chest tightness', 'heart palpitations', 'numbness',
  'severe abdominal pain', 'blood in', 'bleeding', 'suicidal', 'self-harm',
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
 * @param {object} input assessment fields (symptoms, symptomSeverity,
 *   medicalConditions, feelingDescription, currentMedications, allergies)
 * @param {object} [aiResults] optional AI results (scans warnings text)
 * @returns {{ flagged: boolean, reasons: string[] }}
 */
function analyzeSeverity(input = {}, aiResults = null) {
  const reasons = [];

  const symptoms = normalizeList(input.symptoms);
  const severity = input.symptomSeverity && typeof input.symptomSeverity === 'object' ? input.symptomSeverity : {};
  const conditions = normalizeList(input.medicalConditions);

  // Build freeText from free-text fields, ignoring placeholder "None" values and very short text
  const rawFreeText = [
    input.feelingDescription, input.currentMedications, input.allergies,
    input.recentBloodTest, input.bloodTestResults,
  ].filter(v => typeof v === 'string')
   .map(v => v.trim())
   .filter(v => v && !IGNORE_VALUES.has(v.toLowerCase()) && v.length > 3)
   .join('\n')
   .toLowerCase();
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
    return { flagged: false, reasons: [] };
  }
  if (unique.length > 0 && secondaryReasons.length > 0) {
    // Has strong signal plus secondary condition — include secondary for context
    unique = [...new Set([...unique, ...secondaryReasons])].slice(0, MAX_REASONS);
  }

  // Empty/minimal input should never flag — require at least one strong reason
  // If unique is empty, already not flagged
  return { flagged: unique.length > 0, reasons: unique };
}

module.exports = { analyzeSeverity };
