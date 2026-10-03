/**
 * The unauthenticated recovery routes must NOT tear the tab session down.
 *
 * ── The bug this exists to prevent ─────────────────────────────────────────
 *
 * `friendlyError(401)` calls `handleAuthError`, which assumes a 401 means "this
 * tab's session is dead": it drops the tab session and navigates to /login. That
 * is correct on every signed-in screen.
 *
 * It is wrong for /auth/password-reset/recovery-code and its siblings. Those
 * routes are UNAUTHENTICATED — the caller holds no session at all — and the
 * server answers **401 for a wrong recovery code**. So the first person to
 * mistype their code was silently signed out of the tab and thrown onto the
 * sign-in screen mid-recovery, with their email address gone and no explanation.
 * Every subsequent attempt did exactly the same thing, which made the feature
 * look broken while the server logs showed nothing wrong with it.
 *
 * No HTTP test could have caught this: the bug is entirely in how the client
 * interprets the status. It only shows up when you actually drive the UI.
 *
 * The fix is `recoveryError`, which passes `isLoginAttempt = true` so the
 * teardown is skipped and the server's generic refusal is returned as an
 * ordinary Error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// api.js is a sibling of utils/, not inside it.
const SOURCE = readFileSync(join(here, '..', 'api.js'), 'utf8');

/** The exported function bodies under test, sliced out of api.js by name. */
function bodyOf(name) {
  const start = SOURCE.indexOf(`export const ${name} = async`);
  assert.notEqual(start, -1, `${name} not found in api.js`);
  const end = SOURCE.indexOf('\n};', start);
  assert.notEqual(end, -1, `end of ${name} not found`);
  return SOURCE.slice(start, end);
}

// Every endpoint the alternative-recovery section calls. Each one can answer 401,
// so each one has to route its failure through recoveryError.
const UNAUTHENTICATED_RECOVERY_CALLERS = [
  'recoverWithRecoveryCode',
  'recoverWithAuthenticator',
  'requestRecoveryEmailReset',
  'recoverWithPasskey',
];

test('recoveryError exists and opts out of the session teardown', () => {
  assert.match(SOURCE, /const recoveryError = \(status, serverMessage\) =>\s*\n?\s*new Error\(friendlyError\(status, serverMessage, true\)\)/,
    'recoveryError must pass isLoginAttempt = true, or a 401 will sign the tab out');
});

test('no recovery endpoint builds its error with the session-killing helper', () => {
  for (const name of UNAUTHENTICATED_RECOVERY_CALLERS) {
    const body = bodyOf(name);
    const bare = body.match(/friendlyError\(([^)]*)\)/g) || [];
    for (const call of bare) {
      assert.fail(
        `${name} calls ${call} directly. On a 401 that tears down the tab session `
        + 'and navigates to /login, throwing the user out of the recovery form. '
        + 'Use recoveryError() instead.'
      );
    }
  }
});

test('every recovery endpoint reports its failure through recoveryError', () => {
  for (const name of UNAUTHENTICATED_RECOVERY_CALLERS) {
    const body = bodyOf(name);
    assert.match(body, /throw recoveryError\(/, `${name} must throw via recoveryError`);
  }
});

test('the pre-existing reset helpers keep their own, different handling', () => {
  // Guard against "fixing" this by changing behaviour that was already right:
  // `completePasswordReset` attaches `status` and `linkInvalid` because the
  // reset page branches on them, and `validatePasswordResetToken` returns a 400
  // rather than throwing because a dead link is an ANSWER, not a failure.
  assert.match(SOURCE, /err\.linkInvalid = res\.status === 400/);
  assert.match(SOURCE, /if \(res\.status === 400\) return \{ valid: false/);
});