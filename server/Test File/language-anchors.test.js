/**
 * The Filipino layer, pinned.
 *
 * Run: node --test "Test File/language-anchors.test.js"
 *
 * WHY THIS FILE EXISTS
 * Every text check in this app was written against English, and `utils/languageAnchors.js`
 * is the bridge that lets a member writing Tagalog, Cebuano, Hiligaynon, Ilocano or Taglish
 * reach those checks. A bridge is exactly the kind of code that decays silently: an anchor
 * whose regex stops firing costs nothing, breaks nothing, and produces a reply that reads as
 * though the member had said something unrelated. Nothing downstream errors. So each of the
 * four consumers the bridge feeds is asserted here through its own real entry point —
 * `retrieve()` for evidence, `getSeverityTier()`/`analyzeSeverity()` for safety,
 * `classifyOffTopic()` for the pre-filter — rather than against the anchor table alone.
 *
 * THE INVARIANTS THAT MATTER
 * 1. Coverage: every anchor id has a phrasing a real member writes, and that phrasing fires it.
 * 2. The English invariant: an English message fires NO anchor, so anchoring is a byte-for-byte
 *    no-op for the majority of traffic. If this ever fails, the bridge is translating English
 *    into Filipino-graded query terms and every ranking downstream silently changes.
 * 3. Grounding: the Filipino phrasing must reach the note this app actually published about
 *    that topic. This is pinned per topic rather than as a similarity score, because the first
 *    version of this test caught eight anchors that fired correctly and then retrieved the
 *    wrong document — "loss of consciousness" ranking above the symptom because `loss` also
 *    titles the Hair Loss note. A similarity threshold cannot see that; an expected document
 *    id can.
 * 4. Safety erring wide: an anchor tagged `safety` must actually escalate the member, because
 *    the asymmetry is documented in the rule engine — an over-flag costs an admin a look, a
 *    missed flag costs a member their emergency response.
 * 5. Independence from the guess: anchoring never consults `detectLanguage()`. A fuzzy language
 *    estimate may choose which language the REPLY is written in; it must never decide whether a
 *    sentence about not breathing is readable.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ANCHORS, ANCHOR_BY_ID, CATEGORIES,
  matchedAnchors, anchorText, hasHealthAnchor,
} = require('../utils/languageAnchors');
const { retrieve } = require('../utils/ragRetriever');
const { buildCorpus, tokens } = require('../utils/ragCorpus');
const { getSeverityTier, analyzeSeverity } = require('../utils/severity');
const { classifyOffTopic } = require('../utils/offTopicFilter');
const { detectLanguage, isPhilippineCode } = require('../utils/language');

/** One phrasing per anchor, written the way a member writes it — particles and all. */
const CASES = [
  { id: 'fil-sleep', text: 'hirap po akong matulog gabi-gabi' },
  { id: 'ceb-sleep', text: 'lisod ko makatulog' },
  { id: 'ilo-war-sleep', text: 'saan pay akon makatulog' },
  { id: 'fil-fatigue', text: 'walang akong lakas kahapon gabi' },
  { id: 'bisaya-fatigue', text: 'kapoy gid kaayo ko' },
  { id: 'fil-breathing', text: 'nangangahanga ako pagkatapos maglakad' },
  { id: 'ceb-breathing', text: 'dili ko makaginhawa' },
  { id: 'fil-chest', text: 'bigat ng dibdib ko' },
  { id: 'fil-heart', text: 'mabilis ang tibok ng puso ko' },
  { id: 'fil-crisis', text: 'ayoko na mabuhay' },
  { id: 'bisaya-crisis', text: 'gusto nako mawala' },
  { id: 'fil-unconscious', text: 'nawalan siya ng malay kahapon' },
  { id: 'fil-numbness', text: 'namamanhid ang kamay ko' },
  { id: 'fil-stroke-signs', text: 'bangis ang mukha niya' },
  { id: 'fil-severe', text: 'grabe ang sakit ng tiyan ko' },
  { id: 'fil-bleeding', text: 'dumudugo pa ang sugat' },
  { id: 'fil-blood-urine', text: 'may dugo ang aking ihi' },
  { id: 'fil-blood-stool', text: 'may dugo sa aking dumi' },
  { id: 'fil-blood-cough', text: 'may dugo ang aking ubo' },
  { id: 'fil-headache', text: 'sumasakit ang ulo ko' },
  { id: 'fil-dizzy', text: 'nangingilo ako kapag bumangon' },
  { id: 'fil-eyes', text: 'malabo ang paningin ko' },
  { id: 'fil-ear', text: 'sakit ang tainga ko' },
  { id: 'fil-brain-fog', text: 'hindi ko makapag-focus sa trabaho' },
  { id: 'fil-stomach', text: 'sakit ng tiyan ko' },
  { id: 'fil-gerd', text: 'hareri ako pagkatapos kumain' },
  { id: 'fil-diarrhea', text: 'tuloy-tuloy ang dumi ko' },
  { id: 'fil-constipation', text: 'raot ako ng ilang araw' },
  { id: 'fil-vomit', text: 'nagsusuka ako umaga' },
  { id: 'fil-bloating', text: 'sukob ako pagkatapos kumain' },
  { id: 'fil-appetite', text: 'walang akong gutom' },
  { id: 'fil-fever', text: 'nilalagnat ako nang walang dahilan' },
  { id: 'fil-cold-cough', text: 'may ubo at sipon ako' },
  { id: 'fil-immunity', text: 'madalas akong masakit' },
  { id: 'fil-muscle-joint', text: 'sakit ng mga kasuka ko' },
  { id: 'fil-knee', text: 'sakit ng tuhod ko nang matinding pagbangon' },
  { id: 'fil-teeth', text: 'sakit ang mga ngipin ko' },
  { id: 'fil-skin', text: 'pangangati ng balat ko' },
  { id: 'fil-hair', text: 'buhok ko nanlalaglag' },
  { id: 'fil-swelling', text: 'namamaga ang mata ko' },
  { id: 'fil-anxiety', text: 'kaba ako walang dahilan' },
  { id: 'fil-mood', text: 'lungkot ko araw-araw' },
  { id: 'fil-stress', text: 'bigat ng isip ko' },
  { id: 'fil-hypertension', text: 'mataas ang presyon ko' },
  { id: 'fil-diabetes', text: 'tanggaw ko po' },
  { id: 'fil-thirst', text: 'laging umiihi ako sa gabi' },
  { id: 'fil-cholesterol', text: 'mataas ang kolesterol ko' },
  { id: 'fil-thyroid', text: 'sakit ang leeng ko' },
  { id: 'fil-kidney', text: 'may bato sa batugana ko' },
  { id: 'fil-liver', text: 'dilaw ng mukha ko' },
  { id: 'fil-asthma', text: 'parang astma ako' },
  { id: 'fil-anemia', text: 'maputla ang mukha ko' },
  { id: 'fil-allergy', text: 'alerhiya ko sa gatas' },
  { id: 'fil-pregnancy', text: 'buntis ako, anong pwede kumain' },
  { id: 'fil-period', text: 'hindi regular ang regla ko' },
  { id: 'fil-weight', text: 'gusto kong bawasan ang timbang ko' },
  { id: 'fil-cancer', text: 'kanser ba ang dahilan nito' },
  { id: 'fil-dengue', text: 'dengue ba yan' },
  { id: 'fil-arthritis', text: 'artiris ang nakikita ko sa sarili' },
  { id: 'fil-medication', text: 'uto ang gamot ko kanina' },
  { id: 'fil-side-effect', text: 'masama ang gamot sa tiyan ko' },
  { id: 'fil-dose-question', text: 'gaano kadamot ko ito' },
  { id: 'fil-labs', text: 'saan ang resulta ko' },
  { id: 'fil-login', text: 'hindi ako makapasok sa account ko' },
  { id: 'fil-password-reset', text: 'nakalimutan ko password ko' },
  { id: 'fil-app-nav', text: 'saan ang aking dashboard' },
  { id: 'fil-plan-track', text: 'i-mark ko ba ang dose ko' },
  { id: 'fil-reminder', text: 'paalala nyo ako sa gamot ko' },
  { id: 'fil-support', text: 'kailangan ko ng tulong' },
  { id: 'fil-billing', text: 'magkano ang bayad ko' },
  { id: 'fil-assessment', text: 'paano kukumpletuhin ang tselist' },
  { id: 'fil-can-i', text: 'pwede ba i-sync ang apple watch ko' },
  { id: 'fil-how-do', text: 'paano ko gagamitin ito' },
  { id: 'fil-diagnosis-ask', text: 'sabi mo na lang anong sakit ko' },
];

/**
 * The document this app published about each topic, which the Filipino phrasing must reach.
 * Pinned by id, not by similarity: the first run of this test passed every "did it retrieve
 * anything" check while handing a fainting story to the Hair Loss note and an itchy face to
 * Dry Skin. Only the topics whose evidence genuinely exists here are listed.
 */
const EXPECTS = {
  'fil-sleep': 'symptom:Sleep Disturbances',
  'ceb-sleep': 'symptom:Sleep Disturbances',
  'ilo-war-sleep': 'symptom:Sleep Disturbances',
  'fil-fatigue': 'nutrient:Iron',
  'bisaya-fatigue': 'nutrient:Iron',
  'fil-breathing': 'condition:Sleep Apnea (Snoring / Paused Breathing)',
  'ceb-breathing': 'condition:Sleep Apnea (Snoring / Paused Breathing)',
  'fil-chest': 'condition:Heart / Cardiovascular Disease',
  'fil-heart': 'condition:Heart / Cardiovascular Disease',
  'fil-unconscious': 'symptom:Muscle Weakness',
  'fil-numbness': 'symptom:Muscle Weakness',
  'fil-stroke-signs': 'symptom:Muscle Weakness',
  'fil-severe': 'symptom:Upper Abdominal Burning',
  'fil-bleeding': 'nutrient:Iron',
  'fil-blood-cough': 'symptom:Frequent Colds / Low Immunity',
  'fil-headache': 'condition:Migraine',
  'fil-dizzy': 'condition:Hypertension (High Blood Pressure)',
  'fil-eyes': 'nutrient:Vitamin A',
  'fil-brain-fog': "nutrient:Lion's Mane",
  'fil-stomach': 'symptom:Upper Abdominal Burning',
  'fil-gerd': 'condition:GERD / Acid Reflux (Suan)',
  'fil-diarrhea': 'condition:IBS (Irritable Bowel Syndrome)',
  'fil-constipation': 'condition:IBS (Irritable Bowel Syndrome)',
  'fil-vomit': 'nutrient:Probiotics',
  'fil-bloating': 'nutrient:Probiotics',
  'fil-fever': 'symptom:Frequent Colds / Low Immunity',
  'fil-cold-cough': 'symptom:Frequent Colds / Low Immunity',
  'fil-immunity': 'symptom:Frequent Colds / Low Immunity',
  'fil-muscle-joint': 'symptom:Joint Pain',
  'fil-knee': 'symptom:Joint Pain',
  'fil-teeth': 'nutrient:Calcium',
  'fil-skin': 'symptom:Skin Rashes / Flare-ups',
  'fil-hair': 'symptom:Hair Loss',
  'fil-swelling': 'symptom:Joint Swelling',
  'fil-anxiety': 'symptom:Anxiety / Stress',
  'fil-mood': 'condition:Depression',
  'fil-stress': 'symptom:Anxiety / Stress',
  'fil-hypertension': 'condition:Hypertension (High Blood Pressure)',
  'fil-diabetes': 'condition:Diabetes',
  'fil-thirst': 'condition:Diabetes',
  'fil-cholesterol': 'nutrient:Omega-3 / Fish oil',
  'fil-thyroid': 'condition:Thyroid Disorders',
  'fil-kidney': 'symptom:Flank / Side Pain',
  'fil-liver': 'condition:Liver Disease',
  'fil-asthma': 'symptom:Frequent Colds / Low Immunity',
  'fil-anemia': 'nutrient:Iron',
  'fil-allergy': 'symptom:Skin Rashes / Flare-ups',
  'fil-pregnancy': 'nutrient:Folate',
  'fil-period': 'condition:PCOS',
  'fil-weight': 'condition:Obesity',
  'fil-dengue': 'symptom:Frequent Colds / Low Immunity',
  'fil-arthritis': 'condition:Arthritis',
  'fil-labs': 'app:core-pages',
  'fil-login': 'app:account',
  'fil-password-reset': 'app:account',
  'fil-app-nav': 'app:core-pages',
  'fil-plan-track': 'app:tracking',
  'fil-reminder': 'app:tracking',
  'fil-assessment': 'app:assessment',
  // A capability question in Filipino must reach the note that says what the app cannot
  // do, or the model invents the feature.
  'fil-can-i': 'app:does-not-exist',
  'fil-how-do': 'app:does-not-exist',
  'fil-diagnosis-ask': 'app:does-not-exist',
};

/**
 * The honest gap list. The app publishes no evidence note on these topics, so the right
 * answer to "kanser ba ang dahilan nito" is the model saying it does not know — not a note
 * about something adjacent. The anchor still exists so the member is never DECLINED and is
 * always answered in their own language; asserting it retrieves NOTHING is what forces this
 * list to shrink deliberately (add the note, then remove the id) instead of letting an
 * anchor quietly pretend to have coverage.
 */
const NO_EVIDENCE = ['fil-cancer'];

/**
 * Plain English, including the phrasings that share a word with an anchor's shape
 * ("how do I track my plan", "can I get a reminder"), because that is where a bridge
 * that leans on English loanwords does its damage.
 */
const ENGLISH = [
  'how do i improve my sleep quality',
  'i feel tired all the time',
  "i can't breathe after climbing stairs",
  'what dose of magnesium is safe',
  'can the app read my blood results',
  'how do i track my plan',
  'can i get a reminder every morning',
  'i want to cancel my subscription',
  'where do i find my dashboard',
  'i forgot my password',
  'what are the side effects of zinc',
  'i have a headache and can barely sleep',
  'my blood sugar is high lately',
  'is there proof this actually works',
  'how often should i take vitamin d',
  'i have been feeling anxious',
  'can you write me a python script',
  'what is the weather today',
  'who won the nba finals',
  'tell me a joke',
];

/** Crisis sentences that must reach a Priority review, not merely a flag. */
const MUST_ESCALATE = [
  'gusto ko na lang mamatay',
  'ayoko na mabuhay',
  'wala na akong kwenta',
  'saktan ko ang sarili ko',
  'hindi ko na kaya ang buhay na to',
  'gusto nako mawala',
];

/** ANCHOR_BY_ID is a Map; indexing it like an object reads as "anchor no longer exists". */
const byId = (id) => ANCHOR_BY_ID.get(id);

test('the anchor table is well-formed and every category is one of the four declared', () => {
  assert.deepEqual([...CATEGORIES].sort(), ['app', 'health', 'retrieval', 'safety']);
  const ids = new Set();
  for (const a of ANCHORS) {
    assert.ok(a.id && !ids.has(a.id), `duplicate anchor id ${a.id}`);
    ids.add(a.id);
    assert.ok(a.re instanceof RegExp && a.re.source, `${a.id} needs a pattern`);
    assert.ok(a.en && a.en.trim().split(/\s+/).length >= 2, `${a.id} must add a phrase, not one word`);
    assert.ok(Array.isArray(a.cats) && a.cats.length, `${a.id} must declare which check it feeds`);
    for (const c of a.cats) assert.ok(CATEGORIES.includes(c), `${a.id} category ${c} is not declared`);
    assert.equal(byId(a.id), a, `${a.id} must be reachable by id`);
  }
});

test('every anchor is exercised by a phrasing a real member writes', () => {
  const sampled = new Set(CASES.map((c) => c.id));
  const missing = ANCHORS.map((a) => a.id).filter((id) => !sampled.has(id));
  const unknown = [...sampled].filter((id) => !byId(id));
  assert.deepEqual(unknown, [], 'a case would test an anchor that no longer exists');
  assert.deepEqual(missing, [], `${missing.length} anchor(s) have no phrasing in CASES and would decay unnoticed`);
});

test('each sampled phrasing fires the anchor it was written for', () => {
  const failures = [];
  for (const c of CASES) {
    const fired = matchedAnchors(c.text).map((a) => a.id);
    if (!fired.includes(c.id)) failures.push(`${c.id} <- "${c.text}" fired [${fired.join(', ')}]`);
  }
  assert.deepEqual(failures, [], `these Filipino phrasings reach no check:\n${failures.join('\n')}`);
});

test('English input fires no anchor, so anchoring is a byte-for-byte no-op there', () => {
  const offenders = [];
  for (const en of ENGLISH) {
    const fired = matchedAnchors(en);
    if (fired.length) offenders.push(`"${en}" fired ${fired.map((a) => a.id).join(', ')}`);
    assert.equal(anchorText(en, [...CATEGORIES]), en, `${en} must arrive at the checks unchanged`);
  }
  assert.deepEqual(offenders, [], 'an English message must not be re-weighted by a Filipino bridge');
});

test('the anchored text keeps the member words first', () => {
  // `^`-anchored rules in the pre-filter and the severity engine read the START of the
  // string; prepending a translation would silently kill every one of them.
  for (const c of CASES) {
    const anchored = anchorText(c.text, [...CATEGORIES]);
    assert.ok(anchored.startsWith(c.text), `${c.id}: anchoring must append, never replace or prepend`);
    if (NO_EVIDENCE.includes(c.id)) continue;
    assert.notEqual(anchored, c.text, `${c.id}: an anchor that fires must actually add its English form`);
  }
});

test('a Filipino question reaches the note this app published about that topic', () => {
  const nothing = [];
  const wrong = [];
  const unreported = [];
  for (const c of CASES) {
    const anchor = byId(c.id);
    // A crisis sentence is not a request for a supplement note. These anchors exist to
    // escalate, and retrieving nothing for them is the correct behaviour, not a miss.
    if (!anchor.cats.some((k) => k !== 'safety')) continue;
    const result = retrieve(c.text);
    if (NO_EVIDENCE.includes(c.id)) {
      if (result.docs.length) nothing.push(`${c.id}: "${c.text}" retrieves ${result.docs.length} note(s) — the corpus grew, update NO_EVIDENCE`);
      continue;
    }
    if (!result.docs.length) { nothing.push(`${c.id}: "${c.text}" retrieved nothing`); continue; }
    if (byId(c.id).cats.some((k) => k === 'retrieval' || k === 'health' || k === 'app') && !result.anchored.includes(c.id)) {
      unreported.push(`${c.id}: retrieved notes but did not report the anchor that produced them`);
    }
    const expected = EXPECTS[c.id];
    if (expected && !result.docs.some((d) => d.id === expected)) {
      wrong.push(`${c.id}: "${c.text}" topped out on ${result.docs[0].id}, expected ${expected}`);
    }
  }
  assert.deepEqual(unreported, [], `the retrieval result stopped saying which bridge fired:\n${unreported.join('\n')}`);
  assert.deepEqual(nothing, [], `firing but grounding nothing is the silent half of a retrieval miss:\n${nothing.join('\n')}`);
  assert.deepEqual(wrong, [], `the bridge handed the model evidence about a different complaint:\n${wrong.join('\n')}`);
});

test('no anchor points at a word the checks cannot see', () => {
  // A `retrieval`/`app`/`health` anchor must add at least one term the corpus actually
  // contains; a `safety` anchor must add a phrase the rule engine matches. Anything else
  // reads as coverage while the query still returns nothing.
  const corpusTokens = new Set();
  for (const doc of buildCorpus()) for (const t of tokens(`${doc.title} ${doc.text} ${(doc.keys || []).join(' ')}`)) corpusTokens.add(t);
  const dead = [];
  for (const c of CASES) {
    const anchor = byId(c.id);
    const enTokens = tokens(anchor.en);
    if (anchor.cats.includes('safety')) {
      const tier = getSeverityTier({ feelingDescription: anchorText(c.text, ['safety', 'health']) });
      if (!tier) dead.push(`${c.id}: safety form "${anchor.en}" flags nothing`);
      continue;
    }
    if (NO_EVIDENCE.includes(c.id)) continue;
    if (!enTokens.some((t) => corpusTokens.has(t))) dead.push(`${c.id}: "${anchor.en}" matches no document in the corpus`);
  }
  assert.deepEqual(dead, [], `dead anchors:\n${dead.join('\n')}`);
});

test('a symptom named in Filipino escalates the review the same way English does', () => {
  const missed = [];
  for (const c of CASES) {
    if (!byId(c.id).cats.includes('safety')) continue;
    const raw = getSeverityTier({ feelingDescription: c.text });
    const bridged = getSeverityTier({ feelingDescription: anchorText(c.text, ['safety', 'health']) });
    if (!bridged) missed.push(`${c.id}: "${c.text}" was not flagged at all`);
    if (raw && bridged === null) missed.push(`${c.id}: anchoring made a flagged sentence unflagged`);
  }
  assert.deepEqual(missed, [], `safety anchors that do not reach the rule engine:\n${missed.join('\n')}`);
});

test('a crisis written in Filipino reaches a Priority review', () => {
  for (const text of MUST_ESCALATE) {
    const result = analyzeSeverity({ feelingDescription: text });
    assert.equal(result.flagged, true, `"${text}" must flag`);
    assert.equal(result.tier, 'critical', `"${text}" must escalate, got ${result.tier}`);
  }
});

test('a crisis written in English reaches the same Priority review', () => {
  // The counterpart to the test above, and the reason utils/severity.js exports
  // CRISIS_PHRASES instead of leaving the wording inside one regex: "I want to harm
  // myself" and "I want to end my life" named no needle in
  // `suicid|self.harm|hopeless|want to die`, so the member whose own words are the
  // clearest possible emergency got a supplement plan and no flag.
  const MUST_ESCALATE_EN = [
    'I feel like I want to die',
    'I want to harm myself',
    'I want to end my life',
    'I keep thinking about killing myself',
    'I am hopeless, there is no reason to live',
  ];
  for (const text of MUST_ESCALATE_EN) {
    const result = analyzeSeverity({ feelingDescription: text });
    assert.equal(result.tier, 'critical', `"${text}" must escalate, got ${result.tier}`);
  }
});

test('the pre-filter never declines a health question asked in Filipino', () => {
  const declined = [];
  for (const c of CASES) {
    const verdict = classifyOffTopic(c.text);
    if (verdict.offTopic) declined.push(`"${c.text}" declined by rule ${verdict.rule}`);
  }
  assert.deepEqual(declined, [], `a false decline costs the member an answer they were entitled to:\n${declined.join('\n')}`);
  assert.equal(hasHealthAnchor('sakit ng ulo ko'), true);
  assert.equal(hasHealthAnchor('who won the nba finals'), false);
});

test('anchoring does not wait for the language guess', () => {
  // `detectLanguage()` is a heuristic and may only pick the REPLY language. The bridge is
  // keyed on word pairs, so it fires whatever the guesser says — this asserts the two are
  // independent, with the guesser's own coverage reported as a floor, not a gate.
  let philippine = 0;
  for (const c of CASES) {
    const fired = matchedAnchors(c.text).map((a) => a.id);
    assert.ok(fired.includes(c.id), `${c.id} must fire regardless of the language guess`);
    if (isPhilippineCode(detectLanguage(c.text).code)) philippine++;
  }
  assert.ok(philippine >= CASES.length * 0.6, `the detector recognised only ${philippine}/${CASES.length} phrasings`);
});
