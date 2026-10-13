/**
 * Format a phone number for display
 * Converts raw formats like "1234567890" to "(123) 456-7890"
 * @param {string} phone - Raw phone number
 * @returns {string} Formatted phone number
 */
export function formatPhoneNumber(phone) {
  if (!phone) return '—';
  
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');
  
  // Handle different lengths
  if (digits.length === 10) {
    // Format: (123) 456-7890
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  } else if (digits.length === 11 && digits[0] === '1') {
    // Format: +1 (123) 456-7890
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  } else if (digits.length > 10) {
    // International format: keep original with basic formatting
    return `+${digits}`;
  }
  
  // Return original if format is unrecognized
  return phone;
}

/**
 * Format an email address for display
 * Ensures proper lowercase and basic sanitization
 * @param {string} email - Email address
 * @returns {string} Formatted email address
 */
export function formatEmail(email) {
  if (!email) return '—';
  return email.trim().toLowerCase();
}
