/**
 * Deadline-based countdown for emailed verification codes.
 *
 * WHY THIS EXISTS
 * ---------------
 * The countdown used to be a counter decremented by an interval:
 *
 *     setOtpTimeLeft(prev => prev - 1)   // every 1000ms
 *
 * That shape has four failure modes, and this application hit all of them.
 *
 *   1. IT ACCUMULATES. The displayed value is a running total, not a fact about
 *      the clock. Every tick that does not fire — a throttled tab, a suspended
 *      laptop, a busy main thread, a dropped frame — is a second the timer never
 *      loses but real time does. Browsers clamp `setInterval` to roughly once a
 *      minute in a background tab, so a user who switches away for five minutes
 *      comes back to a timer reading 4:12 over a code that expired long ago.
 *
 *   2. IT STACKS. `startOtpExpiryTimer()` clears the previous interval using a
 *      value captured from the render that called it. Two calls before a re-render
 *      therefore clear nothing and leave two intervals running, and the countdown
 *      burns twice as fast. The shorter the window, the less anyone notices.
 *
 *   3. IT IS DESTROYED BY UNRELATED STATE. ProfilePage put `resendTimer` and
 *      `otpExpiryTimer` in a dependency array whose cleanup cleared both
 *      intervals. Changing the resend cooldown tore down the expiry countdown,
 *      which then froze mid-flight — the worst of both worlds, because the timer
 *      kept showing time remaining over a code the server had already expired.
 *
 *   4. IT GUESSES. The window was a literal in each file. The server decides when
 *      a code dies; a hardcoded client copy drifts from it the first time one side
 *      is edited, and nothing detects it.
 *
 * THE FIX
 * -------
 * Store an ABSOLUTE DEADLINE (epoch milliseconds) and derive the remaining time
 * from `Date.now()` on every tick. The value is then idempotent — the same
 * deadline and the same instant always produce the same answer, no matter how
 * many times it is computed or how many intervals exist. Stacking becomes
 * harmless, throttling self-corrects, and cleanup only has to stop the tick
 * because the tick can no longer corrupt anything.
 *
 * The window itself comes from the server (`expiresInSeconds`), so the client
 * renders the number the server will actually enforce.
 */

/**
 * The fallback window, used only when a server response predates this field.
 *
 * MUST match OTP_TTL_MS in server/routes/auth.js. utils/otpChallenge.js and the
 * email template carry the same number; the server response is what actually
 * drives the UI, so drift here is cosmetic rather than behavioural.
 */
export const OTP_TTL_SECONDS = 300;

/** Coerce anything into a positive whole number of seconds. */
function normalizeSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return OTP_TTL_SECONDS;
  return Math.floor(seconds);
}

/**
 * An absolute instant at which the code stops working.
 *
 * @param {number} [seconds] window length, e.g. the server's `expiresInSeconds`
 * @param {number} [now]     injectable clock, for tests
 * @returns {number} epoch milliseconds
 */
export function createDeadline(seconds = OTP_TTL_SECONDS, now = Date.now()) {
  return Number(now) + normalizeSeconds(seconds) * 1000;
}

/**
 * Seconds remaining, derived from the wall clock rather than accumulated.
 *
 * `Math.ceil` so the display shows 1 for the whole final second instead of
 * flashing 0 early and then staying at 0 — a countdown that reads 0:00 while
 * the code is still accepted is a countdown nobody trusts.
 *
 * @returns {number} 0 once the deadline has passed
 */
export function secondsLeft(deadline, now = Date.now()) {
  const target = Number(deadline);
  const current = Number(now);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return 0;
  if (target <= 0) return 0;
  return Math.max(0, Math.ceil((target - current) / 1000));
}

/** True once the deadline has passed. Idempotent, like `secondsLeft`. */
export function isExpired(deadline, now = Date.now()) {
  return secondsLeft(deadline, now) <= 0;
}

/**
 * "4:59" / "0:07" — the shape the OTP modals already render.
 *
 * Exported so both pages format identically; they had two private copies.
 */
export function formatCountdown(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Read the window out of a server response, falling back to the built-in
 * default.
 *
 * Guards against a response carrying `expiresInSeconds: 0`, a string, or
 * nothing at all — all of which would otherwise produce a deadline of "now",
 * i.e. a countdown that is already over the moment the modal opens.
 */
export function ttlFromResponse(body) {
  const raw = body && typeof body === 'object' ? body.expiresInSeconds : undefined;
  return normalizeSeconds(raw);
}