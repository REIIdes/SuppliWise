/**
 * THE ALTERNATIVE RECOVERY METHODS, AGAINST A REAL DATABASE.
 *
 * The route-table test next door proves the endpoints exist; this proves they
 * work, and — more importantly — proves the anti-enumeration property that the
 * whole design rests on. That property is easy to break silently: change one
 * refusal message, reorder one guard, and a wrong code becomes a reliable oracle
 * for "this address is registered AND has an authenticator". Nothing else in the
 * suite would notice, so it is asserted here directly.
 *
 * Uses the same guarded harness as password-reset-db.test.js, which refuses to
 * run unless MONGO_TEST_URI points at a provably-throwaway database. The `after`
 * hook deletes only what this suite created — it never calls dropDatabase().
 */
const { testDbPreflight, connectTestDb } = require('./testDbGuard');

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

require('dotenv').config();

const User = require('../models/User');
const BackupCode = require('../models/BackupCode');
const PasswordResetToken = require('../models/PasswordResetToken');
const recovery = require('../utils/passwordRecovery');

const EMAIL = 'recovery-methods@example.test';
const PASSWORD = 'Cedar$Otter48!';
const NEW_PASSWORD = 'Mango$Tulip77!';

/**
 * The skip decision comes from the GUARD, evaluated at module load, and never
 * from a connection flag. node:test reads a test's `skip` option when the test
 * is REGISTERED, so a value assigned later in `before` is ignored — the tests
 * would run against a connection that was never opened and fail on a buffering
 * timeout instead of skipping cleanly. See password-reset-db.test.js for the
 * same trap documented at length.
 */
const options = testDbPreflight();
const skipIfNoDb = options.skip || false;

test.before(async () => {
  await connectTestDb();
});
test.after(async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      const fixtures = await User.find({ email: EMAIL }).select('_id').lean().catch(() => []);
      for (const u of fixtures) {
        await PasswordResetToken.deleteMany({ user: u._id }).catch(() => {});
        await BackupCode.deleteMany({ user: u._id }).catch(() => {});
      }
      await User.deleteMany({ email: EMAIL }).catch(() => {});
    }
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
});

/** A fresh account with 2FA on, mirroring what the routes expect to find. */
async function makeUser(overrides = {}) {
  await User.deleteMany({ email: EMAIL });
  // The User schema requires these; they are irrelevant to recovery but a
  // fixture missing them fails validation before any assertion runs.
  const user = new User({
    email: EMAIL,
    password: PASSWORD,
    firstName: 'Recovery',
    lastName: 'Tester',
    gender: 'Female',
    dateOfBirth: new Date('1990-01-15'),
    ...overrides,
  });
  await user.save();
  return user;
}

/** A request-shaped stub. The services only read these three things off it. */
const fakeReq = (ip = '203.0.113.10') => ({
  ip,
  get: (h) => (String(h).toLowerCase() === 'user-agent' ? 'recovery-test' : ''),
});

test('a valid recovery code mints a grant that redeems like an emailed one', { skip: skipIfNoDb }, async () => {
  const user = await makeUser({ twoFactorEnabled: true, twoFactorMethod: 'authenticator' });
  const { codes } = await BackupCode.generate(user._id);

  const result = await recovery.withRecoveryCode({ email: EMAIL, code: codes[0], req: fakeReq() });
  assert.equal(result.status, 200);
  assert.ok(result.resetToken, 'a grant token must be returned');
  assert.ok(result.expiresAt, 'the grant must carry an expiry');
  assert.equal(result.remainingCodes, codes.length - 1, 'the spent code must not count as remaining');

  // The grant is a REAL PasswordResetToken row, so the single-use claim and the
  // TTL apply exactly as they do for an emailed link.
  const stored = await PasswordResetToken.findActiveByTokenHash(result.resetToken);
  assert.ok(stored, 'the grant must be stored so /complete can find it');
  assert.equal(String(stored.user), String(user._id));

  // And it must be single-use: the second claim cannot win.
  assert.ok(await PasswordResetToken.claimByTokenHash(result.resetToken), 'first claim wins');
  assert.equal(await PasswordResetToken.claimByTokenHash(result.resetToken), null, 'second claim must lose');

  // The code itself is burned.
  assert.equal(await BackupCode.consume(user._id, codes[0]), false, 'a recovery code is single-use');
});

test('every failure mode returns the SAME status and message', { skip: skipIfNoDb }, async () => {
  const user = await makeUser({ twoFactorEnabled: true, twoFactorMethod: 'authenticator' });
  const { codes } = await BackupCode.generate(user._id);

  const wrong = await recovery.withRecoveryCode({ email: EMAIL, code: 'ZZZZZ-ZZZZZ', req: fakeReq() });
  const unknown = await recovery.withRecoveryCode({ email: 'nobody@example.test', code: codes[0], req: fakeReq() });

  assert.equal(wrong.status, unknown.status, 'status must not distinguish "wrong code" from "no such account"');
  assert.equal(wrong.message, unknown.message, 'message must not distinguish them either');
});

test('an account WITHOUT an authenticator is refused identically to a wrong code', { skip: skipIfNoDb }, async () => {
  await makeUser({ twoFactorEnabled: false });

  const noTwoFactor = await recovery.withRecoveryCode({ email: EMAIL, code: 'ZZZZZ-ZZZZZ', req: fakeReq() });
  const unknown = await recovery.withRecoveryCode({ email: 'nobody@example.test', code: 'ZZZZZ-ZZZZZ', req: fakeReq() });

  assert.equal(noTwoFactor.status, unknown.status);
  assert.equal(noTwoFactor.message, unknown.message,
    '"this account has no recovery codes" must not be distinguishable from "no such account"');
});

test('a malformed code is a 400 that reveals nothing about the account', { skip: skipIfNoDb }, async () => {
  await makeUser({ twoFactorEnabled: true, twoFactorMethod: 'authenticator' });

  // No lookup can have happened, so naming the shape of the input is safe.
  const empty = await recovery.withRecoveryCode({ email: EMAIL, code: '', req: fakeReq() });
  assert.equal(empty.status, 400);

  const unknown = await recovery.withRecoveryCode({ email: 'nobody@example.test', code: '', req: fakeReq() });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.message, empty.message);
});

test('an authenticator code mints a grant, and the same code cannot be replayed', { skip: skipIfNoDb }, async () => {
  const speakeasy = require('speakeasy');
  const user = await makeUser({ twoFactorEnabled: true, twoFactorMethod: 'authenticator' });

  // speakeasy v2 exposes generateSecret at the top level; the older
  // `speakeasy.authenticator.generateSecret` shape does not exist in it.
  const secret = speakeasy.generateSecret().base32;
  // Written the way the app stores it: encrypted, via the one helper that owns it.
  const { writeSecret } = require('../utils/totpSecret');
  const doc = await User.findById(user._id);
  writeSecret(doc, secret);
  await doc.save();

  const code = speakeasy.totp({ secret, encoding: 'base32' });

  const first = await recovery.withAuthenticatorCode({ email: EMAIL, code, req: fakeReq() });
  assert.equal(first.status, 200);
  assert.ok(first.resetToken, 'a grant token must be returned');

  // verifyTotpOnce is replay-protected per account, so the identical code must
  // not work twice.
  const replay = await recovery.withAuthenticatorCode({ email: EMAIL, code, req: fakeReq() });
  assert.equal(replay.status, 401, 'a TOTP code must not be replayable');
});

test('the recovery email is inert until it has been verified', { skip: skipIfNoDb }, async () => {
  await makeUser({
    twoFactorEnabled: false,
    recoveryEmail: 'backup@example.test',
    recoveryEmailVerifiedAt: null, // typed in, never proven
  });

  const result = await recovery.withRecoveryEmail({ email: EMAIL, req: fakeReq() });
  assert.equal(result.status, 200, 'must answer 200, not reveal anything');
  assert.equal(result.sent, false, 'an unverified address must not receive a credential');
});

test('the recovery email answers identically for an unknown account', { skip: skipIfNoDb }, async () => {
  await makeUser({ twoFactorEnabled: false });

  const unknown = await recovery.withRecoveryEmail({ email: 'nobody@example.test', req: fakeReq() });
  const known = await recovery.withRecoveryEmail({ email: EMAIL, req: fakeReq() });

  assert.equal(known.status, unknown.status);
  assert.equal(known.message, unknown.message);
});

test('a recovery grant cannot outlive its account', { skip: skipIfNoDb }, async () => {
  const user = await makeUser({ twoFactorEnabled: true, twoFactorMethod: 'authenticator' });
  const { codes } = await BackupCode.generate(user._id);

  const first = await recovery.withRecoveryCode({ email: EMAIL, code: codes[0], req: fakeReq() });
  const second = await recovery.withRecoveryCode({ email: EMAIL, code: codes[1], req: fakeReq() });

  // Completing a reset burns every OTHER outstanding grant, so a link minted
  // before the reset cannot be used after it.
  await PasswordResetToken.invalidateAllForUser(user._id);
  assert.equal(await PasswordResetToken.claimByTokenHash(first.resetToken), null);
  assert.equal(await PasswordResetToken.claimByTokenHash(second.resetToken), null);
});