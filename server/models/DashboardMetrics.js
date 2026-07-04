const mongoose = require('mongoose');

const dashboardMetricsSchema = new mongoose.Schema(
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
    // Tracking metrics
    currentStreak: {
      type: Number,
      default: 0,
    },
    longestStreak: {
      type: Number,
      default: 0,
    },
    totalDaysTracked: {
      type: Number,
      default: 0,
    },
    overallAdherence: {
      type: Number,
      default: 0,
    },
    lastTrackedDate: {
      type: String, // YYYY-MM-DD format
    },
    lastCompletedDay: {
      type: String, // YYYY-MM-DD format - last day with 100% completion
    },
    streakAwardedToday: {
      type: Boolean,
      default: false, // Prevents multiple +1 in the same day
    },
    // Wellness score (calculated from adherence, energy, etc.)
    wellnessScore: {
      type: Number,
      default: 0,
    },
    // Energy level self-reported
    energyLevel: {
      type: String,
      enum: ['Low', 'Medium', 'High'],
      default: 'Medium',
    },
    // Assessment lifecycle
    assessmentStartDate: {
      type: Date,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Compound index for efficient queries
dashboardMetricsSchema.index({ user: 1, assessment: 1 });
dashboardMetricsSchema.index({ user: 1, isActive: 1 });

module.exports = mongoose.model('DashboardMetrics', dashboardMetricsSchema);
