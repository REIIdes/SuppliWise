/**
 * Recovery codes — the whole lifecycle, driven over real HTTP.
 *
 * The dashboard can mint single-use recovery codes, show them exactly once,
 * count them, and destroy them; sign-in can redeem one when the authenticator
 * is gone. None of that had a single automated test, so every one of these
 * behaviours was reachable only by hand — and the parts that had broken (a
 * regeneration that left the old set live, a race that let one code sign in
 * twice, a count that drifted) failed silently in production.
 *
 * What is pinned here:
 *
 *    1. THE GATE        — codes cannot be minted while 2FA is off
 *    2. MINTING         — 10 well-formed, distinct codes; only hashes stored
 *    3. THE COUNT       — /security/summary agrees with what was issued
 *    4. REGENERATION    — replaces the previous set, and invalidates it
 *    5. STEP-UP         — required, session-bound, and TOTP-bound
 *    6. REDEMPTION      — the pre-session route completes a real sign-in
 *    7. SINGLE USE      — a replay is refused, including under concurrency
 *    8. INVALIDATION    — destroys the unused codes and zeroes the count
 *    9. THE BOUNDARIES  — email method, ownership, unknown account, bad input
 *
 * ── Why a throwaway database and its own server ──────────────────────────
 *
 * The routes under test are the real ones, so this suite needs the real app
 * wiring — and the real wiring includes the account lockout ladder and the
 * per-IP rate limiters, both of which live in process memory. A suite that
 * deliberately fails authentication (steps 7 and 9 do) would therefore poison
 * the developer's own running server and lock the probe account out halfway
 * through, turning its own later assertions into noise. `e2eServer.js` starts
 * a separate server process against a throwaway database precisely so that
 * in-memory state is private to the run and the application's data is never
 * touched. See Test File/e2eServer.js and Test File/testDbGuard.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const speakeasy = require('speakeasy');

const { startTestServer, connectTestDb } = require('./e2eServer');
const { testDbPreflight, skipMessage } = require('./testDbGuard');

const { issueUserSession } = require('../utils/sessions');
const User = require('../models/User');
const BackupCode = require('../models/BackupCode');

// node:test reads `skip` when the test is REGISTERED, so this has to be
// evaluated at module load — a decision made inside `before` is already too
// late and the suite would run against a database it never connected to.
const preflight = testDbPreflight();

const PASSWORD = 'Probe!12345';
const CODE_COUNT = 10;

/**
 * A TOTP for a specific 30-second step, relative to now.
 *
 * `counter` rather than `time`: speakeasy's generator and its verifier do not
 * agree on how `time` becomes a counter, so a `time`-generated code does not
 * verify at all.
 */
const totpFor = (secret, stepOffset = 0) => speakeasy.totp({
  secret,
  encoding: 'base32',
  counter: Math.floor(Date.now() / 30000) + stepOffset,
});

/** Client for one account: owns its token and the step-up header. */
function clientFor(base, token) {
  const state = { token, stepUp: '' };
  const call = async (path, { method = 'GET', body, headers = {}, useStepUp = false } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        ...(useStepUp && state.stepUp ? { 'X-Step-Up': state.stepUp } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, data };
  };
  return { state, call };
}

test('recovery codes — full lifecycle over real HTTP', { skip: preflight.skip }, async (t) => {
  const server = await startTestServer({ port: 5121 });
  if (!server.ok) return t.skip(skipMessage(server));
  const db = await connectTestDb();
  if (!db.connected) {
    await server.stop();
    return t.skip(skipMessage(db));
  }

  const { base } = server;
  const cleanups = [];
  t.after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    await server.stop();
  });

  /** A throwaway account with a known authenticator, plus a live session. */
  const seed = async (overrides = {}) => {
    const email = `rc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
    const user = await User.create({
      firstName: 'Recovery', lastName: 'Probe', name: 'Recovery Probe',
      email, password: PASSWORD, dateOfBirth: '1990-01-01', gender: 'Male',
      twoFactorEnabled: false, ...overrides,
    });
    cleanups.push(async () => {
      await BackupCode.deleteMany({ user: user._id });
      await User.deleteOne({ _id: user._id });
    });
    const token = await issueUserSession(user._id, { userAgent: 'recovery-test', ip: '127.0.0.1' });
    return { user, email, token, client: clientFor(base, token), spent: new Map() };
  };

  /**
   * A TOTP this account has not presented yet.
   *
   * `verifyTotpOnce` is single-use per account, so a suite that authenticates
   * several times cannot keep sending the same code — it would be measuring the
   * replay cache rather than the thing it means to test. The server accepts a
   * ±1 step window, so all three offsets below are valid at any moment; this
   * hands out the least-used of them.
   */
  const nextCode = (ctx, secret) => {
    const WINDOW = [0, 1, -1];
    let best = WINDOW[0];
    for (const offset of WINDOW) {
      if ((ctx.spent.get(offset) || 0) < (ctx.spent.get(best) || 0)) best = offset;
    }
    const uses = ctx.spent.get(best) || 0;
    assert.ok(uses < 2, 'this account has spent every usable TOTP step — seed a new one');
    ctx.spent.set(best, uses + 1);
    return totpFor(secret, best);
  };

  const turnOnAuthenticator = async (ctx) => {
    const setup = await ctx.client.call('/api/auth/setup-2fa', { method: 'POST' });
    assert.equal(setup.status, 200, 'setup-2fa should issue a secret');
    const secret = setup.data.secret;
    const verify = await ctx.client.call('/api/auth/verify-2fa', { method: 'POST', body: { otp: nextCode(ctx, secret) } });
    assert.equal(verify.status, 200, `verify-2fa should enable 2FA: ${verify.data.message}`);
    return secret;
  };

  /** Step up on the current session, with a TOTP the server has not spent. */
  const stepUp = async (ctx, secret) => {
    const r = await ctx.client.call('/api/security/step-up', {
      method: 'POST',
      body: { password: PASSWORD, otp: secret ? nextCode(ctx, secret) : '' },
    });
    assert.equal(r.status, 200, `step-up should succeed: ${r.data && r.data.message}`);
    ctx.client.state.stepUp = r.data.stepUp;
    assert.ok(r.data.stepUp, 'step-up must return a token');
    return r.data.stepUp;
  };

  const generate = (ctx) => ctx.client.call('/api/security/backup-codes/generate', { method: 'POST', useStepUp: true });

  /** The pre-session redemption route, with the body parsed. */
  const redeem = (body) => fetch(`${base}/api/security/backup-codes/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, data: await res.json() }));

  // ══ 1. THE GATE ═════════════════════════════════════════════════════════

  await t.test('codes cannot be minted while two-factor is off', async () => {
    const ctx = await seed();
    await stepUp(ctx, null);
    const r = await generate(ctx);
    assert.equal(r.status, 409, 'minting must be refused, not silently accepted');
    assert.match(r.data.message, /two-factor/i);
  });

  await t.test('a recovery-code sign-in is refused while two-factor is off', async () => {
    const { user } = await seed();
    const r = await redeem({ userId: String(user._id), code: 'ABCDE-12345' });
    assert.equal(r.status, 401, 'must not confirm anything about an account without 2FA');
  });

  // ══ 2. MINTING ═════════════════════════════════════════════════════════

  await t.test('minting returns 10 distinct, well-formed codes', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);
    const r = await generate(ctx);
    assert.equal(r.status, 200, `generate failed: ${r.data.message}`);
    const { codes } = r.data;
    assert.ok(Array.isArray(codes), 'codes must be an array');
    assert.equal(codes.length, CODE_COUNT, `expected ${CODE_COUNT} codes, got ${codes.length}`);
    for (const code of codes) {
      assert.match(code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/, `malformed code: ${code}`);
    }
    assert.equal(new Set(codes).size, CODE_COUNT, 'codes must be distinct within a batch');
  });

  await t.test('no plaintext code is ever stored', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);
    const { data } = await generate(ctx);
    const rows = await BackupCode.find({ user: ctx.user._id }).lean();
    assert.equal(rows.length, CODE_COUNT, 'one row per code');
    for (const row of rows) {
      assert.match(row.codeHash, /^[0-9a-f]{64}$/, 'codeHash must be a sha256 hex digest');
    }
    for (const code of data.codes) {
      assert.ok(
        !rows.some((row) => row.codeHash === code),
        'a plaintext code must never be its own stored value',
      );
    }
  });

  // ══ 3. THE COUNT ════════════════════════════════════════════════════════

  await t.test('the summary counts exactly what was issued', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);
    await generate(ctx);

    const summary = await ctx.client.call('/api/security/summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.data.twoFactor.enabled, true);
    assert.equal(summary.data.twoFactor.method, 'authenticator');
    assert.equal(summary.data.backupCodes.remaining, CODE_COUNT);
    assert.equal(summary.data.backupCodes.total, CODE_COUNT);
  });

  // ══ 4. REGENERATION ═════════════════════════════════════════════════════

  await t.test('regenerating replaces the previous set and kills it', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);
    const first = (await generate(ctx)).data.codes;
    const second = (await generate(ctx)).data.codes;

    assert.equal(second.length, CODE_COUNT);
    assert.notDeepEqual(second, first, 'regeneration must produce a different set');

    const rows = await BackupCode.find({ user: ctx.user._id }).lean();
    assert.equal(rows.length, CODE_COUNT, 'the previous batch must be deleted, not left alongside');
    assert.equal(new Set(rows.map((r) => r.batchId)).size, 1, 'only one batch may remain');

    const stale = await redeem({ userId: String(ctx.user._id), code: first[0] });
    assert.equal(stale.status, 401, 'a code from the replaced set must be dead');
  });

  // ══ 5. STEP-UP ══════════════════════════════════════════════════════════

  await t.test('minting without a step-up token is refused', async () => {
    const ctx = await seed();
    await turnOnAuthenticator(ctx);
    const bare = clientFor(base, ctx.token);
    const r = await bare.call('/api/security/backup-codes/generate', { method: 'POST' });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'STEP_UP_REQUIRED');
  });

  await t.test('a step-up token is bound to the session that earned it', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);

    // A different session for the same account must not inherit the token.
    const otherToken = await issueUserSession(ctx.user._id, { userAgent: 'other-device', ip: '127.0.0.1' });
    const other = clientFor(base, otherToken);
    other.state.stepUp = ctx.client.state.stepUp;
    const r = await other.call('/api/security/backup-codes/generate', { method: 'POST', useStepUp: true });
    assert.equal(r.status, 401, 'step-up must not cross sessions');
  });

  await t.test('the authenticator code is also required for step-up', async () => {
    const ctx = await seed();
    await turnOnAuthenticator(ctx);
    const passwordOnly = await ctx.client.call('/api/security/step-up', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(passwordOnly.status, 400, 'a password alone must not be enough');
    assert.match(passwordOnly.data.message, /6-digit code/i);
  });

  // ══ 6. REDEMPTION ═══════════════════════════════════════════════════════

  await t.test('a valid code completes a real sign-in', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);
    const { codes } = (await generate(ctx)).data;

    const r = await redeem({ userId: String(ctx.user._id), code: codes[0] });
    assert.equal(r.status, 200, `redeem failed: ${r.data.message}`);
    assert.ok(r.data.token, 'redeem must return a session token');
    assert.equal(String(r.data._id), String(ctx.user._id), 'the session must belong to the redeeming account');

    // The returned token must actually work against a protected endpoint.
    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${r.data.token}` } });
    assert.equal(me.status, 200, 'the token from a recovery-code sign-in must be live');
  });

  await t.test('redemption is case- and separator-insensitive', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);
    const { codes } = (await generate(ctx)).data;

    // People retype these from paper; lowercase and a missing dash must work.
    const messy = codes[0].toLowerCase().replace('-', '');
    const r = await redeem({ userId: String(ctx.user._id), code: messy });
    assert.equal(r.status, 200, 'case and the dash must not decide whether a code is valid');
  });

  // ══ 7. SINGLE USE ═══════════════════════════════════════════════════════

  await t.test('a spent code cannot be replayed', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);
    const { codes } = (await generate(ctx)).data;

    assert.equal((await redeem({ userId: String(ctx.user._id), code: codes[0] })).status, 200);
    assert.equal((await redeem({ userId: String(ctx.user._id), code: codes[0] })).status, 401,
      'the second use of a code must be refused');
  });

  await t.test('concurrent redemptions of one code yield exactly one session', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);
    const { codes } = (await generate(ctx)).data;

    // The classic race: a conditional update is the only thing standing between
    // "single use" and "usable N times in the same instant".
    const attempts = await Promise.all(Array.from({ length: 6 }, () =>
      redeem({ userId: String(ctx.user._id), code: codes[0] })));
    const wins = attempts.filter((r) => r.status === 200);
    assert.equal(wins.length, 1, `expected exactly 1 winner, got ${wins.length}`);

    const stillUnused = await BackupCode.countDocuments({
      user: ctx.user._id,
      codeHash: BackupCode.hashCode(codes[0]),
      usedAt: null,
    });
    assert.equal(stillUnused, 0, 'the code must be marked used exactly once');
  });

  // ══ 8. INVALIDATION ═════════════════════════════════════════════════════

  await t.test('invalidating destroys every unused code', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);
    const { codes } = (await generate(ctx)).data;

    const del = await ctx.client.call('/api/security/backup-codes', { method: 'DELETE', useStepUp: true });
    assert.equal(del.status, 200, `invalidate failed: ${del.data.message}`);
    assert.equal(del.data.removed, CODE_COUNT, 'every unused code must be reported as removed');

    const summary = await ctx.client.call('/api/security/summary');
    assert.equal(summary.data.backupCodes.remaining, 0, 'the count must drop to zero');

    const r = await redeem({ userId: String(ctx.user._id), code: codes[0] });
    assert.equal(r.status, 401, 'an invalidated code must be dead');
  });

  await t.test('invalidating needs a step-up token', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);
    await generate(ctx);
    ctx.client.state.stepUp = ''; // drop it
    const r = await ctx.client.call('/api/security/backup-codes', { method: 'DELETE' });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'STEP_UP_REQUIRED');
  });

  // ══ 9. THE BOUNDARIES ══════════════════════════════════════════════════

  await t.test('redemption is refused on the email second-factor method', async () => {
    const ctx = await seed();
    const secret = await turnOnAuthenticator(ctx);
    await stepUp(ctx, secret);
    const { codes } = (await generate(ctx)).data;

    await stepUp(ctx, secret);
    const downgrade = await ctx.client.call('/api/auth/two-factor-method', {
      method: 'POST',
      body: { method: 'email', currentPassword: PASSWORD },
    });
    assert.equal(downgrade.status, 200, `switching method failed: ${downgrade.data.message}`);

    const r = await redeem({ userId: String(ctx.user._id), code: codes[0] });
    assert.equal(r.status, 400, 'the emailed code is already the second factor');
  });

  await t.test('one account cannot destroy another account’s codes', async () => {
    const victim = await seed();
    const attacker = await seed();
    const secret = await turnOnAuthenticator(victim);
    await stepUp(victim, secret);
    await generate(victim);

    const attackerSecret = await turnOnAuthenticator(attacker);
    await stepUp(attacker, attackerSecret);
    const del = await attacker.client.call('/api/security/backup-codes', { method: 'DELETE', useStepUp: true });
    assert.equal(del.status, 200);

    // The victim's codes must be untouched by someone else's invalidation.
    const victimSummary = await victim.client.call('/api/security/summary');
    assert.equal(victimSummary.data.backupCodes.remaining, CODE_COUNT,
      'invalidating your own codes must not reach another account');
  });

  await t.test('malformed redemption input is rejected, not crashed on', async () => {
    const unknown = new mongoose.Types.ObjectId().toString();
    assert.equal((await redeem({ userId: 'not-an-object-id', code: 'ABCDE-12345' })).status, 400);
    assert.equal((await redeem({ userId: unknown })).status, 400);
    assert.equal((await redeem({ userId: unknown, code: '' })).status, 400);
    assert.equal((await redeem({ userId: unknown, code: 'short' })).status, 401,
      'a well-formed request for an account without codes must not be a 400');
  });

  await t.test('a wrong code never reveals whether the account exists', async () => {
    const known = await seed();
    const unknownId = new mongoose.Types.ObjectId().toString();
    const a = await redeem({ userId: String(known.user._id), code: 'ZZZZZ-99999' });
    const b = await redeem({ userId: unknownId, code: 'ZZZZZ-99999' });
    assert.equal(a.status, b.status, 'status must match so the endpoint cannot enumerate accounts');
    assert.equal(a.status, 401);
    assert.deepEqual(a.data, b.data, 'the response body must be identical too');
  });
});
