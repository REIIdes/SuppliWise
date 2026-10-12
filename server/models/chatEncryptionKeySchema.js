/**
 * The public half of an account's end-to-end encryption identity.
 *
 * Shared verbatim by models/User.js and models/AdminAccount.js. Both sides of a
 * support conversation need it, both need it to mean the same thing, and two
 * copies of a crypto field in two schemas is how they drift within a month.
 *
 * ── What is here, and what is not ──────────────────────────────────────────
 * `publicKey` is safe to store and safe to publish. It is the x‖y of a P-256
 * point; publishing it is the entire point — it is how another browser seals a
 * message to this account.
 *
 * The PRIVATE half is NOT here, and cannot be. A server that can read the
 * private key is not an end-to-end encrypted system, it is a server holding an
 * extra copy of everybody's messages. So it lives in the browser, sealed under
 * a key that this server does not hold:
 *
 *   device      → a random 32-byte secret in the browser's localStorage, written
 *                 once. Covers the ordinary case: reload, new tab, same machine.
 *   recovery    → a one-time code the ACCOUNT HOLDER is shown and asked to save,
 *                 never transmitted, never stored. Covers the case the device
 *                 seal cannot: a different machine, or cleared storage.
 *
 * `recoveryWrapped` is the private key sealed under that code. It is useless to
 * anyone who does not have the code, which is why it is safe to keep server-side
 * — the server can store the safe and never the means of opening it.
 *
 * `recoveryHint` is four characters of the code, enough for a person to
 * recognise their own code when they come back to it. Four characters of a
 * 26-symbol alphabet narrows 26^4 ≈ 457,000 — which is a confirmation aid and
 * NOT a secret, and is deliberately labelled as such at the point of display.
 */
module.exports = function chatEncryptionKeySchema() {
  return {
    keyId: { type: String, default: '', trim: true, maxlength: 32 },
    publicKey: { type: String, default: '', trim: true, maxlength: 128 },
    createdAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    recoveryWrapped: { type: String, default: '', maxlength: 2048 },
    recoveryHint: { type: String, default: '', maxlength: 8 },
    recoveryAt: { type: Date, default: null },
  };
};
