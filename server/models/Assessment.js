const mongoose = require('mongoose');

const assessmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Step 1 - Basic Information
    age: { type: Number },
    gender: { type: String, enum: ['Male', 'Female'] },
    weight: { type: Number },
    height: { type: Number },
    activityLevel: { type: String },
    // Step 2 - Diet & Health Goals
    dietType: { type: String },
    healthGoals: [{ type: String }],
    // Step 3 - Current Symptoms
    symptoms: [{ type: String }],
    symptomSeverity: { type: mongoose.Schema.Types.Mixed },
    stressLevel: { type: String },
    sleepQuality: { type: String },
    waterIntake: { type: String },
    // Step 4 - Medical Information
    medicalConditions: [{ type: String }],
    currentMedications: { type: String },
    allergies: { type: String },
    feelingDescription: { type: String },
    lifestyleHabits: [{ type: String }],
    pregnancyStatus: { type: String },
    takingSupplements: { type: String },
    currentSupplements: { type: String },
    recentBloodTest: { type: String },
    // AI Results stored with assessment
    aiResults: { type: mongoose.Schema.Types.Mixed },
    // New fields
    sunExposure: { type: String },
    fitnessFocus: { type: String },
    proteinIntake: { type: String },
    bloodTestResults: { type: String },
    recreationalDrugTypes: { type: String },
    // 5 CALENDAR years after creation (shared helper — same math as the UI).
    // The create route sets this explicitly; the default keeps any other insert
    // on the standard retention window instead of "never expires".
    // Priority assessments null this while flagged (never expire while under
    // review) and restore it from createdAt when resolved.
    expiresAt: {
      type: Date,
      default: () => require('../utils/assessments').expiryDateFromNow(),
    },
    // Admin-set priority flag
    priority: { type: String, enum: ['Priority', 'Standard'], default: 'Standard' },
    // Flagging lifecycle (user-visible history of auto-detection + resolution)
    flagReasons: [{ type: String }],
    flaggedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedReason: { type: String, default: '' },

    // ── Where the flag came from ──────────────────────────────────────────
    // `analyzePriorityFlagging` computes, on every assessment submit, whether the
    // AI second opinion ESCALATED a flag the rule engine had not raised — and
    // that answer was then thrown away, so "rules" and "rules+AI" produced
    // IDENTICAL documents. With no provenance there is no way to ever count how
    // often the model was right, so the one question a clinician would ask —
    // "is the second opinion helping, or adding noise to my review queue?" —
    // cannot be answered from any data the system holds. These fields make it
    // answerable (`utils/overviewAnalytics.js` -> `calibrationPipeline`).
    //
    // `null` is the honest default and is preserved rather than backfilled: an
    // assessment flagged before this field existed genuinely has no recorded
    // source, and writing 'rules' onto it would manufacture a measurement.
    //
    // This is RECORDING ONLY. Nothing reads these to move ESCALATION_MIN_
    // CONFIDENCE or any other threshold — a safety gate that silently retunes
    // itself on live clinical data, with no test and no human in the loop, is
    // exactly the failure mode this feature's own header warns about.
    flagSource: {
      type: String,
      enum: ['rules', 'rules+ai', 'admin', null],
      default: null,
    },
    // The confidence the model reported for an AI-ONLY escalation, 0-100.
    // null whenever the rules alone raised the flag.
    flagAiConfidence: { type: Number, default: null, min: 0, max: 100 },
    // When the flag was raised and what the model claimed for it. Kept after
    // resolution on purpose — the calibration figure is about what happened NEXT,
    // so overwriting it at resolution time would erase the question.
    flagAiEscalatedAt: { type: Date, default: null },
    // User info snapshot (for easy identification in DB)
    userEmail: { type: String },
    userName: { type: String },
    // Track if this assessment was updated from a previous one
    updatedFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Assessment',
      default: null,
    },
  },
  { timestamps: true }
);

// Hot paths query newest-first per user — index them (dashboard, insights, assessment routes)
assessmentSchema.index({ user: 1, createdAt: -1 });
// The AI-escalation calibration figure reads `flagSource` on rows that have been
// resolved, so this is its access path. Leading field is `flagSource` because that
// is what it filters on; `flaggedAt` carries the recency bound.
assessmentSchema.index({ flagSource: 1, flaggedAt: -1 });

module.exports = mongoose.model('Assessment', assessmentSchema);
