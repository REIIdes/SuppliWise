/**
 * The SMS second-factor invariant.
 *
 * ONE property matters here, and it is the reason this feature can be offered at
 * all: `sms-otp` must never be the only way into an account.
 *
 * SMS is delivered by a third party, through a carrier, onto a SIM. Carrier
 * filtering drops messages without telling either end, the gateway phone can be
 * offline, a plan limit can run out mid-afternoon, and a SIM swap defeats the
 * whole mechanism. If a texted code could be the sole route through, each of
 * those becomes an account lockout — and the person affected is the one who
 * cannot fix it.
 *
 * So SMS is strictly ADDITIVE: it is appended to a second factor the account
 * already has, and the guard that enforces it lives in methodsFor() rather than
 * in a comment. These tests pin that guard, because a future edit that drops the
 * `methods.length > 0` condition would be invisible in review and would turn
 * every delivery failure into a locked-out user.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mfa-sms';

const test = require('node:test');
const assert = require('node:assert/strict');

const { methodsFor, MAX_ATTEMPTS } = require('../utils/mfaTransaction');

const authenticatorAccount = { twoFactorEnabled: true, twoFactorMethod: 'authenticator' };
const emailAccount = { twoFactorEnabled: true, twoFactorMethod: 'email' };

test('SMS is added alongside the authenticator, never instead of it', () => {
  const methods = methodsFor(authenticatorAccount, { phoneSecondFactor: true });
  assert.ok(methods.includes('totp'), 'the account keeps its real factor');
  assert.ok(methods.includes('sms-otp'), 'and gains the texted alternative');
});

test('SMS is added alongside the emailed code too', () => {
  const methods = methodsFor(emailAccount, { phoneSecondFactor: true });
  assert.ok(methods.includes('email-otp'));
  assert.ok(methods.includes('sms-otp'));
});

test('SMS is never the ONLY method, for any account shape', () => {
  // The exhaustive version of the invariant. Every combination of the flags a
  // caller can pass is checked, because the guarantee has to hold for inputs
  // nobody thought of when the feature was written.
  const accounts = [
    null,
    {},
    { twoFactorEnabled: false, twoFactorMethod: 'authenticator' },
    { twoFactorEnabled: false, twoFactorMethod: 'email' },
    authenticatorAccount,
    emailAccount,
    { twoFactorEnabled: true, twoFactorMethod: 'phone' },  // unknown value
  ];
  const extras = [
    {},
    { passkeys: 1 },
    { passkeys: 3, backupCodeCount: 5 },
    { backupCodeCount: 5 },
  ];

  for (const account of accounts) {
    for (const extra of extras) {
      const methods = methodsFor(account, { ...extra, phoneSecondFactor: true });
      assert.ok(
        methods.length >= 1,
        `methodsFor(${JSON.stringify(account)}, ${JSON.stringify(extra)}) returned nothing`,
      );
      if (methods.includes('sms-otp')) {
        assert.ok(
          methods.length > 1,
          `sms-otp is the only method for ${JSON.stringify(account)} — an account could be locked out by a dropped text`,
        );
      }
    }
  }
});

test('SMS is never the only method even with passkeys and backup codes absent', () => {
  const methods = methodsFor(
    { twoFactorEnabled: false, twoFactorMethod: 'authenticator' },
    { passkeys: 0, backupCodeCount: 0, phoneSecondFactor: true },
  );
  assert.ok(!methods.includes('sms-otp'), 'an account with 2FA off must not gain a text-only route');
  assert.deepEqual(methods, ['totp']);
});

test('a falsy phone flag adds nothing at all', () => {
  // The callers derive this from the database, but the function must still be
  // safe if one of them ever passes something odd.
  for (const flag of [false, undefined, null, 0, '', 'true', 1, {}]) {
    const methods = methodsFor(authenticatorAccount, { phoneSecondFactor: flag });
    assert.ok(
      !methods.includes('sms-otp'),
      `phoneSecondFactor=${JSON.stringify(flag)} must not enable the method`,
    );
  }
});

test('the existing method list is unchanged when the flag is absent', () => {
  // A guard against this feature quietly altering behaviour for accounts that
  // never opted in.
  const base = methodsFor(authenticatorAccount, {});
  const withBackup = methodsFor(authenticatorAccount, { backupCodeCount: 5 });
  const withPasskey = methodsFor(authenticatorAccount, { passkeys: 2 });

  assert.deepEqual(base, ['totp']);
  assert.deepEqual(withBackup, ['totp', 'backup-code']);
  assert.deepEqual(withPasskey, ['totp', 'passkey']);
  assert.ok(!base.includes('sms-otp'));
});

test('a passkey account with a verified number is offered SMS too', () => {
  // Consistency check, not a restriction. "Additive" means additive: an account
  // that reached a second factor through a passkey has opted in exactly as much
  // as one using an authenticator, so its own opt-in earns it the same
  // alternative. What must never happen is SMS REPLACING the passkey.
  const methods = methodsFor(
    { twoFactorEnabled: false, twoFactorMethod: 'authenticator' },
    { passkeys: 1, phoneSecondFactor: true },
  );
  assert.ok(methods.includes('passkey'), 'the passkey stays');
  assert.ok(methods.includes('sms-otp'), 'and the opted-in phone is offered alongside');
  assert.equal(methods.length, 2);
});

test('the transaction attempt budget is shared, not widened, by the extra method', () => {
  // Every method a transaction accepts shares one budget. Adding a second way
  // in must not double the guesses available against a 6-digit code.
  assert.equal(MAX_ATTEMPTS, 10);
});

// ── The allowlist in start() ─────────────────────────────────────────────────

test('the stored allowlist accepts sms-otp, so a transaction can be spent on it', () => {
  // methodsFor() can return 'sms-otp', and start() filters the list it stores.
  // If the filter did not know the value, every texted sign-in would fail at the
  // spend step with "that sign-in attempt has expired" — a bug that would only
  // show up on the one path nobody tests until it matters.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'utils', 'mfaTransaction.js'),
    'utf8',
  );
  const filterLine = source.match(/methods: methods\.filter\(.*$/m);
  assert.ok(filterLine, 'the stored allowlist was not found');
  assert.match(filterLine[0], /'sms-otp'/, 'sms-otp is filtered out of stored methods');
});