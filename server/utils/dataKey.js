/**
 * The key used to encrypt data AT REST (member health blobs, wallet signing
 * keys) — kept deliberately separate from the key that mints session tokens.
 *
 * WHY THIS EXISTS
 * ---------------
 * Both of those used to be `sha256(process.env.JWT_SECRET)`. One secret therefore
 * held two unrelated jobs: forgery and decryption. Anyone who obtained it could
 * sign a token and claim to be any member, AND open every stored health record
 * and every wallet private key — and the second half stays possible forever,
 * because ciphertext written under a key does not stop being readable when that
 * key is rotated for signing tokens. The blast radius of the signing secret was
 * silently the whole database.
 *
 * index.js already refuses this coupling for TOTP seeds (production will not boot
 * without its own TOTP_ENCRYPTION_KEY). This is the same rule for the data that is
 * actually sensitive.
 *
 * ── Key resolution, in order ────────────────────────────────────────────────
 *
 *   HEALTH_DATA_KEY                 base64/hex 32 bytes. The real one; write key.
 *   HEALTH_DATA_KEY_PREVIOUS        comma-separated, decrypt-only (rotation).
 *   (none of the above)             HKDF-SHA256(JWT_SECRET, info below) — a real
 *                                   32-byte key, still derived, and it says so.
 *   LEGACY                          sha256(JWT_SECRET) itself, tried LAST so
 *                                   ciphertext pinned before this module existed
 *                                   still opens. Without it every stored health
 *                                   backup and wallet key in a live database
 *                                   would become unreadable the moment this
 *                                   shipped, which is data loss, not security.
 *
 * Envelopes here carry no key id, so `decrypt` answers "wrong key" and "tampered"
 * identically (a GCM tag failure) and the caller tries the next candidate. That is
 * safe precisely because there is nothing to learn from the difference: the
 * ciphertext is already the owner's own, and the tag still refuses to open
 * anything it did not seal.
 */
const crypto = require('crypto');

const KEY_BYTES = 32;
const HKDF_INFO = 'suppliwise/data-at-rest/v1';
const LEGACY_INFO = 'legacy-sha256(JWT_SECRET)';

/** base64 (standard or url-safe) or hex of exactly 32 bytes, else null. */
function parseKeyMaterial(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  const buf = Buffer.from(text, 'base64');
  // Same strictness as utils/secretBox: Buffer.from(base64) silently drops
  // characters it does not understand, so a mistyped key must fail here rather
  // than quietly become a shorter, weaker one.
  return buf.length === KEY_BYTES ? buf : null;
}

function hkdf(secret) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(String(secret), 'utf8'),
    Buffer.alloc(0),
    Buffer.from(HKDF_INFO, 'utf8'),
    KEY_BYTES,
  ));
}

// Re-derive on every call rather than caching: utils/envFile can reload the
// environment while the server is running, and a key that is only half-rotated
// is the failure mode this module exists to avoid.
function resolve() {
  const primary = parseKeyMaterial(process.env.HEALTH_DATA_KEY);
  const candidates = [];
  const previous = [];

  const push = (key) => {
    if (key && !candidates.some((c) => c.equals(key))) {
      candidates.push(key);
      previous.push(key);
    }
  };
  // Every key that has EVER sealed data in this application, appended after the
  // write key in the order it was introduced.
  //
  // This is what makes a rotation safe. Declaring HEALTH_DATA_KEY used to build a
  // candidate list containing only that key and its stated predecessors, so the
  // first production deployment that set it — exactly what index.js warns about —
  // left every health blob and every wallet signing key that had been sealed
  // under a JWT_SECRET-derived key unreadable, with a GCM tag failure as the only
  // symptom and no log naming the cause. Silent data loss is not a security win.
  const pushDerived = (secret) => {
    if (!secret) return;
    push(hkdf(secret));
    push(crypto.createHash('sha256').update(secret, 'utf8').digest());
  };
  const pushDeclared = (list) => {
    for (const entry of String(list || '').split(',')) {
      const value = String(entry || '').trim();
      if (!value) continue;
      const at = value.indexOf('=');
      // A labelled entry first, then the whole thing — because a standard
      // base64 32-byte key ends in '=' padding, and treating that as the label
      // separator would chop the key into nothing. Same reasoning as
      // utils/secretBox.js: the way an operator actually pastes a rotated key
      // must not be a silent no-op.
      for (const candidate of at <= 0 ? [value] : [value.slice(at + 1), value]) {
        const key = parseKeyMaterial(candidate);
        if (key) {
          push(key);
          break;
        }
      }
    }
  };

  if (primary) {
    candidates.push(primary);
    pushDeclared(process.env.HEALTH_DATA_KEY_PREVIOUS);
    pushDerived(String(process.env.JWT_SECRET || ''));
    return { key: primary, candidates, source: 'HEALTH_DATA_KEY', configured: true, previous: previous.length };
  }

  const secret = String(process.env.JWT_SECRET || '');
  if (secret) {
    const derived = hkdf(secret);
    candidates.push(derived);
    pushDeclared(process.env.HEALTH_DATA_KEY_PREVIOUS);
    // Last, because it is the pre-separation key: sha256 of the signing secret
    // itself, exactly what blockchain/crypto.js was handed before this module
    // existed. Without it, every health backup and wallet key already in a live
    // database stops opening the moment this ships — data loss, not security.
    push(crypto.createHash('sha256').update(secret, 'utf8').digest());
    return {
      key: derived,
      candidates,
      source: 'derived-from-JWT_SECRET',
      configured: false,
      previous: previous.length,
    };
  }

  return { key: null, candidates: [], source: 'none', configured: false, previous: 0 };
}

/** The 32-byte key new ciphertext is written under, or null. */
function primary() {
  const r = resolve();
  return r.key;
}

/** Every key worth trying, write key first, legacy last. */
function candidates() {
  return resolve().candidates;
}

/** Which key the given ciphertext was sealed with (null = none of them). */
function openWith(envelope, decryptWith) {
  for (const key of candidates()) {
    try {
      const plaintext = decryptWith(key);
      if (plaintext !== null && plaintext !== undefined) return { plaintext, key };
    } catch {
      // Wrong key and tampered ciphertext are the same GCM failure; try the next.
    }
  }
  return null;
}

/** Which candidate a value was derived from, for reporting only. Never key material. */
function fingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('base64url').slice(0, 11);
}

function describe() {
  const r = resolve();
  return {
    available: Boolean(r.key),
    configured: r.configured,
    source: r.source,
    activeKeyId: r.key ? fingerprint(r.key) : '',
    candidates: r.candidates.length,
    // Decrypt-only keys beyond the write key — including, whenever JWT_SECRET
    // exists, the two historical derived keys. Reporting the count is what lets
    // an operator see that a rotation did not orphan the old ciphertext.
    previous: r.previous,
    legacyIncluded: r.candidates.length > 1,
    legacyLabel: LEGACY_INFO,
  };
}

module.exports = { primary, candidates, openWith, describe, fingerprint, parseKeyMaterial, KEY_BYTES, HKDF_INFO };
