/**
 * Password hashing — SHA-3-layered argon2id for everything new, raw argon2id
 * and bcrypt accepted for existing stores.
 *
 * - New/changed passwords are hashed with argon2id over SHA3-512(password)
 *   (OWASP interactive profile: 19 MiB memory, 2 iterations, 1 lane) via
 *   hash-wasm (no native build), stored with an `sw2$` marker.
 * - Stored bcrypt hashes ($2a/$2b, cost 12) and pre-layer raw argon2id hashes
 *   keep verifying UNCHANGED — no existing credential is rewritten by the
 *   SHA-3 layer. Users and ADMIN_ACCOUNTS entries keep working with zero
 *   downtime.
 * - On successful bcrypt verification, callers upgrade the stored hash to
 *   the current layered form transparently (see upgradeHashIfLegacy).
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

// ── SHA-3 pre-hash layer (added 2026-10-18) ─────────────────────────────
// New hashes feed argon2id SHA3-512(password) instead of the raw password
// and carry an `sw2$` marker:
//   • bounded KDF input — a multi-megabyte "password" can no longer stall
//     the hash beyond argon2's own fixed cost;
//   • no NUL-byte or encoding surprises reach the KDF;
//   • the KDF never sees the literal password bytes.
// This is strictly ADDITIVE. Stored raw-argon2id and bcrypt hashes keep
// verifying through their original branches and are never rewritten by
// this layer — existing credentials are untouched.
const V2_PREFIX = 'sw2$';
function sha3Pre(password) {
  return crypto.createHash('sha3-512').update(String(password), 'utf8').digest('base64');
}

function isArgon2id(hash) {
  return /^(?:sw2\$)?\$argon2id\$/.test(String(hash || ''));
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
  const encoded = await argon2id({
    password: sha3Pre(plaintext),
    salt,
    parallelism: ARGON2_OPTS.parallelism,
    iterations: ARGON2_OPTS.iterations,
    memorySize: ARGON2_OPTS.memorySize,
    hashLength: ARGON2_OPTS.hashLength,
    outputType: 'encoded',
  });
  return V2_PREFIX + encoded;
}

async function verifyPassword(plaintext, hash) {
  const password = String(plaintext);
  const stored = String(hash || '');
  try {
    if (stored.startsWith(V2_PREFIX)) {
      return await argon2Verify({ password: sha3Pre(password), hash: stored.slice(V2_PREFIX.length) });
    }
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

// Burn roughly the same CPU a real verification would, without needing a user.
//
// Used on the "no such account" branch of sign-in so that answering takes about
// as long as a wrong-password answer. Without it, an unknown email returns in
// microseconds while a known one takes an argon2id verify (~tens of ms), and
// the timing gap alone confirms whether an account exists.
//
// Verified against a throwaway hash, so the cost tracks the real algorithm
// rather than a hard-coded sleep that would drift if the parameters change.
const BURN_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0Q1wJ8S0Y7bYl6m0Zx3kQ8x1Jq0k4h6l0mQ';
async function burnPasswordCompare() {
  try {
    await verifyPassword('timing-equaliser', BURN_HASH);
  } catch {
    // A failed burn only weakens timing, never correctness — never throw here.
  }
}

module.exports = {
  ARGON2_OPTS,
  V2_PREFIX,
  sha3Pre,
  isArgon2id,
  isBcrypt,
  needsRehash,
  hashPassword,
  verifyPassword,
  upgradeHashIfLegacy,
  burnPasswordCompare,
};
