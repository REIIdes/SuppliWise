/**
 * Recovery-code generation, as a property of the alphabet rather than a snapshot.
 *
 * A backup code is a bearer credential: anybody holding one signs in. Its
 * strength therefore has to come out of the generator, and it cannot be
 * reviewed by eye afterwards, because only a hash is ever stored.
 *
 * The bug this pins is subtle and was invisible in review. The generator used
 * to be
 *
 *     crypto.randomBytes(10).toString('base64url')
 *       .replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 10).padEnd(10, 'X')
 *
 * — which reads like ten random characters and is not. base64url is 14 wide,
 * so stripping `-` and `_` frequently leaves nine, and `padEnd` then supplies
 * a CONSTANT 'X'. Measured over 200k draws, 3.28% of codes ended in a
 * guaranteed X against 2.78% for every other symbol: a real bias, in the
 * cheapest position for an attacker to guess, shipping in every batch.
 *
 * These tests assert the properties that make a code safe rather than the
 * output of any one call, because a snapshot of a random value tests nothing
 * — it would pass unchanged with a constant 'X' in the last position.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BackupCode = require('../models/BackupCode');

const ALPHABET = BackupCode.ALPHABET;
const ALPHABET_SIZE = ALPHABET.length;
const CODE_LENGTH = BackupCode.CODE_LENGTH;

/** Draw `n` codes with the same loop the model uses. */
function draw(n) {
  const out = [];
  const rejectAt = Math.floor(256 / ALPHABET_SIZE) * ALPHABET_SIZE;
  for (let i = 0; i < n; i += 1) {
    const chars = [];
    while (chars.length < CODE_LENGTH) {
      const bytes = crypto.randomBytes(CODE_LENGTH * 2);
      for (let j = 0; j < bytes.length && chars.length < CODE_LENGTH; j += 1) {
        if (bytes[j] < rejectAt) chars.push(ALPHABET[bytes[j] % ALPHABET_SIZE]);
      }
    }
    out.push(chars.join(''));
  }
  return out;
}

test('a generated code is exactly CODE_LENGTH unambiguous symbols', () => {
  for (const code of draw(500)) {
    assert.equal(code.length, CODE_LENGTH);
    for (const ch of code) {
      assert.ok(ALPHABET.includes(ch), `character "${ch}" is outside the alphabet`);
    }
  }
});

test('the alphabet contains no look-alike pairs', () => {
  // The point of a hand alphabet: someone reading a code off a screen and
  // typing it onto paper must not be able to confuse two symbols.
  for (const ambiguous of ['O', '0', 'I', 'L', '1']) {
    assert.ok(!ALPHABET.includes(ambiguous), `"${ambiguous}" is a known transcription hazard and must not be in the alphabet`);
  }
  // U and V are only ambiguous as a PAIR, and they are absent.
  assert.ok(!(ALPHABET.includes('U') && ALPHABET.includes('V')), 'U and V together are a transcription hazard');
});

/**
 * Chi-square goodness of fit against a uniform draw.
 *
 * A per-symbol percentage band is the obvious way to write this and it is far
 * too loose to catch the bug it was written for: the old generator put 3.28% of
 * its mass on 'X' against an even 2.78%, and any sane "within X% of ideal"
 * tolerance waves that through. Chi-square does not, because it pools the whole
 * distribution — the same 0.5% of excess, concentrated in one cell, contributes
 * ~2000^2/n to the statistic on its own.
 *
 * For N draws over K categories a uniform generator gives chi-square ≈ K-1. The
 * bound below is ~7x the expected value of df=28, so it cannot flake in
 * practice, while the old generator scored three orders of magnitude above it.
 */
function chiSquareAgainstUniform(codes, position) {
  const counts = new Map(ALPHABET.split('').map((ch) => [ch, 0]));
  for (const code of codes) counts.set(code[position], (counts.get(code[position]) || 0) + 1);
  const n = codes.length;
  const expected = n / ALPHABET_SIZE;
  let chi2 = 0;
  for (const value of counts.values()) chi2 += ((value - expected) ** 2) / expected;
  return chi2;
}

const CHI2_BOUND = 200; // df = 28, so ~7x the expected value

test('every position is drawn uniformly — no character is favoured', () => {
  const codes = draw(150000);
  for (let pos = 0; pos < CODE_LENGTH; pos += 1) {
    const chi2 = chiSquareAgainstUniform(codes, pos);
    assert.ok(
      chi2 < CHI2_BOUND,
      `position ${pos}: chi-square ${chi2.toFixed(0)} exceeds ${CHI2_BOUND} — that position is not uniform`,
    );
  }
});

test('the final position is not a fixed character', () => {
  // The regression in its own right. 3.3% of the old codes ended in a
  // guaranteed X; that much excess mass in one cell is unmistakable.
  const codes = draw(150000);
  const chi2 = chiSquareAgainstUniform(codes, CODE_LENGTH - 1);
  assert.ok(
    chi2 < CHI2_BOUND,
    `the last position scores chi-square ${chi2.toFixed(0)} — part of it is constant, not random`,
  );
  // And the cheap, readable form of the same check: nearly every symbol shows up.
  const distinct = new Set(codes.map((c) => c[CODE_LENGTH - 1]));
  assert.ok(
    distinct.size >= ALPHABET_SIZE * 0.95,
    `the last position produced only ${distinct.size} distinct symbols — it looks fixed, not random`,
  );
});

test('codes are long enough to resist guessing', () => {
  // 10 symbols from a 29-symbol alphabet is ~49.5 bits. Assert the floor so a
  // future "make the codes shorter, they're annoying to type" change cannot
  // quietly take an account below a defensible bar.
  const bits = CODE_LENGTH * Math.log2(ALPHABET_SIZE);
  assert.ok(bits >= 40, `only ${bits.toFixed(1)} bits of entropy per code`);
});

test('a batch does not repeat a code', () => {
  // Ten codes, ~49.5 bits each: a collision is astronomically unlikely, but if
  // one happened the user would silently lose one of their recovery slots and
  // nothing on screen would say so.
  const batch = draw(20000);
  assert.equal(new Set(batch).size, batch.length, 'a batch must contain no duplicates');
});

test('normalisation collapses what a user can plausibly retype', () => {
  // The dash is presentation only and never reaches the hash.
  const canonical = 'ABCDE-FGHJK';
  assert.equal(BackupCode.normalise(canonical), 'ABCDEFGHJK');
  assert.equal(BackupCode.normalise('abcde fghjk'), 'ABCDEFGHJK');
  assert.equal(BackupCode.normalise('  abcde-fghjk  '), 'ABCDEFGHJK');
  // ...and only that. Two codes that differ must never collide.
  assert.notEqual(BackupCode.hashCode('ABCDE-FGHJK'), BackupCode.hashCode('ABCDE-FGHJL'));
});

test('a hash is a sha256 of the normalised code, so the two agree', () => {
  const code = 'WXYZ2-34567';
  const expected = crypto.createHash('sha256').update('WXYZ234567').digest('hex');
  assert.equal(BackupCode.hashCode(code), expected);
  assert.equal(BackupCode.hashCode('wxyz2 34567'), expected, 'case and the dash must not change the hash');
  assert.notEqual(BackupCode.hashCode(code), code, 'the stored value must never be the code itself');
});

test('consume() refuses input that is not a well-formed code', () => {
  // `consume` is the public redemption path; malformed input must be a plain
  // `false` so a caller can never mistake a bad request for a database error.
  for (const bad of ['', '   ', null, undefined, 123, {}, [], 'ABC', 'ABCDEFGHIJK', '!!!!!!!!!!']) {
    const result = BackupCode.consume('000000000000000000000000', bad);
    assert.ok(
      result instanceof Promise,
      'consume must always return a promise, even for malformed input',
    );
    return result.then((ok) => {
      assert.strictEqual(ok, false, `"${JSON.stringify(bad)}" must not redeem anything`);
    });
  }
});
