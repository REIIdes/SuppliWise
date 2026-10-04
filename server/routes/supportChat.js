const express = require('express');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const ChatThread = require('../models/ChatThread');
const ChatMessage = require('../models/ChatMessage');
const {
  ChatInputError,
  ChatStateError,
  MAX_MESSAGES_PER_THREAD,
  normalizeSubject,
  normalizeCategory,
  normalizeBody,
  assertThreadWritable,
  statusAfterMessage,
  buildPreview,
} = require('../utils/supportChat');

/**
 * SUPPORT CHAT — the member's side of the conversation.
 *
 * Mounted at /api/support-chat, which is deliberately a DIFFERENT path from
 * /api/chat: that one is the stateless AI assistant (routes/chat.js) and has
 * nothing to do with this. Keeping them apart means the AI's rate limit, its
 * plan gate and its payload shape are unaffected by anything here.
 *
 * Rules that apply to every route in this file:
 *   • Identity comes from `req.user` only. A `user` in the body or query is
 *     never read — the whole point of the scoping below is that it cannot be.
 *   • Another account's thread id answers 404, not 403. A 403 would confirm
 *     that the id exists, turning this endpoint into a probe for valid ids.
 *   • Admin tokens are refused (403 'User account required.') so the admin
 *     console and the member inbox can never be crossed by holding one token.
 *
 * `author` is derived from the session, NEVER from the request body. A member
 * who POSTs { author: 'admin' } gets a message recorded as their own.
 *
 * ── The member cannot resolve or reopen ─────────────────────────────────────
 * There is deliberately no `POST /:id/resolve` and no `POST /:id/reopen` here.
 * Both live on the admin router, and that is the rule rather than a gap: a
 * member is not the only party who decides whether a question is answered, and
 * a member who can reopen can also write, which would defeat the read-only
 * resolved state. A member whose question was closed early starts a NEW
 * conversation, which keeps the history intact and puts it back in the queue
 * where an administrator will see it.
 */
const router = express.Router();
router.use(protect);

const requireUserAccount = (req, res) => {
  if (req.user.role === 'admin') {
    res.status(403).json({ message: 'User account required.' });
    return false;
  }
  return true;
};

/**
 * What every admin reply is called on the MEMBER's side.
 *
 * Admin aliases (`AdminDevs`, `AdminJoma`, …) are operator identities, not
 * something a member is entitled to. They name individuals behind what the
 * product presents as one support channel, they come out of a server-side
 * config file, and publishing one tells a member exactly which person is
 * handling their billing and their account — which is nobody's business and is
 * also a small, needlessly specific thing to aim at. So a member sees the
 * channel, never the operator behind it.
 *
 * The alias is NOT discarded. It stays exactly where the work needs it —
 * routes/adminSupportChats.js reads it straight off the document — so the
 * console can still show who replied and who owns a thread. Only this router,
 * which is the one a member can reach, replaces it.
 *
 * Enforced HERE, at the serialisation boundary, rather than in the component:
 * the payload is what the member's browser (and any future mobile build) holds,
 * so a label chosen in the UI would still ship `AdminDevs` over the wire and
 * into any network tab, saved payload or log along the way.
 *
 * Mirrored — not shared — by SUPPORT_AUTHOR_LABEL in
 * my-react-app/src/Components/SupportInbox/SupportInbox.jsx, which renders the
 * same string rather than trusting the field, so a regression on either side
 * degrades to a generic name instead of a name.
 */
const SUPPORT_AUTHOR_LABEL = 'Suppliwise Support';

/**
 * Never let a stored document carry an unexpected author into a render, and
 * never let it carry an admin alias out of this router either.
 */
const toMessageView = (message) => ({
  _id: message._id,
  thread: message.thread,
  author: message.author,
  // A member's own name is theirs to see, so it passes through untouched. An
  // admin's reply is attributed to the label above regardless of what the
  // document says — including for messages written before this existed, which is
  // why the substitution is here and not in the write path.
  authorName: message.author === 'admin' ? SUPPORT_AUTHOR_LABEL : message.authorName,
  body: message.body,
  createdAt: message.createdAt,
});

const toThreadView = (thread) => ({
  _id: thread._id,
  subject: thread.subject,
  category: thread.category,
  status: thread.status,
  lastMessageAt: thread.lastMessageAt,
  lastMessagePreview: thread.lastMessagePreview,
  lastMessageBy: thread.lastMessageBy,
  messageCount: thread.messageCount,
  unreadByUser: thread.unreadByUser,
  unreadByAdmin: thread.unreadByAdmin,
  // Which colleague has claimed a thread, and which one closed it, are both
  // aliases and both internal. Blanked on the way out for the same reason the
  // author name is (see SUPPORT_AUTHOR_LABEL). The keys are kept, and kept
  // empty, so the response shape is unchanged for the client — a member cannot
  // learn an admin's identity from the list endpoint any more than from the
  // transcript. The console reads the real values from its own router, which
  // has its own toThreadView for exactly this reason.
  assignedTo: '',
  // `at` survives because the member UI dates the resolution ("resolved Oct 3")
  // and that is about their conversation, not about who closed it. `by` does not.
  resolved: { by: '', at: thread.resolved?.at || null },
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
});

/**
 * Insert a message and update its thread's denormalised summary in one shot.
 *
 * The two writes cannot be in a transaction (the deployment runs standalone
 * Mongo, where transactions need a replica set), so ordering matters: the
 * MESSAGE goes in first. A crash between the two leaves a real message that the
 * thread summary does not mention — the thread reads as one message short and
 * self-heals on the next send. The reverse order would leave a preview pointing
 * at a message that does not exist, which is visible to an admin as a dead link.
 */
async function appendMessage({ thread, author, authorName, body }) {
  const now = new Date();
  const message = await ChatMessage.create({
    thread: thread._id,
    user: thread.user,
    author,
    authorName,
    body,
  });

  // The reader's own counter goes to zero and the OTHER side's goes up by one.
  // These two counters are only ever written here and by the read endpoints, so
  // "unread" cannot disagree with itself between the list and the thread view.
  const inc = author === 'user' ? { unreadByAdmin: 1 } : { unreadByUser: 1 };

  await ChatThread.updateOne(
    { _id: thread._id },
    {
      $set: {
        lastMessageAt: now,
        lastMessagePreview: buildPreview(body),
        lastMessageBy: author,
        status: statusAfterMessage(author),
        resolved: { by: '', at: null },
      },
      $inc: { messageCount: 1, ...inc },
    }
  );

  return message;
}

// @route   GET /api/support-chat
// @desc    The member's conversations, most recently active first
// @access  Private
router.get('/', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const [threads, unreadCount] = await Promise.all([
      ChatThread.find({ user: req.user._id })
        .sort({ lastMessageAt: -1 })
        .limit(limit)
        .lean(),
      ChatThread.countDocuments({ user: req.user._id, unreadByUser: { $gt: 0 } }),
    ]);
    res.json({
      threads: (threads || []).map(toThreadView),
      unreadCount,
    });
  } catch (error) {
    console.error('[support-chat GET]', error.message);
    res.status(500).json({ message: 'Could not load your conversations.' });
  }
});

// @route   POST /api/support-chat
// @desc    Start a new conversation. The first message is the body.
// @access  Private
router.post('/', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    const body = normalizeBody(req.body?.body ?? req.body?.message);
    const subject = normalizeSubject(req.body?.subject, body);
    const category = normalizeCategory(req.body?.category);

    const thread = await ChatThread.create({
      user: req.user._id,
      subject,
      category,
      status: 'open',
      lastMessageAt: new Date(),
      lastMessagePreview: buildPreview(body),
      lastMessageBy: 'user',
      messageCount: 1,
      // The opening message is by definition unread on our side.
      unreadByAdmin: 1,
      unreadByUser: 0,
    });

    await ChatMessage.create({
      thread: thread._id,
      user: req.user._id,
      author: 'user',
      authorName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email || 'Member',
      body,
    });

    // Ring the admin bell. Fire-and-forget: a failed notification must never
    // cost the member their message, and the thread itself is already durable.
    // `type` is in the AdminEvent enum — see the note in models/AdminEvent.js
    // about a value missing from that enum silently dropping every audit row.
    const who = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email;
    require('../models/AdminEvent').create({
      type: 'support-chat',
      title: 'New support conversation',
      detail: `${who} started “${subject}” and is waiting for a reply.`,
      user: req.user._id,
      linkUserId: req.user._id,
    }).catch((notifyError) => {
      console.error('[support-chat admin bell]', notifyError.message);
    });

    res.status(201).json({
      message: 'Your message was sent. An administrator will reply here.',
      thread: toThreadView(thread),
    });
  } catch (error) {
    if (error instanceof ChatInputError) return res.status(400).json({ message: error.message });
    console.error('[support-chat POST]', error.message);
    res.status(500).json({ message: 'Could not send your message.' });
  }
});

// @route   GET /api/support-chat/:id
// @desc    One conversation with its transcript. Reading marks it read.
// @access  Private
router.get('/:id', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    // Owner-scoped: another account's id is a 404, not a 403 (see header).
    const thread = await ChatThread.findOne({ _id: req.params.id, user: req.user._id }).lean();
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });

    const messages = await ChatMessage.find({ thread: thread._id })
      .sort({ createdAt: 1 })
      .limit(500)
      .lean();

    // Opened == read. Awaited before responding so the unread badge in the list
    // is already correct if the client refetches immediately.
    await ChatThread.updateOne({ _id: thread._id }, { $set: { unreadByUser: 0 } });

    res.json({
      thread: toThreadView({ ...thread, unreadByUser: 0 }),
      messages: (messages || []).map(toMessageView),
    });
  } catch (error) {
    console.error('[support-chat GET /:id]', error.message);
    res.status(500).json({ message: 'Could not load the conversation.' });
  }
});

// @route   POST /api/support-chat/:id/messages
// @desc    Reply. Refused on a resolved thread (409) — a message no longer
//          revives one; an administrator must reopen it first.
// @access  Private
router.post('/:id/messages', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const body = normalizeBody(req.body?.body ?? req.body?.message);
    const thread = await ChatThread.findOne({ _id: req.params.id, user: req.user._id });
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });

    // Before the message-count check, so a resolved thread reports "resolved"
    // rather than a limit the member cannot do anything about either.
    assertThreadWritable(thread);

    if (thread.messageCount >= MAX_MESSAGES_PER_THREAD) {
      return res.status(400).json({
        message: 'This conversation has reached its message limit. Please start a new one.',
      });
    }

    const message = await appendMessage({
      thread,
      author: 'user',
      authorName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email || 'Member',
      body,
    });

    res.status(201).json({ message: 'Reply sent.', message_record: toMessageView(message) });
  } catch (error) {
    if (error instanceof ChatInputError) return res.status(400).json({ message: error.message });
    if (error instanceof ChatStateError) return res.status(error.status).json({ message: error.message });
    console.error('[support-chat POST /:id/messages]', error.message);
    res.status(500).json({ message: 'Could not send your reply.' });
  }
});

// ── Nothing below this line ─────────────────────────────────────────────────
// There is no member-facing resolve and no member-facing reopen. See the header:
// both transitions belong to an administrator, and a member who can reopen can
// also write, which would make the resolved state read-only in name only.
//
// The former endpoints are removed rather than left returning 403 on purpose:
// a route that exists to refuse is a route someone will eventually call, and
// Express answering 404 tells the truth — there is no such thing here.
//
// A member who still needs help after their thread was resolved starts a new
// conversation, which preserves the old transcript and returns the question to
// the admin queue where it can be seen.
module.exports = router;
