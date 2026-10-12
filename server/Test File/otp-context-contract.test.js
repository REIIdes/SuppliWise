/**
 * The otpChallenge context contract.
 *
 * `buildEntry({ otp, context })` and `consume(store, key, code)` only agree when
 * `context` is the SAME STRING as `key`. When they differ, the stored HMAC and
 * the recomputed one are over different inputs, so a correct code is rejected as
 * `mismatch` — with the identical message a genuinely wrong code produces.
 *
 * That failure mode already shipped once. Both proof routes in
 * routes/security.js stored entries under the bare account id while building the
 * digest with a `recovery_email_` / `recovery_phone_` prefix, so:
 *
 *   • setting a recovery email could never be completed, and
 *   • setting a recovery phone could never be completed,
 *
 * and neither was covered by a happy-path test. A user following the instructions
 * was told their code was wrong, over and over, with nothing to distinguish it
 * from a typo.
 *
 * These tests pin the contract at both levels: behaviourally (the two shapes),
 * and structurally (every real call site in the repository agrees).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-otp-context';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const otpChallenge = require('../utils/otpChallenge');

const SRC = path.join(__dirname, '..');

// ── Behaviour: the contract stated as a fact ─────────────────────────────────

test('a code verifies when the context equals the store key', () => {
  const code = otpChallenge.generateOtp();
  const store = new Map();
  const key = 'recovery_phone_abc123';
  store.set(key, otpChallenge.buildEntry({ otp: code, context: key, ttlMs: 60_000 }));

  const verdict = otpChallenge.consume(store, key, code);
  assert.equal(verdict.ok, true, 'the correct code must be accepted');
  assert.equal(verdict.entry.digest.length, 64, 'and the entry is returned');
});

test('a correct code is REJECTED when the context differs from the store key', () => {
  // The defect, reproduced deliberately. If this test ever starts failing
  // because consume() got more forgiving, the bug it guards is no longer
  // possible and the structural checks below can be retired — but they should
  // not be, because the two shapes are not interchangeable.
  const code = otpChallenge.generateOtp();
  const store = new Map();
  store.set('abc123', otpChallenge.buildEntry({
    otp: code,
    context: 'recovery_phone_abc123', // <-- the mismatch that shipped
    ttlMs: 60_000,
  }));

  const verdict = otpChallenge.consume(store, 'abc123', code);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.outcome, 'mismatch',
    'a differing context must read as a wrong code, which is exactly why it went unnoticed');
});

test('namespacing the key gives purpose separation between flows', () => {
  // Two flows, two keys, one shared code. The prefix is what stops a code
  // issued for the recovery phone being presented to the recovery email route.
  const code = otpChallenge.generateOtp();
  const phoneKey = 'recovery_phone_user1';
  const emailKey = 'recovery_email_user1';
  const store = new Map();
  store.set(phoneKey, otpChallenge.buildEntry({ otp: code, context: phoneKey, ttlMs: 60_000 }));

  assert.equal(otpChallenge.consume(store, emailKey, code).ok, false, 'must not cross over');
  assert.equal(otpChallenge.consume(store, phoneKey, code).ok, true);
});

// ── Structure: every real call site in the repository agrees ────────────────

/**
 * Find the argument expressions a `.set(key, ...buildEntry({ context }))` call
 * and a `consume(store, key, ...)` call pass, so they can be compared.
 */
function callSites(file) {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8');
  return { source, file };
}

test('routes/security.js uses one namespaced key for both set and consume', () => {
  const { source } = callSites('routes/security.js');

  for (const [prefix, store] of [
    ['recovery_email_', 'recoveryEmailProofs'],
    ['recovery_phone_', 'recoveryPhoneProofs'],
  ]) {
    const set = source.match(new RegExp(store + '\\.set\\((\\w+)'));
    assert.ok(set, `no ${store}.set(...) found`);

    // The key must be a variable that already contains the namespaced value,
    // not an inline template that could drift from the consume() side.
    assert.match(set[1], /^[A-Za-z0-9_]*[Kk]ey$/,
      `${store} must be keyed by a dedicated variable so the key and the context cannot diverge`);

    const binding = source.match(new RegExp('const (\\w+) = .' + prefix));
    assert.ok(binding, `${prefix} is never bound to a namespaced key`);
    assert.equal(set[1], binding[1],
      `${store}.set uses a different variable than the one built with the ${prefix} prefix`);

    // And the entry must be built with that same variable as its context.
    const built = source.match(new RegExp(store + '\\.set\\([\\s\\S]{0,400}?context: (\\w+)'));
    assert.ok(built, `${store} has no buildEntry context`);
    assert.equal(built[1], set[1],
      `${store} builds with a different context than the key it stores under`);
  }
});

test('every buildEntry context is also the key its entry is stored under', () => {
  // Precise form of the check. An inline literal is NOT automatically wrong —
  // `otpStore.set(`sms_login_${id}`, buildEntry({ context: `sms_login_${id}` }))`
  // is correct, because the same expression is used on both sides. What is
  // wrong is the two expressions DIVERGING, which is what shipped: context was
  // `recovery_email_<id>` while the key was `String(user._id)`.
  //
  // So the rule is: the expression passed as `context:` must also appear as an
  // argument to `.set(` in the same file. That fails on the defect and passes on
  // the two correct shapes above.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      const relative = path.relative(SRC, full);

      // Every `.set(<expr>,` first argument in the file.
      const setKeys = [...source.matchAll(/\.set\(\s*([^,()]+(?:\([^()]*\))?[^,]*?),/g)]
        .map((m) => m[1].trim());

      // Every `buildEntry({ ... context: <expr>` in the file.
      const contexts = [...source.matchAll(/buildEntry\(\{[\s\S]{0,400}?context:\s*([^,\n]+)/g)]
        .map((m) => m[1].trim());

      for (const context of contexts) {
        const usedAsKey = setKeys.some((key) => key === context);
        if (!usedAsKey) offenders.push(`${relative}: context ${context} is never a store key`);
      }
    }
  };
  walk(path.join(SRC, 'utils'));
  walk(path.join(SRC, 'routes'));

  assert.deepEqual(offenders, [],
    'buildEntry() context must be the same expression the entry is stored under');
});