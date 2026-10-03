'use strict';
/**
 * Tests for utils/paymentInstructions.js — the "how do I actually pay?" half of
 * the checkout.
 *
 * The bug these exist for: the proof step asked a member to send a payment
 * receipt and never said where to send it. There was no account number, no bank,
 * no e-wallet, no instructions — anywhere. A member following the screen
 * literally could not complete a purchase.
 *
 * So the property under test is not "does it format a bank name", it is:
 *
 *   1. no destination configured  ->  `available: false`, with a reason, so the
 *      checkout can WITHHOLD the transfer route rather than inviting a payment
 *      it cannot receive;
 *   2. a destination configured   ->  every field the UI needs to print real,
 *      usable instructions;
 *   3. never a hardcoded fallback account, under any input.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const payment = require('../utils/paymentInstructions');

/** Run `fn` with a given environment, restoring the real one afterwards. */
function withEnv(env, fn) {
  const keys = [
    'PAYMENT_METHOD', 'PAYMENT_ACCOUNT_NAME', 'PAYMENT_BANK_NAME',
    'PAYMENT_ACCOUNT_NUMBER', 'PAYMENT_INSTRUCTIONS', 'PAYMENT_CONTACT_EMAIL',
    'PAYMENT_REFERENCE_HINT',
  ];
  const saved = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const NOTHING = {};
const FULL_BANK = {
  PAYMENT_METHOD: 'bank_transfer',
  PAYMENT_ACCOUNT_NAME: 'SuppliWise Operations',
  PAYMENT_BANK_NAME: 'Example Commercial Bank',
  PAYMENT_ACCOUNT_NUMBER: '1234-5678-90',
  PAYMENT_CONTACT_EMAIL: 'billing@example.com',
};

// ══════════════════════════════════════════════════════════════════════════
// 1. NO DESTINATION — THE STATE THIS REPO IS IN
// ══════════════════════════════════════════════════════════════════════════

test('an unconfigured deployment offers no transfer route', () => {
  withEnv(NOTHING, () => {
    const out = payment.getPaymentInstructions();
    assert.equal(out.available, false);
    assert.equal(out.accountNumber, '');
    assert.equal(out.instructions, '');
  });
});

test('an unconfigured deployment explains itself instead of going quiet', () => {
  withEnv(NOTHING, () => {
    const { reason } = payment.getPaymentInstructions();
    // A member who reaches the proof step must be told the truth, not left
    // waiting on a payment that was never possible.
    assert.ok(reason.length > 20, 'the reason must say something');
    assert.match(reason, /contact support/i);
  });
});

test('there is never a hardcoded fallback account', () => {
  // The single most dangerous thing this module could do is invent an account
  // number. A member would pay real money to it.
  for (const env of [NOTHING, { PAYMENT_BANK_NAME: 'Some Bank' }, { PAYMENT_METHOD: 'e_wallet' }]) {
    withEnv(env, () => {
      const out = payment.getPaymentInstructions();
      assert.equal(out.available, false);
      assert.equal(out.accountNumber, '', 'invented an account number');
    });
  }
});

test('a bank name with no account number is not a destination', () => {
  // It cannot receive money, so the route must stay hidden.
  withEnv({ PAYMENT_BANK_NAME: 'Example Bank', PAYMENT_ACCOUNT_NAME: 'Ops' }, () => {
    assert.equal(payment.getPaymentInstructions().available, false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. A REAL DESTINATION
// ══════════════════════════════════════════════════════════════════════════

test('a configured bank transfer is available and complete', () => {
  withEnv(FULL_BANK, () => {
    const out = payment.getPaymentInstructions();
    assert.equal(out.available, true);
    assert.equal(out.method, 'bank_transfer');
    assert.equal(out.accountName, 'SuppliWise Operations');
    assert.equal(out.bankName, 'Example Commercial Bank');
    assert.equal(out.accountNumber, '1234-5678-90');
    assert.equal(out.contactEmail, 'billing@example.com');
    // No reason is needed once there is somewhere to send it.
    assert.equal(out.reason, '');
  });
});

test('a destination always carries a reference hint', () => {
  // What to type in the reference is what makes a receipt findable in a bank
  // statement full of anonymous transfers. Defaulted, never blank.
  withEnv(FULL_BANK, () => {
    assert.ok(payment.getPaymentInstructions().referenceHint.length > 0);
  });
  withEnv({ ...FULL_BANK, PAYMENT_REFERENCE_HINT: 'Use your SuppliWise email.' }, () => {
    assert.equal(payment.getPaymentInstructions().referenceHint, 'Use your SuppliWise email.');
  });
});

test('instructions alone are enough, for a hosted checkout', () => {
  // Not every deployment prints an account number; some send members to a
  // hosted payment page. That is a real destination.
  withEnv({ PAYMENT_INSTRUCTIONS: 'Pay on the SuppliWise checkout page.' }, () => {
    const out = payment.getPaymentInstructions();
    assert.equal(out.available, true);
    assert.equal(out.instructions, 'Pay on the SuppliWise checkout page.');
    assert.equal(out.method, '', 'no method is invented when none was declared');
  });
});

test('an account number alone is treated as a bank transfer', () => {
  withEnv({ PAYMENT_ACCOUNT_NUMBER: '9988' }, () => {
    assert.equal(payment.getPaymentInstructions().method, 'bank_transfer');
  });
});

test('a declared e-wallet is not silently relabelled a bank', () => {
  withEnv({ PAYMENT_METHOD: 'e_wallet', PAYMENT_ACCOUNT_NUMBER: '09171234567' }, () => {
    assert.equal(payment.getPaymentInstructions().method, 'e_wallet');
  });
});

test('a method nobody recognises is dropped, not passed through', () => {
  // "crypto" or "carrier_pigeon" must not reach the UI as a label.
  withEnv({ PAYMENT_METHOD: 'carrier_pigeon', PAYMENT_ACCOUNT_NUMBER: '123' }, () => {
    assert.equal(payment.getPaymentInstructions().method, 'bank_transfer');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. ROBUSTNESS
// ══════════════════════════════════════════════════════════════════════════

test('a whitespace-only configuration is treated as absent', () => {
  // An operator who empties a field in a .env leaves spaces behind, and those
  // must not read as a destination.
  withEnv({ PAYMENT_ACCOUNT_NUMBER: '   ', PAYMENT_INSTRUCTIONS: '\t\n  ' }, () => {
    assert.equal(payment.getPaymentInstructions().available, false);
  });
});

test('newlines in a field are collapsed, not rendered', () => {
  // These strings are printed inline in the checkout; a raw multi-line value
  // would break the layout exactly as a multi-line note would.
  withEnv({ ...FULL_BANK, PAYMENT_BANK_NAME: 'Example\n  Commercial   Bank' }, () => {
    const { bankName } = payment.getPaymentInstructions();
    assert.equal(bankName.includes('\n'), false);
    assert.equal(bankName, 'Example Commercial Bank');
  });
});

test('an account number keeps its dashes, because that is how it is printed', () => {
  withEnv(FULL_BANK, () => {
    assert.equal(payment.getPaymentInstructions().accountNumber, '1234-5678-90');
  });
});

test('the payload is the same shape as the instructions', () => {
  // The pricing page reads this off the plan list, so a divergence here would
  // mean the button and the details were computed from different things.
  withEnv(FULL_BANK, () => {
    assert.deepEqual(payment.toPayload(), payment.getPaymentInstructions());
  });
});

test('isUsableDestination is the rule the UI depends on', () => {
  assert.equal(payment.isUsableDestination({ accountNumber: '1', instructions: '' }), true);
  assert.equal(payment.isUsableDestination({ accountNumber: '', instructions: 'go here' }), true);
  assert.equal(payment.isUsableDestination({ accountNumber: '', instructions: '' }), false);
  assert.equal(payment.isUsableDestination({}), false);
});

// ══════════════════════════════════════════════════════════════════════════
// 4. IT REACHES THE CLIENT
// ══════════════════════════════════════════════════════════════════════════

test('the plan list carries the payment destination', () => {
  // Without this the checkout has no way to know whether to offer a transfer,
  // which is the whole bug.
  withEnv(FULL_BANK, () => {
    const { cataloguePayload } = require('../utils/planCatalogue');
    const payload = cataloguePayload('PHP');
    assert.ok(payload.payment, 'the plan payload has no `payment` key');
    assert.equal(payload.payment.available, true);
    assert.equal(payload.payment.accountNumber, '1234-5678-90');
  });
});

test('the plan list says so when there is nowhere to pay', () => {
  withEnv(NOTHING, () => {
    const { cataloguePayload } = require('../utils/planCatalogue');
    const payload = cataloguePayload('PHP');
    assert.equal(payload.payment.available, false);
    assert.ok(payload.payment.reason.length > 0);
  });
});
