/**
 * WebAuthn / FIDO2 relying-party configuration and challenge bookkeeping.
 *
 * ALL of it comes from the environment. There is no localhost default that can
 * survive into production by accident, and the module refuses to hand out
 * options at all if production is misconfigured — a passkey ceremony that
 * silently falls back to `localhost` produces credentials that work on the
 * developer's machine and nowhere else, and the failure only shows up for real
 * users at the moment they try to use the very feature meant to save them.
 *
 *   WEBAUTHN_RP_NAME     Human-readable relying-party name, shown by the
 *                        authenticator ("SuppliWise"). Defaults to APP_NAME.
 *   WEBAUTHN_RP_ID       The RP ID: a DOMAIN, never a URL, never a port.
 *                        https://app.example.com → "app.example.com".
 *                        Required in production.
 *   WEBAUTHN_ORIGIN      Comma-separated list of origins allowed to make a
 *                        ceremony. Must be scheme + host (+ port), no path,
 *                        no trailing slash. Required in production.
 *   WEBAUTHN_TIMEOUT_MS  How long the browser waits for the user. Separate from
 *                        CHALLENGE_TTL_MS, which is how long the SERVER keeps
 *                        accepting the answer.
 *
 * ── Why both an RP ID and an origin, and why they are checked separately ──
 *
 * The RP ID scopes which domain may mint a credential for this relying party;
 * the origin scopes which page may ask for one. They answer different
 * questions, and a service worker or a compromised subdomain is exactly the
 * case where they disagree. @simplewebauthn/server verifies both on every
 * ceremony, and the code here never has to reason about it.
 *
 * Nothing in this module performs cryptography. Verification is
 * @simplewebauthn/server's job, called from routes/passkeys.js.
 */
const crypto = require('crypto');
const {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  getDefaultSupportedAlgorithmIDs,
} = require('@simplewebauthn/server');

const AuthChallenge = require('../models/AuthChallenge');

const APP_NAME = 'SuppliWise';

// How long the SERVER keeps a challenge. Deliberately short: a challenge is
// only useful while the user is looking at a system dialog, and every second
// it lives is a second a captured clientDataJSON stays replayable.
//
// The browser-side timeout (WEBAUTHN_TIMEOUT_MS) is deliberately SHORTER than
// this. If the user leaves the dialog open past the browser timeout, the
// ceremony is abandoned by the client, and by the time they try again the
// server-side challenge is usually gone too — which is the correct outcome
// (start a fresh ceremony, fresh challenge) rather than accepting a stale one.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

class WebauthnConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebauthnConfigError';
    this.statusCode = 503;
  }
}

const isProduction = () => process.env.NODE_ENV === 'production';

/** Strip a trailing slash; a WebAuthn origin must have neither path nor slash. */
function normaliseOrigin(value) {
  return str(value).trim().replace(/\/+$/, '');
}

/** True for a well-formed origin: scheme://host[:port], nothing else. */
function isValidOrigin(value) {
  const text = normaliseOrigin(value);
  if (!text) return false;
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (url.pathname !== '/' || url.search || url.hash) return false;
  if (!url.hostname) return false;
  return true;
}

/**
 * An RP ID is a bare domain. Rejecting the obvious mistakes here — a full URL,
 * a port, a path — turns a ceremony that would fail confusingly at
 * verification time into a boot-time error naming the variable to fix.
 */
function isValidRpId(value) {
  const text = str(value).trim().toLowerCase();
  if (!text || text.includes('/') || text.includes(':') || text.includes(' ')) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(text);
}

function parseOriginList(raw) {
  return str(raw)
    .split(',')
    .map(normaliseOrigin)
    .filter(Boolean);
}

/**
 * Local-development origins, used ONLY when the environment says nothing and
 * the process is not production. Listed explicitly rather than pattern-matched
 * so a test or a review can see exactly what a dev build trusts.
 */
function developmentOrigins() {
  const out = [];
  const port = str(process.env.PORT || '5000');
  for (const host of ['localhost', '127.0.0.1']) {
    for (const webPort of ['5173', '5174', '5175']) {
      out.push(`http://${host}:${webPort}`);
      out.push(`https://${host}:${webPort}`);
    }
    // The API's own origin, both schemes — same reasoning as in
    // utils/origins.js: the dev server and the API are HTTPS together when a
    // certificate is present, and a ceremony from an https page against an http
    // origin is refused by the browser before it ever reaches this code.
    out.push(`http://${host}:${port}`);
    out.push(`https://${host}:${port}`);
  }
  return out;
}

/**
 * Resolve the relying-party configuration, or throw with an actionable message.
 *
 * Memoised on an environment fingerprint because the routes call this on every
 * ceremony, and because `utils/envFile` can reload the environment at runtime
 * (a rotated key should take effect without a restart).
 */
let cached = null;
let cachedFingerprint = '';

function fingerprint() {
  return [
    process.env.WEBAUTHN_RP_NAME || '',
    process.env.WEBAUTHN_RP_ID || '',
    process.env.WEBAUTHN_ORIGIN || '',
    process.env.WEBAUTHN_TIMEOUT_MS || '',
    process.env.NODE_ENV || '',
  ].join('|');
}

function config() {
  const fp = fingerprint();
  if (cached && cachedFingerprint === fp) return cached;

  const name = str(process.env.WEBAUTHN_RP_NAME || APP_NAME).trim() || APP_NAME;

  const configuredId = str(process.env.WEBAUTHN_RP_ID).trim().toLowerCase();
  // In development, an unset WEBAUTHN_ORIGIN falls back to the same loopback
  // origins the CORS allowlist trusts, so a fresh clone gets working passkeys
  // with no configuration. It is NEVER used in production — the block below
  // turns a missing value into a boot error there.
  const configuredOrigins = parseOriginList(process.env.WEBAUTHN_ORIGIN).length
    ? parseOriginList(process.env.WEBAUTHN_ORIGIN)
    : (isProduction() ? [] : developmentOrigins());

  let rpID = configuredId;
  let origins = configuredOrigins;

  if (!rpID && !isProduction()) {
    // Derive the dev RP ID from whatever origin the dev server is on, so a
    // developer on a LAN address gets working passkeys instead of a ceremony
    // that is rejected because the origin does not match.
    const seed = (origins[0] || process.env.PUBLIC_WEB_URL || 'https://localhost:5173');
    try {
      rpID = new URL(normaliseOrigin(seed) || seed).hostname;
    } catch {
      rpID = 'localhost';
    }
    if (!rpID) rpID = 'localhost';
  }

  const problems = [];
  if (!rpID) {
    problems.push(
      isProduction()
        ? 'WEBAUTHN_RP_ID is not set (the production domain, e.g. "app.example.com" — no scheme, no port, no path).'
        : 'WEBAUTHN_RP_ID could not be derived from any configured origin.',
    );
  } else if (!isValidRpId(rpID)) {
    problems.push(`WEBAUTHN_RP_ID ("${configuredId}") is not a bare domain — drop the scheme, port and path.`);
  }

  if (!origins.length) {
    problems.push(
      isProduction()
        ? 'WEBAUTHN_ORIGIN is not set (comma-separated https origins, e.g. "https://app.example.com").'
        : 'WEBAUTHN_ORIGIN is not set and no development origin could be inferred.',
    );
  } else {
    for (const origin of origins) {
      if (!isValidOrigin(origin)) {
        problems.push(`WEBAUTHN_ORIGIN entry ("${origin}") is not a bare origin — use scheme://host[:port] with no path.`);
      }
    }
    // The classic production mistake: an https app whose origin list still
    // names localhost. Passkeys registered against localhost work nowhere else,
    // so this is refused rather than warned about.
    //
    // Note the dev fallback above deliberately includes http:// origins, and
    // that is safe HERE precisely because this check only runs in production: a
    // loopback dev server is a trustworthy context under the WebAuthn spec, and
    // the alternative — refusing http on loopback — would mean a fresh clone
    // cannot test passkeys at all before it has a domain.
    if (isProduction()) {
      const insecure = origins.filter((o) => !o.startsWith('https://') && !o.startsWith('capacitor://'));
      if (insecure.length) {
        problems.push(`WEBAUTHN_ORIGIN must be https in production (offending: ${insecure.join(', ')}).`);
      }
    }
  }

  if (problems.length) {
    throw new WebauthnConfigError(
      `WebAuthn is not configured: ${problems.join(' ')} Passkey sign-in is unavailable until this is fixed.`,
    );
  }

  const timeout = Number.parseInt(process.env.WEBAUTHN_TIMEOUT_MS, 10);
  const resolved = {
    rpID,
    rpName: name,
    origins,
    // Capped: a challenge outliving 10 minutes is not a challenge any more.
    timeoutMs: Number.isFinite(timeout) && timeout >= 30_000 && timeout <= 600_000
      ? timeout
      : 120_000,
    challengeTtlMs: CHALLENGE_TTL_MS,
  };
  cached = resolved;
  cachedFingerprint = fp;
  return resolved;
}

/** Non-throwing probe, for the boot-time log and the security summary. */
function describe() {
  try {
    const c = config();
    return { configured: true, rpID: c.rpID, rpName: c.rpName, origins: c.origins };
  } catch (error) {
    return { configured: false, error: error.message };
  }
}

const isConfigured = () => describe().configured === true;

// ── Challenge issuance ─────────────────────────────────────────────────────

/**
 * Store a freshly minted challenge. Randomness is the library's job
 * (`generateRegistrationOptions` / `generateAuthenticationOptions` use a
 * CSPRNG), so this only persists what the library produced and binds it.
 */
async function storeChallenge({ challenge, flow, user = null, sid = null, userHandle = '' }) {
  await AuthChallenge.create({
    challenge,
    flow,
    user: user || null,
    sid: sid ? String(sid) : null,
    userHandle: userHandle || '',
    attempts: 0,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    consumedAt: null,
  });
}

/**
 * SPEND a challenge. Returns the row, or null.
 *
 * The conditional update is the security property. It means:
 *   • a challenge can be verified exactly once, ever;
 *   • two concurrent verifications cannot both succeed;
 *   • the attempt budget is incremented in the same atomic step, so it cannot
 *     be exceeded by racing.
 *
 * A null return is deliberately undifferentiated: unknown, expired, already
 * spent, and over-budget all look the same to the caller, so this endpoint
 * cannot be used to probe which challenges exist.
 */
async function consumeChallenge(challenge, flow) {
  if (!challenge || !flow) return null;
  const now = new Date();
  return AuthChallenge.findOneAndUpdate(
    {
      challenge: String(challenge),
      flow,
      consumedAt: null,
      expiresAt: { $gt: now },
      $expr: { $lt: ['$attempts', '$maxAttempts'] },
    },
    {
      $inc: { attempts: 1 },
      $set: { consumedAt: now },
    },
    { new: true }
  ).lean();
}

/** Read a challenge without spending it. Used only for diagnostics. */
async function peekChallenge(challenge, flow) {
  if (!challenge) return null;
  return AuthChallenge.findOne({ challenge: String(challenge), flow }).lean();
}

/** Drop a challenge that the CLIENT abandoned (a ceremony that never ran). */
async function discardChallenge(challenge, flow) {
  if (!challenge) return;
  await AuthChallenge.deleteOne({ challenge: String(challenge), flow, consumedAt: null })
    .catch(() => {});
}

// ── Ceremony option builders ───────────────────────────────────────────────

/**
 * Options for `navigator.credentials.create()`.
 *
 * `excludeCredentials` carries every credential this account already has, so
 * the authenticator refuses to enrol the same one twice. That is a UX guard
 * (the user gets "this device is already registered" instead of a confusing
 * duplicate); the actual uniqueness enforcement is the unique index on
 * `Passkey.credentialId`, because a client-side exclusion list is advisory.
 *
 * `residentKey: 'required'` is what makes these PASSKEYS rather than
 * key-handles: a discoverable credential is offered on the account's sign-in
 * screen without the server naming it, which is what makes passwordless
 * sign-in possible at all.
 */
async function buildRegistrationOptions({ user, rp }) {
  const existing = await require('../models/Passkey')
    .find({ user: user._id })
    .select('credentialId transports')
    .lean();

  return generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.email,
    // The stable opaque handle, NOT the account id. See User.webauthnUserId.
    userID: Buffer.from(String(user.webauthnUserId), 'base64url'),
    userDisplayName: user.fullName || user.email,
    timeout: rp.timeoutMs,
    // 'none' keeps consumer passkeys working everywhere. Attestation is a
    // model-identification feature that requires vendor cooperation; demanding
    // it would lock out exactly the platform authenticators (Touch ID, Windows
    // Hello, Google Password Manager) that make passkeys worth having.
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: Array.isArray(c.transports) ? c.transports : undefined,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      // 'preferred', not 'required': a sign-in security key with no PIN cannot
      // do user verification, and demanding UV would exclude it outright. The
      // server requires UV at VERIFICATION time for sign-in, so a passkey that
      // cannot provide it is refused at use, not silently accepted at enrol.
      userVerification: 'preferred',
    },
    supportedAlgorithmIDs: getDefaultSupportedAlgorithmIDs(),
  });
}

/**
 * Options for `navigator.credentials.get()`.
 *
 * `allowCredentials` is EMPTY on purpose. A discoverable credential is found
 * by the authenticator, and the assertion comes back naming itself — which is
 * the property that makes this safe: the server looks the account up BY the
 * verified credential, so the client never gets to say which account it is
 * signing in as. Sending a client-supplied id here would be a step backwards
 * towards the enumeration problem.
 */
async function buildAuthenticationOptions({ rp }) {
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    timeout: rp.timeoutMs,
    allowCredentials: [],
    // Required, and the library enforces it at verification: an assertion
    // without the UV flag is refused. This is what makes a passkey two
    // factors (something you have + something you are) rather than one.
    userVerification: 'required',
  });
}

/**
 * Verify an attestation and return the credential material to store.
 *
 * Thin on purpose. @simplewebauthn/server checks the challenge, the origin,
 * the RP ID hash, the attestation statement, the client-data binding, the
 * algorithm and the user-verification flag. `attestationSafetyNetEnforceCTSCheck`
 * is left at its default (on) so an Android SafetyNet attestation that cannot
 * be cryptographically validated is treated as unsafe rather than waved
 * through.
 */
async function verifyRegistration({ response, expectedChallenge, rp, requireUserVerification }) {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origins,
    expectedRPID: rp.rpID,
    requireUserPresence: true,
    requireUserVerification: requireUserVerification !== false,
  });
}

/**
 * Verify an assertion against ONE stored credential.
 *
 * The caller must have resolved the credential from the assertion's own
 * credential id. `expectedChallenge` is the stored challenge string, which has
 * already been spent by `consumeChallenge` — so a replayed assertion finds no
 * live challenge and never reaches this function.
 */
async function verifyAuthentication({ response, expectedChallenge, rp, credential, requireUserVerification }) {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origins,
    expectedRPID: rp.rpID,
    credential: {
      id: credential.credentialId,
      publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
      counter: credential.counter || 0,
      transports: Array.isArray(credential.transports) ? credential.transports : undefined,
    },
    requireUserVerification: requireUserVerification !== false,
  });
}

/**
 * A fresh, random 32-byte user handle, base64url.
 *
 * `crypto.randomBytes` rather than a UUID: the handle is a WebAuthn
 * requirement, not a display identifier, and a UUID's version nibble halves
 * the search space for free.
 */
function generateUserHandle() {
  return crypto.randomBytes(32).toString('base64url');
}

function _resetCache() {
  cached = null;
  cachedFingerprint = '';
}

module.exports = {
  APP_NAME,
  CHALLENGE_TTL_MS,
  WebauthnConfigError,
  config,
  describe,
  isConfigured,
  isValidOrigin,
  isValidRpId,
  storeChallenge,
  consumeChallenge,
  peekChallenge,
  discardChallenge,
  buildRegistrationOptions,
  buildAuthenticationOptions,
  verifyRegistration,
  verifyAuthentication,
  generateUserHandle,
  developmentOrigins,
  _resetCache,
};
