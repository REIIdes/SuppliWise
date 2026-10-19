'use strict';
/**
 * Administrator authenticator seeds are sealed at rest.
 *
 * THE BUG THIS EXISTS TO STOP
 * --------------------------
 * `AdminAccount.totpSecret` held the raw base32 seed. The member collection had
 * already moved to AES-256-GCM envelopes (utils/totpSecret.js); the admin one
 * had not — and an operator's seed is the more valuable target, because the
 * account behind it can reset member passwords, read support transcripts and
 * change plan entitlements. `select: false` hides a field from ordinary queries;
 * it does nothing to anyone who can read the collection.
 *
 * utils/adminTotp.js is the single place that knows how a seed is stored, so
 * encryption cannot be half-applied across the four call sites that touch it.
 * These tests drive it with plain objects — no database, no live administrator —
 * and pin the four properties that make the change safe to ship:
 * the boot seeder never writes plaintext, an existing plaintext seed keeps
 * working until it is used, sealing is idempotent, and nothing reports a seed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

require('dotenv').config();

const secretBox = require('../utils/secretBox');
const adminTotp = require('../utils/adminTotp');

const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DP';

test('the fields that hold a seed must be asked for by name', () => {
  // Both are `select: false`, so a caller that forgets this string reads an
  // account that looks like it has no authenticator at all. The constant exists
  // so no call site has to remember the spelling.
  assert.equal(adminTotp.SECRET_FIELDS, '+totpSecret +totpSecretEnc');
});

test('writeSeed seals, and empties the plaintext field', () => {
  const account = { totpSecret: '', totpSecretEnc: '' };
  adminTotp.writeSeed(account, SEED);
  assert.equal(account.totpSecret, '', 'the raw seed must not survive the write');
  assert.ok(secretBox.isEnvelope(account.totpSecretEnc), 'what is stored is a versioned envelope');
  assert.ok(!account.totpSecretEnc.includes(SEED));
  assert.equal(adminTotp.readSeed(account), SEED, 'and the server can still verify a code');
});

test('writeSeed with nothing clears the seed from both fields', () => {
  // Disabling an operator's authenticator has to genuinely destroy the seed,
  // or an account that believes it has no second factor can still be signed
  // into by anyone holding a dump.
  const account = { totpSecret: '', totpSecretEnc: '' };
  adminTotp.writeSeed(account, SEED);
  adminTotp.writeSeed(account, null);
  assert.equal(account.totpSecretEnc, '');
  assert.equal(account.totpSecret, '');
  assert.equal(adminTotp.readSeed(account), '');
});

test('a legacy plaintext seed reads, is flagged, and seals in place', () => {
  // The lazy migration is what lets this ship without a script that has to run
  // against production while administrators are signing in.
  const account = { totpSecret: SEED, totpSecretEnc: '' };
  assert.equal(adminTotp.readSeed(account), SEED, 'an unmigrated operator is not locked out');
  assert.equal(adminTotp.needsMigration(account), true);
  assert.equal(adminTotp.migrateInPlace(account), true);
  assert.equal(account.totpSecret, '');
  assert.ok(secretBox.isEnvelope(account.totpSecretEnc));
  assert.equal(adminTotp.readSeed(account), SEED, 'the same seed still verifies afterwards');
  assert.equal(adminTotp.migrateInPlace(account), false, 'and sealing it twice changes nothing');
});

test('a sealed envelope that will not open reads as empty, never as the legacy field', () => {
  // Same reasoning as the member path: falling back to plaintext here would
  // quietly resurrect a seed that was supposed to have been migrated away.
  const account = { totpSecretEnc: `v1.${'x'.repeat(11)}.AAAA.BBBB.CCCC`, totpSecret: SEED };
  assert.equal(adminTotp.readSeed(account), '');
});

test('readSeed tolerates missing input', () => {
  assert.equal(adminTotp.readSeed(null), '');
  assert.equal(adminTotp.readSeed(undefined), '');
  assert.equal(adminTotp.readSeed({}), '');
});

test('sealAccount turns an environment descriptor into a document with no plaintext', () => {
  // The boot seeder's path. A fresh install must never have a raw seed in the
  // database at all — not "raw at first, sealed later".
  const doc = adminTotp.sealAccount({
    alias: 'ops',
    email: 'ops@example.com',
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdAhash',
    totpSecret: SEED,
  });
  assert.equal(doc.totpSecret, '');
  assert.ok(secretBox.isEnvelope(doc.totpSecretEnc));
  assert.equal(doc.alias, 'ops');
  assert.equal(doc.passwordHash.startsWith('$argon2id$'), true);
  assert.ok(!JSON.stringify(doc).includes(SEED), 'the seed appears nowhere in the written document');
  assert.equal(adminTotp.readSeed(doc), SEED, 'and the seeder can still hand it to speakeasy');
});

test('sealAccount tolerates an account with no authenticator', () => {
  const doc = adminTotp.sealAccount({ alias: 'nocreds', passwordHash: 'x' });
  assert.equal(doc.totpSecret, '');
  assert.equal(doc.totpSecretEnc, '');
});

test('storageState reports shape, never material', () => {
  const sealed = { totpSecret: '', totpSecretEnc: secretBox.encrypt(SEED) };
  const legacy = { totpSecret: SEED, totpSecretEnc: '' };
  const none = { totpSecret: '', totpSecretEnc: '' };
  assert.deepEqual(adminTotp.storageState(sealed), { sealed: true, legacyPlaintext: false, usable: true });
  assert.deepEqual(adminTotp.storageState(legacy), { sealed: false, legacyPlaintext: true, usable: true });
  assert.deepEqual(adminTotp.storageState(none), { sealed: false, legacyPlaintext: false, usable: false });
  for (const state of [adminTotp.storageState(sealed), adminTotp.storageState(legacy)]) {
    assert.ok(!JSON.stringify(state).includes(SEED), 'a dashboard row must not echo a seed');
  }
});

test('a key rotation does not make an operator seed unreadable', () => {
  // The failure mode this guards: an admin re-pairs under key A, the deployment
  // rotates to key B, and now the seed cannot open. The envelope names its key,
  // so the predecessor still resolves it — provided the operator put the old key
  // in TOTP_ENCRYPTION_KEY_PREVIOUS, which is exactly the shape this writes.
  const prevKey = process.env.TOTP_ENCRYPTION_KEY;
  const prevList = process.env.TOTP_ENCRYPTION_KEY_PREVIOUS;
  try {
    const oldKey = crypto.randomBytes(32).toString('base64');
    const newKey = crypto.randomBytes(32).toString('base64');
    process.env.TOTP_ENCRYPTION_KEY = oldKey;
    secretBox._resetCache();
    const account = { totpSecret: '', totpSecretEnc: '' };
    adminTotp.writeSeed(account, SEED);

    process.env.TOTP_ENCRYPTION_KEY = newKey;
    process.env.TOTP_ENCRYPTION_KEY_PREVIOUS = oldKey;
    secretBox._resetCache();
    assert.equal(adminTotp.readSeed(account), SEED, 'during rotation the old seed still opens');
  } finally {
    if (prevKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY; else process.env.TOTP_ENCRYPTION_KEY = prevKey;
    if (prevList === undefined) delete process.env.TOTP_ENCRYPTION_KEY_PREVIOUS; else process.env.TOTP_ENCRYPTION_KEY_PREVIOUS = prevList;
    secretBox._resetCache();
  }
});

test('the admin login path never keeps a seed in memory between requests', () => {
  // Structural: /admin-login used to hold the raw seed in the challenge record
  // so /verify-admin-2FA could read it back. That put every pending operator
  // challenge, seed included, in a heap dump and in any code that logs the
  // challenge. The fix is to re-read the document inside the verify route.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.resolve(__dirname, '../routes/auth.js'), 'utf8');
  assert.match(src, /adminChallenges\.set\(challengeId,\s*\{[^}]*\}\)/);
  const setLine = src.match(/adminChallenges\.set\(([^;]*)\);/s)[1];
  assert.ok(!/totpSecret/i.test(setLine), `the challenge record must not carry a seed: ${setLine}`);
  assert.match(src, /migrateInPlace/, 'and the verify route seals what it reads');
});
