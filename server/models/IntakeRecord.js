const mongoose = require('mongoose');

const intakeRecordSchema = new mongoose.Schema(
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
      required: true,
      index: true,
    },
    supplementName: {
      type: String,
      required: true,
    },
    dosage: {
      type: String,
      required: true,
    },
    priority: {
      type: String,
      enum: ['High', 'Medium', 'Low'],
      default: 'Medium',
    },
    scheduledTime: {
      type: String, // e.g., "Morning", "With Lunch", "Evening"
    },
    taken: {
      type: Boolean,
      default: false,
    },
    takenAt: {
      type: Date,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    // Store the day in YYYY-MM-DD format for easy querying
    dayKey: {
      type: String,
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

// Compound index for efficient queries
intakeRecordSchema.index({ user: 1, assessment: 1, dayKey: 1 });
intakeRecordSchema.index({ user: 1, dayKey: 1 });

module.exports = mongoose.model('IntakeRecord', intakeRecordSchema);
