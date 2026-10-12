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

  // ── Exactly one of these two, never both ────────────────────────────────
  //
  // `body` is the plaintext message. It is populated only on a thread that is
  // not end-to-end encrypted, and it is the legacy format: every message ever
  // written lives here.
  //
  // `cipher` is `e1.<iv>.<ciphertext>` — AES-256-GCM under the thread's
  // content key, which was generated in a browser and never reached this
  // server. The body of such a message is unknowable here, which is the entire
  // point; see utils/chatEncryption.js.
  //
  // A thread's own state decides which one a write may carry (enforceMessagePayload
  // below), so the collection never mixes two conventions inside one transcript.
  body: { type: String, default: '', trim: true, maxlength: 2000 },
  cipher: { type: String, default: '', maxlength: 8000 },
}, { timestamps: true });

/**
 * A message with neither a body nor a ciphertext is an empty bubble that still
 * bumps `messageCount`, floats the thread to the top of both queues and rings
 * somebody's bell. Refused at the model rather than in each of the four call
 * sites that write here, because this is the invariant, not a per-route rule.
 */
chatMessageSchema.pre('validate', function enforceMessagePayload(next) {
  if (!this.cipher && !this.body) {
    this.invalidate('body', 'A message needs either text or an encrypted body.');
  }
  next();
});

// The transcript: chronological within a thread.
chatMessageSchema.index({ thread: 1, createdAt: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
