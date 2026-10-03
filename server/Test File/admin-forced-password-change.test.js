'use strict';
/**
 * Tests for the forced admin password change.
 *
 * The property that matters is the SERVER one: while `mustChangePassword` is
 * set, an authenticated admin must not be able to reach the dashboard, the user
 * list, or any mutating route. A client-side redirect alone would not hold — by
 * the time the admin is authenticated the JWT is already valid, so anything
 * that skips the browser (curl, a stale tab, a token copied elsewhere) would
 * otherwise walk straight into /api/admin.
 *
 * These exercise the real middleware against a real express app with a stubbed
 * AdminAccount model, so the allowlist is checked as the router sees it
 * (baseUrl + path) rather than as a hand-written string.
 */
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Stub the model BEFORE the middleware is required, so `protect` binds to this.
const ADMIN_ID = '507f1f77bcf86cd799439011';
const state = { account: null, saved: null, log: [] };
// One stub for the WHOLE file, covering every access shape routes/admin.js and
// middleware/auth.js use. Anything left unstubbed is a real mongoose call that
// buffers against an absent connection and surfaces as an opaque "buffering
// timed out" 500 - which looks like the route under test failing.
const adminDoc = () => ({
  _id: ADMIN_ID,
  ...state.account,
  save: async function () { state.saved = this; },
});
const AdminAccount = {
  findById: () => ({ select: () => ({ then: (res) => res(adminDoc()) }) }),
  findOne: () => ({ select: () => ({ then: (res) => res(adminDoc()) }) }),
  findByIdAndUpdate: () => ({ exec: async () => ({}) }),
  updateOne: () => ({ exec: async () => ({}) }),
};

const Module = require('module');
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request.endsWith('models/AdminAccount') || request === '../models/AdminAccount') return AdminAccount;
  if (request === 'jsonwebtoken') return jwt;
  return originalLoad.apply(this, arguments);
};

const { protect, PASSWORD_CHANGE_REQUIRED, PASSWORD_CHANGE_ALLOWLIST, mayChangePassword } = require('../middleware/auth');
const { evaluatePassword } = require('../utils/passwordRules');
const { hashPassword, verifyPassword } = require('../utils/password');

// The loader patch stays installed for the WHOLE file on purpose. Restoring it
// after the first require left routes/admin.js resolving the real mongoose
// model, whose findOne() then buffered against an absent connection and surfaced
// as `adminaccounts.findOne() buffering timed out` — a 500 that looked like the
// change-password route failing when the route was never reached. Every module
// in this file resolves AdminAccount through the stub, which is the intent.
process.on('exit', () => { Module._load = originalLoad; });

const SECRET = 'test-only-signing-key';
process.env.JWT_SECRET = SECRET;

function app() {
  const a = express();
  a.use(express.json());
  const router = express.Router();
  router.use(protect);
  router.get('/overview', (req, res) => res.json({ ok: true }));
  router.get('/users', (req, res) => res.json({ ok: true }));
  router.post('/users', (req, res) => res.json({ ok: true }));
  router.get('/session-status', (req, res) => res.json({ ok: true }));
  router.patch('/profile/password', (req, res) => res.json({ ok: true }));
  router.get('/profile/password', (req, res) => res.json({ ok: true }));
  router.patch('/profile/password/extra', (req, res) => res.json({ ok: true }));
  router.delete('/session-status', (req, res) => res.json({ ok: true }));
  a.use('/api/admin', router);
  return a;
}

// Minimal request driver — no supertest dependency needed for four routes.
function call(server, method, path, token) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const http = require('http');
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* non-JSON is still a result */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function token() {
  return jwt.sign({ id: ADMIN_ID, role: 'admin', alias: 'AdminDevs', adminId: ADMIN_ID }, SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}

test('the allowlist is exact method+path, never a prefix', () => {
  const mk = (method, path) => ({ method, baseUrl: '/api/admin', path });
  assert.strictEqual(mayChangePassword(mk('PATCH', '/profile/password')), true);
  assert.strictEqual(mayChangePassword(mk('GET', '/session-status')), true);
  // A prefix rule would let every one of these through.
  assert.strictEqual(mayChangePassword(mk('PATCH', '/profile/password/extra')), false);
  assert.strictEqual(mayChangePassword(mk('GET', '/profile/password')), false);
  assert.strictEqual(mayChangePassword(mk('DELETE', '/session-status')), false);
  assert.strictEqual(mayChangePassword(mk('PATCH', '/profile')), false);
  assert.strictEqual(mayChangePassword(mk('GET', '/overview')), false);
  assert.strictEqual(mayChangePassword(mk('POST', '/users')), false);
  // Trailing slash is the same route, not a different one.
  assert.strictEqual(mayChangePassword(mk('PATCH', '/profile/password/')), true);
  assert.strictEqual(PASSWORD_CHANGE_ALLOWLIST.has('GET /api/admin/overview'), false);
});

test('a gated admin is refused everywhere except the change and the policy', async (t) => {
  const server = app().listen(0);
  t.after(() => server.close());
  state.account = { alias: 'AdminDevs', enabled: true, lastActivityAt: new Date(), mustChangePassword: true };
  const tok = token();

  for (const [method, path] of [['GET', '/api/admin/overview'], ['GET', '/api/admin/users'], ['POST', '/api/admin/users']]) {
    const r = await call(server, method, path, tok);
    assert.strictEqual(r.status, 403, method + ' ' + path + ' must be refused');
    assert.strictEqual(r.body.code, PASSWORD_CHANGE_REQUIRED);
    assert.strictEqual(r.body.mustChangePassword, true);
  }

  // The two the account is allowed to reach.
  assert.strictEqual((await call(server, 'GET', '/api/admin/session-status', tok)).status, 200);
  assert.strictEqual((await call(server, 'PATCH', '/api/admin/profile/password', tok)).status, 200);
});

test('a gated admin is refused even with a valid, unexpired token', async (t) => {
  const server = app().listen(0);
  t.after(() => server.close());
  state.account = { alias: 'AdminDevs', enabled: true, lastActivityAt: new Date(), mustChangePassword: true };

  const r = await call(server, 'GET', '/api/admin/overview', token());
  // The distinction that matters: 403, not 401. A 401 tells the client the
  // session is dead, which would make it discard a working token and ask the
  // admin to sign in again for the same credentials.
  assert.strictEqual(r.status, 403);
  assert.match(r.body.message, /password/i);
});

test('clearing the flag opens the whole admin API again', async (t) => {
  const server = app().listen(0);
  t.after(() => server.close());
  state.account = { alias: 'AdminDevs', enabled: true, lastActivityAt: new Date(), mustChangePassword: false };
  const tok = token();

  for (const [method, path] of [['GET', '/api/admin/overview'], ['GET', '/api/admin/users'], ['POST', '/api/admin/users']]) {
    assert.strictEqual((await call(server, method, path, tok)).status, 200, method + ' ' + path);
  }
});

test('a missing flag behaves as "no change required"', async (t) => {
  const server = app().listen(0);
  t.after(() => server.close());
  // An account created before the field existed has no mustChangePassword at
  // all. It must not be locked out of the panel by a migration default.
  state.account = { alias: 'AdminDevs', enabled: true, lastActivityAt: new Date() };
  assert.strictEqual((await call(server, 'GET', '/api/admin/overview', token())).status, 200);
});

test('the gate does not weaken the other admin checks', async (t) => {
  const server = app().listen(0);
  t.after(() => server.close());

  state.account = { alias: 'AdminDevs', enabled: false, lastActivityAt: new Date(), mustChangePassword: true };
  assert.strictEqual((await call(server, 'GET', '/api/admin/overview', token())).status, 401,
    'a disabled account is still refused, flag or not');

  state.account = { alias: 'AdminDevs', enabled: true, lastActivityAt: new Date(Date.now() - 60 * 60 * 1000), mustChangePassword: true };
  assert.strictEqual((await call(server, 'GET', '/api/admin/overview', token())).status, 401,
    'an idle session still expires, flag or not');

  state.account = { alias: 'AdminDevs', enabled: true, lastActivityAt: new Date(), mustChangePassword: true };
  assert.strictEqual((await call(server, 'GET', '/api/admin/overview', 'not-a-jwt')).status, 401);
  assert.strictEqual((await call(server, 'GET', '/api/admin/overview')).status, 401);
});

// ── the policy the change endpoint now enforces ───────────────────────────
test('the change endpoint uses the one shared policy, not a local copy', () => {
  // The route used to accept "at least 8 characters with a capital letter and
  // number" - which is shorter than the server-wide minimum, requires no
  // symbol, and applies no guessability check. An admin account is the
  // highest-privilege credential in the product and had the weakest rule.
  const old = (pw) => pw.length >= 8 && /[A-Z]/.test(pw) && /[0-9]/.test(pw);
  assert.strictEqual(old('Passw0rd'), true, 'precondition: the old rule allowed this');

  const now = evaluatePassword('Passw0rd');
  assert.strictEqual(now.ok, false, 'the shared policy refuses it (too short, no symbol)');
  assert.ok(now.message, 'and says which rule is unmet');

  // Everything the old rule accepted and the new one rejects.
  for (const weak of ['Passw0rd', 'Password1', 'Abcdefg1', 'Longenough1']) {
    assert.strictEqual(evaluatePassword(weak).ok, false, weak + ' must not pass');
  }
  // A genuinely strong password still passes.
  assert.strictEqual(evaluatePassword('Fjord-Lantern-42!').ok, true);
});

test('the shared policy still accepts the passwords it always did', () => {
  assert.strictEqual(evaluatePassword('Fjord-Lantern-42!').ok, true);
  assert.strictEqual(evaluatePassword('Tr0ub4dor&3xyz!').ok, true);
  // The 128-character bound is bcrypt's limit and is still enforced. The
  // 120-character sample is varied rather than a run of 'A', because
  // REPEATED_RUN ("four or more of the same character in a row") makes a solid
  // run fail the guessability rule for a second, unrelated reason - and a
  // length test that passes for the wrong reason is worse than no test.
  assert.strictEqual(evaluatePassword('Quay7-Zephyr-' + 'v4nta9-'.repeat(13) + 'Lp2!').ok, true,
    'a 120-character password inside the bound is still accepted');
  assert.strictEqual(evaluatePassword('Quay7-Zephyr-' + 'v4nta9-'.repeat(16) + 'Lp2!').ok, false,
    'and one over 128 is still refused');
});

test('a wrong password or code is a 400, never a 401', async (t) => {
  // The distinction the client depends on. 401 means "your session is dead"
  // everywhere else in this API, so returning it for a mistyped code made the
  // change-password page discard a perfectly good admin token and send the user
  // back to sign in - to retype the password they had just typed correctly,
  // only to be redirected straight back to the same page. One typo became a
  // loop with no way out.
  //
  // These drive the REAL router (routes/admin.js). The model is already the
  // file-level stub installed before `require` — routes/admin.js and
  // middleware/auth.js both close over it — so there is nothing to patch here,
  // and the asserted status codes are the ones actually shipped.
  const { hashPassword } = require('../utils/password');
  const hash = await hashPassword('NFaCRvuJRBeE+S2.=Fgg');
  let saved = null;

  // One document serves BOTH the router and the middleware, because `protect`
  // reads the same model. It must therefore look like a healthy, ungated admin —
  // otherwise protect answers 401 "Admin account is unavailable" and the test
  // would be measuring the middleware instead of the route.
  state.account = {
    alias: 'AdminDevs', enabled: true, lastActivityAt: new Date(),
    mustChangePassword: false, passwordHash: hash, totpSecret: 'JBSWY3DPEHPK3PXP',
    save: async function () { saved = this; state.saved = this; },
  };

  // The route catches its own errors and answers 500, logging the cause. Keep
  // the message instead of discarding it, so a future failure says WHY.
  const realError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };

  const adminRouter = require('../routes/admin');
  const a = express();
  a.use(express.json());
  a.use('/api/admin', adminRouter);
  const server = a.listen(0);
  t.after(() => {
    server.close();
    console.error = realError;
    state.account = null;
    state.saved = null;
  });

  const auth = { Authorization: `Bearer ${token()}` };
  const call = (body) => new Promise((resolve, reject) => {
    const http = require('http');
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'PATCH',
      path: '/api/admin/profile/password',
      headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b || '{}'); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end(data);
  });

  // Wrong current password.
  const badPw = await call({ currentPassword: 'wrong-password-here', newPassword: 'Harbour-Lantern-77!', otp: '123456' });
  // A 500 here means the route threw before reaching the credential check, so
  // print the cause rather than making the next reader guess.
  assert.strictEqual(badPw.status, 400,
    'a wrong current password is a user error, not a dead session. got ' + badPw.status +
    ' ' + JSON.stringify(badPw.body) + ' | route logged: ' + logged.join(' / '));
  assert.strictEqual(badPw.status === 401, false, 'must never be 401');
  assert.strictEqual(badPw.body.code, 'CURRENT_PASSWORD_INVALID');

  // Wrong authenticator code: correct password, so it reaches the TOTP check.
  const badOtp = await call({ currentPassword: 'NFaCRvuJRBeE+S2.=Fgg', newPassword: 'Harbour-Lantern-77!', otp: '000111' });
  assert.strictEqual(badOtp.status, 400, 'a wrong authenticator code must not be 401');
  assert.strictEqual(badOtp.body.code, 'OTP_INVALID');

  // A weak new password is refused before any credential is touched.
  const weak = await call({ currentPassword: 'NFaCRvuJRBeE+S2.=Fgg', newPassword: 'Passw0rd', otp: '123456' });
  assert.strictEqual(weak.status, 400);

  // Nothing above should have written a password.
  assert.strictEqual(saved, null, 'a rejected attempt must not save a new hash');
  assert.strictEqual(state.saved, null, 'nor reach the document save at all');
});

test('a hash of the new password verifies, and the old one does not', async () => {
  const before = await hashPassword('Fjord-Lantern-42!');
  assert.ok(/^\$argon2id\$/.test(before));
  assert.strictEqual(await verifyPassword('Fjord-Lantern-42!', before), true);
  assert.strictEqual(await verifyPassword('something-else-9!', before), false);
});
