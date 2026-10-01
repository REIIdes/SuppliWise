/**
 * Time-slot grouping for "Today's Supplements".
 *
 * Run: node --test src/utils/timeSlots.test.js
 *
 * THE FAILURE THIS GUARDS AGAINST
 * The AI returns the same plan twice: `recommendations` (each with free-text
 * `timing` like "With a meal containing fat") and `dailySchedule` (the
 * Morning / Afternoon / Evening grouping the results page renders). The tracker
 * used the free text alone, so a user saw one flat, unsorted list and had to
 * read every row to work out what belonged to breakfast. The server now
 * resolves the real slot per supplement and sends it as `timeSlot`; this module
 * is what the UI groups and sorts by, plus the local fallback that keeps an
 * older cached payload from collapsing into a single untitled block.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * The authoritative resolution (which name in the schedule matches which
 * recommendation) is server-side — utils/dailyScheduleSlots.js. This is only
 * the presentation layer, so it never has to guess across supplements: it reads
 * one `timeSlot` string per row.
 */

/** Display order. `anytime` is last so timed slots always read first. */
export const SLOT_ORDER = ['morning', 'afternoon', 'evening', 'night', 'anytime'];

export const SLOT_LABELS = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  // Labelled "Before Bed" rather than "Night": this is the 10 PM–midnight window,
  // and "Night" reads as the whole back half of the day, which is Evening.
  night: 'Before Bed',
  anytime: 'Anytime',
};

/* Checked most-specific-first below. `night` is tested before `evening` because
   "30 minutes before bed" mentions noon-free evening wording yet means bedtime,
   and a user who reads it as "with dinner" takes magnesium at the wrong hour. */
const SLOT_KEYWORDS = {
  night: ['before bed', 'before bedtime', 'at bedtime', 'bedtime', 'before sleeping', 'at night', 'overnight'],
  morning: ['early morning', 'first thing', 'upon waking', 'on waking', 'before breakfast', 'with breakfast', 'at breakfast', 'breakfast', 'empty stomach', 'fasting', 'morning'],
  afternoon: ['mid afternoon', 'midday', 'mid day', 'with lunch', 'at lunch', 'lunchtime', 'afternoon', 'lunch'],
  evening: ['with dinner', 'at dinner', 'dinnertime', 'early evening', 'evening', 'supper', 'dinner'],
};

const asText = (value) => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
};

/** Slot key for one row: the server's answer, else the timing text, else Anytime. */
export function slotOf(supplement) {
  const server = asText(supplement?.timeSlot).toLowerCase();
  if (SLOT_ORDER.includes(server)) return server;

  const text = asText(supplement?.scheduledTime).toLowerCase();
  if (!text) return 'anytime';
  if (SLOT_KEYWORDS.night.some((keyword) => text.includes(keyword))) return 'night';
  for (const key of ['morning', 'afternoon', 'evening']) {
    if (SLOT_KEYWORDS[key].some((keyword) => text.includes(keyword))) return key;
  }
  return 'anytime';
}

/**
 * [{ key, label, items }] in fixed display order, empty slots dropped.
 * Never returns an empty group, so no header can render over nothing.
 */
export function groupBySlot(supplements) {
  const list = Array.isArray(supplements) ? supplements : [];
  const buckets = new Map(SLOT_ORDER.map((key) => [key, []]));
  for (const supplement of list) {
    const key = slotOf(supplement);
    // Belt and braces: an unknown key would otherwise create a phantom group
    // and a supplement would vanish from the UI entirely.
    if (buckets.has(key)) buckets.get(key).push(supplement);
    else buckets.get('anytime').push(supplement);
  }
  return SLOT_ORDER
    .map((key) => ({ key, label: SLOT_LABELS[key], items: buckets.get(key) }))
    .filter((group) => group.items.length > 0);
}

/** How many of a group's items are ticked. */
export function takenCount(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item?.taken).length;
}

/** Ids of a group's unticked items — the rows a "take all" press should write. */
export function pendingIds(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && !item.taken && item.id)
    .map((item) => item.id);
}

const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };

/**
 * Untaken first, then by the clock, then by priority. A NEW array — the
 * caller's list is never mutated, which matters because this runs inside a
 * setState updater.
 *
 * The clock order is SLOT_ORDER itself, so a row's position inside its section
 * always agrees with the section it sits in.
 */
export function sortPlan(supplements) {
  return [...(Array.isArray(supplements) ? supplements : [])].sort((a, b) => {
    if (Boolean(a?.taken) !== Boolean(b?.taken)) return a?.taken ? 1 : -1;
    const timeA = SLOT_ORDER.indexOf(slotOf(a));
    const timeB = SLOT_ORDER.indexOf(slotOf(b));
    if (timeA !== timeB) return timeA - timeB;
    return (PRIORITY_ORDER[a?.priority] ?? 3) - (PRIORITY_ORDER[b?.priority] ?? 3);
  });
}
