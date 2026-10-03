const express = require('express');
const mongoose = require('mongoose');
const { protect, adminOnly } = require('../middleware/auth');
const User = require('../models/User');
const ChatThread = require('../models/ChatThread');
const ChatMessage = require('../models/ChatMessage');
const UserNotification = require('../models/UserNotification');
const {
  ChatInputError,
  ChatStateError,
  MAX_MESSAGES_PER_THREAD,
  CHAT_CATEGORIES,
  CHAT_STATUSES,
  normalizeBody,
  assertThreadWritable,
  statusAfterMessage,
  statusAfterReopen,
  buildPreview,
  categoryLabel,
} = require('../utils/supportChat');

/**
 * SUPPORT CHAT — the admin console's side. Mounted at /api/admin/chats, so it
 * inherits the admin rate limiter and the lockout check registered for
 * /api/admin in index.js, and the sidebar "Chat management" tab renders it via
 * the dashboard's own `request` helper (admin bearer token).
 *
 * The shape deliberately mirrors routes/supportChat.js: same list/detail/reply
 * semantics, same 404-not-403 rule. Two inbox implementations that disagree
 * about who is waiting is how a queue ends up with conversations marked
 * resolved that the member is still waiting on.
 *
 * ── This file owns both ends of the resolved lock ───────────────────────────
 * The member router has no resolve and no reopen, so THIS file is the only place
 * a conversation can be closed or reopened. That asymmetry is the feature:
 *
 *   resolve  → freezes the thread. Neither side can post until an admin reopens.
 *   reopen   → unfreezes it and puts it back in the "waiting on us" queue.
 *
 * Both notify the member, because a thread silently becoming read-only — or
 * silently becoming writable again — is indistinguishable from a bug to the
 * person on the other side.
 *
 * What admins can do that members cannot: resolve, reopen, delete a whole
 * conversation (spam, abuse), and see the member's identity beside every
 * message. What they cannot do: edit or delete an individual message. The
 * transcript is the record.
 */
const router = express.Router();
router.use(protect, adminOnly);

const THREAD_USER_FIELDS = 'firstName lastName email accountStatus subscriptionPlan';

// Escapes a user-supplied search term before it becomes a RegExp. Without this
// a query of "(" is a syntax error that 500s, and a term of "a{1,1000}" is a
// pathological pattern on a large collection.
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const toThreadView = (thread) => ({
  _id: thread._id,
  subject: thread.subject,
  category: thread.category,
  categoryLabel: categoryLabel(thread.category),
  status: thread.status,
  lastMessageAt: thread.lastMessageAt,
  lastMessagePreview: thread.lastMessagePreview,
  lastMessageBy: thread.lastMessageBy,
  messageCount: thread.messageCount,
  unreadByAdmin: thread.unreadByAdmin,
  unreadByUser: thread.unreadByUser,
  assignedTo: thread.assignedTo || '',
  resolved: thread.resolved || { by: '', at: null },
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  user: thread.user
    ? {
      _id: thread.user._id,
      firstName: thread.user.firstName,
      lastName: thread.user.lastName,
      email: thread.user.email,
      accountStatus: thread.user.accountStatus,
      subscriptionPlan: thread.user.subscriptionPlan,
    }
    : null,
});

/** open / pending / resolved tallies, for the filter badges. */
async function threadStatusCounts() {
  const grouped = await ChatThread.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const counts = { open: 0, pending: 0, resolved: 0 };
  for (const row of grouped || []) {
    if (row && row._id in counts) counts[row._id] = row.count;
  }
  counts.all = counts.open + counts.pending + counts.resolved;
  // "Waiting on you" is the only number that must never be missed.
  counts.unread = await ChatThread.countDocuments({ unreadByAdmin: { $gt: 0 } });
  return counts;
}

// @route   GET /api/admin/chats
// @desc    The support queue: filters, search, counts
// @access  Admin
router.get('/', async (req, res) => {
  try {
    const statusParam = String(req.query.status || 'open').trim().toLowerCase();
    if (statusParam !== 'all' && !CHAT_STATUSES.includes(statusParam)) {
      return res.status(400).json({ message: 'Unknown conversation status.' });
    }
    const categoryParam = String(req.query.category || 'all').trim().toLowerCase();
    if (categoryParam !== 'all' && !CHAT_CATEGORIES.includes(categoryParam)) {
      return res.status(400).json({ message: 'Unknown conversation category.' });
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const search = String(req.query.search || '').trim().slice(0, 80);

    const filter = {};
    if (statusParam !== 'all') filter.status = statusParam;
    if (categoryParam !== 'all') filter.category = categoryParam;

    if (search) {
      const rx = new RegExp(escapeRegExp(search), 'i');
      // Match the SUBJECT too, not just the member: admins are routinely told
      // "find the thread about the ₱1,295 transfer" and have no name to go on.
      const or = [{ subject: rx }];
      // A name/email match needs a lookup first. Bounded to 500 ids so a broad
      // search over the whole member base cannot turn into an unbounded $in.
      const matches = await User.find({
        $or: [{ firstName: rx }, { lastName: rx }, { email: rx }],
      }).select('_id').limit(500).lean();
      const ids = (matches || []).map((m) => m._id);
      if (ids.length > 0) or.push({ user: { $in: ids } });
      // Nothing could match: answer an empty page rather than the whole queue.
      else if (or.length === 0) {
        return res.json({ threads: [], counts: await threadStatusCounts(), status: statusParam });
      }
      filter.$or = or;
    }

    const [rows, counts] = await Promise.all([
      ChatThread.find(filter)
        // Most recently ACTIVE first (lastMessageAt, not updatedAt) so a status
        // change cannot float a dormant thread above a live one.
        .sort({ lastMessageAt: -1 })
        .limit(limit)
        .populate('user', THREAD_USER_FIELDS)
        .lean(),
      threadStatusCounts(),
    ]);

    return res.json({
      threads: (rows || []).map(toThreadView),
      counts,
      status: statusParam,
      category: categoryParam,
    });
  } catch (error) {
    console.error('[admin/chats GET]', error.message);
    return res.status(500).json({ message: 'Unable to load the conversations.' });
  }
});

// @route   GET /api/admin/chats/next-id
// @desc    The newest waiting thread, for "open the next one" from a list that
//          is filtered to nothing yet. Kept separate from the list so the
//          ordinary list query stays a plain filter+sort.
// @access  Admin
router.get('/next-id', async (req, res) => {
  try {
    const row = await ChatThread.findOne({ status: 'open' })
      .sort({ lastMessageAt: -1 })
      .select('_id')
      .lean();
    return res.json({ id: row?._id || null });
  } catch (error) {
    console.error('[admin/chats GET /next-id]', error.message);
    return res.status(500).json({ message: 'Unable to find the next conversation.' });
  }
});

// @route   GET /api/admin/chats/:id
// @desc    One conversation with its transcript. Reading marks it read here.
// @access  Admin
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const thread = await ChatThread.findById(req.params.id)
      .populate('user', THREAD_USER_FIELDS)
      .lean();
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });

    const messages = await ChatMessage.find({ thread: thread._id })
      .sort({ createdAt: 1 })
      .limit(1000)
      .lean();

    await ChatThread.updateOne({ _id: thread._id }, { $set: { unreadByAdmin: 0 } });

    return res.json({
      thread: toThreadView({ ...thread, unreadByAdmin: 0 }),
      messages: (messages || []).map((m) => ({
        _id: m._id,
        author: m.author,
        authorName: m.authorName,
        body: m.body,
        createdAt: m.createdAt,
      })),
    });
  } catch (error) {
    console.error('[admin/chats GET /:id]', error.message);
    return res.status(500).json({ message: 'Unable to load the conversation.' });
  }
});

// @route   POST /api/admin/chats/:id/messages
// @desc    Reply as an administrator. Refused on a resolved thread (409) — the
//          resolved state is read-only for the admin too, and the only way back
//          in is the reopen endpoint below.
// @access  Admin
router.post('/:id/messages', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const body = normalizeBody(req.body?.body ?? req.body?.message);
    const thread = await ChatThread.findById(req.params.id);
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });

    // Same gate the member route uses, from the same shared function. An admin
    // is not exempt: "resolved" has to mean the thread is closed, or it means
    // nothing. Reopen first, then reply.
    assertThreadWritable(thread);

    if (thread.messageCount >= MAX_MESSAGES_PER_THREAD) {
      return res.status(400).json({ message: 'This conversation has reached its message limit.' });
    }

    const now = new Date();
    const alias = String(req.user.alias || 'Administrator').trim() || 'Administrator';
    const message = await ChatMessage.create({
      thread: thread._id,
      user: thread.user,
      author: 'admin',
      authorName: alias,
      body,
    });

    await ChatThread.updateOne(
      { _id: thread._id },
      {
        $set: {
          lastMessageAt: now,
          lastMessagePreview: buildPreview(body),
          lastMessageBy: 'admin',
          status: statusAfterMessage('admin'),
          resolved: { by: '', at: null },
          // The admin has it open, so it is theirs until they let it go.
          assignedTo: thread.assignedTo || alias,
        },
        $inc: { messageCount: 1, unreadByUser: 1, unreadByAdmin: 0 },
      }
    );

    // Tell the member. Fire-and-forget: a failed bell must not cost the reply.
    UserNotification.create({
      user: thread.user,
      type: 'info',
      title: 'Support replied to your message',
      detail: `“${thread.subject}” — ${buildPreview(body, 140)}`,
    }).catch((notifyError) => {
      console.error('[admin/chats member bell]', notifyError.message);
    });

    return res.status(201).json({
      message: 'Reply sent.',
      message_record: { ...message.toObject(), author: message.author },
    });
  } catch (error) {
    if (error instanceof ChatInputError) return res.status(400).json({ message: error.message });
    if (error instanceof ChatStateError) return res.status(error.status).json({ message: error.message });
    console.error('[admin/chats POST /:id/messages]', error.message);
    return res.status(500).json({ message: 'Could not send your reply.' });
  }
});

// @route   POST /api/admin/chats/:id/resolve
// @desc    THE resolve. Admin-only — there is no member equivalent, because only
//          the operator can know a question is actually answered. Resolving
//          freezes the thread for BOTH sides: see the resolved lock in
//          utils/supportChat.js.
// @access  Admin
router.post('/:id/resolve', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const alias = String(req.user.alias || 'Administrator').trim() || 'Administrator';
    const existing = await ChatThread.findById(req.params.id).select('status').lean();
    if (!existing) return res.status(404).json({ message: 'Conversation not found.' });

    // Resolving an already-resolved thread re-stamps the resolver and the time,
    // which is harmless and keeps the endpoint idempotent. The read above is
    // only there to give a 404 before the write rather than after it.
    const updated = await ChatThread.findOneAndUpdate(
      { _id: req.params.id },
      {
        $set: {
          status: 'resolved',
          resolved: { by: alias, at: new Date() },
          // Nobody is owed a reply, so nothing is unread on either side.
          unreadByAdmin: 0,
          unreadByUser: 0,
        },
      },
      { new: true }
    ).populate('user', THREAD_USER_FIELDS).lean();
    if (!updated) return res.status(404).json({ message: 'Conversation not found.' });

    // Tell the member their thread is closed, so a resolved conversation in
    // their list is explained rather than looking like data loss. Fire-and-forget
    // like every other bell here: a failed notification must not undo a resolve.
    UserNotification.create({
      user: updated.user?._id || updated.user,
      type: 'info',
      title: 'Support conversation resolved',
      detail: `“${updated.subject}” was closed by support. You can start a new conversation at any time.`,
    }).catch((notifyError) => {
      console.error('[admin/chats resolve bell]', notifyError.message);
    });

    return res.json({ message: 'Conversation resolved.', thread: toThreadView(updated) });
  } catch (error) {
    console.error('[admin/chats POST /:id/resolve]', error.message);
    return res.status(500).json({ message: 'Could not update the conversation.' });
  }
});

// @route   POST /api/admin/chats/:id/reopen
// @desc    THE ONLY way back into a resolved thread. Admin-only, for the same
//          reason resolve is: a member who can reopen can also write. Puts the
//          thread back in the "waiting on us" queue and notifies the member.
// @access  Admin
router.post('/:id/reopen', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const alias = String(req.user.alias || 'Administrator').trim() || 'Administrator';
    const updated = await ChatThread.findOneAndUpdate(
      { _id: req.params.id },
      {
        $set: {
          status: statusAfterReopen(),
          resolved: { by: '', at: null },
          // The admin has taken it back up, so it is theirs until they let go.
          assignedTo: alias,
        },
      },
      { new: true }
    ).populate('user', THREAD_USER_FIELDS).lean();
    if (!updated) return res.status(404).json({ message: 'Conversation not found.' });

    // The member has to know the thread is live again: it is closed and
    // read-only on their side, and nothing else would tell them it reopened.
    UserNotification.create({
      user: updated.user?._id || updated.user,
      type: 'info',
      title: 'Support conversation reopened',
      detail: `Support reopened “${updated.subject}”. You can reply again.`,
    }).catch((notifyError) => {
      console.error('[admin/chats reopen bell]', notifyError.message);
    });

    return res.json({ message: 'Conversation reopened.', thread: toThreadView(updated) });
  } catch (error) {
    console.error('[admin/chats POST /:id/reopen]', error.message);
    return res.status(500).json({ message: 'Could not reopen the conversation.' });
  }
});

// @route   POST /api/admin/chats/:id/assign
// @desc    Claim a conversation for an admin alias. Informational only — never
//          gates reading or replying, so colleagues can still cover each other.
// @access  Admin
router.post('/:id/assign', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const alias = String(req.body?.alias ?? req.user.alias ?? '').trim().slice(0, 60);
    const updated = await ChatThread.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { assignedTo: alias } },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ message: 'Conversation not found.' });
    return res.json({ thread: toThreadView(updated) });
  } catch (error) {
    console.error('[admin/chats POST /:id/assign]', error.message);
    return res.status(500).json({ message: 'Could not assign the conversation.' });
  }
});

// @route   DELETE /api/admin/chats/:id
// @desc    Delete a conversation and its whole transcript. The only destructive
//          action in this feature — for spam and abuse, not for tidying.
// @access  Admin
router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const thread = await ChatThread.findByIdAndDelete(req.params.id).select('_id').lean();
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });
    // Messages are NOT cascaded by mongoose here (no ref middleware in this
    // codebase), so the transcript is removed explicitly. Doing it in this order
    // means a failure leaves messages that are unreachable by any route rather
    // than a thread pointing at a transcript that is still queryable.
    await ChatMessage.deleteMany({ thread: thread._id });
    return res.json({ message: 'Conversation deleted.' });
  } catch (error) {
    console.error('[admin/chats DELETE /:id]', error.message);
    return res.status(500).json({ message: 'Could not delete the conversation.' });
  }
});

module.exports = router;
