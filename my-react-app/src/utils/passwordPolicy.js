/**
 * Client-side view of the server's password policy.
 *
 * The rules are FETCHED, not hard-coded, and this module is the fallback for
 * when they cannot be fetched. That ordering is the whole point: the old
 * LogIn.jsx carried its own `validatePassword()` with a hand-copied 8/upper/
 * digit rule while the server enforced something else, so the form happily
 * accepted a password the server then rejected with no field-level explanation.
 * Here the server is the source of truth and these constants only stand in
 * when it is unreachable — a cosmetic degradation, never a validation path.
 *
 * `evaluate()` here is a UX affordance only. The server re-validates
 * everything on submit and its message wins.
 */

/** Mirrors server/utils/passwordRules.js. Keep in sync; it is a fallback. */
export const FALLBACK_RULES = Object.freeze({
  minLength: 10,
  maxLength: 128,
  checks: [
    { id: 'length', label: '10–128 characters' },
    { id: 'uppercase', label: 'An uppercase letter' },
    { id: 'lowercase', label: 'A lowercase letter' },
    { id: 'number', label: 'A number' },
    { id: 'symbol', label: 'A symbol (! @ # $ …)' },
    { id: 'common', label: 'Not a common or guessable password' },
  ],
  scoreLabels: ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'],
});

const asText = (value) => (typeof value === 'string' ? value : '');

/** Strip non-alphanumerics so `P@ssw0rd!` compares equal to `password`. */
const squash = (value) => asText(value).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A local heuristic for the "not guessable" rule.
 *
 * STRIPPED FIRST, which is the part that matters. Matching the raw string missed
 * `Password123!` — the single most common way people satisfy a symbol rule —
 * because the trailing `!` meant the anchored pattern never fired. Squashing to
 * alphanumerics first is what the server does, and the two have to agree or the
 * tick appears and then vanishes on submit.
 *
 * A deliberately short prefix list. This is not the real blocklist and does not
 * pretend to be: the server owns that. This exists so the obvious floor-satisfiers
 * are flagged while typing rather than after.
 */
const GUESSABLE_ROOTS = /^(?:password|passw0rd|password1|qwerty|letmein|welcome|admin|root|suppliwise|abc|iloveyou|monkey|dragon)/;
const KEY_RUNS = /(?:123456|654321|abcdef|fedcba|qwerty|asdfgh|0987654)/;
const REPEATED_RUN = /(.)\1{3,}/;

function looksGuessable(value) {
  const squashed = squash(value);
  if (!squashed) return true; // symbols only — compliant on paper, worthless
  if (GUESSABLE_ROOTS.test(squashed)) return true;
  if (KEY_RUNS.test(squashed)) return true;
  if (REPEATED_RUN.test(squashed)) return true;
  return false;
}

/**
 * Validate against whichever rule set was supplied.
 *
 * @param {string} value
 * @param {object} rules A `describePasswordRules()` payload, or FALLBACK_RULES.
 * @returns {{ok: boolean, message: string, checks: Array, score: number,
 *            scoreLabel: string, met: number, total: number}}
 */
export function evaluate(value, rules = FALLBACK_RULES) {
  const password = asText(value);
  const list = Array.isArray(rules?.checks) && rules.checks.length ? rules.checks : FALLBACK_RULES.checks;
  const labels = Array.isArray(rules?.scoreLabels) && rules.scoreLabels.length
    ? rules.scoreLabels
    : FALLBACK_RULES.scoreLabels;
  const min = Number(rules?.minLength) || FALLBACK_RULES.minLength;
  const max = Number(rules?.maxLength) || FALLBACK_RULES.maxLength;

  const byId = {
    length: password.length >= min && password.length <= max,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /[0-9]/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password),
    // Only a heuristic locally — the server owns the real blocklist. It is
    // deliberately a little STRICTER than "unknown": a false tick that clears
    // on submit is a small annoyance, whereas a false pass that the server
    // then rejects is the drift this module exists to stop.
    common: !looksGuessable(password),
  };

  const checks = list.map((check) => ({ ...check, ok: !!byId[check.id] }));
  const met = checks.filter((check) => check.ok).length;

  // Same clamp as the server: the top two bands require every rule.
  let score;
  if (met <= 1) score = 0;
  else if (met === 2) score = 1;
  else if (met === 3) score = 2;
  else score = password.length >= 14 ? 4 : 3;
  if (met < checks.length) score = Math.min(score, 2);

  return { ok: met === checks.length, message: '', checks, score, scoreLabel: labels[score], met, total: checks.length };
}
