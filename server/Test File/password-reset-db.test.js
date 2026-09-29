/**
 * THE WHOLE FLOW, AGAINST A REAL DATABASE AND A REAL HTTP SERVER.
 *
 * Every other reset test stubs the database. This one does not: it creates a
 * real user in MongoDB, drives the actual routes over HTTP, and asserts the
 * things that only a real Mongoose model can prove.
 *
 * WHY IT IS A SEPARATE FILE
 * -------------------------
 * The stubbed tests are fast and hermetic, which is what you want most of the
 * time. But a stub cannot catch the failures that come specifically from the
 * real implementation:
 *
 *   1. THE TTL INDEX. Expired grants are supposed to be removed by MongoDB. A
 *      stub has no indexes, so a wrong `index: { expires: 0 }` would never be
 *      noticed — and the symptom is expired credentials silently accumulating
 *      forever in the collection.
 *   2. THE UNIQUE CONSTRAINT ON tokenHash. A collision must be impossible.
 *   3. `select: false` ON THE DIGESTS. If that were ever dropped, a stray
 *      `.find()` would serialize token hashes into an API response or a log.
 *   4. THE PRE-SAVE HASH HOOK. This asserts the stored password is a real
 *      argon2id hash that verifies — that the reset actually changed the
 *      credential, rather than writing plaintext and appearing to work.
 *
 * Skips itself when no test database is reachable, so it never turns a local run red
 * for an unrelated reason.
 *
 * IT MUST USE A DEDICATED TEST DATABASE — AND THAT IS NOT OPTIONAL
 * ---------------------------------------------------------------
 * This file used to connect straight to `process.env.MONGO_URI` and then call
 * `dropDatabase()` in its `after` hook. `npm test` therefore DELETED THE ENTIRE
 * PRODUCTION DATABASE. It did so silently, on every run, and it is not
 * theoretical: the application's MONGO_URI carries no database name, so it
 * resolved to the driver's default database — literally named `test` — on the
 * live SuppliWise cluster, and the drop removed every user, admin, assessment
 * and subscription row on it.
 *
 * It now goes through testDbGuard, which refuses to run unless MONGO_TEST_URI
 * is set to something that is provably not the application's own database, and
 * skips (rather than fails) when no test database is configured. `after` no
 * longer drops anything: it deletes only the rows this suite created, so even a
 * misconfigured run cannot take data with it.
 */
const { testDbPreflight, connectTestDb } = require('./testDbGuard');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');

// Load .env FIRST, for the same reason as withResetRouter.js: `node --test`
// gives this file its own process, so nothing server/index.js would normally
// load is present. The reset route signs a JWT when it issues a grant, and
// without JWT_SECRET that throws — which arrived here as an undefined
// `resetUrl` on a 500 rather than as the obvious "no secret configured".
require('dotenv').config();

const { PASSWORD_RULES } = require('../utils/passwordRules');
const { verifyPassword, isArgon2id } = require('../utils/password');

const USER_ID = '507f1f77bcf86cd799439011';
const EMAIL = 'reset-smoke@example.test';
const CURRENT_PASSWORD = 'Cedar$Otter48!';
const NEW_PASSWORD = 'Mango$Tulip77!';
const ORIGIN = 'http://localhost:5173';

let dbUp = false;

/**
 * The skip decision is made HERE, at module load, and not inside `before`:
 * node:test reads a test's `skip` option when the test is REGISTERED, so a
 * value assigned later is ignored — the tests would run against a connection
 * that was never opened and fail on a buffering timeout instead of skipping.
 */
const options = testDbPreflight();
test.before(async () => {
  // The guard, not process.env.MONGO_URI. See the header.
  const result = await connectTestDb();
  dbUp = result.connected;
});

test.after(async () => {
  // NO dropDatabase(). Tear down only what this suite created, by a
  // throwaway-scoped filter, so an interrupted or misconfigured run can never
  // take unrelated data with it.
  if (mongoose.connection.readyState === 1) {
    const { User } = require('../models/User');
    const PasswordResetToken = require('../models/PasswordResetToken');
    const fixtures = await User.find({ email: EMAIL }).select('_id').lean().catch(() => []);
    for (const u of fixtures) {
      await PasswordResetToken.deleteMany({ user: u._id }).catch(() => {});
    }
    await User.deleteMany({ email: EMAIL }).catch(() => {});
  }
  await mongoose.disconnect().catch(() => {});
});

/**
 * Skip rather than fail when there is no TEST database to test against.
 *
 * Returns true when the caller must bail out, and the reason is either the
 * guard's own refusal (MONGO_TEST_URI missing, or pointing at the
 * application's database) or a connection that would not open. Crucially the
 * caller returns immediately, so nothing in the body ever reaches a database
 * that was not deliberately provided for tests.
 */
function requiresDb(t) {
  if (!dbUp) {
    t.skip(options.skip || 'test database unreachable — set MONGO_TEST_URI to run the real-model checks');
    return true;
  }
  return false;
}


/** Build the routers over a real database, with only the mailer stubbed. */
async function withServer(fn) {
  const emailUtils = require('../utils/email');
  const originalSend = emailUtils.sendPasswordResetEmail;
  const sent = [];
  emailUtils.sendPasswordResetEmail = async (to, payload) => {
    sent.push({ to, ...payload });
    return true;
  };

  // The service DESTRUCTURES `sendPasswordResetEmail` at require time, so the
  // stub has to be in place before the module is first loaded or the router
  // keeps a reference to the real mailer and `sent` stays empty. Re-requiring
  // per test is what the stubbed suites do for the same reason.
  delete require.cache[require.resolve('../routes/passwordReset')];
  delete require.cache[require.resolve('../utils/passwordReset')];

  const app = express();
  app.use(express.json());
  app.use('/api/auth/password-reset', require('../routes/passwordReset'));
  app.use('/api/auth', require('../routes/auth'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };

  try {
    return await fn({ call, sent });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    emailUtils.sendPasswordResetEmail = originalSend;
    delete require.cache[require.resolve('../routes/passwordReset')];
    delete require.cache[require.resolve('../utils/passwordReset')];
  }
}

async function makeUser() {
  const User = require('../models/User');
  await User.deleteMany({ email: EMAIL });
  return User.create({
    firstName: 'Reset',
    lastName: 'Smoke',
    email: EMAIL,
    password: CURRENT_PASSWORD,
    dateOfBirth: new Date('1990-01-01'),
    gender: 'Male',
  });
}

// ── 1. The model, on a real database ───────────────────────────────────────

test('the token model creates and reads back a grant', async (t) => {
  if (requiresDb(t)) return;
  const PasswordResetToken = require('../models/PasswordResetToken');
  const user = await makeUser();

  const { token, code } = PasswordResetToken.generateSecrets();
  await PasswordResetToken.store({
    userId: user._id, token, code, ttlMs: 60_000, ip: '127.0.0.1', userAgent: 'test',
  });

  const found = await PasswordResetToken.findActiveByTokenHash(token);
  assert.ok(found, 'a stored grant must be findable by its token');
  assert.equal(String(found.user), String(user._id));
});

test('the raw token and code are never returned by a read', async (t) => {
  if (requiresDb(t)) return;
  const PasswordResetToken = require('../models/PasswordResetToken');
  const user = await makeUser();
  const { token, code } = PasswordResetToken.generateSecrets();
  await PasswordResetToken.store({ userId: user._id, token, code, ttlMs: 60_000 });

  // The `select: false` on both digests is what makes this true. Without it, any
  // `.find()` anywhere in the codebase would serialize token hashes into a
  // response body or a log line.
  const plain = await PasswordResetToken.findOne({ user: user._id });
  const serialized = JSON.stringify(plain);
  assert.equal(plain.tokenHash, undefined, 'tokenHash must not be selected by default');
  assert.equal(plain.codeHash, undefined, 'codeHash must not be selected by default');
  assert.doesNotMatch(serialized, /tokenHash|codeHash/);

  // And the digests are not the raw secrets.
  const withSecrets = await PasswordResetToken.findOne({ user: user._id }).select('+tokenHash +codeHash');
  assert.notEqual(withSecrets.tokenHash, token);
  assert.notEqual(withSecrets.codeHash, code);
});

test('a grant can only be claimed once, atomically', async (t) => {
  if (requiresDb(t)) return;
  const PasswordResetToken = require('../models/PasswordResetToken');
  const user = await makeUser();
  const { token, code } = PasswordResetToken.generateSecrets();
  await PasswordResetToken.store({ userId: user._id, token, code, ttlMs: 60_000 });

  // Fired together. The guarantee is the conditional `usedAt: null` in the
  // query, so this is the only way to prove it is really there.
  const [a, b] = await Promise.all([
    PasswordResetToken.claimByTokenHash(token),
    PasswordResetToken.claimByTokenHash(token),
  ]);
  const wins = [a, b].filter(Boolean).length;
  assert.equal(wins, 1, `exactly one claim must succeed, got ${wins}`);
});

test('an expired grant is not findable, and the TTL index will remove it', async (t) => {
  if (requiresDb(t)) return;
  const PasswordResetToken = require('../models/PasswordResetToken');
  const user = await makeUser();
  const { token, code } = PasswordResetToken.generateSecrets();
  await PasswordResetToken.store({ userId: user._id, token, code, ttlMs: -1000 });

  assert.equal(await PasswordResetToken.findActiveByTokenHash(token), null, 'an expired grant must not validate');
  assert.equal(await PasswordResetToken.claimByTokenHash(token), null, 'nor be claimable');

  // Confirm the TTL index exists. Without it, rows accumulate forever and
  // expired credentials pile up in the collection.
  const indexes = await PasswordResetToken.collection.indexes();
  const ttl = indexes.find((index) => index.key && index.key.expiresAt === 1);
  assert.ok(ttl, `expected a TTL index on expiresAt, found: ${JSON.stringify(indexes.map((i) => i.key))}`);
  assert.equal(ttl.expireAfterSeconds, 0, 'rows must expire AT expiresAt, not after a delay');
});

test('the token digest is unique, so two grants cannot share a token', async (t) => {
  if (requiresDb(t)) return;
  const PasswordResetToken = require('../models/PasswordResetToken');
  const user = await makeUser();
  const { token, code } = PasswordResetToken.generateSecrets();
  await PasswordResetToken.store({ userId: user._id, token, code, ttlMs: 60_000 });

  const indexes = await PasswordResetToken.collection.indexes();
  const unique = indexes.find((index) => index.key && index.key.tokenHash === 1);
  assert.ok(unique, 'expected a unique index on tokenHash');
  assert.equal(unique.unique, true);
});

// ── 2. The flow, over real HTTP ────────────────────────────────────────────

test('a real reset changes the stored password to a verifiable argon2id hash', async (t) => {
  if (requiresDb(t)) return;
  const User = require('../models/User');

  await withServer(async ({ call, sent }) => {
    await makeUser();

    const requested = await call('/api/auth/password-reset/request', { email: EMAIL });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    assert.equal(requested.body.token, undefined, 'the link must never be echoed in the response');

    const token = new URL(sent[sent.length - 1].resetUrl).searchParams.get('token');
    assert.ok(token, 'the email must contain a link');

    const done = await call('/api/auth/password-reset/complete', { token, newPassword: NEW_PASSWORD });
    assert.equal(done.status, 200, JSON.stringify(done.body));

    // THE ASSERTION THAT MATTERS. Not "the response said 200" — that the
    // credential on disk actually changed, is a real hash, and verifies against
    // the new password and not the old one. A response of 200 with plaintext
    // still in the database would pass every other test in this file.
    const stored = await User.findOne({ email: EMAIL });
    assert.ok(isArgon2id(stored.password), `expected an argon2id hash, got ${String(stored.password).slice(0, 20)}…`);
    assert.equal(await verifyPassword(NEW_PASSWORD, stored.password), true, 'the new password must verify');
    assert.equal(await verifyPassword(CURRENT_PASSWORD, stored.password), false, 'the old password must not');
  });
});

test('a real link cannot be redeemed twice, and a second reset starts clean', async (t) => {
  if (requiresDb(t)) return;
  await withServer(async ({ call, sent }) => {
    await makeUser();

    await call('/api/auth/password-reset/request', { email: EMAIL });
    const first = new URL(sent[sent.length - 1].resetUrl).searchParams.get('token');

    const done = await call('/api/auth/password-reset/complete', { token: first, newPassword: NEW_PASSWORD });
    assert.equal(done.status, 200, JSON.stringify(done.body));

    const replay = await call('/api/auth/password-reset/complete', { token: first, newPassword: 'Another$Pass99!' });
    assert.equal(replay.status, 400, 'a single-use link must not work twice');

    // A fresh request still works after the previous one was spent — the grant
    // is per-request, not a one-shot per account.
    const again = await call('/api/auth/password-reset/request', { email: EMAIL });
    assert.equal(again.status, 200);
  });
});

test('the real policy is enforced end to end, not just in the unit tests', async (t) => {
  if (requiresDb(t)) return;
  await withServer(async ({ call, sent }) => {
    await makeUser();
    await call('/api/auth/password-reset/request', { email: EMAIL });
    const token = new URL(sent[sent.length - 1].resetUrl).searchParams.get('token');

    // One password per rule, all refused, and the link must survive every one.
    const refusals = [
      ['Aa1!aaaa', /at least 10 characters/i],
      ['alllowercase1!', /uppercase/i],
      ['ALLUPPERCASE1!', /lowercase/i],
      ['NoDigitsAnywhere!', /number/i],
      ['NoSymbolAnywhere1', /symbol/i],
      ['Password123!', /too easy to guess/i],
      ['a'.repeat(PASSWORD_RULES.maxLength) + 'aA1!', /at most 128/i],
    ];
    for (const [password, pattern] of refusals) {
      const res = await call('/api/auth/password-reset/complete', { token, newPassword: password });
      assert.equal(res.status, 400, `"${password.slice(0, 16)}" should be refused`);
      assert.match(res.body.message, pattern, `"${password.slice(0, 16)}" got: ${res.body.message}`);
    }

    // Still usable afterwards — a rejected password must not burn the link.
    const ok = await call('/api/auth/password-reset/complete', { token, newPassword: NEW_PASSWORD });
    assert.equal(ok.status, 200, `the link must survive every rejection: ${JSON.stringify(ok.body)}`);
  });
});

test('unknown addresses and real accounts are indistinguishable over the wire', async (t) => {
  if (requiresDb(t)) return;
  await withServer(async ({ call }) => {
    await makeUser();
    const known = await call('/api/auth/password-reset/request', { email: EMAIL });
    const unknown = await call('/api/auth/password-reset/request', { email: 'nobody-here@example.test' });
    assert.deepEqual(
      known.body,
      unknown.body,
      'these two must be byte-identical or the endpoint enumerates your users'
    );
    assert.equal(known.status, unknown.status);
  });
});

test('the rules the client is told to render are the rules the server applies', async (t) => {
  if (requiresDb(t)) return;
  await withServer(async ({ call }) => {
    const rules = await call('/api/auth/password-reset/rules');
    assert.equal(rules.status, 200);
    assert.equal(rules.body.minLength, PASSWORD_RULES.minLength);
    assert.equal(rules.body.maxLength, PASSWORD_RULES.maxLength);
    assert.equal(rules.body.checks.length, 6);
  });
});
