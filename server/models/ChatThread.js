const mongoose = require('mongoose');
const { ENCRYPTION_VERSION } = require('../utils/chatEncryption');

/**
 * One wrapped copy of a conversation's content key, addressed to one party.
 *
 * `_id: false` because a share is a value, not a document: there is no reason
 * to be able to delete or reference one individually, and an ObjectId per share
 * would be 24 bytes of nothing on every encrypted thread.
 */
const chatKeyShareSchema = new mongoose.Schema({
  // `user:<id>` or `admin:<id>` — validated on the way in by
  // utils/chatEncryption.js normalizeKeyShares().
  participant: { type: String, required: true, trim: true, maxlength: 64 },
  // `w1.<ephPub>.<salt>.<iv>.<ct>` — ECIES over P-256. See chatEncryption.js.
  wrapped: { type: String, required: true, maxlength: 1024 },
}, { _id: false });

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
  // Plaintext excerpt, used while the thread is not encrypted. Empty on an
  // encrypted thread — there is nothing here the server is allowed to have read.
  lastMessagePreview: { type: String, default: '', maxlength: 240 },
  // The same excerpt, encrypted. This is what keeps the inbox list a single
  // query: the member and the operator both render the newest message beside
  // every row, and neither of them can have that without decrypting N extra
  // documents on every poll. So the excerpt is sealed in the browser, exactly
  // like the message it came from, and both sides unseal it with the thread's
  // content key before rendering. See utils/chatEncryption.js.
  lastMessagePreviewCipher: { type: String, default: '', maxlength: 8000 },
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

  // ── The reference a human quotes ────────────────────────────────────────
  // `SW-4KQ7M2XB`. See utils/ticketId.js for the format and the reasoning.
  //
  // NO DEFAULT, and that is load-bearing rather than an oversight: the unique
  // index below is SPARSE, and a sparse index only skips documents where the
  // field is genuinely absent. A `default: ''` would write an empty string on
  // every thread created before this field existed — no, rather, it would write
  // '' on every thread that did not supply one — and the second such document
  // would collide with the first on '' and fail the insert. Leaving it unset
  // keeps legacy threads outside the index entirely, and utils/ticketId.js
  // backfills them on read.
  ticketId: { type: String, trim: true, uppercase: true, maxlength: 32 },

  // ── End-to-end encryption state ─────────────────────────────────────────
  // version 0 = plaintext, which is every thread that predates this feature and
  // any thread created while the operator's browser had no usable WebCrypto.
  // version 1 = every message body in this thread is an `e1.…` envelope sealed
  // under `contentKey`, a 32-byte secret that exists only in browsers.
  //
  // `keyShares` is the whole of what the server knows about that key: one
  // ECIES-wrapped copy per party, each readable only by the private half of
  // that party's key pair. The server holds no unwrapped key, cannot unwrap
  // one, and — because it never had the private halves — never could. Full
  // reasoning and the envelope formats are in utils/chatEncryption.js.
  encryption: {
    version: { type: Number, default: 0, min: 0, max: ENCRYPTION_VERSION },
    keyShares: { type: [chatKeyShareSchema], default: [] },
  },
}, { timestamps: true });

// The admin queue: waiting on us first, then most recently active.
chatThreadSchema.index({ status: 1, lastMessageAt: -1 });
// "My conversations" on /support.
chatThreadSchema.index({ user: 1, lastMessageAt: -1 });
// The unread badge. Partial, because resolved threads are never unread and this
// keeps the index proportional to the live queue rather than to all history.
chatThreadSchema.index({ unreadByAdmin: -1, lastMessageAt: -1 });
// The ticket id. Sparse + unique, for the reason spelled out on the field
// above: a thread with no code yet must stay OUT of the index, or it would
// collide with every other code-less thread at once.
chatThreadSchema.index({ ticketId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('ChatThread', chatThreadSchema);
