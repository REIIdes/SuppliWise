'use strict';
/**
 * Send the administrator credential-update notice from the terminal.
 *
 *   npm run notify-admins
 *   npm run notify-admins -- --description "Custom wording"
 *   npm run notify-admins -- --dry-run
 *
 * This is the same fan-out the console button runs (utils/adminCredentialNotice.js),
 * so both produce an identical recipient list and an identical report. The
 * difference is only in how you reach it: the button is for a person already
 * signed in to the console, this is for a deployment step, a post-rotation
 * checklist, or a fresh clone whose administrator has no browser session yet.
 *
 * It does not open a database connection, which is deliberate: this must work on
 * a machine where the server is not running, and the recipient list is server
 * configuration, not stored state. Consequently there is no AdminEvent audit
 * row for a send made this way — the console log below is the record.
 *
 * EXIT CODES
 *   0  every configured address was reached (or nothing was configured, or a
 *      dry run, or the operator cancelled)
 *   1  at least one address was rejected, or the arguments could not be parsed
 *   3  nothing was sent and it was not a dry run, because there is no usable
 *      ADMIN_EMAILS value or no SMTP config to send it with
 */

require('dotenv').config();

const { notifyAllAdminsAboutCredentials } = require('../utils/adminCredentialNotice');
const { configuredAdminEmails, adminAccountsMissingEmail } = require('../utils/adminAccounts');
const { DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION } = require('../utils/email');

/** Mirrors maskEmail in utils/email.js: log a recipient without persisting it. */
function mask(value) {
  const email = String(value || '').trim();
  const at = email.indexOf('@');
  if (at <= 0) return '[invalid]';
  return `${email[0]}***@${email.slice(at + 1)}`;
}

function parseArgs(argv) {
  const options = { description: '', dryRun: false, help: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    // Both --yes and -y, because this sends real mail to real people.
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--description' || arg === '-d') {
      const next = argv[++i];
      if (next === undefined) throw new Error('--description needs a value.');
      options.description = next;
    } else if (arg.startsWith('--description=')) {
      options.description = arg.slice('--description='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const USAGE = `
Send the administrator credential-update notice to every ADMIN_EMAILS address.

  npm run notify-admins
  npm run notify-admins -- --dry-run
  npm run notify-admins -- --description "Your wording here"
  npm run notify-admins -- -d "Your wording here" --yes

Options
  -d, --description <text>  Override the notice wording (max 400 characters).
      --dry-run            Show who would be reached, send nothing.
  -y, --yes                Skip the confirmation prompt.
  -h, --help               Show this message.
`;

async function confirm(prompt) {
  // Required lazily so --dry-run and --yes work in an environment with no TTY
  // attached (CI, a scheduled task, a container without an interactive shell).
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
  return /^y(es)?$/i.test(String(answer || '').trim());
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[notify-admins] ${error.message}`);
    console.error(USAGE);
    return 1;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const recipients = configuredAdminEmails();
  const missing = adminAccountsMissingEmail();
  const description = options.description || DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION;

  console.log('\n── Administrator credential notice ──────────────────────────────');
  console.log(`Wording    : ${description}`);
  console.log(`Recipients : ${recipients.length}`);
  for (const { alias, email } of recipients) {
    console.log(`  • ${alias.padEnd(12)} ${mask(email)}`);
  }
  if (missing.length) {
    console.log(`No address on file (${missing.length}): ${missing.join(', ')}`);
  }

  if (options.dryRun) {
    console.log('\nDry run — nothing was sent.\n');
    return 0;
  }

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.error('\nEMAIL_USER / EMAIL_PASSWORD are not set — nothing can be sent.');
    console.error('Add them to server/.env. See .env.example.');
    return 3;
  }

  if (recipients.length === 0) {
    console.error('\nNo usable ADMIN_EMAILS entries. Add one per administrator to server/.env, e.g.');
    console.error('  ADMIN_EMAILS=AdminDevs=someone@example.com,AdminPoli=other@example.com');
    return 3;
  }

  // Prompt before sending. This is real mail to real people from a shared
  // mailbox, and the cost of a mistaken run is a security notice delivered N
  // times. --yes is the opt-out for unattended runs.
  if (!options.yes && !await confirm(`\nSend this notice to ${recipients.length} administrator(s)? [y/N] `)) {
    console.log('Cancelled. Nothing was sent.\n');
    return 0;
  }

  const report = await notifyAllAdminsAboutCredentials({ description, triggeredBy: 'npm script' });

  console.log('\n── Result ──────────────────────────────────────────────────────');
  console.log(`Delivered : ${report.delivered.length}/${report.recipients}`);
  for (const { alias, email } of report.delivered) console.log(`  OK  ${alias.padEnd(12)} ${mask(email)}`);
  for (const { alias, email, reason } of report.failed) {
    console.log(`  XX  ${alias.padEnd(12)} ${mask(email)} — ${reason}`);
  }
  if (report.missingEmail.length) {
    console.log(`Skipped   : ${report.missingEmail.length} administrator(s) with no address on file`);
  }
  console.log('');

  return report.failed.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`[notify-admins] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
