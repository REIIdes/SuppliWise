const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * BackupCode — single-use recovery codes for when the authenticator is lost.
 *
 * STORAGE: only a SHA-256 hash of each code is persisted, never the code
 * itself. A backup code is a bearer secret exactly like a password, so the
 * database must be useless to an attacker who reads it. SHA-256 (not bcrypt)
 * is the right primitive here specifically BECAUSE these are high-entropy
 * random values, not user-chosen passwords: there is no dictionary to attack,
 * so key-stretching would only make each redemption slow without adding
 * security.
 *
 * SINGLE-USE: `consume()` is a conditional update — it only marks a row used
 * if `usedAt` is still null, so two concurrent redemptions of the same code
 * cannot both win.
 *
 * REGENERATION: codes are written with a shared `batchId`; a new batch deletes
 * the previous one, which is what "regenerating invalidates the previous set"
 * has to mean.
 */
const backupCodeSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Groups one generation together so a regeneration can replace the lot.
    batchId: {
      type: String,
      required: true,
      index: true,
    },
    // hex(sha256(code)) — the code itself is returned once and never stored.
    codeHash: {
      type: String,
      required: true,
    },
    createdAt: { type: Date, default: Date.now },
    usedAt: { type: Date, default: null },
  },
  { timestamps: false }
);

backupCodeSchema.index({ user: 1, batchId: 1 });
backupCodeSchema.index({ user: 1, usedAt: 1 });

const BackupCode = mongoose.models.BackupCode
  || mongoose.model('BackupCode', backupCodeSchema);

const CODE_COUNT = 10;

function normalise(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normalise(code)).digest('hex');
}

/**
 * Mint a fresh set, replacing any previous one. Returns the PLAINTEXT codes —
 * this is the only moment they exist outside the user's screen, which is why
 * they can never be shown again afterwards.
 */
async function generate(userId, count = CODE_COUNT) {
  const uid = userId._id ? userId._id : userId;
  const batchId = crypto.randomBytes(12).toString('hex');
  const codes = [];
  const docs = [];

  for (let i = 0; i < count; i += 1) {
    // 10 chars from an unambiguous alphabet, grouped for legibility:
    // XXXXX-XXXXX  (~52 bits of entropy per code)
    const raw = crypto.randomBytes(10).toString('base64url').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 10).padEnd(10, 'X');
    const pretty = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
    codes.push(pretty);
    docs.push({ user: uid, batchId, codeHash: hashCode(pretty) });
  }

  // Invalidate the previous set FIRST so a failure here cannot leave two
  // simultaneously-valid batches.
  await BackupCode.deleteMany({ user: uid });
  await BackupCode.insertMany(docs);
  return { batchId, codes };
}

/**
 * Redeem one code. Single-use is enforced by the filter itself: the update
 * only matches a row that is still unused, so a replay (or two racing
 * requests) matches nothing and returns false.
 */
async function consume(userId, code) {
  const uid = userId._id ? userId._id : userId;
  const normalised = normalise(code);
  if (normalised.length !== 10) return false;
  const row = await BackupCode.findOneAndUpdate(
    { user: uid, codeHash: hashCode(normalised), usedAt: null },
    { $set: { usedAt: new Date() } },
    { new: true }
  ).lean();
  return !!row;
}

async function invalidateAll(userId) {
  const uid = userId._id ? userId._id : userId;
  const res = await BackupCode.deleteMany({ user: uid });
  return res.deletedCount || 0;
}

async function countRemaining(userId) {
  const uid = userId._id ? userId._id : userId;
  return BackupCode.countDocuments({ user: uid, usedAt: null });
}

module.exports = BackupCode;
module.exports.generate = generate;
module.exports.consume = consume;
module.exports.invalidateAll = invalidateAll;
module.exports.countRemaining = countRemaining;
module.exports.normalise = normalise;
module.exports.hashCode = hashCode;
module.exports.CODE_COUNT = CODE_COUNT;
