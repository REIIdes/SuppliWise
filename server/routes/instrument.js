const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/auth');
const Assessment = require('../models/Assessment');
const InstrumentReview = require('../models/InstrumentReview');
const {
  INSTRUMENT_VERSION,
  ITEMS,
  itemById,
} = require('../utils/healthAssessmentInstrument');
const {
  contentValidityReport,
  statisticalValidationReport,
} = require('../utils/instrumentValidation');

/**
 * System Health Assessment instrument endpoints.
 *
 * This is the reviewer-#3 surface for the intake questionnaire itself:
 *
 * GET  /                     — the versioned item registry every question,
 *   its options, its construct and its published provenance. The client and
 *   the panel review what the SERVER defines.
 * GET  /validation           — admin-only validation report: Lawshe CVR /
 *   S-CVI content validity from stored expert reviews, plus statistical
 *   validity (severity-scale Cronbach alpha, endorsement distribution,
 *   per-field completeness) computed from real Assessment rows.
 * POST /review               — admin-only submission of one expert review
 *   (rating vector over the registry items); re-submitting replaces that
 *   reviewer's earlier review.
 *
 * NOTE: adminOnly must always be paired with protect — `adminOnly` alone
 * reads req.user, which only `protect` populates (this exact omission made
 * /api/survey/validation 403 for every admin).
 */

router.get('/', protect, (req, res) => {
  res.json({ instrument: INSTRUMENT_VERSION, items: ITEMS });
});

// Cap the corpus the statistics run over; alpha on 5,000 assessments is far
// past any threshold of interest and an uncapped find is how a dashboard
// endpoint takes the database down.
const VALIDATION_CAP = 5000;

// Fields whose completeness the report measures — the required items.
const COMPLETENESS_FIELDS = ITEMS
  .filter((i) => i.required === true)
  .map((i) => ({
    id: i.id,
    label: i.label,
    extract: (d) => d[i.id],
  }));

router.get('/validation', protect, adminOnly, async (req, res) => {
  try {
    // Latest review per reviewer wins — one panel observation per person.
    const reviewDocs = await InstrumentReview.find({ instrument: INSTRUMENT_VERSION })
      .sort({ createdAt: 1 })
      .lean();
    const latestByReviewer = new Map();
    for (const doc of reviewDocs) {
      const key = String(doc.submittedBy ?? doc._id);
      latestByReviewer.set(key, doc);
    }
    const ratings = [];
    for (const doc of latestByReviewer.values()) {
      for (const r of doc.ratings || []) {
        ratings.push({
          itemId: r.itemId,
          rating: r.rating,
          reviewer: String(doc.submittedBy ?? doc._id),
        });
      }
    }
    const contentValidity = contentValidityReport(
      ratings,
      ITEMS.map((i) => i.id)
    );

    // Real-data statistics. Assessments written before symptom severity
    // existed simply contribute no severity rows; the report says so instead
    // of inventing a number.
    const docs = await Assessment.find({})
      .sort({ createdAt: -1 })
      .limit(VALIDATION_CAP)
      .lean();
    const statistics = statisticalValidationReport(docs, { fields: COMPLETENESS_FIELDS });

    return res.json({
      instrument: INSTRUMENT_VERSION,
      items: ITEMS.length,
      contentValidity: {
        ...contentValidity,
        panelDisciplines: [...new Set(
          [...latestByReviewer.values()].map((d) => d.discipline).filter(Boolean)
        )],
      },
      statistics,
      interpretation: {
        cvr: 'An item is content-valid when its CVR meets 1.645/sqrt(panel size) (Lawshe 1975).',
        alpha: 'The severity subscale is internally consistent when alpha >= 0.70.',
      },
    });
  } catch (err) {
    console.error('[instrument] validation report failed:', err.message);
    return res.status(500).json({ message: 'Could not build the instrument validation report.' });
  }
});

router.post('/review', protect, adminOnly, async (req, res) => {
  try {
    const { reviewerAlias, discipline, ratings } = req.body || {};
    if (typeof reviewerAlias !== 'string' || !reviewerAlias.trim())
      return res.status(400).json({ message: 'reviewerAlias is required.' });
    if (typeof discipline !== 'string' || !discipline.trim())
      return res.status(400).json({ message: 'discipline is required (e.g. clinician, dietitian, statistician).' });
    if (!Array.isArray(ratings) || ratings.length === 0)
      return res.status(400).json({ message: 'Provide a ratings array.' });
    if (ratings.length > ITEMS.length * 3)
      return res.status(400).json({ message: 'Too many ratings for this instrument.' });

    const normalized = [];
    for (const r of ratings) {
      const item = r && typeof r === 'object' ? itemById(String(r.itemId)) : null;
      if (!item)
        return res.status(400).json({ message: `Unknown item id: ${r && r.itemId}` });
      const rating = Number(r.rating);
      if (![1, 2, 3].includes(rating))
        return res.status(400).json({ message: `Rating for ${item.id} must be 1, 2 or 3.` });
      normalized.push({
        itemId: item.id,
        rating,
        comment: typeof r.comment === 'string' ? r.comment.slice(0, 2000) : '',
      });
    }

    // Replace semantics: a reviewer editing their panel submission replaces
    // their previous review rather than double-counting in the CVR.
    await InstrumentReview.deleteMany({
      instrument: INSTRUMENT_VERSION,
      submittedBy: req.user._id,
    });

    const doc = await InstrumentReview.create({
      instrument: INSTRUMENT_VERSION,
      submittedBy: req.user._id,
      reviewerAlias: reviewerAlias.trim().slice(0, 120),
      discipline: discipline.trim().slice(0, 120),
      ratings: normalized,
    });

    const reviewed = new Set(normalized.map((r) => r.itemId));
    return res.status(201).json({
      ok: true,
      id: doc._id,
      ratedItems: reviewed.size,
      unratedItems: ITEMS.length - reviewed.size,
    });
  } catch (err) {
    console.error('[instrument] review submission failed:', err.message);
    return res.status(500).json({ message: 'Could not save the instrument review.' });
  }
});

module.exports = router;
