'use strict';
/**
 * Route-level tests for POST /api/admin/admins/credential-delivery.
 *
 * The unit tests in admin-credential-delivery.test.js pin the pairing and the
 * fan-out. These pin what only a real HTTP call can prove:
 *
 *   1. The route is registered, and reaches the client through the admin auth
 *      middleware — an unwired route looks identical to a working one right up
 *      until somebody presses the button.
 *   2. The step-up gate is in front of the send, not after it. An invalid code
 *      must produce ZERO attempted mails.
 *   3. The response body carries no authenticator key and no address. That is
 *      the whole security property of the feature: it mails secrets, and must
 *      not echo them into a browser.
 *
 * Models and the mailer are stubbed. No database is touched and, critically, no
 * email is sent — the real recipients are six live mailboxes.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const express = require('express');
const mongoose = require('mongoose');
const totpRfc = require('../utils/totpRfc');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'route-test-secret-not-a-real-one';
process.env.EMAIL_USER = 'smtp@example.com';
process.env.EMAIL_PASSWORD = 'app-password';
// Pinned for the test aliases, not inherited from .env: the route resolves
// recipients through ADMIN_EMAILS, so leaving the real value in place would make
// these assertions depend on who happens to be configured on this machine — and
// would point a passing test at six live mailboxes.
process.env.ADMIN_EMAILS = 'AdminDevs=devs@example.com,AdminPoli=poli@example.com,AdminJoma=joma@example.com';

const { stubQuery } = require('./stubQuery');

const CALLER_ID = new mongoose.Types.ObjectId();
// The caller's seed must be a genuine base32 value: verifyTotpOnce decodes it with
// the in-repo RFC 6238 module, and a code that does not verify would test the
// guard rather than the
// route. It is FRESH PER TEST because the replay cache is process-global and keyed
// on (scope, secret, code) — a fixed seed would let the first test consume the
// code and every later test would answer 401 for the wrong reason.
let CALLER_SECRET = 'JBSWY3DPEHPK3PXPAAAAAAAAAAAA';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function freshSecret() {
  return Array.from({ length: 32 }, () => BASE32_ALPHABET[crypto.randomInt(32)]).join('');
}

const adminAccountsPath = require.resolve('../models/AdminAccount');
const adminEventsPath = require.resolve('../models/AdminEvent');
const emailUtilsPath = require.resolve('../utils/email');

/**
 * Load routes/admin.js with the models it uses replaced, mount it behind a stub
 * of the real `protect, adminOnly` pair, and hand the caller a fetch helper.
 *
 * @param {object} config
 * @param {Array}  [config.accounts]      documents GET-side `find()` returns
 * @param {object} [config.caller]        document `findById()` returns
 * @param {boolean}[config.emailConfigured]
 */
async function withAdminRouter(config, run) {
  const AdminAccount = require(adminAccountsPath);
  const AdminEvent = require(adminEventsPath);
  const emailUtils = require(emailUtilsPath);
  // routes/admin.js registers `router.use(protect, adminOnly)` at line 65, so the
  // prefix is authenticated by the router ITSELF — a middleware mounted ahead of
  // it in the test app never gets first say. Overriding the middleware module
  // BEFORE requiring the router is the faithful way in: `protect`'s own behaviour
  // (token parsing, session death, lockout) is covered by
  // admin-session-expiry.test.js; what this file tests is the route behind it.
  const authMiddleware = require('../middleware/auth');
  const originalProtect = authMiddleware.protect;
  const originalAdminOnly = authMiddleware.adminOnly;

  const sent = [];
  const audits = [];

  const originals = {
    findById: AdminAccount.findById,
    find: AdminAccount.find,
    create: AdminEvent.create,
    send: emailUtils.sendAdminCredentialEmail,
    envUser: process.env.EMAIL_USER,
    envPass: process.env.EMAIL_PASSWORD,
  };

  AdminAccount.findById = () => stubQuery(() => (config.caller === undefined ? null : config.caller));
  AdminAccount.find = () => {
    const rows = config.accounts || [];
    const query = {
      sort: () => query,
      limit: () => query,
      select: () => query,
      lean: async () => rows.map((row) => ({ ...row })),
      then: (onFulfilled) => Promise.resolve(rows).then(onFulfilled),
    };
    return query;
  };
  AdminEvent.create = (payload) => { audits.push(payload); return Promise.resolve({}); };
  emailUtils.sendAdminCredentialEmail = async (to, context) => {
    sent.push({ to, key: context.authenticatorKey, alias: context.alias });
    return true;
  };
  if (config.emailConfigured === false) {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASSWORD;
  }

  authMiddleware.protect = (req, res, next) => {
    req.user = { _id: String(CALLER_ID), alias: 'AdminDevs', role: 'admin' };
    next();
  };
  authMiddleware.adminOnly = (req, res, next) => next();

  delete require.cache[require.resolve('../routes/admin')];
  const adminRouter = require('../routes/admin');

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (body) => {
    const res = await fetch(`${base}/api/admin/admins/credential-delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json;
    try { json = await res.json(); } catch { json = {}; }
    return { status: res.status, body: json };
  };

  try {
    return await run({ call, sent, audits });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    AdminAccount.findById = originals.findById;
    AdminAccount.find = originals.find;
    AdminEvent.create = originals.create;
    emailUtils.sendAdminCredentialEmail = originals.send;
    authMiddleware.protect = originalProtect;
    authMiddleware.adminOnly = originalAdminOnly;
    process.env.EMAIL_USER = originals.envUser;
    process.env.EMAIL_PASSWORD = originals.envPass;
    delete require.cache[require.resolve('../routes/admin')];
  }
}

/**
 * Give the test a caller seed of its own.
 *
 * The replay cache in utils/totp.js is process-global and keyed on
 * (scope, secret, code), so a fixed seed lets the first test consume the current
 * time-step's code and makes every later test fail the guard for a reason that
 * has nothing to do with what it is asserting. Minting per test — and BEFORE the
 * caller document is built, so the document and the code cannot disagree — is the
 * only reliable way to drive a TOTP-gated route.
 */
const prepare = () => { CALLER_SECRET = freshSecret(); return CALLER_SECRET; };
const currentCode = () => totpRfc.totp({ secret: CALLER_SECRET, encoding: 'base32' });

const callerDoc = () => ({ _id: CALLER_ID, alias: 'AdminDevs', totpSecret: CALLER_SECRET });

const healthyAccounts = () => ([
  { _id: CALLER_ID, alias: 'AdminDevs', enabled: true, totpSecret: CALLER_SECRET },
  { _id: new mongoose.Types.ObjectId(), alias: 'AdminPoli', enabled: true, totpSecret: 'KRSXG5CTMVRXEZLUBBBBBBBBBBBB' },
]);

// ── 1. The step-up gate ────────────────────────────────────────────────────

test('a missing authenticator code is refused before anything is read', async () => {
  prepare();
  await withAdminRouter({ caller: callerDoc(), accounts: healthyAccounts() }, async ({ call, sent }) => {
    const res = await call({});
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'OTP_REQUIRED');
    assert.strictEqual(sent.length, 0);
  });
});

test('a wrong authenticator code sends no mail', async () => {
  prepare();
  await withAdminRouter({ caller: callerDoc(), accounts: healthyAccounts() }, async ({ call, sent, audits }) => {
    const res = await call({ otp: '000000' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'OTP_INVALID');
    assert.strictEqual(sent.length, 0, 'the guard sits in front of the fan-out');
    assert.strictEqual(audits.length, 0, 'a refused step-up is not a delivery');
  });
});

test('a non-6-digit code is refused as a malformed request', async () => {
  prepare();
  await withAdminRouter({ caller: callerDoc(), accounts: healthyAccounts() }, async ({ call, sent }) => {
    const res = await call({ otp: '12345' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(sent.length, 0);
  });
});

// ── 2. The successful path ─────────────────────────────────────────────────

test('a valid code delivers one mail per reachable administrator', async () => {
  prepare();
  await withAdminRouter({ caller: callerDoc(), accounts: healthyAccounts() }, async ({ call, sent, audits }) => {
    const res = await call({ otp: currentCode() });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(sent.length, 2);
    assert.deepStrictEqual(sent.map(entry => entry.alias).sort(), ['AdminDevs', 'AdminPoli']);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].type, 'security');
    assert.match(audits[0].detail, /2 of 2/);
  });
});

test('the response never carries a key, a hash, or a full address', async () => {
  prepare();
  await withAdminRouter({ caller: callerDoc(), accounts: healthyAccounts() }, async ({ call }) => {
    const res = await call({ otp: currentCode() });
    const wire = JSON.stringify(res.body);
    assert.doesNotMatch(wire, /JBSWY3DPEHPK3PXP|KRSXG5CTMVRXEZLU/, 'authenticator seeds stay out of the response');
    assert.doesNotMatch(wire, /argon2|\$2[aby]\$/, 'no password hash rides along');
    // .env has no mapping for these test aliases, so the address fields are the
    // masked/empty ones the util produced — never a bare mailbox.
    assert.doesNotMatch(wire, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });
});

test('an admin whose seed is not a key is reported and not mailed', async () => {
  const corrupted = 'LMQVI5D5GUXGMSSQKJRDSTTCPJJFA3C3,t=2,p=1$sEv0l9enNLLqSB77DFjMfQ$i7pYWE';
  prepare();
  await withAdminRouter(
    {
      caller: callerDoc(),
      accounts: [
        { _id: CALLER_ID, alias: 'AdminDevs', enabled: true, totpSecret: CALLER_SECRET },
        { _id: new mongoose.Types.ObjectId(), alias: 'AdminJoma', enabled: true, totpSecret: corrupted },
      ],
    },
    async ({ call, sent }) => {
      const res = await call({ otp: currentCode() });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(sent.length, 1, 'the malformed seed is not handed to a recipient');
      assert.strictEqual(res.body.totals.unusableKey, 1);
      assert.deepStrictEqual(res.body.unusableKey, ['AdminJoma']);
    }
  );
});

test('an administrator with no address is reported, not silently omitted', async () => {
  prepare();
  await withAdminRouter(
    {
      caller: callerDoc(),
      accounts: [
        { _id: CALLER_ID, alias: 'AdminDevs', enabled: true, totpSecret: CALLER_SECRET },
        { _id: new mongoose.Types.ObjectId(), alias: 'AdminNobody', enabled: true, totpSecret: 'MYHEXORBASE32SEEDABCDEFGHIJKLMNOPQRS' },
      ],
    },
    async ({ call, sent }) => {
      const res = await call({ otp: currentCode() });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(res.body.totals.missingEmail, 1);
    }
  );
});

// ── 3. The honest failure paths ────────────────────────────────────────────

test('no reachable administrator is a 400 that explains itself', async () => {
  prepare();
  await withAdminRouter(
    { caller: callerDoc(), accounts: [{ _id: CALLER_ID, alias: 'AdminDevs', enabled: true, totpSecret: '' }] },
    async ({ call, sent }) => {
      const res = await call({ otp: currentCode() });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, 'NO_RECIPIENTS');
      assert.strictEqual(sent.length, 0);
    }
  );
});

test('an unconfigured mail service is refused before the collection is read', async () => {
  prepare();
  await withAdminRouter(
    { caller: callerDoc(), accounts: healthyAccounts(), emailConfigured: false },
    async ({ call, sent }) => {
      const res = await call({ otp: currentCode() });
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.code, 'EMAIL_UNCONFIGURED');
      assert.strictEqual(sent.length, 0);
    }
  );
});

test('a delivery in which every send is refused answers 502 with the reasons', async () => {
  prepare();
  await withAdminRouter({ caller: callerDoc(), accounts: healthyAccounts() }, async ({ call, sent }) => {
    // Replace the succeeding stub with a transport that refuses everything,
    // after the router is mounted but before the request is made.
    require(emailUtilsPath).sendAdminCredentialEmail = async (to) => { sent.push({ to, refused: true }); return false; };
    const res = await call({ otp: currentCode() });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.body.code, 'DELIVERY_FAILED');
    assert.strictEqual(res.body.totals.delivered, 0);
    assert.strictEqual(res.body.totals.failed, 2);
    assert.ok(res.body.report.failed[0].email.includes('***'), 'even a failure report masks the address');
  });
});
