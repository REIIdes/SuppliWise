/**
 * Security-event wording, split out of SessionActivity.jsx so it can be tested
 * directly. The component imports CSS and JSX, neither of which `node --test`
 * can load, so a table living inside it was untestable by construction — which
 * is how it fell out of step with the model in the first place.
 *
 * The rule this file exists to enforce: EVERY type in
 * server/models/SecurityEvent.js EVENT_TYPES has a label here. An unlabelled
 * event renders as the generic "Security event", which is exactly what happened
 * to all six passkey events — the lines a user most wants to read on the one
 * page built to tell them who has touched their credentials.
 *
 * `securityEventLabels.test.js` reads the model's source and asserts coverage,
 * so adding a type server-side without adding a label here fails the build.
 */

/**
 * One entry per EVENT_TYPES member.
 *
 * Wording is deliberately even-handed: a failed sign-in is recorded as a failed
 * sign-in. Nothing here claims an attack happened, because a wrong password is
 * not evidence of one — including 'suspicious-authentication', which is raised
 * when a signal is noticed, not when a conclusion is reached.
 */
export const EVENT_LABELS = {
  'login-success': 'Signed in',
  'unrecognized-login': 'Signed in from a new device',
  'login-failure': 'Failed sign-in',
  'mfa-success': 'Second factor accepted',
  'mfa-failure': 'Second factor rejected',
  'mfa-enabled': 'Two-factor enabled',
  'mfa-disabled': 'Two-factor disabled',
  'password-changed': 'Password changed',
  'password-change-failed': 'Incorrect password',
  'password-reset-requested': 'Password reset requested',
  'password-reset-code-verified': 'Reset code verified',
  'password-reset-completed': 'Password reset completed',
  'backup-codes-generated': 'Recovery codes created',
  'backup-codes-regenerated': 'Recovery codes replaced',
  'backup-codes-invalidated': 'Recovery codes invalidated',
  'backup-code-used': 'Recovery code used',
  'session-created': 'Session started',
  'session-revoked': 'Session revoked',
  'sessions-revoked-all': 'All other sessions signed out',
  'device-trust-revoked': 'Device removed',
  'recovery-email-changed': 'Recovery email changed',
  'account-locked': 'Sign-in temporarily paused',
  'email-changed': 'Email address changed',
  'reauth-succeeded': 'Identity re-confirmed',
  'reauth-failed': 'Identity re-confirmation failed',
  // ── Passkeys ───────────────────────────────────────────────────────────
  // "A passkey was removed" is the single most security-relevant line in this
  // list — it is what an attacker does to lock a victim out.
  'passkey-added': 'Passkey added',
  'passkey-removed': 'Passkey removed',
  'passkey-renamed': 'Passkey renamed',
  'passkey-used': 'Passkey used to sign in',
  'passkey-registration-failed': 'Passkey setup failed',
  'passkey-login-failed': 'Passkey sign-in failed',
  // ── Authenticator app ──────────────────────────────────────────────────
  'totp-setup-started': 'Authenticator setup started',
  'totp-enabled': 'Authenticator app connected',
  'totp-disabled': 'Authenticator app disconnected',
  'totp-failed': 'Incorrect authenticator code',
  'mfa-challenge-created': 'Second factor requested',
  'suspicious-authentication': 'Unusual sign-in details',
};

/**
 * Events worth drawing the eye to. Notable, not proven malicious.
 *
 * Every FAILURE is notable by construction — a failure is the signal — plus the
 * changes that alter who can get in or what a later recovery can rely on.
 */
export const NOTABLE = new Set([
  'unrecognized-login', 'account-locked', 'suspicious-authentication',
  'login-failure', 'mfa-failure', 'totp-failed', 'reauth-failed',
  'passkey-login-failed', 'passkey-registration-failed',
  'password-change-failed', 'password-reset-requested',
  'passkey-removed', 'passkey-added', 'passkey-renamed',
  'mfa-disabled', 'totp-disabled', 'recovery-email-changed', 'email-changed',
  'password-changed', 'backup-code-used',
]);

/**
 * Display label for an event, never undefined and never the raw enum string.
 * @param {string} type
 */
export function eventLabel(type) {
  return EVENT_LABELS[type] || 'Security event';
}
