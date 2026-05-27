const express = require('express');
const router = express.Router();
const Assessment = require('../models/Assessment');
const { protect } = require('../middleware/auth');

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
      medicalConditions, currentMedications, allergies, feelingDescription,
      lifestyleHabits, pregnancyStatus,
      takingSupplements, currentSupplements, recentBloodTest,
    } = req.body;

    // Validate numeric ranges
    if (age && (age < 1 || age > 120)) return res.status(400).json({ message: 'Age must be between 1 and 120.' });
    if (weight && (weight < 1 || weight > 500)) return res.status(400).json({ message: 'Weight must be between 1 and 500 kg.' });
    if (height && (height < 30 || height > 300)) return res.status(400).json({ message: 'Height must be between 30 and 300 cm.' });

    // Validate string field lengths (prevent oversized payloads)
    const TEXT_MAX = 1000;
    const SHORT_MAX = 200;
    if (currentMedications && currentMedications.length > TEXT_MAX)
      return res.status(400).json({ message: `Current medications must be ${TEXT_MAX} characters or fewer.` });
    if (allergies && allergies.length > SHORT_MAX)
      return res.status(400).json({ message: `Allergies must be ${SHORT_MAX} characters or fewer.` });
    if (feelingDescription && feelingDescription.length > TEXT_MAX)
      return res.status(400).json({ message: `Health description must be ${TEXT_MAX} characters or fewer.` });
    if (req.body.bloodTestResults && req.body.bloodTestResults.length > TEXT_MAX)
      return res.status(400).json({ message: `Blood test results must be ${TEXT_MAX} characters or fewer.` });
    if (currentSupplements && currentSupplements.length > SHORT_MAX)
      return res.status(400).json({ message: `Current supplements must be ${SHORT_MAX} characters or fewer.` });

    const assessment = await Assessment.create({
      user: req.user._id,
      userEmail: req.user.email,
      userName: req.user.name,
      age, gender, weight, height, activityLevel,
      dietType, healthGoals,
      symptoms, symptomSeverity, stressLevel, sleepQuality, waterIntake,
      medicalConditions, currentMedications, allergies, feelingDescription,
      lifestyleHabits, pregnancyStatus,
      takingSupplements, currentSupplements, recentBloodTest,
      bloodTestResults: req.body.bloodTestResults,
      sunExposure: req.body.sunExposure,
      fitnessFocus: req.body.fitnessFocus,
      proteinIntake: req.body.proteinIntake,
    });

    console.log('Assessment saved to DB, id:', assessment._id);
    res.status(201).json({ message: 'Assessment saved', assessment });
  } catch (error) {
    console.error('[assessment POST]', error.message);
    res.status(500).json({ message: 'Could not save your assessment. Please try again.' });
  }
});

// @route   GET /api/assessment/history
// @desc    Get all assessments for the current user (newest first)
// @access  Private
router.get('/history', protect, async (req, res) => {
  try {
    const assessments = await Assessment.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(20);
    res.json(assessments);
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
