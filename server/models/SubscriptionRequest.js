const mongoose = require('mongoose');

/**
 * A user's REQUEST to buy a plan, with an image of the payment receipt as
 * proof. It is the hand-off point between the pricing page and the admin
 * "Subscription management" queue:
 *
 *   user picks a plan → uploads the receipt → POST /api/subscription/requests
 *                     → admin queue (AdminEvent bell)
 *                     → admin presses Approve
 *                     → subscriptionState 'setPaid' writes the PAID layer
 *
 * The request is a *request*. It never grants anything by itself: the only way a
 * plan becomes active is an admin pressing Approve, which runs the same
 * subscriptionState engine the rest of the admin panel uses. So a user cannot
 * mint access by POSTing here, and an approval cannot bypass the two-layer
 * (paid / override) bookkeeping.
 *
 * MONEY IS NEVER TRUSTED FROM THE CLIENT. `amountPhp` / `amount` /
 * `formattedAmount` are a server-priced snapshot taken from planCatalogue at the
 * moment the request was made (see utils/subscriptionRequests.js), so the queue
 * shows what the plan list charged even if the catalogue changes later — and a
 * tampered body cannot make a ₱1 receipt look like a Premium purchase.
 *
 * Validation, caps and the proof parser live in utils/subscriptionRequests.js —
 * this file is only the shape of the document.
 */
const subscriptionRequestSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // Only the paid tiers are requestable — the Free plan needs no purchase, and
  // allowing 'free' here would fill the queue with rows an admin must clear.
  // A Team request stores the TIER its seats grant (TEAM_PLAN.tier) plus the seat
  // count, so approving one is the same `setPaid` call an individual plan uses.
  plan: { type: String, enum: ['monthly', 'annual', 'custom'], required: true },
  months: { type: Number, default: 1, min: 1, max: 12 },
  // Team is billing metadata on top of a tier, not a tier of its own — the same
  // decision subscriptionState.js makes. isTeam + plan together say everything.
  isTeam: { type: Boolean, default: false },
  seats: { type: Number, default: 1, min: 1, max: 500 },

  // ── Server-priced snapshot of what the plan list charged ──
  currency: { type: String, default: 'PHP' },
  symbol: { type: String, default: '' },
  amountPhp: { type: Number, default: 0, min: 0 },
  amount: { type: Number, default: 0, min: 0 },
  formattedAmount: { type: String, default: '' },
  // Team only: the per-seat unit price, so the queue can show "₱3,495 (₱699 × 5)"
  // and a reviewer can sanity-check the total at a glance.
  perSeatPhp: { type: Number, default: null },
  perSeatFormatted: { type: String, default: null },

  // What the user typed alongside the picture.
  reference: { type: String, default: '', trim: true, maxlength: 80 },
  note: { type: String, default: '', trim: true, maxlength: 500 },

  // ── The proof itself ──
  // A base64 data URL, exactly like the profile/banner pictures, so there is no
  // file host, no filesystem path and no orphan-file cleanup.
  proof: { type: String, required: true },
  proofMime: { type: String, required: true },
  proofBytes: { type: Number, default: 0, min: 0 },

  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },

  // ── The admin decision ──
  review: {
    by: { type: String, default: '' },
    at: { type: Date, default: null },
    note: { type: String, default: '' },
  },

  // What was actually granted, so a later catalogue change cannot make the audit
  // trail lie about the plan the user ended up with.
  grantedPlan: { type: String, default: null },
  grantedDays: { type: Number, default: null },
}, { timestamps: true });

// The admin queue: pending first, newest first.
subscriptionRequestSchema.index({ status: 1, createdAt: -1 });
// "My requests" on the profile billing view.
subscriptionRequestSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('SubscriptionRequest', subscriptionRequestSchema);
