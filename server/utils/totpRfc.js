'use strict';

/**
 * RFC 6238 (TOTP) over RFC 4226 (HOTP) — written here rather than required.
 *
 * Why not a package: this is the code path that decides whether a second factor
 * is satisfied. The library that did it until now (`speakeasy`) has had no
 * release since 2018, ships a deprecated `initial_time` API, and encodes its
 * secret from a printable-ASCII string whose entropy depends on a symbol table
 * nobody audited. A ~120-line implementation of a published standard, with the
 * standard's own test vectors in `Test File/totp-rfc6238.test.js`, is easier to
 * trust than an unmaintained dependency — and it removes a supply-chain path
 * from the authentication flow.
 *
 * Compatibility is the part that could hurt: seeds enrolled while speakeasy was
 * in charge are still in the database and in members' authenticator apps. Both
 * sides therefore follow the spec exactly — SHA1, 6 digits, 30-second step,
 * counter measured from the UNIX epoch, unpadded RFC 4648 base32 secret — and
 * the golden vectors in that test file were captured from speakeasy itself
 * before it was removed, so a drift here fails a test instead of locking
 * someone out of sign-in.
 */

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_VALUE = new Map([...BASE32_ALPHABET].map((char, index) => [char, index]));
const DIGESTS = new Set(['sha1', 'sha256', 'sha512']);

// The values every authenticator app on earth defaults to, and the values the
// setup endpoint advertises to the client (routes/totp.js TOTP_OPTIONS).
const DEFAULTS = Object.freeze({
  digits: 6,
  step: 30,
  algorithm: 'sha1',
  // 32 random bytes = 256 bits, which encodes to the same 52-character base32
  // string the old generator produced by default. `length` is BYTES here; the
  // library it replaced counted ASCII characters instead.
  secretBytes: 32,
});

// Accepted clock drift, in steps, on each side. Callers ask for 1; the ceiling
// exists because a wider window means more codes are valid at once, which is the
// one knob that directly grows the guessing surface.
const MAX_WINDOW = 3;

/** RFC 4648 base32 without padding; `padding: true` adds the '=' back for URLs. */
function base32Encode(buffer, { padding = false } = {}) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  if (padding) out += '='.repeat((8 - (out.length % 8)) % 8);
  return out;
}

/**
 * Base32 -> bytes, or null when the input is not a base32 key.
 *
 * Padding, case and spaces are forgiven because seeds are copied by hand and
 * apps export them inconsistently. An unrecognised character is NOT forgiven: a
 * hex seed would silently decode to the wrong bytes, and the owner would see
 * "invalid code" forever with nothing in the log to explain it.
 *
 * A leftover group of fewer than 8 bits becomes one more byte, left-aligned and
 * zero-filled. RFC 4648 would call those bits padding and discard them — but a
 * 32-byte key encodes to 52 characters, which is exactly what every seed this
 * system has ever stored looks like, and the library this replaced decoded it to
 * 33 bytes. Dropping the bits here would produce a different HMAC key from the
 * one the user's authenticator app was given, so an enrolment that worked
 * yesterday would fail today with no error anywhere. Compatibility with data
 * already in the database wins over strictness, and the test asserts the round
 * trip so this cannot be "tidied" away by accident.
 */
function base32Decode(input) {
  const text = String(input || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!text) return null;
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const index = BASE32_VALUE.get(char);
    if (index === undefined) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits > 0) bytes.push((value << (8 - bits)) & 0xff);
  return bytes.length ? Buffer.from(bytes) : null;
}

function digitsOf(value) {
  const digits = Number(value == null ? DEFAULTS.digits : value);
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error(`TOTP digits must be an integer from 6 to 8, got ${value}`);
  }
  return digits;
}

function digestOf(value) {
  const algorithm = String(value == null ? DEFAULTS.algorithm : value).toLowerCase();
  if (!DIGESTS.has(algorithm)) throw new Error(`Unsupported TOTP digest "${value}"`);
  return algorithm;
}

function stepOf(value) {
  const step = Number(value == null ? DEFAULTS.step : value);
  if (!Number.isInteger(step) || step < 1 || step > 3600) {
    throw new Error(`TOTP step must be a whole number of seconds, got ${value}`);
  }
  return step;
}

/** The seed as key bytes. `encoding` defaults to base32, which is what is stored. */
function keyBytes({ secret, encoding = 'base32' } = {}) {
  const text = String(secret || '');
  if (!text) return null;
  if (String(encoding).toLowerCase() === 'hex') {
    return /^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0 ? Buffer.from(text, 'hex') : null;
  }
  if (String(encoding).toLowerCase() === 'ascii') return Buffer.from(text, 'utf8');
  return base32Decode(text);
}

/** Time steps since the UNIX epoch — the RFC's T0 is 0, and nothing shifts it. */
function counterOf({ time, step = DEFAULTS.step, counter } = {}) {
  if (counter != null) return Math.floor(Number(counter));
  const millis = time != null ? Number(time) * 1000 : Date.now();
  return Math.floor(millis / (stepOf(step) * 1000));
}

/** RFC 4226 dynamic truncation, with the 64-bit big-endian counter RFC 6238 requires. */
function hotp({ key, counter, digits = DEFAULTS.digits, algorithm = DEFAULTS.algorithm }) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter % 0x100000000, 4);
  const mac = crypto.createHmac(digestOf(algorithm), key).update(buffer).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(truncated % 10 ** digitsOf(digits)).padStart(digitsOf(digits), '0');
}

/** The code for `now` (or for the supplied time/counter) — what an app would show. */
function totp(options = {}) {
  const key = keyBytes(options);
  if (!key) throw new Error('TOTP needs a decodable secret');
  return hotp({
    key,
    counter: counterOf(options),
    digits: options.digits,
    algorithm: options.algorithm,
  });
}

/**
 * Does `token` match the seed at `now`, within `window` steps either side?
 *
 * False rather than throwing on a bad seed or a junk token: this answers a
 * sign-in request, and a 500 is both an outage and an oracle. Every candidate
 * counter is compared even after a hit, so the work done does not depend on
 * where the match was.
 */
function verify(options = {}) {
  const digits = digitsOf(options.digits);
  const token = String(options.token == null ? '' : options.token).trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(token)) return false;
  const key = keyBytes(options);
  if (!key) return false;

  const step = stepOf(options.step);
  const window = Math.max(0, Math.min(MAX_WINDOW, Math.trunc(Number(options.window) || 0)));
  const center = counterOf({ ...options, step });
  const candidate = Buffer.from(token, 'utf8');

  let matched = false;
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = Buffer.from(hotp({
      key,
      counter: center + offset,
      digits,
      algorithm: options.algorithm,
    }), 'utf8');
    if (expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate)) matched = true;
  }
  return matched;
}

/**
 * A fresh seed, plus the otpauth URL a QR of it encodes.
 *
 * `length` is the key size in BYTES (default 32). The label keeps the
 * "Issuer (account)" shape the previous generator produced, and the issuer is
 * also sent as its own parameter, which is how current apps are told which
 * issuer a label belongs to.
 */
function generateSecret(options = {}) {
  const bytes = Number(options.length == null ? DEFAULTS.secretBytes : options.length);
  if (!Number.isInteger(bytes) || bytes < 20 || bytes > 127) {
    throw new Error('TOTP secret length must be a whole number of bytes from 20 to 127');
  }
  const raw = crypto.randomBytes(bytes);
  const base32 = base32Encode(raw);
  const label = encodeURIComponent(String(options.name || 'SuppliWise'));
  // Unpadded, exactly as the previous generator wrote it: a scanned QR decodes
  // either way, and a URL that changes shape changes what an app stores.
  const query = [`secret=${base32}`];
  if (options.issuer) query.push(`issuer=${encodeURIComponent(String(options.issuer))}`);
  return { base32, otpauth_url: `otpauth://totp/${label}?${query.join('&')}` };
}

module.exports = { BASE32_ALPHABET, DEFAULTS, MAX_WINDOW, base32Decode, base32Encode, generateSecret, hotp, totp, verify };
