const mongoose = require('mongoose');

/**
 * A medical condition the AI published itself, after the evidence gate found
 * every one of its supplement interventions cited to an authoritative health
 * professional source. No human approval click is involved: publication is
 * governed by clinicalEvidenceStandards, and the verdict trail lives on the
 * matching ConditionProposal row.
 *
 * The bundle mirrors the shapes routes/recommend.js already pushes per
 * condition, so a published condition behaves exactly like a hard-coded one
 * on both the rule engine and the AI paths.
 */
const dynamicConditionSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 200 },
    normalizedLabel: { type: String, required: true, unique: true },
    group: { type: String, trim: true, maxlength: 120, default: 'Other' },
    sexGate: { type: String, enum: ['', 'Male', 'Female'], default: '' },
    rationale: { type: String, trim: true, maxlength: 2000, default: '' },
    symptomPool: { type: [String], default: [] },
    supplements: [{
      name: { type: String, required: true, trim: true, maxlength: 200 },
      reason: { type: String, trim: true, maxlength: 2000, default: '' },
      dosage: { type: String, trim: true, maxlength: 200, default: '' },
      timing: { type: String, trim: true, maxlength: 200, default: '' },
      priority: { type: String, enum: ['High', 'Medium', 'Low'], default: 'Medium' },
      interactions: { type: String, trim: true, maxlength: 300, default: 'Inform your doctor' },
      evidence: { type: String, trim: true, maxlength: 600, default: '' },
      knownApprovedIngredient: { type: Boolean, default: false },
    }],
    warnings: { type: [String], default: [] },
    avoid: { type: [String], default: [] },
    lifestyle: [{
      category: { type: String, trim: true, maxlength: 60, default: 'Diet' },
      advice: { type: String, trim: true, maxlength: 1200, default: '' },
    }],
    status: { type: String, enum: ['live', 'dropped'], default: 'live', index: true },
    source: {
      script: { type: String, trim: true, maxlength: 120, default: 'conditionGapAnalysis' },
      runAt: { type: Date, default: null },
      assessmentsScanned: { type: Number, min: 0, default: 0 },
    },
    annotationReasons: { type: [String], default: [] },
  },
  { timestamps: true }
);

/** Publish (or refresh) gate-accepted bundles. Idempotent by label. */
async function publishAccepted(accepted, meta = {}) {
  let published = 0;
  let refreshed = 0;
  for (const c of accepted) {
    const existing = await this.findOne({ normalizedLabel: c.normalizedLabel });
    const doc = {
      label: c.label,
      normalizedLabel: c.normalizedLabel,
      group: c.group,
      sexGate: c.sexGate,
      rationale: c.rationale,
      symptomPool: c.symptomPool,
      supplements: c.supplements,
      warnings: c.warnings,
      avoid: c.avoid,
      lifestyle: c.lifestyle,
      status: 'live',
      annotationReasons: c.annotationReasons || [],
      source: {
        script: meta.script || 'conditionGapAnalysis',
        runAt: meta.runAt || new Date(),
        assessmentsScanned: meta.assessmentsScanned || 0,
      },
    };
    if (existing) {
      await this.updateOne({ _id: existing._id }, { $set: doc });
      refreshed += 1;
    } else {
      await this.create(doc);
      published += 1;
    }
  }
  return { published, refreshed };
}

dynamicConditionSchema.statics.publishAccepted = publishAccepted;

module.exports = mongoose.model('DynamicCondition', dynamicConditionSchema);
