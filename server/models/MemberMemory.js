const mongoose = require('mongoose');

/**
 * WHAT THIS APP REMEMBERS ABOUT ONE MEMBER.
 *
 * The assistant already knows a member's name, their questionnaire answers and
 * their saved plan for the length of one request, and forgets all of it the moment
 * the next conversation opens. Every "as I asked before", "that thing I mentioned"
 * and "same as last time" therefore has to be re-typed by the member or guessed at
 * by the model — and a guess about a health question is the thing this codebase
 * spends a whole verifier deleting.
 *
 * So this collection holds what the member has shown the app over time. It is
 * deliberately a set of IDS, WEIGHTS AND COUNTS, never a second transcript:
 *
 * - `topics` are ids from the curated alias table (utils/ragRetriever.js ALIASES) —
 *   this app's own vocabulary for "sleep", "energy", "gut". A topic row cannot
 *   contain a member's sentence because the value stored is one of ~19 fixed ids.
 * - `docs` are reference-note ids this app published, with the weight this member's
 *   own votes gave them.
 * - `adherence` and `language` are counts over data the member generated.
 *
 * What is NOT here, by design: message text, reply text, questionnaire answers and
 * plan rows — those reach the prompt live from the assessment itself, in
 * utils/chatIdentity.js and the recommendation context, so a copy here would only
 * add a place for health prose to leak and a staler second version of the truth for
 * the model to contradict. Also absent: anything a clinician or admin wrote about
 * the member, email/phone/DOB/subscription/2FA, and anything from the human support
 * channel (which the server cannot read anyway). See
 * docs/AI_DATA_FLOW_ANALYSIS.md §12.
 *
 * `forgetBefore` is the member's control: clearing memory stamps this moment, and
 * derivation ignores every event older than it — so "forget what you noticed about
 * me" survives the next conversation instead of being rebuilt from the old one.
 *
 * `expiresAt` is a rolling 18-month TTL (Mongo reaps it on its own): a member who
 * stops using the app stops being profiled, without a cron job.
 */

const topicSchema = new mongoose.Schema({
  // An ALIASES id from utils/ragRetriever.js, e.g. 'sleep'. Not free text.
  id: { type: String, required: true, maxlength: 32 },
  // Count of the member's turns on which this topic fired, inside the window.
  hits: { type: Number, default: 0 },
  lastAt: { type: Date, default: null },
}, { _id: false });

const docWeightSchema = new mongoose.Schema({
  docId: { type: String, required: true, maxlength: 120 },
  // Bounded by chatLearning's clamp: [-0.45, 0.6]. Applied as a multiplier on a
  // note that ALREADY matched the question, so no weight can promote an irrelevant
  // note into the answer.
  weight: { type: Number, default: 0 },
  lastAt: { type: Date, default: null },
}, { _id: false });

const memberMemorySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  schemaVersion: { type: Number, default: 1 },

  topics: [topicSchema],
  docs: [docWeightSchema],

  adherence: {
    percent: { type: Number, default: null },
    // The one place a plan item's NAME is kept: "you leave one item untaken often"
    // is not actionable without saying which, and these names are already in the
    // same prompt from the recommendation context.
    leastTaken: [{ type: String, maxlength: 64 }],
    days: { type: Number, default: 0 },
    at: { type: Date, default: null },
  },

  language: { type: String, default: '' },
  turns: { type: Number, default: 0 },

  // When this document last reflected its sources, versus when the sources moved.
  builtAt: { type: Date, default: null },
  // Stamped by the member's clear; older events are ignored on rebuild.
  forgetBefore: { type: Date, default: null },
  lastAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

memberMemorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Rolling retention for a profile row. Shorter than the 5-year record retention. */
memberMemorySchema.statics.RETENTION_MS = 18 * 30 * 24 * 3600 * 1000;

module.exports = mongoose.model('MemberMemory', memberMemorySchema);
