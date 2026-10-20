'use strict';
/**
 * One-shot delivery of every administrator's recoverable credentials to the
 * address configured for them in server/.env (`ADMIN_EMAILS`).
 *
 * WHAT "RECOVERABLE" MEANS HERE — AND WHY THERE IS NO PASSWORD
 * -----------------------------------------------------------
 * An admin's password exists only as an argon2id hash (`passwordHash`, in .env
 * and in the AdminAccount document). It is one-way: no code in this repository
 * can print it, and a module that claimed to would be inventing a value. So the
 * mail carries the two things that genuinely are recoverable — the sign-in alias
 * and the authenticator seed — and says plainly why the password is absent.
 *
 * WHY A MODULE OF ITS OWN
 * ----------------------
 * The recurring, secret-free channels in utils/email.js must stay secret-free;
 * that is the standing rule for anything scheduled or automatic. This is the
 * opposite: a deliberate, single act driven by an authenticated admin pressing a
 * button. Keeping it separate means the recurring paths cannot drift into
 * carrying a key "just this once".
 *
 * PARTIAL SUCCESS IS SUCCESS
 * --------------------------
 * Every recipient is attempted even after a failure, and the caller gets a
 * per-address report. Aborting on the first SMTP error would reliably leave the
 * later administrators with nothing, and the person who pressed the button would
 * see a bare error rather than "3 delivered, 2 refused by the provider".
 *
 * Sends are sequential with a gap: a burst of simultaneous SMTP handshakes from
 * one message is how a provider starts silently dropping mail — and a dropped
 * credential mail is indistinguishable from a delivered one at the provider.
 *
 * NO SECRET LEAVES THIS MODULE INTO A LOG OR A RESPONSE
 * ----------------------------------------------------
 * Aliases, counts, reasons, and masked addresses only. utils/email.js masks its
 * own log line; nothing here adds a second one.
 */

const DELIVERY_GAP_MS = 250;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Mirrors maskEmail in utils/email.js so a report never holds a full address. */
function maskEmail(value) {
  const email = String(value || '').trim();
  const at = email.indexOf('@');
  if (at <= 0) return '[invalid]';
  return `${email[0]}***@${email.slice(at + 1)}`;
}

/**
 * Whether a stored seed is a key an authenticator app can actually be given.
 *
 * speakeasy does NOT reject a non-base32 secret — it decodes up to the first
 * character outside `A-Z2-7` and silently ignores the rest. A value whose tail is
 * an argon2 parameter block (`,t=2,p=1$salt$hash`) therefore "works" on the
 * server and produces a code no app on earth will ever generate. That is exactly
 * the shape of the ADMIN_ACCOUNTS corruption described in adminAccounts.js, so
 * the delivery must say "this key is unusable" rather than mail a value that
 * cannot be spent.
 */
function isUsableBase32(value) {
  const secret = String(value || '').trim();
  return secret.length >= 16 && /^[A-Z2-7]+$/.test(secret);
}

/**
 * Pair the administrator documents with the addresses named in .env.
 *
 * The database wins for the authenticator seed: `.env` keeps a copy for the boot
 * seeder, but rotating a key writes only to the document, so .env can be a stale
 * seed while still naming the right alias.
 *
 * An alias with no address is reported in `missingEmail` rather than dropped:
 * "nobody was mailed for this account" is a fact the operator needs, whereas a
 * silently short list reads like everything went out.
 *
 * @param {Array<{alias: string, totpSecret?: string}>} accounts
 * @param {Array<{alias: string, email: string}>} emails configuredAdminEmails()
 * @returns {{recipients: Array<{alias: string, email: string, authenticatorKey: string}>,
 *            missingEmail: string[], missingKey: string[], unusableKey: string[],
 *            unknownEmail: string[]}}
 */
function buildCredentialRecipients(accounts = [], emails = []) {
  const emailByAlias = new Map(emails.map((entry) => [String(entry.alias || '').trim(), String(entry.email || '').trim()]));
  const seen = new Set();

  const recipients = [];
  const missingEmail = [];
  const missingKey = [];
  const unusableKey = [];

  for (const account of accounts) {
    const alias = String(account?.alias || '').trim();
    if (!alias) continue;
    seen.add(alias);
    const key = String(account.totpSecret || '').trim();
    if (!key) {
      // Nothing to deliver. Saying so beats mailing an envelope with a blank field.
      missingKey.push(alias);
      continue;
    }
    const email = emailByAlias.get(alias);
    if (!email) {
      missingEmail.push(alias);
      continue;
    }
    if (!isUsableBase32(key)) {
      // The account has a field, but it is not a key. Mailing it would tell the
      // recipient "here is your authenticator" and hand them something that can
      // never produce a code.
      unusableKey.push(alias);
      continue;
    }
    recipients.push({ alias, email, authenticatorKey: key });
  }

  // Addresses in .env naming an alias that has no admin account at all — a typo
  // or a retired administrator. Worth surfacing: it is the one case where the
  // operator would otherwise conclude the list was complete.
  const unknownEmail = emails
    .map((entry) => String(entry.alias || '').trim())
    .filter((alias) => alias && !seen.has(alias));

  return { recipients, missingEmail, missingKey, unusableKey, unknownEmail };
}

/**
 * Mail one copy per administrator.
 *
 * @param {object} [options]
 * @param {Array<{alias: string, email: string, authenticatorKey: string}>} [options.recipients]
 * @param {NodeJS.ProcessEnv} [options.env] injectable for tests
 * @param {number} [options.gapMs]
 * @param {number} [options.limit] cap on recipients per call
 * @returns {Promise<{ok: boolean, total: number, delivered: Array<{alias: string, email: string}>,
 *   failed: Array<{alias: string, email: string, reason: string}>,
 *   emailUnconfigured: boolean, capped: number}>}
 */
async function deliverAdminCredentials(options = {}) {
  // Required inside the function so a test can patch the module before this
  // runs (the technique the existing email tests already use).
  const { sendAdminCredentialEmail } = require('./email');

  const env = options.env || process.env;
  const gapMs = Number.isFinite(options.gapMs) ? Math.max(0, options.gapMs) : DELIVERY_GAP_MS;
  // A delivery is sized by the configured administrators, not by the caller's
  // body, so the cap is a backstop against a runaway recipient list rather than
  // a knob anyone is expected to hit.
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 50;

  const all = Array.isArray(options.recipients) ? options.recipients : [];
  const recipients = all.slice(0, limit);
  const report = {
    ok: false,
    total: recipients.length,
    delivered: [],
    failed: [],
    emailUnconfigured: false,
    capped: Math.max(0, all.length - recipients.length),
  };

  if (recipients.length === 0) return report;

  if (!env.EMAIL_USER || !env.EMAIL_PASSWORD) {
    report.emailUnconfigured = true;
    report.failed = recipients.map(({ alias, email }) => ({
      alias,
      email: maskEmail(email),
      reason: 'Email service is not configured (EMAIL_USER / EMAIL_PASSWORD missing from server/.env).',
    }));
    return report;
  }

  for (let i = 0; i < recipients.length; i++) {
    const { alias, email, authenticatorKey } = recipients[i];
    try {
      const sent = await sendAdminCredentialEmail(email, { alias, authenticatorKey });
      if (sent) report.delivered.push({ alias, email: maskEmail(email) });
      else report.failed.push({ alias, email: maskEmail(email), reason: 'The provider refused or did not accept the send.' });
    } catch (error) {
      report.failed.push({ alias, email: maskEmail(email), reason: String(error?.message || 'Send failed.') });
    }
    if (i < recipients.length - 1 && gapMs > 0) await sleep(gapMs);
  }

  report.ok = report.delivered.length > 0;
  return report;
}

module.exports = {
  deliverAdminCredentials,
  buildCredentialRecipients,
  isUsableBase32,
  maskEmail,
  DELIVERY_GAP_MS,
};
