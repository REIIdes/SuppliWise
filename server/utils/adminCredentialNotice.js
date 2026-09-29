'use strict';
/**
 * Fan-out of the administrator credential-update notice.
 *
 * ONE DEFINITION, BECAUSE TWO COPIES IS THE BUG
 * ---------------------------------------------
 * This send is reachable from two places: the console button
 * (`POST /api/admin/admins/notify-credentials`) and the terminal script
 * (`npm run notify-admins`). Both need the same four decisions — who the
 * recipients are, what the notice says, whether one bad address aborts the
 * batch, and what the caller is told afterwards. Written twice, those four
 * drift: the button reports "sent to 6" while the script reports 5, or the
 * script starts skipping a failing address and the button does not, and nobody
 * notices until an administrator says they never got it.
 *
 * So the decisions live here and both callers only choose *whether* to run it.
 * The same reasoning as `utils/adminAccounts.js` (one delimiter rule, not two)
 * and for the same reason: a rule that is easy to get subtly wrong should exist
 * once, not once per caller.
 *
 * NO DATABASE REQUIRED
 * --------------------
 * This module deliberately does not touch Mongo. The script runs it from a
 * terminal where no connection is open, and the route has one already — an
 * audit row is a nice-to-have on the notification path and must never be what
 * decides whether an administrator gets told their credentials changed. The
 * route writes the audit row itself, after the fan-out has completed.
 */

/** Gap between sends. Sequential on purpose — see the note in the loop below. */
const SEND_GAP_MS = 120;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Send the notice to every configured administrator address.
 *
 * PARTIAL SUCCESS IS SUCCESS
 * -------------------------
 * One undeliverable address must not stop the rest. The administrator who gets
 * no notice is precisely the person who needs one, and a batch that aborts on
 * the first SMTP failure reliably leaves the *later* aliases — including the
 * person who triggered the send — uninformed. So every recipient is attempted,
 * failures are collected per address, and the caller gets a report that names
 * exactly who was reached.
 *
 * The transport is pooled (utils/email.js) and the sends are sequential rather
 * than concurrent: this is at most a handful of addresses, fired by a human
 * clicking a button, and a burst of simultaneous SMTP handshakes is how a
 * provider starts silently dropping mail. The gap is what stops the pool from
 * opening them all at once.
 *
 * @param {object}  [options]
 * @param {NodeJS.ProcessEnv} [options.env] injectable for tests
 * @param {string}  [options.description] overrides the notice wording
 * @param {string}  [options.triggeredBy] alias of the admin who asked, for logs
 * @returns {Promise<{
 *   ok: boolean,
 *   description: string,
 *   recipients: number,
 *   delivered: Array<{alias: string, email: string}>,
 *   failed: Array<{alias: string, email: string, reason: string}>,
 *   missingEmail: string[],
 *   unconfigured: boolean,
 * }>}
 */
async function notifyAllAdminsAboutCredentials(options = {}) {
  // Required inside the function, not at module scope, so a caller can patch
  // the module object (the technique the auth and reset tests already use for
  // email) before this runs.
  const { configuredAdminEmails, adminAccountsMissingEmail } = require('./adminAccounts');
  const { sendAdminCredentialUpdateEmail, DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION } = require('./email');

  const env = options.env || process.env;
  const description = String(options.description || '').trim().slice(0, 400)
    || DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION;
  const triggeredBy = String(options.triggeredBy || '').trim().slice(0, 64) || 'operator';
  const changedAt = new Date().toISOString();

  const recipients = configuredAdminEmails(env);
  // Admins that exist as accounts but were never given an address. Reported
  // rather than skipped silently: "we emailed everyone" is only true if the
  // operator can see who was left out and why.
  const missingEmail = adminAccountsMissingEmail(env);

  const report = {
    ok: false,
    description,
    recipients: recipients.length,
    delivered: [],
    failed: [],
    missingEmail,
    unconfigured: recipients.length === 0,
  };

  if (recipients.length === 0) {
    console.warn(
      `[admin-credentials] No ADMIN_EMAILS entries matched a usable address — nothing sent `
      + `(triggered by ${triggeredBy}).`
    );
    return report;
  }

  console.log(
    `[admin-credentials] Notifying ${recipients.length} administrator(s) about the credential `
    + `update (triggered by ${triggeredBy}).`
  );

  for (const [index, recipient] of recipients.entries()) {
    if (index > 0) await sleep(SEND_GAP_MS);
    let sent = false;
    try {
      sent = await sendAdminCredentialUpdateEmail(recipient.email, {
        alias: recipient.alias,
        description,
        changedAt,
      });
    } catch (error) {
      // sendAdminCredentialUpdateEmail is documented never to throw, but this
      // is a loop over a network call whose transport is rebuilt on failure;
      // a defensive catch keeps one recipient from taking down the batch.
      console.error(`[admin-credentials] ${recipient.alias} raised: ${error.message}`);
    }
    if (sent) {
      report.delivered.push({ ...recipient });
    } else {
      report.failed.push({ ...recipient, reason: 'not accepted by the mail service' });
    }
  }

  report.ok = report.failed.length === 0;
  console.log(
    `[admin-credentials] Done: ${report.delivered.length} delivered, ${report.failed.length} failed, `
    + `${missingEmail.length} administrator(s) with no address on file.`
  );
  if (missingEmail.length) {
    console.warn(`[admin-credentials] No address configured for: ${missingEmail.join(', ')}`);
  }
  return report;
}

module.exports = {
  notifyAllAdminsAboutCredentials,
  // Re-exported, not re-declared. The notice wording is owned by utils/email.js
  // because that is what renders it; this module just orchestrates the send.
  // A second copy of the sentence here would be the exact drift this file
  // exists to prevent.
  getDefaultDescription: () => require('./email').DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION,
};
