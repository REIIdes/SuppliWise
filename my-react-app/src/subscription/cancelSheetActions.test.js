/**
 * Tests for the cancel sheet's action bar.
 *
 * The bug these guard against is not layout — it is the sheet telling the member
 * something untrue. "End it now" strips paid access the instant it is pressed;
 * "ask an administrator" changes nothing until a human says so. A commit button
 * that reads the same for both is a button that lies to anyone who cannot tell
 * the options apart, and a member who believes the wrong one loses a paid month
 * they thought they were keeping.
 *
 * So the assertions are about the promise the button makes, walking both modes
 * and every state that can change it. A future change to either door's wording
 * that stops naming the consequence fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCancelActions,
  cancelActionsNeedStack,
  cancelActionBarClassName,
  CANCEL_MODES,
  CANCEL_MODE_COPY,
  MODE_IMMEDIATE,
  MODE_REVIEW,
} from './cancelSheetActions.js';

// Both doors, plus a nonsense mode, because "what happens for a mode nobody
// defined" is exactly where a commit button starts lying.
const MODES = [...CANCEL_MODES, 'immediately', '', null, undefined];

// ══════════════════════════════════════════════════════════════════════════
// The regression: the button must name the consequence
// ══════════════════════════════════════════════════════════════════════════

test('the commit button says what pressing it actually does', () => {
  const review = buildCancelActions({ mode: MODE_REVIEW, planName: 'Premium' });
  const now = buildCancelActions({ mode: MODE_IMMEDIATE, planName: 'Premium' });

  const reviewLabel = review.find((a) => a.kind === 'primary').label;
  const nowLabel = now.find((a) => a.kind === 'primary').label;

  assert.notEqual(reviewLabel, nowLabel, 'the two doors must not share a button label');
  // "immediate" is not self-explanatory, so the label has to carry it.
  assert.match(nowLabel, /now/i, 'the immediate door must say it happens now');
  assert.match(reviewLabel, /request/i, 'the review door must say it is a request');
  // Neither may claim to end the plan, because neither alone does that.
  assert.equal(/end/i.test(reviewLabel), false, 'a request does not end the plan');
});

test('the plan being given up is named on the immediate button', () => {
  // "End it now" with no object is vague; the member must see WHAT ends.
  const actions = buildCancelActions({ mode: MODE_IMMEDIATE, planName: 'Ultimate' });
  assert.match(actions.find((a) => a.kind === 'primary').label, /Ultimate/);
});

test('an undefined mode falls back to the reversible door, not the destructive one', () => {
  // Fail SAFE. A missing or unknown mode must never default to the option that
  // destroys access the instant it is pressed.
  for (const mode of ['immediately', '', null, undefined, 'nonsense', 42]) {
    const actions = buildCancelActions({ mode, planName: 'Premium' });
    const primary = actions.find((a) => a.kind === 'primary');
    assert.equal(primary.label, 'Request cancellation', `mode ${JSON.stringify(mode)} did not fail safe`);
  }
});

test('both doors carry written consequences', () => {
  for (const mode of CANCEL_MODES) {
    const copy = CANCEL_MODE_COPY[mode];
    assert.ok(copy, `${mode} has no copy`);
    assert.ok(copy.label.trim().length > 0, `${mode} has no label`);
    assert.ok(copy.consequence.trim().length > 20, `${mode} has no real consequence text`);
  }
  // The immediate copy must warn about what is lost, not merely sound quick.
  assert.match(CANCEL_MODE_COPY[MODE_IMMEDIATE].consequence, /immediately/i);
  assert.match(CANCEL_MODE_COPY[MODE_IMMEDIATE].consequence, /not refunded|back to Free/i);
  // The review copy must promise the plan survives the wait.
  assert.match(CANCEL_MODE_COPY[MODE_REVIEW].consequence, /stays active/i);
});

test('an unknown mode still resolves to real copy, so nothing renders blank', () => {
  const actions = buildCancelActions({ mode: 'nonsense', planName: 'Premium' });
  assert.ok(actions.length > 0);
  for (const item of actions) {
    assert.ok(item.label && item.label.trim().length > 0, `blank label for ${item.key}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Shape, for every mode
// ══════════════════════════════════════════════════════════════════════════

test('every bar has exactly one primary, and it is last', () => {
  for (const mode of MODES) {
    const actions = buildCancelActions({ mode, planName: 'Premium' });
    const where = `mode ${JSON.stringify(mode)}`;
    assert.equal(actions.filter((a) => a.kind === 'primary').length, 1, where);
    // Last, for the same reason as checkout: on mobile it is the bottom of a
    // column, which is the thumb's target.
    assert.equal(actions[actions.length - 1].kind, 'primary', where);
  }
});

test('every bar offers a way out that is not the destructive action', () => {
  // A sheet you can only leave by cancelling is a trap.
  for (const mode of CANCEL_MODES) {
    const actions = buildCancelActions({ mode, planName: 'Premium' });
    const escape = actions.filter((a) => a.kind !== 'primary' && a.action === 'close');
    assert.equal(escape.length, 1, `mode ${mode} has no plain way out`);
    // Explicitly live, not merely "not disabled" — the way out must never be
    // greyed out, even while the destructive action is in flight.
    assert.equal(escape[0].disabled, false, `the way out must stay live`);
  }
});

test('keys are unique and actions are known', () => {
  for (const mode of MODES) {
    const actions = buildCancelActions({ mode, planName: 'Premium' });
    const keys = actions.map((a) => a.key);
    assert.equal(new Set(keys).size, keys.length, `mode ${mode}: duplicate keys`);
    for (const item of actions) {
      assert.ok(['close', 'commit'].includes(item.action), `unknown action "${item.action}"`);
      assert.ok(item.label.trim().length > 0, `"${item.key}" has an empty label`);
    }
  }
});

test('the bar is two actions, so it never needs the stacked layout', () => {
  // Unlike checkout's three-action summary, this bar is always two — and the
  // class is derived from the count so a future third button cannot forget.
  for (const mode of MODES) {
    const actions = buildCancelActions({ mode, planName: 'Premium' });
    assert.equal(actions.length, 2, `mode ${mode}`);
    assert.equal(cancelActionsNeedStack(actions), false);
    assert.equal(cancelActionBarClassName(actions), 'pricing-sheet__actions');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// State that must block or unblock the commit
// ══════════════════════════════════════════════════════════════════════════

test('an idle bar disables nothing', () => {
  for (const mode of CANCEL_MODES) {
    const actions = buildCancelActions({ mode, planName: 'Premium' });
    for (const item of actions) {
      assert.equal(item.disabled, false, `${mode}/${item.key} disabled while idle`);
    }
  }
});

test('busy blocks the commit and offers a progress label', () => {
  const review = buildCancelActions({ mode: MODE_REVIEW, planName: 'Premium', busy: true });
  assert.equal(review.find((a) => a.key === 'commit').disabled, true);
  assert.equal(review.find((a) => a.key === 'commit').busyLabel, 'Sending…');

  const now = buildCancelActions({ mode: MODE_IMMEDIATE, planName: 'Premium', busy: true });
  assert.equal(now.find((a) => a.key === 'commit').disabled, true);
  assert.equal(now.find((a) => a.key === 'commit').busyLabel, 'Ending…');
});

test('an open review request blocks a second one, but not an immediate cancel', () => {
  // The server answers 409 for a duplicate review, so the button says so up
  // front. An immediate cancel is a different operation and stays available —
  // a member who wants out now should not be told to wait for their own request.
  const blocked = buildCancelActions({ mode: MODE_REVIEW, planName: 'Premium', alreadyPending: true });
  assert.equal(blocked.find((a) => a.key === 'commit').disabled, true);

  const immediate = buildCancelActions({ mode: MODE_IMMEDIATE, planName: 'Premium', alreadyPending: true });
  assert.equal(immediate.find((a) => a.key === 'commit').disabled, false);
});

test('an account with nothing to cancel gets only a way out', () => {
  // Defensive: the sheet is never opened for a Free account, but if it were,
  // there is no honest commit button to show.
  const actions = buildCancelActions({ planName: 'Free', canCancel: false });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'close');
  assert.equal(actions.find((a) => a.kind === 'primary'), undefined, 'no destructive action may exist');
  assert.equal(cancelActionsNeedStack(actions), false);
});

// ══════════════════════════════════════════════════════════════════════════
// Purity — a cross-render bug would only show up after a state change
// ══════════════════════════════════════════════════════════════════════════

test('the builder is pure: same input, same output, and it mutates nothing', () => {
  const input = { mode: MODE_IMMEDIATE, planName: 'Premium' };
  const first = buildCancelActions(input);
  const second = buildCancelActions(input);
  assert.deepEqual(first, second);

  // A caller that mutates the result must not corrupt the next render.
  first.push({ key: 'injected', label: 'x', kind: 'secondary', action: 'close' });
  assert.equal(buildCancelActions(input).length, 2);
  assert.deepEqual(input, { mode: MODE_IMMEDIATE, planName: 'Premium' });
});

test('a missing plan name never renders "End undefined now"', () => {
  for (const planName of [undefined, '', null, 'undefined']) {
    const actions = buildCancelActions({ mode: MODE_IMMEDIATE, planName });
    const label = actions.find((a) => a.kind === 'primary').label;
    assert.equal(label.includes('undefined'), false, `rendered "${label}"`);
    assert.equal(label.trim().length > 0, true);
  }
});

test('cancelActionsNeedStack is false for anything that is not a real list', () => {
  // Called during render: a bad input must not throw and take the page down.
  for (const bad of [null, undefined, 'nope', 0, {}, []]) {
    assert.equal(cancelActionsNeedStack(bad), false, `${JSON.stringify(bad)}`);
  }
  assert.equal(cancelActionsNeedStack([]), false);
  assert.equal(cancelActionsNeedStack([{}]), false);
  assert.equal(cancelActionsNeedStack([{}, {}, {}]), true);
});
