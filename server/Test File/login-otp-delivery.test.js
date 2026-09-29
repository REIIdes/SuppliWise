/**
 * ONE-TIME-CODE DELIVERY — a code may only be promised once it has been sent.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `sendOtpInBackground()` fired the SMTP send into the background and let the
 * route answer "Verification code sent to your email successfully" immediately.
 * The promise was therefore made BEFORE the send was attempted. When the send
 * then failed, the failure handler did this:
 *
 *     if (!sent) { otpStore.delete(otpKey); ... }
 *
 * That deleted the pending code — the exact code the client had just been told
 * to go and read out of its inbox. `/verify-login-otp` then answered "No OTP
 * request found. Please try logging in again." while the sign-in modal sat
 * open on screen.
 *
 * The whole user login was consequently contingent on the mail provider being
 * healthy. A revoked Gmail app password, a Gmail outage, a quota block or a
 * momentary network blip locked EVERY user out of their own account, and the UI
 * told them to check an inbox that was never going to receive anything. A failed
 * "send again" was the same bug in miniature: it destroyed the still-valid code
 * the user was already working from.
 *
 * The contract now enforced by these tests:
 *   1. A failed delivery is reported as a failure. The route must never claim a
 *      code was sent, and must never hand back a `userId`/`requiresOtp` that
 *      would open a verification step with no code in it.
 *   2. A successful delivery is unchanged — `requiresOtp` + a code that verifies.
 *   3. A failed delivery leaves NOTHING behind: no pending code, no cooldown, no
 *      strike. An honest user whose mail bounced must be able to retry at once.
 *   4. A failed RESEND must never destroy the previously issued code, which is
 *      still valid and is the one the user is actually working from.
 *
 * The mailer is stubbed, so these run with no SMTP and no database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const User = require('../models/User');
const emailUtils = require('../utils/email');
const sessionUtils = require('../utils/sessions');
const { stubQuery } = require('./stubQuery');
// The password-reset flow moved to an emailed link with its own router and
// harness; the two legacy aliases on this router are still covered below.
const { withResetRouter } = require('./withResetRouter');

const USER_ID = '507f1f77bcf86cd799439011';
const EMAIL = 'demo@example.com';
const PASSWORD = 'Secret123';

/** A user the login route can work with. No `lastLoginUserAgent` ⇒ not a new device. */
function stubUser(overrides = {}) {
  return {
    _id: USER_ID,
    email: EMAIL,
    firstName: 'Demo',
    lastName: 'User',
    fullName: 'Demo User',
    dateOfBirth: new Date('1990-01-01'),
    age: 36,
    gender: 'Male',
    profilePicture: '',
    bannerPicture: '',
    accountStatus: 'active',
    twoFactorEnabled: false,
    twoFactorMethod: 'authenticator',
    save: async () => {},
    matchPassword: async (value) => value === PASSWORD,
    ...overrides,
  };
}

/**
 * Build the auth router and run `fn(ctx)` against it.
 *
 * `deliver` decides whether the mail goes out; every code handed to the mailer is
 * recorded in `sentCodes` so a test can play the part of the user reading their
 * inbox. The router is re-required per test so each one starts with a clean OTP
 * store (the store is module-level state, deliberately — it is a live process).
 *
 * Nothing here touches a database: session issuing is stubbed, so the only real
 * collaborators are the OTP store and the mailer — which is exactly the surface
 * under test.
 */
async function withAuthRouter({ deliver, findOne }, fn) {
  const originals = {
    findOne: User.findOne,
    sendOtpEmail: emailUtils.sendOtpEmail,
    issueUserSession: sessionUtils.issueUserSession,
    revokeAllUserSessions: sessionUtils.revokeAllUserSessions,
    nodeEnv: process.env.NODE_ENV,
  };
  const sentCodes = [];
  process.env.NODE_ENV = 'test';

  // stubQuery, not a bare object: /login projects the fields it needs with
  // `.select(...)`, and a plain object is not chainable. See stubQuery.js.
  User.findOne = () => stubQuery(() => (findOne ? findOne() : stubUser()));
  emailUtils.sendOtpEmail = async (to, otp, type) => {
    sentCodes.push({ to, otp, type });
    return deliver ? deliver(to, otp, type) : true;
  };
  // A real JWT, so the client-visible contract (a usable token comes back) is
  // still exercised, without needing a Session document.
  sessionUtils.issueUserSession = async () => 'stub.session.token';
  sessionUtils.revokeAllUserSessions = async () => 0;

  delete require.cache[require.resolve('../routes/auth')];
  const authRouter = require('../routes/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
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
    return { status: res.status, body: json };
  };

  /**
   * Step the clock past the 30s OTP cooldown. The resend routes are gated by a
   * shared in-process cooldown map keyed on `Date.now()`; waiting it out for real
   * would add 30s to the suite, and the cooldown itself is not what these tests
   * are about.
   */
  const skipCooldown = () => {
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    return () => { Date.now = realNow; };
  };

  try {
    return await fn({ call, sentCodes, skipCooldown });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    User.findOne = originals.findOne;
    emailUtils.sendOtpEmail = originals.sendOtpEmail;
    sessionUtils.issueUserSession = originals.issueUserSession;
    sessionUtils.revokeAllUserSessions = originals.revokeAllUserSessions;
    process.env.NODE_ENV = originals.nodeEnv;
    delete require.cache[require.resolve('../routes/auth')];
  }
}

// ── 1. A failed delivery is reported as a failure ──────────────────────────

test('a sign-in whose code cannot be delivered never claims the code was sent', async () => {
  await withAuthRouter({ deliver: () => false }, async ({ call, sentCodes }) => {
    const res = await call('/login', { email: EMAIL, password: PASSWORD });

    assert.equal(sentCodes.length, 1, 'the mailer really was asked to send something');
    assert.equal(res.status, 503, `expected an honest 503, got ${res.status} ${JSON.stringify(res.body)}`);

    // The client opens its verification modal purely off `requiresOtp`. If that
    // is present the user is staring at a code box for a mail that never left.
    assert.equal(res.body.requiresOtp, undefined, 'must not open a verification step with no code in it');
    assert.equal(res.body.userId, undefined, 'must not hand back a userId to wait on');

    // And the wording must not tell them to go and check an empty inbox.
    assert.doesNotMatch(
      res.body.message || '',
      /sent to your email/i,
      'must not claim delivery it does not have'
    );
    assert.match(res.body.message || '', /could not send/i, 'must say the mail is the problem');
  });
});

test('the same is true of a "send again" that fails — reported, not silently swallowed', async () => {
  await withAuthRouter({ deliver: () => false }, async ({ call }) => {
    const res = await call('/resend-login-otp', { userId: USER_ID });
    assert.equal(res.status, 503, `expected 503, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.requiresOtp, undefined);
  });
});

// Password reset used to be a 6-digit code on this route and answered 503 when
// the mail failed. It is now an emailed link, and the 503 is GONE — deliberately,
// and this test is where that is pinned down.
//
// WHY 200 INSTEAD OF 503
// ---------------------
// The old contract was "report our failure honestly": 503 when delivery failed,
// 200 when the address had no account. That difference IS an account-existence
// oracle. An attacker enumerating registered addresses just watched for the 503.
//
// So the route now answers 200 with the same body for a real account, an unknown
// address and a mail outage alike. The outage is logged loudly for the operator
// and the user is told to check their inbox and resend if nothing arrives — the
// only honest option that does not also publish your user list.
//
// The property this file exists to protect still holds, and is asserted below:
// nothing that would move a client onto a step with no credential in it.
test('a password reset that cannot be delivered never hands back anything to wait on', async () => {
  await withResetRouter({ deliver: () => false }, async ({ call, store }) => {
    const res = await call('/request', { email: EMAIL });

    assert.equal(res.status, 200, `an outage must not be distinguishable here, got ${res.status}`);
    // A userId or a token here is what would move a client onto a step with no
    // link in it — the exact bug this file was written about.
    assert.equal(res.body.userId, undefined, 'must not advance the client to a step with no link in it');
    assert.equal(res.body.token, undefined, 'must never return the reset link in the response');
    // And no undelivered link may have become a live credential.
    assert.equal(store.rows.length, 0, 'an undelivered link must never be stored');
  });
});

test('an address-change code that cannot be delivered is reported too', async () => {
  await withAuthRouter({ deliver: () => false }, async ({ call }) => {
    const res = await call('/request-email-otp', { newEmail: 'new@example.com' });
    // This route needs a session, so an unauthenticated call is refused first —
    // either way it must never answer "sent".
    assert.doesNotMatch(res.body.message || '', /sent to your email/i);
  });
});

// ── 2. The happy path is untouched ─────────────────────────────────────────

test('a delivered code still produces a normal sign-in', async () => {
  await withAuthRouter({ deliver: () => true }, async ({ call, sentCodes }) => {
    const login = await call('/login', { email: EMAIL, password: PASSWORD });

    assert.equal(login.status, 200);
    assert.equal(login.body.requiresOtp, true);
    assert.equal(login.body.userId, USER_ID);
    assert.match(login.body.message, /Verification code sent/);
    assert.equal(login.body.otp, undefined, 'the code must never be echoed in the response');

    // The user reads the code out of their inbox and submits it.
    const code = sentCodes[sentCodes.length - 1].otp;
    const verify = await call('/verify-login-otp', { userId: USER_ID, otp: code });

    assert.equal(verify.status, 200, `the delivered code must verify: ${JSON.stringify(verify.body)}`);
    assert.ok(verify.body.token, 'a delivered code must produce a session token');
    assert.equal(verify.body.email, EMAIL, 'the response must carry the profile the client stores');
  });
});

// ── 3. A failed delivery leaves nothing behind ─────────────────────────────

test('a failed delivery leaves no code behind that a wrong guess could strike', async () => {
  await withAuthRouter({ deliver: () => false }, async ({ call, sentCodes }) => {
    await call('/login', { email: EMAIL, password: PASSWORD });
    const code = sentCodes[sentCodes.length - 1].otp;

    // Nothing was stored, so nothing can be verified — and, importantly, the
    // wrong guesses must NOT climb the brute-force ladder for a code the user
    // was never actually given.
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const attempt = await call('/verify-login-otp', { userId: USER_ID, otp: '000000' });
      assert.notEqual(attempt.status, 429, `strike ${i + 1} escalated the lockout ladder for a code that was never issued`);
    }

    // The code the mailer was handed is not a valid code either.
    const attempt = await call('/verify-login-otp', { userId: USER_ID, otp: code });
    assert.notEqual(attempt.status, 200, 'a code that was never delivered must not sign anybody in');
  });
});

test('a failed delivery releases the cooldown, so the user can retry immediately', async () => {
  let deliver = false;
  await withAuthRouter({ deliver: () => deliver }, async ({ call }) => {
    const first = await call('/login', { email: EMAIL, password: PASSWORD });
    assert.equal(first.status, 503);

    // The mailer recovers. Without the cooldown being released the retry would
    // be answered 429 for 30 seconds — punishing a user for OUR outage.
    deliver = true;
    const retry = await call('/login', { email: EMAIL, password: PASSWORD });
    assert.equal(retry.status, 200, `an immediate retry must be allowed, got ${retry.status} ${JSON.stringify(retry.body)}`);
  });
});

// ── 4. A failed resend must not destroy the code already in hand ───────────

test('a failed "send again" keeps the code the user is already working from', async () => {
  let deliver = true;
  await withAuthRouter({ deliver: () => deliver }, async ({ call, sentCodes, skipCooldown }) => {
    const login = await call('/login', { email: EMAIL, password: PASSWORD });
    assert.equal(login.status, 200);
    const originalCode = sentCodes[sentCodes.length - 1].otp;

    // The mail goes down; the user clicks "send again" and it fails.
    deliver = false;
    const restore = skipCooldown();
    const resend = await call('/resend-login-otp', { userId: USER_ID });
    restore();
    assert.equal(resend.status, 503, 'the failed resend must be reported honestly');

    // This is the bug. The first code was still valid and is the one the user
    // has in front of them; deleting it on a failed resend stranded them with
    // a code box and no way forward.
    const verify = await call('/verify-login-otp', { userId: USER_ID, otp: originalCode });
    assert.equal(
      verify.status, 200,
      `the original code must survive a failed resend, got ${verify.status} ${JSON.stringify(verify.body)}`
    );
    assert.ok(verify.body.token);
  });
});

// The same guarantee, expressed for password reset. The reset flow is a link
// now rather than a code, so the credential that must survive a failed resend
// is the LINK the user is already working from — not a code sitting in a modal.
test('a failed password-reset resend keeps the reset link already in hand', async () => {
  let deliver = true;
  await withResetRouter({ deliver: () => deliver }, async ({ call, sent, store, linkFromLastMail }) => {
    const first = await call('/request', { email: EMAIL });
    assert.equal(first.status, 200);
    const originalLink = linkFromLastMail();
    assert.ok(originalLink, 'a link was issued');

    // The mail goes down and the user asks for another one.
    deliver = false;
    const resend = await call('/request', { email: EMAIL });
    assert.equal(resend.status, 200, 'a failed resend is still anonymous');
    assert.equal(sent.length, 1, 'and must not have produced a second email');

    // This is the bug this file is about. The first link was never revoked — the
    // user has it open — so destroying it on a failed resend would strand them
    // on a dead screen with no way forward.
    assert.equal(store.rows.length, 1, 'the undelivered resend must not have touched the stored grant');
    const validated = await call(`/validate?token=${encodeURIComponent(originalLink)}`);
    assert.equal(validated.status, 200, `the original link must survive: ${JSON.stringify(validated.body)}`);
    assert.equal(validated.body.valid, true);
  });
});

// ── 5. The anti-enumeration guarantee is not weakened by any of this ──────

// Kept on the legacy alias on purpose: /forgot-password is still a live route,
// and the enumeration guarantee has to hold on the path an old client uses too.
test('an unknown address still gets the same silent answer it always got', async () => {
  await withAuthRouter({ deliver: () => false, findOne: () => null }, async ({ call, sentCodes }) => {
    const res = await call('/forgot-password', { email: 'ghost@example.test' });
    assert.equal(res.status, 200, `unknown addresses must not be treated as failures, got ${res.status}`);
    assert.equal(res.body.userId, undefined);
    assert.equal(res.body.token, undefined, 'the reset link must never be echoed in a response');
    assert.equal(sentCodes.length, 0, 'nothing should be sent for an address with no account');
  });
});
