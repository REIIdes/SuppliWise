const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════════════
// Cryptographic primitives for the SuppliWise Web3 layer.
//
//  · stableStringify / hashPayload — deterministic canonical JSON + sha256
//    digests, so the same payload always hashes to the same tx/block hash.
//  · generateIdentity / sign / verify — ed25519 decentralized identity keys.
//  · encrypt / decrypt — AES-256-GCM for user data at rest (feature 8).
//  · contentId — IPFS-style content identifiers (CID) computed from ciphertext.
// ═══════════════════════════════════════════════════════════════════════════

// Deterministic JSON: object keys sorted recursively, undefined dropped.
// Two structurally equal payloads must produce the same bytes (and hash) no
// matter how the keys were inserted.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256Hex(input) {
  return crypto
    .createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .digest('hex');
}

// Canonical payload hash — used for every tx `dataHash`.
function hashPayload(payload) {
  return sha256Hex(stableStringify(payload === undefined ? null : payload));
}

// ── ed25519 identity ───────────────────────────────────────────────────────
const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Deterministic, Ethereum-looking address derived from the public key.
function addressFromPublicKey(publicKeyB64) {
  return `0x${sha256Hex(`sw:addr:${publicKeyB64}`).slice(0, 40)}`;
}

// Generate a new decentralized identity: ed25519 keypair → address.
function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pubRaw = spki.subarray(spki.length - 32).toString('base64'); // raw 32-byte key
  const privPkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  return {
    publicKey: pubRaw,
    privateKey: privPkcs8,
    address: addressFromPublicKey(pubRaw),
  };
}

function toKeyObject(b64, type) {
  return crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type });
}

function toPublicKeyObject(pubRawB64) {
  const raw = Buffer.from(pubRawB64, 'base64');
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), // SPKI prefix for Ed25519
    raw,
  ]);
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

function sign(privateKeyB64, message) {
  const key = toKeyObject(privateKeyB64, 'pkcs8');
  return crypto.sign(null, Buffer.from(String(message), 'utf8'), key).toString('base64');
}

function verify(publicKeyB64, message, signatureB64) {
  try {
    const key = toPublicKeyObject(publicKeyB64);
    return crypto.verify(null, Buffer.from(String(message), 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

// ── AES-256-GCM encryption (data at rest / before content-addressing) ─────
function cipherKey(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest();
}

function encrypt(plaintext, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey(secret), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt({ iv, ct, tag }, secret) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey(secret), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

// IPFS-style content identifier: CIDv1-looking, derived purely from bytes —
// the same content always maps to the same CID (tamper-evident by design).
function contentId(bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest();
  return `bafy${base32Encode(digest)}`;
}

// Local calendar day key (YYYY-MM-DD) — shared by reward idempotency.
function dayKey(at = Date.now()) {
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Round token amounts to 2 decimals (avoids float drift in balances).
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

module.exports = {
  stableStringify,
  sha256Hex,
  hashPayload,
  generateIdentity,
  addressFromPublicKey,
  sign,
  verify,
  encrypt,
  decrypt,
  contentId,
  base32Encode,
  dayKey,
  round2,
};
