/**
 * A PROVEN PASSWORD MUST NEVER BE REFUSED BY SOMETHING INCIDENTAL TO IT.
 *
 * TWO BUGS THIS LOCKS DOWN
 * ------------------------
 *
 * 1. THE PERMANENT LOCKOUT
 *    `/login` recorded the sign-in metadata (lastLoginAt / lastLoginIp /
 *    lastLoginUserAgent / lastLoginLocation) with a bare `await user.save()`.
 *    ANY failure there surfaced as a 500 "Something went wrong. Please try
 *    again later." — AFTER the password had been accepted.
 *
 *    It is a PERMANENT lockout, not a blip, because it fails identically every
 *    time. It was reproduced with a user document whose name the current
 *    validation rules reject — a value written before those rules tightened, or
 *    inserted by a script:
 *
 *        [login] User validation failed: lastName: Last name can only contain
 *        letters, spaces, hyphens, apostrophes and periods.
 *
 *    Nothing about signing in depends on the "last seen" fields, so a document
 *    that cannot be saved is a reason to LOG, not to refuse. Before this, such
 *    an account could never sign in again, with no recourse and no way for the
 *    user to tell anything was wrong.
 *
 * 2. INFRASTRUCTURE BLIPS READ AS THE USER'S FAULT
 *    A dropped MongoDB socket produced the same opaque 500:
 *
 *        [login] connection 10 to 159.143.174.62:27017 timed out
 *
 *    A 500 with generic wording says nothing and invites a blind retry into the
 *    same transient failure — which then looks like a wrong password. Database
 *    and network trouble is OUR side and it clears on its own, so it is a 503
 *    with a Retry-After and a message that says so.
 *
 * The database is stubbed throughout: these assert the ROUTE's contract, not
 * MongoDB's behaviour.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Load .env FIRST, for the same reason as withResetRouter.js: `node --test`
// gives this file its own process, so nothing server/index.js would load is
// present. The login route mints a session JWT, and without JWT_SECRET that
// throws — which arrived here as a missing `requiresTwoFactor` on a 500 rather
// than as the obvious "no secret configured".
require('dotenv').config();

const User = require('../models/User');
const emailUtils = require('../utils/email');
const sessionUtils = require('../utils/sessions');
const { stubQuery } = require('./stubQuery');
// /login now mints an MFA transaction and, for accounts with a second factor,
// counts passkeys and unused recovery codes. Each is a real round-trip, so a
// suite that stubs only User leaves them buffering against a connection that
// does not exist and the route answers 500 after a 10s timeout.
const { stubMfaModels } = require('./stubMfaModels');

const USER_ID = '507f1f77bcf86cd799439011';
const EMAIL = 'demo@example.com';
const PASSWORD = 'Secret123';

/** What mongoose throws when a document violates the schema. */
function validationError(message) {
  const err = new Error(message || 'Validation failed');
  err.name = 'ValidationError';
  return err;
}

/** What the driver throws when a pooled socket times out. */
function mongoNetworkTimeout() {
  const err = new Error('connection 10 to 159.143.174.62:27017 timed out');
  err.name = 'MongoNetworkError';
  return err;
}

/** What the driver throws when no server can be selected in time. */
function mongoServerSelectionTimeout() {
  const err = new Error('Server selection timed out after 10000 ms');
  err.name = 'MongoServerSelectionError';
  return err;
}

async function withAuthRouter({ deliver = () => true, user }, fn) {
  const originals = {
    findOne: User.findOne,
    sendOtpEmail: emailUtils.sendOtpEmail,
    issueUserSession: sessionUtils.issueUserSession,
    nodeEnv: process.env.NODE_ENV,
  };
  const sentCodes = [];
  process.env.NODE_ENV = 'test';
  // stubQuery, not a bare object: /login projects the fields it needs with
  // `.select(...)`, and a plain object is not chainable. See stubQuery.js.
  User.findOne = () => stubQuery(() => (typeof user === 'function' ? user() : user));
  // The second step of sign-in touches three more models; see stubMfaModels.js.
  // A live transaction double is configured because /verify-login-otp accepts a
  // bare userId only while one exists for the account.
  const MFA_TRANSACTION = 'test-only-transaction-aaaaaaaaaaaaaaaaaaaaaaaa';
  const restoreMfaModels = stubMfaModels({
    transaction: { _id: 'tx1', user: USER_ID, methods: ['email-otp', 'totp', 'backup-code'] },
  });
  emailUtils.sendOtpEmail = async (to, otp, type) => {
    sentCodes.push({ to, otp, type });
    return deliver(to, otp, type);
  };
  sessionUtils.issueUserSession = async () => 'stub.session.token';

  delete require.cache[require.resolve('../routes/auth')];
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (route, body) => {
    const res = await fetch(`${base}/api/auth${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, retryAfter: res.headers.get('retry-after') };
  };

  try {
    return await fn({ call, sentCodes, mfaTransaction: MFA_TRANSACTION });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    User.findOne = originals.findOne;
    emailUtils.sendOtpEmail = originals.sendOtpEmail;
    sessionUtils.issueUserSession = originals.issueUserSession;
    process.env.NODE_ENV = originals.nodeEnv;
    delete require.cache[require.resolve('../routes/auth')];
  }
}

/** A user whose metadata write blows up — the unsaveable document. */
function unsaveableUser() {
  return {
    _id: USER_ID, email: EMAIL, firstName: 'Demo', lastName: 'User',
    fullName: 'Demo User', dateOfBirth: new Date('1990-01-01'), gender: 'Male',
    profilePicture: '', bannerPicture: '',
    accountStatus: 'active', twoFactorEnabled: false, twoFactorMethod: 'authenticator',
    matchPassword: async (v) => v === PASSWORD,
    save: async () => { throw validationError('User validation failed: lastName: Last name can only contain letters'); },
  };
}

const healthyUser = () => unsaveableUser() && ({
  ...unsaveableUser(),
  save: async () => {},
});

// ── 1. The permanent lockout ──────────────────────────────────────────────

test('an account whose metadata cannot be saved can still sign in', async () => {
  await withAuthRouter({ user: unsaveableUser }, async ({ call, sentCodes , mfaTransaction }) => {
    const res = await call('/login', { email: EMAIL, password: PASSWORD });

    // The password was correct. The sign-in must complete.
    assert.equal(
      res.status, 200,
      `a failed metadata write must not refuse a valid sign-in, got ${res.status} ${JSON.stringify(res.body)}`
    );
    assert.equal(res.body.requiresOtp, true, 'the login must still reach the verification step');
    assert.equal(sentCodes.length, 1, 'and the code must still be sent');

    // And it must not be reported as a server fault — this is a data problem,
    // logged server-side, not the user's problem.
    assert.notEqual(res.body.message, 'Something went wrong. Please try again later.');
  });
});

test('an account whose metadata cannot be saved reaches the authenticator step too', async () => {
  // The 2FA branch returns before the OTP code is issued, so it needs its own
  // assertion: a broken document must not block that path either.
  //
  // `twoFactorSecret` is REQUIRED as well as the flag. `/login` deliberately
  // only takes the authenticator branch when a secret actually exists — an
  // account with `twoFactorEnabled` but no secret is a half-finished setup, and
  // answering with an authenticator prompt would be a code the server can never
  // verify, locking the holder out of their own second factor. The route falls
  // back to an emailed code in that case, so without the secret here this
  // fixture would exercise the fallback and not the branch it names.
  const twoFa = {
    ...unsaveableUser(),
    twoFactorEnabled: true,
    twoFactorMethod: 'authenticator',
    twoFactorSecret: 'JBSWY3DPEHPK3PXP',
  };
  await withAuthRouter({ user: twoFa }, async ({ call , mfaTransaction }) => {
    const res = await call('/login', { email: EMAIL, password: PASSWORD });
    assert.equal(res.status, 200, `got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.requiresTwoFactor, true, 'the authenticator prompt must still be shown');
  });
});

test('the unsaveable document does not poison the rest of the session', async () => {
  await withAuthRouter({ user: unsaveableUser, deliver: () => true }, async ({ call, sentCodes , mfaTransaction }) => {
    const login = await call('/login', { email: EMAIL, password: PASSWORD });
    assert.equal(login.status, 200);
    const code = sentCodes[sentCodes.length - 1].otp;
    const verify = await call('/verify-login-otp', { userId: USER_ID, mfaTransaction, otp: code });
    assert.equal(verify.status, 200, `the code must still verify, got ${JSON.stringify(verify.body)}`);
    assert.ok(verify.body.token, 'and a session must still be issued');
  });
});

// ── 2. Infrastructure blips ───────────────────────────────────────────────

test('a dropped database connection is a retryable 503, not an opaque 500', async () => {
  await withAuthRouter({ user: () => { throw mongoNetworkTimeout(); } }, async ({ call , mfaTransaction }) => {
    const res = await call('/login', { email: EMAIL, password: PASSWORD });

    assert.equal(res.status, 503, `expected 503, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.retryAfter, '5', 'a transient failure must tell the client when to come back');
    assert.doesNotMatch(res.body.message || '', /something went wrong/i, 'must not read like a fault the user caused');
    assert.match(res.body.message || '', /try again/i, 'must say a retry is the right move');
    // Never leak the driver's internals.
    assert.doesNotMatch(res.body.message || '', /27017|mongo|timed out|socket/i);
  });
});

test('a server-selection timeout is also reported as retryable', async () => {
  await withAuthRouter({ user: () => { throw mongoServerSelectionTimeout(); } }, async ({ call , mfaTransaction }) => {
    const res = await call('/login', { email: EMAIL, password: PASSWORD });
    assert.equal(res.status, 503, `expected 503, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.retryAfter, '5');
  });
});

test('the same applies while verifying the code', async () => {
  await withAuthRouter({ user: healthyUser }, async ({ call , mfaTransaction }) => {
    // The OTP lookup is the first thing /verify-login-otp does.
    const origFindById = User.findById;
    // Rejects when awaited, which is how the driver behaves. Wrapped in a query
    // so a route that chains `.select()` onto it still fails the same way.
    User.findById = () => stubQuery(() => { throw mongoNetworkTimeout(); });
    try {
      const res = await call('/verify-login-otp', { userId: USER_ID, mfaTransaction, otp: '123456' });
      assert.equal(res.status, 503, `expected 503, got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.retryAfter, '5');
    } finally {
      User.findById = origFindById;
    }
  });
});

test('a genuine application fault still answers 500 and leaks nothing', async () => {
  // Not infrastructure: this must NOT be dressed up as a transient blip, or the
  // user retries forever against a bug that will never clear.
  await withAuthRouter({ user: () => { throw new Error('some internal invariant broke'); } }, async ({ call , mfaTransaction }) => {
    const res = await call('/login', { email: EMAIL, password: PASSWORD });
    assert.equal(res.status, 500, `expected 500, got ${res.status}`);
    assert.equal(res.retryAfter, null, 'a real fault is not retryable');
    assert.equal(res.body.message, 'Something went wrong. Please try again later.');
  });
});

test('a caller-supplied bad id is still a 500-free 4xx path, not a 503', async () => {
  // Guards the classifier against over-reaching: a CastError is the caller's
  // input, not our database being unavailable.
  await withAuthRouter({ user: healthyUser }, async ({ call , mfaTransaction }) => {
    const origFindById = User.findById;
    const err = new Error('Cast to ObjectId failed for value "not-an-id"');
    err.name = 'CastError';
    User.findById = () => stubQuery(() => { throw err; });
    try {
      const res = await call('/verify-login-otp', { userId: 'not-an-id', otp: '123456' });
      assert.notEqual(res.status, 503, 'a malformed id is the caller\'s problem, not a retryable outage');
    } finally {
      User.findById = origFindById;
    }
  });
});
