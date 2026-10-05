const mongoose = require('mongoose');

const adminAccountSchema = new mongoose.Schema({
  alias: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  totpSecret: { type: String, required: true, select: false },
  enabled: { type: Boolean, default: true },
  // Selfie / banner the admin picks in Settings → Edit profile. Stored as
  // base64 data URLs exactly like the member-facing User pictures, so no
  // upload pipeline or static file host is needed.
  profilePicture: { type: String, default: '' },
  bannerPicture: { type: String, default: '' },
  // Version stamp for the two picture fields ONLY. `updatedAt` cannot serve
  // this purpose: the admin heartbeat writes lastActivityAt on every request,
  // so timestamps bump it continuously and the client would re-download the
  // multi-megabyte pictures on every poll. This moves ONLY when a picture is
  // actually saved, so GET /profile can stay a few hundred bytes and the
  // pictures are fetched once, then only when this value changes.
  picturesUpdatedAt: { type: Date, default: null },
  lastLoginAt: { type: Date, default: null },
  lastActivityAt: { type: Date, default: null },

  // ── Forced password change on first sign-in ────────────────────────────
  // Set when the account's password was set by something other than the person
  // holding it: a generated hand-off value, a reset, an operator override. The
  // admin is signed in normally but may only reach the change-password endpoint
  // until the flag clears, so the generated value stops being a real password
  // the moment it is first used.
  //
  // The gate is enforced in middleware/auth.js, NOT only by the client
  // redirect. A redirect is a UI convenience: the JWT is already valid, so
  // anything that skips the browser (curl, a stale tab, another device) would
  // otherwise walk straight into /api/admin on a password nobody chose.
  mustChangePassword: { type: Boolean, default: false },
  // When the password was last set by this account's owner. Null means it has
  // never been changed, which is what a freshly generated account looks like.
  passwordChangedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('AdminAccount', adminAccountSchema);
