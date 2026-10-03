/**
 * timeSlots — grouping "Today's Supplements" by part of day.
 *
 * Run: npm test
 *
 * THE FAILURE THIS GUARDS AGAINST
 * Before this, the tracker rendered one flat list sorted by a keyword match on
 * `scheduledTime`. Two things went wrong with that, and both are invisible
 * until a user has a real plan:
 *
 *   1. Timing text that names no part of the day ("With a meal containing fat")
 *      sorted to the bottom, so a supplement the results page puts in the
 *      MORNING stack appeared after the evening ones. The user reads that as
 *      the plan being wrong.
 *   2. Nothing could tell whether a supplement was grouped or not, because
 *      there were no groups — so a "take the whole morning at once" action had
 *      no way to name what it was taking.
 *
 * What is pinned here:
 *   1. the server's `timeSlot` always wins over the free-text timing;
 *   2. the fallback never throws on junk and never silently DROPS a row;
 *   3. groups are ordered morning → afternoon → evening → night → anytime, and
 *      empty ones never render;
 *   4. sortPlan does not mutate its input (it runs inside setState).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_ORDER,
  SLOT_LABELS,
  slotOf,
  groupBySlot,
  takenCount,
  pendingIds,
  sortPlan,
} from './timeSlots.js';

// ── slotOf ─────────────────────────────────────────────────────────────────

test('slotOf trusts the server slot above the timing text', () => {
  assert.equal(slotOf({ timeSlot: 'morning', scheduledTime: 'Evening with dinner' }), 'morning');
  assert.equal(slotOf({ timeSlot: 'evening', scheduledTime: 'With breakfast' }), 'evening');
});

test('slotOf accepts the server slot in any case', () => {
  assert.equal(slotOf({ timeSlot: 'Afternoon' }), 'afternoon');
  assert.equal(slotOf({ timeSlot: 'MORNING' }), 'morning');
});

test('slotOf falls back to the timing text when no slot was sent', () => {
  assert.equal(slotOf({ scheduledTime: 'With breakfast' }), 'morning');
  assert.equal(slotOf({ scheduledTime: 'With lunch' }), 'afternoon');
  assert.equal(slotOf({ scheduledTime: 'Evening with dinner' }), 'evening');
  assert.equal(slotOf({ scheduledTime: '30 minutes before bed' }), 'night');
});

test('slotOf reads bedtime as bedtime, not evening', () => {
  // "Evening" and "before bed" can appear in the same sentence. The specific
  // one wins, or the user takes magnesium with dinner instead of at bedtime.
  assert.equal(slotOf({ scheduledTime: 'Evening, 30 min before bed' }), 'night');
  assert.equal(slotOf({ scheduledTime: 'Bedtime' }), 'night');
});

test('slotOf puts timing that names no part of the day in Anytime', () => {
  assert.equal(slotOf({ scheduledTime: 'With a meal containing fat' }), 'anytime');
  assert.equal(slotOf({ scheduledTime: 'Anytime' }), 'anytime');
  assert.equal(slotOf({ scheduledTime: 'As needed' }), 'anytime');
});

test('slotOf survives missing, empty and junk rows', () => {
  for (const value of [undefined, null, '', {}, []]) {
    assert.equal(slotOf(value), 'anytime', JSON.stringify(value));
    assert.equal(slotOf({ timeSlot: value }), 'anytime', JSON.stringify(value));
    assert.equal(slotOf({ scheduledTime: value }), 'anytime', JSON.stringify(value));
  }
  assert.equal(slotOf(), 'anytime');
});

test('slotOf ignores an unknown server slot rather than inventing one', () => {
  // A newer server could add "midday". Until this client knows the label, the
  // row belongs in Anytime — visible, not lost.
  assert.equal(slotOf({ timeSlot: 'midday', scheduledTime: 'With lunch' }), 'afternoon');
  assert.equal(slotOf({ timeSlot: 'brunch', scheduledTime: 'With meals' }), 'anytime');
});

// ── groupBySlot ────────────────────────────────────────────────────────────

test('groupBySlot groups a real plan by the clock', () => {
  const groups = groupBySlot([
    { id: '1', name: 'Magnesium Glycinate', timeSlot: 'evening' },
    { id: '2', name: 'Vitamin D3', timeSlot: 'morning' },
    { id: '3', name: 'Zinc Picolinate', timeSlot: 'afternoon' },
  ]);

  assert.deepEqual(groups.map((g) => g.key), ['morning', 'afternoon', 'evening']);
  assert.deepEqual(groups.map((g) => g.label), ['Morning', 'Afternoon', 'Evening']);
  assert.deepEqual(groups[0].items.map((i) => i.name), ['Vitamin D3']);
  assert.equal(groups[2].items[0].name, 'Magnesium Glycinate');
});

test('groupBySlot keeps clock order regardless of input order', () => {
  const keys = groupBySlot([
    { id: '1', timeSlot: 'night' },
    { id: '2', timeSlot: 'morning' },
    { id: '3', timeSlot: 'anytime' },
    { id: '4', timeSlot: 'evening' },
    { id: '5', timeSlot: 'afternoon' },
  ]).map((g) => g.key);
  assert.deepEqual(keys, ['morning', 'afternoon', 'evening', 'night', 'anytime']);
});

test('groupBySlot omits slots with nothing in them', () => {
  const groups = groupBySlot([
    { id: '1', timeSlot: 'morning' },
    { id: '2', timeSlot: 'evening' },
  ]);
  // No "Afternoon" header over an empty list.
  assert.deepEqual(groups.map((g) => g.key), ['morning', 'evening']);
});

test('groupBySlot returns nothing for an empty or invalid list', () => {
  assert.deepEqual(groupBySlot([]), []);
  assert.deepEqual(groupBySlot(undefined), []);
  assert.deepEqual(groupBySlot(null), []);
  assert.deepEqual(groupBySlot('nonsense'), []);
});

test('groupBySlot never drops a supplement, whatever it is given', () => {
  // Every row must appear exactly once. A row that fell through the slot lookup
  // would silently vanish from the user's plan.
  const rows = [
    { id: '1', timeSlot: 'morning' },
    { id: '2' },
    { id: '3', timeSlot: 'midday' },
    { id: '4', timeSlot: 'afternoon' },
    { id: '5', scheduledTime: 'Evening with dinner' },
    { id: '6', timeSlot: '' },
  ];
  const grouped = groupBySlot(rows).flatMap((g) => g.items);
  assert.equal(grouped.length, rows.length);
  assert.deepEqual(grouped.map((i) => i.id).sort(), ['1', '2', '3', '4', '5', '6']);
});

test('every label a group can render exists', () => {
  for (const key of SLOT_ORDER) {
    assert.equal(typeof SLOT_LABELS[key], 'string');
    assert.notEqual(SLOT_LABELS[key], '');
  }
});

// ── takenCount / pendingIds ────────────────────────────────────────────────

test('takenCount counts ticked rows', () => {
  assert.equal(takenCount([{ taken: true }, { taken: false }]), 1);
  assert.equal(takenCount([{ taken: true }, { taken: true }]), 2);
  assert.equal(takenCount([]), 0);
  assert.equal(takenCount(undefined), 0);
});

test('pendingIds returns only unticked rows that have an id', () => {
  // The ids go straight into a write request, so a row with no id must be
  // filtered out rather than sent as undefined.
  assert.deepEqual(
    pendingIds([{ id: 'a', taken: false }, { id: 'b', taken: true }, { id: 'c', taken: false }]),
    ['a', 'c'],
  );
  assert.deepEqual(pendingIds([{ taken: false }]), []);
  assert.deepEqual(pendingIds(undefined), []);
});

// ── sortPlan ───────────────────────────────────────────────────────────────

test('sortPlan orders untaken first, then by clock, then priority', () => {
  const sorted = sortPlan([
    { id: '1', name: 'Evening', timeSlot: 'evening', priority: 'High' },
    { id: '2', name: 'Morning', timeSlot: 'morning', priority: 'Low' },
    { id: '3', name: 'Morning high', timeSlot: 'morning', priority: 'High' },
  ]);
  assert.deepEqual(sorted.map((s) => s.name), ['Morning high', 'Morning', 'Evening']);
});

test('sortPlan sinks ticked rows to the end without losing their order', () => {
  const sorted = sortPlan([
    { id: '1', name: 'morning taken', timeSlot: 'morning', taken: true },
    { id: '2', name: 'morning open', timeSlot: 'morning', taken: false },
    { id: '3', name: 'evening open', timeSlot: 'evening', taken: false },
    { id: '4', name: 'evening taken', timeSlot: 'evening', taken: true },
  ]);
  assert.deepEqual(
    sorted.map((s) => s.name),
    ['morning open', 'evening open', 'morning taken', 'evening taken'],
  );
});

test('sortPlan does not mutate its input', () => {
  // It runs inside a setState updater, where mutating would corrupt the
  // previous state the updater is meant to be a pure function of.
  const rows = [
    { id: '1', timeSlot: 'evening', taken: false },
    { id: '2', timeSlot: 'morning', taken: false },
  ];
  const snapshot = rows.map((r) => r.id);
  const sorted = sortPlan(rows);
  assert.deepEqual(rows.map((r) => r.id), snapshot, 'input order must be unchanged');
  assert.notEqual(sorted, rows, 'a new array must be returned');
});

test('sortPlan sorts an unrecognised priority last, without dropping it', () => {
  // Unknown values fall to the same rank as Low (3), so a junk priority can
  // never outrank a real one — and the row is still there, at the end.
  const sorted = sortPlan([
    { id: '1', timeSlot: 'morning', priority: 'Urgent' },
    { id: '2', timeSlot: 'morning', priority: 'Low' },
  ]);
  assert.deepEqual(sorted.map((s) => s.id), ['2', '1']);
  assert.equal(sorted.length, 2);
});

test('sortPlan treats a missing priority like an unknown one', () => {
  const sorted = sortPlan([
    { id: '1', timeSlot: 'morning' },
    { id: '2', timeSlot: 'morning', priority: 'High' },
    { id: '3', timeSlot: 'morning', priority: 'Medium' },
  ]);
  assert.deepEqual(sorted.map((s) => s.id), ['2', '3', '1']);
});

test('sortPlan tolerates junk input', () => {
  assert.deepEqual(sortPlan([]), []);
  assert.deepEqual(sortPlan(undefined), []);
  assert.deepEqual(sortPlan(null), []);
});
