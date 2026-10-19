/**
 * The verification keyring for JWTs.
 *
 * WHY THIS EXISTS
 * ---------------
 * `manualActions[0]` of the security audit has been "URGENT: rotate JWT_SECRET"
 * since 2026-09-23, and it has not happened. Not because anyone forgot: the
 * value is in public git history, so it IS burned, and every code path that
 * needs it — sign, verify, the HKDF the encryption keys fall back to, the OTP
 * challenge digest — derives everything from the one variable the deploy reads.
 * Rotating it with a single-key verifier disconnects every logged-in member and
 * admin the moment the process restarts, so "later" is always the safer answer.
 *
 * A keyring is what makes the rotation a normal Tuesday instead.
 * `JWT_SECRET_PREVIOUS_KEYS` lists keys that are no longer used for signing but
 * are still accepted for verification, so the cutover can happen while traffic
 * is on the wire: new tokens carry the new secret, sessions still held by a
 * browser verify against the old one, and nothing is cut off mid-request.
 *
 * THE PART THAT IS ACTUALLY LOAD-BEARING
 * --------------------------------------
 * The overlap makes rotation SAFE; the cleanup makes it MEANINGFUL. A retired
 * key left in `JWT_SECRET_PREVIOUS_KEYS` is still a key this server accepts, so
 * a secret burned in git history keeps minting valid access forever and the
 * whole exercise accomplishes nothing. That is why this module counts, per
 * deprecated key, how many tokens it accepted since the process started:
 * `rotationState()` turns that into "you can delete this now" or "not yet, there
 * are still sessions riding on it". The `jwt_secret_rotation` monitor reads it.
 *
 * Two other things this handles deliberately:
 *
 *   • Algorithms stay pinned to HS256 for EVERY candidate key. Trying several
 *     keys must never widen what is accepted — a token signed `alg:none`, or with
 *     a different algorithm, is rejected exactly as firmly as it was when only
 *     one key existed (finding L1). This is a key-list, not an algorithm-list.
 *
 *   • The first candidate is always the current key and its error is the one
 *     rethrown when nothing verifies. A verifier that reported "expired" only
 *     after trying three keys would answer slower for the tokens it rejects, and
 *     `middleware/auth.js` branches on `TokenExpiredError`, so the distinction
 *     has to survive being attempted more than once.
 *
 * Note on the keys that are DERIVED from JWT_SECRET (utils/dataKey.js,
 * utils/secretBox.js, utils/otpChallenge.js): changing the signing secret also
 * changes any key that falls back to it, which can make already-stored
 * ciphertext unreadable. That hazard is measured rather than documented here —
 * `rotationSafety()` below reads the two key sources from the environment, and
 * the monitor refuses to call a rotation safe while data is encrypted under a
 * key that only exists inside the secret being replaced.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ALGORITHMS = ['HS256'];

/** The signing key. Exactly one key ever signs; deprecated keys only verify. */
function currentKey() {
  return String(process.env.JWT_SECRET || '').trim();
}

/**
 * Keys that still verify but never sign, in the order the operator listed them.
 * Blank entries are skipped (a trailing comma is not a key) and the current key
 * is dropped, so a copy-paste that leaves the new secret in the previous list
 * cannot make an ordinary token look like a rotation-window token.
 */
function deprecatedKeys() {
  const current = currentKey();
  const seen = new Set();
  const out = [];
  for (const entry of String(process.env.JWT_SECRET_PREVIOUS_KEYS || '').split(',')) {
    const key = entry.trim();
    if (!key || key === current || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 8 url-safe base64 characters of the key's SHA-256: identifies it, leaks nothing. */
function keyId(key) {
  return crypto.createHash('sha256').update(String(key)).digest('base64url').slice(0, 8);
}

// Per-deprecated-key acceptance counts, for the lifetime of THIS process. They
// are in memory on purpose: "has anyone presented a token under this key since
// we booted" is the question that decides whether the overlap can be deleted,
// and a number that survived restarts would count sessions that no longer exist.
const acceptances = new Map();

/**
 * Verify a token against the current key, then against each retained key.
 *
 * @param {string} token
 * @param {object} [options] passed to jsonwebtoken, except `algorithms`, which
 *   is always pinned here.
 * @returns {object|import('jsonwebtoken').JwtPayload}
 * @throws whatever the CURRENT key threw when no key verified the token.
 */
function verify(token, options = {}) {
  const { algorithms: _ignored, ...rest } = options || {};
  const candidates = [currentKey(), ...deprecatedKeys()].filter(Boolean);
  if (!candidates.length) {
    const error = new Error('JWT_SECRET is not configured; no token can be verified.');
    error.name = 'JsonWebTokenError';
    throw error;
  }

  let firstError;
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const payload = jwt.verify(token, candidates[index], { ...rest, algorithms: ALGORITHMS });
      if (index > 0) {
        const id = keyId(candidates[index]);
        const seen = acceptances.get(id) || { keyId: id, accepted: 0, lastAt: null };
        seen.accepted += 1;
        seen.lastAt = new Date();
        acceptances.set(id, seen);
      }
      return payload;
    } catch (error) {
      if (index === 0) firstError = error;
    }
  }
  throw firstError;
}

/** Sign with the current key. Never exposed for a deprecated one. */
function sign(payload, options = {}) {
  return jwt.sign(payload, currentKey(), options);
}

/**
 * Whether JWT_SECRET can be rotated right now without losing anything.
 *
 * `dataKeySource` / `sealKeySource` are the `source` fields of utils/dataKey.js
 * and utils/secretBox.js. A source that names JWT_SECRET means the encryption
 * key is DERIVED from the signing secret, so replacing that secret re-derives
 * the encryption key and every byte stored under the old one stops opening —
 * unless the operator has declared the old derived key in the matching
 * `*_PREVIOUS` variable, which is exactly the thing nobody remembers.
 */
function rotationSafety({ dataKeySource = '', sealKeySource = '', previousDeclared = deprecatedKeys().length } = {}) {
  const blockers = [];
  const derivedData = /JWT_SECRET/i.test(String(dataKeySource));
  const derivedSeal = /JWT_SECRET/i.test(String(sealKeySource));

  if (derivedData) {
    blockers.push('health data is encrypted under a key derived from JWT_SECRET (utils/dataKey.js) — put the current '
      + 'derived key in HEALTH_DATA_KEY_PREVIOUS, or set an explicit HEALTH_DATA_KEY first');
  }
  if (derivedSeal) {
    blockers.push('authenticator seeds are sealed under a key derived from JWT_SECRET (utils/secretBox.js) — put the '
      + 'current key in TOTP_ENCRYPTION_KEY_PREVIOUS, or set an explicit TOTP_ENCRYPTION_KEY first');
  }

  return {
    // A rotation is only "safe" in the narrow sense: nothing above loses data.
    // Overlap keys are what makes it safe for live sessions, so their absence is
    // reported, but it is a different consequence — logged out, not locked out.
    losesData: blockers.length > 0,
    blockers,
    overlapConfigured: previousDeclared > 0,
    previousDeclared,
  };
}

/** What the monitor renders. Contains fingerprints only, never key material. */
function rotationState() {
  return {
    currentKeyId: currentKey() ? keyId(currentKey()) : '',
    signing: Boolean(currentKey()),
    deprecatedKeyIds: deprecatedKeys().map(keyId),
    acceptances: [...acceptances.values()].map((row) => ({
      keyId: row.keyId,
      accepted: row.accepted,
      lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null,
    })),
  };
}

module.exports = {
  ALGORITHMS,
  verify,
  sign,
  currentKey,
  deprecatedKeys,
  keyId,
  rotationSafety,
  rotationState,
};
