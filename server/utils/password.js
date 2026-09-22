/**
 * Password hashing — argon2id for everything new, bcrypt accepted for legacy.
 *
 * - New/changed passwords are hashed with argon2id (OWASP interactive profile:
 *   19 MiB memory, 2 iterations, 1 lane) via hash-wasm (no native build).
 * - Stored bcrypt hashes ($2a/$2b, cost 12) keep verifying, so existing users
 *   and ADMIN_ACCOUNTS entries keep working with zero downtime.
 * - On successful bcrypt verification, callers upgrade the stored hash to
 *   argon2id transparently (see upgradeHashIfLegacy).
 */

const bcrypt = require('bcryptjs');
const { argon2id, argon2Verify } = require('hash-wasm');
const crypto = require('crypto');

// OWASP first-choice interactive parameters (memorySize is in KiB)
const ARGON2_OPTS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19 * 1024,
  hashLength: 32,
};

function isArgon2id(hash) {
  return /^\$argon2id\$/.test(String(hash || ''));
}

function isBcrypt(hash) {
  return /^\$2[aby]?\$\d{2}\$/.test(String(hash || ''));
}

// True when the stored hash is NOT argon2id (legacy bcrypt / unknown).
function needsRehash(hash) {
  return !isArgon2id(hash);
}

async function hashPassword(plaintext) {
  const salt = crypto.randomBytes(16);
  return argon2id({
    password: String(plaintext),
    salt,
    parallelism: ARGON2_OPTS.parallelism,
    iterations: ARGON2_OPTS.iterations,
    memorySize: ARGON2_OPTS.memorySize,
    hashLength: ARGON2_OPTS.hashLength,
    outputType: 'encoded',
  });
}

async function verifyPassword(plaintext, hash) {
  const password = String(plaintext);
  const stored = String(hash || '');
  try {
    if (isArgon2id(stored)) return await argon2Verify({ password, hash: stored });
    if (isBcrypt(stored)) return await bcrypt.compare(password, stored);
    return false;
  } catch {
    return false;
  }
}

// After a successful legacy-bcrypt verification, mint a replacement argon2id
// hash. Returns the new hash, or null when no upgrade applies.
async function upgradeHashIfLegacy(plaintext, hash) {
  if (!isBcrypt(hash)) return null;
  const ok = await bcrypt.compare(String(plaintext), String(hash)).catch(() => false);
  if (!ok) return null;
  return hashPassword(plaintext);
}

module.exports = {
  ARGON2_OPTS,
  isArgon2id,
  isBcrypt,
  needsRehash,
  hashPassword,
  verifyPassword,
  upgradeHashIfLegacy,
};
