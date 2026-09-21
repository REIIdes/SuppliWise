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

function tokenKey(secret, token) {
  const step = Math.floor(Date.now() / 30000);
  return crypto.createHash('sha256').update(`${secret}:${token}:${step}`).digest('hex');
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
