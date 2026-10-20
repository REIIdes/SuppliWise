'use strict';

const { buildCorpus, planDocs, dynamicConditionDocs, tokens } = require('./ragCorpus');

/**
 * BM25 OVER THE APP'S OWN KNOWLEDGE — WHY IT LOOKS LIKE THIS.
 *
 * Retrieval here is not a search engine bolted onto a chat; it is the difference
 * between a model that has to remember magnesium and a model that is handed the
 * sentence this app already published and already checked. So the ranking is
 * deliberately boring: a deterministic scoring function over a fixed corpus, no
 * network, no model call, no embedding store to drift or go down. A retriever that
 * depends on an API cannot be tested in CI, and an accuracy gate nobody can re-run
 * on a laptop is not a gate.
 *
 * Two decisions are load-bearing:
 *
 * 1. ALIAS EXPANSION IS CURATED, NOT LEARNED FROM THE MODEL. A member says "I can't
 *    sleep"; the registry says "Magnesium ... sleep quality". Those two phrasings
 *    share no stem, so plain term matching would return nothing and the model would
 *    be back to inventing. The bridge is a hand-written map of everyday phrasings to
 *    vocabulary that already exists in this app's questionnaire and evidence notes.
 *    It only ever adds *query* terms — it cannot make a document claim something it
 *    does not already say, which is what keeps retrieval out of the hallucination
 *    business.
 *
 * 2. THE "DOES NOT EXIST" SECTION IS FORCED IN. On any "how do I / can I / does the
 *    app" question, the list of things this product cannot do is included whatever it
 *    scores. That is the one failure mode a ranking algorithm gets wrong silently:
 *    the absence of a document is indistinguishable from a weak match, and a model
 *    with no evidence of absence fills it with a confident, plausible, wrong path
 *    through a Settings screen that does not exist.
 */

const K1 = 1.4;
const B = 0.75;

// Everyday phrasing -> vocabulary this corpus actually contains. Keys are matched
// against the raw question; values are fed through the same folding as documents.
//
// Every term listed here reaches at least one document, and `npm run eval:chat`
// enforces that. A synonym that matches nothing is not harmless: it reads as coverage
// ("we handle gut questions") while the query still returns nothing, which is the
// invisible half of a retrieval miss.
const ALIASES = [
  { id: 'sleep', re: /\b(can'?t|cannot|trouble|difficulty|poor|low|disturb|improve)\s+(my\s+)?sleep|insomnia|sleepless|stay asleep|fall asleep|tossing|snor(e|ing)|restless night|sleep quality\b/i, add: ['sleep', 'melatonin', 'magnesium', 'valerian', 'theanine', 'ashwagandha'] },
  { id: 'energy', re: /\b(tired|fatigue|fatigued|low energy|exhausted|sleepy|letharg|no energy|burnt out)\b/i, add: ['energy', 'weakness', 'b12', 'iron', 'folate', 'coq10', 'rhodiola', 'ginseng', 'creatine'] },
  { id: 'immunity', re: /\b(immunity|immune|cold|flu|sick|infection|cough|fever)\b/i, add: ['immunity', 'cold', 'zinc', 'vitamin', 'elderberry', 'echinacea', 'probiotics'] },
  { id: 'gut', re: /\b(gut|stomach|digest|bloat|constip|diarrh|acid reflux|gerd|ibs|cramp|gas)\b/i, add: ['probiotics', 'ibs', 'burning', 'reflux', 'thistle'] },
  { id: 'brain', re: /\b(focus|concentrat|memory|brain|mental clarity|foggy|cognitive|studying|adhd)\b/i, add: ['clarity', 'lion', 'mane', 'ginkgo', 'bacopa', 'theanine', 'phosphatidylserine'] },
  { id: 'joint', re: /\b(joint|knee|arthritis|back pain|stiff|sore|tendon|muscle pain|cartilage)\b/i, add: ['joint', 'pain', 'arthritis', 'stiffness', 'soreness', 'curcumin', 'boswellia', 'glucosamine', 'chondroitin', 'collagen', 'omega'] },
  { id: 'skin', re: /\b(skin|acne|wrinkle|eczema|psoriasis|rash|dry skin|glow|pigment)\b/i, add: ['skin', 'acne', 'rash', 'collagen', 'biotin', 'zinc', 'vitamin', 'astaxanthin', 'hyaluronic'] },
  { id: 'hair', re: /\b(hair|thinning|bald|hairfall|hair loss)\b/i, add: ['hair', 'thinning', 'loss', 'biotin', 'zinc', 'iron', 'collagen'] },
  { id: 'stress', re: /\b(stress|stressed|anxiety|anxious|panic|overwhelm|nervous|depress|low mood|mood)\b/i, add: ['stress', 'anxiety', 'depression', 'ashwagandha', 'rhodiola', 'theanine', 'magnesium', 'bacopa'] },
  { id: 'heart', re: /\b(heart|blood pressure|hypertension|bp|cholesterol|triglyceride|artery|cardio)\b/i, add: ['heart', 'blood', 'pressure', 'hypertension', 'omega', 'coq10', 'garlic', 'potassium', 'nattokinase'] },
  { id: 'sugar', re: /\b(diabetes|blood sugar|glucose|insulin|prediabet|hba1c|sugar level)\b/i, add: ['diabetes', 'insulin', 'resistance', 'berberine', 'chromium'] },
  { id: 'weight', re: /\b(weight|obes|fat loss|slim|metabolism|belly|kg)\b/i, add: ['weight', 'obesity', 'berberine', 'chromium', 'protein'] },
  { id: 'liver', re: /\b(liver|fatty liver|nafl|detox|jaundice)\b/i, add: ['liver', 'thistle', 'fatty', 'jaundice', 'curcumin'] },
  { id: 'hormone', re: /\b(period|menstrual|pcos|menopaus|hormone|hormonal|pcod|libido|fertility|pregnan|testosterone|thyroid)\b/i, add: ['pcos', 'thyroid', 'vitex', 'maca', 'iodine', 'selenium', 'zinc', 'iron'] },
  { id: 'bone', re: /\b(bone|osteopor|calcium|vitamin d|joint bone|fracture|teeth|dental)\b/i, add: ['bone', 'osteoporosis', 'calcium', 'vitamin', 'magnesium', 'pain'] },
  { id: 'muscle-gain', re: /\b(muscle|gym|workout|exercise|protein|bulk|strength|recover)\b/i, add: ['muscle', 'protein', 'creatine', 'whey', 'hmb', 'citrulline', 'beta-alanine', 'weakness', 'soreness'] },
  { id: 'tracking', re: /\b(log|logged|logging|track|tracker|adherence|streak|missed|mark(?:ed)? it|take it|schedule|calendar|daily plan|today'?s plan)\b/i, add: ['track', 'intake', 'taken', 'calendar', 'adherence', 'streak', 'missed', 'mark', 'schedule'] },
  { id: 'dose', re: /\b(how much|what dose|dosage|mg per day|maximum|safe amount|too much|overdose|side effect|safe)\b/i, add: ['dose'] },
  { id: 'evidence', re: /\b(proof|proof of|source|sources|study|studies|research|cite|citation|reference|scientifically|really works|does it work|works)\b/i, add: ['citation', 'results', 'page', 'registry'] },
];

// "How do I / can I / does the app" — the shape of question where a missing feature
// must be named, not inferred. "can the app prescribe medication" is exactly such a
// question and does not contain "can I", so the app-subject forms are listed apart.
const FEATURE_QUESTION = /\bhow (do|can|to|does|many)|where (do|can|is|are|was|will)|can i|could i|how to|can (the |an |my )?(app|it|this|system)|what (does|can) the (app|system)|does (the )?(app|it|this)|is there|are there|i want to|how old|am i able|support|feature|available|option|prescrib\b/i;

const PLAN_BOOST = 1.3;
const REPORTED_BOOST = 1.12;

const entryCache = new WeakMap();

/**
 * Build the scoring tables for a set of documents.
 *
 * Called once for the static corpus and again, per request, for the corpus plus that
 * member's plan rows and the learned conditions. The second call is the honest
 * version of the ranking: document frequency is what decides whether a query term
 * carries any signal, so a plan document that is about to be returned has to be in
 * the statistics it was returned by. Indexing the static corpus alone would rank
 * "which of these 165 notes matches best" and then bolt the member's own note on,
 * which is exactly the ordering nobody measured.
 */
function makeIndex(docs) {
  const entries = docs.map((doc) => {
    const known = entryCache.get(doc);
    if (known) return known;
    // Title and keys are repeated so a document is found by what it is called, not
    // only by the words inside its sentences.
    const bag = tokens(`${doc.title} ${doc.title} ${doc.title} ${(doc.keys || []).join(' ')} ${doc.text}`);
    const tf = new Map();
    for (const t of bag) tf.set(t, (tf.get(t) || 0) + 1);
    const entry = { doc, tf, len: bag.length };
    entryCache.set(doc, entry);
    return entry;
  });
  const df = new Map();
  for (const e of entries) for (const t of e.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = entries.length;
  const avgdl = entries.reduce((sum, e) => sum + e.len, 0) / (N || 1);
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + (N - d + 0.5) / (d + 0.5)));
  return { entries, avgdl, idf, df, N };
}

let baseIndex = null;

function getIndex() {
  if (!baseIndex) baseIndex = makeIndex(buildCorpus());
  return baseIndex;
}

/**
 * Terms that appear in a third of the corpus carry no signal, and an expanded query
 * reaches exactly those words by design ("app", "day", "results"). Dropping them is
 * what stops "how much magnesium" from returning every dose note in the library
 * because they all say the same boilerplate sentence.
 */
function discriminative(terms, idx) {
  const floor = idx.N * 0.34;
  return terms.filter((t) => (idx.df.get(t) || 0) <= floor);
}

/** The question, plus this app's own vocabulary for what the question means. */
function expandQuestion(question) {
  const raw = String(question || '');
  const out = new Set(tokens(raw));
  const matched = [];
  for (const alias of ALIASES) {
    if (!alias.re.test(raw)) continue;
    matched.push(alias.id);
    for (const term of alias.add) for (const t of tokens(term)) out.add(t);
  }
  return { terms: [...out], matched };
}

function baseScore(entry, queryTerms, idx) {
  let score = 0;
  for (const t of queryTerms) {
    const tf = entry.tf.get(t);
    if (!tf) continue;
    const idf = idx.idf.get(t) || 0;
    score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (entry.len / idx.avgdl)));
  }
  return score;
}

/** Nutrients the member already has in their plan, lowercased for joining. */
function planNames(assessment) {
  const rows = assessment && assessment.aiResults && Array.isArray(assessment.aiResults.recommendations)
    ? assessment.aiResults.recommendations : [];
  return new Set(rows.map((r) => String((r && r.name) || '').toLowerCase().trim()).filter(Boolean));
}

function reportedLabels(assessment) {
  if (!assessment) return new Set();
  const out = new Set();
  const push = (v) => { if (v) out.add(String(v).toLowerCase().trim()); };
  for (const list of [assessment.symptoms, assessment.healthGoals, assessment.medicalConditions]) {
    if (Array.isArray(list)) list.forEach(push);
  }
  return out;
}

/**
 * Did the member name this thing themselves? Alias expansion reaches related notes,
 * which is the point, but it must not let a related note outrank the one the member
 * actually asked about — "what dose of vitamin d" pulling up Calcium first because a
 * registry sentence pairs them is retrieval being cleverer than the question.
 *
 * Two strengths, because the token fold cannot see the difference between
 * "vitamin d" and "vitamin c" (single letters drop out of it). A whole-phrase hit is
 * what the member literally typed, so it wins; a token hit is only "they said the
 * family".
 *
 * App help documents are excluded from the whole-phrase strength on purpose: their
 * keys are question shapes by design ("can i", "is there", "does it have"), so a
 * substring of the question proves the member is asking ABOUT the app, not naming a
 * document. They compete on content words like everything else.
 */
function nameMatch(doc, rawLower, queryTokens) {
  const phrasable = doc.kind !== 'app';
  let weak = 0;
  for (const c of [doc.title, ...(doc.keys || [])]) {
    const key = String(c || '').toLowerCase().trim();
    if (!key) continue;
    if (phrasable && key.length >= 5 && rawLower.includes(key)) return 2;
    const t = tokens(key);
    if (t.length && t.every((x) => queryTokens.has(x))) weak = 1;
  }
  return weak;
}

const DOSE_QUESTION = /\b(how much|what dose|dosage|dose|mg|mcg|iu per day|maximum|safe amount|too much|overdose|side effect|is it safe|can i take)\b/i;

/**
 * Rank the corpus against one question.
 *
 * `priors` is the adaptation hook: a docId -> weight map produced by the learning
 * loop from member feedback on previous answers. It is applied as a bounded
 * multiplier so a heavily-downvoted note can fade and a useful one can rise without
 * either one ever beating the BM25 match on the question in front of it. Feedback
 * tunes which evidence gets handed over; it never writes evidence.
 *
 * @param {string} question
 * @param {{assessment?: object, live?: Array, priors?: Map|object, limit?: number, extraDocs?: Array}} [options]
 */
function retrieve(question, options = {}) {
  // Per-request documents — the member's own plan rows and the conditions the
  // learning loop published — join the corpus BEFORE the statistics are taken, so a
  // plan note competes for the top slot on the same scale as everything else.
  const extras = [...(options.extraDocs || []), ...planDocs(options.assessment), ...dynamicConditionDocs(options.live)];
  const idx = extras.length ? makeIndex([...buildCorpus(), ...extras]) : getIndex();
  const { terms: expandedTerms, matched } = expandQuestion(question);
  const terms = discriminative(expandedTerms, idx);
  const limit = Math.max(1, Math.min(Number(options.limit) || 6, 12));

  const all = idx.entries;
  const inPlan = planNames(options.assessment);
  const reported = reportedLabels(options.assessment);
  const priors = options.priors instanceof Map ? options.priors : new Map(Object.entries(options.priors || {}));
  const namedTokens = new Set(tokens(question));
  const rawLower = ` ${String(question || '').toLowerCase()} `;
  const doseQuestion = DOSE_QUESTION.test(String(question || ''));

  const scored = all.map((entry) => {
    let score = baseScore(entry, terms, idx);
    const doc = entry.doc;
    const byName = nameMatch(doc, rawLower, namedTokens);
    if (byName === 2) score *= 2.4;
    else if (byName === 1) score *= 1.35;
    if (doseQuestion && doc.kind === 'dose' && byName) score *= 1.5;
    const nutrients = (doc.nutrients || []).map((n) => String(n).toLowerCase());
    if (nutrients.some((n) => inPlan.has(n))) score *= PLAN_BOOST;
    if (doc.kind === 'symptom' || doc.kind === 'condition' || doc.kind === 'learned-condition') {
      if (reported.has(String(doc.title).toLowerCase())) score *= REPORTED_BOOST * 1.4;
    } else if (reported.size && doc.keys) {
      const hit = doc.keys.some((k) => reported.has(String(k).toLowerCase()));
      if (hit) score *= REPORTED_BOOST;
    }
    const prior = priors.get(doc.id);
    if (prior) score *= Math.min(2, Math.max(0.4, 1 + Number(prior)));
    return { doc, score, byName, matchedTerms: terms.filter((t) => entry.tf.has(t)).length };
  }).filter((row) => row.score > 0);

  scored.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));

  // A nutrient the member named out loud is not a ranking decision.
  // "what is vitamin d good for" used to answer with Calcium, Osteoporosis and Bone
  // Pain — true things about bones, none of them the thing that was asked — because
  // the bone alias contributes more matching terms than a two-letter name can win on.
  // When the question contains a note's own name, that note goes in first.
  const named = scored.filter((r) => r.byName === 2).slice(0, 3);
  const seen = new Set(named.map((r) => r.doc.id));
  const fill = scored.filter((r) => !seen.has(r.doc.id)).slice(0, Math.max(0, limit - named.length));
  const shape = (r) => ({ id: r.doc.id, kind: r.doc.kind, title: r.doc.title, text: r.doc.text, nutrients: r.doc.nutrients, pmids: r.doc.pmids, never: Boolean(r.doc.never), score: Number(r.score.toFixed(3)) });
  const chosen = [...named, ...fill].map(shape);

  // Forced sections: absence must always be visible, whatever it scored.
  if (FEATURE_QUESTION.test(String(question || ''))) {
    const present = new Set(chosen.map((d) => d.id));
    const forced = buildCorpus().filter((d) => d.never || d.id === 'app:exists');
    for (const doc of forced) {
      if (present.has(doc.id)) continue;
      chosen.push(shape({ doc, score: 0 }));
    }
  }

  return { docs: chosen, queryTerms: terms, expanded: matched, candidates: scored.slice(0, 20).map((r) => ({ id: r.doc.id, score: Number(r.score.toFixed(3)) })) };
}

const MAX_REFERENCE_CHARS = 3200;

/**
 * The block that goes into the system prompt.
 *
 * Marked as data, in the same shape the rest of this codebase already uses for
 * anything that is reference material rather than instruction — because plan rows
 * contain model-written prose and a member's own notes, and a retrieved document is
 * the one place a reply can pick up somebody else's imperative sentence. `<` is
 * escaped so no document can close the fence it arrived in.
 */
function referencesBlock(result, { maxChars = MAX_REFERENCE_CHARS } = {}) {
  const all = (result && result.docs) || [];
  if (!all.length) return '';
  // The absence note is spent first, whatever else the budget has to give up. It is
  // the last document in the ranking (it scores nothing) and the only one that stops
  // the model inventing a Settings screen: on "can the app read my blood results",
  // the ten notes that DID match pushed it past the character cap and the member got
  // an confident wrong tour of a feature that does not exist.
  const docs = [...all.filter((d) => d.never), ...all.filter((d) => !d.never)];
  const lines = [];
  let used = 0;
  for (const doc of docs) {
    const line = `- [${doc.id}] ${doc.title}: ${doc.text}`;
    if (used + line.length > maxChars) break;
    used += line.length;
    lines.push(line);
  }
  if (!lines.length) return '';
  return `<reference_notes>
${lines.join('\n').replace(/</g, '\\u003c')}
</reference_notes>
These notes were written and checked by this app, not by you. Use them as the factual backbone of your answer: their dosages, their cautions, their evidence sentences, and their statements about what the app can and cannot do. Say them in your own words for the member in front of you. Do not add a figure, source, outcome or app capability that is not in a note or in the member's own message. When no note covers something, say plainly that you do not know it rather than reasoning outward from what sounds typical.`;
}

module.exports = {
  retrieve,
  referencesBlock,
  expandQuestion,
  ALIASES,
  FEATURE_QUESTION,
};
