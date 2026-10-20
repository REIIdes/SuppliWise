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

/**
 * What the server put in front of the model for one reply.
 *
 * A separate array from `messages`, in its own shape, because the transcript is what
 * the panel renders and it must stay `{role, text}`. This is the audit trail of the
 * generation: which reference notes were retrieved, which verifier categories the
 * draft needed, which provider answered. It is what makes a thumbs-down mean
 * something — without it, feedback is a feeling with no cause to correlate against,
 * and the ranking loop has nothing to learn from.
 *
 * `i` is the index of the assistant message in `messages`, so a vote on an older
 * reply still resolves to the notes that produced that reply, even after ten more
 * turns.
 */
const aiChatTurnSchema = new mongoose.Schema({
  i: { type: Number, required: true },
  docs: { type: [String], default: [] },
  repairs: { type: [String], default: [] },
  provider: { type: String, trim: true, maxlength: 60, default: '' },
  // A turn whose reply shipped unchanged. Tracked because "the verifier never had to
  // touch this answer" is the state the whole grounding pass is trying to reach, and
  // it is only knowable if it is recorded.
  clean: { type: Boolean, default: true },
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
  archived: { type: Boolean, default: false },
  messages: [aiChatMessageSchema],
  turns: [aiChatTurnSchema],
}, { timestamps: true });

module.exports = mongoose.model('AiChatThread', aiChatThreadSchema);
