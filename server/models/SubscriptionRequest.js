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
  plan: { type: String, enum: ['monthly', 'annual', 'custom'], required: true },
  months: { type: Number, default: 1, min: 1, max: 12 },

  // ── Server-priced snapshot of what the plan list charged ──
  currency: { type: String, default: 'PHP' },
  symbol: { type: String, default: '' },
  amountPhp: { type: Number, default: 0, min: 0 },
  amount: { type: Number, default: 0, min: 0 },
  formattedAmount: { type: String, default: '' },

  // What the user typed alongside the picture.
  reference: { type: String, default: '', trim: true, maxlength: 80 },
  note: { type: String, default: '', trim: true, maxlength: 500 },

  // ── The proof itself ──
  // A base64 data URL, exactly like the profile/banner pictures, so there is no
  // file host, no filesystem path and no orphan-file cleanup.
  //
  // NOT `required`. A deployment with no payment destination configured cannot
  // receive a transfer, so there is no receipt to upload — and making the field
  // mandatory meant the only route to a paid plan was unreachable (see
  // utils/paymentInstructions.receiptRequired). Every record written before
  // this change has a proof, so relaxing the constraint loses nothing.
  //
  // `paymentRequired` records WHY a proof may be missing, and it is stored rather
  // than recomputed on read for the reason the price snapshot above is stored:
  // the deployment can gain a destination tomorrow, and a reviewer looking at a
  // request from yesterday must see the rule that applied when it was made, not
  // the one in force now.
  proof: { type: String, default: '' },
  proofMime: { type: String, default: '' },
  proofBytes: { type: Number, default: 0, min: 0 },
  // True when this request was supposed to carry a receipt (a transfer
  // destination existed). False means the member asked for activation directly
  // because there was nowhere to pay.
  paymentRequired: { type: Boolean, default: true },

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
