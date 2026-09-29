/**
 * ADMIN SESSION POLICY — the ordering rules, not the numbers.
 *
 * An admin session is governed by three numbers: how long the account may be
 * idle, how long the token is valid, and how often the server records activity.
 * They are not independent — get the order wrong and working administrators are
 * signed out mid-task, which is the failure mode that actually happens.
 *
 * These tests assert the ORDER and the client/server AGREEMENT. The values
 * themselves are deliberately not pinned to "10 minutes": raising the window is
 * supposed to be a one-line change in server/utils/adminSession.js, and a test
 * hard-coding 600 would just be a second number to forget. The tests below fail
 * only when the policy becomes self-defeating or the two sides disagree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import policy from '../../../server/utils/adminSession.js';

const {
  ADMIN_IDLE_MINUTES,
  ADMIN_IDLE_LIMIT_SECONDS,
  ADMIN_IDLE_TIMEOUT_MS,
  ADMIN_WARNING_SECONDS,
  ADMIN_TOKEN_LIFETIME,
  ADMIN_TOKEN_LIFETIME_SECONDS,
  ADMIN_HEARTBEAT_INTERVAL_MS,
} = policy;

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, ...parts), 'utf8');
const dashboard = read('..', 'Pages', 'AdminDashboard.jsx');

// The middleware and the routes are READ as text, not imported. Importing them
// would execute Express router construction (and its model requires) purely to
// assert on a literal, and a CJS module's default export is an object, not
// something a regex can be tested against.
const serverDir = join(here, '..', '..', '..', 'server');
const middlewareAuth = readFileSync(join(serverDir, 'middleware', 'auth.js'), 'utf8');
const authRoutes = readFileSync(join(serverDir, 'routes', 'auth.js'), 'utf8');
const indexJs = readFileSync(join(serverDir, 'index.js'), 'utf8');

test('the idle window is expressed in one unit, consistently', () => {
  // Minutes is what a human reasons about; the rest is derived. A mismatch here
  // would mean the countdown and the server disagreed by a factor of 60.
  assert.equal(ADMIN_IDLE_LIMIT_SECONDS, ADMIN_IDLE_MINUTES * 60);
  assert.equal(ADMIN_IDLE_TIMEOUT_MS, ADMIN_IDLE_LIMIT_SECONDS * 1000);
  assert.ok(ADMIN_IDLE_MINUTES > 0, 'the window must be a real number of minutes');
  // A window of zero, or a negative one, would sign an admin out on the first
  // request — a plausible typo with no other symptom.
  assert.ok(Number.isInteger(ADMIN_IDLE_MINUTES), 'a fractional idle window is a typo');
});

test('the heartbeat is shorter than the idle window', () => {
  // THE rule that was broken before. `lastActivityAt` is written on a throttle
  // but read on every request by the idle check. When the throttle is LONGER than
  // the window, the write stops happening while the read keeps firing, and an
  // administrator who never stops working is signed out as if they had.
  //
  // At the old values this was 5 minutes of throttle against a 3:30 window.
  assert.ok(
    ADMIN_HEARTBEAT_INTERVAL_MS < ADMIN_IDLE_TIMEOUT_MS,
    `heartbeat ${ADMIN_HEARTBEAT_INTERVAL_MS}ms must be shorter than the idle window `
    + `${ADMIN_IDLE_TIMEOUT_MS}ms, or an active admin is signed out`,
  );
  // Comfortably shorter, not merely shorter: at exactly the window there is no
  // margin at all, and clock granularity decides who gets logged out.
  assert.ok(
    ADMIN_HEARTBEAT_INTERVAL_MS * 2 <= ADMIN_IDLE_TIMEOUT_MS,
    'the heartbeat should be at most half the window, so one write always lands inside it',
  );
});

test('the token outlives the idle window', () => {
  // Otherwise the token dies while the countdown still shows time in hand: the
  // admin is hard-logged-out mid-task with no warning and no way to avoid it.
  // The idle check is what ends an idle session, and it cannot be bypassed by a
  // still-valid token — so headroom here grants no extra idle time.
  assert.ok(
    ADMIN_IDLE_TIMEOUT_MS < ADMIN_TOKEN_LIFETIME_SECONDS * 1000,
    `token ${ADMIN_TOKEN_LIFETIME_SECONDS}s must outlive the idle window ${ADMIN_IDLE_LIMIT_SECONDS}s`,
  );
});

test('the warning appears before the window closes, with room to act', () => {
  // A warning that fires at the same moment the session ends is not a warning.
  assert.ok(
    ADMIN_WARNING_SECONDS > 0 && ADMIN_WARNING_SECONDS < ADMIN_IDLE_LIMIT_SECONDS,
    'the warning threshold must fall inside the idle window',
  );
  // And far enough ahead to finish a thought. 30s on a 3:30 window was tight;
  // on a ten-minute window it is worse, because that is the time the admin now
  // has to notice, decide and click.
  assert.ok(
    ADMIN_WARNING_SECONDS >= 60,
    'at least a minute of notice, or the modal is an interruption rather than a warning',
  );
});

test('the token lifetime is a parseable duration string', () => {
  // It goes straight into jwt.sign({ expiresIn }). A malformed value does not
  // throw at require-time — it throws at the first admin sign-in, in production.
  assert.match(ADMIN_TOKEN_LIFETIME, /^\d+[smhd]$/);
  const seconds = Number(ADMIN_TOKEN_LIFETIME.slice(0, -1))
    * { s: 1, m: 60, h: 3600 }[ADMIN_TOKEN_LIFETIME.slice(-1)];
  assert.equal(seconds, ADMIN_TOKEN_LIFETIME_SECONDS, 'the string and the number must agree');
});

test('the frontend fallback window equals the server window', () => {
  // The badge shows a number before the first /auth/admin-refresh reply lands.
  // If that fallback is not the server's window, the countdown briefly tells the
  // admin a duration the API does not honour.
  const match = /const ADMIN_IDLE_LIMIT_SECONDS = (\d+) \* 60;/.exec(dashboard);
  assert.ok(match, 'the fallback constant is still declared as MINUTES * 60');
  assert.equal(
    Number(match[1]) * 60,
    ADMIN_IDLE_LIMIT_SECONDS,
    'the frontend fallback idle window does not match the server',
  );
});

test('the frontend takes its window from the server, not only the fallback', () => {
  // Reading it back from the API is what keeps the two from drifting after this
  // point. Without this, the fallback above is the only link and a future server
  // change would leave the badge counting the wrong thing.
  assert.ok(
    /idleLimitSeconds/.test(dashboard),
    'the dashboard should adopt idleLimitSeconds from /auth/admin-refresh',
  );
  assert.ok(
    /idlingRef\.current\s*\*\s*1000/.test(dashboard),
    'the activity listeners should re-anchor the deadline from the live window',
  );
  // A hard-coded window anywhere in the re-anchor would silently override the
  // server's value on every mouse move.
  const reanchors = dashboard.match(/idleDeadlineRef\.current = Date\.now\(\) \+ [^;]+;/g) || [];
  assert.ok(reanchors.length > 0, 'the deadline is set somewhere');
  for (const line of reanchors) {
    assert.ok(
      !/ADMIN_IDLE_LIMIT_SECONDS\s*\*\s*1000/.test(line),
      `a deadline is re-anchored from the compile-time constant, ignoring the server: ${line}`,
    );
  }
});

test('the middleware and the routes read the same policy module', () => {
  // Both used to carry their own literal copy of the idle window, with comments
  // claiming they were kept in step. This asserts the duplication is gone: a new
  // literal would have to be added to both files to reappear.
  for (const [name, source] of [['middleware', middlewareAuth], ['routes', authRoutes]]) {
    assert.ok(
      /require\('\.\.\/utils\/adminSession'\)/.test(source),
      `${name} should import the policy rather than restate it`,
    );
    assert.ok(
      !/\(\s*3\s*\*\s*60\s*\+\s*30\s*\)\s*\*\s*1000/.test(source),
      `${name} has reintroduced the old 3:30 literal`,
    );
    assert.ok(
      !/expiresIn:\s*'5m'/.test(source),
      `${name} has reintroduced a hard-coded 5-minute token`,
    );
    assert.ok(
      !/expiresInSeconds:\s*5\s*\*\s*60/.test(source),
      `${name} has reintroduced a hard-coded 5-minute lifetime in the response`,
    );
  }
});

// ── The idle check itself ───────────────────────────────────────────────
// It used to be written out twice, in the middleware and in /auth/admin-refresh,
// and both copies read:
//
//     if (admin.lastActivityAt && Date.now() - admin.lastActivityAt > IDLE)
//
// That `&&` is a hole rather than a guard. With no stamp — a new account, or one
// whose sign-in never reached the write — the check is SKIPPED and the session
// is never idle-expired, leaving `exp` as the only bound. These assert the hole
// is closed and, crucially, that it fails CLOSED.

test('a session with no activity stamp is still measured', () => {
  const { idleReferenceMs, idleExceeded } = policy;
  const now = Date.now();
  const freshToken = { iat: Math.floor(now / 1000) };

  // A fresh token with no stamp is legitimate: just signed in.
  assert.equal(
    idleExceeded({ lastActivityAt: null }, freshToken, now), false,
    'a token issued moments ago must not be treated as idle',
  );
  // An old token with no stamp must NOT be waved through — this is the case the
  // old `admin.lastActivityAt && ...` silently allowed.
  const oldToken = { iat: Math.floor((now - (ADMIN_IDLE_LIMIT_SECONDS + 60) * 1000) / 1000) };
  assert.equal(
    idleExceeded({ lastActivityAt: null }, oldToken, now), true,
    'an unstamped session older than the window must be refused, not waved through',
  );
  // And with nothing at all to measure from, refuse. An unmeasurable session is
  // not an unlimited one.
  assert.equal(idleReferenceMs({ lastActivityAt: null }, {}), 0);
  assert.equal(idleExceeded({ lastActivityAt: null }, {}, now), true);
});

test('the stamp is preferred over the token, and both agree when fresh', () => {
  const { idleReferenceMs, idleExceeded } = policy;
  const now = Date.now();
  // A recent stamp wins: the token may be older than the stamp (it is only
  // re-issued periodically), so using `iat` would understate activity.
  const recent = new Date(now - 5000);
  assert.equal(idleReferenceMs({ lastActivityAt: recent }, { iat: 1 }), recent.getTime());
  assert.equal(idleExceeded({ lastActivityAt: recent }, { iat: 1 }, now), false);
  // And a stamp past the window is honoured even when the token looks new.
  const old = new Date(now - (ADMIN_IDLE_LIMIT_SECONDS + 60) * 1000);
  assert.equal(
    idleExceeded({ lastActivityAt: old }, { iat: Math.floor(now / 1000) }, now), true,
    'a stale stamp must end the session even though the token was just re-issued',
  );
});

test('a token renewal does not count as activity', () => {
  // THE load-bearing distinction behind the client keepalive. The dashboard
  // re-issues its token on a timer; if that counted as activity it would slide
  // `lastActivityAt` forever and the ten-minute timeout would stop existing for
  // every admin — the keepalive would quietly remove the control it sits beside.
  const { countsAsActivity } = policy;
  for (const body of [{ renew: true }, { renew: 'true' }, { renew: '1' }, { tokenRenewal: true }]) {
    assert.equal(countsAsActivity(body), false, `${JSON.stringify(body)} must not count as activity`);
  }
  // Everything else is genuine activity.
  for (const body of [{}, undefined, { renew: false }, { renew: 'yes' }, { renew: 1 }]) {
    assert.equal(countsAsActivity(body), true, `${JSON.stringify(body)} must count as activity`);
  }
});

test('the middleware and the routes share ONE idle check', () => {
  // The whole reason idleExceeded exists. Two copies of this decision drifted
  // before, and both carried the same hole; a third copy would reintroduce it.
  for (const [name, source] of [['middleware', middlewareAuth], ['routes', authRoutes]]) {
    assert.ok(
      /idleExceeded\(/.test(source),
      `${name} should call the shared idle check`,
    );
    assert.ok(
      !/admin\.lastActivityAt\s*&&\s*Date\.now\(\)/.test(source),
      `${name} has reintroduced the inline check that skips an unstamped session`,
    );
  }
  assert.ok(
    /idleExceeded/.test(authRoutes) && /countsAsActivity/.test(authRoutes),
    '/auth/admin-refresh must both check idleness and honour the renew flag',
  );
});

test('the activity stamp is throttled in the database, not in process memory', () => {
  // The heartbeat used to be an unconditional write on EVERY admin request, and
  // the dashboard polls every 10 seconds. The throttle has to be the filter on
  // the update, not a Map in one process: behind a load balancer each instance
  // would keep its own counter, so the stamp would be written once per instance
  // per interval and the "throttle" would not actually throttle anything.
  // `[\s\S]*?` rather than `[^}]*`: the guard sits inside a NESTED object
  // (`lastActivityAt: { $lt: … }`), so a brace-excluding pattern can never reach
  // it — which would make this assertion pass or fail for a formatting reason.
  const update = /AdminAccount\.updateOne\([\s\S]*?lastActivityAt:\s*\{\s*\$lt/.test(middlewareAuth);
  assert.ok(
    update,
    'the admin heartbeat should carry an `$lt` guard in the update filter',
  );
  assert.ok(
    /ADMIN_HEARTBEAT_INTERVAL_MS/.test(middlewareAuth),
    'the guard should be expressed in the declared heartbeat interval',
  );
});

// ── The client keepalive ─────────────────────────────────────────────────
// An admin JWT is deliberately short-lived. Nothing used to re-issue it except
// the "Stay signed in" button, which only appears after the IDLE countdown runs
// out — so an admin who was working continuously never saw it, and at the
// token's `exp` they were signed out mid-task with no warning. That is not an
// edge case; it is what working for a quarter of an hour did.

test('the dashboard renews the token before it expires', () => {
  assert.ok(
    /renewIfDue/.test(dashboard) && /ADMIN_TOKEN_CHECK_INTERVAL_MS/.test(dashboard),
    'the dashboard should poll for a token that is due for renewal',
  );
  assert.ok(
    /ADMIN_TOKEN_RENEWAL_RATIO/.test(dashboard),
    'renewal should be scheduled from a ratio of the token lifetime, not at expiry',
  );
  // It has to schedule off the server's number. The old bug in one line: an
  // admin who sees a countdown they do not understand is better than one who is
  // logged out, but neither is worth a hard-coded number that can drift.
  assert.ok(
    /data\.expiresInSeconds/.test(dashboard),
    'the keepalive should take the token lifetime from the server response',
  );
});

test('the keepalive renews the token without holding the session open', () => {
  // The single most important property of the keepalive. It sends `renew: true`,
  // which the server treats as a token renewal and NOT as activity. Without it
  // the timer would refresh `lastActivityAt` on every pass and the ten-minute
  // idle timeout would never fire for anyone.
  assert.ok(
    /JSON\.stringify\(\{\s*renew:\s*true\s*\}\)/.test(dashboard),
    'the keepalive must send renew: true',
  );
  // And it must not slide the visible idle deadline either, or the countdown
  // would show an admin time they do not actually have.
  assert.ok(
    !/renewIfDue[\s\S]{0,600}idleDeadlineRef\.current\s*=/.test(dashboard),
    'a token renewal must not move the idle countdown deadline',
  );
});

test('a failed renewal is not a sign-out', () => {
  // The 401 case is a real sign-out and must be handled. Everything else — a
  // dropped connection, a 5xx during a deploy — must leave the working token
  // alone, or a restart signs out every administrator in the building.
  assert.ok(
    /response\.status === 401/.test(dashboard),
    'a 401 from the renewal should sign the admin out',
  );
  const renewal = /syncAdminSession[\s\S]*?countsAsActivity|async \(asActivity\)[\s\S]*?throw new Error/.exec(dashboard);
  assert.ok(renewal, 'the renewal helper should be inspectable');
  const catchBlocks = (dashboard.match(/\.catch\(\(\) => \{ \/\* a failed attempt/g) || []).length;
  assert.ok(
    catchBlocks > 0,
    'a failed renewal attempt should be swallowed so the next tick can retry',
  );
});

test('the frontend fallback token lifetime equals the server', () => {
  // Same rule as the idle window: the badge is on screen before the first reply
  // arrives, so the fallback has to be the enforced number.
  const match = /const ADMIN_TOKEN_LIFETIME_SECONDS = (\d+) \* 60;/.exec(dashboard);
  assert.ok(match, 'the fallback token lifetime is still declared as MINUTES * 60');
  assert.equal(
    Number(match[1]) * 60,
    ADMIN_TOKEN_LIFETIME_SECONDS,
    'the frontend fallback token lifetime does not match the server',
  );
});

// ── The activity beacon ──────────────────────────────────────────────────
// Resetting the local countdown is not the same as telling the server. The
// dashboard's own 10-second poll is marked X-Admin-Background so an unattended
// tab cannot hold a session open, which means the server only ever hears about
// activity from a NON-background request. Without a beacon, an admin reading the
// dashboard and clicking nothing watches a countdown that never runs out while
// the server signs them out anyway.

test('user input is reported to the server, not only to the local countdown', () => {
  assert.ok(
    /ADMIN_ACTIVITY_BEACON_MS/.test(dashboard) && /sendActivityBeacon/.test(dashboard),
    'the activity listeners should also beacon to the server',
  );
  assert.ok(
    /auth\/admin-activity/.test(dashboard),
    'and it should be the dedicated beacon endpoint, not the token renewal',
  );
  // It must ride on the SAME events the countdown listens to. If the two used
  // different signals they would disagree again, which is the bug.
  const events = /const activityEvents = \[([^\]]+)\]/.exec(dashboard);
  assert.ok(events, 'the shared activity event list is still declared');
  const handler = /const handleActivity = \(\) => \{([^}]*)\}/.exec(dashboard);
  assert.ok(handler, 'the shared handler is still declared');
  assert.match(
    handler[1],
    /resetIdleTimer\(\)/,
    'the handler must reset the countdown',
  );
  assert.match(
    handler[1],
    /sendActivityBeacon\(\)/,
    'and beacon to the server, from the same handler',
  );
});

test('the beacon is throttled, and only fires on real input', () => {
  // Once a minute rather than once per event, or a person typing costs a
  // request per keystroke.
  assert.ok(
    /now - lastBeacon < ADMIN_ACTIVITY_BEACON_MS/.test(dashboard),
    'the beacon must be throttled',
  );
  // Driven by user events only — never a timer. A timer-driven beacon would
  // keep every admin session open forever, which is precisely what the ten
  // minute timeout exists to prevent.
  const beacon = /const sendActivityBeacon = \(\) => \{[\s\S]*?\n {4}\};/.exec(dashboard);
  assert.ok(beacon, 'the beacon is inspectable');
  assert.ok(
    !/setInterval|setTimeout/.test(beacon[0]),
    'the beacon must not be on a timer of its own',
  );
});

test('the beacon is excluded from the sensitive auth budget', () => {
  // A non-loopback deployment gets 20 requests per 15 minutes on /api/auth.
  // A once-a-minute beacon would spend 15 of them on a background ping and
  // leave a legitimate administrator unable to sign in — the same failure the
  // `skip` on GET /me exists to prevent.
  assert.ok(
    /req\.path === '\/admin-activity'/.test(indexJs),
    'index.js should skip the auth limiter for the activity beacon',
  );
  assert.ok(
    /protect/.test(authRoutes),
    'and the beacon must still be authenticated',
  );
});

test('the beacon is a real, protected endpoint that mints nothing', () => {
  // It stamps activity (so the idle window genuinely slides) but must not be a
  // second way to obtain a token — that is /auth/admin-refresh's job, and
  // conflating them is how the idle timeout would get quietly disabled.
  assert.ok(
    /router\.post\('\/admin-activity',\s*protect/.test(authRoutes),
    'the beacon endpoint should exist and be protected',
  );
  const beaconRoute = /router\.post\('\/admin-activity'[\s\S]*?\n\}\);/.exec(authRoutes);
  assert.ok(beaconRoute, 'the beacon route is inspectable');
  assert.ok(
    !/adminToken\(/.test(beaconRoute[0]),
    'the beacon must not mint a token',
  );
  assert.ok(
    /idleLimitSeconds/.test(beaconRoute[0]),
    'and it reports the enforced window so the client can correct its countdown',
  );
});
