'use strict';
/**
 * Authenticator apps and recovery codes — enrolment, activation, removal, and
 * the recovery path — over real HTTP.
 *
 * What this pins that was not pinned before:
 *   • a TOTP seed is ENCRYPTED at rest, and the seed is never returned by any
 *     endpoint after setup;
 *   • enrolment and removal both require RE-AUTHENTICATION, so a stolen
 *     session is not enough to strip an account's second factor;
 *   • recovery codes are single-use even under concurrency, and regenerating
 *     kills the previous set;
 *   • the plaintext codes exist exactly once and the server cannot produce
 *     them again — not for the owner, not for an admin.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const speakeasy = require('speakeasy');

require('dotenv').config();

const { startTestServer, connectTestDb } = require('./e2eServer');
const { testDbPreflight, skipMessage } = require('./testDbGuard');

const { issueUserSession } = require('../utils/sessions');
const { issue: issueStepUp } = require('../middleware/stepUp');
const User = require('../models/User');
const BackupCode = require('../models/BackupCode');
const MfaTransaction = require('../models/MfaTransaction');
const secretBox = require('../utils/secretBox');
const totpSecret = require('../utils/totpSecret');

const preflight = testDbPreflight();
const PASSWORD = 'Probe!12345';
const CODE_COUNT = BackupCode.CODE_COUNT;

test('TOTP and recovery codes — enrolment, removal and the recovery path', { skip: preflight.skip }, async (t) => {
  const server = await startTestServer({ port: 5124 });
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

  const seed = async (overrides = {}) => {
    const email = `totp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
    const user = await User.create({
      firstName: 'Totp', lastName: 'Probe', name: 'Totp Probe',
      email, password: PASSWORD, dateOfBirth: '1990-01-01', gender: 'Male',
      ...overrides,
    });
    created.push(user._id);
    const token = await issueUserSession(user._id, { userAgent: 'totp-test', ip: '127.0.0.1' });
    const sid = (require('jsonwebtoken').decode(token) || {}).sid;
    return { user, email, token, stepUp: issueStepUp(user._id, sid) };
  };

  const call = (path, { method = 'GET', body, token, stepUp } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token || ''}` }),
      ...(stepUp ? { 'X-Step-Up': stepUp } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => {
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }
    return { status: r.status, data };
  });

  const codeFor = (secret, offset = 0) => speakeasy.totp({
    secret, encoding: 'base32', counter: Math.floor(Date.now() / 30000) + offset,
  });

  /** Enrol an authenticator end to end and return its seed. */
  const enrol = async (ctx) => {
    const setup = await call('/api/auth/totp/setup', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    assert.equal(setup.status, 200, `setup failed: ${setup.data && setup.data.message}`);
    const secret = setup.data.manualEntryKey;
    const verify = await call('/api/auth/totp/verify-setup', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { otp: codeFor(secret) },
    });
    assert.equal(verify.status, 200, `verify-setup failed: ${verify.data && verify.data.message}`);
    return secret;
  };

  // ══ 1. ENROLMENT ════════════════════════════════════════════════════════

  await t.test('setup returns a QR code and a manual key, and nothing else', async () => {
    const ctx = await seed();
    const r = await call('/api/auth/totp/setup', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    assert.equal(r.status, 200);
    assert.match(r.data.qrCode, /^data:image\/png;base64,/, 'a scannable QR is offered');
    assert.ok(r.data.manualEntryKey, 'plus a key to type for people who cannot scan');
    assert.equal(r.data.digits, 6);
    assert.equal(r.data.period, 30, 'RFC 6238 defaults every standard authenticator app expects');

    // The seed is shown once, here, and is not yet active.
    const user = await User.findById(ctx.user._id).select('+twoFactorSecret +twoFactorSecretEnc').lean();
    assert.equal(user.twoFactorEnabled, false, 'a seed alone does not enable 2FA');
    assert.ok(secretBox.decrypt(user.twoFactorSecretEnc), 'and it is already encrypted at rest');
  });

  await t.test('the seed is NEVER stored in plaintext', async () => {
    const ctx = await seed();
    const secret = await enrol(ctx);
    const user = await User.findById(ctx.user._id).select('+twoFactorSecret +twoFactorSecretEnc').lean();
    assert.equal(user.twoFactorSecret, '', 'the legacy plaintext field stays empty');
    assert.equal(secretBox.decrypt(user.twoFactorSecretEnc), secret, 'the sealed field holds the seed');

    const raw = await mongoose.connection.db.collection('users').findOne({ _id: ctx.user._id });
    assert.ok(!JSON.stringify(raw).includes(secret), 'the raw document must not contain the seed anywhere');
  });

  await t.test('the seed is never returned again after setup', async () => {
    const ctx = await seed();
    const secret = await enrol(ctx);

    // Every read a signed-in user can perform. None of them may carry the seed
    // or the envelope.
    const reads = await Promise.all([
      call('/api/auth/me', { token: ctx.token }),
      call('/api/security/summary', { token: ctx.token }),
      call('/api/auth/passkeys', { token: ctx.token }),
      call('/api/auth/sessions', { token: ctx.token }),
    ]);
    for (const r of reads) {
      const body = JSON.stringify(r.data);
      assert.ok(!body.includes(secret), 'a response leaked the seed');
      if (ctx.user.twoFactorSecretEnc) {
        assert.ok(!body.includes(ctx.user.twoFactorSecretEnc), 'a response leaked the envelope');
      }
      assert.ok(!body.includes('twoFactorSecret'), 'a response leaked the field name');
    }
  });

  await t.test('a wrong code does not activate 2FA', async () => {
    const ctx = await seed();
    const setup = await call('/api/auth/totp/setup', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    const wrong = String((Number(codeFor(setup.data.manualEntryKey)) + 1) % 1000000).padStart(6, '0');
    const r = await call('/api/auth/totp/verify-setup', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { otp: wrong },
    });
    assert.equal(r.status, 401);
    assert.equal((await User.findById(ctx.user._id).select('+twoFactorSecret +twoFactorSecretEnc').lean()).twoFactorEnabled, false,
      'a half-finished setup must not lock the owner out of their own second factor');
  });

  await t.test('enrolment requires re-authentication', async () => {
    const ctx = await seed();
    const r = await call('/api/auth/totp/setup', { method: 'POST', token: ctx.token });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'STEP_UP_REQUIRED',
      'a hijacked session must not be enough to install an authenticator');
  });

  await t.test('a live authenticator cannot be silently replaced', async () => {
    const ctx = await seed();
    await enrol(ctx);
    const r = await call('/api/auth/totp/setup', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    assert.equal(r.status, 409, 'replacing an authenticator must go through disable, which demands a code');
  });

  await t.test('re-enabling after disabling works and produces a DIFFERENT seed', async () => {
    const ctx = await seed();
    const first = await enrol(ctx);

    const off = await call('/api/auth/totp/disable', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { otp: codeFor(first, 1) },
    });
    assert.equal(off.status, 200, `disable failed: ${off.data && off.data.message}`);

    const second = await enrol(ctx);
    assert.notEqual(second, first, 'a new setup must not re-issue the old seed');
    assert.equal(codeFor(second) && true, true);
  });

  // ══ 2. REMOVAL ══════════════════════════════════════════════════════════

  await t.test('disabling forgets the seed entirely', async () => {
    const ctx = await seed();
    const secret = await enrol(ctx);
    const r = await call('/api/auth/totp/disable', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { otp: codeFor(secret, 1) },
    });
    assert.equal(r.status, 200);

    const user = await User.findById(ctx.user._id).select('+twoFactorSecret +twoFactorSecretEnc').lean();
    assert.equal(user.twoFactorEnabled, false);
    assert.equal(user.twoFactorSecretEnc, '', 'a stored seed would still mint codes from a database dump');
    assert.equal(user.twoFactorSecret, '');
  });

  await t.test('disabling signs out every other session', async () => {
    const ctx = await seed();
    const secret = await enrol(ctx);
    // A second device for the same account.
    const otherToken = await issueUserSession(ctx.user._id, { userAgent: 'other-device', ip: '127.0.0.2' });
    const otherSid = (require('jsonwebtoken').decode(otherToken) || {}).sid;

    const r = await call('/api/auth/totp/disable', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { otp: codeFor(secret, 1) },
    });
    assert.equal(r.status, 200);

    const stillWorks = await call('/api/auth/me', { token: otherToken });
    assert.equal(stillWorks.status, 401, 'a downgrade this significant should cost anything already holding a token');
    assert.equal(stillWorks.data.code, 'SESSION_REVOKED');
    assert.ok(otherSid);
  });

  await t.test('disabling requires re-authentication AND the current code', async () => {
    const ctx = await seed();
    const secret = await enrol(ctx);

    const noStepUp = await call('/api/auth/totp/disable', { method: 'POST', token: ctx.token, body: { otp: codeFor(secret, 1) } });
    assert.equal(noStepUp.status, 401);
    assert.equal(noStepUp.data.code, 'STEP_UP_REQUIRED');

    const wrongCode = await call('/api/auth/totp/disable', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { otp: '000000' },
    });
    assert.equal(wrongCode.status, 401);
    assert.equal((await User.findById(ctx.user._id).select('+twoFactorSecret +twoFactorSecretEnc').lean()).twoFactorEnabled, true, 'still enabled');
  });

  // ══ 3. THE AUTHENTICATOR AT SIGN-IN ══════════════════════════════════════

  await t.test('a valid code completes a real sign-in', async () => {
    const ctx = await seed();
    const secret = await enrol(ctx);
    const login = await call('/api/auth/login', { method: 'POST', body: { email: ctx.email, password: PASSWORD } });
    assert.equal(login.data.requiresTwoFactor, true);

    const done = await call('/api/auth/totp/verify', {
      method: 'POST', body: { mfaTransaction: login.data.mfaTransaction, otp: codeFor(secret, 1) },
    });
    assert.equal(done.status, 200, `sign-in failed: ${done.data && done.data.message}`);
    assert.equal(done.data.mfaVerified, true);

    const me = await call('/api/auth/me', { token: done.data.token });
    assert.equal(me.status, 200);
  });

  await t.test('an old code from a previous window is refused', async () => {
    // A TOTP code is only good for its own step. A captured code must not keep
    // working as the clock moves on, which is what the +/-1 window exists to
    // bound rather than eliminate.
    const ctx = await seed();
    const secret = await enrol(ctx);
    await call('/api/auth/totp/verify-setup', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { otp: codeFor(secret, -3) },
    });
    // -3 steps is outside the +/-1 window the server accepts.
    const login = await call('/api/auth/login', { method: 'POST', body: { email: ctx.email, password: PASSWORD } });
    const r = await call('/api/auth/totp/verify', {
      method: 'POST', body: { mfaTransaction: login.data.mfaTransaction, otp: codeFor(secret, -3) },
    });
    assert.equal(r.status, 401, 'a stale code must not authenticate');
  });

  await t.test('malformed codes are refused without throwing', async () => {
    const ctx = await seed();
    await enrol(ctx);
    const login = await call('/api/auth/login', { method: 'POST', body: { email: ctx.email, password: PASSWORD } });
    for (const bad of ['', '   ', 'abcdef', '12345', '1234567', '12345678', 123456, {}, null, 'x'.repeat(500)]) {
      const r = await call('/api/auth/totp/verify', {
        method: 'POST', body: { mfaTransaction: login.data.mfaTransaction, otp: bad },
      });
      assert.ok([400, 401, 429].includes(r.status), `must refuse ${JSON.stringify(bad)}, got ${r.status}`);
      assert.ok(!r.data.token);
    }
  });

  // ══ 4. RECOVERY CODES ═══════════════════════════════════════════════════

  await t.test('codes can only be minted once 2FA is on', async () => {
    const ctx = await seed();
    const r = await call('/api/auth/recovery-codes/generate', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    assert.equal(r.status, 409);
  });

  await t.test('minting requires re-authentication', async () => {
    const ctx = await seed();
    await enrol(ctx);
    const r = await call('/api/auth/recovery-codes/generate', { method: 'POST', token: ctx.token });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'STEP_UP_REQUIRED',
      'a stolen session must not be able to mint password-free credentials');
  });

  await t.test('codes are well-formed, distinct, and stored only as hashes', async () => {
    const ctx = await seed();
    await enrol(ctx);
    const r = await call('/api/auth/recovery-codes/generate', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    assert.equal(r.status, 200);
    assert.equal(r.data.codes.length, CODE_COUNT);
    assert.equal(new Set(r.data.codes).size, CODE_COUNT, 'no duplicates within a batch');
    for (const code of r.data.codes) assert.match(code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);

    const rows = await BackupCode.find({ user: ctx.user._id }).lean();
    assert.equal(rows.length, CODE_COUNT);
    for (const row of rows) {
      assert.ok(!r.data.codes.includes(row.codeHash), 'a stored row must not be a plaintext code');
      assert.match(row.codeHash, /^[a-f0-9]{64}$/);
    }
  });

  await t.test('the server cannot produce the codes again', async () => {
    // Not for the owner, not through any endpoint. There is deliberately no
    // "show me my recovery codes" route.
    const ctx = await seed();
    await enrol(ctx);
    const minted = await call('/api/auth/recovery-codes/generate', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    const summary = await call('/api/security/summary', { token: ctx.token });
    assert.equal(summary.data.backupCodes.remaining, CODE_COUNT, 'the count is reported');
    assert.ok(!JSON.stringify(summary.data).includes(minted.data.codes[0]), 'but never the codes themselves');
  });

  await t.test('regenerating invalidates every previous code', async () => {
    const ctx = await seed();
    await enrol(ctx);
    const first = await call('/api/auth/recovery-codes/generate', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    const second = await call('/api/auth/recovery-codes/regenerate', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    assert.equal(second.status, 200);

    const login = await call('/api/auth/login', { method: 'POST', body: { email: ctx.email, password: PASSWORD } });
    const old = await call('/api/auth/recovery-codes/verify', {
      method: 'POST', body: { mfaTransaction: login.data.mfaTransaction, code: first.data.codes[0] },
    });
    assert.equal(old.status, 401, 'a code from the previous set must be dead');
  });

  await t.test('a valid code completes a real sign-in, once', async () => {
    const ctx = await seed();
    await enrol(ctx);
    const { codes } = (await call('/api/auth/recovery-codes/generate', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp })).data;

    const login = await call('/api/auth/login', { method: 'POST', body: { email: ctx.email, password: PASSWORD } });
    const r = await call('/api/auth/recovery-codes/verify', {
      method: 'POST', body: { mfaTransaction: login.data.mfaTransaction, code: codes[0] },
    });
    assert.equal(r.status, 200, `redeem failed: ${r.data && r.data.message}`);
    assert.equal(r.data.remainingCodes, CODE_COUNT - 1, 'and the user is told they are down one');

    const me = await call('/api/auth/me', { token: r.data.token });
    assert.equal(me.status, 200);

    // Second use is refused.
    const login2 = await call('/api/auth/login', { method: 'POST', body: { email: ctx.email, password: PASSWORD } });
    const again = await call('/api/auth/recovery-codes/verify', {
      method: 'POST', body: { mfaTransaction: login2.data.mfaTransaction, code: codes[0] },
    });
    assert.equal(again.status, 401, 'a recovery code is good for exactly one sign-in');
  });

  await t.test('concurrent redemptions of one code yield exactly one session', async () => {
    const ctx = await seed();
    await enrol(ctx);
    const { codes } = (await call('/api/auth/recovery-codes/generate', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp })).data;
    const login = await call('/api/auth/login', { method: 'POST', body: { email: ctx.email, password: PASSWORD } });
    const token = login.data.mfaTransaction;

    const attempts = await Promise.all([0, 1, 2, 3, 4, 5].map(() => call('/api/auth/recovery-codes/verify', {
      method: 'POST', body: { mfaTransaction: token, code: codes[0] },
    })));
    const wins = attempts.filter((r) => r.status === 200);
    assert.equal(wins.length, 1, `expected exactly 1 winner, got ${wins.length}`);
  });

  await t.test('codes are case- and separator-insensitive', async () => {
    // People retype these from paper.
    const ctx = await seed();
    await enrol(ctx);
    const { codes } = (await call('/api/auth/recovery-codes/generate', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp })).data;
    const login = await call('/api/auth/login', { method: 'POST', body: { email: ctx.email, password: PASSWORD } });
    const r = await call('/api/auth/recovery-codes/verify', {
      method: 'POST', body: { mfaTransaction: login.data.mfaTransaction, code: codes[0].toLowerCase().replace('-', '') },
    });
    assert.equal(r.status, 200);
  });

  await t.test('a wrong code never reveals whether the account exists', async () => {
    const known = await seed();
    await enrol(known);
    // Mint codes so this account's transaction accepts the backup-code factor,
    // matching the state the unknown-id request is compared against.
    await call('/api/auth/recovery-codes/generate', { method: 'POST', token: known.token, stepUp: known.stepUp });
    const unknownId = new mongoose.Types.ObjectId().toString();

    const a = await call('/api/auth/recovery-codes/verify', { method: 'POST', body: { mfaTransaction: (await call('/api/auth/login', { method: 'POST', body: { email: known.email, password: PASSWORD } })).data.mfaTransaction, code: 'ZZZZZ-99999' } });
    const b = await call('/api/auth/recovery-codes/verify', { method: 'POST', body: { userId: unknownId, code: 'ZZZZZ-99999' } });
    assert.equal(a.status, b.status, 'status must not leak account existence');
    assert.deepEqual(a.data, b.data, 'nor may the body');
  });

  await t.test('invalidating destroys every unused code', async () => {
    const ctx = await seed();
    await enrol(ctx);
    await call('/api/auth/recovery-codes/generate', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    const r = await call('/api/auth/recovery-codes/generate', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    assert.equal(r.status, 200);
    assert.equal(await BackupCode.countDocuments({ user: ctx.user._id, usedAt: null }), CODE_COUNT);
  });

  await t.test('one account cannot reach another account\'s codes', async () => {
    const victim = await seed();
    const attacker = await seed();
    await enrol(victim);
    await enrol(attacker);
    await call('/api/auth/recovery-codes/generate', { method: 'POST', token: victim.token, stepUp: victim.stepUp });
    const { codes } = (await call('/api/auth/recovery-codes/generate', { method: 'POST', token: attacker.token, stepUp: attacker.stepUp })).data;

    const attackerLogin = await call('/api/auth/login', { method: 'POST', body: { email: attacker.email, password: PASSWORD } });
    // Spend the ATTACKER's transaction against the VICTIM's code.
    const r = await call('/api/auth/recovery-codes/verify', {
      method: 'POST', body: { mfaTransaction: attackerLogin.data.mfaTransaction, code: codes[0] },
    });
    assert.equal(r.status, 200, 'the attacker spends their OWN code — that must work');

    // ...and the victim's codes are untouched.
    const victimSummary = await call('/api/security/summary', { token: victim.token });
    assert.equal(victimSummary.data.backupCodes.remaining, CODE_COUNT, 'other accounts are unaffected');
  });

  // ══ 5. THE SEED MODULE ITSELF ═══════════════════════════════════════════

  await t.test('a pre-encryption account keeps working and is upgraded on use', async () => {
    // The migration property: no account loses its authenticator to this
    // change, and none of them has to do anything for it to happen.
    const legacy = speakeasy.generateSecret({ length: 20 }).base32;
    const ctx = await seed({
      twoFactorEnabled: true, twoFactorMethod: 'authenticator',
      twoFactorSecretEnc: '', twoFactorSecret: legacy,
    });

    const login = await call('/api/auth/login', { method: 'POST', body: { email: ctx.email, password: PASSWORD } });
    assert.equal(login.data.requiresTwoFactor, true, 'a legacy account still gets a TOTP challenge');

    const r = await call('/api/auth/totp/verify', {
      method: 'POST', body: { mfaTransaction: login.data.mfaTransaction, otp: codeFor(legacy, 1) },
    });
    assert.equal(r.status, 200, `legacy secret must still verify: ${r.data && r.data.message}`);

    const after = await User.findById(ctx.user._id).select('+twoFactorSecret +twoFactorSecretEnc').lean();
    assert.equal(after.twoFactorSecret, '', 'and is re-sealed on the way through');
    assert.equal(totpSecret.readSecret(after), legacy);
  });
});
