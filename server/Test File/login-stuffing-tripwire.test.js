/**
 * THE CREDENTIAL-STUFFING TRIPWIRE MUST NOT LOCK OUT A SHARED ADDRESS.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `noteIpAccountFailure()` watched for one IP failing several *distinct*
 * accounts and, on crossing the threshold, escalated that IP onto the
 * escalating `ip:` ladder — the same bucket `lockoutCheck` reads as a HARD,
 * pre-limiter stop on the entire `/api/auth` surface.
 *
 * The threshold was 3. Three is not a credential-stuffing threshold; it is a
 * typo threshold. Reaching it needs nothing more than:
 *
 *   • forgetting which of your two accounts you are signing into,
 *   • mistyping your own address twice,
 *   • two people behind one household/office NAT each getting it wrong once.
 *
 * The consequences were severe, and all of them are things a real user feels:
 *
 *   1. EVERY user behind that address was locked out of every sign-in — not
 *      just the one being guessed.
 *   2. The stop is a pre-limiter hard stop, so it also refused requests
 *      carrying the CORRECT password. The defence built to protect accounts was
 *      what locked people out of their own.
 *   3. Nothing the user could do cleared it. Only waiting 15 minutes worked, and
 *      a second incident escalated to an hour, then six, then a day.
 *   4. `lockoutCheck` runs before the route, so there was no way for a correct
 *      password to "prove" itself and release the lock.
 *
 * THE CONTRACT NOW
 * ----------------
 *   1. Failures spread over a handful of accounts are not an attack and must
 *      never touch the IP ladder.
 *   2. A tripped tripwire is INVISIBLE to `lockoutCheck` — it can never become
 *      a blanket ban on an address.
 *   3. A tripped tripwire still slows the spray down: further failed attempts
 *      are refused while the cooldown runs.
 *   4. A correct password clears the tripwire, so a shared address heals.
 *   5. The real brute-force defence — one account's repeated wrong passwords
 *      climbing the account ladder — is completely untouched.
 *
 * Pure in-memory logic: no database, no HTTP, no SMTP.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  noteIpAccountFailure,
  clearIpAccountFailures,
  stuffingCooldownMs,
  lockRemainingMs,
  recordAccountFailure,
  lockInfo,
  lockoutCheck,
  accountKey,
  IP_ACCOUNT_THRESHOLD,
  STUFFING_COOLDOWN_MS,
} = require('../utils/lockout');

/** Minimal Express-ish request/response pair for `lockoutCheck`. */
function probe(ip) {
  const req = { ip, get: () => 'probe-agent' };
  let status = null;
  let body = null;
  let nexted = false;
  const res = {
    set() {},
    status(code) { status = code; return res; },
    json(payload) { body = payload; return res; },
  };
  lockoutCheck(req, res, () => { nexted = true; });
  return { status, body, nexted };
}

// Each test uses its own address so the module-level buckets cannot leak between
// them.
let ipCounter = 0;
const freshIp = () => `198.51.${(ipCounter += 1) % 250}.${(ipCounter * 7) % 250}`;

test('a few ordinary failed sign-ins never touch the IP ladder', () => {
  const ip = freshIp();
  // The two most common human mistakes: the wrong account, and a typo'd address
  // that matches nothing. Three is the old threshold — the tripwire must now be
  // untouchable by this.
  noteIpAccountFailure(ip, 'someone@example.test');
  noteIpAccountFailure(ip, 'other@example.test');
  noteIpAccountFailure(ip, 'typo@example.test');

  assert.equal(
    lockRemainingMs(`ip:${ip}`), 0,
    'three ordinary mistakes must not lock the address out of authentication'
  );
  assert.equal(lockInfo(`ip:${ip}`).locked, false);
  assert.equal(probe(ip).nexted, true, 'the address must still be able to sign in');
});

test('an address failing many accounts is throttled, not banned', () => {
  const ip = freshIp();
  for (let i = 0; i < IP_ACCOUNT_THRESHOLD; i += 1) {
    noteIpAccountFailure(ip, `victim${i}@example.test`);
  }

  // The spray is slowed: further attempts face a cooldown…
  assert.ok(
    stuffingCooldownMs(ip) > 0,
    'a detected spray must be slowed down'
  );
  assert.ok(
    stuffingCooldownMs(ip) <= STUFFING_COOLDOWN_MS,
    'the tripwire cooldown must stay short — a shared address is not a single person'
  );

  // …but it is NEVER a blanket ban. This is the whole fix.
  assert.equal(
    lockRemainingMs(`ip:${ip}`), 0,
    'the tripwire must not write to the escalating IP bucket'
  );
  assert.equal(lockInfo(`ip:${ip}`).locked, false, 'the address must not read as locked');

  // A correct password is never refused because someone else on the same
  // address was spraying.
  const allowed = probe(ip);
  assert.equal(allowed.status, null, 'lockoutCheck must not hard-stop this address');
  assert.equal(allowed.nexted, true, 'a legitimate sign-in from this address must still reach the route');
});

test('a correct password clears the tripwire count, so a shared address heals', () => {
  const ip = freshIp();
  for (let i = 0; i < IP_ACCOUNT_THRESHOLD; i += 1) {
    noteIpAccountFailure(ip, `victim${i}@example.test`);
  }
  assert.ok(stuffingCooldownMs(ip) > 0, 'precondition: the tripwire is cooling down');

  // What /login does once `matchPassword` succeeds.
  clearIpAccountFailures(ip);

  // The COUNT is forgotten, so one ordinary typo afterwards cannot put the
  // address back into cooldown — the failure that matters (a correct password)
  // wipes the slate. The existing cooldown is deliberately left running, so the
  // proof is that the single failure did not RESTART it: the remaining time can
  // only have gone down, never back up to a full window.
  const before = stuffingCooldownMs(ip);
  assert.equal(
    noteIpAccountFailure(ip, 'someone-else@example.test'), false,
    'a single failure after a legitimate sign-in must not re-trip the tripwire'
  );
  assert.ok(
    stuffingCooldownMs(ip) <= before,
    'a single failure must not re-arm the cooldown'
  );

  // And a correct password is never what the cooldown can block.
  assert.equal(probe(ip).nexted, true, 'the address must be able to sign in again immediately');
});

test('an active cooldown never blocks a correct password', () => {
  const ip = freshIp();
  for (let i = 0; i < IP_ACCOUNT_THRESHOLD; i += 1) {
    noteIpAccountFailure(ip, `victim${i}@example.test`);
  }
  // The cooldown is deliberately left to expire rather than released on success,
  // so an attacker cannot launder a spray with one valid account. That is only
  // safe because it gates FAILED attempts: the request carrying the right
  // password still reaches the route.
  assert.ok(stuffingCooldownMs(ip) > 0, 'precondition: cooling down');
  assert.equal(probe(ip).nexted, true, 'the cooldown must not stop a legitimate sign-in');
});

test('one spray cools down, so the next burst starts a fresh count', () => {
  const ip = freshIp();
  for (let i = 0; i < IP_ACCOUNT_THRESHOLD; i += 1) {
    noteIpAccountFailure(ip, `first${i}@example.test`);
  }
  assert.ok(stuffingCooldownMs(ip) > 0, 'precondition: cooling down');

  // The counter is reset when it fires, so an address is not throttled for the
  // remainder of the window because of one early mistake.
  assert.equal(
    noteIpAccountFailure(ip, 'someone-else@example.test'), false,
    'a single fresh failure after a cooldown must not immediately re-trip'
  );
});

test('the real brute-force defence is untouched: one account, repeated guesses', () => {
  const ip = freshIp();
  const account = accountKey('email', 'target@example.test');

  // Repeated WRONG PASSWORDS for the SAME account — genuinely one person
  // guessing one account. This must still escalate, and escalate hard.
  for (let i = 0; i < 5; i += 1) {
    recordAccountFailure(account, { ip, fp: 'fp', agent: 'agent' });
  }
  assert.ok(
    lockRemainingMs(account) > 0,
    'repeated failures on ONE account must still lock that account'
  );
  // …and that lock is account-scoped: it must not have touched the address.
  assert.equal(lockRemainingMs(`ip:${ip}`), 0, 'an account lock must not become an address lock');
});

test('the admin lockout counters still add up', () => {
  // eslint-disable-next-line global-require
  const { lockoutStats } = require('../utils/lockout');
  // The bucket map is process-wide and other tests in this file have left locks
  // in it, so assert on the DELTA this test causes rather than absolute totals.
  const before = lockoutStats();

  const ip = freshIp();
  for (let i = 0; i < IP_ACCOUNT_THRESHOLD; i += 1) {
    noteIpAccountFailure(ip, `stats${i}@example.test`);
  }
  const after = lockoutStats();

  assert.equal(after.ipsLocked - before.ipsLocked, 0, 'a throttled address is not a locked address');
  assert.equal(
    after.accountsLocked - before.accountsLocked, 0,
    'a throttled address must not be miscounted as a locked account'
  );
  assert.ok(
    after.addressesThrottled - before.addressesThrottled >= 1,
    'throttled addresses must be reported rather than folded into the account count'
  );
});
