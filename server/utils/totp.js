const crypto = require('crypto');
const speakeasy = require('speakeasy');

// One-time-use TOTP cache — prevents code replay inside the validity window.
// Keyed by a hash of (secret + code); entries live 90 s.
const usedTokens = new Map();
const USED_TTL_MS = 90 * 1000;
// Prune on a timer, not on a size threshold.
//
// This used to return early below 500 entries, so a quiet server accumulated
// consumed codes indefinitely: replay protection kept working, but the map
// grew without bound and could also reject a legitimately reused code long
// after its window had passed. A cheap interval keeps it honest at any load.
const PRUNE_INTERVAL_MS = 60 * 1000;

function prune(force = false) {
  if (!force && usedTokens.size < 500) return;
  const now = Date.now();
  for (const [key, at] of usedTokens) {
    if (now - at > USED_TTL_MS) usedTokens.delete(key);
  }
}

// Unref'd so this timer can never hold the process open on shutdown.
const pruneTimer = setInterval(() => prune(true), PRUNE_INTERVAL_MS);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

// Keyed by (scope + secret + code) — deliberately WITHOUT the wall-clock time
// step. Verification uses speakeasy's `window: 1`, so a code minted for step
// N still validates during step N+1; including the current step in the key
// would give that replay a *different* key and let it through once more.
// The 90 s TTL covers the code's entire ±1-step validity span, and a fresh
// 6-digit code colliding with a consumed one inside that span is a 1-in-10^6
// event that merely asks the user to wait one tick.
//
// `scope` is the ACCOUNT the code was spent against, and it is part of the key
// because the cache is otherwise global per secret. TOTP codes are a function
// of the secret and the clock alone, so two accounts sharing one seed mint the
// IDENTICAL code in the same 30 s step — and with a secret-only key the first
// of them to sign in consumed it for all the others. With six administrators
// configured on a single shared seed that meant exactly one admin could
// complete 2FA per 30 s window while the other five were told "Invalid
// authenticator code", which reads as a wrong code and is not one.
//
// Scoping to the account keeps the property that actually matters — a code is
// single-use *for the account it authenticates* — so a stolen code still buys
// exactly one authentication, and no longer denies every other holder of the
// same seed. Callers must pass a stable per-account identifier; omitting it
// falls back to the previous secret-only behaviour.
function tokenKey(secret, token, scope) {
  return crypto.createHash('sha256').update(`${scope}:${secret}:${token}`).digest('hex');
}

/**
 * Verify a TOTP code exactly once FOR THIS ACCOUNT. Returns true on first valid
 * use; a replay of the same code against the same account returns false.
 *
 * @param {string} secret  base32 TOTP seed
 * @param {string} token   the 6-8 digit code the client submitted
 * @param {string} [scope] stable account identifier (user id / admin alias).
 *   Required for correctness whenever more than one account can share a seed.
 */
function verifyTotpOnce(secret, token, scope = '') {
  const code = String(token || '').trim();
  if (!/^\d{6,8}$/.test(code) || !secret) return false;
  const key = tokenKey(secret, code, scope);
  if (usedTokens.has(key)) return false;
  const ok = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
  if (ok) {
    usedTokens.set(key, Date.now());
    prune();
  }
  return !!ok;
}

module.exports = { verifyTotpOnce };
