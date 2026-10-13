const express = require('express');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const User = require('../models/User');
const ChatThread = require('../models/ChatThread');
const ChatMessage = require('../models/ChatMessage');
const {
  ChatInputError,
  ChatStateError,
  MAX_MESSAGES_PER_THREAD,
  normalizeCategory,
  assertThreadWritable,
  statusAfterMessage,
  buildPreview,
} = require('../utils/supportChat');
const {
  ENCRYPTION_VERSION,
  participantForUser,
  readMessagePayload,
  normalizeKeyShares,
  sharesForParticipant,
  encryptionView,
  isEncrypted,
  isCipher,
  claimThreadForSealing,
  releaseThreadSealingClaim,
} = require('../utils/chatEncryption');
const {
  KeyInputError,
  keyView,
  registerPublicKey,
  saveRecoveryCopy,
  listOperatorPublicKeys,
} = require('../utils/chatKeys');
const { createThread, withTicketIds } = require('../utils/ticketId');
const { isSupportActive, onSupportActiveChange } = require('../utils/supportPresence');
const { SSE_HEARTBEAT_MS, streamTokenAuth, sseWrite, sseHeaders, tokenExpiryDelayMs } = require('../utils/sse');
const chatBus = require('../utils/chatEventBus');

/**
 * Announce a conversation change on every channel that must learn about it:
 * the chat bus (all other devices/tabs, member and admin audiences) and this
 * user's OWN stream connections, so a second tab of the same account syncs
 * too. The event is an INVALIDATION signal only — `{ kind, thread, by }`,
 * never message content — so the read endpoints stay the source of truth and
 * nothing about E2E ciphertext rides this channel.
 *
 * CALL IT BEFORE res.json/sendStatus. A client that gets the HTTP reply may
 * refetch instantly, and a push that races ahead of the write being readable
 * makes the actor's own message blink out of a repaint. The bus is in-process
 * and synchronous, so publishing before the response means every recipient's
 * refetch happens after the write is durable.
 */
function announce(req, event, threadUserId) {
  const key = String(req.user?._id || '').trim();
  const producerId = req.chatStreamClientId || '';
  // The member produced this write themselves: OTHER devices/tabs of theirs
  // must hear it (ownStreams below) and every admin console must hear it
  // (admin audience), but the bus's user audience would only storm the
  // producer's own connections — including the one that just optimistically
  // appended. Admin-side writes (resolve, reopen, an operator's reply) arrive
  // at this member through the bus's user audience instead, published by
  // routes/adminSupportChats.js.
  chatBus.publishChat(event, threadUserId, { skipUser: key === String(threadUserId) });
  const set = key ? ownStreams.get(key) : null;
  if (!set) return;
  for (const { res, clientId } of [...set]) {
    // The connection that produced the write is never echoed: its client has
    // already updated itself, and an echo would race that append.
    if (clientId === producerId) continue;
    try {
      sseWrite(res, 'chat', event);
    } catch { /* dead client — the close handler cleans it up */ }
  }
}

// userId -> Set<{ res, clientId }> of this member's live stream connections.
// A write from connection A must echo to connections B, C … of the SAME
// account; the bus's user audience excludes the producer's own listeners only
// after this map tells us which connections those are, so the echo is done
// here directly.
const ownStreams = new Map();

/**
 * Console-only announcement: the admin consoles need to know, and the member's
 * OWN tabs must not hear it.
 *
 * 'read' is the case that makes this necessary rather than merely tidier. A
 * member's tab refetches a thread → that GET marks it read → if the mark were
 * pushed back to the member's own connections, their client would refresh the
 * transcript → which GETs the thread → which marks it read again. A loop that
 * is invisible on one device and a refetch storm on two. Nothing on the
 * member's side needs a push about their own reading — the badge is already
 * right locally and the poll reconciles another tab within twelve seconds —
 * while the console genuinely must stop glowing for a reply that has been seen.
 */
function announceAdmins(req, event, threadUserId) {
  try {
    chatBus.publishChat(event, threadUserId, { skipUser: true });
  } catch (error) {
    console.error('[support-chat announce]', error.message);
  }
}

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
 * ── Tickets and encryption ──────────────────────────────────────────────────
 * Every thread carries a short `SW-XXXXXXXX` reference (utils/ticketId.js) so
 * it can be quoted over the phone, and may be end-to-end encrypted, in which
 * case a send carries `cipher` instead of `body` and the server stores
 * something it cannot read (utils/chatEncryption.js). Both features are
 * additive: a thread with neither is an ordinary conversation, and every
 * message written before them still reads exactly as it did.
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
// The stream authenticates with ?token= because EventSource cannot set an
// Authorization header, and that token must be copied into the header BEFORE
// protect runs — so it is registered as pre-middleware on this one path,
// ahead of the router-wide protect. Every other route in this file still
// requires the header, exactly as before. See utils/sse.js.
router.use('/stream', streamTokenAuth);
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
 * The member's own participant address, and the ONLY share the member is ever
 * shown. Everything else in `encryption.keyShares` is sealed to somebody else's
 * public key and is not this router's to distribute — see
 * `sharesForParticipant` in utils/chatEncryption.js.
 */
const memberParticipant = (req) => participantForUser(req.user._id);

/**
 * Never let a stored document carry an unexpected author into a render, and
 * never let it carry an admin alias out of this router either.
 */
const toMessageView = (message) => ({
  _id: message._id,
  thread: message.thread,
  author: message.author,
  authorName: message.author === 'admin'
    ? SUPPORT_AUTHOR_LABEL
    : (message.authorName || ''),
  // Exactly one of these two is populated. Both travel because the client has
  // to render a transcript that mixes a legacy plaintext thread with a newly
  // encrypted one, and deciding which by guessing would be guesswork.
  body: message.cipher ? '' : (message.body || ''),
  cipher: message.cipher || '',
  createdAt: message.createdAt,
});

const toThreadView = (thread, participant = '') => ({
  _id: thread._id,
  ticketId: thread.ticketId || '',
  subject: thread.subject,
  category: thread.category,
  status: thread.status,
  lastMessageAt: thread.lastMessageAt,
  lastMessagePreview: thread.encryption?.version ? '' : (thread.lastMessagePreview || ''),
  lastMessagePreviewCipher: thread.encryption?.version ? (thread.lastMessagePreviewCipher || '') : '',
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
  // The encryption state, plus the ONE wrapped copy addressed to this member.
  // Without the latter a member who reloads the page could read nothing at all;
  // with it, and only it, they can.
  encryption: encryptionView(thread),
  keyShares: participant ? sharesForParticipant(thread, participant) : [],
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
async function appendMessage({ thread, author, authorName, payload }) {
  const now = new Date();
  const message = await ChatMessage.create({
    thread: thread._id,
    user: thread.user,
    author,
    authorName,
    body: payload.mode === 'encrypted' ? '' : payload.body,
    cipher: payload.cipher,
  });

  // The reader's own counter goes to zero and the OTHER side's goes up by one.
  // These two counters are only ever written here and by the read endpoints, so
  // "unread" cannot disagree with itself between the list and the thread view.
  const inc = author === 'user' ? { unreadByAdmin: 1 } : { unreadByUser: 1 };

  // On an encrypted thread the summary holds the SEALED excerpt and an empty
  // plaintext one. Both fields are written on both paths so a thread can never
  // be left holding a plaintext preview of a message that is supposed to be
  // unreadable — which is exactly the kind of leak that survives an audit
  // because every individual field looks correct.
  const summary = payload.mode === 'encrypted'
    ? { lastMessagePreview: '', lastMessagePreviewCipher: payload.cipher }
    : { lastMessagePreview: buildPreview(payload.body), lastMessagePreviewCipher: '' };

  await ChatThread.updateOne(
    { _id: thread._id },
    {
      $set: {
        lastMessageAt: now,
        ...summary,
        lastMessageBy: author,
        status: statusAfterMessage(author),
        resolved: { by: '', at: null },
      },
      $inc: { messageCount: 1, ...inc },
    }
  );

  return message;
}

// @route   GET /api/support-chat/stream
// @desc    SSE push channel for one member: every change to any of their
//          conversations — an admin reply, a resolve, a reopen, a seal, a
//          delete, a read, and operator-presence flips — arrives within
//          milliseconds, and the inbox refetches THAT thread instead of
//          waiting for the next 12s poll. The events are invalidation
//          signals only (no message content), so the read endpoints stay the
//          source of truth and E2E ciphertext never travels this channel.
//          Falls back to the polls if the stream cannot connect.
// @access  Private (user) — accepts ?token= for EventSource
router.get('/stream', async (req, res) => {
  // protect has already run (router-wide, after the path-scoped token copy
  // above); this is the same refusal every other route in this file makes.
  if (!requireUserAccount(req, res)) return;
  try {
    const clientId = String(req.query.clientId || '').slice(0, 40) || `anon-${Date.now()}`;
    const userId = String(req.user._id);
    // Lets announce() tell which of this account's connections produced a
    // write, so the writer is never echoed.
    req.chatStreamClientId = clientId;

    sseHeaders(res);

    let closed = false;
    // Bus chat events reaching THIS connection are writes the member did not
    // produce (announce() skips the user audience on their own writes and
    // delivers same-account tabs directly), so there is nothing to echo-filter
    // here — an event is by definition news from the other side.
    const sendChat = (event) => {
      if (closed || res.writableEnded) return;
      try {
        sseWrite(res, 'chat', event);
      } catch { closed = true; }
    };
    const sendPresence = (active) => {
      if (closed || res.writableEnded) return;
      try {
        sseWrite(res, 'presence', { supportActive: active });
      } catch { closed = true; }
    };

    // Snapshot on connect — a reconnecting tab catches up on presence without
    // waiting for the next list poll; conversation changes come via the
    // client's own mount fetch.
    sendPresence(isSupportActive());

    const unsubBus = chatBus.subscribeUser(userId, sendChat);
    const unsubPresence = onSupportActiveChange(sendPresence);

    // Register on the shared per-user map so writes from the member's OTHER
    // connections (their second tab, their phone) echo back here.
    if (!ownStreams.has(userId)) ownStreams.set(userId, new Set());
    const entry = { res, clientId };
    ownStreams.get(userId).add(entry);

    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return;
      try { res.write(': hb\n\n'); } catch { closed = true; }
    }, SSE_HEARTBEAT_MS);

    // Admin tokens expire; user session tokens do not (utils/userSession.js),
    // so tokenExpiryDelayMs returning null here is the normal case.
    const expMs = tokenExpiryDelayMs(req);
    const expTimer = expMs ? setTimeout(() => cleanup(), expMs) : null;

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (expTimer) clearTimeout(expTimer);
      unsubBus();
      unsubPresence();
      const set = ownStreams.get(userId);
      if (set) {
        set.delete(entry);
        if (set.size === 0) ownStreams.delete(userId);
      }
      try { res.end(); } catch { /* already closed */ }
    }

    req.on('close', cleanup);
  } catch (error) {
    console.error('[support-chat GET /stream]', error.message);
    if (!res.headersSent) res.status(500).json({ message: 'Could not open the conversation stream.' });
    else try { res.end(); } catch { /* ignore */ }
  }
});

// @route   GET /api/support-chat
// @desc    The member's conversations, most recently active first
// @access  Private
router.get('/', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    const participant = memberParticipant(req);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const [threads, unreadCount] = await Promise.all([
      // Unanswered support replies float to the top: a reply the member has
      // not seen yet is the most important row in their inbox, and "priority
      // until seen" beats pure recency (a thread they were typing in can
      // otherwise bury it). Within each group, most recently active first.
      ChatThread.find({ user: req.user._id })
        .sort({ unreadByUser: -1, lastMessageAt: -1 })
        .limit(limit)
        .lean(),
      ChatThread.countDocuments({ user: req.user._id, unreadByUser: { $gt: 0 } }),
    ]);
    // Legacy threads get their ticket id here, on first sight, rather than
    // waiting on a migration. See utils/ticketId.js withTicketIds().
    await withTicketIds(threads);
    res.json({
      threads: (threads || []).map((thread) => toThreadView(thread, participant)),
      unreadCount,
      // Whether an operator is at the support console right now — the inbox
      // renders this as "Active Now" / "Away". See utils/supportPresence.js.
      supportActive: isSupportActive(),
    });
  } catch (error) {
    console.error('[support-chat GET]', error.message);
    res.status(500).json({ message: 'Could not load your conversations.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// THE MEMBER'S ENCRYPTION IDENTITY
//
// Four small endpoints, all about the same P-256 key pair. The private half
// never appears in any of them — see models/chatEncryptionKeySchema.js for why
// that is the difference between end-to-end encryption and "the server holds an
// extra copy".
// ══════════════════════════════════════════════════════════════════════════

// @route   GET /api/support-chat/encryption/recovery
// @desc    The sealed private key, for the one client that says it has a code.
// @access  Private
//
// Kept apart from GET /encryption/key on purpose. That endpoint is polled by the
// inbox on load and answers "do you have a key"; this one answers "give me the
// sealed copy so I can try a code against it". Returning the wrapper from the
// first would put a file on the wire that exists solely to be attacked offline,
// for no request anybody was making.
router.get('/encryption/recovery', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    const user = await User.findById(req.user._id).select('chatEncryptionKey.recoveryWrapped chatEncryptionKey.recoveryHint chatEncryptionKey.publicKey').lean();
    const recovery = user?.chatEncryptionKey || {};
    return res.json({
      hasRecovery: Boolean(recovery.recoveryWrapped),
      recoveryWrapped: recovery.recoveryWrapped || '',
      recoveryHint: recovery.recoveryHint || '',
      // So the client can tell "wrong code" apart from "this account has no
      // saved recovery copy", which are two different things to say to a person.
      publicKey: recovery.publicKey || '',
    });
  } catch (error) {
    console.error('[support-chat GET /encryption/recovery]', error.message);
    return res.status(500).json({ message: 'Could not read your saved recovery key.' });
  }
});

// @route   GET /api/support-chat/encryption/key
// @desc    This account's published public key, and whether a recovery copy exists
// @access  Private
router.get('/encryption/key', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    const user = await User.findById(req.user._id).select('chatEncryptionKey').lean();
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    return res.json({ key: keyView(user) });
  } catch (error) {
    console.error('[support-chat GET /encryption/key]', error.message);
    return res.status(500).json({ message: 'Could not read your encryption key.' });
  }
});

// @route   POST /api/support-chat/encryption/key
// @desc    Publish a public key. Called on every visit; a no-op when unchanged.
// @access  Private
router.post('/encryption/key', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    const result = await registerPublicKey(User, req.user._id, req.body || {});
    return res.json(result);
  } catch (error) {
    if (error instanceof KeyInputError) return res.status(400).json({ message: error.message });
    console.error('[support-chat POST /encryption/key]', error.message);
    return res.status(500).json({ message: 'Could not publish your encryption key.' });
  }
});

// @route   POST /api/support-chat/encryption/recovery
// @desc    Store the private key, sealed under a recovery code the member saved.
//          The code itself is never transmitted and never stored.
// @access  Private
router.post('/encryption/recovery', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    const key = await saveRecoveryCopy(User, req.user._id, req.body || {});
    return res.json({ key });
  } catch (error) {
    if (error instanceof KeyInputError) return res.status(400).json({ message: error.message });
    console.error('[support-chat POST /encryption/recovery]', error.message);
    return res.status(500).json({ message: 'Could not store your recovery key.' });
  }
});

// @route   GET /api/support-chat/encryption/operators
// @desc    The operator public keys a member needs before opening an encrypted
//          conversation. Public keys are public — this is the mechanism, not a
//          disclosure. See utils/chatKeys.js listOperatorPublicKeys().
// @access  Private
router.get('/encryption/operators', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    const operators = await listOperatorPublicKeys();
    // The list is the single thing that decides whether a NEW conversation can
    // be encrypted at all: with no operator key, a member could seal the
    // message to nobody and support would never read it. The client checks this
    // and pauses sending with an explanation rather than storing plaintext or
    // producing an unreadable ticket.
    return res.json({ operators, canEncrypt: operators.length > 0 });
  } catch (error) {
    console.error('[support-chat GET /encryption/operators]', error.message);
    return res.status(500).json({ message: 'Could not reach the support team securely.' });
  }
});

// @route   POST /api/support-chat
// @desc    Start a new conversation. The first message must be encrypted in the
//          member's browser and wrapped for the member and at least one admin.
// @access  Private
router.post('/', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    // A new thread must never be created in plaintext. Encryption is performed
    // in the member's browser; the server only validates envelope shape.
    const payload = readMessagePayload(
      req.body || {},
      { encryption: { version: 0 } },
      { creating: true, requireEncryption: true }
    );
    if (payload.mode !== 'encrypted') {
      throw new ChatInputError('Secure messaging is not ready. Please retry after encryption setup completes.');
    }
    const category = normalizeCategory(req.body?.category);

    // The subject is a typed title, NOT part of the sealed message — see the
    // header of utils/chatEncryption.js for why the queue can read it and must.
    // An encrypted send therefore cannot fall back to an excerpt of the body
    // (the server has no body), so the client is required to send one. It always
    // can: it derives a default from the first line before encrypting.
    const subject = requireEncryptedSubject(req.body?.subject);

    // A member may only ever address a share to themselves or to an operator.
    // The server cannot check that a wrapped blob really was sealed to the
    // operator named beside it — it has no way to open one — so the boundary
    // that is checkable is the one that matters: which addresses are allowed to
    // appear in the list at all.
    const selfParticipant = memberParticipant(req);
    const keyShares = normalizeKeyShares(req.body?.keyShares, {
      isAllowed: (participant) => participant === selfParticipant || participant.startsWith('admin:'),
    });

    // A sealed ticket must be readable by somebody OTHER than its author. The
    // client only seals when an operator key exists (`canSealNew`), but a
    // directory that went stale mid-session must not be able to open a
    // conversation only the member can read — that is data loss wearing an
    // encryption badge, and the server is the last party that can tell.
    if (!keyShares.some((share) => share.participant === selfParticipant)) {
      throw new ChatInputError('This conversation needs an encryption key for your account.');
    }
    if (!keyShares.some((share) => share.participant.startsWith('admin:'))) {
      throw new ChatInputError('Suppliwise Support has not published an encryption key yet. Your message was not sent.');
    }

    const thread = await createThread({
      user: req.user._id,
      subject,
      category,
      status: 'open',
      lastMessageAt: new Date(),
      lastMessageBy: 'user',
      messageCount: 1,
      // The opening message is by definition unread on our side.
      unreadByAdmin: 1,
      unreadByUser: 0,
      encryption: { version: ENCRYPTION_VERSION, keyShares },
      lastMessagePreview: '',
      lastMessagePreviewCipher: payload.cipher,
    });

    await ChatMessage.create({
      thread: thread._id,
      user: req.user._id,
      author: 'user',
      authorName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email || 'Member',
      body: '',
      cipher: payload.cipher,
    });

    // Ring the admin bell. Fire-and-forget: a failed notification must never
    // cost the member their message, and the thread itself is already durable.
    // `type` is in the AdminEvent enum — see the note in models/AdminEvent.js
    // about a value missing from that enum silently dropping every audit row.
    //
    // The detail line carries the SUBJECT and the ticket id, never an excerpt of
    // the message. On an encrypted thread the server has no excerpt to leak, and
    // on a plain one there is no reason to copy the member's words into a
    // second collection just to render a bell.
    //
    // It also carries no NAME OR EMAIL. That used to read
    // `"${who} started …"`, which every admin in the console then held a copy
    // of — the member's identity broadcast into a queue to describe one arrival.
    // An operator opening the thread gets the same identity from the thread
    // itself, which they are already authorised to read; the bell says only
    // that something is waiting.
    //
    // The ticket id stands in for the name and is enough to work with: it is
    // stable, unique, and appears in the Chat management list the link opens.
    require('../models/AdminEvent').create({
      type: 'support-chat',
      title: 'New support conversation',
      detail: `A new conversation “${subject}” (${thread.ticketId}) is waiting for a reply.`,
      user: req.user._id,
      linkUserId: req.user._id,
      // Opens Chat management ON this conversation rather than the bare tab.
      link: `chats?thread=${thread._id}`,
      linkLabel: 'Open the conversation',
    }).catch((notifyError) => {
      console.error('[support-chat admin bell]', notifyError.message);
    });

    // Every admin console learns about the new conversation immediately
    // (queue row + counts), and the member's other tabs learn about their own
    // send. Published BEFORE the response for the ordering reason in announce.
    announce(req, { kind: 'message', thread: thread._id, by: 'user' }, thread.user);

    res.status(201).json({
      message: 'Your message was sent. An administrator will reply here.',
      thread: toThreadView(thread, selfParticipant),
    });  } catch (error) {
    if (error instanceof ChatInputError) return res.status(400).json({ message: error.message });
    console.error('[support-chat POST]', error.message);
    res.status(500).json({ message: 'Could not send your message.' });
  }
});

/** An encrypted send has no body for the server to excerpt a subject from. */
function requireEncryptedSubject(value) {
  const subject = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!subject) {
    throw new ChatInputError('Please add a subject so support can find your conversation.');
  }
  return subject;
}

// @route   GET /api/support-chat/:id
// @desc    One conversation with its transcript. Reading marks it read.
//          Automatically returns encryption metadata for plaintext threads
//          so clients can auto-seal if capable.
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
    // The one place a thread opened directly by id still needs its ticket id —
    // the list backfills, this read does not go through it.
    await withTicketIds([thread]);

    // For plaintext threads, include operator public keys so the client can
    // auto-seal if it has encryption capability. This enables automatic
    // encryption of existing conversations without manual activation.
    let operators = [];
    if (!isEncrypted(thread)) {
      try {
        operators = await listOperatorPublicKeys();
      } catch (opError) {
        console.error('[support-chat GET /:id operators]', opError.message);
        operators = [];
      }
    }

    // Tell every admin console this thread just became read on the member's
    // side: their unread badge and "priority until seen" ordering must not
    // keep glowing for a reply the member has already opened. Console-only —
    // see announceAdmins for the refetch loop this avoids.
    announceAdmins(req, { kind: 'read', thread: thread._id, by: 'user' }, req.user._id);

    // Fetch admin profiles who have replied in this thread for avatar display
    const AdminAccount = require('../models/AdminAccount');
    const adminNames = [...new Set(
      messages
        .filter(m => m.author === 'admin' && m.authorName)
        .map(m => m.authorName)
    )];
    const adminProfiles = {};
    if (adminNames.length > 0) {
      const admins = await AdminAccount.find({ alias: { $in: adminNames } })
        .select('alias profilePicture')
        .lean();
      admins.forEach(admin => {
        adminProfiles[admin.alias] = admin.profilePicture || '';
      });
    }

    return res.json({
      thread: toThreadView({ ...thread, unreadByUser: 0 }, memberParticipant(req)),
      messages: (messages || []).map(toMessageView),
      // Include operators for auto-sealing plaintext threads
      operators,
      // Fresh presence for the thread header, so a deep-linked open does not
      // wait for the next list poll to answer "is support here?".
      supportActive: isSupportActive(),
      // Admin profiles for avatar display
      adminProfiles,
    });
  } catch (error) {
    console.error('[support-chat GET /:id]', error.message);
    return res.status(500).json({ message: 'Could not load the conversation.' });
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
    const thread = await ChatThread.findOne({ _id: req.params.id, user: req.user._id });
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });
    if (!isEncrypted(thread)) {
      return res.status(409).json({ message: 'This older conversation is being secured. Reopen it after encryption completes to reply.' });
    }

    // Before the message-count check, so a resolved thread reports "resolved"
    // rather than a limit the member cannot do anything about either.
    assertThreadWritable(thread);

    if (thread.messageCount >= MAX_MESSAGES_PER_THREAD) {
      return res.status(400).json({
        message: 'This conversation has reached its message limit. Please start a new one.',
      });
    }

    // An encrypted thread accepts a ciphertext and refuses plaintext, so a
    // single unencrypted reply cannot land in the middle of a conversation that
    // is supposed to be sealed. The 2000-character cap is applied to the
    // DECRYPTED text by the client, before it encrypts — the server is not
    // holding a plaintext to measure.
    const payload = readMessagePayload(req.body || {}, thread);

    const message = await appendMessage({
      thread,
      author: 'user',
      authorName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email || 'Member',
      payload,
    });

    // Before the response, for the ordering reason in announce(): the admin
    // console's instant refetch must never read a transcript that lacks this
    // message, and its own reply append is protected by the same rule.
    announce(req, { kind: 'message', thread: thread._id, by: 'user' }, thread.user);

    res.status(201).json({ message: 'Reply sent.', message_record: toMessageView(message) });
  } catch (error) {
    if (error instanceof ChatInputError) return res.status(400).json({ message: error.message });
    if (error instanceof ChatStateError) return res.status(error.status).json({ message: error.message });
    console.error('[support-chat POST /:id/messages]', error.message);
    res.status(500).json({ message: 'Could not send your reply.' });
  }
});

// @route   POST /api/support-chat/:id/secure
// @desc    Seal an existing conversation. The client re-encrypts every message
//          it is currently displaying and posts the ciphertexts back; the server
//          replaces the plaintexts, stamps the version and records the shares.
// @access  Private
//
// Why the member can do this: the plaintext is ALREADY in this browser's memory
// — the member just read it on screen. Encrypting it here changes who can read
// it from here on (a database dump, a log, a backup) without changing anything
// about who can read it right now. It is the cheapest possible version of the
// promise and the server can be sure of one thing only: that afterwards, it
// does not hold the words.
router.post('/:id/secure', async (req, res) => {
  let sealingClaim = '';
  if (!requireUserAccount(req, res)) return;
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const thread = await ChatThread.findOne({ _id: req.params.id, user: req.user._id }).lean();
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });
    if (isEncrypted(thread)) {
      return res.json({ message: 'This conversation is already encrypted.', thread: toThreadView(thread, memberParticipant(req)) });
    }

    const messages = await ChatMessage.find({ thread: thread._id, cipher: '' })
      .sort({ createdAt: 1 })
      .select('_id cipher body')
      .limit(500)
      .lean();

    const sealed = applySealedMessages(req.body?.messages, messages, MAX_MESSAGES_PER_THREAD);
    if (sealed.length === 0) {
      throw new ChatInputError('There is nothing to encrypt in this conversation yet.');
    }

    const selfParticipant = memberParticipant(req);
    const keyShares = normalizeKeyShares(req.body?.keyShares, {
      isAllowed: (participant) => participant === selfParticipant || participant.startsWith('admin:'),
    });
    if (!keyShares.some((share) => share.participant === selfParticipant)
      || !keyShares.some((share) => share.participant.startsWith('admin:'))) {
      throw new ChatInputError('This conversation needs a key for you and Suppliwise Support.');
    }

    sealingClaim = await claimThreadForSealing(ChatThread, thread._id);
    if (!sealingClaim) {
      const current = await ChatThread.findOne({ _id: thread._id, user: req.user._id }).lean();
      if (isEncrypted(current)) {
        return res.json({
          message: 'This conversation is already encrypted.',
          thread: toThreadView(current, selfParticipant),
        });
      }
      return res.status(409).json({ message: 'Encryption is already being set up. Please retry shortly.' });
    }

    await ChatMessage.bulkWrite(
      sealed.map(({ _id, cipher }) => ({
        updateOne: { filter: { _id, thread: thread._id }, update: { $set: { cipher, body: '' } } },
      }))
    );

    // The denormalised summary is the part that is easiest to forget: sealing 40
    // messages and leaving the newest one in plaintext in `lastMessagePreview`
    // would leave the inbox list — the one screen every member and every
    // operator sees — showing the entire conversation in the clear.
    const newest = messages[messages.length - 1];
    const previewCipher = sealed.find((entry) => String(entry._id) === String(newest?._id))?.cipher || '';
    const sealedThread = await ChatThread.updateOne(
      { _id: thread._id, 'encryption.sealingId': sealingClaim },
      {
        $set: {
          'encryption.version': ENCRYPTION_VERSION,
          'encryption.keyShares': keyShares,
          lastMessagePreview: '',
          lastMessagePreviewCipher: previewCipher,
        },
        $unset: { 'encryption.sealingId': 1, 'encryption.sealingAt': 1 },
      }
    );
    if (!sealedThread.modifiedCount) {
      throw new ChatInputError('Encryption could not be completed. Please reopen the conversation and try again.');
    }
    sealingClaim = '';

    const updated = await ChatThread.findById(thread._id).lean();
    // The console's queue badge and open transcript repaint at once — a thread
    // that just became sealed changes what an operator can read there.
    announce(req, { kind: 'sealed', thread: thread._id, by: 'user' }, thread.user);
    return res.json({
      message: `This conversation is now end-to-end encrypted (${sealed.length} message${sealed.length === 1 ? '' : 's'} sealed).`,
      thread: toThreadView(updated, selfParticipant),
    });
  } catch (error) {
    await releaseThreadSealingClaim(ChatThread, req.params.id, sealingClaim);
    if (error instanceof ChatInputError) return res.status(400).json({ message: error.message });
    console.error('[support-chat POST /:id/secure]', error.message);
    return res.status(500).json({ message: 'Could not encrypt this conversation.' });
  }
});

/**
 * Pair the client's ciphertexts against the messages actually on the server.
 *
 * The client is not trusted to say which message it is sealing: it sends ids,
 * and this drops anything that is not a message of THIS thread that still has
 * plaintext. Otherwise a member could POST `{ _id: <someone else's message> }`
 * and overwrite it with a blob of their choosing.
 */
function applySealedMessages(raw, serverMessages, limit) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (raw.length > Math.min(serverMessages.length, limit)) {
    throw new ChatInputError('That encryption payload is not valid.');
  }
  const byId = new Map(serverMessages.map((m) => [String(m._id), m]));
  const sealed = [];
  const seen = new Set();
  for (const entry of raw) {
    const id = String(entry?._id || '');
    const cipher = String(entry?.cipher || '').trim();
    if (!byId.has(id) || seen.has(id) || !isCipher(cipher)) {
      throw new ChatInputError('That encryption payload is not valid.');
    }
    // A message with no plaintext has nothing to seal; accepting it would let a
    // client overwrite a sealed message with a ciphertext of its own choosing,
    // which is a quieter version of the problem the check above prevents.
    if (!byId.get(id).body) throw new ChatInputError('That encryption payload is not valid.');
    seen.add(id);
    sealed.push({ _id: id, cipher });
  }
  return sealed;
}

// @route   POST /api/support-chat/:id/keys
// @desc    Re-share this conversation's key with the support team.
// @access  Private
//
// The member-side twin of POST /api/admin/chats/:id/keys, and the answer to a
// real operational hole: a conversation sealed before an operator published a
// key (or sealed with a key that browser has since lost) is unreadable on the
// admin side forever, because only a party that HOLDS the content key can
// grant it — and the only party that always can is the member themselves.
//
// A member may address shares to operators ONLY (`admin:*`). They cannot park
// a share for another member account, so this cannot turn a private
// conversation into a broadcast one. The client proves it holds the key by
// producing valid wrapped shares; the server routes them and stores them, and
// still cannot open any of them.
router.post('/:id/keys', async (req, res) => {
  if (!requireUserAccount(req, res)) return;
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid conversation.' });
    }
    const thread = await ChatThread.findOne({ _id: req.params.id, user: req.user._id }).lean();
    if (!thread) return res.status(404).json({ message: 'Conversation not found.' });
    if (!isEncrypted(thread)) {
      return res.status(400).json({ message: 'This conversation is not encrypted.' });
    }

    const shares = normalizeKeyShares(req.body?.shares, {
      isAllowed: (participant) => participant.startsWith('admin:'),
    });

    // Upsert per participant, same rule as the admin twin: re-granting must
    // replace a colleague's stale share, not accumulate copies of it.
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
    ).lean();

    // A real grant repaints the console's grant panel; the routine background
    // auto-grant with nothing new to give (shares.length 0) stays silent.
    if (shares.length > 0) {
      announce(req, { kind: 'shared', thread: thread._id, by: 'user' }, thread.user);
    }

    return res.json({
      message: `Access granted to ${shares.length} operator${shares.length === 1 ? '' : 's'}.`,
      thread: toThreadView(updated, memberParticipant(req)),
    });
  } catch (error) {
    if (error instanceof ChatInputError) return res.status(400).json({ message: error.message });
    console.error('[support-chat POST /:id/keys]', error.message);
    return res.status(500).json({ message: 'Could not share this conversation with support.' });
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
