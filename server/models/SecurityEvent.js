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
  'password-reset-requested',
  'password-reset-code-verified',
  'password-reset-completed',
  'backup-codes-generated',
  'backup-code-used',
  'backup-codes-invalidated',
  'backup-codes-regenerated',
  'session-revoked',
  'sessions-revoked-all',
  'device-trust-revoked',
  'recovery-email-changed',
  'account-locked',
  'unrecognized-login',
  // ── Passkeys / WebAuthn ──────────────────────────────────────────────
  // Names mirror the state machine rather than the UI: a credential is added,
  // used, renamed, and removed, and each is a separate audit event because
  // "a passkey was removed" is the single most security-relevant line in this
  // whole list — it is what an attacker does to lock a victim out.
  'passkey-added',
  'passkey-removed',
  'passkey-renamed',
  'passkey-used',
  'passkey-registration-failed',
  'passkey-login-failed',
  // ── TOTP / authenticator app ─────────────────────────────────────────
  'totp-setup-started',
  'totp-enabled',
  'totp-disabled',
  'totp-failed',
  // ── Session lifecycle ─────────────────────────────────────────────────
  'session-created',
  'mfa-challenge-created',
  'email-changed',
  'reauth-succeeded',
  'reauth-failed',
  // Raised when a signal worth a human's attention is noticed, WITHOUT
  // asserting an attack: a passkey assertion signed by a credential that
  // belonged to another account, a sign-in that skipped the second factor, a
  // transaction spent from a different address than it was opened from.
  'suspicious-authentication',
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
    // A small, FIXED vocabulary of extra facts about the event.
    //
    // The event list is already a closed set, and this is closed for the same
    // reason: an open "details" object is how a secret ends up in an audit log
    // three code changes later. Each key below is a scalar, truncated and typed
    // by this file, so a caller cannot add its own key and therefore cannot
    // smuggle a TOTP seed, a backup code, a token or a clientDataJSON through
    // here even by accident.
    meta: {
      // How the person proved themselves: password | passkey | totp |
      // backup-code | email-otp | remember.
      authMethod: { type: String, default: '', maxlength: 32 },
      // Which factor was demanded, offered or refused.
      factor: { type: String, default: '', maxlength: 32 },
      // The user's own label for a passkey. Never the credential id: that is a
      // bearer-adjacent identifier and it belongs in no log.
      passkeyName: { type: String, default: '', maxlength: 60 },
      // Coarse platform word ("Windows", "iOS") parsed from the user-agent.
      platform: { type: String, default: '', maxlength: 40 },
      // Whether a second factor was actually verified in this authentication.
      mfaVerified: { type: Boolean, default: false },
      // A short, non-identifying outcome word ("ok", "expired", "mismatch").
      outcome: { type: String, default: '', maxlength: 24 },
    },
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

// The Model, compiled BEFORE write() so the helper can use it.
//
// This ordering is load-bearing and it used to be wrong. `write()` called
// `securityEventSchema.create(...)`, and `Schema.prototype.create` does not
// exist in Mongoose 8 - it was added to `Model`, not `Schema`. Every call
// therefore threw a TypeError into the catch below and returned null, which is
// indistinguishable from success at every call site (all of them `await` it and
// ignore the result).
//
// The consequence was that the security activity log had never once written a
// row: sign-ins, failed sign-ins, MFA decisions, recovery-code use, session
// revocation and every security-setting change were all silently discarded.
// Nothing errored, nothing was logged, and the "Recent security activity"
// panel simply stayed empty. This is the single most expensive kind of bug in
// an audit trail - a control that reports success while doing nothing.
const SecurityEvent = mongoose.models.SecurityEvent
  || mongoose.model('SecurityEvent', securityEventSchema);

// The keys `meta` will accept, and how each is coerced. An allowlist rather
// than copy-and-trust, so a caller that hands over a whole request object (or
// something worse) gets the unrecognised keys dropped instead of persisted.
const META_KEYS = {
  authMethod: (v) => String(v || '').slice(0, 32),
  factor: (v) => String(v || '').slice(0, 32),
  passkeyName: (v) => String(v || '').slice(0, 60),
  platform: (v) => String(v || '').slice(0, 40),
  mfaVerified: (v) => v === true,
  outcome: (v) => String(v || '').slice(0, 24),
};

function safeMeta(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  let touched = false;
  for (const [key, coerce] of Object.entries(META_KEYS)) {
    if (input[key] === undefined) continue;
    out[key] = coerce(input[key]);
    touched = true;
  }
  return touched ? out : undefined;
}

/**
 * Append an event. Never throws and never rejects — a failure to record
 * history must not be able to fail the sign-in, MFA check or password change
 * that produced it. Callers `await` it for test determinism but can ignore it.
 */
async function write({ user, type, success = true, ip = '', userAgent = '', location = '', reason = '', meta = null }) {
  try {
    if (!user || !EVENT_TYPES.includes(type)) return null;
    const extra = safeMeta(meta);
    return await SecurityEvent.create({
      user,
      type,
      success: success !== false,
      ip: String(ip || '').slice(0, 64),
      userAgent: String(userAgent || '').slice(0, 300),
      location: String(location || '').slice(0, 120),
      reason: String(reason || '').slice(0, 160),
      ...(extra ? { meta: extra } : {}),
    });
  } catch {
    return null;
  }
}

module.exports = SecurityEvent;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.META_KEYS = Object.keys(META_KEYS);
module.exports.write = write;
