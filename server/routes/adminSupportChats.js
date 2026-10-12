const express = require('express');
const mongoose = require('mongoose');
const { protect, adminOnly } = require('../middleware/auth');
const User = require('../models/User');
const AdminAccount = require('../models/AdminAccount');
const ChatThread = require('../models/ChatThread');
const ChatMessage = require('../models/ChatMessage');
const UserNotification = require('../models/UserNotification');
const {
  ChatInputError,
  ChatStateError,
  MAX_MESSAGES_PER_THREAD,
  CHAT_CATEGORIES,
  CHAT_STATUSES,
  assertThreadWritable,
  statusAfterMessage,
  statusAfterReopen,
  buildPreview,
  categoryLabel,
} = require('../utils/supportChat');
const {
  ENCRYPTION_VERSION,
  participantForAdmin,
  participantForUser,
  readMessagePayload,
  normalizeKeyShares,
  sharesForParticipant,
  encryptionView,
  isEncrypted,
  isCipher,
} = require('../utils/chatEncryption');
const {
  KeyInputError,
  keyView,
  registerPublicKey,
  saveRecoveryCopy,
  listOperatorPublicKeys,
  participantFor,
} = require('../utils/chatKeys');
const { withTicketIds, normalizeTicketSearch } = require('../utils/ticketId');
const { markAdminActivity, addAdminConnection, removeAdminConnection } = require('../utils/supportPresence');
const { SSE_HEARTBEAT_MS, streamTokenAuth, sseWrite, sseHeaders, tokenExpiryDelayMs } = require('../utils/sse');
const chatBus = require('../utils/chatEventBus');

/**
 * Announce a conversation change everywhere it must land, now and without a
 * refresh: every OTHER operator's console (the bus's admin audience and this
 * account's other stream connections — operator A's reply must repaint
 * operator B's queue this second), and the member on the other end of the
 * thread (the bus's user audience, unless this very operator's session
 * produced the write and their member-side copy is irrelevant).
 *
 * The event is an INVALIDATION signal only — `{ kind, thread, by }`, never
 * message content — so the read endpoints stay the single source of truth and
 * nothing about E2E ciphertext rides this channel.
 *
 * CALL IT BEFORE res.json/sendStatus, for the ordering reason spelled out on
 * the member router's twin: a recipient that refetches the moment it is
 * pushed to must read a transcript that already contains the write.
 */
function announce(req, event, threadUserId, opts = {}) {
  const adminKey = String(req.user?._id || '').trim();
  const producerId = req.chatStreamClientId || '';
  // skipAdmins: the bus would otherwise fan this out to every console
  // INCLUDING this operator's other tabs — the map loop below delivers to
  // those with the producer excluded, so both paths must not double-deliver.
  chatBus.publishChat(event, threadUserId, { skipAdmins: true, ...opts });
  // Every OTHER operator's console.
  for (const [adminId, set] of ownAdminStreams) {
    if (adminId === adminKey) continue;
    for (const { res, clientId } of [...set]) {
      if (clientId === producerId) continue;
      try {
        sseWrite(res, 'chat', event);
      } catch { /* dead client — the close handler cleans it up */ }
    }
  }
  // Other consoles of THIS same operator (second tab, another machine).
  const set = adminKey ? ownAdminStreams.get(adminKey) : null;
  if (set) {
    for (const { res, clientId } of [...set]) {
      if (clientId === producerId) continue;
      try {
        sseWrite(res, 'chat', event);
      } catch { /* dead client — the close handler cleans it up */ }
    }
  }
}

// AdminAccountId -> Set<{ res, clientId }> of live console streams. The admin
// fan-out walks this map rather than the bus's admin audience, because the
// producer's own connection has to be excluded per-connection, and a bus
// listener cannot tell which connection a write came from.
const ownAdminStreams = new Map();

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
 *
 * ── Tickets, and end-to-end encryption ──────────────────────────────────────
 * Every thread has a short `SW-XXXXXXXX` reference (utils/ticketId.js), shown in
 * the queue and searchable by it, because "the one about the transfer" is not a
 * thing an operator can find and `SW-4KQ7M2XB` is.
 *
 * A thread may also be end-to-end encrypted, in which case the transcript
 * arrives here as ciphertext and is opened in the BROWSER with this operator's
 * private key. That key is not on this server and never was — see
 * models/chatEncryptionKeySchema.js — so "administrators can read support
 * messages" is true in the sense that an operator holding the key can, and
 * false in the sense that the operator console's host cannot.
 *
 * Which is also the operational cost, and the thing to get right: an operator
 * who registers a key AFTER a conversation was sealed cannot read it. That is
 * the same trade-off every end-to-end encrypted product makes, and the answer
 * here is the `POST /:id/keys` endpoint below — one click by a colleague who
 * can already read the thread re-seals it to everybody else.
 */
const router = express.Router();
// Same shape as the member router: the stream's ?token= (EventSource cannot
// set headers) is copied into the Authorization header on THIS path only,
// ahead of the router-wide protect, so admin auth runs exactly once.
router.use('/stream', streamTokenAuth);
router.use(protect, adminOnly);

const THREAD_USER_FIELDS = 'firstName lastName email accountStatus subscriptionPlan';

// Escapes a user-supplied search term before it becomes a RegExp. Without this
// a query of "(" is a syntax error that 500s, and a term of "a{1,1000}" is a
// pathological pattern on a large collection.
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pair the client's ciphertexts against the messages actually on the server.
 * Mirrors the member router's copy — see the note there for why a client is not
 * trusted to name its own messages.
 */
function applySealedMessages(raw, serverMessages) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > serverMessages.length) {
    throw new ChatInputError('That encryption payload is not valid.');
  }
  const byId = new Map(serverMessages.map((m) => [String(m._id), m]));
  const sealed = [];
  const seen = new Set();
  for (const entry of raw) {
    const id = String(entry?._id || '');
    const cipher = String(entry?.cipher || '').trim();
    if (!byId.has(id) || seen.has(id) || !isCipher(cipher) || !byId.get(id).body) {
      throw new ChatInputError('That encryption payload is not valid.');
    }
    seen.add(id);
    sealed.push({ _id: id, cipher });
  }
  return sealed;
}

const toThreadView = (thread, participant = '') => ({
  _id: thread._id,
  ticketId: thread.ticketId || '',
  subject: thread.subject,
  category: thread.category,
  categoryLabel: categoryLabel(thread.category),
  status: thread.status,
  lastMessageAt: thread.lastMessageAt,
  // Same rule as the member router: on a sealed thread the plaintext excerpt is
  // blanked and the sealed one travels instead, so the queue cannot render the
  // newest message of a conversation it is not allowed to read.
  lastMessagePreview: thread.encryption?.version ? '' : (thread.lastMessagePreview || ''),
  lastMessagePreviewCipher: thread.encryption?.version ? (thread.lastMessagePreviewCipher || '') : '',
  lastMessageBy: thread.lastMessageBy,
  messageCount: thread.messageCount,
  unreadByAdmin: thread.unreadByAdmin,
  unreadByUser: thread.unreadByUser,
  assignedTo: thread.assignedTo || '',
  resolved: thread.resolved || { by: '', at: null },
  encryption: encryptionView(thread),
  // Only this operator's own wrapped copy — never the member's, never a
  // colleague's. `sharesForParticipant` is the boundary.
  keyShares: participant ? sharesForParticipant(thread, participant) : [],
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

// @route   GET /api/admin/chats/stream
// @desc    SSE push channel for one operator's console. Every change to any
//          conversation — a member's new message or reply, a colleague's
//          reply, a resolve, a reopen, an assign, a delete, a seal — arrives
//          within milliseconds and the queue/panel refetches THAT thread
//          instead of waiting for the next 12s poll. Invalidation signals
//          only (no message content), so the read endpoints stay the source
//          of truth and E2E ciphertext never travels this channel.
//          Also registers the console's live presence, which is what the
//          member's "Active Now" reads.
// @access  Admin — accepts ?token= for EventSource
router.get('/stream', async (req, res) => {
  // protect + adminOnly have already run (router-wide, after the path-scoped
  // token copy above), so a non-admin token cannot reach this line.
  try {
    const clientId = String(req.query.clientId || '').slice(0, 40) || `anon-${Date.now()}`;
    const adminKey = String(req.user._id);
    // Marks this connection as the producer of any write made through it, so
    // announce() never echoes a console its own action.
    req.chatStreamClientId = clientId;

    markAdminActivity();
    addAdminConnection();
    sseHeaders(res);

    let closed = false;
    const sendChat = (event) => {
      if (closed || res.writableEnded) return;
      try {
        sseWrite(res, 'chat', event);
      } catch { closed = true; }
    };

    if (!ownAdminStreams.has(adminKey)) ownAdminStreams.set(adminKey, new Set());
    const entry = { res, clientId };
    ownAdminStreams.get(adminKey).add(entry);

    // The bus's admin audience is not used by this router's own fan-out (see
    // the note on ownAdminStreams), but a write published by ANOTHER file —
    // the member router's, which fans out through announce() there — reaches
    // consoles through it, so subscribe and let the bus do the cross-file work.
    const unsubBus = chatBus.subscribeAdmins(sendChat);

    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return;
      try {
        res.write(': hb\n\n');
        // A long-lived connection with no requests in flight still has to keep
        // stamping presence, or the poll window it replaced would lapse.
        markAdminActivity();
      } catch { closed = true; }
    }, SSE_HEARTBEAT_MS);

    // Admin tokens DO expire (unlike user sessions), and the client renews
    // them; close shortly before so the console reconnects on a fresh token.
    const expMs = tokenExpiryDelayMs(req);
    const expTimer = expMs ? setTimeout(() => cleanup(), expMs) : null;

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (expTimer) clearTimeout(expTimer);
      unsubBus();
      const set = ownAdminStreams.get(adminKey);
      if (set) {
        set.delete(entry);
        if (set.size === 0) ownAdminStreams.delete(adminKey);
      }
      removeAdminConnection();
      try { res.end(); } catch { /* already closed */ }
    }

    req.on('close', cleanup);
  } catch (error) {
    console.error('[admin/chats GET /stream]', error.message);
    if (!res.headersSent) res.status(500).json({ message: 'Could not open the conversation stream.' });
    else try { res.end(); } catch { /* ignore */ }
  }
});

// @route   GET /api/admin/chats
// @desc    The support queue: filters, search, counts
// @access  Admin
router.get('/', async (req, res) => {
  try {
    // The console polls this every 12s while open, so a hit here means an
    // operator is at the chats screen right now — the member inbox shows
    // "Active Now" off this. See utils/supportPresence.js.
    markAdminActivity();
    const participant = participantFor(req);
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
      // A ticket id is the one term a member will actually READ OUT over the
      // phone, so it has to be findable. It is matched as a literal field, not
      // a regex: "SW-4KQ7M2XB" typed approximately should still land on the
      // ticket somebody is holding, not silently match the first four
      // characters of everything.
      const ticket = normalizeTicketSearch(search);
      if (ticket) {
        or.push({ ticketId: ticket });
      } else {
        // …and a partial code is still useful ("4KQ7"), so it joins the regex
        // branch rather than replacing it.
        or.push({ ticketId: rx });
      }
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

    // Backfill here rather than in a migration so every thread in the queue has
    // a code to quote the moment this ships. See utils/ticketId.js.
    await withTicketIds(rows);

    return res.json({
      threads: (rows || []).map((thread) => toThreadView(thread, participant)),
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
//          Automatically returns encryption metadata for plaintext threads
//          so clients can auto-seal if capable.
// @access  Admin
router.get('/:id', async (req, res) => {
  try {
    markAdminActivity();
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
    await withTicketIds([thread]);
    // The member's side shows whether support has READ their message; push the
    // read instead of letting their "seen" state lag a poll behind.
    announce(req, { kind: 'read', thread: thread._id, by: 'admin' }, thread.user?._id || thread.user);

    // For plaintext threads, include member public key so the admin client can
    // auto-seal if it has encryption capability. This enables automatic
    // encryption of existing conversations without manual activation.
    let memberKey = null;
    let adminKeys = [];
    if (!isEncrypted(thread)) {
      try {
        // Get member's public key
        const member = await User.findById(thread.user?._id || thread.user)
          .select('chatEncryptionKey.publicKey')
          .lean();
        if (member?.chatEncryptionKey?.publicKey) {
          memberKey = {
            participant: participantForUser(thread.user?._id || thread.user),
            publicKey: member.chatEncryptionKey.publicKey,
          };
        }
        // Get other admin public keys
        adminKeys = await listOperatorPublicKeys({ excludeAlias: req.user.alias });
      } catch (keyError) {
        console.error('[admin/chats GET /:id keys]', keyError.message);
        memberKey = null;
        adminKeys = [];
      }
    }

    return res.json({
      thread: toThreadView({ ...thread, unreadByAdmin: 0 }, participantFor(req)),
      messages: (messages || []).map((m) => ({
        _id: m._id,
        author: m.author,
        authorName: m.authorName,
        // The console reads the real alias; the member router substitutes a
        // channel label at the same boundary. Only this one differs.
        body: m.cipher ? '' : (m.body || ''),
        cipher: m.cipher || '',
        createdAt: m.createdAt,
      })),
      // Include recipients for auto-sealing plaintext threads
      recipients: !isEncrypted(thread) ? [memberKey, ...adminKeys].filter(Boolean) : [],
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
    markAdminActivity();
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const thread = await ChatThread.findById(req.params.id);
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });

    // Same gate the member route uses, from the same shared function. An admin
    // is not exempt: "resolved" has to mean the thread is closed, or it means
    // nothing. Reopen first, then reply.
    assertThreadWritable(thread);

    if (thread.messageCount >= MAX_MESSAGES_PER_THREAD) {
      return res.status(400).json({ message: 'This conversation has reached its message limit.' });
    }

    // An encrypted thread accepts a ciphertext and refuses plaintext, so a reply
    // typed by an operator whose key failed to unlock cannot quietly drop the
    // conversation back to plaintext. readMessagePayload is the same function
    // the member router uses, for the same reason.
    const payload = readMessagePayload(req.body || {}, thread);

    const now = new Date();
    const alias = String(req.user.alias || 'Administrator').trim() || 'Administrator';
    const message = await ChatMessage.create({
      thread: thread._id,
      user: thread.user,
      author: 'admin',
      authorName: alias,
      body: payload.mode === 'encrypted' ? '' : payload.body,
      cipher: payload.cipher,
    });

    await ChatThread.updateOne(
      { _id: thread._id },
      {
        $set: {
          lastMessageAt: now,
          // The sealed excerpt replaces the plaintext one on an encrypted
          // thread. Writing only one of the two leaves the queue showing the
          // newest message of a conversation the server is not allowed to read.
          ...(payload.mode === 'encrypted'
            ? { lastMessagePreview: '', lastMessagePreviewCipher: payload.cipher }
            : { lastMessagePreview: buildPreview(payload.body), lastMessagePreviewCipher: '' }),
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
    // `link` is what makes the bell open THIS conversation instead of falling
    // through to a generic page.
    //
    // The detail line is the subject and the ticket id — never an excerpt of the
    // reply. On an encrypted thread there is no excerpt to leak, and writing
    // one here would put the words in a SECOND collection, which is the exact
    // leak the encryption exists to prevent.
    UserNotification.create({
      user: thread.user,
      type: 'info',
      title: 'Support replied to your message',
      detail: `“${thread.subject}” (${thread.ticketId || 'support'}) — a new reply from support.`,
      link: `/support?thread=${thread._id}`,
      linkLabel: 'Read the reply',
    }).catch((notifyError) => {
      console.error('[admin/chats member bell]', notifyError.message);
    });

    // The member learns about the reply on their own stream the instant it is
    // written, and every other console repaints the queue row. Published
    // before the response — see announce()'s ordering note.
    announce(req, { kind: 'message', thread: thread._id, by: 'admin' }, thread.user);

    return res.status(201).json({
      message: 'Reply sent.',
      message_record: {
        _id: message._id,
        thread: message.thread,
        author: message.author,
        authorName: message.authorName,
        body: message.cipher ? '' : message.body,
        cipher: message.cipher || '',
        createdAt: message.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof ChatInputError) return res.status(400).json({ message: error.message });
    if (error instanceof ChatStateError) return res.status(error.status).json({ message: error.message });
    console.error('[admin/chats POST /:id/messages]', error.message);
    return res.status(500).json({ message: 'Could not send your reply.' });
  }
});

// @route   GET /api/admin/chats/:id/recipients
// @desc    Everybody who can be granted access to a sealed conversation, and who
//          already has it.
// @access  Admin
//
// This is the data behind "Grant secure access". Re-sealing a conversation
// requires the public keys of the people it is being sealed TO, and the server
// is the only party that knows both those and who currently holds a share — so a
// list endpoint is the only way the grant button can be more than a guess.
router.get('/:id/recipients', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const thread = await ChatThread.findById(req.params.id)
      .select('user encryption.keyShares')
      .lean();
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });

    const shared = new Set((thread.encryption?.keyShares || []).map((share) => share.participant));
    const memberParticipant = participantForUser(thread.user);

    const admins = await AdminAccount.find({
      enabled: true,
      'chatEncryptionKey.publicKey': { $nin: ['', null] },
    }).select('_id alias chatEncryptionKey.publicKey').sort({ alias: 1 }).lean();

    // The member is deliberately first in the list. They are the one party who
    // must be able to read every conversation they opened, and a grant panel
    // that lists only colleagues is a panel that forgets the actual client.
    const member = await User.findById(thread.user).select('chatEncryptionKey').lean();
    const recipients = [];
    if (member?.chatEncryptionKey?.publicKey) {
      recipients.push({
        participant: memberParticipant,
        label: 'Member',
        publicKey: member.chatEncryptionKey.publicKey,
        hasShare: shared.has(memberParticipant),
        isMember: true,
      });
    }

    for (const admin of admins) {
      const participant = participantForAdmin(admin._id);
      // The caller cannot grant a share to themselves — they already have the
      // key or they could not be reading this list — so they are filtered here
      // rather than rendered as a row that does nothing.
      if (String(admin._id) === String(req.user._id)) continue;
      recipients.push({
        participant,
        label: admin.alias,
        publicKey: admin.chatEncryptionKey?.publicKey || '',
        hasShare: shared.has(participant),
        isMember: false,
      });
    }

    return res.json({ recipients });
  } catch (error) {
    console.error('[admin/chats GET /:id/recipients]', error.message);
    return res.status(500).json({ message: 'Could not read the recipients.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// THE OPERATOR'S ENCRYPTION IDENTITY
//
// Mirrors the member router's endpoints exactly. Two implementations that
// disagreed about what a registered key means would produce conversations one
// side could open and the other could not, which is the single worst failure
// mode this feature has.
// ══════════════════════════════════════════════════════════════════════════

// @route   GET /api/admin/chats/encryption/me
// @desc    The caller's own participant address. Sessions created before the
//          login response carried the AdminAccount id have no local copy of it,
//          and the encryption identity MUST be `admin:<AdminAccount._id>` —
//          the same string `participantForAdmin` puts on a key share. One read
//          of the signed token answers it without asking the client to guess.
// @access  Admin
router.get('/encryption/me', async (req, res) => {
  try {
    return res.json({ accountId: String(req.user._id), participant: participantFor(req) });
  } catch (error) {
    console.error('[admin/chats GET /encryption/me]', error.message);
    return res.status(500).json({ message: 'Could not read your account.' });
  }
});

// @route   GET /api/admin/chats/encryption/key
// @desc    This operator's published public key, and whether a recovery copy exists
// @access  Admin
router.get('/encryption/key', async (req, res) => {
  try {
    const admin = await AdminAccount.findById(req.user._id).select('chatEncryptionKey').lean();
    if (!admin) return res.status(404).json({ message: 'Admin account not found.' });
    return res.json({ key: keyView(admin) });
  } catch (error) {
    console.error('[admin/chats GET /encryption/key]', error.message);
    return res.status(500).json({ message: 'Could not read your encryption key.' });
  }
});

// @route   POST /api/admin/chats/encryption/key
// @desc    Publish a public key. Called on every visit to Chat management.
// @access  Admin
router.post('/encryption/key', async (req, res) => {
  try {
    const result = await registerPublicKey(AdminAccount, req.user._id, req.body || {});
    return res.json(result);
  } catch (error) {
    if (error instanceof KeyInputError) return res.status(400).json({ message: error.message });
    console.error('[admin/chats POST /encryption/key]', error.message);
    return res.status(500).json({ message: 'Could not publish your encryption key.' });
  }
});

// @route   POST /api/admin/chats/encryption/recovery
// @desc    Store the private key, sealed under a recovery code the operator saved
// @access  Admin
router.post('/encryption/recovery', async (req, res) => {
  try {
    const key = await saveRecoveryCopy(AdminAccount, req.user._id, req.body || {});
    return res.json({ key });
  } catch (error) {
    if (error instanceof KeyInputError) return res.status(400).json({ message: error.message });
    console.error('[admin/chats POST /encryption/recovery]', error.message);
    return res.status(500).json({ message: 'Could not store your recovery key.' });
  }
});

// @route   GET /api/admin/chats/encryption/recovery
// @desc    The sealed private key, for the one client that says it has a code.
//          Kept apart from GET /encryption/key for the reason given on the member
//          router: that endpoint is polled on every load, and this one answers a
//          request a human actually made.
// @access  Admin
router.get('/encryption/recovery', async (req, res) => {
  try {
    const admin = await AdminAccount.findById(req.user._id)
      .select('chatEncryptionKey.recoveryWrapped chatEncryptionKey.recoveryHint chatEncryptionKey.publicKey')
      .lean();
    const recovery = admin?.chatEncryptionKey || {};
    return res.json({
      hasRecovery: Boolean(recovery.recoveryWrapped),
      recoveryWrapped: recovery.recoveryWrapped || '',
      recoveryHint: recovery.recoveryHint || '',
      publicKey: recovery.publicKey || '',
    });
  } catch (error) {
    console.error('[admin/chats GET /encryption/recovery]', error.message);
    return res.status(500).json({ message: 'Could not read your saved recovery key.' });
  }
});

// @route   POST /api/admin/chats/:id/keys
// @desc    Grant other parties access to a sealed conversation.
//
// This is the answer to the operational cost of end-to-end encryption: an
// operator who registers a key after a conversation was sealed cannot read it,
// and only somebody who CAN read it can re-seal it to them. So this endpoint is
// the grant, and it requires the caller to already hold the content key — which
// the client proves by producing a valid share, not by asserting it.
//
// An operator may address a share to another operator or to the thread's own
// member. Nothing else. A member cannot reach this router at all.
// @access  Admin
router.post('/:id/keys', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const thread = await ChatThread.findById(req.params.id).lean();
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });
    if (!isEncrypted(thread)) {
      return res.status(400).json({ message: 'This conversation is not encrypted.' });
    }

    const memberParticipant = participantForUser(thread.user);
    const shares = normalizeKeyShares(req.body?.shares, {
      isAllowed: (participant) => participant.startsWith('admin:') || participant === memberParticipant,
    });

    // Upsert per participant rather than appending: re-granting a key that is
    // already there must replace it, not accumulate, or a thread that has been
    // shared a dozen times carries a dozen copies of the same secret.
    const updated = await ChatThread.findOneAndUpdate(
      { _id: thread._id },
      {
        $set: {
          'encryption.keyShares': shares.reduce(
            (all, share) => [...all, share],
            (thread.encryption?.keyShares || []).filter((existing) => !shares.some((s) => s.participant === existing.participant))
          ),
        },
      },
      { new: true }
    ).populate('user', THREAD_USER_FIELDS).lean();

    // A grant changes what a COLLEAGUE can read, so their open console (and
    // the member's own inbox preview) repaints now rather than at the poll.
    if (shares.length > 0) {
      announce(req, { kind: 'shared', thread: thread._id, by: 'admin' }, thread.user);
    }

    return res.json({
      message: `Access granted to ${shares.length} recipient${shares.length === 1 ? '' : 's'}.`,
      thread: toThreadView(updated, participantFor(req)),
    });
  } catch (error) {
    if (error instanceof ChatInputError) return res.status(400).json({ message: error.message });
    console.error('[admin/chats POST /:id/keys]', error.message);
    return res.status(500).json({ message: 'Could not grant access to the conversation.' });
  }
});

// @route   POST /api/admin/chats/:id/secure
// @desc    Seal an existing conversation: the client re-encrypts what it is
//          displaying and posts the ciphertexts back.
// @access  Admin
//
// The operator is the party most likely to want this — it is the one action that
// turns every conversation they have already read into something the database
// no longer holds — and it is safe for exactly the reason the member-side twin
// is: the plaintext was already in this browser, and after this call the server
// does not have it.
router.post('/:id/secure', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const thread = await ChatThread.findById(req.params.id)
      .populate('user', THREAD_USER_FIELDS)
      .lean();
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });
    if (isEncrypted(thread)) {
      return res.json({
        message: 'This conversation is already encrypted.',
        thread: toThreadView(thread, participantFor(req)),
      });
    }

    const messages = await ChatMessage.find({ thread: thread._id, cipher: '' })
      .sort({ createdAt: 1 })
      .select('_id cipher body')
      .limit(1000)
      .lean();
    const sealed = applySealedMessages(req.body?.messages, messages);
    if (sealed.length === 0) {
      throw new ChatInputError('There is nothing to encrypt in this conversation yet.');
    }

    // `thread.user` is a raw ObjectId on some reads and a populated document on
    // others (GET /:id and the responses the console adopts are populated). The
    // id is the only thing that may reach participantForUser/announce — an
    // object there stringifies to `user:[object Object]`, which the share
    // validator rejects and the event bus cannot route.
    const threadUserId = thread.user?._id || thread.user;
    const memberParticipant = participantForUser(threadUserId);
    const shares = normalizeKeyShares(req.body?.keyShares, {
      isAllowed: (participant) => participant.startsWith('admin:') || participant === memberParticipant,
    });

    await ChatMessage.bulkWrite(
      sealed.map(({ _id, cipher }) => ({
        updateOne: { filter: { _id, thread: thread._id }, update: { $set: { cipher, body: '' } } },
      }))
    );

    // The newest message decides what the queue shows, and the queue is the one
    // screen every operator sees. Sealing the transcript and leaving the summary
    // in plaintext would defeat the whole thing on the first screen it appears.
    const newest = messages[messages.length - 1];
    const previewCipher = sealed.find((entry) => String(entry._id) === String(newest?._id))?.cipher || '';
    await ChatThread.updateOne(
      { _id: thread._id },
      {
        $set: {
          encryption: { version: ENCRYPTION_VERSION, keyShares: shares },
          lastMessagePreview: '',
          lastMessagePreviewCipher: previewCipher,
        },
      }
    );

    // The member's inbox reads the row's encryption badge and its previews
    // from the thread summary, which just changed under them.
    announce(req, { kind: 'sealed', thread: thread._id, by: 'admin' }, threadUserId);

    // Populated like GET /:id: the console adopts whatever these three endpoints
    // answer as its loaded thread, and a view without `user` paints
    // "Unknown account" over the member panel the operator was just reading.
    const updated = await ChatThread.findById(thread._id).populate('user', THREAD_USER_FIELDS).lean();
    return res.json({
      message: `This conversation is now end-to-end encrypted (${sealed.length} message${sealed.length === 1 ? '' : 's'} sealed).`,
      thread: toThreadView(updated, participantFor(req)),
    });
  } catch (error) {
    if (error instanceof ChatInputError) return res.status(400).json({ message: error.message });
    console.error('[admin/chats POST /:id/secure]', error.message);
    return res.status(500).json({ message: 'Could not encrypt this conversation.' });
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

    // The member's thread becomes read-only on their side the moment this
    // lands — their open inbox must lock the composer immediately, not after
    // a poll (or, worse, let them type into a 409).
    announce(req, { kind: 'resolved', thread: updated._id, by: 'admin' }, updated.user?._id || updated.user);

    // Tell the member their thread is closed, so a resolved conversation in
    // their list is explained rather than looking like data loss. Fire-and-forget
    // like every other bell here: a failed notification must not undo a resolve.
    UserNotification.create({
      user: updated.user?._id || updated.user,
      type: 'info',
      title: 'Support conversation resolved',
      detail: `“${updated.subject}” was closed by support. You can start a new conversation at any time.`,
      link: `/support?thread=${updated._id}`,
      linkLabel: 'View the conversation',
    }).catch((notifyError) => {
      console.error('[admin/chats resolve bell]', notifyError.message);
    });

    return res.json({ message: 'Conversation resolved.', thread: toThreadView(updated, participantFor(req)) });
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

    // The mirror of the resolve: the member's composer unlocks live.
    announce(req, { kind: 'reopened', thread: updated._id, by: 'admin' }, updated.user?._id || updated.user);

    // The member has to know the thread is live again: it is closed and
    // read-only on their side, and nothing else would tell them it reopened.
    UserNotification.create({
      user: updated.user?._id || updated.user,
      type: 'info',
      title: 'Support conversation reopened',
      detail: `Support reopened “${updated.subject}”. You can reply again.`,
      link: `/support?thread=${updated._id}`,
      linkLabel: 'Reply now',
    }).catch((notifyError) => {
      console.error('[admin/chats reopen bell]', notifyError.message);
    });

    return res.json({ message: 'Conversation reopened.', thread: toThreadView(updated, participantFor(req)) });
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
    ).populate('user', THREAD_USER_FIELDS).lean();
    if (!updated) return res.status(404).json({ message: 'Conversation not found.' });
    // Carries this operator's own wrapped key like every other thread response.
    // The console REPLACES its loaded thread with whatever comes back from these
    // three endpoints, so a view that quietly dropped `keyShares` would strip
    // the admin's ability to read the very conversation they just acted on.
    //
    // Colleagues' queues show the owner chip — repaint it live rather than
    // leaving a stale "unassigned" until the next poll. The member does not
    // read assignments at all, so the bus's user copy is skipped here.
    announce(req, { kind: 'assign', thread: updated._id, by: 'admin' }, updated.user?._id || updated.user, { skipUser: true });
    return res.json({ thread: toThreadView(updated, participantFor(req)) });
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
    // Read the OWNER before the delete: it is the only moment the member's id
    // is still on hand to address the push to, and their inbox must drop the
    // conversation the instant it is gone rather than showing a row that 404s.
    const existing = await ChatThread.findById(req.params.id).select('user').lean();
    const thread = await ChatThread.findByIdAndDelete(req.params.id).select('_id').lean();
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });
    // Messages are NOT cascaded by mongoose here (no ref middleware in this
    // codebase), so the transcript is removed explicitly. Doing it in this order
    // means a failure leaves messages that are unreachable by any route rather
    // than a thread pointing at a transcript that is still queryable.
    await ChatMessage.deleteMany({ thread: thread._id });
    announce(req, { kind: 'deleted', thread: thread._id, by: 'admin' }, existing?.user || thread.user);
    return res.json({ message: 'Conversation deleted.' });
  } catch (error) {
    console.error('[admin/chats DELETE /:id]', error.message);
    return res.status(500).json({ message: 'Could not delete the conversation.' });
  }
});

module.exports = router;
