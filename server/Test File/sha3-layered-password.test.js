/**
 * SHA-3 pre-hash layer over argon2id (added 2026-10-18).
 * Contract: NEW hashes are sw2$ + argon2id(SHA3-512(pw)); EXISTING raw
 * argon2id and bcrypt hashes keep verifying and are never rewritten.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { argon2id } = require('hash-wasm');

const {
  V2_PREFIX, sha3Pre, isArgon2id, isBcrypt, needsRehash,
  hashPassword, verifyPassword, upgradeHashIfLegacy,
  ARGON2_OPTS,
} = require('../utils/password');

test('sha3-512 is available in this Node/OpenSSL build and is deterministic', () => {
  const a = sha3Pre('p@ss');
  assert.equal(a, sha3Pre('p@ss'));
  assert.notEqual(a, sha3Pre('p@ss1'));
  assert.equal(Buffer.from(a, 'base64').length, 64);
});

test('new hashes carry the sw2$ marker over a real argon2id encoding', async () => {
  const h = await hashPassword('CorrectHorse1!');
  assert.ok(h.startsWith(V2_PREFIX + '$argon2id$'), h.slice(0, 20));
  assert.ok(await verifyPassword('CorrectHorse1!', h));
  assert.ok(!(await verifyPassword('wrong', h)));
});

test('existing raw argon2id hashes verify UNCHANGED (credentials untouched)', async () => {
  const legacy = await argon2id({
    password: 'LegacyUser1!pw',
    salt: crypto.randomBytes(16),
    ...ARGON2_OPTS,
    outputType: 'encoded',
  });
  assert.ok(!legacy.startsWith(V2_PREFIX));
  assert.ok(isArgon2id(legacy), 'raw form is still recognised as current');
  assert.ok(await verifyPassword('LegacyUser1!pw', legacy));
  assert.ok(!(await verifyPassword('LegacyUser1!px', legacy)));
  assert.equal(needsRehash(legacy), false, 'the layer must NOT mark existing hashes for rewrite');
});

test('legacy bcrypt hashes still verify and upgrade to the layered form', async () => {
  const b = bcrypt.hashSync('BcryptUser1!x', 4);
  assert.ok(await verifyPassword('BcryptUser1!x', b));
  const up = await upgradeHashIfLegacy('BcryptUser1!x', b);
  assert.ok(up.startsWith(V2_PREFIX + '$argon2id$'));
  assert.ok(await verifyPassword('BcryptUser1!x', up));
});

test('a 1 MB password is bounded by the pre-hash and still round-trips', async () => {
  const huge = 'µ'.repeat(1024 * 1024);
  const h = await hashPassword(huge);
  assert.ok(await verifyPassword(huge, h));
});

test('isArgon2id/needsRehash agree for every stored shape', () => {
  assert.equal(isArgon2id(V2_PREFIX + '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$x'), true);
  assert.equal(isArgon2id('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$x'), true);
  assert.equal(isBcrypt('$2b$12$' + 'x'.repeat(53)), true);
  assert.equal(needsRehash('plaintext-looking-junk'), true);
  assert.equal(needsRehash(null), true);
});

test('verifyPassword never throws on junk stored values', async () => {
  for (const junk of ['', 'x', '$argon2id$', V2_PREFIX, V2_PREFIX + 'garbage', {}]) {
    assert.equal(await verifyPassword('anything', junk), false);
  }
});
