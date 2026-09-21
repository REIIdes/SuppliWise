const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requirePlan } = require('../utils/plan');
const Assessment = require('../models/Assessment');
const IntakeRecord = require('../models/IntakeRecord');
const DashboardMetrics = require('../models/DashboardMetrics');
const { notExpiredFilter } = require('../utils/assessments');

// Helper: Get date range for queries
const getDateRange = (days) => {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  return { startDate, endDate };
};

// Helper: Format date to YYYY-MM-DD
const formatDate = (date) => {
  return date.toISOString().split('T')[0];
};

// @route   GET /api/insights
// @desc    Get AI insights and tracking data for the active assessment
// @access  Private (Deluxe Package and above)
// Insights & Analytics is a paid perk — free-tier users are stopped here
// with a 403 + requiresPlan payload so the client can show an upgrade prompt.
router.get('/', protect, requirePlan('monthly'), async (req, res) => {
  try {
    // Latest assessment still in force (expired ones are retired from insights)
    const latestAssessment = await Assessment.findOne({ user: req.user._id, ...notExpiredFilter() })
      .sort({ createdAt: -1 });

    if (!latestAssessment) {
      return res.json({ 
        message: 'No assessment found. Please complete an assessment first.',
        hasData: false,
        hasAssessment: false,
      });
    }

    // Independent reads run in parallel (Atlas RTT ~0.5s each — sequential was ~2.5s)
    const { startDate } = getDateRange(30);
    const todayKey = formatDate(new Date());
    const [metrics, intakeRecords, todayIntakeRecords, totalAssessments] = await Promise.all([
      DashboardMetrics.findOne({ user: req.user._id, assessment: latestAssessment._id }).lean(),
      // Last 30 days only, lean + minimal fields
      IntakeRecord.find({ user: req.user._id, assessment: latestAssessment._id, date: { $gte: startDate } })
        .select('date taken')
        .sort({ date: 1 })
        .lean(),
      IntakeRecord.find({ user: req.user._id, assessment: latestAssessment._id, dayKey: todayKey }).lean(),
      Assessment.countDocuments({ user: req.user._id }),
    ]);

    if (!metrics) {
      return res.json({
        hasData: false,
        hasAssessment: true,
        message: 'Not enough tracking data yet. Start tracking your supplements to see insights.',
      });
    }

    // Calculate daily adherence
    const dailyAdherence = {};
    intakeRecords.forEach(record => {
      const day = formatDate(record.date);
      if (!dailyAdherence[day]) {
        dailyAdherence[day] = { total: 0, taken: 0 };
      }
      dailyAdherence[day].total += 1;
      if (record.taken) dailyAdherence[day].taken += 1;
    });

    const adherenceTrends = Object.keys(dailyAdherence)
      .sort()
      .slice(-7) // Last 7 days
      .map(day => ({
        date: day,
        percentage: Math.round((dailyAdherence[day].taken / dailyAdherence[day].total) * 100),
        taken: dailyAdherence[day].taken,
        total: dailyAdherence[day].total,
      }));

    // Get AI insights from assessment
    const aiInsights = latestAssessment.aiResults?.actionPlan || [];
    const lifestyleAdvice = latestAssessment.aiResults?.lifestyleAdvice || [];

    // Get today's supplements (already fetched above)
    const recommendations = latestAssessment.aiResults?.recommendations || [];

    // Don't automatically create records - user must add supplements manually from recommendations

    const todaysSupplements = todayIntakeRecords.map(rec => ({
      id: rec._id,
      name: rec.supplementName,
      dosage: rec.dosage,
      scheduledTime: rec.scheduledTime,
      taken: rec.taken,
      takenAt: rec.takenAt,
    }));

    // Calculate days since assessment
    const daysSinceStart = Math.floor(
      (new Date() - new Date(latestAssessment.createdAt)) / (1000 * 60 * 60 * 24)
    );

    // Determine current phase based on days
    let currentPhase = null;
    if (daysSinceStart < 7) {
      currentPhase = aiInsights.find(p => p.phase?.includes('Week 1'));
    } else if (daysSinceStart < 14) {
      currentPhase = aiInsights.find(p => p.phase?.includes('Week 2'));
    } else if (daysSinceStart < 30) {
      currentPhase = aiInsights.find(p => p.phase?.includes('Week 3-4') || p.phase?.includes('Weeks 3-4'));
    } else if (daysSinceStart < 60) {
      currentPhase = aiInsights.find(p => p.phase?.includes('Month 2'));
    } else {
      currentPhase = aiInsights.find(p => p.phase?.includes('Month 3+'));
    }

    // Response
    res.json({
      hasData: true,
      hasAssessment: true,
      overview: {
        daysTracked: metrics.totalDaysTracked || daysSinceStart,
        currentStreak: metrics.currentStreak,
        longestStreak: metrics.longestStreak,
        overallAdherence: metrics.overallAdherence,
        wellnessScore: metrics.wellnessScore,
        energyLevel: metrics.energyLevel,
        assessmentsCompleted: totalAssessments,
      },
      adherenceTrends,
      todaysSupplements,
      currentPhase: currentPhase ? {
        phase: currentPhase.phase,
        focus: currentPhase.focus,
        steps: currentPhase.steps,
        expectedChanges: currentPhase.expectedChanges,
      } : null,
      allPhases: aiInsights.map(p => ({
        phase: p.phase,
        focus: p.focus,
      })),
      lifestyleAdvice: lifestyleAdvice.map(advice => ({
        category: advice.category,
        advice: advice.advice,
      })),
      assessmentSummary: latestAssessment.aiResults?.simplifiedSummary || latestAssessment.aiResults?.summary || '',
    });
  } catch (error) {
    console.error('[insights GET]', error.message);
    res.status(500).json({ message: 'Could not load insights. Please try again.' });
  }
});

module.exports = router;
