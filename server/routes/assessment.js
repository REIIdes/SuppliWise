const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Assessment = require('../models/Assessment');
const DashboardMetrics = require('../models/DashboardMetrics');
const UserNotification = require('../models/UserNotification');
const AdminEvent = require('../models/AdminEvent');
const { protect } = require('../middleware/auth');
const { sanitizeTextField, sanitizeShortField, scrubKeys } = require('../utils/sanitize');
const { historyLimitFor, tierOf, can, PLAN_LABELS, resolveSubscription } = require('../utils/plan');
const { analyzeSeverity } = require('../utils/severity');
const { expiryDateFromNow, expiryFromCreatedAt } = require('../utils/assessments');

// Flag an assessment as Priority + notify the user and admins (best-effort,
// never fails the surrounding request). Idempotent per assessment.
async function flagSevereAssessment(assessment, reasons, userEmail) {
  try {
    const label = reasons.length > 0 ? reasons.join('; ') : 'Severe case detected';
    await Assessment.findByIdAndUpdate(assessment._id, {
      // Priority assessments never expire while flagged (expiresAt: null)
      $set: { priority: 'Priority', flagReasons: reasons.slice(0, 5), flaggedAt: new Date(), expiresAt: null, resolvedAt: null, resolvedReason: '' },
    });
    await UserNotification.create({
      user: assessment.user,
      type: 'severe-flag',
      title: 'Health review flagged for your assessment',
      detail: `Our review flagged possible severe concerns (${label}). An administrator has been notified. If you feel unwell, please seek medical care promptly.`,
      assessmentId: assessment._id,
    });
    await AdminEvent.create({
      type: 'severe-flag',
      title: 'Severe case flagged',
      detail: `${userEmail || 'A user'} — ${label}`,
      user: assessment.user,
      assessmentId: assessment._id,
      linkUserId: assessment.user,
    }).catch(() => {});
  } catch (err) {
    console.error('[severity-flag]', err.message);
  }
}

// @route   POST /api/assessment
// @desc    Save a completed health assessment
// @access  Private
router.post('/', protect, async (req, res) => {
  try {
    console.log('Assessment save request from user:', req.user?._id);
    const {
      age, gender, weight, height, activityLevel,
      dietType, healthGoals,
      symptoms, symptomSeverity, stressLevel, sleepQuality, waterIntake,
      medicalConditions, currentMedications, allergies,
      lifestyleHabits, pregnancyStatus,
      takingSupplements, currentSupplements, recentBloodTest,
      recreationalDrugTypes,
    } = req.body;

    // Validate numeric fields — numbers or numeric strings only. Anything
    // else (arrays, objects, "not-a-number") slipped past the old range
    // comparisons and died in Mongoose as a CastError → 500.
    const finite = (v) => v === undefined || v === null || v === '' || Number.isFinite(Number(v));
    if (!finite(age) || !finite(weight) || !finite(height)) {
      return res.status(400).json({ message: 'Age, weight, and height must be valid numbers.' });
    }
    if (age && (age < 1 || age > 120)) return res.status(400).json({ message: 'Age must be between 1 and 120.' });
    if (weight && (weight < 1 || weight > 500)) return res.status(400).json({ message: 'Weight must be between 1 and 500 kg.' });
    if (height && (height < 30 || height > 300)) return res.status(400).json({ message: 'Height must be between 30 and 300 cm.' });

    // Validate string field lengths
    const TEXT_MAX = 1000;
    const SHORT_MAX = 200;
    if (currentMedications && currentMedications.length > TEXT_MAX)
      return res.status(400).json({ message: `Current medications must be ${TEXT_MAX} characters or fewer.` });
    if (allergies && allergies.length > SHORT_MAX)
      return res.status(400).json({ message: `Allergies must be ${SHORT_MAX} characters or fewer.` });
    if (req.body.bloodTestResults && req.body.bloodTestResults.length > TEXT_MAX)
      return res.status(400).json({ message: `Blood test results must be ${TEXT_MAX} characters or fewer.` });
    if (currentSupplements && currentSupplements.length > SHORT_MAX)
      return res.status(400).json({ message: `Current supplements must be ${SHORT_MAX} characters or fewer.` });

    // ── Sanitize short fields (rule-based) ───────────────────────────────
    const medsResult      = sanitizeShortField(currentMedications);
    const allergiesResult = sanitizeShortField(allergies);
    const suppsResult     = sanitizeShortField(currentSupplements);
    const bloodResult     = sanitizeTextField(req.body.bloodTestResults);

    // ── Sanitize fields (rule-based) ─────────────────────────────────────
    const garbageFields = [];
    if (medsResult.garbage)      garbageFields.push({ field: 'currentMedications',  label: 'Current Medications',  value: currentMedications });
    if (allergiesResult.garbage) garbageFields.push({ field: 'allergies',            label: 'Allergies',            value: allergies });
    if (suppsResult.garbage)     garbageFields.push({ field: 'currentSupplements',   label: 'Current Supplements',  value: currentSupplements });
    if (bloodResult.garbage)     garbageFields.push({ field: 'bloodTestResults',     label: 'Blood Test Results',   value: req.body.bloodTestResults });

    // ── Priority gate: while a Priority assessment is unresolved the user
    // must finish it first (admin resolves via Standard, or it is deleted).
    // This keeps severe cases from being buried under newer assessments.
    const blockingPriority = await Assessment.findOne({ user: req.user._id, priority: 'Priority' })
      .select('_id createdAt flagReasons flaggedAt')
      .lean();
    if (blockingPriority) {
      return res.status(403).json({
        message: 'You have a prioritized assessment that needs to finish first. Please complete its review before starting a new assessment.',
        priorityAssessment: {
          id: blockingPriority._id,
          createdAt: blockingPriority.createdAt,
          reasons: blockingPriority.flagReasons || [],
        },
      });
    }

    const assessment = await Assessment.create({
      user: req.user._id,
      userEmail: req.user.email,
      userName: req.user.name,
      age, gender, weight, height, activityLevel,
      dietType, healthGoals,
      symptoms, symptomSeverity, stressLevel, sleepQuality, waterIntake,
      medicalConditions,
      currentMedications: medsResult.value,
      allergies: allergiesResult.value,
      lifestyleHabits, pregnancyStatus,
      takingSupplements,
      currentSupplements: suppsResult.value,
      recentBloodTest,
      bloodTestResults: bloodResult.value,
      sunExposure: req.body.sunExposure,
      fitnessFocus: req.body.fitnessFocus,
      proteinIntake: req.body.proteinIntake,
      recreationalDrugTypes: recreationalDrugTypes || '',
      // 5 calendar years from creation — same helper the rest of the retention
      // logic uses, so the stored date and the "Expires …" badge always match.
      expiresAt: expiryDateFromNow(),
    });

    console.log('Assessment saved to DB, id:', assessment._id);

    // Auto-flag severe cases (Priority + user/admin notifications, best-effort).
    // Priority Assessment is a PREMIUM+ entitlement: lower tiers save
    // as Standard with no flag, no notifications, and no new-assessment block.
    // (A manual admin Priority flag still applies to any tier.)
    const severity = analyzeSeverity(req.body);
    let severityFlag = { flagged: false, reasons: [] };
    if (severity.flagged && can(req.user, 'priorityAssessment')) {
      severityFlag = severity;
      await flagSevereAssessment(assessment, severity.reasons, req.user.email);
      // Reflect the flag in this response (the created doc predates the update)
      assessment.priority = 'Priority';
      assessment.flagReasons = severity.reasons.slice(0, 5);
      assessment.flaggedAt = new Date();
      assessment.expiresAt = null;
    }
    
    // Deactivate all previous dashboard metrics
    await DashboardMetrics.updateMany(
      { user: req.user._id, isActive: true },
      { isActive: false }
    );
    
    // Create new dashboard metrics for this assessment
    await DashboardMetrics.create({
      user: req.user._id,
      assessment: assessment._id,
      assessmentStartDate: new Date(),
      isActive: true,
      currentStreak: 0,
      overallAdherence: 0,
      wellnessScore: 0,
    });
    
    console.log('Dashboard metrics reset for new assessment');
    res.status(201).json({ message: 'Assessment saved', assessment, garbageFields, severityFlag });
  } catch (error) {
    console.error('[assessment POST]', error.message);
    res.status(500).json({ message: 'Could not save your assessment. Please try again.' });
  }
});

// @route   GET /api/assessment/priority-status
// @desc    Whether the user is blocked from new assessments + the blocking items
// @access  Private
router.get('/priority-status', protect, async (req, res) => {
  try {
    const items = await Assessment.find({ user: req.user._id, priority: 'Priority' })
      .sort({ createdAt: -1 })
      .limit(3)
      .select('createdAt flagReasons flaggedAt')
      .lean();
    res.json({
      blocked: items.length > 0,
      assessments: items.map(a => ({
        id: a._id,
        createdAt: a.createdAt,
        flaggedAt: a.flaggedAt,
        reasons: a.flagReasons || [],
      })),
    });
  } catch (error) {
    console.error('[assessment GET /priority-status]', error.message);
    res.status(500).json({ message: 'Could not check priority status.' });
  }
});

// @route   GET /api/assessment/history
// @desc    Get all assessments for the current user (newest first, paginated)
// @access  Private (page size capped by subscription tier:
//          FREE = 5, DELUXE = 10, PREMIUM/ULTIMATE = 20 — paging beyond the
//          first page is a PREMIUM+ entitlement: "5-Year Record History")
router.get('/history', protect, async (req, res) => {
  try {
    const planLimit = historyLimitFor(req.user);
    // Page is clamped to a finite window: an unbounded value produced a
    // skip far beyond Number.MAX_SAFE_INTEGER (imprecise, and a cheap way to
    // make the database grind). Anything past this window is simply the last
    // reachable page — pagination metadata still tells the client the truth.
    const page = Math.min(1000000, Math.max(1, parseInt(req.query.page, 10) || 1));
    // 5-Year Record History (PREMIUM+): lower tiers get one tier-capped page
    // and a structured 403 for anything deeper — enforced here, not in the UI.
    if (page > 1 && !can(req.user, 'historyFull')) {
      return res.status(403).json({
        message: `Full record history requires the ${PLAN_LABELS.annual} plan. Please upgrade to continue.`,
        feature: 'historyFull',
        requiresPlan: 'annual',
        currentPlan: tierOf(req.user),
        subscriptionStatus: resolveSubscription(req.user).status,
        allowed: false,
      });
    }
    const requested = Math.max(1, parseInt(req.query.limit, 10) || 10);
    const limit = Math.min(requested, planLimit, 20);
    const skip  = (page - 1) * limit;
    // Lightweight mode for the recommendations page — only the fields it reads,
    // instead of the full ~500 KB aiResults blob per assessment.
    const light = req.query.fields === 'recommendations';
    const projection = light ? 'aiResults.recommendations createdAt' : null;

    const historyQuery = Assessment.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      // Lean: skip Mongoose hydration (aiResults docs can be ~500 KB)
      .lean();
    if (projection) historyQuery.select(projection);

    const [assessments, total] = await Promise.all([
      historyQuery,
      Assessment.countDocuments({ user: req.user._id }),
    ]);

    res.json({
      serverTime: new Date().toISOString(),
      assessments,
      planLimit,
      currentPlan: tierOf(req.user),
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        hasMore: skip + assessments.length < total,
      },
    });
  } catch (error) {
    console.error('[assessment GET /history]', error.message);
    res.status(500).json({ message: 'Could not load your history. Please try again.' });
  }
});

// @route   GET /api/assessment/me
// @desc    Get the current user's latest assessment
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    const assessment = await Assessment.findOne({ user: req.user._id }).sort({ createdAt: -1 });
    if (!assessment) return res.status(404).json({ message: 'No assessment found.' });
    res.json(assessment);
  } catch (error) {
    console.error('[assessment GET /me]', error.message);
    res.status(500).json({ message: 'Could not load your assessment. Please try again.' });
  }
});

// @route   GET /api/assessment/user/:userId
// @desc    Get all assessments for a specific user — admin only
// @access  Private (Admin)
router.get('/user/:userId', protect, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  if (!mongoose.isValidObjectId(req.params.userId)) {
    return res.status(400).json({ message: 'Invalid user account.' });
  }
  try {
    const assessments = await Assessment.find({ user: req.params.userId }).sort({ createdAt: -1 });
    res.json(assessments);
  } catch (error) {
    console.error('[assessment GET /user/:userId]', error.message);
    res.status(500).json({ message: 'Could not load assessments. Please try again.' });
  }
});

// @route   GET /api/assessment/results/:assessmentId
// @desc    Get AI results for a specific assessment — admin only
// @access  Private (Admin)
router.get('/results/:assessmentId', protect, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  if (!mongoose.isValidObjectId(req.params.assessmentId)) {
    return res.status(400).json({ message: 'Invalid assessment.' });
  }
  try {
    const assessment = await Assessment.findById(req.params.assessmentId);
    if (!assessment) return res.status(404).json({ message: 'Assessment not found.' });
    res.json(assessment.aiResults);
  } catch (error) {
    console.error('[assessment GET /results/:assessmentId]', error.message);
    res.status(500).json({ message: 'Could not load assessment results. Please try again.' });
  }
});

// @route   PATCH /api/assessment/:id/results
// @desc    Store AI results on an existing assessment
// @access  Private
const MAX_AI_RESULTS_BYTES = 500 * 1024; // 500 KB — prevents DB bloat from oversized payloads
router.patch('/:id/results', protect, async (req, res) => {
  // Malformed ids reach Mongoose as a CastError and surfaced as a 500.
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: 'Invalid assessment.' });
  }
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'Invalid results payload.' });
    }
    // Strip prototype-pollution keys before persisting the Mixed blob
    scrubKeys(req.body);
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(req.body), 'utf8');
    } catch {
      return res.status(400).json({ message: 'Invalid results payload.' });
    }
    if (size > MAX_AI_RESULTS_BYTES) {
      return res.status(413).json({ message: 'Results payload is too large.' });
    }
    const assessment = await Assessment.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { aiResults: req.body },
      { new: true }
    );
    if (!assessment) return res.status(404).json({ message: 'Assessment not found.' });
    // Re-run severe-case detection now that AI results exist (warnings scan).
    // Only flags when the assessment isn't already Priority (idempotent) and
    // the owner holds PREMIUM+ (Priority Assessment is tier-gated).
    let severityFlag = { flagged: false, reasons: [] };
    if (assessment.priority !== 'Priority' && can(req.user, 'priorityAssessment')) {
      const severity = analyzeSeverity(
        assessment.toObject ? assessment.toObject() : assessment,
        req.body
      );
      if (severity.flagged) {
        severityFlag = severity;
        await flagSevereAssessment(assessment, severity.reasons, assessment.userEmail);
      }
    }
    res.json({ message: 'Results saved', assessment, severityFlag });
  } catch (error) {
    console.error('[assessment PATCH /:id/results]', error.message);
    res.status(500).json({ message: 'Could not save results. Please try again.' });
  }
});

// @route   PATCH /api/assessment/:id/priority
// @desc    Set assessment priority — admin only
// @access  Private (Admin)
router.patch('/:id/priority', protect, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  const { priority } = req.body;
  if (!['Priority', 'Standard'].includes(priority)) {
    return res.status(400).json({ message: 'Priority must be "Priority" or "Standard".' });
  }
  // Malformed ids reach Mongoose as a CastError and surfaced as a 500.
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: 'Invalid assessment.' });
  }
  try {
    const existing = await Assessment.findById(req.params.id).select('createdAt').lean();
    if (!existing) return res.status(404).json({ message: 'Assessment not found.' });
    // Priority suspends expiration; resolving restores the standard 5-year
    // window counted from CREATION — never "5 years from now", which used to
    // push an old record's expiry far into the future.
    const update = priority === 'Priority'
      ? { priority, flaggedAt: new Date(), expiresAt: null, resolvedAt: null, resolvedReason: '' }
      : { priority, expiresAt: expiryFromCreatedAt(existing.createdAt), resolvedAt: new Date(), resolvedReason: 'admin-resolved' };
    const assessment = await Assessment.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true }
    );
    if (!assessment) return res.status(404).json({ message: 'Assessment not found.' });
    res.json({ message: `Assessment set to ${priority}.`, assessment });
  } catch (error) {
    console.error('[assessment PATCH /:id/priority]', error.message);
    res.status(500).json({ message: 'Could not update priority. Please try again.' });
  }
});

// @route   DELETE /api/assessment/:id
// @desc    Delete an assessment — owner or admin
// @access  Private
router.delete('/:id', protect, async (req, res) => {
  // Malformed ids reach Mongoose as a CastError and surfaced as a 500.
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: 'Invalid assessment.' });
  }
  try {
    // Admins can delete any assessment; regular users can only delete their own
    const filter = req.user.role === 'admin'
      ? { _id: req.params.id }
      : { _id: req.params.id, user: req.user._id };

    const assessment = await Assessment.findOneAndDelete(filter);
    if (!assessment) return res.status(404).json({ message: 'Assessment not found.' });
    // Clean up orphaned tracking data (intake records + metrics reference the assessment)
    try {
      const IntakeRecord = require('../models/IntakeRecord');
      const DashboardMetrics = require('../models/DashboardMetrics');
      await Promise.all([
        IntakeRecord.deleteMany({ assessment: assessment._id }),
        DashboardMetrics.deleteMany({ assessment: assessment._id }),
      ]);
    } catch (cleanupError) {
      console.error('[assessment DELETE /:id] orphan cleanup failed:', cleanupError.message);
    }
    res.json({ message: 'Assessment deleted.' });
  } catch (error) {
    console.error('[assessment DELETE /:id]', error.message);
    res.status(500).json({ message: 'Could not delete the assessment. Please try again.' });
  }
});

module.exports = router;