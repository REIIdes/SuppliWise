const mongoose = require('mongoose');

const medicalReviewAuditSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    assessment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Assessment',
      default: null,
    },
    decision: {
      type: String,
      enum: ['approved', 'needs_more_info'],
      required: true,
    },
    notes: {
      type: String,
      default: '',
    },
    resolvedBy: {
      type: String,
      required: true,
    },
    resolvedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

// Index for querying audit history
medicalReviewAuditSchema.index({ user: 1, resolvedAt: -1 });
medicalReviewAuditSchema.index({ resolvedAt: -1 });

module.exports = mongoose.model('MedicalReviewAudit', medicalReviewAuditSchema);
