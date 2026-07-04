const express = require('express');
const router = express.Router();
const Assessment = require('../models/Assessment');
const DashboardMetrics = require('../models/DashboardMetrics');
const { protect } = require('../middleware/auth');
const { sanitizeTextField, sanitizeShortField } = require('../utils/sanitize');

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

    // Validate numeric ranges
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
      expiresAt: new Date(Date.now() + 5 * 365.25 * 24 * 60 * 60 * 1000),
    });

    console.log('Assessment saved to DB, id:', assessment._id);
    
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
    res.status(201).json({ message: 'Assessment saved', assessment, garbageFields });
  } catch (error) {
    console.error('[assessment POST]', error.message);
    res.status(500).json({ message: 'Could not save your assessment. Please try again.' });
  }
});

// @route   GET /api/assessment/history
// @desc    Get all assessments for the current user (newest first, paginated)
// @access  Private
router.get('/history', protect, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
    const skip  = (page - 1) * limit;

    const [assessments, total] = await Promise.all([
      Assessment.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Assessment.countDocuments({ user: req.user._id }),
    ]);

    res.json({
      serverTime: new Date().toISOString(),
      assessments,
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

// @route   PATCH /api/assessment/:id/results
// @desc    Store AI results on an existing assessment
// @access  Private
router.patch('/:id/results', protect, async (req, res) => {
  try {
    const assessment = await Assessment.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { aiResults: req.body },
      { new: true }
    );
    if (!assessment) return res.status(404).json({ message: 'Assessment not found.' });
    res.json({ message: 'Results saved', assessment });
  } catch (error) {
    console.error('[assessment PATCH /:id/results]', error.message);
    res.status(500).json({ message: 'Could not save results. Please try again.' });
  }
});

// @route   DELETE /api/assessment/:id
// @desc    Delete an assessment
// @access  Private
router.delete('/:id', protect, async (req, res) => {
  try {
    const assessment = await Assessment.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!assessment) return res.status(404).json({ message: 'Assessment not found.' });
    res.json({ message: 'Assessment deleted' });
  } catch (error) {
    console.error('[assessment DELETE /:id]', error.message);
    res.status(500).json({ message: 'Could not delete the assessment. Please try again.' });
  }
});

module.exports = router;
