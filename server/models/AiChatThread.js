const mongoose = require('mongoose');

/**
 * A stored conversation between ONE member and the AI assistant.
 *
 * This is the AI surface (routes/chat.js) — NOT the human support
 * channel (ChatThread). It exists so the floating assistant keeps
 * a history across visits instead of resetting on every open.
 *
 * ── Why messages are embedded ─────────────────────────────
 * A conversation is always read whole (the panel renders the
 * entire transcript) and written append-only, one turn at a
 * time. A separate message collection would turn every open
 * into a join and every send into two writes, with no query
 * to justify either.
 *
 * ── Why the denormalised tail exists ──────────────────────
 * `lastText` / `messageCount` follow ChatThread's
 * `lastMessagePreview` rule: the history menu renders from ONE
 * lightweight query instead of pulling every transcript just to
 * show its last line. Both are rewritten in the same save that
 * appends the turn, so they cannot drift from the messages.
 */
const aiChatMessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  text: { type: String, required: true },
}, { _id: false });

const aiChatThreadSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  title: { type: String, default: 'New conversation', maxlength: 60 },
  lastText: { type: String, default: '' },
  messageCount: { type: Number, default: 0 },
  pinned: { type: Boolean, default: false },
  messages: [aiChatMessageSchema],
}, { timestamps: true });

module.exports = mongoose.model('AiChatThread', aiChatThreadSchema);
