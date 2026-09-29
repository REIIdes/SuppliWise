const express = require('express');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const UserNotification = require('../models/UserNotification');
const Assessment = require('../models/Assessment');

const router = express.Router();
router.use(protect);

// Dismissed rows are only kept so the backfill below can tell "already seen"
// from "never existed". Past this window the distinction no longer matters, so
// the storage is reclaimed instead of growing forever.
const DISMISSED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

    // Backfill missing flags (idempotent — only creates what is absent).
    // Coverage counts EVERY severe-flag row for the user, read or dismissed:
    // a notice the member has already read (or thrown away) must not be
    // recreated as unread on the next poll.
    try {
      const [priorityItems, existingFlags] = await Promise.all([
        Assessment.find({ user: req.user._id, priority: 'Priority' })
          .select('_id flagReasons flaggedAt createdAt')
          .lean(),
        UserNotification.find({ user: req.user._id, type: 'severe-flag' })
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
      UserNotification.find({ user: req.user._id, dismissed: false })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      UserNotification.countDocuments({ user: req.user._id, read: false, dismissed: false }),
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
      { _id: req.params.id, user: req.user._id, dismissed: false },
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
    await UserNotification.updateMany(
      { user: req.user._id, read: false, dismissed: false },
      { $set: { read: true } }
    );
    res.json({ message: 'All notifications marked as read.' });
  } catch (error) {
    console.error('[notifications POST /read-all]', error.message);
    res.status(500).json({ message: 'Could not update notifications.' });
  }
});

// @route   POST /api/notifications/delete-read
// @desc    Clear every notification the current user has already read. Unread
//          ones are left alone so they stay actionable in the bell.
// @access  Private
router.post('/delete-read', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const cleared = await UserNotification.updateMany(
      { user: req.user._id, read: true, dismissed: false },
      { $set: { dismissed: true } }
    );
    // Reclaim storage now that the read rows are gone from the inbox.
    await UserNotification.deleteMany({
      user: req.user._id,
      dismissed: true,
      createdAt: { $lt: new Date(Date.now() - DISMISSED_RETENTION_MS) },
    });
    res.json({
      message: 'Read notifications cleared.',
      deletedCount: cleared.modifiedCount || 0,
    });
  } catch (error) {
    console.error('[notifications POST /delete-read]', error.message);
    res.status(500).json({ message: 'Could not clear read notifications.' });
  }
});

// @route   DELETE /api/notifications/:id
// @desc    Dismiss one notification (owner only)
// @access  Private
router.delete('/:id', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid notification.' });
    const item = await UserNotification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, dismissed: false },
      { $set: { dismissed: true } },
      { new: true }
    ).lean();
    if (!item) return res.status(404).json({ message: 'Notification not found.' });
    res.json({ message: 'Notification deleted.' });
  } catch (error) {
    console.error('[notifications DELETE /:id]', error.message);
    res.status(500).json({ message: 'Could not delete the notification.' });
  }
});

module.exports = router;
