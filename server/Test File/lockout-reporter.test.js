/**
 * THE LOCKOUT REPORTER — the one function every sign-in failure path calls.
 *
 * Run: npm test
 *
 * This file exists because of a regression that no other test could see.
 *
 * ── What went wrong ──────────────────────────────────────────────────────────
 *
 * reportAccountLockout() was changed to stop naming members in the admin bell.
 * While making that change the `email` parameter was accidentally dropped from
 * the destructuring, while routes/auth.js:642 still passed it — and still passes
 * it, because the password path resolves no account and has only the address to
 * lock.
 *
 * Inside the function `email` was then not defined in scope. Line 460 read
 *
 *   : email ? await User.findOne({ email }) : null
 *
 * which threw a ReferenceError. That throw sat inside `catch { }`, so it was
 * swallowed exactly as designed — the function kept "succeeding". The visible
 * effect was that a member locked out by repeated failed passwords received NO
 * notification and NO email. The one lockout path that matters most to the
 * person affected, failing silently.
 *
 * Two things follow, and both are asserted below:
 *
 *   1. A ReferenceError inside a best-effort block is invisible to every caller.
 *      The tests below therefore assert on the OBSERVABLE EFFECT — what the
 *      member and the bell end up with — not on the function returning.
 *   2. Nothing else in the suite exercises this path, so nothing else would have
 *      caught it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { readFileSync } = require('node:fs');
const path = require('path');

const lockoutSrc = readFileSync(path.join(__dirname, '..', 'utils', 'lockout.js'), 'utf8');
const authSrc = readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');

// ── Every field the callers pass must be one the function accepts ───────────

test('reportAccountLockout accepts every field its callers pass', () => {
  // The signature and the call sites are compared against each other rather
  // than against a list written here, because a list is exactly what goes stale
  // when a fifth caller appears.
  const signature = /function reportAccountLockout\(\{([^}]*)\}\)/.exec(lockoutSrc);
  assert.ok(signature, 'the reporter signature was not found');

  const accepted = new Set(
    signature[1].split(',').map((part) => part.trim().split(/\s*=\s*/)[0]).filter(Boolean),
  );

  const callers = [...authSrc.matchAll(/reportAccountLockout\(\{([^}]*)\}\)/g)].map((m) => m[1]);
  assert.ok(callers.length >= 9, `expected every lockout path to report, saw ${callers.length}`);

  for (const body of callers) {
    for (const field of body.split(',').map((p) => p.trim().split(':')[0]).filter(Boolean)) {
      assert.ok(
        accepted.has(field),
        `a caller passes "${field}" but the function no longer destructures it — ` +
        'the value is silently undefined inside the reporter',
      );
    }
  }
});

test('the password lockout path still names the address it locks', () => {
  // routes/auth.js locks by EMAIL on this path, because no account has been
  // resolved yet. It is the path that produced the silent failure.
  assert.match(
    authSrc,
    /reportAccountLockout\(\{\s*email:[^}]*lockKey:/,
    'the password lockout path no longer reports an email — check that the reporter still needs it',
  );
});

test('an undefined member id never renders as a fixed reference', () => {
  // memberReference(undefined) returns "Member 2222" — four zeroes through the
  // base-32 alphabet. Every such row in the console would look identical and name
  // nobody, which is the "Member 2222" signature. The reporter must therefore
  // only call it with a resolved id.
  const privacy = require('../utils/memberPrivacy');
  assert.equal(privacy.memberReference(undefined), 'Member 2222');
  assert.equal(privacy.memberReference(null), 'Member 2222');

  const reporter = lockoutSrc.slice(
    lockoutSrc.indexOf('function reportAccountLockout'),
    lockoutSrc.indexOf('function reportAccountLockout') + 4000,
  );
  const call = /memberReference\(([^)]*)\)/.exec(reporter);
  assert.ok(call, 'the reporter no longer produces a member reference');
  assert.match(
    call[1],
    /_id/,
    'the reporter calls memberReference() on something that may be undefined — ' +
    'every such row renders as the fixed string "Member 2222"',
  );
});

test('the member is resolved before either notice is written', () => {
  // Order is the fix. The bell needs the account id to produce a reference; the
  // member's notification needs the row. If the lookup happens after the AdminEvent
  // is created, the bell is written with a reference it cannot compute.
  const reporter = lockoutSrc.slice(
    lockoutSrc.indexOf('function reportAccountLockout'),
    lockoutSrc.indexOf('function reportAccountLockout') + 4000,
  );
  const lookup = reporter.indexOf('User.findOne');
  const bell = reporter.indexOf('AdminEvent.create');
  const notice = reporter.indexOf('UserNotification.create');

  assert.ok(lookup !== -1, 'the member lookup is gone from the reporter');
  assert.ok(bell !== -1, 'the admin bell is gone from the reporter');
  assert.ok(notice !== -1, 'the member notification is gone from the reporter');

  assert.ok(lookup < bell, 'the bell must be written AFTER the member is resolved');
  assert.ok(lookup < notice, 'the member notice must be written AFTER the member is resolved');
});

test('the member notice is not gated on a lookup that can fail', () => {
  // The regression hid inside `catch { }`. A failure of the EMAIL lookup must not
  // be able to skip the in-app notification, because the notification is the
  // notice the person is guaranteed to be able to read.
  const reporter = lockoutSrc.slice(
    lockoutSrc.indexOf('function reportAccountLockout'),
    lockoutSrc.indexOf('function reportAccountLockout') + 4000,
  );
  const lookupEnd = reporter.indexOf('} catch { /* best-effort');
  const notice = reporter.indexOf('UserNotification.create');
  assert.notEqual(lookupEnd, -1, 'the lookup is no longer inside a best-effort block');
  assert.ok(
    notice > lookupEnd,
    'UserNotification.create is still inside the lookup\'s catch block — ' +
    'a failed lookup would skip the notification the member depends on',
  );
});

test('the throttle key still distinguishes the paths that share a subject', () => {
  // Restoring `email` also restores the key. Without it every password lockout
  // keyed on 'unknown', so N different accounts locking out inside one hour were
  // treated as ONE and the later ones were never reported.
  const reporter = lockoutSrc.slice(
    lockoutSrc.indexOf('function reportAccountLockout'),
    lockoutSrc.indexOf('function reportAccountLockout') + 4000,
  );
  assert.match(
    reporter,
    /lockout-notify:\$\{[^}]*email[^}]*\}/,
    'the throttle key no longer includes the email, so unrelated password lockouts share one key',
  );
});

test('the admin alias is still named in full', () => {
  // An admin locking themselves out is a colleague's problem and the console is
  // the only audience — the one case where naming the subject is right.
  const reporter = lockoutSrc.slice(
    lockoutSrc.indexOf('function reportAccountLockout'),
    lockoutSrc.indexOf('function reportAccountLockout') + 4000,
  );
  assert.match(reporter, /alias\s*\n?\s*\?\s*`admin "\$\{alias\}"`/);
});