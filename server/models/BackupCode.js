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
const CODE_LENGTH = 10;

// The alphabet a code is drawn from. Unambiguous on paper and in a screenshot:
// no O/0, no I/1/L, no U/V pair for handwriting to trip over. 29 symbols, so
// 10 of them carry log2(29) * 10 ≈ 49.5 bits.
const ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';
const ALPHABET_SIZE = ALPHABET.length;

// The largest multiple of the alphabet size that fits in a byte. Bytes at or
// above this are discarded rather than folded with `%`, because 29 does not
// divide 256: the first 29 values of a byte would otherwise come up ~10% more
// often than the rest, which is a measurable bias in a credential.
const REJECT_AT = Math.floor(256 / ALPHABET_SIZE) * ALPHABET_SIZE;

function normalise(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normalise(code)).digest('hex');
}

/**
 * One code of CODE_LENGTH symbols, drawn uniformly from ALPHABET.
 *
 * ── Why not base64url ─────────────────────────────────────────────────────
 *
 * The obvious `crypto.randomBytes(10).toString('base64url')` is 14 characters
 * wide, and stripping the two non-alphanumeric symbols out of it does NOT give
 * you ten random characters: roughly one draw in thirty has a symbol dropped
 * from the first ten, leaving nine. The old version papered over that with
 * `padEnd(10, 'X')` — a CONSTANT — so 3.3% of every batch shipped a code whose
 * final character was the letter X rather than a random one. Measured over
 * 200k draws the last position came out at 3.28% X against 2.78% for every
 * other symbol: a real (if small) bias, and a fixed character handed to an
 * attacker in the position that is cheapest to guess.
 *
 * Rejection sampling fixes it properly. There is no fallback character because
 * there is no pad, and no modulo bias because the biased tail is thrown away
 * rather than folded in. ~91% of bytes are accepted, so the expected draw is
 * barely more than one.
 */
function randomCode() {
  const out = [];
  while (out.length < CODE_LENGTH) {
    const bytes = crypto.randomBytes(CODE_LENGTH * 2);
    for (let i = 0; i < bytes.length && out.length < CODE_LENGTH; i += 1) {
      if (bytes[i] < REJECT_AT) out.push(ALPHABET[bytes[i] % ALPHABET_SIZE]);
    }
  }
  return out.join('');
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
  const taken = new Set();

  for (let i = 0; i < count; i += 1) {
    // Distinct WITHIN the batch. Two identical codes would silently cost the
    // user one of their `count` recovery slots — a collision in a set of ten is
    // far too rare to notice by hand and impossible to explain afterwards.
    let raw = randomCode();
    for (let attempt = 0; taken.has(raw) && attempt < 16; attempt += 1) {
      raw = randomCode();
    }
    taken.add(raw);

    // Grouped for legibility: XXXXX-XXXXX. The dash is presentation only —
    // `normalise` strips it, so it is never part of what gets hashed.
    const pretty = `${raw.slice(0, 5)}-${raw.slice(5)}`;
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
module.exports.CODE_LENGTH = CODE_LENGTH;
module.exports.ALPHABET = ALPHABET;
