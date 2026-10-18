const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { protect, adminOnly } = require('../middleware/auth');
const ConditionProposal = require('../models/ConditionProposal');
const { MEDICAL_CONDITIONS } = require('../utils/healthAssessmentInstrument');

/**
 * AI condition-proposal ratification queue.
 *
 * The gap analysis proposes; only a health professional disposes. Health
 * professionals act through their signed-in admin account — the same identity
 * the instrument panel uses — and every decision requires a written comment
 * that is appended to the proposal's verdicts audit trail. There is no route
 * that creates, edits, or auto-approves a proposal: the ONLY way a proposal
 * enters this system is the operator script, and the ONLY way it leaves is a
 * professional's verdict here.
 *
 * GET  /                 — all proposals, pending first, with run evidence
 *   and the live-registry flag, plus status counts for the header chips.
 * POST /:id/decision     — { decision: 'approve'|'reject', comment (required) }
 */

const DISCIPLINES = ['clinician', 'dietitian', 'statistician', 'public-health'];
const liveSet = () => new Set(MEDICAL_CONDITIONS.map(ConditionProposal.normalizeConditionName));

router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const docs = await ConditionProposal.find({})
      .sort({ supportingCount: -1, createdAt: -1 })
      .lean();
    const live = liveSet();
    // Pending first: the queue's whole point is what still awaits a verdict.
    // (A lexical sort on status would put "approved" before "pending".)
    const RANK = { pending: 0, approved: 1, rejected: 2 };
    docs.sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3));
    const proposals = docs.map((d) => ({
      ...d,
      // Recomputed, not stored: the registry may have moved since the import.
      liveNow: live.has(d.normalizedName),
    }));
    const counts = { pending: 0, approved: 0, rejected: 0 };
    for (const p of proposals) counts[p.status] += 1;
    return res.json({ counts, proposals });
  } catch (err) {
    console.error('[proposals] list failed:', err.message);
    return res.status(500).json({ message: 'Could not load the proposal queue.' });
  }
});

router.post('/:id/decision', protect, adminOnly, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(400).json({ message: 'Unknown proposal.' });

    const { decision, comment, discipline } = req.body || {};
    if (decision !== 'approve' && decision !== 'reject')
      return res.status(400).json({ message: 'decision must be "approve" or "reject".' });
    if (typeof comment !== 'string' || !comment.trim())
      return res.status(400).json({ message: 'A written rationale (comment) is required for every verdict.' });
    const cleanDiscipline = typeof discipline === 'string' && DISCIPLINES.includes(discipline.trim())
      ? discipline.trim()
      : '';

    const proposal = await ConditionProposal.findByIdAndUpdate(
      req.params.id,
      {
        $set: { status: decision === 'approve' ? 'approved' : 'rejected' },
        $push: {
          verdicts: {
            reviewer: req.user._id,
            reviewerAlias: String(req.user.alias || '').slice(0, 120),
            discipline: cleanDiscipline,
            decision,
            comment: comment.trim().slice(0, 2000),
            at: new Date(),
          },
        },
      },
      { new: true, lean: true }
    );
    if (!proposal) return res.status(404).json({ message: 'Proposal not found.' });

    return res.json({
      ok: true,
      proposal: { ...proposal, liveNow: liveSet().has(proposal.normalizedName) },
    });
  } catch (err) {
    console.error('[proposals] decision failed:', err.message);
    return res.status(500).json({ message: 'Could not record the decision.' });
  }
});

module.exports = router;
