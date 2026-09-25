const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Assessment = require('../models/Assessment');
const IntakeRecord = require('../models/IntakeRecord');
const DashboardMetrics = require('../models/DashboardMetrics');
const { notExpiredFilter, expiryFromCreatedAt } = require('../utils/assessments');
const { can } = require('../utils/plan');
const { selfHealOpenPriority } = require('../utils/priorityGate');

// Coerce any JSON value to a plain string for DB equality filters.
// Objects (e.g. {"$ne": "x"}) would otherwise become NoSQL operators and
// match/delete the wrong records — String() neutralizes them to literals.
const str = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));
// Strip any HTML/markup first (defense-in-depth: React escapes on render, but
// the API must never persist or echo raw markup back to a client).
const cleanSupplementName = (value) => str(value).replace(/<[^>]*>/g, '').trim().slice(0, 200);

// Helper: Get today's date in YYYY-MM-DD format
const getTodayKey = () => {
  const now = new Date();
  return now.toISOString().split('T')[0];
};

// Helper: Calculate adherence percentage
const calculateAdherence = (taken, total) => {
  if (total === 0) return 0;
  return Math.round((taken / total) * 100);
};

// Helper: Calculate wellness score
const calculateWellnessScore = (baseline, adherence, streak) => {
  // baseline: 0-30 (from AI analysis of health state)
  // adherence: 0-100 → contributes 0-50 points
  // streak: capped at 30 days → contributes 0-20 points
  
  const adherencePoints = Math.round(adherence * 0.5);
  const streakPoints = Math.min(Math.round(streak * 0.67), 20);
  
  return Math.min(baseline + adherencePoints + streakPoints, 100);
};

// Helper: Get wellness baseline from assessment
const getWellnessBaseline = (assessment) => {
  // Try to get baseline from AI results
  if (assessment && assessment.aiResults && typeof assessment.aiResults.wellnessBaseline === 'number') {
    return Math.max(0, Math.min(30, assessment.aiResults.wellnessBaseline));
  }
  // Default baseline if not available (neutral starting point)
  return 15;
};

// Helper: Validate and reset streak if previous day was missed
const validateStreak = async (userId, assessmentId, metrics) => {
  const todayKey = getTodayKey();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = yesterday.toISOString().split('T')[0];
  
  // Check if we crossed into a new day
  if (metrics.lastTrackedDate && metrics.lastTrackedDate !== todayKey) {
    // New day has started - evaluate yesterday's completion
    
    if (metrics.lastCompletedDay === metrics.lastTrackedDate) {
      // Yesterday finished with 100% completion - keep streak
      metrics.streakAwardedToday = false; // Reset for new day
      await metrics.save();
    } else {
      // Yesterday finished incomplete - reset streak
      metrics.currentStreak = 0;
      metrics.streakAwardedToday = false;
      metrics.lastCompletedDay = null;
      metrics.lastTrackedDate = todayKey;
      await metrics.save();
    }
  }
  
  return metrics.currentStreak;
};

// @route   GET /api/dashboard
// @desc    Get complete dashboard data for the user's active assessment
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    // Track first dashboard visit
    const User = require('../models/User');
    const isFirstVisit = !req.user.hasVisitedDashboard;
    
    if (isFirstVisit) {
      await User.findByIdAndUpdate(req.user._id, { hasVisitedDashboard: true });
    }

    // Get the latest assessment
    const latestAssessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 });

    if (!latestAssessment) {
      // Return empty dashboard data for new users without assessment
      return res.json({
        hasAssessment: false,
        isFirstVisit,
        priorityBlock: { blocked: false, count: 0 },
        priorityAssessments: [],
        assessment: null,
        todaysSupplements: [],
        stats: {
          wellnessScore: 0,
          daysStreak: 0,
          longestStreak: 0,
          adherenceRate: 0,
          energyLevel: 'Medium',
          todaysProgress: {
            taken: 0,
            total: 0,
            percentage: 0,
          },
        },
        insights: null,
      });
    }

    // Metrics + today's records are independent — fetch in parallel (Atlas RTT ~0.5s each)
    const todayKey = getTodayKey();
    let [metrics, todayIntakeRecords] = await Promise.all([
      DashboardMetrics.findOne({ user: req.user._id, assessment: latestAssessment._id }),
      IntakeRecord.find({ user: req.user._id, assessment: latestAssessment._id, dayKey: todayKey }).lean(),
    ]);

    if (!metrics) {
      // Create initial metrics for this assessment
      metrics = await DashboardMetrics.create({
        user: req.user._id,
        assessment: latestAssessment._id,
        assessmentStartDate: latestAssessment.createdAt,
        isActive: true,
        currentStreak: 0,
        overallAdherence: 0,
        wellnessScore: 0,
      });
    }

    // Validate streak on page load - reset if previous day was missed
    const validatedStreak = await validateStreak(req.user._id, latestAssessment._id, metrics);

    // Get today's supplements from assessment recommendations
    const recommendations = latestAssessment.aiResults?.recommendations || [];
    const dailySchedule = latestAssessment.aiResults?.dailySchedule || [];

    // Daily plan snapshot: on the first load of a day with an empty plan,
    // seed today's records from the AI recommendations so the day always
    // lists what needed to be taken. Untouched days automatically read as
    // MISSED (red) in the calendar and day-detail views.
    if (todayIntakeRecords.length === 0 && recommendations.length > 0) {
      const seeds = recommendations.slice(0, 20)
        .map(rec => ({
          user: req.user._id,
          assessment: latestAssessment._id,
          supplementName: rec.name || rec.supplement,
          dosage: rec.dosage || '',
          priority: ['High', 'Medium', 'Low'].includes(rec.priority) ? rec.priority : 'Medium',
          scheduledTime: rec.timing || 'Anytime',
          taken: false,
          date: new Date(),
          dayKey: todayKey,
        }))
        .filter(doc => doc.supplementName);
      if (seeds.length > 0) {
        // Per-supplement upserts: idempotent if two devices load at once
        await Promise.all(seeds.map(doc =>
          IntakeRecord.updateOne(
            { user: doc.user, assessment: doc.assessment, supplementName: doc.supplementName, dayKey: doc.dayKey },
            { $setOnInsert: doc },
            { upsert: true }
          ).exec()
        ));
        todayIntakeRecords = await IntakeRecord.find({
          user: req.user._id,
          assessment: latestAssessment._id,
          dayKey: todayKey,
        }).lean();
      }
    }

    // Get wellness baseline from assessment
    const wellnessBaseline = getWellnessBaseline(latestAssessment);

    // Calculate today's progress
    const totalToday = todayIntakeRecords.length;
    const takenToday = todayIntakeRecords.filter(r => r.taken).length;
    const todayAdherence = calculateAdherence(takenToday, totalToday);

    // Update wellness score
    const wellnessScore = calculateWellnessScore(
      wellnessBaseline,
      metrics.overallAdherence,
      validatedStreak
    );

    // Update metrics if changed
    if (metrics.wellnessScore !== wellnessScore) {
      metrics.wellnessScore = wellnessScore;
      await metrics.save();
    }

    // Get AI insights from assessment
    const aiInsights = latestAssessment.aiResults?.actionPlan || [];
    const currentPhase = aiInsights.length > 0 ? aiInsights[0] : null;

    // Priority assessments needing review (cap 3, own recommendations each).
    // These block new assessments until resolved and are surfaced on the dashboard.
    //
    // Gated on the CURRENT plan: Priority Assessment is a premium entitlement,
    // so a user who downgraded keeps the flagged assessment (history badge, admin
    // view) but is no longer paused — the banner and the "Paused" card must not
    // be produced for them, or the dashboard keeps selling a premium lockout
    // the API no longer enforces.
    let priorityDocs = [];
    if (can(req.user, 'priorityAssessment')) {
      // Same repair as GET /api/assessment/priority-status. Without it the two
      // endpoints could disagree: the assessment screen released a completed
      // flag while the dashboard still counted it and showed "New Assessments
      // Paused", so the user could not tell whether they were blocked at all.
      try {
        const healed = await selfHealOpenPriority(req.user._id);
        if (healed.released.length > 0) {
          console.warn(`[dashboard GET /] released ${healed.released.length} completed priority flag(s) for user ${req.user._id}`);
        }
      } catch (healError) {
        console.error('[dashboard GET /] priority self-heal failed:', healError.message);
      }
      priorityDocs = await Assessment.find({ user: req.user._id, priority: 'Priority' })
        .sort({ createdAt: -1 })
        .limit(3)
        .select('createdAt flagReasons flaggedAt aiResults.recommendations')
        .lean();
    }
    const priorityAssessments = (priorityDocs || []).map(doc => ({
      id: doc._id,
      createdAt: doc.createdAt,
      flaggedAt: doc.flaggedAt,
      reasons: doc.flagReasons || [],
      recommendations: (doc.aiResults?.recommendations || []).slice(0, 12).map(rec => ({
        name: rec.name || rec.supplement,
        dosage: rec.dosage || '',
        priority: rec.priority || 'Medium',
        timing: rec.timing || 'Anytime',
      })),
    }));

    // Map priority and timing from recommendations to intake records
    const priorityMap = {};
    const timingMap = {};
    recommendations.forEach(rec => {
      priorityMap[rec.name] = rec.priority || 'Medium';
      timingMap[rec.name] = rec.timing || 'Anytime';
    });

    // Response - always use priority and timing from recommendations, not from stored record
    res.json({
      hasAssessment: true,
      isFirstVisit,
      priorityBlock: {
        blocked: priorityAssessments.length > 0,
        count: priorityAssessments.length,
      },
      priorityAssessments,
      assessment: {
        id: latestAssessment._id,
        createdAt: latestAssessment.createdAt,
        summary: latestAssessment.aiResults?.simplifiedSummary || latestAssessment.aiResults?.summary || '',
      },
      todaysSupplements: todayIntakeRecords.map(rec => ({
        id: rec._id,
        name: rec.supplementName,
        dosage: rec.dosage,
        priority: priorityMap[rec.supplementName] || rec.priority || 'Medium', // Use recommendation priority first
        scheduledTime: timingMap[rec.supplementName] || rec.scheduledTime || 'Anytime', // Use recommendation timing first
        taken: rec.taken,
        takenAt: rec.takenAt,
      })),
      stats: {
        wellnessScore: metrics.wellnessScore,
        daysStreak: validatedStreak,
        longestStreak: metrics.longestStreak || 0,
        adherenceRate: metrics.overallAdherence,
        energyLevel: metrics.energyLevel,
        todaysProgress: {
          taken: takenToday,
          total: totalToday,
          percentage: todayAdherence,
        },
      },
      insights: currentPhase ? {
        phase: currentPhase.phase,
        focus: currentPhase.focus,
        steps: currentPhase.steps,
        expectedChanges: currentPhase.expectedChanges,
      } : null,
    });
  } catch (error) {
    console.error('[dashboard GET]', error.message);
    res.status(500).json({ message: 'Could not load dashboard data. Please try again.' });
  }
});

// @route   POST /api/dashboard/intake
// @desc    Mark a supplement as taken or undo
// @access  Private
router.post('/intake', protect, async (req, res) => {
  try {
    const { recordId, taken } = req.body;

    if (!recordId || typeof taken !== 'boolean') {
      return res.status(400).json({ message: 'Record ID and taken status are required.' });
    }
    // Reject operator objects before they reach the _id filter (CastError → 500)
    if (!mongoose.isValidObjectId(recordId)) {
      return res.status(400).json({ message: 'Invalid record.' });
    }

    const record = await IntakeRecord.findOne({
      _id: recordId,
      user: req.user._id,
    });

    if (!record) {
      return res.status(404).json({ message: 'Intake record not found.' });
    }

    // History is read-only: only today's records can change. This protects
    // streak integrity and the priority lift/reflag lifecycle from back-dated edits.
    if (record.dayKey !== getTodayKey()) {
      return res.status(400).json({ message: 'Only today\u2019s supplements can be updated. Past days are read-only history.' });
    }

    record.taken = taken;
    record.takenAt = taken ? new Date() : null;
    await record.save();

    // Update metrics — independent reads run in parallel
    const todayKey = getTodayKey();
    const [todayRecords, metrics, totals, assessmentDoc] = await Promise.all([
      IntakeRecord.find({ user: req.user._id, assessment: record.assessment, dayKey: todayKey }).select('taken').lean(),
      DashboardMetrics.findOne({ user: req.user._id, assessment: record.assessment }),
      Promise.all([
        IntakeRecord.countDocuments({ user: req.user._id, assessment: record.assessment }),
        IntakeRecord.countDocuments({ user: req.user._id, assessment: record.assessment, taken: true }),
      ]),
      // Only the slices needed downstream (wellness baseline + priority state)
      Assessment.findById(record.assessment).select('aiResults.wellnessBaseline priority resolvedReason').lean(),
    ]);

    const totalToday = todayRecords.length;
    const takenToday = todayRecords.filter(r => r.taken).length;
    const todayAdherence = calculateAdherence(takenToday, totalToday);

    // Overall adherence via counted aggregation (no full-history load)
    const [totalAll, takenAll] = totals;
    const overallAdherence = calculateAdherence(takenAll, totalAll);

    if (metrics) {
      const today = todayKey;
      const yesterday = new Date(new Date().setDate(new Date().getDate() - 1))
        .toISOString().split('T')[0];
      
      // MIDNIGHT CHECK: Evaluate if we crossed into a new day
      if (metrics.lastTrackedDate && metrics.lastTrackedDate !== today) {
        // New day has started - check if yesterday was completed
        if (metrics.lastCompletedDay === metrics.lastTrackedDate) {
          // Yesterday finished with 100% - keep streak
          // Reset daily flag for new day
          metrics.streakAwardedToday = false;
        } else {
          // Yesterday finished incomplete - break streak
          metrics.currentStreak = 0;
          metrics.streakAwardedToday = false;
          metrics.lastCompletedDay = null;
        }
      }
      
      // CURRENT DAY LOGIC: Update streak based on current completion state
      if (takenToday === totalToday && totalToday > 0) {
        // User has 100% completion RIGHT NOW
        
        if (!metrics.streakAwardedToday) {
          // First time completing 100% today - award streak
          metrics.currentStreak += 1;
          metrics.streakAwardedToday = true;
          metrics.lastCompletedDay = today;
          
          if (metrics.currentStreak > metrics.longestStreak) {
            metrics.longestStreak = metrics.currentStreak;
          }
        } else {
          // Already awarded streak today, just mark completion
          metrics.lastCompletedDay = today;
        }
      } else if (takenToday < totalToday && totalToday > 0) {
        // User does NOT have 100% completion right now
        
        if (metrics.streakAwardedToday && metrics.lastCompletedDay === today && metrics.currentStreak > 0) {
          // They had completed today but just undid - remove today's streak
          // Only decrement if streak is greater than 0 to prevent negative values
          metrics.currentStreak -= 1;
          metrics.lastCompletedDay = null; // Today is no longer completed
          metrics.streakAwardedToday = false; // Reset flag to allow re-awarding if they complete again
        }
      }
      
      metrics.lastTrackedDate = today;

      metrics.overallAdherence = overallAdherence;

      // Auto-lift: all of today's AI-suggested supplements taken on a
      // Priority assessment finishes its review (strict two-way gate below).
      // Both directions are premium bookkeeping (the re-flag also notifies), so
      // they follow the same entitlement as the pause itself: after a downgrade
      // a stale Priority document must stay untouched instead of being resolved
      // and then reinstated behind the user's back.
      let priorityLifted = false;
      let priorityReflagged = false;
      const priorityEntitled = can(req.user, 'priorityAssessment');
      const completedNow = takenToday === totalToday && totalToday > 0;
      if (priorityEntitled && completedNow && assessmentDoc && assessmentDoc.priority === 'Priority') {
        try {
          await Assessment.findByIdAndUpdate(record.assessment, {
            // Resolved by completion: Standard again, with the normal 5-year
            // window counted from CREATION. It used to set expiresAt to "now",
            // which retired the record the instant the user finished their
            // priority review and showed "Expired <today>" in history.
            $set: {
              priority: 'Standard',
              resolvedAt: new Date(),
              resolvedReason: 'intake-complete',
              expiresAt: expiryFromCreatedAt(assessmentDoc.createdAt),
            },
          });
          priorityLifted = true;
          const UserNotification = require('../models/UserNotification');
          const AdminEvent = require('../models/AdminEvent');
          await UserNotification.create({
            user: req.user._id,
            type: 'info',
            title: 'Priority review completed',
            detail: 'All of today\u2019s supplements were taken, so the priority review on your assessment is finished. You can start a new assessment any time.',
            assessmentId: record.assessment,
          }).catch(() => {});
          await AdminEvent.create({
            type: 'resolved',
            title: 'Priority auto-resolved (intake complete)',
            detail: `User ${req.user._id} completed all of today\u2019s supplements for assessment ${record.assessment}. Flag lifted automatically.`,
            user: req.user._id,
            assessmentId: record.assessment,
            linkUserId: req.user._id,
          }).catch(() => {});
        } catch (liftError) {
          console.error('[dashboard POST /intake] priority auto-lift failed:', liftError.message);
        }
      } else if (priorityEntitled && !completedNow && assessmentDoc && assessmentDoc.priority === 'Standard' && assessmentDoc.resolvedReason === 'intake-complete') {
        // Strict gate: undoing after an auto-lift breaks 100% completion,
        // so the restriction comes back. Admin-resolved flags are never touched.
        try {
          await Assessment.findByIdAndUpdate(record.assessment, {
            $set: {
              priority: 'Priority',
              flaggedAt: new Date(),
              resolvedAt: null,
              resolvedReason: '',
              expiresAt: null,
              flagReasons: ['Intake undone after auto-resolve — review reinstated'],
            },
          });
          priorityReflagged = true;
          const UserNotification = require('../models/UserNotification');
          const AdminEvent = require('../models/AdminEvent');
          await UserNotification.create({
            user: req.user._id,
            type: 'severe-flag',
            title: 'Priority review reinstated',
            detail: 'A supplement was marked not taken, so today\u2019s plan is incomplete again. The priority review is back in effect and new assessments are paused until it is finished.',
            assessmentId: record.assessment,
          }).catch(() => {});
          await AdminEvent.create({
            type: 'severe-flag',
            title: 'Priority re-flagged (intake undone)',
            detail: `User ${req.user._id} undid a supplement for assessment ${record.assessment} after auto-resolve. Restriction reinstated.`,
            user: req.user._id,
            assessmentId: record.assessment,
            linkUserId: req.user._id,
          }).catch(() => {});
        } catch (reflagError) {
          console.error('[dashboard POST /intake] priority re-flag failed:', reflagError.message);
        }
      }
      
      // Wellness baseline from the already-fetched assessment slice
      const wellnessBaseline = getWellnessBaseline(assessmentDoc);
      
      metrics.wellnessScore = calculateWellnessScore(
        wellnessBaseline,
        overallAdherence,
        metrics.currentStreak
      );
      await metrics.save();

      res.json({
        message: 'Intake updated',
        priorityLifted,
        priorityReflagged,
        record: {
          id: record._id,
          taken: record.taken,
          takenAt: record.takenAt,
        },
        stats: {
          todaysProgress: {
            taken: takenToday,
            total: totalToday,
            percentage: todayAdherence,
          },
          overallAdherence: metrics.overallAdherence,
          daysStreak: metrics.currentStreak,
          wellnessScore: metrics.wellnessScore,
        },
      });
    } else {
      res.json({
        message: 'Intake updated',
        record: {
          id: record._id,
          taken: record.taken,
          takenAt: record.takenAt,
        },
      });
    }
  } catch (error) {
    console.error('[dashboard POST /intake]', error.message);
    res.status(500).json({ message: 'Could not update intake. Please try again.' });
  }
});

// @route   POST /api/dashboard/energy
// @desc    Update energy level for today (DEPRECATED - energy no longer affects wellness score)
// @access  Private
router.post('/energy', protect, async (req, res) => {
  try {
    const { energyLevel } = req.body;

    if (!['Low', 'Medium', 'High'].includes(energyLevel)) {
      return res.status(400).json({ message: 'Invalid energy level.' });
    }

    // Get latest assessment
    const latestAssessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 });

    if (!latestAssessment) {
      return res.status(404).json({ message: 'No assessment found.' });
    }

    // Update metrics - energy level is stored but doesn't affect score anymore
    const metrics = await DashboardMetrics.findOne({
      user: req.user._id,
      assessment: latestAssessment._id,
    });

    if (!metrics) {
      return res.status(404).json({ message: 'Metrics not found.' });
    }

    metrics.energyLevel = energyLevel;
    
    // Wellness score is now calculated from baseline + adherence + streak only
    const wellnessBaseline = getWellnessBaseline(latestAssessment);
    metrics.wellnessScore = calculateWellnessScore(
      wellnessBaseline,
      metrics.overallAdherence,
      metrics.currentStreak
    );
    await metrics.save();

    res.json({
      message: 'Energy level updated',
      energyLevel: metrics.energyLevel,
      wellnessScore: metrics.wellnessScore,
    });
  } catch (error) {
    console.error('[dashboard POST /energy]', error.message);
    res.status(500).json({ message: 'Could not update energy level. Please try again.' });
  }
});

// @route   POST /api/dashboard/reset
// @desc    Reset dashboard when a new assessment is taken (deactivate old metrics)
// @access  Private
router.post('/reset', protect, async (req, res) => {
  try {
    const { assessmentId } = req.body;

    if (!assessmentId) {
      return res.status(400).json({ message: 'Assessment ID is required.' });
    }
    // Reject operator objects before they reach the document reference
    if (!mongoose.isValidObjectId(assessmentId)) {
      return res.status(400).json({ message: 'Invalid assessment.' });
    }

    // Ownership check: the referenced assessment must belong to the caller.
    // Without it, any authenticated user could bind their dashboard metrics
    // to another account's assessment id (broken object-level authorization).
    const owned = await Assessment.findOne({ _id: assessmentId, user: req.user._id })
      .select('_id')
      .lean();
    if (!owned) {
      return res.status(404).json({ message: 'Assessment not found.' });
    }

    // Deactivate all previous metrics
    await DashboardMetrics.updateMany(
      { user: req.user._id, isActive: true },
      { isActive: false }
    );

    // Create new metrics for the new assessment
    const newMetrics = await DashboardMetrics.create({
      user: req.user._id,
      assessment: assessmentId,
      assessmentStartDate: new Date(),
      isActive: true,
      currentStreak: 0,
      overallAdherence: 0,
      wellnessScore: 0,
    });

    res.json({
      message: 'Dashboard reset successfully',
      metrics: newMetrics,
    });
  } catch (error) {
    console.error('[dashboard POST /reset]', error.message);
    res.status(500).json({ message: 'Could not reset dashboard. Please try again.' });
  }
});

// @route   GET /api/dashboard/day/:dayKey
// @desc    Full intake records for one day (YYYY-MM-DD) — powers the
//          interactive calendar day-detail view. Read-only history; toggling
//          past days is intentionally unsupported (protects streak integrity).
// @access  Private
router.get('/day/:dayKey', protect, async (req, res) => {
  try {
    const { dayKey } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey || '')) {
      return res.status(400).json({ message: 'Invalid date. Use YYYY-MM-DD.' });
    }
    const todayKey = getTodayKey();
    if (dayKey > todayKey) {
      return res.status(400).json({ message: 'Future dates have no records yet.' });
    }

    const latestAssessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 })
      .select('_id')
      .lean();
    if (!latestAssessment) {
      return res.json({ dayKey, records: [] });
    }

    const records = await IntakeRecord.find({
      user: req.user._id,
      assessment: latestAssessment._id,
      dayKey,
    })
      .select('supplementName dosage priority scheduledTime taken takenAt')
      .sort({ scheduledTime: 1 })
      .lean();

    res.json({
      dayKey,
      records: records.map(rec => ({
        id: rec._id,
        name: rec.supplementName,
        dosage: rec.dosage,
        priority: rec.priority || 'Medium',
        scheduledTime: rec.scheduledTime || 'Anytime',
        taken: !!rec.taken,
        takenAt: rec.takenAt,
      })),
    });
  } catch (error) {
    console.error('[dashboard GET /day/:dayKey]', error.message);
    res.status(500).json({ message: 'Could not load that day. Please try again.' });
  }
});

// @route   GET /api/dashboard/calendar/:year/:month
// @desc    Get completion history for a specific month
// @access  Private
router.get('/calendar/:year/:month', protect, async (req, res) => {
  try {
    const { year, month } = req.params;
    
    // Validate year and month.
    // The year is also clamped to a sane window: an unbounded value builds an
    // Invalid Date whose toISOString() throws, turning a crafted URL into a
    // 500 instead of an empty result.
    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10);
    const currentYear = new Date().getFullYear();

    if (
      isNaN(yearNum) || isNaN(monthNum) ||
      monthNum < 1 || monthNum > 12 ||
      yearNum < 2000 || yearNum > currentYear + 1
    ) {
      return res.status(400).json({ message: 'Invalid year or month.' });
    }

    // Get the latest assessment
    const latestAssessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 });

    if (!latestAssessment) {
      return res.json({ completionData: {} });
    }

    // Get first and last day of the month
    const firstDay = new Date(yearNum, monthNum - 1, 1);
    const lastDay = new Date(yearNum, monthNum, 0);
    
    // Format as YYYY-MM-DD for comparison
    const startKey = firstDay.toISOString().split('T')[0];
    const endKey = lastDay.toISOString().split('T')[0];

    // Get all intake records for this month (lean + minimal fields)
    const records = await IntakeRecord.find({
      user: req.user._id,
      assessment: latestAssessment._id,
      dayKey: { $gte: startKey, $lte: endKey },
    }).select('dayKey taken').lean();

    // Group by day and calculate completion percentage
    const completionData = {};
    
    records.forEach(record => {
      if (!completionData[record.dayKey]) {
        completionData[record.dayKey] = {
          total: 0,
          taken: 0,
        };
      }
      
      completionData[record.dayKey].total += 1;
      if (record.taken) {
        completionData[record.dayKey].taken += 1;
      }
    });

    // Calculate percentages
    const result = {};
    Object.keys(completionData).forEach(dayKey => {
      const data = completionData[dayKey];
      const percentage = data.total > 0 ? Math.round((data.taken / data.total) * 100) : 0;
      
      // Extract day number from YYYY-MM-DD
      const day = parseInt(dayKey.split('-')[2]);
      
      result[day] = {
        percentage,
        taken: data.taken,
        total: data.total,
      };
    });

    res.json({ completionData: result });
  } catch (error) {
    console.error('[dashboard GET /calendar/:year/:month]', error.message);
    res.status(500).json({ message: 'Could not load calendar data. Please try again.' });
  }
});

// @route   GET /api/dashboard/weekly-adherence
// @desc    Get adherence data for the current week
// @access  Private
router.get('/weekly-adherence', protect, async (req, res) => {
  try {
    // Get the latest assessment
    const latestAssessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 });

    if (!latestAssessment) {
      return res.json({ weeklyDays: [], overallAdherence: 0 });
    }

    // Get the current week (last 7 days)
    const today = new Date();
    const dayKeys = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      dayKeys.push({
        dayKey: date.toISOString().split('T')[0],
        dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
      });
    }

    // Single query for the whole week (avoids 7 sequential round-trips)
    const records = await IntakeRecord.find({
      user: req.user._id,
      assessment: latestAssessment._id,
      dayKey: { $in: dayKeys.map(d => d.dayKey) },
    }).select('dayKey taken').lean();

    const byDay = new Map();
    for (const record of records) {
      const entry = byDay.get(record.dayKey) || { total: 0, taken: 0 };
      entry.total += 1;
      if (record.taken) entry.taken += 1;
      byDay.set(record.dayKey, entry);
    }

    const weekData = dayKeys.map(({ dayKey, dayName }) => {
      const entry = byDay.get(dayKey) || { total: 0, taken: 0 };
      return {
        day: dayName,
        date: dayKey,
        completed: entry.taken,
        total: entry.total,
        percentage: entry.total > 0 ? Math.round((entry.taken / entry.total) * 100) : 0,
      };
    });

    // Calculate overall adherence
    const totalSupplements = weekData.reduce((sum, day) => sum + day.total, 0);
    const totalTaken = weekData.reduce((sum, day) => sum + day.completed, 0);
    const overallAdherence = totalSupplements > 0 ? Math.round((totalTaken / totalSupplements) * 100) : 0;

    res.json({
      weeklyDays: weekData,
      overallAdherence: overallAdherence,
    });
  } catch (error) {
    console.error('[dashboard GET /weekly-adherence]', error.message);
    res.status(500).json({ message: 'Could not load weekly adherence data. Please try again.' });
  }
});

// @route   POST /api/dashboard/add-supplement
// @desc    Add a supplement to user's daily plan
// @access  Private
router.post('/add-supplement', protect, async (req, res) => {
  try {
    const { dosage, timing, priority } = req.body;
    const name = cleanSupplementName(req.body.name);
    // Coerce/whitelist before Mongoose sees them: an object dosage → CastError,
    // and a non-enum priority (e.g. {"$gt": ""}) → ValidationError — both 500s.
    const safeDosage = str(dosage).trim().slice(0, 100);
    const safeTiming = str(timing).trim().slice(0, 50);
    const safePriority = ['High', 'Medium', 'Low'].includes(priority) ? priority : 'Medium';

    if (!name) {
      return res.status(400).json({ message: 'Supplement name is required.' });
    }

    // Get the latest assessment
    const latestAssessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 });

    if (!latestAssessment) {
      return res.status(404).json({ message: 'No assessment found. Please complete an assessment first.' });
    }

    // Check if supplement already exists in today's plan
    const todayKey = getTodayKey();
    const existingRecord = await IntakeRecord.findOne({
      user: req.user._id,
      assessment: latestAssessment._id,
      supplementName: name,
      dayKey: todayKey,
    });

    if (existingRecord) {
      return res.status(400).json({ message: 'This supplement is already in your plan for today.' });
    }

    // Create new intake record for today
    const newRecord = await IntakeRecord.create({
      user: req.user._id,
      assessment: latestAssessment._id,
      supplementName: name,
      dosage: safeDosage,
      priority: safePriority,
      scheduledTime: safeTiming || 'Anytime',
      taken: false,
      date: new Date(),
      dayKey: todayKey,
    });

    // Update metrics - adding a new supplement breaks 100% completion
    const metrics = await DashboardMetrics.findOne({
      user: req.user._id,
      assessment: latestAssessment._id,
    });

    if (metrics) {
      const today = todayKey;
      
      // Get all today's records including the new one
      const todayRecords = await IntakeRecord.find({
        user: req.user._id,
        assessment: latestAssessment._id,
        dayKey: todayKey,
      });

      const totalToday = todayRecords.length;
      const takenToday = todayRecords.filter(r => r.taken).length;

      // If user had completed today (100%) and just added a new supplement, they no longer have 100%
      if (metrics.streakAwardedToday && metrics.lastCompletedDay === today && takenToday < totalToday) {
        // Break the streak - remove today's contribution
        if (metrics.currentStreak > 0) {
          metrics.currentStreak -= 1;
        }
        metrics.lastCompletedDay = null; // Today is no longer completed
        metrics.streakAwardedToday = false; // Reset flag to allow re-awarding when they complete all
      }

      // Recalculate overall adherence via counted aggregation (no full-history load)
      const [totalAll, takenAll] = await Promise.all([
        IntakeRecord.countDocuments({ user: req.user._id, assessment: latestAssessment._id }),
        IntakeRecord.countDocuments({ user: req.user._id, assessment: latestAssessment._id, taken: true }),
      ]);
      metrics.overallAdherence = calculateAdherence(takenAll, totalAll);

      // Recalculate wellness score
      const wellnessBaseline = getWellnessBaseline(latestAssessment);
      metrics.wellnessScore = calculateWellnessScore(
        wellnessBaseline,
        metrics.overallAdherence,
        metrics.currentStreak
      );

      await metrics.save();
    }

    res.json({
      message: 'Supplement added to your plan',
      supplement: {
        id: newRecord._id,
        name: newRecord.supplementName,
        dosage: newRecord.dosage,
        priority: newRecord.priority,
        scheduledTime: newRecord.scheduledTime,
        taken: newRecord.taken,
      },
    });
  } catch (error) {
    console.error('[dashboard POST /add-supplement]', error.message);
    res.status(500).json({ message: 'Could not add supplement. Please try again.' });
  }
});

// @route   POST /api/dashboard/remove-supplement
// @desc    Remove a supplement from user's daily plan
// @access  Private
router.post('/remove-supplement', protect, async (req, res) => {
  try {
    const supplementName = cleanSupplementName(req.body.supplementName);

    if (!supplementName) {
      return res.status(400).json({ message: 'Supplement name is required.' });
    }

    // Get the latest assessment
    const latestAssessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 });

    if (!latestAssessment) {
      return res.status(404).json({ message: 'No assessment found.' });
    }

    // Remove from today's plan
    const todayKey = getTodayKey();
    const result = await IntakeRecord.deleteMany({
      user: req.user._id,
      assessment: latestAssessment._id,
      supplementName: supplementName,
      dayKey: todayKey,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Supplement not found in your plan.' });
    }

    res.json({
      message: 'Supplement removed from your plan',
      supplementName,
    });
  } catch (error) {
    console.error('[dashboard POST /remove-supplement]', error.message);
    res.status(500).json({ message: 'Could not remove supplement. Please try again.' });
  }
});

// @route   GET /api/dashboard/my-plan
// @desc    Get user's personalized supplement plan (today's supplements)
// @access  Private
router.get('/my-plan', protect, async (req, res) => {
  try {
    // Get the latest assessment
    const latestAssessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 });

    if (!latestAssessment) {
      return res.json({ 
        supplements: [],
        message: 'No assessment found.',
      });
    }

    // Get today's supplements
    const todayKey = getTodayKey();
    const todaySupplements = await IntakeRecord.find({
      user: req.user._id,
      assessment: latestAssessment._id,
      dayKey: todayKey,
    });

    res.json({
      supplements: todaySupplements.map(rec => ({
        id: rec._id,
        name: rec.supplementName,
        dosage: rec.dosage,
        priority: rec.priority,
        scheduledTime: rec.scheduledTime,
        taken: rec.taken,
        takenAt: rec.takenAt,
      })),
    });
  } catch (error) {
    console.error('[dashboard GET /my-plan]', error.message);
    res.status(500).json({ message: 'Could not load your plan. Please try again.' });
  }
});

module.exports = router;
