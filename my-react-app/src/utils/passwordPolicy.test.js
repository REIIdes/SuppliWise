/**
 * The client-side password checklist.
 *
 * WHAT THIS IS REALLY TESTING
 * --------------------------
 * Not the arithmetic of the meter — that the reset form shows the user exactly
 * what the server will accept, and does not contradict it.
 *
 * The failure this guards against is concrete: the old `LogIn.jsx` carried its
 * own `validatePassword()` with hand-copied 8/upper/digit rules while the
 * server enforced something else. The form accepted a password the server then
 * rejected, with no field-level explanation, and the user had no way to tell
 * which one was wrong. Two copies of a policy will drift. So the policy is
 * FETCHED, these tests pin the fallback's agreement with the server, and
 * `evaluate()` is a UX affordance the server re-validates regardless.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FALLBACK_RULES, evaluate } from './passwordPolicy.js';

const GOOD = 'Mango$Tulip77!';

test('a compliant password passes and reports every rule met', () => {
  const result = evaluate(GOOD);
  assert.equal(result.ok, true);
  assert.equal(result.met, result.total);
  assert.equal(result.checks.every((check) => check.ok), true);
});

test('each rule is reported unmet on its own, so the checklist is truthful', () => {
  const cases = [
    ['short1!A', 'length'],
    ['alllowercase1!', 'uppercase'],
    ['ALLUPPERCASE1!', 'lowercase'],
    ['NoDigitsHere!', 'number'],
    ['NoSymbolHere1', 'symbol'],
  ];
  for (const [password, expectedId] of cases) {
    const result = evaluate(password);
    const unmet = result.checks.filter((check) => !check.ok).map((check) => check.id);
    assert.ok(
      unmet.includes(expectedId),
      `"${password}" should leave "${expectedId}" unmet, got ${JSON.stringify(unmet)}`
    );
  }
});

test('an over-long password is refused rather than silently truncated', () => {
  const result = evaluate(`${'a'.repeat(200)}aA1!`);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.id === 'length').ok, false);
});

test('the meter never shows a top band for a password that would be refused', () => {
  // A meter that reads "Very strong" on a 7-character password while the form
  // rejects it is worse than no meter at all: the user trusts it.
  for (const bad of ['short1!A', 'alllowercase1!', 'NoSymbolHere1', 'Password123!']) {
    const result = evaluate(bad);
    assert.equal(result.ok, false, `"${bad}" should be refused`);
    assert.ok(result.score <= 2, `"${bad}" scored ${result.score} (${result.scoreLabel}) but is invalid`);
  }
});

test('a longer compliant password outranks a minimal one', () => {
  const minimal = evaluate('Mango$T1!');
  const long = evaluate('Mango$Tulip77!WithMoreEntropy');
  assert.ok(long.score > minimal.score, 'length should be able to reach the top band');
  assert.equal(long.scoreLabel, 'Very strong');
});

test('the fallback rules match the shipped server policy', () => {
  // FALLBACK_RULES is only used when the network is down. If it disagrees with
  // server/utils/passwordRules.js the user sees a checklist the server will not
  // honour — the exact drift this module exists to prevent, one layer down.
  assert.equal(FALLBACK_RULES.minLength, 10);
  assert.equal(FALLBACK_RULES.maxLength, 128);
  assert.equal(FALLBACK_RULES.checks.length, 6);
  assert.deepEqual(
    FALLBACK_RULES.checks.map((check) => check.id),
    ['length', 'uppercase', 'lowercase', 'number', 'symbol', 'common']
  );
});

test('a server-supplied rule set overrides the fallback without being re-derived', () => {
  const stricter = {
    ...FALLBACK_RULES,
    minLength: 20,
    checks: [...FALLBACK_RULES.checks, { id: 'noReuse', label: 'Never used before' }],
  };
  const result = evaluate(GOOD, stricter);
  // 13 characters fails the 20-character rule the server just asked for.
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.id === 'noReuse').ok, false);
  assert.equal(result.total, stricter.checks.length);
});

test('an empty or non-string password is all-unmet, never a crash', () => {
  for (const input of ['', null, undefined, 0, {}, []]) {
    const result = evaluate(input);
    assert.equal(result.ok, false);
    assert.equal(result.met, 0);
  }
});
