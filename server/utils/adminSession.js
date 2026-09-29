/**
 * ADMIN SESSION LIFETIME — one definition for every number that decides when an
 * administrator is signed out.
 *
 * These values used to be written out in three places (the middleware, the auth
 * routes, and the frontend countdown) with a comment in two of them promising
 * they were kept in step. They were not: the idle window was duplicated as a
 * literal in two server files, and the token lifetime was a third literal
 * beside them. A change to one did not change the others, which is how the
 * client ended up counting down from a window the server was not enforcing.
 *
 * THE THREE NUMBERS, AND THE ORDER THEY MUST KEEP
 * ------------------------------------------------
 *   TOKEN_LIFETIME   how long a signed admin JWT is valid. The client re-issues
 *                    it on activity via POST /api/auth/admin-refresh.
 *   IDLE_LIMIT       how long the account may go without activity before the
 *                    server refuses it. This is the SECURITY control.
 *   HEARTBEAT        how often the server persists `lastActivityAt`. An
 *                    optimisation, not a policy.
 *
 * The invariant is strict, and it is the whole reason this file exists:
 *
 *   HEARTBEAT < IDLE_LIMIT < TOKEN_LIFETIME
 *
 *   • HEARTBEAT < IDLE_LIMIT — otherwise an administrator who is working
 *     CONTINUOUSLY is signed out, because the heartbeat is throttled and stops
 *     writing `lastActivityAt` while the idle check keeps reading it. At the old
 *     values this was broken: a 5-minute heartbeat against a 3:30 idle window
 *     meant an active admin was killed roughly every 4 minutes. The 10-minute
 *     window fixes it as a side effect.
 *
 *   • IDLE_LIMIT < TOKEN_LIFETIME — otherwise the token dies while the countdown
 *     still says the admin is within their allowance, so an actively-working
 *     admin is hard-logged-out with no warning. The token needs headroom above
 *     the idle window; the idle window does NOT need headroom above the token,
 *     because the idle check is a database read that a still-valid token cannot
 *     bypass.
 *
 * A longer window is therefore not one number. Raising IDLE_LIMIT past
 * TOKEN_LIFETIME would silently reintroduce a forced logout, which is why the
 * test suite asserts this ordering rather than trusting the arithmetic here.
 */

/** Minutes of inactivity before an administrator is signed out. */
const ADMIN_IDLE_MINUTES = 10;
const ADMIN_IDLE_LIMIT_SECONDS = ADMIN_IDLE_MINUTES * 60;
const ADMIN_IDLE_TIMEOUT_MS = ADMIN_IDLE_LIMIT_SECONDS * 1000;

/**
 * How long before the idle limit the warning modal appears.
 *
 * 60s rather than the old 30s: on a ten-minute window a half-minute is not
 * enough time to finish a sentence, finish an approval, or decide whether to
 * stay signed in.
 */
const ADMIN_WARNING_SECONDS = 60;

/**
 * JWT lifetime. Deliberately LONGER than the idle window (15m vs 10m) so an
 * active admin is never logged out by token expiry mid-task. The idle check
 * still ends the session after 10 minutes of silence, so this grants no extra
 * idle time — it only removes a cliff.
 */
const ADMIN_TOKEN_LIFETIME_SECONDS = 15 * 60;
const ADMIN_TOKEN_LIFETIME = `${ADMIN_TOKEN_LIFETIME_SECONDS}s`;

/**
 * How often the server writes `lastActivityAt`. Purely a write-amplification
 * optimisation.
 *
 * MUST stay below ADMIN_IDLE_TIMEOUT_MS. At half the idle window there is always
 * at least one write inside any window that has not expired, so a continuously
 * active admin is never mistaken for an idle one.
 */
const ADMIN_HEARTBEAT_INTERVAL_MS = (ADMIN_IDLE_LIMIT_SECONDS / 2) * 1000;

/**
 * Fail loudly at import time rather than shipping a session policy that signs
 * out working administrators. A mis-ordered set of constants is a security/UX
 * bug that is invisible in review and maddening in use, so it is caught the
 * moment the module loads.
 */
if (!(ADMIN_HEARTBEAT_INTERVAL_MS < ADMIN_IDLE_TIMEOUT_MS)) {
  throw new Error(
    'adminSession invariant violated: the activity heartbeat must be shorter than the idle '
    + `window, or a continuously active administrator is signed out (heartbeat `
    + `${ADMIN_HEARTBEAT_INTERVAL_MS}ms, idle ${ADMIN_IDLE_TIMEOUT_MS}ms).`,
  );
}
if (!(ADMIN_IDLE_TIMEOUT_MS < ADMIN_TOKEN_LIFETIME_SECONDS * 1000)) {
  throw new Error(
    'adminSession invariant violated: the token must outlive the idle window, or an active '
    + `administrator is logged out with no warning (idle ${ADMIN_IDLE_TIMEOUT_MS}ms, token `
    + `${ADMIN_TOKEN_LIFETIME_SECONDS * 1000}ms).`,
  );
}

module.exports = {
  ADMIN_IDLE_MINUTES,
  ADMIN_IDLE_LIMIT_SECONDS,
  ADMIN_IDLE_TIMEOUT_MS,
  ADMIN_WARNING_SECONDS,
  ADMIN_TOKEN_LIFETIME,
  ADMIN_TOKEN_LIFETIME_SECONDS,
  ADMIN_HEARTBEAT_INTERVAL_MS,
};
