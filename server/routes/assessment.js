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
    if (age && (age < 1 || age > 120)) return res.status(400).json({ message: 'Age must be between 1 and 120' });
    if (weight && (weight < 1 || weight > 500)) return res.status(400).json({ message: 'Weight must be between 1 and 500 kg' });
    if (height && (height < 30 || height > 300)) return res.status(400).json({ message: 'Height must be between 30 and 300 cm' });

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
    console.error('Assessment save error:', error.message, error.stack);
    res.status(500).json({ message: 'Server error', error: error.message });
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
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /api/assessment/me
// @desc    Get the current user's latest assessment
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    const assessment = await Assessment.findOne({ user: req.user._id }).sort({ createdAt: -1 });
    if (!assessment) return res.status(404).json({ message: 'No assessment found' });
    res.json(assessment);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
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
    if (!assessment) return res.status(404).json({ message: 'Assessment not found' });
    res.json({ message: 'Results saved', assessment });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
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
    if (!assessment) return res.status(404).json({ message: 'Assessment not found' });
    res.json({ message: 'Assessment deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
