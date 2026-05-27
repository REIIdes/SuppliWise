const express = require('express');
const router = express.Router();
const Assessment = require('../models/Assessment');
const { protect } = require('../middleware/auth');
const { sanitizeTextField, sanitizeShortField, isGarbage } = require('../utils/sanitize');

// ── AI rewrite using Groq ──────────────────────────────────────────────────
// Rewrites a health description: fixes spelling/grammar, converts slang to
// clinical language. Returns null if the text is garbage/unrelated to health.
async function aiPolishText(text) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY || GROQ_API_KEY === 'your_groq_api_key_here') return null;
  if (!text || !text.trim() || text.trim().length < 5) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are a clinical documentation assistant. Fix spelling and grammar errors in the patient\'s health description. Convert informal/slang to professional language. Keep the same meaning. Output ONLY the corrected text — no explanations, no quotes, no extra words. If the input is gibberish or completely unrelated to health, output exactly: GARBAGE',
          },
          {
            role: 'user',
            content: text.trim(),
          },
        ],
        max_tokens: 300,
        temperature: 0.1,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;
    const data = await response.json();
    const result = data.choices?.[0]?.message?.content?.trim();
    if (!result || result === 'GARBAGE') return result === 'GARBAGE' ? '__GARBAGE__' : null;
    return result;
  } catch {
    return null; // timeout or network error — fall back to basic sanitize
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
      medicalConditions, currentMedications, allergies, feelingDescription,
      lifestyleHabits, pregnancyStatus,
      takingSupplements, currentSupplements, recentBloodTest,
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
    if (feelingDescription && feelingDescription.length > TEXT_MAX)
      return res.status(400).json({ message: `Health description must be ${TEXT_MAX} characters or fewer.` });
    if (req.body.bloodTestResults && req.body.bloodTestResults.length > TEXT_MAX)
      return res.status(400).json({ message: `Blood test results must be ${TEXT_MAX} characters or fewer.` });
    if (currentSupplements && currentSupplements.length > SHORT_MAX)
      return res.status(400).json({ message: `Current supplements must be ${SHORT_MAX} characters or fewer.` });

    // ── Sanitize short fields (rule-based) ───────────────────────────────
    const medsResult      = sanitizeShortField(currentMedications);
    const allergiesResult = sanitizeShortField(allergies);
    const suppsResult     = sanitizeShortField(currentSupplements);
    const bloodResult     = sanitizeTextField(req.body.bloodTestResults);

    // ── AI-polish the health description ────────────────────────────────
    const garbageFields = [];
    if (medsResult.garbage)      garbageFields.push({ field: 'currentMedications',  label: 'Current Medications',  value: currentMedications });
    if (allergiesResult.garbage) garbageFields.push({ field: 'allergies',            label: 'Allergies',            value: allergies });
    if (suppsResult.garbage)     garbageFields.push({ field: 'currentSupplements',   label: 'Current Supplements',  value: currentSupplements });
    if (bloodResult.garbage)     garbageFields.push({ field: 'bloodTestResults',     label: 'Blood Test Results',   value: req.body.bloodTestResults });

    let cleanedDescription = '';
    if (feelingDescription && feelingDescription.trim()) {
      if (isGarbage(feelingDescription)) {
        garbageFields.push({ field: 'feelingDescription', label: 'Health Concerns', value: feelingDescription });
        cleanedDescription = '';
      } else {
        // Try AI polish first; fall back to rule-based if Groq is unavailable
        const aiResult = await aiPolishText(feelingDescription);
        if (aiResult === '__GARBAGE__') {
          garbageFields.push({ field: 'feelingDescription', label: 'Health Concerns', value: feelingDescription });
          cleanedDescription = '';
        } else if (aiResult) {
          cleanedDescription = aiResult;
        } else {
          // Groq unavailable — use rule-based sanitize
          const fallback = sanitizeTextField(feelingDescription);
          cleanedDescription = fallback.value;
          if (fallback.garbage) garbageFields.push('feelingDescription');
        }
      }
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
      feelingDescription: cleanedDescription,
      lifestyleHabits, pregnancyStatus,
      takingSupplements,
      currentSupplements: suppsResult.value,
      recentBloodTest,
      bloodTestResults: bloodResult.value,
      sunExposure: req.body.sunExposure,
      fitnessFocus: req.body.fitnessFocus,
      proteinIntake: req.body.proteinIntake,
    });

    console.log('Assessment saved to DB, id:', assessment._id);
    res.status(201).json({ message: 'Assessment saved', assessment, garbageFields });
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
