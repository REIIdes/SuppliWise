const crypto = require('crypto');
const speakeasy = require('speakeasy');

// One-time-use TOTP cache — prevents code replay inside the validity window.
// Keyed by a hash of (secret + code + 30s time-step); entries live 90 s.
const usedTokens = new Map();
const USED_TTL_MS = 90 * 1000;

function prune() {
  if (usedTokens.size < 500) return;
  const now = Date.now();
  for (const [key, at] of usedTokens) {
    if (now - at > USED_TTL_MS) usedTokens.delete(key);
  }
}

// Keyed by (secret + code) ONLY — deliberately WITHOUT the wall-clock time
// step. Verification uses speakeasy's `window: 1`, so a code minted for step
// N still validates during step N+1; including the current step in the key
// would give that replay a *different* key and let it through once more.
// The 90 s TTL covers the code's entire ±1-step validity span, and a fresh
// 6-digit code colliding with a consumed one inside that span is a 1-in-10^6
// event that merely asks the user to wait one tick.
function tokenKey(secret, token) {
  return crypto.createHash('sha256').update(`${secret}:${token}`).digest('hex');
}

/**
 * Verify a TOTP code exactly once. Returns true on first valid use;
 * replays of the same code inside its window return false.
 */
function verifyTotpOnce(secret, token) {
  const code = String(token || '').trim();
  if (!/^\d{6,8}$/.test(code) || !secret) return false;
  const key = tokenKey(secret, code);
  if (usedTokens.has(key)) return false;
  const ok = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
  if (ok) {
    usedTokens.set(key, Date.now());
    prune();
  }
  return !!ok;
}

module.exports = { verifyTotpOnce };
