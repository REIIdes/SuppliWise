'use strict';
/**
 * Reading AND writing the admin credentials in server/.env.
 *
 * The two halves are the same problem seen from opposite ends. Reading parses
 * the packed `ADMIN_ACCOUNTS` value (whose delimiter cannot be a bare comma,
 * because argon2id hashes contain one). Writing exists because that .env value
 * is a standing copy of every admin's password: if the copy is not updated when
 * the owner changes their password, the boot seeder can resurrect the
 * hand-off credential the next time an account document is missing.
 *
 * WHY THE PARSER EXISTS
 * ---------------------
 * `ADMIN_ACCOUNTS` holds `alias|passwordHash|totpSecret` entries joined by
 * commas. The obvious parse is `value.split(',')`, and that is what both the
 * boot seeder and the security panel used to do.
 *
 * It silently corrupts any argon2id hash. The encoded form is
 *
 *     $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
 *
 * whose parameter block is comma-separated, so a naive split cuts a single
 * account into three fragments, the alias/hash/secret fields land in the wrong
 * places, and the entry is dropped as malformed. bcrypt hashes
 * (`$2a$12$<22-char salt><31-char hash>`) contain no commas, which is why the
 * bug only appears once a password is hashed with the current default — and
 * the failure is silent rather than loud: boot logs a smaller admin count and
 * those accounts are simply missing until the database is rebuilt.
 *
 * The fix is to split on a comma that *starts an entry* rather than on every
 * comma. An entry begins with an alias followed by the field separator, and an
 * alias is plain text: it contains no comma, no pipe, and - decisively - no `$`.
 * Every comma inside an argon2id hash sits in the parameter block
 * `m=...,t=...,p=...`, which is always followed by `$<salt>$<hash>`, so a comma
 * whose run up to the next pipe contains a `$` is inside a hash, not between
 * entries.
 *
 * The `$` exclusion is load-bearing, not decoration. An earlier version of this
 * rule read `,(?=[^,|]*\|)` - "a comma, then a run with no comma or pipe, then a
 * pipe" - which still matched the comma after `t=2`, because `p=1$<salt>$<hash>`
 * does reach the pipe. That version passed on the hand-written sample hashes in
 * the unit test and failed on a real `hashPassword()` result, which is why the
 * suite hashes a genuine value rather than trusting a literal.
 *
 * ONE definition, because the alternative is what this file exists to prevent:
 * the parse lived inline in `index.js` (which seeds the accounts at boot) and
 * again in `routes/admin.js` (which reports whether the configured hashes are
 * sound). Two copies of a delimiter rule that is easy to get subtly wrong is
 * how the panel ends up certifying a config the seeder cannot read.
 */

/**
 * Split the comma-joined value into entries without cutting inside a hash.
 *
 * A separator is a comma followed by a run of characters containing none of
 * `,`, `$` or `|`, and then a pipe.
 */
const ENTRY_SEPARATOR = /,(?=[^,$|]*\|)/;

/** Absolute path to the server's .env — same file utils/envFile.js reads. */
const fs = require('fs');
const path = require('path');
const ENV_PATH = path.join(__dirname, '..', '.env');

/**
 * Parse a raw `ADMIN_ACCOUNTS` value into admin account descriptors.
 *
 * Entries missing any of the three fields are skipped rather than inserted
 * half-formed: a partially-parsed entry would seed an account with a truncated
 * hash that can never be verified, which is a worse outcome than not seeding
 * it (the operator can see the missing account and fix the config).
 *
 * @param {string|undefined|null} raw the environment value
 * @returns {Array<{alias: string, passwordHash: string, totpSecret: string}>}
 */
function parseAdminAccounts(raw) {
  const value = String(raw || '');
  if (!value.trim()) return [];

  const accounts = [];
  for (const entry of value.split(ENTRY_SEPARATOR)) {
    const parts = entry.split('|').map((field) => field.trim());
    if (parts.length < 3) continue;
    const [alias, passwordHash, totpSecret] = parts;
    if (alias && passwordHash && totpSecret) accounts.push({ alias, passwordHash, totpSecret });
  }
  return accounts;
}

/**
 * Rewrite one admin's password hash inside server/.env.
 *
 * WHY THE APP WRITES ITS OWN CONFIG
 * ---------------------------------
 * .env is the source of truth the boot seeder falls back to. index.js inserts
 * any account whose document is MISSING ($setOnInsert), which is what makes a
 * fresh clone self-heal. That is also the hazard: a password chosen through the
 * admin UI lived only in MongoDB, so the hand-off hash in .env survived it.
 *
 * The consequence is that the temporary password was never actually spent. As
 * soon as the document went away — a wiped collection, a fresh clone, a restored
 * backup, a mistyped alias — the seeder recreated the account straight from
 * .env, which meant:
 *
 *   • the hand-off password worked again, and
 *   • mustChangePassword came back false, because the schema default is false,
 *     so nothing prompted the owner to replace it.
 *
 * i.e. the account was fully usable on the temporary password with no prompt at
 * all. Verified by deleting one document and re-running the seeder.
 *
 * So the two stores have to move together. This is deliberately best-effort and
 * never throws: .env can be read-only (a container mount, a permissions
 * problem), and failing a password change because the config could not be
 * updated would be worse than the divergence it prevents. The caller logs when
 * this does not land, and `mustChangePassword` is still cleared, so the account
 * is correct in the database either way.
 *
 * @param {string} alias
 * @param {string} passwordHash argon2id/bcrypt hash, already computed
 * @param {NodeJS.ProcessEnv} [env] injectable for tests
 * @returns {{written: boolean, reason?: string, replaced: number}}
 */
function persistAdminPasswordToEnv(alias, passwordHash, env = process.env) {
  if (!alias || !passwordHash) return { written: false, reason: 'missing alias or hash', replaced: 0 };
  let raw;
  try {
    raw = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (error) {
    return { written: false, reason: `cannot read ${ENV_PATH}: ${error.message}`, replaced: 0 };
  }

  const lines = raw.split(/\r?\n/);
  let replaced = 0;
  let sawPackedList = false;

  for (let i = 0; i < lines.length; i++) {
    // The legacy single-account trio owns ADMIN_ALIAS.
    const legacyAlias = String(env.ADMIN_ALIAS || '').trim();
    const legacyHashLine = /^(\s*ADMIN_PASSWORD_HASH\s*=\s*)(.*)$/.exec(lines[i]);
    if (legacyHashLine && legacyAlias && alias === legacyAlias) {
      lines[i] = legacyHashLine[1] + passwordHash;
      replaced++;
      continue;
    }
    if (/^\s*ADMIN_ACCOUNTS\s*=/.test(lines[i])) {
      sawPackedList = true;
      const eq = lines[i].indexOf('=');
      const head = lines[i].slice(0, eq + 1);
      const list = lines[i].slice(eq + 1);
      // Split with the SAME comma-aware rule the parser uses, never a bare
      // split(','). An argon2id hash's parameter block is comma-separated
      // (m=19456,t=2,p=1), so a naive split cuts every entry in three and the
      // rewrite then writes a mangled list — which would look like this worked
      // while quietly corrupting the neighbouring accounts' credentials.
      lines[i] = head + list.split(ENTRY_SEPARATOR).map((entry) => {
        const parts = entry.split('|').map((field) => field.trim());
        if (parts[0] !== alias) return entry;
        parts[1] = passwordHash;                  // field 2 = passwordHash
        replaced++;
        return parts.join('|');
      }).join(',');
    }
  }

  if (replaced === 0) {
    return {
      written: false,
      reason: sawPackedList
        ? `alias "${alias}" is not in .env, so there is nothing to update`
        : `alias "${alias}" is not in .env (not the ADMIN_ALIAS, and no ADMIN_ACCOUNTS entry)`,
    };
  }

  try {
    fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
  } catch (error) {
    return { written: false, reason: `cannot write ${ENV_PATH}: ${error.message}`, replaced };
  }
  return { written: true, replaced };
}

/**
 * Shape check for an address. Deliberately not RFC-complete: it rejects the
 * mistakes an operator can actually make in .env (missing `@`, missing domain,
 * stray whitespace, a pasted comment) and nothing subtler.
 */
const EMAIL_SHAPE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/**
 * Parse a raw `ADMIN_EMAILS` value into `{alias, email}` pairs.
 *
 * WHY A PLAIN `split(',')` IS CORRECT HERE — AND ONLY HERE
 * -------------------------------------------------------
 * The sibling `parseAdminAccounts` above needs a regex delimiter because an
 * argon2id hash contains its own commas (`m=19456,t=2,p=1`). This value holds
 * nothing but `alias=address` pairs: an alias is plain text and an email
 * address has no comma in its grammar (RFC 5322 treats `,` as a special
 * character, and it is illegal unquoted in a dot-atom local part or a domain).
 * So the delimiter cannot be ambiguous here, and reusing `ENTRY_SEPARATOR` for
 * it would be actively wrong — that pattern requires a `|` ahead of the comma,
 * and no address contains one, so it would match nothing and silently yield a
 * single malformed entry.
 *
 * Entries that are not `alias=address`, or whose address fails the shape
 * check, are skipped rather than delivered to half-formed. Same rule as the
 * account parser: a visible missing admin is fixable, a mail sent to a
 * truncated address is not.
 *
 * @param {string|undefined|null} raw the environment value
 * @returns {Array<{alias: string, email: string}>}
 */
function parseAdminEmails(raw) {
  const value = String(raw || '');
  if (!value.trim()) return [];

  const accounts = [];
  for (const entry of value.split(',')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const alias = entry.slice(0, eq).trim();
    // `slice(eq + 1)`, not `split('=')[1]`: an address may legally contain `=`
    // in its quoted local part, and the alias — not the address — is the field
    // that carries the first delimiter.
    const email = entry.slice(eq + 1).trim().toLowerCase();
    if (!alias || !EMAIL_SHAPE.test(email)) continue;
    accounts.push({ alias, email });
  }
  return accounts;
}

/**
 * Every admin address the environment defines, de-duplicated by alias and then
 * by address, with a stable order.
 *
 * De-duplication matters because the value is hand-edited in .env and a
 * repeated pair would otherwise send the same admin two copies of a security
 * notice — which reads to the recipient as though something alarming happened
 * twice. Last value wins for a repeated alias, matching how a duplicated
 * environment variable behaves elsewhere in the boot sequence.
 *
 * @param {NodeJS.ProcessEnv} [env] injectable for tests
 * @returns {Array<{alias: string, email: string}>}
 */
function configuredAdminEmails(env = process.env) {
  const byAlias = new Map();
  for (const { alias, email } of parseAdminEmails(env.ADMIN_EMAILS)) {
    byAlias.set(alias, { alias, email });
  }
  const seenAddresses = new Set();
  const unique = [];
  for (const entry of byAlias.values()) {
    // Same address under two aliases is a shared mailbox, not two people.
    // Dropping the duplicate keeps the send honest about how many people were
    // actually reached; the caller reports the real recipient count.
    if (seenAddresses.has(entry.email)) continue;
    seenAddresses.add(entry.email);
    unique.push(entry);
  }
  return unique;
}

/**
 * Aliases that are real admin accounts but have no usable address in
 * ADMIN_EMAILS.
 *
 * WHY THIS IS NOT DERIVABLE FROM THE OTHER TWO
 * --------------------------------------------
 * `configuredAdminAccounts` and `configuredAdminEmails` are independent lists,
 * and nothing else in the codebase compares them. Without this, an operator who
 * adds a fifth admin account and forgets the matching `alias=address` entry
 * gets a send that reports "4 delivered" and no indication that a fifth
 * person exists who was never told anything. The gap between the two lists is
 * the actual failure mode, so it is named rather than left for someone to spot
 * by eye.
 *
 * @param {NodeJS.ProcessEnv} [env] injectable for tests
 * @returns {string[]} aliases, in account order
 */
function adminAccountsMissingEmail(env = process.env) {
  const withEmail = new Set(configuredAdminEmails(env).map((entry) => entry.alias));
  return configuredAdminAccounts(env)
    .map((account) => account.alias)
    .filter((alias) => !withEmail.has(alias));
}

/**
 * Every admin descriptor the environment defines: the legacy single-account
 * trio (`ADMIN_ALIAS` / `ADMIN_PASSWORD_HASH` / `ADMIN_TOTP_SECRET`) plus the
 * packed list, with the legacy entry dropped if `ADMIN_ACCOUNTS` already
 * defines an account of the same alias.
 *
 * @param {NodeJS.ProcessEnv} [env] injectable for tests
 */
function configuredAdminAccounts(env = process.env) {
  const list = parseAdminAccounts(env.ADMIN_ACCOUNTS);

  const legacyAlias = String(env.ADMIN_ALIAS || '').trim();
  const legacyHash = String(env.ADMIN_PASSWORD_HASH || '').trim();
  const legacySecret = String(env.ADMIN_TOTP_SECRET || '').trim();
  const legacyComplete = legacyAlias && legacyHash && legacySecret;

  if (!legacyComplete) return list;
  if (list.some((account) => account.alias === legacyAlias)) return list;
  return [{ alias: legacyAlias, passwordHash: legacyHash, totpSecret: legacySecret }, ...list];
}

module.exports = {
  parseAdminAccounts,
  configuredAdminAccounts,
  persistAdminPasswordToEnv,
  parseAdminEmails,
  configuredAdminEmails,
  adminAccountsMissingEmail,
  ENTRY_SEPARATOR,
  ENV_PATH,
};
