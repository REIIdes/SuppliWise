const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('path');

const { FACTORS, strongestFactor, describeFactor } = require('../utils/strongestFactor');

/**
 * The strongest-factor rule, in one place.
 *
 * Background: the admin Users grid rendered
 *     user.twoFactorEnabled ? 'Google Authenticator active' : 'Email OTP active'
 * while /api/security/summary computed the same question correctly and knew
 * about passkeys. Two answers to one question, and the admin one was wrong
 * twice — it called email-coded accounts "Google Authenticator", and it called
 * passkey-only accounts (holding the strongest factor available) the weakest.
 *
 * These tests exist so the two endpoints cannot drift apart again.
 */

test('a passkey outranks every other factor', () => {
  assert.equal(strongestFactor({ passkeyCount: 2 }), FACTORS.PASSKEY);
  assert.equal(
    strongestFactor({ passkeyCount: 1, twoFactorEnabled: true, twoFactorMethod: 'authenticator' }),
    FACTORS.PASSKEY,
    'a passkey plus an authenticator app is still reported as a passkey',
  );
});

test('the 2FA method is honoured when there is no passkey', () => {
  assert.equal(
    strongestFactor({ passkeyCount: 0, twoFactorEnabled: true, twoFactorMethod: 'authenticator' }),
    FACTORS.AUTHENTICATOR,
  );
  assert.equal(
    strongestFactor({ passkeyCount: 0, twoFactorEnabled: true, twoFactorMethod: 'email' }),
    FACTORS.EMAIL,
  );
});

test('twoFactorMethod is ignored while 2FA is off', () => {
  // models/User.js documents the field as meaningful only while enabled.
  // Honouring it here would report protection the account does not have.
  assert.equal(
    strongestFactor({ passkeyCount: 0, twoFactorEnabled: false, twoFactorMethod: 'authenticator' }),
    FACTORS.PASSWORD,
  );
});

test('an enabled account with no stored method falls back to the authenticator', () => {
  // Under-reporting protection is the dangerous direction, so the stronger
  // reading wins over claiming 'password'.
  assert.equal(strongestFactor({ twoFactorEnabled: true }), FACTORS.AUTHENTICATOR);
  assert.equal(
    strongestFactor({ twoFactorEnabled: true, twoFactorMethod: 'something-new' }),
    FACTORS.AUTHENTICATOR,
  );
});

test('no state at all reads as password only', () => {
  assert.equal(strongestFactor(), FACTORS.PASSWORD);
  assert.equal(strongestFactor({}), FACTORS.PASSWORD);
});

test('a non-numeric or absent count never counts as a passkey', () => {
  // countDocuments returns a Number, but a Mongo aggregation can return a Long
  // and a partial projection can return anything. Only a real positive number
  // may promote an account to "passkey": a false positive here asserts
  // protection the account does not have.
  for (const passkeyCount of [undefined, null, 0, '0', '', NaN, 'many', {}, -1, -5]) {
    assert.notEqual(
      strongestFactor({ passkeyCount, twoFactorEnabled: true, twoFactorMethod: 'authenticator' }),
      FACTORS.PASSKEY,
      `passkeyCount ${JSON.stringify(passkeyCount)} must not read as a passkey`,
    );
  }
});

test('a BigInt or numeric-string count still counts', () => {
  // Aggregations return Long, which serialises to a string-shaped number across
  // the wire. These must promote the account, not silently drop it.
  assert.equal(strongestFactor({ passkeyCount: '2' }), FACTORS.PASSKEY);
  assert.equal(strongestFactor({ passkeyCount: 2n }), FACTORS.PASSKEY);
});

test('the label always agrees with the method', () => {
  assert.equal(describeFactor({ passkeyCount: 1 }).label, '1 passkey active');
  assert.equal(describeFactor({ passkeyCount: 4 }).label, '4 passkeys active');
  assert.equal(
    describeFactor({ passkeyCount: 0, twoFactorEnabled: true, twoFactorMethod: 'authenticator' }).label,
    'Google Authenticator active',
  );
  assert.equal(
    describeFactor({ passkeyCount: 0, twoFactorEnabled: true, twoFactorMethod: 'email' }).label,
    'Email OTP active',
  );
  assert.equal(describeFactor({}).label, 'Password only');
});

test('the email label never mentions an authenticator', () => {
  // The specific lie the old column told. Asserted directly so a future edit
  // to the copy cannot reintroduce it.
  const described = describeFactor({ twoFactorEnabled: true, twoFactorMethod: 'email' });
  assert.doesNotMatch(described.label, /Authenticator/i);
  assert.equal(described.strong, false);
});

test('each method maps to a distinct label', () => {
  const labels = new Set();
  for (const method of Object.values(FACTORS)) {
    const described = describeFactor({
      passkeyCount: method === FACTORS.PASSKEY ? 1 : 0,
      twoFactorEnabled: method === FACTORS.AUTHENTICATOR || method === FACTORS.EMAIL,
      twoFactorMethod: method,
    });
    assert.equal(described.method, method);
    assert.ok(described.label.trim(), `${method} needs a label`);
    assert.equal(labels.has(described.label), false, `label "${described.label}" is used twice`);
    labels.add(described.label);
  }
});

test('describeFactor always reports a count, so a caller cannot render NaN', () => {
  for (const passkeyCount of [undefined, null, NaN, 'x']) {
    const described = describeFactor({ passkeyCount, twoFactorEnabled: true });
    assert.equal(described.passkeyCount, 0);
    assert.doesNotMatch(described.label, /NaN|undefined/);
  }
});

test('FACTORS is frozen', () => {
  // A caller mutating this would change the contract for everyone else.
  assert.equal(Object.isFrozen(FACTORS), true);
});

// ── Wiring ────────────────────────────────────────────────────────────────
//
// The helper is only worth having if both endpoints actually use it. These read
// the source, in the style of the other structural tests in this repo.

const adminRouteSource = readFileSync(
  path.join(__dirname, '..', 'routes', 'admin.js'),
  'utf8',
);
const securityRouteSource = readFileSync(
  path.join(__dirname, '..', 'routes', 'security.js'),
  'utf8',
);

test('the admin users route resolves the factor server-side', () => {
  assert.match(
    adminRouteSource,
    /require\('\.\.\/utils\/strongestFactor'\)/,
    'routes/admin.js does not import strongestFactor',
  );
  assert.match(
    adminRouteSource,
    /describeFactor\(\{[\s\S]*?passkeyCount[\s\S]*?twoFactorEnabled[\s\S]*?twoFactorMethod/,
    'routes/admin.js does not feed all three inputs to describeFactor',
  );
});

test('the admin users route selects twoFactorMethod alongside twoFactorEnabled', () => {
  // Without the method field the route can only guess, and guessing wrong is
  // the bug being fixed.
  const usersRoute = adminRouteSource.match(/router\.get\('\/users'[\s\S]*?\.lean\(\)/);
  assert.ok(usersRoute, 'could not locate the /users query');
  assert.match(usersRoute[0], /twoFactorEnabled/);
  assert.match(usersRoute[0], /twoFactorMethod/);
});

test('the admin users route counts passkeys in one grouped query, not per user', () => {
  // A countDocuments() inside the map is 100 extra round trips on every render.
  const usersRoute = adminRouteSource.match(/router\.get\('\/users'[\s\S]*?res\.json\(\{ users:/);
  assert.ok(usersRoute, 'could not locate the /users handler body');
  assert.match(usersRoute[0], /Passkey\.aggregate\(/, 'passkeys are not counted with an aggregate');
  assert.match(usersRoute[0], /Promise\.all\(/, 'the passkey count is not batched with the assessment count');
});

test('a missing passkeys collection degrades the column instead of the endpoint', () => {
  // On a database where the collection was never created, the users table must
  // still load. Security display is important; the account list is load bearing.
  const usersRoute = adminRouteSource.match(/router\.get\('\/users'[\s\S]*?res\.json\(\{ users:/);
  assert.ok(usersRoute);
  assert.match(usersRoute[0], /Passkey\.aggregate\([\s\S]*?\)\s*\.catch\(/, 'the passkey query can reject the whole response');
});

test('the user-facing summary uses the same helper', () => {
  assert.match(securityRouteSource, /require\('\.\.\/utils\/strongestFactor'\)/);
  assert.match(
    securityRouteSource,
    /strongestMethod:\s*strongestFactor\(/,
    'routes/security.js still has its own copy of the expression',
  );
});

test('neither endpoint keeps a hand-rolled copy of the old expression', () => {
  // The distinguishing tail is `: 'password'` — that fallback is what made the
  // old expression a strongest-factor rule rather than an "is a second factor
  // active" read. (routes/security.js still legitimately resolves the active
  // method in a few places: "which second factor is required" is a different
  // question that does not involve passkeys, and matching it here would be
  // wrong.) If the strongest-factor rule is re-inlined anywhere, the two
  // endpoints can drift apart again.
  const legacy = /twoFactorEnabled\s*\?\s*\(?\s*(?:user\.)?twoFactorMethod[^\n]*:\s*'password'/;
  assert.doesNotMatch(securityRouteSource, legacy, 'routes/security.js re-inlined the rule');
  assert.doesNotMatch(adminRouteSource, legacy, 'routes/admin.js re-inlined the rule');
});

test('the old passkey-blind rule is not reintroduced anywhere', () => {
  // `passkeys.length > 0 ? 'passkey' : ...` was correct in isolation but is
  // exactly the copy that has to be shared, not duplicated.
  for (const [name, source] of [['routes/security.js', securityRouteSource], ['routes/admin.js', adminRouteSource]]) {
    assert.doesNotMatch(source, /passkeys?\.length\s*>\s*0\s*\?/, `${name} re-inlined the passkey comparison`);
  }
});
