'use strict';

/**
 * Phone numbers — normalisation, validation, and safe display.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every place a phone number is accepted is reachable directly, and every one of
 * them puts the number into a paid SMS request aimed at a stranger if the value
 * is wrong. There is no libphonenumber dependency here (and deliberately no new
 * one), so this module is the single boundary that decides what counts as a
 * number the server is willing to send to.
 *
 * WHAT A VALID NUMBER IS HERE
 * ---------------------------
 * E.164 only: a leading `+`, then 8–15 digits.
 *
 * Requiring the `+` is the important decision. A bare national number such as
 * `07700900123` is ambiguous — it means a UK mobile, an Irish mobile and a
 * German one is a different shape entirely, and guessing the country code is how
 * an account ends up texting a stranger. Refusing and saying "include your
 * country code" costs the user one keystroke; guessing costs them a text to
 * somebody who never asked for one, billed at our expense.
 *
 * We do NOT attempt to validate that the number is *assigned* or reachable. That
 * requires carrier-grade metadata this server has no business holding, and
 * pretending to know it would be a lie the UI acts on.
 *
 * FORMATTING IS TOLERATED, JUNK IS NOT
 * ------------------------------------
 * Spaces, dashes, dots and brackets are stripped, because they are how people
 * actually type numbers and stripping them cannot change which number is meant.
 * Letters and anything else are REFUSED rather than stripped: "07700900123 ext
 * 4" stripped down is `077009001234`, a real number belonging to somebody else,
 * and silently sending a verification code to it is worse than an error message.
 *
 * STORAGE
 * -------
 * `normalizePhone()` is the only function allowed to produce a value that gets
 * stored, so the database holds exactly one representation of a number. Callers
 * MUST re-normalise on read rather than trusting what was written earlier —
 * see utils/sms.js, which refuses to send to anything `isValidE164()` rejects,
 * so a hand-edited or legacy row can never become an outgoing request.
 */

/** ITU-T E.164 caps a subscriber number at 15 digits, country code included. */
const MAX_E164_DIGITS = 15;

/**
 * Below 8 digits no plausible E.164 number exists — every real country code is
 * 1–3 digits and leaves at least 5 for the subscriber. The floor exists to
 * reject short-code fragments and typos before a message is billed.
 */
const MIN_E164_DIGITS = 8;

/** Characters a person legitimately types that carry no meaning. */
const FORMATTING = /[\s\-().]/g;

/**
 * Normalise user input to E.164, or return null if it cannot be one.
 *
 * @param {unknown} input
 * @returns {string|null} e.g. '+447700900123', or null when unusable.
 */
function normalizePhone(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return null;

  // Formatting characters go; everything else is checked, not stripped.
  const compact = raw.replace(FORMATTING, '');
  if (!compact) return null;

  // Must start with `+`. A bare `00` international prefix is accepted as an
  // explicit signal of intent and rewritten, since it is unambiguous.
  let candidate = compact;
  if (candidate.startsWith('00')) candidate = `+${candidate.slice(2)}`;
  if (!candidate.startsWith('+')) return null;

  const digits = candidate.slice(1);
  // Anything left that is not a digit means the caller typed something we will
  // not silently reinterpret as part of the number.
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;
  // Country codes never start with 0. A leading zero is a national-format
  // number that lost its `+`, and the user has dropped the part we needed.
  if (digits[0] === '0') return null;

  return `+${digits}`;
}

/**
 * Is this already a stored, canonical number?
 *
 * Used at the point of USE (before sending), never at the point of input. It is
 * the check that makes a malformed or hand-edited database row harmless.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidE164(value) {
  return typeof value === 'string' && normalizePhone(value) === value;
}

/**
 * Enough of the number to recognise it, not enough to harvest it.
 *
 * Mirrors `maskEmail`/`maskTail` in utils/email.js and utils/passwordRecovery.js,
 * which exist for the same reason: logs and notification text should stay
 * diagnosable without persisting a subscriber's full contact details.
 *
 * The last three digits are kept because "is this the number I meant?" is
 * answerable with them. Everything else is a bullet.
 *
 * @param {unknown} value
 * @returns {string} e.g. '+•••••••123'
 */
function maskPhone(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return 'your phone';
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 4) return '+•••';
  return `+${'•'.repeat(Math.max(1, digits.length - 3))}${digits.slice(-3)}`;
}

module.exports = {
  MIN_E164_DIGITS,
  MAX_E164_DIGITS,
  normalizePhone,
  isValidE164,
  maskPhone,
};