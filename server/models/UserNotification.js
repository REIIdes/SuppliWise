const mongoose = require('mongoose');

const userNotificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['severe-flag', 'info', 'resolved'],
      default: 'info',
      index: true,
    },
    title: { type: String, required: true },
    detail: { type: String, default: '' },
    // Deep link target — assessment the notification refers to (if any)
    assessmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Assessment',
      default: null,
    },
    read: { type: Boolean, default: false, index: true },
    // Soft delete. The severe-flag backfill in routes/notifications.js rebuilds
    // an unread notice for every Priority assessment it cannot find one for, so
    // a hard delete would let a dismissed notice reappear as unread on the very
    // next poll (mark all as read -> delete all read -> unread badge is back).
    // Keeping the row as `dismissed` preserves the "this was already seen"
    // signal; routes/notifications.js purges those rows on a retention timer.
    dismissed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Newest-first per-user inbox queries
userNotificationSchema.index({ user: 1, dismissed: 1, createdAt: -1 });
userNotificationSchema.index({ user: 1, read: 1, dismissed: 1, createdAt: -1 });

module.exports = mongoose.model('UserNotification', userNotificationSchema);
