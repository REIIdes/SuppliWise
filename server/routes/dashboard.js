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
const { buildScheduleSlotIndex, resolveTimeSlot } = require('../utils/dailyScheduleSlots');
// `cleanTimeZone` is re-exported by intakeWindows from utils/planDay.js, which
// owns the one `Intl` reader in the server — so the day a record belongs to and
// the window it was due in are read by the same clock, from the same zone.
const { cleanTimeZone, evaluateToday } = require('../utils/intakeWindows');
const {
  getWellnessBaseline,
  calculateWellnessScore,
  penaltyForMisses,
  describeToday,
} = require('../utils/wellnessScore');
// One definition of "today" for every handler here, and one definition of which
// wall clock "today" is read on. Neither is duplicated in a route.
const {
  planDayKey,
  previousDayKey,
  shiftDayKey,
  recentPlanDayKeys,
  minutesToNextReset,
  isInDeadHours,
  PLAN_DAY_RESET_LABEL,
} = require('../utils/planDay');

// Coerce any JSON value to a plain string for DB equality filters.
// Objects (e.g. {"$ne": "x"}) would otherwise become NoSQL operators and
// match/delete the wrong records — String() neutralizes them to literals.
const str = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));
// Strip any HTML/markup first (defense-in-depth: React escapes on render, but
// the API must never persist or echo raw markup back to a client).
const cleanSupplementName = (value) => str(value).replace(/<[^>]*>/g, '').trim().slice(0, 200);

/**
 * The running PLAN DAY as YYYY-MM-DD — 04:00 to 04:00 in the user's own zone.
 *
 * It used to be `new Date().toISOString().split('T')[0]`, which is the UTC
 * calendar date. That rolls over at 00:00 UTC — 8:00 AM in Manila, 7:00 PM the
 * previous evening in Los Angeles — so a plan was displayed for four hours after
 * the reset it was meant to have, and the edits that display invited were refused
 * ("only today's supplements"), because the read and the gate were on different
 * days. See utils/planDay.js for the rule and why the boundary is 4 AM.
 *
 * Every caller must pass the same `timeZone` it is about to filter and score
 * with; see `timezoneFor`.
 */
const getTodayKey = (timeZone = '', now = new Date()) => planDayKey(now, timeZone);

// Helper: Calculate adherence percentage
const calculateAdherence = (taken, total) => {
  if (total === 0) return 0;
  return Math.round((taken / total) * 100);
};

/**
 * The user's IANA timezone, for judging when a dose's time window closes.
 *
 * ORDER OF TRUST
 *   1. `X-Client-Timezone`, sent by api.js on every request from
 *      `Intl.DateTimeFormat().resolvedOptions().timeZone`. This is the user's
 *      actual clock, and it is what makes the penalty land at noon rather than
 *      at midnight for anyone east or west of UTC.
 *   2. `user.timeZone`, the last value the browser reported and the server
 *      stored, for requests that carry no header (background jobs, Web3 reads).
 *   3. UTC, the historical behaviour.
 *
 * WHY THE "ALREADY EQUALS" TEST IS IN THE FILTER
 * The write happens on every dashboard call that carries a zone, so it is made a
 * no-op in the DATABASE — not in this function — by putting the comparison in the
 * query. Deciding it in JS instead would depend on `req.user` still holding the
 * value we just wrote, which only survives as long as the 30s session cache does;
 * a request that re-reads the user from Mongo would rewrite the same string on
 * every poll. Same throttle as `heartbeatAdmin`.
 *
 * The header is used either way. The write is bookkeeping, not a precondition for
 * scoring, and its failure is swallowed — a timezone is not worth failing a
 * dashboard load over.
 */
const timezoneFor = async (req) => {
  const header = cleanTimeZone(req.get('x-client-timezone'));
  const stored = cleanTimeZone(req.user && req.user.timeZone);

  if (header && header !== stored) {
    try {
      const User = require('../models/User');
      await User.updateOne(
        { _id: req.user._id, $or: [{ timeZone: { $ne: header } }, { timeZone: { $exists: false } }] },
        { $set: { timeZone: header } },
      );
    } catch (error) {
      console.error('[dashboard] could not store time zone:', error.message);
    }
    // This request is scored in the reported zone regardless of the write.
    if (req.user) req.user.timeZone = header;
  }
  return header || stored || 'UTC';
};

/**
 * Everything the wellness score needs about today, from one place.
 *
 * `finalizeIntakeChange` and `GET /` used to score the day themselves, which is
 * how two readers of the same number drifted. One function, one rule: a dose
 * counts against the user only once its window has closed, and a dose ticked
 * late counts in full. See utils/intakeWindows.js for the rule and
 * utils/wellnessScore.js for the arithmetic.
 *
 * @param {Array} records Today's intake records (lean or hydrated).
 * @param {{now?: Date, timeZone?: string}} [options]
 */
const scoreToday = (records, { now = new Date(), timeZone = 'UTC' } = {}) =>
  evaluateToday(records, { now, timeZone });

/**
 * The `stats.wellnessToday` block: today's progress split by the rule, plus the
 * exact number of points the misses are costing. Derived from the same
 * `calculateWellnessScore` the persisted score comes from, so the explanation can
 * never drift from the number it explains.
 */
const buildWellnessToday = (today, { baseline, overallAdherence, streak }) => ({
  ...describeToday(today),
  penaltyPoints: penaltyForMisses({ baseline, overallAdherence, streak, today }).points,
});

/**
 * "Mon", "Tue", … for a YYYY-MM-DD key.
 *
 * Read off the key with a UTC cursor so the label cannot drift a day from the
 * column it names — the alternative, `new Date(key).toLocaleDateString()`, is
 * parsed as UTC midnight and then formatted in the HOST's zone, which is a
 * different weekday west of Greenwich.
 */
const weekdayName = (dayKey) => {
  const [y, m, d] = str(dayKey).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
  const cursor = new Date(0);
  cursor.setUTCFullYear(y, m - 1, d);
  if (cursor.getUTCMonth() !== m - 1 || cursor.getUTCDate() !== d) return '';
  return cursor.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
};

/**
 * The `planDay` block every dashboard endpoint returns.
 *
 * WHY IT IS IN THE PAYLOAD RATHER THAN ONLY BEING USED
 * The client has its own copy of the 4 AM rule (my-react-app/src/utils/planDay.js,
 * to draw the reset without waiting on the API), and two copies of one boundary
 * drift. Handing it the server's answer — the key it actually used, and when the
 * next reset lands — lets the page follow the server instead of re-deriving it.
 */
const planDayPayload = (now = new Date(), timeZone = 'UTC') => ({
  todayKey: planDayKey(now, timeZone),
  resetAt: PLAN_DAY_RESET_LABEL,
  nextResetInMinutes: minutesToNextReset(now, timeZone),
  inDeadHours: isInDeadHours(now, timeZone),
  timeZone: cleanTimeZone(timeZone) || 'UTC',
});

/**
 * Validate and reset the streak if the previous day was missed.
 *
 * `todayKey` is passed in rather than recomputed, so this watches for the
 * rollover at exactly the boundary the rest of the request used. It used to build
 * its own UTC date, which meant the streak was decided against a day the user
 * could not see, and a page left open across the boundary kept yesterday's streak.
 */
const validateStreak = async (metrics, todayKey) => {
  // Check if we crossed into a new day
  if (metrics.lastTrackedDate && metrics.lastTrackedDate !== todayKey) {
    // New day has started - evaluate yesterday's completion
    
    if (metrics.lastCompletedDay === metrics.lastTrackedDate) {
      // Yesterday finished with 100% completion - keep streak
      metrics.streakAwardedToday = false; // Reset for new day
    } else {
      // Yesterday finished incomplete - reset streak
      metrics.currentStreak = 0;
      metrics.streakAwardedToday = false;
      metrics.lastCompletedDay = null;
    }

    // ADVANCE THE POINTER — in BOTH branches.
    //
    // It used to advance only on the break branch, so a finished day left
    // `lastTrackedDate` on the old key. `lastTrackedDate` IS the guard that stops
    // the rollover re-running (see `finalizeIntakeChange`, which relies on the
    // same pointer), so a kept streak made every subsequent dashboard load decide
    // the same day again — awarding or revoking against a day long past.
    metrics.lastTrackedDate = todayKey;
    await metrics.save();
  }
  
  return metrics.currentStreak;
};

/**
 * Recompute today's progress and persist everything that depends on it
 * (adherence, streak, wellness score and the priority flag lifecycle) after one
 * or more intake records changed.
 *
 * This used to live inline inside POST /intake, which meant the bulk endpoint
 * could only have been written by copying ~180 lines of streak/priority
 * bookkeeping — and the priority auto-lift has to fire on exactly the change
 * that completes the day, so a copy that drifted by one branch would award or
 * revoke the review without the plan actually being complete. One function, one
 * copy of the rules, called by both endpoints.
 *
 * @returns {Promise<{priorityLifted: boolean, priorityReflagged: boolean, stats: object|null}>}
 *   `stats` is null when the user has no metrics row for this assessment, which
 *   is the only case where there is nothing to write.
 */
const finalizeIntakeChange = async (req, assessmentId, planDay = {}) => {
  // One clock and one timezone for the whole recompute. Two `new Date()`s a few
  // lines apart could straddle a window boundary — or the 4 AM reset — and score
  // the same press two different ways. The caller resolves the day once and hands
  // it in, so the streak, the records read and the score cannot disagree.
  const { now = new Date(), timeZone = 'UTC', todayKey = '' } = planDay;

  // Update metrics — independent reads run in parallel
  const [todayRecords, metrics, totals, assessmentDoc] = await Promise.all([
    // `timeSlot` / `scheduledTime` are the addition to the old `taken`-only
    // projection: "is this dose missed?" is decided by whether its window has
    // closed (utils/intakeWindows.js), and the wellness score below depends on it.
    IntakeRecord.find({ user: req.user._id, assessment: assessmentId, dayKey: todayKey })
      .select('taken timeSlot scheduledTime supplementName')
      .lean(),
    DashboardMetrics.findOne({ user: req.user._id, assessment: assessmentId }),
    Promise.all([
      IntakeRecord.countDocuments({ user: req.user._id, assessment: assessmentId }),
      IntakeRecord.countDocuments({ user: req.user._id, assessment: assessmentId, taken: true }),
    ]),
    // Only the slices needed downstream (wellness baseline + priority state)
    Assessment.findById(assessmentId).select('aiResults.wellnessBaseline priority resolvedReason').lean(),
  ]);

  const totalToday = todayRecords.length;
  const takenToday = todayRecords.filter(r => r.taken).length;
  const todayAdherence = calculateAdherence(takenToday, totalToday);

  // Overall adherence via counted aggregation (no full-history load)
  const [totalAll, takenAll] = totals;
  const overallAdherence = calculateAdherence(takenAll, totalAll);

  if (!metrics) {
    return { priorityLifted: false, priorityReflagged: false, stats: null };
  }

  // The window-aware view of today: `missed` is the only figure that costs
  // points, and `awaiting` is those same rows one moment before they do.
  const wellnessToday = scoreToday(todayRecords, { now, timeZone });

  const today = todayKey;

  // RESET CHECK: Evaluate if we crossed into a new plan day
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
      await Assessment.findByIdAndUpdate(assessmentId, {
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
        assessmentId,
      }).catch(() => {});
      await AdminEvent.create({
        type: 'resolved',
        title: 'Priority auto-resolved (intake complete)',
        detail: `User ${req.user._id} completed all of today\u2019s supplements for assessment ${assessmentId}. Flag lifted automatically.`,
        user: req.user._id,
        assessmentId,
        linkUserId: req.user._id,
      }).catch(() => {});
    } catch (liftError) {
      console.error('[dashboard intake] priority auto-lift failed:', liftError.message);
    }
  } else if (priorityEntitled && !completedNow && assessmentDoc && assessmentDoc.priority === 'Standard' && assessmentDoc.resolvedReason === 'intake-complete') {
    // Strict gate: undoing after an auto-lift breaks 100% completion,
    // so the restriction comes back. Admin-resolved flags are never touched.
    try {
      await Assessment.findByIdAndUpdate(assessmentId, {
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
        assessmentId,
      }).catch(() => {});
      await AdminEvent.create({
        type: 'severe-flag',
        title: 'Priority re-flagged (intake undone)',
        detail: `User ${req.user._id} undid a supplement for assessment ${assessmentId} after auto-resolve. Restriction reinstated.`,
        user: req.user._id,
        assessmentId,
        linkUserId: req.user._id,
      }).catch(() => {});
    } catch (reflagError) {
      console.error('[dashboard intake] priority re-flag failed:', reflagError.message);
    }
  }

  // Wellness baseline from the already-fetched assessment slice
  const wellnessBaseline = getWellnessBaseline(assessmentDoc);

  metrics.wellnessScore = calculateWellnessScore({
    baseline: wellnessBaseline,
    overallAdherence,
    todayAdherence: wellnessToday.adherence,
    streak: metrics.currentStreak,
  });
  await metrics.save();

  return {
    priorityLifted,
    priorityReflagged,
    stats: {
      todaysProgress: {
        taken: takenToday,
        total: totalToday,
        percentage: todayAdherence,
      },
      overallAdherence: metrics.overallAdherence,
      daysStreak: metrics.currentStreak,
      wellnessScore: metrics.wellnessScore,
      wellnessToday: buildWellnessToday(wellnessToday, {
        baseline: wellnessBaseline,
        overallAdherence: metrics.overallAdherence,
        streak: metrics.currentStreak,
      }),
    },
  };
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

    // One clock, one timezone and one plan day for the whole response — see
    // finalizeIntakeChange. Everything below filters and scores with these three.
    const now = new Date();
    const timeZone = await timezoneFor(req);
    const todayKey = getTodayKey(timeZone, now);

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
        planDay: planDayPayload(now, timeZone),
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
          wellnessToday: {
            total: 0,
            taken: 0,
            missed: 0,
            awaiting: 0,
            decided: 0,
            adherence: 100,
            penaltyPoints: 0,
          },
        },
        insights: null,
      });
    }

    // Metrics + today's records are independent — fetch in parallel (Atlas RTT ~0.5s each)
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

    // Validate streak on page load - reset if previous day was missed.
    // The day is handed in rather than recomputed, so the rollover is judged
    // against exactly the day whose records were just read.
    const validatedStreak = await validateStreak(metrics, todayKey);

    // Get today's supplements from assessment recommendations
    const recommendations = latestAssessment.aiResults?.recommendations || [];
    const dailySchedule = latestAssessment.aiResults?.dailySchedule || [];

    // Morning / Afternoon / Evening buckets, taken from the AI daily schedule
    // (the same grouping the results page renders) so the tracker and the
    // results page can never disagree about which stack a supplement belongs to.
    const scheduleSlotIndex = buildScheduleSlotIndex(dailySchedule);

    // Daily plan snapshot: on the first load of a day with an empty plan,
    // seed today's records from the AI recommendations so the day always
    // lists what needed to be taken. Untouched days automatically read as
    // MISSED (red) in the calendar and day-detail views.
    if (todayIntakeRecords.length === 0 && recommendations.length > 0) {
      const seeds = recommendations.slice(0, 20)
        .map(rec => {
          const name = rec.name || rec.supplement;
          // Schedule time first, recommendation timing second — same order the
          // response mapping below uses, so a record never drifts from its card.
          const slot = resolveTimeSlot({ name, timing: rec.timing }, scheduleSlotIndex);
          return {
            user: req.user._id,
            assessment: latestAssessment._id,
            supplementName: name,
            dosage: rec.dosage || '',
            priority: ['High', 'Medium', 'Low'].includes(rec.priority) ? rec.priority : 'Medium',
            scheduledTime: slot.timeLabel || rec.timing || 'Anytime',
            // Stored, not just derived: the wellness score needs to know when this
            // dose's window closes, and re-deriving it from the schedule on every
            // read is a fuzzy name match per row per request. Rows seeded before
            // this field existed fall back to parsing `scheduledTime`.
            timeSlot: slot.key,
            taken: false,
            date: new Date(),
            dayKey: todayKey,
          };
        })
        .filter(doc => doc.supplementName);
      if (seeds.length > 0) {
        // Bulk upsert: one round-trip instead of N (was a major bottleneck
        // for users with 15+ supplements — each upsert was a separate DB call)
        await IntakeRecord.bulkWrite(
          seeds.map(doc => ({
            updateOne: {
              filter: { user: doc.user, assessment: doc.assessment, supplementName: doc.supplementName, dayKey: doc.dayKey },
              update: { $setOnInsert: doc },
              upsert: true,
            },
          })),
          { ordered: false } // continue on error — one failure shouldn't block the rest
        );
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

    // The window-aware view of today, judged in the user's own timezone. `now`
    // and `timeZone` come from the top of the handler so the whole response is
    // scored against one clock.
    const wellnessToday = scoreToday(todayIntakeRecords, { now, timeZone });

    // Update wellness score
    const wellnessScore = calculateWellnessScore({
      baseline: wellnessBaseline,
      overallAdherence: metrics.overallAdherence,
      todayAdherence: wellnessToday.adherence,
      streak: validatedStreak,
    });

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
      planDay: planDayPayload(now, timeZone),
      todaysSupplements: todayIntakeRecords.map(rec => {
        const timing = timingMap[rec.supplementName] || rec.scheduledTime || 'Anytime';
        const slot = resolveTimeSlot({ name: rec.supplementName, timing }, scheduleSlotIndex);
        return {
          id: rec._id,
          name: rec.supplementName,
          dosage: rec.dosage,
          priority: priorityMap[rec.supplementName] || rec.priority || 'Medium', // Use recommendation priority first
          scheduledTime: timing, // Use recommendation timing first
          // Grouping for the tracker: which part of the day this belongs to.
          timeSlot: slot.key,
          timeSlotLabel: slot.label,
          timeSlotOrder: slot.order,
          scheduleTime: slot.timeLabel,
          taken: rec.taken,
          takenAt: rec.takenAt,
        };
      }),
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
        // The sync the score is reading: how many of today's doses are ticked,
        // how many closed unticked (and are costing points), and how many are
        // still takeable on time (and are costing nothing yet).
        wellnessToday: buildWellnessToday(wellnessToday, {
          baseline: wellnessBaseline,
          overallAdherence: metrics.overallAdherence,
          streak: validatedStreak,
        }),
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

    // History is read-only: only the running plan day can change. This protects
    // streak integrity and the priority lift/reflag lifecycle from back-dated edits.
    //
    // Gated on the SAME plan day `GET /` served the row under. It used to compute
    // its own UTC date, so between 00:00 and 04:00 UTC — 8:00 AM in Manila — the
    // page showed yesterday's doses and then refused the user for ticking one.
    const now = new Date();
    const timeZone = await timezoneFor(req);
    const todayKey = getTodayKey(timeZone, now);
    if (record.dayKey !== todayKey) {
      return res.status(400).json({ message: 'Only today\u2019s supplements can be updated. Past days are read-only history.' });
    }

    record.taken = taken;
    record.takenAt = taken ? new Date() : null;
    await record.save();

    const outcome = await finalizeIntakeChange(req, record.assessment, { now, timeZone, todayKey });

    res.json({
      planDay: planDayPayload(now, timeZone),
      message: 'Intake updated',
      record: {
        id: record._id,
        taken: record.taken,
        takenAt: record.takenAt,
      },
      ...outcome,
    });
  } catch (error) {
    console.error('[dashboard POST /intake]', error.message);
    res.status(500).json({ message: 'Could not update intake. Please try again.' });
  }
});

// @route   POST /api/dashboard/intake/bulk
// @desc    Mark a whole time slot (Morning / Afternoon / Evening) taken in one press
// @access  Private
router.post('/intake/bulk', protect, async (req, res) => {
  try {
    const { recordIds, taken } = req.body;

    if (!Array.isArray(recordIds) || recordIds.length === 0) {
      return res.status(400).json({ message: 'Choose at least one supplement to update.' });
    }
    if (typeof taken !== 'boolean') {
      return res.status(400).json({ message: 'Taken status is required.' });
    }
    // A slot is at most a handful of rows; anything larger is a client bug, and
    // an unbounded $in is the sort of thing that quietly times out.
    if (recordIds.length > 60) {
      return res.status(400).json({ message: 'Too many supplements in one update.' });
    }

    // Reject non-ObjectId values before they reach the $in filter (CastError → 500)
    const ids = [...new Set(recordIds.filter(id => typeof id === 'string' && mongoose.isValidObjectId(id)))];
    if (ids.length === 0) {
      return res.status(400).json({ message: 'No valid supplements to update.' });
    }

    // The SAME plan day the single-record endpoint and `GET /` use — see the note
    // there. A bulk press gated on a different day than the row it was offered
    // for is the bug this closes.
    const now = new Date();
    const timeZone = await timezoneFor(req);
    const todayKey = getTodayKey(timeZone, now);
    const records = await IntakeRecord.find({
      _id: { $in: ids },
      user: req.user._id,
    }).select('_id assessment dayKey').lean();

    if (records.length === 0) {
      return res.status(404).json({ message: 'Intake records not found.' });
    }

    // One plan per request: the metrics recompute below is per assessment, so a
    // mixed batch would silently report only the first plan's numbers.
    const assessments = new Set(records.map(rec => String(rec.assessment)));
    if (assessments.size > 1) {
      return res.status(400).json({ message: 'Those supplements come from different plans. Refresh and try again.' });
    }

    // History is read-only, exactly as for the single-record endpoint.
    const todayRecords = records.filter(rec => rec.dayKey === todayKey);
    if (todayRecords.length === 0) {
      return res.status(400).json({ message: 'Only today\u2019s supplements can be updated. Past days are read-only history.' });
    }

    const takenAt = taken ? new Date() : null;
    await IntakeRecord.updateMany(
      { _id: { $in: todayRecords.map(rec => rec._id) } },
      { $set: { taken, takenAt } }
    );

    const outcome = await finalizeIntakeChange(req, todayRecords[0].assessment, { now, timeZone, todayKey });

    res.json({
      planDay: planDayPayload(now, timeZone),
      message: taken ? 'Supplements marked as taken' : 'Supplements marked as not taken',
      updated: todayRecords.length,
      skipped: records.length - todayRecords.length,
      ...outcome,
    });
  } catch (error) {
    console.error('[dashboard POST /intake/bulk]', error.message);
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

    // Wellness score is baseline + adherence + streak only. Today's term still
    // needs the window-aware split, so energy cannot be allowed to score a day it
    // knows nothing about.
    const timeZone = await timezoneFor(req);
    const now = new Date();
    const todayRecords = await IntakeRecord.find({
      user: req.user._id,
      assessment: latestAssessment._id,
      dayKey: getTodayKey(timeZone, now),
    }).select('taken timeSlot scheduledTime').lean();
    const today = scoreToday(todayRecords, { now, timeZone });
    const wellnessBaseline = getWellnessBaseline(latestAssessment);
    metrics.wellnessScore = calculateWellnessScore({
      baseline: wellnessBaseline,
      overallAdherence: metrics.overallAdherence,
      todayAdherence: today.adherence,
      streak: metrics.currentStreak,
    });
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

    // "Future" means after the RUNNING plan day, not after the UTC date. The
    // calendar asks for this the moment a day is clicked, and it used to be
    // handed 400 for the day the user was actually looking at whenever their
    // clock was behind UTC's.
    const now = new Date();
    const timeZone = await timezoneFor(req);
    const todayKey = getTodayKey(timeZone, now);
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
      isToday: dayKey === todayKey,
      planDay: planDayPayload(now, timeZone),
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
    const now = new Date();
    const timeZone = await timezoneFor(req);
    // Clamped in the USER's year, not the server's — a user east of UTC is already
    // on tomorrow's date while the server is still on today's, and refusing their
    // December because the host is in November would be indefensible.
    const currentYear = Number(planDayKey(now, timeZone).slice(0, 4));

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

    // Month bounds as plain calendar arithmetic.
    //
    // They were `new Date(y, m, 0).toISOString().split('T')[0]`, which converts
    // local midnight to UTC — so on a host east of Greenwich the last day came back
    // as the PREVIOUS date and the calendar silently stopped a day early. Both
    // keys are formatted from numbers, so no zone can move them.
    const daysInMonth = new Date(Date.UTC(yearNum, monthNum, 0)).getUTCDate();
    const pad = (n) => String(n).padStart(2, '0');
    const key = (d) => `${yearNum}-${pad(monthNum)}-${pad(d)}`;
    const startKey = key(1);
    const endKey = key(daysInMonth);

    if (!latestAssessment) {
      return res.json({
        completionData: {},
        month: { year: yearNum, month: monthNum, daysInMonth, startKey, endKey },
        planDay: planDayPayload(now, timeZone),
      });
    }

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

    res.json({
      completionData: result,
      // The month's shape and the running day are both returned, so the client
      // highlights from the server's answer instead of its own calendar cursor —
      // which is how it used to end up marking a day the server had never heard of.
      month: { year: yearNum, month: monthNum, daysInMonth, startKey, endKey },
      planDay: planDayPayload(now, timeZone),
    });
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

    const now = new Date();
    const timeZone = await timezoneFor(req);
    const todayKey = getTodayKey(timeZone, now);

    if (!latestAssessment) {
      return res.json({ weeklyDays: [], overallAdherence: 0, planDay: planDayPayload(now, timeZone) });
    }

    // The last 7 PLAN days, oldest first, ending on the running one.
    //
    // It used to walk the UTC calendar backwards from `new Date()`, so for anyone
    // east of UTC the newest column was always yesterday and the day the user was
    // living — the one with their doses in it — appeared nowhere on the chart.
    const keys = recentPlanDayKeys(7, now, timeZone);
    const dayKeys = keys.map((dayKey) => ({
      dayKey,
      // The weekday label is read off the key itself, not off a Date, so it cannot
      // drift a day from the column it names.
      dayName: weekdayName(dayKey),
    }));

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
        // Which column is the running day. The client used to decide this from its
        // own cursor, which is how a column could be highlighted while the server
        // was serving a different day.
        isToday: dayKey === todayKey,
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
      planDay: planDayPayload(now, timeZone),
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
    const now = new Date();
    const timeZone = await timezoneFor(req);
    const todayKey = getTodayKey(timeZone, now);
    const existingRecord = await IntakeRecord.findOne({
      user: req.user._id,
      assessment: latestAssessment._id,
      supplementName: name,
      dayKey: todayKey,
    });

    if (existingRecord) {
      return res.status(400).json({ message: 'This supplement is already in your plan for today.' });
    }

    // Create new intake record for today.
    // The slot is resolved the same way the daily-plan seeder resolves it, so a
    // hand-added dose is judged by the same window as every other row — and so
    // the score can decide whether it has been missed yet.
    const addedSlot = resolveTimeSlot(
      { name, timing: safeTiming },
      buildScheduleSlotIndex(latestAssessment.aiResults?.dailySchedule || [])
    );
    const newRecord = await IntakeRecord.create({
      user: req.user._id,
      assessment: latestAssessment._id,
      supplementName: name,
      dosage: safeDosage,
      priority: safePriority,
      scheduledTime: safeTiming || 'Anytime',
      timeSlot: addedSlot.key,
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
      // Named `windowedToday` because `today` in this block is the dayKey string.
      const windowedToday = scoreToday(todayRecords, { now, timeZone });
      metrics.wellnessScore = calculateWellnessScore({
        baseline: wellnessBaseline,
        overallAdherence: metrics.overallAdherence,
        todayAdherence: windowedToday.adherence,
        streak: metrics.currentStreak,
      });

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
    const timeZone = await timezoneFor(req);
    const todayKey = getTodayKey(timeZone);
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
    const now = new Date();
    const timeZone = await timezoneFor(req);

    // Get the latest assessment
    const latestAssessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 });

    if (!latestAssessment) {
      return res.json({
        supplements: [],
        message: 'No assessment found.',
        planDay: planDayPayload(now, timeZone),
      });
    }

    // Get today's supplements
    const todayKey = getTodayKey(timeZone, now);
    const todaySupplements = await IntakeRecord.find({
      user: req.user._id,
      assessment: latestAssessment._id,
      dayKey: todayKey,
    });

    // Same Morning/Afternoon/Evening buckets the dashboard returns, so both
    // readers of "the plan" group identically.
    const scheduleSlotIndex = buildScheduleSlotIndex(latestAssessment.aiResults?.dailySchedule || []);

    res.json({
      planDay: planDayPayload(now, timeZone),
      supplements: todaySupplements.map(rec => {
        const slot = resolveTimeSlot({ name: rec.supplementName, timing: rec.scheduledTime }, scheduleSlotIndex);
        return {
          id: rec._id,
          name: rec.supplementName,
          dosage: rec.dosage,
          priority: rec.priority,
          scheduledTime: rec.scheduledTime,
          timeSlot: slot.key,
          timeSlotLabel: slot.label,
          timeSlotOrder: slot.order,
          scheduleTime: slot.timeLabel,
          taken: rec.taken,
          takenAt: rec.takenAt,
        };
      }),
    });
  } catch (error) {
    console.error('[dashboard GET /my-plan]', error.message);
    res.status(500).json({ message: 'Could not load your plan. Please try again.' });
  }
});

// @route   GET /api/dashboard/current-supplements
// @desc    What the user is already taking, to pre-fill the assessment's
//          "Currently Taking Supplements?" question
// @access  Private
//
// WHY THIS IS A READ, NOT A WRITE
// A returning user retaking the assessment has to answer "are you taking any
// supplements?" about themselves, and the honest answer is already in the
// database: the plan they are tracking right now. Re-typing it is both tedious
// and a source of silent drift — a user who answers "No" here while their
// dashboard shows five supplements in the morning stack gets recommendations
// that contradict the plan they are actually following.
//
// WHAT COUNTS AS "TAKING SOMETHING"
// Two independent signals, either of which is enough:
//   1. a supplement ticked as taken today — the strongest, they demonstrably
//      did it today;
//   2. any supplement on today's plan at all — they were prescribed it, even
//      if today's tick is still outstanding.
//
// Both are read from IntakeRecords rather than from the assessment's own
// `takingSupplements` answer, because that answer is what we are trying to
// pre-fill and copying it back would only ever echo a stale value.
router.get('/current-supplements', protect, async (req, res) => {
  try {
    const latestAssessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 })
      .select('_id aiResults.recommendations');

    if (!latestAssessment) {
      // No assessment yet: nothing to detect, and the client leaves the
      // question blank for the user to answer.
      return res.json({ hasPlan: false, takingSupplements: false, supplements: [], takenCount: 0 });
    }

    const now = new Date();
    const timeZone = await timezoneFor(req);
    // The RUNNING plan day, so a tick the user just made is visible here. Reading a
    // UTC day instead made the answer disagree with the dashboard by up to four
    // hours, and this endpoint's whole job is to describe what they are taking.
    const todayKey = getTodayKey(timeZone, now);
    const records = await IntakeRecord.find({
      user: req.user._id,
      assessment: latestAssessment._id,
      dayKey: todayKey,
    }).select('supplementName dosage taken').lean();

    const takenCount = records.filter(rec => rec.taken).length;

    // Names from the plan the user is tracking; fall back to the assessment's
    // recommendations so a plan that was never opened still counts.
    const names = records
      .map(rec => str(rec.supplementName).trim())
      .filter(Boolean);
    if (names.length === 0) {
      for (const rec of (latestAssessment.aiResults?.recommendations || []).slice(0, 20)) {
        const name = str(rec && (rec.name || rec.supplement)).trim();
        if (name && !names.includes(name)) names.push(name);
      }
    }

    res.json({
      hasPlan: names.length > 0,
      takingSupplements: names.length > 0,
      supplements: names.slice(0, 20),
      takenCount,
    });
  } catch (error) {
    console.error('[dashboard GET /current-supplements]', error.message);
    res.status(500).json({ message: 'Could not load your current supplements.' });
  }
});

module.exports = router;
