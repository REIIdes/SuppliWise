/**
 * Tests for the checkout sheet's action bar.
 *
 * The bug these exist for: the bar's layout depends on HOW MANY actions it has,
 * and that used to be a hand-written condition per render branch
 * (`selfServe && !atProofStep`). Both summary branches render three actions, but
 * only the self-serve one was flagged as needing the primary on its own row —
 * and self-serve fails CLOSED, so the DEFAULT path squeezed "Upload proof of
 * payment" into a third of the bar, where it wrapped across three lines.
 *
 * So the assertions below are not about one label: they walk EVERY combination
 * of step × selfServe and assert the count and the layout agree, which is the
 * property that was broken. A future branch cannot reintroduce it without
 * failing here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildSheetActions,
  actionsNeedStack,
  actionBarClassName,
  KIND_PRIMARY,
  KIND_SECONDARY,
} from './sheetActions.js';

// Every combination the sheet can be in. The sheet has exactly two steps and a
// boolean deployment flag, and the bug lived in a disagreement BETWEEN them, so
// the matrix is the test.
const COMBINATIONS = [];
for (const step of ['summary', 'proof']) {
  for (const selfServe of [false, true]) COMBINATIONS.push({ step, selfServe });
}

// ══════════════════════════════════════════════════════════════════════════
// The regression itself
// ══════════════════════════════════════════════════════════════════════════

test('BOTH summary branches give the primary its own row, self-serve on or off', () => {
  for (const { selfServe } of COMBINATIONS.filter((c) => c.step === 'summary')) {
    const actions = buildSheetActions({ step: 'summary', selfServe, planName: 'Ultimate' });
    assert.equal(actions.length, 3, `summary selfServe=${selfServe} lost an action`);
    assert.equal(
      actionsNeedStack(actions), true,
      `summary selfServe=${selfServe} left three buttons sharing one row — the primary will wrap`,
    );
    assert.match(actionBarClassName(actions), /--stacked/);
  }
});

test('self-serve is off by default, and the default path is the stacked one', () => {
  // Guards the reason this shipped: `selfServe` fails closed, so the branch with
  // NO extra flag is the one almost every deployment takes.
  const actions = buildSheetActions({ step: 'summary' });
  assert.equal(actions.length, 3);
  assert.equal(actionsNeedStack(actions), true);
  assert.match(actionBarClassName(actions), /--stacked/);
});

test('the long label lives on a full-width row, not in a third', () => {
  // "Upload proof of payment" is the longest string the bar ever renders, and
  // it is the one that wrapped. Pin it: it must be the primary, on a stacked bar.
  const actions = buildSheetActions({ step: 'summary', selfServe: false });
  const primary = actions.filter((a) => a.kind === KIND_PRIMARY);
  assert.equal(primary.length, 1);
  assert.equal(primary[0].label, 'Upload proof of payment');
  assert.equal(actionsNeedStack(actions), true);
});

test('no label can exceed a third of the bar without the bar being stacked', () => {
  // The general form of the bug: if a bar has three actions and is NOT stacked,
  // each label must still fit in a third. 30 characters is a deliberately
  // generous ceiling — the real longest is "Upload proof of payment" (23).
  for (const { step, selfServe } of COMBINATIONS) {
    const actions = buildSheetActions({ step, selfServe, planName: 'Ultimate' });
    if (actions.length <= 2) continue;
    assert.equal(
      actionsNeedStack(actions), true,
      `${step}/selfServe=${selfServe}: ${actions.length} actions, not stacked`,
    );
    for (const item of actions) {
      assert.ok(item.label.length <= 30, `label "${item.label}" is too long for a third of the bar`);
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Shape, for every combination
// ══════════════════════════════════════════════════════════════════════════

test('every combination has exactly one primary, and it is last', () => {
  for (const { step, selfServe } of COMBINATIONS) {
    const actions = buildSheetActions({ step, selfServe, planName: 'Premium' });
    const where = `${step}/selfServe=${selfServe}`;
    const primaries = actions.filter((a) => a.kind === KIND_PRIMARY);
    assert.equal(primaries.length, 1, `${where} has ${primaries.length} primaries`);
    // Last, because the primary's whole job is the bottom-right of a checkout,
    // and on mobile it is the bottom of a column — the thumb's target.
    assert.equal(actions[actions.length - 1].kind, KIND_PRIMARY, `${where}: primary is not last`);
    assert.equal(actions[actions.length - 1], primaries[0]);
  }
});

test('keys are unique, so React never reuses a node across a step change', () => {
  for (const { step, selfServe } of COMBINATIONS) {
    const actions = buildSheetActions({ step, selfServe });
    const keys = actions.map((a) => a.key);
    assert.equal(new Set(keys).size, keys.length, `${step}: duplicate keys ${keys.join(',')}`);
  }
});

test('every action has a non-empty label and a known verb', () => {
  const KNOWN = new Set(['close', 'support', 'step:summary', 'step:proof', 'confirm', 'submit']);
  for (const { step, selfServe } of COMBINATIONS) {
    for (const item of buildSheetActions({ step, selfServe })) {
      assert.ok(item.key, `${step}: an action has no key`);
      assert.equal(typeof item.label, 'string');
      assert.ok(item.label.trim().length > 0, `${step}: "${item.key}" has an empty label`);
      assert.ok(KNOWN.has(item.action), `${step}: "${item.key}" has unknown action "${item.action}"`);
      assert.ok(
        item.kind === KIND_PRIMARY || item.kind === KIND_SECONDARY,
        `${step}: "${item.key}" has kind "${item.kind}"`,
      );
    }
  }
});

test('no two actions in a bar are labelled the same', () => {
  // Two identically-labelled buttons in one bar is a coin flip for the user.
  for (const { step, selfServe } of COMBINATIONS) {
    const labels = buildSheetActions({ step, selfServe }).map((a) => a.label);
    assert.equal(new Set(labels).size, labels.length, `${step}: duplicate labels ${labels.join(' | ')}`);
  }
});

test('the bar always offers a way out', () => {
  // A sheet you cannot leave is a trap. Every combination must carry a close or
  // a back action.
  for (const { step, selfServe } of COMBINATIONS) {
    const actions = buildSheetActions({ step, selfServe });
    const escape = actions.some((a) => a.action === 'close' || a.action === 'step:summary');
    assert.ok(escape, `${step}/selfServe=${selfServe} has no way out`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Labels and behaviour per branch
// ══════════════════════════════════════════════════════════════════════════

test('the summary names the plan it is confirming', () => {
  const actions = buildSheetActions({ step: 'summary', selfServe: true, planName: 'Ultimate' });
  const confirm = actions.find((a) => a.action === 'confirm');
  assert.equal(confirm.label, 'Confirm Ultimate');
  // Never the bare tier code — "Confirm PREMIUM" would be shouting and would not
  // match the card the member just clicked.
  assert.equal(confirm.label.includes('PREMIUM'), false);
});

test('the self-serve summary offers the transfer route, the default one offers support', () => {
  const withSelfServe = buildSheetActions({ step: 'summary', selfServe: true });
  const without = buildSheetActions({ step: 'summary', selfServe: false });
  assert.ok(withSelfServe.some((a) => a.action === 'step:proof'));
  assert.ok(withSelfServe.some((a) => a.label === 'I paid by transfer'));
  assert.ok(without.some((a) => a.action === 'support'));
  assert.equal(without.some((a) => a.action === 'step:proof' && a.kind === KIND_SECONDARY), false);
});

test('the proof step is always Back + Send, and only two of them', () => {
  for (const selfServe of [false, true]) {
    const actions = buildSheetActions({ step: 'proof', selfServe });
    assert.equal(actions.length, 2, `proof/selfServe=${selfServe} should be two actions`);
    assert.deepEqual(actions.map((a) => a.key), ['back', 'submit']);
    // Two actions fit a row comfortably, so no stacked class here.
    assert.equal(actionsNeedStack(actions), false);
    assert.equal(actionBarClassName(actions), 'pricing-sheet__actions');
  }
});

test('Send is blocked until a receipt is attached', () => {
  const blocked = buildSheetActions({ step: 'proof', canSubmit: false });
  assert.equal(blocked.find((a) => a.key === 'submit').disabled, true);
  // "Back" must stay live so the member is never trapped.
  assert.equal(blocked.find((a) => a.key === 'back').disabled, false);

  const ready = buildSheetActions({ step: 'proof', canSubmit: true });
  assert.equal(ready.find((a) => a.key === 'submit').disabled, false);
});

test('busy blocks the committing action and offers a progress label', () => {
  const actions = buildSheetActions({ step: 'summary', selfServe: true, busy: true });
  const confirm = actions.find((a) => a.key === 'confirm');
  assert.equal(confirm.disabled, true);
  assert.equal(confirm.busyLabel, 'Activating…');
  // The secondaries stop too, so a member cannot fire a second request while
  // the first is in flight.
  for (const item of actions.filter((a) => a.kind === KIND_SECONDARY)) {
    assert.equal(item.disabled, true, `${item.key} stayed live while busy`);
  }

  const proof = buildSheetActions({ step: 'proof', busy: true });
  assert.equal(proof.find((a) => a.key === 'submit').busyLabel, 'Sending…');
  assert.equal(proof.find((a) => a.key === 'back').disabled, true);
});

test('an idle bar disables nothing, and "Upload proof of payment" is never disabled', () => {
  // "Upload proof of payment" is a navigation step, not a commit — there is
  // nothing to fail, so it must never be greyed out.
  for (const { step, selfServe } of COMBINATIONS) {
    const actions = buildSheetActions({ step, selfServe, canSubmit: true });
    for (const item of actions) {
      assert.equal(item.disabled, false, `${step}/${item.key} disabled while idle`);
    }
  }
});

test('only the self-serve primary gets the arrow, and never the committing one', () => {
  const manual = buildSheetActions({ step: 'summary', selfServe: false });
  assert.equal(manual.find((a) => a.kind === KIND_PRIMARY).arrow, true);
  const instant = buildSheetActions({ step: 'summary', selfServe: true });
  assert.equal(instant.find((a) => a.key === 'confirm').arrow, undefined);
  // Back/Send are terminal, not navigational.
  for (const item of buildSheetActions({ step: 'proof' })) {
    assert.equal(item.arrow, undefined, `${item.key} should not carry an arrow`);
  }
});

test('the builder is pure: same input, same output, and it mutates nothing', () => {
  const input = { step: 'summary', selfServe: false, planName: 'Premium' };
  const first = buildSheetActions(input);
  const second = buildSheetActions(input);
  assert.deepEqual(first, second);
  // A caller that mutates the returned array must not corrupt the next call —
  // that would be a cross-render bug that only shows up after a state change.
  first.push({ key: 'injected', label: 'x', kind: KIND_SECONDARY, action: 'close' });
  assert.equal(buildSheetActions(input).length, 3);
  assert.deepEqual(input, { step: 'summary', selfServe: false, planName: 'Premium' });
});

test('a missing plan name still produces a usable label', () => {
  // Defensive: a plan added to the catalogue without display metadata must not
  // render a button reading "Confirm undefined".
  const actions = buildSheetActions({ step: 'summary', selfServe: true });
  const confirm = actions.find((a) => a.key === 'confirm');
  assert.equal(confirm.label.includes('undefined'), false);
  assert.equal(confirm.label.trim().length > 0, true);
});

test('actionsNeedStack is false for anything that is not a real list', () => {
  // Defensive, because this is called during render: a bad input must not throw
  // and take the pricing page down with it.
  for (const bad of [null, undefined, 'nope', 0, {}, []]) {
    assert.equal(actionsNeedStack(bad), false, `${JSON.stringify(bad)} should not stack`);
  }
  assert.equal(actionsNeedStack([]), false);
  assert.equal(actionsNeedStack([{}]), false);
  assert.equal(actionsNeedStack([{}, {}, {}]), true);
});

// ══════════════════════════════════════════════════════════════════════════
// Structural guards on the stylesheet
//
// These read the CSS as text rather than asserting behaviour, and that is a
// real limitation: there is no DOM here, so they cannot prove the bar does not
// wrap. What they CAN do is fail loudly if someone deletes the declarations that
// prevent it, which is the realistic way this regresses after the layout logic
// is already correct. The behavioural proof is the browser sweep.
// ══════════════════════════════════════════════════════════════════════════

const css = readFileSync(new URL('../Pages/PricingPage.css', import.meta.url), 'utf8');

/** The declaration block for the first rule with this exact selector. */
function blockFor(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(source);
  assert.ok(match, `no CSS rule found for "${selector}"`);
  return match[1];
}

test('the action bar may wrap, so a third button moves instead of being squeezed', () => {
  assert.match(
    blockFor(css, '.pricing-sheet__actions'),
    /flex-wrap:\s*wrap/,
    'without wrap, the last button is squeezed into the space left over',
  );
});

test('action-bar labels never break across lines', () => {
  assert.match(
    blockFor(css, '.pricing-sheet__actions .pricing-cta'),
    /white-space:\s*nowrap/,
    'a wrapped label is exactly what broke "Upload proof of payment"',
  );
});

test('action-bar buttons size from their label, not from the shared card rule', () => {
  // `.pricing-cta` sets `width: 100%` for the plan cards, and a flex item takes
  // its base size from `width` — so without this every button claimed the full
  // bar and each wrapped onto its own line.
  assert.match(
    blockFor(css, '.pricing-sheet__actions .pricing-cta'),
    /width:\s*auto/,
    'flex-basis: auto reads the base size from `width`',
  );
});

test('the stacked modifier exists and gives the primary a row of its own', () => {
  // The sheet applies `--stacked`; without this rule the class would be a no-op
  // and the three buttons would go back to sharing one row.
  assert.match(
    css,
    /\.pricing-sheet__actions--stacked\s+\.pricing-cta--primary\s*\{[^}]*flex-basis:\s*100%/s,
    'the --stacked class is applied by the sheet but does nothing without this rule',
  );
});
