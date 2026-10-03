'use strict';
/**
 * The MFA transaction, and what it is actually FOR.
 *
 * ── The bug this exists to stop ────────────────────────────────────────────
 *
 * Sign-in is two steps. Step one (password) handed the client a bare `_id`.
 * Step two (`/auth/login-2fa`, `/auth/verify-login-otp`,
 * `/auth/security/backup-codes/redeem`) took that `_id` plus a code and issued
 * a fully authenticated session.
 *
 * So the second factor was, on its own, sufficient. Anyone who obtained a valid
 * TOTP or recovery code — a shoulder-surfed code, one read off a phishing page,
 * one phoned in by an impatient support agent — and who could guess or learn
 * the victim's user id could exchange it for a full session, with the password
 * never involved at any point. A Mongo ObjectId is a counter in disguise, and
 * for many accounts the id was in the sign-in response body anyway.
 *
 * The password step now mints a TRANSACTION, and these tests pin that the
 * second factor is honoured only against a live one, that it is single-use, and
 * that it expires and exhausts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const speakeasy = require('speakeasy');

require('dotenv').config();

const { startTestServer, connectTestDb } = require('./e2eServer');
const { testDbPreflight, skipMessage } = require('./testDbGuard');

const mfa = require('../utils/mfaTransaction');
const BackupCode = require('../models/BackupCode');
const User = require('../models/User');
const MfaTransaction = require('../models/MfaTransaction');
const secretBox = require('../utils/secretBox');

const preflight = testDbPreflight();
const PASSWORD = 'Probe!12345';

test('MFA transaction — the second factor is no longer sufficient on its own', { skip: preflight.skip }, async (t) => {
  const server = await startTestServer({ port: 5123 });
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
      await MfaTransaction.deleteMany({ user: id }).catch(() => {});
      await BackupCode.deleteMany({ user: id }).catch(() => {});
      await User.deleteOne({ _id: id }).catch(() => {});
    }
    await mongoose.disconnect().catch(() => {});
    await server.stop();
  });

  /** An account with a working authenticator, plus its plaintext seed. */
  const seed = async (overrides = {}) => {
    const email = `mfa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const user = await User.create({
      firstName: 'Mfa', lastName: 'Probe', name: 'Mfa Probe',
      email, password: PASSWORD, dateOfBirth: '1990-01-01', gender: 'Male',
      twoFactorEnabled: true, twoFactorMethod: 'authenticator',
      twoFactorSecretEnc: secretBox.encrypt(secret),
      twoFactorSecret: '',
      ...overrides,
    });
    created.push(user._id);
    return { user, email, secret };
  };

  const call = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

  /** The real first step: post a password, get a transaction back. */
  const startLogin = async (ctx) => call('/api/auth/login', { email: ctx.email, password: PASSWORD });

  const spent = new Set();
  const nextCode = (ctx) => {
    // verifyTotpOnce is single-use per account, so a suite that authenticates
    // repeatedly cannot keep sending the same code: it would be measuring the
    // replay cache rather than the thing it means to test. The server accepts a
    // +/-1 step window, so all three offsets are valid at any moment.
    for (const offset of [0, 1, -1]) {
      const key = `${ctx.user._id}:${offset}`;
      if (!spent.has(key)) {
        spent.add(key);
        return speakeasy.totp({ secret: ctx.secret, encoding: 'base32', counter: Math.floor(Date.now() / 30000) + offset });
      }
    }
    throw new Error('every usable TOTP step is spent — seed a new account');
  };

  // ══ 1. THE TRANSACTION IS ISSUED ════════════════════════════════════════

  await t.test('the password step mints a transaction', async () => {
    const ctx = await seed();
    const r = await startLogin(ctx);
    assert.equal(r.status, 200);
    assert.equal(r.data.requiresTwoFactor, true);
    assert.ok(r.data.mfaTransaction, 'the second factor is now addressed by an opaque token');
    assert.ok(r.data.mfaTransaction.length >= 32, 'and it is long enough to be unguessable');
    assert.ok(Array.isArray(r.data.mfaMethods) && r.data.mfaMethods.includes('totp'),
      'and the accepted factors are stated, decided server-side');

    // It is a HASH that is stored, never the token itself.
    const row = await MfaTransaction.findOne({ user: ctx.user._id }).lean();
    assert.ok(row, 'a transaction row exists');
    assert.notEqual(row.tokenHash, r.data.mfaTransaction, 'the raw token is never stored');
    assert.equal(row.tokenHash.length, 64, 'sha256 hex');
  });

  await t.test('the userId is still returned, so a stale client keeps working', async () => {
    // The compatibility contract matters: a PWA that has not refreshed sends
    // `userId`, and it must still be able to finish a sign-in.
    const ctx = await seed();
    const r = await startLogin(ctx);
    assert.equal(String(r.data.userId), String(ctx.user._id));

    const done = await call('/api/auth/login-2fa', { userId: String(ctx.user._id), otp: nextCode(ctx) });
    assert.equal(done.status, 200, 'the legacy shape must still complete a real sign-in');
    assert.ok(done.data.token);
  });

  // ══ 2. THE BYPASS IS CLOSED ═════════════════════════════════════════════

  await t.test('a valid TOTP with NO transaction gets nothing', async () => {
    // THE regression. Before this change the next line returned a session.
    const ctx = await seed();
    const r = await call('/api/auth/login-2fa', { userId: String(ctx.user._id), otp: nextCode(ctx) });
    assert.equal(r.status, 401, 'a second factor alone must not be a sign-in');
    assert.ok(!r.data.token, 'and no token is issued');

    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: 'Bearer not-a-token' } });
    assert.equal(me.status, 401);
  });

  await t.test('a valid recovery code with NO transaction gets nothing', async () => {
    // Same bypass, different factor — and a recovery code is worth a full
    // sign-in, so it matters just as much.
    const ctx = await seed();
    const { codes } = await BackupCode.generate(ctx.user._id);
    const r = await call('/api/auth/recovery-codes/verify', { userId: String(ctx.user._id), code: codes[0] });
    assert.equal(r.status, 401, 'a recovery code alone must not be a sign-in');
    assert.equal(await BackupCode.countDocuments({ user: ctx.user._id, codeHash: BackupCode.hashCode(codes[0]), usedAt: null }), 1,
      'and the code must NOT have been consumed by the attempt');
  });

  await t.test('a transaction for an account cannot be spent on a different factor', async () => {
    const ctx = await seed();
    // Log in BEFORE any recovery codes exist, so the password step decides this
    // account needs a TOTP and nothing else.
    const login = await startLogin(ctx);
    assert.deepEqual(login.data.mfaMethods, ['totp']);

    // Recovery codes are minted afterwards, then tried against that
    // transaction. The client cannot pick which factor the account is held to.
    const fresh = await BackupCode.generate(ctx.user._id);
    const r = await call('/api/auth/recovery-codes/verify', {
      mfaTransaction: login.data.mfaTransaction, code: fresh.codes[0],
    });
    assert.equal(r.status, 401, 'the transaction was opened for totp, not backup-code');
    assert.equal(await BackupCode.countDocuments({
      user: ctx.user._id, codeHash: BackupCode.hashCode(fresh.codes[0]), usedAt: null,
    }), 1, 'and the code must not have been consumed by the attempt');
  });

  await t.test('a transaction from one account cannot sign in another', async () => {
    const victim = await seed();
    const attacker = await seed();
    const login = await startLogin(victim);
    // The attacker's own valid code, spent against the victim's transaction.
    const r = await call('/api/auth/totp/verify', {
      mfaTransaction: login.data.mfaTransaction, otp: nextCode(attacker),
    });
    assert.equal(r.status, 401, 'the transaction decides the account, not the code');
  });

  // ══ 3. SINGLE USE ═══════════════════════════════════════════════════════

  await t.test('a transaction is spent by the first success and cannot be replayed', async () => {
    const ctx = await seed();
    const login = await startLogin(ctx);
    const token = login.data.mfaTransaction;

    const first = await call('/api/auth/totp/verify', { mfaTransaction: token, otp: nextCode(ctx) });
    assert.equal(first.status, 200);
    assert.ok(first.data.token);

    // A fresh, live code, spent against the same (now dead) transaction.
    const replay = await call('/api/auth/totp/verify', { mfaTransaction: token, otp: nextCode(ctx) });
    assert.equal(replay.status, 401, 'a transaction is good for exactly one sign-in');
  });

  await t.test('concurrent submissions of one transaction yield exactly one session', async () => {
    const ctx = await seed();
    const login = await startLogin(ctx);
    const token = login.data.mfaTransaction;

    // The SAME valid code, six times at once. That is the race: the
    // conditional update that spends the transaction is the only thing standing
    // between "single use" and "usable N times in the same instant".
    const code = nextCode(ctx);
    const attempts = await Promise.all([0, 1, 2, 3, 4, 5].map(() => call('/api/auth/totp/verify', {
      mfaTransaction: token, otp: code,
    })));
    const wins = attempts.filter((r) => r.status === 200);
    assert.equal(wins.length, 1, `expected exactly 1 winner, got ${wins.length}`);
  });

  await t.test('starting a new sign-in closes the previous transaction', async () => {
    const ctx = await seed();
    const first = await startLogin(ctx);
    const second = await startLogin(ctx);
    assert.notEqual(first.data.mfaTransaction, second.data.mfaTransaction);

    const r = await call('/api/auth/totp/verify', { mfaTransaction: first.data.mfaTransaction, otp: nextCode(ctx) });
    assert.equal(r.status, 401, 'the superseded window is dead');
  });

  // ══ 4. EXPIRY AND BUDGET ════════════════════════════════════════════════

  await t.test('an expired transaction is refused', async () => {
    const ctx = await seed();
    const login = await startLogin(ctx);
    await MfaTransaction.updateOne(
      { user: ctx.user._id, consumedAt: null },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const r = await call('/api/auth/totp/verify', { mfaTransaction: login.data.mfaTransaction, otp: nextCode(ctx) });
    assert.equal(r.status, 401);
  });

  await t.test('a transaction has a finite attempt budget', async () => {
    // A 6-digit code is a million possibilities, but a transaction with
    // unlimited attempts is a million-request oracle. The budget is enforced
    // inside the same conditional update that spends the transaction, so it
    // cannot be exceeded by racing.
    const ctx = await seed();
    const token = (await startLogin(ctx)).data.mfaTransaction;
    for (let i = 0; i < mfa.MAX_ATTEMPTS + 4; i += 1) {
      await call('/api/auth/totp/verify', { mfaTransaction: token, otp: '000000' });
    }
    // Whatever the transport-level throttling did along the way, the window
    // itself must now be dead: a CORRECT code still gets nothing. The account
    // lockout ladder may well answer 429 before the per-transaction budget is
    // reached — that is correct, separate defence in depth — so the assertion
    // is about the OUTCOME (no session) rather than about which layer stopped
    // it.
    const after = await call('/api/auth/totp/verify', { mfaTransaction: token, otp: nextCode(ctx) });
    assert.ok(after.status === 401 || after.status === 429, `unexpected status ${after.status}`);
    assert.ok(!after.data.token, 'a correct code after the budget is gone must still get nothing');
  });

  await t.test('the attempt budget is per transaction, not per account', async () => {
    // Asserted against the service rather than over HTTP, because over HTTP the
    // ACCOUNT lockout ladder escalates long before a per-transaction budget is
    // reached. That ladder is correct, separate behaviour, and not something
    // this test should be fighting.
    //
    // The property that matters: burning one window's guesses does not consume
    // the NEXT window's budget, so an attacker cannot pre-exhaust the sign-in
    // a victim is about to make.
    const ctx = await seed();
    const first = await mfa.start({ user: ctx.user._id, methods: ['totp'] });
    for (let i = 0; i < mfa.MAX_ATTEMPTS; i += 1) {
      await call('/api/auth/totp/verify', { mfaTransaction: first, otp: '000000' }).catch(() => {});
    }
    const second = await mfa.start({ user: ctx.user._id, methods: ['totp'] });
    const peeked = await mfa.peek(second);
    assert.ok(peeked, 'a fresh window must be fully available');
    assert.equal(peeked.attempts, 0, 'with its own untouched budget');
  });

  await t.test('garbage tokens are rejected without a lookup storm', async () => {
    for (const bad of ['', 'x', 'a'.repeat(31), 'a'.repeat(201), '../../etc/passwd', null, 12345, {}]) {
      const r = await call('/api/auth/totp/verify', { mfaTransaction: bad, otp: '123456' });
      assert.ok(r.status === 400 || r.status === 401, `must refuse ${JSON.stringify(bad)}`);
      assert.ok(!r.data.token, `and issue nothing for ${JSON.stringify(bad)}`);
    }
  });

  // ══ 5. WHAT THE SERVER DECIDES ══════════════════════════════════════════

  await t.test('the accepted factors are chosen from server state, not the client', async () => {
    const withPasskey = await seed();
    await require('../models/Passkey').create({
      user: withPasskey.user._id,
      credentialId: 'cred_' + Math.random().toString(36).slice(2),
      publicKey: 'x', counter: 0,
    });
    const login = await startLogin(withPasskey);
    assert.ok(login.data.mfaMethods.includes('passkey'),
      'a discoverable passkey satisfies the second factor on its own, so it is offered');
    assert.ok(login.data.mfaMethods.includes('totp'));
  });

  await t.test('a recovery code is offered only when the authenticator is the factor', async () => {
    const authenticator = await seed();
    await BackupCode.generate(authenticator.user._id);
    const a = await startLogin(authenticator);
    assert.ok(a.data.mfaMethods.includes('backup-code'));

    const emailed = await seed({ twoFactorMethod: 'email' });
    await BackupCode.generate(emailed.user._id);
    const e = await startLogin(emailed);
    assert.ok(!e.data.mfaMethods.includes('backup-code'),
      'on the emailed-code method the mailed code is already the second factor');
    assert.ok(e.data.mfaMethods.includes('email-otp'));
  });

  await t.test('an account with no second factor is offered no methods', async () => {
    const ctx = await seed({ twoFactorEnabled: false, twoFactorSecretEnc: '' });
    const r = await startLogin(ctx);
    assert.equal(r.data.requiresTwoFactor, undefined, 'no MFA is demanded of it');
    assert.equal(r.data.requiresOtp, true, 'it falls through to the emailed step');
  });

  // ══ 6. THE SERVICE ITSELF ═══════════════════════════════════════════════

  await t.test('the raw token is never persisted anywhere', async () => {
    const ctx = await seed();
    const raw = await mfa.start({ user: ctx.user._id, methods: ['totp'] });
    assert.ok(raw.length >= 40);
    const row = await MfaTransaction.findOne({ user: ctx.user._id, consumedAt: null }).lean();
    assert.notEqual(row.tokenHash, raw);
    const everything = await MfaTransaction.collection.find({ user: ctx.user._id }).toArray();
    assert.ok(!JSON.stringify(everything).includes(raw), 'the raw token must not appear in the document');
  });

  await t.test('peek does not spend, and spend is idempotent-safe', async () => {
    const ctx = await seed();
    const raw = await mfa.start({ user: ctx.user._id, methods: ['totp'] });
    assert.ok(await mfa.peek(raw), 'peek finds a live transaction');
    assert.ok(await mfa.peek(raw), 'and does not consume it');
    const spentOnce = await mfa.spend(raw, { method: 'totp' });
    assert.equal(spentOnce.ok, true);
    const spentTwice = await mfa.spend(raw, { method: 'totp' });
    assert.equal(spentTwice.ok, false, 'a second spend finds nothing');
    assert.equal(await mfa.peek(raw), null);
  });

  await t.test('spendById works too, so the legacy path closes its window', async () => {
    // The compatibility path resolves by (user, live) rather than by token, so
    // it must still be able to SPEND what it found — otherwise the window stays
    // open for unlimited code attempts, which is the hole this all exists to
    // close.
    const ctx = await seed();
    const raw = await mfa.start({ user: ctx.user._id, methods: ['totp'] });
    const row = await MfaTransaction.findOne({ tokenHash: mfa.hashToken(raw) }).lean();
    const done = await mfa.spendById(row._id, { method: 'totp' });
    assert.equal(done.ok, true);
    assert.equal((await mfa.spendById(row._id, { method: 'totp' })).ok, false);
  });

  await t.test('methodsFor never returns an empty list', async () => {
    // A transaction with no methods would be one nothing can be spent on,
    // which reads to a user as "your code is wrong".
    for (const user of [
      { twoFactorEnabled: false },
      { twoFactorEnabled: true, twoFactorMethod: 'authenticator' },
      { twoFactorEnabled: true, twoFactorMethod: 'email' },
      null,
    ]) {
      const methods = mfa.methodsFor(user, { passkeys: 0, backupCodeCount: 0 });
      assert.ok(Array.isArray(methods) && methods.length > 0, `must offer something for ${JSON.stringify(user)}`);
    }
  });
});
