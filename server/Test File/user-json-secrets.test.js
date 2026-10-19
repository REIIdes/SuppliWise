'use strict';
/**
 * A member document must not be able to carry its own credentials out of the
 * process.
 *
 * THE BUG THIS EXISTS TO STOP
 * --------------------------
 * `User.password` is not `select: false` — every sign-in read needs the hash to
 * verify against, so hiding it behind a projection would mean editing the whole
 * auth path and forgetting one route. Forgotten routes are the actual risk: an
 * argon2id hash is a perfectly good offline cracking target once someone has the
 * database, and it is worse than useless in a JSON response because it also
 * proves the account exists and that this password was set there.
 *
 * So the deletion happens at the serialization boundary — the one place every
 * `res.json(user)` passes through — and these tests pin that boundary rather
 * than trusting each route to remember it.
 *
 * Why the ADMIN collection is not duplicated here: `AdminAccount.passwordHash`
 * and both seed fields ARE `select: false`, so a raw admin document cannot
 * contain them without a caller asking for them by name. Different mechanism,
 * same requirement, tested in admin-totp-seal.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();

const User = require('../models/User');

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$Zm9vYmFyYmF6cXV1eGRvZyEyM3Rlc3Q';
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DP';

/** A document with every secret populated, built without touching a database. */
function fullUser() {
  return new User({
    email: 'member@example.com',
    firstName: 'Mia',
    lastName: 'Reyes',
    password: HASH,
    twoFactorEnabled: true,
    twoFactorMethod: 'authenticator',
    twoFactorSecret: SEED,
    twoFactorSecretEnc: 'v1.abcd.AAAABBBB.CCCCDDDD.EEEEFFFF.GGGGHHHH',
  });
}

test('JSON serialization drops the password hash and both seed fields', () => {
  const json = fullUser().toJSON();
  assert.equal(json.password, undefined, 'the argon2id hash must not be in the payload');
  assert.equal(json.twoFactorSecret, undefined, 'the legacy plaintext seed must not be in the payload');
  assert.equal(json.twoFactorSecretEnc, undefined, 'the sealed envelope must not be in the payload');
  const text = JSON.stringify(json);
  assert.ok(!text.includes('argon2id'), 'not even as a value somewhere else in the document');
  assert.ok(!text.includes(SEED));
});

test('res.json behaviour is covered too, because that is the real path', () => {
  // `JSON.stringify(doc)` runs the same transform express reaches through
  // res.json(user) — asserted separately so a change to `toObject` alone cannot
  // reopen the hole.
  const text = JSON.stringify(fullUser());
  assert.ok(!text.includes('argon2id'));
  assert.ok(!text.includes(SEED));
});

test('the fields a client legitimately needs survive the transform', () => {
  // The other half of the property. A transform that deletes too much turns
  // into a route-by-route `toObject()` workaround, and that workaround is how
  // the hash comes back.
  const json = fullUser().toJSON();
  assert.equal(json.email, 'member@example.com');
  assert.equal(json.firstName, 'Mia');
  assert.equal(json.twoFactorEnabled, true, '2FA being ON is a fact the UI must still show');
  assert.equal(json.twoFactorMethod, 'authenticator');
});

test('a document read with lean() is a caller responsibility, and the model says so', () => {
  // `lean()` returns the raw stored document and never runs toJSON — which is
  // exactly why utils/attack_probes.js `sensitive_data` measures the transform
  // rather than a projection. Pinned here so the distinction stays visible: a
  // route that does `User.find().lean()` and returns the rows bypasses this
  // guard and must select its own fields.
  const proto = User.hydrate({ email: 'x@example.com', password: HASH }).toObject();
  assert.equal(proto.password, HASH,
    'toObject still carries the hash — the guard is at the JSON boundary, not at the document');
});
