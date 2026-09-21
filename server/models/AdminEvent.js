const mongoose = require('mongoose');

const adminEventSchema = new mongoose.Schema({
  type: { type: String, enum: ['new-device-login', 'security', 'account', 'severe-flag', 'resolved'], required: true },
  title: { type: String, required: true },
  detail: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  readBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  // Deep-link targets for interactable notifications
  assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment', default: null },
  linkUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// Admin panels sort/filter events by recency and type
adminEventSchema.index({ createdAt: -1 });
adminEventSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model('AdminEvent', adminEventSchema);
