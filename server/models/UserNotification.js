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
      enum: ['severe-flag', 'info'],
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
  },
  { timestamps: true }
);

// Newest-first per-user inbox queries
userNotificationSchema.index({ user: 1, createdAt: -1 });
userNotificationSchema.index({ user: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('UserNotification', userNotificationSchema);
