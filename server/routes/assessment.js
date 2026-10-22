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
// Severity is reached through the flagging layer, which runs the rule engine
// (utils/severity.js) as its authoritative floor and can only escalate on top.
const { analyzePriorityFlagging } = require('../utils/priorityFlagging');
const { expiryDateFromNow, expiryFromCreatedAt, notExpiredFilter } = require('../utils/assessments');
const { guardRaisePriority, selfHealOpenPriority } = require('../utils/priorityGate');
// Chain proofs for the events this route actually produces. Anchoring is an
// enhancement, never a dependency: the helpers return `anchored: false` instead
// of throwing, so a member can always save their assessment even when the
// ledger is refusing blocks.
const {
  web3Enabled,
  anchorHealthLedger,
  anchorPlanEvents,
} = require('../blockchain/proofs');
// The plan day and the supplement-name rule the history migration shares with
// the tracker, so a dose moved across assessments is matched by the same key the
// day's rows are written and read with. See utils/todayPlanSync.js.
const { cleanTimeZone, planDayKey } = require('../utils/planDay');
const { normalizeName } = require('../utils/dailyScheduleSlots');

// Flag an assessment as Priority + notify the user and admins (best-effort,
// never fails the surrounding request). Idempotent per assessment.
//
// @returns {Promise<{flagged: boolean, reason?: string}>} `flagged: false` means
//   the guard declined, so callers must NOT report a flag to the client. Both
//   call sites used to mutate their own response object to `priority: 'Priority'`
//   unconditionally, which showed "flagged" in the UI for a write the database
//   never received.
async function flagSevereAssessment(assessment, reasons, userEmail, triageVerdict = null) {
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
        // An AdminEvent with no link does not surface in the admin console at
        // all -- link is how the bell resolves an event to the tab that can act
        // on it.
        //
        // No member identifier in detail. The assessment row the link opens
        // already carries one and is authorised to; the bell's job is only to say
        // that severity was detected and the guard declined. See
        // utils/memberPrivacy.js for why that rule exists.
        link: 'assessment-management',
        linkLabel: 'Open Assessment Management',
      }).catch(() => {});
      return { flagged: false, reason: verdict.code };
    }
    const label = reasons.length > 0 ? reasons.join('; ') : 'Severe case detected';

    // Record WHERE this flag came from, not merely that it was raised.
    //
    // The triage verdict already knows: `aiEscalated` is true only when the rule
    // engine found nothing and the model's own escalation cleared the confidence
    // bar. Persisting it is the only thing that lets this layer ever be measured
    // -- see the `flagSource` block on the schema. Without it a rules flag and a
    // rules+AI flag are byte-identical documents, and "is the second opinion
    // catching real misses, or just adding noise to the review queue?" cannot be
    // answered from any data this system holds.
    const aiEscalated = Boolean(triageVerdict && triageVerdict.aiEscalated === true);
    const rawConfidence = Number(triageVerdict && triageVerdict.confidence);
    const aiConfidence = aiEscalated && Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(100, Math.round(rawConfidence)))
      : null;
    const raisedAt = new Date();

    await Assessment.findByIdAndUpdate(assessment._id, {
      // Priority assessments never expire while flagged (expiresAt: null)
      $set: {
        priority: 'Priority',
        flagReasons: reasons.slice(0, 5),
        flaggedAt: raisedAt,
        expiresAt: null,
        resolvedAt: null,
        resolvedReason: '',
        // 'rules' only when the rules genuinely were the whole story. A missing
        // verdict (a caller that predates this wiring) is recorded as null rather
        // than guessed at, so an UNKNOWN provenance is never counted as a rules
        // decision in the calibration figure.
        flagSource: triageVerdict ? (aiEscalated ? 'rules+ai' : 'rules') : null,
        flagAiConfidence: aiConfidence,
        flagAiEscalatedAt: aiEscalated ? raisedAt : null,
      },
    });
    await UserNotification.create({
      user: assessment.user,
      type: 'severe-flag',
      title: 'Health review flagged for your assessment',
      detail: `Our review flagged possible severe concerns (${label}). An administrator has been notified. If you feel unwell, please seek medical care promptly.`,
      assessmentId: assessment._id,
      // The member is told their assessments are PAUSED, so the bell has to take
      // them somewhere that shows them the pause. A stored link is always right:
      // only this writer knows the assessmentId, and the route table is a
      // title-matching fallback for writers that do not set one.
      link: '/history',
      linkLabel: 'View the flagged assessment',
    });
    await AdminEvent.create({
      type: 'severe-flag',
      title: 'Severe case flagged',
      detail: label,
      user: assessment.user,
      assessmentId: assessment._id,
      linkUserId: assessment.user,
      // `link` is how the bell resolves this to the tab that can act on it,
      // and without it the event never appears in the admin console at all. The
      // identity is on the assessment row the link opens — already authorised
      // there — so copying it into a bell payload is pure exposure. See
      // utils/memberPrivacy.js.
      link: 'assessment-management',
      linkLabel: 'Open Assessment Management',
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

    // Identity fields are REQUIRED to save. An empty body used to persist as a
    // 201 "assessment" with no numbers at all — NaN BMI downstream and a plan
    // the engine cannot anchor. The client always sends these four.
    const missing = (v) => v === undefined || v === null || v === '';
    if (missing(age) || missing(gender) || missing(weight) || missing(height)) {
      return res.status(400).json({ message: 'Age, gender, weight, and height are required.' });
    }
    if (!['Male', 'Female'].includes(gender)) {
      return res.status(400).json({ message: 'Gender must be Male or Female.' });
    }

    // Multi-select fields must be arrays of short strings. The [String] schema
    // silently CASTS a bare string ("nope" → ["nope"]) — garbage that then
    // flows into the rule engine and mergeSelectedBundles — while objects or
    // numbers inside the array throw a CastError → 500. Validate explicitly.
    const strArrayOk = (v) => v === undefined || v === null ||
      (Array.isArray(v) && v.length <= 100 && v.every((x) => typeof x === 'string' && x.length <= 200));
    for (const [field, value] of Object.entries({ healthGoals, symptoms, medicalConditions, lifestyleHabits })) {
      if (!strArrayOk(value)) {
        return res.status(400).json({ message: `${field} must be an array of short strings.` });
      }
    }
    // Plain text fields: an object/array/number reaches Mongoose castString
    // and throws — reject at the boundary instead.
    const textFields = {
      activityLevel, dietType, stressLevel, sleepQuality, waterIntake,
      pregnancyStatus, takingSupplements, recentBloodTest,
      sunExposure: req.body.sunExposure, fitnessFocus: req.body.fitnessFocus,
      proteinIntake: req.body.proteinIntake, recreationalDrugTypes,
      currentMedications, allergies, currentSupplements: req.body.currentSupplements,
      bloodTestResults: req.body.bloodTestResults,
    };
    for (const [field, value] of Object.entries(textFields)) {
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return res.status(400).json({ message: `${field} must be text.` });
      }
    }
    // Mixed accepts anything, but the severity scorer reads it as a map —
    // arrays/strings/numbers there produce silent NaN scores.
    if (symptomSeverity !== undefined && symptomSeverity !== null
      && (typeof symptomSeverity !== 'object' || Array.isArray(symptomSeverity))) {
      return res.status(400).json({ message: 'symptomSeverity must be an object.' });
    }

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
    if (req.body.feelingDescription && String(req.body.feelingDescription).length > TEXT_MAX)
      return res.status(400).json({ message: `Feeling description must be ${TEXT_MAX} characters or fewer.` });

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
      sunExposure: req.body.sunExposure,
      fitnessFocus: req.body.fitnessFocus,
      proteinIntake: req.body.proteinIntake,
      // The patient narrative is a data path, not decoration: the priority
      // red-flag scanner (utils/priorityFlagging.js) and the AI profile both
      // read it, so it must actually be stored.
      feelingDescription: typeof req.body.feelingDescription === 'string'
        ? req.body.feelingDescription.trim().slice(0, 1000)
        : '',
      recreationalDrugTypes: recreationalDrugTypes || '',
      // Track if this assessment updates a previous one
      ...(req.body.updatedFrom ? { updatedFrom: req.body.updatedFrom } : {}),
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
      const outcome = await flagSevereAssessment(assessment, severity.reasons, req.user.email, severity);
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
    // Every assessment the platform issues is now a chain event, not just the
    // ones whose member happens to visit the Web3 hub and press a button. The
    // digest is history-level (assessment ids, timestamps, intake volume), so
    // nothing personal is written on-chain and the record stays verifiable by
    // the same /health/verify endpoint a clinic would use.
    let chainProof = null;
    if (web3Enabled(req.user)) {
      const out = await anchorHealthLedger(req.user);
      if (out.anchored) {
        chainProof = {
          blockIndex: out.blockIndex,
          txHash: out.txHash,
          digest: out.snapshot.digest,
          assessmentCount: out.snapshot.assessmentCount,
        };
      }
    }
    res.status(201).json({ message: 'Assessment saved', assessment, garbageFields, severityFlag, chainProof });
  } catch (error) {
    console.error('[assessment POST]', error.message);
    res.status(500).json({ message: 'Could not save your assessment. Please try again.' });
  }
});

// @route   GET /api/assessment/active
// @desc    The newest assessment still in force, aiResults projected out.
//          Powers the dashboard's "Update current assessment" pre-fill; an
//          expired record must 404 so a retired plan is never served as active.
// @access  Private
router.get('/active', protect, async (req, res) => {
  try {
    const assessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 })
      // The ~500 KB `aiResults` blob is projected out on purpose: this route
      // exists to pre-fill a FORM, and the replacement assessment generates fresh
      // results. Shipping the old ones costs bandwidth and saves nothing.
      .select('-aiResults');
    if (!assessment) {
      return res.status(404).json({ message: 'No active assessment.' });
    }
    return res.json(assessment);
  } catch (error) {
    console.error('[assessment GET /active]', error.message);
    return res.status(500).json({ message: 'Could not load the active assessment.' });
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
    const items = await Assessment.find({ 
      user: req.user._id, 
      priority: 'Priority',
      resolvedAt: null  // Only unresolved priority assessments block the user
    })
      .sort({ createdAt: -1 })
      .limit(3)
      .select('createdAt flagReasons flaggedAt symptoms')
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
      remaining = await Assessment.find({ 
        user: req.user._id, 
        priority: 'Priority',
        resolvedAt: null  // Only unresolved priority assessments
      })
        .sort({ createdAt: -1 })
        .limit(3)
        .select('createdAt flagReasons flaggedAt symptoms')
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
        symptoms: a.symptoms || [],
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
        const outcome = await flagSevereAssessment(assessment, severity.reasons, assessment.userEmail, severity);
        severityFlag = outcome.flagged
          ? severity
          : { flagged: false, reasons: [], suppressed: outcome.reason };
      }
    }
    // The plan the engine just returned is anchored as it is persisted, so
    // "the app suggested this" is a dated, tamper-evident claim rather than
    // something the member has to remember to prove later. Same commitment the
    // Web3 hub's own anchor button makes — one derivation, so the two can never
    // disagree about what a plan hashes to. The health ledger snapshot rides in
    // the same block, because the record just moved and an export that follows
    // must still find its digest on-chain.
    let recommendationProof = null;
    let chainProof = null;
    if (web3Enabled(req.user)) {
      const out = await anchorPlanEvents(req.user, assessment._id);
      if (out.anchored) {
        recommendationProof = {
          blockIndex: out.blockIndex,
          txHash: out.planTxHash,
          combinedHash: out.combinedHash,
          logicVersion: out.logicVersion,
        };
        chainProof = {
          blockIndex: out.blockIndex,
          txHash: out.healthTxHash,
          digest: out.digest,
          assessmentCount: out.assessmentCount,
        };
      }
    }
    res.json({ message: 'Results saved', assessment, severityFlag, recommendationProof, chainProof });
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
      // Pass adminOverride=true to bypass medical review check for manual admin flags
      const verdict = await guardRaisePriority(existing.user, existing._id, true);
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
        type: nowRaised ? 'severe-flag' : 'info',
        title,
        detail,
        assessmentId: existing._id,
        link: '/history',
        linkLabel: nowRaised ? 'View the flagged assessment' : 'View your assessment history',
      }).catch((err) => {
        console.error('[assessment PATCH /:id/priority] notification failed:', err.message);
      });
      await AdminEvent.create({
        type: nowRaised ? 'severe-flag' : 'resolved',
        title: nowRaised ? 'Assessment flagged as Priority' : 'Assessment priority released',
        // No member identifier: the assessment row the link opens already carries
        // one and is authorised to it. See utils/memberPrivacy.js.
        detail: detail,
        user: existing.user,
        assessmentId: existing._id,
        linkUserId: existing.user,
        // An admin event with no `link` never reaches the console — the
        // bell resolves `link` to the tab that can act on the item, so a missing
        // one makes an admin action invisible while reporting success.
        link: 'assessment-management',
        linkLabel: 'Open Assessment Management',
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

// @route   POST /api/assessment/:id/migrate-history
// @desc    Carry an replaced assessment's tracking history and metrics onto its
//          replacement — so updating a plan is not restarting the day
// @access  Private
//
// WHY A MOVE AND NOT A COPY
// The client creates a fresh assessment on Update, which starts with no rows and
// no streak. Without this route the user's whole history — every ticked dose,
// every day of adherence, the streak itself — would be orphaned under a
// deactivated assessment, and the tracker would ask them to take this morning's
// pills again because the rows that prove they did were filed somewhere else.
//
// THREE RULES THIS HANDLER OWNS
//   NO DUPLICATES. GET / may already have seeded today under the new assessment.
//   Moving an old row onto the same (day, dose) would double-count it, so those
//   old rows stay where they are and only their TAKEN state moves across.
//   PRUNE ONLY PLACEHOLDERS. Today's unticked rows the OLD plan named and the NEW
//   one dropped must go, or the user is asked for supplements they no longer take
//   and the day can never reach 100%. A row that was ticked is history. A row
//   neither plan named was added by hand, so this route has no idea it exists.
//   METRICS ARE THE MODEL'S FIELDS. This used to copy `oldMetrics.streak` and
//   `lastStreakUpdate`, which are not fields of DashboardMetrics — every update
//   silently threw the streak away and set nothing.
router.post('/:id/migrate-history', protect, async (req, res) => {
  try {
    const { newAssessmentId } = req.body;

    if (!newAssessmentId) {
      return res.status(400).json({ message: 'newAssessmentId is required.' });
    }

    // Validate ObjectIds
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(newAssessmentId)) {
      return res.status(400).json({ message: 'Invalid assessment ID.' });
    }

    // Verify both assessments exist and belong to the user
    const oldAssessment = await Assessment.findOne({ _id: req.params.id, user: req.user._id });
    const newAssessment = await Assessment.findOne({ _id: newAssessmentId, user: req.user._id });

    if (!oldAssessment) {
      return res.status(404).json({ message: 'Source assessment not found.' });
    }
    if (!newAssessment) {
      return res.status(404).json({ message: 'Target assessment not found.' });
    }

    // Import IntakeRecord model
    const IntakeRecord = require('../models/IntakeRecord');

    const doseKey = (row) => `${row.dayKey}|${normalizeName(row.supplementName)}`;
    const planNames = (assessment) => new Set(
      ((assessment.aiResults && assessment.aiResults.recommendations) || [])
        .map((rec) => normalizeName(rec && (rec.name || rec.supplement)))
        .filter(Boolean),
    );
    const oldPlan = planNames(oldAssessment);
    const newPlan = planNames(newAssessment);

    const [oldRows, newRows] = await Promise.all([
      IntakeRecord.find({ user: req.user._id, assessment: oldAssessment._id })
        .select('_id dayKey supplementName taken takenAt')
        .lean(),
      IntakeRecord.find({ user: req.user._id, assessment: newAssessment._id })
        .select('_id dayKey supplementName taken takenAt')
        .lean(),
    ]);

    // A dose the replacement already has a row for must not be moved onto it.
    const alreadyOnNew = new Map();
    for (const row of newRows) {
      if (!alreadyOnNew.has(doseKey(row))) alreadyOnNew.set(doseKey(row), row);
    }

    const blockedIds = [];
    const inheritTaken = [];
    for (const row of oldRows) {
      const existing = alreadyOnNew.get(doseKey(row));
      if (!existing) continue;
      blockedIds.push(row._id);
      // The user really did take this dose today; the row that says so is the old
      // one, and the row the tracker renders is the new one.
      if (row.taken && !existing.taken) inheritTaken.push({ _id: existing._id, takenAt: row.takenAt || new Date() });
    }

    const updateResult = await IntakeRecord.updateMany(
      { user: req.user._id, assessment: oldAssessment._id, _id: { $nin: blockedIds } },
      { $set: { assessment: newAssessment._id } }
    );

    for (const row of inheritTaken) {
      await IntakeRecord.updateOne({ _id: row._id }, { $set: { taken: true, takenAt: row.takenAt } });
    }

    // Today's placeholders for doses the updated plan dropped — read off the rows
    // being moved, since the replacement's own rows came from its own plan.
    const timeZone = cleanTimeZone(req.get('x-client-timezone'))
      || cleanTimeZone(req.user && req.user.timeZone)
      || 'UTC';
    const todayKey = planDayKey(new Date(), timeZone);
    const blocked = new Set(blockedIds.map(String));
    const prune = oldRows.filter((row) => {
      const name = normalizeName(row.supplementName);
      return !blocked.has(String(row._id))
        && row.dayKey === todayKey
        && !row.taken
        && oldPlan.has(name)
        && !newPlan.has(name);
    });
    if (prune.length > 0) {
      await IntakeRecord.deleteMany({ _id: { $in: prune.map((row) => row._id) }, user: req.user._id });
    }

    // Copy adherence metrics from old assessment's dashboard metrics to new one
    let copiedMetrics = false;
    try {
      const oldMetrics = await DashboardMetrics.findOne({ 
        user: req.user._id, 
        assessment: oldAssessment._id 
      });

      if (oldMetrics) {
        // Only the fields the model actually has. `wellnessScore` is left alone
        // because GET / recomputes it from the history this just moved.
        //
        // `assessmentStartDate` is REQUIRED, and an `upsert` with `$set` does not
        // run document validation — so omitting it used to file a metrics row that
        // could be read but never saved. The next `GET /api/dashboard` calls
        // `metrics.save()`, which validates the whole document, and the user's
        // dashboard answered 500 for the rest of the day. Observed live, not
        // theorised.
        await DashboardMetrics.findOneAndUpdate(
          { user: req.user._id, assessment: newAssessment._id },
          {
            $set: {
              assessmentStartDate: oldMetrics.assessmentStartDate
                || newAssessment.createdAt
                || new Date(),
              currentStreak: oldMetrics.currentStreak || 0,
              longestStreak: oldMetrics.longestStreak || 0,
              totalDaysTracked: oldMetrics.totalDaysTracked || 0,
              overallAdherence: oldMetrics.overallAdherence || 0,
              energyLevel: oldMetrics.energyLevel || 'Medium',
              streakAwardedToday: !!oldMetrics.streakAwardedToday,
              lastTrackedDate: oldMetrics.lastTrackedDate || '',
              lastCompletedDay: oldMetrics.lastCompletedDay || '',
              lastBackfilledDay: oldMetrics.lastBackfilledDay || '',
              isActive: true,
            }
          },
          // Ask Mongoose to validate the write, so a required field can only ever
          // be missing from an error here — never from the row that gets read back.
          { upsert: true, new: true, runValidators: true }
        );
        copiedMetrics = true;
      }
    } catch (metricsError) {
      console.error('[migrate-history] Failed to copy metrics:', metricsError.message);
      // Don't fail the whole operation if metrics copy fails
    }

    console.log(`[migrate-history] Migrated ${updateResult.modifiedCount} intake records from ${oldAssessment._id} to ${newAssessment._id}`);

    res.json({
      message: 'History migrated successfully.',
      recordsMigrated: updateResult.modifiedCount,
      dosesInherited: inheritTaken.length,
      staleDosesPruned: prune.length,
      metricsCopied: copiedMetrics,
    });
  } catch (error) {
    console.error('[migrate-history] Error:', error);
    res.status(500).json({ message: 'Failed to migrate history.', error: error.message });
  }
});

module.exports = router;