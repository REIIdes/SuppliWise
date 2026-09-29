/**
 * ADMIN SESSION EXPIRY — the ten-minute window, proven over real HTTP.
 *
 * Admin sessions are the ONE kind that ends on a timer. Member sessions do not
 * (see user-session-no-expiry.test.js); an administrator's does, and this suite
 * is what holds that promise to the number the client counts down from.
 *
 * What is pinned here:
 *
 *    1. THE WINDOW     — ten minutes, and the boundary is exact
 *    2. THE HOLE       — an account with no activity stamp is still measured
 *    3. DISABLING      — still refused, unaffected by the window
 *    4. THE HEARTBEAT  — written, but throttled rather than on every request
 *    5. RENEWAL        — a token renewal is not activity, and cannot be used to
 *                        hold an idle session open
 *
 * ── Why this needs a real database and a real server ────────────────────────
 *
 * The window is compared against a stored timestamp, and the heartbeat's
 * throttling is expressed in the UPDATE FILTER. Neither can be observed by
 * stubbing a model: a stub returns whatever the test told it to return, so it
 * would happily "prove" both a working throttle and a broken one. These run
 * against a throwaway Mongo and a real HTTP server (Test File/e2eServer.js),
 * then read the document back.
 *
 * The clock is moved by writing `lastActivityAt` into the past, exactly as the
 * real thing would have aged.
 *
 * Run: node --test "Test File/admin-session-expiry.test.js"
 *
 * Requires MONGO_TEST_URI — a DEDICATED throwaway database. This suite creates
 * and deletes real AdminAccount documents.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { startTestServer, connectTestDb } = require('./e2eServer');
const { testDbPreflight, skipMessage } = require('./testDbGuard');

const fs = require('node:fs');
const path = require('node:path');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const AdminAccount = require('../models/AdminAccount');
const {
  ADMIN_IDLE_MINUTES,
  ADMIN_IDLE_LIMIT_SECONDS,
  ADMIN_IDLE_TIMEOUT_MS,
  ADMIN_TOKEN_LIFETIME_SECONDS,
  ADMIN_HEARTBEAT_INTERVAL_MS,
  idleExceeded,
} = require('../utils/adminSession');

const preflight = testDbPreflight();

/** A dummy alias/hash: nothing in this suite ever verifies a password. */
const ADMIN = {
  alias: 'admin-expiry-probe',
  passwordHash: 'not-a-real-hash-this-suite-never-verifies-it',
  totpSecret: 'NOTAREALBASE32SECRET000000000000000',
};

/** Mint a token the server will accept, exactly as routes/auth.js does. */
function adminToken(adminId, { ageMs = 0, alias = ADMIN.alias } = {}) {
  const issuedAt = Math.floor((Date.now() - ageMs) / 1000);
  return jwt.sign(
    { id: String(adminId), adminId: String(adminId), alias, role: 'admin', iat: issuedAt },
    process.env.JWT_SECRET,
    { expiresIn: ADMIN_TOKEN_LIFETIME_SECONDS },
  );
}

test('admin session expiry — the ten-minute window over real HTTP', { skip: preflight.skip }, async (t) => {
  const server = await startTestServer({ port: 5124 });
  if (!server.ok) return t.skip(skipMessage(server));
  const db = await connectTestDb();
  if (!db.connected) {
    await server.stop();
    return t.skip(skipMessage(db));
  }
  const { base } = server;

  // `alias` carries a unique index, so every case needs its OWN account. They
  // are all tracked and removed at the end — a suite that leaves admin
  // documents behind in a shared throwaway database is how the next run
  // collides on exactly this.
  const createdIds = [];
  let aliasSeq = 0;
  t.after(async () => {
    for (const id of createdIds) await AdminAccount.deleteOne({ _id: id }).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    await server.stop();
  });

  /**
   * A fresh admin. `lastActivityAt` defaults to null in the schema, which is
   * the interesting case — see case 2.
   */
  const seed = async (overrides = {}) => {
    aliasSeq += 1;
    const alias = `${ADMIN.alias}-${aliasSeq}`;
    const doc = await AdminAccount.create({
      passwordHash: ADMIN.passwordHash,
      totpSecret: ADMIN.totpSecret,
      ...overrides,
      alias,
    });
    createdIds.push(doc._id);
    return doc;
  };

  const readStamp = async (id) => (await AdminAccount.findById(id).lean()).lastActivityAt;

  const call = (path, { method = 'GET', token, body, headers = {} } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

  // A protected admin endpoint. It is in middleware/auth.js's allowlist for
  // forced-password-change accounts, so it answers for any admin state.
  const PROBE = '/api/admin/session-status';
  const ago = (ms) => new Date(Date.now() - ms);

  // ══ 1. THE WINDOW ══════════════════════════════════════════════════════

  await t.test('the window is ten minutes', () => {
    // The number the user asked for, stated so a change to it is a deliberate
    // edit to a test rather than a silent drift.
    assert.equal(ADMIN_IDLE_MINUTES, 10);
    assert.equal(ADMIN_IDLE_LIMIT_SECONDS, 600);
    assert.equal(ADMIN_IDLE_TIMEOUT_MS, 600_000);
  });

  await t.test('a fresh session is accepted', async () => {
    const admin = await seed();
    const r = await call(PROBE, { token: adminToken(admin._id) });
    assert.equal(r.status, 200, 'a just-signed-in admin must be allowed through');
  });

  await t.test('a session inside the window is accepted', async () => {
    const admin = await seed({ lastActivityAt: ago(ADMIN_IDLE_TIMEOUT_MS - 60_000) });
    const r = await call(PROBE, { token: adminToken(admin._id) });
    assert.equal(r.status, 200, 'nine minutes idle is still inside ten');
  });

  await t.test('a session past the window is refused', async () => {
    const admin = await seed({ lastActivityAt: ago(ADMIN_IDLE_TIMEOUT_MS + 60_000) });
    const r = await call(PROBE, { token: adminToken(admin._id) });
    assert.equal(r.status, 401, 'eleven minutes idle must end an admin session');
    assert.match(r.data.message, /inactivit/i, 'and the message must say why');
  });

  await t.test('the boundary is exact, to within the heartbeat\'s slack', async () => {
    // The stored stamp can be up to one heartbeat interval stale by design, so
    // the boundary is asserted with that slack stated rather than pretending to
    // a precision the throttled heartbeat cannot deliver.
    const inside = await seed({ lastActivityAt: ago(ADMIN_IDLE_TIMEOUT_MS - ADMIN_HEARTBEAT_INTERVAL_MS) });
    assert.equal((await call(PROBE, { token: adminToken(inside._id) })).status, 200);

    const outside = await seed({ lastActivityAt: ago(ADMIN_IDLE_TIMEOUT_MS + ADMIN_HEARTBEAT_INTERVAL_MS) });
    assert.equal((await call(PROBE, { token: adminToken(outside._id) })).status, 401);
  });

  // ══ 2. THE HOLE ════════════════════════════════════════════════════════

  await t.test('an account with NO activity stamp is still measured', async () => {
    // The bug. Both copies of the idle check read:
    //
    //     if (admin.lastActivityAt && Date.now() - admin.lastActivityAt > IDLE)
    //
    // and that `&&` SKIPS the check entirely when the stamp is null. A brand
    // new account has a null stamp by default, so the ten-minute timeout did
    // nothing for it and only the token's `exp` bounded it.
    //
    // TWO accounts, because a successful request legitimately repairs the
    // stamp — a single account cannot demonstrate "measured" and "not skipped"
    // in sequence, because the first request would fix the second one's data.
    const fresh = await seed({ lastActivityAt: null });
    assert.equal(
      (await call(PROBE, { token: adminToken(fresh._id) })).status, 200,
      'a token issued moments ago must not be treated as idle',
    );

    const stale = await seed({ lastActivityAt: null });
    // An OLD token on an unstamped account, as the very first request. This is
    // the case the old check let through.
    const old = adminToken(stale._id, { ageMs: ADMIN_IDLE_TIMEOUT_MS + 60_000 });
    assert.equal(
      (await call(PROBE, { token: old })).status, 401,
      'an unstamped session older than the window must be refused, not skipped',
    );
  });

  await t.test('idleExceeded agrees with itself, and fails closed', () => {
    const now = Date.now();
    assert.equal(idleExceeded({ lastActivityAt: null }, { iat: Math.floor(now / 1000) }, now), false);
    assert.equal(idleExceeded({ lastActivityAt: null }, { iat: Math.floor((now - 11 * 60_000) / 1000) }, now), true);
    // Nothing to measure from at all → refuse. An unmeasurable session is not an
    // unlimited one.
    assert.equal(idleExceeded({}, {}, now), true);
  });

  // ══ 3. DISABLING ══════════════════════════════════════════════════════

  await t.test('a disabled admin is refused inside the window', async () => {
    const admin = await seed({ lastActivityAt: new Date(), enabled: false });
    const r = await call(PROBE, { token: adminToken(admin._id) });
    assert.equal(r.status, 401, 'disabling must not wait for the idle window');
  });

  // ══ 4. THE HEARTBEAT ═══════════════════════════════════════════════════

  await t.test('activity inside the window refreshes the stamp', async () => {
    const admin = await seed({ lastActivityAt: ago(ADMIN_IDLE_TIMEOUT_MS - 60_000) });
    // Older than the heartbeat interval, so the conditional write is allowed.
    await call(PROBE, { token: adminToken(admin._id) });
    await new Promise((r) => setTimeout(r, 250)); // the write is fire-and-forget
    const after = await readStamp(admin._id);
    assert.ok(
      Date.now() - new Date(after).getTime() < 5_000,
      'a genuine request must slide the activity stamp',
    );
  });

  await t.test('the heartbeat is THROTTLED, not written on every request', async () => {
    // This is the optimisation, asserted by its observable consequence rather
    // than by counting queries.
    //
    // The guard lives in the update FILTER (`lastActivityAt < now - interval`),
    // so whether a write happens is decided entirely by how old the stored value
    // is. That gives a two-sided test, and both sides matter:
    //
    //   stamp FRESHER than one interval  -> no write at all
    //   stamp OLDER  than one interval  -> exactly one write
    //
    // A single-sided test could pass with the update simply disabled, which
    // would satisfy "no writes" while silently breaking the feature.
    const freshMarker = ago(ADMIN_HEARTBEAT_INTERVAL_MS / 2);
    const fresh = await seed({ lastActivityAt: freshMarker });
    for (let i = 0; i < 5; i += 1) {
      const r = await call(PROBE, { token: adminToken(fresh._id) });
      assert.equal(r.status, 200, 'every request inside the window is served');
    }
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      new Date(await readStamp(fresh._id)).getTime(),
      freshMarker.getTime(),
      'five requests inside the heartbeat interval must produce no writes at all',
    );
    // And the session still works — a throttle must never cost a working
    // administrator their session.
    assert.equal((await call(PROBE, { token: adminToken(fresh._id) })).status, 200);

    const staleMarker = ago(ADMIN_HEARTBEAT_INTERVAL_MS * 2);
    const stale = await seed({ lastActivityAt: staleMarker });
    await call(PROBE, { token: adminToken(stale._id) });
    await new Promise((r) => setTimeout(r, 250));
    assert.notEqual(
      new Date(await readStamp(stale._id)).getTime(),
      staleMarker.getTime(),
      'a stamp older than the interval must still be refreshed once',
    );
  });

  await t.test('the heartbeat skips background polls', async () => {
    // The dashboard's own refresh loop is not evidence that a human is at the
    // keyboard, so it must not hold a session open.
    const marker = ago(ADMIN_HEARTBEAT_INTERVAL_MS * 2);
    const admin = await seed({ lastActivityAt: marker });
    await call(PROBE, { token: adminToken(admin._id), headers: { 'X-Admin-Background': 'true' } });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      new Date(await readStamp(admin._id)).getTime(),
      marker.getTime(),
      'a background poll must not stamp activity',
    );
  });

  // ══ 5. RENEWAL IS NOT ACTIVITY ════════════════════════════════════════

  await t.test('a plain refresh counts as activity', async () => {
    const admin = await seed({ lastActivityAt: ago(ADMIN_IDLE_LIMIT_SECONDS * 1000 - 120_000) });
    const r = await call('/api/auth/admin-refresh', { method: 'POST', token: adminToken(admin._id) });
    assert.equal(r.status, 200, '"Stay signed in" is activity and must be honoured');
    assert.equal(r.data.countedAsActivity, true, 'and reported as such');
    assert.equal(r.data.idleLimitSeconds, ADMIN_IDLE_LIMIT_SECONDS, 'reporting the enforced window');
    assert.equal(r.data.expiresInSeconds, ADMIN_TOKEN_LIFETIME_SECONDS, 'and the enforced token lifetime');
  });

  await t.test('a token renewal does NOT slide the window', async () => {
    // THE load-bearing property of the client keepalive. The dashboard renews
    // its 15-minute token on a timer; if that counted as activity, the timer
    // would refresh `lastActivityAt` forever and the ten-minute timeout would
    // stop existing for every administrator. The renewal exists purely so a
    // working admin is not logged out by `exp` — it must not become a way to
    // keep an idle session alive.
    const marker = ago(ADMIN_IDLE_TIMEOUT_MS - 120_000);
    const admin = await seed({ lastActivityAt: marker });

    const r = await call('/api/auth/admin-refresh', {
      method: 'POST',
      token: adminToken(admin._id),
      body: { renew: true },
    });
    assert.equal(r.status, 200, 'a renewal is a legitimate request');
    assert.equal(r.data.countedAsActivity, false, 'and must report that it was not activity');
    assert.ok(r.data.token, 'while still issuing a fresh token');

    await new Promise((r2) => setTimeout(r2, 250));
    assert.equal(
      new Date(await readStamp(admin._id)).getTime(),
      marker.getTime(),
      'a renewal must leave lastActivityAt exactly where it was',
    );
  });

  await t.test('a token renewal cannot revive an idle session', async () => {
    // The other half. If renewal skipped the idle check as well as the stamp,
    // it would be a way to keep an admin token alive indefinitely.
    const admin = await seed({ lastActivityAt: ago(ADMIN_IDLE_TIMEOUT_MS + 60_000) });
    const r = await call('/api/auth/admin-refresh', {
      method: 'POST',
      token: adminToken(admin._id),
      body: { renew: true },
    });
    assert.equal(r.status, 401, 'an idle admin must still be signed out by a renewal');
  });

  await t.test('a renewal on an unstamped account still measures idleness', async () => {
    // The hole, reached through the renewal path rather than the middleware.
    const admin = await seed({ lastActivityAt: null });
    const r = await call('/api/auth/admin-refresh', {
      method: 'POST',
      token: adminToken(admin._id, { ageMs: ADMIN_IDLE_TIMEOUT_MS + 60_000 }),
      body: { renew: true },
    });
    assert.equal(r.status, 401, 'the hole must be closed here too');
  });

  await t.test('a renewal cannot rescue a disabled account', async () => {
    const admin = await seed({ lastActivityAt: new Date(), enabled: false });
    const r = await call('/api/auth/admin-refresh', {
      method: 'POST',
      token: adminToken(admin._id),
      body: { renew: true },
    });
    assert.equal(r.status, 401);
  });

  await t.test('the renewed token works, and keeps working', async () => {
    // The end the whole mechanism exists for: a working administrator is not
    // logged out by `exp`.
    const admin = await seed({ lastActivityAt: new Date() });
    const first = await call('/api/auth/admin-refresh', {
      method: 'POST', token: adminToken(admin._id), body: { renew: true },
    });
    assert.equal(first.status, 200);
    const second = await call(PROBE, { token: first.data.token });
    assert.equal(second.status, 200, 'the token from a renewal must be accepted');
    assert.notEqual(first.data.token, undefined);
  });

  await t.test('a user token is not an admin token', async () => {
    // The two session kinds are entirely separate, and the renewal endpoint must
    // not accept one to obtain the other's token.
    const userToken = jwt.sign({ sub: 'x', id: 'x', sid: 'x' }, process.env.JWT_SECRET);
    const r = await call('/api/auth/admin-refresh', { method: 'POST', token: userToken, body: { renew: true } });
    assert.equal(r.status, 403);
  });

  // ══ 6. THE ACTIVITY BEACON ═════════════════════════════════════════════

  await t.test('the beacon counts as activity and slides the window', async () => {
    // The dashboard's own poll is marked X-Admin-Background so an unattended
    // tab cannot hold a session open. That is correct, and it left a gap: the
    // server only ever heard about activity from a non-background request, so a
    // client counting down on local input was counting down a window the server
    // was not honouring.
    const marker = ago(ADMIN_HEARTBEAT_INTERVAL_MS * 2);
    const admin = await seed({ lastActivityAt: marker });

    const r = await call('/api/auth/admin-activity', { method: 'POST', token: adminToken(admin._id) });
    assert.equal(r.status, 200, 'a genuine user is reporting in');
    assert.equal(r.data.ok, true);
    assert.equal(r.data.idleLimitSeconds, ADMIN_IDLE_LIMIT_SECONDS, 'and gets the enforced window back');
    assert.ok(r.data.serverTime > 0, 'plus the server clock, so a drifted client can correct itself');
    // No token. Minting one here would make this a second renewal path, which is
    // exactly how the idle timeout would end up disabled.
    assert.equal(r.data.token, undefined, 'the beacon must not mint a token');

    await new Promise((res) => setTimeout(res, 250));
    assert.notEqual(
      new Date(await readStamp(admin._id)).getTime(),
      marker.getTime(),
      'the beacon must genuinely stamp activity',
    );
  });

  await t.test('the beacon is throttled like any other activity', async () => {
    const freshMarker = ago(ADMIN_HEARTBEAT_INTERVAL_MS / 2);
    const admin = await seed({ lastActivityAt: freshMarker });
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await call('/api/auth/admin-activity', { method: 'POST', token: adminToken(admin._id) })).status, 200);
    }
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      new Date(await readStamp(admin._id)).getTime(),
      freshMarker.getTime(),
      'four beacons inside the interval must still produce one write at most — and none here',
    );
  });

  await t.test('the beacon cannot revive an idle session', async () => {
    // A client that keeps beaconing after the window has closed must be signed
    // out, not allowed to talk its way back in.
    const admin = await seed({ lastActivityAt: ago(ADMIN_IDLE_TIMEOUT_MS + 60_000) });
    const r = await call('/api/auth/admin-activity', { method: 'POST', token: adminToken(admin._id) });
    assert.equal(r.status, 401, 'the idle window is not negotiable from the client');
  });

  await t.test('the beacon requires a credential', async () => {
    for (const token of [undefined, 'not.a.jwt', 'a.b.c']) {
      const r = await call('/api/auth/admin-activity', { method: 'POST', token });
      assert.equal(r.status, 401, `must refuse ${String(token).slice(0, 12)}`);
    }
  });

  await t.test('the beacon does not consume the sensitive auth budget', async () => {
    // A non-loopback deployment gets 20 requests per 15 minutes on /api/auth. A
    // once-a-minute beacon would spend 15 of them and leave a legitimate admin
    // unable to sign in at all — the exact failure the /me skip prevents.
    assert.ok(
      /req\.path === '\/admin-activity'/.test(indexSource),
      'the beacon must be skipped by the sensitive auth limiter',
    );
  });
});
