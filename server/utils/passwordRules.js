'use strict';

/**
 * THE password policy — defined once, used by every route that accepts a
 * password.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * The rules used to be written out by hand at each call site:
 *
 *     if (password.length < 8) ...            ← /register
 *     if (!/[A-Z]/.test(password)) ...        ← /register, /reset-password,
 *     if (!/[0-9]/.test(password)) ...        ←   /change-password (x2)
 *
 * Three copies of the same four numbers, in two files, with no test. They had
 * already drifted: /register capped the length at 128 and the other two did
 * not, so `/reset-password` would happily accept a 5-megabyte string and hand it
 * to argon2. And a new rule meant finding every copy.
 *
 * Now there is exactly one policy, one function that evaluates it, and one
 * function that describes it. The client renders its checklist from
 * `describePasswordRules()` over the wire, so the requirements shown to the
 * user are the requirements the server enforces — they cannot disagree.
 *
 * THE RULES, AND WHY THESE
 * -------------------------
 * 10 characters minimum, 128 maximum, and at least one character from each of
 * the four classes (upper, lower, digit, symbol). Length does the heavy lifting;
 * the class requirements exist because they measurably raise the cost of the
 * guesses people actually make, and because they give the user a concrete,
 * checkable target instead of an open-ended "be stronger". 128 is not arbitrary:
 * it is bcrypt's limit and a generous bound on what the pre-save hook will ever
 * hand to argon2.
 */

const PASSWORD_RULES = Object.freeze({
  minLength: 10,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: true,
});

const SYMBOL_PATTERN = /[^A-Za-z0-9]/;

/**
 * The most-tried passwords in the world, plus the ones people pick for THIS
 * product. A password that satisfies all four class rules is not automatically
 * good: `Password123!` satisfies every one of them. Composition rules are a
 * floor, not a ceiling, so the obvious floor-satisfying choices are rejected
 * explicitly.
 */
const BLOCKED_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  'passw0rd', 'passw0rd!', 'p@ssword', 'p@ssword1', 'p@ssw0rd',
  'qwerty', 'qwertyuiop', 'qwerty123', 'qwerty123!',
  'letmein', 'letmein1', 'letmein123', 'letmein123!',
  'welcome', 'welcome1', 'welcome123', 'welcome123!',
  'admin', 'admin123', 'administrator', 'root', 'root123',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'abc123', 'abc12345', 'abcd1234', 'abc123!', 'abcdefgh',
  '123456', '1234567', '12345678', '123456789', '1234567890',
  '11111111', '00000000', '12121212', '12312312',
  'suppliwise', 'suppliwise1', 'suppliwise123', 'suppliwise1!',
  'suppliwiseadmin', 'suppliw1se',
]);

// Runs of characters that survive the "all one class" rules and are still
// worthless: `abcdefghijk`, `qwertyuiop`, `0987654321`, … Short runs are listed
// too — `12345678aA!` satisfies every composition rule and is one of the first
// things anyone tries.
const SEQUENCES = [
  'abcdefghij', 'jihgfedcba', 'qwertyuiop', 'poiuytrewq', 'asdfghjkl',
  'lkjhgfdsa', 'zxcvbnm', 'mnbvcxz', '0987654321', '1234567890',
  'abcdef', 'fedcba', 'qwerty', 'asdfgh', '123456', '654321', '000000', '111111',
];

// Four or more of the same character in a row. `aaaaaaaaaaaaaaaA1!` meets every
// rule and has close to no entropy.
const REPEATED_RUN = /(.)\1{3,}/;

/** Strip everything that isn't a letter or digit, so `P@ssw0rd!` == `password`. */
function squash(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const asText = (value) => (typeof value === 'string' ? value : '');

/**
 * True when the password is one of the guessable ones.
 *
 * `email` is optional; when supplied, a password built around the address
 * itself (`suppliwise2026@gmail.com` → `suppliwise2026`) is refused too. People
 * do this constantly, and it is public information.
 */
function isCommonPassword(value, email) {
  const password = asText(value);
  if (!password) return true;

  const squashed = squash(password);
  if (!squashed) return true; // only symbols — technically compliant, useless
  if (BLOCKED_PASSWORDS.has(squashed)) return true;

  // A blocked word decorated with a year and a symbol — `SuppliWise2026!`,
  // `Password123!` — is the single most common way people satisfy composition
  // rules. The blocklist alone misses every one of them, because the exact
  // string is unique.
  const decorated = squashed.match(/^([a-z]+)\d*$/);
  if (decorated && BLOCKED_PASSWORDS.has(decorated[1])) return true;

  for (const sequence of SEQUENCES) {
    if (squashed.includes(sequence)) return true;
  }
  if (REPEATED_RUN.test(squashed)) return true;

  const domain = String(email || '').toLowerCase().split('@')[0];
  const localPart = squash(domain);
  if (localPart.length >= 5 && squashed.includes(localPart)) return true;

  return false;
}

/**
 * The rule-by-rule breakdown, in the order the checklist should be shown.
 *
 * Returned (rather than only a pass/fail) so the UI can render a live
 * checklist and a strength meter without a second copy of the rules, and so a
 * failure can name the ONE thing that is missing.
 */
function passwordChecks(value, options = {}) {
  const password = asText(value);
  const length = password.length;
  return [
    {
      id: 'length',
      ok: length >= PASSWORD_RULES.minLength && length <= PASSWORD_RULES.maxLength,
      label: `${PASSWORD_RULES.minLength}–${PASSWORD_RULES.maxLength} characters`,
    },
    { id: 'uppercase', ok: /[A-Z]/.test(password), label: 'An uppercase letter' },
    { id: 'lowercase', ok: /[a-z]/.test(password), label: 'A lowercase letter' },
    { id: 'number', ok: /[0-9]/.test(password), label: 'A number' },
    { id: 'symbol', ok: SYMBOL_PATTERN.test(password), label: 'A symbol (! @ # $ …)' },
    { id: 'common', ok: !isCommonPassword(password, options.email), label: 'Not a common or guessable password' },
  ];
}

/**
 * A 0–4 strength score for the meter.
 *
 * Driven by how many rules are satisfied, with length breaking ties — a 10
 * character password that meets every rule is decent; a 20 character one that
 * meets every rule is genuinely good, and the meter should be able to say so.
 *
 * The top two bands are reserved for passwords that meet EVERY rule. Without
 * that clamp a 7-character password with a symbol in it rated "Very strong" on
 * a live meter while the form rejected it on submit — the meter has to agree
 * with the verdict or it is worse than no meter.
 */
function scorePassword(value, options = {}) {
  const checks = passwordChecks(value, options);
  const met = checks.filter((check) => check.ok).length;
  const length = asText(value).length;

  let score;
  if (met <= 1) score = 0;
  else if (met === 2) score = 1;
  else if (met === 3) score = 2;
  else if (length >= 14) score = 4; // every rule met
  else score = 3;                   // every rule met

  if (met < checks.length) score = Math.min(score, 2);
  return score;
}

const SCORE_LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];

/**
 * Evaluate a password against the policy.
 *
 * @param {string} value
 * @param {{email?: string}} [options] Pass the account's email to also refuse
 *   passwords built from the address.
 * @returns {{ok: boolean, message: string, checks: Array, met: number,
 *            total: number, score: number, scoreLabel: string}}
 *   `message` is empty when `ok`; otherwise it is the single most useful thing
 *   to tell the user, phrased as an instruction rather than a rejection.
 */
function evaluatePassword(value, options = {}) {
  const password = asText(value);
  const checks = passwordChecks(password, options);
  const met = checks.filter((check) => check.ok).length;
  const length = password.length;

  let message = '';
  if (length > PASSWORD_RULES.maxLength) {
    message = `Passwords can be at most ${PASSWORD_RULES.maxLength} characters.`;
  } else if (length < PASSWORD_RULES.minLength) {
    message = `Use at least ${PASSWORD_RULES.minLength} characters — length is what makes a password hard to guess.`;
  } else if (PASSWORD_RULES.requireUppercase && !/[A-Z]/.test(password)) {
    message = 'Add an uppercase letter (A–Z).';
  } else if (PASSWORD_RULES.requireLowercase && !/[a-z]/.test(password)) {
    message = 'Add a lowercase letter (a–z).';
  } else if (PASSWORD_RULES.requireNumber && !/[0-9]/.test(password)) {
    message = 'Add a number (0–9).';
  } else if (PASSWORD_RULES.requireSymbol && !SYMBOL_PATTERN.test(password)) {
    message = 'Add a symbol such as ! @ # or $.';
  } else if (isCommonPassword(password, options.email)) {
    message = 'That password is too easy to guess. Choose something harder to predict.';
  }

  const score = scorePassword(password, options);
  return {
    ok: message === '',
    message,
    checks,
    met,
    total: checks.length,
    score,
    scoreLabel: SCORE_LABELS[score],
  };
}

/**
 * The policy, in a shape the client can render directly.
 *
 * Served by `GET /api/auth/password-reset/rules` so the checklist on the reset
 * page is generated from the same object the server validates against. Without
 * this, the UI needs its own copy of these numbers and drifts — which is
 * exactly the bug the client-side `validatePassword()` in LogIn.jsx had.
 */
function describePasswordRules() {
  return {
    minLength: PASSWORD_RULES.minLength,
    maxLength: PASSWORD_RULES.maxLength,
    requireUppercase: PASSWORD_RULES.requireUppercase,
    requireLowercase: PASSWORD_RULES.requireLowercase,
    requireNumber: PASSWORD_RULES.requireNumber,
    requireSymbol: PASSWORD_RULES.requireSymbol,
    checks: passwordChecks('').map(({ id, label }) => ({ id, label })),
    scoreLabels: SCORE_LABELS,
  };
}

module.exports = {
  PASSWORD_RULES,
  passwordChecks,
  scorePassword,
  evaluatePassword,
  describePasswordRules,
  isCommonPassword,
};
