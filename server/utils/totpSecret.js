/**
 * Per-user TOTP secret storage — the one place that knows how a user's seed is
 * persisted, so encryption and migration cannot be half-applied.
 *
 * WHAT CHANGED
 * ------------
 * `User.twoFactorSecret` held the raw base32 seed in plaintext. That field is
 * still here, still `select: false`, still honoured on read — but it is now a
 * LEGACY field. New writes go to `User.twoFactorSecretEnc` (an AES-256-GCM
 * envelope, see utils/secretBox.js) and the plaintext field is left empty.
 *
 * Why keep reading the old field at all instead of forcing a migration script:
 * a bulk migration has to decrypt nothing (it only has to copy), but it does
 * have to run against production while people are signing in, and the
 * alternative to an on-read upgrade is an account that suddenly cannot reach
 * its own second factor. So migration is LAZY and IDEMPOTENT — the first time
 * a secret is needed, it is upgraded in place, on the same code path that just
 * used it. Nothing has to remember to run it, and an account that never signs
 * in costs nothing.
 *
 * This mirrors the app's existing "legacy bcrypt upgrades to argon2id on
 * successful verification" pattern (utils/password.js), for the same reason:
 * a credential format change should not require the user to do anything.
 *
 * `readSecret` is the only thing routes should call. It never returns the
 * envelope, never logs, and never distinguishes "no secret" from "secret could
 * not be decrypted" in a way the caller could turn into an oracle.
 */
const { encrypt, decrypt, isEnvelope } = require('./secretBox');

/** Fields a caller must ask for explicitly (both are `select: false`). */
const SECRET_FIELDS = '+twoFactorSecret +twoFactorSecretEnc';

/**
 * The account's TOTP seed as plaintext, for `speakeasy` only.
 *
 * Returns '' when there is no usable secret — including when the stored value
 * exists but will not decrypt (wrong key, tampered ciphertext). Collapsing
 * those into one answer is deliberate: a caller that can tell "no secret" from
 * "broken secret" can be used as an oracle by anyone who can drive the setup
 * route, and the repair for both is the same (re-run setup).
 *
 * `user` may be a hydrated document or a lean projection — only the two
 * string fields are read.
 */
function readSecret(user) {
  if (!user) return '';
  const encrypted = user.twoFactorSecretEnc;
  if (encrypted) {
    const opened = decrypt(encrypted);
    if (opened) return opened;
    // A non-empty envelope that will not open means the key is wrong. Falling
    // back to the legacy field would silently downgrade to a DIFFERENT secret
    // if one happens to linger, which is worse than reporting none.
    return '';
  }
  return user.twoFactorSecret || '';
}

/**
 * True when the document still carries an un-migrated plaintext seed.
 *
 * Cheap on purpose: it reads fields only, so it is safe to call on a lean
 * projection and on the hot sign-in path.
 */
function needsMigration(user) {
  return Boolean(user && user.twoFactorSecret && !user.twoFactorSecretEnc);
}

/**
 * Move a legacy plaintext seed into the encrypted field.
 *
 * Mutates the document in memory and returns true when it changed anything, so
 * the caller decides when to save. It is intentionally NOT async and does not
 * call `save()` itself: the callers are already inside a request that saves the
 * document (or deliberately does not), and a second write from a helper is how
 * a "best-effort upgrade" turns into a lost update.
 *
 * Failures are swallowed and reported as "no change" — a seed that cannot be
 * re-encrypted keeps working on the legacy path, which is strictly better than
 * an account locked out by a storage problem.
 */
function migrateInPlace(user) {
  if (!needsMigration(user)) return false;
  try {
    const sealed = encrypt(user.twoFactorSecret);
    if (!sealed) return false;
    user.twoFactorSecretEnc = sealed;
    user.twoFactorSecret = '';
    return true;
  } catch {
    return false;
  }
}

/**
 * Store a NEW seed, encrypted. Always clears the legacy field, so switching an
 * account to a new authenticator cannot leave the old plaintext seed behind —
 * which is the single most important property here: replacing an authenticator
 * must genuinely forget the old one.
 */
function writeSecret(user, secret) {
  const value = secret == null ? '' : String(secret);
  if (!value) {
    clearSecret(user);
    return;
  }
  user.twoFactorSecretEnc = encrypt(value);
  user.twoFactorSecret = '';
}

/** Forget the seed entirely. Used by disable, and by switching away from TOTP. */
function clearSecret(user) {
  if (!user) return;
  user.twoFactorSecretEnc = '';
  user.twoFactorSecret = '';
}

/**
 * What the security dashboard may show about an account's authenticator.
 *
 * Never includes the seed or the envelope — only the three facts a user needs
 * to tell "set up", "paired but not activated" and "active" apart.
 */
function describe(user) {
  const has = Boolean(readSecret(user));
  return {
    configured: has,
    // A seed with twoFactorEnabled off is a half-finished setup: the secret was
    // generated but never proved with a code. Surfaced so the UI can offer
    // "finish setup" instead of pretending there is no authenticator at all.
    pendingSetup: has && user.twoFactorEnabled !== true,
    encryptedAtRest: Boolean(user && user.twoFactorSecretEnc),
  };
}

module.exports = {
  SECRET_FIELDS,
  readSecret,
  writeSecret,
  clearSecret,
  migrateInPlace,
  needsMigration,
  describe,
};
