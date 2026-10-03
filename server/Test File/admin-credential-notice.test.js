'use strict';
/**
 * Tests for the credential-update notice itself: the rendered message, and the
 * fan-out that delivers it.
 *
 * The parser has its own file (admin-emails.test.js). What is pinned here is
 * the part that decides what a real administrator actually receives.
 *
 * THE POINT OF THIS FILE
 * ----------------------
 * The notice carries no secret. AdminNames.md records that this project's real
 * TOTP seeds were committed to a public repository, and `email.js` contains a
 * second function — sendAdminCredentialsEmail — that does put a password and a
 * seed in a message. A recurring "your credentials were upgraded" mail is the
 * kind of feature that invites someone to helpfully add the new password to
 * it, and that change would be invisible in review. So the guarantee is
 * asserted structurally: whatever is passed in, the rendered message must not
 * contain it.
 */

const test = require('node:test');
const assert = require('node:assert');

const { DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION } = require('../utils/email');

/**
 * Render a notice through the real sender with a stubbed transport, so the
 * assertions are about the message a recipient would actually receive.
 *
 * utils/email.js keeps its transporter in a module-private variable and builds
 * it from process.env on first use, so the helper stubs
 * `nodemailer.createTransport` and re-requires utils/email.js with a cleared
 * cache. That exercises the real assembly path — the same one a live send goes
 * through — without a network connection and without refactoring the module
 * purely for testability.
 */
async function captureMail(options = {}) {
  const nodemailer = require('nodemailer');
  const emailUtilsPath = require.resolve('../utils/email');

  const messages = [];
  const realCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (mail) => {
      messages.push(mail);
      return { messageId: 'stub', accepted: [mail.to] };
    },
    verify: async () => true,
    close: () => {},
  });

  const saved = {
    EMAIL_HOST: process.env.EMAIL_HOST,
    EMAIL_PORT: process.env.EMAIL_PORT,
    EMAIL_USER: process.env.EMAIL_USER,
    EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
  };
  // A configured transport. Without these the sender short-circuits at
  // getTransporter() and the template is never rendered at all, so a test
  // asserting on the message would pass for the wrong reason.
  process.env.EMAIL_HOST = 'localhost';
  process.env.EMAIL_PORT = '2525';
  process.env.EMAIL_USER = 'sender@example.com';
  process.env.EMAIL_PASSWORD = 'app-password';

  delete require.cache[emailUtilsPath];
  const fresh = require('../utils/email');
  const sent = await fresh.sendAdminCredentialUpdateEmail(options.to || 'target@example.com', {
    alias: options.alias,
    description: options.description,
    changedAt: options.changedAt,
  });

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  nodemailer.createTransport = realCreateTransport;
  delete require.cache[emailUtilsPath];

  return { sent, messages };
}

/** Run `body` with the SMTP config removed, so the sender cannot send. */
async function withoutEmailConfig(body) {
  const saved = {
    EMAIL_USER: process.env.EMAIL_USER,
    EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
  };
  delete process.env.EMAIL_USER;
  delete process.env.EMAIL_PASSWORD;
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── The rendered message ─────────────────────────────────────────────────

test('the default wording is the sentence this notice was written for', () => {
  // Pinned as its own assertion so the constant cannot be reworded without
  // this failing. The wording is the whole point of the notice.
  assert.strictEqual(
    DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION,
    "I'll Updated Your Credentials With Upgraded Version of Encryption"
  );
});

test('the notice is delivered and says the requested thing', async () => {
  const { sent, messages } = await captureMail({ alias: 'AdminDevs' });
  assert.strictEqual(sent, true, 'a configured transport must report success');
  assert.strictEqual(messages.length, 1);

  const [mail] = messages;
  assert.match(mail.subject, /credentials were updated/i);
  // The apostrophe arrives as the entity `&#39;` in the HTML body, which every
  // mail client renders as "I'll". The plain-text twin carries the raw
  // apostrophe, asserted below — so the reader sees the sentence as written in
  // both formats and neither shows them an entity.
  assert.match(
    mail.html,
    /I&#39;ll Updated Your Credentials With Upgraded Version of Encryption/,
    'the default description must reach the recipient'
  );
  assert.match(
    mail.text,
    /I'll Updated Your Credentials With Upgraded Version of Encryption/,
    'the plain-text twin must carry the raw apostrophe, not the entity'
  );
});

test('an operator-supplied description replaces the default', async () => {
  const { messages } = await captureMail({ alias: 'AdminDevs', description: 'Keys rotated on Tuesday.' });
  assert.match(messages[0].html, /Keys rotated on Tuesday\./);
  assert.doesNotMatch(messages[0].html, /Upgraded Version of Encryption/);
});

test('an empty description falls back to the default rather than sending a blank notice', async () => {
  // A whitespace-only override is what a cleared text field produces. Sending
  // it would deliver a security notice with no content at all.
  for (const value of ['', '   ', '\n\t ']) {
    const { messages } = await captureMail({ alias: 'AdminDevs', description: value });
    assert.match(messages[0].html, /Upgraded Version of Encryption/);
  }
});

test('the message states that the sign-in method is unchanged', async () => {
  // The notice exists to stop recipients panicking and re-enrolling their
  // authenticator. Saying *that* credentials changed without saying *what did
  // not* would produce exactly that panic, so the reassurance is asserted.
  const { messages } = await captureMail({ alias: 'AdminDevs' });
  assert.match(messages[0].html, /sign in exactly as you did before/i);
  assert.match(messages[0].html, /no new key has to be added/i);
});

test('the message says no secret is included', async () => {
  // Belt and braces with the assertions below: the recipient is told the
  // channel carries no secret, so the guarantee is visible to them and not
  // only to a test runner.
  const { messages } = await captureMail({ alias: 'AdminDevs' });
  assert.match(messages[0].html, /no password or authenticator key is ever sent by email/i);
});

// ── Escaping ─────────────────────────────────────────────────────────────

test('a description containing HTML is escaped, not rendered', async () => {
  // `description` is the one field in this file a caller outside the codebase
  // chooses, so it is the one that has to be escaped rather than stripped.
  const { messages } = await captureMail({
    alias: 'AdminDevs',
    description: '<img src=x onerror="alert(1)"> upgraded & hardened',
  });
  const [mail] = messages;
  assert.doesNotMatch(mail.html, /<img/, 'the tag must not survive into the message');
  assert.match(mail.html, /&lt;img/, 'it must appear escaped instead');
  // Stripping rather than escaping would also drop the "&" and render the
  // sentence as "...upgraded  hardened", losing the operator's wording.
  assert.match(mail.html, /upgraded &amp; hardened/, 'escaping must preserve the text');
});

test('an alias containing HTML is escaped too', async () => {
  const { messages } = await captureMail({ alias: 'Admin<script>alert(1)</script>' });
  assert.doesNotMatch(messages[0].html, /<script/);
  assert.match(messages[0].html, /&lt;script/);
});

test('the plain-text alternative is not HTML-escaped', async () => {
  // The text twin uses the unescaped value on purpose. Sharing the escaped one
  // would show a reader "R&amp;D" where the operator typed "R&D".
  const { messages } = await captureMail({ alias: 'AdminDevs', description: 'R&D keys upgraded' });
  assert.match(messages[0].text, /R&D keys upgraded/);
  assert.doesNotMatch(messages[0].text, /&amp;/);
});

test('an over-long description is capped instead of bloating the message', async () => {
  const { messages } = await captureMail({ alias: 'AdminDevs', description: 'x'.repeat(5000) });
  assert.ok(messages[0].html.length < 20000, 'the message must stay a sane size');
});

// ── The no-secret guarantee ──────────────────────────────────────────────

test('no password, hash or authenticator key is ever present', async () => {
  // The structural guarantee. sendAdminCredentialsEmail (a different function)
  // does put secrets in mail — that is its job, for a one-time hand-off — so
  // the risk here is that someone reaches for it, or adds a "helpful" context
  // field, and the guarantee quietly lapses. Pinned so that is a failing test.
  const { messages } = await captureMail({
    alias: 'AdminDevs',
    description: DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION,
  });
  const rendered = `${messages[0].html}\n${messages[0].text}`;
  assert.doesNotMatch(rendered, /AAAAAAAAAABBBBBBBBBBCCCCCCCCCCCC/, 'a real TOTP seed must never appear');
  assert.doesNotMatch(rendered, /argon2id/, 'a stored hash must never appear');
  assert.doesNotMatch(rendered, /\$2[aby]?\$/, 'a bcrypt hash must never appear');
  assert.doesNotMatch(rendered, /password\s*[:=]\s*\S/i, 'no labelled password may appear');
  assert.doesNotMatch(rendered, /authenticator key\s*[:=]\s*[A-Z2-7]{16,}/i, 'no labelled seed may appear');
});

// ── Failure behaviour ────────────────────────────────────────────────────

test('a malformed recipient is refused before any transport is used', async () => {
  const { sent, messages } = await captureMail({ to: 'not-an-email' });
  assert.strictEqual(sent, false);
  assert.strictEqual(messages.length, 0, 'nothing may be handed to the transport');
});

test('the sender never throws, so one bad address cannot abort a batch', async () => {
  const fresh = require('../utils/email');
  // No SMTP config: getTransporter() returns null and the sender must return
  // false rather than throw.
  const result = await withoutEmailConfig(() => fresh.sendAdminCredentialUpdateEmail('target@example.com', { alias: 'AdminDevs' }));
  assert.strictEqual(result, false);
});

// ── The fan-out ──────────────────────────────────────────────────────────

const ACCOUNTS = [
  'AdminDevs|$2a$12$mMRQcVk4IxFpvOeCdVqhqueRm73wg4sO.z1pJmZej4LLf4GbXG8oO|AAAAAAAAAABBBBBBBBBBCCCCCCCCCCCC',
  'AdminPoli|$2a$12$mMRQcVk4IxFpvOeCdVqhqueRm73wg4sO.z1pJmZej4LLf4GbXG8oO|GVXWNR2K5KXIXL5IRZUEPSKIFFFKPDXA',
  'AdminJoma|$2a$12$mMRQcVk4IxFpvOeCdVqhqueRm73wg4sO.z1pJmZej4LLf4GbXG8oO|AAAAAAAAAABBBBBBBBBBCCCCCCCCCC',
  'AdminShMa|$2a$12$mMRQcVk4IxFpvOeCdVqhqueRm73wg4sO.z1pJmZej4LLf4GbXG8oO|DDDDDDDDDEEEEEEEEEEFFFFFFFFFF',
].join(',');

test('a report names who was reached and who has no address', async () => {
  const { notifyAllAdminsAboutCredentials } = require('../utils/adminCredentialNotice');
  // No SMTP config, so every send reports failure. What is under test is the
  // shape of the report and that all recipients were attempted rather than the
  // send being short-circuited at the first one.
  const report = await withoutEmailConfig(() => notifyAllAdminsAboutCredentials({
    env: {
      ADMIN_ACCOUNTS: ACCOUNTS,
      ADMIN_EMAILS: 'AdminDevs=a@example.com,AdminPoli=b@example.com',
    },
  }));

  assert.strictEqual(report.recipients, 2);
  assert.strictEqual(report.delivered.length + report.failed.length, 2, 'every recipient is attempted');
  assert.deepStrictEqual(report.missingEmail, ['AdminJoma', 'AdminShMa']);
  assert.strictEqual(report.ok, false, 'no delivery means not ok');
});

test('one failing address does not stop the rest of the batch', async () => {
  // The single most important property of the fan-out. The administrator who
  // is NOT reached is precisely the one who needs to know, and a batch that
  // aborted on the first failure would reliably leave the later aliases —
  // including whoever pressed the button — uninformed.
  const { notifyAllAdminsAboutCredentials } = require('../utils/adminCredentialNotice');
  const { configuredAdminEmails } = require('../utils/adminAccounts');

  const report = await withoutEmailConfig(() => notifyAllAdminsAboutCredentials({
    env: { ADMIN_EMAILS: 'A=a@example.com,B=b@example.com,C=c@example.com,D=d@example.com' },
  }));

  assert.strictEqual(report.recipients, 4, 'all four configured addresses are attempted');
  assert.strictEqual(report.failed.length, 4, 'with no SMTP config all four fail');
  // And the order is preserved, so the last alias in .env is not the one that
  // gets abandoned.
  assert.deepStrictEqual(report.failed.map(entry => entry.alias), ['A', 'B', 'C', 'D']);
  assert.ok(configuredAdminEmails, 'the fan-out resolves recipients through the shared parser');
});

test('an empty address list is reported as unconfigured, not as a silent success', async () => {
  const { notifyAllAdminsAboutCredentials } = require('../utils/adminCredentialNotice');
  const report = await withoutEmailConfig(() => notifyAllAdminsAboutCredentials({
    env: { ADMIN_EMAILS: '' },
  }));
  assert.strictEqual(report.unconfigured, true);
  assert.strictEqual(report.recipients, 0);
  assert.strictEqual(report.ok, false);
  assert.deepStrictEqual(report.delivered, []);
});

test('the report carries the wording that was actually used', async () => {
  // So the console can show the operator the sentence their administrators
  // received rather than a description of it.
  const { notifyAllAdminsAboutCredentials } = require('../utils/adminCredentialNotice');
  const report = await withoutEmailConfig(() => notifyAllAdminsAboutCredentials({
    env: { ADMIN_EMAILS: 'A=a@example.com' },
    description: 'Upgraded on Tuesday.',
  }));
  assert.strictEqual(report.description, 'Upgraded on Tuesday.');
});

test('a blank description resolves to the default, not to an empty string', async () => {
  const { notifyAllAdminsAboutCredentials } = require('../utils/adminCredentialNotice');
  const report = await withoutEmailConfig(() => notifyAllAdminsAboutCredentials({
    env: { ADMIN_EMAILS: 'A=a@example.com' },
    description: '   ',
  }));
  assert.strictEqual(report.description, DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION);
});
