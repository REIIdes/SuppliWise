'use strict';

/**
 * FILIPINO AND PHILIPPINE-LANGUAGE ANCHORS — HOW A TAGALOG SENTENCE REACHES AN
 * ENGLISH-WRITTEN CHECK WITHOUT ANY ENGLISH CHECK BEING WEAKENED.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
 * Every text check in this product is written in English, and each one was written
 * that way for a reason worth keeping:
 *
 * - utils/ragRetriever.js expands a question through `ALIASES`, every regex of which
 *   is English, then folds terms with a `[^a-z0-9\s-]` tokenizer. "hirap po akong
 *   matulog" produces terms that occur in no document, so retrieval returns nothing
 *   and the reply is generated UNGROUNDED — the exact path where the model is told
 *   to cite nothing and the accuracy gate scores recall 0.
 * - utils/severity.js looks for needles like "can't breathe" with `String.includes`.
 *   "hindi ako makapag-hinga" contains none of them, so a member describing a
 *   life-threatening symptom was NOT flagged Priority. That is the worst bug this
 *   module exists to close.
 * - utils/offTopicFilter.js, routes/recommend.js and the `offlineFallback` in
 *   routes/chat.js all match English words for the same reason.
 *
 * ── WHY ANCHOR THE QUERY INSTEAD OF TRANSLATING THE CHECKS ───────────────────
 * The alternative — rewriting every needle list bilingually — was rejected on three
 * grounds. (1) Those lists are load-bearing for other subsystems and pinned by tests
 * that assert exact English strings (Test File/recommendation-plain-language.test.js,
 * Test File/rag-retrieval.test.js); adding foreign alternatives into them changes what
 * a verifier matches on, which is how a guard silently dies. (2) The evidence corpus is
 * English and stays English — its notes were checked against PubMed as written, and a
 * translated note is an unchecked note (utils/ragCorpus.js). (3) Retrieval may only
 * ever ADD query terms, never make a document claim something it does not say;
 * appending English equivalents to the query is exactly that addition, and nothing
 * else.
 *
 * So the rule is: the check keeps its English, and a member's Filipino text arrives
 * carrying the English words the check is looking for. The original words stay in the
 * text too — anchoring never replaces, and it always APPENDS, never prepends, because
 * the off-topic rules and `offlineFallback` are `^`-anchored and a prefix would make
 * every one of them dead.
 *
 * ── WHAT AN ANCHOR IS NOT ───────────────────────────────────────────────────
 * It is not a translator. Only phrasings this product's own screens, questionnaire and
 * research interviews actually encounter are listed, and each one maps to English that
 * already exists in the subsystem it is fed to — an ALIASES trigger in ragRetriever, a
 * needle in severity, a branch in offlineFallback. An anchor whose English reaches
 * nothing would read as coverage while the question still returns nothing, which is
 * the invisible half of a retrieval miss; `Test File/language-anchors.test.js` asserts
 * the target instead of trusting the intent.
 *
 * An unmapped Filipino sentence is simply not anchored, and the reply-language
 * instruction in the prompt still answers it in Filipino. A missing anchor costs
 * retrieval, never the member's language.
 *
 * ── THE ONE RULE EVERY PATTERN BELOW OBEYS ──────────────────────────────────
 * An anchor fires only on a word that cannot mean anything else (`lagnat`, `buntis`,
 * `nhagas`), or on a PAIR — symptom word plus body part, intensity word plus pain word,
 * difficulty word plus sleep word. A pattern whose tail is optional is a pattern that
 * fires on "grabe" alone and flags a Priority review for an exclamation. That is why
 * every span here ends in a required noun or verb, and why the same span is bounded
 * (`[^.\n]{0,20}?`) rather than `.*`: an unbounded window glues two unrelated sentences
 * into one symptom, and a lazy `.*` over a long message is how a request thread never
 * comes back.
 *
 * ── WHY DIALECT COVERAGE IS DELIBERATELY NARROW ─────────────────────────────
 * Tagalog gets a wide set because it is what this product's members write. Cebuano,
 * Hiligaynon, Bikol, Ilocano, Kapampangan, Pangasinan and Waray get crisis phrasing and
 * a handful of high-confidence symptoms. The reason is asymmetry, not laziness: English
 * injected for a word that does NOT mean it makes retrieval confidently answer a
 * question nobody asked, and a wrong health claim is worse than no health claim. So
 * `gugma` ("love", not a thyroid word) and `ate` ("sister", not only "liver") are not
 * anchors on their own. Where Tagalog and a Bisaya language share the content word, the
 * PREPOSITION is the evidence and is required: `sakit ng ulo` is Tagalog, `sakit sa ulo`
 * is Cebuano, and both are headache.
 *
 * `categories` decide which consumers may use which anchors, because a health word
 * injected into a navigation branch would send a symptom description to the History
 * page:
 * - `retrieval` — feeds query expansion (ragRetriever) and the app-feature guide.
 * - `safety`     — crisis and emergency phrasing (severity, priority flagging).
 * - `health`     — the rule engine's vocabulary: symptoms, conditions, medications,
 *                  pregnancy, allergies, dose words (routes/recommend.js).
 * - `app`        — navigation vocabulary for the off-topic filter and fallbacks.
 */

const { prepare } = require('./language');

/** Every anchor declares at least one of these; a consumer asks for the ones it wants. */
const CATEGORIES = ['retrieval', 'safety', 'health', 'app'];

const ANCHORS = [
  // ── SLEEP ────────────────────────────────────────────────────────────────────
  {
    id: 'fil-sleep',
    // "hindi akong matulog", "hirap po akong matulog", "gising-gising ako toda gabi"
    re: /\bhirap\s+(?:\w+\s+){0,2}?(?:pagtulog|matulog|mamatulog|tulog)\b|\bwala\s+(?:\w+\s+){0,2}?(?:tulog|pagtulog|matulog)\b|\b(?:hindi|di|hy)\s+(?:\w+\s+){0,2}?(?:makatulog|makapag[-\s]?tulog|makapagtulog|matulog|mamatulog|gising|mabangon|puyat|paga)\b|\bgising-gising\b|\bmaraming\s+gising\b|\bmadalas\s+gumising\b/i,
    en: 'difficulty sleeping insomnia poor sleep quality restless night',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'ceb-sleep',
    // "dili ko makatulog", "lisod nakaog makatulog"
    re: /\b(?:dili|indi|lisod|nabudlay|lisud)\s+(?:\w+\s+){0,2}?(?:makatulog|matulog|katulog|turog|mahulog|pagkatulog|pagkaturog)\b/i,
    en: 'difficulty sleeping insomnia poor sleep quality',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'ilo-war-sleep',
    // "saan pay makatulog" (Ilocano), "nabudlay akon matulog" (Waray)
    re: /\b(?:saan|haan)\s+(?:\w+\s+){0,3}?(?:matulog|makatulog|ipagtulog|natulog)\b|\bnabudlay\s+(?:\w+\s+){0,2}?(?:matulog|natulog|pagkatulog)\b/i,
    en: 'difficulty sleeping insomnia poor sleep quality',
    cats: ['retrieval', 'health'],
  },

  // ── ENERGY ───────────────────────────────────────────────────────────────────
  {
    id: 'fil-fatigue',
    // "pagod na pagod ako", "walang lakas", "kahina ng katawan"
    re: /\b(?:pagod|napapagal)\b|\bwalang\s+(?:akong|aking|aming|nating|ninyo|ako\s+ng|niya|ila\s+ng)?\s*(?:lakas|energy|buo|kusang|kusog|gusto\s+huminga)\b|\bkulang\s+sa\s+(?:lakas|kusog|energy)\b|\bkahina(?:n)?\s+ng\s+(?:katawan|buong\s+katawan|isip)\b/i,
    en: 'tired fatigue low energy exhausted weakness',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'bisaya-fatigue',
    // "kapoy kaayo ko", "guba ang lawas", "kulang sa kusog"
    re: /\b(?:kapoy|kapoyan)\b|\bguba\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*lawas\b|\bkulang\s+sa\s+kusog\b/i,
    en: 'tired fatigue low energy exhausted weakness',
    cats: ['retrieval', 'health'],
  },

  // ── BREATHING & CHEST (safety-critical) ──────────────────────────────────────
  {
    id: 'fil-breathing',
    // "hindi ako makapaghinga", "hirap sa paghinga", "nangangahanga ako", "nahuhupaw"
    re: /\b(?:hindi|di|hirap|lisod|kulang|wala|nabudlay)\b[^.\n]{0,20}?(?:makapag-?hinga|makahinga|paghinga|paghinzo|huminga|hinga|ginhawa)\b|\bnangangahanga\w*\b|\b(?:nahuhupaw|huhupaw|hupaw)\b/i,
    en: "unable to breathe difficulty breathing shortness of breath can't breathe wheezing",
    cats: ['safety', 'retrieval', 'health'],
  },
  {
    id: 'ceb-breathing',
    // "dili ko makaginhawa", "wala akoy ginhawa", "nagahupaw ko"
    re: /\b(?:dili|indi|lisod|nabudlay|wala|kulang)\b[^.\n]{0,20}?(?:makaginhawa|paginhawa|ginhawa|makahinga|hinga)\b|\bnagahupaw\b|\bhupaw\b/i,
    en: 'unable to breathe difficulty breathing shortness of breath wheezing',
    cats: ['safety', 'retrieval', 'health'],
  },
  {
    id: 'fil-chest',
    // "sakit ng dibdib ko", "bigat sa dibdib", "pinipigil ang aking dibdib"
    re: /\b(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|pananakit|bigat|pipigil|pikit|kirot|giit|hapdi)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+|buong\s+)?(?:dibdib|baga|pecho|tsesso|apog)\b|\b(?:dibdib|baga|pecho)\b[^.\n]{0,14}?(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|bigat|kirot|hapdi|piril)\b/i,
    en: 'chest pain heart cardiovascular pressure tightness',
    cats: ['safety', 'retrieval', 'health'],
  },
  {
    id: 'fil-heart',
    // "pabilis ang tibok ng puso", "pangingilabot", "sakit ng puso"
    re: /\bpangingilabot\b|\bkabog\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*puso\b|\b(?:pabilis|abilis|mabilis|bagbag|bilis-bilis)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:tibok|pagtibok|puso)\b|\bsakit\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+(?:aking\s+)?puso\b|\b(?:atake|ataque)\s+(?:sa\s+)?(?:puso|heart)\b/i,
    en: 'heart palpitations rapid heartbeat chest pain heart',
    cats: ['safety', 'retrieval', 'health'],
  },

  // ── CRISIS (safety-critical) ────────────────────────────────────────────────
  {
    id: 'fil-crisis',
    // "gusto kong mamatay", "ayoko na mabuhay", "saktan ko ang sarili ko",
    // "hindi ko na kaya ang buhay", "wala na akong kwenta", "pagod na pagod ako sa lahat"
    re: /\b(?:gusto|ais|ibig|pili|plano|desisyon)\s+(?:\w+\s+){0,4}?(?:mamatay|magpakamatay|mag?-?patay\s+(?:sa\s+)?(?:akes|sarili|ako)|pumatay\s+(?:sa\s+)?(?:akes|sarili|ako))\b|\b(?:ayaw|ayoko|wala\s+na\s+(?:akong|gusto))\s+(?:\w+\s+){0,2}?mabuhay\b|\bhindi\s+(?:ko|gusto)\s+mabuhay\b|\bmawala\s+na\s+ako\b|\btapusin\s+(?:ko\s+)?(?:ang|na\s+ang)\s+(?:buhay|kinabuhayan|lahat)\b|\b(?:saktan|bugbog|gago|hiwa)\s+(?:ko\s+(?:ang\s+)?)?(?:sarili|sarile)(?:\s+ko)?\b|\bhindi\s+(?:ko|ako)\s+(?:\w+\s+){0,3}?kaya\b[^.\n]{0,24}?(?:buhay|lahat|ng\s+lahat|isang\s+araw|gising|magtagal)\b|\bpagod\s+na\s+pagod\s+ako\s+(?:na\s+)?(?:sa\s+(?:buhay|lahat|ng\s+lahat|tanang|salang|lahat))\b|\bwala\s+na\s+(?:akong|saking|ako\s+ng)\s+(?:kwenta|halaga|pag-asa)\b/i,
    en: 'suicidal thoughts self-harm want to die',
    cats: ['safety'],
  },
  {
    id: 'bisaya-crisis',
    // "gusto nako nga mamatay" (Cebuano), "dili nako kaya ang kinabuhi" (Bisaya),
    // "wala nay paglaom" (there is no hope left)
    re: /\bgusto\s+(?:nako|ko|tao\s+nako|sige\s+nako)\s+(?:gayod\s+|man\s+|nga\s+|usab\s+)?(?:mamatay|magpakamatay|mawala)\b|\bgugma\s+nako\s+mamatay\b|\bdili\s+(?:nako|ko|tao\s+nako)\s+kaya\s+(?:ang\s+)?(?:kinabuhi|kabuhi|tanang\s+butang)\b|\bwala\s+(?:nay|nakoy|ko\s+y|ako\s+y)\s+(?:paglaom|halaga)\b/i,
    en: 'suicidal thoughts self-harm want to die',
    cats: ['safety'],
  },
  {
    id: 'fil-unconscious',
    // "nawalan siya ng malay", "mimista ako", "bigla akong nahulog"
    re: /\bnawalan\s+(?:\w+\s+){0,2}?(?:ng|sa|nit|man)?\s*malay\b|\bnagpapawalan\s+(?:\w+\s+){0,2}?(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*malay\b|\b(?:mimista|magmimista|naiyap)\b|\bbigla\s+(?:akong|ko|nako|niya)\s+(?:nahulog|matumba|matarang|nakalutang)\b/i,
    en: 'passing out fainting feeling faint dizzy weakness',
    cats: ['safety', 'retrieval', 'health'],
  },
  {
    id: 'fil-numbness',
    // "namamanhid ang kamay ko", "hindi ko magalaw ang kaliwang bahagi"
    re: /\b(?:manhid|namamanhid|pangingilan|ngalay|ngalngalay)\b|\bhindi\s+(?:ko|nako|niya|siya)\s+(?:kaya\s+)?(?:mag-?galaw|galawin|pag-?galaw|paglihok)\b[^.\n]{0,20}?(?:kaliwa|kanan|kamay|paa|binti|hika|bahagi|malata|buong\s+katawan)\b/i,
    en: 'numbness weakness',
    cats: ['safety', 'retrieval', 'health'],
  },
  {
    id: 'fil-stroke-signs',
    // "bangis ang mukha niya", "hindi niya mapagsalitan nang malinaw", "baluktot ang salita"
    re: /\b(?:bangis|pansing|baluktot|pangi|gumuguho)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+|niya\s+)?(?:mukha|nguso|salita|dila|bigkas)\b|\b(?:mukha|nguso)\b[^.\n]{0,16}?(?:bangis|baluktot|gumuguho|nagbangis)\b|\bhindi\s+(?:niya|ko|nako|siya|makapag|ma-)?\s*(?:malinaw|maayos|linaw|ayos)?\s*(?:magsalita|makapagsalita|pagsalita|bigkas)\b/i,
    en: 'facial drooping slurred speech sudden weakness',
    cats: ['safety', 'retrieval', 'health'],
  },
  {
    id: 'fil-severe',
    // "grabe ang sakit ng tiyan", "sobrang sakit", "hindi ko na matiis"
    re: /\b(?:grabe|sobrang|matindi|lubha|napakalakas|indi\s+matiis|hindi\s+(?:ko|nako|niya|tao\s+nako)?\s*(?:na\s+)?matiis)\b[^.\n]{0,24}?(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|pananakit|kirot|hapdi|paninikip)\b|\b(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|pananakit|kirot|hapdi)\b[^.\n]{0,24}?(?:grabe|sobrang|matindi|lubha|napakalakas|matiis|dili\s+matiis)\b/i,
    en: 'severe pain extreme pain',
    cats: ['safety', 'retrieval', 'health'],
  },
  {
    id: 'fil-bleeding',
    // "tuloy-tuloy ang pagdurugo", "hindi mapigil ang dugo"
    re: /\b(?:dumudugo|nagdudugo|nag-dudugo|pagdurugo|dudugo)\b|\btuloy-tuloy\s+(?:na\s+)?(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*dugo\b|\bhindi\s+(?:mapigil|matigil|tigilan)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*dugo\b/i,
    en: 'bleeding heavily bleeding iron weakness',
    cats: ['safety', 'retrieval', 'health'],
  },
  {
    id: 'fil-blood-urine',
    // "may dugo sa aking ihi" — the needle this must reach is severity's exact
    // 'blood in urine', not a loose paraphrase, so nothing here is invented.
    re: /\bdugo\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+(?:aking\s+|iyak\s+|mga\s+)?(?:ihi|pag-ihi)\b/i,
    en: 'blood in urine',
    cats: ['safety', 'retrieval', 'health'],
  },
  {
    id: 'fil-blood-stool',
    re: /\bdugo\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+(?:aking\s+|mga\s+)?(?:dumi|labad|likaw|dila\s+ng\s+likaw)\b/i,
    en: 'blood in stool',
    cats: ['safety', 'retrieval', 'health'],
  },
  {
    id: 'fil-blood-cough',
    re: /\bdugo\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+(?:aking\s+|mga\s+)?(?:ubo|tiksi|bibig|baba|hinina)\b/i,
    en: 'coughing blood',
    cats: ['safety', 'retrieval', 'health'],
  },

  // ── HEAD, EYES, EARS ────────────────────────────────────────────────────────
  {
    id: 'fil-headache',
    // "sakit ng ulo ko", "bigat ng noo", "umiilog ang ulo", "may semi ako"
    re: /\b(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|pananakit|bigat|kirot|nimulod|sumisikit|bilog|pijit|hapdi)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+|buong\s+)?(?:ulo|noo|tikod|leeg|palad\s+ng\s+ulo)\b|\b(?:ulo|noo)\b[^.\n]{0,12}?(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|bigat|kirot|nimulod)\b|\b(?:umiilog|namumula)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?(?:ulo|noo)\b|\bmigraine\b|\bsemi\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s*ulo\b/i,
    en: 'headache severe headache migraine',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-dizzy',
    // "nakakahi​lo", "nangingilo ako", "parang umiikot ang lahat", "barog ko" (Cebuano)
    re: /\b(?:nangingilo|nakakahilo|nahihinilo|nauuhilo|mailo|naiilo)\b|\bumiikot\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:paligid|lahat|kapaligid|ulo)\b|\b(?:barog|nagbarog|lawod|nilalawod|likalical|nalilikalical)\b/i,
    en: 'dizziness weakness iron deficiency low blood pressure',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-eyes',
    // "panit ng mata", "malabo ang paningin ko", "sakit ng mata"
    re: /\b(?:panit|pagpanit|angas|kapal|pagkapal|kati|pamamaga)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?(?:mata|screen|computer)\b|\b(?:malabo|mahina|labo|damang)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?(?:paningin|vision|mata)\b|\bsakit\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+(?:aking\s+)?mata\b/i,
    en: 'eye strain blurry vision screens vitamin a',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-ear',
    // "sakit ng tainga ko", "inig", "bunot", "nangingibing ako"
    re: /\b(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|pananakit|kati|namamaga|dugo|inig|bunot)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?tainga\b|\b(?:inig|nanginginig\s+ng\s+tainga)\b|\b(?:bingi|nangingibing|bigla\s+na\s+bingi)\b/i,
    en: 'ear infection ear ringing hearing',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-brain-fog',
    // "malabo ang isip", "hindi ako makapag-focus", "mabilis makalimot"
    re: /\b(?:malabo|magulo|bogbog|balisa|mabigat)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?(?:isip|pag-iisip|pagsasalita\s+ng\s+isip)\b|\bpagkalimot\b|\bnangangalimot\b|\bmabilis\s+makalimot\b|\bhindi\s+(?:ko\s+)?(?:makapag-?focus|mag-?focus|kumonsentra|makonsentra|mag-?concentrate|matandaan)\b/i,
    en: 'brain fog difficulty concentrating memory mental clarity',
    cats: ['retrieval', 'health'],
  },

  // ── GUT ──────────────────────────────────────────────────────────────────────
  {
    id: 'fil-stomach',
    // "sakit ng tiyan", "sumasakit ang sikmura", "kirot ng baywang"
    re: /\b(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|pananakit|kirot|bigat|kumurug|kulog|hapdi|samakit|hirap)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+|buong\s+)?(?:tiyan|sikmura|baywang|barang|iyak|bara|ilalim\s+ng\s+tiyan)\b|\b(?:tiyan|sikmura|baywang|iyak|bara)\b[^.\n]{0,14}?(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|kirot|hirap|hapdi|bigat)\b/i,
    en: 'stomach pain abdominal pain digestive discomfort cramp',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-gerd',
    // "may suan ako", "nasusunog ang dibdib pagkatapos kumain", "pait ng lagay"
    re: /\b(?:suan|asnan|hapdit|hareri|haeri|akid)\b|\b(?:nasusunog|masusunog|sunog|paapugin)\b[^.\n]{0,20}?(?:dibdib|lagay|tiyan|mitswa|pera|sikmura)\b|\bpait\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+(?:lagay|dila|tiyan)\b/i,
    en: 'acid reflux heartburn gerd indigestion burning',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-diarrhea',
    re: /\b(?:pagdudurow|pagdurao|dudrow|tatae|pagtatae|nagdudurog|dudurog)\b|\b(?:maxinang|tuloy-tuloy\s+(?:ang|na|ng|nit))\s+dumi\b/i,
    en: 'diarrhea loose stools digestion ibs probiotics hydration',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-constipation',
    re: /\b(?:pagkaraot|raot)\b|\bhirap\s+(?:dumumi|magdumi|dumurog|magdumili|gumumi)\b|\bdili\s+(?:ko|nako|tao\s+nako)\s+(?:ma|maka)-?(?:dumi|dumumi|gumi)\b/i,
    en: 'constipation bowel digestion',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-vomit',
    // "nagsusuka ako", "ugagho" (Cebuano), "pagdudura" (Cebuano)
    re: /\b(?:nagsusuka|nagsuka|pagsusuka|nasusuka|sumuka|nisuka|nag-uuhog|uhkog|pagdudura|ugagho|nagugaghoa)\b/i,
    en: 'nausea vomiting stomach burning reflux',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-bloating',
    // "namamaga ang tiyan ko", "sukob", "maraming hangin sa tiyan"
    re: /\b(?:namamaga|pamamaga|magsinaw)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?(?:tiyan|iyak|sikmura|barang|bara)\b|\bsukob\b|\bhangin\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+(?:tiyan|bara|iyak|sikmura)\b|\bmaraming\s+hangin\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+tiyan\b/i,
    en: 'bloating gas ibs probiotics',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-appetite',
    // "walang ganang kumain", "masyadong gutom", "sira ang gutom"
    re: /\b(?:walang|wala|kawalan\s+ng)\s+(?:akong|aming|aking)?\s*(?:gutom|ganang\s+kumain|apetite|appetite|kilos)\b|\b(?:masyadong|sobrang|grabe\s+ng|napakalakas\s+ng)\s+gutom\b|\bsira\s+ang\s+gutom\b|\bhindi\s+(?:ko|gusto|nako)\s+(?:manga?kun|kumain|makakain|gusto\s+kumain)\b/i,
    en: 'appetite poor appetite hungry protein weight weakness',
    cats: ['retrieval', 'health'],
  },

  // ── BODY, SKIN, IMMUNITY ────────────────────────────────────────────────────
  {
    id: 'fil-fever',
    // "nilalagnat ako", "init ng katawan", "nanginginig sa lagnat"
    re: /\b(?:lagnat|nilalagnat|naglagnat)\b|\b(?:init|mainit)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+|buong\s+)?(?:katawan|noo|tikod|tagilid|body)\b|\bnanginginig\b[^.\n]{0,14}?(?:lagnat|lamig|ngipin)\b/i,
    en: 'fever temperature infection cold immunity',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-cold-cough',
    // "ubo at sipon", "uhog", "lengis", "nagalaba ko" (Cebuano: I have a cold)
    re: /\b(?:umaubo|nag-uubo|nag-ubo|umubo|ubo|sipon|uhog|lengis|nagalaba|gripo|nagripo)\b/i,
    en: 'cough cold flu immunity infection',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-immunity',
    // "madalas akong masakit", "mahina ang resistensya ko"
    re: /\b(?:madalas|kasahuran|laging)\s+(?:akong\s+)?(?:masakit|magkasakit|magpapagaihimok|mahulog|maglagay|magpailalim)\b|\bmahina\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?(?:resistensya|immunity|katatagan|lakas\s+ng\s+katawan|sistema\s+ng\s+katatagan)\b/i,
    en: 'immunity immune infection sick',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-muscle-joint',
    // "sakit ng mga kasuka ko", "namamaga ang tuwikan", "kuryenta", "gugulang"
    re: /\b(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|pananakit|kirot|bigat|hirap|namamaga|pamamaga|pigid|kabado|pangangalat)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+|mga\s+|buong\s+)?(?:kasuka|tuhod|tuhuyan|tuwikan|likod|liyo|hugaw|balikat|batikan|hika|binti|kalamnan|daliri|tampal|lipong)\b|\b(?:gugulang|kuryenta|masel|panunupil|pangingilat|hugaw|kabado)\b/i,
    en: 'joint pain muscle pain back pain soreness stiffness',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-knee',
    // "sumasakit ang tuhod ko pag-akyat", "masakit ang hika ko", "luyot ang tuhod"
    // The plan engine has a knee-specific branch (glucosamine, type-II collagen) that
    // the generic joint phrase never reaches, so a member with knee pain has to be
    // understood as having KNEE pain, not just joint pain.
    re: /\b(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|kirot|bigat|hirap|namamaga|pamamaga|luyot|kuyom)\b[^.\n]{0,20}?\b(?:tuhod|tuhukan|hika|patal)\b|\b(?:tuhod|tuhukan|hika)\b[^.\n]{0,20}?(?:sakit|masakit|sumasakit|sinasakit|nasasakit|kirot|hirap|namamaga|pamamaga|luyot)\b/i,
    en: 'knee pain knee ache knee hurt',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-teeth',
    // "sakit ng ngipin ko", "ngi", "kakuha ng ngi"
    re: /\b(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|pananakit|kirot|bigat|pamamaga|namamaga|dugo|lubog|kakuha|butong)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+|mga\s+)?(?:ngi|ngipin)\b|\b(?:ngi|ngipin)\b[^.\n]{0,12}?(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|kirot|kakuha|lubog|namamaga|butong)\b/i,
    en: 'toothache dental pain',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-skin',
    // "nakakakati ang balat ko", "panti", "raspa", "bungaraka", "tuyo ang balat"
    re: /\b(?:nakakakati|pangangati|panti|raspa|kaliskis|ketis|kati|bungaraka|akne|namumula|pamamaga\s+ng\s+balat|sira\s+ng\s+balat|tuyo\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+balat)\b|\bbalat\b[^.\n]{0,14}?(?:kati|tuyo|namumula|raspa|sira|panti)/i,
    en: 'skin rash itching dry skin acne',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-hair',
    // "nhagas ang buhok ko", "kumakalat ang buhok", "kalbo na ako"
    re: /\b(?:nhagas|nhalo|pangangahas|kalbo|magaspang\s+ng\s+buhok|pagkawasak\s+ng\s+buhok)\b|\bbuhok\b[^.\n]{0,16}?(?:nhagas|kumakalat|kalbo|natutuyo|nangina|bagsak|nanlalaglag|naninigas|namumunga)/i,
    en: 'hair loss thinning hair',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-swelling',
    // "namamaga ang hikay ko", "maga ang tiyan" (Cebuano), "pampanga"?
    re: /\b(?:namamaga|pamamaga|magamga|namaga|nagmaga)\b|\bmaga\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+|iyak\s+)?(?:hika|tuhod|binti|kamay|mata|daliri|tiyan|liyo|balat)\b/i,
    en: 'swelling edema',
    cats: ['retrieval', 'health'],
  },

  // ── MIND & MOOD ──────────────────────────────────────────────────────────────
  {
    id: 'fil-anxiety',
    // "kaba ako", "ngapa ako", "praning", "atak ako", "panic"
    re: /\b(?:kaba|nangangaba|ginagaba|ngapa|nangangapa|praning|atak|pagkatakot|kabog)\b|\btakot\s+(?:na\s+)?(?:matinding|walang\s+katwiran|angas|bigla)\b/i,
    en: 'anxiety panic stress overwhelmed nervous',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-mood',
    // "malungkot ako", "iyak lang", "walang pakiramdam", "inis ko lahat"
    re: /\b(?:lungkot|nalulungkot|nararamdam\s+ng\s+lungkot|iyak|iiyak|naiiyak|anaw|walang\s+pakiramdam|patay\s+na\s+ang\s+(?:pakiramdam|damdamin))\b|\b(?:inis|mainis|agalma|irek|galit)\s+(?:ko|ng|ako|akong|siya|tao|lahat|sa\s+lahat|ng\s+lahat)\b|\b(?:madaling\s+mainis|laging\s+galit|laging\s+inis|sobrang\s+inis)\b/i,
    en: 'low mood depression sad irritability',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-stress',
    // "masyado akong stressed", "bigat ng isip ko", "abala ako"
    re: /\b(?:nakakastress|nakakadepress|depresyon|stress\s+ko|stress\s+ako|stressed\s+(?:ako|ko))\b|\bbigat\s+ng\s+(?:isip|buhay|loob|dibdib|sitwasyon)\b|\babala\b|\bhindi\s+ko\s+kaya\s+ang\s+(?:trabaho|abala|sitwasyon|lahat\s+ng\s+itong)\b/i,
    en: 'stress stressed overwhelmed burnt out',
    cats: ['retrieval', 'health'],
  },

  // ── CONDITIONS ───────────────────────────────────────────────────────────────
  {
    id: 'fil-hypertension',
    // "taas ng presyon ko", "presyon", "taas ng dugo"
    re: /\b(?:taas|mataas|ahiya|daku)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?(?:presyon|pressure|blood\s+pressure|dugo)\b|\bpresyonan?\b/i,
    en: 'high blood pressure hypertension',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-diabetes',
    // "may diabetes ako", "matamang sakit", "taas ng asukar ko", "laging uhaw"
    re: /\b(?:nodyabetis|tanggaw)\b|\b(?:matamang|matamis\s+na)\s+(?:na\s+)?(?:akit|sakit|helam|ga)\b|\b(?:taas|high|mataas|sobrang)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+|antas\s+ng\s+)?(?:asukar|asukan|sugar|glucose)\b|\b(?:sobrang|laging|masyadong|napaka)\w*\s*uhaw\b|\bnangingibaw\b/i,
    en: 'diabetes blood sugar glucose',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-thirst',
    // "uhaw", "madalas na ihi", "hindi ko mapigil ang ihi"
    re: /\buhaw\b|\b(?:madalas|kasahuran|gabing-gabi|daku|laging)\s+(?:na\s+)?(?:ang\s+)?(?:ako|niya|aking)?\s*(?:ma)?ihi\b|\bumiihi\b|\bihi\b[^.\n]{0,16}?(?:madalas|sakit|dugo|hirap|amoy|baga|paso|pagtatae)/i,
    en: 'excessive thirst water drinking diabetes blood sugar glucose',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-cholesterol',
    // "kolesterol", "taba sa dugo"
    re: /\b(?:kolesterol|trigliserito)\b|\btaba\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+dugo\b/i,
    en: 'cholesterol triglycerides heart omega garlic',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-thyroid',
    // "tirod", "namamaga ang leeg ko", "bigat ng tadyang"
    re: /\b(?:tirod|tirodismo|hipotiroid|hipertiroid)\b|\b(?:namamaga|pamamaga|tuma|bigat|matigas|sakit)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?(?:leeng|leeg|tadyang|lipong)\b/i,
    en: 'thyroid hypothyroid hyperthyroid neck swelling',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-kidney',
    // "may bato sa batugana", "dialisis", "sakit ng amag"
    re: /\bbato\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+(?:aking\s+)?(?:batugana|batugan|amag|kidney)\b|\b(?:batugana|dialisis|amag)\b|\bsakit\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+(?:likod|baywang)\b[^.\n]{0,18}?(?:bato|dugo|ihi|amag|batugana)/i,
    en: 'kidney stones kidney flank pain back',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-liver',
    // "sakit ng atay", "dilaw ng mukha ko" (jaundice), "may problema sa dila"
    re: /\b(?:atay|dila)\b[^.\n]{0,16}?(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|problem|hirap|sira|lagnat|dilaw|masama)\b|\b(?:sakit|masakit|sumasakit|sinasakit|nasasakit|pinagsasakit|samakit|pananakit|problem|hirap|lagnat|sira)\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?(?:atay|dila)\b|\bdilaw\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?(?:mukha|mata|balat|katawan|iyak)\b/i,
    en: 'liver jaundice fatty',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-asthma',
    re: /\b(?:astma|ataque\s+de\s+pecho)\b/i,
    en: 'asthma wheezing shortness of breath cold immunity',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-anemia',
    // "maputla", "kulang sa dugo", "pupot"
    re: /\b(?:mapusyaw|maputla|pupot|dughan)\b|\bkulang\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:aking\s+)?dugo\b/i,
    en: 'anemia pale iron deficiency',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-allergy',
    // "allergic ako", "may lason ako sa sili", "hapo ko sa mani"
    re: /\b(?:alheyik|alerhiya|hapo|lason)\b|\bhindi\s+(?:ko|nako|tao\s+nako|niya)\s+(?:kaya|kakayanin|matiis|tanggapin)\b[^.\n]{0,20}?(?:pagkain|gamot|kariton|mani|seafood|maint|maintenance|lalagyan|gatas|itlog|isda)\b/i,
    en: 'allergy allergic skin rash itching immune quercetin',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-pregnancy',
    re: /\b(?:buntis|nagbubuntis|nadadalang\s+tao|dalang-tao|buntag|anganak|panganak|nagpanganak)\b/i,
    en: 'pregnant pregnancy prenatal folate iron',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-period',
    // "hindi dating ang regla ko", "sakit ng regla", "napuputol ang buwanan"
    re: /\b(?:regla|menstruasyon|buwanan|panlinig\w*|pasinaw)\b/i,
    en: 'menstrual period irregular periods hormonal',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-weight',
    // "tumagas ako", "bumaba ang timbang ko", "mataba ako", "sobrang manipis"
    re: /\b(?:tumagas|tumatagas|gumaga|mataba|matabaan|manipis|timbang|timbangin|dagdag-timbang|bawas\s+timbang)\b|\b(?:mabilis|bigla|dahan-dahan|nang\s+dahan)\s+(?:kong\s+)?(?:tumagas|bumaba|gumaga|magtaas\s+ng\s+timbang)\b|\bsobrang\s+(?:timbang|taba|manipis|payat)\b/i,
    en: 'weight obesity metabolism slim',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-cancer',
    re: /\b(?:kanser|maligno|kemoterapiya|kabag)\b/i,
    en: 'cancer tumour',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-dengue',
    // "dengue", "tatlong araw na lagnat", "hihika ng lamok"
    re: /\b(?:dengue|chikungunya|tigdasan|tipes|roskas|leptospirosis)\b|\blagnat\b[^.\n]{0,16}?(?:matindi|sobrang|grabe|tatlong|3|limang|5|dalawang)\b/i,
    en: 'dengue fever infection',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-arthritis',
    // "arthritis", "rigid ang mga kasuka", "hidhip"? (gout loanwords)
    re: /\b(?:artiris|reumatismo|osteoporoysis|fraktura|langitan|pangingilat|pigid\s+ng\s+liyo|matitigas\s+ng\s+kasuka)\b/i,
    en: 'arthritis joint bone stiffness',
    cats: ['retrieval', 'health'],
  },

  // ── MEDICATIONS, DOSES, LABS ────────────────────────────────────────────────
  {
    id: 'fil-medication',
    // "gamot ko sa blood pressure", "uminom ako ng maintenance", "reseta ng doktor"
    re: /\b(?:gamot|lunas|reseta|reteta|tableta|kapsula|bitamin|suplemento|dosis|pildoras|maintenance|maintenance\s+ko|dokter|doktor|nars|baringero|hospitalisasyon|operasyon)\b|\binumin\b|\buminom\b|\bbinom\b/i,
    en: 'medication dose supplement vitamin tablet clinician doctor',
    cats: ['retrieval', 'health', 'app'],
  },
  {
    id: 'fil-side-effect',
    // "may side effect yung gamot", "masama ang gamot sa tiyan ko"
    re: /\bepekto\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+gamot\b|\bmasama\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+gamot\b|\bhindi\s+(?:ko|niya)\s+(?:tolera|kaya|matiis)\s+(?:ang|yung)?\s*(?:gamot|reseta|tableta|dosis)\b/i,
    en: 'side effect tolerate',
    cats: ['retrieval', 'health'],
  },
  {
    id: 'fil-dose-question',
    // "gaano kadamot uuomin", "ilang tableta", "kailan ko uuomin"
    re: /\bgaano\s+(?:kadamot|kadamo|ka-damo|kalaon|kadamo)\s+(?:pa\s+)?(?:ba\s+)?(?:akong|ko|nako|ang|ng)?\b|\b(?:ilan\s+(?:ka|kong|kong)?\s*(?:tableta|kapsula|mg|dose|bitamin|suplemento|kutsara|sachet))\b|\bkailan\s+(?:ko|nako|akong|ba\s+ako)\s+(?:uuinom|uminom|inom|kakainin|uubuhay|aumin|haharapin)\b/i,
    en: 'how much what dose safe',
    cats: ['retrieval', 'health', 'app'],
  },
  {
    id: 'fil-labs',
    // "resulta ng blood test ko", "pamblood test", "check-up"
    re: /\b(?:pamblood\s+test|eks-?ray|resulta|pagnanalisa|pagsusuri\s+ng\s+dugo)\b|\bdugo\s+(?:ko|nit|aking|natin|ngok)\b/i,
    en: 'test lab results',
    cats: ['retrieval', 'health', 'app'],
  },

  // ── APP NAVIGATION ──────────────────────────────────────────────────────────
  {
    id: 'fil-login',
    // "hindi ako makapag-login", "nakalimutan ang password ko"
    re: /\b(?:pagsulod|password\s+ko|account\s+ko|bagong\s+account)\b/i,
    en: 'login password account sign in',
    cats: ['app', 'retrieval'],
  },
  {
    id: 'fil-password-reset',
    re: /\b(?:password|pass|otp|code|email)\b[^.\n]{0,32}?(?:baguhin|palitan|nakalimutan|kalimutan|reset|bagong|kuha|makuha|di\s+dating|natatanggap|hindi\s+dati)\b|\b(?:baguhin|palitan|reset|nakalimutan|kalimutan)\b[^.\n]{0,24}?(?:password|pass|otp|code|email)\b/i,
    en: 'forgot password reset password otp code not received',
    cats: ['app', 'retrieval'],
  },
  {
    id: 'fil-app-nav',
    // "saan ang aking plano", "di ko makita ang results", "asann yung report"
    re: /\b(?:saan|san|asann|ainu)\s+(?:ang|ba|ba\s+ang|nit|ko|ng|niya)?\s*\w*\s*(?:aking|ako|ko|nit|nyo|iyang)?\s*(?:plano|resulta|results?|tsart|chart|report|dashboard|history|profile|settings?|plan|pdf|assessment|account|gamot|ticket|support)\b|\b(?:di|hindi|dili|wala|saan)\s+ko\s+(?:makita|kita|makakita|nataguan|natamaan|naaang)\b/i,
    en: 'dashboard results history profile settings app',
    cats: ['app', 'retrieval'],
  },
  {
    id: 'fil-plan-track',
    // "paano i-mark na inumin ko", "subaybayan ang plano", "na-miss ko dose ko"
    re: /\b(?:i-?mark|markahan|na-mark|nakamark|subaybay\w*|talaan|pagtatala|pangangalakal\s+ng\s+tala)\b|\b(?:kalimutan|nakakalimot|na-miss|miss)\s+ko\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)?\s*(?:gamot|inom|dose|tableta|planong\s+araw|adlaw)\b|\bdi\s+ko\s+uminom\b/i,
    en: "track tracker log mark it missed today's plan schedule",
    cats: ['app', 'retrieval'],
  },
  {
    id: 'fil-reminder',
    // "paano maglagay ng paalala", "may alarm ba ang app"
    re: /\b(?:paalala|papaalalan|alala|gisingin\s+mo|tawag\s+(?:mo\s+)?(?:ba\s+)?ako)\b/i,
    en: 'reminders notification schedule',
    cats: ['app', 'retrieval'],
  },
  {
    id: 'fil-support',
    // "paano kausapin ang support", "kailangan ko ng tulong", "may tao ba rito"
    re: /\b(?:tulong|humingi\s+ng\s+tulong|kausap\w*|kausi?n|reklamo|sumbong|may\s+tao\s+ba)\b/i,
    en: 'support contact help ticket assistant',
    cats: ['app', 'retrieval'],
  },
  {
    id: 'fil-billing',
    // "magkano ang subscription", "gusto kong kanselahin", "paano magbayad"
    re: /\b(?:bayad|babayaran|binayad|magbayad|kredit|debit|gcash|presyo|magkano|mag-subscribe|mag-subscribe|mag-upgrade|kansela\w*|palamang\s+dati|libre)\b/i,
    en: 'subscription package payment upgrade cancel plan',
    cats: ['app', 'retrieval'],
  },
  {
    id: 'fil-assessment',
    // "paano simulan ang assessment", "kumpletuhin ang tanong"
    re: /\b(?:tselist|pagsusulit|kumplet\w*|tanung\w*|mag-apply|aplay|punin\s+(?:ng|ang|sa|nang|nit|nin|ko|aking|iyang|sa\s+aking|sa\s+iyang)\s+\w*\s*(?:tselist|tanong))\b/i,
    en: 'assessment questionnaire results',
    cats: ['app', 'retrieval'],
  },
  {
    id: 'fil-can-i',
    // "pwede ba i-sync ang apple watch ko", "may reminder ba ang app", "kaya ba ng app..."
    // The capability question. FEATURE_QUESTION in utils/ragRetriever.js is written in
    // English, and the one thing a Filipino "can the app do X" needs from this bridge is the
    // forced absence note: without it the model invents a Settings screen that does not
    // exist, which is the single most damaging thing this surface can do.
    re: /\b(?:pwede|puwede|kaya|possible|mayroon|meron|may)\s+\w*\s*ba\b|\b(?:pwede|puwede|kaya)\s+(?:ba\s+)?(?:ng\s+|ako\s+|nako\s+)?(?:app|system|ito|ni)\b|\b(?:gusto|ayok)\w*\s+(?:ko\s+)?bang\s+(?:malaman|alam\w*|makita)\b/i,
    en: 'can i does the app have is there a feature option available',
    cats: ['app', 'retrieval'],
  },
  {
    id: 'fil-how-do',
    // "paano ko gagamitin ito", "pano mag-subscribe", "ano ang susunod" — the how-do-I
    // shape, which needs the same forced absence note as its English twin.
    re: /\b(?:paano|pano|paon|pailalom\s+ba|unsay|unsa\s+man|ngaan|hihirang|ainu|giunoc)\b|\bano\s+ang\s+(?:susunod|next|gagawin)\b/i,
    en: 'how do i how to what should i do next',
    cats: ['app', 'retrieval'],
  },
  {
    id: 'fil-diagnosis-ask',
    // "anong sakit ko", "ano ang karamdaman ko", "i-diagnose mo ako"
    re: /\b(?:anong|ano\s+ang|anung)\s+(?:sakit|karamdaman|meron|sakitin|maysakit)\b|\b(?:sabi(?:in)?|ilan|tukuyin)\s+(?:mo\s+)?(?:na\s+)?lang\s+(?:anong|ano|kung)\b|\b(?:diagnos|hinala|hinuhula)\w*\s+(?:mo\s+)?(?:ako|lang|ba\s+ako)\b|\bano\s+(?:ba\s+)?ang\s+sakit\s+ko\b/i,
    en: 'tell me what disease i have diagnosis my condition',
    cats: ['health', 'retrieval'],
  },
];

const ANCHOR_BY_ID = new Map(ANCHORS.map((a) => [a.id, a]));

function wants(categories) {
  const list = Array.isArray(categories) && categories.length ? categories : CATEGORIES;
  return new Set(list.filter((c) => CATEGORIES.includes(c)));
}

/**
 * Which anchors fire, and the English they bring in.
 * @returns {Array<{id: string, en: string}>} in ANCHORS order, de-duplicated by `en`
 *   so two synonyms for the same thing cannot flood the query and distort the ranking.
 */
function matchedAnchors(text, categories) {
  const prepared = prepare(text);
  if (!prepared.trim()) return [];
  const allowed = wants(categories);
  const seen = new Set();
  const out = [];
  for (const anchor of ANCHORS) {
    if (!anchor.cats.some((c) => allowed.has(c))) continue;
    if (seen.has(anchor.en)) continue;
    if (!anchor.re.test(prepared)) continue;
    seen.add(anchor.en);
    out.push({ id: anchor.id, en: anchor.en });
  }
  return out;
}

/**
 * The member's own words, plus the English vocabulary this app's checks already know.
 * Appended, never prepended, and byte-identical to the input when nothing matched — so
 * an English message behaves exactly as it does today.
 *
 * @param {string} text free text as typed
 * @param {string[]} [categories] restrict which anchors may fire; all by default
 */
function anchorText(text, categories) {
  const original = typeof text === 'string' ? text : String(text == null ? '' : text);
  const matches = matchedAnchors(original, categories);
  if (!matches.length) return original;
  return `${original} ${matches.map((m) => m.en).join(' ')}`;
}

/** Just the English terms, for a caller that expands a query rather than rewriting it. */
function anchorTerms(text, categories) {
  return matchedAnchors(text, categories).map((m) => m.en);
}

/**
 * Does this text describe health, in any language this app writes checks for?
 * utils/offTopicFilter.js explains at length why the answer must err wide: a false
 * decline costs the member an answer they were owed, and a missed decline only costs
 * one provider call the prompt declines anyway. Health and safety anchors only —
 * navigation vocabulary is already vetoed by the English app words, and an `app`
 * anchor is never evidence of a health topic.
 */
function hasHealthAnchor(text) {
  return matchedAnchors(text, ['health', 'safety']).length > 0;
}

/** Did any anchor fire at all? Lets a log say a reply was answered from anchors. */
function isAnchored(text, categories) {
  return matchedAnchors(text, categories).length > 0;
}

module.exports = {
  CATEGORIES,
  ANCHORS,
  ANCHOR_BY_ID,
  anchorText,
  anchorTerms,
  matchedAnchors,
  hasHealthAnchor,
  isAnchored,
};
