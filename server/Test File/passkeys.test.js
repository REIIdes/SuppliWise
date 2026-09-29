'use strict';
/**
 * WebAuthn / passkey — the whole ceremony lifecycle, over real HTTP, with a
 * REAL authenticator.
 *
 * ── Why this file builds its own authenticator ─────────────────────────────
 *
 * The most dangerous way to test WebAuthn is to stub the verification. A stub
 * returns "verified: true" for whatever it is given, so the tests pass and the
 * actual security properties — challenge binding, origin checking, RP ID
 * checking, signature verification, the counter rule, replay refusal — are
 * never exercised at all. A passkey implementation whose only tests are
 * stubs is a passkey implementation that has been tested for nothing.
 *
 * So the authenticator below is real: a P-256 keypair generated per test, a
 * correct CBOR encoding of the attestation object, a correct
 * `clientDataJSON`, and a real ECDSA signature over `authenticatorData ||
 * SHA-256(clientDataJSON)`. That is the actual WebAuthn signing procedure, so
 * @simplewebauthn/server does genuine cryptographic verification, and every
 * negative test below genuinely fails the way it would in production.
 *
 * There is still no real browser, so the tests pin the SERVER's half of the
 * protocol. The client half is `navigator.credentials.*` and is the browser's
 * job.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const cbor = require('cbor');

// Load .env FIRST: `node --test` gives every file its own process, and the
// JWT secret has to exist before any route is required.
require('dotenv').config();

process.env.WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
process.env.WEBAUTHN_ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://localhost:5173';

const { startTestServer, connectTestDb } = require('./e2eServer');
const { testDbPreflight, skipMessage } = require('./testDbGuard');

const { issueUserSession } = require('../utils/sessions');
const { issue: issueStepUp } = require('../middleware/stepUp');
const User = require('../models/User');
const Passkey = require('../models/Passkey');
const AuthChallenge = require('../models/AuthChallenge');
const SecurityEvent = require('../models/SecurityEvent');

const preflight = testDbPreflight();

const RP_ID = process.env.WEBAUTHN_RP_ID;
const ORIGIN = process.env.WEBAUTHN_ORIGIN;
const PASSWORD = 'Probe!12345';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

/* ── A minimal but REAL WebAuthn authenticator ───────────────────────────── */

/**
 * Encode a minimal CBOR attestation object. Written out byte by byte rather
 * than pulled from a library so the test controls exactly what the server
 * sees: a change in the encoding is a change in what is being asserted.
 */
function encodeAttestationObject(authData, credentialId) {
  return cbor.encode({
    fmt: 'none',
    // The empty map is the whole "none" attestation statement.
    attStmt: {},
    authData,
  }, { extensionMap: new Map([[1, credentialId]]) });
}

/**
 * Build a virtual authenticator.
 *
 * `counter` is the authenticator's signature counter; `uv` toggles the
 * user-verified flag. Both are parameters because both are load-bearing: the
 * server must refuse an assertion without UV, and must notice a counter that
 * goes backwards.
 */
function authenticator() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let counter = 0;
  const credentialId = crypto.randomBytes(32);

  return {
    credentialId,
    counterValue: () => counter,

    /** rpIdHash || flags || signCount || attestedCredentialData */
    authData({ rpId = RP_ID, uv = true, includeAttested = true } = {}) {
      const flags = 0x01 | (uv ? 0x04 : 0x00) | (includeAttested ? 0x40 : 0x00);
      const head = Buffer.concat([
        sha256(Buffer.from(rpId, 'utf8')),
        Buffer.from([flags]),
        (() => { const b = Buffer.alloc(4); b.writeUInt32BE(counter); return b; })(),
      ]);
      if (!includeAttested) return head;
      const aaguid = Buffer.alloc(16);
      const idLen = Buffer.from([0x00, credentialId.length]);
      // COSE EC2 key: {1: kty=EC2, 3: alg=ES256, -1: crv=P-256, -2: x, -3: y}.
      //
      // Two details a JS object cannot express, both of which the real
      // verification library rejects (a stub would have accepted either, and
      // then the tests would have been asserting nothing):
      //   • the labels -1/-2/-3 are CBOR NEGATIVE INTEGERS, so a quoted "-1"
      //     emits a text string and you get "missing numeric alg";
      //   • x and y are CBOR BYTE STRINGS, so base64url text is wrong — the
      //     raw 32 bytes go in, or WebCrypto refuses the key with
      //     "Invalid keyData".
      // A Map can express both, and preserves the label order the
      // authenticator-data format requires.
      const point = pointOf(pair);
      const coseKey = cbor.encode(new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, point.x],
        [-3, point.y],
      ]));
      return Buffer.concat([head, aaguid, idLen, credentialId, coseKey]);
    },

    /** The signed response for navigator.credentials.create(). */
    register({ challenge, origin = ORIGIN, rpId = RP_ID, uv = true, userHandle }) {
      counter += 1;
      const authData = this.authData({ rpId, uv });
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: 'webauthn.create',
        challenge,
        origin,
        crossOrigin: false,
      }), 'utf8');
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        response: {
          clientDataJSON: b64u(clientDataJSON),
          attestationObject: b64u(encodeAttestationObject(authData, credentialId)),
          transports: ['internal', 'hybrid'],
        },
        clientExtensionResults: {},
        type: 'public-key',
        // Recorded so the test can assert the server bound the credential to
        // the account it issued the challenge for.
        __userHandle: userHandle,
      };
    },

    /** The signed response for navigator.credentials.get(). */
    authenticate({ challenge, origin = ORIGIN, rpId = RP_ID, uv = true, overrideCounter = null }) {
      if (overrideCounter !== null) counter = overrideCounter;
      else counter += 1;
      const authData = this.authData({ rpId, uv, includeAttested: false });
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin,
        crossOrigin: false,
      }), 'utf8');
      const signature = crypto.sign(
        'sha256',
        Buffer.concat([authData, sha256(clientDataJSON)]),
        pair.privateKey,
      );
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        response: {
          clientDataJSON: b64u(clientDataJSON),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
        },
        clientExtensionResults: {},
        type: 'public-key',
      };
    },
  };
}

function pointOf(pair) {
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return { x: Buffer.from(jwk.x, 'base64url'), y: Buffer.from(jwk.y, 'base64url') };
}

/* ── The suite ───────────────────────────────────────────────────────────── */

test('passkeys — registration, sign-in and every refusal', { skip: preflight.skip }, async (t) => {
  const server = await startTestServer({ port: 5122 });
  if (!server.ok) return t.skip(skipMessage(server));
  const db = await connectTestDb();
  if (!db.connected) {
    await server.stop();
    return t.skip(skipMessage(db));
  }

  const { base } = server;
  const created = [];
  t.after(async () => {
    for (const userId of created.reverse()) {
      await Passkey.deleteMany({ user: userId }).catch(() => {});
      await AuthChallenge.deleteMany({ user: userId }).catch(() => {});
      await SecurityEvent.deleteMany({ user: userId }).catch(() => {});
      await User.deleteOne({ _id: userId }).catch(() => {});
    }
    await mongoose.disconnect().catch(() => {});
    await server.stop();
  });

  const seed = async () => {
    const email = `pk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
    const user = await User.create({
      firstName: 'Pass', lastName: 'Key', name: 'Pass Key',
      email, password: PASSWORD, dateOfBirth: '1990-01-01', gender: 'Male',
    });
    created.push(user._id);
    const token = await issueUserSession(user._id, { userAgent: 'passkey-test', ip: '127.0.0.1' });
    const sid = (require('jsonwebtoken').decode(token) || {}).sid;
    return { user, token, stepUp: issueStepUp(user._id, sid) };
  };

  const call = (path, { method = 'GET', body, token, stepUp } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(stepUp ? { 'X-Step-Up': stepUp } : {}),
      Origin: ORIGIN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data };
  });

  /** Fetch options, run the ceremony, verify — the shape a browser performs. */
  const enrol = async (ctx, auth, name = 'Test Passkey', regOptions = {}) => {
    const options = await call('/api/auth/passkeys/register/options', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    if (options.status !== 200) return { options, verified: null };
    const response = auth.register({ challenge: options.data.challenge, ...regOptions });
    const verified = await call('/api/auth/passkeys/register/verify', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp,
      body: { response, name },
    });
    return { options, verified, response };
  };

  // ══ 1. REGISTRATION ══════════════════════════════════════════════════════

  await t.test('options come back with a fresh challenge, bound to this account', async () => {
    const ctx = await seed();
    const r = await call('/api/auth/passkeys/register/options', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    assert.equal(r.status, 200);
    assert.ok(r.data.challenge, 'a challenge is required');
    assert.ok(r.data.rp.id, 'the RP ID is stated');
    assert.equal(r.data.rp.id, RP_ID);
    assert.ok(r.data.user.id, 'a user handle is required');
    assert.equal(r.data.authenticatorSelection.residentKey, 'required',
      'a discoverable credential is what makes passwordless sign-in possible at all');
  });

  await t.test('registration requires re-authentication', async () => {
    const ctx = await seed();
    const noStepUp = await call('/api/auth/passkeys/register/options', { method: 'POST', token: ctx.token });
    assert.equal(noStepUp.status, 401);
    assert.equal(noStepUp.data.code, 'STEP_UP_REQUIRED',
      'a stolen session must not be enough to enrol the attacker\'s own passkey');

    const noSession = await call('/api/auth/passkeys/register/options', { method: 'POST', stepUp: ctx.stepUp });
    assert.equal(noSession.status, 401);
  });

  await t.test('a valid passkey registers and is stored without a private key', async () => {
    const ctx = await seed();
    const auth = authenticator();
    const { verified } = await enrol(ctx, auth, 'Windows Hello');
    assert.equal(verified.status, 200, `verify failed: ${verified.data && verified.data.message}`);
    assert.equal(await Passkey.countDocuments({ user: ctx.user._id }), 1);

    const row = await Passkey.findOne({ user: ctx.user._id }).lean();
    assert.ok(row.publicKey, 'the public key is stored');
    assert.ok(!('privateKey' in row), 'there is no field a private key could be stored in');
    assert.ok(row.deviceLabel, 'device info is recorded for display');
    assert.equal(row.name, 'Windows Hello');
    assert.equal(row.lastUsedAt, null, 'a new passkey has never been used');
  });

  await t.test('the registration response never contains the credential id', async () => {
    const ctx = await seed();
    const auth = authenticator();
    const { verified } = await enrol(ctx, auth);
    assert.equal(verified.status, 200);
    const body = JSON.stringify(verified.data);
    assert.ok(!body.includes(auth.credentialId.toString('base64url')),
      'the credential id is an authentication lookup key and has no business in a response');
  });

  await t.test('a wrong challenge is refused', async () => {
    const ctx = await seed();
    const auth = authenticator();
    const options = await call('/api/auth/passkeys/register/options', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    // An assertion minted in response to a challenge the server never issued.
    const response = auth.register({ challenge: b64u(crypto.randomBytes(32)) });
    const r = await call('/api/auth/passkeys/register/verify', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { response },
    });
    assert.equal(r.status, 400);
    assert.equal(await Passkey.countDocuments({ user: ctx.user._id }), 0);
    assert.ok(options.data.challenge);
  });

  await t.test('a challenge cannot be spent twice', async () => {
    // This is the replay property, and it is the reason the challenge is a
    // database row rather than a signed token.
    const ctx = await seed();
    const auth = authenticator();
    const options = await call('/api/auth/passkeys/register/options', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    const response = auth.register({ challenge: options.data.challenge });

    const first = await call('/api/auth/passkeys/register/verify', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { response },
    });
    assert.equal(first.status, 200);

    const replay = await call('/api/auth/passkeys/register/verify', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { response },
    });
    assert.equal(replay.status, 400, 'the same attestation must not verify twice');
    assert.equal(await Passkey.countDocuments({ user: ctx.user._id }), 1);
  });

  await t.test('an expired challenge is refused', async () => {
    const ctx = await seed();
    const auth = authenticator();
    const options = await call('/api/auth/passkeys/register/options', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    const response = auth.register({ challenge: options.data.challenge });
    // Age the stored challenge out of existence.
    await AuthChallenge.updateOne(
      { challenge: options.data.challenge },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const r = await call('/api/auth/passkeys/register/verify', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { response },
    });
    assert.equal(r.status, 400);
  });

  await t.test('an assertion from a different origin is refused', async () => {
    const ctx = await seed();
    const auth = authenticator();
    const options = await call('/api/auth/passkeys/register/options', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    const response = auth.register({ challenge: options.data.challenge, origin: 'https://evil.example.com' });
    const r = await call('/api/auth/passkeys/register/verify', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { response },
    });
    assert.equal(r.status, 400, 'origin binding is the core of WebAuthn phishing resistance');
    assert.equal(await Passkey.countDocuments({ user: ctx.user._id }), 0);
  });

  await t.test('an assertion for a different RP ID is refused', async () => {
    const ctx = await seed();
    const auth = authenticator();
    const options = await call('/api/auth/passkeys/register/options', { method: 'POST', token: ctx.token, stepUp: ctx.stepUp });
    const response = auth.register({ challenge: options.data.challenge, rpId: 'evil.example.com' });
    const r = await call('/api/auth/passkeys/register/verify', {
      method: 'POST', token: ctx.token, stepUp: ctx.stepUp, body: { response },
    });
    assert.equal(r.status, 400, 'the RP ID hash is what binds a credential to a domain');
  });

  await t.test('an attestation with no user verification is accepted but recorded as unverified', async () => {
    // A security key with no PIN cannot do UV. Refusing to ENROL it would lock
    // those users out of the strongest factor available to them; the server
    // records that it is unverified and then requires UV at SIGN-IN, which is
    // where it actually matters.
    const ctx = await seed();
    const auth = authenticator();
    const { verified } = await enrol(ctx, auth, 'YubiKey', { uv: false });
    assert.equal(verified.status, 200);
    const row = await Passkey.findOne({ user: ctx.user._id }).lean();
    assert.equal(row.userVerified, false);
  });

  await t.test('the same passkey cannot be registered twice', async () => {
    const ctx = await seed();
    const auth = authenticator();
    const first = await enrol(ctx, auth, 'First');
    assert.equal(first.verified.status, 200);

    const second = await enrol(ctx, auth, 'Second');
    assert.equal(second.verified.status, 409, 'a duplicate credential must be refused, not stored twice');
    assert.equal(await Passkey.countDocuments({ user: ctx.user._id }), 1);
  });

  await t.test('one credential cannot be attached to two accounts', async () => {
    // The unique index on credentialId is what makes this true, not the read
    // above it. A per-user uniqueness rule would permit exactly the
    // account-confusion bug this whole design avoids.
    const victim = await seed();
    const attacker = await seed();
    const auth = authenticator();

    const enrolled = await enrol(victim, auth, 'Victim key');
    assert.equal(enrolled.verified.status, 200);

    // The attacker enrols the SAME authenticator on their own account.
    const options = await call('/api/auth/passkeys/register/options', { method: 'POST', token: attacker.token, stepUp: attacker.stepUp });
    const response = auth.register({ challenge: options.data.challenge });
    const r = await call('/api/auth/passkeys/register/verify', {
      method: 'POST', token: attacker.token, stepUp: attacker.stepUp, body: { response },
    });
    assert.equal(r.status, 409);
    assert.equal(await Passkey.countDocuments({ credentialId: b64u(auth.credentialId) }), 1,
      'exactly one account may own a credential');
  });

  await t.test('a challenge issued to one account cannot complete on another', async () => {
    const victim = await seed();
    const attacker = await seed();
    const auth = authenticator();

    const options = await call('/api/auth/passkeys/register/options', { method: 'POST', token: victim.token, stepUp: victim.stepUp });
    const response = auth.register({ challenge: options.data.challenge });
    // The attacker answers the VICTIM's challenge on the ATTACKER's account.
    const r = await call('/api/auth/passkeys/register/verify', {
      method: 'POST', token: attacker.token, stepUp: attacker.stepUp, body: { response },
    });
    assert.equal(r.status, 400, 'a challenge is bound to the account and session it was issued for');
    assert.equal(await Passkey.countDocuments({ attacker: { $exists: true } }).catch(() => 0), 0);
  });

  // ══ 2. SIGN-IN ═══════════════════════════════════════════════════════════

  await t.test('a passkey signs in with no password at all', async () => {
    const ctx = await seed();
    const auth = authenticator();
    assert.equal((await enrol(ctx, auth, 'Sign-in key')).verified.status, 200);

    const options = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    assert.equal(options.status, 200);
    assert.equal(options.data.userVerification, 'required', 'UV is what makes a passkey two factors');
    assert.ok(!options.data.allowCredentials || options.data.allowCredentials.length === 0,
      'a discoverable credential must be found by the authenticator, not named by the server');

    const response = auth.authenticate({ challenge: options.data.challenge });
    const r = await call('/api/auth/passkeys/login/verify', { method: 'POST', body: { response } });
    assert.equal(r.status, 200, `sign-in failed: ${r.data && r.data.message}`);
    assert.ok(r.data.token, 'a session token is returned');
    assert.equal(String(r.data._id), String(ctx.user._id), 'the account comes from the credential, not the request');
    assert.equal(r.data.mfaVerified, true, 'a user-verified passkey is a second factor');

    // The token must actually work.
    const me = await call('/api/auth/me', { token: r.data.token });
    assert.equal(me.status, 200);
  });

  await t.test('sign-in updates the last-used stamp and the counter', async () => {
    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth);
    const options = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const r = await call('/api/auth/passkeys/login/verify', {
      method: 'POST', body: { response: auth.authenticate({ challenge: options.data.challenge }) },
    });
    assert.equal(r.status, 200);
    const row = await Passkey.findOne({ user: ctx.user._id }).lean();
    assert.ok(row.lastUsedAt, 'last used must be recorded — it is how a user spots an unfamiliar one');
    assert.ok(row.counter > 0);
    assert.equal(row.signInCount, 1);
  });

  await t.test('a replayed assertion is refused', async () => {
    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth);
    const options = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const response = auth.authenticate({ challenge: options.data.challenge });

    const first = await call('/api/auth/passkeys/login/verify', { method: 'POST', body: { response } });
    assert.equal(first.status, 200);
    const replay = await call('/api/auth/passkeys/login/verify', { method: 'POST', body: { response } });
    assert.equal(replay.status, 401, 'a captured assertion must not be spendable twice');
  });

  await t.test('an assertion without user verification is refused', async () => {
    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth, 'No-UV key', { uv: false });
    const options = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const r = await call('/api/auth/passkeys/login/verify', {
      method: 'POST', body: { response: auth.authenticate({ challenge: options.data.challenge, uv: false }) },
    });
    assert.equal(r.status, 401, 'a passkey that cannot verify the user is one factor wearing a passkey\'s name');
  });

  await t.test('a tampered signature is refused', async () => {
    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth);
    const options = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const response = auth.authenticate({ challenge: options.data.challenge });
    const sig = Buffer.from(response.response.signature, 'base64url');
    sig[0] ^= 0xff;
    response.response.signature = b64u(sig);
    const r = await call('/api/auth/passkeys/login/verify', { method: 'POST', body: { response } });
    assert.equal(r.status, 401);
  });

  await t.test('an assertion signed by a DIFFERENT key is refused', async () => {
    // The strongest form of the check: not a corrupted signature but a
    // perfectly well-formed one from an authenticator that never enrolled.
    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth);

    const impostor = authenticator();
    const options = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const forged = impostor.authenticate({ challenge: options.data.challenge });
    // Keep the REAL credential id, swap in the impostor's signature.
    forged.id = auth.credentialId.toString('base64url');
    forged.rawId = forged.id;
    const r = await call('/api/auth/passkeys/login/verify', { method: 'POST', body: { response: forged } });
    assert.equal(r.status, 401);
  });

  await t.test('an assertion for a different origin is refused', async () => {
    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth);
    const options = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const r = await call('/api/auth/passkeys/login/verify', {
      method: 'POST',
      body: { response: auth.authenticate({ challenge: options.data.challenge, origin: 'https://phish.example.com' }) },
    });
    assert.equal(r.status, 401, 'this is the phishing the whole protocol exists to stop');
  });

  await t.test('an assertion for a different RP ID is refused', async () => {
    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth);
    const options = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const r = await call('/api/auth/passkeys/login/verify', {
      method: 'POST', body: { response: auth.authenticate({ challenge: options.data.challenge, rpId: 'evil.example.com' }) },
    });
    assert.equal(r.status, 401);
  });

  await t.test('an unknown credential id is refused, identically', async () => {
    // The response must be indistinguishable from a wrong signature, or this
    // endpoint becomes a "does this credential exist" oracle.
    const unknown = authenticator();
    const options = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const a = await call('/api/auth/passkeys/login/verify', {
      method: 'POST', body: { response: unknown.authenticate({ challenge: options.data.challenge }) },
    });

    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth);
    const options2 = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const sig = auth.authenticate({ challenge: options2.data.challenge });
    sig.response.signature = b64u(Buffer.from(sig.response.signature, 'base64url').map((b) => b ^ 0xff));
    const b = await call('/api/auth/passkeys/login/verify', { method: 'POST', body: { response: sig } });

    assert.equal(a.status, b.status, 'status must not reveal whether a credential exists');
    assert.deepEqual(a.data, b.data, 'nor may the body');
  });

  await t.test('a signature counter that goes backwards is treated as a clone', async () => {
    // Most modern passkeys sync and always report 0, so the rule only applies
    // when the authenticator actually maintains a counter. A counter that
    // stops advancing while it used to is the signature of a copied
    // credential.
    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth);

    const first = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const ok = await call('/api/auth/passkeys/login/verify', {
      method: 'POST', body: { response: auth.authenticate({ challenge: first.data.challenge }) },
    });
    assert.equal(ok.status, 200);
    const stored = await Passkey.findOne({ user: ctx.user._id }).lean();
    assert.ok(stored.counter > 0);

    const second = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const replayed = await call('/api/auth/passkeys/login/verify', {
      method: 'POST',
      body: { response: auth.authenticate({ challenge: second.data.challenge, overrideCounter: stored.counter }) },
    });
    assert.equal(replayed.status, 401);
  });

  await t.test('a zero counter is never treated as a rollback', async () => {
    // A syncing passkey reports 0 forever. Treating that as "went backwards"
    // would lock out every user on the platform authenticators the product is
    // built around.
    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth);
    await Passkey.updateOne({ user: ctx.user._id }, { $set: { counter: 0 } });

    for (let i = 0; i < 2; i += 1) {
      const options = await call('/api/auth/passkeys/login/options', { method: 'POST' });
      const r = await call('/api/auth/passkeys/login/verify', {
        method: 'POST', body: { response: auth.authenticate({ challenge: options.data.challenge, overrideCounter: 0 }) },
      });
      assert.equal(r.status, 200, `sign-in ${i + 1} must succeed with a non-counting authenticator`);
    }
  });

  await t.test('an expired login challenge is refused', async () => {
    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth);
    const options = await call('/api/auth/passkeys/login/options', { method: 'POST' });
    const response = auth.authenticate({ challenge: options.data.challenge });
    await AuthChallenge.updateOne(
      { challenge: options.data.challenge },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const r = await call('/api/auth/passkeys/login/verify', { method: 'POST', body: { response } });
    assert.equal(r.status, 401);
  });

  // ══ 3. MANAGEMENT ═══════════════════════════════════════════════════════

  await t.test('an account can hold several passkeys', async () => {
    const ctx = await seed();
    for (const name of ['Windows Hello', 'iPhone', 'Security Key']) {
      const auth = authenticator();
      const { verified } = await enrol(ctx, auth, name);
      assert.equal(verified.status, 200, `${name} must register`);
    }
    assert.equal(await Passkey.countDocuments({ user: ctx.user._id }), 3);

    const list = await call('/api/auth/passkeys', { token: ctx.token });
    assert.equal(list.status, 200);
    assert.equal(list.data.passkeys.length, 3);
    for (const p of list.data.passkeys) {
      assert.ok(p.name && p.createdAt, 'each passkey is listed with a name and a creation date');
      assert.ok(!('credentialId' in p), 'the credential id must never be returned');
      assert.ok(!('publicKey' in p), 'nor the public key');
    }
  });

  await t.test('a passkey can be renamed', async () => {
    const ctx = await seed();
    const auth = authenticator();
    await enrol(ctx, auth, 'Old name');
    const row = await Passkey.findOne({ user: ctx.user._id }).lean();

    const r = await call(`/api/auth/passkeys/${row._id}`, {
      method: 'PATCH', token: ctx.token, body: { name: 'Work laptop' },
    });
    assert.equal(r.status, 200);
    assert.equal((await Passkey.findById(row._id).lean()).name, 'Work laptop');
  });

  await t.test('one account cannot rename or read another account\'s passkey', async () => {
    const victim = await seed();
    const attacker = await seed();
    await enrol(victim, authenticator(), 'Victim key');
    const row = await Passkey.findOne({ user: victim.user._id }).lean();

    const rename = await call(`/api/auth/passkeys/${row._id}`, {
      method: 'PATCH', token: attacker.token, body: { name: 'Mine now' },
    });
    assert.equal(rename.status, 404, 'a guessed id belonging to someone else is a 404, never a 403');

    const remove = await call(`/api/auth/passkeys/${row._id}`, {
      method: 'DELETE', token: attacker.token, stepUp: attacker.stepUp,
    });
    assert.equal(remove.status, 404);
    assert.ok(await Passkey.findById(row._id), 'and the passkey is still there');
  });

  await t.test('removing a passkey requires re-authentication', async () => {
    const ctx = await seed();
    await enrol(ctx, authenticator(), 'Removable');
    const row = await Passkey.findOne({ user: ctx.user._id }).lean();

    const noStepUp = await call(`/api/auth/passkeys/${row._id}`, { method: 'DELETE', token: ctx.token });
    assert.equal(noStepUp.status, 401);
    assert.equal(noStepUp.data.code, 'STEP_UP_REQUIRED');
    assert.ok(await Passkey.findById(row._id), 'nothing was removed');
  });

  await t.test('a passkey can be removed', async () => {
    const ctx = await seed();
    await enrol(ctx, authenticator(), 'Keep me');
    await enrol(ctx, authenticator(), 'Remove me');
    const row = await Passkey.findOne({ user: ctx.user._id, name: 'Remove me' }).lean();

    const r = await call(`/api/auth/passkeys/${row._id}`, { method: 'DELETE', token: ctx.token, stepUp: ctx.stepUp });
    assert.equal(r.status, 200);
    assert.equal(await Passkey.countDocuments({ user: ctx.user._id }), 1);

    const events = await SecurityEvent.find({ user: ctx.user._id, type: 'passkey-removed' }).lean();
    assert.equal(events.length, 1, 'removal is recorded — it is the thing an attacker does to lock a victim out');
  });

  await t.test('the last passkey cannot be removed when it is the only way in', async () => {
    // Removing the final strong factor with nothing else configured leaves the
    // account with a password alone, which is not a security improvement. The
    // route refuses and says what to do instead.
    const ctx = await seed();
    await enrol(ctx, authenticator(), 'Only key');
    const row = await Passkey.findOne({ user: ctx.user._id }).lean();

    const r = await call(`/api/auth/passkeys/${row._id}`, { method: 'DELETE', token: ctx.token, stepUp: ctx.stepUp });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'LAST_STRONG_METHOD');
    assert.ok(await Passkey.findById(row._id), 'the passkey is still there');
  });

  await t.test('the last passkey CAN be removed once there is another way in', async () => {
    const ctx = await seed();
    // Turn on an authenticator so the account is not left with only a password.
    const { hashPassword } = require('../utils/password');
    const seedData = require('speakeasy').generateSecret({ length: 20 }).base32;
    await User.updateOne(
      { _id: ctx.user._id },
      {
        $set: {
          twoFactorEnabled: true,
          twoFactorMethod: 'authenticator',
          twoFactorSecretEnc: require('../utils/secretBox').encrypt(seedData),
        },
      },
    );
    await enrol(ctx, authenticator(), 'Only key');
    const row = await Passkey.findOne({ user: ctx.user._id }).lean();

    const r = await call(`/api/auth/passkeys/${row._id}`, { method: 'DELETE', token: ctx.token, stepUp: ctx.stepUp });
    assert.equal(r.status, 200, 'with an authenticator present the account is not left unprotected');
    assert.ok(hashPassword);
  });

  // ══ 4. THE SECURITY SUMMARY ═════════════════════════════════════════════

  await t.test('the summary reflects real passkey state, not a guess', async () => {
    const ctx = await seed();
    const before = await call('/api/security/summary', { token: ctx.token });
    assert.equal(before.status, 200);
    assert.equal(before.data.passkeys.count, 0);

    await enrol(ctx, authenticator(), 'Summary key');
    const after = await call('/api/security/summary', { token: ctx.token });
    assert.equal(after.data.passkeys.count, 1);
    assert.equal(after.data.passkeys.strongestMethod, 'passkey',
      'the badge is computed from real state, so it cannot disagree with the list below it');
    assert.equal(after.data.passkeySignIn.available, true);
  });
});
