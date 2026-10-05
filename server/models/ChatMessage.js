const mongoose = require('mongoose');

/**
 * One message inside a ChatThread.
 *
 * Messages are append-only: nothing edits or deletes a single message, so the
 * transcript is a trustworthy record of what was actually said. A whole thread
 * is what gets removed — by the user deleting their account, or by an admin
 * deleting the conversation.
 *
 * `user` is denormalised onto the message even though the thread already has
 * it. That is deliberate: it is the field the account-deletion cascade looks
 * for (routes/admin.js USER_DELETE_PLAN, and the User.js delete hooks), and
 * without it a deleted account's transcript would be orphaned — unreadable
 * through any scoped query, but still sitting in the collection forever.
 */
const chatMessageSchema = new mongoose.Schema({
  thread: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatThread',
    required: true,
    index: true,
  },
  // Denormalised for the deletion cascade — see the note above.
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // 'user' | 'admin'. The AUTHORITY comes from the verified session, never from
  // this field: the client never sends it (see routes/supportChat.js).
  author: {
    type: String,
    enum: ['user', 'admin'],
    required: true,
  },
  // Display name of the author at the time of writing. Denormalised so a
  // renamed member (or a disabled admin) does not rewrite history.
  authorName: { type: String, default: '' },
  body: { type: String, required: true, trim: true, maxlength: 2000 },
}, { timestamps: true });

// The transcript: chronological within a thread.
chatMessageSchema.index({ thread: 1, createdAt: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
