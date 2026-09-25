/**
 * Shared email validation.
 *
 * Extracted from routes/auth.js rather than copied: the recovery-email flow
 * needs the SAME rule (including the typo-TLD rejection), and a second,
 * slightly different copy is how an app ends up accepting an address on one
 * screen that it rejects on another.
 */

// Requires a real TLD (2+ letters). Rejects the classic typo domains (.con,
// .cmo, .ocm, .nte, .ogr, .cpm) that a user is far more likely to have
// mistyped than to have meant.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const SUSPICIOUS_TLDS = ['.con', '.cmo', '.ocm', '.nte', '.ogr', '.cpm'];

function isValidEmail(email) {
  const value = String(email || '');
  if (!EMAIL_REGEX.test(value)) return false;
  const lower = value.toLowerCase();
  if (SUSPICIOUS_TLDS.some((tld) => lower.endsWith(tld))) return false;
  return true;
}

module.exports = { isValidEmail, EMAIL_REGEX, SUSPICIOUS_TLDS };
