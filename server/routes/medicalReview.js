const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Assessment = require('../models/Assessment');
const UserNotification = require('../models/UserNotification');
const AdminEvent = require('../models/AdminEvent');
const MedicalReviewAudit = require('../models/MedicalReviewAudit');
const { protect, adminOnly } = require('../middleware/auth');

// @route   POST /api/medical-review/request
// @desc    User requests medical review after being flagged
// @access  Private (user)
router.post('/request', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Don't allow duplicate requests
    if (user.medicalReviewStatus === 'pending') {
      return res.status(400).json({ message: 'Medical review request already pending.' });
    }

    // Update user with medical review request
    user.medicalReviewRequested = true;
    user.medicalReviewRequestedAt = new Date();
    user.medicalReviewStatus = 'pending';
    await user.save();

    // Create notification for user
    await UserNotification.create({
      user: user._id,
      type: 'medical-review-requested',
      title: 'Medical review requested',
      detail: 'Your medical review request has been submitted. An administrator will review your case shortly.',
      link: '/dashboard',
    });

    // Create admin event for visibility
    await AdminEvent.create({
      type: 'medical-review-requested',
      title: 'Medical review requested',
      detail: `${user.email} has requested medical review for priority assessment`,
      user: user._id,
      linkUserId: user._id,
      link: 'assessment-management',
    });

    res.status(200).json({
      message: 'Medical review request submitted successfully.',
      status: 'pending',
    });
  } catch (error) {
    console.error('[medical-review-request]', error);
    res.status(500).json({ message: 'Failed to submit medical review request.' });
  }
});

// @route   GET /api/medical-review/status
// @desc    Get current medical review status for logged-in user
// @access  Private (user)
router.get('/status', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      'medicalReviewRequested medicalReviewRequestedAt medicalReviewStatus medicalReviewNotes medicalReviewResolvedAt'
    );
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Also check for any active Priority assessments
    const priorityAssessments = await Assessment.find({
      user: user._id,
      priority: 'Priority',
      resolvedAt: null,
    })
      .select('flagReasons flaggedAt')
      .sort({ flaggedAt: -1 })
      .limit(1);

    res.status(200).json({
      medicalReviewStatus: user.medicalReviewStatus,
      medicalReviewRequested: user.medicalReviewRequested,
      medicalReviewRequestedAt: user.medicalReviewRequestedAt,
      medicalReviewResolvedAt: user.medicalReviewResolvedAt,
      medicalReviewNotes: user.medicalReviewNotes,
      hasPriorityAssessment: priorityAssessments.length > 0,
      priorityAssessment: priorityAssessments[0] || null,
    });
  } catch (error) {
    console.error('[medical-review-status]', error);
    res.status(500).json({ message: 'Failed to get medical review status.' });
  }
});

// @route   GET /api/admin/medical-reviews
// @desc    Get all pending medical reviews (admin only)
// @access  Private (admin)
router.get('/admin/reviews', protect, adminOnly, async (req, res) => {
  try {
    // Find all users with medical reviews that need admin attention
    // (pending = newly requested, needs_more_info = admin requested clarification)
    const pendingReviews = await User.find({
      medicalReviewStatus: { $in: ['pending', 'needs_more_info'] },
    })
      .select('firstName lastName email medicalReviewRequestedAt medicalReviewStatus')
      .sort({ medicalReviewRequestedAt: -1 });

    // For each user, get their most recent Priority assessment
    const reviewsWithAssessments = await Promise.all(
      pendingReviews.map(async (user) => {
        const assessment = await Assessment.findOne({
          user: user._id,
          priority: 'Priority',
          resolvedAt: null,
        })
          .select('flagReasons flaggedAt symptoms symptomSeverity medicalConditions')
          .sort({ flaggedAt: -1 });

        return {
          userId: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          requestedAt: user.medicalReviewRequestedAt,
          status: user.medicalReviewStatus,
          assessment: assessment || null,
        };
      })
    );

    res.status(200).json({ reviews: reviewsWithAssessments });
  } catch (error) {
    console.error('[admin-medical-reviews]', error);
    res.status(500).json({ message: 'Failed to get medical reviews.' });
  }
});

// @route   POST /api/admin/medical-reviews/:userId/resolve
// @desc    Resolve a medical review (approve or request more info)
// @access  Private (admin)
router.post('/admin/reviews/:userId/resolve', protect, adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    const { decision, notes } = req.body;

    // Validate decision
    if (!['approved', 'needs_more_info'].includes(decision)) {
      return res.status(400).json({ message: 'Invalid decision. Must be "approved" or "needs_more_info".' });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Update user status
    user.medicalReviewStatus = decision === 'approved' ? 'approved' : 'needs_more_info';
    user.medicalReviewNotes = notes || '';
    user.medicalReviewResolvedAt = new Date();
    user.medicalReviewResolvedBy = req.user.adminAlias || req.user.email || 'Admin';
    await user.save();

    // Get the most recent Priority assessment for audit trail
    const priorityAssessment = await Assessment.findOne({
      user: userId,
      priority: 'Priority',
      resolvedAt: null,
    })
      .select('_id')
      .sort({ flaggedAt: -1 });

    // Create audit trail entry
    await MedicalReviewAudit.create({
      user: userId,
      assessment: priorityAssessment ? priorityAssessment._id : null,
      decision,
      notes: notes || '',
      resolvedBy: user.medicalReviewResolvedBy,
      resolvedAt: new Date(),
    });

    // If approved, DON'T resolve the Priority assessment yet
    // User must confirm they've read the admin response first
    if (decision === 'approved') {
      // Just notify user of approval - assessments stay flagged until user confirms
      await UserNotification.create({
        user: userId,
        type: 'medical-review-approved',
        title: 'Medical review approved',
        detail: `Your medical review has been approved. Please check your dashboard to view the administrator's response and confirm to continue.${notes ? ` Note: ${notes}` : ''}`,
        link: '/dashboard',
      });

      // Create admin event
      await AdminEvent.create({
        type: 'medical-review-approved',
        title: 'Medical review approved',
        detail: `${user.email} - Review approved by ${user.medicalReviewResolvedBy}${notes ? ` - ${notes}` : ''}`,
        user: userId,
        linkUserId: userId,
        link: 'assessment-management',
      });
    } else {
      // Request more info
      await UserNotification.create({
        user: userId,
        type: 'medical-review-needs-info',
        title: 'Medical review needs more information',
        detail: `Your medical review requires additional information. ${notes || 'Please contact support for details.'}`,
        link: '/dashboard',
      });

      // Create admin event
      await AdminEvent.create({
        type: 'medical-review-needs-info',
        title: 'Medical review - more info requested',
        detail: `${user.email} - ${user.medicalReviewResolvedBy} requested more information${notes ? ` - ${notes}` : ''}`,
        user: userId,
        linkUserId: userId,
        link: 'assessment-management',
      });
    }

    res.status(200).json({
      message: `Medical review ${decision === 'approved' ? 'approved' : 'marked as needing more info'} successfully.`,
      decision,
    });
  } catch (error) {
    console.error('[admin-resolve-medical-review] Error:', error.message);
    console.error('[admin-resolve-medical-review] Stack:', error.stack);
    res.status(500).json({ 
      message: 'Failed to resolve medical review.',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// @route   POST /api/medical-review/confirm
// @desc    User confirms they've read admin approval and lifts the block
// @access  Private (user)
router.post('/confirm', protect, async (req, res) => {
  console.log('[medical-review-confirm] Starting confirmation for user:', req.user._id);
  
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      console.log('[medical-review-confirm] User not found:', req.user._id);
      return res.status(404).json({ message: 'User not found.' });
    }

    console.log('[medical-review-confirm] User status before:', {
      status: user.medicalReviewStatus,
      requested: user.medicalReviewRequested,
    });

    // Get all Priority assessments to check if there's anything to resolve
    const priorityAssessments = await Assessment.find({
      user: req.user._id,
      priority: 'Priority',
      resolvedAt: null,
    }).select('_id createdAt');

    // If no Priority assessments found, return early
    if (priorityAssessments.length === 0) {
      console.log('[medical-review-confirm] No Priority assessments to resolve');
      return res.status(200).json({
        message: 'No priority assessments to resolve.',
        resolvedCount: 0,
        alreadyConfirmed: true,
      });
    }

    console.log('[medical-review-confirm] Resolving Priority assessments...', {
      count: priorityAssessments.length,
      ids: priorityAssessments.map(a => a._id),
    });
    
    // Update each assessment: resolve, restore priority to Standard, and restore expiry
    const result = await Assessment.updateMany(
      { user: req.user._id, priority: 'Priority', resolvedAt: null },
      {
        $set: {
          priority: 'Standard',
          resolvedAt: new Date(),
          resolvedReason: `Health safety alert acknowledged by user${user.medicalReviewResolvedBy ? ` after approval by ${user.medicalReviewResolvedBy}` : ''}`,
        },
      }
    );
    
    // Restore expiry dates for each resolved assessment
    for (const assessment of priorityAssessments) {
      const expiryDate = new Date(assessment.createdAt);
      expiryDate.setFullYear(expiryDate.getFullYear() + 5);
      await Assessment.findByIdAndUpdate(assessment._id, {
        $set: { expiresAt: expiryDate }
      });
    }

    console.log('[medical-review-confirm] Assessments resolved:', {
      matched: result.matchedCount,
      modified: result.modifiedCount,
    });

    // Reset medical review status to none after confirmation
    user.medicalReviewStatus = 'none';
    user.medicalReviewRequested = false;
    await user.save();

    console.log('[medical-review-confirm] User status reset to none');

    // Create audit event
    await AdminEvent.create({
      type: 'resolved',
      title: 'Medical review confirmed by user',
      detail: `${user.email} confirmed medical review and lifted the block (${result.modifiedCount} assessment(s) resolved)`,
      user: req.user._id,
      linkUserId: req.user._id,
      link: 'assessment-management',
    });

    console.log('[medical-review-confirm] Audit event created successfully');

    const response = {
      message: 'Medical review confirmed. You can now continue with new assessments.',
      resolvedCount: result.modifiedCount,
    };

    console.log('[medical-review-confirm] Sending success response:', response);
    res.status(200).json(response);
  } catch (error) {
    console.error('[medical-review-confirm] Error caught:', error.message);
    console.error('[medical-review-confirm] Stack:', error.stack);
    res.status(500).json({ 
      message: 'Failed to confirm medical review.',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

module.exports = router;
