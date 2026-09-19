const mongoose = require('mongoose');

const adminAccountSchema = new mongoose.Schema({
  alias: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  totpSecret: { type: String, required: true, select: false },
  enabled: { type: Boolean, default: true },
  lastLoginAt: { type: Date, default: null },
  lastActivityAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('AdminAccount', adminAccountSchema);
