/**
 * How an ADMINISTRATOR's TOTP seed is persisted — the one place that knows, so
 * encryption cannot be half-applied across the four sites that touch it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `AdminAccount.totpSecret` held the raw base32 seed in plaintext, and an
 * administrator's seed is worth more than a member's: it is the second factor
 * on the account that can reset passwords, read support transcripts and change
 * plan entitlements. A database read alone (`select: false` only hides the field
 * from ordinary queries — it is not a protection against anyone who can read the
 * collection) handed over everything an attacker needed, permanently.
 *
 * Members already moved to AES-256-GCM envelopes in utils/totpSecret.js. This is
 * the same storage, same key material (utils/secretBox), same lazy-migration
 * policy, applied to the admin collection — with the field names this schema
 * actually uses.
 *
 * WHY MIGRATION IS LAZY RATHER THAN A SCRIPT
 * ------------------------------------------
 * The same reason as for members: a bulk migration has to run against production
 * while administrators are signing in, and the alternative to upgrading on first
 * use is an operator who suddenly cannot reach their own second factor. So the
 * first read that needs the seed seals it in place, and an account that never
 * signs in costs nothing. `sealAccount()` covers the other direction — the boot
 * seeder writes envelopes, so a fresh install never stores plaintext at all.
 *
 * Nothing here logs a seed, an envelope, or a key.
 */
const secretBox = require('./secretBox');

/** Fields a caller must ask for explicitly (both are `select: false`). */
const SECRET_FIELDS = '+totpSecret +totpSecretEnc';

/**
 * The seed in plaintext, for the TOTP verifier only — '' when there is none or it
 * will not open. Collapsing those two is deliberate (same reasoning as
 * utils/totpSecret.readSecret: telling them apart is a decryption oracle for
 * anything that can drive a setup route).
 */
function readSeed(account) {
  if (!account) return '';
  const sealed = account.totpSecretEnc;
  if (sealed) return secretBox.decrypt(sealed) || '';
  return account.totpSecret || '';
}

/** True when the document still carries an un-migrated plaintext seed. */
function needsMigration(account) {
  return Boolean(account && account.totpSecret && !account.totpSecretEnc);
}

/**
 * Move a plaintext seed into the sealed field, in memory. Returns true when it
 * changed anything; the caller decides when to save. A seed that cannot be
 * re-encrypted keeps working on the legacy path — a storage problem must never
 * lock an operator out of their own account.
 */
function migrateInPlace(account) {
  if (!needsMigration(account)) return false;
  try {
    const sealed = secretBox.encrypt(account.totpSecret);
    if (!sealed) return false;
    account.totpSecretEnc = sealed;
    account.totpSecret = '';
    return true;
  } catch {
    return false;
  }
}

/** Store a NEW seed, sealed, and forget the old one. */
function writeSeed(account, secret) {
  const value = secret == null ? '' : String(secret);
  if (!value) {
    clearSeed(account);
    return;
  }
  account.totpSecretEnc = secretBox.encrypt(value);
  account.totpSecret = '';
}

function clearSeed(account) {
  if (!account) return;
  account.totpSecretEnc = '';
  account.totpSecret = '';
}

/**
 * A plain object ready to be written to MongoDB from an environment descriptor
 * `{ alias, passwordHash, totpSecret }` — the plaintext seed becomes a sealed
 * envelope, and the plaintext field is written empty so a document created by
 * the boot seeder never carries a raw seed at all.
 */
function sealAccount(account) {
  const { totpSecret, ...rest } = account || {};
  return { ...rest, totpSecret: '', totpSecretEnc: secretBox.encrypt(totpSecret) };
}

/**
 * What the dashboard may report about how seeds are stored. Counts and shape
 * only — never a seed, an envelope, or a key.
 */
function storageState(account) {
  return {
    sealed: Boolean(account && account.totpSecretEnc),
    legacyPlaintext: needsMigration(account),
    usable: Boolean(readSeed(account)),
  };
}

module.exports = {
  SECRET_FIELDS,
  readSeed,
  writeSeed,
  clearSeed,
  migrateInPlace,
  needsMigration,
  sealAccount,
  storageState,
};
