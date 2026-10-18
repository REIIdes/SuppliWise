const mongoose = require('mongoose');

/**
 * One AI-suggested medical condition awaiting (or carrying) ratification by a
 * health professional.
 *
 * The condition-gap analysis (scripts/conditionGapAnalysis.js) proposes; it
 * never ships. Suggestions land here as `pending` and only a signed-in admin
 * — the same health-professional panel that rates the instrument — can move a
 * proposal to `approved` or `rejected`, and every such decision is a required
 * non-empty comment appended to the verdicts audit trail. A fabricated verdict
 * is exactly the misconduct this queue exists to make impossible-by-construction:
 * nothing here lets a script mark anything as professionally tested.
 *
 * `alreadyLive` records the honest fact that a human reviewer shipped the
 * option during the 2026-10 audit before this queue existed; the panel can
 * still ratify or retire it, and the chip tells the UI not to imply the
 * registry entry is unvetted.
 */
const conditionProposalSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    // Dedupe key for re-runs of the analysis: two spaces, casing or trailing
    // punctuation must not create a second copy of the same proposal.
    normalizedName: { type: String, required: true, unique: true },
    group: { type: String, trim: true, maxlength: 120, default: '' },
    rationale: { type: String, trim: true, maxlength: 2000, default: '' },
    covers: { type: [String], default: [] },
    supportingCount: { type: Number, min: 0, max: 100000, default: 0 },
    safetyImpact: { type: String, trim: true, maxlength: 500, default: '' },

    source: {
      script: { type: String, trim: true, maxlength: 120, default: 'conditionGapAnalysis' },
      runAt: { type: Date, default: null },
      assessmentsScanned: { type: Number, min: 0, default: 0 },
    },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    alreadyLive: { type: Boolean, default: false },

    // Append-only audit trail. One entry per decision, including any later
    // re-decision by a panel member.
    verdicts: [
      {
        reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminAccount' },
        reviewerAlias: { type: String, trim: true, maxlength: 120, default: '' },
        discipline: { type: String, trim: true, maxlength: 120, default: '' },
        decision: { type: String, enum: ['approve', 'reject'] },
        comment: { type: String, trim: true, maxlength: 2000 },
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

conditionProposalSchema.index({ status: 1, supportingCount: -1 });

function normalizeConditionName(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Record proposals from a ranked analysis run. This is the ONLY write the
 * analysis pipeline makes.
 *
 * Already-decided names are left untouched — a fresh run does not silently
 * undo a professional's ratification — and pending rows get refreshed evidence
 * so the panel always reviews the newest counts. Returns created/refreshed/
 * skipped counts for the script log.
 */
async function upsertProposalsFromRanking(ranked, meta = {}) {
  const out = { created: 0, refreshed: 0, skipped: 0 };
  const { MEDICAL_CONDITIONS } = require('../utils/healthAssessmentInstrument');
  const live = new Set(MEDICAL_CONDITIONS.map(normalizeConditionName));
  const candidates = Array.isArray(ranked && ranked.candidates) ? ranked.candidates : [];
  for (const c of candidates) {
    const name = String((c && c.name) || '').trim().slice(0, 200);
    if (!name) { out.skipped += 1; continue; }
    const normalizedName = normalizeConditionName(name);
    const evidence = {
      group: String((c && c.group) || '').slice(0, 120),
      rationale: String((c && c.rationale) || '').slice(0, 2000),
      covers: Array.isArray(c && c.covers) ? c.covers.map((x) => String(x).slice(0, 200)).slice(0, 20) : [],
      supportingCount: Math.max(0, Math.min(100000, Number(c && c.supportingCount) || 0)),
      safetyImpact: String((c && c.safetyImpact) || '').slice(0, 500),
    };
    const existing = await this.findOne({ normalizedName });
    if (existing && existing.status !== 'pending') { out.skipped += 1; continue; }
    if (existing) {
      await this.updateOne(
        { _id: existing._id },
        { $set: { ...evidence, 'source.script': meta.script || 'conditionGapAnalysis', 'source.runAt': meta.runAt || new Date(), 'source.assessmentsScanned': meta.assessmentsScanned || 0 } }
      );
      out.refreshed += 1;
      continue;
    }
    await this.create({
      name,
      normalizedName,
      ...evidence,
      alreadyLive: live.has(normalizedName),
      source: { script: meta.script || 'conditionGapAnalysis', runAt: meta.runAt || new Date(), assessmentsScanned: meta.assessmentsScanned || 0 },
    });
    out.created += 1;
  }
  return out;
}

conditionProposalSchema.statics.normalizeConditionName = normalizeConditionName;
conditionProposalSchema.statics.upsertFromRanking = upsertProposalsFromRanking;

module.exports = mongoose.model('ConditionProposal', conditionProposalSchema);
