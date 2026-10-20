/**
 * Answer canonicalisation.
 *
 * Two submissions that mean the same thing must be treated as the same answers.
 * The form always sends the option strings verbatim, but an assessment can also
 * arrive from a migrated history row, a retry, or a client that trimmed nothing:
 * "  MIGRAINE ", "fatigue" and "Migraine" are one answer to the clinician and
 * three different strings to a lookup table. Left alone, the clinical rule
 * engine reads them as different profiles — which shows up as a different plan
 * for the same questionnaire, the exact complaint this module exists to stop.
 *
 * The vocabulary is the app's own: the validated instrument's option lists, plus
 * the published condition symptoms. A value that is NOT in the vocabulary is
 * kept as written (only tidied), because inventing a recognised option the
 * member never chose would be a false statement about them in their own record.
 */

const {
  CONDITION_SYMPTOMS,
  GENERAL_SYMPTOMS,
  ITEMS,
  MEDICAL_CONDITIONS,
  SEVERITY_OPTIONS,
} = require('./healthAssessmentInstrument');

/** Lower-case, single-spaced, trimmed — the comparison form of an answer. */
function fold(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whitespace only: never changes what a member said, only how it is stored. */
function tidy(value) {
  return String(value).replace(/[ \t]+/g, ' ').trim();
}

function mapOf(values) {
  const map = new Map();
  for (const value of values) {
    const key = fold(value);
    if (key && !map.has(key)) map.set(key, value);
  }
  return map;
}

// The instrument's own options, per field.
const VOCABULARY = new Map();
for (const item of ITEMS) {
  if (Array.isArray(item.options) && item.options.length > 0) VOCABULARY.set(item.id, mapOf(item.options));
}
// Symptoms are also collected per condition, so a condition-specific complaint
// that the member picked from the form is still a known word.
VOCABULARY.set('symptoms', new Map([
  ...(VOCABULARY.get('symptoms') || mapOf([])),
  ...mapOf([...GENERAL_SYMPTOMS, ...CONDITION_SYMPTOMS, ...MEDICAL_CONDITIONS]),
]));
VOCABULARY.set('medicalConditions', mapOf([...(VOCABULARY.get('medicalConditions')?.values() || []), ...MEDICAL_CONDITIONS]));
VOCABULARY.set('symptomSeverity', mapOf(SEVERITY_OPTIONS));

// Multi-select fields arrive as arrays; the rest as single strings.
const LIST_FIELDS = new Set(ITEMS.filter((item) => item.type === 'multi').map((item) => item.id));

function canonical(field, value) {
  if (typeof value !== 'string') return value;
  const vocabulary = VOCABULARY.get(field);
  const match = vocabulary && vocabulary.get(fold(value));
  return match !== undefined && match !== null ? match : tidy(value);
}

/**
 * Return a copy of an assessment payload whose answer fields are written the way
 * the app's own option lists write them. Everything the app does not recognise
 * as an answer field (identifiers, notes, free text) is passed through.
 */
function canonicaliseAnswers(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out = {};
  for (const [field, value] of Object.entries(payload)) {
    if (field === 'symptomSeverity' && value && typeof value === 'object' && !Array.isArray(value)) {
      const severities = {};
      for (const [symptom, severity] of Object.entries(value)) {
        const key = VOCABULARY.get('symptoms').get(fold(symptom)) || tidy(symptom);
        const level = canonical('symptomSeverity', severity);
        if (typeof level === 'string' && level) severities[key] = level;
      }
      out[field] = severities;
      continue;
    }
    if (LIST_FIELDS.has(field)) {
      const raw = Array.isArray(value)
        ? value
        : String(value === null || value === undefined ? '' : value).split(',');
      out[field] = raw
        .map((entry) => (typeof entry === 'string' ? canonical(field, entry) : entry))
        .filter((entry) => typeof entry !== 'string' || entry.length > 0);
      continue;
    }
    if (VOCABULARY.has(field)) {
      out[field] = canonical(field, value);
      continue;
    }
    out[field] = typeof value === 'string' ? tidy(value) : value;
  }
  return out;
}

module.exports = { canonicaliseAnswers, fold };
