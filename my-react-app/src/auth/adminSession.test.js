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
