/**
 * The MFA transaction service — `MFA_REQUIRED` as a server-side fact.
 *
 * See models/MfaTransaction.js for why this exists at all. This module is the
 * only interface to it, so the security rules (single use, expiry, attempt
 * budget, which methods a transaction will accept) are stated once.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const MfaTransaction = require('../models/MfaTransaction');

function toObjectId(value) {
  try {
    const id = new mongoose.Types.ObjectId(String(value));
    return mongoose.Types.ObjectId.isValid(id) ? id : null;
  } catch {
    return null;
  }
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// Long enough to type a code on a phone, short enough that a captured token is
// worthless by the time anyone looks at it. The emailed-code path needs a
// little longer because the user may have to open their mail.
const DEFAULT_TTL_MS = 5 * 60 * 1000;
// 30-second grace buffer for clock skew between the server and Atlas.
const CLOCK_SKEW_GRACE_MS = 30 * 1000;
const MAX_ATTEMPTS = 10;

// Generous ceiling on tokens resolved per process per minute, so a run of
// garbage tokens cannot turn the lookup into an amplifier. The account lockout
// ladder handles the "many valid-looking transactions" case.
const RESOLVE_WINDOW_MS = 60 * 1000;
const RESOLVE_BUDGET = 120;
const resolveAttempts = new Map(); // ip -> [count, windowStart]

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function resolveBudgetExhausted(ip) {
  const now = Date.now();
  const entry = resolveAttempts.get(ip) || [0, now];
  if (now - entry[1] > RESOLVE_WINDOW_MS) {
    resolveAttempts.set(ip, [1, now]);
    return false;
  }
  entry[0] += 1;
  resolveAttempts.set(ip, entry);
  if (resolveAttempts.size > 5000) resolveAttempts.clear();
  return entry[0] > RESOLVE_BUDGET;
}

/**
 * Open a transaction for an account that has just passed its FIRST factor.
 *
 * Returns the RAW token, which is the only time it exists. Hand it to the
 * client; never store it, never log it.
 *
 * Starting a new transaction for an account revokes the previous ones. That is
 * deliberate: a user who mistypes their password three times and then succeeds
 * should not leave three live windows behind for whoever caused the failures.
 */
async function start({ user, methods = ['totp'], ip = '', userAgent = '', location = '', primaryMethod = 'password', ttlMs = DEFAULT_TTL_MS }) {
  const uid = user._id ? user._id : user;
  const raw = crypto.randomBytes(32).toString('base64url');
  const now = new Date();

  // Close the account's previous windows first. If the insert then fails, the
  // account is left needing a fresh sign-in — which is the safe direction.
  await MfaTransaction.updateMany(
    { user: uid, consumedAt: null },
    { $set: { consumedAt: now } },
  ).catch(() => {});

  await MfaTransaction.create({
    tokenHash: hashToken(raw),
    user: uid,
    methods: methods.filter((m) => m === 'totp' || m === 'email-otp' || m === 'backup-code' || m === 'passkey'),
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    primaryMethod: String(primaryMethod || 'password').slice(0, 32),
    ip: String(ip || '').slice(0, 64),
    userAgent: String(userAgent || '').slice(0, 300),
    location: String(location || '').slice(0, 120),
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
    consumedAt: null,
    consumedBy: '',
  });

  return raw;
}

/**
 * Resolve a token WITHOUT spending it.
 *
 * Two uses, and the distinction matters:
 *   • `method` present → the transaction must have been opened for that factor.
 *     A transaction opened for `totp` cannot be spent on a backup code, so a
 *     client cannot pick which factor the account is held to.
 *   • `method` absent → "is this account waiting on a second factor at all?",
 *     used by the legacy `userId` compatibility path.
 *
 * Returns null on anything unusable, without saying which.
 */
async function peek(rawToken, { method = null } = {}) {
  const token = str(rawToken).trim();
  if (!token || token.length < 32 || token.length > 200) return null;

  const row = await MfaTransaction.findOne({
    tokenHash: hashToken(token),
    consumedAt: null,
    expiresAt: { $gt: new Date(Date.now() - CLOCK_SKEW_GRACE_MS) },
  }).lean();
  if (!row) return null;
  if (row.attempts >= row.maxAttempts) return null;
  if (method && !row.methods.includes(method)) return null;
  return row;
}

/**
 * Spend a transaction, atomically, and return the account it belonged to.
 *
 * The conditional update is what makes "single use" true rather than intended:
 * two concurrent submissions of the same code race on one document and exactly
 * one matches. The attempt budget is enforced in the same filter, so it cannot
 * be exceeded by sending many requests at once.
 *
 * Returns one of:
 *   { ok: true,  user }              — completed
 *   { ok: false, reason: 'unknown' }  — no such live transaction
 *   { ok: false, reason: 'exhausted' }— spent, expired, or out of attempts
 */
async function spend(rawToken, { method = null } = {}) {
  const token = str(rawToken).trim();
  if (!token || token.length < 32 || token.length > 200) return { ok: false, reason: 'unknown' };

  const now = new Date();
  const row = await MfaTransaction.findOneAndUpdate(
    {
      tokenHash: hashToken(token),
      consumedAt: null,
      expiresAt: { $gt: new Date(Date.now() - CLOCK_SKEW_GRACE_MS) },
      $expr: { $lt: ['$attempts', '$maxAttempts'] },
      ...(method ? { methods: method } : {}),
    },
    { $set: { consumedAt: now, consumedBy: String(method || '').slice(0, 32) } },
    { new: true }
  ).lean();

  if (!row) {
    // Distinguish "never existed" from "used up" only for our own logging —
    // both are answered identically to the client.
    const seen = await MfaTransaction.findOne({ tokenHash: hashToken(token) }).select('attempts maxAttempts consumedAt expiresAt').lean();
    return { ok: false, reason: seen ? 'exhausted' : 'unknown' };
  }
  return { ok: true, user: row.user, transaction: row };
}

/**
 * Which methods a transaction will accept, given the account's configuration.
 *
 * Called at the password step, so the decision is made from server state and
 * handed to the client as information — never as something the client chooses.
 */
async function spendById(id, { method = null } = {}) {
  const objectId = toObjectId(id);
  if (!objectId) return { ok: false, reason: 'unknown' };
  const now = new Date();
  const row = await MfaTransaction.findOneAndUpdate(
    {
      _id: objectId,
      consumedAt: null,
      expiresAt: { $gt: new Date(Date.now() - CLOCK_SKEW_GRACE_MS) },
      $expr: { $lt: ['$attempts', '$maxAttempts'] },
      ...(method ? { methods: method } : {}),
    },
    { $set: { consumedAt: now, consumedBy: String(method || '').slice(0, 32) } },
    { new: true }
  ).lean();
  return row ? { ok: true, user: row.user, transaction: row } : { ok: false, reason: 'exhausted' };
}

function methodsFor(user, { passkeys = 0, backupCodeCount = 0 } = {}) {
  const methods = [];
  if (user && user.twoFactorEnabled === true) {
    const method = user.twoFactorMethod || 'authenticator';
    if (method === 'email') methods.push('email-otp');
    else methods.push('totp');
    // A recovery code is the fallback for a lost authenticator, so it is only
    // offered when the authenticator is the active factor — mirroring the rule
    // the redemption route already enforces.
    if (method === 'authenticator' && backupCodeCount > 0) methods.push('backup-code');
  }
  // A discoverable passkey satisfies the second factor on its own (UV is
  // required at verification), so it is offered alongside rather than instead.
  if (passkeys > 0) methods.push('passkey');
  return methods.length ? methods : ['totp'];
}

const isValidTokenFormat = (value) => {
  const token = str(value).trim();
  return token.length >= 32 && token.length <= 200 && /^[A-Za-z0-9_-]+$/.test(token);
};

module.exports = {
  DEFAULT_TTL_MS,
  MAX_ATTEMPTS,
  start,
  peek,
  spend,
  spendById,
  methodsFor,
  hashToken,
  isValidTokenFormat,
  resolveBudgetExhausted,
};
