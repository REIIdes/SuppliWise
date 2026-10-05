const mongoose = require('mongoose');

const supplementDetailSchema = new mongoose.Schema(
  {
    // Normalized lowercase key for fast lookup (e.g. "iron bisglycinate")
    nameKey: { type: String, required: true, unique: true, index: true },
    // Original name as returned by AI
    name: { type: String, required: true },
    // The GENERIC guide, used when the request carries no patient profile.
    detail: { type: mongoose.Schema.Types.Mixed, default: null },

    // Personalized guides, keyed by profile digest: `profileKey -> { detail, updatedAt }`.
    //
    // This field is what makes "tap for details" affordable. A personalised guide
    // is only valid for the profile it was written from, so it cannot share the
    // generic `detail` field — and without somewhere to put it, every tap for a
    // personalised plan pays for a fresh generation, forever.
    //
    // Declared, not merely tolerated: mongoose runs in STRICT mode, and an
    // undeclared path is stripped from the update rather than rejected. Without
    // this line the store's `$set: { 'variants.<digest>': … }` would report
    // success, write nothing, and the feature would keep billing OpenRouter on
    // every tap while every read came back a miss. `Mixed` because the value is
    // a map whose keys are computed digests, and because documents written before
    // the map shape existed still hold an ARRAY here.
    variants: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SupplementDetail', supplementDetailSchema);
