/**
 * Authenticated encryption for secrets the SERVER must be able to read back.
 *
 * WHY THIS EXISTS
 * ---------------
 * A TOTP seed is not a password. A password is verified by re-hashing what the
 * user typed, so it can be stored as a one-way digest and thrown away. A TOTP
 * seed cannot: verifying a code means running HMAC over the seed and the
 * counter, so the server needs the seed itself on every sign-in. Hashing is
 * therefore not an option, and the previous implementation stored the raw
 * base32 seed on the user document, meaning anyone who could read the database
 * (a dump, a replica, a backup, a careless admin query) could mint valid codes
 * for every enrolled account, forever, with no password.
 *
 * So it is ENCRYPTED, not hashed: AES-256-GCM, which is authenticated (the tag
 * makes silent tampering a decryption failure rather than a forged plaintext)
 * and provides confidentiality. The key never lives in the database, which is
 * the only reason "the database leaked" stops being catastrophic.
 *
 * ── Envelope ───────────────────────────────────────────────────────────────
 *
 *   v1.<keyId>.<iv>.<tag>.<ciphertext>      (each part base64url)
 *
 * The version and key id are IN the envelope, not inferred. The key id is a
 * FINGERPRINT OF THE KEY ITSELF (8 bytes of SHA-256 over the key material),
 * not a positional label, and that is what makes rotation work without a
 * maintenance window: a ciphertext says which key made it, so it stays
 * readable after the primary key is replaced. A positional id ("k1 is the
 * current one") would silently break every existing envelope the moment the
 * key rotated, which is the kind of failure that only appears at 3am for
 * exactly the accounts that had an authenticator.
 *
 * ── Key resolution ─────────────────────────────────────────────────────────
 *
 *   TOTP_ENCRYPTION_KEY           base64 (or hex) of 32 bytes. The real one.
 *   TOTP_ENCRYPTION_KEY_PREVIOUS  comma-separated key material, decrypt-only.
 *   (neither)                     HKDF-SHA256(JWT_SECRET, "suppliwise/totp/v1")
 *
 * The fallback exists so a developer clone boots and the test suite runs
 * without extra setup. It is NOT a substitute for the real thing, and it says
 * so loudly, because it ties the TOTP key's confidentiality to the JWT signing
 * key: whoever can forge tokens would then also be able to decrypt every seed.
 * Production must set its own key, and index.js refuses to boot without it.
 *
 * ── What is deliberately absent ────────────────────────────────────────────
 *
 * No logging of plaintext, no logging of the key, no error that echoes either.
 * A failed decrypt returns null, never the ciphertext and never a stack: a
 * decryption oracle is what distinguishes "wrong key" from "tampered" for an
 * attacker, and there is no reason to hand one out.
 */
const crypto = require('crypto');

const ENVELOPE_VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;   // 96-bit nonce, the GCM-recommended size
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_INFO = 'suppliwise/totp/v1';
const SEP = '.';
// NUL cannot appear in an environment variable, so it is a separator that
// cannot be faked by a value that happens to contain our delimiter.
const ENV_SEP = '|';

/** base64 (standard or url-safe) or hex to Buffer, or null if unusable. */
function parseKeyMaterial(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  try {
    const buf = Buffer.from(text, 'base64');
    // Buffer.from(base64) is famously lenient: it silently drops characters it
    // does not recognise. A 30-byte result from a mistyped 32-byte key must be
    // a hard error here, not a weaker key discovered at encryption time.
    return buf.length === KEY_BYTES ? buf : null;
  } catch {
    return null;
  }
}

/** 8 bytes of SHA-256 over the key: unique in practice, far too short to leak. */
function keyId(key) {
  return crypto.createHash('sha256').update(key).digest('base64url').slice(0, 11);
}

/**
 * Every key this process can use, keyed by its own fingerprint.
 *
 * Cached against an environment fingerprint rather than forever, because
 * utils/envFile can reload the environment while the server is running and a
 * rotated key should take effect on the next request rather than on the next
 * deploy.
 */
let cached = null;
let cachedFingerprint = '';

function envFingerprint() {
  return [
    process.env.TOTP_ENCRYPTION_KEY || '',
    process.env.TOTP_ENCRYPTION_KEY_PREVIOUS || '',
    String(process.env.JWT_SECRET || '').length,
    process.env.NODE_ENV || '',
  ].join(ENV_SEP);
}

function loadKeys() {
  const fingerprint = envFingerprint();
  if (cached && cachedFingerprint === fingerprint) return cached;

  const keys = new Map();
  let source = 'none';
  let primaryId = null;

  const primary = parseKeyMaterial(process.env.TOTP_ENCRYPTION_KEY);
  if (primary) {
    primaryId = keyId(primary);
    keys.set(primaryId, primary);
    source = 'TOTP_ENCRYPTION_KEY';
  } else {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'TOTP_ENCRYPTION_KEY must be set to a base64/hex 32-byte key in production. '
        + 'Generate one with `openssl rand -base64 32`. Without it the server would '
        + 'fall back to deriving the TOTP encryption key from JWT_SECRET, which ties '
        + 'token forgery to seed decryption.',
      );
    }
    // Development / test fallback. HKDF gives a well-separated 32-byte key from
    // a secret that already has to be long and random, so this is a real key,
    // just one that shares fate with the JWT secret because nobody has
    // configured the better one yet.
    const secret = String(process.env.JWT_SECRET || '');
    if (secret) {
      const derived = Buffer.from(crypto.hkdfSync(
        'sha256',
        Buffer.from(secret, 'utf8'),
        Buffer.alloc(0),
        Buffer.from(HKDF_INFO, 'utf8'),
        KEY_BYTES,
      ));
      const derivedId = keyId(derived);
      keys.set(derivedId, derived);
      source = 'derived-from-JWT_SECRET';
      // The derived key is just as much the WRITE key as an explicit one would
      // be. Leaving primaryId null here made `available` false and made every
      // encryption throw, which is the whole reason this branch exists.
      primaryId = derivedId;
    }
  }

  // Decrypt-only predecessors. Entries may be written as "kid=BASE64" for
  // readability, but each key is always STORED under its own fingerprint, so a
  // mislabelled or duplicated entry still decrypts correctly.
  for (const pair of String(process.env.TOTP_ENCRYPTION_KEY_PREVIOUS || '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const key = parseKeyMaterial(pair.slice(at + 1));
    if (key) keys.set(keyId(key), key);
  }

  cached = { keys, source, primaryId };
  cachedFingerprint = fingerprint;
  return cached;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/**
 * True when `value` looks like one of our envelopes rather than a bare secret.
 *
 * This is the whole legacy-detection strategy: a pre-existing account has raw
 * base32 in the old field, a migrated one has a versioned envelope, and the two
 * are told apart by shape rather than by a flag that could disagree with
 * reality.
 */
function isEnvelope(value) {
  const text = String(value || '');
  if (!text.startsWith(ENVELOPE_VERSION + SEP)) return false;
  return text.split(SEP).length === 5;
}

/**
 * Encrypt a UTF-8 string under the PRIMARY key. Returns '' for empty input so a
 * caller can clear a secret by clearing a field, and throws only when no key is
 * available at all, which is a misconfiguration that must not be silently
 * downgraded to plaintext.
 */
function encrypt(plaintext) {
  const text = plaintext == null ? '' : String(plaintext);
  if (!text) return '';
  const { keys, primaryId } = loadKeys();
  const key = keys.get(primaryId);
  if (!key) {
    throw new Error('No encryption key is available (set TOTP_ENCRYPTION_KEY, or JWT_SECRET for local development).');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    primaryId,
    b64u(iv),
    b64u(tag),
    b64u(ciphertext),
  ].join(SEP);
}

/**
 * Decrypt an envelope produced by `encrypt`. Returns null when the value is not
 * an envelope, names an unknown key, or fails authentication: three different
 * faults that are deliberately indistinguishable to the caller, because
 * distinguishing them is a decryption oracle.
 */
function decrypt(envelope) {
  if (!isEnvelope(envelope)) return null;
  const parts = String(envelope).split(SEP);
  const key = loadKeys().keys.get(parts[1]);
  if (!key) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(parts[2], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[4], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Non-secret description of the key situation, for the boot-time log and the
 * production checks. Reports key IDs and lengths only, never key material.
 */
function describe() {
  const { keys, source, primaryId } = loadKeys();
  return {
    available: Boolean(primaryId),
    source,
    activeKeyId: primaryId || '',
    keyIds: [...keys.keys()],
  };
}

// Test seam: drop the memoised keys so a suite that mutates the environment
// between cases re-reads it. Production never needs it.
function _resetCache() {
  cached = null;
  cachedFingerprint = '';
}

module.exports = {
  encrypt,
  decrypt,
  isEnvelope,
  describe,
  ENVELOPE_VERSION,
  KEY_BYTES,
  _resetCache,
};
