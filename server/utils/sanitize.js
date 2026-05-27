/**
 * Shared text sanitization utility.
 * Used by assessment.js (before saving to DB) and recommend.js (before sending to AI).
 */

const SPELLING_FIXES = {
  // Health/supplement misspellings
  tireed: 'tired', tierd: 'tired',
  fatige: 'fatigue', fatique: 'fatigue',
  vitamen: 'vitamin', vitamn: 'vitamin',
  suppliment: 'supplement', supplment: 'supplement',
  magneseum: 'magnesium', magnezium: 'magnesium',
  omaga: 'omega', omego: 'omega',
  protien: 'protein', protine: 'protein',
  calicum: 'calcium', calcuim: 'calcium',
  probiotik: 'probiotic',
  alergy: 'allergy',
  medecine: 'medicine', medicin: 'medicine',
  diabetis: 'diabetes', diabeetus: 'diabetes',
  thyriod: 'thyroid', thryoid: 'thyroid',
  anaemia: 'anemia',
  diarrea: 'diarrhea', diarhea: 'diarrhea',
  nausious: 'nauseous',
  migranes: 'migraine', migrains: 'migraine',
  insomia: 'insomnia',
  anxeity: 'anxiety', anixety: 'anxiety',
  depresion: 'depression', deppression: 'depression',
  excersize: 'exercise', excercise: 'exercise',
  // Food/allergy
  'sea food': 'seafood', 'sea foods': 'seafood',
  diary: 'dairy', 'diary products': 'dairy products',
  shelfish: 'shellfish', 'shell fish': 'shellfish',
  'pea nuts': 'peanuts', 'pea nut': 'peanut',
  'tree nut': 'tree nuts',
  'soy bean': 'soy', soya: 'soy',
  // Common body/symptom terms
  headche: 'headache', headach: 'headache',
  stomache: 'stomach', stomack: 'stomach',
  dizyness: 'dizziness', dizzines: 'dizziness',
  inflamation: 'inflammation', inflamation: 'inflammation',
  sweling: 'swelling', swolen: 'swollen',
  numbnes: 'numbness', numness: 'numbness',
  weekness: 'weakness', weaknes: 'weakness',
  constipaton: 'constipation', constipasion: 'constipation',
  diareah: 'diarrhea',
  vommiting: 'vomiting', vomitting: 'vomiting',
  nausia: 'nausea',
  // Tagalog/Filipino common health terms → English
  masakit: 'pain', sumasakit: 'painful',
  nahihilo: 'dizziness', pagod: 'fatigue', napapagod: 'fatigue',
  gutom: 'hunger', uhaw: 'thirst',
  nilalagnat: 'fever', lagnat: 'fever',
  sipon: 'runny nose', ubo: 'cough',
  sakit: 'pain', 'may sakit': 'illness',
};

const SLANG_TO_CLINICAL = {
  'super tired': 'significant fatigue',
  'really tired': 'significant fatigue',
  'so tired': 'excessive fatigue',
  'very tired': 'significant fatigue',
  'extremely tired': 'severe fatigue',
  exhausted: 'severe fatigue',
  'wiped out': 'extreme fatigue',
  'worn out': 'fatigued',
  drained: 'depleted energy',
  'burnt out': 'burnout symptoms',
  'no energy': 'lack of energy',
  'zero energy': 'severe fatigue',
  'low energy': 'reduced energy',
  sluggish: 'lethargy',
  "can't sleep": 'insomnia',
  'cant sleep': 'insomnia',
  'cannot sleep': 'insomnia',
  'trouble sleeping': 'sleep disturbance',
  'hard to sleep': 'difficulty initiating sleep',
  'brain fog': 'cognitive impairment',
  'foggy brain': 'cognitive impairment',
  foggy: 'cognitive impairment',
  "can't focus": 'difficulty concentrating',
  'cant focus': 'difficulty concentrating',
  'hard to focus': 'difficulty concentrating',
  forgetful: 'memory difficulties',
  'stressed out': 'experiencing stress',
  anxious: 'experiencing anxiety',
  worried: 'experiencing anxiety',
  moody: 'mood fluctuations',
  irritable: 'irritability',
  grumpy: 'irritability',
  depressed: 'depressive symptoms',
  'feeling down': 'low mood',
  tummy: 'stomach',
  'tummy ache': 'abdominal pain',
  'stomach ache': 'abdominal pain',
  constipated: 'constipation',
  'throwing up': 'vomiting',
  puking: 'vomiting',
  nauseous: 'nausea',
  queasy: 'nausea',
  bloated: 'abdominal bloating',
  gassy: 'flatulence',
  dizzy: 'dizziness',
  lightheaded: 'lightheadedness',
  achy: 'body aches',
  sore: 'muscle soreness',
  stiff: 'joint stiffness',
  hurts: 'pain',
  painful: 'pain',
  weak: 'muscle weakness',
  shaky: 'tremors',
  'stuffy nose': 'nasal congestion',
  'runny nose': 'rhinorrhea',
  'sore throat': 'pharyngitis',
  'dry skin': 'xerosis',
  itchy: 'pruritus',
  breakouts: 'acne',
  pimples: 'acne',
  'hair falling out': 'hair loss',
  'losing hair': 'hair loss',
};

/**
 * Detects if text is garbage (button mashing, symbols, nonsense).
 * Returns true if the text should be rejected/cleared.
 */
function isGarbage(text) {
  if (!text || !text.trim()) return false;
  const t = text.trim();
  if (t.length < 3) return true;
  // All same character repeated: "aaaaaaa", "!!!!!!"
  if (/^(.)\1{4,}$/.test(t)) return true;
  // Only symbols/numbers, no real words
  if (/^[^a-zA-Z]+$/.test(t)) return true;
  // Keyboard mashing patterns
  if (/^(asdf|qwerty|zxcv|hjkl|uiop|bnm|1234|abcd)/i.test(t)) return true;
  // Repeated word spam: "test test test test"
  if (/^(\w+\s+)\1{3,}$/.test(t)) return true;
  // Less than 20% actual letters (mostly symbols/numbers)
  const letters = (t.match(/[a-zA-Z]/g) || []).length;
  if (letters / t.length < 0.2) return true;
  return false;
}

/**
 * Sanitizes a free-text field:
 * - Returns empty string if garbage
 * - Fixes spelling mistakes
 * - Converts slang to clinical language
 * - Normalizes whitespace and capitalizes
 */
function sanitizeTextField(text) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (isGarbage(trimmed)) return '';

  let cleaned = trimmed.replace(/\s+/g, ' ');

  // Remove filler words
  cleaned = cleaned.replace(/\b(like|um|uh|you know|basically|literally)\b/gi, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Apply spelling fixes (longer phrases first to avoid partial matches)
  const spellingEntries = Object.entries(SPELLING_FIXES).sort((a, b) => b[0].length - a[0].length);
  for (const [wrong, correct] of spellingEntries) {
    const regex = new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    cleaned = cleaned.replace(regex, correct);
  }

  // Apply slang → clinical (longer phrases first)
  const slangEntries = Object.entries(SLANG_TO_CLINICAL).sort((a, b) => b[0].length - a[0].length);
  for (const [slang, clinical] of slangEntries) {
    const regex = new RegExp(`\\b${slang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    cleaned = cleaned.replace(regex, clinical);
  }

  // Remove repeated characters (sooooo → so)
  cleaned = cleaned.replace(/(.)\1{3,}/g, '$1$1');

  // Capitalize first letter of sentences
  cleaned = cleaned.replace(/(^\w|[.!?]\s+\w)/g, m => m.toUpperCase());

  return cleaned.trim();
}

/**
 * Sanitizes a short field (medications, allergies, supplements).
 * Less aggressive — just fixes spelling and normalizes whitespace.
 */
function sanitizeShortField(text) {
  if (!text || typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (isGarbage(trimmed)) return '';

  let cleaned = trimmed.replace(/\s+/g, ' ');

  const spellingEntries = Object.entries(SPELLING_FIXES).sort((a, b) => b[0].length - a[0].length);
  for (const [wrong, correct] of spellingEntries) {
    const regex = new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    cleaned = cleaned.replace(regex, correct);
  }

  return cleaned.trim();
}

module.exports = { sanitizeTextField, sanitizeShortField, isGarbage };
