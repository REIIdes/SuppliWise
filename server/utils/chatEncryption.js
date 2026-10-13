/**
 * END-TO-END ENCRYPTION — the shared contract.
 *
 * ── What "end-to-end" means here, exactly ───────────────────────────────────
 * The message body is encrypted in the BROWSER, with AES-256-GCM under a key
 * that was generated in a browser and is never transmitted. The server stores
 * the ciphertext and routes it; it cannot read it. That is the whole claim, and
 * everything below exists to make it literally true rather than approximately
 * true:
 *
 *   • A message the server can read is a message in a database dump, in a log,
 *     in a replica, and in the hands of anybody with read access to any of
 *     those. AES-GCM at rest would not fix that — the server would still hold
 *     the key — so this is client-side, and the server's job is reduced to
 *     "store this blob and hand it back to the two parties".
 *
 *   • The content key is shared with each participant using ECIES over
 *     P-256 ECDH: an ephemeral key pair per share, HKDF-SHA256 to derive a
 *     key-encryption key, AES-GCM to wrap the 32-byte content key. Only the
 *     RECIPIENT can open a share, because only the recipient holds the private
 *     half of the pairing the share was computed against.
 *
 * ── What is deliberately NOT encrypted ──────────────────────────────────────
 * The subject, the category, the status, the timestamps, the member's name and
 * the ticket id. This is not a shortcut, it is the design:
 *
 *   • The admin queue is a triage list. An operator who cannot see what a
 *     thread is about cannot decide whether to open it, cannot search for it,
 *     and cannot tell "about a refund" from "about a login" without opening
 *     every one. Encrypting the subject would make the product worse for the
 *     people who exist to answer the questions.
 *   • The subject is typed by the member into a field labelled "Subject", on a
 *     form that asks for a topic. It is a title, not the message.
 *
 * The UI says this out loud on every conversation rather than letting anybody
 * infer it, because "end-to-end encrypted" with an unencrypted title beside it
 * is exactly the kind of detail that turns into a complaint later.
 *
 * ── Two envelopes, one string each ──────────────────────────────────────────
 * Messages   `e1.<iv>.<ciphertext>`        AES-256-GCM, 96-bit random IV
 * Key shares `w1.<ephPub>.<salt>.<iv>.<ct>`  ECIES over P-256
 *
 * Both are versioned in the first segment. A future format is a new tag, and
 * an old row keeps its old tag, so the two can coexist in one collection during
 * a rollout instead of the migration deleting the conversation it was supposed
 * to protect.
 *
 * The server validates SHAPE, never CONTENT. It cannot check that a ciphertext
 * decrypts — it has nothing to decrypt it with, which is the point. What it can
 * check is that the value is a well-formed envelope of a length that could not
 * be a request body stuffed into a string field, and that is what this module
 * is for.
 */

const crypto = require('crypto');
const { ChatInputError, normalizeBody } = require('./supportChat');

/** The only version this build writes. */
const ENCRYPTION_VERSION = 1;

// An AES-GCM ciphertext always ends in a 128-bit tag, so nothing shorter than
// 16 base64url characters can be one. The generous ceiling is the 2000-character
// message cap in supportChat.js, which is ~2,700 bytes of UTF-8 at worst.
const CIPHER_MAX_LENGTH = 8000;
const CIPHER_PATTERN = /^e1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16,7600}$/;

// P-256 public point, uncompressed: 64 bytes of x‖y → 86 base64url characters.
// The HKDF salt is 16 bytes (22 chars) and the wrapping IV is 12 (16). The
// wrapped content key is 32 bytes + a 16-byte tag = 48 → 64 characters.
const WRAP_PATTERN = /^w1\.[A-Za-z0-9_-]{86}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32,200}$/;

// A participant is `<role>:<24-hex ObjectId>`. Constraining it to exactly this
// shape is what stops an arbitrary string being pushed into a share list and
// later being rendered, or matched, as somebody's identity.
const PARTICIPANT_PATTERN = /^(user|admin):[a-f0-9]{24}$/;

// A thread has one member and a handful of operators. Twelve is generous and
// bounded, so "wrap this for everyone" can never become an unbounded write.
const MAX_KEY_SHARES = 12;
const SEALING_LEASE_MS = 5 * 60 * 1000;

// A public key is the 64-byte x‖y of a P-256 point, base64url.
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{80,90}$/;

/** `user:<id>` — a member's own share. */
function participantForUser(userId) {
  return `user:${String(userId)}`;
}

/** `admin:<id>` — an operator's share. */
function participantForAdmin(adminId) {
  return `admin:${String(adminId)}`;
}

function isParticipant(value) {
  return PARTICIPANT_PATTERN.test(String(value || ''));
}

/** A message envelope. */
function isCipher(value) {
  return CIPHER_PATTERN.test(String(value || ''));
}

/** A wrapped content key. */
function isWrappedKey(value) {
  return WRAP_PATTERN.test(String(value || ''));
}

function isPublicKey(value) {
  return PUBLIC_KEY_PATTERN.test(String(value || ''));
}

/**
 * Is this thread encrypted?
 *
 * Version 0 is the honest "no" — every thread that predates this feature, and
 * any thread created while the operator's browser had no usable WebCrypto.
 */
function isEncrypted(thread) {
  return Number(thread?.encryption?.version || 0) >= ENCRYPTION_VERSION;
}

/**
 * Read a submitted message body.
 *
 * A send carries EITHER a plaintext `body` or an encrypted `cipher` and never
 * both. The thread's own state decides which is acceptable:
 *
 *   encrypted thread  → cipher required. Accepting plaintext here would let a
 *                       single unencrypted reply land in the middle of a secure
 *                       conversation, which is how "we encrypt everything" quietly
 *                       stops being true without anybody deciding to stop it.
 *   plain thread      → plaintext required. The alternative — accepting a
 *                       ciphertext for a thread that has no content key at all —
 *                       would store a message nobody can ever read, which is
 *                       indistinguishable from data loss.
 *
 * `creating` covers the one case the thread itself cannot answer, because there
 * is no thread yet. For a new conversation the shares decide: a send carrying a
 * valid ciphertext starts a sealed conversation, one without it starts a plain
 * one. That is the client's decision, taken once, at the moment it knows whether
 * it can encrypt at all — see `canSealNew` in useSecureChat.js. Support chat
 * routes pass `requireEncryption` so there is no plaintext fallback.
 *
 * @param {object} payload
 * @param {object} thread    the target thread, or a stub for one being created
 * @param {{ creating?: boolean, requireEncryption?: boolean }} [options]
 * @returns {{ mode: 'plain'|'encrypted', body: string, cipher: string }}
 * @throws {ChatInputError} 400
 */
function readMessagePayload({ body, cipher }, thread, options = {}) {
  const hasBody = typeof body === 'string' && body.trim().length > 0;
  const hasCipher = typeof cipher === 'string' && cipher.trim().length > 0;

  if (hasCipher && !isCipher(cipher)) {
    throw new ChatInputError('That message could not be encrypted properly.');
  }
  if (options.requireEncryption && !hasCipher) {
    throw new ChatInputError('Secure messaging is not ready. Please retry after encryption setup completes.');
  }

  // An EXISTING encrypted thread. The state is already decided and this is the
  // rule that stops one plaintext reply quietly un-sealing a conversation.
  if (isEncrypted(thread)) {
    if (!hasCipher) {
      throw new ChatInputError('This conversation is end-to-end encrypted and needs an encrypted reply.');
    }
    return { mode: 'encrypted', body: '', cipher: cipher.trim() };
  }

  // A NEW conversation. There is no state to inherit, so the send decides: a
  // ciphertext starts a sealed thread, plaintext starts a plain one. A client
  // that cannot encrypt sends plaintext on purpose (see `canSealNew`), so this
  // has to accept both rather than only one.
  if (options.creating) {
    if (!hasCipher) {
      if (!hasBody) throw new ChatInputError('Please type a message before sending.');
      return { mode: 'plain', body: normalizeBody(body), cipher: '' };
    }
    return { mode: 'encrypted', body: '', cipher: cipher.trim() };
  }

  // An EXISTING plain thread. A ciphertext here would store a message nobody can
  // ever read — indistinguishable from data loss.
  if (hasCipher) {
    throw new ChatInputError('This conversation is not encrypted yet. Send it as normal text.');
  }
  if (!hasBody) {
    throw new ChatInputError('Please type a message before sending.');
  }
  // The same length rules as an unencrypted send (utils/supportChat.js). A 4 MB
  // ciphertext is still a 4 MB message from the member's point of view.
  return { mode: 'plain', body: normalizeBody(body), cipher: '' };
}

/**
 * Validate a list of incoming key shares.
 *
 * @param {*} raw   whatever arrived in `req.body.keyShares`
 * @param {object} options
 * @param {string[]} options.allowedParticipants  the only participants the
 *   caller may name. A member may only ever write `user:<their own id>` and
 *   `admin:*`; an operator may only ever write `admin:*` and `user:<the thread's
 *   owner>`. Without this, a compromised client could park a share for an
 *   arbitrary address and have it rendered back as a legitimate participant.
 * @param {Function} options.isAllowed `(participant) => boolean`
 * @returns {Array<{participant: string, wrapped: string}>}
 * @throws {ChatInputError} 400
 */
function normalizeKeyShares(raw, { isAllowed }) {
  if (!Array.isArray(raw)) throw new ChatInputError('Invalid encryption key data.');
  if (raw.length === 0 || raw.length > MAX_KEY_SHARES) {
    throw new ChatInputError('Invalid encryption key data.');
  }

  const seen = new Set();
  const shares = [];
  for (const entry of raw) {
    const participant = String(entry?.participant || '').trim();
    const wrapped = String(entry?.wrapped || '').trim();
    if (!isParticipant(participant) || !isWrappedKey(wrapped)) {
      throw new ChatInputError('Invalid encryption key data.');
    }
    if (!isAllowed(participant)) throw new ChatInputError('Invalid encryption key data.');
    if (seen.has(participant)) continue;
    seen.add(participant);
    shares.push({ participant, wrapped });
  }
  if (shares.length === 0) throw new ChatInputError('Invalid encryption key data.');
  return shares;
}

/**
 * A caller may only ever be handed THEIR OWN wrapped key.
 *
 * This is the single function both routers use to decide what leaves the server
 * in a thread view. The full share list — which contains blobs sealed to other
 * people's public keys — never crosses the wire in any direction. There is no
 * cryptographic argument for sending them (they are unreadable without the
 * recipient's private key) and there is a plain privacy one: a share list is a
 * map of who can read this conversation, and a member has no business reading
 * it.
 *
 * @param {object} thread       the ChatThread document
 * @param {string} participant  `user:<id>` or `admin:<id>` for the caller
 * @returns {string[]} the caller's own wrapped blobs (0 or 1 in practice)
 */
function sharesForParticipant(thread, participant) {
  const shares = Array.isArray(thread?.encryption?.keyShares) ? thread.encryption.keyShares : [];
  return shares
    .filter((share) => share && share.participant === participant)
    .map((share) => share.wrapped)
    .filter(isWrappedKey);
}

/** The public half of a thread, for the UI. No keys, no ciphertext, no leakage. */
function encryptionView(thread) {
  return {
    version: isEncrypted(thread) ? ENCRYPTION_VERSION : 0,
    recipients: Array.isArray(thread?.encryption?.keyShares)
      ? thread.encryption.keyShares.length
      : 0,
  };
}

/**
 * Claim a legacy thread before replacing its messages with ciphertext.
 *
 * Two browsers can open the same plaintext thread at once. Without a server
 * claim, each can encrypt with a different key and the last write leaves one
 * or both participants unable to read the transcript.
 */
async function claimThreadForSealing(ChatThread, threadId) {
  const claimId = crypto.randomBytes(24).toString('base64url');
  const staleBefore = new Date(Date.now() - SEALING_LEASE_MS);
  const claimed = await ChatThread.findOneAndUpdate(
    {
      _id: threadId,
      $and: [
        {
          $or: [
            { 'encryption.version': { $exists: false } },
            { 'encryption.version': { $lt: ENCRYPTION_VERSION } },
          ],
        },
        {
          $or: [
            { 'encryption.sealingAt': { $exists: false } },
            { 'encryption.sealingAt': null },
            { 'encryption.sealingAt': { $lt: staleBefore } },
          ],
        },
      ],
    },
    {
      $set: {
        'encryption.sealingId': claimId,
        'encryption.sealingAt': new Date(),
      },
    },
    { new: true, projection: { _id: 1 } }
  ).lean();
  return claimed ? claimId : '';
}

async function releaseThreadSealingClaim(ChatThread, threadId, claimId) {
  if (!claimId) return;
  await ChatThread.updateOne(
    { _id: threadId, 'encryption.sealingId': claimId },
    { $unset: { 'encryption.sealingId': 1, 'encryption.sealingAt': 1 } }
  );
}

module.exports = {
  ENCRYPTION_VERSION,
  CIPHER_MAX_LENGTH,
  MAX_KEY_SHARES,
  participantForUser,
  participantForAdmin,
  isParticipant,
  isCipher,
  isWrappedKey,
  isPublicKey,
  isEncrypted,
  readMessagePayload,
  normalizeKeyShares,
  sharesForParticipant,
  encryptionView,
  claimThreadForSealing,
  releaseThreadSealingClaim,
};
