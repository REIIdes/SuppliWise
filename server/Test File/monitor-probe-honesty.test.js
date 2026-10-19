'use strict';
/**
 * A Security Center row must be capable of going red.
 *
 * WHY THESE ARE STRUCTURAL
 * -----------------------
 * Four of these probes used to be incapable of failing, which is the one thing
 * a monitoring row must never be:
 *
 *   `password_hashing` read ONE member document and then stated "All verified
 *   passwords use argon2id" — a sample of one is a sample of one, and the
 *   account still holding something else was simply not the one that got read.
 *   `sensitive_data` queried with `select('-password ...')` and then checked
 *   whether the fields it had just excluded were present: the projection was
 *   written by the probe, so the probe was measuring its own query.
 *   `jwt_security` signed a token with the app's own secret and asked
 *   jsonwebtoken what lifetime it had chosen two lines earlier, then asserted a
 *   12 h expiry that no token in this application uses.
 *   `seal_integrity` did not exist at all, so the mass failure it now measures —
 *   a rotated TOTP key making every authenticator on the system quietly
 *   non-binding while sign-ins keep succeeding — had no symptom anywhere.
 *
 * They cannot be driven from a unit process: three of them talk to the live
 * verifier over HTTP and all four read the real collections. So these read the
 * source of the probe bodies and forbid the shapes that made them vacuous. The
 * behavioural halves are covered elsewhere — the seal decision by
 * totp-encryption.test.js + admin-totp-seal.test.js, the JWT rejection by the
 * auth suites, the serialization boundary by user-json-secrets.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ADMIN_SRC = fs.readFileSync(path.resolve(__dirname, '../routes/admin.js'), 'utf8');
const PROBES_SRC = fs.readFileSync(path.resolve(__dirname, '../utils/attack_probes.js'), 'utf8');

/** The body of one probe, from its declaration to the next, or to EOF. */
function probeBody(src, opener, nextMarker) {
  const start = src.indexOf(opener);
  assert.notEqual(start, -1, `probe not found: ${opener}`);
  const rest = src.slice(start);
  const end = rest.indexOf(nextMarker, opener.length);
  return end === -1 ? rest : rest.slice(0, end);
}

test('password hashing is COUNTED across every account, not sampled', () => {
  const body = probeBody(ADMIN_SRC, "probe('password_hashing'", "probe('salting'");
  assert.match(body, /User\.countDocuments\(/, 'a count over the collection is the only answer to "all"');
  assert.doesNotMatch(body, /User\.findOne\(/, 'reading one document cannot support a claim about all of them');
  // Argon2id, cost-10+ bcrypt and below-cost bcrypt are separate populations.
  // Collapsing them would let a table of `$2b$04$` hashes read as healthy.
  // The patterns are matched loosely because each `$` is escaped twice in the
  // source (a JS string holding a regex), and a test that spells the escaping
  // instead of the intent is a test that fails on reformatting.
  assert.match(body, /\$regex: '[^']*argon2id/, 'argon2id counted by a hash-prefix scan');
  assert.match(body, /\$regex: '[^']*2\[aby\]/, 'bcrypt shape recognised');
  assert.match(body, /bcryptWeak/, 'and a legacy bcrypt below cost 10 is reported apart, not merged into "fine"');
  // `[].every(x => good)` is true, so an unconfigured ADMIN_ACCOUNTS used to
  // render "hashing is sound" on a deployment that had no admin credential at all.
  assert.match(body, /envAccounts\.length > 0\s*&&/, 'an empty admin config must not vacuously pass');
  assert.match(body, /status: 'critical'/, 'and the probe has a red state');
});

test('the admin hash parser the probe uses is the parser the seeder uses', () => {
  // A bare `ADMIN_ACCOUNTS.split(',')` read `$argon2id$v=19$m=19456` as a hash
  // and called the configuration sound while the boot seeder could not load it.
  const body = probeBody(ADMIN_SRC, "probe('password_hashing'", "probe('salting'");
  assert.match(body, /require\('\.\.\/utils\/adminAccounts'\)/);
  assert.match(body, /parseAdminAccounts\(process\.env\.ADMIN_ACCOUNTS\)/);
});

test('a duplicate $ne key cannot make a null password count as hashed', () => {
  // `{ password: { $ne: null, $ne: '' } }` is one key in JavaScript, silently —
  // the second replaces the first, so `$ne: null` never applied.
  const body = probeBody(ADMIN_SRC, "probe('password_hashing'", "probe('salting'");
  assert.match(body, /\$nin:\s*\[null, ''\]/);
});

test('seal integrity measures envelopes, and can go critical', () => {
  const body = probeBody(ADMIN_SRC, "probe('seal_integrity'", "// ── 10–15");
  assert.match(body, /twoFactorSecretEnc: \{ \$nin: \[null, ''\] \}/, 'member envelopes are selected out of the DB, not counted by a flag');
  assert.match(body, /AdminAccount\.find\(/, 'operator seeds are measured too — they guard the accounts that can reset passwords');
  assert.match(body, /decrypt\(/, 'the measurement is a real AES-GCM open, not a field-presence check');
  assert.match(body, /unopenable > 0[\s\S]{0,400}status: 'critical'/,
    'a mass decrypt failure is CRITICAL: those accounts keep signing in, on an emailed code, without their second factor');
  // The scan is bounded, so the row must admit when it did not finish.
  assert.match(body, /SEAL_SCAN_MAX/, 'bounded, so a dashboard refresh cannot depend on a million-row scan');
  assert.match(body, /hit its ceiling/, 'and honest about the ceiling instead of reporting the first page as the truth');
  // Legacy plaintext operators are a named warning, not a silent healthy.
  assert.match(body, /adminPlaintext[\s\S]{0,300}status: 'warning'/);
  assert.doesNotMatch(body, /console\.(log|warn|error)\(/, 'a failing envelope is counted, never logged');
});

test('the data-key separation is reported from the row that owns crypto', () => {
  const body = probeBody(ADMIN_SRC, "probe('seal_integrity'", "// ── 10–15");
  assert.match(body, /require\('\.\.\/utils\/dataKey'\)\.describe\(\)/);
  assert.match(body, /STILL derived from JWT_SECRET/, 'the gap is named in the dashboard, not only in a boot log one deploy ago');
});

test('the JWT row exercises the DEPLOYED verifier over HTTP', () => {
  const body = probeBody(PROBES_SRC, 'jwt_security: async ()', '\n  // ── Security headers');
  assert.match(body, /selfFetch\('\/api\/auth\/me'/, 'the middleware that answers real requests is the thing under test');
  assert.match(body, /alg: 'none'/, 'an unsigned token is offered to it');
  assert.match(body, /a-strictly-wrong-secret/, 'and a token signed with a different secret');
  assert.match(body, /status: 'critical'/, 'accepting either is a red row');
  // `jwt.sign` + `jwt.decode` of your own token answers a question you just
  // asked jsonwebtoken; it says nothing about the running app.
  assert.doesNotMatch(body, /jwt\.decode/, 'no reading the probe own token back');
  assert.match(body, /status: 'warning'[\s\S]{0,120}Self-check unreachable/,
    'an unreachable self-check is reported as unmeasured, never as healthy');
});

test('the JWT row quotes the lifetimes the enforcers actually use', () => {
  // It used to assert "tokens expire 12 h after issue". Admin tokens live 15
  // minutes and slide; member tokens deliberately carry no `exp`. A dashboard
  // that states a number the code never uses trains an admin to ignore the row.
  const body = probeBody(PROBES_SRC, 'jwt_security: async ()', '\n  // ── Security headers');
  assert.match(body, /adminSession\.ADMIN_TOKEN_LIFETIME_MINUTES/);
  assert.match(body, /adminSession\.ADMIN_IDLE_MINUTES/);
  assert.match(body, /sessionsRevokedAt/, 'sign-out revocation is part of what "lifetime" means here');
  assert.doesNotMatch(body, /12 h/, 'and the invented number is gone');
});

test('the sensitive-data row runs a real document through the JSON boundary', () => {
  const body = probeBody(PROBES_SRC, 'sensitive_data: async ()', '\n  // ── ');
  assert.doesNotMatch(body, /select\('-password/, 'a probe that excludes the secret cannot discover that a route leaks it');
  assert.match(body, /toJSON|hydrate/, 'the same serialization every res.json(user) passes through');
  assert.match(body, /twoFactorSecret/, 'a recoverable authenticator seed counts as exposure, not just the password');
  assert.match(body, /status: 'critical'/, 'and it can say so');
});

test('every probe in this file is reachable from the dashboard', () => {
  // A probe that is written but never registered is how a control stops being
  // believed: the row either goes missing or stays on a stale verdict.
  for (const key of ['password_hashing', 'seal_integrity', 'jwt_security', 'sensitive_data']) {
    const defined = ADMIN_SRC.includes(`probe('${key}'`) || PROBES_SRC.includes(`${key}: async ()`);
    assert.ok(defined, `${key} is defined somewhere`);
  }
  // The attack-surface probes are spread into the list, so each needs a label
  // there; without one it still renders, but as its raw key, which is how a row
  // stops being read.
  for (const key of ['jwt_security', 'seal_integrity', 'sensitive_data']) {
    assert.ok(new RegExp(`${key}:\\s*\\['`).test(ADMIN_SRC), `${key} has a display name in the monitor list`);
  }
});
