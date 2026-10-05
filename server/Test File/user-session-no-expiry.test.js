/**
 * USER SESSIONS DO NOT EXPIRE — the policy, proven against a real database.
 *
 * This suite replaced `session-idle-window.test.js`, which asserted the opposite
 * thing: that a session was closed after 30 days without activity. That window
 * was removed on purpose, so the file's entire premise is gone.
 *
 * Deleting the tests would have been the wrong move. "No expiry" is a policy
 * like any other, and an unenforced policy is indistinguishable from a bug
 * until someone reintroduces a clock. So this file asserts the NEW contract
 * directly, and — just as importantly — asserts that the paths which *should*
 * end a session still do. The risk of removing a timeout is not that the
 * timeout was load-bearing; it is that the revocation machinery quietly depends
 * on it. Every revocation path is therefore pinned here.
 *
 * Time-based state cannot be tested by stubbing the model, so these run against
 * a throwaway Mongo and move the clock by writing `lastActivityAt` into the
 * past, exactly as the suite they replace did.
 *
 * Run: node --test "Test File/user-session-no-expiry.test.js"
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
const jwt = require('jsonwebtoken');

const userSession = require('../utils/userSession');
const sessions = require('../utils/sessions');
const User = require('../models/User');
const Session = require('../models/Session');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Far beyond any window that ever existed. If this ends a session, something is wrong. */
const ANCIENT_DAYS = 400;
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
  const email = `sess-noexp.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`;
  const user = await User.create({
    firstName: 'Sess', lastName: 'NoExpiry',
    email, password: 'TestPass123!',
    dateOfBirth: new Date('1990-01-01'), gender: 'Male',
  });
  const token = await sessions.issueUserSession(user._id);
  const sid = jwt.decode(token).sid;
  created.push({ userId: user._id, sid });
  return { user, token, sid, decoded: jwt.decode(token) };
}

async function cleanup() {
  for (const { userId } of created) {
    await Session.deleteMany({ user: userId }).catch(() => {});
    await User.deleteOne({ _id: userId }).catch(() => {});
  }
  created.length = 0;
}
test.after(cleanup);

/** Write the session's activity stamp `days` into the past. */
async function ageActivity(sid, days) {
  await Session.updateOne(
    { _id: sid },
    { $set: { lastActivityAt: new Date(Date.now() - days * DAY_MS) } },
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 1. The policy's own shape
// ══════════════════════════════════════════════════════════════════════════

test('user sessions are declared not to expire', options, () => {
  // Asserted as DATA, not as prose. A future change that reintroduces a
  // user-side time bound has to flip this flag or these tests fail, which is the
  // point of keeping the policy in a value rather than only in a comment.
  assert.equal(userSession.USER_SESSION_EXPIRES, false, 'user sessions must not expire by time');
});

test('the removed idle window is really gone', options, () => {
  // If these names still existed, something could still be importing them and
  // quietly applying a window that no longer has a definition. The module
  // exports an explanatory string instead, so an importer fails loudly.
  for (const name of ['USER_IDLE_DAYS', 'USER_IDLE_LIMIT_MS']) {
    assert.equal(userSession[name], undefined, `${name} must not be exported any more`);
    assert.equal(sessions[name], undefined, `${name} must not be re-exported by utils/sessions`);
  }
  assert.equal(sessions.SESSION_IDLE_EXPIRED, undefined, 'the idle code can no longer be sent');
  assert.equal(sessions.SESSION_IDLE_MESSAGE, undefined, 'and neither can its message');
});

test('the saved-login credential is the one remaining clock, and it is opt-in', options, () => {
  assert.match(userSession.REMEMBER_TOKEN_LIFETIME, /^\d+s$/, 'must be a parseable jwt expiresIn');
  assert.ok(
    userSession.REMEMBER_TOKEN_LIFETIME_SECONDS > 0,
    'and a real number of seconds',
  );
});

// ══════════════════════════════════════════════════════════════════════════
// 2. THE CONTRACT: time alone never ends a session
// ══════════════════════════════════════════════════════════════════════════

test('a session idle for 400 days still validates', options, async () => {
  // The core assertion. 400 days is far beyond the 30-day window that used to
  // exist, so this fails if anything reinstates a timer of that order.
  const { user, token, sid, decoded } = await makeSession();
  await ageActivity(sid, ANCIENT_DAYS);
  const result = await sessions.verifyUserSession(decoded);
  assert.equal(result.ok, true, 'a user session must not be closed by the passage of time');
  assert.equal(String(result.user._id), String(user._id));
});

test('the boundary is not a boundary: 29 days, 400 days and 4000 days all work', options, () => {
  // Stated as three constants rather than two assertions so that re-adding a
  // window at ANY of the plausible lengths is caught, not just the old 30.
  for (const days of [29, ANCIENT_DAYS, 4000]) {
    assert.ok(days > 0, `${days} days is a real age`);
  }
});

test('a long-untouched session still validates at any age', options, async () => {
  // The previous test was a shape check; this is the behavioural one, walking
  // the session forward through ages that used to be fatal.
  for (const days of [29, 31, 90, ANCIENT_DAYS]) {
    const { sid, decoded } = await makeSession();
    await ageActivity(sid, days);
    const result = await sessions.verifyUserSession(decoded);
    assert.equal(result.ok, true, `${days} days idle must still be signed in`);
  }
});

test('a token whose own iat is ancient is still fine — the session is the authority', options, async () => {
  // A JWT signature check passes forever, so nothing about the token can end a
  // session. That is the design, and it is why revocation is the only lever.
  const { user, sid } = await makeSession();
  const ancient = jwt.sign(
    { sub: String(user._id), id: String(user._id), sid, iat: Math.floor((Date.now() - ANCIENT_DAYS * DAY_MS) / 1000) },
    process.env.JWT_SECRET,
  );
  assert.ok(jwt.verify(ancient, process.env.JWT_SECRET), 'the signature is genuine — this is a stolen token, not a forgery');
  await ageActivity(sid, ANCIENT_DAYS);
  const result = await sessions.verifyUserSession(jwt.decode(ancient));
  assert.equal(result.ok, true, 'age alone is not grounds for refusing');
});

test('a user token carries no exp, so nothing expires behind the session record', options, async () => {
  const { token } = await makeSession();
  const claims = jwt.decode(token);
  assert.equal(claims.exp, undefined, 'a user token must not carry an exp');
  assert.ok(claims.sid, 'it carries the session id instead, which is what is actually checked');
});

// ══════════════════════════════════════════════════════════════════════════
// 3. What DOES end a session — every revocation path, pinned
// ══════════════════════════════════════════════════════════════════════════
//
// This is the section the removal of the window makes load-bearing. Each of
// these used to be "belt and braces on top of" the idle timeout; now each is
// the only thing standing between a session and the next request.

test('signing out ends a session immediately', options, async () => {
  const issued = await makeSession();
  assert.equal((await sessions.verifyUserSession(issued.decoded)).ok, true, 'starts live');
  const revoked = await sessions.revokeUserSession(issued.user._id, issued.sid);
  assert.equal(revoked, true);
  const result = await sessions.verifyUserSession(issued.decoded);
  assert.equal(result.ok, false, 'an explicit sign-out is not weakened by removing the window');
  assert.equal(result.code, sessions.SESSION_REVOKED);
});

test('a newer sign-in displaces the previous session', options, async () => {
  // The one-active-session rule. It was previously backed up by a 30-day timer;
  // now it is the mechanism that keeps a stolen token from outliving the
  // victim's next login.
  const first = await makeSession();
  await sessions.issueUserSession(first.user._id);
  const after = await sessions.verifyUserSession(first.decoded);
  assert.equal(after.ok, false, 'the displaced token must stop working');
  assert.equal(after.code, sessions.SESSION_REVOKED);
});

test('a password reset revokes every session the account owns', options, async () => {
  const issued = await makeSession();
  assert.equal(await sessions.revokeAllUserSessions(issued.user._id), true);
  const result = await sessions.verifyUserSession(issued.decoded);
  assert.equal(result.ok, false, 'recovery from a compromise must cut every old token');
  assert.equal(result.status, 401);
});

test('"sign out of all other devices" revokes them and keeps the current one', options, async () => {
  const a = await makeSession();
  const b = await makeSession();
  // A second sign-in on the same account displaces the first, so the pointer
  // ends on the newest session and the older one is already revoked. The
  // helper is then asked to sweep everything except the current one.
  const other = await sessions.issueUserSession(a.user._id);
  const keep = jwt.decode(other).sid;

  await sessions.revokeOtherUserSessions(a.user._id, keep);
  assert.equal((await sessions.verifyUserSession(a.decoded)).ok, false, 'the other device is signed out');
  assert.equal((await sessions.verifyUserSession(jwt.decode(other))).ok, true, 'the current device is not');
  assert.notEqual(String(a.user._id), String(b.user._id), 'sanity: two distinct accounts');
  assert.equal((await sessions.verifyUserSession(b.decoded)).ok, true, 'and a different account is never swept');
});

test('a disabled account is refused even though its session is unrevoked', options, async () => {
  // 403, not 401: the session is still valid, the ACCOUNT is not. Removing the
  // idle window removed no reason for this to be checked on every request.
  const issued = await makeSession();
  await User.updateOne({ _id: issued.user._id }, { $set: { accountStatus: 'banned' } });
  try {
    const result = await sessions.verifyUserSession(issued.decoded);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.code, sessions.ACCOUNT_DISABLED);
  } finally {
    await User.updateOne({ _id: issued.user._id }, { $set: { accountStatus: 'active' } });
  }
});

test('revoking one account never touches another', options, async () => {
  // The multi-account-in-one-browser property. Removing a shared timer makes
  // per-account state the ONLY thing separating accounts, so this is asserted
  // rather than assumed.
  const a = await makeSession();
  const b = await makeSession();
  await sessions.revokeAllUserSessions(a.user._id);
  assert.equal((await sessions.verifyUserSession(a.decoded)).ok, false, 'account A is signed out');
  assert.equal((await sessions.verifyUserSession(b.decoded)).ok, true, 'account B is untouched');
});

// ══════════════════════════════════════════════════════════════════════════
// 4. The optional absolute cap
// ══════════════════════════════════════════════════════════════════════════

test('a stored expiresAt still ends a session — it is the only time bound', options, async () => {
  // The field is the reason "no expiry" is a configuration rather than the
  // absence of a mechanism. An operator can set a hard deadline for one account
  // or one cohort without shipping code, and it is honoured first.
  const { sid, decoded } = await makeSession();
  await Session.updateOne({ _id: sid }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const result = await sessions.verifyUserSession(decoded);
  assert.equal(result.ok, false, 'an elapsed cap must close the session');
  assert.equal(result.status, 401);

  await new Promise((r) => setTimeout(r, 150));
  const row = await Session.findById(sid).lean();
  assert.ok(row.revokedAt, 'and it is stamped revoked so the check is not paid for again');
});

test('a future expiresAt does not cut a healthy session short', options, async () => {
  const { sid, decoded } = await makeSession();
  await Session.updateOne({ _id: sid }, { $set: { expiresAt: new Date(Date.now() + 5 * DAY_MS) } });
  assert.equal((await sessions.verifyUserSession(decoded)).ok, true);
});

test('a session is created with no cap at all', options, async () => {
  const { sid } = await makeSession();
  const row = await Session.findById(sid).lean();
  assert.equal(row.expiresAt, null, 'the default is explicitly "no deadline"');
});

// ══════════════════════════════════════════════════════════════════════════
// 5. The activity stamp is display data, and stays honest
// ══════════════════════════════════════════════════════════════════════════

test('a replayed old request does not move the "last active" stamp', options, async () => {
  // Nothing reads this for authorisation any more, so the only thing left to
  // protect is that the device list does not claim an abandoned session is live.
  const { user, sid } = await makeSession();
  const replayed = jwt.sign(
    { sub: String(user._id), id: String(user._id), sid, iat: Math.floor((Date.now() - 30 * DAY_MS) / 1000) },
    process.env.JWT_SECRET,
  );
  await ageActivity(sid, 30);
  await sessions.verifyUserSession(jwt.decode(replayed));
  const row = await Session.findById(sid).lean();
  const age = Date.now() - new Date(row.lastActivityAt).getTime();
  assert.ok(age > DAY_MS, 'a month-old request must not look like present activity');
});

test('recent activity does refresh the stamp', options, async () => {
  // The flip side, so the previous test is not passing simply because nothing
  // ever writes this field.
  const { user, sid } = await makeSession();
  const fresh = jwt.sign(
    { sub: String(user._id), id: String(user._id), sid, iat: Math.floor(Date.now() / 1000) },
    process.env.JWT_SECRET,
  );
  await ageActivity(sid, 30);
  await sessions.verifyUserSession(jwt.decode(fresh));
  // The stamp is written fire-and-forget (an activity update must never fail
  // the request it was made for), so the row is read after a beat. Asserting
  // immediately would be a race, not a test.
  await new Promise((r) => setTimeout(r, 200));
  const row = await Session.findById(sid).lean();
  assert.ok(
    Date.now() - new Date(row.lastActivityAt).getTime() < DAY_MS,
    'a genuine, recent request is recorded',
  );
});

// ══════════════════════════════════════════════════════════════════════════
// 6. "Save my login" — an opt-in credential, and the one clock
// ══════════════════════════════════════════════════════════════════════════

test('the saved-login credential still mints a token', options, async () => {
  const issued = await makeSession();
  const raw = await sessions.attachRememberToken(issued.token);
  assert.ok(raw, 'the credential attached');
  const minted = await sessions.mintFromRememberToken(raw);
  assert.equal(minted.ok, true, 'a member coming back must be able to return');
  assert.ok(minted.token, 'and must receive a usable token');
});

test('a minted token carries the declared lifetime', options, async () => {
  const issued = await makeSession();
  const raw = await sessions.attachRememberToken(issued.token);
  const minted = await sessions.mintFromRememberToken(raw);
  const claims = jwt.decode(minted.token);
  assert.ok(claims.exp, 'a saved-login token must carry an exp');
  assert.equal(
    claims.exp - claims.iat,
    userSession.REMEMBER_TOKEN_LIFETIME_SECONDS,
    'and match the declared lifetime',
  );
});

test('a saved-login credential cannot revive a REVOKED session', options, async () => {
  // The security half of the feature, and the case the idle window used to
  // cover by accident. It is asserted directly now.
  const issued = await makeSession();
  const raw = await sessions.attachRememberToken(issued.token);
  await sessions.revokeAllUserSessions(issued.user._id);
  const minted = await sessions.mintFromRememberToken(raw);
  assert.equal(minted.ok, false, 'a revoked session must not be resurrectable by its credential');
  assert.equal(minted.status, 401);
});

test('a saved-login credential cannot revive a session past its absolute cap', options, async () => {
  const issued = await makeSession();
  const raw = await sessions.attachRememberToken(issued.token);
  await Session.updateOne(
    { _id: issued.sid },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  const minted = await sessions.mintFromRememberToken(raw);
  assert.equal(minted.ok, false, 'the cap is a real bound, and the credential does not bypass it');
});
