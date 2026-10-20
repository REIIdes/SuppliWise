'use strict';
/**
 * Tests for the one-shot administrator credential delivery.
 *
 * Two properties matter more than the rest, and both are pinned here:
 *
 *   1. Nothing that looks like a secret leaves the module except to the sender.
 *      The report the caller sees carries MASKED addresses and no key at all —
 *      the report is what gets rendered in the admin console and written to the
 *      audit trail.
 *   2. There is no password on the recipient shape. Not "we forgot to fill it
 *      in" — the field does not exist, because `passwordHash` is a one-way hash
 *      and a plaintext cannot be retrieved. A future edit that adds one has to
 *      pass this test first.
 *
 * The email module is stubbed rather than reached: a delivery test that really
 * mailed would mail to six live addresses.
 */

const test = require('node:test');
const assert = require('node:assert');

const emailModule = require('../utils/email');
const {
  buildCredentialRecipients,
  deliverAdminCredentials,
  maskEmail,
} = require('../utils/adminCredentialDelivery');

const REAL_SENDER = emailModule.sendAdminCredentialEmail;

/** Swap the only secret-carrying sender for a recorder. Restored after each test. */
function stubSender(handler) {
  const calls = [];
  emailModule.sendAdminCredentialEmail = async (to, context) => {
    calls.push({ to, context });
    return handler ? handler(to, context, calls.length) : true;
  };
  return calls;
}

test(() => {
  emailModule.sendAdminCredentialEmail = REAL_SENDER;
});

test('a full alias set pairs each admin with its own address and key', async () => {
  const accounts = [
    { alias: 'AdminDevs', totpSecret: 'JBSWY3DPEHPK3PXP' },
    { alias: 'AdminPoli', totpSecret: 'KRSXG5CTMVRXEZLU' },
  ];
  const emails = [
    { alias: 'AdminDevs', email: 'devs@example.com' },
    { alias: 'AdminPoli', email: 'poli@example.com' },
  ];
  const { recipients, missingEmail, missingKey, unknownEmail } = buildCredentialRecipients(accounts, emails);
  assert.strictEqual(recipients.length, 2);
  assert.deepStrictEqual(recipients[0], {
    alias: 'AdminDevs',
    email: 'devs@example.com',
    authenticatorKey: 'JBSWY3DPEHPK3PXP',
  });
  assert.deepStrictEqual([missingEmail, missingKey, unknownEmail], [[], [], []]);
});

test('the recipient shape has no password field, and no hash either', async () => {
  const { recipients } = buildCredentialRecipients(
    [{ alias: 'AdminDevs', totpSecret: 'JBSWY3DPEHPK3PXP', passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$sal$hash' }],
    [{ alias: 'AdminDevs', email: 'devs@example.com' }]
  );
  assert.deepStrictEqual(Object.keys(recipients[0]).sort(), ['alias', 'authenticatorKey', 'email']);
});

test('an admin with no address is reported, not silently dropped', async () => {
  const { recipients, missingEmail } = buildCredentialRecipients(
    [{ alias: 'AdminDevs', totpSecret: 'JBSWY3DPEHPK3PXPAAAA' }, { alias: 'AdminJohn', totpSecret: 'KRSXG5CTMVRXEZLUAAAA' }],
    [{ alias: 'AdminDevs', email: 'devs@example.com' }]
  );
  assert.strictEqual(recipients.length, 1);
  assert.deepStrictEqual(missingEmail, ['AdminJohn']);
});

test('an admin with no key is reported rather than mailed an empty field', async () => {
  const { recipients, missingKey } = buildCredentialRecipients(
    [{ alias: 'AdminDevs', totpSecret: '' }],
    [{ alias: 'AdminDevs', email: 'devs@example.com' }]
  );
  assert.strictEqual(recipients.length, 0);
  assert.deepStrictEqual(missingKey, ['AdminDevs']);
});

test('an address naming no account surfaces as unknownEmail', async () => {
  const { unknownEmail } = buildCredentialRecipients(
    [{ alias: 'AdminDevs', totpSecret: 'JBSWY3DPEHPK3PXPAAAA' }],
    [{ alias: 'AdminDevs', email: 'a@example.com' }, { alias: 'AdminGhost', email: 'b@example.com' }]
  );
  assert.deepStrictEqual(unknownEmail, ['AdminGhost']);
});

test('a seed carrying an argon2 fragment is reported, never mailed', async () => {
  // Real shape from this deployment: a base32 run followed by `,t=2,p=1$salt$hash`.
  // speakeasy decodes the legal prefix and ignores the rest, so the server happily
  // verifies codes the recipient's app cannot generate. That is not a credential to
  // hand somebody — it is a broken account.
  const corrupted = 'LMQVI5D5GUXGMSSQKJRDSTTCPJJFA3C3,t=2,p=1$sEv0l9enNLLqSB77DFjMfQ$i7pYWErvD0QPzUJBTAnom3iZ08K';
  const { recipients, missingKey, unusableKey } = buildCredentialRecipients(
    [{ alias: 'AdminJoma', totpSecret: corrupted }],
    [{ alias: 'AdminJoma', email: 'joma@example.com' }]
  );
  assert.strictEqual(recipients.length, 0);
  assert.deepStrictEqual(unusableKey, ['AdminJoma']);
  assert.deepStrictEqual(missingKey, []);
});

test('isUsableBase32 accepts a genuine seed and rejects padding-free nonsense', async () => {
  const { isUsableBase32 } = require('../utils/adminCredentialDelivery');
  assert.strictEqual(isUsableBase32('JBSWY3DPEHPK3PXPAAAA'), true);
  assert.strictEqual(isUsableBase32('JBSWY3DP'), false);           // too short to be a real seed
  assert.strictEqual(isUsableBase32('jbswy3dpehpk3pxpaaaa'), false); // lowercase is not base32
  assert.strictEqual(isUsableBase32('JBSWY3DPEHPK3PXPAAAA,'), false);
  assert.strictEqual(isUsableBase32(''), false);
});

test('sends go one per recipient and the report masks every address', async () => {
  const calls = stubSender();
  const report = await deliverAdminCredentials({
    gapMs: 0,
    recipients: [
      { alias: 'AdminDevs', email: 'devs@example.com', authenticatorKey: 'AAAA' },
      { alias: 'AdminPoli', email: 'poli@example.com', authenticatorKey: 'BBBB' },
    ],
    env: { EMAIL_USER: 'smtp@example.com', EMAIL_PASSWORD: 'app-pass' },
  });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(report.delivered.length, 2);
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.delivered[0].email, 'd***@example.com');
  // The key reached the sender exactly once and never appears in the report.
  assert.strictEqual(calls[0].context.authenticatorKey, 'AAAA');
  assert.doesNotMatch(JSON.stringify(report), /AAAA|BBBB|devs@|poli@/);
});

test('one refusing provider does not stop the later recipients', async () => {
  stubSender((to, context, index) => index !== 2);
  const report = await deliverAdminCredentials({
    gapMs: 0,
    recipients: [
      { alias: 'A', email: 'a@example.com', authenticatorKey: 'K1' },
      { alias: 'B', email: 'b@example.com', authenticatorKey: 'K2' },
      { alias: 'C', email: 'c@example.com', authenticatorKey: 'K3' },
    ],
    env: { EMAIL_USER: 'smtp@example.com', EMAIL_PASSWORD: 'app-pass' },
  });
  assert.strictEqual(report.delivered.length, 2);
  assert.strictEqual(report.failed.length, 1);
  assert.strictEqual(report.failed[0].alias, 'B');
  assert.strictEqual(report.ok, true);
});

test('a thrown send is recorded as that recipient failing, not as a crash', async () => {
  emailModule.sendAdminCredentialEmail = async () => { throw new Error('socket hang up'); };
  const report = await deliverAdminCredentials({
    gapMs: 0,
    recipients: [{ alias: 'A', email: 'a@example.com', authenticatorKey: 'K1' }],
    env: { EMAIL_USER: 'smtp@example.com', EMAIL_PASSWORD: 'app-pass' },
  });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.failed[0].reason, 'socket hang up');
});

test('no SMTP configuration is reported as such instead of a per-address failure', async () => {
  const calls = stubSender();
  const report = await deliverAdminCredentials({
    gapMs: 0,
    recipients: [{ alias: 'A', email: 'a@example.com', authenticatorKey: 'K1' }],
    env: {},
  });
  assert.strictEqual(report.emailUnconfigured, true);
  assert.strictEqual(calls.length, 0);
  assert.match(report.failed[0].reason, /EMAIL_USER/);
});

test('an empty recipient list sends nothing and is not an error', async () => {
  const calls = stubSender();
  const report = await deliverAdminCredentials({ recipients: [], env: { EMAIL_USER: 'u', EMAIL_PASSWORD: 'p' } });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(report.total, 0);
  assert.strictEqual(report.ok, false);
});

test('a runaway recipient list is capped and says so', async () => {
  stubSender();
  const many = Array.from({ length: 7 }, (_, i) => ({ alias: `A${i}`, email: `a${i}@example.com`, authenticatorKey: 'K' }));
  const report = await deliverAdminCredentials({
    gapMs: 0,
    limit: 3,
    recipients: many,
    env: { EMAIL_USER: 'u', EMAIL_PASSWORD: 'p' },
  });
  assert.strictEqual(report.total, 3);
  assert.strictEqual(report.capped, 4);
});

test('maskEmail degrades to [invalid] rather than echoing a malformed address', async () => {
  assert.strictEqual(maskEmail('not-an-email'), '[invalid]');
  assert.strictEqual(maskEmail('a@example.com'), 'a***@example.com');
});
