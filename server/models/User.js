const mongoose = require('mongoose');
const { hashPassword, verifyPassword, needsRehash } = require('../utils/password');
const { NAME_PATTERN, NAME_MIN, NAME_MAX, NAME_CHARS_HINT } = require('../utils/nameValidation');

// The browser filters these fields, but a client-side check is only a
// suggestion — /api/auth/register and the profile update endpoint are
// reachable directly. The pattern below is the actual boundary, and it
// mirrors my-react-app/src/utils/nameValidation.js exactly. Keep the two in
// step or the forms and the API will disagree about what a name is.
const nameRule = (label) => ({
  minlength: [NAME_MIN, `${label} must be at least ${NAME_MIN} characters`],
  maxlength: [NAME_MAX, `${label} must be ${NAME_MAX} characters or fewer`],
  match: [
    NAME_PATTERN,
    `${label} can only contain ${NAME_CHARS_HINT}`,
  ],
});

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
      ...nameRule('First name'),
    },
    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
      ...nameRule('Last name'),
    },
    name: {
      type: String,
      trim: true,
      // Virtual field computed from firstName + lastName, but keep for backward compatibility
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/, 'Please enter a valid email address.'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters.'],
    },
    // When the password was last SET (registration, change, or reset).
    // Stamped in the pre-save hook below so it can never drift from the hash:
    // any write that changes the password updates the date in the same save.
    // null = never changed since the account was created (or predates this
    // field) — the UI shows "never" rather than guessing.
    passwordChangedAt: {
      type: Date,
      default: null,
    },
    dateOfBirth: {
      type: Date,
      required: [true, 'Date of birth is required'],
      validate: {
        validator: function(value) {
          const today = new Date();
          const birthDate = new Date(value);
          const age = today.getFullYear() - birthDate.getFullYear();
          const monthDiff = today.getMonth() - birthDate.getMonth();
          const adjustedAge = monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate()) ? age - 1 : age;
          return adjustedAge >= 1 && adjustedAge <= 120;
        },
        message: 'Please enter a valid date of birth (age must be between 1 and 120).',
      },
    },
    gender: {
      type: String,
      required: [true, 'Gender is required'],
      enum: ['Male', 'Female'],
    },
    profilePicture: {
      type: String,
      default: '',
    },
    bannerPicture: {
      type: String,
      default: '',
    },
    hasVisitedDashboard: {
      type: Boolean,
      default: false,
    },
    // IANA zone ("Europe/London") last reported by the browser, e.g.
    // `Intl.DateTimeFormat().resolvedOptions().timeZone`.
    //
    // WHY IT IS NEEDED: a supplement's time window belongs to the user's day,
    // so "has the morning window closed?" has to be asked in THEIR clock. The
    // server's default is UTC, which for anyone west of Greenwich closes every
    // window hours early and would mark a morning dose missed before the user
    // had woken up. See utils/intakeWindows.js.
    //
    // Purely a hint: it is never used to authorise anything, and an empty value
    // degrades to UTC with the penalty logic failing open (nothing marked
    // missed) rather than closed.
    timeZone: {
      type: String,
      default: '',
      maxlength: 64,
    },
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    // ── Recovery email ────────────────────────────────────────────────
    // A SECOND address, used only to warn the account holder that their
    // primary account is under pressure. It can never authenticate a sign-in
    // and is never a login identifier — that would make it a second password.
    // It is inert until recoveryEmailVerifiedAt is set, and changing it always
    // notifies the PRIMARY address.
    recoveryEmail: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    recoveryEmailVerifiedAt: {
      type: Date,
      default: null,
    },
    // WHICH second factor, once twoFactorEnabled is true.
    //   'authenticator' — TOTP app (Google Authenticator et al). Stronger.
    //   'email'          — a code mailed to the account address.
    // Only meaningful while twoFactorEnabled; defaulting to the stronger option
    // means an account that enables 2FA without choosing gets the safe one.
    // 'email' is deliberately opt-IN and labelled as the weaker choice in the
    // UI — it protects against a stolen password, but not against someone who
    // already controls the mailbox.
    twoFactorMethod: {
      type: String,
      enum: ['authenticator', 'email'],
      default: 'authenticator',
    },
    // ── TOTP seed: encrypted, with a legacy plaintext field ───────────────
    // A TOTP seed cannot be hashed (the server must run HMAC over it to verify
    // a code), so it is ENCRYPTED at rest with AES-256-GCM under a key held
    // outside the database — see utils/secretBox.js. Read and write go through
    // utils/totpSecret.js and nowhere else.
    //
    // `twoFactorSecret` below is the pre-encryption field. It is still READ
    // (and upgraded in place on first use) so no account loses its second
    // factor during the transition, but nothing writes a new seed there and it
    // is cleared the moment an account touches its authenticator.
    twoFactorSecretEnc: {
      type: String,
      default: '',
      select: false,
    },
    // LEGACY: a raw base32 seed written before encryption existed. Empty on
    // every account that has been migrated. Never repopulated.
    twoFactorSecret: {
      type: String,
      default: '',
      select: false,
    },
    // ── WebAuthn / passkey user handle ─────────────────────────────────────
    // The opaque, stable `user.id` sent to the authenticator at registration.
    //
    // It is a random 32-byte value, NOT the account id and NOT the email.
    // WebAuthn requires the handle to be a stable, unguessable byte string that
    // never changes for an account; using the email would both leak the
    // address to every authenticator and platform involved, and give anyone
    // holding a passkey a ready-made account-enumeration oracle. Generated
    // lazily on first passkey registration and immutable afterwards — changing
    // it would orphan every passkey already on the account.
    webauthnUserId: {
      type: String,
      default: '',
      select: false,
      maxlength: 128,
    },
    subscriptionActive: {
      type: Boolean,
      default: false,
    },
    subscriptionPlan: {
      type: String,
      default: 'free',
      enum: ['free', 'monthly', 'annual', 'custom'],
    },
    subscriptionUpdatedAt: {
      type: Date,
      default: null,
    },
    // ── PROJECTED effective state ─────────────────────────────────────────
    // Written on every subscription mutation by utils/subscriptionState.js and
    // the ONLY subscription fields the rest of the app needs to read: they
    // always describe the effective subscription (what the user paid for,
    // unless an admin override is in force).
    //
    // Keeping this projection denormalized is what let ~40 pre-existing readers
    // — the entitlement gates, the admin grid, /auth/me, the overview metrics —
    // keep working untouched while the durable two-layer record below was
    // introduced.
    subscriptionStartedAt: {
      type: Date,
      default: null,
    },
    subscriptionExpiresAt: {
      type: Date,
      default: null,
    },
    // subscriptionPermanent — this grant never expires, so
    //   subscriptionExpiresAt is null AND any stale end date is ignored at read
    //   time. Removal is the only way to end it.
    // subscriptionSource    — 'payment' | 'admin' | 'free'; drives the
    //   PAID / ADMIN badge and the "restore original" affordance.
    subscriptionPermanent: {
      type: Boolean,
      default: false,
    },
    subscriptionSource: {
      type: String,
      default: 'free',
      enum: ['payment', 'admin', 'free'],
    },
    // ── The durable two-layer record ─────────────────────────────────────
    // The source of truth for "what did the user pay for" and "what has an
    // admin layered on top of it". Accounts created before this existed have no
    // record; they are read as a paid layer built from the fields above
    // (utils/subscriptionState.readRecord), so no migration script is needed and
    // no account can be lost.
    subscriptionRecord: {
      // What the USER bought. No admin override is allowed to destroy this — it
      // is only rewritten by a purchase, a renewal, a cancellation, expiry, or
      // an explicit correction.
      paid: {
        plan: { type: String, default: 'free', enum: ['free', 'monthly', 'annual', 'custom'] },
        // none = never had one | active | expired | cancelled
        status: { type: String, default: 'none', enum: ['none', 'active', 'expired', 'cancelled'] },
        startedAt: { type: Date, default: null },
        expiresAt: { type: Date, default: null },
        permanent: { type: Boolean, default: false },
        updatedAt: { type: Date, default: null },
        // 'payment' | 'system' | 'system:migrated' | 'admin:<alias>'
        updatedBy: { type: String, default: 'system' },
        // The days the last purchase/grant actually bought, so the UI can show
        // "30-day plan" without recomputing it from the calendar.
        periodDays: { type: Number, default: null },
      },
      // The ADMIN layer, active only while an override is in force. While it is
      // set, `paid` is frozen into `restore` so "Restore original subscription
      // state" can put the exact previous expiry back.
      override: {
        active: { type: Boolean, default: false },
        plan: { type: String, default: 'free', enum: ['free', 'monthly', 'annual', 'custom'] },
        permanent: { type: Boolean, default: false },
        startedAt: { type: Date, default: null },
        expiresAt: { type: Date, default: null },
        appliedAt: { type: Date, default: null },
        updatedAt: { type: Date, default: null },
        adminAlias: { type: String, default: '' },
        reason: { type: String, default: '' },
        // The frozen paid snapshot. `expiresAt` here is an ABSOLUTE date
        // captured when the override began — restoring uses this value as-is,
        // which is why restoring never silently re-grants a full 30 days.
        restore: {
          plan: { type: String, default: 'free', enum: ['free', 'monthly', 'annual', 'custom'] },
          status: { type: String, default: 'none' },
          startedAt: { type: Date, default: null },
          expiresAt: { type: Date, default: null },
          permanent: { type: Boolean, default: false },
          capturedAt: { type: Date, default: null },
          capturedDaysRemaining: { type: Number, default: null },
          periodDays: { type: Number, default: null },
        },
      },
      // Append-only audit trail: who changed what, when, and from which state to
      // which. Newest first, capped by the engine.
      history: [{
        at: { type: Date, default: null },
        actor: { type: String, default: 'system' },
        action: { type: String, default: 'update' },
        note: { type: String, default: '' },
        from: { type: mongoose.Schema.Types.Mixed, default: null },
        to: { type: mongoose.Schema.Types.Mixed, default: null },
      }],
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    lastLoginIp: {
      type: String,
      default: '',
      select: false,
    },
    lastLoginUserAgent: {
      type: String,
      default: '',
      select: false,
    },
    accountRole: {
      type: String,
      enum: ['user', 'moderator'],
      default: 'user',
    },
    accountStatus: {
      type: String,
      enum: ['active', 'banned', 'deleted'],
      default: 'active',
    },
    lastLoginLocation: {
      type: String,
      default: 'Unknown location',
    },
    // Active-session pointer: the ONE session this account is currently
    // signed in with (its Session._id, embedded in the JWT as `sid`).
    // Sign-in flips it in a single atomic document update — the newest
    // sign-in always wins — and the session it displaced is revoked.
    // No timers: sessions end only by replacement or sign-out.
    currentSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      select: false,
    },
    // Monotonic sign-in counter (audit/informational: bumped on every login
    // in the same atomic update as the pointer above).
    sessionVersion: {
      type: Number,
      default: 0,
      select: false,
    },
    bannedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Admin panels sort/filter by recency and login activity
userSchema.index({ createdAt: -1 });
userSchema.index({ lastLoginAt: -1 });
// Subscription lookups: "who has a live paid plan" / "who is overridden".
userSchema.index({ subscriptionPlan: 1, subscriptionExpiresAt: 1 });

// Virtual for full name
userSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`;
});

// Virtual for age calculated from dateOfBirth
userSchema.virtual('age').get(function() {
  if (!this.dateOfBirth) return null;
  const today = new Date();
  const birthDate = new Date(this.dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
});

// Ensure virtuals are included in JSON
userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

// Pre-save hook to set name field from firstName + lastName for backward compatibility
userSchema.pre('save', async function (next) {
  // Set name from firstName + lastName
  if (this.firstName && this.lastName) {
    this.name = `${this.firstName} ${this.lastName}`;
  }
  
  // Hash password with argon2id (legacy bcrypt hashes verify + upgrade on login).
  // Skip when the value is already an argon2id hash (transparent-upgrade path
  // assigns a finished hash — hashing it again would lock the user out).
  if (!this.isModified('password')) return next();

  // Stamp the change time in the SAME save as the new hash. Doing it here
  // rather than at each call site is the point: a route that forgets to set it
  // can no longer leave a fresh password looking like a year-old one.
  this.passwordChangedAt = new Date();

  if (!needsRehash(this.password)) return next();
  this.password = await hashPassword(this.password);
  next();
});

// Compare password method (argon2id current, bcrypt legacy)
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await verifyPassword(enteredPassword, this.password);
};

// Cascade delete — remove assessments + tracking data when a user is deleted
userSchema.post('findOneAndDelete', async function (doc) {
  if (doc) {
    const Assessment = require('./Assessment');
    const IntakeRecord = require('./IntakeRecord');
    const DashboardMetrics = require('./DashboardMetrics');
    const SubscriptionRequest = require('./SubscriptionRequest');
    const SubscriptionCancelRequest = require('./SubscriptionCancelRequest');
    const ChatThread = require('./ChatThread');
    const ChatMessage = require('./ChatMessage');
    // Messages first: a thread is the only handle that reaches them, so if the
    // process dies mid-cascade the transcript must not be left orphaned.
    const threadIds = await ChatThread.find({ user: doc._id }).select('_id').lean();
    await Promise.all([
      Assessment.deleteMany({ user: doc._id }),
      IntakeRecord.deleteMany({ user: doc._id }),
      DashboardMetrics.deleteMany({ user: doc._id }),
      // Plan requests carry a base64 receipt each; without this the admin queue
      // would keep rows for an account that no longer exists.
      SubscriptionRequest.deleteMany({ user: doc._id }),
      // Same reason: a cancellation queue full of rows for a deleted account is
      // work no reviewer can ever complete.
      SubscriptionCancelRequest.deleteMany({ user: doc._id }),
      // Support conversations: the threads themselves, and their transcripts.
      // ChatMessage carries a `user` field precisely so this cascade can find
      // them without a lookup through ChatThread.
      ChatThread.deleteMany({ user: doc._id }),
      ChatMessage.deleteMany({ user: doc._id }),
    ]);
    if (threadIds.length) {
      // Belt and braces: anything left by an interrupted earlier cascade.
      await ChatMessage.deleteMany({ thread: { $in: threadIds.map((t) => t._id) } });
    }
    console.log(`Cascade deleted assessments for user ${doc._id}`);
  }
});

userSchema.post('deleteOne', { document: true, query: false }, async function () {
  const Assessment = require('./Assessment');
  const IntakeRecord = require('./IntakeRecord');
  const DashboardMetrics = require('./DashboardMetrics');
  const SubscriptionRequest = require('./SubscriptionRequest');
  const SubscriptionCancelRequest = require('./SubscriptionCancelRequest');
  const ChatThread = require('./ChatThread');
  const ChatMessage = require('./ChatMessage');
  const threadIds = await ChatThread.find({ user: this._id }).select('_id').lean();
  await Promise.all([
    Assessment.deleteMany({ user: this._id }),
    IntakeRecord.deleteMany({ user: this._id }),
    DashboardMetrics.deleteMany({ user: this._id }),
    SubscriptionRequest.deleteMany({ user: this._id }),
    SubscriptionCancelRequest.deleteMany({ user: this._id }),
    ChatThread.deleteMany({ user: this._id }),
    ChatMessage.deleteMany({ user: this._id }),
  ]);
  if (threadIds.length) {
    await ChatMessage.deleteMany({ thread: { $in: threadIds.map((t) => t._id) } });
  }
  console.log(`Cascade deleted assessments for user ${this._id}`);
});

module.exports = mongoose.model('User', userSchema);
