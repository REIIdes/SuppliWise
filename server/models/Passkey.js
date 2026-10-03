const mongoose = require('mongoose');

/**
 * Passkey — one WebAuthn/FIDO2 credential belonging to one account.
 *
 * WHAT IS AND IS NOT HERE
 * ----------------------
 * Stored: the credential id, the public key, the authenticator's signature
 * counter, and enough attestation metadata to name the device to a human.
 *
 * NOT stored, and not storable: the private key. It is created inside the
 * authenticator (a platform TPM/secure element, a phone's secure enclave, a
 * hardware token) and never leaves it. The browser hands the server a signed
 * assertion; the server checks it against the public key below. There is no
 * field in which a private key could be put, which is the point — a database
 * dump yields public keys and opaque ids, and none of that can sign anything.
 *
 * Every cryptographic check (attestation format, client-data binding, origin,
 * RP ID hash, UV flag, signature) is performed by @simplewebauthn/server. This
 * module stores the result; it never verifies a signature itself.
 *
 * DESIGN NOTES
 * ------------
 * • One credential per account per authenticator, but MANY credentials per
 *   account — the whole point of a passkey is being able to have a phone, a
 *   laptop and a hardware key all signed in. Indexes support both access
 *   patterns: "this account's keys" and, far more importantly, "which account
 *   does this credential id belong to" on every sign-in.
 *
 * • `credentialId` is UNIQUE across the whole collection, not per user. A
 *   credential id is minted by the authenticator and is globally unique in
 *   practice; making it globally unique in the database is what turns "two
 *   accounts claim the same passkey" into a database error instead of a silent
 *   cross-account authentication. Per-user uniqueness would permit exactly the
 *   account-confusion bug the rest of this design works to prevent.
 *
 * • Deletion is a hard delete. There is nothing to preserve: a revoked
 *   credential's only remaining use would be as an oracle for "was this passkey
 *   ever registered here", and the security event log already records that
 *   history for the account's owner.
 */
const passkeySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // base64url, exactly as the authenticator reported it. This is the primary
    // lookup key for a sign-in: the assertion names the credential, never the
    // user, which is what makes a passwordless sign-in safe.
    credentialId: {
      type: String,
      required: true,
      unique: true,
      maxlength: 512,
    },
    // base64url of the COSE public key produced by the authenticator. Verified
    // against by @simplewebauthn/server on every assertion.
    publicKey: {
      type: String,
      required: true,
      maxlength: 1024,
    },
    // The authenticator's signature counter. Zero for passkeys that sync (most
    // modern ones do), which is why a zero never counts as "went backwards" —
    // see the check in routes/passkeys.js.
    counter: {
      type: Number,
      default: 0,
    },
    // Hints the browser gave about how to reach this authenticator again
    // ('internal', 'hybrid', 'usb', 'nfc', 'ble'). Purely an optimisation: it
    // lets the platform skip transports that will not work. An absent or wrong
    // hint costs the user a tap, never a security property.
    transports: {
      type: [String],
      default: [],
    },
    // 'singleDevice' credentials live in one authenticator and are lost with
    // it; 'multiDevice' are synced/passkeys. Surfaced in the UI so someone
    // relying on a synced passkey knows it is not hardware-bound.
    deviceType: {
      type: String,
      enum: ['singleDevice', 'multiDevice'],
      default: 'singleDevice',
    },
    // Whether the platform reports this multi-device credential as backed up.
    backedUp: {
      type: Boolean,
      default: false,
    },
    // Attestation GUID, when the authenticator provides one. 'none' is the
    // normal value for consumer passkeys, and is NOT a weakness: attestation is
    // about proving which MODEL of authenticator produced a key, and requires
    // vendor cooperation almost no consumer platform offers.
    aaguid: {
      type: String,
      default: '',
      maxlength: 64,
    },
    // Attestation statement format ('none', 'packed', 'tpm', 'apple', ...).
    attestationFormat: {
      type: String,
      default: 'none',
      maxlength: 32,
    },
    // The user's own label ("Windows Hello", "YubiKey 5C"). Display only, and
    // the ONLY passkey field the owner can write — everything else is
    // authenticator-derived and must not be client-settable.
    name: {
      type: String,
      default: 'Passkey',
      maxlength: 60,
    },
    // Best-effort device description derived from the registration request's
    // user-agent. PRESENTATION ONLY, exactly like Session.deviceLabel: the
    // header is caller-controlled and is never an authorisation input.
    deviceLabel: {
      type: String,
      default: '',
      maxlength: 120,
    },
    // Whether the authenticator performed user verification (biometric / PIN)
    // at registration. Recorded because it is a fact about the credential's
    // strength, not a per-assertion check.
    userVerified: {
      type: Boolean,
      default: false,
    },
    createdAt: { type: Date, default: Date.now },
    // Last successful assertion. Drives the "Last used" column in the UI, and
    // lets a user spot a passkey that is being used somewhere they do not
    // recognise — one of the better free signals for credential theft.
    lastUsedAt: { type: Date, default: null },
    lastUsedIp: { type: String, default: '', maxlength: 64 },
    // How many times this credential has completed a sign-in. Diagnostic.
    signInCount: { type: Number, default: 0 },
  },
  { timestamps: false }
);

// "This account's passkeys", newest first — the management list.
passkeySchema.index({ user: 1, createdAt: -1 });
// "Which account owns this credential id" — the sign-in hot path. `credentialId`
// is already uniquely indexed, so this is covered; declared here so the intent
// is explicit and survives someone dropping the unique constraint by accident.

module.exports = mongoose.models.Passkey
  || mongoose.model('Passkey', passkeySchema);
