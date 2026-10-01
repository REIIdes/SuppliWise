/**
 * Daily schedule → time slots ("Today's Supplements" grouping).
 *
 * Run: npm test
 *
 * The property that matters:
 *
 *   THE DAILY SCHEDULE IS THE SOURCE OF TRUTH FOR *WHEN*, THE RECOMMENDATION'S
 *   OWN `timing` IS THE FALLBACK, AND NOTHING MAY EVER THROW.
 *
 * The results page renders Morning / Afternoon / Evening from the AI daily
 * schedule. The tracker renders the same supplements from IntakeRecords. If the
 * two disagree about which stack a supplement is in, the user is told to take
 * magnesium at breakfast on one page and at midnight on another, so the schedule
 * has to win — and when the schedule says nothing about a supplement, the
 * recommendation's own timing text decides.
 *
 * These tests pin:
 *   1. the schedule wins over timing, even when timing names a different slot;
 *   2. a slot the schedule does not mention still gets a sensible bucket;
 *   3. fuzzy name matching cannot bleed one supplement's slot into another
 *      ("Vitamin D" must not steal "Vitamin D3", "B12" must not steal "B Complex");
 *   4. junk input (nulls, objects, numbers, empty strings) resolves to Anytime
 *      instead of throwing or hiding a row;
 *   5. every returned key is one the frontend knows how to render.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SLOT_DEFS,
  timeSlotFromText,
  normalizeName,
  buildScheduleSlotIndex,
  resolveTimeSlot,
} = require('../utils/dailyScheduleSlots');

const KNOWN_KEYS = SLOT_DEFS.map(slot => slot.key);

// The schedule exactly as the AI emits it on the results page.
const SCHEDULE = [
  {
    time: 'Morning',
    supplements: [
      'Omega-3 Fish Oil (EPA/DHA)',
      'Vitamin D3 (Cholecalciferol)',
      'Vitamin B12 (Methylcobalamin)',
      'Probiotic (Lactobacillus and Bifidobacterium strains)',
      'Vitamin C (Ascorbic Acid)',
    ],
  },
  {
    time: 'Afternoon',
    supplements: ['Zinc Picolinate', 'Chromium Picolinate', 'Alpha-Lipoic Acid (R-ALAA)', 'Inositol (Myo-inositol)'],
  },
  {
    time: 'Evening',
    supplements: [
      'Magnesium Glycinate',
      'Coenzyme Q10 (Ubiquinol)',
      'Selenium (Selenomethionine)',
      'Vitamin K2 (MK-7)',
      'L-Carnitine (L-Carnitine Tartrate)',
      'N-Acetylcysteine (NAC)',
    ],
  },
];

// ── timeSlotFromText ───────────────────────────────────────────────────────

test('timeSlotFromText reads the words the AI actually uses', () => {
  assert.equal(timeSlotFromText('Morning, sublingual for best absorption'), 'morning');
  assert.equal(timeSlotFromText('With breakfast'), 'morning');
  assert.equal(timeSlotFromText('Evening with dinner'), 'evening');
  assert.equal(timeSlotFromText('With lunch'), 'afternoon');
  assert.equal(timeSlotFromText('30 minutes before bed'), 'night');
});

test('timeSlotFromText prefers the more specific bedtime wording over "evening"', () => {
  // "Evening, 30 min before bed" mentions evening first but means bedtime.
  assert.equal(timeSlotFromText('Evening, 30 min before bed'), 'night');
});

test('timeSlotFromText reads clock times', () => {
  assert.equal(timeSlotFromText('8:00 AM'), 'morning');
  assert.equal(timeSlotFromText('06:30'), 'morning');
  assert.equal(timeSlotFromText('1 PM'), 'afternoon');
  assert.equal(timeSlotFromText('20:00'), 'evening');
});

test('timeSlotFromText returns null for text that names no part of the day', () => {
  // null ≠ 'anytime': it is what tells the schedule index "drop this slot"
  // rather than "force these supplements into Anytime".
  assert.equal(timeSlotFromText('With meals'), null);
  assert.equal(timeSlotFromText('Anytime'), null);
  assert.equal(timeSlotFromText('With a meal containing fat'), null);
  assert.equal(timeSlotFromText(''), null);
  assert.equal(timeSlotFromText(undefined), null);
});

test('timeSlotFromText does not mistake an "am" inside a word for a time', () => {
  // "cream", "lamb" — substring matching on the meridiem pattern is safe only
  // because it is anchored to digits, and this pins that anchoring.
  assert.equal(timeSlotFromText('With cream, taken twice daily'), null);
});

// ── normalizeName ──────────────────────────────────────────────────────────

test('normalizeName strips the dosage tail and punctuation the AI appends', () => {
  assert.equal(normalizeName('Omega-3 Fish Oil (EPA/DHA)'), 'omega 3 fish oil epa dha');
  assert.equal(normalizeName('Magnesium Glycinate - 400 mg daily'), 'magnesium glycinate');
  assert.equal(normalizeName('  Vitamin   D3  '), 'vitamin d3');
  assert.equal(normalizeName(undefined), '');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(42), '42');
});

// ── The schedule decides ───────────────────────────────────────────────────

test('every supplement in the schedule lands in that schedule slot', () => {
  const index = buildScheduleSlotIndex(SCHEDULE);

  const cases = [
    ['Omega-3 Fish Oil (EPA/DHA)', 'morning'],
    ['Vitamin D3 (Cholecalciferol)', 'morning'],
    ['Vitamin C (Ascorbic Acid)', 'morning'],
    ['Zinc Picolinate', 'afternoon'],
    ['Inositol (Myo-inositol)', 'afternoon'],
    ['Magnesium Glycinate', 'evening'],
    ['L-Carnitine (L-Carnitine Tartrate)', 'evening'],
    ['N-Acetyl Cysteine (NAC)', 'evening'],
  ];

  for (const [name, expected] of cases) {
    assert.equal(resolveTimeSlot({ name, timing: 'With meals' }, index).key, expected, name);
  }
});

test('the schedule wins over a timing string that names a different slot', () => {
  const index = buildScheduleSlotIndex(SCHEDULE);
  // The recommendation says "Evening", the plan puts it in the morning stack.
  // The plan wins — that is the whole point of the sync.
  const slot = resolveTimeSlot({ name: 'Magnesium Glycinate', timing: 'Evening with dinner' }, index);
  assert.equal(slot.key, 'evening');
  assert.equal(slot.source, 'schedule');

  const morning = resolveTimeSlot({ name: 'Vitamin D3 (Cholecalciferol)', timing: 'Evening with dinner' }, index);
  assert.equal(morning.key, 'morning');
  assert.equal(morning.source, 'schedule');
});

test('a supplement the schedule does not mention falls back to its own timing', () => {
  const index = buildScheduleSlotIndex(SCHEDULE);
  const slot = resolveTimeSlot({ name: 'Melatonin', timing: '30 minutes before bed' }, index);
  assert.equal(slot.key, 'night');
  assert.equal(slot.source, 'timing');
  assert.equal(slot.timeLabel, '30 minutes before bed');
});

test('a supplement with no usable timing anywhere lands in Anytime, not nowhere', () => {
  const index = buildScheduleSlotIndex(SCHEDULE);
  for (const timing of [undefined, null, '', 'With meals', 'As needed']) {
    const slot = resolveTimeSlot({ name: 'Creatine', timing }, index);
    assert.equal(slot.key, 'anytime', String(timing));
    assert.ok(KNOWN_KEYS.includes(slot.key));
  }
});

test('resolveTimeSlot works with no schedule at all (empty index)', () => {
  const empty = buildScheduleSlotIndex([]);
  assert.equal(resolveTimeSlot({ name: 'Zinc Picolinate', timing: 'With lunch' }, empty).key, 'afternoon');
  assert.equal(resolveTimeSlot({ name: 'Zinc Picolinate', timing: 'With meals' }, empty).key, 'anytime');
  // And with no index passed at all, rather than crashing.
  assert.equal(resolveTimeSlot({ name: 'Zinc', timing: 'With breakfast' }).key, 'morning');
});

test('slots come back in display order with a label the UI can print', () => {
  const index = buildScheduleSlotIndex(SCHEDULE);
  const orders = SLOT_DEFS.map(({ order }) => order);
  assert.deepEqual([...orders].sort((a, b) => a - b), orders, 'slot order must be 0..n');

  const slot = resolveTimeSlot({ name: 'Zinc Picolinate', timing: 'With lunch' }, index);
  assert.equal(slot.label, 'Afternoon');
  assert.equal(SLOT_DEFS.find(def => def.key === slot.key).order, slot.order);
});

// ── Name matching must not bleed ───────────────────────────────────────────

test('a shorter schedule name cannot steal a more specific supplement', () => {
  const index = buildScheduleSlotIndex([
    { time: 'Morning', supplements: ['Vitamin D'] },
    { time: 'Evening', supplements: ['Vitamin D3 (Cholecalciferol)'] },
  ]);
  assert.equal(resolveTimeSlot({ name: 'Vitamin D3 (Cholecalciferol)', timing: 'With meals' }, index).key, 'evening');
  assert.equal(resolveTimeSlot({ name: 'Vitamin D', timing: 'With meals' }, index).key, 'morning');
});

test('different vitamins keep their own slots', () => {
  const index = buildScheduleSlotIndex([
    { time: 'Morning', supplements: ['Vitamin D3 (Cholecalciferol)'] },
    { time: 'Evening', supplements: ['Vitamin K2 (MK-7)'] },
  ]);
  assert.equal(resolveTimeSlot({ name: 'Vitamin D3 (Cholecalciferol)', timing: 'With meals' }, index).key, 'morning');
  assert.equal(resolveTimeSlot({ name: 'Vitamin K2 (MK-7)', timing: 'With meals' }, index).key, 'evening');
});

test('a B-complex record is not treated as a B12 record', () => {
  const index = buildScheduleSlotIndex([{ time: 'Morning', supplements: ['Vitamin B12 (Methylcobalamin)'] }]);
  // Neither mentions the other, so timing decides rather than a wrong morning.
  assert.equal(resolveTimeSlot({ name: 'B-Complex', timing: 'With breakfast' }, index).key, 'morning');
  assert.equal(resolveTimeSlot({ name: 'B-Complex', timing: 'With dinner' }, index).key, 'evening');
});

test('the same name in two schedule slots resolves deterministically', () => {
  // Malformed AI output (a supplement listed twice) must not make the renderer
  // flip between two answers across renders: the first entry wins, every time.
  const index = buildScheduleSlotIndex([
    { time: 'Morning', supplements: ['Magnesium Glycinate'] },
    { time: 'Evening', supplements: ['Magnesium Glycinate'] },
  ]);
  const first = resolveTimeSlot({ name: 'Magnesium Glycinate', timing: 'With meals' }, index);
  const second = resolveTimeSlot({ name: 'Magnesium Glycinate', timing: 'With meals' }, index);
  assert.equal(first.key, second.key);
  assert.equal(first.key, 'morning');
});

// ── Junk in must not throw ─────────────────────────────────────────────────

test('a malformed daily schedule is ignored rather than fatal', () => {
  for (const junk of [null, undefined, 'Morning', 42, {}, [{ time: 'Morning' }]]) {
    const index = buildScheduleSlotIndex(junk);
    const slot = resolveTimeSlot({ name: 'Zinc', timing: 'With lunch' }, index);
    assert.ok(KNOWN_KEYS.includes(slot.key), JSON.stringify(junk));
  }
});

test('supplement entries inside a slot may be objects or junk', () => {
  const index = buildScheduleSlotIndex([
    { time: 'Morning', supplements: [{ name: 'Vitamin D3' }, null, 7, { supplement: 'Zinc' }, ''] },
  ]);
  assert.equal(resolveTimeSlot({ name: 'Vitamin D3', timing: 'With meals' }, index).key, 'morning');
  assert.equal(resolveTimeSlot({ name: 'Zinc', timing: 'With meals' }, index).key, 'morning');
  assert.equal(resolveTimeSlot({ name: 'Nothing Like It', timing: 'With meals' }, index).key, 'anytime');
});

test('resolveTimeSlot survives junk supplement objects', () => {
  for (const junk of [undefined, null, {}, { name: null }, { name: {}, timing: [] }]) {
    const slot = resolveTimeSlot(junk, buildScheduleSlotIndex(SCHEDULE));
    assert.ok(KNOWN_KEYS.includes(slot.key), JSON.stringify(junk));
    assert.equal(typeof slot.label, 'string');
  }
});

test('slot times that name no part of the day are dropped, not forced to Anytime', () => {
  // "After a workout" is not a time of day. Indexing it as Anytime would make
  // those supplements override a perfectly good "morning" from their timing.
  const index = buildScheduleSlotIndex([
    { time: 'After a workout', supplements: ['Creatine'] },
    { time: 'Morning', supplements: ['Vitamin D3'] },
  ]);
  const slot = resolveTimeSlot({ name: 'Creatine', timing: 'Morning, before training' }, index);
  assert.equal(slot.key, 'morning');
  assert.equal(slot.source, 'timing');
});
