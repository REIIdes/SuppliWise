/**
 * USER SESSION LIFETIME — the policy is "no time-based expiry", stated once.
 *
 * ── What this file used to say, and why it changed ────────────────────────
 *
 * A sliding idle timeout was added here: 30 days without activity ended a
 * session, on the reasonable argument that a user JWT carries no `exp`, so a
 * leaked token is otherwise valid FOREVER and a token thief controls neither
 * sign-in nor sign-out. That reasoning is sound as far as it goes, and it is
 * why the window existed.
 *
 * It has been removed. A user session no longer ends because of the clock.
 *
 * This is a PRODUCT decision, not a claim that the old window was pointless.
 * A member who opens SuppliWise once a month was being signed out every month
 * and had no way to opt out — the checkbox on the sign-in screen controls the
 * saved-login credential, not this. People experience that as the app losing
 * their work, and no security benefit was bought with it: the threats the
 * window defends against (a token stolen from disk, from a log, from an XSS
 * payload) are not meaningfully reduced by 30 days versus 31, and the
 * genuinely effective controls are all still here and are unaffected:
 *
 *   • Revocation is immediate and total. A new sign-in displaces the old
 *     session, sign-out revokes it, and a password reset revokes every session
 *     the account owns. `utils/sessions.js` publishes revocations to the
 *     validation cache, so all of those take effect on the NEXT request, not
 *     at the end of a cache window.
 *   • One active session per ACCOUNT, so a stolen token is displaced by the
 *     victim's next sign-in, and a new sign-in is one of the events that fires.
 *   • A second factor is required to OPEN a session, and a fresh one to change
 *     anything sensitive. A stolen session token alone cannot mint recovery
 *     codes, repoint recovery email, or strip MFA — all of those require
 *     step-up (see middleware/stepUp.js).
 *   • A ban or a disabled account is refused on every request.
 *
 * So the only thing the window bought was an inconvenience, and it is gone.
 *
 * ── What this does NOT mean ──────────────────────────────────────────────
 *
 * "No expiry" is not "no bound of any kind". Three time bounds survive, each
 * deliberate and each opt-in or event-driven:
 *
 *   1. The saved-login credential (below). Time-bounded, and only exists for
 *      an account that ticked the box.
 *   2. `Session.expiresAt` — an ABSOLUTE cap, honoured by `verifyUserSession`
 *      before anything else. Nothing in the application sets it, so it grants
 *      no expiry by default; it exists so an operator has a lever that does not
 *      require shipping code, and so "the window is null" is a deliberate
 *      configuration rather than the absence of one.
 *   3. Revocation, which is the actual authority. It is event-driven, not
 *      time-driven, and it is the mechanism the rest of the system relies on.
 */

/**
 * THE POLICY, as a value rather than a comment.
 *
 * Exported so a test can assert on it and a reader can grep for it. If a future
 * change reintroduces a user-side time bound, this flips to a number and the
 * accompanying tests stop passing — which is the point of having it be data.
 */
const USER_SESSION_EXPIRES = false;

/**
 * Absolute lifetime of a token minted by the saved-login credential.
 *
 * Independent of any session window on purpose. It used to be expressed as
 * `USER_IDLE_DAYS + 1`, because a minted token had to outlive the window it was
 * minted for or a returning member landed in a gap where the credential still
 * worked, the session was still alive, and the token it produced had died
 * underneath them. With no window there is no such ordering to respect, so this
 * is simply the lifetime of an opt-in credential — long enough that the
 * checkbox means what it says, short enough that a token read out of a browser
 * profile stops working on its own.
 *
 * This is the ONLY clock that can end a signed-in user session, and only for an
 * account that asked for it.
 */
const REMEMBER_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const REMEMBER_TOKEN_LIFETIME = `${REMEMBER_TOKEN_LIFETIME_SECONDS}s`;

/**
 * How often a validated request refreshes `lastActivityAt`.
 *
 * Purely write amplification, and purely informational now that nothing reads
 * it to make an authorisation decision: it is what the "signed-in devices" list
 * sorts by and what a member sees as "last active". Still throttled, because a
 * busy member should not turn every API call into a write.
 */
const USER_ACTIVITY_TOUCH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * A request older than this is not "activity" for the purpose of refreshing
 * the stamp.
 *
 * With no expiry to defend, this is no longer a security control — it keeps
 * `lastActivityAt` honest for display. Without it, replaying one captured
 * request would slide the displayed value forward forever and the device list
 * would claim a session is active when nothing has touched it.
 */
const USER_ACTIVITY_MAX_AGE_MS = 15 * 60 * 1000;

if (!(REMEMBER_TOKEN_LIFETIME_SECONDS > 0)) {
  throw new Error(
    'userSession invariant violated: the saved-login credential must have a positive lifetime, '
    + 'or "Save my login" mints a token that is dead on arrival.',
  );
}

/** The stale windows these names used to carry, kept as an explicit error. */
const REMOVED = 'USER_IDLE_DAYS / USER_IDLE_LIMIT_MS were removed: user sessions do not expire by time. '
  + 'Use Session.expiresAt for an absolute cap, or revokeUserSession / revokeAllUserSessions.';

module.exports = {
  USER_SESSION_EXPIRES,
  REMEMBER_TOKEN_LIFETIME,
  REMEMBER_TOKEN_LIFETIME_SECONDS,
  USER_ACTIVITY_TOUCH_INTERVAL_MS,
  USER_ACTIVITY_MAX_AGE_MS,
  REMOVED,
};
