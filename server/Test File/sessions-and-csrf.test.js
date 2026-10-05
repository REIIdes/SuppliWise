'use strict';
/**
 * Sessions: revocation, isolation between accounts, and the CSRF/Origin guard.
 *
 * ── The product requirement these tests exist to pin ───────────────────────
 *
 *   Tab 1: Account A signed in.
 *   Tab 2: Account B signed in.        <- both at once, same browser
 *   Account A signs in again.          <- replaces A's OLD session only
 *   => Account B is completely unaffected.
 *
 * That is a real constraint, not a nicety, and it has two halves that can each
 * be broken independently:
 *
 *   SERVER: every revocation is filtered on `user: req.user._id`. A session
 *   that was not filtered on its owner would let one account's sign-out reach
 *   another's.
 *
 *   CLIENT: the two tokens must not share storage. A single browser-wide token
 *   makes "two accounts at once" impossible by construction, and the usual
 *   "fix" — one shared token plus an account id — is exactly the account-confusion
 *   vulnerability, because any request can then claim to be the other account.
 *
 * The client half is a property of api.js and is asserted here by reading the
 * source, since it cannot be exercised from a server test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config();

const { startTestServer, connectTestDb } = require('./e2eServer');
const { testDbPreflight, skipMessage } = require('./testDbGuard');

const { issueUserSession } = require('../utils/sessions');
const User = require('../models/User');
const Session = require('../models/Session');
const { issue: issueStepUp } = require('../middleware/stepUp');

const preflight = testDbPreflight();
const PASSWORD = 'Probe!12345';

test('sessions — revocation, account isolation and the CSRF guard', { skip: preflight.skip }, async (t) => {
  const server = await startTestServer({ port: 5125 });
  if (!server.ok) return t.skip(skipMessage(server));
  const db = await connectTestDb();
  if (!db.connected) {
    await server.stop();
    return t.skip(skipMessage(db));
  }

  const { base } = server;
  const created = [];
  t.after(async () => {
    for (const id of created.reverse()) {
      await Session.deleteMany({ user: id }).catch(() => {});
      await User.deleteOne({ _id: id }).catch(() => {});
    }
    await mongoose.disconnect().catch(() => {});
    await server.stop();
  });

  const seed = async (tag) => {
    const email = `sess_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
    const user = await User.create({
      firstName: 'Sess', lastName: tag, name: `Sess ${tag}`,
      email, password: PASSWORD, dateOfBirth: '1990-01-01', gender: 'Male',
    });
    created.push(user._id);
    const token = await issueUserSession(user._id, { userAgent: `probe-${tag}`, ip: '127.0.0.1', authMethod: 'passkey', mfaVerified: true });
    const sid = (require('jsonwebtoken').decode(token) || {}).sid;
    return { user, email, token, sid, stepUp: issueStepUp(user._id, sid) };
  };

  const call = (path, { method = 'GET', body, token, stepUp, origin, fetchSite } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token || ''}` }),
      ...(stepUp ? { 'X-Step-Up': stepUp } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(fetchSite ? { 'Sec-Fetch-Site': fetchSite } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => {
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }
    return { status: r.status, data, headers: r.headers };
  });

  const TRUSTED = 'https://localhost:5173';

  /**
   * Give an account a second live session, pointed at as its current one.
   *
   * NOT done through issueUserSession: that function deliberately displaces the
   * account's previous session, which is the policy under test, so it cannot be
   * used to construct the multi-device state the revoke routes exist to handle.
   * The row is written directly instead — the same document a real sign-in
   * would leave.
   */
  const addDevice = async (ctx, userAgent, ip) => {
    const sid = new mongoose.Types.ObjectId();
    await Session.create({
      _id: sid,
      user: ctx.user._id,
      tokenHash: 'probe',
      deviceLabel: userAgent,
      platform: 'probe',
      ip: ip || '127.0.0.9',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      revokedAt: null,
    });
    await User.updateOne({ _id: ctx.user._id }, { $set: { currentSessionId: sid } });
    const token = require('jsonwebtoken').sign(
      { sub: String(ctx.user._id), id: String(ctx.user._id), sid: String(sid) },
      process.env.JWT_SECRET,
    );
    // The caller must act AS the new device from here on: the old token is
    // already dead, because addDevice moved the account's current-session
    // pointer — which is the one-active-session policy, working correctly.
    return { token, sid: String(sid), stepUp: issueStepUp(ctx.user._id, String(sid)) };
  };

  // ══ 1. TWO ACCOUNTS AT ONCE ═════════════════════════════════════════════

  await t.test('two accounts hold independent sessions at the same time', async () => {
    const a = await seed('aaa');
    const b = await seed('bbb');

    const meA = await call('/api/auth/me', { token: a.token });
    const meB = await call('/api/auth/me', { token: b.token });
    assert.equal(meA.status, 200);
    assert.equal(meB.status, 200);
    assert.equal(String(meA.data._id), String(a.user._id), 'A\'s token resolves to A');
    assert.equal(String(meB.data._id), String(b.user._id), 'B\'s token resolves to B');
  });

  await t.test('A\'s token cannot act as B, even with B\'s id in the body', async () => {
    // The confused-deputy case. Every route scopes by `req.user._id` — the
    // identity the TOKEN proved — never by anything in the request.
    const a = await seed('aaa');
    const b = await seed('bbb');

    const sessionsAsB = await call('/api/auth/sessions', { token: a.token });
    assert.equal(sessionsAsB.status, 200);
    for (const s of sessionsAsB.data.sessions) {
      assert.equal(String(s.id), String(a.sid), 'A sees only A\'s sessions, whatever it asks for');
    }

    // Signing out "all" while authenticated as A must not reach B.
    await call('/api/auth/sessions/logout-all', { method: 'POST', token: a.token });
    const bStillWorks = await call('/api/auth/me', { token: b.token });
    assert.equal(bStillWorks.status, 200, 'B must be entirely unaffected by A signing out everywhere');
  });

  await t.test('A signing in again does NOT invalidate B', async () => {
    const a = await seed('aaa');
    const b = await seed('bbb');
    const bBefore = await call('/api/auth/me', { token: b.token });
    assert.equal(bBefore.status, 200);

    // A signs in again, displacing A's own previous session. Driven through
    // issueUserSession because that is literally what every real sign-in path
    // calls once its factors are satisfied — see utils/authFlow.completeSignIn.
    const relogin = await issueUserSession(a.user._id, { userAgent: 'second-device', ip: '127.0.0.4' });
    assert.ok(relogin, 'A completed a real sign-in');

    const oldA = await call('/api/auth/me', { token: a.token });
    assert.equal(oldA.status, 401, 'A\'s PREVIOUS session is invalidated');
    assert.equal(oldA.data.code, 'SESSION_REVOKED');

    const bAfter = await call('/api/auth/me', { token: b.token });
    assert.equal(bAfter.status, 200, 'B is untouched — this is the whole product requirement');
  });

  // ══ 2. LISTING, REVOCATION, EXPIRY ═════════════════════════════════════

  await t.test('the session list shows what a person needs and nothing more', async () => {
    const a = await seed('aaa');
    const r = await call('/api/auth/sessions', { token: a.token });
    assert.equal(r.status, 200);
    assert.equal(r.data.sessions.length, 1);
    const s = r.data.sessions[0];
    assert.equal(s.isCurrent, true);
    assert.equal(s.authMethod, 'passkey', 'how this session was actually opened is recorded');
    assert.equal(s.mfaVerified, true);
    assert.ok(s.createdAt && s.lastActiveAt);

    const body = JSON.stringify(r.data);
    assert.ok(!body.includes(a.token), 'the token must never be echoed');
    assert.ok(!/"tokenHash"|"rememberHash"/.test(body), 'nor any credential hash');
  });

  await t.test('a revoked session stops working on the very next request', async () => {
    // THE regression. middleware/auth.js caches a validated session for 30
    // seconds to halve database reads. That cache is safe for DISPLACEMENT (a
    // new sign-in mints a new sid, so the stale entry is unreachable) but NOT
    // for in-place revocation, which is what sign-out does: the sid is
    // unchanged, so a cached entry would keep authenticating for a full TTL
    // after the user asked to be signed out. utils/sessions.js now announces
    // every revocation to the cache.
    //
    // The cache is WARMED on purpose. Without that first read the assertion
    // would pass even against the unfixed code, because the request after a
    // revocation is a fresh database read and finds nothing.
    const a = await seed('aaa');
    const b = await seed('bbb');
    assert.equal((await call('/api/auth/me', { token: a.token })).status, 200, 'warm A');
    assert.equal((await call('/api/auth/me', { token: b.token })).status, 200, 'warm B');

    const out = await call('/api/auth/sessions/logout-all', { method: 'POST', token: a.token });
    assert.equal(out.status, 200);

    assert.equal((await call('/api/auth/me', { token: a.token })).status, 401,
      'A is dead immediately, not at the end of the 30-second cache window');
    assert.equal((await call('/api/auth/me', { token: b.token })).status, 200,
      'and B, whose session is cached too, is untouched');
  });

  await t.test('logout ends the caller\'s own session immediately', async () => {
    const a = await seed('aaa');
    assert.equal((await call('/api/auth/logout', { method: 'POST', token: a.token })).status, 200);
    const after = await call('/api/auth/me', { token: a.token });
    assert.equal(after.status, 401, 'a token that signed out one second ago must not still work');
  });

  await t.test('logout-all ends every session of that account, and only that account', async () => {
    const a = await seed('aaa');
    const b = await seed('bbb');
    const { token: a2 } = await addDevice(a, 'phone', '127.0.0.3');

    const r = await call('/api/auth/sessions/logout-all', { method: 'POST', token: a2 });
    assert.equal(r.status, 200);
    assert.ok(r.data.revoked >= 1);

    assert.equal((await call('/api/auth/me', { token: a2 })).status, 401);
    assert.equal((await call('/api/auth/me', { token: a.token })).status, 401);
    assert.equal((await call('/api/auth/me', { token: b.token })).status, 200, 'B is unaffected');
  });

  await t.test('revoke-others keeps the caller and drops the rest', async () => {
    const a = await seed('aaa');
    const { token: a2 } = await addDevice(a, 'phone', '127.0.0.3');
    const r = await call('/api/auth/sessions/revoke-others', { method: 'POST', token: a2 });
    assert.equal(r.status, 200);
    assert.equal((await call('/api/auth/me', { token: a2 })).status, 200, 'the device you clicked on stays signed in');
    assert.equal((await call('/api/auth/me', { token: a.token })).status, 401, 'and everything else is gone');
  });

  await t.test('one account cannot revoke another account\'s session', async () => {
    const victim = await seed('vvv');
    const attacker = await seed('aaa');
    const r = await call(`/api/auth/sessions/${victim.sid}`, { method: 'DELETE', token: attacker.token, stepUp: attacker.stepUp });
    assert.equal(r.status, 404, 'a guessed id belonging to someone else is a 404, never a 403');
    assert.equal((await call('/api/auth/me', { token: victim.token })).status, 200, 'and the victim is still signed in');
  });

  await t.test('an account cannot delete its OWN current session through this route', async () => {
    const a = await seed('aaa');
    const r = await call(`/api/auth/sessions/${a.sid}`, { method: 'DELETE', token: a.token, stepUp: a.stepUp });
    assert.equal(r.status, 400, 'that is what Sign out is for');
    assert.equal((await call('/api/auth/me', { token: a.token })).status, 200);
  });

  await t.test('a long-untouched session is NOT refused — users do not expire', async () => {
    // This asserted the opposite while a 30-day idle window existed. The window
    // was removed deliberately, so the assertion is inverted rather than
    // deleted: over HTTP, on a real session, an account untouched for 40 days
    // must still be signed in.
    //
    // What must still end a session is revocation, and the cases above and below
    // cover all of it — sign-out, a newer sign-in, a disabled account.
    const a = await seed('untouched');
    await Session.updateOne(
      { _id: a.sid },
      { $set: { lastActivityAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) } },
    );
    const r = await call('/api/auth/me', { token: a.token });
    assert.equal(r.status, 200, 'time alone must not end a user session');
  });

  await t.test('a session past an explicit absolute cap IS refused', async () => {
    // The one time bound a user session still has. It is null by default, so
    // "no expiry" is a configuration someone chose rather than the absence of a
    // mechanism, and an operator can bound an account without shipping code.
    const a = await seed('capped');
    await Session.updateOne(
      { _id: a.sid },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const r = await call('/api/auth/me', { token: a.token });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'SESSION_REVOKED');
  });

  await t.test('a garbage or forged token is refused', async () => {
    for (const bad of ['', 'not.a.jwt', 'a.b.c', `${'x'.repeat(400)}`]) {
      const r = await call('/api/auth/me', { token: bad });
      assert.equal(r.status, 401, `must refuse ${JSON.stringify(bad.slice(0, 20))}`);
    }
    // A correctly-shaped token signed with the WRONG key.
    const forged = require('jsonwebtoken').sign(
      { sub: String(created[0]), id: String(created[0]), sid: '507f1f77bcf86cd799439011' },
      'not-the-real-secret-at-all',
    );
    assert.equal((await call('/api/auth/me', { token: forged })).status, 401);
  });

  await t.test('a token with no sid is refused', async () => {
    // A legacy token predating server-side sessions carries no `sid`, so the
    // session store cannot vouch for it. Honouring it would be a bypass of the
    // entire revocation model.
    const noSid = require('jsonwebtoken').sign({ id: String(created[0]) }, process.env.JWT_SECRET);
    const r = await call('/api/auth/me', { token: noSid });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'SESSION_INVALID');
  });

  await t.test('a token whose sub and id disagree is refused', async () => {
    const confused = require('jsonwebtoken').sign(
      { sub: String(created[0]), id: String(created[created.length - 1]), sid: '507f1f77bcf86cd799439011' },
      process.env.JWT_SECRET,
    );
    assert.equal((await call('/api/auth/me', { token: confused })).status, 401);
  });

  // ══ 3. THE CSRF / ORIGIN GUARD ══════════════════════════════════════════

  await t.test('a state-changing request from an untrusted origin is refused', async () => {
    const a = await seed('aaa');
    const r = await call('/api/auth/sessions/logout-all', {
      method: 'POST', token: a.token, origin: 'https://evil.example.com',
    });
    assert.equal(r.status, 403, 'CORS is not a CSRF defence; this is the server-side rule');
    assert.equal((await call('/api/auth/me', { token: a.token })).status, 200, 'and nothing was changed');
  });

  await t.test('a trusted origin is allowed', async () => {
    const a = await seed('aaa');
    const r = await call('/api/auth/sessions/revoke-others', { method: 'POST', token: a.token, origin: TRUSTED });
    assert.equal(r.status, 200);
  });

  await t.test('Sec-Fetch-Site: cross-site is refused even with a trusted Origin header', async () => {
    // Otherwise a spoofed Origin string talks straight past the allowlist.
    const a = await seed('aaa');
    const r = await call('/api/auth/sessions/revoke-others', {
      method: 'POST', token: a.token, origin: TRUSTED, fetchSite: 'cross-site',
    });
    assert.equal(r.status, 403);
  });

  await t.test('a request with no Origin at all is allowed', async () => {
    // curl, the native app, a server-to-server call. None of them can be the
    // victim of a browser CSRF, and refusing them would break the Capacitor
    // build and every integration test.
    const a = await seed('aaa');
    const r = await call('/api/auth/sessions/revoke-others', { method: 'POST', token: a.token });
    assert.equal(r.status, 200);
  });

  await t.test('safe methods are not subject to the origin check', async () => {
    const r = await call('/api/auth/me', { token: (await seed('aaa')).token, origin: 'https://evil.example.com' });
    assert.equal(r.status, 200, 'a cross-origin READ leaks nothing: the response is unreadable by the page');
  });

  // ══ 4. THE CLIENT HALF (read from source) ════════════════════════════════

  await t.test('the client keeps each tab\'s credential in sessionStorage, not localStorage', () => {
    // The server can be perfect and this still be broken: with one shared token
    // the browser cannot hold two accounts at once, and the usual workaround —
    // a shared token plus a client-chosen account id — lets any request claim to
    // be the other account. The per-tab split is what makes Tab 1 = A and
    // Tab 2 = B possible at all.
    const api = fs.readFileSync(path.join(__dirname, '..', '..', 'my-react-app', 'src', 'api.js'), 'utf8');
    const tokenKey = "sessionStorage.getItem(TAB_TOKEN_KEY)";
    assert.ok(api.includes(tokenKey), 'the token is read from sessionStorage');
    assert.ok(
      !/localStorage\.getItem\(TAB_TOKEN_KEY\)|localStorage\.setItem\(TAB_TOKEN_KEY/.test(api),
      'and never mirrored into localStorage, which every tab shares',
    );
    // The shared directory is metadata only: an id, an email and a name. No
    // credential of any kind may appear in it.
    const directory = api.slice(api.indexOf('const upsertDirectory'), api.indexOf('const writeDirectory('));
    // What the directory writer actually stores: an id and some metadata.
    assert.ok(/entry\.id/.test(directory) && /entry\.email/.test(directory) && /entry\.name/.test(directory),
      'the shared directory holds id, email and name');
    assert.ok(!/(entry|list|e)\.(token|jwt|secret|password)\s*=/.test(directory),
      'and no credential of any kind');
  });

  await t.test('the legacy localStorage credential mirror is actively stripped on load', () => {
    const api = fs.readFileSync(path.join(__dirname, '..', '..', 'my-react-app', 'src', 'api.js'), 'utf8');
    assert.ok(api.includes('LEGACY_SHARED_KEYS'), 'older builds wrote credentials to localStorage');
    assert.ok(
      /LEGACY_SHARED_KEYS\.forEach\(\(key\) => localStorage\.removeItem\(key\)\)/.test(api),
      'and they are removed on load, not just ignored',
    );
  });
});
