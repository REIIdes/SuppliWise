/**
 * supplementPrefill — auto-answering "Currently Taking Supplements?".
 *
 * Run: npm test
 *
 * The one property that must never break:
 *
 *   A PRE-FILL MAY ONLY EVER ADD AN ANSWER TO A BLANK QUESTION. IT MAY NEVER
 *   CHANGE AN ANSWER THE USER GAVE.
 *
 * Everything else here is downstream of that. A pre-fill that overwrote "No"
 * would be worse than no pre-fill at all: the user who stopped their
 * supplements would be told, on every visit, that they are still taking them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { prefillSupplements } from './supplementPrefill.js';

const DETECTED = {
  takingSupplements: true,
  supplements: ['Omega-3 Fish Oil (EPA/DHA)', 'Vitamin D3 (Cholecalciferol)'],
};

// ── The happy path ─────────────────────────────────────────────────────────

test('an unanswered question is filled from the detected plan', () => {
  assert.deepEqual(prefillSupplements('', DETECTED), {
    takingSupplements: 'Yes',
    currentSupplements: 'Omega-3 Fish Oil (EPA/DHA), Vitamin D3 (Cholecalciferol)',
  });
});

test('a null or undefined answer counts as unanswered', () => {
  for (const current of [null, undefined]) {
    assert.equal(prefillSupplements(current, DETECTED).takingSupplements, 'Yes');
  }
});

// ── Never override the user ────────────────────────────────────────────────

test('an existing "No" is never overwritten', () => {
  // The load-bearing case. "No" means they stopped; re-answering it as "Yes"
  // would have the assessment recommend supplements against their own account.
  assert.deepEqual(prefillSupplements('No', DETECTED), {});
});

test('an existing "Yes" is left exactly as the user left it', () => {
  // Their list may have been edited. Re-detecting must not undo that edit.
  assert.deepEqual(prefillSupplements('Yes', DETECTED), {});
});

test('an unexpected value is left alone rather than clobbered', () => {
  for (const current of ['yes', 'Y', 'true', 'maybe']) {
    assert.deepEqual(prefillSupplements(current, DETECTED), {}, current);
  }
});

// ── Do not answer a question we cannot fill ────────────────────────────────

test('nothing happens when detection reports no supplements', () => {
  assert.deepEqual(prefillSupplements('', { takingSupplements: false, supplements: [] }), {});
  assert.deepEqual(prefillSupplements('', { takingSupplements: true, supplements: [] }), {});
});

test('nothing happens when detection failed or has not arrived', () => {
  for (const detected of [undefined, null, {}, { error: 'network' }, 'nonsense', 0]) {
    assert.deepEqual(prefillSupplements('', detected), {}, JSON.stringify(detected));
  }
});

test('a Yes with nothing to list is refused, not left broken', () => {
  // "Yes" makes the free-text field required, so answering it with an empty
  // list would just move the validation error to the next submit.
  assert.deepEqual(prefillSupplements('', { takingSupplements: true, supplements: ['   ', '', null] }), {});
  assert.deepEqual(prefillSupplements('', { takingSupplements: true, supplements: 'not an array' }), {});
});

// ── The generated list is usable as-is ─────────────────────────────────────

test('junk entries are dropped rather than rendered into the textarea', () => {
  const out = prefillSupplements('', {
    takingSupplements: true,
    supplements: ['  Vitamin D3  ', '', null, undefined, 42, {}, 'Zinc'],
  });
  assert.equal(out.currentSupplements, 'Vitamin D3, Zinc');
});

test('duplicates collapse, order is preserved', () => {
  const out = prefillSupplements('', {
    takingSupplements: true,
    supplements: ['Zinc', 'Vitamin D3', 'Zinc'],
  });
  assert.equal(out.currentSupplements, 'Zinc, Vitamin D3');
});

test('duplicates that differ only in case collapse too', () => {
  // The AI writes "zinc picolinate" in one place and "Zinc Picolinate" in
  // another; listing the same bottle twice would just look like a mistake.
  const out = prefillSupplements('', {
    takingSupplements: true,
    supplements: ['Zinc Picolinate', 'zinc picolinate', 'Vitamin D3'],
  });
  assert.equal(out.currentSupplements, 'Zinc Picolinate, Vitamin D3');
});

test('a single supplement produces a clean list', () => {
  assert.deepEqual(prefillSupplements('', { takingSupplements: true, supplements: ['Melatonin'] }), {
    takingSupplements: 'Yes',
    currentSupplements: 'Melatonin',
  });
});

test('only the two known fields are ever returned', () => {
  // The result is spread into the whole form, so an extra key would have to be
  // one the form actually understands.
  assert.deepEqual(Object.keys(prefillSupplements('', DETECTED)).sort(), ['currentSupplements', 'takingSupplements']);
});
