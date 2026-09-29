/**
 * USER SESSION LIFETIME — the policy, and the one invariant that keeps it honest.
 *
 * ── What changed, and why ──────────────────────────────────────────────────
 *
 * User sessions used to have NO time-based expiry at all. The JWT carried no
 * `exp`, `Session.expiresAt` was written as `null`, and `lastActivityAt` was
 * stamped but never read. Validity was purely revocation-based: a token stayed
 * good until the account signed in again (displacing it) or signed out.
 *
 * That is a defensible design and it was applied consistently — but it has one
 * sharp edge: a leaked token is valid FOREVER. Not "for a long time" — forever.
 * The only ways to kill it are a new sign-in, a sign-out, or a password reset,
 * none of which a token thief controls. Every other serious credential system
 * bounds this.
 *
 * So the session now has a SLIDING IDLE TIMEOUT: 30 days without activity ends
 * it. "Sliding" is what makes it free in practice — any use pushes the deadline
 * out, so a member who opens the app weekly is never affected, and only a
 * genuinely abandoned session ever ages out.
 *
 * ── Why 30 days and not something shorter ──────────────────────────────────
 *
 * This has to coexist with "Save my login on this browser". A member who ticks
 * that box expects to come back after a month or two without re-authenticating.
 * A 7-day window would silently break the feature the checkbox advertises, and
 * users experience that as the app logging them out for no reason. 30 days
 * bounds the leak while staying inside what people actually expect from a
 * "remember me".
 *
 * ── The invariant ──────────────────────────────────────────────────────────
 *
 *   IDLE_LIMIT < REMEMBER_TOKEN_LIFETIME
 *
 * The saved-login credential mints a fresh access token for the SAME session
 * (see mintFromRememberToken). If that minted token expired before the idle
 * window did, a returning member could be caught in the gap: the credential
 * was still valid, the session was still alive, and the token it produced died
 * underneath them — with no way to notice or recover except signing in again.
 *
 * The check is the same one adminSession.js applies, for the same reason: a
 * mis-ordered pair of constants is invisible in review and maddening in use, so
 * it is caught the moment the module loads rather than by a support ticket.
 */

/** Days of inactivity after which a user session ends. */
const USER_IDLE_DAYS = 30;
const USER_IDLE_LIMIT_MS = USER_IDLE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Absolute lifetime of a token minted by the saved-login credential.
 *
 * Deliberately longer than the idle window. A minted token is a convenience —
 * it saves the member re-typing a password — and must never be the thing that
 * logs them out. The idle window still ends genuinely abandoned sessions; this
 * only removes a cliff.
 *
 * It is expressed as idle + a day rather than as idle again. When the two were
 * the SAME number the invariant below (`idle < token`) was false by
 * construction, so the module threw on require and the server refused to start —
 * a self-inflicted outage from an arithmetic coincidence, not a real safety
 * check. A day of headroom is what the comment above always claimed.
 */
const REMEMBER_TOKEN_LIFETIME_SECONDS = (USER_IDLE_DAYS + 1) * 24 * 60 * 60;
const REMEMBER_TOKEN_LIFETIME = `${REMEMBER_TOKEN_LIFETIME_SECONDS}s`;

/**
 * How often a validated request refreshes `lastActivityAt`.
 *
 * Purely write amplification. It is NOT bounded by the idle window the way the
 * admin heartbeat is, because the window here is 30 days and this is minutes —
 * but it is still throttled so a busy member does not turn every API call into
 * a write.
 */
const USER_ACTIVITY_TOUCH_INTERVAL_MS = 15 * 60 * 1000;   // 15 minutes

/**
 * A minted token must outlive the window it is minted for, or a returning
 * member hits a gap they cannot see or fix.
 */
if (!(USER_IDLE_LIMIT_MS < REMEMBER_TOKEN_LIFETIME_SECONDS * 1000)) {
  throw new Error(
    'userSession invariant violated: a saved-login token must outlive the idle window, or a '
    + `returning member is signed out by a token that died first (idle ${USER_IDLE_LIMIT_MS}ms, `
    + `token ${REMEMBER_TOKEN_LIFETIME_SECONDS * 1000}ms).`,
  );
}

/**
 * A request older than this is not "activity" for the purpose of extending the
 * session. Without it, replaying one captured request would slide the deadline
 * out forever and make the timeout decorative.
 */
const USER_ACTIVITY_MAX_AGE_MS = 15 * 60 * 1000;

if (!(Number.isFinite(USER_IDLE_LIMIT_MS) && USER_IDLE_LIMIT_MS > 0)) {
  throw new Error('userSession invariant violated: the idle window must be a positive number.');
}

module.exports = {
  USER_IDLE_DAYS,
  USER_IDLE_LIMIT_MS,
  REMEMBER_TOKEN_LIFETIME,
  REMEMBER_TOKEN_LIFETIME_SECONDS,
  USER_ACTIVITY_TOUCH_INTERVAL_MS,
  USER_ACTIVITY_MAX_AGE_MS,
};
