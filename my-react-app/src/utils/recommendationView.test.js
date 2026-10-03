/**
 * recommendationView — the shared reading of an AI recommendation.
 *
 * Run: npm test
 *
 * These cases exist because each one is a bug that shipped. The comments say
 * which, because a test that does not say what it prevents tends to get
 * deleted by the next person who cannot see the point of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DETAIL_MODE_KEY,
  cleanTriggeredBy,
  confidenceOf,
  countByPriority,
  displayEvidence,
  displayReason,
  filterByPriority,
  fixChars,
  foodPills,
  hasInteractions,
  isOnPlan,
  isPlaceholderEvidence,
  nameKey,
  planPriority,
  priorityLabel,
  priorityOf,
  recName,
  severityTone,
  sortRecommendations,
  supplementIcon,
  usableEvidence,
} from './recommendationView.js';

// ── Priority: the bug that made the sort lie ─────────────────────────────

test('priority reads the same whatever case the AI used', () => {
  // The recommendations page keyed its sort table on lowercase and the results
  // page on capitalized. A capital "High" therefore missed every bucket on one
  // page, fell through to a shared default, and made the list sort by
  // confidence alone — so a Low could render above a High.
  for (const raw of ['High', 'high', 'HIGH', '  High  ', 'hIgH']) {
    assert.equal(priorityOf(raw), 'high', `priorityOf(${JSON.stringify(raw)})`);
  }
  for (const raw of ['Medium', 'medium', 'MEDIUM']) {
    assert.equal(priorityOf(raw), 'medium', `priorityOf(${JSON.stringify(raw)})`);
  }
  for (const raw of ['Low', 'low', 'LOW']) {
    assert.equal(priorityOf(raw), 'low', `priorityOf(${JSON.stringify(raw)})`);
  }
});

test('an unrecognised or absent priority floors to low, never throws', () => {
  // `low` is the least-prominent tone, so junk can never make a card look
  // important by accident. It also has to survive being absent entirely.
  for (const raw of ['', '   ', 'critical', 'urgent', 'High-ish', null, undefined, 0, {}, []]) {
    assert.equal(priorityOf(raw), 'low', `priorityOf(${JSON.stringify(raw)})`);
  }
});

test('the plan write is capitalized even when the read was not', () => {
  // The add-to-plan endpoint whitelists ['High','Medium','Low'] and silently
  // stores anything else as 'Medium'. Sending it the model's own "high" demoted
  // a high-priority supplement in the one place the user's day is built from,
  // with no error and nothing on screen to say so.
  assert.equal(planPriority('high'), 'High');
  assert.equal(planPriority('HIGH'), 'High');
  assert.equal(planPriority('Medium'), 'Medium');
  assert.equal(planPriority('low'), 'Low');
  assert.equal(planPriority('nonsense'), 'Low');
  assert.equal(planPriority(undefined), 'Low');
});

test('the plan write always satisfies the endpoint enum', () => {
  for (const raw of ['High', 'high', 'medium', 'Low', '', 'urgent', null, undefined, {}]) {
    assert.ok(
      ['High', 'Medium', 'Low'].includes(planPriority(raw)),
      `planPriority(${JSON.stringify(raw)}) produced ${planPriority(raw)}`,
    );
  }
});

test('priorityLabel is the capitalized spelling of the same reading', () => {
  assert.equal(priorityLabel('high'), 'High');
  assert.equal(priorityLabel('MEDIUM'), 'Medium');
  assert.equal(priorityLabel(undefined), 'Low');
});

// ── Severity ─────────────────────────────────────────────────────────────

test('severity reads its own vocabulary, including the soft labels', () => {
  assert.equal(severityTone('Severe'), 'high');
  assert.equal(severityTone('High'), 'high');
  assert.equal(severityTone('Moderate'), 'medium');
  assert.equal(severityTone('Mild'), 'low');
  // The rule engine uses these three for recommendations no symptom drives.
  assert.equal(severityTone('Mild to Moderate'), 'medium');
  assert.equal(severityTone('Preventive'), 'preventive');
  assert.equal(severityTone(''), 'none');
  assert.equal(severityTone(undefined), 'none');
});

// ── fixChars ─────────────────────────────────────────────────────────────

test('a lost dash is restored, and a real question mark is left alone', () => {
  // The storage sanitizer flattens every non-Latin-1 character, so an em dash
  // can arrive as U+2014 or as a literal '?'. Only a '?' wedged BETWEEN two
  // alphanumerics is damage — "Iron: 65mg?" is a genuine question.
  assert.equal(fixChars('Week 1 ? Build'), 'Week 1 - Build');
  assert.equal(fixChars('Magnesium ? 400mg'), 'Magnesium - 400mg');
  assert.equal(fixChars('How much?\nAnd when?'), 'How much?\nAnd when?');
  assert.equal(fixChars('Why? Because.'), 'Why? Because.');
});

test('unicode punctuation is normalized to plain ASCII', () => {
  assert.equal(fixChars('sleep \u2014 energy'), 'sleep - energy');
  assert.equal(fixChars('a \u2013 b'), 'a - b');
  assert.equal(fixChars('\u201cquoted\u201d'), '"quoted"');
  assert.equal(fixChars('it\u2019s'), "it's");
  assert.equal(fixChars('wait\u2026'), 'wait...');
});

test('fixChars never throws and never returns a non-string', () => {
  // Every reader interpolates its result straight into JSX, so a raw object
  // reaching here used to render as "[object Object]" on a clinical card.
  for (const raw of [null, undefined, '', 0, false, {}, [], ['a'], () => {}]) {
    const out = fixChars(raw);
    assert.equal(typeof out, 'string', `fixChars(${JSON.stringify(raw)})`);
  }
  assert.equal(fixChars(400), '400');
  assert.equal(fixChars(null), '');
});

// ── nameKey: the toggle that could not match itself ─────────────────────

test('a name matches itself across case, whitespace, markup and dosage tails', () => {
  // This is the whole add/remove toggle. The card looked itself up with
  // `rec.name`, the button it rendered used `rec.name || rec.supplement`, and
  // the plan came back with server-cleaned names. Any drift meant a card that
  // was already IN the plan still offered to add itself, and pressing it hit
  // "already in your plan for today" — a dead end with no way back.
  const key = nameKey('Magnesium Glycinate');
  for (const variant of [
    'magnesium glycinate',
    '  Magnesium   Glycinate  ',
    'MAGNESIUM GLYCINATE',
    'Magnesium Glycinate - 400mg',
    '<b>Magnesium Glycinate</b>',
    'Magnesium Glycinate (200mg)',
  ]) {
    assert.equal(nameKey(variant), key, `nameKey(${JSON.stringify(variant)})`);
  }
});

test('different supplements never collide', () => {
  // The load-bearing negative: a toggle that matches too much is worse than one
  // that matches too little, because it lights up a card the user never added.
  const keys = new Set([
    'Magnesium Glycinate',
    'Magnesium Citrate',
    'Zinc Picolinate',
    'Vitamin D3',
    'Omega-3 Fish Oil',
    'Iron Bisglycinate',
  ].map(nameKey));
  assert.equal(keys.size, 6);
});

test('form-words alone do not make one vitamin look like another', () => {
  // "Vitamin D" and "Vitamin D3" are different products, and "Vitamin D3 MK-7"
  // is a third. Without dropping generic words, all three reduce to the same
  // key and the plan toggle would light up whichever card it liked.
  assert.notEqual(nameKey('Vitamin D'), nameKey('Vitamin D3'));
  assert.notEqual(nameKey('Vitamin D3'), nameKey('Vitamin D3 MK-7'));
  // ...but the dosage tail and unit are not part of the identity.
  assert.equal(nameKey('Vitamin D3 2000 IU'), nameKey('Vitamin D3'));
});

test('an unusable name produces an empty key rather than a false match', () => {
  // A blank key would make every nameless card look like every other nameless
  // card — the plan toggle would claim supplements that are not on the plan.
  for (const raw of ['', '   ', null, undefined, {}, [], 'mg', '2000 IU daily']) {
    assert.equal(nameKey(raw), '', `nameKey(${JSON.stringify(raw)})`);
  }
});

test('the legacy `supplement` key is read as the name', () => {
  // Older records were written with `supplement`, newer with `name`. The card
  // used one key and the button the other, so a legacy record rendered with no
  // name at all.
  assert.equal(recName({ name: 'Zinc Picolinate' }), 'Zinc Picolinate');
  assert.equal(recName({ supplement: 'Zinc Picolinate' }), 'Zinc Picolinate');
  assert.equal(recName({ name: '  Zinc  ' }), 'Zinc');
  assert.equal(recName({}), '');
  assert.equal(recName(null), '');
  assert.equal(recName('a string'), '');
});

test('isOnPlan only answers true for a real match', () => {
  const plan = new Set([nameKey('Magnesium Glycinate')]);
  assert.equal(isOnPlan({ name: 'magnesium glycinate' }, plan), true);
  assert.equal(isOnPlan({ name: 'Magnesium Citrate' }, plan), false);
  // A missing set must not throw and must not claim a match.
  assert.equal(isOnPlan({ name: 'Magnesium Glycinate' }, null), false);
  assert.equal(isOnPlan({ name: 'Magnesium Glycinate' }), false);
  assert.equal(isOnPlan({}, plan), false);
});

// ── confidenceOf ─────────────────────────────────────────────────────────

test('confidence is clamped into a range a CSS width can use', () => {
  // The value is interpolated into `width: ${n}%`. An out-of-range or NaN score
  // rendered a bar that never filled, with nothing on screen to explain it.
  assert.equal(confidenceOf({ confidenceScore: 95 }), 95);
  assert.equal(confidenceOf({ confidenceScore: '88' }), 88);
  assert.equal(confidenceOf({ confidenceScore: 0 }), 0);
  assert.equal(confidenceOf({ confidenceScore: 100 }), 100);
  assert.equal(confidenceOf({ confidenceScore: 140 }), 100);
  assert.equal(confidenceOf({ confidenceScore: -20 }), 0);
  assert.equal(confidenceOf({ confidenceScore: 'abc' }), null);
  assert.equal(confidenceOf({ confidenceScore: NaN }), null);
  assert.equal(confidenceOf({ confidenceScore: Infinity }), null);
});

test('a missing confidence is null, not zero', () => {
  // The distinction decides whether the bar renders at all. Zero would draw an
  // empty track and read as "0% match" for a recommendation scored at 70.
  assert.equal(confidenceOf({}), null);
  assert.equal(confidenceOf({ confidenceScore: null }), null);
  assert.equal(confidenceOf({ confidenceScore: '' }), null);
  assert.equal(confidenceOf(null), null);
});

// ── evidence ─────────────────────────────────────────────────────────────

test('a citation template is not rendered as a citation', () => {
  // Told to cite a source and given none, the model emits the SHAPE of a
  // citation with the prompt's own example text. "Org/Author (Year). Title."
  // looks like a real reference the reader might act on, so it is refused.
  for (const junk of [
    'Org/Author (Year). Title. Source. URL if available.',
    'Author et al. (2023).',
    'Journal Name (Year)',
    'Cite 1-2 sources',
    'Xxxxxxx',
    'Brief finding here',
    'Source 2 if applicable',
    'short',
    '',
    null,
  ]) {
    assert.equal(isPlaceholderEvidence(junk), true, `isPlaceholderEvidence(${JSON.stringify(junk)})`);
    assert.equal(usableEvidence(junk), '', `usableEvidence(${JSON.stringify(junk)})`);
  }
});

test('a real citation survives', () => {
  const real = 'NIH Office of Dietary Supplements (2024). Magnesium Fact Sheet for Health Professionals.';
  assert.equal(isPlaceholderEvidence(real), false);
  assert.equal(usableEvidence(real), real);
});

// ── detail mode ──────────────────────────────────────────────────────────

test('simplified mode prefers the plain explanation and falls back cleanly', () => {
  // The preference is stored once and every page has to honour it, or a reader
  // who chose Simplified on the results page reads clinical prose here.
  const rec = { reason: 'Magnesium modulates NMDA receptor excitability.', simplifiedReason: 'Helps you sleep.' };
  assert.equal(displayReason(rec, 'simplified'), 'Helps you sleep.');
  assert.equal(displayReason(rec, 'detailed'), 'Magnesium modulates NMDA receptor excitability.');

  // An older record with only one of the two still renders something.
  assert.equal(displayReason({ reason: 'Only clinical.' }, 'simplified'), 'Only clinical.');
  assert.equal(displayReason({ simplifiedReason: 'Only plain.' }, 'detailed'), 'Only plain.');
  assert.equal(displayReason({}, 'simplified'), '');
  assert.equal(displayReason(null, 'detailed'), '');
});

test('evidence is filtered in both modes', () => {
  const rec = { evidence: 'NIH ODS (2024). Magnesium Fact Sheet.', simplifiedEvidence: 'Research supports this.' };
  assert.equal(displayEvidence(rec, 'simplified'), 'Research supports this.');
  assert.equal(displayEvidence(rec, 'detailed'), 'NIH ODS (2024). Magnesium Fact Sheet.');
  // A template is refused in either mode.
  assert.equal(displayEvidence({ evidence: 'Org/Author (Year).' }, 'detailed'), '');
  assert.equal(displayEvidence({}, 'simplified'), '');
});

test('the detail mode preference has one storage key', () => {
  // Two keys would mean two users on the same device, each believing the app
  // forgot their setting.
  assert.equal(DETAIL_MODE_KEY, 'suppliwise_detail_mode');
});

// ── triggeredBy ──────────────────────────────────────────────────────────

test('parenthetical severity is normalized to the three real labels', () => {
  // "(significant)" reads as a different clinical claim from "(Severe)".
  assert.equal(cleanTriggeredBy('Migraine, Nausea (Severe)'), 'Migraine, Nausea (Severe)');
  assert.equal(cleanTriggeredBy('Nausea (significant)'), 'Nausea (Severe)');
  assert.equal(cleanTriggeredBy('Fatigue (moderate)'), 'Fatigue (Moderate)');
  assert.equal(cleanTriggeredBy('Fatigue (slight)'), 'Fatigue (Mild)');
  assert.equal(cleanTriggeredBy(''), '');
  assert.equal(cleanTriggeredBy(null), '');
});

// ── food pills ───────────────────────────────────────────────────────────

test('a bare food category is expanded into examples the reader can shop for', () => {
  // "Nuts" on its own is a shopping aisle. Naming four of them turns it into
  // something the reader can act on, which is the point of the pill.
  const pills = foodPills('fatty fish, nuts, leafy greens');
  assert.deepEqual(pills, [
    'Fatty fish (salmon, tuna, sardines, mackerel)',
    'Nuts (almonds, cashews, walnuts, pumpkin seeds)',
    'Leafy greens (spinach, kale, Swiss chard)',
  ]);
});

test('a food that is already specific is left alone', () => {
  // Expanding "walnuts" into a list of other nuts loses the thing the reader
  // was actually told. Only a bare CATEGORY is worth expanding.
  assert.deepEqual(foodPills('walnuts'), ['walnuts']);
  assert.deepEqual(foodPills('kale, blueberries'), ['kale', 'blueberries']);
});

test('an already-expanded food is not expanded a second time', () => {
  const pills = foodPills('nuts (almonds, cashews)');
  assert.deepEqual(pills, ['nuts (almonds, cashews)']);
});

test('a food list with a trailing rationale still splits correctly', () => {
  const pills = foodPills('spinach, kale, such as chard, are rich in magnesium');
  assert.equal(pills.length, 2, JSON.stringify(pills));
  for (const pill of pills) {
    assert.ok(!pill.includes('such as'), pill);
    assert.ok(!pill.includes('rich in'), pill);
    assert.ok(!pill.startsWith(','), pill);
  }
});

test('a parenthesized list is not split from the outside', () => {
  // "greens (spinach, kale)" is ONE food. Splitting inside the parentheses
  // yields "greens (spinach" and "kale)" — two broken pills.
  const pills = foodPills('leafy greens (spinach, kale), walnuts');
  assert.equal(pills.length, 2, JSON.stringify(pills));
  assert.ok(pills[0].includes('('), pills[0]);
  assert.ok(pills[0].includes(')'), pills[0]);
});

test('an unusable food value produces no pills rather than empty ones', () => {
  // A pill with no text still occupies a pill's worth of space, so an empty
  // array has to mean "render nothing".
  for (const raw of ['', '   ', null, undefined, {}, ' , ; , ']) {
    assert.deepEqual(foodPills(raw), [], `foodPills(${JSON.stringify(raw)})`);
  }
});

test('duplicate foods collapse to one pill', () => {
  const pills = foodPills('spinach, spinach, kale');
  assert.equal(pills.length, 2, JSON.stringify(pills));
});

// ── icons ────────────────────────────────────────────────────────────────

test('a supplement gets a stable icon, and an unknown one a neutral pill', () => {
  assert.equal(supplementIcon('Magnesium Glycinate'), supplementIcon('magnesium glycinate'));
  assert.equal(supplementIcon(''), '💊');
  assert.equal(supplementIcon(null), '💊');
  assert.equal(supplementIcon('Unobtainium 9000'), '💊');
});

// ── ordering ─────────────────────────────────────────────────────────────

const RECS = [
  { name: 'Low One', priority: 'Low', confidenceScore: 99 },
  { name: 'High One', priority: 'High', confidenceScore: 70 },
  { name: 'Medium One', priority: 'Medium', confidenceScore: 80 },
  { name: 'High Two', priority: 'High', confidenceScore: 95 },
  { name: 'High Three', priority: 'HIGH', confidenceScore: 88 },
];

const names = (list) => list.map((rec) => rec.name);

test('priority leads, then confidence, whatever case the priority arrived in', () => {
  // "High Three" is capitalized in a table keyed on lowercase. It used to fall
  // through to a shared default alongside every other record, so the priority
  // clause was always 0 and the list silently sorted by confidence alone.
  assert.deepEqual(names(sortRecommendations(RECS, new Set())), [
    'High Two', 'High Three', 'High One', 'Medium One', 'Low One',
  ]);
});

test('a capitalized High outranks a 99%-confidence Low', () => {
  // The entire reason priority is assigned. If confidence can promote a Low
  // above a High, the priority the AI chose is decorative.
  const sorted = sortRecommendations(RECS, new Set());
  assert.ok(sorted.indexOf(RECS[1]) < sorted.indexOf(RECS[0]));
});

test('anything already on the plan sinks to the bottom', () => {
  // A card the user has acted on has done its job; leaving it above the ones
  // they have not makes the page look unchanged after they did the work.
  const plan = new Set([nameKey('High Two')]);
  const sorted = names(sortRecommendations(RECS, plan));
  assert.equal(sorted[sorted.length - 1], 'High Two');
});

test('a junk record is sorted, not dropped or crashed on', () => {
  const withJunk = [...RECS, null, undefined, 'a string', 42, {}];
  const sorted = sortRecommendations(withJunk, new Set());
  // Non-objects are excluded; an object with no name is kept and floored.
  assert.equal(sorted.length, 6);
  assert.ok(sorted.every((rec) => rec && typeof rec === 'object'));
});

test('sorting does not mutate the array it was given', () => {
  // It runs inside a setState updater, where the array is the previous state.
  const input = [...RECS];
  const before = names(input);
  sortRecommendations(input, new Set());
  assert.deepEqual(names(input), before);
});

test('a non-array sorts to an empty list rather than throwing', () => {
  for (const raw of [null, undefined, 'nope', 42, {}]) {
    assert.deepEqual(sortRecommendations(raw, new Set()), []);
  }
});

// ── filtering and counting ───────────────────────────────────────────────

test('the filter tabs and the badges read priority the same way', () => {
  // These used to disagree: the tab compared a lowercased string directly and
  // the badge went through the normalizer. A card could carry a "low" badge
  // and appear under no tab at all, or vice versa.
  const mixed = [
    { name: 'A', priority: 'High' },
    { name: 'B', priority: 'high' },
    { name: 'C', priority: 'Medium' },
    { name: 'D', priority: 'Low' },
    { name: 'E' },
  ];
  assert.equal(filterByPriority(mixed, 'high').length, 2);
  assert.equal(filterByPriority(mixed, 'medium').length, 1);
  // A record with no priority is badged low, so it must be in the low tab.
  assert.equal(filterByPriority(mixed, 'low').length, 2);
  assert.equal(filterByPriority(mixed, 'all').length, 5);
  assert.equal(filterByPriority(mixed, undefined).length, 5);
});

test('counts match what the filter returns, for every tab', () => {
  // The counts on the tabs are the reader's only way to know a filter will not
  // be empty. If they disagree with the filter, the tab lies.
  const mixed = [
    { name: 'A', priority: 'High' }, { name: 'B', priority: 'high' },
    { name: 'C', priority: 'Medium' }, { name: 'D', priority: 'Low' },
    { name: 'E' }, null, 'junk',
  ];
  const counts = countByPriority(mixed);
  for (const tab of ['all', 'high', 'medium', 'low']) {
    assert.equal(
      filterByPriority(mixed, tab).length,
      counts[tab],
      `count for ${tab} disagrees with the filter`,
    );
  }
});

test('counting an empty or junk list yields zeroes, not NaN', () => {
  assert.deepEqual(countByPriority([]), { all: 0, high: 0, medium: 0, low: 0 });
  assert.deepEqual(countByPriority(null), { all: 0, high: 0, medium: 0, low: 0 });
});

// ── interactions ─────────────────────────────────────────────────────────

test('"None identified" is treated as nothing to flag, everything else is', () => {
  // This is the most consequential string on the card: a reader on warfarin
  // who takes "None identified" as reassurance has been told something the AI
  // may not know. It is surfaced as a caution, not as a green tick.
  assert.equal(hasInteractions('None identified'), false);
  assert.equal(hasInteractions('none'), false);
  assert.equal(hasInteractions('N/A'), false);
  assert.equal(hasInteractions(''), false);
  assert.equal(hasInteractions(null), false);
  assert.equal(hasInteractions('Warfarin — keep Vitamin K intake consistent'), true);
  assert.equal(hasInteractions('Separate from thyroid medication by 2 hours'), true);
});
