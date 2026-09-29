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
// EXPIRY. A session ends when it is REPLACED by a newer sign-in, when it is
// revoked (sign-out, password reset, "sign out of all other devices"), or when
// the account is disabled — and on no other basis. It does not expire because
// of the clock: a user JWT carries no `exp` and no idle window is applied.
//
// A 30-day sliding idle window used to sit here. It is deliberately gone — a
// member who opened the app monthly was signed out monthly with no way to opt
// out, and the token-leak exposure it addressed is barely narrower at 30 days
// than at 31. Revocation is the authority, it is immediate, and it is published
// to the validation cache so it takes effect on the next request rather than
// the next cache expiry. See utils/userSession.js for the full argument and for
// the things that still bound a session.
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
    // When this session was last genuinely used. NOTHING reads this to make an
    // authorisation decision — a user session has no time-based expiry. It is
    // display data: it is what the "Signed-in devices" list sorts by and what
    // a member reads as "last active", and it is the input to a stale-session
    // sweep that an operator can run if they want one.
    //
    // Only RECENT activity counts (a request's own age is checked, so a
    // replayed old request cannot keep the label sliding forward), and the write
    // is throttled, so a busy member is not one update per API call.
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
    // Which credential actually opened this session, recorded at sign-in:
    // 'password' | 'passkey' | 'totp' | 'backup-code' | 'email-otp' |
    // 'remember'.
    //
    // Display and forensics, never authorisation. Its value is that "signed in
    // 4 hours ago with a passkey" and "...with a recovery code" are very
    // different events, and before this existed the security page could only
    // report that a session existed.
    authMethod: {
      type: String,
      default: '',
      maxlength: 32,
    },
    // Whether a second factor was verified for THIS session. A passkey
    // assertion with user verification counts as two factors (something you
    // have plus something you are), and is recorded as such, so a reviewer can
    // tell a 2FA session from a bare-password one.
    mfaVerified: {
      type: Boolean,
      default: false,
    },
    // The passkey this session was opened with, for the audit trail. Deleting
    // the passkey does NOT retroactively end the session: revocation happens
    // through the ordinary session paths, and a passkey is a proof of
    // possession rather than a lease on the session it opened.
    passkeyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Passkey',
      default: null,
    },
    // An OPTIONAL ABSOLUTE cap, honoured by verifyUserSession before anything
    // else. null (the default, and what the application always writes) means the
    // session has no time-based expiry and ends only through revocation.
    //
    // It is kept as a field rather than deleted so that "no expiry" is a
    // configuration someone chose, not merely the absence of a mechanism — an
    // operator can set a hard deadline for one account or one cohort without a
    // code change, and `lastActivityAt` gives them the age to compute it from.
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
// "Live sessions for this account" — every device list and the revoke-other-
// devices sweep filter on { user, revokedAt }, and there is no index for that
// without it. On an account with a long history of sign-ins this is the
// difference between a collection scan and a bounded read on a route the user
// hits every time they open their security page.
sessionSchema.index({ user: 1, revokedAt: 1 });

module.exports = mongoose.model('Session', sessionSchema);
