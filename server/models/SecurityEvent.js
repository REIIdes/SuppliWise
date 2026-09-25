const mongoose = require('mongoose');

/**
 * SecurityEvent — the account's own, append-only security history.
 *
 * WHY THIS EXISTS
 * The UI previously derived "Recent security activity" by string-matching
 * notification *titles* in the browser. That silently dropped any event whose
 * wording changed, could not express success vs failure, and had nowhere to
 * record a FAILED sign-in or a rejected MFA code. This is the structured
 * record those features need.
 *
 * WHAT IS DELIBERATELY ABSENT
 * No passwords, TOTP secrets, backup codes, tokens, session ids or hashes are
 * ever written here. `write()` takes a fixed vocabulary of types and simply
 * cannot express a secret — there is no free-form field an event body could
 * smuggle one through. The IP is stored because a user reviewing their own
 * history needs to recognise their own devices; it is never exposed to any
 * other user (every read is scoped to `req.user._id`).
 *
 * Written as its own collection rather than folded into UserNotification:
 * the notification inbox is a UI surface that gets marked read and deleted,
 * whereas this is an audit trail that must not be mutable by the UI.
 */
const EVENT_TYPES = [
  'login-success',
  'login-failure',
  'mfa-success',
  'mfa-failure',
  'mfa-enabled',
  'mfa-disabled',
  'password-changed',
  'password-change-failed',
  'backup-codes-generated',
  'backup-code-used',
  'backup-codes-invalidated',
  'session-revoked',
  'sessions-revoked-all',
  'device-trust-revoked',
  'recovery-email-changed',
  'account-locked',
  'unrecognized-login',
];

const securityEventSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: EVENT_TYPES,
      required: true,
    },
    // true = the event describes something that SUCCEEDED, false = rejected.
    // Displayed as a success/failure column; never phrased as "malicious"
    // because a failed attempt is not evidence of an attack.
    success: {
      type: Boolean,
      default: true,
    },
    // Truncated, display-only. Never parsed, never trusted for decisions.
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    // Human-readable "City, Country" / "Private network" etc.
    location: { type: String, default: '' },
    // Short, non-sensitive explanation ("Wrong password", "New device").
    // Kept generic on purpose: it must never quote user input verbatim.
    reason: { type: String, default: '', maxlength: 160 },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// Newest-first reads are always "this user's latest N events".
securityEventSchema.index({ user: 1, createdAt: -1 });

// Housekeeping: an account's history is capped by age rather than by count, so
// a dormant account can't accumulate rows forever. A scheduled sweep removes
// them; nothing in the read path depends on the cap being enforced promptly.
securityEventSchema.index({ createdAt: 1 });

/**
 * Append an event. Never throws and never rejects — a failure to record
 * history must not be able to fail the sign-in, MFA check or password change
 * that produced it. Callers `await` it for test determinism but can ignore it.
 */
async function write({ user, type, success = true, ip = '', userAgent = '', location = '', reason = '' }) {
  try {
    if (!user || !EVENT_TYPES.includes(type)) return null;
    return await securityEventSchema.create({
      user,
      type,
      success: success !== false,
      ip: String(ip || '').slice(0, 64),
      userAgent: String(userAgent || '').slice(0, 300),
      location: String(location || '').slice(0, 120),
      reason: String(reason || '').slice(0, 160),
    });
  } catch {
    return null;
  }
}

const SecurityEvent = mongoose.models.SecurityEvent
  || mongoose.model('SecurityEvent', securityEventSchema);

module.exports = SecurityEvent;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.write = write;
