const mongoose = require('mongoose');

/**
 * A user's request to END a paid subscription and drop back to Free.
 *
 * This is the mirror image of SubscriptionRequest. An upgrade request says
 * "activate this plan once someone checks my receipt"; a cancellation request
 * says "take this plan away". Both are hand-offs into the same admin
 * "Subscription management" queue, and both are inert on their own: nothing
 * changes until either the user picks the immediate option or an admin presses
 * Approve.
 *
 * WHY A SEPARATE COLLECTION RATHER THAN A `kind` FLAG ON SubscriptionRequest
 * -------------------------------------------------------------------------
 * The two documents do not share a shape. An upgrade carries money (a
 * server-priced amount), a proof image and a term; a cancellation carries
 * neither, and instead carries a reason and the plan being given up. More
 * importantly they do not share a GRANT: approving an upgrade runs `setPaid`,
 * approving a cancellation runs `remove`. Putting both behind one flag would
 * mean every read, every index and every assertion on the well-tested upgrade
 * path had to start asking "which kind is this?" — a class of bug that is much
 * harder to see than two clearly separated queues. Two collections, one admin
 * tab.
 *
 * THE TWO WAYS OUT
 * ----------------
 *   immediate — the user asks for it to happen NOW. The route applies
 *               `remove` (scope 'all') itself and records a row with
 *               status 'applied', so the action is auditable but needs no admin.
 *   review    — the user asks an administrator to do it. The row sits
 *               'pending' until an admin approves, and only the approval runs
 *               the engine.
 *
 * `mode` records which door the request came through, so the audit trail cannot
 * claim a member waited for review when they did not (or vice versa).
 *
 * Note the asymmetry with a purchase, which is deliberate: cancelling only ever
 * REMOVES access, so the immediate path is safe to allow even where self-serve
 * billing is switched off. Nothing is granted, no money moves, and a scripted
 * client gains nothing by calling it.
 */
const subscriptionCancelRequestSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  // A snapshot of what was being given up, so the queue still reads correctly
  // after the account has been changed or the catalogue has moved on. `plan` is
  // the TIER the member was on.
  plan: { type: String, enum: ['monthly', 'annual', 'custom'], required: true },

  // Which door the member used. 'immediate' rows are already 'applied'.
  mode: { type: String, enum: ['immediate', 'review'], default: 'review', required: true },

  // Why they are leaving. Shown to the reviewer, and to the member if the
  // request is turned down, so it is worth asking for.
  reason: { type: String, default: '', trim: true, maxlength: 500 },

  /**
   * pending  — waiting for an administrator (the only reviewable state)
   * applied  — the subscription is already gone (the immediate path, and an
   *            approved review once the engine has run)
   * rejected — an administrator declined; nothing about the account changed
   */
  status: { type: String, enum: ['pending', 'applied', 'rejected'], default: 'pending' },

  // ── The admin decision ──
  review: {
    by: { type: String, default: '' },
    at: { type: Date, default: null },
    note: { type: String, default: '' },
  },

  // What the account actually ended up on, so a later change cannot make the
  // audit trail lie about what a cancellation did.
  appliedPlan: { type: String, default: null },
  appliedAt: { type: Date, default: null },
}, { timestamps: true });

// The admin queue: pending first, newest first.
subscriptionCancelRequestSchema.index({ status: 1, createdAt: -1 });
// "My cancellations" on the profile billing view.
subscriptionCancelRequestSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('SubscriptionCancelRequest', subscriptionCancelRequestSchema);
