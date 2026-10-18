/**
 * ADMIN SIGN-OUT ENDS THE SESSION SERVER-SIDE.
 *
 * An admin credential is a stateless HS256 JWT. It carries no `sid` pointing at
 * a session document the way a member token does, so for as long as `/logout`
 * only knew how to revoke member sessions, an administrator clicking Sign out
 * was discarding their own copy of a string that stayed fully valid — against
 * every administrative endpoint — for the rest of `ADMIN_TOKEN_LIFETIME`.
 * Whoever held that string (another tab, a shell history entry, a copied token)
 * still held admin access.
 *
 * The fix is a stamp on the account: `sessionsRevokedAt`. A token is usable only
 * if it was issued after it. Two rules in `utils/adminSession.js` make that
 * precise against a clock with one-second `iat` values, and this suite pins both
 * the arithmetic and the live HTTP behaviour:
 *
 *   1. THE DECISION   — signedOutSince / adminSessionBlock, offline
 *   2. THE ENDPOINT   — /api/auth/logout stamps, then the same token is refused
 *   3. NO RESURRECTION— /admin-refresh cannot mint a fresh token for a dead one
 *   4. NO COLLATERAL  — another admin, and another of the SAME admin's
 *                       pre-sign-out tokens for a different account, are untouched
 *   5. THE COUNTER    — a sign-in after the sign-out works again
 *
 * Run: node --test "Test File/admin-signout-revocation.test.js"
 * Requires MONGO_TEST_URI (a dedicated throwaway database) for cases 2-5.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { startTestServer, connectTestDb } = require('./e2eServer');
const { testDbPreflight, skipMessage } = require('./testDbGuard');

const AdminAccount = require('../models/AdminAccount');
const {
  ADMIN_TOKEN_LIFETIME_SECONDS,
  ADMIN_IDLE_TIMEOUT_MS,
  signoutStamp,
  signedOutSince,
  adminSessionBlock,
} = require('../utils/adminSession');

const preflight = testDbPreflight();
const SECOND = 1000;

// ══ 1. THE DECISION (offline) ════════════════════════════════════════════

test('signoutStamp rounds up to the next whole second', () => {
  const t = 1_700_000_000_400;
  assert.equal(signoutStamp(t), 1_700_000_001_000, 'a token issued in this second must be provably older than the stamp');
  assert.equal(signoutStamp(1_700_000_000_000), 1_700_000_001_000, 'an exact second boundary still moves forward one second');
});

test('a token issued before the stamp is refused, after it is accepted', () => {
  const stamp = new Date(signoutStamp(Date.now()));
  const issuedBefore = { iat: Math.floor(stamp.getTime() / SECOND) - 1 };
  const issuedAfter = { iat: Math.floor(stamp.getTime() / SECOND) + 1 };
  assert.equal(signedOutSince({ sessionsRevokedAt: stamp }, issuedBefore), true);
  assert.equal(signedOutSince({ sessionsRevokedAt: stamp }, issuedAfter), false);
});

test('an account that never signed out accepts anything', () => {
  for (const stamp of [null, undefined]) {
    assert.equal(signedOutSince({ sessionsRevokedAt: stamp }, { iat: 1 }), false);
  }
  assert.equal(signedOutSince({}, { iat: 1 }), false, 'a document without the field at all (pre-migration) is not a lockout');
});

test('a token with no provable issue time loses', () => {
  const stamp = new Date(signoutStamp(Date.now()));
  for (const decoded of [{}, { iat: 0 }, { iat: 'not-a-time' }, undefined]) {
    assert.equal(signedOutSince({ sessionsRevokedAt: stamp }, decoded), true, `iat missing/unusable (${JSON.stringify(decoded)}) must fail closed`);
  }
});

test('a corrupt stamp is treated as no stamp, never as a crash or a lockout', () => {
  // Fails OPEN by design: a junk value proves nothing about when anyone signed
  // out, and the alternative — reading a broken field as "revoked" — would sign
  // every administrator out on a bad write. `iat` still has its own expiry, and
  // the idle window is measured independently.
  assert.equal(signedOutSince({ sessionsRevokedAt: 'clearly not a date' }, { iat: 1 }), false);
});

test('adminSessionBlock reports a sign-out before it reports idleness', () => {
  const now = Date.now();
  const stamp = new Date(signoutStamp(now));
  const dead = { sessionsRevokedAt: stamp, lastActivityAt: new Date(now - ADMIN_IDLE_TIMEOUT_MS - 60_000) };
  assert.equal(adminSessionBlock(dead, { iat: Math.floor(stamp.getTime() / SECOND) - 5 }, now), 'signed_out',
    'a session that is both idle and signed-out must say the true, more specific reason');
  assert.equal(adminSessionBlock({ lastActivityAt: new Date(now - ADMIN_IDLE_TIMEOUT_MS - 60_000) }, { iat: Math.floor(now / SECOND) }, now), 'idle');
  assert.equal(adminSessionBlock({ lastActivityAt: new Date(now) }, { iat: Math.floor(now / SECOND) }, now), null);
});

// ══ 2-5. OVER REAL HTTP ══════════════════════════════════════════════════

test('admin sign-out revokes the credential over real HTTP', { skip: preflight.skip }, async (t) => {
  const server = await startTestServer({ port: 5126 });
  if (!server.ok) return t.skip(skipMessage(server));
  const db = await connectTestDb();
  if (!db.connected) {
    await server.stop();
    return t.skip(skipMessage(db));
  }
  const { base } = server;

  const created = [];
  let aliasSeq = 0;
  t.after(async () => {
    for (const id of created) await AdminAccount.deleteOne({ _id: id }).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    await server.stop();
  });

  const seed = async (overrides = {}) => {
    aliasSeq += 1;
    const doc = await AdminAccount.create({
      alias: `admin-signout-probe-${aliasSeq}`,
      passwordHash: 'not-a-real-hash-this-suite-never-verifies-it',
      totpSecret: 'NOTAREALBASE32SECRET000000000000000',
      ...overrides,
    });
    created.push(doc._id);
    return doc;
  };

  /** Mint a token the way routes/auth.js does. `ageMs` backdates `iat`. */
  const tokenFor = (admin, { ageMs = 0 } = {}) => jwt.sign(
    {
      id: String(admin._id),
      adminId: String(admin._id),
      alias: admin.alias,
      role: 'admin',
      iat: Math.floor((Date.now() - ageMs) / SECOND),
    },
    process.env.JWT_SECRET,
    { expiresIn: ADMIN_TOKEN_LIFETIME_SECONDS },
  );

  const call = (route, { method = 'GET', token, body, headers = {} } = {}) =>
    fetch(`${base}${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

  const PROBE = '/api/admin/session-status';

  await t.test('signing out kills the token that was used to sign out', async () => {
    const admin = await seed();
    const token = tokenFor(admin);
    assert.equal((await call(PROBE, { token })).status, 200, 'control: the token works before the sign-out');

    const out = await call('/api/auth/logout', { method: 'POST', token });
    assert.equal(out.status, 200, 'sign-out itself must succeed');

    const doc = await AdminAccount.findById(admin._id).lean();
    assert.ok(doc.sessionsRevokedAt, 'the account carries the stamp now');
    assert.ok(new Date(doc.sessionsRevokedAt).getTime() >= Date.now() - 2 * SECOND,
      'and it is rounded up to at least the second the sign-out happened in');

    const after = await call(PROBE, { token });
    assert.equal(after.status, 401, 'the same token must be dead immediately, not at its own expiry');
    assert.equal(after.data.code, 'ADMIN_SESSION_ENDED', 'with a machine-readable reason');
    assert.match(after.data.message, /sign in again/i);
  });

  await t.test('a token minted after the stamp still works', async () => {
    const admin = await seed({ sessionsRevokedAt: new Date(Date.now() - 60 * SECOND) });
    const r = await call(PROBE, { token: tokenFor(admin) });
    assert.equal(r.status, 200, 'a sign-in that follows a sign-out is not punished for it');
  });

  await t.test('the refresh endpoint cannot resurrect a signed-out session', async () => {
    const admin = await seed();
    const token = tokenFor(admin);
    await call('/api/auth/logout', { method: 'POST', token });
    const renewed = await call('/api/auth/admin-refresh', { method: 'POST', token, body: { renew: true } });
    assert.equal(renewed.status, 401, 'renewal runs the same validation, so it must refuse the same token');
    assert.equal(renewed.data.code, 'ADMIN_SESSION_ENDED');
    assert.ok(!renewed.data || !renewed.data.token, 'and it must not hand back a fresh credential');
  });

  await t.test('signing out one admin leaves another untouched', async () => {
    const a = await seed();
    const b = await seed();
    const tokenA = tokenFor(a);
    const tokenB = tokenFor(b);
    await call('/api/auth/logout', { method: 'POST', token: tokenA });
    assert.equal((await call(PROBE, { token: tokenA })).status, 401);
    assert.equal((await call(PROBE, { token: tokenB })).status, 200,
      'revocation is per account — a sign-out can never end someone else\'s session');
  });

  await t.test('a member sign-out still only revokes its own session', async () => {
    // The branch this fix rewrote must not have lost the member behaviour: an
    // admin token stamps the account, a member token revokes the Session record.
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    const logout = /router\.post\('\/logout'[\s\S]{0,1400}\n\}\);/.exec(source);
    assert.ok(logout, 'the logout route is still here');
    assert.match(logout[0], /role === 'admin'[\s\S]*signoutStamp\(\)/, 'admin branch stamps the account');
    assert.match(logout[0], /else if \(req\.user && req\.sessionId\)[\s\S]*revokeUserSession\(req\.user\._id, req\.sessionId\)/,
      'member branch still revokes exactly that session');
    assert.match(logout[0], /mongoose\.isValidObjectId\(req\.user\._id\)/,
      'and a non-document legacy id cannot throw inside a route that promises never to fail sign-out');
  });

  await t.test('both admin validation sites use the one decision', () => {
    // The idle check and the revocation check are the same two rules; keeping
    // them in one function is what stops the middleware and /admin-refresh from
    // disagreeing about whether a session is alive.
    const middleware = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'auth.js'), 'utf8');
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    assert.match(middleware, /adminSessionBlock\(admin, decoded\)/);
    assert.match(routes, /adminSessionBlock\(admin, decoded\)/);
    assert.doesNotMatch(middleware, /if \(idleExceeded\(/, 'the middleware must not re-implement a partial check');
    assert.doesNotMatch(routes, /if \(idleExceeded\(/, 'nor may the refresh route');
    assert.match(middleware, /select\('[^']*sessionsRevokedAt'\)/, 'and both must actually read the field they judge');
    assert.match(routes, /select\('[^']*sessionsRevokedAt'\)/);
  });
});
