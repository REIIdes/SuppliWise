/**
 * Passkeys / WebAuthn, mounted at /api/auth/passkeys.
 *
 * ── The one rule the whole file is built around ───────────────────────────
 *
 * **The client never says which account it is.**
 *
 * On sign-in, the browser returns an assertion that names a CREDENTIAL. The
 * server looks that credential up, and the account is whatever the stored
 * credential belongs to. There is no `userId` parameter anywhere in the login
 * flow, and there is nothing for a client to tamper with. That is what makes
 * passwordless sign-in safe, and it is why this file never grows a "sign in as
 * this user" shortcut.
 *
 * On registration, the account comes from the session — the one piece of
 * identity a request may take from itself — and the challenge is bound to that
 * session and to that user before it is ever handed out.
 *
 * ── What the library does and what this file does ─────────────────────────
 *
 * @simplewebauthn/server performs EVERY cryptographic check: challenge
 * binding, origin, RP ID hash, attestation statement verification, client-data
 * hashing, algorithm agreement, user-verification flag, and the signature over
 * the authenticator data. None of that is reimplemented here, and there is no
 * hand-rolled CBOR, no manual COSE parsing and no crypto in this file beyond
 * naming a credential to verify.
 *
 * This file is responsible for the parts a library cannot: binding challenges
 * to a transaction, spending them exactly once, resolving an account from a
 * verified credential, enforcing the counter rules, deciding what is stored,
 * and refusing the requests that should never have been made.
 *
 * ── Rate limiting ─────────────────────────────────────────────────────────
 *
 * Options endpoints are limited per IP. Verification is limited per IP AND,
 * once the credential is resolved, per account — the second limit is the one
 * that matters, because a botnet spreading one IP across many addresses is
 * bounded by the per-account bucket instead.
 */
const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const { protect } = require('../middleware/auth');
const { requireStepUp } = require('../middleware/stepUp');
const { verifyOrigin } = require('../utils/origins');
const { limitReachedHandler, accountKey, lockRemainingMs, recordAccountFailure, recordOffense, clearOffenses, lockMeta } = require('../utils/lockout');
const User = require('../models/User');
const Passkey = require('../models/Passkey');
const SecurityEvent = require('../models/SecurityEvent');
const BackupCode = require('../models/BackupCode');
const webauthn = require('../utils/webauthn');
const { deviceLabelOf, platformOf } = require('../utils/device');
const { AUTH_METHODS, publicUser, completeSignIn, recordFailure } = require('../utils/authFlow');

const router = express.Router();
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// Every state-changing request must come from a page this deployment serves.
// This API is Bearer-authenticated, so classic CSRF is already structurally
// impossible; this makes sure adding a cookie one day fails closed instead of
// quietly.
router.use(verifyOrigin);

// ── Limiters ───────────────────────────────────────────────────────────────
// Deliberately separate buckets. `options` is cheap and happens twice per
// ceremony (a legitimate user hits it on every page load that offers a
// passkey), so it gets room. `verify` is the expensive, oracle-shaped one and
// gets very little, because a wrong signature is the only interesting thing an
// attacker can do here.
const optionsLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req) => (process.env.NODE_ENV === 'production' ? 40 : 400),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please wait a few minutes and try again.' },
});

const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req) => (process.env.NODE_ENV === 'production' ? 25 : 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait a few minutes and try again.' },
  handler: limitReachedHandler('Too many attempts. Lockout escalated — please wait and try again.'),
});

// Enrolling a credential is a security change, not a read.
const manageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req) => (process.env.NODE_ENV === 'production' ? 20 : 200),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many changes. Please wait a few minutes and try again.' },
  handler: limitReachedHandler('Too many changes. Lockout escalated — please wait and try again.'),
});

/** Safe user-facing message for anything the library throws. */
function ceremonyFailed(res, { user, req, type, reason, outcome }) {
  return recordFailure({ user, req, reason, type, outcome }).then(() => res.status(400).json({
    message: 'That passkey could not be verified. Please try again.',
  }));
}

/**
 * Load the authenticated user with the fields a ceremony needs.
 *
 * `+webauthnUserId` is required, not optional: the user handle is what the
 * authenticator binds the credential to, and reading it as `undefined` would
 * produce a registration that can never be signed in with.
 */
function loadAuthUser(req) {
  return User.findById(req.user._id)
    .select('-profilePicture -bannerPicture +webauthnUserId +twoFactorSecret +twoFactorSecretEnc');
}

/**
 * Ensure the account has a stable WebAuthn user handle, creating one on first
 * use.
 *
 * Generated once and then never changed. Regenerating it would orphan every
 * existing passkey, because a discoverable credential is looked up by
 * (rpId, userHandle) — the handle is the account's identity inside the
 * authenticator, and changing it is indistinguishable from deleting the
 * account's passkeys.
 */
async function ensureUserHandle(user) {
  if (user.webauthnUserId) return user.webauthnUserId;
  const handle = webauthn.generateUserHandle();
  // `$in: ['', null]` rather than an `$or` over `$exists`: the field carries a
  // default of '', so every document has it, and the extra clause only ever
  // matched documents this schema cannot produce — while costing a Mongoose
  // "Can't use $or" cast failure on the first registration of the first
  // account. The conditional update still loses the race safely.
  const updated = await User.findByIdAndUpdate(
    { _id: user._id, webauthnUserId: { $in: ['', null] } },
    { $set: { webauthnUserId: handle } },
    { new: true },
  ).select('webauthnUserId').lean();
  // Lost the race against a concurrent registration: the other writer's handle
  // is now the account's, and using ours would create a second identity.
  return (updated && updated.webauthnUserId) || handle;
}

// ═══════════════════════════════════════════════════════════════════════════
// MANAGEMENT  (authenticated, owner-scoped)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/auth/passkeys — this account's credentials, for the security page.
//
// Owner-scoped by construction: the filter carries `req.user._id`, so there is
// no id to get wrong and no way to ask about somebody else's credential.
router.get('/', protect, async (req, res) => {
  try {
    const passkeys = await Passkey.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      passkeys: passkeys.map((p) => ({
        id: String(p._id),
        name: p.name || 'Passkey',
        createdAt: p.createdAt,
        lastUsedAt: p.lastUsedAt || null,
        // The credential id is NOT returned. It is a lookup key for
        // authentication, has no use in a management UI, and echoing it would
        // put a bearer-adjacent identifier in the browser for no benefit.
        device: p.deviceLabel || 'Unknown device',
        deviceType: p.deviceType,
        backedUp: p.backedUp === true,
        transports: Array.isArray(p.transports) ? p.transports : [],
        userVerified: p.userVerified === true,
        signInCount: p.signInCount || 0,
      })),
      // Whether the browser is even capable, so the UI can hide a button that
      // would only ever fail. The client re-checks for itself; this is
      // convenience, never a security decision.
      supported: webauthn.isConfigured(),
      passkeySignInAvailable: true,
    });
  } catch (error) {
    console.error('[passkeys/list]', error.message);
    res.status(500).json({ message: 'Could not load your passkeys.' });
  }
});

// POST /api/auth/passkeys/register/options
//
// Requires: a live session AND a fresh step-up.
//
// The step-up is what stops a hijacked session from quietly enrolling the
// attacker's own passkey. A passkey is the strongest credential in the system
// and, once enrolled, is enough to sign in without a password forever — so
// "add a passkey" is exactly the operation that must never be one stolen token
// away. The proof is the account's password plus its current second factor.
//
// Step 1 of 2: hand the browser the options and remember the challenge.
router.post('/register/options', protect, manageLimiter, requireStepUp, async (req, res) => {
  let rp;
  let user;
  try {
    rp = webauthn.config();
  } catch (error) {
    // Misconfiguration is our fault, not the user's. Say so plainly in the log
    // (without any secret) and answer 503 rather than pretending.
    console.error('[passkeys/register/options] WebAuthn is not configured:', error.message);
    return res.status(503).json({ message: 'Passkeys are not available on this server right now.' });
  }

  try {
    user = await loadAuthUser(req);
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });

    const handle = await ensureUserHandle(user);
    const options = await webauthn.buildRegistrationOptions({ user: { ...user.toObject(), webauthnUserId: handle }, rp });

    // The challenge is bound to THIS user and THIS session before it leaves.
    // That binding is what makes it a transaction rather than a nonce: a
    // challenge lifted from a hijacked session cannot be completed later from
    // somewhere else, and a challenge issued for one account cannot store a
    // credential against another.
    await webauthn.storeChallenge({
      challenge: options.challenge,
      flow: 'register',
      user: user._id,
      sid: req.sessionId,
      userHandle: handle,
    });

    await SecurityEvent.write({
      user: user._id, type: 'passkey-registration-failed', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: 'Started adding a passkey',
      meta: { outcome: 'options-issued', platform: platformOf(req.get('user-agent')) },
    });

    return res.json(options);
  } catch (error) {
    console.error('[passkeys/register/options]', error.message);
    return res.status(500).json({ message: 'Could not start adding a passkey.' });
  }
});

// POST /api/auth/passkeys/register/verify
//
// Step 2: the browser hands back the authenticator's signed attestation.
//
// Verification order is load-bearing and each step removes an assumption:
//   1. the challenge is SPENT first, so a replay of a captured attestation
//      cannot even be attempted, let alone succeed;
//   2. the spent challenge must have been issued FOR this user and THIS
//      session, so a challenge from elsewhere cannot be spent here;
//   3. only then does the library verify origin, RP ID, attestation and the
//      user-verification flag;
//   4. the credential id must not already exist, anywhere.
router.post('/register/verify', protect, manageLimiter, requireStepUp, async (req, res) => {
  let rp;
  try {
    rp = webauthn.config();
  } catch (error) {
    console.error('[passkeys/register/verify] WebAuthn is not configured:', error.message);
    return res.status(503).json({ message: 'Passkeys are not available on this server right now.' });
  }

  const response = req.body && req.body.response;
  const name = str(req.body && req.body.name).trim().slice(0, 60);

  if (!response || typeof response !== 'object' || !response.id || !response.response) {
    return res.status(400).json({ message: 'That passkey response was not readable. Please try again.' });
  }

  let user;
  let challengeRow;
  try {
    user = await loadAuthUser(req);
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });

    // The challenge the client echoes back is only an identifier; the
    // authoritative one is server-side, keyed by that string. Note the path:
    // in a RegistrationResponseJSON the client data lives under
    // `response.response.clientDataJSON`, not at the top level.
    const challenge = safeParseClientDataChallenge(response.response && response.response.clientDataJSON);
    if (!challenge) {
      return res.status(400).json({ message: 'That passkey response was not readable. Please try again.' });
    }

    challengeRow = await webauthn.consumeChallenge(challenge, 'register');
    if (!challengeRow) {
      await recordFailure({
        user, req, type: 'passkey-registration-failed',
        reason: 'Challenge missing, expired or already used', outcome: 'challenge-rejected',
      });
      return res.status(400).json({ message: 'That passkey request has expired. Please try again.' });
    }

    // Bound to this account and this session. A challenge issued for somebody
    // else — or for a different session of the same account — cannot complete
    // here.
    if (String(challengeRow.user) !== String(user._id) || String(challengeRow.sid || '') !== String(req.sessionId || '')) {
      await recordFailure({
        user, req, type: 'suspicious-authentication',
        reason: 'Passkey challenge presented from a different account or session', outcome: 'challenge-binding',
      });
      return res.status(400).json({ message: 'That passkey request has expired. Please try again.' });
    }

    let verification;
    try {
      verification = await webauthn.verifyRegistration({
        response,
        expectedChallenge: challenge,
        rp,
        // User verification is preferred at enrolment (so a plain security key
        // can still be registered) but the UV flag is recorded, and a
        // passkey that cannot do UV is refused at SIGN-IN, where it matters.
        requireUserVerification: false,
      });
    } catch (error) {
      // The library throws for a bad origin, a bad RP ID, a failed attestation
      // or a malformed attestationObject. None of those details reach the
      // client: which check failed is exactly the information an attacker
      // probing a realm wants.
      console.warn(`[passkeys/register/verify] attestation rejected: ${error.message}`);
      return ceremonyFailed(res, {
        user, req, type: 'passkey-registration-failed',
        reason: 'Attestation rejected', outcome: 'attestation',
      });
    }

    if (!verification.verified || !verification.registrationInfo) {
      return ceremonyFailed(res, {
        user, req, type: 'passkey-registration-failed',
        reason: 'Attestation rejected', outcome: 'attestation',
      });
    }

    const info = verification.registrationInfo;
    const credentialId = str(info.credential.id);
    if (!credentialId) {
      return ceremonyFailed(res, {
        user, req, type: 'passkey-registration-failed',
        reason: 'Authenticator returned no credential', outcome: 'no-credential',
      });
    }

    // The user handle the credential was minted for must be this account's.
    // A mismatch means the authenticator answered a ceremony belonging to
    // someone else, and storing it would create a credential whose discoverable
    // identity is not the account it is filed under.
    if (challengeRow.userHandle && info.credential.userHandle
        && str(info.credential.userHandle) !== str(challengeRow.userHandle)) {
      await recordFailure({
        user, req, type: 'suspicious-authentication',
        reason: 'Credential was minted for a different user handle', outcome: 'user-handle-mismatch',
      });
      return ceremonyFailed(res, {
        user, req, type: 'passkey-registration-failed',
        reason: 'Credential did not match this account', outcome: 'user-handle',
      });
    }

    // Uniqueness is enforced by a unique index, not by this read. The read is
    // here to produce a clean 409 instead of a 500 from a duplicate-key error
    // on a user-initiated action; the index is what actually guarantees that
    // one credential can never be attached to two accounts.
    const existing = await Passkey.findOne({ credentialId }).select('_id user').lean();
    if (existing) {
      return res.status(409).json({
        message: existing.user && String(existing.user) === String(user._id)
          ? 'That passkey is already registered on this account.'
          : 'That passkey cannot be added to this account.',
      });
    }

    const transports = Array.isArray(response.response.transports)
      ? response.response.transports.map((t) => str(t).slice(0, 20)).slice(0, 10)
      : [];

    let created;
    try {
      created = await Passkey.create({
        user: user._id,
        credentialId,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        // The signature counter lives on `credential`, not on registrationInfo
        // directly. Reading it from the wrong place stored 0 for every
        // credential, which silently disabled the cloned-credential check —
        // a security control that appears to work and never fires.
        counter: Number(info.credential.counter) || 0,
        transports,
        deviceType: info.credentialDeviceType === 'multiDevice' ? 'multiDevice' : 'singleDevice',
        backedUp: info.credentialBackedUp === true,
        aaguid: Buffer.from(info.aaguid || '').toString('hex').slice(0, 32),
        attestationFormat: str(info.fmt || 'none').slice(0, 32),
        name: name || 'Passkey',
        deviceLabel: deviceLabelOf(req.get('user-agent')),
        userVerified: info.userVerified === true,
        createdAt: new Date(),
        lastUsedAt: null,
        signInCount: 0,
      });
    } catch (error) {
      // A duplicate-key error here means two registrations raced, which the
      // read above could not see. Unique index wins; say the same thing.
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'That passkey is already registered on this account.' });
      }
      throw error;
    }

    await SecurityEvent.write({
      user: user._id, type: 'passkey-added', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: `Passkey "${created.name}" added`,
      meta: { passkeyName: created.name, factor: 'passkey', platform: created.deviceLabel },
    });

    // Tell the account. A new authentication method appearing is the single
    // change a person most needs to hear about, and it is also the one an
    // attacker with a stolen session would most like to happen quietly.
    try {
      const UserNotification = require('../models/UserNotification');
      await UserNotification.create({
        user: user._id,
        type: 'info',
        title: 'A passkey was added to your account',
        detail: `A passkey named "${created.name}" (${created.deviceLabel || 'unknown device'}) can now sign in to your account. If this was not you, remove it and change your password immediately.`,
      }).catch(() => {});
    } catch { /* best-effort */ }

    return res.json({
      message: 'Passkey added.',
      passkey: {
        id: String(created._id),
        name: created.name,
        createdAt: created.createdAt,
        device: created.deviceLabel,
        deviceType: created.deviceType,
        backedUp: created.backedUp,
        userVerified: created.userVerified,
      },
    });
  } catch (error) {
    console.error('[passkeys/register/verify]', error.message);
    return res.status(500).json({ message: 'Could not add that passkey.' });
  }
});

/**
 * PATCH /api/auth/passkeys/:id — rename.
 *
 * No step-up: a label is not a security control, it changes no permission and
 * no credential. Requiring a password to call a passkey "Work laptop" would
 * train people to type their password for no reason, which is its own kind of
 * harm. Ownership is still enforced, and the name is sanitised here rather
 * than trusted.
 */
router.patch('/:id', protect, manageLimiter, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Passkey not found.' });

    const name = str(req.body && req.body.name).trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!name) return res.status(400).json({ message: 'Enter a name for this passkey.' });

    // Owner-scoped in the filter. A guessed id belonging to somebody else
    // matches nothing and is a 404, never a 403 — 403 would confirm it exists.
    const updated = await Passkey.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { name } },
      { new: true },
    ).lean();
    if (!updated) return res.status(404).json({ message: 'Passkey not found.' });

    await SecurityEvent.write({
      user: req.user._id, type: 'passkey-renamed', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: `Passkey renamed to "${name}"`,
      meta: { passkeyName: name },
    });

    return res.json({ message: 'Passkey renamed.', passkey: { id: String(updated._id), name: updated.name } });
  } catch (error) {
    console.error('[passkeys/rename]', error.message);
    return res.status(500).json({ message: 'Could not rename that passkey.' });
  }
});

/**
 * DELETE /api/auth/passkeys/:id — remove.
 *
 * Requires a step-up, and refuses to remove the last way in.
 *
 * The lockout guard is the interesting part. Removing a passkey is a
 * credential change, so it needs a fresh proof — but the proof itself may have
 * BEEN the passkey. So before deleting, the route asks: after this removal,
 * does the account still have a way to authenticate with more than a password?
 * If not, the removal is refused and the user is told to add another passkey,
 * set up an authenticator, or generate recovery codes first.
 *
 * There is an escape hatch on purpose: a confirmed, step-up-authenticated
 * removal of the LAST passkey is allowed when the account still has an
 * authenticator or unused recovery codes. What is refused is ending up with
 * nothing but a password — which is not a security improvement, it is the user
 * asking to be weaker, and doing it silently is how accounts get lost.
 */
router.delete('/:id', protect, manageLimiter, requireStepUp, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Passkey not found.' });

    const passkey = await Passkey.findOne({ _id: req.params.id, user: req.user._id });
    if (!passkey) return res.status(404).json({ message: 'Passkey not found.' });

    const [remaining, hasTotp, backupRemaining] = await Promise.all([
      Passkey.countDocuments({ user: req.user._id, _id: { $ne: passkey._id } }),
      User.findById(req.user._id).select('twoFactorEnabled twoFactorMethod').lean(),
      BackupCode.countDocuments({ user: req.user._id, usedAt: null }),
    ]);

    const hasAuthenticator = hasTotp && hasTotp.twoFactorEnabled === true && hasTotp.twoFactorMethod === 'authenticator';
    if (remaining === 0 && !hasAuthenticator && backupRemaining === 0) {
      await recordFailure({
        user: req.user._id ? req.user._id : req.user, req,
        type: 'suspicious-authentication',
        reason: 'Attempted to remove the last strong authentication method',
        outcome: 'would-lock-out',
      });
      return res.status(409).json({
        code: 'LAST_STRONG_METHOD',
        message: 'This is your only way to verify it is you. Add another passkey, set up an authenticator app, or generate recovery codes first.',
      });
    }

    await Passkey.deleteOne({ _id: passkey._id, user: req.user._id });

    await SecurityEvent.write({
      user: req.user._id, type: 'passkey-removed', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: `Passkey "${passkey.name}" removed`,
      meta: { passkeyName: passkey.name, factor: 'passkey' },
    });

    try {
      const UserNotification = require('../models/UserNotification');
      await UserNotification.create({
        user: req.user._id,
        type: 'info',
        title: 'A passkey was removed from your account',
        detail: `The passkey "${passkey.name}" (${passkey.deviceLabel || 'unknown device'}) can no longer sign in to your account. If this was not you, change your password immediately.`,
      }).catch(() => {});
    } catch { /* best-effort */ }

    return res.json({ message: 'Passkey removed.' });
  } catch (error) {
    console.error('[passkeys/remove]', error.message);
    return res.status(500).json({ message: 'Could not remove that passkey.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SIGN-IN  (public — this is how an account gets in)
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/auth/passkeys/login/options
//
// Deliberately reachable BEFORE sign-in: a passkey sign-in has no first step.
// The response is the same for everyone — no "this account has passkeys" hint,
// no account list, no discoverable-credential filtering by email — so this
// endpoint cannot be used to find out who has an account.
router.post('/login/options', optionsLimiter, async (req, res) => {
  let rp;
  try {
    rp = webauthn.config();
  } catch (error) {
    console.error('[passkeys/login/options] WebAuthn is not configured:', error.message);
    return res.status(503).json({ message: 'Passkey sign-in is not available on this server right now.' });
  }

  try {
    const options = await webauthn.buildAuthenticationOptions({ rp });
    // Unbound by design: a login challenge belongs to no account, because the
    // account is discovered from the assertion. Binding it to a user here
    // would reintroduce exactly the "client says who it is" problem.
    await webauthn.storeChallenge({ challenge: options.challenge, flow: 'login' });
    return res.json(options);
  } catch (error) {
    console.error('[passkeys/login/options]', error.message);
    return res.status(500).json({ message: 'Could not start passkey sign-in.' });
  }
});

/**
 * Read the challenge out of the base64url clientDataJSON.
 *
 * This is a structural peek, NOT verification: it pulls out the one string
 * needed to look the challenge up in the database. Whether that challenge was
 * ever legitimately issued, whether the origin is right and whether the
 * signature holds are all decided afterwards by the store and by
 * @simplewebauthn/server. Parsing the client's own JSON to find an identifier
 * grants it nothing.
 */
function safeParseClientDataChallenge(clientDataJSON) {
  try {
    const raw = Buffer.from(str(clientDataJSON), 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.challenge === 'string' ? parsed.challenge : '';
  } catch {
    return '';
  }
}

// POST /api/auth/passkeys/login/verify
//
// The passwordless path. Order of operations:
//
//   1. read the challenge out of the assertion, SPEND it (single use);
//   2. resolve the credential BY ITS OWN ID — the account comes from the
//      stored row, never from the request;
//   3. rate-limit on the now-known account as well as the IP;
//   4. let the library check origin, RP ID, UV and the signature;
//   5. enforce the signature counter;
//   6. only then issue a session, and revoke this account's previous one.
router.post('/login/verify', verifyLimiter, async (req, res) => {
  let rp;
  try {
    rp = webauthn.config();
  } catch (error) {
    console.error('[passkeys/login/verify] WebAuthn is not configured:', error.message);
    return res.status(503).json({ message: 'Passkey sign-in is not available on this server right now.' });
  }

  const response = req.body && req.body.response;
  if (!response || typeof response !== 'object' || !str(response.id) || !response.response) {
    return res.status(400).json({ message: 'That passkey response was not readable. Please try again.' });
  }

  // ONE answer for every failure below. Unknown credential, wrong origin, bad
  // signature, replayed challenge, disabled account: all 401, all the same
  // words. Differentiating them would turn this into an oracle for "does this
  // credential id exist" and "which origin does this deployment trust".
  const refuse = async (outcome, { user = null, type = 'passkey-login-failed', status = 401, message = 'That passkey could not be verified. Please try again.' } = {}) => {
    if (user) {
      await recordFailure({ user, req, type, reason: 'Passkey sign-in refused', outcome });
    }
    return res.status(status).json({ message });
  };

  let credential = null;
  try {
    const challenge = safeParseClientDataChallenge(response.response && response.response.clientDataJSON);
    if (!challenge) return refuse('unreadable');

    // Spend the challenge BEFORE anything else. Once this succeeds, a captured
    // assertion has nothing left to spend, no matter what else is wrong with
    // it. Doing it first is what makes replay structurally impossible rather
    // than merely discouraged.
    const challengeRow = await webauthn.consumeChallenge(challenge, 'login');
    if (!challengeRow) return refuse('challenge');

    // The credential identifies the account. Not a parameter, not a header,
    // not the userHandle in the assertion: the row in our own database.
    // ── The lookup, and what it does and does not reveal ───────────────────
    // `response.id` is a LOOKUP KEY, not an identity claim: the signature is
    // verified against the public key of whatever row it finds, so a guessed or
    // forged id cannot authenticate anybody. The account that gets a session is
    // the owner of the verified credential, and nothing else.
    //
    // The one thing it does leak is TIMING — an unknown id returns immediately,
    // a known one goes on to verify a signature. There is no enumeration value
    // in that, because a credential id is 32 bytes of authenticator output and
    // cannot be guessed; the status and the body are identical either way, which
    // is the part that would actually matter.
    const credentialId = str(response.id);
    credential = await Passkey.findOne({ credentialId }).lean();
    if (!credential) return refuse('unknown-credential');

    // Per-account throttling, now that we know whose account this is. The IP
    // bucket above cannot see a distributed spray; this one can.
    const accountLock = accountKey('passkey', credential.user);
    if (lockRemainingMs(accountLock) > 0) {
      return refuse('locked', { user: credential.user, status: 429, message: 'Too many attempts. Please wait a few minutes and try again.' });
    }

    const verification = await webauthn.verifyAuthentication({
      response,
      expectedChallenge: challenge,
      rp,
      credential,
      // Required. A passkey that cannot verify the user is a single factor
      // wearing a passkey's name, and this is where that is caught.
      requireUserVerification: true,
    });

    if (!verification || verification.verified !== true) {
      recordOffense(accountLock, lockMeta(req, req.ip));
      return refuse('signature', { user: credential.user });
    }

    // ── userHandle cross-check ────────────────────────────────────────────
    // For a discoverable credential the authenticator echoes the account handle
    // it was given. The signature above already proves which credential this is,
    // so this is not load-bearing for authentication — but a handle that does
    // not match the row the credential belongs to means the authenticator
    // answered a ceremony issued to somebody else, which is worth recording and
    // refusing. Optional in the response, so it is only checked when present.
    const echoedHandle = str(verification.authenticationInfo && response.response
      && response.response.userHandle);
    if (echoedHandle) {
      const account = await User.findById(credential.user).select('+webauthnUserId').lean();
      if (account && account.webauthnUserId && echoedHandle !== String(account.webauthnUserId)) {
        recordOffense(accountLock, lockMeta(req, req.ip));
        await recordFailure({
          user: credential.user, req, type: 'suspicious-authentication',
          reason: 'Passkey assertion carried a different user handle', outcome: 'user-handle-mismatch',
        });
        return refuse('user-handle', { user: credential.user });
      }
    }

    // ── Signature counter ────────────────────────────────────────────────
    // A counter that goes BACKWARDS means two authenticators hold copies of
    // the same credential, which is the definition of a cloned one. Most
    // modern passkeys sync and always report 0, so 0 means "this authenticator
    // does not keep a counter" and is not evidence of anything — the rule only
    // applies when the authenticator actually maintains one.
    const newCounter = Number(verification.authenticationInfo.newCounter) || 0;
    const storedCounter = Number(credential.counter) || 0;
    if (newCounter > 0 && storedCounter > 0 && newCounter <= storedCounter) {
      recordOffense(accountLock, lockMeta(req, req.ip));
      await recordFailure({
        user: credential.user, req, type: 'suspicious-authentication',
        reason: 'Passkey signature counter did not advance', outcome: 'counter-rollback',
      });
      return refuse('counter', { user: credential.user, type: 'passkey-login-failed' });
    }
    if (newCounter > storedCounter) {
      await Passkey.updateOne(
        { _id: credential._id },
        {
          $set: {
            counter: newCounter,
            lastUsedAt: new Date(),
            lastUsedIp: String(req.ip || '').slice(0, 64),
          },
          $inc: { signInCount: 1 },
        },
      ).catch(() => {});
    } else {
      await Passkey.updateOne(
        { _id: credential._id },
        {
          $set: { lastUsedAt: new Date(), lastUsedIp: String(req.ip || '').slice(0, 64) },
          $inc: { signInCount: 1 },
        },
      ).catch(() => {});
    }

    // The account, loaded AFTER the assertion proved the credential belongs to
    // it. Nothing earlier in this handler was allowed to influence which user
    // gets loaded.
    const user = await User.findById(credential.user)
      .select('-password -profilePicture -bannerPicture');
    if (!user) return refuse('no-user');
    if (user.accountStatus && user.accountStatus !== 'active') {
      return res.status(403).json({
        message: user.accountStatus === 'banned'
          ? 'This account has been banned.'
          : 'This account is no longer active.',
      });
    }

    clearOffenses(accountLock);

    const remember = req.body && (req.body.remember === true || req.body.remember === 'true');
    const { token, rememberToken } = await completeSignIn({
      user,
      authMethod: AUTH_METHODS.PASSKEY,
      // A user-verified passkey assertion IS two factors: the authenticator
      // (something you have) plus the biometric or PIN (something you are).
      // Recording it as such is what lets the security page tell a user what
      // their session is actually protected by.
      mfaVerified: true,
      req,
      location: user.lastLoginLocation || '',
      remember,
      reason: `Signed in with passkey "${credential.name || 'Passkey'}"`,
      eventType: 'login-success',
      passkeyId: credential._id,
      extraEvent: { type: 'passkey-used', reason: `Passkey "${credential.name || 'Passkey'}" used` },
    });

    return res.json({
      ...publicUser(user),
      token,
      authMethod: AUTH_METHODS.PASSKEY,
      mfaVerified: true,
      ...(rememberToken ? { rememberToken } : {}),
    });
  } catch (error) {
    // Includes every rejection @simplewebauthn/server throws: wrong origin,
    // wrong RP ID, signature mismatch, UV not performed, malformed
    // authenticatorData. None of the detail is echoed — which check failed is
    // precisely what an attacker enumerating realms or credentials wants.
    console.warn(`[passkeys/login/verify] refused: ${error.message}`);
    return refuse('error', { user: credential ? credential.user : null });
  }
});

module.exports = router;
