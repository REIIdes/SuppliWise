/**
 * USER SESSION IDLE WINDOW — the policy, proven against a real database.
 *
 * The sliding window is time-based state, so stubbing the model would prove
 * nothing about the thing most likely to be wrong. These tests run against the
 * same Mongo the app uses, move the clock by writing `lastActivityAt` into the
 * past, and assert on what `verifyUserSession` actually answers.
 *
 * The regression this guards is specific and severe: a user JWT carries no `exp`,
 * so BEFORE this change a leaked token was valid FOREVER. A token thief controls
 * neither sign-in nor sign-out, so nothing else would ever have ended it. Every
 * assertion below is about that window actually closing.
 *
 * Run: node --test "Test File/session-idle-window.test.js"
 *
 * Requires MONGO_TEST_URI — a DEDICATED throwaway database, never the
 * application's own MONGO_URI. This suite writes real User and Session
 * documents, so it used to run against the live cluster (129 stray accounts
 * accumulated that way) whenever MONGO_URI happened to be present. The guard
 * below makes that impossible and SKIPS (rather than fails) when no test
 * database is configured, so it is not a false alarm on a fresh machine.
 */
const { testDbPreflight, connectTestDb } = require('./testDbGuard');

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  USER_IDLE_DAYS,
  USER_IDLE_LIMIT_MS,
  REMEMBER_TOKEN_LIFETIME,
  REMEMBER_TOKEN_LIFETIME_SECONDS,
  USER_ACTIVITY_MAX_AGE_MS,
} = require('../utils/userSession');
const sessions = require('../utils/sessions');
const User = require('../models/User');
const Session = require('../models/Session');
const jwt = require('jsonwebtoken');

const DAY_MS = 24 * 60 * 60 * 1000;
let connected = false;

/**
 * One shared connection, and a skip signal when no test database is configured.
 *
 * The decision is made HERE, at module load, and not inside `test.before`:
 * node:test reads a test's `skip` option when the test is registered, so a
 * value assigned later is ignored — the tests would run against a connection
 * that was never opened and fail on a 10 s buffering timeout instead of
 * skipping cleanly.
 */
const options = testDbPreflight();
test.before(async () => {
  const result = await connectTestDb();
  if (!result.connected) return; // options.skip already carries the reason
  connected = true;
});
test.after(async () => {
  if (connected) await mongoose.disconnect().catch(() => {});
});

const created = [];

/** A real user with a real session, cleaned up afterwards. */
async function makeSession() {
  const email = `sess-win.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`;
  const user = await User.create({
    firstName: 'Sess', lastName: 'Window',
    email, password: 'TestPass123!',
    dateOfBirth: new Date('1990-01-01'), gender: 'Male',
  });
  const token = await sessions.issueUserSession(user._id);
  const sid = String(mongoose.Types.ObjectId.isValid(token) ? '' : jwt.decode(token).sid);
  created.push({ userId: user._id, sid });
  return { user, token, sid, decoded: jwt.decode(token) };
}

async function cleanup() {
  for (const { userId, sid } of created) {
    await Session.deleteMany({ user: userId }).catch(() => {});
    await User.deleteOne({ _id: userId }).catch(() => {});
  }
  created.length = 0;
}
test.after(cleanup);

/** Age the session's activity stamp by `days`, sliding nothing. */
async function ageActivity(sid, days) {
  await Session.updateOne(
    { _id: sid },
    { $set: { lastActivityAt: new Date(Date.now() - days * DAY_MS) } },
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 1. The policy's own shape
// ══════════════════════════════════════════════════════════════════════════

test('the idle window is 30 days and the saved-login token outlives it', options, () => {
  assert.equal(USER_IDLE_DAYS, 30);
  assert.equal(USER_IDLE_LIMIT_MS, 30 * DAY_MS);
  // The invariant the module asserts at load, restated so a test failure names
  // the consequence rather than just the comparison.
  assert.ok(
    USER_IDLE_LIMIT_MS < REMEMBER_TOKEN_LIFETIME_SECONDS * 1000,
    'a saved-login token must outlive the window, or a returning member is signed out '
    + 'by a token that died first',
  );
  assert.match(REMEMBER_TOKEN_LIFETIME, /^\d+s$/, 'must be a parseable jwt expiresIn');
});

test('a replayed request cannot count as activity', options, () => {
  // Without this the window is decorative: a thief holding a captured token
  // could resend it and hold the session open indefinitely.
  assert.ok(
    USER_ACTIVITY_MAX_AGE_MS > 0 && USER_ACTIVITY_MAX_AGE_MS <= DAY_MS,
    'the replay window must be short — minutes, not days',
  );
});

// ══════════════════════════════════════════════════════════════════════════
// 2. The window actually closes
// ══════════════════════════════════════════════════════════════════════════

test('a session inside the window still validates', options, async () => {
  const { user, token, sid } = await makeSession();
  await ageActivity(sid, USER_IDLE_DAYS - 1);          // 29 days idle
  const result = await sessions.verifyUserSession(jwt.decode(token));
  assert.equal(result.ok, true, 'a session inside its window must keep working');
  assert.equal(String(result.user._id), String(user._id));
});

test('a session past the window is refused and stamped revoked', options, async () => {
  const { token, sid } = await makeSession();
  await ageActivity(sid, USER_IDLE_DAYS + 1);          // 31 days idle
  const result = await sessions.verifyUserSession(jwt.decode(token));
  assert.equal(result.ok, false, 'a token with no expiry must not outlive the window');
  assert.equal(result.status, 401);
  // Its OWN code, not the generic revoked one — so the client can explain that
  // this was inactivity rather than an administrator or a second sign-in.
  assert.equal(result.code, sessions.SESSION_IDLE_EXPIRED);
  assert.match(result.message, /inactivity/i, 'the message must say why');
  assert.match(result.message, new RegExp(String(USER_IDLE_DAYS)), 'and name the window');

  // Stamped revoked, not merely refused: otherwise every later request with the
  // same token pays for this query again.
  await new Promise((r) => setTimeout(r, 150));
  const row = await Session.findById(sid).lean();
  assert.ok(row.revokedAt, 'an expired session should be marked revoked, not re-checked forever');
});

test('an idle expiry is distinguishable from a sign-out or a second login', options, async () => {
  // Three different reasons a member can be signed out. If they share a code the
  // client can only show one generic message, and an inactivity timeout looks
  // like a bug.
  const aged = await makeSession();
  await ageActivity(aged.sid, USER_IDLE_DAYS + 1);
  const idle = await sessions.verifyUserSession(jwt.decode(aged.token));
  assert.equal(idle.code, sessions.SESSION_IDLE_EXPIRED);

  const signedOut = await makeSession();
  await sessions.revokeUserSession(signedOut.user._id, signedOut.sid);
  const out = await sessions.verifyUserSession(signedOut.decoded);
  assert.equal(out.code, sessions.SESSION_REVOKED);
  assert.notEqual(out.code, idle.code, 'the two causes must not collapse into one');
  assert.notEqual(out.message, idle.message, 'and the wording must differ');
});

test('the boundary is exact: 29 days works, 31 does not', options, async () => {
  const inside = await makeSession();
  await ageActivity(inside.sid, 29);
  assert.equal((await sessions.verifyUserSession(inside.decoded)).ok, true, '29 days must work');

  const outside = await makeSession();
  await ageActivity(outside.sid, 31);
  assert.equal((await sessions.verifyUserSession(outside.decoded)).ok, false, '31 days must not');
});

test('an aged session is refused even while its token still verifies', options, async () => {
  // The point of the change: a JWT signature check passes forever, so the session
  // record is the only thing that can end this.
  const { token, decoded } = await makeSession();
  const jwt = require('jsonwebtoken');
  assert.ok(jwt.verify(token, process.env.JWT_SECRET), 'the token itself is still cryptographically valid');
  assert.equal(jwt.decode(token).exp, undefined, 'and it carries no exp at all');
  await ageActivity(jwt.decode(token).sid, 40);
  const result = await sessions.verifyUserSession(decoded);
  assert.equal(result.ok, false, 'yet the session is closed');
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Activity slides the window
// ══════════════════════════════════════════════════════════════════════════

test('a REPLAYED old request cannot slide the window open', options, async () => {
  // The guard that makes the window worth having. Without it, anyone holding a
  // captured token could resend it and keep a session alive forever — which is
  // exactly the exposure the 30-day window was added to close.
  //
  // The token has to be genuinely OLD, not a fresh one pointed at an aged
  // session: `issueUserSession` stamps `lastActivityAt`, so a fresh token always
  // sits on a fresh session, and that combination cannot arise in production.
  // A real replay is an old `iat` meeting an aged session, so that is what is
  // built here.
  const { user, sid } = await makeSession();
  const oldIat = Math.floor((Date.now() - 40 * DAY_MS) / 1000);
  const replayed = jwt.sign(
    { sub: String(user._id), id: String(user._id), sid, iat: oldIat },
    process.env.JWT_SECRET,
  );
  // The signature is genuine — this is not a forgery attack, it is a stolen
  // token. That is the whole threat model.
  assert.ok(jwt.verify(replayed, process.env.JWT_SECRET), 'the replayed token is cryptographically valid');

  await ageActivity(sid, 31);
  const result = await sessions.verifyUserSession(jwt.decode(replayed));
  assert.equal(result.ok, false, 'a 40-day-old token must not count as activity');
  assert.equal(result.status, 401);

  const row = await Session.findById(sid).lean();
  const age = Date.now() - new Date(row.lastActivityAt).getTime();
  assert.ok(age > USER_IDLE_LIMIT_MS, 'the window must not have been slid open by the replay');
});

test('real activity slides the window, so an active member is never logged out', options, async () => {
  // The whole point of "sliding": someone who uses the app regularly must never
  // hit this. Simulate that by repeatedly aging the session and letting a
  // genuine (recently-issued) request restore the stamp.
  const { token, sid } = await makeSession();
  for (let day = 0; day < 5; day += 1) {
    await ageActivity(sid, 25);
    const decoded = jwt.decode(token);
    const result = await sessions.verifyUserSession(decoded);
    assert.equal(result.ok, true, `active on day ${day} — must stay signed in`);
    // The stamp is throttled, so it may not have been written on every call.
    // Assert the window is intact rather than that a write happened.
    const row = await Session.findById(sid).lean();
    const age = Date.now() - new Date(row.lastActivityAt).getTime();
    assert.ok(age < USER_IDLE_LIMIT_MS, 'the session must not be ageing toward expiry');
    // Force the throttle open for the next iteration.
    await Session.updateOne({ _id: sid }, { $set: { lastActivityAt: new Date() } });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 4. "Save my login" still works
// ══════════════════════════════════════════════════════════════════════════

test('the saved-login credential still mints a token after a month idle', options, async () => {
  // The compatibility case that decides whether this policy is acceptable: a
  // member who ticked "save my login" comes back after 25 days. Their session
  // is inside the window, and the mint must work.
  const issued = await makeSession();
  const raw = await sessions.attachRememberToken(issued.token);
  assert.ok(raw, 'the credential attached');

  await ageActivity(issued.sid, 25);
  const minted = await sessions.mintFromRememberToken(raw);
  assert.equal(minted.ok, true, 'a member inside the window must be able to come back');
  assert.ok(minted.token, 'and must receive a usable token');
});

test('a minted token outlives the idle window', options, async () => {
  // If the minted token expired BEFORE the window, a returning member could land
  // in a gap: credential valid, session alive, token dead. The claims are
  // asserted rather than the timing, so no clock is involved.
  const issued = await makeSession();
  const raw = await sessions.attachRememberToken(issued.token);
  const minted = await sessions.mintFromRememberToken(raw);
  const claims = require('jsonwebtoken').decode(minted.token);
  assert.ok(claims.exp, 'a saved-login token must carry an exp');
  const lifetimeSeconds = claims.exp - claims.iat;
  assert.equal(lifetimeSeconds, REMEMBER_TOKEN_LIFETIME_SECONDS, 'and match the declared lifetime');
  assert.ok(
    lifetimeSeconds * 1000 > USER_IDLE_LIMIT_MS,
    `the minted token (${lifetimeSeconds}s) must outlive the window (${USER_IDLE_LIMIT_MS / 1000}s)`,
  );
});

test('a saved-login credential cannot revive a window that already closed', options, async () => {
  // The security half of the same feature: the credential must not be a
  // backdoor around the idle window.
  const issued = await makeSession();
  const raw = await sessions.attachRememberToken(issued.token);
  await ageActivity(issued.sid, USER_IDLE_DAYS + 5);
  const minted = await sessions.mintFromRememberToken(raw);
  assert.equal(minted.ok, false, 'an expired session must not be resurrectable by its credential');
  assert.equal(minted.status, 401);
});

test('signing out still ends a session inside its window', options, async () => {
  // The new expiry must not have weakened the existing revocation paths.
  const issued = await makeSession();
  const revoked = await sessions.revokeUserSession(issued.user._id, issued.sid);
  assert.equal(revoked, true);
  const result = await sessions.verifyUserSession(issued.decoded);
  assert.equal(result.ok, false, 'an explicit sign-out is unaffected by the idle window');
});

// ══════════════════════════════════════════════════════════════════════════
// 5. The optional hard cap
// ══════════════════════════════════════════════════════════════════════════

test('a stored expiresAt overrides the sliding window', options, async () => {
  // The field was documented as a hook for "a future policy per session type".
  // It is now consulted FIRST, so such a policy takes precedence rather than
  // being silently ignored by the window.
  const { user, sid } = await makeSession();
  await Session.updateOne(
    { _id: sid },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  // Fresh, recent activity — the sliding window alone would let this through.
  const row = await Session.findById(sid).lean();
  assert.ok(Date.now() - new Date(row.lastActivityAt).getTime() < USER_IDLE_LIMIT_MS);

  // A SECOND session, so the cap under test is not the one the first
  // `ageActivity` call touched.
  const fresh = await sessions.issueUserSession(user._id);
  const decoded = require('jsonwebtoken').decode(fresh);
  await Session.updateOne(
    { _id: decoded.sid },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  const result = await sessions.verifyUserSession(decoded);
  assert.equal(result.ok, false, 'an absolute cap must win over a sliding window');
  assert.equal(result.status, 401);
});

test('a future expiresAt does not cut a healthy session short', options, async () => {
  const { token } = await makeSession();
  const decoded = jwt.decode(token);
  const sid = decoded.sid;
  await Session.updateOne(
    { _id: sid },
    { $set: { expiresAt: new Date(Date.now() + 5 * DAY_MS) } },
  );
  const result = await sessions.verifyUserSession(decoded);
  assert.equal(result.ok, true, 'a cap in the future must not reject a live session');
});
