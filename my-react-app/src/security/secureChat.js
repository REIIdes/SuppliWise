/**
 * END-TO-END ENCRYPTION for support conversations — the browser's half.
 *
 * ── What this file is responsible for, and nothing else ─────────────────────
 * Every sealed byte a member or an operator sees was produced here, and every
 * one of them can be read here. The server stores the results of these calls
 * and routes them; it never has the keys. That is the whole claim, and it holds
 * only because this file has no network code in it at all — see `useSecureChat`
 * for the wiring and `server/utils/chatEncryption.js` for the wire format this
 * matches.
 *
 * ── The key hierarchy ───────────────────────────────────────────────────────
 *
 *   identity key pair (P-256 ECDH, one per browser)
 *     ├── private  → localStorage, sealed under a device secret
 *     │             (survives a reload; see `deviceSecret` for its limits)
 *     └── private  → a copy kept server-side, sealed under a RECOVERY CODE the
 *                     account holder is shown and asked to save
 *
 *   content key (AES-256-GCM, one per conversation, 32 random bytes)
 *     ├── shared to the member      → wrapped to their identity public key
 *     └── shared to each operator   → wrapped to their identity public key
 *
 *   message body → AES-256-GCM under the content key
 *
 * A share is ECIES: a fresh ephemeral key pair per share, HKDF-SHA256 over the
 * ECDH shared secret to derive a key-encryption key, AES-GCM to wrap. It is one
 * envelope string, it is self-describing, and unpicking it requires the private
 * half of the recipient's identity key — which the server has never had.
 *
 * ── The two failure modes this file is built around ─────────────────────────
 *
 * 1. No WebCrypto. `secureChatAvailable()` is checked before anything else.
 *    A page served over plain HTTP on a LAN address has no `crypto.subtle`, and
 *    pretending otherwise gives a button that silently produces nothing. The
 *    caller degrades to ordinary text and says so.
 *
 * 2. A browser that does not hold the key. A member who opens the app on a new
 *    machine cannot read conversations sealed to the key on the old one — that
 *    is inherent to end-to-end encryption and is the same reason Signal tells
 *    you about it. `openFromThread` returns null rather than throwing, so the
 *    UI can say so, and the recovery code exists so the answer is "paste the
 *    code you saved" rather than "that history is gone".
 *
 * Everything here calls no globals other than `crypto`, `btoa`/`atob` and
 * `localStorage` — which is why it can be tested under `node --test` on Node 24,
 * where all three exist.
 */

// ── Envelope tags ───────────────────────────────────────────────────────────
// These must stay in step with the patterns in server/utils/chatEncryption.js.
// A mismatch is not a crash, it is a message that reads as garbage on one side
// and "bad request" on the other, which is why it is asserted by a unit test.
const MESSAGE_TAG = 'e1';
const WRAP_TAG = 'w1';
const RECOVERY_TAG = 'r1';

const HKDF_INFO = 'suppliwise/chat/keywrap/v1';
const RECOVERY_SALT_INFO = 'suppliwise/chat/recovery-salt/v1';

const IDENTITY_PREFIX = 'suppliwise:secure-chat:identity:';
const DEVICE_SECRET_KEY = 'suppliwise:secure-chat:device';

// The body of a recovery code, behind its prefix, as `normalizeRecoveryCode`
// counts it: 24 characters. NOT derived from the group arithmetic in
// generateRecoveryCode below — computing it as `4 + 4 * 5 - 4` is exactly the
// mis-split that produced a code the normaliser would reject.
const RECOVERY_CODE_BODY_LENGTH = 24;
const RECOVERY_ITERATIONS = 150000;

// A member scrolling a 500-message conversation twice would otherwise grow this
// to every distinct ciphertext they have ever seen.
const TEXT_CACHE_LIMIT = 400;

// ── base64url ───────────────────────────────────────────────────────────────

export function b64uEncode(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode, tolerating the padding a hand-copied value is likely to have lost.
 * Throws on genuinely malformed input — every caller treats that as "wrong
 * code" rather than as a crash.
 */
export function b64uDecode(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const randomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

// ── Availability ────────────────────────────────────────────────────────────

/**
 * False on a plain-HTTP LAN origin, an old browser, or a locked-down WebView.
 * Every caller checks this before promising the member anything.
 */
export function secureChatAvailable() {
  return typeof TextEncoder !== 'undefined'
    && typeof TextDecoder !== 'undefined'
    && typeof btoa === 'function'
    && Boolean(globalThis.crypto && globalThis.crypto.subtle);
}

const subtle = () => globalThis.crypto.subtle;

// ── Encoding helpers ────────────────────────────────────────────────────────

const encodeText = (text) => new TextEncoder().encode(String(text));
const decodeText = (bytes) => new TextDecoder().decode(bytes);

const concat = (...parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

// ── Caches ──────────────────────────────────────────────────────────────────
//
// Module scope, not React state, and deliberately so. These are CryptoKey
// objects that must survive a re-render, a poll and a component unmount; they
// are secrets, so they are never handed to a React state inspector or a dev
// tool. Nothing here outlives the tab.

const identityCache = new Map();
const threadKeyCache = new Map();
const textCache = new Map();

/** Amber: the letter set excludes I, L, O and U — the four people misread aloud. */
const KEY_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A key id: 10 characters of a 32-symbol alphabet, ~50 bits. */
export function generateKeyId() {
  const bytes = randomBytes(10);
  let id = '';
  for (let index = 0; index < bytes.length; index += 1) {
    id += KEY_ID_ALPHABET[bytes[index] % KEY_ID_ALPHABET.length];
  }
  return id;
}

/**
 * A 24-character recovery code in five readable segments: `SWK-XXXX-XXXXX-XXXXX-XXXXX-XXXXX`.
 *
 * Deliberately NOT a word list. It is one random value with hyphens in it so it
 * can be read aloud, and the letter set is UPPERCASE for the same reason the
 * ticket ids are: these are typed from a screen. Lowercase would be as secure
 * and noticeably harder to read back correctly.
 *
 * The group arithmetic matters and is spelled out rather than derived: a
 * 20-character body split 4 + 4×5 leaves the final group one character short,
 * which reads as a typo to everyone shown one and — worse — makes the code that
 * prints different from the code `normalizeRecoveryCode` will accept.
 */
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LENGTH = 5;
const RECOVERY_HEAD_LENGTH = 4;
const RECOVERY_TOTAL_LENGTH = RECOVERY_HEAD_LENGTH + RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH;

/** Same alphabet as a ticket id: no I, L, O or U, all uppercase. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export function generateRecoveryCode() {
  const bytes = randomBytes(RECOVERY_TOTAL_LENGTH);
  let flat = '';
  for (let index = 0; index < bytes.length; index += 1) {
    // 256 is a whole multiple of 32, so `byte % 32` is uniform — no modulo bias.
    flat += RECOVERY_ALPHABET[bytes[index] % RECOVERY_ALPHABET.length];
  }
  const head = flat.slice(0, RECOVERY_HEAD_LENGTH);
  const groups = [];
  for (let index = 0; index < RECOVERY_GROUPS; index += 1) {
    const start = RECOVERY_HEAD_LENGTH + index * RECOVERY_GROUP_LENGTH;
    groups.push(flat.slice(start, start + RECOVERY_GROUP_LENGTH));
  }
  return `SWK-${head}-${groups.join('-')}`;
}

/** Four characters — enough to recognise your own code, worthless as one. */
export function recoveryHintOf(code) {
  return String(code || '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(-4);
}

/**
 * Accept a code typed with or without the prefix, with or without the hyphens,
 * in either case. Returns the 20-character secret or '' if it is not one.
 */
export function normalizeRecoveryCode(code) {
  const flat = String(code || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  const body = flat.startsWith('SWK') ? flat.slice(3) : flat;
  return body.length === RECOVERY_CODE_BODY_LENGTH ? body : '';
}

// ── P-256 ECDH ──────────────────────────────────────────────────────────────

const ECDH_ARG = { name: 'ECDH', namedCurve: 'P-256' };

/**
 * The 64-byte x‖y of a P-256 point, base64url — the wire form of a public key.
 *
 * The point, not the full SPKI DER: 64 bytes is what the server stores and what
 * the share envelope carries, and wrapping a DER blob in base64 would have cost
 * ~140 characters per share for no added security.
 */
function rawFromJwk(jwk) {
  return b64uEncode(concat(b64uDecode(jwk.x), b64uDecode(jwk.y)));
}

/**
 * Inverse of `rawFromJwk`.
 *
 * `kty` is `EC`, NOT `ECDH`. The WebCrypto JWK shape for every NIST curve is
 * `EC` regardless of whether the key is used for ECDH — the algorithm name
 * (`ECDH`) says what the key is FOR, and `kty`/`crv` say what it IS. Getting this
 * wrong throws `Invalid JWK "kty" Parameter` on every import in every browser,
 * which is exactly what the round-trip test in secureChat.test.js is here to
 * catch: the server validates the shape of a key but never imports one, so this
 * is the only place that mistake can be detected before it ships.
 */
function jwkFromRaw(raw) {
  const bytes = b64uDecode(raw);
  if (bytes.length !== 64) throw new Error('That public key is not a P-256 point.');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64uEncode(bytes.slice(0, 32)),
    y: b64uEncode(bytes.slice(32, 64)),
    ext: true,
  };
}

const importPublic = (raw) => subtle().importKey('jwk', jwkFromRaw(raw), ECDH_ARG, false, []);

// ── AES-GCM and HKDF ────────────────────────────────────────────────────────

const AES_GCM = 'AES-GCM';

const importAesKey = (rawBytes, extractable) => subtle().importKey(
  'raw', rawBytes, AES_GCM, Boolean(extractable), ['encrypt', 'decrypt']
);

async function hkdf(sharedBytes, saltBytes) {
  const base = await subtle().importKey('raw', sharedBytes, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: encodeText(HKDF_INFO) },
    base,
    { name: AES_GCM, length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function aesGcmEncrypt(key, iv, data) {
  return new Uint8Array(await subtle().encrypt({ name: AES_GCM, iv }, key, data));
}

async function aesGcmDecrypt(key, iv, data) {
  return new Uint8Array(await subtle().decrypt({ name: AES_GCM, iv }, key, data));
}

/** `e1.<iv>.<ciphertext>` — the one string shape a message travels as. */
const encryptTextWith = async (key, text) => {
  const iv = randomBytes(12);
  const sealed = await aesGcmEncrypt(key, iv, encodeText(text));
  return `${MESSAGE_TAG}.${b64uEncode(iv)}.${b64uEncode(sealed)}`;
};

async function decryptTextWith(key, envelope) {
  const parts = String(envelope).split('.');
  if (parts.length !== 3 || parts[0] !== MESSAGE_TAG) throw new Error('Unsupported message envelope.');
  return decodeText(await aesGcmDecrypt(key, b64uDecode(parts[1]), b64uDecode(parts[2])));
}

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * A fresh identity.
 *
 * `privateKey` is extractable on purpose: it has to leave the browser exactly
 * once — sealed under the recovery code — and cannot be re-wrapped if it is
 * not. After that write the key is still only ever used in memory.
 */
export async function generateIdentity() {
  const pair = await subtle().generateKey(ECDH_ARG, true, ['deriveBits', 'deriveKey']);
  const publicJwk = await subtle().exportKey('jwk', pair.publicKey);
  return {
    keyId: generateKeyId(),
    publicKey: rawFromJwk(publicJwk),
    privateKey: pair.privateKey,
  };
}

// ── localStorage ────────────────────────────────────────────────────────────
//
// Every access is guarded. Private-browsing modes throw on write, a
// storage-disabled setting throws on read, an exceeded quota throws on setItem.
// None of those are reasons to lose the conversation, so none of them throw out
// of this module: identity stays in memory for the tab, and the caller degrades
// rather than dies.

function readStorage(key) {
  try { return globalThis.localStorage?.getItem(key) || ''; } catch { return ''; }
}

function writeStorage(key, value) {
  try { globalThis.localStorage?.setItem(key, value); return true; } catch { return false; }
}

function forgetStorage(key) {
  try { globalThis.localStorage?.removeItem(key); } catch { /* ignore */ }
}

const identityStorageKey = (participant) => `${IDENTITY_PREFIX}${String(participant)}`;

/**
 * The device secret that seals the local copy of the private key.
 *
 * A random 32-byte value, generated once, never sent anywhere. It stops a
 * storage dump — a backup, a synced profile, an exported profile — from yielding
 * a usable private key. It does NOT stop a script running on the page: nothing
 * reading localStorage from inside this origin can, and that is the honest
 * boundary of a web end-to-end implementation. The recovery code exists because
 * of it.
 */
async function deviceSecret() {
  let stored = readStorage(DEVICE_SECRET_KEY);
  if (!stored) {
    stored = b64uEncode(randomBytes(32));
    writeStorage(DEVICE_SECRET_KEY, stored);
  }
  return importAesKey(b64uDecode(stored), false);
}

/** Store an identity, sealed under the device secret. */
export async function saveLocalIdentity(participant, identity) {
  if (!identity || !identity.keyId || !identity.publicKey || !identity.privateKey) return false;
  const privateJwk = JSON.stringify(await subtle().exportKey('jwk', identity.privateKey));
  const sealed = await encryptTextWith(await deviceSecret(), privateJwk);
  const record = { v: 1, keyId: identity.keyId, publicKey: identity.publicKey, sealedPrivateKey: sealed };
  const written = writeStorage(identityStorageKey(participant), JSON.stringify(record));
  identityCache.set(String(participant), identity);
  return written;
}

/**
 * Read an identity: memory first, then localStorage.
 *
 * @returns {Promise<{keyId:string,publicKey:string,privateKey:CryptoKey}|null>}
 */
export async function loadLocalIdentity(participant) {
  const cached = identityCache.get(String(participant));
  if (cached) return cached;

  const raw = readStorage(identityStorageKey(participant));
  if (!raw) return null;

  let record;
  try { record = JSON.parse(raw); } catch { return null; }
  if (!record || record.v !== 1 || !record.sealedPrivateKey) return null;

  try {
    const privateJwk = JSON.parse(await decryptTextWith(await deviceSecret(), record.sealedPrivateKey));
    const identity = {
      keyId: record.keyId,
      publicKey: record.publicKey,
      privateKey: await subtle().importKey('jwk', privateJwk, ECDH_ARG, true, ['deriveBits', 'deriveKey']),
    };
    identityCache.set(String(participant), identity);
    return identity;
  } catch {
    // A blob that will not unseal was not written by this device, or was moved
    // between origins. Drop it: keeping a broken identity makes every later
    // thread read as "unavailable" forever, with no way to tell why.
    forgetStorage(identityStorageKey(participant));
    return null;
  }
}

export function forgetLocalIdentity(participant) {
  identityCache.delete(String(participant));
  forgetStorage(identityStorageKey(participant));
}

// ── Content keys ─────────────────────────────────────────────────────────────

/** One 32-byte AES-256 key. The only secret a conversation is sealed under. */
export const generateThreadKey = () => importAesKey(randomBytes(32), true);

/** Stash a conversation's key under the id the server assigned to it. */
export function rememberThreadKey(threadId, key) {
  if (threadId && key) threadKeyCache.set(String(threadId), key);
}

/** The cached key for a thread, if this browser has one. */
export const recallThreadKey = (threadId) => threadKeyCache.get(String(threadId)) || null;

/** Drop every conversation key. Called on sign-out. */
export function forgetThreadKeys() {
  threadKeyCache.clear();
  textCache.clear();
}

/**
 * Open the server's wrapped copy of a conversation key with our own private key.
 *
 * @param {string} threadId
 * @param {string[]} wrappedBlobs  the shares addressed to THIS participant
 * @param {string} participant     `user:<id>` / `admin:<id>`
 * @returns {Promise<CryptoKey|null>}
 */
export async function ensureThreadKey(threadId, wrappedBlobs, participant) {
  const cached = threadKeyCache.get(String(threadId));
  if (cached) return cached;

  const identity = await loadLocalIdentity(participant);
  if (!identity) return null;

  const blobs = Array.isArray(wrappedBlobs) ? wrappedBlobs : [wrappedBlobs];
  for (const blob of blobs) {
    const key = await unwrapKeyFor(blob, identity.privateKey);
    if (key) {
      threadKeyCache.set(String(threadId), key);
      return key;
    }
  }
  return null;
}

/**
 * Wrap a content key to one recipient.
 *
 * @returns {Promise<string>} `w1.<ephPub>.<salt>.<iv>.<ct>`
 */
export async function wrapKeyFor(threadKey, recipientPublicKey) {
  const raw = await subtle().exportKey('raw', threadKey);
  const recipient = await importPublic(recipientPublicKey);
  const ephemeral = await subtle().generateKey(ECDH_ARG, true, ['deriveBits']);
  const ephemeralJwk = await subtle().exportKey('jwk', ephemeral.publicKey);

  // `w1.<ephPub>.<salt>.<iv>.<ct>` — five parts, and the ORDER must match
  // server/utils/chatEncryption.js exactly. A missing IV is not a crash: the
  // share is 4 segments, the server's shape check rejects it with a 400, and the
  // member sees "That message could not be encrypted properly." with no
  // explanation. The round-trip test pins the shape for exactly this reason.
  const shared = new Uint8Array(await subtle().deriveBits(
    { name: 'ECDH', public: recipient }, ephemeral.privateKey, 256
  ));
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = await hkdf(shared, salt);
  const sealed = await aesGcmEncrypt(kek, iv, raw);
  return [WRAP_TAG, rawFromJwk(ephemeralJwk), b64uEncode(salt), b64uEncode(iv), b64uEncode(sealed)].join('.');
}

/**
 * Open a wrapped content key with a private identity key.
 *
 * @returns {Promise<CryptoKey|null>} null when the blob was not sealed to this
 *   identity — the ordinary "wrong browser" case, not an error.
 */
export async function unwrapKeyFor(wrapped, privateKey) {
  if (!wrapped || !privateKey) return null;
  const parts = String(wrapped).split('.');
  if (parts.length !== 5 || parts[0] !== WRAP_TAG) return null;
  try {
    const ephemeral = await importPublic(parts[1]);
    const shared = new Uint8Array(await subtle().deriveBits(
    { name: 'ECDH', public: ephemeral }, privateKey, 256
  ));

    const kek = await hkdf(shared, b64uDecode(parts[2]));
    const raw = await aesGcmDecrypt(kek, b64uDecode(parts[3]), b64uDecode(parts[4]));
    return raw.length === 32 ? importAesKey(raw, true) : null;
  } catch {
    return null;
  }
}

// ── The read/write surface ───────────────────────────────────────────────────

/**
 * A new conversation's key, plus the two closures the create call needs.
 *
 * The key is returned as a SESSION and must be handed over with
 * `adoptThreadKey` once the server has confirmed a thread id — otherwise a
 * reply in the same second the thread was created has no key to seal with.
 */
export async function createSealing() {
  const key = await generateThreadKey();
  return {
    key,
    seal: (text) => encryptTextWith(key, text),
    shareWith: (publicKey) => wrapKeyFor(key, publicKey),
  };
}

/** Move a fresh conversation's key under the id the server gave it. */
export function adoptThreadKey(threadId, sealing) {
  if (threadId && sealing && sealing.key) {
    threadKeyCache.set(String(threadId), sealing.key);
  }
}

/**
 * Seal a message under an existing conversation's key.
 *
 * @param {string} threadId
 * @param {string} text
 * @returns {Promise<string>} `e1.<iv>.<ct>`
 * @throws when this browser has no key for the thread — the caller shows the
 *   "cannot read/write here" panel, because sending nothing is correct here.
 */
export async function sealText(threadId, text) {
  const key = threadKeyCache.get(String(threadId));
  if (!key) throw new Error('This conversation has no encryption key on this device.');
  return encryptTextWith(key, text);
}

/**
 * Open one ciphertext.
 *
 * @param {string} threadId
 * @param {string} envelope
 * @returns {Promise<string|null>} null when it cannot be read. The result is
 *   cached, including the negative, because "can this be read" is a stable
 *   answer for the life of a tab and re-deriving it across a 500-message
 *   transcript turns a blocked read into a janky scroll.
 */
export async function openText(threadId, envelope) {
  if (!envelope) return null;
  const cacheKey = `${String(threadId)}:${String(envelope)}`;

  const cached = textCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const key = threadKeyCache.get(String(threadId));
  if (!key) return null;

  let text = null;
  try {
    text = await decryptTextWith(key, envelope);
  } catch {
    // Not a failure to report. A blob that will not open is a key that is not
    // on this device, and the UI renders that as "unavailable" with its own
    // explanation — a thrown error here would surface as a crash instead.
    // The reassignment is the point: `text` must come out null, not undefined.
  }

  if (textCache.size >= TEXT_CACHE_LIMIT) {
    const oldest = textCache.keys().next().value;
    if (oldest !== undefined) textCache.delete(oldest);
  }
  textCache.set(cacheKey, text);
  return text;
}

/** Convenience for the batch case: one transcript, in order. */
export async function openAllText(threadId, envelopes) {
  return Promise.all(envelopes.map((envelope) => openText(threadId, envelope)));
}

// ── Recovery ────────────────────────────────────────────────────────────────

/**
 * The PBKDF2 salt is derived from the participant, so it is the same value
 * forever. A random salt would have to be stored and shipped with the wrapper,
 * which would be fine cryptographically but would make the code unwrappable by
 * anybody who has only the participant id and the code.
 */
async function recoverySalt(participant, code) {
  const base = await subtle().importKey('raw', encodeText(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: encodeText(`${RECOVERY_SALT_INFO}:${participant}`),
      iterations: RECOVERY_ITERATIONS,
    },
    base,
    256
  );
  return new Uint8Array(bits);
}

/**
 * Seal a private identity key under a recovery code.
 *
 * 150,000 PBKDF2-SHA256 iterations is the point: the wrapper is stored
 * server-side, so it WILL be attacked offline if it ever leaks, and the only
 * thing between an attacker and the private key is how expensive this
 * derivation is.
 *
 * @returns {Promise<{wrapped:string, hint:string}>}
 */
export async function wrapIdentityForRecovery(privateKey, participant, code) {
  const clean = normalizeRecoveryCode(code);
  if (!clean) throw new Error('That recovery code is not valid.');
  const kek = await importAesKey(await recoverySalt(participant, clean), false);
  const iv = randomBytes(12);
  const sealed = await aesGcmEncrypt(kek, iv, encodeText(JSON.stringify(await subtle().exportKey('jwk', privateKey))));
  return { wrapped: `${RECOVERY_TAG}.${b64uEncode(iv)}.${b64uEncode(sealed)}`, hint: recoveryHintOf(code) };
}

/** Inverse. Throws when the code is wrong — the caller turns that into "try again". */
export async function unwrapIdentityForRecovery(wrapped, participant, code) {
  const parts = String(wrapped || '').split('.');
  if (parts.length !== 3 || parts[0] !== RECOVERY_TAG) {
    throw new Error('That saved recovery key is not valid.');
  }
  const clean = normalizeRecoveryCode(code);
  if (!clean) throw new Error('That recovery code is not valid.');
  const kek = await importAesKey(await recoverySalt(participant, clean), false);
  const jwk = JSON.parse(decodeText(await aesGcmDecrypt(kek, b64uDecode(parts[1]), b64uDecode(parts[2]))));
  return subtle().importKey('jwk', jwk, ECDH_ARG, true, ['deriveBits', 'deriveKey']);
}
