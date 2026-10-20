const mongoose = require('mongoose');

/**
 * ONE MEMBER'S VERDICT ON ONE ANSWER.
 *
 * The learning loop this app already runs learns from assessment rows: it counts
 * which supplements appear for which reported symptoms and publishes what survives
 * an evidence gate. That loop cannot see the thing chat actually produces — whether
 * an answer helped. Without a signal attached to a reply, "the AI adapts" is a claim
 * about a prompt, not about behaviour, and every retrieval ranking decision is made
 * by nobody in particular.
 *
 * What is stored is deliberately narrow. `docIds` are the reference notes the server
 * handed the model for that turn (see AiChatThread.turns — the server records them,
 * so a client cannot name a document it wants promoted), `repairs` are the verifier
 * categories the reply needed, and the vote is up or down. No question text and no
 * answer text is copied here: the transcript already holds both, this collection is
 * a signal index, and a second copy of a member's health prose in a second collection
 * is a second place to leak it.
 *
 * The unique (user, thread, messageIndex) key is what makes a thumb a changeable
 * state rather than an append log. A member who taps down then up must not leave a
 * down-vote in the statistics forever.
 */
const aiChatFeedbackSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  thread: { type: mongoose.Schema.Types.ObjectId, ref: 'AiChatThread', required: true, index: true },
  // Index of the ASSISTANT message this verdict is about, in that thread's `messages`.
  messageIndex: { type: Number, required: true, min: 0 },
  vote: { type: String, enum: ['up', 'down'], required: true },

  // Copied from the turn record at the moment of voting, so the aggregate that
  // builds retrieval priors never has to re-read a transcript.
  docIds: { type: [String], default: [] },
  repairs: { type: [String], default: [] },
  provider: { type: String, trim: true, maxlength: 60, default: '' },
  // True when the member voted on a reply the verifier had to change. That is the
  // most useful row in the collection: an edited answer that was also voted down is
  // a note that is being quoted wrongly, not a member who dislikes the topic.
  wasRepaired: { type: Boolean, default: false },
}, { timestamps: true, versionKey: false });

aiChatFeedbackSchema.index({ user: 1, thread: 1, messageIndex: 1 }, { unique: true });
aiChatFeedbackSchema.index({ createdAt: -1 });

aiChatFeedbackSchema.statics.VOTES = ['up', 'down'];

module.exports = mongoose.model('AiChatFeedback', aiChatFeedbackSchema);
