/**
 * Shared text sanitization utility.
 * Used by assessment.js (before saving to DB) and recommend.js (before sending to AI).
 */

const SPELLING_FIXES = {
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
  'sea food': 'seafood', 'sea foods': 'seafood',
  diary: 'dairy', 'diary products': 'dairy products',
  shelfish: 'shellfish', 'shell fish': 'shellfish',
  'pea nuts': 'peanuts', 'pea nut': 'peanut',
  'tree nut': 'tree nuts',
  'soy bean': 'soy', soya: 'soy',
  headche: 'headache', headach: 'headache',
  stomache: 'stomach', stomack: 'stomach',
  dizyness: 'dizziness', dizzines: 'dizziness',
  inflamation: 'inflammation',
  sweling: 'swelling', swolen: 'swollen',
  numbnes: 'numbness', numness: 'numbness',
  weekness: 'weakness', weaknes: 'weakness',
  constipaton: 'constipation', constipasion: 'constipation',
  diareah: 'diarrhea',
  vommiting: 'vomiting', vomitting: 'vomiting',
  nausia: 'nausea',
  masakit: 'pain', sumasakit: 'painful',
  nahihilo: 'dizziness', pagod: 'fatigue', napapagod: 'fatigue',
  gutom: 'hunger', uhaw: 'thirst',
  nilalagnat: 'fever', lagnat: 'fever',
  sipon: 'runny nose', ubo: 'cough',
  sakit: 'pain', 'may sakit': 'illness',
  hirap: 'difficulty', mahirap: 'difficulty',
  naiinis: 'irritability', inis: 'irritability',
  takot: 'anxiety', kinakabahan: 'nervousness',
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

// ── Common English words (enough to detect real sentences) ─────────────────
// If a text has NONE of these, it's likely nonsense
const COMMON_WORDS = new Set([
  'i','im','ive','my','me','the','a','an','is','am','are','was','were','be',
  'been','have','has','had','do','does','did','will','would','could','should',
  'can','may','might','shall','not','no','yes','and','or','but','so','if',
  'in','on','at','to','for','of','with','by','from','up','about','into',
  'feel','feeling','felt','pain','ache','hurt','hurts','tired','fatigue',
  'sick','ill','weak','dizzy','nausea','headache','stomach','back','chest',
  'sleep','sleeping','slept','eat','eating','ate','drink','drinking','drank',
  'body','head','leg','arm','hand','foot','eye','ear','nose','throat','skin',
  'blood','heart','lung','liver','kidney','bone','muscle','joint','nerve',
  'health','medical','doctor','hospital','medicine','medication','drug',
  'vitamin','supplement','allergy','allergic','condition','disease','symptom',
  'weight','height','age','diet','exercise','stress','anxiety','depression',
  'always','often','sometimes','never','daily','every','since','after','before',
  'very','really','quite','much','more','less','little','lot','some','any',
  'been','getting','having','taking','using','trying','started','stopped',
  'worse','better','severe','mild','moderate','chronic','acute',
  // Tagalog common words
  'ako','ko','ng','sa','na','at','ay','ang','mga','ito','iyon','siya',
  'niya','namin','natin','nila','kami','kayo','sila','hindi','oo','wala',
  'mahal','mabuti','masama','malaki','maliit','bago','luma','puti','itim',
]);

/**
 * Checks if a string of words contains at least one recognizable word.
 * "Niduwahjkwd" → false (no real words)
 * "I feel tired" → true
 */
function hasRealWords(text) {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  // Check against known words
  const knownCount = words.filter(w => COMMON_WORDS.has(w)).length;
  if (knownCount > 0) return true;

  // Also accept if any word is 3+ chars and looks like a real word
  // (not random consonant clusters like "nkwdjf")
  // Real words tend to have vowels
  const hasVowelWord = words.some(w => {
    if (w.length < 3) return false;
    const vowels = (w.match(/[aeiou]/g) || []).length;
    const vowelRatio = vowels / w.length;
    // Real words typically have 20-60% vowels
    return vowelRatio >= 0.2 && vowelRatio <= 0.7;
  });

  return hasVowelWord;
}

/**
 * Detects if text is garbage (button mashing, symbols, nonsense, random strings).
 * Returns true if the text should be rejected/cleared.
 */
function isGarbage(text) {
  if (!text || !text.trim()) return false;
  const t = text.trim();
  if (t.length < 3) return true;

  // All same character: "aaaaaaa", "!!!!!!"
  if (/^(.)\1{4,}$/.test(t)) return true;

  // Only symbols/numbers, no letters
  if (/^[^a-zA-Z]+$/.test(t)) return true;

  // Keyboard mashing patterns
  if (/^(asdf|qwerty|zxcv|hjkl|uiop|bnm|1234|abcd)/i.test(t)) return true;

  // Repeated word spam: "test test test test"
  if (/^(\w+\s+)\1{3,}$/.test(t)) return true;

  // Less than 20% actual letters
  const letters = (t.match(/[a-zA-Z]/g) || []).length;
  if (letters / t.length < 0.2) return true;

  // ── Mixed alphanumeric nonsense: letters and digits jumbled with no spaces ──
  // e.g. "sad12312asd", "abc123xyz456", "hello123world"
  // Real text doesn't embed numbers inside words like this
  const words = t.split(/\s+/);
  const mixedAlphanumericWords = words.filter(w => /[a-zA-Z]/.test(w) && /[0-9]/.test(w));
  // If MORE than half the words are mixed alphanumeric, it's garbage
  if (words.length > 0 && mixedAlphanumericWords.length / words.length > 0.5) return true;
  // Single word that mixes letters and numbers = garbage
  if (words.length === 1 && /[a-zA-Z]/.test(words[0]) && /[0-9]/.test(words[0])) return true;

  // ── Single word checks ──
  if (words.length === 1) {
    const w = words[0].toLowerCase();
    const vowels = (w.match(/[aeiou]/g) || []).length;
    const vowelRatio = vowels / w.length;
    // Single word with < 15% vowels is almost certainly random
    if (vowelRatio < 0.15) return true;
    // Single word > 12 chars with no spaces is suspicious unless it's a known word
    if (w.length > 12 && !COMMON_WORDS.has(w)) return true;
  }

  // Multi-word: if NO word is recognizable, it's garbage
  if (!hasRealWords(t)) return true;

  return false;
}

/**
 * Sanitizes a free-text field:
 * - Returns { value: '', garbage: true } if garbage detected
 * - Returns { value: cleanedText, garbage: false } otherwise
 */
function sanitizeTextField(text) {
  if (!text || typeof text !== 'string') return { value: '', garbage: false };
  const trimmed = text.trim();
  if (!trimmed) return { value: '', garbage: false };
  if (isGarbage(trimmed)) return { value: '', garbage: true };

  let cleaned = trimmed.replace(/\s+/g, ' ');

  // Remove filler words
  cleaned = cleaned.replace(/\b(like|um|uh|you know|basically|literally)\b/gi, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Apply spelling fixes (longer phrases first)
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

  return { value: cleaned.trim(), garbage: false };
}

/**
 * Sanitizes a short field (medications, allergies, supplements).
 */
function sanitizeShortField(text) {
  if (!text || typeof text !== 'string') return { value: text || '', garbage: false };
  const trimmed = text.trim();
  if (!trimmed) return { value: '', garbage: false };
  if (isGarbage(trimmed)) return { value: '', garbage: true };

  let cleaned = trimmed.replace(/\s+/g, ' ');

  const spellingEntries = Object.entries(SPELLING_FIXES).sort((a, b) => b[0].length - a[0].length);
  for (const [wrong, correct] of spellingEntries) {
    const regex = new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    cleaned = cleaned.replace(regex, correct);
  }

  return { value: cleaned.trim(), garbage: false };
}

module.exports = { sanitizeTextField, sanitizeShortField, isGarbage };
