const express = require('express');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const UserNotification = require('../models/UserNotification');
const Assessment = require('../models/Assessment');

const router = express.Router();
router.use(protect);

// @route   GET /api/notifications
// @desc    Current user's notifications, newest first. Self-healing: every
//          Priority assessment is guaranteed a matching unread severe-flag
//          notification (covers flags set before notifications existed or via
//          the admin console), so the inbox is in sync at all times.
// @access  Private
router.get('/', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

    // Backfill missing flags (idempotent — only creates what is absent)
    try {
      const [priorityItems, existingFlags] = await Promise.all([
        Assessment.find({ user: req.user._id, priority: 'Priority' })
          .select('_id flagReasons flaggedAt createdAt')
          .lean(),
        UserNotification.find({ user: req.user._id, type: 'severe-flag', read: false })
          .select('assessmentId')
          .lean(),
      ]);
      const covered = new Set(
        (existingFlags || []).map(n => String(n.assessmentId || ''))
      );
      const missing = (priorityItems || []).filter(a => !covered.has(String(a._id)));
      if (missing.length > 0) {
        await UserNotification.insertMany(
          missing.slice(0, 10).map(a => ({
            user: req.user._id,
            type: 'severe-flag',
            title: 'Health review flagged for your assessment',
            detail: `Our review flagged possible severe concerns (${((a.flagReasons || []).join('; ') || 'Priority review')}). An administrator has been notified. If you feel unwell, please seek medical care promptly.`,
            assessmentId: a._id,
          })),
          { ordered: false }
        );
      }
    } catch (backfillError) {
      console.error('[notifications backfill]', backfillError.message);
    }

    const [items, unreadCount] = await Promise.all([
      UserNotification.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      UserNotification.countDocuments({ user: req.user._id, read: false }),
    ]);
    res.json({ notifications: items, unreadCount });
  } catch (error) {
    console.error('[notifications GET]', error.message);
    res.status(500).json({ message: 'Could not load notifications.' });
  }
});

// @route   PATCH /api/notifications/:id/read
// @desc    Mark one notification as read (owner only)
// @access  Private
router.patch('/:id/read', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid notification.' });
    const item = await UserNotification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { read: true } },
      { new: true }
    ).lean();
    if (!item) return res.status(404).json({ message: 'Notification not found.' });
    res.json({ notification: item });
  } catch (error) {
    console.error('[notifications PATCH /:id/read]', error.message);
    res.status(500).json({ message: 'Could not update the notification.' });
  }
});

// @route   POST /api/notifications/read-all
// @desc    Mark all of the current user's notifications as read
// @access  Private
router.post('/read-all', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    await UserNotification.updateMany({ user: req.user._id, read: false }, { $set: { read: true } });
    res.json({ message: 'All notifications marked as read.' });
  } catch (error) {
    console.error('[notifications POST /read-all]', error.message);
    res.status(500).json({ message: 'Could not update notifications.' });
  }
});

// @route   DELETE /api/notifications/:id
// @desc    Delete one notification (owner only)
// @access  Private
router.delete('/:id', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid notification.' });
    const item = await UserNotification.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!item) return res.status(404).json({ message: 'Notification not found.' });
    res.json({ message: 'Notification deleted.' });
  } catch (error) {
    console.error('[notifications DELETE /:id]', error.message);
    res.status(500).json({ message: 'Could not delete the notification.' });
  }
});

module.exports = router;
