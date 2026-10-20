'use strict';

/**
 * WHICH LANGUAGE A MEMBER IS WRITING IN — WHY THIS IS A MODULE AND NOT A GUESS.
 *
 * Every text check in this app was written against English: the retrieval aliases
 * (utils/ragRetriever.js), the off-topic pre-filter (utils/offTopicFilter.js), the
 * crisis vocabulary (utils/severity.js), the injection phrases
 * (utils/aiGuardrails.js), the rule engine that turns answers into a plan
 * (routes/recommend.js). Each one matches by word, so a member writing Filipino,
 * Cebuano or Taglish is not answered in their language — they are answered as if
 * they had said nothing recognizable at all. "hindi ako makapag-hinga" is the
 * sentence that must flag a Priority review, and it matched no needle in
 * severity.js, so it did not flag.
 *
 * Detection here is deliberately DETERMINISTIC: no provider call, no network, no
 * model. A language guess that costs an API round trip cannot sit in front of every
 * chat turn, cannot run in CI, and cannot be re-run by the accuracy gate on a
 * laptop. What it costs in recall it buys back in being testable — see
 * `Test File/language-detection.test.js`.
 *
 * ── WHY FUNCTION WORDS, NOT HEALTH WORDS ──────────────────────────────────────
 * The obvious classifier — count health vocabulary — is wrong for this user base,
 * because a Taglish sentence carries English medical words inside Tagalog grammar
 * ("pwede ba akong uminom ng magnesium bago matulog?"). Counting "magnesium" and
 * "inom" as the same signal makes Taglish unreadable. So markers are FUNCTION words
 * — the particles, articles and pronouns that belong to one language's grammar and
 * almost never borrow. "po", "na lang", "ayaw", "ga", "gyud", "iray", "hiya" are
 * not vocabulary a code-switcher has a reason to import; "sakit" and "vitamin" are.
 *
 * ── WHY WEIGHTS, AND WHY "SA" IS NOT PROOF OF CEBUANO ────────────────────────
 * Philippine languages share a large part of their grammar and their Spanish
 * loanwords. `sa` ("at/to/by") is Cebuano, Hiligaynon, Waray and Bikol all at once;
 * `ng` is Tagalog but also Cebuano; `dai` is both Ilocano and Bikol. A marker that
 * is ambiguous is scored low, and only the high-weight exclusive markers can decide
 * a language on their own. Every weight below records the reason.
 *
 * ── WHAT AN ABSENT LANGUAGE MEANS ────────────────────────────────────────────
 * A short or mixed message that scores nothing returns `en`. That is not a claim
 * that the member is an English speaker; it is the safe default, because `en`
 * preserves today's behaviour exactly (every check matches, English copy is served).
 * A wrong `en` costs a member their own language for one turn; a wrong `fil` costs
 * a verifier its ability to read the reply. Detection therefore errs toward `en`
 * and errs toward `fil` when the two compete, since Filipino is the language this
 * product's research population actually writes in.
 */

/** Stable codes used across the API. `fil` covers Filipino/Tagalog and Taglish. */
const LANGUAGES = {
  en: 'English',
  fil: 'Filipino (Tagalog)',
  fil_taglish: 'Taglish',
  ceb: 'Cebuano (Bisaya)',
  hil: 'Hiligaynon (Ilonggo)',
  bik: 'Bikol',
  ilo: 'Ilocano',
  kap: 'Kapampangan',
  pag: 'Pangasinan',
  war: 'Waray',
  es: 'Spanish',
  pt: 'Portuguese',
  id: 'Indonesian',
  ms: 'Malay',
  hi: 'Hindi',
  ar: 'Arabic',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  vi: 'Vietnamese',
  th: 'Thai',
  fr: 'French',
  de: 'German',
};

/** What the model is told to answer in. `fil_taglish` is still Filipino. */
const REPLY_LANGUAGE = { fil: 'Filipino (Tagalog)', fil_taglish: 'Filipino (Tagalog)', ceb: 'Cebuano', hil: 'Hiligaynon', bik: 'Bikol', ilo: 'Ilocano', kap: 'Kapampangan', pag: 'Pangasinan', war: 'Waray' };

/**
 * `w` is the weight of the marker, `re` an optional multi-word shape. Weights:
 * 3 = exclusive to this language in this region, 2 = strongly indicative,
 * 1 = supportive but shared with a neighbour.
 */
const MARKERS = {
  fil: {
    words: [
      // the Tagalog ergative/absolutive particles — a code-switcher keeps these
      ['ang', 2], ['ng', 2], ['mga', 3], ['nina', 2], ['kay', 1], ['niya', 3], ['niyo', 3],
      ['nyo', 1], ['ako', 2], ['ikaw', 3], ['ka', 1], ['tayo', 3], ['sila', 3], ['kami', 3],
      ['namin', 3], ['natin', 3], ['ko', 1], ['mo', 1], ['to', 1], ['do', 1], ['gito', 3],
      ['ganiyan', 3], ['ganito', 3], ['gayan', 1],
      // aspect + negation + modality, none of which English borrows
      ['ayaw', 3], ['gusto', 2], ['kailangan', 3], ['kailan', 2], ['pwede', 3],
      ['puwede', 3], ['kaya', 1], ['kayaning', 3], ['marunong', 3], ['alam', 2],
      ['hindi', 3], ['di', 1], ['wala', 3], ['walla', 2], ['meron', 3], ['mayroon', 3],
      ['gumawa', 3], ['gagawa', 3], ['gawa', 2], ['uminom', 3], ['inom', 2], ['umuli', 3],
      ['kumain', 3], ['kain', 2], ['matulog', 3], ['tulog', 2], ['gising', 2], ['lakad', 2],
      // the politeness particles: the single clearest Taglish fingerprint
      ['po', 2], ['op', 3], ['ho', 1], ['oo', 3], ['sige', 3], ['sana', 2], ['bakit', 3],
      ['paano', 3], ['ganoon', 3], ['ganun', 2], ['na', 1], ['naman', 3], ['lang', 1],
      ['din', 1], ['rito', 3], ['diyan', 3], ['doon', 3], ['sayo', 3], ['akin', 3],
      ['para', 1], ['tungkol', 3], ['halimbawa', 3], ['talaga', 3], ['siya', 3],
    ],
    phrases: [
      ['\\bna\\s+lang\\b', 3], ['\\bpa\\s+na\\b', 2], ['\\bpa\\s+ako\\b', 3],
      ['\\bhanggang\\s+ngayon\\b', 3], ['\\bsiya\\s+pa\\b', 2],
      ['\\bgusto\\s+ko\\b', 2], ['\\bko\\s+lang\\b', 3], ['\\bmo\\s+lang\\b', 2],
      ['\\bpara\\s+sa\\s+akin\\b', 3], ['\\bsa\\s+tingin\\s+ko\\b', 3],
      ['\\bano\\s+ang\\b', 3], ['\\bkanino\\b', 3], ['\\bsino\\s+pa\\b', 2],
    ],
  },
  ceb: {
    words: [
      // Cebuano markers that are NOT Tagalog. `sa` and `ang` are shared, so they
      // carry no weight here; these do.
      ['pagka', 2], ['misud', 3], ['mosud', 3], ['mokaon', 3], ['pagtuon', 3], ['hulga', 3],
      ['katulog', 2], ['lawas', 3], ['buhi', 2], ['panimalay', 3], ['balay', 3], ['litrato', 3],
      ['gikan', 3], ['arom', 3], ['atbang', 3], ['suod', 3], ['gamay', 3], ['dako', 3],
      ['bag-o', 2], ['bara', 1], ['kan-anon', 3], ['hulaw', 3], ['sula', 2], ['tapos', 1],
      ['uban', 3], ['uyuban', 3], ['paminaw', 3], ['pano', 3], ['ngaa', 3], ['nganong', 3],
      ['unsa', 3], ['unsay', 3], ['kanus-a', 3], ['kanusa', 3], ['asig', 3], ['dali', 1],
      ['hinoong', 3], ['labi', 2], ['kaayo', 3], ['ayo', 3], ['hataas', 3], ['gibug-on', 3],
      ['kasubay', 3], ['kanon', 2], ['pagpangin', 1], ['kun', 1], ['kon', 1],
      ['jud', 2], ['man', 1], ['gayod', 3], ['baayo', 3], ['daotan', 3],
      ['lisod', 2], ['hirap', 2], ['sakit', 1], ['higala', 3], ['igsu', 3], ['batan', 2],
      ['bata', 1], ['pagkaon', 3], ['inum', 2], ['tulog', 1], ['bulawan', 3], ['bulan', 2],
      ['dili', 3], ['mabati', 3], ['pila', 3], ['hulgat', 3],
    ],
    phrases: [
      ['\\bsa\\s+akong\\b', 3], ['\\bsa\\s+imong\\b', 3], ['\\bsa\\s+iya\\b', 2],
      ['\\bako\\s+maka\\b', 3], ['\\bdili\\s+ko\\b', 3], ['\\bdili\\s+nako\\b', 3],
      ['\\bnaa\\s+ko\\b', 3], ['\\bnaa\\s+man\\b', 2], ['\\bmahimo\\s+ba\\b', 3],
      ['\\bpwede\\s+ba\\b', 1], ['\\bkaya\\s+ba\\s+nimo\\b', 2], ['\\bkanus-a\\s+ba\\b', 3],
      ['\\bunsa\\s+man\\b', 3], ['\\blabi\\s+kaayo\\b', 3], ['\\bpresko\\s+kaayo\\b', 2],
    ],
  },
  hil: {
    words: [
      // Hiligaynon's own set. `wala`/`gid` overlap with neighbouring Bisaya
      // languages, hence 2 rather than 3.
      ['gba', 3], ['gyud', 3], ['gid', 2], ['bala', 3], ['hambal', 3], ['hulaton', 3],
      ['kaunon', 3], ['tuyok', 3], ['katabo', 3], ['karon', 3], ['subo', 2], ['tuo', 3],
      ['wala', 2], ['may', 1], ['amaro', 3], ['kalibutan', 3], ['banwa', 2], ['balay', 2],
      ['lawas', 2], ['ngaan', 3], ['kay', 1], ['ah', 2], ['adto', 2], ['kon', 2],
      ['kong', 2], ['sang', 3], ['sing', 3], ['para', 1], ['kag', 3], ['kundi', 3],
      ['tani', 1], ['labot', 3], ['higot', 3], ['garo', 3], ['domo', 3], ['kuko', 3],
      ['baling', 2], ['huyop', 3], ['init', 2], ['lamig', 3], ['sira', 2], ['hana', 2],
      ['tanom', 3], ['pagkaon', 2], ['bulawan', 2], ['bulan', 2], ['lingsir', 3],
      ['tiil', 3], ['higala', 2], ['tuwa', 3], ['balik', 1], ['haduay', 3],
    ],
    phrases: [
      ['\\bkon\\s+pa\\b', 2], ['\\bwala\\s+gid\\b', 3], ['\\bwala\\s+gba\\b', 3],
      ['\\bpwede\\s+ba\\s+kamo\\b', 2], ['\\bilin\\s+mo\\b', 2], ['\\bgani\\s+ba\\b', 3],
      ['\\bsa\\s+aton\\b', 3], ['\\blo\\s+gid\\b', 2], ['\\bmay\\s+idiya\\b', 3],
    ],
  },
  bik: {
    words: [
      // `dai` is shared with Ilocano, `gba`/`ya` with Hiligaynon — the exclusive
      // forms below are what decides Bikol.
      ['sinda', 3], ['saiya', 3], ['sabong', 3], ['uyam', 3], ['uya', 3], ['kamo', 3],
      ['kamu', 2], ['ta', 1], ['ninda', 3], ['nia', 2], ['nyo', 1], ['mi', 1], ['mu', 1],
      ['somok', 3], ['maray', 3], ['arahdo', 3], ['haro', 3], ['kua', 3], ['abot', 2],
      ['namamaga', 2], ['ratak', 3], ['banua', 3], ['reyna', 2], ['samar', 3],
      ['gumagalang', 3], ['kasarotan', 3], ['tataramon', 3], ['suhayan', 3],
      ['pagabot', 3], ['tulos', 3], ['sige', 1], ['dai', 1], ['ibo', 3],
      ['itlog', 3], ['bukaton', 2], ['tina', 3], ['kalye', 1], ['saka', 2],
    ],
    phrases: [
      ['\\bdai\\s+ako\\b', 3], ['\\bdai\\s+na\\b', 3], ['\\bsa\\s+gaya\\s+ni\\b', 2],
      ['\\bmay\\s+na\\s+ba\\b', 1], ['\\bsa\\s+yaong\\b', 3], ['\\bkun\\s+ako\\b', 2],
    ],
  },
  ilo: {
    words: [
      // `ita`/`daing`/`pay`/`laeng` are the Ilocano spine; `kadi` is a question
      // particle no other Philippine language here uses.
      ['daytoy', 3], ['daydiay', 3], ['adda', 3], ['saan', 3], ['kadi', 3],
      ['laeng', 3], ['pay', 2], ['anton', 3], ['inton', 3], ['idiay', 3], ['nu', 2],
      ['kas', 2], ['kuy', 3], ['daing', 3], ['ita', 3], ['mi', 2], ['tayo', 1],
      ['dagiti', 3], ['unay', 3], ['ad-adu', 3], ['bassit', 3], ['naimbag', 3],
      ['naka', 1], ['ngarud', 3], ['gapu', 3], ['ta', 1], ['gawa', 2],
      ['mapan', 3], ['rummuar', 3], ['napan', 3], ['immak', 3], ['makanen', 3],
      ['agad', 3], ['saka', 2], ['maysa', 3], ['tallupok', 3], ['rimbag', 2],
    ],
    phrases: [
      ['\\bsaan\\s+pay\\b', 3], ['\\bsaan\\s+laeng\\b', 3], ['\\badda\\s+pay\\b', 3],
      ['\\bno\\s+laeng\\b', 3], ['\\bkas\\s+muna\\b', 3],
      ['\\bnu\\s+saan\\b', 3], ['\\bdaytoy\\s+laeng\\b', 3], ['\\bagad\\s+ni\\b', 2],
      ['\\bnu\\s+pay\\b', 3],
    ],
  },
  kap: {
    words: [
      // Kapampangan writes /k/ as `q` in ordinary words (`qananam`, `malagung`), but
      // there is deliberately NO `q`-initial test here: English writes `q` the same
      // way in "quality", "quiz" and "question", and an orthography-only signal
      // misdetected plain English as Kapampangan. Articles and pronouns carry it.
      ['karing', 3], ['aring', 3], ['dere', 3], ['ing', 2], ['neng', 3],
      ['ingwa', 3], ['alang', 3], ['muto', 3], ['kayugu', 3], ['malagung', 3], ['masantu', 3],
      ['lalang', 3], ['bale', 3], ['ibamun', 3], ['ingget', 2], ['kanam', 3], ['kanu', 3],
      ['kaneno', 3], ['kanen', 3], ['inu', 2], ['dindin', 3], ['mari', 2], ['deng', 3],
      ['ding', 3], ['atim', 3], ['zamu', 3], ['yu', 1], ['mayung', 3], ['agnan', 3],
      ['kare', 2], ['kanita', 3], ['maki', 2], ['mwag', 3], ['ule', 2], ['keta', 3],
    ],
    phrases: [
      ['\\balang\\s+yu\\b', 3], ['\\bding\\s+kareng\\b', 3],
      ['\\bkaring\\s+ing\\b', 3], ['\\bkanu\\s+keng\\b', 3], ['\\bneng\\s+mu\\b', 3],
    ],
  },
  pag: {
    words: [
      // `iray`/`sar`/`nin`/`so`/`tan` together; `tan` ("and") is shared with
      // Tagalog so it only supports.
      ['iray', 3], ['sar', 3], ['nin', 3], ['so', 2], ['tan', 1], ['nay', 3], ['ambot', 3],
      ['tair', 3], ['nan', 2], ['tota', 3], ['siarey', 3], ['siampoy', 3],
      ['nilan', 3], ['kilan', 3], ['sitan', 3], ['way', 2], ['unong', 3],
      ['noteb', 3], ['abig', 2], ['noyin', 3], ['karkarni', 3], ['asalansan', 3],
      ['tampot', 3], ['biska', 2], ['gagawa', 2], ['awa', 2], ['lapit', 2],
    ],
    phrases: [
      ['\\biray\\s+sar\\b', 3], ['\\btan\\s+nin\\b', 3],
      ['\\bambot\\s+to\\b', 3], ['\\bdi\\s+nin\\b', 3], ['\\bso\\s+nota\\b', 2],
      ['\\bnoteb\\s+to\\b', 3], ['\\bnilan\\s+so\\b', 3],
    ],
  },
  war: {
    words: [
      // `hiya`/`iyan`/`ngaan`/`hana` distinguish Waray from its Bisaya relatives;
      // `ngaan` is shared with Hiligaynon so it supports rather than decides.
      ['hiya', 3], ['iyaroy', 3], ['iyan', 3], ['ngan', 2], ['ngaa', 2], ['ngaan', 2],
      ['hana', 3], ['kaarog', 3], ['higugma', 3], ['hinali', 3], ['hidlaw', 3], ['gihimo', 3],
      ['buhatan', 3], ['katung', 3], ['adto', 2], ['dayon', 3], ['niha', 2], ['nirha', 3],
      ['hi', 1], ['ha', 2], ['hay', 2], ['binisita', 3], ['nataran', 3], ['kaarbo', 3],
      ['ninin', 2], ['tawo', 3], ['burat', 3], ['dulag', 3], ['ato', 2], ['naton', 3],
      ['kikita', 3], ['huhula', 3], ['damgo', 3], ['hinirang', 3], ['hirudlaw', 3],
      ['anhi', 3], ['kuru', 3], ['taid', 3], ['gamha', 3], ['luad', 3], ['hiro', 2],
      ['kaurusa', 3], ['hihirang', 2], ['natulog', 2],
      // Waray's own negation and pronoun set. `dai` is shared with Bikol and
      // Ilocano so it carries no weight here; these are what separate Waray from
      // its neighbours when all three use the same Spanish-derived vocabulary.
      ['akon', 3], ['naton', 3], ['nataw', 3], ['haa', 3],
      ['halos', 2], ['nagdada', 3], ['minumolon', 3], ['nanalip', 3], ['nabudlay', 3],
      ['higugma', 3], ['makakatulog', 2],
    ],
    phrases: [
      ['\\bhi\\s+ako\\b', 2], ['\\bha\\s+ako\\b', 3], ['\\bngaa\\s+ka\\b', 2],
      ['\\bwaray\\b', 3], ['\\bdaghan\\b', 3], ['\\bhaa\\s+in\\b', 3],
      ['\\bdai\\s+ako\\s+maka', 3], ['\\bnabudlay\\s+kaayo\\b', 3],
    ],
  },
  // Non-Philippine majors: detection only, no anchors. A model natively writes
  // these, so all the product needs from them is the reply-language instruction.
  es: { words: [['el', 1], ['la', 1], ['los', 2], ['las', 2], ['que', 1], ['porque', 3], ['cómo', 3], ['estoy', 3], ['estás', 3], ['tengo', 3], ['duele', 3], ['dolor', 2], ['medicamento', 3], ['vitamina', 1], ['sueño', 2], ['presión', 2], ['azúcar', 2], ['dieta', 1], ['ejercicio', 1], ['quisiera', 3], ['podría', 3], ['gracias', 2], ['buenas', 2], ['por', 1], ['favor', 1], ['necesito', 3], ['quiero', 2], ['ayuda', 2], ['tableta', 1]] },
  pt: { words: [['não', 3], ['estou', 3], ['tenho', 3], ['dói', 3], ['dores', 2], ['medicamento', 2], ['obrigado', 3], ['poderia', 3], ['posso', 3], ['tomar', 3], ['sono', 2], ['pressão', 2], ['açúcar', 3], ['porque', 2], ['estás', 2], ['você', 3], ['vocês', 3], ['preciso', 3], ['gostaria', 3], ['como', 1], ['onde', 2], ['quando', 2], ['muito', 1], ['dor', 2]] },
  id: { words: [['saya', 3], ['apa', 2], ['bagaimana', 3], ['kapan', 3], ['kenapa', 3], ['tidak', 3], ['bisa', 3], ['boleh', 3], ['obat', 3], ['vitamin', 1], ['tidur', 3], ['tekanan', 2], ['gula', 3], ['terima', 2], ['tolong', 3], ['sudah', 3], ['belum', 3], ['pernah', 3], ['rasa', 2], ['sakit', 2], ['butuh', 3], ['mohon', 2], ['apakah', 3]] },
  ms: { words: [['saya', 2], ['boleh', 3], ['macam', 3], ['mana', 3], ['tak', 3], ['ubat', 3], ['tidur', 2], ['terima', 2], ['sudah', 2], ['belum', 2], ['pernah', 2], ['kenapa', 3], ['bagaimana', 2], ['adakah', 3], ['mahu', 3], ['nak', 3], ['bolehkah', 3], ['tolong', 2], ['perlukan', 2]] },
  hi: { words: [['मैं', 3], ['है', 2], ['कैसे', 3], ['क्या', 3], ['दवा', 3], ['नींद', 3], ['दर्द', 3], ['मुझे', 3], ['चाहिए', 3], ['कितना', 3], ['कल', 1], ['हाँ', 1], ['नहीं', 3], ['सुबह', 3], ['रात', 2], ['खाना', 3], ['पानी', 3]] },
  ar: { words: [['كيف', 3], ['ما', 1], ['هل', 3], ['أنا', 3], ['دواء', 3], ['نوم', 3], ['ألم', 3], ['متى', 3], ['كم', 3], ['مرحبا', 3], ['شكرا', 3], ['نعم', 2], ['لا', 1], ['طعام', 3], ['ماء', 3]] },
  fr: { words: [['je', 2], ['suis', 3], ['comment', 3], ['quoi', 2], ['pourquoi', 3], ['médicament', 3], ['sommeil', 3], ['douleur', 3], ['puis-je', 3], ['est-ce', 3], ['quand', 3], ['combien', 3], ['bonjour', 3], ['merci', 3], ['oui', 1], ['non', 2], ['nourriture', 3], ['eau', 3], ['besoin', 3], ['veux', 3]] },
  de: { words: [['ich', 2], ['bin', 3], ['wie', 2], ['was', 2], ['warum', 3], ['medikament', 3], ['schlaf', 3], ['schmerzen', 3], ['kann', 2], ['wann', 3], ['wieviel', 3], ['hallo', 3], ['danke', 3], ['ja', 1], ['nein', 3], ['essen', 3], ['wasser', 3], ['brauche', 3], ['nicht', 2], ['auch', 2], ['aber', 3], ['oder', 3]] },
};

// Scripts are unambiguous, so a single character in one of these ranges decides the
// language outright — EXCEPT that order matters here. Japanese writes with kanji,
// the same block Chinese uses, so a kanji-first list would report every Japanese
// member as Chinese. Kana never appears in Chinese, so it is tested first and wins
// whenever it is present.
const SCRIPTS = [
  ['ja', /[぀-ゟ゠-ヿ]/],
  ['ko', /[가-힯]/],
  ['ar', /[؀-۽]/],
  ['hi', /[ऀ-ॿ]/],
  ['th', /[๐-๿]/],
  ['zh', /[一-鿿]/],
];

const MAX_SCAN_CHARS = 4000;

const PHILIPPINE = ['fil', 'ceb', 'hil', 'bik', 'ilo', 'kap', 'pag', 'war'];

/** Languages this classifier recognises for the reply instruction only. */
const MAJOR_FALLBACK = ['es', 'pt', 'fr', 'de', 'id', 'ms', 'hi', 'ar', 'zh', 'ja', 'ko', 'vi', 'th'];

/** A non-Philippine language must beat the best Philippine score by this much to win. */
const PHIL_PRIORITY = 4;

/** Above this share of English stopwords, Filipino text is written as Taglish. */
const TAGLISH_SHARE = 0.5;

const byScore = (a, b) => b.score - a.score || a.code.localeCompare(b.code);

function pad(text) {
  return ` ${text} `;
}

/** Lowercase, fold typographic spaces, clip. Never mutates meaning. */
function prepare(text) {
  return pad(String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SCAN_CHARS));
}

function scoreLanguage(text, spec) {
  let score = 0;
  const hits = [];
  for (const entry of spec.words || []) {
    const [word, weight] = entry;
    if (!weight || !word) continue;
    // Word-anchored on both sides against a Unicode letter/digit, so `gba` does not
    // fire inside `bugba` and `so` does not fire inside `socola`.
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${safe}($|[^\\p{L}\\p{N}])`, 'gu');
    if (re.test(text)) { score += weight; hits.push(word); }
  }
  for (const entry of spec.phrases || []) {
    const [source, weight] = entry;
    if (!weight) continue;
    if (new RegExp(source, 'u').test(text)) { score += weight; hits.push(source); }
  }
  return { score, hits };
}

/**
 * How much of the text is an ordinary English word.
 *
 * Counting ASCII-only tokens looks adequate until you meet Tagalog, which is
 * entirely ASCII and full of short common-looking words: `ng`, `po`, `mo`, `di`,
 * `gawa`, `talaga`. On that measure every Filipino sentence is "100% English" and
 * the Taglish branch fires on plain Tagalog, mislabelling the member's own language
 * in the transcript and the admin monitor. A stoplist measures what the text
 * actually IS rather than what alphabet it uses.
 */
const ENGLISH_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'of', 'in', 'on',
  'at', 'to', 'for', 'with', 'without', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'am', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
  'may', 'might', 'must', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us',
  'them', 'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those', 'there',
  'here', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'not', 'no', 'yes', 'so',
  'because', 'about', 'into', 'over', 'under', 'again', 'more', 'most', 'some', 'any', 'all', 'each',
  'very', 'too', 'also', 'just', 'than', 'then', 'vitamin', 'vitamins', 'supplement', 'supplements',
  'tablet', 'tablets', 'dose', 'doses', 'dosage', 'sleep', 'tired', 'pain', 'stress', 'anxiety',
  'energy', 'digestion', 'protein', 'water', 'food', 'diet', 'exercise', 'plan', 'app', 'daily',
  'please', 'thanks', 'thank', 'hello', 'hi', 'hey', 'good', 'bad', 'better', 'best', 'help',
  'take', 'taking', 'took', 'felt', 'feel', 'feeling', 'since', 'during', 'while', 'before', 'after']);

function englishShare(text) {
  const words = text.trim().split(/[^\p{L}\p{N}'-]+/u).filter((w) => w.length > 1);
  if (!words.length) return 0;
  let known = 0;
  for (const w of words) if (ENGLISH_STOPWORDS.has(w)) known += 1;
  return known / words.length;
}

/**
 * @param {unknown} text free text as the member typed it
 * @returns {{code: string, label: string, confidence: number, shared: number,
 *   markers: string[], isEnglish: boolean, isPhilippine: boolean}}
 */
function detectLanguage(text) {
  const prepared = prepare(text);
  const base = { code: 'en', label: LANGUAGES.en, confidence: 0, shared: 0, markers: [], isEnglish: true, isPhilippine: false };
  if (!prepared.trim()) return base;

  for (const [code, re] of SCRIPTS) {
    if (!re.test(prepared)) continue;
    const label = LANGUAGES[code] || code;
    return { code, label, confidence: 0.95, shared: 0, markers: [`script:${code}`], isEnglish: false, isPhilippine: false };
  }

  const scoredAll = [];
  for (const [code, spec] of Object.entries(MARKERS)) {
    const { score, hits } = scoreLanguage(prepared, spec);
    if (score > 0 && hits.length >= 2) scoredAll.push({ code, score, hits, family: PHILIPPINE.includes(code) ? 'phil' : 'major' });
  }
  // A single accidental marker is not a language: `ng` sits inside English that has
  // no Tagalog in it at all, and `como` sits inside Filipino that has no Spanish in
  // it. Two distinct markers is the floor, and the pair must clear the family's own
  // bar — one Spanish word in a Filipino sentence is a loanword, not a second
  // language.
  const phil = scoredAll.filter((r) => r.family === 'phil').sort(byScore);
  const major = scoredAll.filter((r) => r.family === 'major').sort(byScore);
  const philBest = phil[0] || null;
  const majorBest = major[0] || null;

  // Filipino wins a close contest on purpose. This app's research population is
  // Filipino-speaking and its written register leans heavily on Spanish loanwords
  // (`sakramento`, `reseta`, `presyon`, `kudyapi` of a headache); a classifier that
  // let three loanwords outvote the ergative particles would answer a Tagalog
  // speaker in Spanish.
  const winner = philBest
    && (!majorBest || majorBest.score - philBest.score < PHIL_PRIORITY)
    ? philBest
    : (majorBest || philBest);

  if (!winner) {
    return base;
  }

  const runnerUp = (winner === philBest ? phil : major)[1]
    || (winner === philBest ? majorBest : philBest);
  // Two Philippine languages competing is a code-switched or regionally mixed
  // message. Filipino wins by design: it is the language this product's members
  // write when they are not sure which of their own languages the app reads.
  const resolved = runnerUp
    && runnerUp.code === 'fil'
    && PHILIPPINE.includes(winner.code)
    && winner.code !== 'fil'
    && winner.score - runnerUp.score <= 2
    ? { code: 'fil', score: runnerUp.score, hits: runnerUp.hits }
    : winner;

  const shared = englishShare(prepared);
  const isPhilippine = PHILIPPINE.includes(resolved.code);
  const taglish = resolved.code === 'fil' && shared >= TAGLISH_SHARE;
  const code = taglish ? 'fil_taglish' : resolved.code;
  const confidence = Math.max(0.3, Math.min(1, resolved.score / 9));

  return {
    code,
    label: LANGUAGES[code] || resolved.code,
    confidence: Number(confidence.toFixed(2)),
    shared: Number(shared.toFixed(2)),
    markers: resolved.hits.slice(0, 8),
    isEnglish: code === 'en',
    isPhilippine,
  };
}

/** True when the reply should be written in a Philippine language. */
function isPhilippineCode(code) {
  return Boolean(REPLY_LANGUAGE[String(code || '')]);
}

/** The language name to put in a prompt, or null when English is already implied. */
function replyLanguageName(code) {
  return REPLY_LANGUAGE[String(code || '')] || null;
}

module.exports = {
  LANGUAGES,
  REPLY_LANGUAGE,
  detectLanguage,
  isPhilippineCode,
  replyLanguageName,
  prepare,
};
