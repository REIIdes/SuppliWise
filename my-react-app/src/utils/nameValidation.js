/**
 * Name validation — one rule, used by every field that asks for a person's
 * name (sign-up, profile edit).
 *
 * WHY THIS EXISTS
 * The fields were `type="text"` with length checks only, so "John123" or
 * "3ng3l4" registered happily — and the Mongoose schema had no pattern either,
 * so the API accepted them too. A client-only fix would leave the hole open to
 * anyone posting directly to /api/auth/register.
 *
 * WHAT A NAME MAY CONTAIN
 *   letters   — any script (\p{L}), not just ASCII: José, Müller, 李雷, Аня
 *   marks     — combining accents (\p{M}) so decomposed text still validates
 *   space     — for multi-part names: "Mary Jane", "van der Berg"
 *   ' and ’   — O'Brien, D'Angelo
 *   -         — Smith-Jones, Anne-Marie
 *   .         — "J. Smith", "St. John"
 *
 * WHAT IT MAY NOT CONTAIN
 *   digits, symbols, emoji, or leading/trailing separators.
 *
 * The first and last characters are restricted to a letter/mark (a final
 * period is allowed, since "J. R. R." is a real initialism) so a name cannot
 * begin or end with a space, hyphen or apostrophe.
 */

export const NAME_MIN = 2;
export const NAME_MAX = 50;

// Must start and end with a letter/mark; the middle may hold name punctuation.
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} '\-.’]*[\p{L}\p{M}.]$/u;
const HAS_LETTER = /\p{L}/u;
// Everything that is not name material. Used to filter keystrokes and pastes.
const NOT_NAME_MATERIAL = /[^\p{L}\p{M} '\-.’]/gu;

// Kept in step with server/utils/nameValidation.js. If you change one, change
// the other, or the forms and the API will disagree about what a name is.
export const NAME_CHARS_HINT = 'letters, spaces, hyphens, apostrophes and periods.';

/** The pattern as a string, so JSX can put it straight on a `pattern` attribute. */
export const NAME_PATTERN_SOURCE = NAME_RE.source;

/**
 * Strip anything that cannot appear in a name, so the field simply will not
 * accept it. Used on input so a digit typed or pasted is dropped rather than
 * raising an error the user cannot act on.
 *
 * Also collapses runs of spaces and caps the length, which is what
 * `maxLength` does for typed input but NOT for a paste.
 */
export function sanitizeNameInput(raw) {
  return String(raw ?? '')
    .replace(NOT_NAME_MATERIAL, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, NAME_MAX);
}

/**
 * @param {string} raw
 * @param {string} label  Used in the message, e.g. "First name".
 * @returns {string} '' when valid, otherwise the message to show.
 */
export function validateName(raw, label = 'Name') {
  const value = String(raw ?? '').trim();

  if (!value) return `Please enter your ${label.toLowerCase()}.`;
  if (!HAS_LETTER.test(value)) return `${label} must contain at least one letter.`;
  if (value.length < NAME_MIN) return `${label} must be at least ${NAME_MIN} characters.`;
  if (value.length > NAME_MAX) return `${label} must be ${NAME_MAX} characters or fewer.`;
  if (!NAME_RE.test(value)) {
    return `${label} can only contain ${NAME_CHARS_HINT}`;
  }
  return '';
}

export const NAME_PATTERN = NAME_RE;
