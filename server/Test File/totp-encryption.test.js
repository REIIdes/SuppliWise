'use strict';
/**
 * TOTP seed encryption at rest.
 *
 * THE BUG THIS EXISTS TO STOP
 * --------------------------
 * `User.twoFactorSecret` held the raw base32 seed. A TOTP seed is not a
 * password — it cannot be hashed, because verifying a code means running HMAC
 * over the seed and the counter — so it has to be recoverable, and it was
 * stored recoverably in the clear. That meant anyone who could read the
 * database (a dump, a replica, a backup, a careless admin query) could mint
 * valid 6-digit codes for every enrolled account, forever, with no password
 * and no second factor of any kind.
 *
 * These tests pin the properties that make the fix real, rather than the
 * library calls that implement it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// `node --test` gives each file its own process, so variables in server/.env
// are NOT inherited the way they are when index.js boots. secretBox derives its
// development key from JWT_SECRET, so without this the whole file fails with
// "No encryption key is available" — which would look like a broken
// implementation rather than a missing environment. server/index.js loads the
// env itself, so this is a harness-only responsibility, exactly as it is in
// Test File/withResetRouter.js.
require('dotenv').config();

const secretBox = require('../utils/secretBox');
const totpSecret = require('../utils/totpSecret');

const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DP';

test('a secret round-trips, and the stored value is not the secret', () => {
  const sealed = secretBox.encrypt(SEED);
  assert.notEqual(sealed, SEED, 'the envelope must not contain the plaintext');
  assert.ok(!sealed.includes(SEED), 'the plaintext must not appear anywhere in the envelope');
  assert.equal(secretBox.decrypt(sealed), SEED);
});

test('the envelope is versioned and names the key that made it', () => {
  const sealed = secretBox.encrypt(SEED);
  const parts = sealed.split('.');
  assert.equal(parts.length, 5, 'v1.kid.iv.tag.ciphertext');
  assert.equal(parts[0], 'v1');
  assert.ok(parts[1].length > 0, 'the key id is in the envelope, so rotation needs no flag day');
  assert.ok(secretBox.isEnvelope(sealed));
  assert.ok(!secretBox.isEnvelope(SEED), 'a bare base32 seed is not an envelope');
});

test('every encryption uses a fresh nonce', () => {
  // Two encryptions of the same plaintext must not produce the same bytes, or
  // an observer could tell that two accounts share a seed, and a single
  // recovered ciphertext would decrypt every copy of it.
  const a = secretBox.encrypt(SEED);
  const b = secretBox.encrypt(SEED);
  assert.notEqual(a, b);
  assert.equal(secretBox.decrypt(a), SEED);
  assert.equal(secretBox.decrypt(b), SEED);
});

test('a tampered ciphertext fails authentication instead of decrypting', () => {
  const sealed = secretBox.encrypt(SEED);
  const parts = sealed.split('.');
  // Flip a byte of the ciphertext.
  const ct = Buffer.from(parts[4], 'base64url');
  ct[0] ^= 0xff;
  parts[4] = ct.toString('base64url');
  assert.equal(secretBox.decrypt(parts.join('.')), null,
    'AES-GCM must reject this, not hand back modified plaintext');
});

test('a tampered authentication tag is rejected', () => {
  const parts = secretBox.encrypt(SEED).split('.');
  const tag = Buffer.from(parts[3], 'base64url');
  tag[0] ^= 0x01;
  parts[3] = tag.toString('base64url');
  assert.equal(secretBox.decrypt(parts.join('.')), null);
});

test('an unknown key id decrypts to null, not to garbage', () => {
  const parts = secretBox.encrypt(SEED).split('.');
  parts[1] = 'k99';
  assert.equal(secretBox.decrypt(parts.join('.')), null);
});

test('empty input is empty output, so a secret can be cleared', () => {
  assert.equal(secretBox.encrypt(''), '');
  assert.equal(secretBox.encrypt(null), '');
  assert.equal(secretBox.encrypt(undefined), '');
});

test('readSecret returns the seed, and prefers the sealed field', () => {
  const user = { twoFactorSecretEnc: secretBox.encrypt(SEED), twoFactorSecret: '' };
  assert.equal(totpSecret.readSecret(user), SEED);
});

test('a legacy plaintext seed still verifies, and is migrated in place', () => {
  // This is the property that lets the fix ship without a migration script and
  // without locking anyone out: an account created before encryption keeps
  // working, and the first time it is used the seed is re-sealed.
  const user = { twoFactorSecret: SEED, twoFactorSecretEnc: '' };
  assert.equal(totpSecret.readSecret(user), SEED, 'the legacy seed must still be readable');
  assert.equal(totpSecret.needsMigration(user), true);

  assert.equal(totpSecret.migrateInPlace(user), true);
  assert.equal(user.twoFactorSecret, '', 'the plaintext field must be emptied');
  assert.ok(user.twoFactorSecretEnc.length > 0, 'and the encrypted field written');
  assert.equal(totpSecret.readSecret(user), SEED, 'and the same seed must verify afterwards');
  assert.equal(totpSecret.migrateInPlace(user), false, 'migration is idempotent');
});

test('writeSecret never leaves a plaintext seed behind', () => {
  const user = { twoFactorSecret: 'OLDSEEDOLDSEOLDSEE', twoFactorSecretEnc: '' };
  totpSecret.writeSecret(user, SEED);
  assert.equal(user.twoFactorSecret, '', 'replacing an authenticator must forget the old seed');
  assert.equal(totpSecret.readSecret(user), SEED);
  assert.ok(!user.twoFactorSecretEnc.includes(SEED));
});

test('clearSecret forgets the seed from BOTH fields', () => {
  // Disabling the authenticator has to genuinely destroy the seed. Leaving a
  // stored seed behind would mean an account that believes it has no
  // authenticator can still be signed into by anyone holding a database dump.
  const user = { twoFactorSecretEnc: secretBox.encrypt(SEED), twoFactorSecret: '' };
  totpSecret.clearSecret(user);
  assert.equal(user.twoFactorSecretEnc, '');
  assert.equal(user.twoFactorSecret, '');
  assert.equal(totpSecret.readSecret(user), '');
});

test('a sealed value that will not open reads as "no secret", never as an error', () => {
  // Collapsing these into one answer is deliberate: a caller that can tell
  // "no secret" from "broken secret" is an oracle for anyone who can drive the
  // setup route, and the repair is the same either way.
  const user = { twoFactorSecretEnc: 'v1.k1.AAAA.BBBB.CCCC', twoFactorSecret: SEED };
  assert.equal(totpSecret.readSecret(user), '',
    'must NOT silently fall back to the legacy field when the envelope is unreadable');
});

test('readSecret tolerates missing input', () => {
  assert.equal(totpSecret.readSecret(null), '');
  assert.equal(totpSecret.readSecret(undefined), '');
  assert.equal(totpSecret.readSecret({}), '');
});

test('describe reports facts, never the seed', () => {
  const withSeed = { twoFactorSecretEnc: secretBox.encrypt(SEED), twoFactorEnabled: true };
  const d = totpSecret.describe(withSeed);
  assert.equal(d.configured, true);
  assert.equal(d.pendingSetup, false);
  assert.equal(d.encryptedAtRest, true);
  assert.ok(!JSON.stringify(d).includes(SEED), 'no response shape may echo the seed');
});

test('describe distinguishes a half-finished setup from a live one', () => {
  const pending = { twoFactorSecretEnc: secretBox.encrypt(SEED), twoFactorEnabled: false };
  assert.equal(totpSecret.describe(pending).pendingSetup, true,
    'a seed with 2FA off is "paired but not activated", not "set up"');
});

test('secretBox never logs or throws the plaintext', () => {
  // Structural rather than behavioural: the module's public surface has no
  // logging call at all, and decrypt returns null rather than an error object
  // that could carry context.
  const source = require('fs').readFileSync(require.resolve('../utils/secretBox'), 'utf8');
  assert.ok(!/console\.(log|error|warn)/.test(source), 'secretBox must not log anything');
});

test('a 32-byte key is required, and a short one is refused', () => {
  // A mistyped base64 key must be a hard error, not a silently weaker key
  // discovered at encryption time. Buffer.from(base64) is famously lenient.
  const env = process.env.TOTP_ENCRYPTION_KEY;
  const restore = () => { secretBox._resetCache(); if (env === undefined) delete process.env.TOTP_ENCRYPTION_KEY; else process.env.TOTP_ENCRYPTION_KEY = env; };
  try {
    process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    secretBox._resetCache();
    const d = secretBox.describe();
    assert.equal(d.source, 'derived-from-JWT_SECRET', 'a wrong-length key must not be adopted');
  } finally {
    restore();
  }
});

test('a key set in the environment is actually used', () => {
  const env = process.env.TOTP_ENCRYPTION_KEY;
  try {
    const key = crypto.randomBytes(32);
    process.env.TOTP_ENCRYPTION_KEY = key.toString('base64');
    secretBox._resetCache();
    const sealed = secretBox.encrypt(SEED);
    assert.equal(secretBox.decrypt(sealed), SEED);
    assert.equal(secretBox.describe().source, 'TOTP_ENCRYPTION_KEY');
  } finally {
    if (env === undefined) delete process.env.TOTP_ENCRYPTION_KEY; else process.env.TOTP_ENCRYPTION_KEY = env;
    secretBox._resetCache();
  }
});

test('a previous key still decrypts, so rotation is not an outage', () => {
  const prev = process.env.TOTP_ENCRYPTION_KEY;
  const prevList = process.env.TOTP_ENCRYPTION_KEY_PREVIOUS;
  try {
    const oldKey = crypto.randomBytes(32).toString('base64');
    const newKey = crypto.randomBytes(32).toString('base64');
    process.env.TOTP_ENCRYPTION_KEY = oldKey;
    secretBox._resetCache();
    const sealedUnderOld = secretBox.encrypt(SEED);

    // Rotate: the new key becomes primary, the old one becomes decrypt-only.
    process.env.TOTP_ENCRYPTION_KEY = newKey;
    process.env.TOTP_ENCRYPTION_KEY_PREVIOUS = `k0=${oldKey}`;
    secretBox._resetCache();

    assert.equal(secretBox.decrypt(sealedUnderOld), SEED,
      'a seed sealed under the previous key must still open during rotation');
    const newId = secretBox.describe().activeKeyId;
    assert.notEqual(newId, '', 'the new primary key must have a fingerprint of its own');
    assert.ok(secretBox.encrypt(SEED).includes(`.${newId}.`), 'new writes use the new primary key');
    assert.notEqual(sealedUnderOld, secretBox.encrypt(SEED), 'and a fresh nonce as well');
  } finally {
    if (prev === undefined) delete process.env.TOTP_ENCRYPTION_KEY; else process.env.TOTP_ENCRYPTION_KEY = prev;
    if (prevList === undefined) delete process.env.TOTP_ENCRYPTION_KEY_PREVIOUS; else process.env.TOTP_ENCRYPTION_KEY_PREVIOUS = prevList;
    secretBox._resetCache();
  }
});
