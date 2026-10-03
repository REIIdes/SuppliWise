/**
 * One reading of an AI recommendation, shared by every page that renders one.
 *
 * Run: node --test src/utils/recommendationView.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * The same recommendation is rendered in three places — the results page, the
 * history page and the recommendations page — and each of them grew its own copy
 * of the same questions:
 *
 *   "what priority is this?"      three implementations, two casings
 *   "strip the mojibake"          three copies of one regex chain
 *   "is this evidence real?"      two copies, one of them unreachable
 *   "which food pills?"           two copies of a 40-line splitter
 *
 * A copy is free to answer a question slightly differently, and then the same
 * recommendation reads as high priority on one page and medium on another. That
 * is not a cosmetic difference: the priority decides what the tracker nudges
 * first, and it is written to the plan.
 *
 * So: every question is asked here, once, and the pages import the answer.
 * Nothing in this module touches React, the network or the DOM — it is plain
 * data in, plain data out, which is what makes it directly testable.
 */

/* ── Text repair ─────────────────────────────────────────────────────────
   AI output reaches us through a sanitizer that flattens every non-Latin-1
   character, so an em dash stored as U+2014 and one that arrived as a literal
   '?' are the same damage wearing different clothes. Both have to be repaired
   or the user reads "Week 1 ? Build" as a typo in the product. */

// eslint-disable-next-line no-control-regex -- the control range IS the point here
const NON_LATIN1 = /[^\x09\x0A\x0D\x20-\xFF]/g;

/**
 * Repair the characters a round-trip through storage destroys.
 * Returns '' for anything that is not text, so callers can render it directly.
 */
export function fixChars(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return '';
  return value
    // A '?' with whitespace on BOTH sides is a lost dash. The rule is
    // deliberately strict, because the alternative is rewriting a real
    // question: every corruption this repairs arrived as "Week 1 ? Build" or
    // "Hotline ? Call", whereas a genuine question mark never has a space in
    // front of it ("Why? Because", "65mg?"). Matching tighter than this turned
    // real questions into dashes.
    .replace(/([a-zA-Z0-9])[ \t]+\?[ \t]+([a-zA-Z0-9])/g, '$1 - $2')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(NON_LATIN1, '')
    // An em dash usually arrives with a space on each side already, so
    // substituting ' - ' produced "sleep  -  energy". Tidy the spacing the
    // substitution itself created, without collapsing indentation elsewhere.
    .replace(/[ \t]+-[ \t]+/g, ' - ');
}

/* ── Priority ───────────────────────────────────────────────────────────
   The single most consequential normalization in the app.

   The AI is asked for "High|Medium|Low". The prompt says so, the rule engine
   emits exactly that, and the model has honoured it so far — but nothing
   ENFORCED it, and the three readers disagreed about what to do when it didn't:

     - the recommendations page keyed its sort on lowercase, so a capital "High"
       missed every bucket, fell through to a shared default, and the list
       quietly sorted by confidence alone. A low-priority supplement could
       appear above a high-priority one.
     - the results and history pages keyed theirs on capitalized, so the same
       record sorted correctly there and wrongly here.
     - the add-to-plan endpoint whitelists ['High','Medium','Low']. Send it
       "high" and it is silently stored as "Medium" — a high-priority
       supplement demoted in the one place the user's day is built from, with
       no error and nothing on screen to say so.

   `priorityOf` is the case-insensitive read every view uses.
   `planPriority` is the capitalized write the endpoint's enum requires. */

/** Canonical lowercase priority. Unknown or absent floors to 'low'. */
export function priorityOf(priority) {
  const key = typeof priority === 'string' ? priority.trim().toLowerCase() : '';
  return key === 'high' || key === 'medium' || key === 'low' ? key : 'low';
}

/** The capitalized form the plan endpoint's enum accepts. Never throws. */
export function planPriority(priority) {
  const key = priorityOf(priority);
  return key.charAt(0).toUpperCase() + key.slice(1);
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/** Display label for a priority chip. */
export function priorityLabel(priority) {
  const key = priorityOf(priority);
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/* ── Severity ───────────────────────────────────────────────────────────
   A separate axis from priority: priority is "how soon should I start this",
   severity is "how bad is the thing driving it". The rule engine emits
   'High' | 'Moderate' | 'Low' plus three softer labels it uses for
   non-symptom-driven recommendations. */

// Order matters: these are anchored prefixes, so the two-word label has to be
// tested before "mild" claims it. "Mild to Moderate" is the rule engine's label
// for a high-priority recommendation no severe symptom drives — its ceiling is
// Moderate, so it reads as medium.
const SEVERITY_TONES = [
  [/^(mild to moderate|mild-to-moderate)/i, 'medium'],
  [/^(severe|critical|high)/i, 'high'],
  [/^(moderate|medium|noticeable|marked)/i, 'medium'],
  [/^(mild|low|minor)/i, 'low'],
  [/^(preventive|general|supportive)/i, 'preventive'],
];

/** CSS tone for a severity label, with a safe floor for junk data. */
export function severityTone(severity) {
  const text = typeof severity === 'string' ? severity.trim() : '';
  if (!text) return 'none';
  for (const [test, tone] of SEVERITY_TONES) {
    if (test.test(text)) return tone;
  }
  return 'none';
}

/* ── Name identity ──────────────────────────────────────────────────────
   The bug this fixes.

   "Add to my plan" is a toggle, and a toggle is only honest if both sides ask
   the same question of the name. They did not:

     - the card looked itself up with `rec.name`
     - the button it rendered used `rec.name || rec.supplement`
     - the plan came back from the server with names that had been through
       `cleanSupplementName` (markup stripped, trimmed, capped at 200 chars)
     - the AI writes "Magnesium Glycinate" in one field and "magnesium
       glycinate" in another

   So a card could be IN the plan and still offer to add itself, and pressing
   that button returned "This supplement is already in your plan for today" —
   a dead end with no way back, because the remove path looked it up by the
   same mismatched key.

   `nameKey` is the one identity both sides are reduced to. */

/** Words that identify the FORM of a supplement, not which supplement it is.
    Without this, "vitamin d" would match "vitamin d3", "vitamin d3 mk-7" and
    "vitamin d" alike, and the toggle would light up the wrong card. */
const GENERIC_WORDS = new Set([
  'vitamin', 'vitamins', 'mineral', 'minerals', 'acid', 'acids', 'complex',
  'supplement', 'supplements', 'extract', 'powder', 'capsule', 'capsules',
  'tablet', 'tablets', 'softgel', 'softgels', 'gummies', 'serving', 'servings',
  'dose', 'daily', 'mg', 'mcg', 'iu', 'ug', 'g', 'ml', 'form', 'food', 'grade',
  'natural', 'pure', 'free',
]);

/**
 * The identity a supplement name reduces to: lowercase, no punctuation, no
 * markup, no dosage tail, generic form-words dropped. Two names that normalize
 * to the same key are the same bottle.
 */
export function nameKey(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  let text = String(value).replace(/<[^>]*>/g, ' ');
  // "Vitamin D3 - 2000 IU" is a schedule entry, not a name.
  text = text.split(/\s+[-–—]\s+/)[0];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 1 && !GENERIC_WORDS.has(word) && !isMeasure(word))
    .join(' ')
    .trim();
}

/**
 * A measurement, not an identity: "2000", "400mg", "5000iu".
 *
 * The same recommendation is written with and without its dose depending on
 * which field it came from — "Magnesium Glycinate" in `name`, "Magnesium
 * Glycinate (400mg)" in a schedule entry. If the dose stayed in the key, the
 * card and the plan would disagree about whether they are the same bottle.
 *
 * `b12` is NOT a measurement and is kept: it identifies the supplement.
 */
function isMeasure(word) {
  return /^\d+[a-z]*$/.test(word);
}

/** The recommendation's display name, tolerating the legacy `supplement` key. */
export function recName(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const name = rec.name ?? rec.supplement;
  if (typeof name === 'string' && name.trim()) return name.trim();
  return '';
}

/** True when `rec` is already on the plan. */
export function isOnPlan(rec, planKeys) {
  const key = nameKey(recName(rec));
  if (!key || !(planKeys instanceof Set)) return false;
  return planKeys.has(key);
}

/* ── Confidence ────────────────────────────────────────────────────────
   The prompt asks for 70-100. The model has been trusted with that, and the
   value is then interpolated straight into a CSS width — so it is clamped here
   rather than in each of the three places that draw the bar. A NaN would
   otherwise render as `width: NaN%`, which the browser discards, leaving a bar
   that never fills and no error anywhere. */
export function confidenceOf(rec) {
  const raw = rec && typeof rec === 'object' ? rec.confidenceScore : null;
  if (raw === null || raw === undefined || raw === '') return null;
  const score = Number(raw);
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ── Evidence ───────────────────────────────────────────────────────────
   When the model is told to cite a source and has none to give, it very
   often emits the shape of a citation with the contents left as the prompt's
   own example text. Rendering "Org/Author (Year)" as evidence is worse than
   rendering nothing, because it looks like a real reference the user might
   act on. */

/** True when `text` is a citation-shaped template rather than a real one. */
export function isPlaceholderEvidence(text) {
  if (!text) return true;
  const t = String(text).toLowerCase();
  if (t.length < 15) return true;
  return (
    t.includes('author et al') ||
    t.includes('(year)') ||
    t.includes('xxxxxxx') ||
    t.includes('source 2 if applicable') ||
    t.includes('brief finding') ||
    t.includes('journal name') ||
    t.includes('cite 1-2') ||
    t.includes('org/author') ||
    t.includes('url if available')
  );
}

/** Evidence worth showing, or '' when the AI left a template behind. */
export function usableEvidence(text) {
  if (isPlaceholderEvidence(text)) return '';
  return fixChars(text);
}

/* ── Text chosen by the reader's detail mode ────────────────────────────
   The AI writes two versions of its explanation: a clinical `reason` and a
   plain-language `simplifiedReason`. A reader who chose Simplified on the
   results page must get Simplified here too — the preference is stored once
   (localStorage 'suppliwise_detail_mode') and this is where it is honoured. */

export const DETAIL_MODE_KEY = 'suppliwise_detail_mode';

/** The explanation for the current mode, falling back to the other one. */
export function displayReason(rec, detailMode) {
  if (!rec || typeof rec !== 'object') return '';
  if (detailMode === 'simplified') {
    return fixChars(rec.simplifiedReason || rec.reason);
  }
  return fixChars(rec.reason || rec.simplifiedReason);
}

/** The citation for the current mode, or '' if there is nothing real to show. */
export function displayEvidence(rec, detailMode) {
  if (!rec || typeof rec !== 'object') return '';
  const text = detailMode === 'simplified'
    ? (rec.simplifiedEvidence || rec.evidence)
    : (rec.evidence || rec.simplifiedEvidence);
  return usableEvidence(text);
}

/* ── triggeredBy ───────────────────────────────────────────────────────
   The AI is told to write severity in parentheses, e.g. "Migraine, Nausea
   (Severe)". It also writes "(significant)", "(quite bad)" and similar, which
   read as a different clinical claim from the one the label is meant to carry. */

// The three labels the prompt actually asks for. Everything the model writes
// instead is mapped onto one of them.
const SEVERITY_LABELS = { mild: 'Mild', moderate: 'Moderate', severe: 'Severe' };

/** Normalize the parenthetical severity labels in a triggeredBy string. */
export function cleanTriggeredBy(value) {
  const text = fixChars(value);
  if (!text) return '';
  return text.replace(/\(([^)]+)\)/g, (match, inner) => {
    const raw = inner.trim();
    // Canonicalize, don't just pass through: "(moderate)" and "(Severe)" on
    // the same page read as two different vocabularies, and a filter or test
    // keyed on the exact label silently misses the lowercase one.
    const exact = SEVERITY_LABELS[raw.toLowerCase()];
    if (exact) return `(${exact})`;
    if (/significant|severe|critical|extreme/i.test(raw)) return '(Severe)';
    if (/moderate|medium|notable|marked/i.test(raw)) return '(Moderate)';
    if (/mild|slight|minor|low/i.test(raw)) return '(Mild)';
    // Not a severity claim at all — a qualifier, a dosage note. Keep it.
    return `(${fixChars(raw)})`;
  });
}

/* ── Food sources ──────────────────────────────────────────────────────
   "4-6 foods" comes back as a comma-separated string, and the model cannot
   resist adding a sentence about why they matter:
     "fatty fish, walnuts, , such as salmon, are rich in omega-3"
   Splitting that naively produces pills reading ", such as salmon" and
   "are rich in omega-3". Parenthesized lists are common and must not be split
   from the outside, or "greens (spinach, kale)" becomes two broken pills. */

/** Generic food category → concrete examples the reader can act on. */
const FOOD_SPECIFICS = {
  'fatty fish': 'fatty fish (salmon, tuna, sardines, mackerel)',
  'leafy greens': 'leafy greens (spinach, kale, Swiss chard)',
  'leafy green': 'leafy greens (spinach, kale, Swiss chard)',
  nuts: 'nuts (almonds, cashews, walnuts, pumpkin seeds)',
  dairy: 'dairy (Greek yogurt, cheddar cheese, whole milk)',
  'dairy products': 'dairy (Greek yogurt, cheddar cheese, whole milk)',
  citrus: 'citrus (oranges, grapefruit, kiwi)',
  'citrus fruits': 'citrus (oranges, grapefruit, kiwi)',
  legumes: 'legumes (lentils, chickpeas, black beans)',
  'whole grains': 'whole grains (oats, brown rice, quinoa)',
  'lean meats': 'lean meats (chicken breast, turkey, lean beef)',
  'lean meat': 'lean meats (chicken breast, turkey, lean beef)',
  'red meat': 'red meat (beef, lamb, bison)',
  shellfish: 'shellfish (oysters, clams, crab, shrimp)',
  seeds: 'seeds (pumpkin seeds, sunflower seeds, chia seeds)',
  berries: 'berries (blueberries, strawberries, raspberries)',
  'cruciferous vegetables': 'cruciferous vegetables (broccoli, Brussels sprouts, cauliflower)',
  'organ meats': 'organ meats (beef liver, chicken liver)',
  'fermented foods': 'fermented foods (kefir, kimchi, sauerkraut, miso)',
};

/** Strip the trailing rationale the model appends to a food list. */
function stripFoodRationale(text) {
  return String(text)
    .replace(/,?\s*(such as|which are|are naturally|naturally rich|found in|including)[^,;]*/gi, '')
    .replace(/,?\s*are\s+[a-z].*$/gi, '')
    .trim()
    .replace(/,\s*$/, '');
}

/** Replace a bare category word with concrete examples, if it is one. */
function expandFoodItem(item) {
  const text = String(item || '').trim();
  if (!text) return '';
  // Already expanded — the parenthetical IS the expansion.
  if (text.includes('(') && text.includes(')')) return text;
  const lower = text.toLowerCase();
  for (const [key, expanded] of Object.entries(FOOD_SPECIFICS)) {
    if (lower === key || lower.startsWith(`${key} `) || lower.endsWith(` ${key}`)) {
      return expanded.charAt(0).toUpperCase() + expanded.slice(1);
    }
  }
  return text;
}

/** Split on commas/semicolons that are not inside parentheses. */
function splitTopLevel(text) {
  const items = [];
  let current = '';
  let depth = 0;
  for (const ch of String(text || '')) {
    if (ch === '(') { depth += 1; current += ch; }
    else if (ch === ')') { depth = Math.max(0, depth - 1); current += ch; }
    else if ((ch === ',' || ch === ';') && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/**
 * The food sources as a clean list of pills. Always returns an array, so a
 * caller can render it without checking — and an empty array means "say
 * nothing", which is the correct outcome for a missing or unusable value.
 */
export function foodPills(foods) {
  if (!foods) return [];
  const source = typeof foods === 'string' ? foods : fixChars(foods);
  if (!source) return [];
  const cleaned = stripFoodRationale(source) || source;
  const items = splitTopLevel(cleaned).map(expandFoodItem).filter(isAFood);
  const final = items.length > 0 ? items : [expandFoodItem(cleaned)].filter(isAFood);
  // Two pills reading identically is a rendering bug the user would have to
  // report; drop the duplicate here instead.
  return [...new Set(final)];
}

/** A pill is only worth rendering if it names something. Punctuation left
    behind by the stripping pass (" , ;") occupies a pill's worth of space
    while saying nothing. */
function isAFood(item) {
  return typeof item === 'string' && /[a-z0-9]/i.test(item);
}

/* ── Icons ─────────────────────────────────────────────────────────────
   Cosmetic, but a card with a different emoji per page for the same
   supplement is the kind of drift nobody notices until a user mentions it. */

const SUPPLEMENT_ICONS = [
  ['magnesium', '🧲'], ['vitamin d', '☀️'], ['vitamin b', '💉'], ['b12', '💉'],
  ['omega', '🐟'], ['fish oil', '🐟'], ['iron', '🔴'], ['zinc', '🛡️'],
  ['vitamin c', '🍊'], ['calcium', '🦴'], ['coq10', '❤️'], ['probiotic', '🦠'],
  ['ashwagandha', '🌿'], ["lion's mane", '🍄'], ['curcumin', '🟡'], ['berberine', '🌱'],
  ['selenium', '⚡'], ['collagen', '💪'], ['creatine', '💪'], ['melatonin', '🌙'],
  ['vitamin k', '🥦'], ['riboflavin', '🟠'], ['theanine', '🍵'], ['glucosamine', '🦴'],
];

/** An emoji for a supplement name, longest keyword first so "vitamin d3" is
    not claimed by a bare "vitamin" entry. */
export function supplementIcon(name) {
  const text = String(name || '').toLowerCase();
  if (!text) return '💊';
  let best = null;
  for (const [keyword, icon] of SUPPLEMENT_ICONS) {
    if (!text.includes(keyword)) continue;
    if (!best || keyword.length > best[0].length) best = [keyword, icon];
  }
  return best ? best[1] : '💊';
}

/* ── Ordering ──────────────────────────────────────────────────────────
   The list the user reads has one job: put what matters most at the top.

   Priority first — that is the whole point of the AI assigning it. Within a
   priority, confidence descending, so the better-evidenced item leads. And
   anything already on the plan sinks to the bottom: a card the user has acted
   on has done its job, and leaving it above the ones they have not makes the
   page look no different after they do the work.

   The comparator never mutates its input, because it runs inside a setState
   updater where the array is the previous state. */

function recPriorityRank(rec) {
  return PRIORITY_RANK[priorityOf(rec && rec.priority)];
}

/**
 * Sort a copy of `recs` by: not-on-plan, then priority, then confidence.
 * @param {Array} recs
 * @param {Set<string>} planKeys normalized names already on the plan
 */
export function sortRecommendations(recs, planKeys) {
  return [...usableRecs(recs)].sort((a, b) => {
    const aOnPlan = isOnPlan(a, planKeys);
    const bOnPlan = isOnPlan(b, planKeys);
    if (aOnPlan !== bOnPlan) return aOnPlan ? 1 : -1;

    const pa = recPriorityRank(a);
    const pb = recPriorityRank(b);
    if (pa !== pb) return pa - pb;

    return (confidenceOf(b) || 0) - (confidenceOf(a) || 0);
  });
}

/**
 * The records a list actually contains, as objects.
 *
 * `aiResults` is Mixed, so a recommendation can be null, a bare string, or
 * missing entirely. The filter and the counter must agree about which of those
 * count, or the number on a tab disagrees with the rows the tab renders.
 */
function usableRecs(recs) {
  return (Array.isArray(recs) ? recs : []).filter((rec) => rec && typeof rec === 'object');
}

/** The recommendations matching one filter tab. */
export function filterByPriority(recs, tab) {
  const list = usableRecs(recs);
  if (!tab || tab === 'all') return list;
  const want = String(tab).toLowerCase();
  return list.filter((rec) => priorityOf(rec.priority) === want);
}

/** How many recommendations sit in each priority bucket. */
export function countByPriority(recs) {
  const counts = { all: 0, high: 0, medium: 0, low: 0 };
  for (const rec of usableRecs(recs)) {
    counts.all += 1;
    counts[priorityOf(rec.priority)] += 1;
  }
  return counts;
}

/** The four filter tabs, in the order they read. */
export const PRIORITY_TABS = [
  { key: 'all', label: 'All Recommendations' },
  { key: 'high', label: 'High priority' },
  { key: 'medium', label: 'Medium priority' },
  { key: 'low', label: 'Low priority' },
];

/* ── Interactions ──────────────────────────────────────────────────────
   "None identified" is a claim about the patient's medication list, and it is
   the single most consequential string on the card: a user on warfarin who
   reads it as reassurance has been told something the AI may not know. It is
   shown, never hidden — but the page styles it as a caution, not a green tick. */

const NO_INTERACTIONS = /^(none|no|none identified|not applicable|n\/a|nil|nothing)\b/i;

/** Interactions text worth flagging, or '' when there is nothing to flag. */
export function hasInteractions(value) {
  const text = fixChars(value);
  if (!text) return false;
  return !NO_INTERACTIONS.test(text.trim());
}
