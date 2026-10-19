const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { protect, adminOnly } = require('../middleware/auth');
const SurveyResponse = require('../models/SurveyResponse');
const Assessment = require('../models/Assessment');
const { INSTRUMENTS, scoreInstrument } = require('../utils/surveyInstruments');
const { describeInstrument, mean, sampleStandardDeviation } = require('../utils/surveyStats');

/**
 * Evaluation instruments endpoint.
 *
 * GET  /api/survey/instruments  — the standardized questionnaires (items,
 *   scale, provenance) the member-facing feedback screen renders. The client
 *   renders what the SERVER defines, so an instrument revision is one deploy,
 *   not a coordinated app release.
 * POST /api/survey/respond      — one completed instrument; scored and
 *   reverse-flipped server-side and stored.
 * GET  /api/survey/validation   — admin-only reliability report: per
 *   instrument, respondent count, score mean/SD, Cronbach's alpha and
 *   alpha-if-item-deleted. This is the "validated by statisticians" surface:
 *   the numbers a panel needs are computed from live data, not asserted.
 */

router.get('/instruments', protect, (req, res) => {
  res.json({
    instruments: INSTRUMENTS.map(({ items, scale, scoreRange, benchmark, source, title, measures, id }) => ({
      id, title, measures, source, benchmark,
      scale, scoreRange,
      items: items.map(({ id: itemId, text, reverse }) => ({ id: itemId, text, reverse })),
    })),
  });
});

router.post('/respond', protect, async (req, res) => {
  try {
    const { instrument, values, assessmentId } = req.body || {};
    if (typeof instrument !== 'string' || !Array.isArray(values) || values.length > 20) {
      return res.status(400).json({ message: 'Provide an instrument id and an array of answers.' });
    }
    const result = scoreInstrument(instrument, values);
    if (result.error) return res.status(400).json({ message: result.error });

    // The assessment this questionnaire is about is stored so the admin report
    // can tie feedback to a run. It used to be stored verbatim from the body,
    // which let any member attach — and, in a joined report, imply — another
    // member's assessment id. Only accept an id that names THIS account's own
    // assessment; anything else is rejected rather than quietly dropped,
    // because a silently ignored field reads to the client as "saved".
    let linkedAssessmentId = null;
    if (assessmentId !== undefined && assessmentId !== null && assessmentId !== '') {
      if (!mongoose.isValidObjectId(String(assessmentId))) {
        return res.status(400).json({ message: 'That assessment reference is not valid.' });
      }
      const owns = await Assessment.exists({ _id: assessmentId, user: req.user._id });
      if (!owns) return res.status(403).json({ message: 'That assessment is not yours.' });
      linkedAssessmentId = assessmentId;
    }

    const doc = await SurveyResponse.create({
      user: req.user._id,
      instrument: result.instrument.id,
      values,
      reversed: result.reversed,
      score: result.score,
      assessmentId: linkedAssessmentId,
    });
    return res.status(201).json({ ok: true, instrument: doc.instrument, score: doc.score });
  } catch (err) {
    console.error('[survey] respond failed:', err.message);
    return res.status(500).json({ message: 'Could not save the survey response.' });
  }
});

// Cap the matrix the statistics run over; alpha on 5,000 respondents is
// already far past any threshold of interest and an uncapped find on a
// popular deployment is how a dashboard endpoint takes the database down.
const VALIDATION_CAP = 5000;

router.get('/validation', protect, adminOnly, async (req, res) => {
  try {
    const report = [];
    for (const instrument of INSTRUMENTS) {
      const docs = await SurveyResponse.find({ instrument: instrument.id })
        .sort({ createdAt: -1 })
        .limit(VALIDATION_CAP)
        .lean();
      // One observation per participant: alpha treats rows as independent
      // samples, so a member who resubmits (the UI allows correcting an
      // answer before the study closes) must contribute only their LATEST
      // response. The query is newest-first, so first-seen wins.
      const perUser = new Set();
      const respondentsAll = docs;
      const uniqueDocs = respondentsAll.filter((d) => {
        const k = String(d.user ?? d._id);
        if (perUser.has(k)) return false;
        perUser.add(k);
        return true;
      });
      const scores = uniqueDocs.map((d) => d.score).filter((s) => Number.isFinite(s));
      const matrix = uniqueDocs
        .map((d) => (Array.isArray(d.reversed) && d.reversed.length === instrument.items.length ? d.reversed : null))
        .filter(Boolean);
      report.push({
        instrument: instrument.id,
        title: instrument.title,
        measures: instrument.measures,
        source: instrument.source,
        respondents: uniqueDocs.length,
        totalSubmissions: respondentsAll.length,
        scoreMean: Number.isFinite(mean(scores)) ? Math.round(mean(scores) * 10) / 10 : null,
        scoreSd: Number.isFinite(sampleStandardDeviation(scores)) ? Math.round(sampleStandardDeviation(scores) * 10) / 10 : null,
        reliability: matrix.length >= 3 ? describeInstrument(matrix) : { respondents: matrix.length, note: 'Need at least 3 complete responses to compute Cronbach\'s alpha.' },
      });
    }
    return res.json({
      threshold: 'Cronbach alpha >= 0.70 is the accepted research standard for internal consistency.',
      instruments: report,
    });
  } catch (err) {
    console.error('[survey] validation report failed:', err.message);
    return res.status(500).json({ message: 'Could not build the validation report.' });
  }
});

module.exports = router;
