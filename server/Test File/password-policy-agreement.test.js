/**
 * THE POLICY AND THE CHECKLIST MUST AGREE.
 *
 * THE DRIFT THIS EXISTS TO CATCH
 * ------------------------------
 * The client renders a live checklist of the server's password rules so a user
 * can see what is still missing while typing. That only helps if the list it
 * renders IS the list the server enforces. When it isn't, the failure is
 * maddening rather than obvious:
 *
 *   • the checklist ticks every box, submit is accepted, the server refuses —
 *     the user concludes the form is broken;
 *   • or the checklist refuses a password the server would have taken, and the
 *     rule they are being blocked by does not exist.
 *
 * The client gets its rules from `GET /api/auth/password-reset/rules`, so the
 * primary risk is that the FALLBACK copy in my-react-app/src/utils/passwordPolicy.js
 * (used when that fetch fails) silently diverges from
 * server/utils/passwordRules.js. Two hand-maintained lists in two languages will
 * drift the moment either is edited.
 *
 * So: the fallback is asserted equal to the server, rule by rule, here. It is
 * cheap and it fails the moment someone changes one side.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PASSWORD_RULES, describePasswordRules, evaluatePassword, isCommonPassword } = require('../utils/passwordRules');

const CLIENT_POLICY = path.join(__dirname, '..', '..', 'my-react-app', 'src', 'utils', 'passwordPolicy.js');
const source = fs.readFileSync(CLIENT_POLICY, 'utf8');

/** Pull a `key: value` number or boolean out of the client's frozen object. */
function clientRule(name) {
  const match = source.match(new RegExp(`${name}:\\s*(\\d+|true|false)`));
  assert.ok(match, `the client fallback must declare ${name}; if you renamed it, update this test too`);
  if (match[1] === 'true') return true;
  if (match[1] === 'false') return false;
  return Number(match[1]);
}

test('the client fallback declares the same lengths as the server', () => {
  assert.equal(clientRule('minLength'), PASSWORD_RULES.minLength, 'minLength has drifted');
  assert.equal(clientRule('maxLength'), PASSWORD_RULES.maxLength, 'maxLength has drifted');
});

test('the client fallback lists the same rules, in the same order, with the same labels', () => {
  const server = describePasswordRules().checks;

  // The client's list is the one array literal between `checks: [` and its
  // closing bracket. Read it rather than importing it: this file is CommonJS and
  // the module under inspection is ESM.
  const block = source.match(/checks:\s*\[([\s\S]*?)\n\s*\]/);
  assert.ok(block, 'could not find the checks array in the client fallback');

  const clientIds = [...block[1].matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]);
  const clientLabels = [...block[1].matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);

  assert.deepEqual(
    clientIds,
    server.map((check) => check.id),
    'the client and server must enforce the same rules in the same order'
  );
  assert.deepEqual(
    clientLabels,
    server.map((check) => check.label),
    'the checklist text is generated from these labels — it must match what the server serves'
  );
});

test('the server serves the same policy it validates against', () => {
  const served = describePasswordRules();
  assert.equal(served.minLength, PASSWORD_RULES.minLength);
  assert.equal(served.maxLength, PASSWORD_RULES.maxLength);
  // One entry per rule, and every id the evaluator knows must be represented —
  // a rule the client cannot see is a rule the user cannot satisfy knowingly.
  assert.equal(served.checks.length, 6);
  assert.deepEqual(
    served.checks.map((c) => c.id).sort(),
    evaluatePassword('Aa1!aaaaaa').checks.map((c) => c.id).sort()
  );
});

// ── The policy itself ──────────────────────────────────────────────────────

test('the four character classes are genuinely required', () => {
  const complete = 'Mango$Tulip77!';
  assert.equal(evaluatePassword(complete).ok, true);
  // Remove one class at a time; each removal must be caught by its own rule.
  for (const [broken, rule] of [
    ['mango$tulip77!', 'uppercase'],
    ['MANGO$TULIP77!', 'lowercase'],
    ['Mango$Tulip!!!', 'number'],
    ['MangoTulip77aa', 'symbol'],
  ]) {
    const result = evaluatePassword(broken);
    const unmet = result.checks.filter((c) => !c.ok).map((c) => c.id);
    assert.ok(unmet.includes(rule), `${broken} should fail "${rule}", got ${JSON.stringify(unmet)}`);
  }
});

test('length bounds are enforced at both ends', () => {
  assert.equal(evaluatePassword('Aa1!aaaa').ok, false, 'nine characters is too short');
  assert.equal(evaluatePassword(`${'a'.repeat(PASSWORD_RULES.maxLength)}aA1!`).ok, false, 'over the cap');
});

test('passwords that satisfy every rule but are guessable are still refused', () => {
  // Composition rules are a floor, not a ceiling. Each of these passes length,
  // case, digit and symbol.
  for (const guessable of [
    'Password123!',     // the canonical one
    'SuppliWise2026!',  // the product name plus the year
    'Welcome1234!',     // blocklist word plus digits
    '12345678aA!',      // a key run
    'abcdefgh1A!',      // a key run
    'aaaaaaaaaaaaaA1!', // one character, many times
  ]) {
    const result = evaluatePassword(guessable);
    assert.equal(
      isCommonPassword(guessable),
      true,
      `"${guessable}" should be recognised as guessable`
    );
    assert.equal(
      result.ok,
      false,
      `"${guessable}" satisfies every composition rule and must still be refused, got ${JSON.stringify(result.checks)}`
    );
    assert.match(result.message, /too easy to guess/i);
  }
});

test('a good password built from the account address is refused', () => {
  // The address is public, so a password derived from it is not a secret.
  const result = evaluatePassword('Samsmith2026!', { email: 'sam.smith@gmail.com' });
  assert.equal(result.ok, false);
  assert.match(result.message, /too easy to guess/i);
});

test('the strength meter can never rate an invalid password as strong', () => {
  for (const bad of ['short1!A', 'alllowercase1!', 'NoSymbolHere1', 'Password123!', 'Aa1!aaaa']) {
    const result = evaluatePassword(bad);
    assert.equal(result.ok, false, `"${bad}" should be invalid`);
    assert.ok(
      result.score <= 2,
      `"${bad}" is invalid but scored ${result.score} (${result.scoreLabel}) — the meter is lying`
    );
  }
});

test('a long, varied password reaches the top band', () => {
  const result = evaluatePassword('Mango$Tulip77!WithMoreEntropy');
  assert.equal(result.ok, true);
  assert.equal(result.score, 4);
  assert.equal(result.scoreLabel, 'Very strong');
});

test('a failure names exactly one thing to fix', () => {
  // The message is the field-level explanation a user acts on. It must be
  // actionable and singular — "invalid password" helps nobody.
  assert.match(evaluatePassword('Aa1!aaaa').message, /at least 10 characters/i);
  assert.match(evaluatePassword('alllowercase1!').message, /uppercase/i);
  assert.match(evaluatePassword('Password123!').message, /too easy to guess/i);
  assert.match(evaluatePassword(`${'a'.repeat(200)}aA1!`).message, /at most 128/i);
});

test('non-string input is refused, never thrown on', () => {
  for (const input of [null, undefined, 0, {}, [], true]) {
    const result = evaluatePassword(input);
    assert.equal(result.ok, false, `${JSON.stringify(input)} must be refused`);
  }
});
