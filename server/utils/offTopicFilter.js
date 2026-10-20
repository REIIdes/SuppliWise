/**
 * The chat pre-filter — the fast path that decides, before a provider is paid,
 * whether a message is clearly nothing to do with health or SuppliWise.
 *
 * ── Why this is a module and not a list of regexes in the route ─────────────
 * It used to be twelve inline patterns inside routes/chat.js, and it was silently
 * destroying real answers. Every rule matched SUBSTRINGS, so `war` lived inside
 * "warning", "aware" and "software", `nfl` inside "inflammation", `vote` inside a
 * schedule question, `nuclear` inside the vitamin D receptor's own pathway, and
 * `^how do i make` inside "how do I make my sleep better". A member asking "what
 * are the warning signs of iron deficiency" got back "I'm only able to help with
 * health questions" — which reads as the assistant being rude, and is the single
 * most damaging failure this surface can have.
 *
 * ── The two rules that fix it ───────────────────────────────────────────────
 * 1. Every pattern is anchored — `^` where the original was anchored, `\b`
 *    everywhere — so an acronym stops matching inside a word and `war` only
 *    declines a message about a war.
 * 2. A message carrying health, nutrition, clinical or SuppliWise vocabulary is
 *    never declined here. The veto is deliberately generous, because the two
 *    mistakes are not equal: a false negative costs one wasted provider call and
 *    the system prompt's own STRICT OFF-TOPIC RULE still declines it, while a
 *    false positive costs the member an answer they were entitled to. So the list
 *    errs wide, and the only words kept OUT of it are the ones that are a rule's
 *    own trigger ("recipe", "cook"), which would otherwise make that rule dead.
 *
 * The classifier reports WHICH rule fired so a decline is diagnosable, and the
 * decline text is chosen deterministically from the message, so asking the same
 * off-topic question twice does not print a different canned sentence.
 */

const { hasHealthAnchor } = require('./languageAnchors');

/**
 * Veto vocabulary: if any of these appears as a whole word the filter abstains and
 * the message goes to the model, which has the member's plan, the retrieved notes
 * and their identity to judge it properly.
 */
const HEALTH_HINTS = [
  // the subject itself
  'health', 'healthy', 'wellness', 'wellbeing', 'well-being', 'supplement', 'supplements',
  'suppliment', 'vitamin', 'vitamins', 'mineral', 'minerals', 'nutrient', 'nutrients',
  'nutrition', 'nutritional', 'diet', 'dietary', 'fasting', 'meal', 'meals', 'protein',
  'carbs', 'carbohydrate', 'fibre', 'fiber', 'calories', 'smoothie', 'snack', 'snacks',
  'breakfast', 'lunch', 'dinner', 'supper', 'vegetarian', 'vegan', 'keto', 'eat', 'eating',
  'food', 'foods', 'drinks', 'tea', 'water', 'alcohol', 'smoking', 'smoke', 'vape',
  // named nutrients and botanicals this app recommends
  'iron', 'ferritin', 'calcium', 'magnesium', 'magnisium', 'zinc', 'potassium', 'sodium',
  'iodine', 'selenium', 'omega', 'creatine', 'collagen', 'probiotics', 'prebiotic',
  'ashwagandha', 'ashwaganda', 'turmeric', 'curcumin', 'ginger', 'garlic', 'melatonin',
  'caffeine', 'glutathione',
  // the body and its states
  'sleep', 'insomnia', 'rest', 'energy', 'fatigue', 'tired', 'stress', 'stressed',
  'anxiety', 'anxious', 'calm', 'mood', 'depression', 'mental', 'brain', 'memory',
  'focus', 'headache', 'migraine', 'dizziness', 'nausea', 'bloating', 'digestion',
  'digestive', 'stomach', 'gut', 'bowel', 'immune', 'inflammation', 'inflammatory',
  'antioxidant', 'muscle', 'joint', 'joints', 'bone', 'bones', 'neck', 'knee', 'skin',
  'acne', 'hair', 'nails', 'teeth', 'dental', 'vision', 'heart', 'cardio', 'cholesterol',
  'blood', 'pressure', 'glucose', 'sugar', 'diabetes', 'diabetic', 'thyroid', 'hormone',
  'hormones', 'cortisol', 'estrogen', 'testosterone', 'insulin', 'pcos', 'menstrual',
  'period', 'menopause', 'pregnancy', 'pregnant', 'breastfeeding', 'lactation',
  'prenatal', 'allergy', 'allergies', 'allergic', 'intolerance', 'symptom', 'symptoms',
  'syndrome', 'condition', 'disease', 'illness', 'pain', 'sore', 'soreness', 'ache',
  'aches', 'sick', 'cold', 'flu', 'fever', 'temperature',
  // clinical interaction, safety and measurement
  'medication', 'medications', 'medicine', 'medicines', 'drug', 'drugs', 'pill', 'pills',
  'tablet', 'tablets', 'capsule', 'capsules', 'dose', 'doses', 'dosage', 'dosing',
  'mg', 'mcg', 'iu', 'interact', 'interacts', 'interaction', 'interactions', 'side',
  'effect', 'effects', 'contraindicated', 'tolerate', 'absorb', 'absorption',
  'bioavailability', 'deficiency', 'deficient', 'excess', 'toxic', 'toxicity',
  'diagnose', 'diagnosed', 'diagnosis', 'lab', 'labs', 'test', 'tests', 'testing',
  'baseline', 'monitor', 'supervised', 'clinician', 'doctor', 'physician', 'nurse',
  'pharmacist', 'dietitian', 'therapist', 'therapy', 'counseling', 'counselling',
  'hospital', 'surgery', 'recovery', 'supplemental',
  // movement and lifestyle
  'exercise', 'workout', 'workouts', 'gym', 'fitness', 'walking', 'running', 'yoga',
  'training', 'sedentary', 'steps', 'hydration', 'hydrated', 'weight', 'bmi', 'height',
  // the app itself — "how do I use …" is a support question, not small talk
  'suppliwise', 'suppli', 'app', 'dashboard', 'assessment', 'questionnaire',
  'subscription', 'package', 'ultimate', 'plan', 'pdf', 'report', 'export', 'download',
  'account', 'profile', 'login', 'password', 'otp', 'ticket', 'support', 'assistant',
  'reminder', 'reminders', 'recommendation', 'recommendations', 'results',
]
  .filter((word, index, list) => list.indexOf(word) === index)
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const HEALTH_VETO = new RegExp(`\\b(?:${HEALTH_HINTS.join('|')})\\b`, 'i');

/**
 * The same veto, in the languages this product's members actually write.
 *
 * HEALTH_HINTS is English, so every rule above was unreachable for a Filipino message —
 * and unreachable in the wrong direction: an English off-topic rule cannot fire on
 * Tagalog either, so the filter abstains and the message goes to the model. That is the
 * safe outcome, and it is why this is not a fix for a bug members hit. It is here for the
 * case where a Taglish message DOES carry an English off-topic trigger word inside
 * Filipino grammar ("annoying ba ang anime ko?" reads as entertainment to a word-anchored
 * English rule), and for the day a rule is added in another language: utils/languageAnchors.js
 * is the single place that knows what a health word looks like in Filipino, and consulting
 * it keeps this module's own rule — never decline a message about health — true in every
 * language instead of only in English.
 *
 * This can only ever ADD abstention, never a decline. That asymmetry is the design rule
 * this file exists for.
 */
const isHealthText = (text) => HEALTH_VETO.test(text) || hasHealthAnchor(text);

/**
 * Off-topic shape, one entry per category the route used to keep inline.
 */
const OFF_TOPIC_RULES = [
  {
    id: 'celebrity',
    pattern: /^\s*(?:who|what|where|when|why|how)\b[^?]{0,40}?\b(?:messi|ronaldo|taylor swift|elon musk|trump|biden|obama|beyonce|drake|kanye|lebron|kobe|eminem|rihanna|adele|harry styles|ariana|billie eilish)\b/i,
  },
  {
    id: 'arithmetic',
    pattern: /^\s*(?:what(?:'s| is)|solve|calculate|compute|evaluate)\s+-?\d[\d,.]*\s*[+\-*/%^]\s*-?\d/i,
  },
  {
    id: 'entertainment',
    pattern: /\b(?:best movie|best film|best song|best album|best show|netflix|spotify|youtube|tiktok|instagram|twitter|facebook|reddit)\b/i,
  },
  {
    id: 'sports',
    pattern: /\b(?:who won|final score|match result|game score|nba|nfl|fifa|premier league|la liga)\b/i,
  },
  {
    id: 'weather',
    pattern: /^\s*(?:what(?:'s| is) the weather|will it rain|temperature (?:today|tomorrow)|forecast\b)/i,
  },
  {
    id: 'code',
    pattern: /\b(?:write|generate|code)\b[^?]{0,30}?\b(?:code|program|programme|script|function|html|css|javascript|typescript|python|java|sql|regex)\b|\bhow to (?:code|program|hack)\b/i,
  },
  {
    id: 'civic-news',
    pattern: /\b(?:president|prime minister|election|senate|senator|congress|parliament|missile|warfare|military|nuclear (?:weapon|bomb|war|energy|power)|war|vote)\b/i,
  },
  {
    id: 'jokes',
    pattern: /^\s*(?:tell me a joke|say something funny|make me laugh|do a trick|sing|rap|write (?:me )?(?:a |some )?(?:poem|song|story|essay|rap|haiku))/i,
  },
  {
    id: 'recipe',
    pattern: /^\s*(?:how (?:do i|do you|to|should i|can i) (?:cook|bake|fry|boil|roast|steam|grill)|recipe for\b|ingredients for\b)/i,
  },
];

/**
 * The decline corpus. One list, because the pre-filter and the model are supposed
 * to give the member the same sentence for the same refusal — it used to be typed
 * twice (once into the route's array, once into the prompt's "use one of these
 * styles"), and the two copies drifted, so a message caught before the call read
 * slightly differently from the same message caught by the model.
 */
const OFF_TOPIC_DECLINES = [
  "I'm only able to help with health, wellness, and SuppliWise questions. Is there something health-related I can assist you with?",
  "That's outside what I can help with — I'm focused on health and SuppliWise. Got any supplement or wellness questions?",
  "I'm not the right assistant for that! I specialize in health, nutrition, and SuppliWise. Anything wellness-related I can help with?",
  "I can only assist with health and SuppliWise topics. Feel free to ask me about supplements, nutrition, or how to use the app!",
];

/** FNV-1a over the normalised message — stable across restarts, unlike Math.random. */
function hashOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * @param {string} message the member's raw question
 * @returns {{offTopic: boolean, rule: string|null}} the rule that fired, or
 *   'health-topic' when the veto abstained, or null when nothing matched.
 */
function classifyOffTopic(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return { offTopic: false, rule: null };
  if (isHealthText(text)) return { offTopic: false, rule: 'health-topic' };
  for (const rule of OFF_TOPIC_RULES) {
    if (rule.pattern.test(text)) return { offTopic: true, rule: rule.id };
  }
  return { offTopic: false, rule: null };
}

const isOffTopic = (message) => classifyOffTopic(message).offTopic;

/**
 * The canned decline for a message, chosen deterministically from the message
 * itself. Identical input prints an identical decline instead of rotating through
 * four strings, which is what lets a repeat of a question be compared against the
 * first answer at all.
 *
 * @param {string} message
 * @param {string[]} replies the decline corpus to pick from
 */
function declineFor(message, replies = OFF_TOPIC_DECLINES) {
  const list = Array.isArray(replies) && replies.length ? replies : [''];
  if (list.length === 1) return list[0];
  const key = String(message || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return list[hashOf(key) % list.length];
}

module.exports = {
  OFF_TOPIC_DECLINES,
  OFF_TOPIC_RULES,
  classifyOffTopic,
  declineFor,
  isOffTopic,
};
