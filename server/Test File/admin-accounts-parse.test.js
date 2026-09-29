'use strict';
/**
 * Regression tests for parsing the packed ADMIN_ACCOUNTS value.
 *
 * The bug: entries are joined with commas, and an argon2id hash's parameter
 * block is itself comma-separated —
 *
 *     $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
 *
 * so `split(',')` sliced one account into three fragments and every account
 * with an argon2id hash was silently dropped at boot. The admin-sync line then
 * reported "1 admin account(s) ensured" instead of 6, and nothing errored.
 * bcrypt hashes contain no commas, which is why the shipped bcrypt config hid
 * the defect until a password was hashed with the current default algorithm.
 */
const test = require('node:test');
const assert = require('node:assert');
const { hashPassword } = require('../utils/password');
const { parseAdminAccounts, configuredAdminAccounts } = require('../utils/adminAccounts');

const ARGON2_LIKE = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0Q1wJ8S0Y7bYl6m0Zx3kQ8x1Jq0k4h6l0mQ';
const BCRYPT_LIKE = '$2a$12$mMRQcVk4IxFpvOeCdVqhqueRm73wg4sO.z1pJmZej4LLf4GbXG8oO';
const SECRET_A = 'AAAAAAAAAABBBBBBBBBBCCCCCCCCCCCC';
const SECRET_B = 'GVXWNR2K5KXIXL5IRZUEPSKIFFFKPDXA'; // 32 chars, like SECRET_A

test('an argon2id hash is not cut in half by its own parameter commas', () => {
  const accounts = parseAdminAccounts(`AdminDevs|${ARGON2_LIKE}|${SECRET_A}`);
  assert.strictEqual(accounts.length, 1, 'must yield exactly one account');
  assert.strictEqual(accounts[0].alias, 'AdminDevs');
  assert.strictEqual(accounts[0].passwordHash, ARGON2_LIKE, 'hash must survive intact');
  assert.strictEqual(accounts[0].totpSecret, SECRET_A);
});

test('a legacy bcrypt entry still parses', () => {
  const accounts = parseAdminAccounts(`AdminDevs|${BCRYPT_LIKE}|${SECRET_A}`);
  assert.strictEqual(accounts.length, 1);
  assert.strictEqual(accounts[0].passwordHash, BCRYPT_LIKE);
});

test('five argon2id accounts parse into five accounts with the right aliases', () => {
  const value = [
    `AdminJoma|${ARGON2_LIKE}|${SECRET_A}`,
    `AdminPoli|${ARGON2_LIKE}|${SECRET_B}`,
    `AdminJohn|${BCRYPT_LIKE}|${SECRET_A}`,
    `AdminShMa|${ARGON2_LIKE}|${SECRET_B}`,
    `AdminRaNe|${ARGON2_LIKE}|${SECRET_A}`,
  ].join(',');
  const accounts = parseAdminAccounts(value);
  assert.strictEqual(accounts.length, 5, 'every entry must survive');
  assert.deepStrictEqual(
    accounts.map((a) => a.alias),
    ['AdminJoma', 'AdminPoli', 'AdminJohn', 'AdminShMa', 'AdminRaNe'],
  );
  assert.strictEqual(accounts[2].passwordHash, BCRYPT_LIKE, 'bcrypt entry keeps its own hash');
  accounts.forEach((a) => assert.strictEqual(a.totpSecret.length, 32));
});

test('mixing bcrypt and argon2id in one list is handled', () => {
  const value = `A|${BCRYPT_LIKE}|${SECRET_A},B|${ARGON2_LIKE}|${SECRET_B},C|${BCRYPT_LIKE}|${SECRET_A}`;
  const accounts = parseAdminAccounts(value);
  assert.deepStrictEqual(accounts.map((a) => a.alias), ['A', 'B', 'C']);
});

test('empty, missing and whitespace values produce no accounts', () => {
  for (const value of ['', '   ', undefined, null, ',,', ' , , ']) {
    assert.deepStrictEqual(parseAdminAccounts(value), [], 'must be empty for ' + JSON.stringify(value));
  }
});

test('an entry missing a field is skipped, not inserted half-formed', () => {
  // A truncated entry must never seed an account whose hash can never verify.
  assert.deepStrictEqual(parseAdminAccounts(`AdminDevs|${ARGON2_LIKE}`), [], 'missing secret');
  assert.deepStrictEqual(parseAdminAccounts(`AdminDevs||${SECRET_A}`), [], 'missing hash');
  assert.deepStrictEqual(parseAdminAccounts(`|${ARGON2_LIKE}|${SECRET_A}`), [], 'missing alias');
  const mixed = parseAdminAccounts(`Good|${ARGON2_LIKE}|${SECRET_A},Broken|${ARGON2_LIKE}`);
  assert.deepStrictEqual(mixed.map((a) => a.alias), ['Good'], 'the valid entry still loads');
});

test('surrounding whitespace in fields is trimmed', () => {
  const accounts = parseAdminAccounts(`  AdminDevs | ${ARGON2_LIKE} | ${SECRET_A} ,  AdminPoli | ${BCRYPT_LIKE} | ${SECRET_B}  `);
  assert.deepStrictEqual(accounts.map((a) => a.alias), ['AdminDevs', 'AdminPoli']);
  assert.strictEqual(accounts[0].passwordHash, ARGON2_LIKE);
});

test('extra fields after the secret are ignored', () => {
  const accounts = parseAdminAccounts(`AdminDevs|${ARGON2_LIKE}|${SECRET_A}|ignored`);
  assert.strictEqual(accounts.length, 1);
  assert.strictEqual(accounts[0].totpSecret, SECRET_A);
});

test('a real argon2id hash round-trips through the packed format', async () => {
  // Not a hand-written sample: this is the actual encoder output, so a future
  // change to hash-wasm's parameters that introduces another comma is caught.
  const hash = await hashPassword('a-real-password-for-this-test');
  assert.ok(hash.includes(','), 'precondition: the hash contains a comma');

  const accounts = parseAdminAccounts(`AdminDevs|${hash}|${SECRET_A}`);
  assert.strictEqual(accounts.length, 1, 'a genuine hash must survive the parse');
  assert.strictEqual(accounts[0].passwordHash, hash, 'and must be byte-identical');

  const two = parseAdminAccounts(`A|${hash}|${SECRET_A},B|${hash}|${SECRET_B}`);
  assert.strictEqual(two.length, 2, 'two genuine hashes must both survive');
});

test('configuredAdminAccounts merges the legacy trio with the packed list', () => {
  const env = {
    ADMIN_ALIAS: 'AdminDevs',
    ADMIN_PASSWORD_HASH: ARGON2_LIKE,
    ADMIN_TOTP_SECRET: SECRET_A,
    ADMIN_ACCOUNTS: `AdminJoma|${BCRYPT_LIKE}|${SECRET_B},AdminPoli|${BCRYPT_LIKE}|${SECRET_B}`,
  };
  const all = configuredAdminAccounts(env);
  assert.deepStrictEqual(all.map((a) => a.alias), ['AdminDevs', 'AdminJoma', 'AdminPoli']);
  assert.strictEqual(all[0].passwordHash, ARGON2_LIKE, 'the legacy hash must not be truncated');
});

test('a legacy alias already present in the packed list is not duplicated', () => {
  const env = {
    ADMIN_ALIAS: 'AdminDevs',
    ADMIN_PASSWORD_HASH: ARGON2_LIKE,
    ADMIN_TOTP_SECRET: SECRET_A,
    ADMIN_ACCOUNTS: `AdminDevs|${BCRYPT_LIKE}|${SECRET_B},AdminJoma|${BCRYPT_LIKE}|${SECRET_B}`,
  };
  const all = configuredAdminAccounts(env);
  assert.deepStrictEqual(all.map((a) => a.alias), ['AdminDevs', 'AdminJoma']);
  assert.strictEqual(all[0].passwordHash, BCRYPT_LIKE, 'the packed entry wins for a shared alias');
});

test('an incomplete legacy trio contributes nothing', () => {
  const env = { ADMIN_ALIAS: 'AdminDevs', ADMIN_ACCOUNTS: `AdminJoma|${BCRYPT_LIKE}|${SECRET_B}` };
  assert.deepStrictEqual(configuredAdminAccounts(env).map((a) => a.alias), ['AdminJoma']);

  const none = { ADMIN_ALIAS: 'AdminDevs', ADMIN_PASSWORD_HASH: ARGON2_LIKE };
  assert.deepStrictEqual(configuredAdminAccounts(none), []);
});
