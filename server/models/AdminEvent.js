const mongoose = require('mongoose');

const adminEventSchema = new mongoose.Schema({
  // NOTE: 'subscription' was being written by the admin subscription routes while
  // it was missing from this enum, so every one of those audit rows failed
  // validation and was swallowed by the fire-and-forget `.catch(() => {})` — the
  // audit trail silently lost every subscription change. 'subscription-request'
  // is the new "a user submitted proof of payment" bell, and 'support-chat' is
  // the "a member started / reopened a support conversation" bell. Check this
  // enum BEFORE writing a new fire-and-forget AdminEvent.
  type: {
    type: String,
    enum: [
      'new-device-login', 'security', 'account', 'severe-flag', 'resolved',
      'subscription', 'subscription-request', 'subscription-cancel-request',
      'support-chat',
    ],
    required: true,
  },
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
// User-scoped event lookups (e.g. "events for this user")
adminEventSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('AdminEvent', adminEventSchema);
