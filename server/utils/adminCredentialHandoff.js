'use strict';
/**
 * Fan-out of the one-time administrator credential hand-off.
 *
 * WHY THIS IS A SEPARATE MODULE FROM adminCredentialNotice.js
 * ---------------------------------------------------------
 * The two sends look similar and are opposites, and merging them is the mistake
 * this file exists to prevent:
 *
 *   adminCredentialNotice.js    → "your stored credentials were upgraded".
 *                                 Carries NO secret. Runs on a button, on a
 *                                 schedule, whenever an operator thinks of it.
 *   adminCredentialHandoff.js   → "here are your alias, password and
 *                                 authenticator key". Carries live secrets.
 *                                 Must be a deliberate, one-off act.
 *
 * AdminNames.md records that this project's real TOTP seeds were committed to a
 * public repository. The fix for that was to keep every recurring channel
 * secret-free. So this module does not extend the update notice, does not add
 * an option to it, and does not read from it: the update notice stays exactly as
 * it is, and the one-time path is a separate caller of the separate sender that
 * was always allowed to carry secrets.
 *
 * ONE DEFINITION, BECAUSE TWO COPIES IS THE BUG
 * ---------------------------------------------
 * Reachable from the console button (`POST /api/admin/admins/credential-handoff`)
 * and from `npm run send-admin-credentials`. Same reasoning, and same failure
 * mode, as adminCredentialNotice.js: two copies of the recipient list drift, the
 * button reports "sent to 6" while the script reports 4, and nobody notices
 * until an administrator says they never got their password. The decisions —
 * who the recipients are, which alias maps to which secret, what counts as
 * skippable, what the caller is told — live here. Callers only choose whether
 * to run it.
 *
 * WHY PASSWORDS ARE AN INPUT AND NOT A LOOKUP
 * -------------------------------------------
 * .env stores `passwordHash` only, and it is a one-way hash (argon2id). The
 * plaintext is not on disk anywhere and cannot be recovered from it — asking this
 * module to "read the password" for an alias is not a missing feature, it is
 * information that does not exist. So the operator supplies the passwords they
 * know, and this module's job is to pair each one with the right alias and the
 * right authenticator key, and to be honest about any alias where that pairing
 * could not be completed.
 *
 * The passwords arrive as a plain object keyed by alias, never as a packed
 * string. A password may contain `,`, `|` and `=`, so any delimiter-based format
 * (like the `ADMIN_ACCOUNTS` value) is ambiguous the moment a real password is
 * used — the same class of bug as the argon2id comma in adminAccounts.js. An
 * object has no delimiter, so there is nothing to get wrong.
 *
 * NO DATABASE REQUIRED
 * --------------------
 * The script runs this from a terminal where no connection is open, and the
 * route has one already. The console log below is the record for a script run;
 * the route writes its own audit row. Neither writes a password, a hash or a
 * seed to a log, a row, or a response — only aliases, masked addresses and
 * counts.
 */

/**
 * Gap between sends.
 *
 * Deliberately its own constant rather than imported from
 * adminCredentialNotice.js: the two sends are independent (see the header), and
 * the reason these are spaced further apart is that these messages are
 * materially bigger — a password and a base32 seed add weight — and go to six
 * people at once. Tying the two together would mean a future change to the
 * notice's pacing silently changed this one too.
 */
const HANDOFF_GAP_MS = 250;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Build an alias → account lookup that is exact-first and forgiving-second.
 *
 * An operator typing `admindevs=...` on a command line has not made a security
 * error, they have made a typing error, and refusing to match would make the
 * hand-off silently skip that person. Exact match always wins, so a hypothetical
 * .env holding both `AdminDevs` and `admindevs` as two separate accounts still
 * resolves each one to itself rather than both to whichever was seen first.
 *
 * @param {Array<{alias: string}>} accounts
 * @returns {{exact: Map<string, object>, lowered: Map<string, object>}}
 */
function indexAccountsByAlias(accounts) {
  const exact = new Map();
  const lowered = new Map();
  for (const account of accounts) {
    const alias = String(account.alias || '').trim();
    if (!alias) continue;
    if (!exact.has(alias)) exact.set(alias, account);
    const key = alias.toLowerCase();
    if (!lowered.has(key)) lowered.set(key, account);
  }
  return { exact, lowered };
}

/**
 * Normalise the caller-supplied password map.
 *
 * Accepts a plain object, or a list of `[alias, password]` pairs / `{alias,
 * password}` objects, because the two callers build it differently (the route
 * receives JSON, the script accumulates repeated `--password alias=value`
 * flags) and both must end up as the same thing.
 *
 * An empty or whitespace-only password is DROPPED, not kept as `''`. That is the
 * difference between "the operator did not supply this one" and "the operator
 * supplied an empty one", and the first is what the report needs to say — an
 * empty value would otherwise be passed to the sender, which rejects it, and
 * the alias would show up as a send failure rather than as an unsupplied
 * password. The failure is honest either way; this way it is also actionable.
 *
 * @param {object|Array} input
 * @returns {Map<string, string>} alias → password
 */
function normalisePasswords(input) {
  const out = new Map();
  const put = (rawAlias, rawPassword) => {
    const alias = String(rawAlias || '').trim();
    const password = typeof rawPassword === 'string' ? rawPassword : String(rawPassword == null ? '' : rawPassword);
    if (!alias || !password.trim()) return;
    out.set(alias, password);
  };

  if (Array.isArray(input)) {
    for (const entry of input) {
      if (Array.isArray(entry)) put(entry[0], entry[1]);
      else if (entry && typeof entry === 'object') put(entry.alias, entry.password);
    }
    return out;
  }
  if (input && typeof input === 'object') {
    for (const [alias, password] of Object.entries(input)) put(alias, password);
  }
  return out;
}

/** Mirrors maskEmail in utils/email.js, so no log line ever holds a full address. */
function maskEmail(value) {
  const email = String(value || '').trim();
  const at = email.indexOf('@');
  if (at <= 0) return '[invalid]';
  return `${email[0]}***@${email.slice(at + 1)}`;
}

/**
 * Email every administrator their own alias, password and authenticator key.
 *
 * PARTIAL SUCCESS IS SUCCESS
 * -------------------------
 * Same rule as the update notice, and for a sharper reason here: the person who
 * is NOT reached is the one who cannot sign in. A batch that aborted on the
 * first SMTP failure would reliably leave the later aliases — quite possibly
 * the person who pressed the button — with no password at all. So every
 * recipient is attempted, failures are collected per address, and the caller
 * gets a report naming exactly who was reached.
 *
 * Sends are sequential, not concurrent. A burst of six simultaneous SMTP
 * handshakes from a freshly-minted credential mail is how a provider starts
 * silently dropping mail, and a dropped hand-off is indistinguishable from a
 * successful one at the provider.
 *
 * @param {object}  [options]
 * @param {NodeJS.ProcessEnv} [options.env] injectable for tests
 * @param {object|Array} [options.passwords] alias → plaintext password
 * @param {string}  [options.description] overrides the notice wording
 * @param {string}  [options.triggeredBy] alias of the admin who asked, for logs
 * @returns {Promise<{
 *   ok: boolean,
 *   description: string,
 *   recipients: number,
 *   delivered: Array<{alias: string, email: string}>,
 *   failed: Array<{alias: string, email: string, reason: string}>,
 *   missingEmail: string[],
 *   missingSecret: string[],
 *   missingPassword: string[],
 *   unusedPasswords: string[],
 *   unconfigured: boolean,
 * }>}
 */
async function handoffAdminCredentials(options = {}) {
  // Required inside the function, not at module scope, so a test can patch the
  // module object — the technique admin-credential-notice.test.js already uses
  // for the email module — before this runs.
  const { configuredAdminEmails, configuredAdminAccounts, adminAccountsMissingEmail } = require('./adminAccounts');
  const { sendAdminCredentialsEmail, DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION } = require('./email');

  const env = options.env || process.env;
  const description = String(options.description || '').trim().slice(0, 400)
    || DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION;
  const triggeredBy = String(options.triggeredBy || '').trim().slice(0, 64) || 'operator';

  const recipients = configuredAdminEmails(env);
  const accounts = indexAccountsByAlias(configuredAdminAccounts(env));
  const passwords = normalisePasswords(options.passwords);

  const report = {
    ok: false,
    description,
    recipients: recipients.length,
    delivered: [],
    failed: [],
    // An admin who exists as an account but has no address: never mailed at all.
    missingEmail: adminAccountsMissingEmail(env),
    // Has an address but no authenticator key in .env. A hand-off without the
    // seed is a half-message that leaves the recipient unable to finish signing
    // in, so it is refused outright rather than sent incomplete.
    missingSecret: [],
    // Has an address and a seed, but the operator did not supply a password.
    missingPassword: [],
    // A password was supplied for an alias that is not going to be mailed —
    // almost always a typo in a `--password` flag. Silently ignoring it would
    // read as "that one was emailed" when in fact that person got nothing.
    unusedPasswords: [],
    unconfigured: recipients.length === 0,
  };

  if (recipients.length === 0) {
    console.warn(
      `[admin-handoff] No ADMIN_EMAILS entries matched a usable address — nothing sent `
      + `(triggered by ${triggeredBy}).`
    );
    return report;
  }

  // Plan before sending. Building the list first means the report can state
  // every skippable alias up front, and — more importantly — a fully-formed
  // recipient is guaranteed to have BOTH halves of the message before the first
  // SMTP connection opens. A half-built message is discovered by the recipient.
  const plan = [];
  const consumed = new Set();
  for (const recipient of recipients) {
    const alias = String(recipient.alias || '').trim();
    const account = accounts.exact.get(alias) || accounts.lowered.get(alias.toLowerCase());

    if (!account || !String(account.totpSecret || '').trim()) {
      report.missingSecret.push(alias);
      continue;
    }
    const password = passwords.get(alias) ?? passwords.get(alias.toLowerCase());
    if (password === undefined) {
      report.missingPassword.push(alias);
      continue;
    }
    consumed.add(alias);
    consumed.add(alias.toLowerCase());
    plan.push({ alias, email: recipient.email, password, totpSecret: String(account.totpSecret).trim() });
  }

  report.unusedPasswords = [...passwords.keys()].filter((alias) => !consumed.has(alias) && !consumed.has(alias.toLowerCase()));

  console.log(
    `[admin-handoff] Sending credentials to ${plan.length} of ${recipients.length} administrator(s) `
    + `(triggered by ${triggeredBy}).`
  );
  for (const note of [
    ['no authenticator key in .env', report.missingSecret],
    ['no password supplied', report.missingPassword],
    ['no address on file', report.missingEmail],
  ]) {
    if (note[1].length) console.warn(`[admin-handoff] Skipped, ${note[0]}: ${note[1].join(', ')}`);
  }
  if (report.unusedPasswords.length) {
    console.warn(
      `[admin-handoff] Password supplied for an alias that is not being mailed (typo?): `
      + report.unusedPasswords.join(', ')
    );
  }

  for (const [index, entry] of plan.entries()) {
    if (index > 0) await sleep(HANDOFF_GAP_MS);
    let sent = false;
    try {
      sent = await sendAdminCredentialsEmail(entry.email, {
        alias: entry.alias,
        password: entry.password,
        totpSecret: entry.totpSecret,
        description,
      });
    } catch (error) {
      // sendAdminCredentialsEmail is documented never to throw, but this is a
      // loop over a network call; a defensive catch keeps one recipient from
      // taking down the batch. The message is logged, the password is not.
      console.error(`[admin-handoff] ${entry.alias} raised: ${error.message}`);
    }
    if (sent) {
      report.delivered.push({ alias: entry.alias, email: entry.email });
    } else {
      report.failed.push({ alias: entry.alias, email: entry.email, reason: 'not accepted by the mail service' });
    }
  }

  // ok means: everybody we set out to reach was reached. An alias that was
  // skipped for a missing password is NOT a failure of this send — it was never
  // part of it — so it does not flip ok, but it is reported separately above so
  // it cannot be mistaken for success.
  report.ok = report.failed.length === 0;
  console.log(
    `[admin-handoff] Done: ${report.delivered.length} delivered, ${report.failed.length} failed, `
    + `${report.missingPassword.length} without a password, ${report.missingSecret.length} without a key, `
    + `${report.missingEmail.length} without an address.`
  );
  return report;
}

module.exports = {
  handoffAdminCredentials,
  // Exported for the unit tests, which assert the normalising rules directly
  // rather than inferring them through a send that needs a transport.
  normalisePasswords,
  indexAccountsByAlias,
  maskEmail,
  HANDOFF_GAP_MS,
};
