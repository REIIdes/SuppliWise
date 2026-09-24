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
  lastLoginAt: { type: Date, default: null },
  lastActivityAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('AdminAccount', adminAccountSchema);
