const mongoose = require('mongoose');

/**
 * MfaTransaction — the state machine's `MFA_REQUIRED` state, persisted.
 *
 * THE VULNERABILITY THIS CLOSES
 * -----------------------------
 * Sign-in is two steps. Step one (password) proved a credential and handed the
 * client a bare `_id`. Step two (`/auth/login-2fa`, `/auth/verify-login-otp`,
 * `/security/backup-codes/redeem`) took that `_id` plus a code, and issued a
 * fully authenticated session.
 *
 * So the second factor was, on its own, sufficient. Anyone who obtained a
 * valid 6-digit TOTP — a shoulder-surfed code, a code read out of a phishing
 * page, a code phoned in by an impatient support agent — and who could guess
 * or learn the victim's user id could exchange it for a full session, with no
 * password at any point. The user id is not a secret: it travels in the sign-in
 * response body, and for accounts created through other paths it is a Mongo
 * ObjectId, which is a counter in disguise.
 *
 * The fix is the obvious one and it is a state machine rather than a flag: the
 * password step now mints a TRANSACTION. The second factor is only honoured
 * against a live transaction, and the transaction is spent by doing so.
 *
 * ── What the token is, and is not ──────────────────────────────────────────
 *
 * `tokenHash` is a SHA-256 of a 256-bit random token. Only the hash is
 * stored, so a database read cannot be replayed as a sign-in. The token itself
 * exists once, in the response body of the password step, held in the client's
 * memory for the duration of the MFA prompt.
 *
 * It carries NO authority of its own. It is not a session, it grants no access
 * to anything, and it cannot be replayed — `consume()` is a conditional update,
 * so the first verification wins and every later one matches nothing. It says
 * exactly one thing: "this account's password was verified, in this browser,
 * N minutes ago, and is waiting for a second factor."
 *
 * ── Attempt budget ─────────────────────────────────────────────────────────
 *
 * A 6-digit code has a million possibilities and a 30-second life, but an
 * unlimited-attempt transaction is a one-million-request oracle. `maxAttempts`
 * is enforced inside the same conditional update that spends the transaction,
 * so it cannot be raced: eleven concurrent guesses produce at most ten checks
 * and then a hard refusal.
 *
 * The budget is PER TRANSACTION, not per account, which matters. A per-account
 * counter would let an attacker lock a victim out of their own account by
 * spending the victim's budget with garbage codes — a denial of service dressed
 * up as a security control. Burning the transaction instead just makes the
 * attacker start a new sign-in, which the existing lockout ladder already
 * accounts for.
 */
const mfaTransactionSchema = new mongoose.Schema(
  {
    // hex(sha256(rawToken)). The raw token is never stored.
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      maxlength: 128,
    },
    // The account this transaction belongs to. The client never chooses it —
    // it is whatever the password step resolved.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Which second factors this transaction will accept, decided at the
    // password step from the account's own configuration. A transaction
    // therefore cannot be *upgraded*: if the password step decided the account
    // needs a TOTP, no amount of client input turns it into a no-op.
    methods: {
      type: [String],
      default: ['totp'],
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 10 },
    // The sign-in this transaction continues, for the audit trail and so a
    // completed sign-in can be attributed to the right login.
    primaryMethod: { type: String, default: 'password', maxlength: 32 },
    // Request context at the password step. Recorded so the completed sign-in
    // is attributable even if the second factor arrives from elsewhere.
    ip: { type: String, default: '', maxlength: 64 },
    userAgent: { type: String, default: '', maxlength: 300 },
    location: { type: String, default: '', maxlength: 120 },
    createdAt: { type: Date, default: Date.now },
    // TTL index: spent and abandoned transactions delete themselves.
    expiresAt: { type: Date, required: true },
    // Which factor completed it, and when. Null until spent.
    consumedAt: { type: Date, default: null },
    consumedBy: { type: String, default: '', maxlength: 32 },
  },
  { timestamps: false }
);

// "Is this account waiting on a second factor?" — the legacy-compatibility
// path looks for a live transaction by user when a client sends a bare user id.
mfaTransactionSchema.index({ user: 1, consumedAt: 1, expiresAt: 1 });
mfaTransactionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const MfaTransaction = mongoose.models.MfaTransaction
  || mongoose.model('MfaTransaction', mfaTransactionSchema);

module.exports = MfaTransaction;
