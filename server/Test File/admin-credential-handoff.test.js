'use strict';
/**
 * Tests for the one-time administrator credential hand-off.
 *
 * THE POINT OF THIS FILE
 * ----------------------
 * This is the only path in the project that puts a live password and a live TOTP
 * seed into a message, so it is tested from both ends at once:
 *
 *   1. The message must CONTAIN them, correctly. The template used to strip
 *      `< > & "` out of every value, which blocks tag injection but silently
 *      corrupts a password — the recipient would have been sent a password that
 *      does not sign in. That is asserted here directly.
 *   2. The recurring update notice must STILL CONTAIN NEITHER. Adding the
 *      hand-off must not have widened the notice, and the guarantee is asserted
 *      across both functions in one test so the two cannot drift apart.
 *
 * admin-credential-notice.test.js pins the notice on its own; this file pins the
 * hand-off and the relationship between them.
 */

const test = require('node:test');
const assert = require('node:assert');

const { DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION } = require('../utils/email');
const { normalisePasswords, indexAccountsByAlias, maskEmail } = require('../utils/adminCredentialHandoff');

/**
 * Render a hand-off through the real sender with a stubbed transport, so the
 * assertions are about the message an administrator would actually receive.
 *
 * utils/email.js keeps its transporter in a module-private variable and builds it
 * from process.env on first use, so this stubs `nodemailer.createTransport` and
 * re-requires the module with a cleared cache — the same technique, and for the
 * same reason, as admin-credential-notice.test.js.
 */
async function captureHandoffMail(options = {}) {
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
  process.env.EMAIL_HOST = 'localhost';
  process.env.EMAIL_PORT = '2525';
  process.env.EMAIL_USER = 'sender@example.com';
  process.env.EMAIL_PASSWORD = 'app-password';

  delete require.cache[emailUtilsPath];
  const fresh = require('../utils/email');
  const sent = await fresh.sendAdminCredentialsEmail(options.to || 'target@example.com', {
    alias: options.alias === undefined ? 'AdminDevs' : options.alias,
    password: options.password === undefined ? 'Devs101' : options.password,
    totpSecret: options.totpSecret === undefined ? 'LN5T652PIVISUXSXKFFXWKCEIN6XKTBPJZIFWXTNMVOVAOD3PFKA' : options.totpSecret,
    description: options.description,
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

test('the message carries the alias, the password and the authenticator key', async () => {
  // The whole purpose of this path. Asserted in both formats, because a mail
  // client that renders the text/plain alternative must show the same values.
  const { sent, messages } = await captureHandoffMail();
  assert.strictEqual(sent, true, 'a configured transport must report success');
  assert.strictEqual(messages.length, 1);

  const [mail] = messages;
  for (const value of [
    'AdminDevs',
    'Devs101',
    'LN5T652PIVISUXSXKFFXWKCEIN6XKTBPJZIFWXTNMVOVAOD3PFKA',
  ]) {
    assert.match(mail.html, new RegExp(value), `${value} must reach the HTML body`);
    assert.match(mail.text, new RegExp(value), `${value} must reach the text body`);
  }
});

test('the message carries the default description', async () => {
  // The same sentence the update notice uses, so an operator can say why the
  // hand-off is going out without the template owning a second copy.
  const { messages } = await captureHandoffMail();
  assert.match(
    messages[0].html,
    /I&#39;ll Updated Your Credentials With Upgraded Version of Encryption/,
    'the default description must reach the recipient'
  );
  assert.match(
    messages[0].text,
    /I'll Updated Your Credentials With Upgraded Version of Encryption/,
    'the plain-text twin must carry the raw apostrophe, not the entity'
  );
});

test('an operator-supplied description replaces the default', async () => {
  const { messages } = await captureHandoffMail({ description: 'Re-issued after the June rotation.' });
  assert.match(messages[0].html, /Re-issued after the June rotation\./);
  assert.doesNotMatch(messages[0].html, /Upgraded Version of Encryption/);
});

test('a blank description falls back to the default rather than sending an unexplained mail', async () => {
  for (const value of ['', '   ', '\n\t ']) {
    const { messages } = await captureHandoffMail({ description: value });
    assert.match(messages[0].html, /Upgraded Version of Encryption/);
  }
});

test('a password containing HTML metacharacters is escaped, not corrupted', async () => {
  // The regression this file exists for. The template used to strip `< > & "`
  // from every value, which meant a password like `a&b<c>"d` reached the
  // administrator as `abcd` — a password that cannot sign in, and a bug that
  // would have been reported as "the email gave me the wrong password".
  const password = 'a&b<c>"d';
  const { messages } = await captureHandoffMail({ password });
  const [mail] = messages;

  assert.doesNotMatch(mail.html, /<c>/, 'the tag must not survive as markup');
  assert.match(mail.html, /a&amp;b&lt;c&gt;&quot;d/, 'every character must survive, escaped');
  // The text/plain twin carries the raw value, because that is what the
  // administrator has to type.
  assert.match(mail.text, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the plain-text alternative is not HTML-escaped', async () => {
  const { messages } = await captureHandoffMail({ description: 'R&D keys upgraded' });
  assert.match(messages[0].text, /R&D keys upgraded/);
  assert.doesNotMatch(messages[0].text, /&amp;/);
});

test('an alias containing HTML is escaped rather than rendered', async () => {
  const { messages } = await captureHandoffMail({ alias: 'Admin<script>alert(1)</script>' });
  assert.doesNotMatch(messages[0].html, /<script/);
  assert.match(messages[0].html, /&lt;script/);
});

test('a description containing HTML is escaped, not rendered', async () => {
  const { messages } = await captureHandoffMail({ description: '<img src=x onerror="alert(1)"> upgraded' });
  assert.doesNotMatch(messages[0].html, /<img/);
  assert.match(messages[0].html, /&lt;img/);
});

// ── Failure behaviour ────────────────────────────────────────────────────

test('a missing password, key or alias is refused before any transport is used', async () => {
  // A hand-off missing its password would be a mail that reaches an
  // administrator who then cannot sign in and does not know why.
  for (const context of [
    { alias: 'AdminDevs', password: '', totpSecret: 'ABC' },
    { alias: 'AdminDevs', password: 'Devs101', totpSecret: '' },
    { alias: '', password: 'Devs101', totpSecret: 'ABC' },
  ]) {
    const { sent, messages } = await captureHandoffMail(context);
    assert.strictEqual(sent, false, `${JSON.stringify(Object.keys(context))} must be refused`);
    assert.strictEqual(messages.length, 0, 'nothing may be handed to the transport');
  }
});

test('a malformed recipient is refused before any transport is used', async () => {
  const { sent, messages } = await captureHandoffMail({ to: 'not-an-email' });
  assert.strictEqual(sent, false);
  assert.strictEqual(messages.length, 0);
});

test('the sender never throws, so one bad address cannot abort a batch', async () => {
  const fresh = require('../utils/email');
  const result = await withoutEmailConfig(() => fresh.sendAdminCredentialsEmail('target@example.com', {
    alias: 'AdminDevs',
    password: 'Devs101',
    totpSecret: 'ABCDEFGHIJKLMNOP',
  }));
  assert.strictEqual(result, false);
});

// ── The two channels must not drift into each other ──────────────────────

test('the recurring update notice still carries no secret after the hand-off was added', async () => {
  // The structural guarantee, re-asserted from this side. The hand-off exists to
  // carry secrets; the notice exists so that a *recurring* channel does not. If
  // a future change ever lets a password into the notice — the "helpful" extra
  // field this repo has been bitten by before — this fails.
  const nodemailer = require('nodemailer');
  const emailUtilsPath = require.resolve('../utils/email');

  const messages = [];
  const realCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (mail) => { messages.push(mail); return { accepted: [mail.to] }; },
    verify: async () => true,
    close: () => {},
  });

  const saved = {
    EMAIL_HOST: process.env.EMAIL_HOST,
    EMAIL_PORT: process.env.EMAIL_PORT,
    EMAIL_USER: process.env.EMAIL_USER,
    EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
  };
  process.env.EMAIL_HOST = 'localhost';
  process.env.EMAIL_PORT = '2525';
  process.env.EMAIL_USER = 'sender@example.com';
  process.env.EMAIL_PASSWORD = 'app-password';

  delete require.cache[emailUtilsPath];
  const fresh = require('../utils/email');
  // Deliberately pass secrets in. The notice must drop them on the floor.
  await fresh.sendAdminCredentialUpdateEmail('target@example.com', {
    alias: 'AdminDevs',
    description: DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION,
    password: 'Devs101',
    totpSecret: 'LN5T652PIVISUXSXKFFXWKCEIN6XKTBPJZIFWXTNMVOVAOD3PFKA',
  });

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  nodemailer.createTransport = realCreateTransport;
  delete require.cache[emailUtilsPath];

  const rendered = `${messages[0].html}\n${messages[0].text}`;
  assert.strictEqual(messages.length, 1);
  assert.doesNotMatch(rendered, /Devs101/, 'the notice must not pick up a password it was handed');
  assert.doesNotMatch(rendered, /LN5T652PIVISUXSXKFFXWKCEIN6XKTBPJZIFWXTNMVOVAOD3PFKA/, 'nor a seed');
  assert.match(rendered, /no password or authenticator key is ever sent by email/i, 'and must still say so');
});

// ── The fan-out ──────────────────────────────────────────────────────────

const ACCOUNTS = [
  // argon2id on purpose: the parameter block is comma-separated, so this also
  // re-proves the shared parser still survives a real hash.
  'AdminDevs|$argon2id$v=19$m=19456,t=2,p=1$salt$hash|LN5T652PIVISUXSXKFFXWKCEIN6XKT',
  'AdminPoli|$argon2id$v=19$m=19456,t=2,p=1$salt$hash|GVXWNR2K5KXIXL5IRZUEPSKIFFFKPDX',
  'AdminJoma|$argon2id$v=19$m=19456,t=2,p=1$salt$hash|AAAAAAAAAABBBBBBBBBBCCCCCCCCCC',
].join(',');

const ENV = {
  ADMIN_ACCOUNTS: ACCOUNTS,
  ADMIN_EMAILS: 'AdminDevs=a@example.com,AdminPoli=b@example.com,AdminJoma=c@example.com',
};

test('every alias is paired with its own key and its own password', async () => {
  // The load-bearing correctness property. A send that gave AdminPoli
  // AdminDevs's password, or two admins the same seed, would be worse than no
  // send at all: both would be locked out and neither would know why.
  const nodemailer = require('nodemailer');
  const emailUtilsPath = require.resolve('../utils/email');
  const { handoffAdminCredentials } = require('../utils/adminCredentialHandoff');

  const messages = [];
  const realCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (mail) => { messages.push(mail); return { accepted: [mail.to] }; },
    verify: async () => true,
    close: () => {},
  });

  const saved = {
    EMAIL_HOST: process.env.EMAIL_HOST,
    EMAIL_PORT: process.env.EMAIL_PORT,
    EMAIL_USER: process.env.EMAIL_USER,
    EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
  };
  process.env.EMAIL_HOST = 'localhost';
  process.env.EMAIL_PORT = '2525';
  process.env.EMAIL_USER = 'sender@example.com';
  process.env.EMAIL_PASSWORD = 'app-password';

  delete require.cache[emailUtilsPath];
  delete require.cache[require.resolve('../utils/adminCredentialHandoff')];
  const freshHandoff = require('../utils/adminCredentialHandoff');

  const report = await freshHandoff.handoffAdminCredentials({
    env: ENV,
    passwords: { AdminDevs: 'devs-pass', AdminPoli: 'poli-pass', AdminJoma: 'joma-pass' },
  });

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  nodemailer.createTransport = realCreateTransport;
  delete require.cache[emailUtilsPath];
  delete require.cache[require.resolve('../utils/adminCredentialHandoff')];

  assert.strictEqual(report.delivered.length, 3);
  assert.strictEqual(messages.length, 3);

  const expectations = [
    { to: 'a@example.com', alias: 'AdminDevs', password: 'devs-pass', seed: 'LN5T652PIVISUXSXKFFXWKCEIN6XKT' },
    { to: 'b@example.com', alias: 'AdminPoli', password: 'poli-pass', seed: 'GVXWNR2K5KXIXL5IRZUEPSKIFFFKPDX' },
    { to: 'c@example.com', alias: 'AdminJoma', password: 'joma-pass', seed: 'AAAAAAAAAABBBBBBBBBBCCCCCCCCCC' },
  ];
  for (const [index, expected] of expectations.entries()) {
    const mail = messages[index];
    assert.strictEqual(mail.to, expected.to, 'each alias must go to its own address');
    const body = `${mail.html}\n${mail.text}`;
    assert.match(body, new RegExp(expected.alias));
    assert.match(body, new RegExp(expected.password));
    assert.match(body, new RegExp(expected.seed));
  }

  // And nothing crossed over.
  assert.doesNotMatch(`${messages[0].html}${messages[0].text}`, /poli-pass|joma-pass/);
  assert.doesNotMatch(`${messages[1].html}${messages[1].text}`, /devs-pass|joma-pass/);
  assert.doesNotMatch(`${messages[2].html}${messages[2].text}`, /devs-pass|poli-pass/);
  assert.ok(handoffAdminCredentials, 'the fan-out is reachable');
});

test('an alias with no password supplied is reported, not silently skipped', async () => {
  // The gap that `adminAccountsMissingEmail` names for addresses, named here for
  // passwords. A run where the operator forgot one person must say so by name.
  const { handoffAdminCredentials } = require('../utils/adminCredentialHandoff');
  const report = await withoutEmailConfig(() => handoffAdminCredentials({
    env: ENV,
    passwords: { AdminDevs: 'devs-pass' },
  }));

  assert.strictEqual(report.recipients, 3);
  assert.deepStrictEqual(report.missingPassword.sort(), ['AdminJoma', 'AdminPoli']);
  assert.strictEqual(report.unusedPasswords.length, 0);
  // No SMTP config, so the one alias that WAS ready fails to send. The two that
  // were skipped are absent from `failed` — a skip is not a send that went
  // wrong, and the two states are what `missingPassword` exists to distinguish.
  assert.deepStrictEqual(report.failed.map((entry) => entry.alias), ['AdminDevs']);
  assert.strictEqual(report.ok, false, 'a rejected send is not ok');
  assert.strictEqual(report.delivered.length, 0);
});

test('a password supplied for an alias that will not be mailed is reported', async () => {
  // Almost always a typo in a --password flag. Silently ignoring it would read
  // to the operator as "that one was emailed" when that person got nothing.
  const { handoffAdminCredentials } = require('../utils/adminCredentialHandoff');
  const report = await withoutEmailConfig(() => handoffAdminCredentials({
    env: ENV,
    passwords: { AdminDev: 'typo-pass', AdminDevs: 'devs-pass' },
  }));

  assert.deepStrictEqual(report.unusedPasswords, ['AdminDev']);
  assert.deepStrictEqual(report.missingPassword.sort(), ['AdminJoma', 'AdminPoli']);
});

test('an alias with no authenticator key in .env is reported and not mailed', async () => {
  // A hand-off without the seed reaches an administrator who can then not
  // complete a sign-in. Refusing it outright is better than sending half.
  const { handoffAdminCredentials } = require('../utils/adminCredentialHandoff');
  const report = await withoutEmailConfig(() => handoffAdminCredentials({
    env: {
      ADMIN_ACCOUNTS: 'AdminDevs|$argon2id$v=19$m=19456,t=2,p=1$salt$hash|LN5T652PIVISUXSXKFFXWKCEIN6XKT',
      ADMIN_EMAILS: 'AdminDevs=a@example.com,AdminGhost=b@example.com',
    },
    passwords: { AdminDevs: 'devs-pass', AdminGhost: 'ghost-pass' },
  }));

  assert.deepStrictEqual(report.missingSecret, ['AdminGhost']);
  assert.deepStrictEqual(report.missingPassword, [], 'a missing key is reported as a key gap, not a password gap');
  assert.deepStrictEqual(report.unusedPasswords, ['AdminGhost']);
});

test('one failing address does not stop the rest of the batch', async () => {
  // The single most important property of any fan-out here. The person who is
  // NOT reached is the one who cannot sign in, and a batch that aborted on the
  // first failure would reliably leave the later aliases — quite possibly the
  // person who pressed the button — with no password at all.
  //
  // The accounts are declared as well as the addresses: without an authenticator
  // key in .env an alias is refused before the send (see the missingSecret test
  // below), so a batch with no accounts would have nothing to attempt and would
  // "pass" this while testing nothing.
  const { handoffAdminCredentials } = require('../utils/adminCredentialHandoff');
  const accounts = ['A', 'B', 'C', 'D']
    .map((alias) => `${alias}|$argon2id$v=19$m=19456,t=2,p=1$salt$hash|SEEDFOR${alias}`)
    .join(',');

  const report = await withoutEmailConfig(() => handoffAdminCredentials({
    env: {
      ADMIN_ACCOUNTS: accounts,
      ADMIN_EMAILS: 'A=a@example.com,B=b@example.com,C=c@example.com,D=d@example.com',
    },
    passwords: { A: 'a', B: 'b', C: 'c', D: 'd' },
  }));

  assert.strictEqual(report.recipients, 4, 'all four configured addresses are attempted');
  assert.deepStrictEqual(report.missingPassword, [], 'every alias had a password, so none was skipped');
  assert.deepStrictEqual(report.missingSecret, [], 'every alias had a key, so none was refused');
  assert.strictEqual(report.failed.length, 4, 'with no SMTP config all four fail');
  // Order preserved, so the last alias in .env is not the one that gets
  // abandoned.
  assert.deepStrictEqual(report.failed.map((entry) => entry.alias), ['A', 'B', 'C', 'D']);
  assert.strictEqual(report.ok, false, 'four failures is not ok');
});

test('an empty address list is reported as unconfigured, not as a silent success', async () => {
  const { handoffAdminCredentials } = require('../utils/adminCredentialHandoff');
  const report = await withoutEmailConfig(() => handoffAdminCredentials({
    env: { ADMIN_EMAILS: '' },
    passwords: { AdminDevs: 'devs-pass' },
  }));
  assert.strictEqual(report.unconfigured, true);
  assert.strictEqual(report.recipients, 0);
  assert.strictEqual(report.ok, false);
  assert.deepStrictEqual(report.delivered, []);
});

test('the report carries the wording that was actually used', async () => {
  const { handoffAdminCredentials } = require('../utils/adminCredentialHandoff');
  const report = await withoutEmailConfig(() => handoffAdminCredentials({
    env: { ADMIN_EMAILS: 'A=a@example.com' },
    passwords: { A: 'a' },
    description: 'Re-issued on Tuesday.',
  }));
  assert.strictEqual(report.description, 'Re-issued on Tuesday.');
});

test('a blank description resolves to the default, not to an empty string', async () => {
  const { handoffAdminCredentials } = require('../utils/adminCredentialHandoff');
  const report = await withoutEmailConfig(() => handoffAdminCredentials({
    env: { ADMIN_EMAILS: 'A=a@example.com' },
    passwords: { A: 'a' },
    description: '   ',
  }));
  assert.strictEqual(report.description, DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION);
});

test('a password containing shell-hostile characters survives the pairing', async () => {
  // `,`, `|` and `=` are the delimiters this project uses everywhere else in
  // .env, so a password containing one is the case a packed format would break
  // on. The object-based input has no delimiter, and this pins that.
  const { handoffAdminCredentials } = require('../utils/adminCredentialHandoff');
  const report = await withoutEmailConfig(() => handoffAdminCredentials({
    env: ENV,
    passwords: { AdminDevs: 'a,b|c=d$e&f<g>' },
  }));
  // No SMTP config, so nothing is delivered — but the alias was ready, which is
  // the part this asserts: the value was not mistaken for a delimiter.
  assert.deepStrictEqual(report.missingPassword.sort(), ['AdminJoma', 'AdminPoli']);
  assert.deepStrictEqual(report.unusedPasswords, []);
});

// ── The pure helpers ─────────────────────────────────────────────────────

test('normalisePasswords drops a blank value rather than storing an empty password', async () => {
  // The difference between "not supplied" and "supplied as empty" is what lets
  // the report say something actionable, so the two must not collapse.
  const out = normalisePasswords({ A: 'real', B: '', C: '   ', D: null, E: 42 });
  assert.deepStrictEqual([...out.entries()], [['A', 'real'], ['E', '42']]);
});

test('normalisePasswords keeps leading and trailing spaces in a real password', async () => {
  // Spaces are characters the administrator chose. Trimming would mail them a
  // password that does not work.
  const out = normalisePasswords({ A: ' spaced out ' });
  assert.strictEqual(out.get('A'), ' spaced out ');
});

test('normalisePasswords accepts the pair and object forms the two callers build', async () => {
  // The route receives JSON, the script accumulates flags. Both must land as the
  // same map, or the button and the terminal would disagree.
  const fromObject = normalisePasswords({ AdminDevs: 'p1' });
  const fromPairs = normalisePasswords([['AdminDevs', 'p1']]);
  const fromEntries = normalisePasswords([{ alias: 'AdminDevs', password: 'p1' }]);
  assert.deepStrictEqual([...fromPairs], [...fromObject]);
  assert.deepStrictEqual([...fromEntries], [...fromObject]);
});

test('indexAccountsByAlias prefers an exact match over a case-folded one', async () => {
  // Case-folding is a convenience for a typing error, so it must never override a
  // real match. With two accounts differing only in case, each resolves to
  // itself rather than both to whichever was seen first.
  const { exact, lowered } = indexAccountsByAlias([
    { alias: 'AdminDevs', totpSecret: 'FIRST' },
    { alias: 'admindevs', totpSecret: 'SECOND' },
  ]);
  assert.strictEqual(exact.get('AdminDevs').totpSecret, 'FIRST');
  assert.strictEqual(exact.get('admindevs').totpSecret, 'SECOND');
  assert.strictEqual(lowered.get('admindevs').totpSecret, 'FIRST', 'folding keeps the first');
});

test('maskEmail never returns a full address', async () => {
  // Logs are shared, so a recipient is only ever identifiable by domain.
  assert.strictEqual(maskEmail('devs@example.com'), 'd***@example.com');
  assert.strictEqual(maskEmail('not-an-email'), '[invalid]');
  assert.strictEqual(maskEmail(''), '[invalid]');
});
