const mongoose = require('mongoose');

/**
 * AuthChallenge — a single-use WebAuthn challenge.
 *
 * WHY THIS IS A DATABASE ROW AND NOT A SIGNED TOKEN
 * -------------------------------------------------
 * The obvious design is a stateless challenge: sign the challenge with the
 * server secret and hand it to the browser, then verify the signature. It is
 * shorter and needs no storage. It is also wrong for this application, for one
 * reason: it is not single-use.
 *
 * A WebAuthn challenge's entire job is to be a nonce. The signature over a
 * challenge proves "this assertion was minted in response to a request this
 * server issued" — it says nothing about how many times that request can be
 * spent. Make the challenge replayable and an attacker who captures one
 * assertion (a malicious extension, a shared machine, a log that kept the
 * clientDataJSON) can replay it until the credential is rotated, because
 * nothing on the server ever notices the second use.
 *
 * Storing the challenge makes "spent" a fact the database can enforce, not a
 * property the token is supposed to have. `consume()` is a conditional update
 * on `consumedAt: null`, so two concurrent verifications of the same challenge
 * cannot both win — the same single-use primitive the backup codes already
 * rely on, for the same reason.
 *
 * WHAT IS BOUND
 * -------------
 *   flow  — 'register' | 'login'. A registration challenge can never be spent
 *           on an assertion, or an attacker could mint a credential for an
 *           account they merely asked about.
 *   user  — the account the challenge was issued FOR, on the registration path.
 *           Without it, a challenge handed to Account A could be completed and
 *           stored against whoever answered it.
 *   sid   — the session the challenge was issued under, on the registration
 *           path. A challenge captured from a hijacked session then cannot be
 *           completed from a different one.
 *
 * The login path is deliberately UNBOUND from any user: that is what makes
 * passwordless sign-in possible. `user` is null there, and the account is
 * determined afterwards by the verified credential — never by anything the
 * client sent.
 *
 * The raw challenge is the lookup key, which is safe precisely because it is
 * 32 bytes of CSPRNG output with a five-minute life and single use. The column
 * is unique so two challenges can never collide.
 */
const challengeSchema = new mongoose.Schema(
  {
    // base64url. Unique: 32 bytes of CSPRNG output, and a collision would be a
    // challenge-substitution bug, so the database refuses to allow one.
    challenge: {
      type: String,
      required: true,
      unique: true,
      maxlength: 128,
    },
    flow: {
      type: String,
      enum: ['register', 'login'],
      required: true,
    },
    // Set for 'register' only. Null on the login path BY DESIGN.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    // Set for 'register' only: binds the challenge to the session that asked.
    sid: {
      type: mongoose.Schema.Types.String,
      default: null,
      maxlength: 64,
    },
    // The userHandle the registration options were issued with. Carried so the
    // verify step can assert the credential was minted for THIS account's
    // stable handle rather than an arbitrary one.
    userHandle: { type: String, default: '', maxlength: 128 },
    // Bounded retries, not "unlimited attempts on one challenge".
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    createdAt: { type: Date, default: Date.now },
    // Mongo's TTL monitor removes the row. Expiry is ALSO checked in code
    // (see utils/webauthn.js) because the monitor runs about once a minute:
    // the TTL index is garbage collection, not the access-control check.
    expiresAt: {
      type: Date,
      required: true,
    },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: false }
);

// TTL index: expired challenges are deleted for us, forever, with no sweeper
// job to forget. `expireAfterSeconds: 0` means "delete at `expiresAt`".
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AuthChallenge = mongoose.models.AuthChallenge
  || mongoose.model('AuthChallenge', challengeSchema);

module.exports = AuthChallenge;
