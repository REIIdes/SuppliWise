const mongoose = require('mongoose');

/**
 * One expert content-validity review of the System Health Assessment.
 *
 * A panelist (clinician, dietitian, statistician — recorded by alias and
 * discipline) rates every registry item on Lawshe's 3-point relevance scale:
 *   1 = not relevant, 2 = relevant but not essential, 3 = essential.
 *
 * The full rating vector is stored per review so the CVR is RECOMPUTABLE at
 * any time from what the panel actually said — the validation report never
 * trusts a cached number. Re-submitting a review replaces the earlier one
 * for that reviewer (latest wins), keeping "one observation per participant"
 * true for the panel too.
 */
const instrumentReviewSchema = new mongoose.Schema(
  {
    instrument: { type: String, required: true, index: true }, // health-assessment-v1
    // The panel signs in as an admin: submittedBy is an AdminAccount id, so
    // it is stored as a bare ObjectId (one trusted key per reviewer) rather
    // than a ref that would mislabel the collection.
    submittedBy: { type: mongoose.Schema.Types.ObjectId, index: true },
    reviewerAlias: { type: String, required: true, trim: true, maxlength: 120 },
    discipline: { type: String, required: true, trim: true, maxlength: 120 }, // clinician | dietitian | statistician | public-health
    // [{ itemId, rating: 1|2|3, comment }]
    ratings: [
      {
        itemId: { type: String, required: true },
        rating: { type: Number, required: true, min: 1, max: 3 },
        comment: { type: String, default: '', trim: true, maxlength: 2000 },
      },
    ],
  },
  { timestamps: true }
);

instrumentReviewSchema.index({ instrument: 1, submittedBy: 1, createdAt: -1 });

module.exports = mongoose.model('InstrumentReview', instrumentReviewSchema);
