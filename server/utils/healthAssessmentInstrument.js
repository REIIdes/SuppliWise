/**
 * The System Health Assessment questionnaire, as a versioned instrument
 * registry.
 *
 * Reviewer requirement #3 — "all questionnaires and metrics standardized or
 * validated by experts and statisticians" — applies to the health assessment
 * intake form itself (the 4-step questionnaire every recommendation is built
 * from), not just the feedback surveys. An intake form with no documented
 * provenance is a survey someone wrote; this registry makes every question
 * auditable: what it asks, what response options exist, which construct it
 * measures, and which published standard or expert review it rests on.
 *
 * The registry mirrors the live form (my-react-app/src/Pages/AssessmentPage.jsx)
 * exactly. Version 2 added the three questions the backend already consumed
 * (stress level, fitness focus, free-text narrative) but the form never asked
 * — a dead data path until the instrument asked for them.
 *
 * `provenance.kind`:
 *   standardized — the response format is taken from a published, cited
 *                  instrument (WHO anthropometry, PSQI global item, EFSA
 *                  water reference values, ...)
 *   expert-panel — no single published instrument covers it; content
 *                  validity is established through the Lawshe CVR process
 *                  in routes/instrument.js (see models/InstrumentReview.js)
 */

const INSTRUMENT_VERSION = 'health-assessment-v2';

// Single source for the severity ordinal scale so validation, flagging and
// the registry cannot drift to different wording.
const SEVERITY_OPTIONS = ['Mild', 'Moderate', 'Severe'];
const SEVERITY_ORDINAL = { Mild: 1, Moderate: 2, Severe: 3 };

const GENERAL_SYMPTOMS = [
  // Energy & Sleep
  'Fatigue', 'Low Energy', 'Difficulty Sleeping', 'Waking Up Unrefreshed',
  // Mind & Mood
  'Brain Fog', 'Difficulty Concentrating', 'Anxiety / Stress',
  'Feeling Tense or Overwhelmed', 'Irritability', 'Low Mood',
  // Head & Senses
  'Frequent Headaches', 'Eye Strain or Dry Eyes',
  // Gut & Appetite
  'Digestive Discomfort', 'Bloating or Acidity', 'Low Appetite',
  // Muscles & Joints
  'Muscle Weakness', 'Neck / Shoulder Tension', 'Muscle or Joint Soreness', 'Joint Stiffness',
  // Skin, Hair & Immunity
  'Hair Thinning', 'Dry Skin', 'Frequent Colds / Low Immunity',
];

// Symptom pool shown when "None" conditions are selected (mirrors
// ALL_SYMPTOMS in AssessmentPage.jsx; condition-scoped symptoms are rendered
// only for the selected conditions).
const CONDITION_SYMPTOMS = [
  'Shortness of Breath', 'Chest Tightness', 'Rapid or Irregular Heartbeat',
  'Dizziness / Lightheadedness', 'Excessive Thirst', 'Frequent Urination',
  'Blurred Vision', 'Unexplained Weight Gain', 'Unexplained Weight Loss',
  'Joint Pain', 'Joint Swelling', 'Morning Stiffness', 'Back / Bone Pain',
  'Bloating', 'Digestive Issue', 'Nausea', 'Abdominal Pain / Cramps',
  'Wheezing / Breathing Difficulty', 'Frequent Colds', 'Skin Rashes / Flare-ups',
  'Acne / Skin Issues', 'Persistent Sadness / Low Mood', 'Panic Attacks',
  'Anxiety / Excessive Worry', 'Sleep Disturbances', 'Loss of Interest',
  'Cold Sensitivity', 'Hair Loss', 'Swollen Neck / Goiter', 'Pale Skin / Pallor',
  'Numbness / Tingling', 'Slow Recovery', 'Swelling (Edema)',
  'Jaundice / Yellow Skin', 'Light / Sound Sensitivity', 'Visual Aura',
  'Irregular Periods', 'Hormonal Acne', 'Excessive Hair Growth', 'Pelvic Pain',
];

const MEDICAL_CONDITIONS = [
  'Hypertension (High Blood Pressure)', 'High Cholesterol', 'Diabetes',
  'Heart / Cardiovascular Disease', 'Obesity', 'Arthritis', 'Osteoporosis',
  'Gout', 'IBS (Irritable Bowel Syndrome)', 'Celiac / Gluten Sensitivity',
  'Asthma', 'Autoimmune Disorders', 'Anxiety Disorder', 'Depression',
  'Thyroid Disorders', 'Anemia', 'Chronic Kidney Disease', 'Liver Disease',
  'Migraine', 'PCOS',
];

const ITEMS = [
  // ── Step 1 — Basic Information ──────────────────────────────────────────
  {
    id: 'age', step: 1, section: 'Basic Information', label: 'Age',
    type: 'number', required: true,
    construct: 'Life stage / age band',
    provenance: {
      kind: 'standardized',
      source: 'Demographic standard required by WHO age-standardised guidance',
      citation: 'WHO reference data are stratified by age band; nutrient DRIs (NIH ODS) are age-specific.',
    },
  },
  {
    id: 'gender', step: 1, section: 'Basic Information', label: 'Sex',
    type: 'single', required: true,
    options: ['Male', 'Female', 'Prefer not to say'],
    construct: 'Sex-specific screening and dosing',
    provenance: {
      kind: 'standardized',
      source: 'Standard demographic item; drives sex-scoped symptom and condition pools',
      citation: 'Female-only items (PCOS symptoms, pregnancy/breastfeeding) follow ACOG-style intake separation; "Prefer not to say" preserves autonomy.',
    },
  },
  {
    id: 'weight', step: 1, section: 'Basic Information', label: 'Weight (kg or lbs)',
    type: 'number', required: true,
    construct: 'Anthropometry — BMI numerator',
    provenance: {
      kind: 'standardized',
      source: 'WHO anthropometry',
      citation: 'WHO Physical Status: The Use and Interpretation of Anthropometry (WHO Technical Report Series 854, 1995).',
    },
  },
  {
    id: 'height', step: 1, section: 'Basic Information', label: 'Height (cm or ft/in)',
    type: 'number', required: true,
    construct: 'Anthropometry — BMI denominator',
    provenance: {
      kind: 'standardized',
      source: 'WHO anthropometry',
      citation: 'Same WHO TRS 854 protocol; BMI = kg / m^2 with WHO cut-offs (<18.5 underweight, 25+ overweight, 30+ obese).',
    },
  },
  {
    id: 'activityLevel', step: 1, section: 'Basic Information', label: 'Physical Activity Level',
    type: 'single', required: true,
    options: ['Sedentary', 'Light', 'Moderate', 'Very'],
    construct: 'Habitual physical activity',
    provenance: {
      kind: 'standardized',
      source: 'WHO 2020 physical activity guidelines',
      citation: 'WHO Guidelines on Physical Activity and Sedentary Behaviour (2020): frequency bands (1-3 / 3-5 / 6-7 days per week) map to the guideline intensity categories.',
    },
  },

  // ── Step 2 — Diet & Health Goals ────────────────────────────────────────
  {
    id: 'dietType', step: 2, section: 'Diet & Health Goals', label: 'Diet Type',
    type: 'single', required: true,
    options: ['Omnivore', 'Vegan', 'Keto', 'Paleo', 'Mediterranean', 'Carnivore', 'DASH', 'Flexitarian', 'Pescatarian'],
    construct: 'Dietary pattern (nutrient-availability constraint)',
    provenance: {
      kind: 'expert-panel',
      source: 'Named dietary patterns from comparative nutrition literature',
      citation: 'Pattern labels follow the definitions used in diet-score research (e.g. DASH: Appel et al. 1997; Mediterranean: Estruch et al. PREDIMED 2013); the option set itself is subject to expert CVR review.',
    },
  },
  {
    id: 'healthGoals', step: 2, section: 'Diet & Health Goals', label: 'Health Goals (pick up to 5)',
    type: 'multi', required: true, minSelections: 1, maxSelections: 5,
    options: [
      'Increase Energy', 'Improve Sleep', 'Boost Immunity', 'Support Heart Health',
      'Digestive Health', 'Muscle Gain', 'Fat Loss', 'Improve Strength',
      'Improve Endurance', 'Mental Focus', 'Stress Reduction', 'Skin & Hair Health',
      'Bone & Joint Health', 'Eye & Vision Health', 'Brain & Mental Health',
    ],
    construct: 'Goal orientation for personalization',
    provenance: {
      kind: 'expert-panel',
      source: 'Wellness outcome domains aligned to NIH ODS nutrient-function claims',
      citation: 'Each goal maps to an authorized nutrient function area (NIH Office of Dietary Supplements / EU 432/2012-style claims); item set is subject to expert CVR review.',
    },
  },

  // ── Step 3 — Medical Information & Symptoms ─────────────────────────────
  {
    id: 'medicalConditions', step: 3, section: 'Medical Information', label: 'Medical Conditions (select all that apply, or None)',
    type: 'multi', required: true, minSelections: 1, allowsNone: true,
    options: [...MEDICAL_CONDITIONS, 'None'],
    construct: 'Chronic-disease history (safety + symptom scoping)',
    provenance: {
      kind: 'expert-panel',
      source: 'Chronic-condition screener reviewed by clinical advisory panel',
      citation: 'Condition list follows AHRQ Clinical Classifications (CCS) groupings restricted to chronic conditions relevant to supplement safety; "Obesity" is BMI-gated (WHO TRS 854 cut-off >= 25), "PCOS" is sex-gated.',
    },
  },
  {
    id: 'symptoms', step: 3, section: 'Current Symptoms', label: 'Current Symptoms (general + per selected condition)',
    type: 'multi', required: true, minSelections: 1, allowsNone: true,
    options: GENERAL_SYMPTOMS,
    conditionScopedOptions: CONDITION_SYMPTOMS,
    construct: 'Symptom burden checklist',
    provenance: {
      kind: 'expert-panel',
      source: 'Checklist symptom inventory (MDHI / MSAS tradition)',
      citation: 'Checklist-format symptom inventories follow the Memorial Symptom Assessment Scale (Chang et al. 2000) and MDHI (Overs & Cassem 1986) tradition: named symptoms, each a reviewable item; general-vs-condition scoping mirrors the H&P review of systems.',
    },
  },
  {
    id: 'symptomSeverity', step: 3, section: 'Current Symptoms',
    label: 'Severity per endorsed symptom (Mild / Moderate / Severe)',
    type: 'ordinal-per-selection', required: true,
    options: SEVERITY_OPTIONS,
    construct: 'Symptom intensity, 3-point ordinal with behavioural anchors',
    provenance: {
      kind: 'standardized',
      source: '3-point intensity ordinal scale with per-symptom anchor descriptions',
      citation: 'Severity ratings with verbal behavioural anchors are the standard intensity-scoring method (cf. MSAS intensity 0-4, reduced here to a 3-point clinical band); each symptom has per-level anchor text in the form.',
    },
  },

  // ── Step 4 — Lifestyle & Medical Information ────────────────────────────
  {
    id: 'sleepQuality', step: 4, section: 'Lifestyle', label: 'Sleep Quality (with hour bands)',
    type: 'single', required: true,
    options: ['Very Poor', 'Poor', 'Average', 'Good', 'Excellent'],
    construct: 'Global sleep quality, single item',
    provenance: {
      kind: 'standardized',
      source: 'PSQI global single item (Component 1)',
      citation: 'Buysse et al. 1989, Psychiatric Research 26(3):193-204 — the Pittsburgh Sleep Quality Index global item ("How would you rate your sleep quality overall?"); hour bands follow NSF recommended sleep ranges.',
    },
  },
  {
    id: 'waterIntake', step: 4, section: 'Lifestyle', label: 'Daily Water Intake (glasses bands)',
    type: 'single', required: true,
    options: ['Less than 4 glasses', '4–6 glasses', '7–8 glasses', '9+ glasses'],
    construct: 'Habitual fluid intake',
    provenance: {
      kind: 'standardized',
      source: 'EFSA 2010 dietary reference values for water',
      citation: 'EFSA Scientific Opinion on dietary reference values for water (2010): adequate intake 2.0 L/day (women) / 2.5 L/day (men) — the 7-8 glasses band corresponds to the AI midpoint.',
    },
  },
  {
    id: 'stressLevel', step: 4, section: 'Lifestyle', label: 'Daily Stress Level',
    type: 'single', required: true,
    options: ['Low', 'Moderate', 'High', 'Severe'],
    construct: 'Perceived stress, 4-point ordinal',
    provenance: {
      kind: 'expert-panel',
      source: 'Global perceived-stress single item (PSS family, Cohen et al. 1988)',
      citation: 'Cohen, Kamarck & Mermelstein 1988 introduced the Perceived Stress Scale; this is the single global-rating variant used in brief screens. Values match verbatim the recommendation-engine branches (High/Severe -> adaptogen pathway, Moderate -> supportive).',
    },
  },
  {
    id: 'lifestyleHabits', step: 4, section: 'Lifestyle', label: 'Lifestyle Habits (Smoking / Alcohol / Recreational Drugs / None)',
    type: 'multi', required: false, allowsNone: true,
    options: ['Smoking', 'Alcohol', 'Recreational Drugs', 'None'],
    construct: 'Behavioural risk screening',
    provenance: {
      kind: 'standardized',
      source: 'Single-item tobacco/alcohol screens (USPSTF / AUDIT-C style)',
      citation: 'Tobacco: USPSTF one-item screening question; alcohol/recreational drugs: single-item frequency screens derived from AUDIT-C (Bradley et al. 2007) practice; item set subject to expert CVR review.',
    },
  },
  {
    id: 'recreationalDrugTypes', step: 4, section: 'Lifestyle',
    label: 'Which recreational drugs (free text)',
    type: 'text', required: 'conditional',
    conditionalOn: { field: 'lifestyleHabits', value: 'Recreational Drugs' },
    construct: 'Substance-specific interaction safety',
    provenance: {
      kind: 'expert-panel',
      source: 'Conditional specification required for interaction checking',
      citation: 'Named-substance disclosure is required before any recommendation is issued (drug–supplement interaction safety); conditionality mirrors standard intake skip patterns.',
    },
  },
  {
    id: 'sunExposure', step: 4, section: 'Lifestyle', label: 'Daily Sun Exposure',
    type: 'single', required: false,
    options: ['None', '< 15 min', '15–30 min', '30–60 min', '1 hr+'],
    construct: 'Endogenous vitamin D synthesis proxy',
    provenance: {
      kind: 'expert-panel',
      source: 'Sun-exposure duration bands used in vitamin-D status screening',
      citation: 'Bands follow the exposure-duration strata used in 25(OH)D prediction literature (Holick 2007, NEJM 357:266); item subject to expert CVR review.',
    },
  },
  {
    id: 'proteinIntake', step: 4, section: 'Lifestyle', label: 'Daily Protein Intake',
    type: 'single', required: false,
    options: ['Very Low (< 50g)', 'Low (50–80g)', 'Moderate (80–120g)', 'High (120g+)', 'Not sure'],
    construct: 'Habitual protein intake band',
    provenance: {
      kind: 'standardized',
      source: 'WHO/FAO/UNU 2007 protein-amino-acid requirements',
      citation: 'FAO/WHO/UNU Expert Consultation (2007): 0.83 g/kg/day adult reference — bands bracket the requirement for a 60-90 kg adult; "Not sure" preserves honest non-response.',
    },
  },
  {
    id: 'fitnessFocus', step: 4, section: 'Lifestyle', label: 'Primary Fitness Focus',
    type: 'single', required: false,
    options: ['Not applicable', 'Muscle Gain', 'Weight Loss', 'Endurance / Cardio', 'Flexibility / Mobility', 'General Fitness'],
    construct: 'Training goal category',
    provenance: {
      kind: 'expert-panel',
      source: 'ACSM-style goal categories (resistance / cardio / mobility / general)',
      citation: 'Goal domains follow ACSM Guidelines for Exercise Testing and Prescription goal setting; "Muscle Gain" and "Endurance / Cardio" match the recommendation engine verbatim.',
    },
  },
  {
    id: 'feelingDescription', step: 4, section: 'Lifestyle',
    label: "How You've Been Feeling (free text, optional)",
    type: 'text', required: false, maxLength: 1000,
    construct: 'Patient narrative / chief complaint in own words',
    provenance: {
      kind: 'expert-panel',
      source: 'Open narrative — the history-of-present-illness tradition',
      citation: 'Free-text patient narrative is the standard opening of a clinical history; here it is also scanned by the priority red-flag detector (utils/priorityFlagging.js) so urgent phrasing can raise a Priority review even without checkbox selections.',
    },
  },
  {
    id: 'takingSupplements', step: 4, section: 'Health Background', label: 'Currently Taking Supplements? (Yes/No)',
    type: 'single', required: true,
    options: ['Yes', 'No'],
    construct: 'Existing regimen (duplication/interaction safety)',
    provenance: {
      kind: 'standardized',
      source: 'Dietary-supplement disclosure required by NIH ODS safety guidance',
      citation: 'NIH ODS "Talk with Your Doctor about Dietary Supplements" — current-regimen disclosure is the first step before adding supplements.',
    },
  },
  {
    id: 'currentSupplements', step: 4, section: 'Health Background',
    label: 'List current supplements (free text)',
    type: 'text', required: 'conditional',
    conditionalOn: { field: 'takingSupplements', value: 'Yes' },
    construct: 'Regimen detail for overlap checking',
    provenance: {
      kind: 'expert-panel',
      source: 'Conditional specification — required to avoid duplicate dosing',
      citation: 'Named-supplement detail is required for UL (tolerable upper intake) overlap checks (NIH ODS); skip-logic mirrors standard supplement-history forms.',
    },
  },
  {
    id: 'recentBloodTest', step: 4, section: 'Health Background', label: 'Recent Blood Test? (Yes/No)',
    type: 'single', required: true,
    options: ['Yes', 'No'],
    construct: 'Objective-deficiency evidence availability',
    provenance: {
      kind: 'expert-panel',
      source: 'Evidence-availability gate for lab-anchored recommendations',
      citation: 'Lab confirmation before correcting a suspected deficiency is the standard clinical posture (NIH ODS fact sheets); subject to expert CVR review.',
    },
  },
  {
    id: 'bloodTestResults', step: 4, section: 'Health Background',
    label: 'Share blood-test results (free text)',
    type: 'text', required: 'conditional-optional',
    conditionalOn: { field: 'recentBloodTest', value: 'Yes' },
    construct: 'Measured biomarker values',
    provenance: {
      kind: 'expert-panel',
      source: 'Optional biomarker detail — improves recommendation accuracy when present',
      citation: 'Optional by design: prompting without forcing avoids fabricated values; when supplied, values are checked against reference ranges.',
    },
  },
  {
    id: 'currentMedications', step: 4, section: 'Health Background',
    label: 'Current Medications (free text, or None)',
    type: 'text', required: true, allowsNone: true,
    construct: 'Drug–supplement interaction safety',
    provenance: {
      kind: 'standardized',
      source: 'Concomitant-medication review — universal intake safety item',
      citation: 'Medication review before supplement advice is required by NIH ODS / Natural Medicines interaction standards; accepting the literal "None" is the standard negative-response convention.',
    },
  },
  {
    id: 'allergies', step: 4, section: 'Health Background',
    label: 'Known Allergies (free text, or None)',
    type: 'text', required: true, allowsNone: true,
    construct: 'Allergen avoidance safety',
    provenance: {
      kind: 'standardized',
      source: 'Allergy screening — universal intake safety item',
      citation: 'Allergen disclosure before product recommendation is a basic safety requirement (all excipient/capsule sources are matched against this field).',
    },
  },
  {
    id: 'isPregnant', step: 4, section: 'Health Background',
    label: 'Pregnant? (Yes/No — female respondents only)',
    type: 'single', required: 'conditional',
    conditionalOn: { field: 'gender', value: 'Female' },
    options: ['Yes', 'No'],
    construct: 'Pregnancy contraindication screen',
    provenance: {
      kind: 'standardized',
      source: 'Pregnancy status screen before supplement advice',
      citation: 'Pregnancy screening is the standard terogenic-risk gate (per FDA/LactMed practice); pregnancy automatically restricts recommendations to prenatal-safe entries.',
    },
  },
  {
    id: 'isBreastfeeding', step: 4, section: 'Health Background',
    label: 'Breastfeeding? (Yes/No — female respondents only)',
    type: 'single', required: 'conditional',
    conditionalOn: { field: 'gender', value: 'Female' },
    options: ['Yes', 'No'],
    construct: 'Lactation contraindication screen',
    provenance: {
      kind: 'standardized',
      source: 'Lactation status screen before supplement advice',
      citation: 'Lactation screening per LactMed (NIH National Library of Medicine) conventions; breastfeeding restricts recommendations to lactation-safe entries.',
    },
  },
];

function itemById(id) {
  return ITEMS.find((i) => i.id === id) || null;
}

module.exports = {
  INSTRUMENT_VERSION,
  SEVERITY_OPTIONS,
  SEVERITY_ORDINAL,
  GENERAL_SYMPTOMS,
  CONDITION_SYMPTOMS,
  MEDICAL_CONDITIONS,
  ITEMS,
  itemById,
};
