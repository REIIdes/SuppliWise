/**
 * securityFactor — what the admin Users grid shows in the "2FA / Security" cell.
 *
 * The server already resolves this from real database state and sends it as
 * `user.security` (see server/utils/strongestFactor.js). That is authoritative
 * and is used whenever it is present.
 *
 * This local derivation exists for the cases where it is not: a row restored
 * from a stale cache, a partial payload, or a server response captured before
 * the field existed. Deriving rather than falling back to the old
 * `twoFactorEnabled ? ... : ...` means those paths render the same truth
 * instead of resurrecting the two lies this column used to tell —
 * "Google Authenticator active" for an account on email codes, and the same
 * again for an account holding passkeys but no authenticator app.
 */

export const SECURITY_METHODS = Object.freeze({
  PASSKEY: 'passkey',
  AUTHENTICATOR: 'authenticator',
  EMAIL: 'email',
  PASSWORD: 'password',
});

/** Mirrors strongestFactor() on the server: passkey > TOTP > email > password. */
export function securityMethod({ passkeyCount = 0, twoFactorEnabled = false, twoFactorMethod } = {}) {
  const count = Number(passkeyCount);
  if (Number.isFinite(count) && count > 0) return SECURITY_METHODS.PASSKEY;
  if (twoFactorEnabled === true) {
    return twoFactorMethod === 'email' ? SECURITY_METHODS.EMAIL : SECURITY_METHODS.AUTHENTICATOR;
  }
  return SECURITY_METHODS.PASSWORD;
}

const COPY = {
  [SECURITY_METHODS.PASSKEY]: (n) => (n === 1 ? '1 passkey active' : `${n} passkeys active`),
  [SECURITY_METHODS.AUTHENTICATOR]: () => 'Google Authenticator active',
  [SECURITY_METHODS.EMAIL]: () => 'Email OTP active',
  [SECURITY_METHODS.PASSWORD]: () => 'Password only',
};

const NOTES = {
  [SECURITY_METHODS.PASSKEY]: (n) => (n === 1
    ? 'Phishing-resistant — device-bound'
    : `Phishing-resistant — ${n} devices`),
  [SECURITY_METHODS.AUTHENTICATOR]: () => 'Second factor required at sign-in',
  // Same reasoning the user's own security page gives, in the admin's words:
  // email protects a stolen password but not a phisher who has the mailbox.
  [SECURITY_METHODS.EMAIL]: () => 'Weaker — stops a stolen password, not a phisher',
  [SECURITY_METHODS.PASSWORD]: () => 'No second factor on this account',
};

/**
 * @param {object} user  an admin users-grid row
 * @returns {{method: string, label: string, note: string, passkeyCount: number, strong: boolean}}
 */
export function securityFactor(user) {
  if (!user) {
    return { method: SECURITY_METHODS.PASSWORD, label: 'Password only', note: '', passkeyCount: 0, strong: false };
  }

  const count = Number(user.passkeyCount);
  const passkeyCount = Number.isFinite(count) && count > 0 ? count : 0;
  const method = securityMethod(user);

  // When the server sent a resolved `security` object, trust it for the label —
  // but keep the locally derived count if the server omitted it, so the count
  // and the label can never disagree.
  const serverLabel = typeof user.security?.label === 'string' ? user.security.label : null;
  const label = serverLabel || COPY[method](passkeyCount);

  return {
    method,
    label,
    note: NOTES[method](passkeyCount),
    passkeyCount,
    strong: method === SECURITY_METHODS.PASSKEY || method === SECURITY_METHODS.AUTHENTICATOR,
  };
}
