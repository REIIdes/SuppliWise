const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Assessment = require('../models/Assessment');
const DashboardMetrics = require('../models/DashboardMetrics');
const IntakeRecord = require('../models/IntakeRecord');
const UserNotification = require('../models/UserNotification');
const AdminEvent = require('../models/AdminEvent');
const { protect } = require('../middleware/auth');
const { sanitizeTextField, sanitizeShortField, scrubKeys } = require('../utils/sanitize');
const { historyLimitFor, tierOf, can, PLAN_LABELS, resolveSubscription } = require('../utils/plan');
// Severity is reached through the flagging layer, which runs the rule engine
// (utils/severity.js) as its authoritative floor and can only escalate on top.
const { analyzePriorityFlagging } = require('../utils/priorityFlagging');
const { expiryDateFromNow, expiryFromCreatedAt } = require('../utils/assessments');
const { guardRaisePriority, selfHealOpenPriority } = require('../utils/priorityGate');

// Flag an assessment as Priority + notify the user and admins (best-effort,
// never fails the surrounding request). Idempotent per assessment.
//
// @returns {Promise<{flagged: boolean, reason?: string}>} `flagged: false` means
//   the guard declined, so callers must NOT report a flag to the client. Both
//   call sites used to mutate their own response object to `priority: 'Priority'`
//   unconditionally, which showed "flagged" in the UI for a write the database
//   never received.
async function flagSevereAssessment(assessment, reasons, userEmail) {
  try {
    // Same rule as the admin endpoint. Severity detection re-runs whenever
    // results are saved, so without this a finished assessment could have its
    // flag re-raised with no admin involved at all — the user had already
    // completed the day's plan, yet found "New Assessments Paused" again.
    const verdict = await guardRaisePriority(assessment.user, assessment._id);
    if (!verdict.ok) {
      await AdminEvent.create({
        type: 'severe-flag',
        title: 'Severe case detected (not flagged)',
        detail: `${userEmail || 'A user'} — ${reasons.join('; ') || 'Severe case detected'}. ` +
          `Not raised to Priority: ${verdict.message}`,
        user: assessment.user,
        assessmentId: assessment._id,
        linkUserId: assessment.user,
      }).catch(() => {});
      return { flagged: false, reason: verdict.code };
    }
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
    return { flagged: true };
  } catch (err) {
    console.error('[severity-flag]', err.message);
    // A genuine failure (DB/network), not a guard decision. Reported as not
    // flagged so the response never claims a write that did not happen.
    return { flagged: false, reason: 'error' };
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
    //
    // The pause is part of the Priority Assessment entitlement and is therefore
    // evaluated against the CURRENT plan on every attempt. Auto-flagging below
    // is gated the same way; without the same check here, a user who was
    // flagged while Premium and then downgraded kept a stale Priority document
    // that locked them out of new assessments forever — a premium restriction
    // they no longer had. The flag itself is kept (history badge, admin view).
    const priorityEntitled = can(req.user, 'priorityAssessment');

    // HEAL BEFORE ASKING. This route used to query for an open review and never
    // run the repair, while GET /priority-status and GET /dashboard both healed
    // first — so a user whose plan was already finished could be told "not
    // blocked" on two screens and then refused with 403 on the one that
    // mattered, with no way to tell which was right.
    if (priorityEntitled) {
      try {
        const healed = await selfHealOpenPriority(req.user._id);
        if (healed.released.length) {
          console.warn(`[assessment POST /] released ${healed.released.length} completed flag(s) for user ${req.user._id}`);
        }
      } catch (healError) {
        // A failed repair must not block a legitimate submit; fall through to
        // the check below, which is the conservative outcome.
        console.error('[assessment POST /] self-heal failed:', healError.message);
      }
    }

    const blockingPriority = priorityEntitled
      ? await Assessment.findOne({ user: req.user._id, priority: 'Priority' })
        .select('_id createdAt flagReasons flaggedAt')
        .lean()
      : null;
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
      // The "Update Health Assessment" flow sends the source assessment id.
      updatedFrom: req.body.updatedFrom || null,
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
    //
    // The rule engine is the authoritative floor; the Anthropic second opinion
    // can only add a flag, never remove one. If the AI is unavailable the rule
    // verdict stands unchanged — a failed call must not silently unflag
    // something the rules caught.
    const severity = await analyzePriorityFlagging(req.body);
    if (severity.aiEscalated) {
      console.log(`[assessment] AI escalated to Priority at ${severity.confidence}% confidence`);
    } else if (severity.aiError) {
      console.log(`[assessment] AI second opinion unavailable, rules only: ${severity.aiError}`);
    }
    let severityFlag = { flagged: false, reasons: [] };
    if (severity.flagged && can(req.user, 'priorityAssessment')) {
      const outcome = await flagSevereAssessment(assessment, severity.reasons, req.user.email);
      if (outcome.flagged) {
        severityFlag = severity;
        // Reflect the flag in this response (the created doc predates the update)
        assessment.priority = 'Priority';
        assessment.flagReasons = severity.reasons.slice(0, 5);
        assessment.flaggedAt = new Date();
        assessment.expiresAt = null;
      } else {
        // Declined (plan already complete, or another review already open) or the
        // write failed. Report it as NOT flagged — announcing a Priority the
        // database does not hold is what made the old behaviour feel broken.
        severityFlag = { flagged: false, reasons: [], suppressed: outcome.reason };
      }
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
    // Same entitlement rule as the POST gate, so the client never shows the
    // "paused" screen to a user the server would not actually pause.
    if (!can(req.user, 'priorityAssessment')) {
      return res.json({ blocked: false, assessments: [] });
    }
    const items = await Assessment.find({ user: req.user._id, priority: 'Priority' })
      .sort({ createdAt: -1 })
      .limit(3)
      .select('createdAt flagReasons flaggedAt')
      .lean();
    // Repair on read. Flags raised before this guard existed — or by a code
    // path that has not been audited — can still sit open on a plan the user
    // has already finished, and nothing else would ever clear them. Releasing
    // here means those users are unblocked on their next page load instead of
    // being stuck permanently. Best-effort by construction: the write is
    // wrapped, so a failure degrades to the previous behaviour.
    let remaining = items;
    try {
      const healed = await selfHealOpenPriority(req.user._id);
      if (healed.released.length > 0) {
        console.warn(`[assessment GET /priority-status] released ${healed.released.length} completed flag(s) for user ${req.user._id}`);
      }
      remaining = await Assessment.find({ user: req.user._id, priority: 'Priority' })
        .sort({ createdAt: -1 })
        .limit(3)
        .select('createdAt flagReasons flaggedAt')
        .lean();
    } catch (healError) {
      console.error('[assessment GET /priority-status] self-heal failed:', healError.message);
    }
    res.json({
      blocked: remaining.length > 0,
      assessments: remaining.map(a => ({
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
    // An OBJECT, and it has to be one. An aggregation `$project` takes a
    // specification document; a space-delimited string is a *find()* projection
    // and Mongo rejects it outright with "$project specification must be an
    // object". That 500 is what made the Recommendations page show "complete a
    // health assessment" to members who already had one — the lightweight fetch
    // it uses to avoid pulling the ~500 KB aiResults blob per assessment was
    // failing, the client swallowed it and rendered its empty state.
    //
    // The consult-doctor fields are here because the page renders that trigger
    // as a banner. It is the one instruction in the plan that must not be
    // skimmable, and a projection that omitted it made the banner permanently
    // unreachable — the code looked correct and never fired.
    //
    // The profile fields are here because the page opens a personalized
    // supplement guide, and the server personalizes that guide from the
    // patient's own age, symptoms, conditions, diet and allergies. Without
    // them the panel silently produced a generic guide while still claiming to
    // be written for this patient. They are small strings and arrays, not the
    // ~500 KB aiResults blob this projection exists to avoid.
    const projection = light
      ? {
          _id: 1,
          createdAt: 1,
          age: 1,
          gender: 1,
          dietType: 1,
          healthGoals: 1,
          symptoms: 1,
          medicalConditions: 1,
          allergies: 1,
          lifestyleHabits: 1,
          pregnancyStatus: 1,
          'aiResults.recommendations': 1,
          'aiResults.consultDoctor': 1,
          'aiResults.consultReason': 1,
        }
      : null;

    // Single aggregation pipeline: fetch paginated results + total count in
    // one round-trip instead of two separate queries (was a bottleneck for
    // users with many assessments).
    const pipeline = [
      { $match: { user: req.user._id } },
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          data: [
            ...(projection ? [{ $project: projection }] : []),
            { $skip: skip },
            { $limit: limit },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await Assessment.aggregate(pipeline);
    const assessments = result.data;
    const total = result.total[0]?.count || 0;

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
// Move the user's intake rows and dashboard metrics from a previous assessment
// onto this (newer) one. Used by the "Update Health Assessment" flow: the new
// assessment becomes the current one, but tracking MUST carry forward — the
// user is continuing their journey, not starting over.
//
// We reassign the OLD rows rather than copying them: a supplement that is still
// recommended keeps its full intake trail, and one that was dropped keeps its
// history readable but is simply absent from the new recommendation list.
//
// Validates both assessments belong to the caller before touching anything.
router.post('/:id/migrate-history', protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid assessment.' });
    }
    const { fromAssessment } = req.body || {};
    if (!fromAssessment || !mongoose.isValidObjectId(fromAssessment)) {
      return res.status(400).json({ message: 'A valid source assessment is required.' });
    }
    if (String(fromAssessment) === String(req.params.id)) {
      return res.json({ migrated: 0, metricsCarriedOver: false });
    }

    const [target, source] = await Promise.all([
      Assessment.findOne({ _id: req.params.id, user: req.user._id }).select('_id').lean(),
      Assessment.findOne({ _id: fromAssessment, user: req.user._id }).select('_id').lean(),
    ]);
    if (!target || !source) {
      return res.status(404).json({ message: 'Assessment not found.' });
    }

    // Re-point all prior intake rows at the new current assessment.
    const intakeResult = await IntakeRecord.updateMany(
      { user: req.user._id, assessment: source._id },
      { $set: { assessment: target._id } },
    );

    // Carry the previous metrics forward onto the new assessment's metrics doc
    // (POST /assessment already created a fresh zeroed one for continuity of the
    // per-assessment streak clock).
    const previous = await DashboardMetrics.findOne({ user: req.user._id, assessment: source._id })
      .sort({ createdAt: -1 })
      .lean();
    let metricsCarriedOver = false;
    if (previous) {
      await DashboardMetrics.updateOne(
        { user: req.user._id, assessment: target._id },
        {
          $set: {
            currentStreak: previous.currentStreak || 0,
            longestStreak: previous.longestStreak || 0,
            totalDaysTracked: previous.totalDaysTracked || 0,
            overallAdherence: previous.overallAdherence || 0,
            energyLevel: previous.energyLevel || 'Medium',
            lastTrackedDate: previous.lastTrackedDate,
            lastCompletedDay: previous.lastCompletedDay,
            streakAwardedToday: previous.streakAwardedToday || false,
          },
        },
      );
      metricsCarriedOver = true;
    }

    return res.json({
      migrated: intakeResult.modifiedCount || 0,
      metricsCarriedOver,
    });
  } catch (error) {
    console.error('[assessment POST /:id/migrate-history]', error.message);
    return res.status(500).json({ message: 'Could not carry your history forward. Please try again.' });
  }
});

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
      const severity = await analyzePriorityFlagging(
        assessment.toObject ? assessment.toObject() : assessment,
        req.body
      );
      if (severity.aiEscalated) {
        console.log(`[assessment] AI escalated re-save to Priority at ${severity.confidence}% confidence`);
      } else if (severity.aiError) {
        console.log(`[assessment] AI second opinion unavailable, rules only: ${severity.aiError}`);
      }
      if (severity.flagged) {
        const outcome = await flagSevereAssessment(assessment, severity.reasons, assessment.userEmail);
        severityFlag = outcome.flagged
          ? severity
          : { flagged: false, reasons: [], suppressed: outcome.reason };
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
    const existing = await Assessment.findById(req.params.id).select('createdAt user priority').lean();
    if (!existing) return res.status(404).json({ message: 'Assessment not found.' });

    // Guard BEFORE writing. This endpoint used to set the flag unconditionally,
    // so an admin could raise Priority on an assessment whose plan was already
    // finished. The user then sat behind "New Assessments Paused" with no exit:
    // the auto-lift in POST /api/dashboard/intake only fires on the next intake
    // post, and someone who had already ticked everything off never posts
    // again. See utils/priorityGate.js.
    if (priority === 'Priority') {
      const verdict = await guardRaisePriority(existing.user, existing._id);
      if (!verdict.ok) {
        return res.status(409).json({
          message: verdict.message,
          code: verdict.code,
          intake: verdict.intake,
          openAssessmentId: verdict.openId || null,
        });
      }
    }

    // Priority suspends expiration; resolving restores the standard 5-year
    // window counted from CREATION — never "5 years from now", which used to
    // push an old record's expiry far into the future.
    //
    // Releasing a record that is ALREADY Standard is a no-op. It used to stamp
    // resolvedAt + "admin-resolved" onto a document nobody had flagged — and
    // because the intake-undo path only re-flags rows whose reason is
    // "intake-complete", that silently disarmed the safety reinstatement for
    // the record. A real admin decision must outrank the automatic reason, so
    // only overwrite it when a flag is genuinely being cleared.
    const wasPriority = existing.priority === 'Priority';
    const update = priority === 'Priority'
      ? { priority, flaggedAt: new Date(), expiresAt: null, resolvedAt: null, resolvedReason: '' }
      : wasPriority
        ? { priority, expiresAt: expiryFromCreatedAt(existing.createdAt), resolvedAt: new Date(), resolvedReason: 'admin-resolved' }
        : { priority };
    const assessment = await Assessment.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true }
    );
    if (!assessment) return res.status(404).json({ message: 'Assessment not found.' });

    // Tell the user, and leave an audit trail.
    //
    // Every other path that moves this flag notifies. A silent override is
    // exactly how a user meets "New Assessments Paused" with no idea an admin
    // acted — or, on release, how the pause vanishes with no explanation.
    // Both are best-effort: the write above already stands, and a broken
    // notification/audit store must not be reported as a failed override.
    const nowRaised = priority === 'Priority';
    const changed = nowRaised ? !wasPriority : wasPriority;
    if (changed) {
      const title = nowRaised
        ? 'Your assessment was paused for priority review'
        : 'Your priority review was released';
      const detail = nowRaised
        ? 'An administrator flagged this assessment for priority review, so new assessments are paused until it is resolved. You can review it at any time.'
        : 'Your priority review was released. You can start a new assessment at any time.';
      await UserNotification.create({
        user: existing.user,
        type: nowRaised ? 'severe-flag' : 'resolved',
        title,
        detail,
        assessmentId: existing._id,
      }).catch((err) => {
        console.error('[assessment PATCH /:id/priority] notification failed:', err.message);
      });
      await AdminEvent.create({
        type: nowRaised ? 'severe-flag' : 'resolved',
        title: nowRaised ? 'Assessment flagged as Priority' : 'Assessment priority released',
        detail: `Assessment ${existing._id} — ${detail}`,
        user: existing.user,
        assessmentId: existing._id,
        linkUserId: existing.user,
      }).catch((err) => {
        console.error('[assessment PATCH /:id/priority] audit failed:', err.message);
      });
    }

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

    // A user must not be able to delete their own OPEN review. DELETE was the
    // way around the entire gate: remove the document and the block goes with
    // it, taking the severe case out of the admin panel and every intake record
    // attached to it, with no audit entry. The flag can only be cleared by an
    // admin releasing it, or by the self-heal on a finished plan.
    if (req.user.role !== 'admin') {
      const open = await Assessment.findOne({ ...filter, priority: 'Priority' }).select('_id').lean();
      if (open) {
        return res.status(409).json({
          message: 'This assessment is open for priority review and cannot be deleted. An administrator must release it first.',
          code: 'priority-open',
        });
      }
    }

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