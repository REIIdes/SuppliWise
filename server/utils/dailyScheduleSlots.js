/**
 * Time slots for "Today's Supplements".
 *
 * THE PROBLEM THIS SOLVES
 * The AI returns two views of the same plan: `recommendations` (each with a free
 * text `timing` such as "Morning, sublingual for best absorption" or "With a
 * meal containing fat") and `dailySchedule` (Morning / Afternoon / Evening
 * slots, which is what the results page renders). The tracker used the free
 * text alone, so the morning stack of the results page arrived as one long
 * unsorted list and the user had to read every row to work out what belongs to
 * which part of the day.
 *
 * THE ORDER OF TRUST
 * 1. The daily schedule wins. It is the clinician-shaped grouping the user
 *    already sees on the results page, so it is the one that must agree with
 *    the tracker.
 * 2. The recommendation's own `timing` is the fallback for anything the
 *    schedule does not mention.
 * 3. "Anytime" is the floor — never a crash, never a hidden row.
 *
 * Matching is name-based and deliberately conservative: an exact match first,
 * then a whole-word containment scored by specificity, so "Vitamin D" in the
 * schedule can never steal "Vitamin D3 (Cholecalciferol)"'s slot (the longer,
 * more specific name is tested first and wins).
 */

// Fixed display order. `anytime` is last so timed slots always read first.
const SLOT_DEFS = [
  { key: 'morning', label: 'Morning', order: 0 },
  { key: 'afternoon', label: 'Afternoon', order: 1 },
  { key: 'evening', label: 'Evening', order: 2 },
  { key: 'night', label: 'Night', order: 3 },
  { key: 'anytime', label: 'Anytime', order: 4 },
];

const SLOT_BY_KEY = SLOT_DEFS.reduce((acc, slot) => {
  acc[slot.key] = slot;
  return acc;
}, {});

// Checked in this order, most specific first. "before bed" must be tested
// before "evening", otherwise "Evening, 30 min before bed" would land in the
// evening bucket the user reads as "with dinner".
const SLOT_PHRASES = [
  {
    key: 'night',
    phrases: [
      'before bed', 'before bedtime', 'at bedtime', 'bedtime', 'before sleeping',
      'just before sleep', 'at night', 'overnight', 'night',
    ],
  },
  {
    key: 'morning',
    phrases: [
      'early morning', 'first thing', 'upon waking', 'on waking', 'after waking',
      'before breakfast', 'with breakfast', 'at breakfast', 'breakfast',
      'empty stomach', 'on an empty stomach', 'fasting', 'morning',
    ],
  },
  {
    key: 'afternoon',
    phrases: [
      'mid afternoon', 'midday', 'mid day', 'with lunch', 'at lunch', 'lunchtime',
      'afternoon', 'lunch',
    ],
  },
  {
    key: 'evening',
    phrases: [
      'with dinner', 'at dinner', 'dinnertime', 'early evening', 'evening',
      'supper', 'dinner',
    ],
  },
];

// Words that add no identity when two supplement names are compared. Without
// them "Vitamin D" and "Vitamin D3" share nothing and no match is possible.
const GENERIC_WORDS = new Set([
  'vitamin', 'vitamins', 'mineral', 'minerals', 'acid', 'acids', 'complex',
  'supplement', 'supplements', 'extract', 'powder', 'capsule', 'capsules',
  'tablet', 'tablets', 'serving', 'servo', 'dose', 'daily', 'mg', 'mcg', 'iu',
  'form', 'food', 'grade', 'natural', 'pure',
]);

const asText = (value) => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
};

/**
 * Slot key for a piece of free text, or null when the text names no part of
 * the day ("With meals", "Anytime", "", nonsense). null is deliberately not
 * 'anytime': it is the difference between "this says morning" and "this says
 * nothing useful", and the schedule index needs to know the difference.
 */
function timeSlotFromText(value) {
  const text = asText(value).toLowerCase();
  if (!text) return null;

  for (const { key, phrases } of SLOT_PHRASES) {
    if (phrases.some((phrase) => text.includes(phrase))) return key;
  }

  // Clock times: "8:00 AM", "6 pm", "13:00", "07:30".
  const meridiem = text.match(/\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/);
  if (meridiem) {
    const hour = Number(meridiem[1]);
    if (meridiem[2] === 'am') return 'morning';
    return hour >= 17 ? 'evening' : 'afternoon';
  }
  const twentyFour = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    if (hour < 12) return 'morning';
    return hour < 17 ? 'afternoon' : 'evening';
  }

  return null;
}

/** Lowercase, punctuation-free, dosage tail removed: "Vitamin D3 - 2000 IU" → "vitamin d3". */
function normalizeName(value) {
  return asText(value)
    .split(/\s+[-–—]\s+/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const significantWords = (normalized) =>
  normalized.split(' ').filter((word) => word.length > 1 && !GENERIC_WORDS.has(word));

/** Bigram set of a squashed string, used for the spelling-drift check below. */
function bigrams(value) {
  const set = new Set();
  for (let i = 0; i < value.length - 1; i += 1) {
    set.add(value.slice(i, i + 2));
  }
  return set;
}

/** Sørensen–Dice coefficient over character bigrams: 1 = identical, 0 = unrelated. */
function diceSimilarity(a, b) {
  if (a === b) return 1;
  // Below ~6 characters a single shared bigram reads as a near-perfect score
  // ("k2" vs "k3"), so short names are never fuzzy-matched at all.
  if (a.length < 6 || b.length < 6) return 0;
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  let shared = 0;
  for (const gram of bigramsA) {
    if (bigramsB.has(gram)) shared += 1;
  }
  return (2 * shared) / (bigramsA.size + bigramsB.size);
}

/**
 * How strongly two names refer to the same supplement. Higher is better;
 * 0 means "not the same supplement".
 *
 *   1000 exact            "magnesium glycinate" === "magnesium glycinate"
 *    500 one contains the other as whole words ("vitamin d3" ⊂ "vitamin d3 mk 7")
 *    300 identical significant words, any order ("coq10" ≈ "coenzyme q10")
 *    100 spelling drift   "n acetyl cysteine" ≈ "n acetylcysteine"
 *
 * The 100 tier exists because the AI writes the same compound both ways —
 * "N-Acetylcysteine" in the schedule, "N-Acetyl Cysteine" in the recommendation
 * — and the two are the same pill. It is kept last and heavily gated so it can
 * never override a real difference: "zinc picolinate" scores ~0.55 against
 * "chromium picolinate" and is therefore left to the timing fallback.
 */
function nameMatchScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1000 + a.length;

  const aWords = a.split(' ').filter(Boolean);
  const bWords = b.split(' ').filter(Boolean);
  const [shorter, longer] = aWords.length <= bWords.length ? [aWords, bWords] : [bWords, aWords];
  const aCore = significantWords(a);
  const bCore = significantWords(b);

  // Containment needs at least one word that actually identifies a supplement,
  // otherwise every "Vitamin" record would match every other "Vitamin" record.
  if (shorter.length > 0 && (aCore.length > 0 || bCore.length > 0)) {
    let matched = 0;
    for (const word of longer) {
      if (word === shorter[matched]) matched += 1;
    }
    if (matched === shorter.length) return 500 + shorter.length;
  }

  const coreA = aCore.slice().sort();
  const coreB = bCore.slice().sort();
  if (coreA.length > 0 && coreA.length === coreB.length && coreA.every((w, i) => w === coreB[i])) {
    return 300 + coreA.length;
  }

  // Spelling drift, on generic words stripped out so "vitamin" cannot inflate
  // the score. 0.85 is tight on purpose: see the note above.
  if (diceSimilarity(coreA.join(''), coreB.join('')) >= 0.85) {
    return 100;
  }

  return 0;
}

/**
 * Index the AI daily schedule by supplement name.
 * Entries with an unrecognised slot time ("After a workout") are dropped so the
 * recommendation's own timing still gets a say.
 */
function buildScheduleSlotIndex(dailySchedule) {
  const entries = [];
  if (!Array.isArray(dailySchedule)) return { entries, byName: new Map() };

  for (const slot of dailySchedule) {
    if (!slot || typeof slot !== 'object') continue;
    const slotText = asText(slot.time);
    const slotKey = timeSlotFromText(slotText);
    if (!slotKey) continue;
    const timeLabel = slotText.slice(0, 60);
    const supplements = Array.isArray(slot.supplements) ? slot.supplements : [];

    for (const raw of supplements) {
      const rawName = typeof raw === 'string' ? raw : (raw && (raw.name || raw.supplement));
      const name = normalizeName(rawName);
      if (!name) continue;
      entries.push({ name, words: name.split(' ').filter(Boolean), slotKey, timeLabel });
    }
  }

  // Longest name first, so the most specific schedule entry is the one a
  // shorter record name can match.
  entries.sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));

  const byName = new Map();
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }

  return { entries, byName };
}

/** Best schedule entry for a supplement name, or null. */
function lookupScheduleSlot(index, supplementName) {
  if (!index || !index.entries || index.entries.length === 0) return null;
  const name = normalizeName(supplementName);
  if (!name) return null;

  const exact = index.byName.get(name);
  if (exact) return exact;

  let best = null;
  let bestScore = 0;
  for (const entry of index.entries) {
    if (entry.name === name) continue;
    const score = nameMatchScore(name, entry.name);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

/**
 * Resolve one supplement to its slot.
 * @param {{name?: string, timing?: string}} supplement
 * @param {ReturnType<typeof buildScheduleSlotIndex>} [index]
 * @returns {{key: string, label: string, order: number, timeLabel: string, source: 'schedule'|'timing'|'default'}}
 */
function resolveTimeSlot(supplement, index) {
  const timing = asText(supplement && supplement.timing) || 'Anytime';
  const fromSchedule = lookupScheduleSlot(index, supplement && supplement.name);

  if (fromSchedule) {
    const def = SLOT_BY_KEY[fromSchedule.slotKey];
    return {
      key: def.key,
      label: def.label,
      order: def.order,
      timeLabel: fromSchedule.timeLabel || def.label,
      source: 'schedule',
    };
  }

  const timingKey = timeSlotFromText(timing);
  if (timingKey) {
    const def = SLOT_BY_KEY[timingKey];
    return { key: def.key, label: def.label, order: def.order, timeLabel: timing, source: 'timing' };
  }

  const fallback = SLOT_BY_KEY.anytime;
  return {
    key: fallback.key,
    label: fallback.label,
    order: fallback.order,
    timeLabel: timing || fallback.label,
    source: 'default',
  };
}

module.exports = {
  SLOT_DEFS,
  normalizeName,
  timeSlotFromText,
  buildScheduleSlotIndex,
  lookupScheduleSlot,
  resolveTimeSlot,
  // exported for tests
  nameMatchScore,
};
