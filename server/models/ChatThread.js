const mongoose = require('mongoose');

/**
 * A support conversation between ONE member and the admin team.
 *
 * This is NOT the AI assistant (that is stateless, see routes/chat.js). This is
 * the human channel: "where did I pay", "my plan did not activate", "can I get
 * a refund", "I cannot sign in" — the questions a bot cannot answer and an
 * admin must.
 *
 * ── Why the thread holds a denormalised copy of the last message ──────────
 * `lastMessagePreview` / `lastMessageBy` / `lastMessageAt` exist so the inbox
 * list can be rendered from ONE query. The alternative — a $lookup for the
 * newest message of every row — turns one indexed read into a fan-out that
 * grows with the queue, on a screen that is polled every few seconds by an
 * admin and by every signed-in member. The copy is written in the same request
 * that inserts the message, so it cannot drift from the message collection.
 *
 * `lastMessageAt` (not `updatedAt`) is the sort key, because "most recently
 * active" is what both inboxes are ordered by, and a status change (resolve,
 * reopen) must NOT float a dormant thread to the top of an admin's queue.
 *
 * ── Where does "waiting on whom" live? ───────────────────────────────────
 * `status` is the answer, and it is the ONLY field the UI filters on:
 *   open      → the member is waiting on us
 *   pending   → we are waiting on the member
 *   resolved  → no reply is expected
 * Every message rewrites it (see utils/supportChat.js `statusAfterMessage`),
 * so a thread can never sit in "open" while the admin has already replied.
 *
 * The unread counters are integers rather than a `lastReadBy` timestamp pair
 * because the list query has to sort/filter by them; a `$gt` comparison across
 * two date fields is not indexable, whereas `{ unreadByAdmin: { $gt: 0 } }` is.
 */
const chatThreadSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  subject: { type: String, required: true, trim: true, maxlength: 160 },
  // 'payment' is the one the pricing page's "Talk to support" button
  // preselects, so the commonest case ("where did I pay") needs no typing.
  category: {
    type: String,
    enum: ['payment', 'account', 'technical', 'billing', 'other'],
    default: 'other',
  },
  status: {
    type: String,
    enum: ['open', 'pending', 'resolved'],
    default: 'open',
  },

  // ── Denormalised newest-message summary (see the note above) ──
  lastMessageAt: { type: Date, default: Date.now },
  lastMessagePreview: { type: String, default: '', maxlength: 240 },
  lastMessageBy: { type: String, enum: ['user', 'admin'], default: null },
  messageCount: { type: Number, default: 0, min: 0 },

  unreadByAdmin: { type: Number, default: 0, min: 0 },
  unreadByUser: { type: Number, default: 0, min: 0 },

  // Which admin alias picked it up. Purely informational — it never gates who
  // may read or reply, because two admins must be able to cover for each other.
  assignedTo: { type: String, default: '' },

  resolved: {
    by: { type: String, default: '' },
    at: { type: Date, default: null },
  },
}, { timestamps: true });

// The admin queue: waiting on us first, then most recently active.
chatThreadSchema.index({ status: 1, lastMessageAt: -1 });
// "My conversations" on /support.
chatThreadSchema.index({ user: 1, lastMessageAt: -1 });
// The unread badge. Partial, because resolved threads are never unread and this
// keeps the index proportional to the live queue rather than to all history.
chatThreadSchema.index({ unreadByAdmin: -1, lastMessageAt: -1 });

module.exports = mongoose.model('ChatThread', chatThreadSchema);
