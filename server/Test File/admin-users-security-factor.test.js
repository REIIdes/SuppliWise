const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const mongoose = require('mongoose');

const User = require('../models/User');
const Passkey = require('../models/Passkey');
const AdminAccount = require('../models/AdminAccount');

const { startTestServer, connectTestDb } = require('./e2eServer');
const { testDbPreflight } = require('./testDbGuard');
const { skipMessage } = require('./testDbGuard');

const preflight = testDbPreflight();
const PORT = 5129;

/**
 * GET /api/admin/users — the "2FA / Security" column, end to end against a real
 * database.
 *
 * Why this needs a database rather than a stub: the column's whole job is to
 * report what is ACTUALLY stored, and a stubbed User.find cannot catch the two
 * ways it used to lie. It reported twoFactorEnabled but not twoFactorMethod, so
 * an account on email codes read as "Google Authenticator active"; and it never
 * looked at the passkeys collection at all, so an account holding the strongest
 * factor available — and no authenticator app — read as the weakest thing it
 * had. Both are now covered by rows below.
 *
 * The projection is also asserted explicitly: adding a field to `describeFactor`
 * is useless if the query never reads it.
 */

const PASSWORD = 'Verify123!';

test('admin users endpoint reports the real security factor', { skip: preflight.skip }, async (t) => {
  const server = await startTestServer({ port: PORT });
  if (!server.ok) return t.skip(skipMessage(server));
  const db = await connectTestDb();
  if (!db.connected) {
    await server.stop();
    return t.skip(skipMessage(db));
  }

  // Tracked separately: the admin is an AdminAccount and never appears in a
  // users list, so mixing the two would break the row-count assertion below.
  const createdUsers = [];
  const createdAdmins = [];
  t.after(async () => {
    for (const id of [...createdUsers].reverse()) {
      await Passkey.deleteMany({ user: id }).catch(() => {});
      await User.deleteOne({ _id: id }).catch(() => {});
    }
    for (const id of createdAdmins) await AdminAccount.deleteOne({ _id: id }).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    await server.stop();
  });

  // A real AdminAccount row, because `protect` resolves the token against the
  // collection and answers 401 "Admin account is unavailable." for a token
  // whose subject does not exist. Nothing here ever verifies the password.
  const admin = await AdminAccount.create({
    alias: `admin-secfactor-${Date.now()}`,
    passwordHash: 'not-a-real-hash-this-suite-never-verifies-it',
    totpSecret: 'NOTAREALBASE32SECRET000000000000000',
  });
  createdAdmins.push(admin._id);

  const adminToken = jwt.sign(
    { id: String(admin._id), adminId: String(admin._id), alias: admin.alias, role: 'admin' },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' },
  );

  const seed = async (fields) => {
    const user = await User.create({
      firstName: 'Sec', lastName: 'Factor', name: 'Sec Factor',
      email: `sec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`,
      password: PASSWORD, dateOfBirth: '1990-01-01', gender: 'Male',
      ...fields,
    });
    createdUsers.push(user._id);
    return user;
  };

  const addPasskey = async (user) => Passkey.create({
    user: user._id,
    credentialId: `cred_${user._id}_${Math.random().toString(36).slice(2, 10)}`,
    publicKey: 'p',
    name: 'Test Key',
  });

  /** Fetch the users list, keeping only the rows this suite created. */
  const listCreated = async () => {
    const res = await fetch(`${server.base}/api/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    // Read the body once. Passing `await res.text()` as the assert message
    // consumes it even on success, and the later res.json() then throws
    // "Body has already been read" — which masks whatever was really wrong.
    const raw = await res.text();
    assert.equal(res.status, 200, raw);
    const { users } = JSON.parse(raw);
    const wanted = new Set(createdUsers.map(String));
    return users.filter((u) => wanted.has(String(u._id)));
  };

  await t.test('a passkey-only account reads as passkeys, not as email codes', async () => {
    // The reported bug. This account holds the strongest factor available and
    // no second-factor boolean at all.
    const user = await seed({ twoFactorEnabled: false, twoFactorMethod: 'authenticator' });
    await addPasskey(user);
    await addPasskey(user);

    const [row] = (await listCreated()).filter((u) => String(u._id) === String(user._id));
    assert.ok(row, 'the seeded user was not returned');
    assert.equal(row.twoFactorEnabled, false, 'precondition: no second factor');
    assert.equal(row.passkeyCount, 2);
    assert.equal(row.security.method, 'passkey');
    assert.equal(row.security.label, '2 passkeys active');
  });

  await t.test('a passkey outranks a live authenticator app', async () => {
    const user = await seed({ twoFactorEnabled: true, twoFactorMethod: 'authenticator' });
    await addPasskey(user);

    const [row] = (await listCreated()).filter((u) => String(u._id) === String(user._id));
    assert.equal(row.twoFactorEnabled, true);
    assert.equal(row.security.method, 'passkey');
    assert.equal(row.security.label, '1 passkey active');
  });

  await t.test('an account on email codes is never called Google Authenticator', async () => {
    // The other reported bug: the boolean is true, so the old ternary took the
    // "Google Authenticator active" branch.
    const user = await seed({ twoFactorEnabled: true, twoFactorMethod: 'email' });

    const [row] = (await listCreated()).filter((u) => String(u._id) === String(user._id));
    assert.equal(row.twoFactorEnabled, true, 'precondition: 2FA is on');
    assert.equal(row.twoFactorMethod, 'email', 'the method must reach the client');
    assert.equal(row.security.method, 'email');
    assert.equal(row.security.label, 'Email OTP active');
    assert.doesNotMatch(row.security.label, /Authenticator/i);
  });

  await t.test('an account with an authenticator app reads as one', async () => {
    const user = await seed({ twoFactorEnabled: true, twoFactorMethod: 'authenticator' });

    const [row] = (await listCreated()).filter((u) => String(u._id) === String(user._id));
    assert.equal(row.passkeyCount, 0);
    assert.equal(row.security.method, 'authenticator');
    assert.equal(row.security.label, 'Google Authenticator active');
  });

  await t.test('an account with no second factor says so', async () => {
    // The old ternary's fallback branch claimed "Email OTP active" here, which
    // is an assertion about a factor that does not exist.
    const user = await seed({ twoFactorEnabled: false, twoFactorMethod: 'email' });

    const [row] = (await listCreated()).filter((u) => String(u._id) === String(user._id));
    assert.equal(row.passkeyCount, 0);
    assert.equal(row.security.method, 'password');
    assert.equal(row.security.label, 'Password only');
  });

  await t.test('every seeded account is described, and counts never leak across rows', async () => {
    // The grouped aggregate keys on user id. A row picking up a neighbour's
    // count would silently claim protection the account does not have.
    const rows = await listCreated();
    assert.equal(rows.length, createdUsers.length);
    for (const row of rows) {
      assert.ok(row.security, 'every row carries a resolved security block');
      assert.equal(typeof row.security.label, 'string');
      assert.equal(typeof row.passkeyCount, 'number');
      assert.ok(row.passkeyCount >= 0);
    }
    const withPasskeys = rows.filter((r) => r.passkeyCount > 0);
    // Two of the seeded accounts hold passkeys: the passkey-only one and the
    // one that also has an authenticator app.
    assert.equal(withPasskeys.length, 2, 'the passkey counts did not follow their own rows');
    for (const row of withPasskeys) assert.equal(row.security.method, 'passkey');
    for (const row of rows.filter((r) => r.passkeyCount === 0)) {
      assert.notEqual(row.security.method, 'passkey');
    }
  });

  await t.test('the projection still carries the fields the grid reads', async () => {
    // A regression guard on the select(): the panel reads subscription dates to
    // decide whether a paid plan has lapsed, and treats a missing end date as
    // open-ended — which once rendered every expired subscriber as active.
    const rows = await listCreated();
    for (const row of rows) {
      for (const field of [
        'firstName', 'lastName', 'email', 'createdAt',
        'subscriptionActive', 'subscriptionPlan', 'subscriptionExpiresAt',
        'subscriptionPermanent', 'twoFactorEnabled', 'twoFactorMethod',
        'lastLoginAt', 'accountRole', 'accountStatus', 'assessmentCount',
      ]) {
        assert.ok(field in row, `the grid reads ${field}, and the projection dropped it`);
      }
    }
  });
});
