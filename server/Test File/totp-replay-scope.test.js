'use strict';
/**
 * Regression tests for the TOTP one-time-use cache.
 *
 * The cache was keyed on sha256(secret + ':' + code) with no account component.
 * TOTP codes are a function of the seed and the clock alone, so two accounts
 * provisioned on ONE shared seed mint the IDENTICAL code in the same 30-second
 * step. The first to authenticate consumed it for 90 seconds and every other
 * account sharing that seed was refused with "Invalid authenticator code" —
 * a message that tells the user their code is wrong when it is not.
 *
 * Observed with six administrator accounts on a single seed: exactly one admin
 * could complete 2FA per window, five of six were locked out of sign-in.
 */
const test = require('node:test');
const assert = require('node:assert');
const speakeasy = require('speakeasy');

const { verifyTotpOnce } = require('../utils/totp');

test('a code is accepted once and a replay of it is refused', () => {
  const secret = speakeasy.generateSecret({ length: 20 }).base32;
  const code = speakeasy.totp({ secret, encoding: 'base32' });
  const scope = 'test:' + Math.random();

  assert.strictEqual(verifyTotpOnce(secret, code, scope), true, 'first use must succeed');
  assert.strictEqual(verifyTotpOnce(secret, code, scope), false, 'replay against the same account must be refused');
  assert.strictEqual(verifyTotpOnce(secret, code, scope), false, 'a second replay must still be refused');
});

test('the same code is accepted once for EACH account sharing a seed', () => {
  // This is the regression: with a secret-only cache key, the second account
  // was refused because the first had already spent the code.
  const secret = speakeasy.generateSecret({ length: 20 }).base32;
  const code = speakeasy.totp({ secret, encoding: 'base32' });
  const tag = 'test:' + Math.random();

  assert.strictEqual(verifyTotpOnce(secret, code, tag + ':a'), true);
  assert.strictEqual(verifyTotpOnce(secret, code, tag + ':b'), true,
    'a different account on the same seed must not be blocked by the first');
  assert.strictEqual(verifyTotpOnce(secret, code, tag + ':c'), true);
  assert.strictEqual(verifyTotpOnce(secret, code, tag + ':d'), true);
  assert.strictEqual(verifyTotpOnce(secret, code, tag + ':e'), true);
  assert.strictEqual(verifyTotpOnce(secret, code, tag + ':f'), true);

  // ...but each of those accounts still gets exactly one use.
  for (const alias of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.strictEqual(verifyTotpOnce(secret, code, tag + ':' + alias), false,
      alias + ' must not be able to reuse the code it already spent');
  }
});

test('an account cannot reuse a code spent on a different seed', () => {
  const tag = 'test:' + Math.random();
  const secretA = speakeasy.generateSecret({ length: 20 }).base32;
  const secretB = speakeasy.generateSecret({ length: 20 }).base32;
  const codeA = speakeasy.totp({ secret: secretA, encoding: 'base32' });
  const codeB = speakeasy.totp({ secret: secretB, encoding: 'base32' });

  // Same scope, different seed: the seeds must stay part of the key, otherwise
  // scoping alone would let a code spent on one account block another.
  if (codeA !== codeB) {
    assert.strictEqual(verifyTotpOnce(secretA, codeA, tag), true);
    assert.strictEqual(verifyTotpOnce(secretB, codeB, tag), true);
  }
});

test('a wrong code is refused and does not consume anything', () => {
  const secret = speakeasy.generateSecret({ length: 20 }).base32;
  const real = speakeasy.totp({ secret, encoding: 'base32' });
  const wrong = String((Number(real) + 1) % 1000000).padStart(6, '0');
  const scope = 'test:' + Math.random();

  if (wrong !== real) {
    assert.strictEqual(verifyTotpOnce(secret, wrong, scope), false, 'a wrong code must be refused');
  }
  // The real code must still work - a failed attempt must not poison the cache.
  assert.strictEqual(verifyTotpOnce(secret, real, scope), true);
});

test('malformed input is refused without throwing', () => {
  const secret = speakeasy.generateSecret({ length: 20 }).base32;
  const scope = 'test:' + Math.random();
  for (const bad of ['', '   ', null, undefined, 'abcdef', '12345', '123456789', 123456, {}]) {
    assert.strictEqual(verifyTotpOnce(secret, bad, scope), false, 'must refuse ' + JSON.stringify(bad));
  }
  assert.strictEqual(verifyTotpOnce('', '123456', scope), false, 'must refuse an empty secret');
});

test('an omitted scope still refuses a replay (back-compat default)', () => {
  // Callers that have not been updated must not lose replay protection - the
  // documented fallback is the previous secret-only behaviour.
  const secret = speakeasy.generateSecret({ length: 20 }).base32;
  const code = speakeasy.totp({ secret, encoding: 'base32' });
  assert.strictEqual(verifyTotpOnce(secret, code), true);
  assert.strictEqual(verifyTotpOnce(secret, code), false, 'replay must be refused even with no scope');
});
