const mongoose = require('mongoose');

/**
 * One submitted questionnaire.
 *
 * The raw item values are stored alongside the computed score on purpose:
 * the score formula can change (it should not need to — SUS is fixed since
 * 1986), and the reliability statistics (Cronbach's alpha) are computed from
 * the ITEM matrix, not from scores. Keeping `reversed` means the validation
 * report can rebuild the alpha for an instrument at any time from the data
 * the product actually collected, which is what "validated by statisticians"
 * requires in practice.
 */
const surveyResponseSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    instrument: { type: String, required: true, index: true }, // sus | efficiency | satisfaction
    // Raw answers in item order, 1..5
    values: [{ type: Number, min: 1, max: 5 }],
    // Same values with reverse-scored items flipped (SUS even items), for alpha
    reversed: [{ type: Number, min: 1, max: 5 }],
    // Instrument score (SUS: 0-100; Likert instruments: 0-100 transform)
    score: { type: Number, required: true },
    // Which plan generation the feedback is about, when known
    assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment', default: null },
  },
  { timestamps: true }
);

surveyResponseSchema.index({ user: 1, instrument: 1, createdAt: -1 });

module.exports = mongoose.model('SurveyResponse', surveyResponseSchema);
