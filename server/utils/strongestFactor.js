/**
 * strongestFactor — the ONE answer to "what is actually protecting this
 * account?", derived from real stored state.
 *
 * WHY THIS EXISTS
 * ---------------
 * The same question was being answered in three places with three different
 * sets of inputs, and they did not agree:
 *
 *   • GET /api/security/summary  — knew about passkeys.
 *   • GET /api/admin/users      — did not, and only had a boolean.
 *   • The admin Users grid       — rendered `twoFactorEnabled ? 'Google
 *     Authenticator active' : 'Email OTP active'`, which produced two lies:
 *       1. An account on `twoFactorMethod: 'email'` with 2FA on was reported
 *          as "Google Authenticator active".
 *       2. An account holding passkeys but no TOTP — holding the STRONGEST
 *          factor available — was reported as the weakest.
 *
 * A status badge that disagrees with the settings it summarises is worse than
 * no badge, so the computation lives here once and every caller reads real
 * database state rather than a flag a client sent or a value a browser cached.
 *
 * ORDERING (strongest first)
 * --------------------------
 *   passkey  — phishing-resistant, bound to the authenticator, no shared
 *              secret, and the only factor that survives a phishing page.
 *   TOTP     — a rotating 6-digit code. Stops a stolen password, not a phisher.
 *   email    — stops a stolen password. Not a factor at all if the attacker
 *              already has the mailbox.
 *   password — nothing by this measure.
 *
 * A passkey outranks TOTP because they protect DIFFERENT attacks: TOTP stops a
 * stolen password, a passkey stops a stolen password *and* a credential-phisher.
 * It is not a claim that a passkey "beats" TOTP at everything.
 *
 * NOTES
 * -----
 * • `passkeyCount` is a COUNT, never a boolean flag on the user document. A
 *   flag would go stale the moment the last passkey is deleted, and the badge
 *   would keep claiming protection the account no longer has.
 * • `twoFactorMethod` is only consulted when `twoFactorEnabled` is true, which
 *   mirrors the model: the field is documented as meaningless otherwise. An
 *   unknown value falls back to 'authenticator' so a future enum addition
 *   degrades to the stronger reading rather than silently claiming "password".
 */
const FACTORS = Object.freeze({
  PASSKEY: 'passkey',
  AUTHENTICATOR: 'authenticator',
  EMAIL: 'email',
  PASSWORD: 'password',
});

/**
 * @param {object} state
 * @param {number} state.passkeyCount        How many live credentials the account owns.
 * @param {boolean} state.twoFactorEnabled   Is a second factor required at sign-in?
 * @param {string} [state.twoFactorMethod]   'authenticator' | 'email'
 * @returns {'passkey'|'authenticator'|'email'|'password'}
 */
function strongestFactor({ passkeyCount = 0, twoFactorEnabled = false, twoFactorMethod } = {}) {
  // `Number()` because MongoDB aggregation returns Long/BigInt in some configs,
  // and `countDocuments` returns a Number. Only a real positive count counts —
  // 0, NaN, null and undefined all mean "no passkeys".
  const count = Number(passkeyCount);
  if (Number.isFinite(count) && count > 0) return FACTORS.PASSKEY;
  if (twoFactorEnabled === true) {
    return twoFactorMethod === 'email' ? FACTORS.EMAIL : FACTORS.AUTHENTICATOR;
  }
  return FACTORS.PASSWORD;
}

/**
 * Everything a UI needs to describe an account's factor, in one object.
 * `label` is plain English for display; the key stays the source of truth so
 * callers can still switch on it.
 *
 * @param {object} state  same shape as strongestFactor()'s argument
 */
function describeFactor(state) {
  const method = strongestFactor(state);
  const count = Number(state && state.passkeyCount);
  const passkeys = Number.isFinite(count) && count > 0 ? count : 0;

  switch (method) {
    case FACTORS.PASSKEY:
      return {
        method,
        passkeyCount: passkeys,
        label: passkeys === 1 ? '1 passkey active' : `${passkeys} passkeys active`,
        strong: true,
      };
    case FACTORS.AUTHENTICATOR:
      return { method, passkeyCount: passkeys, label: 'Google Authenticator active', strong: true };
    case FACTORS.EMAIL:
      return { method, passkeyCount: passkeys, label: 'Email OTP active', strong: false };
    default:
      return { method: FACTORS.PASSWORD, passkeyCount: passkeys, label: 'Password only', strong: false };
  }
}

module.exports = { FACTORS, strongestFactor, describeFactor };
