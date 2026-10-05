'use strict';
/**
 * Route tests for the one-time credential hand-off.
 *
 * The fan-out's own behaviour is pinned in admin-credential-handoff.test.js, and
 * the two templates in admin-credential-notice.test.js. What is left — and what
 * this file covers — is the HTTP surface, and it has three properties the unit
 * tests cannot see:
 *
 *   1. It is behind `protect, adminOnly`, like every other route in this file.
 *   2. It refuses a caller-supplied recipient list. Without that guard an
 *      admin-only route becomes an open relay that will email live passwords to
 *      an address the caller chose, with an audit row naming the admin who
 *      pressed the button.
 *   3. Nothing it sends back — response, audit row or error message — contains a
 *      password or an authenticator key. The values go out to the mailbox and
 *      nowhere else.
 *
 * The router is re-required per test so the module-private cooldown is fresh;
 * otherwise the first successful send would 429 every later test.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

// Loaded before the router, for the same reason withResetRouter.js does it: a
// `node --test` process does not inherit server/.env the way index.js does, and
// these routes read ADMIN_EMAILS / ADMIN_ACCOUNTS from process.env.
require('dotenv').config();

const ACCOUNTS = [
  'AdminDevs|$argon2id$v=19$m=19456,t=2,p=1$salt$hash|LN5T652PIVISUXSXKFFXWKCEIN6XKT',
  'AdminPoli|$argon2id$v=19$m=19456,t=2,p=1$salt$hash|GVXWNR2K5KXIXL5IRZUEPSKIFFFKPDX',
].join(',');

const ADMIN_EMAILS = 'AdminDevs=a@example.com,AdminPoli=b@example.com';

const REAL_SEED = 'LN5T652PIVISUXSXKFFXWKCEIN6XKT';
const REAL_PASSWORD = 'Devs101';

// Every value that must never appear in a response, an error body or an audit
// row. Asserted against all three below.
const SECRETS = [REAL_PASSWORD, REAL_SEED, 'argon2id', '$argon2id$'];

/**
 * Mount the real admin router behind stubbed auth, with SMTP stubbed, and run
 * `fn(ctx)` against it.
 *
 * `protect`/`adminOnly` are destructured at require time, so patching the
 * middleware module's exports BEFORE requiring the router is what makes this
 * work — patching afterwards would leave the router holding the real ones.
 */
async function withHandoffRouter(options = {}, fn) {
  const auth = require('../middleware/auth');
  const nodemailer = require('nodemailer');
  const AdminEvent = require('../models/AdminEvent');
  const routerPath = require.resolve('../routes/admin');
  const authPath = require.resolve('../middleware/auth');

  const originals = {
    protect: auth.protect,
    adminOnly: auth.adminOnly,
    createTransport: nodemailer.createTransport,
    create: AdminEvent.create,
    env: {
      ADMIN_EMAILS: process.env.ADMIN_EMAILS,
      ADMIN_ACCOUNTS: process.env.ADMIN_ACCOUNTS,
      EMAIL_USER: process.env.EMAIL_USER,
      EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
    },
  };

  const sent = [];
  const events = [];

  // Auth passes through, but pins the acting administrator so `triggeredBy` and
  // the audit row can be asserted the way a real request would fill them.
  const fakeReq = { user: { alias: 'AdminDevs', role: 'admin' } };
  auth.protect = (req, res, next) => { req.user = fakeReq.user; next(); };
  auth.adminOnly = (req, res, next) => next();

  nodemailer.createTransport = () => ({
    sendMail: async (mail) => {
      sent.push(mail);
      // `options.failFor` lets one address be rejected, to reach the 207 path.
      if (options.failFor && options.failFor.includes(mail.to)) {
        throw new Error('smtp refused');
      }
      return { messageId: 'stub', accepted: [mail.to] };
    },
    verify: async () => true,
    close: () => {},
  });
  AdminEvent.create = async (row) => { events.push(row); return row; };

  process.env.ADMIN_EMAILS = ADMIN_EMAILS;
  process.env.ADMIN_ACCOUNTS = ACCOUNTS;
  // A configured transport, or every send short-circuits at getTransporter() and
  // the success path below would be unreachable.
  process.env.EMAIL_USER = 'sender@example.com';
  process.env.EMAIL_PASSWORD = 'app-password';

  delete require.cache[routerPath];
  delete require.cache[require.resolve('../utils/email')];
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require(routerPath));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, body) => {
    const res = await fetch(`${base}/api/admin${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };

  try {
    return await fn({ call, sent, events });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    auth.protect = originals.protect;
    auth.adminOnly = originals.adminOnly;
    nodemailer.createTransport = originals.createTransport;
    AdminEvent.create = originals.create;
    for (const [key, value] of Object.entries(originals.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[routerPath];
    delete require.cache[require.resolve('../utils/email')];
  }
}

// ── The preview ──────────────────────────────────────────────────────────

test('the preview lists the aliases and says they carry secrets, but never a seed', async () => {
  await withHandoffRouter({}, async ({ call }) => {
    const { status, body } = await call('/admins/credential-handoff/preview');
    assert.strictEqual(status, 200);

    assert.strictEqual(body.carriesSecrets, true, 'the UI must be able to warn before typing');
    assert.strictEqual(body.rotatesCredentials, false, 'and must not imply anything is rotated');
    assert.strictEqual(
      body.description,
      "I'll Updated Your Credentials With Upgraded Version of Encryption"
    );
    assert.deepStrictEqual(
      body.recipients.map(r => r.alias),
      ['AdminDevs', 'AdminPoli']
    );
    // Readiness only. The boolean is what the dialog needs; the key is not.
    assert.deepStrictEqual(body.recipients.map(r => r.hasTotpSecret), [true, true]);
    for (const entry of body.recipients) {
      assert.strictEqual(entry.totpSecret, undefined, 'a key must never be in a response');
    }
    assert.doesNotMatch(JSON.stringify(body), new RegExp(REAL_SEED));
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────

test('a request with no passwords is refused with an explanation', async () => {
  await withHandoffRouter({}, async ({ call, sent }) => {
    // The single most likely operator mistake: not knowing that .env holds a
    // one-way hash. A bare 400 would read as "the server is broken".
    for (const body of [{}, { passwords: null }, { passwords: [] }, { passwords: 'Devs101' }]) {
      const res = await call('/admins/credential-handoff', body);
      assert.strictEqual(res.status, 400, `${JSON.stringify(body)} must be refused`);
      assert.match(res.body.message, /one-way hash|cannot read them back|must be an object/);
    }
    assert.strictEqual(sent.length, 0, 'nothing may be sent');
  });
});

test('an all-blank password map is refused rather than sending empty credentials', async () => {
  await withHandoffRouter({}, async ({ call, sent }) => {
    const res = await call('/admins/credential-handoff', { passwords: { AdminDevs: '', AdminPoli: '   ' } });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /No usable password/);
    assert.strictEqual(sent.length, 0);
  });
});

test('a caller-supplied recipient list is refused', async () => {
  // The open-relay guard. Without it this route would email live passwords to
  // any address an authenticated admin named, and write an audit row making it
  // look like a legitimate send.
  await withHandoffRouter({}, async ({ call, sent }) => {
    for (const body of [
      { passwords: { AdminDevs: REAL_PASSWORD }, to: 'attacker@example.com' },
      { passwords: { AdminDevs: REAL_PASSWORD }, recipients: ['attacker@example.com'] },
    ]) {
      const res = await call('/admins/credential-handoff', body);
      assert.strictEqual(res.status, 400);
      assert.match(res.body.message, /configured on the server/);
    }
    assert.strictEqual(sent.length, 0, 'nothing may be sent to the supplied address');
  });
});

// ── A successful send ────────────────────────────────────────────────────

test('a send delivers each alias its own password and key, and leaks neither', async () => {
  await withHandoffRouter({}, async ({ call, sent, events }) => {
    const res = await call('/admins/credential-handoff', {
      passwords: { AdminDevs: REAL_PASSWORD, AdminPoli: 'Poli2024' },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.delivered.length, 2);
    assert.strictEqual(sent.length, 2);

    // Each alias got its OWN password and its OWN key. A crossed-over send would
    // lock out both administrators with no way to tell what happened.
    assert.strictEqual(sent[0].to, 'a@example.com');
    assert.match(sent[0].html, new RegExp(REAL_PASSWORD));
    assert.match(sent[0].html, new RegExp(REAL_SEED));
    assert.match(sent[1].html, /Poli2024/);
    assert.match(sent[1].html, /GVXWNR2K5KXIXL5IRZUEPSKIFFFKPDX/);
    assert.doesNotMatch(`${sent[0].html}${sent[0].text}`, /Poli2024/);
    assert.doesNotMatch(`${sent[1].html}${sent[1].text}`, new RegExp(REAL_PASSWORD));

    // The default wording reached both recipients.
    assert.match(sent[0].html, /Upgraded Version of Encryption/);

    // The audit row records who and how many — never a value.
    assert.strictEqual(events.length, 1);
    assert.match(events[0].title, /credentials sent by email/i);
    assert.match(events[0].detail, /2 of 2 delivered by AdminDevs/);
    for (const secret of SECRETS) {
      assert.doesNotMatch(JSON.stringify(events), new RegExp(secret), `the audit row must not hold ${secret}`);
    }
  });
});

test('the response body carries no password, key or hash', async () => {
  await withHandoffRouter({}, async ({ call }) => {
    const res = await call('/admins/credential-handoff', {
      passwords: { AdminDevs: REAL_PASSWORD, AdminPoli: 'Poli2024' },
    });
    const serialised = JSON.stringify(res.body);
    // The response is the one thing the operator's browser keeps around, so it
    // is the last place a value could quietly survive.
    assert.doesNotMatch(serialised, new RegExp(REAL_PASSWORD));
    assert.doesNotMatch(serialised, new RegExp(REAL_SEED));
    assert.doesNotMatch(serialised, /argon2id/);
  });
});

test('an alias left blank is reported by name rather than counted as a failure', async () => {
  await withHandoffRouter({}, async ({ call, sent }) => {
    const res = await call('/admins/credential-handoff', { passwords: { AdminDevs: REAL_PASSWORD } });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(sent.length, 1, 'only the alias that was filled in is sent');
    assert.deepStrictEqual(res.body.missingPassword, ['AdminPoli']);
    // A skip is not a rejected send, so it must not drag the status to 207 and
    // it must not appear in `failed` — otherwise the console would show
    // AdminPoli as "not reached", implying a bounce.
    assert.deepStrictEqual(res.body.failed, []);
    assert.strictEqual(res.body.ok, true);
  });
});

test('a rejected address is reported as 207, not as a 200 success', async () => {
  await withHandoffRouter({ failFor: ['b@example.com'] }, async ({ call }) => {
    const res = await call('/admins/credential-handoff', {
      passwords: { AdminDevs: REAL_PASSWORD, AdminPoli: 'Poli2024' },
    });

    assert.strictEqual(res.status, 207, 'a partial send must not read as a full one');
    assert.strictEqual(res.body.ok, false);
    assert.deepStrictEqual(res.body.delivered.map(a => a.alias), ['AdminDevs']);
    assert.deepStrictEqual(res.body.failed.map(a => a.alias), ['AdminPoli']);
    assert.match(res.body.message, /1 of 2/);
  });
});

test('a cooldown stops a second hand-off going out while the first is in flight', async () => {
  // A duplicate here is not a confusing message — it is a second copy of live
  // credentials in a forwarding rule somewhere, and mail cannot be recalled.
  await withHandoffRouter({}, async ({ call, sent }) => {
    const first = await call('/admins/credential-handoff', { passwords: { AdminDevs: REAL_PASSWORD } });
    assert.strictEqual(first.status, 200);

    const second = await call('/admins/credential-handoff', { passwords: { AdminDevs: REAL_PASSWORD } });
    assert.strictEqual(second.status, 429);
    assert.ok(second.body.retryAfterSeconds > 0, 'the operator is told how long to wait');
    assert.strictEqual(sent.length, 1, 'the second request must not send anything');
  });
});

test('a rejected request does not start the cooldown', async () => {
  // A 400 must not lock the operator out of the hand-off they were trying to
  // make — otherwise one typo costs ten minutes.
  await withHandoffRouter({}, async ({ call, sent }) => {
    const bad = await call('/admins/credential-handoff', { passwords: {} });
    assert.strictEqual(bad.status, 400);

    const good = await call('/admins/credential-handoff', { passwords: { AdminDevs: REAL_PASSWORD } });
    assert.strictEqual(good.status, 200, 'the cooldown must only start on a real attempt');
    assert.strictEqual(sent.length, 1);
  });
});

test('an empty ADMIN_EMAILS is reported as unconfigured, not as a silent success', async () => {
  await withHandoffRouter({}, async ({ call, sent, events }) => {
    // Empty the list after the harness has set it up.
    process.env.ADMIN_EMAILS = '';
    try {
      const res = await call('/admins/credential-handoff', { passwords: { AdminDevs: REAL_PASSWORD } });
      assert.strictEqual(res.status, 400);
      assert.match(res.body.message, /No administrator email addresses are configured/);
      assert.strictEqual(res.body.unconfigured, true);
      assert.strictEqual(sent.length, 0);
      assert.strictEqual(events.length, 0, 'a send that never ran writes no audit row');
    } finally {
      process.env.ADMIN_EMAILS = ADMIN_EMAILS;
    }
  });
});
