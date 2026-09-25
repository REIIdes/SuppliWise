const mongoose = require('mongoose');
const { hashPassword, verifyPassword, needsRehash } = require('../utils/password');

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
      minlength: [2, 'First name must be at least 2 characters'],
      maxlength: [50, 'First name must be 50 characters or fewer'],
    },
    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
      minlength: [2, 'Last name must be at least 2 characters'],
      maxlength: [50, 'Last name must be 50 characters or fewer'],
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
    twoFactorSecret: {
      type: String,
      default: '',
      select: false,
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
    // Subscription window. `subscriptionStartedAt` marks activation;
    // `subscriptionExpiresAt` (null = open-ended) is evaluated at read time —
    // once it passes, entitlements fall back to the free tier automatically.
    subscriptionStartedAt: {
      type: Date,
      default: null,
    },
    subscriptionExpiresAt: {
      type: Date,
      default: null,
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
    await Promise.all([
      Assessment.deleteMany({ user: doc._id }),
      IntakeRecord.deleteMany({ user: doc._id }),
      DashboardMetrics.deleteMany({ user: doc._id }),
    ]);
    console.log(`Cascade deleted assessments for user ${doc._id}`);
  }
});

userSchema.post('deleteOne', { document: true, query: false }, async function () {
  const Assessment = require('./Assessment');
  const IntakeRecord = require('./IntakeRecord');
  const DashboardMetrics = require('./DashboardMetrics');
  await Promise.all([
    Assessment.deleteMany({ user: this._id }),
    IntakeRecord.deleteMany({ user: this._id }),
    DashboardMetrics.deleteMany({ user: this._id }),
  ]);
  console.log(`Cascade deleted assessments for user ${this._id}`);
});

module.exports = mongoose.model('User', userSchema);
