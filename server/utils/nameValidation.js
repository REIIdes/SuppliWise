/**
 * Name validation — the server half of the rule.
 *
 * This is deliberately a mirror of my-react-app/src/utils/nameValidation.js.
 * The browser already filters these fields, but a client check is only a
 * suggestion: /api/auth/register and the profile update endpoint can be called
 * directly, which is how "John123" got into the database in the first place.
 * The pattern on the Mongoose schema (models/User.js) is the real boundary.
 *
 * If you change what a name may contain, change BOTH files together.
 */

/** Letters from any script, not just ASCII: José, Müller, 李雷, Аня. */
const LETTERS = '\\p{L}\\p{M}';
/** Letters, marks, and the punctuation real names use. */
const INNER = `${LETTERS} '\\-.’`;
/** A name ends on a letter/mark, or a period for an initialism ("J. R. R."). */
const TAIL = `[${LETTERS}.]`;

const NAME_MIN = 2;
const NAME_MAX = 50;

/**
 * A name starts and ends on a letter/mark (a final period is allowed), so it
 * cannot begin or end with a space, hyphen or apostrophe. Digits, symbols and
 * emoji are excluded outright.
 */
const NAME_PATTERN = new RegExp(`^[${LETTERS}][${INNER}]*${TAIL}$`, 'u');

/** True when the value satisfies the name rule (trimmed, non-empty). */
function isValidName(raw) {
  return NAME_PATTERN.test(String(raw ?? '').trim());
}

/**
 * Human-readable description of the allowed characters, for error messages.
 * Exported so the message text lives with the pattern instead of being
 * duplicated in three call sites.
 */
const NAME_CHARS_HINT = 'letters, spaces, hyphens, apostrophes and periods.';

module.exports = {
  NAME_MIN,
  NAME_MAX,
  NAME_PATTERN,
  NAME_CHARS_HINT,
  isValidName,
};
