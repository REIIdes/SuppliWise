/**
 * Name validation — client behaviour + client/server drift guard.
 *
 * Run: npm test
 *
 * Why this exists: the First/Last Name fields were `type="text"` with length
 * checks only, so "John123" registered successfully — and the Mongoose schema
 * carried no pattern either, so the API accepted it too. A client-only fix
 * would have left that hole open to anyone posting to /api/auth/register
 * directly, so the rule now lives on both sides and the last section of this
 * file pins them together.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The REAL server module, same trick as subscription/features.test.js.
import server from '../../../server/utils/nameValidation.js';
import {
  validateName,
  sanitizeNameInput,
  NAME_MIN,
  NAME_MAX,
  NAME_PATTERN_SOURCE,
} from './nameValidation.js';

const SAMPLES = [
  'John',
  'Mary Jane',
  'van der Berg',
  "O'Brien",
  'D\u2019Angelo',
  'Anne-Marie',
  'J. Smith',
  'St. John',
  'Jos\u00e9',
  'M\u00fcller',
  '\u674e\u96f7',
  '\u0410\u043d\u044f',
];

const NOT_NAMES = [
  'John123',
  '3ng3l4',
  '1234',
  'John@home',
  'user_name',
  '<script>x</script>',
  'John Doe #1',
];

test('accepts real names, including multi-part and non-ASCII ones', () => {
  for (const name of SAMPLES) {
    assert.equal(validateName(name), '', `should accept ${JSON.stringify(name)}`);
  }
});

test('rejects names containing digits, symbols or markup', () => {
  for (const name of NOT_NAMES) {
    assert.notEqual(validateName(name), '', `should reject ${JSON.stringify(name)}`);
  }
});

test('rejects a value made only of allowed punctuation', () => {
  // Passes the character-set check but is not a name.
  assert.match(validateName('--..--', 'First name'), /at least one letter/i);
  assert.match(validateName('   ', 'First name'), /enter your first name/i);
});

test('enforces the length bounds', () => {
  assert.match(validateName('J'), /at least 2 characters/i);
  assert.match(validateName('a'.repeat(51)), /50 characters or fewer/i);
  assert.equal(validateName('a'.repeat(50)), '');
});

test('trims surrounding whitespace, but not real punctuation', () => {
  // Whitespace is trimmed on purpose: pasted names arrive with stray spaces,
  // and the Mongoose schema sets `trim: true` as well. Trimming is what makes
  // " John" acceptable, and both sides must agree or the API would reject a
  // name the form just accepted.
  assert.equal(validateName(' John'), '');
  assert.equal(validateName('John '), '');
  assert.equal(validateName('  Mary Jane  '), '');

  // A leading or trailing hyphen or apostrophe is NOT whitespace, so it is a
  // real error: "John-" is not a name.
  assert.notEqual(validateName('-John'), '');
  assert.notEqual(validateName('John-'), '');
  assert.notEqual(validateName("'John"), '');
  assert.notEqual(validateName("John'"), '');

  // A final period is allowed, because "J. R. R." is a real initialism.
  assert.equal(validateName('J. R. R.'), '');
});

test('the error message names the field it belongs to', () => {
  assert.match(validateName('', 'First name'), /first name/i);
  assert.match(validateName('x', 'Last name'), /last name/i);
});

test('sanitizeNameInput strips what cannot appear in a name', () => {
  assert.equal(sanitizeNameInput('John123'), 'John');
  assert.equal(sanitizeNameInput('3ng3l4'), 'ngl');
  assert.equal(sanitizeNameInput("O'Brien-Smith"), "O'Brien-Smith");
  assert.equal(sanitizeNameInput('Jos\u00e9'), 'Jos\u00e9');
  assert.equal(sanitizeNameInput('\u674e\u96f7'), '\u674e\u96f7');
  assert.equal(sanitizeNameInput('<b>John</b>'), 'bJohnb');
});

test('sanitizeNameInput collapses runs of spaces and caps the length', () => {
  // maxLength only bounds typed input; a paste bypasses it entirely.
  assert.equal(sanitizeNameInput('Mary   Jane'), 'Mary Jane');
  assert.equal(sanitizeNameInput('a'.repeat(80)).length, NAME_MAX);
  assert.equal(sanitizeNameInput(null), '');
  assert.equal(sanitizeNameInput(undefined), '');
});

test('sanitized output is always valid input', () => {
  // The point of filtering rather than erroring: whatever the field ends up
  // holding must pass validation, so saving can never fail on a name the user
  // was not even able to type.
  for (const raw of [...SAMPLES, ...NOT_NAMES, 'John 123 Doe!!']) {
    const clean = sanitizeNameInput(raw);
    if (clean.length < NAME_MIN) continue;
    assert.equal(validateName(clean), '', `sanitize(${JSON.stringify(raw)}) -> ${JSON.stringify(clean)} should be valid`);
  }
});

test('the exported pattern source is the one actually used', () => {
  // JSX puts NAME_PATTERN_SOURCE straight on the `pattern` attribute, so a
  // stale copy would advertise different rules from the ones enforced.
  const rebuilt = new RegExp(NAME_PATTERN_SOURCE, 'u');
  for (const name of [...SAMPLES, ...NOT_NAMES]) {
    assert.equal(
      rebuilt.test(name),
      validateName(name) === '',
      `pattern attribute disagrees with validateName on ${JSON.stringify(name)}`
    );
  }
});

test('client and server agree on every sample', () => {
  for (const name of [...SAMPLES, ...NOT_NAMES, 'J. R. R.', ' John', 'John ', '--..--']) {
    const trimmed = name.trim();
    if (trimmed.length <= NAME_MIN) continue; // length rules are checked above
    assert.equal(
      validateName(name) === '',
      server.isValidName(name),
      `client/server disagree on ${JSON.stringify(name)}`
    );
  }
});

test('the server carries the same bounds', () => {
  assert.equal(server.NAME_MIN, NAME_MIN);
  assert.equal(server.NAME_MAX, NAME_MAX);
});
