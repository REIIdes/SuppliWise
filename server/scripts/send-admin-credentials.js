'use strict';
/**
 * Hand each administrator their own alias, password and authenticator seed, by email.
 *
 *   npm run send-admin-credentials -- --password AdminDevs:'S3cret!pass'
 *   npm run send-admin-credentials -- --password AdminDevs:'S3cret!pass' --dry-run
 *   npm run send-admin-credentials -- --password AdminDevs:'S3cret!pass' -y
 *
 * WHY THIS IS A SEPARATE SCRIPT AND NOT A FLAG ON notify-admins.js
 * ----------------------------------------------------------------
 * These are two opposite products and they must never be reachable from the
 * same code path:
 *
 *   notify-admins.js  — recurring, secret-FREE. "your stored credentials
 *                       changed". Safe to re-run, safe to automate.
 *   this script       — one-time hand-off, carries the alias, the password AND
 *                       the TOTP seed. Never scheduled, never looped.
 *
 * Keeping them apart means the recurring channel has no password field to grow,
 * and this one cannot be fired by accident by a deploy hook.
 *
 * It does not open a database connection, deliberately: this must work on a
 * machine where the server is not running, and the recipient list is server
 * configuration, not stored state.
 *
 * EXIT CODES
 *   0  every configured address was reached (or nothing was configured, or a
 *      dry run, or the operator cancelled)
 *   1  at least one address was rejected, the arguments could not be parsed, or
 *      at least one hand-off failed
 *   3  nothing was sent and it was not a dry run, because there is no usable
 *      ADMIN_EMAILS value or no SMTP config to send it with
 */

require('dotenv').config();

const {
  handoffAdminCredentials,
  maskEmail,
  indexAccountsByAlias,
} = require('../utils/adminCredentialHandoff');
const {
  configuredAdminEmails,
  configuredAdminAccounts,
  adminAccountsMissingEmail,
} = require('../utils/adminAccounts');

function parseArgs(argv) {
  const options = { passwords: {}, description: '', dryRun: false, help: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    // Both --yes and -y, because this sends real secrets to real people.
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--description' || arg === '-d') {
      const next = argv[++i];
      if (next === undefined) throw new Error('--description needs a value.');
      options.description = next;
    } else if (arg.startsWith('--description=')) {
      options.description = arg.slice('--description='.length);
    } else if (arg === '--password' || arg === '-p') {
      const next = argv[++i];
      if (next === undefined) throw new Error('--password needs a value.');
      const { alias, password } = splitPasswordArg(next);
      options.passwords[alias] = password;
    } else if (arg.startsWith('--password=')) {
      const { alias, password } = splitPasswordArg(arg.slice('--password='.length));
      options.passwords[alias] = password;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * `Alias:password`, split on the FIRST colon only.
 *
 * The first colon, not the last, because a generated password routinely
 * contains colons — splitting on the last one would truncate the password and
 * mail the administrator something that cannot sign in.
 */
function splitPasswordArg(raw) {
  const value = String(raw == null ? '' : raw);
  const at = value.indexOf(':');
  if (at <= 0) {
    throw new Error(`--password must be "Alias:password" — got "${value}".`);
  }
  const alias = value.slice(0, at).trim();
  const password = value.slice(at + 1);
  if (!alias) throw new Error('--password is missing an alias before the colon.');
  if (!password.trim()) throw new Error(`--password for "${alias}" is empty after the colon.`);
  return { alias, password };
}

const USAGE = `
Hand each administrator their alias, password and authenticator seed by email.

  npm run send-admin-credentials -- --password AdminDevs:'S3cret!pass'
  npm run send-admin-credentials -- --password AdminDevs:'S3cret!pass' --dry-run
  npm run send-admin-credentials -- --password AdminDevs:'S3cret!pass' -y

Options
  -p, --password <Alias:password>  Password for one administrator. Repeat the
                                   flag for more than one alias. The value is
                                   split on the FIRST colon, so a password may
                                   itself contain colons.
  -d, --description <text>         Override the message wording (max 400 chars).
      --dry-run                    Show who would be reached, send nothing.
  -y, --yes                        Skip the confirmation prompt.
  -h, --help                       Show this message.

The password is never printed. Prefer --dry-run first, then quote the value so
your shell history and the process list do not keep it.
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
    console.error(`[send-admin-credentials] ${error.message}`);
    console.error(USAGE);
    return 1;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const recipients = configuredAdminEmails();
  const missing = adminAccountsMissingEmail();
  const accounts = indexAccountsByAlias(configuredAdminAccounts());
  const supplied = Object.keys(options.passwords);

  console.log('\n── Administrator credential hand-off ────────────────────────────');
  console.log(`Recipients : ${recipients.length}`);
  for (const { alias, email } of recipients) {
    const account = accounts.exact.get(alias) || accounts.lowered.get(String(alias).toLowerCase());
    const hasSeed = !!(account && String(account.totpSecret || '').trim());
    const hasPassword = Object.prototype.hasOwnProperty.call(options.passwords, alias)
      || Object.prototype.hasOwnProperty.call(options.passwords, String(alias).toLowerCase());
    // Password values are never rendered — only whether one was supplied.
    const marks = [hasSeed ? 'seed' : 'NO SEED', hasPassword ? 'password' : 'NO PASSWORD'];
    console.log(`  • ${String(alias).padEnd(12)} ${maskEmail(email).padEnd(28)} ${marks.join(' + ')}`);
  }
  if (missing.length) {
    console.log(`No address on file (${missing.length}): ${missing.join(', ')}`);
  }
  if (supplied.length) {
    console.log(`Passwords supplied for: ${supplied.join(', ')}`);
  } else {
    console.log('Passwords supplied for: (none)');
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

  // Refuse early rather than mailing a partial set: an administrator with an
  // address but no seed, or no password, cannot finish signing in.
  const unusable = recipients.filter(({ alias }) => {
    const account = accounts.exact.get(alias) || accounts.lowered.get(String(alias).toLowerCase());
    const hasSeed = !!(account && String(account.totpSecret || '').trim());
    const hasPassword = Object.prototype.hasOwnProperty.call(options.passwords, alias)
      || Object.prototype.hasOwnProperty.call(options.passwords, String(alias).toLowerCase());
    return !hasSeed || !hasPassword;
  });
  if (unusable.length) {
    console.error(`\nRefusing to send: ${unusable.length} recipient(s) lack a seed or a password.`);
    for (const { alias } of unusable) {
      const account = accounts.exact.get(alias) || accounts.lowered.get(String(alias).toLowerCase());
      const hasSeed = !!(account && String(account.totpSecret || '').trim());
      const hasPassword = Object.prototype.hasOwnProperty.call(options.passwords, alias);
      console.error(`  • ${alias} — ${hasSeed ? 'no --password supplied' : 'no authenticator key in .env'}`);
    }
    console.error('\nAdd a --password for each alias, or an ADMIN_ACCOUNTS entry with a seed, then re-run.');
    console.error('Use --dry-run to check the plan without sending.');
    return 1;
  }

  // Prompt before sending. This is every administrator's real password and
  // authenticator seed leaving the machine; --yes is the opt-out for unattended
  // runs, and the cost of a mistaken run is not recoverable by re-sending.
  if (!options.yes && !await confirm(`\nSend real passwords and seeds to ${recipients.length} administrator(s)? [y/N] `)) {
    console.log('Cancelled. Nothing was sent.\n');
    return 0;
  }

  const report = await handoffAdminCredentials({
    passwords: options.passwords,
    description: options.description,
    triggeredBy: 'npm script',
  });

  console.log('\n── Result ──────────────────────────────────────────────────────');
  console.log(`Delivered : ${report.delivered.length}/${report.recipients}`);
  for (const { alias, email } of report.delivered) console.log(`  OK  ${alias.padEnd(12)} ${maskEmail(email)}`);
  for (const { alias, email, reason } of report.failed) {
    console.log(`  XX  ${alias.padEnd(12)} ${maskEmail(email)} — ${reason}`);
  }
  if (report.missingEmail.length) {
    console.log(`Skipped   : ${report.missingEmail.length} administrator(s) with no address on file`);
  }
  if (report.missingSecret.length) {
    console.log(`Skipped   : ${report.missingSecret.length} with no authenticator key in .env`);
  }
  if (report.missingPassword.length) {
    console.log(`Skipped   : ${report.missingPassword.length} with no password supplied`);
  }
  if (report.unusedPasswords.length) {
    console.log(`Warning   : password supplied for an alias that was not mailed (typo?): ${report.unusedPasswords.join(', ')}`);
  }
  console.log('\nThis is a one-time hand-off. Do not schedule it and do not re-run it.\n');

  return report.failed.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`[send-admin-credentials] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
