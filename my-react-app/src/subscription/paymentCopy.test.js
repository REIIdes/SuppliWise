/**
 * Tests for paymentCopy — "how am I supposed to pay?"
 *
 * The bug: the proof step said "send us your payment receipt and an
 * administrator will check it" and never said where to send it. A member had no
 * account to transfer to, so the flow asked for proof of a payment nobody could
 * make.
 *
 * The property under test is therefore about HONESTY, not formatting. The
 * screen must never invite a payment the deployment cannot receive, because a
 * member who pays anyway and uploads a genuine receipt waits forever for an
 * approval nobody can verify. That is worse than offering no transfer route at
 * all, so it fails CLOSED — an absent, malformed or failed payload must all land
 * on the administrator route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProofCopy,
  paymentDetailRows,
  paymentInstructionText,
  paymentReferenceHint,
  transferIsAvailable,
  PAY_AVAILABLE,
  PAY_UNAVAILABLE,
} from './paymentCopy.js';

const BANK = {
  available: true,
  method: 'bank_transfer',
  accountName: 'SuppliWise Operations',
  bankName: 'Example Commercial Bank',
  accountNumber: '1234-5678-90',
  instructions: 'Send the exact amount shown, then upload the receipt.',
  referenceHint: 'Use your email address as the reference.',
  contactEmail: 'billing@example.com',
  reason: '',
};

const NO_BANK = {
  available: false,
  method: '', accountName: '', bankName: '', accountNumber: '',
  instructions: '', contactEmail: '', referenceHint: '',
  reason: 'No payment details have been set up for this deployment yet.',
};

// ══════════════════════════════════════════════════════════════════════════
// The failure that must never happen
// ══════════════════════════════════════════════════════════════════════════

test('the transfer route is offered only when a destination actually exists', () => {
  assert.equal(buildProofCopy({ planName: 'Ultimate', payment: BANK }).canUseTransfer, true);
  // The whole point: with nowhere to send money, the transfer route must be
  // GONE rather than shown with a promise attached.
  assert.equal(buildProofCopy({ planName: 'Ultimate', payment: NO_BANK }).canUseTransfer, false);
});

test('an absent payment payload fails CLOSED', () => {
  // An older server that does not send the field, or a payload that failed to
  // load, must not be read as "there is somewhere to pay".
  for (const payment of [null, undefined, {}, { available: 'yes' }, { available: 1 }, 'yes', 42]) {
    assert.equal(transferIsAvailable(payment), false, `${JSON.stringify(payment)} opened the transfer route`);
    assert.equal(buildProofCopy({ payment }).canUseTransfer, false);
  }
});

test('a truthy-but-not-true `available` does not open the route', () => {
  // `available: 'true'` from a stringly-typed API is not a yes.
  assert.equal(transferIsAvailable({ available: 'true' }), false);
  assert.equal(transferIsAvailable({ available: 1 }), false);
  assert.equal(transferIsAvailable({ available: true }), true);
});

test('no destination means no account number is ever shown', () => {
  // Printing an account while claiming there is nothing to transfer to would be
  // the worst possible mix of the two.
  const copy = buildProofCopy({ planName: 'Ultimate', payment: NO_BANK });
  assert.deepEqual(copy.detailRows, []);
  assert.equal(copy.instructions, '');
  assert.equal(copy.referenceHint, '');
  const rendered = JSON.stringify(copy);
  assert.equal(rendered.includes('1234'), false, 'leaked an account number into the unavailable copy');
});

test('a destination shows its account number', () => {
  const copy = buildProofCopy({ planName: 'Ultimate', payment: BANK });
  const rows = Object.fromEntries(copy.detailRows.map((r) => [r.label, r.value]));
  assert.equal(rows['Account number'], '1234-5678-90');
  assert.equal(rows['Pay to'], 'SuppliWise Operations');
  assert.equal(rows.Bank, 'Example Commercial Bank');
});

test('an account number keeps its dashes, because that is how it is printed', () => {
  // Stripping punctuation is how a member copies a number that does not exist.
  const rows = paymentDetailRows({ ...BANK, accountNumber: '1234-5678-90' });
  assert.equal(rows.find((r) => r.label === 'Account number').value, '1234-5678-90');
});

test('empty fields are dropped rather than printed blank', () => {
  // "Bank:" with nothing after it looks broken and teaches distrust.
  const rows = paymentDetailRows({ available: true, accountNumber: '999', bankName: '   ' });
  assert.deepEqual(rows.map((r) => r.label), ['Account number']);
});

// ══════════════════════════════════════════════════════════════════════════
// The screen actually answers the member's question
// ══════════════════════════════════════════════════════════════════════════

test('with a destination, the copy says WHERE and HOW', () => {
  const copy = buildProofCopy({ planName: 'Ultimate', payment: BANK });
  // "send us your receipt" with no destination is the bug; these three are the
  // fix.
  assert.match(copy.body, /exact amount/i, 'does not say what to send');
  assert.match(copy.body, /upload the receipt/i, 'does not say what to do next');
  assert.match(copy.body, /Ultimate/, 'does not name the plan being activated');
  assert.ok(copy.detailRows.length >= 2, 'nowhere to send the money is shown');
  assert.ok(copy.instructions.length > 0);
});

test('with no destination, the copy is honest instead of promising', () => {
  const copy = buildProofCopy({ planName: 'Ultimate', payment: NO_BANK });
  assert.match(copy.body, /no payment address|no .*set up/i, 'still implies money can change hands');
  assert.equal(/send us your payment receipt/i.test(copy.body), false, 'repeats the original dead end');
  // It must still offer a way forward — a dead end with no alternative is worse.
  assert.match(copy.fallbackLabel, /administrator/i);
  assert.equal(copy.reason, NO_BANK.reason, "the server's own reason is passed through");
});

test('the headline tells the member which screen they are on', () => {
  const withBank = buildProofCopy({ payment: BANK });
  const without = buildProofCopy({ payment: NO_BANK });
  assert.notEqual(withBank.headline, without.headline, 'both states look identical');
  assert.match(withBank.headline, /pay/i);
  assert.match(without.headline, /administrator/i);
});

test('instructions default when a destination has none written', () => {
  // An account number with no steps is still a destination, and the screen must
  // not degrade into a bare number.
  const text = paymentInstructionText({ available: true, accountNumber: '999' });
  assert.ok(text.length > 0);
  assert.match(text, /upload/i);
});

test('a written instruction is used verbatim', () => {
  const text = paymentInstructionText({ ...BANK, instructions: 'Scan the QR at the counter.' });
  assert.equal(text, 'Scan the QR at the counter.');
});

test('a whitespace-only instruction falls back to the default', () => {
  // A half-filled config must not render a blank block.
  assert.ok(paymentInstructionText({ available: true, accountNumber: '999', instructions: '   ' }).length > 0);
});

test('the reference hint is passed through, and absent when there is no route', () => {
  assert.equal(paymentReferenceHint(BANK), BANK.referenceHint);
  assert.equal(paymentReferenceHint(NO_BANK), '');
  assert.equal(paymentReferenceHint(null), '');
});

// ══════════════════════════════════════════════════════════════════════════
// Self-serve must not be confused with "has a bank account"
// ══════════════════════════════════════════════════════════════════════════

test('self-serve never instructs the member to pay or upload', () => {
  // A card processor is not a bank transfer. Letting the two flags be confused
  // is how a deployment ends up collecting money it cannot reconcile.
  const copy = buildProofCopy({ planName: 'Ultimate', selfServe: true, payment: BANK });
  assert.equal(copy.canUseTransfer, false);
  assert.deepEqual(copy.detailRows, []);
  assert.equal(copy.instructions, '');
  assert.equal(copy.referenceHint, '');
  // The self-serve body may SAY that there is nothing to send — that is the
  // reassurance, not an instruction — but it must never ask for either.
  assert.doesNotMatch(copy.body, /transfer the|upload your|send us|send the exact/i);
  assert.doesNotMatch(copy.headline, /transfer|pay/i);
});

test('self-serve still wins over a configured destination', () => {
  // Both set at once is a misconfiguration; the billing switch decides, because
  // that is what the deployment actually does.
  assert.equal(buildProofCopy({ selfServe: true, payment: BANK }).canUseTransfer, false);
  assert.equal(buildProofCopy({ selfServe: false, payment: BANK }).canUseTransfer, true);
});

// ══════════════════════════════════════════════════════════════════════════
// Purity and robustness
// ══════════════════════════════════════════════════════════════════════════

test('the builder is pure and survives a missing plan name', () => {
  for (const planName of [undefined, '', null]) {
    const copy = buildProofCopy({ planName, payment: BANK });
    assert.equal(copy.body.includes('undefined'), false, `rendered "undefined" for ${JSON.stringify(planName)}`);
    assert.ok(copy.body.length > 0);
  }
  const first = buildProofCopy({ payment: BANK });
  const second = buildProofCopy({ payment: BANK });
  assert.deepEqual(first, second);
  first.detailRows.push({ label: 'x', value: 'y' });
  assert.equal(buildProofCopy({ payment: BANK }).detailRows.length, BANK ? 4 : 0);
});

test('both branches return the same keys, whatever the state', () => {
  // A payload whose shape depends on a value is how a consumer ends up reading
  // `undefined` where it expected a string.
  const keys = (c) => Object.keys(c).sort();
  assert.deepEqual(
    keys(buildProofCopy({ payment: BANK })),
    keys(buildProofCopy({ payment: NO_BANK })),
  );
  assert.deepEqual(
    keys(buildProofCopy({ payment: BANK })),
    keys(buildProofCopy({ selfServe: true, payment: BANK })),
  );
});

test('every state produces a screen with a headline, a body and an action', () => {
  const states = [
    { payment: BANK }, { payment: NO_BANK }, { selfServe: true, payment: BANK },
    { selfServe: false, payment: null }, { payment: { available: true } },
  ];
  for (const input of states) {
    const copy = buildProofCopy({ planName: 'Premium', ...input });
    assert.ok(copy.headline.trim().length > 0, `no headline for ${JSON.stringify(input)}`);
    assert.ok(copy.body.trim().length > 0, `no body for ${JSON.stringify(input)}`);
    assert.ok(copy.fallbackLabel.trim().length > 0, `no action for ${JSON.stringify(input)}`);
  }
});

test('the named constants match the values the server sends', () => {
  // A rename on either side would silently make every deployment unavailable.
  assert.equal(PAY_AVAILABLE, 'available');
  assert.equal(PAY_UNAVAILABLE, 'unavailable');
});
