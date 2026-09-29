/**
 * ADMIN SESSION LIFETIME — one definition for every number that decides when an
 * administrator is signed out, plus the ONE function that decides it.
 *
 * These values used to be written out in three places (the middleware, the auth
 * routes, and the frontend countdown) with a comment in two of them promising
 * they were kept in step. They were not: the idle window was duplicated as a
 * literal in two server files, and the token lifetime was a third literal beside
 * them. A change to one did not change the others, which is how the client ended
 * up counting down from a window the server was not enforcing. Worse, BOTH
 * copies of the idle check had the same hole — see `idleReferenceMs` below.
 *
 * ── The four numbers, and the order they must keep ───────────────────────
 *
 *   TOKEN_LIFETIME   how long a signed admin JWT is valid.
 *   IDLE_LIMIT       how long the account may go without activity before the
 *                    server refuses it. This is THE SECURITY CONTROL.
 *   HEARTBEAT        how often the server persists `lastActivityAt`. An
 *                    optimisation, not a policy.
 *   WARNING          how long before the limit the client warns. Display only.
 *
 *   HEARTBEAT < IDLE_LIMIT < TOKEN_LIFETIME
 *
 *   • HEARTBEAT < IDLE_LIMIT — the heartbeat is throttled, so it stops writing
 *     `lastActivityAt` for a while; if that gap could outlast the idle window,
 *     a CONTINUOUSLY ACTIVE administrator would be signed out, because the idle
 *     check keeps reading a value the heartbeat stopped refreshing. At the old
 *     values this was broken: a 5-minute heartbeat against a 3:30 idle window
 *     meant an active admin was killed roughly every 4 minutes.
 *
 *   • IDLE_LIMIT < TOKEN_LIFETIME — otherwise the token dies while the
 *     countdown still says the admin is inside their allowance, so a working
 *     admin is hard-logged-out with no warning. The token needs headroom above
 *     the idle window; the idle window does NOT need headroom above the token,
 *     because the idle check is a database read that a still-valid token cannot
 *     bypass.
 *
 * Raising IDLE_LIMIT past TOKEN_LIFETIME silently reintroduces a forced logout,
 * which is why the ordering is asserted here at import time and again by the
 * test suite rather than trusted to arithmetic.
 *
 * ── The 15-minute token used to be a guaranteed logout ────────────────────
 *
 * TOKEN_LIFETIME is 15 minutes and the client only re-issued the token when an
 * administrator pressed "Stay signed in" — which the UI only offers AFTER the
 * idle countdown runs out. An admin who was working continuously never saw the
 * modal, so nothing ever refreshed the token, and at 15 minutes they were
 * hard-logged-out mid-task by `exp`. The headroom above the idle window was
 * described here as "so an active admin is never logged out by token expiry
 * mid-task", which was simply not true: nothing re-issued the token.
 *
 * The fix is on the client (an automatic token renewal, AdminDashboard.jsx) and
 * it is only safe because of `countsAsActivity` below. A blind keepalive would
 * refresh the token forever AND, worse, refresh `lastActivityAt` forever — which
 * would disable the idle timeout entirely. Renewal and activity are deliberately
 * different operations, and only the client can tell them apart.
 */

/** Minutes of inactivity before an administrator is signed out. */
const ADMIN_IDLE_MINUTES = positiveInt(process.env.ADMIN_IDLE_MINUTES, 10);

/**
 * JWT lifetime. Deliberately LONGER than the idle window (15m vs 10m) so a
 * continuously working admin is never logged out by token expiry mid-task, even
 * if the client's renewal is slow or a request is in flight. The idle check
 * still ends the session after IDLE_LIMIT of silence, so this grants no extra
 * idle time — it only removes a cliff.
 */
const ADMIN_TOKEN_LIFETIME_MINUTES = positiveInt(process.env.ADMIN_TOKEN_LIFETIME_MINUTES, 15);

const ADMIN_IDLE_LIMIT_SECONDS = ADMIN_IDLE_MINUTES * 60;
const ADMIN_IDLE_TIMEOUT_MS = ADMIN_IDLE_LIMIT_SECONDS * 1000;
const ADMIN_TOKEN_LIFETIME_SECONDS = ADMIN_TOKEN_LIFETIME_MINUTES * 60;
const ADMIN_TOKEN_LIFETIME = `${ADMIN_TOKEN_LIFETIME_SECONDS}s`;

/**
 * How long before the idle limit the warning modal appears.
 *
 * 60s rather than the old 30s: on a ten-minute window a half-minute is not
 * enough time to finish a sentence, finish an approval, or decide whether to
 * stay signed in.
 */
const ADMIN_WARNING_SECONDS = 60;

/**
 * How often the server writes `lastActivityAt`. Purely a write-amplification
 * optimisation, and the middleware used to ignore it and write on EVERY admin
 * request — one database write per poll, per keystroke-triggered fetch, per
 * anything. The dashboard alone polls every 10 seconds.
 *
 * MUST stay below ADMIN_IDLE_TIMEOUT_MS. The trade is explicit and bounded: the
 * stored value can be up to HEARTBEAT_INTERVAL stale, so a session is really
 * ended after somewhere between IDLE_LIMIT and IDLE_LIMIT + HEARTBEAT_INTERVAL
 * of true silence. At a quarter of the window that is 10–12.5 minutes, which is
 * still "about ten minutes" and buys a 15× reduction in writes.
 */
const ADMIN_HEARTBEAT_INTERVAL_MS = (ADMIN_IDLE_LIMIT_SECONDS / 4) * 1000;

/**
 * Read a positive integer from the environment, or fall back.
 *
 * A bad value must not be able to weaken the policy. `ADMIN_IDLE_MINUTES=0`
 * would otherwise mean "no idle timeout at all" and `=999999` would mean "an
 * admin session that never ends" — both reachable by a stray space or a typo in
 * a deployment's config, and neither is something a config key should be able
 * to do. Anything that is not a positive integer in a sane range is reported
 * and ignored, so a typo produces a loud warning and the safe default.
 */
function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 1440) {
    console.warn(
      `[adminSession] ignoring an out-of-range value (${raw}) — expected an integer number of `
      + `minutes between 1 and 1440. Using ${fallback}.`,
    );
    return fallback;
  }
  return value;
}

/**
 * Fail loudly at import time rather than shipping a session policy that signs
 * out working administrators. A mis-ordered set of constants is a security/UX
 * bug that is invisible in review and maddening in use, so it is caught the
 * moment the module loads rather than by a support ticket.
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

/**
 * The instant an admin session is measured from, in epoch milliseconds.
 *
 * This exists because BOTH copies of the old idle check had the same shape:
 *
 *     if (admin.lastActivityAt && Date.now() - admin.lastActivityAt > IDLE) deny
 *
 * and that `&&` is a hole, not a guard. When `lastActivityAt` is null — a brand
 * new account, or one whose only sign-in never reached the write — the check is
 * SKIPPED ENTIRELY and the session is never idle-expired. The token's `exp` is
 * then the only thing bounding it, so the idle control silently does nothing
 * for exactly the accounts that have least history.
 *
 * The fallback is the token's own `iat`, which is the truth about how long ago
 * the credential was issued, and fails closed when it is missing or unparseable.
 */
function idleReferenceMs(admin, decoded) {
  const stamped = admin && admin.lastActivityAt ? new Date(admin.lastActivityAt).getTime() : NaN;
  if (Number.isFinite(stamped)) return stamped;
  const issued = decoded && decoded.iat ? decoded.iat * 1000 : NaN;
  if (Number.isFinite(issued)) return issued;
  // Nothing trustworthy to measure from. Refusing is the safe direction: an
  // unmeasurable session is not an unlimited one.
  return 0;
}

/**
 * Has this admin session been idle past the limit?
 *
 * THE single implementation. The middleware and POST /auth/admin-refresh both
 * call this, which is the point: when they were separate copies they drifted,
 * and both carried the same null-`lastActivityAt` hole.
 */
function idleExceeded(admin, decoded, now = Date.now()) {
  return now - idleReferenceMs(admin, decoded) > ADMIN_IDLE_TIMEOUT_MS;
}

/**
 * Does a client request count as ACTIVITY (i.e. may it slide the idle window)?
 *
 * A pure token renewal must answer NO. The client re-issues its token on a
 * timer, and if a renewal refreshed `lastActivityAt` the 10-minute idle timeout
 * would never fire for anyone — the timer would keep every session alive
 * forever. Renewal keeps the TOKEN fresh; only genuine use counts as activity
 * for the SESSION.
 *
 * The flag is only a hint, and the risk of trusting it is bounded by design: a
 * caller that lies and sends `renew: true` gets a token that is valid for
 * TOKEN_LIFETIME and nothing more. The idle check above still runs on every
 * request, including the renewal itself, and still reads the real
 * `lastActivityAt` — so lying buys at most one token's worth of extra access to
 * an endpoint they already hold a valid token for.
 */
function countsAsActivity(body) {
  const renew = body && (body.renew ?? body.tokenRenewal);
  return !(renew === true || renew === 'true' || renew === '1');
}

module.exports = {
  ADMIN_IDLE_MINUTES,
  ADMIN_IDLE_LIMIT_SECONDS,
  ADMIN_IDLE_TIMEOUT_MS,
  ADMIN_WARNING_SECONDS,
  ADMIN_TOKEN_LIFETIME,
  ADMIN_TOKEN_LIFETIME_MINUTES,
  ADMIN_TOKEN_LIFETIME_SECONDS,
  ADMIN_HEARTBEAT_INTERVAL_MS,
  idleReferenceMs,
  idleExceeded,
  countsAsActivity,
};
