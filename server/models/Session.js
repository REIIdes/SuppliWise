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
// current active session, and not be revoked.
//
// EXPIRY. A session ends when it is replaced by a newer sign-in, when it is
// revoked at sign-out, or after 30 days WITHOUT ACTIVITY (the sliding window in
// utils/userSession.js). That last one exists because a user JWT carries no
// `exp`, so without it a leaked token would be valid forever — and a token
// thief controls neither sign-in nor sign-out.
//
// The window is DERIVED from `lastActivityAt` at verification time rather than
// stored as a moving deadline, so there is no second copy to fall out of step.
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
    // When this session was last genuinely used. The sliding idle window is
    // derived from this at verification time — see the header note.
    //
    // Only RECENT activity counts (a request's own age is checked, so a
    // replayed old request cannot hold the session open), and the write is
    // throttled, so a busy member is not one update per API call.
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
    // ── Device attribution (display only) ──────────────────────────────
    // Recorded at sign-in so "Signed-in devices" can name a device. NEVER
    // used as an authorisation input: user-agent is attacker-controlled, so
    // trusting it for identity would be a hole. These fields exist to help a
    // person recognise their own sessions, nothing more.
    deviceLabel: {
      type: String,
      default: '',
      maxlength: 120,
    },
    platform: {
      type: String,
      default: '',
      maxlength: 80,
    },
    ip: {
      type: String,
      default: '',
      maxlength: 64,
    },
    location: {
      type: String,
      default: '',
      maxlength: 120,
    },
    // Set when this session holds a "save my login" credential, i.e. this is
    // a TRUSTED DEVICE the user can revoke individually.
    trustedAt: {
      type: Date,
      default: null,
    },
    // An OPTIONAL hard cap, consulted BEFORE the sliding window so a future
    // policy can bound a particular session type without the window overriding
    // it. null = no hard cap, and the sliding idle window applies.
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
