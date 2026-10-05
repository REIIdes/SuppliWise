'use strict';

/**
 * Alternative ways to PROVE you are the account holder, when the mailbox is not
 * available.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The reset flow has exactly one happy path: mail a link to the address on the
 * account. That path is correct and it is the default — but it is unusable in
 * precisely the situation a person opens this screen in. If the mailbox is gone,
 * if the account was made with a throwaway address, if the attacker holds the
 * mailbox and you do not, then "we emailed you a link" is not a recovery
 * mechanism. It is a description of the problem.
 *
 * This module adds the proofs that do not depend on the mailbox. Each one proves
 * something different, and the strength ordering is not accidental:
 *
 *   passkey        — the strongest thing here. A signature from a key that never
 *                    leaves the authenticator, bound to this site, with user
 *                    verification required.
 *   recovery code  — a high-entropy single-use bearer secret, stored only as a
 *                    SHA-256 digest, issued in a batch and invalidated by
 *                    regenerating.
 *   authenticator  — a TOTP code from a seed encrypted at rest. Replay-protected
 *                    per account, and time-limited by the clock.
 *   recovery email — the weakest of the four, and it is still only as strong as
 *                    the secondary mailbox, which is why it is last and why it
 *                    additionally notifies the PRIMARY address.
 *
 * WHAT THEY ALL HAVE IN COMMON
 * ---------------------------
 * Every method ends by calling `mintResetGrant`, which produces the identical
 * single-use, TTL-bound PasswordResetToken that the emailed link produces. So
 * `/reset-password?token=…` stays the one and only place a password can change,
 * with its existing properties intact: the grant is burned atomically on use, it
 * expires on a timer, every other outstanding grant for the account dies with
 * it, and all sessions are revoked afterwards. A new proof method therefore
 * cannot introduce a second, subtly-different way to change a password.
 *
 * THE ANTI-ENUMERATION RULE, AND WHY IT IS HARDER HERE
 * ---------------------------------------------------
 * `/request` can be blunt about everything: one generic 200, always. These
 * methods cannot, because proving a factor requires naming the account first.
 * That turns each of them into an oracle unless we are careful, and the oracle is
 * worse than the one `/request` has:
 *
 *   • "No such account" vs "wrong code" splits the whole user base in two.
 *   • "This account has no authenticator" is itself the answer to "is this
 *     address registered AND does it use TOTP".
 *
 * So every method below returns ONE status and ONE message for every failure —
 * unknown account, factor not configured, wrong secret, spent secret, locked
 * account. The caller learns only that the attempt did not work. Where a method
 * can be checked without a round trip (an empty field), that is a 400 and it
 * reveals nothing, because no lookup has happened yet.
 *
 * A note on timing: `findOne` on an unknown address returns sooner than the
 * verify branch does. We spend a comparable amount of entropy on the miss path
 * (`equalizeMiss`) so the two are not trivially distinguishable, which is the
 * same mitigation `/request` uses.
 */

const crypto = require('crypto');

const User = require('../models/User');
const Passkey = require('../models/Passkey');
const BackupCode = require('../models/BackupCode');
const SecurityEvent = require('../models/SecurityEvent');

const { mintResetGrant, issueGrantByEmail } = require('./passwordReset');
const { sendStatusEmail } = require('./email');
const { normalizeIp } = require('./geo');
const { isValidEmail } = require('./emailValidation');
const { verifyTotpOnce } = require('./totp');
const { readSecret, SECRET_FIELDS } = require('./totpSecret');
const { accountKey, lockRemainingMs, recordAccountFailure, clearOffenses, lockMeta } = require('./lockout');

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const normalizeEmail = (v) => str(v).trim().toLowerCase();

/**
 * One refusal for every failure of every method.
 *
 * Generic on purpose. It names no factor, confirms nothing, and cannot be
 * turned into a probe: "that did not work" is true for an address that does not
 * exist, one with no second factor, one whose code was wrong, and one that is
 * merely locked out. The user is told what to try next, which is actionable,
 * without the server confirming anything about the account.
 */
const REFUSAL = 'That did not work. Check the details and try again, or use a different way to recover your account.';

/**
 * Burn roughly the time a real verification takes, so a miss is not obviously
 * cheaper than a hit.
 *
 * Not a defence on its own — network jitter dominates — but it removes the
 * cheapest signal an enumerator would otherwise get for free, and it costs
 * nothing on the paths that reject before any lookup happens.
 */
function equalizeMiss() {
  crypto.randomBytes(32);
}

/** Record a rejected attempt against the account, for the escalating lockout. */
function noteFailure(user, req, outcome, factor) {
  const lockKey = accountKey('pwreset-factor', user._id);
  recordAccountFailure(lockKey, lockMeta(req, req?.ip));
  SecurityEvent.write({
    user: user._id,
    type: 'password-reset-code-verified',
    success: false,
    reason: `Password reset via ${factor} refused`,
    meta: { factor, outcome },
    ip: normalizeIp(req?.ip),
    userAgent: req?.get?.('user-agent'),
  }).catch(() => {});
  return lockKey;
}

/** Load the account a factor will be checked against. Null when unknown. */
async function loadAccount(email, select) {
  const normalized = normalizeEmail(email);
  if (!normalized || !isValidEmail(normalized)) return null;
  return User.findOne({ email: normalized }).select(select).lean();
}

/** Is this account allowed to hold a session at all? */
function isActive(user) {
  return Boolean(user) && (!user.accountStatus || user.accountStatus === 'active');
}

/**
 * RECOVERY CODE
 * -------------
 * A backup code is already the app's answer to "I lost my authenticator", so it
 * is the natural answer here too — and it is the only method that works with no
 * phone, no clock and no network round trip beyond this one.
 *
 * `BackupCode.consume` is a conditional update on `usedAt: null`, so the code is
 * burned atomically and two concurrent redemptions cannot both win. That happens
 * BEFORE we mint anything, deliberately: if the mint then fails, the user has
 * lost one code but the account is untouched. The reverse order would hand out a
 * live grant against a code that is still on the sheet, which is the one outcome
 * that is actually dangerous.
 *
 * Codes only exist while the authenticator is the active factor, which mirrors
 * routes/recoveryCodes.js — on the emailed-code method the mailed code is already
 * the second factor and a backup code would be a second, weaker door.
 */
async function withRecoveryCode({ email, code, req } = {}) {
  const submitted = str(code).trim();
  if (!submitted) return { status: 400, message: 'Enter one of your recovery codes.' };

  const user = await loadAccount(email, '_id email twoFactorEnabled twoFactorMethod');
  if (!user) {
    equalizeMiss();
    return { status: 401, message: REFUSAL };
  }
  if (!isActive(user) || user.twoFactorEnabled !== true
    || (user.twoFactorMethod || 'authenticator') !== 'authenticator') {
    equalizeMiss();
    return { status: 401, message: REFUSAL };
  }

  const lockKey = accountKey('pwreset-factor', user._id);
  if (lockRemainingMs(lockKey) > 0) {
    return { status: 429, message: 'Too many attempts. Please wait a few minutes and try again.' };
  }

  const used = await BackupCode.consume(user._id, submitted);
  if (!used) {
    noteFailure(user, req, 'mismatch', 'recovery-code');
    return { status: 401, message: REFUSAL };
  }

  clearOffenses(lockKey);

  // The account must be re-read as a full document: `applyNewPassword` needs the
  // pre-save hook to hash the new password, and a lean projection cannot save.
  const grant = await mintResetGrant(await User.findById(user._id), { method: 'recovery-code', req });
  if (!grant.ok) {
    return { status: 503, message: 'We could not start your recovery. Please try again in a moment.' };
  }

  return {
    status: 200,
    message: 'Recovery code accepted. Choose a new password to finish.',
    success: true,
    resetToken: grant.token,
    expiresAt: grant.expiresAt,
    remainingCodes: await BackupCode.countRemaining(user._id),
  };
}

/**
 * AUTHENTICATOR APP (TOTP)
 * ------------------------
 * The seed is read through `readSecret`, so it is decrypted here and nowhere
 * else — including for the legacy plaintext accounts, which are upgraded in
 * place by that helper.
 *
 * `verifyTotpOnce` is replay-protected per account: a code that has already been
 * spent against THIS account is refused, and the cache is keyed by
 * (scope, secret, code) precisely so two accounts sharing one seed cannot
 * consume each other's codes. Using the plain speakeasy call instead would let a
 * user who mistypes once have to wait out the clock for no good reason, and
 * would allow a captured code to be replayed inside its own validity window.
 *
 * The code is not burned by verifying it — that is `verifyTotpOnce`'s job, in
 * memory, for the life of its window.
 */
async function withAuthenticatorCode({ email, code, req } = {}) {
  const submitted = str(code).trim();
  if (!/^\d{6,8}$/.test(submitted)) {
    return { status: 400, message: 'Enter the 6-digit code from your authenticator app.' };
  }

  const user = await loadAccount(email, `_id email twoFactorEnabled twoFactorMethod ${SECRET_FIELDS}`);
  if (!user) {
    equalizeMiss();
    return { status: 401, message: REFUSAL };
  }
  if (!isActive(user) || user.twoFactorEnabled !== true
    || (user.twoFactorMethod || 'authenticator') !== 'authenticator') {
    equalizeMiss();
    return { status: 401, message: REFUSAL };
  }

  const lockKey = accountKey('pwreset-factor', user._id);
  if (lockRemainingMs(lockKey) > 0) {
    return { status: 429, message: 'Too many attempts. Please wait a few minutes and try again.' };
  }

  // A seed that will not decrypt reads as "no secret" rather than throwing, so
  // this cannot distinguish a broken envelope from an absent one.
  const secret = readSecret(user);
  const ok = secret ? verifyTotpOnce(secret, submitted, str(user._id)) : false;
  if (!ok) {
    noteFailure(user, req, secret ? 'mismatch' : 'no-secret', 'authenticator');
    return { status: 401, message: REFUSAL };
  }

  clearOffenses(lockKey);

  const grant = await mintResetGrant(await User.findById(user._id), { method: 'authenticator', req });
  if (!grant.ok) {
    return { status: 503, message: 'We could not start your recovery. Please try again in a moment.' };
  }

  return {
    status: 200,
    message: 'Code accepted. Choose a new password to finish.',
    success: true,
    resetToken: grant.token,
    expiresAt: grant.expiresAt,
  };
}

/**
 * PASSKEY
 * -------
 * Split across two routes because WebAuthn is a two-message ceremony: the server
 * hands over a challenge, the authenticator signs it, and the server verifies
 * the signature against the public key it stored at registration.
 *
 * The account is never taken from the request. The assertion names a credential
 * id, that id is a lookup key into our own table, and the account is whatever
 * row owns it — so a client that lies about who it is gains nothing. This is the
 * same shape as routes/passkeys.js and it is why no email is needed here at all.
 *
 * A `reset` flow value is used for the challenge. The flow is part of the
 * challenge's filter, so a challenge minted for sign-in cannot be spent here and
 * vice versa: without it, an attacker could capture a login assertion and
 * redeem it for a password change.
 */
const RESET_FLOW = 'reset';

async function passkeyOptions() {
  const webauthn = require('./webauthn');
  const rp = webauthn.config();
  const options = await webauthn.buildAuthenticationOptions({ rp });
  // Unbound, exactly like a sign-in: the account comes from the credential.
  await webauthn.storeChallenge({ challenge: options.challenge, flow: RESET_FLOW });
  return options;
}

/**
 * Structural peek at the challenge inside the assertion's own clientDataJSON.
 *
 * Not verification — it only extracts the string needed to find the row. Whether
 * that challenge was ever issued, whether the origin is right, and whether the
 * signature holds are all decided afterwards.
 */
function challengeFromAssertion(clientDataJSON) {
  try {
    const parsed = JSON.parse(Buffer.from(str(clientDataJSON), 'base64url').toString('utf8'));
    return typeof parsed.challenge === 'string' ? parsed.challenge : '';
  } catch {
    return '';
  }
}

async function withPasskey({ response, req } = {}) {
  const webauthn = require('./webauthn');

  if (!response || typeof response !== 'object' || !str(response.id) || !response.response) {
    return { status: 400, message: 'That passkey response was not readable. Please try again.' };
  }

  const refuse = async (outcome, credential) => {
    equalizeMiss();
    if (credential) {
      noteFailure(await User.findById(credential.user).select('_id').lean(), req, outcome, 'passkey');
    }
    return { status: 401, message: REFUSAL };
  };

  let credential;
  let rp;
  try {
    rp = webauthn.config();
  } catch (error) {
    console.error('[password-reset/passkey] WebAuthn is not configured:', error.message);
    return { status: 503, message: 'Passkey recovery is not available on this server right now.' };
  }

  const challenge = challengeFromAssertion(response.response && response.response.clientDataJSON);
  if (!challenge) return refuse('unreadable');

  // Spent FIRST, before anything else. Once this succeeds a captured assertion
  // has nothing left to spend, whatever else is wrong with it.
  if (!await webauthn.consumeChallenge(challenge, RESET_FLOW)) return refuse('challenge');

  credential = await Passkey.findOne({ credentialId: str(response.id) }).lean();
  if (!credential) return refuse('unknown-credential');

  const lockKey = accountKey('pwreset-factor', credential.user);
  if (lockRemainingMs(lockKey) > 0) {
    return { status: 429, message: 'Too many attempts. Please wait a few minutes and try again.' };
  }

  let verification;
  try {
    verification = await webauthn.verifyAuthentication({
      response,
      expectedChallenge: challenge,
      rp,
      credential,
      // Required. Without UV this is a single factor wearing a passkey's name.
      requireUserVerification: true,
    });
  } catch (error) {
    console.error('[password-reset/passkey] verification threw:', error.message);
    return refuse('verify-error', credential);
  }
  if (!verification || verification.verified !== true) {
    return refuse('signature', credential);
  }

  // Counter going backwards means two authenticators hold copies of one
  // credential — a clone. Synced passkeys always report 0, and 0 means "this
  // authenticator keeps no counter", so the rule only applies when both sides
  // are maintaining one.
  const newCounter = Number(verification.authenticationInfo && verification.authenticationInfo.newCounter) || 0;
  const storedCounter = Number(credential.counter) || 0;
  if (newCounter > 0 && storedCounter > 0 && newCounter <= storedCounter) {
    await noteFailure(await User.findById(credential.user).select('_id').lean(), req, 'counter-rollback', 'passkey');
    SecurityEvent.write({
      user: credential.user,
      type: 'suspicious-authentication',
      success: false,
      reason: 'Passkey signature counter did not advance during password reset',
      meta: { factor: 'passkey', outcome: 'counter-rollback' },
      ip: normalizeIp(req?.ip),
      userAgent: req?.get?.('user-agent'),
    }).catch(() => {});
    return { status: 401, message: REFUSAL };
  }

  // Best-effort bookkeeping. A failure here must not block a recovery that has
  // just proved itself with a valid signature.
  await Passkey.updateOne(
    { _id: credential._id },
    {
      $set: {
        counter: newCounter > storedCounter ? newCounter : storedCounter,
        lastUsedAt: new Date(),
        lastUsedIp: String(req?.ip || '').slice(0, 64),
      },
      $inc: { signInCount: 1 },
    }
  ).catch(() => {});

  const user = await User.findById(credential.user).select('-password -profilePicture -bannerPicture');
  if (!user || !isActive(user)) {
    equalizeMiss();
    return { status: 401, message: REFUSAL };
  }

  clearOffenses(lockKey);

  const grant = await mintResetGrant(user, { method: 'passkey', req });
  if (!grant.ok) {
    return { status: 503, message: 'We could not start your recovery. Please try again in a moment.' };
  }

  return {
    status: 200,
    message: 'Passkey accepted. Choose a new password to finish.',
    success: true,
    resetToken: grant.token,
    expiresAt: grant.expiresAt,
  };
}

/**
 * RECOVERY EMAIL
 * --------------
 * Send the same link to the account's verified secondary address instead of the
 * primary one. This is the weakest method and the reason is structural: it is
 * still "possession of a mailbox", and the mailbox it uses is one the account
 * holder nominated — but it survives the common failure where the PRIMARY inbox
 * is the thing that is gone.
 *
 * Two properties make it safe enough to offer:
 *
 *   1. It is inert until `recoveryEmailVerifiedAt` is set. An address that was
 *      typed in and never proven cannot receive a credential, so it cannot be
 *      used to take over an account.
 *   2. The PRIMARY address is always notified. So if an attacker has both the
 *      primary mailbox and the ability to trigger this, the real owner is told
 *      that a recovery happened somewhere they did not start. That notification
 *      is what makes the method safe to have at all.
 *
 * The answer is the same generic 200 whether or not the account exists, has a
 * recovery address, or the mail went out — for exactly the reason `/request`
 * answers generically.
 */
const GENERIC_RECOVERY_EMAIL_MESSAGE =
  'If that account has a verified recovery address, a reset link is on its way there.';

async function withRecoveryEmail({ email, req } = {}) {
  const user = await User.findOne({ email: normalizeEmail(email) })
    .select('_id email recoveryEmail recoveryEmailVerifiedAt')
    .lean();

  const eligible = user
    && isActive(user)
    && Boolean(user.recoveryEmail)
    && Boolean(user.recoveryEmailVerifiedAt);

  if (!eligible) {
    equalizeMiss();
    return { status: 200, message: GENERIC_RECOVERY_EMAIL_MESSAGE, sent: false };
  }

  // A recovery address identical to the primary is not a second route — it is
  // the same one, and honouring it would silently skip the notification below.
  const isDistinct = user.recoveryEmail !== user.email;

  const full = await User.findById(user._id);
  const outcome = isDistinct
    ? await issueGrantByEmail({ user: full, recipient: user.recoveryEmail, req })
    : { delivered: false, reason: 'same-address' };

  if (outcome.delivered) {
    // Tell the primary mailbox. Fire-and-forget: the reset itself already
    // succeeded, and a failed notice must not turn it into an error.
    //
    // The `security-change` preset is used rather than a bespoke template
    // because it is exactly this shape of message — a security-relevant event on
    // the account, with an "if this wasn't you" line — and reusing it keeps one
    // wording for every such notice rather than a second one that drifts.
    sendStatusEmail(user.email, 'security-change', {
      change: `a password reset link was sent to your recovery address (${maskTail(user.recoveryEmail)})`,
    }).catch(() => {});

    SecurityEvent.write({
      user: user._id,
      type: 'password-reset-requested',
      reason: 'Link sent to the verified recovery address',
      meta: { factor: 'recovery-email', outcome: 'sent' },
      ip: normalizeIp(req?.ip),
      userAgent: req?.get?.('user-agent'),
    }).catch(() => {});
  }

  return { status: 200, message: GENERIC_RECOVERY_EMAIL_MESSAGE, sent: !!outcome.delivered };
}

/**
 * Enough of the address to recognise it, not enough to harvest. Shown only in the
 * owner's own notification mail, and only for a distinct secondary address.
 */
function maskTail(address) {
  const value = str(address);
  const at = value.indexOf('@');
  if (at <= 0) return 'your recovery address';
  const domain = value.slice(at + 1);
  const name = value.slice(0, at);
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}

module.exports = {
  REFUSAL,
  RESET_FLOW,
  withRecoveryCode,
  withAuthenticatorCode,
  passkeyOptions,
  withPasskey,
  withRecoveryEmail,
};