const mongoose = require('mongoose');

// Server-side login session — the source of truth for "is this token still
// allowed to act?". One document per sign-in, tied to exactly one account.
//
// Model (see docs/DEVELOPER_GUIDE.md):
//   Account ──< Session (current active = the one whose _id equals
//   User.currentSessionId, enforced atomically on every sign-in)
//
// A JWT alone is NEVER enough: middleware verifies the signature, then this
// record must exist, belong to the authenticated account, be the account's
// current active session, and not be revoked. Sessions have no idle or
// absolute expiry (`expiresAt` stays null) — they end only when replaced by a
// newer sign-in or explicitly revoked at sign-out.
const sessionSchema = new mongoose.Schema(
  {
    // The session id embedded in the JWT as the `sid` claim.
    // _id IS the sessionId.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // sha256 of the JWT minted for this session — audit trail only; validity
    // is decided by signature + ownership + current-session pointer, never by
    // string-comparing tokens.
    tokenHash: {
      type: String,
      default: '',
    },
    // SHA-256 of the OPT-IN "save my login on this browser" credential
    // (POST /auth/remember) — '' unless that sign-in asked to be remembered.
    // Lookup by this hash only FINDS the candidate session; validity is still
    // decided by verifyUserSession (signed out / replaced / banned all reject
    // the mint), so it can never outlive the session it belongs to. Pruned
    // with the record after 30 days.
    rememberHash: {
      type: String,
      default: '',
      index: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    // Informational activity stamp (throttled server-side). Never used to
    // expire a session: users do not get logged out for being idle.
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
    // null = the session never expires on its own. Kept as a field so a
    // future policy (e.g. admin-only TTL) can opt in per session type.
    expiresAt: {
      type: Date,
      default: null,
    },
    // Set when this session is displaced by a newer sign-in or revoked at
    // sign-out. A revoked session is rejected even if the pointer still
    // mentions it (belt and braces against any pointer/revocation skew).
    revokedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: false }
);

// "Sessions for this account, newest first" (admin/security views, revocation).
sessionSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Session', sessionSchema);
