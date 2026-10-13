/**
 * The account side of end-to-end encryption: publishing a public key, offering a
 * recovery copy of the private one, and handing the operator directory to a
 * member who is about to open a new conversation.
 *
 * Everything here works on either account type. `models/User` and
 * `models/AdminAccount` carry the identical `chatEncryptionKey` subdocument
 * (models/chatEncryptionKeySchema.js), so one implementation serves both and
 * the two can never disagree about what a registered key means.
 */

const AdminAccount = require('../models/AdminAccount');
const { participantForAdmin, participantForUser, isPublicKey } = require('./chatEncryption');

const KEY_ID_PATTERN = /^[a-z0-9]{6,32}$/;
const RECOVERY_HINT_PATTERN = /^[A-Z0-9-]{0,8}$/;
const RECOVERY_WRAP_MAX = 2048;
// A recovery copy is `r1.<iv of 12 bytes>.<ciphertext of a P-256 JWK>`. A sealed
// JWK is ~320 base64url characters — the pattern below is bounded around that
// with room for the shape to grow without silently rejecting a valid copy.
const RECOVERY_WRAP_PATTERN = /^r1\.[A-Za-z0-9_-]{16,24}\.[A-Za-z0-9_-]{120,1800}$/;

class KeyInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyInputError';
    this.status = 400;
  }
}

/** A sealed private key, as `wrapIdentityForRecovery` in the browser emits it. */
function isRecoveryWrap(value) {
  const candidate = String(value || '').trim();
  return candidate.length <= RECOVERY_WRAP_MAX && RECOVERY_WRAP_PATTERN.test(candidate);
}

function normalizeKeyId(value) {
  const keyId = String(value == null ? '' : value).trim().toLowerCase();
  return KEY_ID_PATTERN.test(keyId) ? keyId : '';
}

/**
 * What the caller is allowed to see about their own key.
 *
 * `recoveryWrapped` is deliberately absent from this view. It is a sealed copy
 * of the private key, and echoing it back means every GET of the key endpoint
 * hands a 1 KB blob back over the wire for no reason anybody needs. The client
 * already holds the code that opens it.
 */
function keyView(account) {
  const key = account?.chatEncryptionKey || {};
  return {
    keyId: key.keyId || '',
    publicKey: key.publicKey || '',
    hasRecovery: Boolean(key.recoveryWrapped),
    recoveryHint: key.recoveryHint || '',
    createdAt: key.createdAt || null,
  };
}

/**
 * Publish a public key. Idempotent, and safe to call on every page load.
 *
 * The upsert guard is on `keyId` rather than on "is there anything stored", so
 * the same browser calling this every visit is a no-op rather than a rotation.
 * A DIFFERENT browser presenting a different keyId does replace it — that is
 * the "this account is now on another machine" case, and the reply carries the
 * previous key so the client can warn that older conversations will not open
 * here. See the note in my-react-app/src/security/secureChat.js.
 */
async function registerPublicKey(Model, accountId, { keyId, publicKey } = {}) {
  const cleanId = normalizeKeyId(keyId);
  const cleanKey = String(publicKey || '').trim();
  if (!cleanId || !isPublicKey(cleanKey)) {
    throw new KeyInputError('That encryption key is not valid.');
  }

  const previous = await Model.findById(accountId).select('chatEncryptionKey').lean();
  const before = previous?.chatEncryptionKey || {};

  const updated = await Model.findOneAndUpdate(
    { _id: accountId },
    {
      $set: {
        'chatEncryptionKey.keyId': cleanId,
        'chatEncryptionKey.publicKey': cleanKey,
        'chatEncryptionKey.lastSeenAt': new Date(),
        // Preserved on a same-key re-registration (which is what every page load
        // does) and stamped fresh on a genuine key swap, so `createdAt` means
        // "when this browser's key appeared" rather than "when the field did".
        ...(before.keyId && before.keyId === cleanId && before.createdAt
          ? {}
          : { 'chatEncryptionKey.createdAt': new Date() }),
      },
    },
    { new: true }
  ).select('chatEncryptionKey').lean();

  if (!updated) throw new KeyInputError('That account no longer exists.');

  // A key swap drops the previous recovery copy: it sealed a private key this
  // browser no longer has, so keeping it would show the holder a recovery code
  // that no longer works — worse than showing none.
  if (before.keyId && before.keyId !== cleanId) {
    await Model.updateOne(
      { _id: accountId },
      { $set: { 'chatEncryptionKey.recoveryWrapped': '', 'chatEncryptionKey.recoveryHint': '', 'chatEncryptionKey.recoveryAt': null } }
    ).catch(() => {});
  }

  return {
    key: keyView(updated),
    // Empty on first registration. Non-empty means "there was already a key, and
    // it was not this one" — the client uses it to explain, once, why older
    // conversations will not open in this browser.
    replacedKeyId: before.keyId && before.keyId !== cleanId ? before.keyId : '',
  };
}

/** Store a sealed private key plus four characters of its recovery code. */
async function saveRecoveryCopy(Model, accountId, { recoveryWrapped, hint } = {}) {
  const wrapped = String(recoveryWrapped || '').trim();
  const cleanHint = String(hint || '').trim().toUpperCase();
  // The shape matters: `r1.<iv>.<ct>`. Accepting "garbage" here would store a
  // blob the browser can never unseal, and the holder would only discover that
  // the day they needed it. The server cannot check the crypto — it has nothing
  // to unseal with — so shape is the one check it CAN make, and it makes it.
  if (!isRecoveryWrap(wrapped)) {
    throw new KeyInputError('That recovery key is not valid.');
  }
  if (!RECOVERY_HINT_PATTERN.test(cleanHint)) {
    throw new KeyInputError('That recovery key is not valid.');
  }
  const updated = await Model.findOneAndUpdate(
    { _id: accountId },
    {
      $set: {
        'chatEncryptionKey.recoveryWrapped': wrapped,
        'chatEncryptionKey.recoveryHint': cleanHint,
        'chatEncryptionKey.recoveryAt': new Date(),
      },
    },
    { new: true }
  ).select('chatEncryptionKey').lean();
  if (!updated) throw new KeyInputError('That account no longer exists.');
  return keyView(updated);
}

/** A 30-second "this browser is the one that registered the key" heartbeat. */
function touchKey(Model, accountId) {
  return Model.updateOne(
    { _id: accountId, 'chatEncryptionKey.keyId': { $ne: '' } },
    { $set: { 'chatEncryptionKey.lastSeenAt': new Date() } }
  ).exec().catch(() => {});
}

/**
 * The operator directory a member needs before opening a conversation.
 *
 * A P-256 public key is public. Publishing every operator's to a signed-in
 * member is not a disclosure — it is the mechanism, and withholding it would
 * make every member's first message plaintext.
 *
 * Two things are withheld that a naive query would have returned:
 *   • accounts that are disabled — an operator who has been switched off has no
 *     business receiving a new share, and including them would silently make
 *     every new conversation unreadable for them;
 *   • everything that is not a public key. `passwordHash` and `totpSecret` are
 *     `select: false` on the model, and `.select()` below is an allow-list
 *     rather than a deny-list so a field added to the schema later cannot leak
 *     by omission.
 */
async function listOperatorPublicKeys({ excludeAdminId = '' } = {}) {
  const admins = await AdminAccount.find({
    enabled: true,
    'chatEncryptionKey.publicKey': { $nin: ['', null] },
    ...(excludeAdminId ? { _id: { $ne: excludeAdminId } } : {}),
  })
    .select('_id chatEncryptionKey.publicKey')
    .sort({ _id: 1 })
    .lean();

  return (admins || [])
    .map((admin) => ({
      participant: participantForAdmin(admin._id),
      publicKey: admin.chatEncryptionKey?.publicKey || '',
    }))
    .filter((entry) => entry.publicKey);
}

/** The caller's own participant address — `user:<id>` or `admin:<id>`. */
function participantFor(req) {
  return req.user?.role === 'admin'
    ? participantForAdmin(req.user._id)
    : participantForUser(req.user._id);
}

module.exports = {
  KeyInputError,
  normalizeKeyId,
  keyView,
  registerPublicKey,
  saveRecoveryCopy,
  touchKey,
  listOperatorPublicKeys,
  participantFor,
};
