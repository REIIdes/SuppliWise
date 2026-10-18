const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/auth');
const ConditionProposal = require('../models/ConditionProposal');
const { MEDICAL_CONDITIONS } = require('../utils/healthAssessmentInstrument');
const { getLiveConditions } = require('../utils/dynamicConditions');

/**
 * AI learning log — read-only.
 *
 * This collection used to await an admin's approve/reject click. That gate is
 * gone by design: the gap analysis now decides AUTONOMOUSLY through the
 * evidence gate (utils/evidenceGate.js), publishing a condition the moment
 * every one of its supplement suggestions cites an authoritative health-
 * professional source, and rejecting the rest with the missing-proof reason
 * recorded on the same audit trail. The verdicts array on each row therefore
 * says exactly who ratified the candidate — the literature, checked by the
 * gate — and this endpoint exists so the console can show that reasoning.
 *
 * GET /  — every proposal, newest decisions first, with the registry flag and
 *          the published-bundle status (live | dropped).
 */

router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const [docs, liveDynamic] = await Promise.all([
      ConditionProposal.find({}).sort({ supportingCount: -1, updatedAt: -1 }).lean(),
      getLiveConditions(),
    ]);
    const live = new Set([
      ...MEDICAL_CONDITIONS.map(ConditionProposal.normalizeConditionName),
      ...liveDynamic.map((d) => d.normalizedLabel),
    ]);
    const published = new Map(liveDynamic.map((d) => [d.normalizedLabel, d.status]));
    const RANK = { approved: 0, pending: 1, rejected: 2 };
    const proposals = docs.map((d) => ({
      ...d,
      liveNow: live.has(d.normalizedName),
      publishedStatus: published.get(d.normalizedName) || null,
    })).sort((a, b) => RANK[a.status] - RANK[b.status]);
    const counts = { pending: 0, approved: 0, rejected: 0 };
    for (const p of proposals) counts[p.status] += 1;
    return res.json({ counts, proposals, governedBy: 'clinical-evidence-gate (automated)' });
  } catch (err) {
    console.error('[proposals] list failed:', err.message);
    return res.status(500).json({ message: 'Could not load the AI learning log.' });
  }
});

module.exports = router;
