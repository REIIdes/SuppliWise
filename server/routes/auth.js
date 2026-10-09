const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const User = require('../models/User');
const AdminAccount = require('../models/AdminAccount');
const AdminEvent = require('../models/AdminEvent');
// The admin session policy (idle window, token lifetime, heartbeat interval) is
// defined ONCE in utils/adminSession.js and imported here. It used to be a second
// literal copy of the idle window in this file, with a comment saying the
// frontend countdown "must match" it — the client and the two server copies
// could each be edited independently and quietly disagree.
const {
  ADMIN_IDLE_LIMIT_SECONDS,
  ADMIN_IDLE_TIMEOUT_MS,
  ADMIN_TOKEN_LIFETIME,
  ADMIN_TOKEN_LIFETIME_SECONDS,
  ADMIN_HEARTBEAT_INTERVAL_MS,
  idleExceeded,
  countsAsActivity,
} = require('../utils/adminSession');
const { protect, rejectSession } = require('../middleware/auth');
const {
  issueUserSession,
  verifyUserSession,
  attachRememberToken,
  markSessionTrusted,
  mintFromRememberToken,
  revokeUserSession,
  revokeAllUserSessions,
  revokeOtherUserSessions,
  SESSION_INVALID,
  SESSION_ENDED_MESSAGE,
} = require('../utils/sessions');
const { describeSubscription } = require('../utils/entitlements');
const SecurityEvent = require('../models/SecurityEvent');
const { describeDevice } = require('../utils/device');
const { sendOtpEmail, sendPasswordChangedEmail } = require('../utils/email');
const { evaluatePassword } = require('../utils/passwordRules');
// The link-based password reset lives in its own router; these four legacy
// OTP endpoints are aliases onto the same service. See the block below.
const passwordResetService = require('../utils/passwordReset');
const { normalizeIp, ipKind, resolveLoginLocation } = require('../utils/geo');
const { verifyTotpOnce } = require('../utils/totp');
// The TOTP seed is read and written through ONE module, which is what
// guarantees it is always encrypted at rest and always migrated off the legacy
// plaintext field on first use. No route touches `twoFactorSecret*` directly.
const totpSecret = require('../utils/totpSecret');
// The MFA transaction: the server-side MFA_REQUIRED state that replaces a bare
// user id at the second factor. See utils/mfaTransaction.js.
const mfaTransaction = require('../utils/mfaTransaction');
const rateLimits = require('../utils/rateLimits');
const Passkey = require('../models/Passkey');
const BackupCode = require('../models/BackupCode');
const MfaTransaction = require('../models/MfaTransaction');
const { publicUser, completeSignIn, AUTH_METHODS } = require('../utils/authFlow');
const { newChallenge, verifyCaptcha } = require('../utils/captcha');
// Profile/banner images are stored on disk and referenced by URL, never held
// inline on the document. `safePictureValue` is the guard that keeps a
// response from ever shipping a multi-megabyte base64 payload again.
const {
  storePicture,
  safePictureValue,
  MAX_AVATAR_BYTES: MAX_PROFILE_BYTES,
  MAX_BANNER_BYTES,
} = require('../utils/pictures');

// Math CAPTCHA challenge for registration (bot-resistant signup).
// Public but rate-limited with the rest of /api/auth.
router.get('/captcha', (req, res) => {
  res.json(newChallenge());
});
const { recordOffense, recordOtpOffense, recordAccountFailure, lockRemainingMs, clearOffenses, clearAccountState, accountKey, limitReachedHandler, reportAccountLockout, deviceFingerprint, noteIpAccountFailure, clearIpAccountFailures, stuffingCooldownMs, lockMeta } = require('../utils/lockout');

// lockMeta (the evidence bundle attached to lockout entries) now lives in
// utils/lockout.js so every caller builds the same shape.

/**
 * The credential-stuffing tripwire, applied where a failure is detected.
 *
 * An address that has failed on many DISTINCT accounts is slowed down — but
 * only on its failed attempts. It used to be escalated onto the escalating IP
 * ladder, which `lockoutCheck` reads as a hard stop on the whole /api/auth
 * surface: three ordinary typos from one address locked EVERY user behind it
 * out of every sign-in for 15 minutes, including attempts carrying the correct
 * password, and nothing but waiting cleared it. See utils/lockout.js.
 *
 * Refusing the failed attempt is enough to make spraying uneconomic, and it
 * cannot deny service to a user who knows their own password.
 *
 * @returns true when the caller should answer 429 instead of 401.
 */
function tripwireThrottle(res, ip) {
  const left = stuffingCooldownMs(ip);
  if (left <= 0) return false;
  res.set('Retry-After', String(Math.ceil(left / 1000)));
  return true;
}

// Stricter brute-force guard for the most sensitive auth steps (admin login,
// 2FA and OTP verification). Layered on top of the global /api/auth limiter;
// every 429 climbs the 15 min → 1 day lockout ladder.
// The ceiling is configuration, not a literal — see utils/rateLimits.js for why,
// including what happens when the value is missing or nonsense. The default is
// unchanged from what it always was. Every 429 still climbs the
// 15 min → 1 day lockout ladder below; this only decides when the first 429 is.
const rateLimit = require('express-rate-limit');
const sensitiveLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: rateLimits.limit('AUTH_SENSITIVE_RATE_LIMIT_MAX', 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait 10 minutes and try again.' },
  handler: limitReachedHandler('Too many attempts. Lockout escalated — please wait and try again.'),
});
router.use(
  [
    '/login',
    '/admin-login',
    '/verify-admin-2fa',
    '/login-2fa',
    '/verify-login-otp',
    '/forgot-password',
    '/reset-password',
    '/resend-login-otp',
    '/resend-password-reset-otp',
    '/verify-password-reset-otp',
    '/verify-email-otp',
    '/request-email-otp',
  ],
  sensitiveLimiter
);

// Instant, offline location label for a login.
//
// The client-supplied `x-login-location` header is DELIBERATELY IGNORED. It
// used to win outright, which meant the "location" stored against a sign-in —
// and later shown to the user as evidence about their own account — was
// whatever the caller typed. That is attacker-controlled text presented as if
// the server had determined it. Only server-derivable facts are used now, and
// the background resolver fills in the real geo location for public IPs.
function describeIpLocation(headerValue, rawIp) {
  const ip = normalizeIp(rawIp);
  const kind = ipKind(ip);
  if (kind === 'loopback') return 'This device';
  if (kind === 'private') return 'Local network';
  return 'Unknown location';
}

// In-memory OTP storage (in production, use Redis or database)
//
// Format: { <purposeAndSubject>: { digest, expiresAt, createdAt, requestedAt, attempts, maxAttempts } }
//
// WHAT IS *NOT* IN HERE
// --------------------
// The entry holds an HMAC digest, never the code. It used to hold `otp: "123456"`
// in plaintext for the whole life of the challenge, which meant anything that
// could read this process's memory — a heap dump, a crash reporter, a stray
// `console.log(store)`, a debugger attached to a dev box — held live sign-in
// codes that were still redeemable. utils/otpChallenge.js owns the digest and
// the constant-time comparison; this file only decides WHEN an entry exists.
const otpStore = new Map();

// Generation, storage representation and atomic single-use consumption of
// emailed codes. One module, so the login, email-change and recovery-email
// flows cannot each invent their own weaker version.
const otpChallenge = require('../utils/otpChallenge');

// Plaintext OTPs must not accumulate for the process lifetime. Entries were
// only removed when a code was verified, exhausted, or re-requested on the same
// key — so a request that was simply abandoned (or an address that never
// completed the flow) held its plaintext code forever. Prune on write once the
// store grows, and on a timer.
const OTP_STORE_MAX = 5000;
function pruneOtpStore() {
  const now = Date.now();
  for (const [key, entry] of otpStore) {
    if (!entry || !(entry.expiresAt > now)) otpStore.delete(key);
  }
  // If pruning by expiry is not enough (every code still live), drop the
  // oldest by requestedAt until back under the ceiling.
  if (otpStore.size <= OTP_STORE_MAX) return;
  const byAge = [...otpStore.entries()].sort(
    (a, b) => (a[1] && a[1].requestedAt) - (b[1] && b[1].requestedAt)
  );
  for (let i = 0; i < byAge.length && otpStore.size > OTP_STORE_MAX; i += 1) {
    otpStore.delete(byAge[i][0]);
  }
}
const otpStoreSweeper = setInterval(pruneOtpStore, 5 * 60 * 1000);
if (typeof otpStoreSweeper.unref === 'function') otpStoreSweeper.unref();

// Server-side proof that an address-change OTP was really verified for THIS
// account. The previous flow trusted an `emailVerified` flag supplied by the
// request body, so a stolen session could rebind the account to any address
// it liked without ever proving control of it (and then use "forgot
// password" to take the account over). Verification now records WHICH
// address was proven and for how long; PUT /profile accepts only that exact
// address and ignores anything the client claims.
const emailChangeProofs = new Map(); // userId -> { email, expiresAt }
const EMAIL_PROOF_TTL_MS = 15 * 60 * 1000; // one verification round must finish within 15 min

// Logs land in shared stdout/log files, so they must never contain a full
// email address. Keeps the first character of the local part plus the domain
// so an incident stays diagnosable without exposing PII.
function maskEmail(value) {
  const email = str(value);
  const at = email.indexOf('@');
  if (at <= 0) return '[redacted]';
  return `${email[0]}***@${email.slice(at + 1)}`;
}

// Small hardening helper — guarantees a string before .trim() so crafted
// JSON types (objects/arrays for NoSQL injection) get a clean 400, never a 500.
const str = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

/**
 * True when a failure is OUR infrastructure being briefly unavailable, not
 * anything the caller did. Shared with routes/passwordReset.js — see
 * utils/transientError.js.
 */
const { isTransientInfrastructureError } = require('../utils/transientError');

/**
 * Report a failed auth request honestly.
 *
 * Infrastructure trouble is a 503 (retryable, and says so). Everything else
 * keeps the generic 500, so no internal detail is ever handed to a caller.
 */
function authFailure(res, error, context) {
  console.error(`[${context}]`, error.message);
  if (isTransientInfrastructureError(error)) {
    res.set('Retry-After', '5');
    return res.status(503).json({
      message: 'We could not reach our servers just now. Please try again in a moment.',
    });
  }
  return res.status(500).json({ message: 'Something went wrong. Please try again later.' });
}

// Max wrong-code attempts per OTP before it is invalidated (brute-force guard).
// Owned by utils/otpChallenge.js so the login, email-change and recovery-email
// flows cannot drift apart — they used to be independent implementations, and
// the recovery-email one had no limit at all.
const MAX_OTP_ATTEMPTS = otpChallenge.MAX_ATTEMPTS;

// How long a one-time code stays valid. Defined once and used by issueOtp() so
// every issuing route grants the same window — it used to be a literal
// `10 * 60 * 1000` repeated at each of the five call sites, where one site
// could be edited without the others and codes would silently disagree.
//
// Five minutes, down from ten. The window is a pure security parameter: it is
// the amount of time an attacker who has intercepted or triggered a code has to
// guess it, and the emailed code is only 6 digits (~20 bits of entropy). Five
// minutes is ample for someone to open a mail client, read a code and type it;
// ten minutes doubles the guessing window for no usability gain that matters.
// The MFA transaction that gates the session is minted independently and lasts
// 10 minutes for the email path, so this does not shorten the sign-in window —
// it only stops an unredeemed code from staying useful for as long.
const OTP_TTL_MS = 5 * 60 * 1000;

// How long a single delivery may take before it is treated as failed. The
// transporter is pooled, so a healthy relay answers in a few hundred ms; this
// bound exists only so a hung SMTP server can never hold a sign-in open
// forever, turning a slow mail server into a dead login button.
const OTP_DELIVERY_TIMEOUT_MS = 10000;

// A one-time code is only useful if it can be DELIVERED, so delivery is part
// of the request and its real outcome is what the caller answers with.
//
// WHY THIS IS NOT FIRE-AND-FORGET
// --------------------------------
// It used to be. The route answered "Verification code sent to your email
// successfully" immediately and kicked the send into the background — and when
// the send failed, the failure handler DELETED the pending code from the store.
// That is the code the client had just been told to wait for, so
// /verify-login-otp answered "No OTP request found. Please try logging in
// again." while the sign-in modal sat open on screen.
//
// The visible effect was that the entire user login was contingent on the mail
// provider being healthy: a revoked Gmail app password, a Gmail outage, a
// quota block or a momentary network blip locked every user out of their own
// account, with the UI instructing them to check an inbox that would never
// receive anything. The user is now told the truth instead — a code exists only
// once the mail has actually gone out.
//
// A one-time code can be delivered for a dev only when the operator has
// explicitly opted in: without a mailbox there is no other way to finish a
// login locally, and a dev that cannot be signed into is a dev that gets tested
// by weakening the checks instead.
//
// OFF unless LOG_OTP_IN_CONSOLE is explicitly truthy. It is never on by
// default, it never logs in production (see the NODE_ENV guard), and the email
// is masked so the line is not a map of who has an account.
//
// THE GUARD IS NOW AN ALLOWLIST, NOT A DENYLIST
// ---------------------------------------------
// It used to ask only "is NODE_ENV *not* production?". That is a denylist, and a
// denylist fails open on any value it does not recognise — a staging box with
// NODE_ENV=stage, a container image with NODE_ENV unset, a typo'd
// NODE_ENV=prodution. Every one of those would have printed live sign-in codes
// into a log aggregator.
//
// It now requires NODE_ENV to be one of the three values that mean "a developer's
// own machine", so anything unrecognised is treated as production. This is the
// one place in the application where a code is written to a log at all, and it
// is scoped as narrowly as the requirement allows while keeping local sign-in
// possible.
const DEV_ENVIRONMENTS = new Set(['development', 'dev', 'test']);
function logOtpToConsole(toEmail, otp, type) {
  const optedIn = /^(1|true|yes|on)$/i.test(String(process.env.LOG_OTP_IN_CONSOLE || ''));
  const localDev = DEV_ENVIRONMENTS.has(String(process.env.NODE_ENV || '').trim().toLowerCase());
  if (optedIn && localDev) {
    console.log(`[otp] ${type} code for ${maskEmail(toEmail)}: ${otp}`);
  }
}

// Deliver a code and report whether it really went out. Never throws.
// @returns {Promise<boolean>} true only when the mail was handed to the relay.
async function deliverOtp(toEmail, otp, type) {
  logOtpToConsole(toEmail, otp, type);
  let timer = null;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), OTP_DELIVERY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const outcome = await Promise.race([sendOtpEmail(toEmail, otp, type), expiry]);
    if (outcome === 'timeout') {
      console.error(`[otp-email] ${type} delivery to ${maskEmail(toEmail)} timed out after ${OTP_DELIVERY_TIMEOUT_MS}ms`);
      return false;
    }
    if (outcome !== true) {
      console.error(`[otp-email] delivery failed (${type}) to ${maskEmail(toEmail)}`);
    }
    return outcome === true;
  } catch (err) {
    console.error(`[otp-email] delivery error (${type}) for ${maskEmail(toEmail)}: ${err.message}`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Generate a code, deliver it, and only THEN make it real.
//
// The store is written on success and left untouched on failure, so a code the
// user never received can never be accepted, never counts as a wrong attempt,
// and can never be used to burn the account's lockout ladder. The 30s cooldown
// is released on failure so an honest user whose mail bounced can retry
// immediately instead of being told to wait for a code that never existed.
//
// Issuing REPLACES any previous entry under the same key, which is what
// invalidates the old code on a resend: one live code per purpose per subject,
// never two. There is no documented security reason to keep an older code valid
// alongside its replacement, and keeping both would mean a code an attacker
// captured from an earlier mail still worked.
//
// @returns {Promise<{ok: true, otp: string} | {ok: false}>}
async function issueOtp(toEmail, otpKey, rateKey, type) {
  const otp = otpChallenge.generateOtp();
  const delivered = await deliverOtp(toEmail, otp, type);
  if (!delivered) {
    if (rateKey) otpRateLimitMap.delete(rateKey);
    return { ok: false };
  }
  // Only the HMAC digest is stored. See otpChallenge.js for why a bare hash of a
  // 6-digit value would not be a protection.
  otpStore.set(otpKey, otpChallenge.buildEntry({
    otp,
    context: otpKey,
    ttlMs: OTP_TTL_MS,
    maxAttempts: MAX_OTP_ATTEMPTS,
  }));
  if (rateKey) otpRateLimitMap.set(rateKey, Date.now());
  return { ok: true, otp };
}

// The single answer every OTP-issuing route gives when the mail did not go
// out. Deliberately free of `requiresOtp`/`userId`: the client must stay on
// the form and show this message rather than opening a verification step for a
// code that does not exist.
function otpDeliveryFailed(res) {
  return res.status(503).json({
    message: 'We could not send your verification code. Please wait a moment and try again.',
  });
}

// The one message every wrong-code rejection shares.
//
// Two things are deliberately collapsed into it. First, "expired", "never
// issued", "already used" and "wrong code" are indistinguishable, so this route
// cannot be used to probe which challenges exist. Second, the wording does not
// tell the caller whether the challenge still has attempts left, which would let
// an attacker calibrate how far through the budget they are without ever
// triggering the lock.
//
// Kept as a function rather than a literal because it is now quoted by three
// call sites and by the tests that pin the contract.
const OTP_REJECTION_MESSAGE = 'That verification code is not valid.';

// Rate limiting map for OTP requests
const otpRateLimitMap = new Map(); // Format: { userId: lastRequestTime }
const OTP_COOLDOWN_MS = 30000; // 30 seconds cooldown

// The answer given whenever /resend-login-otp cannot act: unknown account,
// inside the cooldown, or a malformed id.
//
// One string for all three so the route cannot be used to tell them apart. See
// the comment at the call site for why "User not found" was itself the bug.
const RESEND_GENERIC_MESSAGE =
  'If that sign-in attempt is still valid, a new verification code is on its way. '
  + 'Check your inbox — and your spam folder if it does not arrive within a few minutes.';

// Generate JWT (admin sessions only — users are minted by issueUserSession).
// User tokens are issued WITHOUT an `exp` and WITH a `sid` (session id):
// they live until a newer sign-in replaces that session (one active session
// per account) or the user signs out — i.e. sessions never expire on their
// own. Admin sessions keep a short sliding TTL via their own expiresIn option.
const generateToken = (id, claims = {}, options = {}) => {
  const finalOptions = { ...options };
  if (finalOptions.expiresIn === null) {
    delete finalOptions.expiresIn;
  }
  return jwt.sign({ id, ...claims }, process.env.JWT_SECRET, finalOptions);
};

const adminChallenges = new Map();
const ADMIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function legacyAdminConfiguration() {
  return {
    alias: String(process.env.ADMIN_ALIAS || '').trim(),
    passwordHash: String(process.env.ADMIN_PASSWORD_HASH || '').trim(),
    totpSecret: String(process.env.ADMIN_TOTP_SECRET || '').trim(),
  };
}

// The token must outlive the idle window, or an administrator who is actively
// working gets signed out by token expiry while their countdown still shows
// time in hand. adminSession.js asserts that ordering at import time, so the
// lifetimes here and in the middleware cannot drift apart.
function adminToken(account) {
  return generateToken(String(account._id), { role: 'admin', alias: account.alias, adminId: String(account._id) }, { expiresIn: ADMIN_TOKEN_LIFETIME });
}

// Email validation is shared with /api/security (recovery email) so both
// surfaces accept and reject exactly the same addresses.
const { isValidEmail } = require('../utils/emailValidation');

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post('/register', async (req, res) => {
  const { firstName, lastName, name, email, password, dateOfBirth, gender, captchaId, captchaAnswer } = req.body;

  try {
    // Bot check: server-issued math CAPTCHA, single-use
    if (!verifyCaptcha(captchaId, captchaAnswer)) {
      return res.status(400).json({ message: 'Please solve the math challenge correctly.', captchaFailed: true });
    }
    if (password !== undefined && typeof password !== 'string') {
      return res.status(400).json({ message: 'Please provide a valid password.' });
    }
    // Support both new format (firstName + lastName) and old format (name)
    let first, last;
    
    if (firstName && lastName) {
      // New format
      first = str(firstName).trim();
      last = str(lastName).trim();
    } else if (name) {
      // Old format - split name into first and last
      const parts = str(name).trim().split(/\s+/);
      first = parts[0] || '';
      last = parts.slice(1).join(' ') || parts[0] || ''; // If only one word, use it for both
    } else {
      return res.status(400).json({ message: 'Please fill in all fields.' });
    }

    if (!email || !password || !dateOfBirth || !gender) {
      return res.status(400).json({ message: 'Please fill in all fields.' });
    }

    // Name validation (control characters stripped — logs, PDFs and UI stay clean)
    const cleanName = (value) => str(value).replace(/[\x00-\x1F\x7F]/g, '').trim();
    first = cleanName(first);
    last = cleanName(last);
    if (first.length < 2) {
      return res.status(400).json({ message: 'First name must be at least 2 characters.' });
    }
    if (first.length > 50) {
      return res.status(400).json({ message: 'First name must be 50 characters or fewer.' });
    }
    if (last.length < 2) {
      return res.status(400).json({ message: 'Last name must be at least 2 characters.' });
    }
    if (last.length > 50) {
      return res.status(400).json({ message: 'Last name must be 50 characters or fewer.' });
    }

    // Gender validation
    if (!['Male', 'Female'].includes(gender)) {
      return res.status(400).json({ message: 'Please select a valid gender.' });
    }

    // Email validation (RFC 5321: 254 chars max)
    const trimmedEmail = str(email).trim().toLowerCase();
    if (trimmedEmail.length > 254 || !isValidEmail(trimmedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address (e.g. name@example.com).' });
    }

    // Date of birth validation (must be an ISO date string, not a timestamp/object)
    if (typeof dateOfBirth !== 'string') {
      return res.status(400).json({ message: 'Please enter a valid date of birth.' });
    }
    const birthDate = new Date(dateOfBirth);
    if (isNaN(birthDate.getTime())) {
      return res.status(400).json({ message: 'Please enter a valid date of birth.' });
    }
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    if (age < 1 || age > 120) {
      return res.status(400).json({ message: 'Please enter a valid date of birth (age must be between 1 and 120).' });
    }

    // Password validation — the ONE policy (utils/passwordRules.js), shared
    // with /reset-password and /change-password. These were four hand-written
    // literals that had already drifted: this route capped the length at 128
    // and the other two did not, so a reset would hand an unbounded string to
    // argon2. The message names the one missing requirement.
    const passwordVerdict = evaluatePassword(password, { email: trimmedEmail });
    if (!passwordVerdict.ok) {
      return res.status(400).json({ message: passwordVerdict.message });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: trimmedEmail });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already registered.' });
    }

    // Create user
    const user = await User.create({ 
      firstName: first, 
      lastName: last, 
      email: trimmedEmail, 
      password,
      dateOfBirth: birthDate,
      gender
    });

    res.status(201).json({
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.fullName,
      email: user.email,
      dateOfBirth: user.dateOfBirth,
      age: user.age,
      gender: user.gender,
      profilePicture: safePictureValue(user.profilePicture),
      bannerPicture: safePictureValue(user.bannerPicture),
      subscriptionActive: user.subscriptionActive,
      subscriptionPlan: user.subscriptionPlan,
      // Resolved entitlement snapshot (honours expiry/cancellation) so the
      // client never bootstraps a stale plan from raw fields alone.
      subscription: describeSubscription(user),
      // New account → first session becomes the account's active session.
      token: await issueUserSession(user._id, describeDevice({
        userAgent: req.get('user-agent'), ip: req.ip,
      })),
    });
  } catch (error) {
    console.error('[register]', error.message);
    // Pass Mongoose validation errors through cleanly; hide everything else
    if (error.name === 'ValidationError') {
      const msg = Object.values(error.errors).map(e => e.message).join(' ');
      return res.status(400).json({ message: msg });
    }
    // Registration race (two simultaneous signups): friendly duplicate message
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Email already registered.' });
    }
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// @route   POST /api/auth/login
// @desc    Login user - Step 1: Validate credentials and send OTP
// @access  Public
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ message: 'Please fill in all fields.' });
    }

    const trimmedEmail = str(email).trim().toLowerCase();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }

    // Account lockout: continuous failures escalate 15 min → 1 day
    const emailLockKey = accountKey('email', trimmedEmail);
    const emailLockedMs = lockRemainingMs(emailLockKey);
    if (emailLockedMs > 0) {
      reportAccountLockout({ email: trimmedEmail, minutes: Math.ceil(emailLockedMs / 60000), lockKey: emailLockKey });
      return res.status(429).json({
        message: `Too many failed attempts. Try again in ${Math.ceil(emailLockedMs / 60000)} minute(s).`,
        remainingSeconds: Math.ceil(emailLockedMs / 1000),
        escalated: true,
        lockedBy: 'account',
      });
    }

    // Read ONLY what sign-in needs.
    //
    // This used to be an unprojected `User.findOne({ email })`, which pulled the
    // account's ENTIRE document. With images stored inline (see
    // utils/pictures.js) that was a ~3 MB read on every single sign-in — ~30 s
    // each way over the Atlas link — and the route then called `user.save()`
    // below, writing the same multi-megabyte document straight back. Sign-in
    // could not finish inside any client timeout, and the resulting socket
    // error surfaced as "We could not reach our servers just now." Excluding
    // the pictures here makes the sign-in read a few kilobytes regardless of
    // what the account is carrying.
    //
    // The secret is additionally REQUESTED (`+twoFactorSecret`): it is
    // `select: false`, and the 2FA decision below has to be able to tell "this
    // account has a working authenticator" from "this account claims one but has
    // no secret", which would be a challenge nobody can satisfy. See
    // usesAuthenticator below.
    const user = await User.findOne({ email: trimmedEmail })
      .select('-profilePicture -bannerPicture +twoFactorSecret +twoFactorSecretEnc');

    // Enumeration-safe rejection. An unknown address and a wrong password must
    // be indistinguishable in BOTH message and timing:
    //
    //   • Same 401, same body. (Already true.)
    //   • Same lockout behaviour. This used to record a failure ONLY when the
    //     account existed, so a real account eventually answered 429 while a
    //     nonexistent one stayed 401 forever — which confirms the account
    //     exists to anyone patient enough to send 3 bad passwords.
    //   • Comparable work. The unknown-user path hashes a throwaway password so
    //     it costs roughly what matchPassword costs, instead of returning in
    //     microseconds and leaking existence through response time.
    if (!user) {
      recordAccountFailure(emailLockKey, lockMeta(req, req.ip));
      noteIpAccountFailure(req.ip, trimmedEmail);
      const { burnPasswordCompare } = require('../utils/password');
      await burnPasswordCompare();
      // Recorded against the submitted address where possible, but with no
      // account to own it we cannot attach a user id — so this stays a lockout
      // signal only, never a row in somebody's history.
      if (tripwireThrottle(res, req.ip)) {
        return res.status(429).json({ message: 'Too many failed sign-in attempts from this network. Please wait a few minutes and try again.' });
      }
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      recordAccountFailure(emailLockKey, lockMeta(req, req.ip));
      noteIpAccountFailure(req.ip, trimmedEmail);
      await SecurityEvent.write({
        user: user._id, type: 'login-failure', success: false,
        ip: req.ip, userAgent: req.get('user-agent'),
        location: user.lastLoginLocation || '',
        reason: 'Incorrect password',
      });
      if (tripwireThrottle(res, req.ip)) {
        return res.status(429).json({ message: 'Too many failed sign-in attempts from this network. Please wait a few minutes and try again.' });
      }
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    // Banned/inactive check runs ONLY after the password is proven. Checking
    // it first was an unauthenticated oracle: a wrong password on a banned
    // account answered 403 instead of 401, confirming both that the account
    // exists and that it was banned — without ever knowing the password.
    if (user.accountStatus && user.accountStatus !== 'active') {
      return res.status(403).json({ message: user.accountStatus === 'banned' ? 'This account has been banned.' : 'This account is no longer active.' });
    }

    // Correct password resets strikes and ladder locks
    clearAccountState(emailLockKey);
    // ...and clears the stuffing tripwire too. A correct password is proof a
    // human is at this address, so a shared address (household, office, campus)
    // heals the moment anyone on it signs in properly instead of staying one
    // typo away from a throttled network for the rest of the window.
    clearIpAccountFailures(req.ip);
    // Transparent hash upgrade: legacy bcrypt → argon2id on successful login
    try {
      const { upgradeHashIfLegacy } = require('../utils/password');
      const upgraded = await upgradeHashIfLegacy(password, user.password);
      if (upgraded) user.password = upgraded;
    } catch { /* upgrade best-effort; login already succeeded */ }

    const previousUserAgent = user.lastLoginUserAgent;
    const loginIp = req.ip;
    user.lastLoginAt = new Date();
    user.lastLoginIp = loginIp;
    user.lastLoginUserAgent = String(req.get('user-agent') || '').slice(0, 500);
    // Server-derived only. The client's x-login-location header is ignored —
    // it is caller-controlled text and this value is shown back to the user as
    // where they signed in from.
    user.lastLoginLocation = describeIpLocation('', loginIp);

    // Recording WHERE and WHEN the user signed in is incidental bookkeeping.
    // It must never be able to deny a sign-in that has already been proven by
    // the password.
    //
    // The document is saved with `user.save()` inside a try/catch, and that
    // catch is load-bearing. It used to be a bare `await user.save()`, so ANY
    // failure surfaced as a 500 "Something went wrong. Please try again later."
    // AFTER the correct password had been accepted — a permanent lockout with
    // no recourse, because it failed identically every time. It was reproduced
    // by a user document holding a name the current validation rules reject:
    // `User validation failed: lastName`. Nothing about signing in depends on
    // the "last seen" fields, so a bad one is a reason to log, not to refuse.
    //
    // This used to be catastrophically slow as well. A `save()` sends the
    // changed paths of the whole document, and the read above used to load the
    // entire account including its inline base64 banner (~3 MB), so stamping a
    // timestamp meant re-uploading those megabytes — ~30 s over the Atlas link,
    // which is what made the login button unusable. The projection above means
    // the document in memory is a few kilobytes and this write is now a tiny
    // delta. It also carries the transparent bcrypt → argon2id hash upgrade,
    // which the pre-save hook persists for us.
    try {
      await user.save();
    } catch (err) {
      // Name the account (masked) and the reason, so it is diagnosable — a
      // document that can never be written is a data problem someone must fix.
      // Nothing after this point saves the document again, so the sign-in
      // simply continues.
      console.error(`[login] could not record sign-in metadata for ${maskEmail(user.email)}: ${err.message}`);
    }
    const isNewDevice = !!(previousUserAgent && previousUserAgent !== user.lastLoginUserAgent);
    if (isNewDevice) {
      AdminEvent.create({ type: 'new-device-login', title: 'New device login', detail: `${user.email} signed in from ${user.lastLoginLocation}.`, user: user._id }).catch(() => {});
    }
    // Neutral wording on purpose: an unfamiliar device is worth a look, not
    // proof of an attack.
    await SecurityEvent.write({
      user: user._id,
      type: isNewDevice ? 'unrecognized-login' : 'login-success',
      success: true,
      ip: loginIp,
      userAgent: user.lastLoginUserAgent,
      location: user.lastLoginLocation,
      reason: isNewDevice ? 'Signed in from a device not seen before' : 'Password accepted',
    });
    if (isNewDevice) {
      try {
        const UserNotification = require('../models/UserNotification');
        await UserNotification.create({
          user: user._id, type: 'info', title: 'New sign-in to your account',
          detail: `Your account was signed in from a device we had not seen before (${user.lastLoginLocation || 'location unknown'}). If this wasn't you, change your password and sign out other devices.`,
        }).catch(() => {});
        if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
          const { sendStatusEmail } = require('../utils/email');
          await sendStatusEmail(user.email, 'new-device', {}).catch(() => {});
        }
      } catch { /* best-effort */ }
    }

    // Which second factor this account uses. Rows written before the field
    // existed have no value, and the fallback is deliberately 'authenticator':
    // an account that already had 2FA on was using an authenticator app, and
    // defaulting them to email here would silently downgrade their login.
    const twoFactorMethod = user.twoFactorMethod || 'authenticator';
    // An authenticator challenge is only satisfiable if there IS a secret to
    // check the code against. The login read therefore has to ask for it
    // explicitly — `twoFactorSecret` is `select: false`, so it is absent unless
    // requested.
    //
    // WHY THE SECRET IS CHECKED
    // ------------------------
    // `twoFactorEnabled` can be true while no secret exists: the flag and the
    // secret are written by different code paths, and a half-finished setup (or
    // a document edited by a script) leaves the flag behind. The route used to
    // branch on the flag alone and answer "Google Authenticator verification
    // required." — a code that can never be produced, because there is nothing
    // to produce it from. The account was then permanently locked out of its
    // own second factor, with no recourse and no way for the holder to tell
    // that was why. A real account (one that HAS set up an authenticator) is
    // unaffected; only the impossible state falls through to the emailed code.
    // Both secret fields are `select: false`, so the login read has to ask for
    // them explicitly — the raw one is legacy, the sealed one is current. See
    // utils/totpSecret.js.
    const usableSecret = totpSecret.readSecret(user);
    const usesAuthenticator = user.twoFactorEnabled === true
      && twoFactorMethod === 'authenticator'
      && Boolean(usableSecret);

    // Lazily re-seal a pre-encryption seed now that the password is proven and
    // the secret is in hand. This is the moment we know the encryption key
    // works, which is the only safe moment to migrate.
    if (totpSecret.migrateInPlace(user)) await user.save().catch(() => {});

    if (user.twoFactorEnabled === true && twoFactorMethod === 'authenticator' && !usableSecret) {
      // Data problem, not a credential problem: record it so it is diagnosable
      // rather than silently papering over it forever.
      console.error(
        `[login] account ${maskEmail(user.email)} has twoFactorEnabled with no readable two-factor secret — `
        + 'falling back to an emailed code so the account is not locked out. Re-run 2FA setup for it.'
      );
    }

    // The second factor is a TRANSACTION now, not a bare user id.
    //
    // The response used to hand the client `userId` and let the next call spend
    // a code against it, which made the second factor sufficient on its own: a
    // valid TOTP or recovery code plus a guessable Mongo id bought a full
    // session, with the password never involved at any point.
    //
    // What replaces it is a single-use, short-lived, server-side transaction
    // that only the password step can open. The client gets an opaque token
    // meaning "this account's password was verified here, minutes ago" and
    // nothing more: no authority, no access to anything, no replay value.
    //
    // `userId` is STILL returned, and the second-factor routes still accept it,
    // but only while a live transaction exists for that account. A stale PWA
    // build still works, because it always comes through /login first; the
    // bypass is closed either way.
    // The counts below are only meaningful for an account that HAS a second
    // factor, and they run on every password submission — so they are skipped
    // entirely otherwise. An account with no 2FA cannot redeem a recovery code
    // and has no passkey challenge in this flow, and the two extra round-trips
    // on the hottest path in the application buy nothing.
    let passkeyCount = 0;
    let backupCount = 0;
    if (user.twoFactorEnabled === true) {
      [passkeyCount, backupCount] = await Promise.all([
        Passkey.countDocuments({ user: user._id }),
        BackupCode.countDocuments({ user: user._id, usedAt: null }),
      ]);
    }
    const mfaMethods = mfaTransaction.methodsFor(
      { twoFactorEnabled: user.twoFactorEnabled, twoFactorMethod },
      { passkeys: passkeyCount, backupCodeCount: backupCount },
    );
    const mfaToken = await mfaTransaction.start({
      user: user._id,
      methods: mfaMethods,
      ip: loginIp,
      userAgent: user.lastLoginUserAgent,
      location: user.lastLoginLocation,
      primaryMethod: 'password',
      // The emailed-code branch needs longer: the user has to go and read mail.
      // Extra 2-minute buffer added to absorb clock skew between server and Atlas.
      ttlMs: mfaMethods.includes('email-otp') ? 12 * 60 * 1000 : mfaTransaction.DEFAULT_TTL_MS,
    });

    await SecurityEvent.write({
      user: user._id,
      type: 'mfa-challenge-created',
      success: true,
      ip: loginIp,
      userAgent: user.lastLoginUserAgent,
      location: user.lastLoginLocation,
      reason: usesAuthenticator ? 'Authenticator code required' : 'Verification code required',
      meta: { factor: usesAuthenticator ? 'totp' : 'email-otp', authMethod: 'password' },
    });

    if (usesAuthenticator) {
      // Kick off background geo-resolution (never blocks the response)
      resolveLoginLocation(user._id, loginIp, user.lastLoginLocation);
      return res.json({
        requiresTwoFactor: true,
        userId: user._id,
        mfaTransaction: mfaToken,
        mfaMethods,
        message: 'Google Authenticator verification required.',
      });
    }

    // Credentials valid - issue the code, but only if it can actually be
    // delivered. Announcing a code that was never sent is what used to strand
    // users on a verification step with nothing valid to type.
    const issued = await issueOtp(trimmedEmail, `login_${user._id}`, user._id.toString(), 'login');
    if (!issued.ok) {
      // The password WAS correct, so the account is not locked and the attempt
      // is not counted against it — this is a delivery failure on our side.
      return otpDeliveryFailed(res);
    }
    // Geo-resolve the login IP in the background too (never blocks login)
    resolveLoginLocation(user._id, loginIp, user.lastLoginLocation);

    res.json({
      message: 'Verification code sent to your email successfully',
      requiresOtp: true,
      userId: user._id,
      mfaTransaction: mfaToken,
      mfaMethods,
      // Lets the client label the step honestly: "your second factor" when the
      // user chose email as their method, plain email verification otherwise.
      twoFactorMethod: user.twoFactorEnabled === true ? 'email' : null,
    });
  } catch (error) {
    return authFailure(res, error, 'login');
  }
});

// Admin credentials are deliberately isolated from public user accounts.
// ADMIN_PASSWORD_HASH must be an argon2id (or legacy bcrypt) hash; plaintext admin passwords are never accepted.
router.post('/admin-login', async (req, res) => {
  const { alias, password } = req.body || {};
  if (typeof alias !== 'string' || typeof password !== 'string') {
    return res.status(401).json({ message: 'Invalid admin credentials.' });
  }

  // Account lockout: continuous failures escalate 15 min → 1 day
  const aliasLockKey = accountKey('admin', alias);
  const aliasLockedMs = lockRemainingMs(aliasLockKey);
  if (aliasLockedMs > 0) {
    reportAccountLockout({ alias: str(alias).trim(), minutes: Math.ceil(aliasLockedMs / 60000), lockKey: aliasLockKey });
    return res.status(429).json({
      message: `Too many failed attempts. Try again in ${Math.ceil(aliasLockedMs / 60000)} minute(s).`,
      remainingSeconds: Math.ceil(aliasLockedMs / 1000),
      escalated: true,
      lockedBy: 'account',
    });
  }

  let account = await AdminAccount.findOne({ alias: str(alias).trim(), enabled: true }).select('+passwordHash +totpSecret');
  if (!account) {
    const legacy = legacyAdminConfiguration();
    if (legacy.alias !== str(alias).trim() || !legacy.passwordHash || !legacy.totpSecret) return res.status(401).json({ message: 'Invalid admin credentials.' });
    account = legacy;
  }
  const { verifyPassword, upgradeHashIfLegacy } = require('../utils/password');
  const passwordMatches = await verifyPassword(password, account.passwordHash);
  if (!passwordMatches) {
    recordAccountFailure(aliasLockKey, lockMeta(req, req.ip));
    noteIpAccountFailure(req.ip, alias);
    return res.status(401).json({ message: 'Invalid admin credentials.' });
  }
  // Correct password resets strikes and ladder locks
  clearAccountState(aliasLockKey);
  // Transparent hash upgrade: legacy bcrypt → argon2id (DB accounts only)
  try {
    if (account._id && account._id !== 'admin') {
      const upgraded = await upgradeHashIfLegacy(password, account.passwordHash);
      if (upgraded) await AdminAccount.findByIdAndUpdate(account._id, { passwordHash: upgraded }).exec();
    }
  } catch { /* upgrade best-effort; login already succeeded */ }

  const challengeId = crypto.randomBytes(24).toString('hex');
  adminChallenges.set(challengeId, { accountId: account._id, alias: account.alias, totpSecret: account.totpSecret, mustChangePassword: !!account.mustChangePassword, expiresAt: Date.now() + ADMIN_CHALLENGE_TTL_MS });
  return res.json({ requiresTwoFactor: true, challengeId, message: 'Authenticator verification required.' });
});

router.post('/verify-admin-2fa', async (req, res) => {
  const { challengeId, otp } = req.body || {};
  const challenge = adminChallenges.get(challengeId);
  if (!challenge || Date.now() > challenge.expiresAt) {
    adminChallenges.delete(challengeId);
    return res.status(401).json({ message: 'Admin verification expired. Please sign in again.' });
  }

  // Same lockout ladder as every other credential step. This route had none:
  // once the password was known, the 6-digit authenticator code could be
  // guessed indefinitely (the ip limiter only throttles, it never stops).
  const adminOtpLockKey = accountKey('admin', challenge.alias);
  const adminOtpLockedMs = lockRemainingMs(adminOtpLockKey);
  if (adminOtpLockedMs > 0) {
    reportAccountLockout({ alias: challenge.alias, minutes: Math.ceil(adminOtpLockedMs / 60000), lockKey: adminOtpLockKey });
    return res.status(429).json({
      message: `Too many incorrect attempts. Try again in ${Math.ceil(adminOtpLockedMs / 60000)} minute(s).`,
      remainingSeconds: Math.ceil(adminOtpLockedMs / 1000),
      escalated: true,
      lockedBy: 'account',
    });
  }

  // Scoped to the alias: administrators may share one authenticator seed, and a
  // secret-only key would let the first of them to sign in spend the 30-second
  // code for every other admin sharing it.
  const verified = verifyTotpOnce(challenge.totpSecret, otp, challenge.alias);
  if (!verified) {
    // Three consecutive failures inside 15 min lock the alias — the same
    // bucket /admin-login checks, so a TOTP brute force also blocks retries.
    recordAccountFailure(adminOtpLockKey, lockMeta(req, req.ip));
    return res.status(401).json({ message: 'Invalid authenticator code.' });
  }
  clearAccountState(adminOtpLockKey);
  adminChallenges.delete(challengeId);
  const account = { _id: challenge.accountId, alias: challenge.alias };
  if (account._id && typeof account._id !== 'string') account._id = String(account._id);
  // Carried on the 2FA challenge so the flag can be reported without a second
  // read: the challenge already fetched the account, and this route must not
  // mint a token for a stale view of it.
  const mustChangePassword = !!challenge.mustChangePassword;
  if (account._id && account._id !== 'admin') await AdminAccount.findByIdAndUpdate(account._id, { lastLoginAt: new Date(), lastActivityAt: new Date() });
  // The flag rides on the RESPONSE, not just in the token. A JWT is immutable
  // once signed, so putting it in the payload would leave the client believing
  // "change required" for the life of the token even after the password is
  // changed - and the client would keep redirecting to a page it no longer needs.
  return res.json({ token: adminToken(account), role: 'admin', alias: account.alias, mustChangePassword });
});

// @route   POST /api/auth/admin-refresh
// @desc    Extend the admin session. Two distinct jobs, distinguished by the
//          `renew` flag — see countsAsActivity in utils/adminSession.js.
//
//          • renew NOT set  ("Stay signed in", or a background poll):
//            genuine activity, so `lastActivityAt` is refreshed and the idle
//            countdown restarts.
//          • renew = true   (the client's automatic timer):
//            a pure TOKEN renewal. The full validation still runs — signature,
//            account exists, still enabled, and NOT idle-expired — so an idle
//            admin is still signed out. It just does not count as activity, and
//            does not touch the idle window.
//
//          Without the flag the client cannot keep a 15-minute token fresh
//          without either (a) being logged out mid-task every 15 minutes, or
//          (b) refreshing on a timer that also refreshes `lastActivityAt`, which
//          would disable the ten-minute idle timeout entirely.
router.post('/admin-refresh', async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ message: 'Admin session missing. Please sign in again.' });
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ message: 'Admin session expired. Please sign in again.' });
    }
    if (decoded.role !== 'admin') return res.status(403).json({ message: 'Admin access required.' });
    const adminId = decoded.adminId || decoded.id;
    if (!adminId || adminId === 'admin') return res.status(401).json({ message: 'Please sign in again.' });
    const AdminAccount = require('../models/AdminAccount');
    const admin = await AdminAccount.findById(adminId).select('alias enabled lastActivityAt');
    if (!admin || !admin.enabled) return res.status(401).json({ message: 'Admin account is unavailable.' });
    // The SAME function the middleware uses. Two copies of this check is how
    // they drifted apart in the first place, and both copies skipped the test
    // entirely when `lastActivityAt` was null.
    if (idleExceeded(admin, decoded)) {
      return res.status(401).json({ message: 'Admin session expired after inactivity.' });
    }
    // Only genuine activity slides the window. A token renewal leaves it alone,
    // which is what keeps the idle timeout meaningful while the client's renewal
    // timer runs forever.
    const activity = countsAsActivity(req.body);
    if (activity) {
      await AdminAccount.updateOne(
        { _id: admin._id, $or: [
          { lastActivityAt: null },
          { lastActivityAt: { $exists: false } },
          { lastActivityAt: { $lt: new Date(Date.now() - ADMIN_HEARTBEAT_INTERVAL_MS) } },
        ] },
        { $set: { lastActivityAt: new Date() } },
      ).exec().catch(() => {});
    }
    return res.json({
      token: adminToken({ _id: String(admin._id), alias: admin.alias }),
      role: 'admin',
      alias: admin.alias,
      // Reported from the same constant the token was signed with. It used to be
      // a second literal ("5 * 60") beside the "5m" in adminToken(), which is two
      // places to forget when the lifetime changes. The client schedules its
      // renewal from THIS number, so it must be the enforced one.
      expiresInSeconds: ADMIN_TOKEN_LIFETIME_SECONDS,
      // The idle window too, so a client can render the real countdown instead
      // of keeping its own copy of the number.
      idleLimitSeconds: ADMIN_IDLE_LIMIT_SECONDS,
      // Whether this call counted as activity, so the client can tell the
      // difference between "I extended your session" and "your token was renewed
      // and the countdown did not move".
      countedAsActivity: activity,
    });
  } catch (error) {
    console.error('[admin-refresh]', error.message);
    return res.status(500).json({ message: 'Unable to refresh the admin session.' });
  }
});

// @route   POST /api/auth/verify-login-otp
// @desc    Login user - Step 2: Verify OTP and issue token
// @access  Public
router.post('/verify-login-otp', async (req, res) => {
  const { userId, otp, remember } = req.body;
  const mfaToken = str(req.body?.mfaTransaction);

  try {
    if (!userId || !otp) {
      return res.status(400).json({ message: 'User ID and OTP are required' });
    }

    // A second factor is only honoured against a LIVE TRANSACTION opened by the
    // password step. `userId` alone is accepted only while such a transaction
    // exists for that account, which is what stops "a valid emailed code plus
    // a known user id" from being a complete sign-in. See utils/mfaTransaction.js.
    let transaction = null;
    if (mfaToken) {
      if (!mfaTransaction.isValidTokenFormat(mfaToken)) {
        console.error('[verify-login-otp] invalid token format, length:', mfaToken?.length);
        return res.status(401).json({ message: 'That sign-in attempt has expired. Please sign in again.' });
      }
      const peeked = await mfaTransaction.peek(mfaToken, { method: 'email-otp' });
      if (!peeked) {
        // Debug: find out why peek returned null
        try {
          const MfaTransaction = require('../models/MfaTransaction');
          const raw = await MfaTransaction.findOne({ tokenHash: mfaTransaction.hashToken(mfaToken) }).select('consumedAt expiresAt attempts maxAttempts methods').lean();
          console.error('[verify-login-otp] peek returned null. Found in DB:', !!raw, 'state:', JSON.stringify(raw), '| now:', new Date().toISOString());
        } catch (dbg) { /* best-effort */ }
        return res.status(401).json({ message: 'That sign-in attempt has expired. Please sign in again.' });
      }
      transaction = { _id: peeked._id, user: peeked.user, viaToken: true };
    } else {
      if (!mongoose.isValidObjectId(str(userId))) {
        return res.status(401).json({ message: 'That sign-in attempt has expired. Please sign in again.' });
      }
      const found = await MfaTransaction.findOne({
        user: str(userId),
        consumedAt: null,
        expiresAt: { $gt: new Date(Date.now() - 30000) },
        methods: 'email-otp',
      }).select('_id user').sort({ createdAt: -1 }).lean();
      if (!found) {
        return res.status(401).json({ message: 'That sign-in attempt has expired. Please sign in again.' });
      }
      transaction = { _id: found._id, user: found.user, viaToken: false };
    }

    // Account lockout: repeated OTP failures escalate 15 min → 1 day.
    // Keyed on the RESOLVED account from the transaction, never on the
    // client-supplied string: keying on that let anyone who knew a victim's id
    // lock their own sign-in out.
    const otpLockKey = accountKey('otp-user', transaction.user);
    const otpLockedMs = lockRemainingMs(otpLockKey);
    if (otpLockedMs > 0) {
      reportAccountLockout({ userId: String(transaction.user), minutes: Math.ceil(otpLockedMs / 60000), lockKey: otpLockKey });
      return res.status(429).json({
        message: `Too many incorrect attempts. Try again in ${Math.ceil(otpLockedMs / 60000)} minute(s).`,
        remainingSeconds: Math.ceil(otpLockedMs / 1000),
        escalated: true,
        lockedBy: 'account',
      });
    }

    const user = await User.findById(transaction.user);
    if (!user) {
      // Same answer as a wrong code. "User not found" here would turn this
      // endpoint into an account-existence oracle for anyone holding a user id.
      return res.status(401).json({ message: 'That verification code is not valid.' });
    }
    // Ban enforcement on the OTP completion step. The password step already
    // rejects non-active accounts; without the same check here a banned user
    // finished the login, cleared their own lockout counters and displaced the
    // account's currentSessionId before the token was rejected downstream.
    if (user.accountStatus && user.accountStatus !== 'active') {
      return res.status(403).json({ message: 'This account is not active.' });
    }

    // Keyed on the RESOLVED id, not the raw client string: the Map is written
    // with the canonical `_id`, and `findById` accepts upper-case hex, so a
    // non-canonical id resolved a user but missed its own pending OTP.
    const otpKey = `login_${user._id}`;

    // Verify AND consume, atomically.
    //
    // This replaces a read-then-compare-then-delete sequence with three awaits
    // interleaved between the checks. Two concurrent submissions of one valid
    // code could both pass every check and both reach the session-issuing code
    // below; only the atomic MfaTransaction spend stopped the second one from
    // getting a token, and only by accident of ordering rather than by design.
    // `consume()` contains no await between its check and its delete, so on the
    // event loop exactly one caller can observe the entry.
    //
    // It also enforces expiry, the single-use guarantee and the attempt budget
    // in one place, and compares against an HMAC digest in constant time rather
    // than with `!==` on the plaintext.
    const submitted = str(otp).trim();
    const verdict = otpChallenge.consume(otpStore, otpKey, submitted);

    if (!verdict.ok) {
      if (verdict.outcome === 'locked') {
        // Capped ladder + keyed on the RESOLVED id. This is an unauthenticated
        // public route: keying on the raw client-supplied userId let anyone who
        // knew a victim's email lock their 2FA / password reset / recovery codes,
        // and the uncapped ladder let it reach a full day.
        recordOtpOffense(accountKey('otp-user', user._id));
        return res.status(429).json({ message: 'Too many incorrect attempts. Please request a new code.' });
      }
      // 'missing', 'expired', 'malformed' and 'mismatch' all answer identically.
      // The old code answered "No OTP request found." for one and "Invalid
      // verification code." for another, which told an attacker holding a user id
      // whether that account had a code outstanding at all.
      return res.status(400).json({ message: OTP_REJECTION_MESSAGE });
    }

    clearOffenses(accountKey('otp-user', transaction.user));

    // Spend the transaction, atomically, BEFORE the session exists. Two
    // concurrent submissions of one valid code both pass the checks above, but
    // only one can win this conditional update — and only the winner is handed
    // a token.
    const spent = transaction.viaToken
      ? await mfaTransaction.spend(mfaToken, { method: 'email-otp' })
      : await mfaTransaction.spendById(transaction._id, { method: 'email-otp' });
    if (!spent.ok) {
      // Debug: log why the spend failed so we can diagnose "expired" errors
      try {
        const MfaTransaction = require('../models/MfaTransaction');
        const raw = await MfaTransaction.findById(transaction._id).select('consumedAt expiresAt attempts maxAttempts methods').lean();
        console.error('[verify-login-otp] spendById failed. Transaction state:', JSON.stringify(raw), '| now:', new Date().toISOString(), '| viaToken:', transaction.viaToken);
      } catch (dbg) { /* best-effort debug, never fail */ }
      return res.status(401).json({ message: 'That sign-in attempt has expired. Please sign in again.' });
    }

    // One active session per account: issueUserSession atomically makes this
    // the account's current session and revokes the one it displaced — in any
    // other tab, browser or device. Scoped to this account, so every other
    // account signed in elsewhere in the same browser is untouched.
    const { token, rememberToken } = await completeSignIn({
      user,
      authMethod: AUTH_METHODS.EMAIL_OTP,
      mfaVerified: user.twoFactorEnabled === true,
      req,
      location: user.lastLoginLocation || '',
      remember,
      reason: user.twoFactorEnabled === true ? 'Signed in with an emailed code' : 'Password accepted',
      eventType: user.twoFactorEnabled === true ? 'mfa-success' : 'login-success',
    });

    // Return user data and token (no expiry — revocation is session-based)
    res.json({
      ...publicUser(user),
      token,
      authMethod: AUTH_METHODS.EMAIL_OTP,
      mfaVerified: user.twoFactorEnabled === true,
      ...(rememberToken ? { rememberToken } : {}),
    });
  } catch (error) {
    return authFailure(res, error, 'verify-login-otp');
  }
});

// @route   POST /api/auth/remember
// @desc    OPT-IN "save my login": swap a stored remember credential for a
//          fresh access JWT for the SAME still-current session. No session is
//          created and none is displaced (one-active-session rule untouched),
//          and the credential dies with the session — sign-out, a newer
//          sign-in and account bans all reject it. Protected by the /api/auth
//          lockout + rate limiters (mounted in index.js).
router.post('/remember', async (req, res) => {
  try {
    const raw = req.body && typeof req.body.token === 'string' ? req.body.token : '';
    const minted = await mintFromRememberToken(raw);
    if (!minted.ok) {
      return res.status(minted.status).json({ code: minted.code, message: minted.message });
    }
    const user = await User.findById(minted.userId);
    if (!user || (user.accountStatus && user.accountStatus !== 'active')) {
      return res.status(401).json({ code: SESSION_INVALID, message: SESSION_ENDED_MESSAGE });
    }
    res.json({
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        name: user.fullName,
        email: user.email,
        dateOfBirth: user.dateOfBirth,
        age: user.age,
        gender: user.gender,
        profilePicture: safePictureValue(user.profilePicture),
        bannerPicture: safePictureValue(user.bannerPicture),
        twoFactorEnabled: user.twoFactorEnabled === true,
        subscriptionActive: user.subscriptionActive,
        subscriptionPlan: user.subscriptionPlan,
        subscription: describeSubscription(user),
      },
      token: minted.token,
    });
  } catch (error) {
    // A database outage must NEVER read as "credential rejected" — the
    // client keeps its saved login and just falls back this once.
    console.error('[remember]', error.message);
    res.status(503).json({ message: 'Unable to verify your saved login right now. Please try again.' });
  }
});

router.post('/setup-2fa', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });

    // 2FA can only be (re)paired while it is OFF. The previous version wrote a
    // brand-new secret unconditionally, so a hijacked session could silently
    // swap the authenticator out from under the owner — replacing their device
    // with one the attacker controls. The normal path is disable (which
    // demands a valid current TOTP) → setup → verify; the UI already only
    // offers setup when 2FA is off, so no legitimate flow reaches this guard.
    if (user.twoFactorEnabled) {
      return res.status(409).json({
        message: 'Two-factor authentication is already enabled. Disable it first before setting up a new authenticator.',
      });
    }

    const secret = speakeasy.generateSecret({ name: `SuppliWise (${user.email})`, issuer: 'SuppliWise' });
    // Encrypted immediately, activated only by /verify-2fa. The legacy
    // plaintext field is cleared, so a new seed never lands in it.
    totpSecret.writeSecret(user, secret.base32);
    await user.save();
    res.json({ qrCode: await QRCode.toDataURL(secret.otpauth_url), secret: secret.base32 });
  } catch (error) {
    res.status(401).json({ message: 'Unable to start two-factor setup.' });
  }
});

router.post('/verify-2fa', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const user = await User.findById(req.user._id).select(totpSecret.SECRET_FIELDS);
    const secret = totpSecret.readSecret(user);
    if (!user || !secret) return res.status(400).json({ message: 'Two-factor setup was not started.' });
    if (!verifyTotpOnce(secret, req.body.otp, String(user._id))) {
      await SecurityEvent.write({
        user: user._id, type: 'totp-failed', success: false,
        ip: req.ip, userAgent: req.get('user-agent'),
        reason: 'Authenticator code rejected during setup',
        meta: { factor: 'totp', outcome: 'mismatch' },
      });
      return res.status(401).json({ message: 'Invalid verification code.' });
    }
    user.twoFactorEnabled = true;
    // Verifying a TOTP IS choosing the authenticator method — record it, so
    // the UI and the login branch agree on which factor this account uses.
    user.twoFactorMethod = 'authenticator';
    await user.save();
    await SecurityEvent.write({
      user: user._id, type: 'totp-enabled', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: 'Authenticator app enabled',
      meta: { factor: 'totp', mfaVerified: true },
    });
    // Security trail: enabling 2FA shows up in Recent security activity
    try {
      const UserNotification = require('../models/UserNotification');
      await UserNotification.create({
        user: user._id,
        type: 'info',
        title: 'Two-factor authentication enabled',
        detail: 'Google Authenticator is now required at sign-in. If this wasn\'t you, disable it and change your password immediately.',
      }).catch(() => {});
    } catch { /* best-effort */ }
    res.json({ message: 'Two-factor authentication enabled successfully.', twoFactorEnabled: true });
  } catch (error) {
    res.status(401).json({ message: 'Unable to verify the authentication code.' });
  }
});

router.post('/login-2fa', async (req, res) => {
  const mfaToken = str(req.body?.mfaTransaction);
  try {
    // The transaction is the whole point of this route now. A bare `userId` is
    // honoured only while a live transaction exists for that account, which
    // means the password step really did succeed here moments ago.
    let transaction = null;
    if (mfaToken) {
      if (!mfaTransaction.isValidTokenFormat(mfaToken)) {
        return res.status(401).json({ message: 'That sign-in attempt has expired. Please sign in again.' });
      }
      const peeked = await mfaTransaction.peek(mfaToken, { method: 'totp' });
      if (!peeked) {
        return res.status(401).json({ message: 'That sign-in attempt has expired. Please sign in again.' });
      }
      transaction = { _id: peeked._id, user: peeked.user, viaToken: true };
    } else {
      const userId = str(req.body?.userId);
      if (!mongoose.isValidObjectId(userId)) {
        return res.status(401).json({ message: 'That sign-in attempt has expired. Please sign in again.' });
      }
      const found = await MfaTransaction.findOne({
        user: userId,
        consumedAt: null,
        expiresAt: { $gt: new Date() },
        methods: 'totp',
      }).select('_id user').sort({ createdAt: -1 }).lean();
      if (!found) {
        return res.status(401).json({ message: 'That sign-in attempt has expired. Please sign in again.' });
      }
      transaction = { _id: found._id, user: found.user, viaToken: false };
    }

    const user = await User.findById(transaction.user).select(totpSecret.SECRET_FIELDS);
    const secret = totpSecret.readSecret(user);
    if (!user || !user.twoFactorEnabled || !secret) {
      return res.status(401).json({ message: 'That verification code is not valid.' });
    }
    // A banned/deleted account must not be able to complete the SECOND factor.
    // The ban was only enforced on the password step, so a banned user could
    // still clear TOTP, be handed a session token, wipe their own lockout state
    // and rotate the account's currentSessionId.
    if (user.accountStatus && user.accountStatus !== 'active') {
      return res.status(403).json({ message: 'This account is not active.' });
    }
    // Lazily migrate a pre-encryption seed: this is the moment we know the key
    // works, which is the only safe moment to re-seal it.
    if (totpSecret.migrateInPlace(user)) await user.save().catch(() => {});
    // Account lockout check + failure recording (ladder 15 min → 1 day)
    const tfaLockKey = accountKey('otp-user', transaction.user);
    if (lockRemainingMs(tfaLockKey) > 0) {
      const left = lockRemainingMs(tfaLockKey);
      reportAccountLockout({ userId: String(transaction.user), minutes: Math.ceil(left / 60000), lockKey: tfaLockKey });
      return res.status(429).json({
        message: `Too many incorrect attempts. Try again in ${Math.ceil(left / 60000)} minute(s).`,
        remainingSeconds: Math.ceil(left / 1000),
        escalated: true,
        lockedBy: 'account',
      });
    }
    const verified = verifyTotpOnce(secret, req.body.otp, String(user._id));
    if (!verified) {
      recordAccountFailure(tfaLockKey, lockMeta(req, req.ip));
      await SecurityEvent.write({
        user: user._id, type: 'mfa-failure', success: false,
        ip: req.ip, userAgent: req.get('user-agent'),
        location: user.lastLoginLocation || '',
        reason: 'Authenticator code rejected at sign-in',
        meta: { factor: 'totp', outcome: 'mismatch' },
      });
      return res.status(401).json({ message: 'That verification code is not valid.' });
    }
    clearAccountState(tfaLockKey);
    // Spend the transaction atomically before any session exists.
    const spent = transaction.viaToken
      ? await mfaTransaction.spend(mfaToken, { method: 'totp' })
      : await mfaTransaction.spendById(transaction._id, { method: 'totp' });
    if (!spent.ok) {
      return res.status(401).json({ message: 'That sign-in attempt has expired. Please sign in again.' });
    }

    // One active session per account (same atomic rotation as /verify-login-otp):
    // this sign-in displaces THIS ACCOUNT's previous session only — other
    // accounts' sessions are never affected, which is what lets two accounts
    // stay signed in in two tabs of the same browser.
    const { token, rememberToken } = await completeSignIn({
      user,
      authMethod: AUTH_METHODS.TOTP,
      mfaVerified: true,
      req,
      location: user.lastLoginLocation || '',
      remember: req.body.remember === true || req.body.remember === 'true',
      reason: 'Signed in with your authenticator app',
      eventType: 'mfa-success',
    });
    res.json({
      ...publicUser(user),
      token,
      authMethod: AUTH_METHODS.TOTP,
      mfaVerified: true,
      ...(rememberToken ? { rememberToken } : {}),
    });
  } catch (error) {
    res.status(401).json({ message: 'Unable to verify the 2FA code.' });
  }
});

router.post('/disable-2fa', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const user = await User.findById(req.user._id).select(totpSecret.SECRET_FIELDS);
    if (!user || !user.twoFactorEnabled) {
      return res.status(400).json({ message: 'Two-factor authentication is not currently enabled.' });
    }

    // The proof required depends on WHICH factor is being turned off.
    //   authenticator — a live TOTP code, because that secret is what an
    //                   attacker who stole the session would be reaching for.
    //   email        — there is no TOTP to present, so demand the account
    //                   password instead. Without this, holding a stolen token
    //                   would be enough to silently drop the second factor.
    const method = user.twoFactorMethod || 'authenticator';
    if (method === 'authenticator') {
      const secret = totpSecret.readSecret(user);
      if (!secret) {
        return res.status(401).json({ message: 'Enter a code from your authenticator app, or contact support.' });
      }
      if (totpSecret.migrateInPlace(user)) await user.save().catch(() => {});
      const verified = verifyTotpOnce(secret, req.body.otp, String(user._id));
      if (!verified) {
        await SecurityEvent.write({
          user: user._id, type: 'totp-failed', success: false,
          ip: req.ip, userAgent: req.get('user-agent'),
          reason: 'Authenticator code rejected while disabling',
          meta: { factor: 'totp', outcome: 'mismatch' },
        });
        return res.status(401).json({ message: 'That verification code is not valid.' });
      }
    } else {
      const ok = await user.matchPassword(str(req.body.currentPassword));
      if (!ok) return res.status(401).json({ message: 'Enter your current password to turn off two-factor authentication.' });
    }

    user.twoFactorEnabled = false;
    // The seed is FORGOTTEN, not just deactivated. Leaving it stored would mean
    // a database read could still mint codes for an account that believes it
    // has no authenticator. See utils/secretBox.js.
    totpSecret.clearSecret(user);
    user.twoFactorMethod = 'authenticator'; // reset so a later re-enable defaults to the strong factor
    await user.save();
    await SecurityEvent.write({
      user: user._id, type: 'totp-disabled', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: method === 'email' ? 'Email sign-in codes turned off' : 'Authenticator app turned off',
      meta: { factor: method === 'email' ? 'email-otp' : 'totp' },
    });
    // Security trail: disabling 2FA shows up in Recent security activity
    try {
      const UserNotification = require('../models/UserNotification');
      await UserNotification.create({
        user: user._id,
        type: 'info',
        title: 'Two-factor authentication disabled',
        detail: method === 'email'
          ? 'Email sign-in codes were turned off. If this wasn\'t you, re-enable two-factor authentication and change your password immediately.'
          : 'Google Authenticator was turned off. If this wasn\'t you, re-enable it and change your password immediately.',
      }).catch(() => {});
    } catch { /* best-effort */ }
    res.json({ message: 'Two-factor authentication has been disabled successfully.', twoFactorEnabled: false });
  } catch (error) {
    res.status(401).json({ message: 'Your session has expired or the code is invalid.' });
  }
});

// @route   POST /api/auth/resend-login-otp
// @desc    Resend OTP for login
// @access  Public
router.post('/resend-login-otp', async (req, res) => {
  const { userId } = req.body;

  try {
    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }
    if (!mongoose.isValidObjectId(str(userId))) {
      // A malformed id is bad input, not a missing account: `findById` throws a
      // CastError on this, which the generic handler would turn into a 500. It
      // is a 400 because a malformed value can never name an account, so the
      // answer reveals nothing about whether one exists.
      return res.status(400).json({ message: 'Invalid request.' });
    }

    const user = await User.findById(userId);
    if (!user) {
      // ENUMERATION, CLOSED.
      //
      // This used to answer `401 { message: 'User not found' }` for an id that
      // does not exist and `200` for one that does. Anyone holding a candidate
      // id could therefore confirm whether that account exists, from an
      // unauthenticated route, with a single request — and the app is careful to
      // make /login itself non-enumerating, so this route was undoing that.
      //
      // The answer is now the same one a real account gets when it is inside the
      // resend cooldown. That is not a convenient coincidence: it is the honest
      // version of the same concealment, because "you just asked, wait" is
      // something a caller learns whether or not the account exists.
      return res.status(200).json({ message: RESEND_GENERIC_MESSAGE });
    }

    // Check rate limiting (60 second cooldown)
    const lastRequest = otpRateLimitMap.get(user._id.toString());
    if (lastRequest) {
      const timeSinceLastRequest = Date.now() - lastRequest;
      if (timeSinceLastRequest < OTP_COOLDOWN_MS) {
        const remainingSeconds = Math.ceil((OTP_COOLDOWN_MS - timeSinceLastRequest) / 1000);
        return res.status(200).json({
          message: RESEND_GENERIC_MESSAGE,
          remainingSeconds,
        });
      }
    }

    // Same rule as /login: a new code replaces the old one only once the mail
    // has gone out. The old code was still valid, so a failed resend must not
    // destroy it — the user can simply finish signing in with the code they
    // already have.
    const issued = await issueOtp(user.email, `login_${user._id}`, user._id.toString(), 'login');
    if (!issued.ok) return otpDeliveryFailed(res);

    res.json({
      message: 'Verification code sent to your email successfully',
    });
  } catch (error) {
    return authFailure(res, error, 'resend-login-otp');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD RESET — LEGACY ALIASES
//
// These four endpoints are the OLD 6-digit-code-in-a-modal flow. The flow they
// belonged to has been replaced by an emailed link and two dedicated pages
// (routes/passwordReset.js), but the endpoints are kept and still work: each
// one now delegates to the same service the new pages use. That is deliberate.
//
//   • A client on a stale build (a PWA that has not refreshed, a tab open for
//     days) can still finish a reset instead of hitting a 404.
//   • Nothing here is a stub or a 410 — each alias reaches the same MongoDB
//     grant, the same email and the same password rules, so the two paths
//     cannot drift apart in behaviour.
//   • The enumeration hole they shared is closed for both. The old
//     /forgot-password returned a `userId` only for accounts that existed,
//     which contradicted its own "we don't reveal whether an account exists"
//     message; the alias now returns the same anonymous body for everyone.
//
// Note on rate limiting: all four remain in the `sensitiveLimiter` path list
// above, so they inherit the stricter 10-min/60-req budget the sensitive auth
// steps share. The new link endpoints carry their own, per-flow budget in
// routes/passwordReset.js.
// ─────────────────────────────────────────────────────────────────────────────

// @route   POST /api/auth/forgot-password  (legacy alias)
// @desc    Request a password reset link
// @access  Public
router.post('/forgot-password', async (req, res) => {
  try {
    const result = await passwordResetService.requestReset({ email: req.body?.email, req });
    return res.status(result.status).json({ message: result.message });
  } catch (error) {
    return authFailure(res, error, 'forgot-password');
  }
});

// @route   POST /api/auth/resend-password-reset-otp  (legacy alias)
// @desc    Re-send the reset email for an account named by id
// @access  Public
router.post('/resend-password-reset-otp', async (req, res) => {
  try {
    const result = await passwordResetService.resendForUser({ userId: req.body?.userId, req });
    return res.status(result.status).json({ message: result.message });
  } catch (error) {
    return authFailure(res, error, 'resend-password-reset-otp');
  }
});

// @route   POST /api/auth/verify-password-reset-otp  (legacy alias)
// @desc    Verify the emailed 6-digit code, returning a short-lived grant
// @access  Public
router.post('/verify-password-reset-otp', async (req, res) => {
  const { userId, otp } = req.body || {};

  try {
    if (!userId || !otp) {
      return res.status(400).json({ message: 'User ID and verification code are required.' });
    }

    // Escalating lockout (15 min → 1 h, capped) on top of the service's own
    // per-record strike counter. This is an UNAUTHENTICATED public route, and
    // the lock key is derived from the client-supplied id — a third party must
    // not be able to lock a victim out of recovering, which is why the ladder
    // is capped at an hour and the service burns the record after five strikes
    // rather than escalating indefinitely.
    const lockKey = accountKey('otp-user', userId);
    const lockedMs = lockRemainingMs(lockKey);
    if (lockedMs > 0) {
      reportAccountLockout({ userId, minutes: Math.ceil(lockedMs / 60000), lockKey });
      return res.status(429).json({
        message: `Too many incorrect attempts. Try again in ${Math.ceil(lockedMs / 60000)} minute(s).`,
        remainingSeconds: Math.ceil(lockedMs / 1000),
        escalated: true,
        lockedBy: 'account',
      });
    }

    const result = await passwordResetService.verifyCodeForUser({ userId, code: otp, req });
    if (result.status !== 200) {
      if (result.status === 429) recordOtpOffense(lockKey);
      return res.status(result.status).json({ message: result.message });
    }

    clearOffenses(lockKey);
    return res.status(200).json({
      message: result.message,
      verified: true,
      // The legacy client already holds the raw code and calls /reset-password
      // with it. A grant is returned as well so a client that dropped the code
      // can still finish — either shape is accepted there.
      resetToken: result.resetToken,
    });
  } catch (error) {
    return authFailure(res, error, 'verify-password-reset-otp');
  }
});

// @route   POST /api/auth/reset-password  (legacy alias)
// @desc    Set a new password from a grant, or directly from the emailed code
// @access  Public
router.post('/reset-password', async (req, res) => {
  const { userId, otp, resetToken, newPassword } = req.body || {};

  try {
    if (!newPassword) {
      return res.status(400).json({ message: 'Please enter a new password.' });
    }

    // Lockout gate — this route can be handed a code directly, so it must be
    // just as hard to brute-force as /verify-password-reset-otp. Without this
    // an attacker could skip the verify step and hammer guesses here forever.
    const lockKey = accountKey('otp-user', userId || 'grant');
    const lockedMs = lockRemainingMs(lockKey);
    if (lockedMs > 0) {
      reportAccountLockout({ userId, minutes: Math.ceil(lockedMs / 60000), lockKey });
      return res.status(429).json({
        message: `Too many incorrect attempts. Try again in ${Math.ceil(lockedMs / 60000)} minute(s).`,
        remainingSeconds: Math.ceil(lockedMs / 1000),
        escalated: true,
        lockedBy: 'account',
      });
    }

    // Two accepted shapes: the grant from /verify-password-reset-otp, or the
    // code straight from the email for a client that never verified separately.
    const result = resetToken
      ? await passwordResetService.completeWithGrant({ resetToken, newPassword, req })
      : await passwordResetService.completeWithCode({ userId, code: otp, newPassword, req });

    if (result.status === 200) clearOffenses(lockKey);
    return res.status(result.status).json({ message: result.message, success: !!result.success });
  } catch (error) {
    return authFailure(res, error, 'reset-password');
  }
});

// @route   GET /api/auth/me
// @desc    Current user profile incl. subscription status (lightweight: no image blobs)
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const user = await User.findById(req.user._id)
      .select('-password -profilePicture -bannerPicture -twoFactorSecret -twoFactorSecretEnc -webauthnUserId -lastLoginIp -lastLoginUserAgent')
      .lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      email: user.email,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      subscriptionActive: user.subscriptionActive,
      subscriptionPlan: user.subscriptionPlan,
      subscriptionUpdatedAt: user.subscriptionUpdatedAt,
      // Authoritative entitlement state — every client surface renders from this.
      subscription: describeSubscription(user),
      twoFactorEnabled: user.twoFactorEnabled,
      twoFactorMethod: user.twoFactorEnabled ? (user.twoFactorMethod || 'authenticator') : null,
      // Drives the "Last password changed" readout in Account Security.
      passwordChangedAt: user.passwordChangedAt || null,
      hasVisitedDashboard: user.hasVisitedDashboard,
    });
  } catch (error) {
    console.error('[me]', error.message);
    res.status(500).json({ message: 'Could not load your profile. Please try again.' });
  }
});

// @route   POST /api/auth/logout
// @desc    Revoke THIS session server-side (the session id inside the
//          presented token). Scoped to the signed-in account + that session,
//          so signing out Account A can never sign out Account B, and any
//          copy of this token dies immediately (backend stays authoritative).
// @access  Private
router.post('/logout', protect, async (req, res) => {
  try {
    if (req.user && req.user.role !== 'admin' && req.sessionId) {
      await revokeUserSession(req.user._id, req.sessionId);
    }
    res.json({ message: 'Signed out successfully.' });
  } catch (error) {
    // Never block a sign-out: the client clears its own copy regardless.
    console.error('[logout]', error.message);
    res.json({ message: 'Signed out successfully.' });
  }
});

// @route   POST /api/auth/change-password
// @desc    Change the password on its own, decoupled from the profile form.
//          Verifies the CURRENT password (so a borrowed unlocked session can't
//          take the account over), enforces the same strength rules the signup
//          form uses, and stamps passwordChangedAt via the model's pre-save
//          hook. Every OTHER session of this account is revoked — a password
//          change is the standard response to "I think someone else got in",
//          so leaving old sessions alive would defeat the point. The caller's
//          own session survives, or the user would be logged out of the very
//          tab they just fixed the password in.
// @access  Private
router.post('/change-password', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const user = await User.findById(req.user._id).select(totpSecret.SECRET_FIELDS);
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });

    const currentPassword = str(req.body?.currentPassword);
    const newPassword = str(req.body?.newPassword);

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Your current password and a new password are both required.' });
    }
    // The ONE password policy (utils/passwordRules.js), the same object the
    // reset flow and the signup form validate against.
    const passwordVerdict = evaluatePassword(newPassword, { email: user.email });
    if (!passwordVerdict.ok) {
      return res.status(400).json({ message: passwordVerdict.message });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ message: 'Your new password must be different from your current one.' });
    }

    const ok = await user.matchPassword(currentPassword);
    if (!ok) {
      await SecurityEvent.write({
        user: user._id, type: 'password-change-failed', success: false,
        ip: req.ip, userAgent: req.get('user-agent'),
        reason: 'Current password was incorrect',
        meta: { authMethod: 'password' },
      });
      // Deliberately the same wording a wrong username gets, and no detail:
      // this endpoint must not confirm that the account exists.
      return res.status(401).json({ message: 'Your current password is incorrect.' });
    }

    // Assigning the plaintext lets the pre-save hook hash it (argon2id) and
    // stamp passwordChangedAt in the same write — the date can never drift
    // from the hash it describes.
    user.password = newPassword;
    await user.save();

    // Kill every other session (see route note). req.sessionId is the caller's.
    const killed = await revokeOtherUserSessions(user._id, req.sessionId);

    await SecurityEvent.write({
      user: user._id, type: 'password-changed', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: killed > 0
        ? `Password changed, ${killed} other ${killed === 1 ? 'session' : 'sessions'} signed out`
        : 'Password changed',
      meta: { authMethod: 'password' },
    });

    try {
      const UserNotification = require('../models/UserNotification');
      await UserNotification.create({
        user: user._id,
        type: 'info',
        title: 'Password changed',
        detail: killed > 0
          ? `Your password was changed and ${killed} other ${killed === 1 ? 'session was' : 'sessions were'} signed out. If this wasn't you, reset your password and contact support immediately.`
          : "Your password was just changed. If this wasn't you, reset it and contact support immediately.",
      }).catch(() => {});
    } catch { /* best-effort trail */ }

    // Confirmation mail, same as a reset. A credential change is exactly the
    // event an account owner needs to hear about, and it is the one signal that
    // reaches them if the change came from a session an intruder held.
    sendPasswordChangedEmail(user.email).catch(() => {});

    res.json({
      message: 'Your password has been updated.',
      passwordChangedAt: user.passwordChangedAt,
      otherSessionsRevoked: killed,
    });
  } catch (error) {
    console.error('[change-password]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// @route   POST /api/auth/sign-out-all
// @desc    Revoke every session for this account EXCEPT the one making the
//          request, and clear the "save my login" credential stored on all of
//          them. Revocation is what ends those sessions; dropping the saved
//          credential is defence-in-depth that leaves nothing behind on those
//          devices (see revokeOtherUserSessions for the precise reasoning).
// @access  Private
router.post('/sign-out-all', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const revoked = await revokeOtherUserSessions(req.user._id, req.sessionId);

    try {
      const UserNotification = require('../models/UserNotification');
      await UserNotification.create({
        user: req.user._id,
        type: 'info',
        title: 'Signed out other devices',
        detail: revoked > 0
          ? `${revoked} other ${revoked === 1 ? 'session was' : 'sessions were'} signed out. Saved logins on those devices were removed too.`
          : 'No other active sessions were found.',
      }).catch(() => {});
    } catch { /* best-effort trail */ }

    res.json({
      message: revoked > 0
        ? `Signed out ${revoked} other ${revoked === 1 ? 'device' : 'devices'}.`
        : 'No other active sessions were found.',
      revoked,
    });
  } catch (error) {
    console.error('[sign-out-all]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// @route   POST /api/auth/two-factor-method
// @desc    Choose WHICH second factor is used at sign-in.
//          Switching TO 'authenticator' is refused here — that has to go
//          through setup-2fa/verify-2fa so a hijacked session can't silently
//          install an authenticator it controls. Switching TO 'email' requires
//          the current password, because it removes a stronger factor.
// @access  Private
router.post('/two-factor-method', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const method = str(req.body?.method);
    if (!['authenticator', 'email'].includes(method)) {
      return res.status(400).json({ message: 'Choose either the authenticator app or email codes.' });
    }

    // Both secret fields are `select: false`, so they have to be asked for
    // explicitly — and a readable seed is the ONLY thing that proves an
    // authenticator was actually set up.
    const user = await User.findById(req.user._id).select(totpSecret.SECRET_FIELDS);
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });
    const hasAuthenticator = Boolean(totpSecret.readSecret(user));

    // Switching TO the authenticator requires a real, already-verified
    // authenticator. Checking `twoFactorEnabled` here is NOT enough: an account
    // on email 2FA has that flag set, so the old guard let them "choose" an
    // authenticator they never configured — and then login demanded a TOTP
    // they had no way to produce, locking them out of their own account.
    if (method === 'authenticator' && !hasAuthenticator) {
      return res.status(409).json({ message: 'Set up an authenticator app first, then choose it here.' });
    }
    if (user.twoFactorEnabled && method === 'email') {
      const ok = await user.matchPassword(str(req.body?.currentPassword));
      if (!ok) {
        return res.status(401).json({ message: 'Enter your current password to switch to email codes.' });
      }
    }

    user.twoFactorMethod = method;
    user.twoFactorEnabled = true;
    // Leaving the authenticator method for email must not leave a live TOTP
    // seed behind: it is dead weight that a future switch back would silently
    // re-enable, and a stored seed is a stored credential. Encrypted or not,
    // it goes.
    if (method === 'email') totpSecret.clearSecret(user);
    await user.save();

    await SecurityEvent.write({
      user: user._id, type: 'mfa-enabled', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      reason: method === 'email' ? 'Switched to emailed sign-in codes' : 'Switched to the authenticator app',
      meta: { factor: method === 'email' ? 'email-otp' : 'totp' },
    });

    try {
      const UserNotification = require('../models/UserNotification');
      await UserNotification.create({
        user: user._id,
        type: 'info',
        title: 'Two-factor method changed',
        detail: method === 'email'
          ? 'Sign-in codes are now sent to your email address. This is weaker than an authenticator app — it protects your password, but not an attacker who already has your mailbox.'
          : 'Your authenticator app is now the second factor used at sign-in.',
      }).catch(() => {});
    } catch { /* best-effort trail */ }

    res.json({
      message: method === 'email'
        ? 'Sign-in codes will now be emailed to you.'
        : 'Your authenticator app is now used at sign-in.',
      twoFactorMethod: user.twoFactorMethod,
      twoFactorEnabled: user.twoFactorEnabled,
    });
  } catch (error) {
    console.error('[two-factor-method]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// NOTE: a second `POST /api/auth/resend-password-reset-otp` used to be
// registered further down this file. Express resolves a path against handlers in
// registration order, so that copy was unreachable — it had been superseded by
// the legacy alias above, which delegates to utils/passwordReset.js — and it is
// gone rather than left as dead code carrying a weaker security posture than
// the live route it shadowed. The live route is the alias registered above.

// @route   POST /api/auth/request-email-otp
// @desc    Request OTP for email change
// @access  Private
router.post('/request-email-otp', async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer')) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    // Same session rules as `protect`: signature + session exists + belongs
    // to this account + unrevoked + still the account's current session.
    const check = await verifyUserSession(decoded);
    if (!check.ok) return rejectSession(res, check);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: 'Not authorized, user not found', code: SESSION_INVALID });
    }

    // Check rate limiting (60 second cooldown)
    const lastRequest = otpRateLimitMap.get(user._id.toString());
    if (lastRequest) {
      const timeSinceLastRequest = Date.now() - lastRequest;
      if (timeSinceLastRequest < OTP_COOLDOWN_MS) {
        const remainingSeconds = Math.ceil((OTP_COOLDOWN_MS - timeSinceLastRequest) / 1000);
        return res.status(429).json({ 
          message: `Please wait ${remainingSeconds} seconds before requesting another code.`,
          remainingSeconds,
        });
      }
    }

    const { newEmail } = req.body;

    if (!newEmail) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const trimmedEmail = str(newEmail).trim().toLowerCase();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }

    // Check if email is already in use
    const existingUser = await User.findOne({ email: trimmedEmail });
    if (existingUser && existingUser._id.toString() !== user._id.toString()) {
      return res.status(400).json({ message: 'Email already in use by another account.' });
    }

    // The code proves control of the NEW address, so it must not exist in the
    // store unless it actually reached that address.
    const issued = await issueOtp(trimmedEmail, `${user._id}_${trimmedEmail}`, user._id.toString(), 'email-change');
    if (!issued.ok) return otpDeliveryFailed(res);

    res.json({
      message: 'Verification code sent to your email successfully',
    });
  } catch (error) {
    console.error('[request-email-otp]', error.message);
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
    }
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// @route   POST /api/auth/verify-email-otp
// @desc    Verify OTP for email change
// @access  Private
router.post('/verify-email-otp', async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer')) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const check = await verifyUserSession(decoded);
    if (!check.ok) return rejectSession(res, check);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: 'Not authorized, user not found', code: SESSION_INVALID });
    }

    const { newEmail, otp } = req.body;

    if (!newEmail || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    const trimmedEmail = str(newEmail).trim().toLowerCase();
    const otpKey = `${user._id}_${trimmedEmail}`;

    // Account lockout: repeated OTP failures escalate 15 min → 1 day
    const emailOtpLockKey = accountKey('otp-user', user._id);
    const emailOtpLockedMs = lockRemainingMs(emailOtpLockKey);
    if (emailOtpLockedMs > 0) {
      reportAccountLockout({ userId: user._id, minutes: Math.ceil(emailOtpLockedMs / 60000), lockKey: emailOtpLockKey });
      return res.status(429).json({
        message: `Too many incorrect attempts. Try again in ${Math.ceil(emailOtpLockedMs / 60000)} minute(s).`,
        remainingSeconds: Math.ceil(emailOtpLockedMs / 1000),
        escalated: true,
        lockedBy: 'account',
      });
    }
    const verdict = otpChallenge.consume(otpStore, otpKey, str(otp).trim());

    if (!verdict.ok) {
      if (verdict.outcome === 'locked') {
        recordOtpOffense(accountKey('otp-user', user._id));
        return res.status(429).json({ message: 'Too many incorrect attempts. Please request a new code.' });
      }
      // One answer for missing, expired, malformed and wrong — see the note on
      // OTP_REJECTION_MESSAGE. This route is behind a valid session, so there is
      // no enumeration concern here, but there is no reason to tell a caller
      // which challenges exist either.
      return res.status(400).json({ message: OTP_REJECTION_MESSAGE });
    }

    clearOffenses(accountKey('otp-user', user._id));

    // Record the proof server-side: PUT /profile will only ever accept a
    // change to THIS exact address, for THIS account, inside the TTL below.
    emailChangeProofs.set(String(user._id), {
      email: trimmedEmail,
      expiresAt: Date.now() + EMAIL_PROOF_TTL_MS,
    });

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('[verify-email-otp]', error.message);
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
    }
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// @route   PUT /api/auth/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer')) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const check = await verifyUserSession(decoded);
    if (!check.ok) return rejectSession(res, check);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: 'Not authorized, user not found', code: SESSION_INVALID });
    }

    // NOTE: `emailVerified` is intentionally NOT read from the request body.
    // The client flag used to be the only gate on an email change, so any
    // signed-in session could silently rebind the account to an address it
    // never controlled (then use "forgot password" to take it over). Only the
    // server-side proof recorded by /verify-email-otp is accepted below.
    const { firstName, lastName, email, dateOfBirth, gender, currentPassword, newPassword, profilePicture, bannerPicture } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !dateOfBirth || !gender) {
      return res.status(400).json({ message: 'Please fill in all required fields.' });
    }

    // Name validation
    const first = str(firstName).trim();
    const last = str(lastName).trim();

    if (first.length < 2) {
      return res.status(400).json({ message: 'First name must be at least 2 characters.' });
    }
    if (first.length > 50) {
      return res.status(400).json({ message: 'First name must be 50 characters or fewer.' });
    }
    if (last.length < 2) {
      return res.status(400).json({ message: 'Last name must be at least 2 characters.' });
    }
    if (last.length > 50) {
      return res.status(400).json({ message: 'Last name must be 50 characters or fewer.' });
    }

    // Gender validation
    if (!['Male', 'Female'].includes(gender)) {
      return res.status(400).json({ message: 'Please select a valid gender.' });
    }

    // Email validation
    const trimmedEmail = str(email).trim().toLowerCase();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address (e.g. name@example.com).' });
    }

    // Check if email is taken by another user and require server-side proof
    // that the NEW address's OTP was really verified for this account.
    const emailChanged = trimmedEmail !== user.email;
    if (emailChanged) {
      const proof = emailChangeProofs.get(String(user._id));
      if (!proof || proof.email !== trimmedEmail || Date.now() > proof.expiresAt) {
        return res.status(400).json({ message: 'Email change requires verification. Please verify your email first.' });
      }

      const existingUser = await User.findOne({ email: trimmedEmail });
      if (existingUser) {
        return res.status(400).json({ message: 'Email already in use by another account.' });
      }
    }

    // Date of birth validation
    const birthDate = new Date(dateOfBirth);
    if (isNaN(birthDate.getTime())) {
      return res.status(400).json({ message: 'Please enter a valid date of birth.' });
    }
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    if (age < 1 || age > 120) {
      return res.status(400).json({ message: 'Please enter a valid date of birth (age must be between 1 and 120).' });
    }

    // Password change validation
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ message: 'Please enter your current password to change it.' });
      }

      const isMatch = await user.matchPassword(currentPassword);
      if (!isMatch) {
        return res.status(400).json({ message: 'Current password is incorrect.' });
      }

      // Check if new password is same as current password
      const isSamePassword = await user.matchPassword(newPassword);
      if (isSamePassword) {
        return res.status(400).json({ message: 'Your new password must be different from your current password.' });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({ message: 'New password must be at least 8 characters.' });
      }
      if (!/[A-Z]/.test(newPassword)) {
        return res.status(400).json({ message: 'New password must contain at least one uppercase letter.' });
      }
      if (!/[0-9]/.test(newPassword)) {
        return res.status(400).json({ message: 'New password must contain at least one number.' });
      }

      user.password = newPassword;
    }

    // Update user fields
    user.firstName = first;
    user.lastName = last;
    user.email = trimmedEmail;
    user.dateOfBirth = birthDate;
    user.gender = gender;

    // Images are written to disk and referenced by URL rather than stored
    // inline. Storing the `data:` string on the document made this account
    // ~3 MB, which then had to be read and rewritten on every sign-in — see
    // utils/pictures.js. `storePicture` validates the type and decoded size,
    // and passes an already-stored path straight back through, so re-saving a
    // profile that did not change its picture costs nothing.
    if (profilePicture !== undefined) {
      try {
        user.profilePicture = storePicture({
          ownerId: user._id,
          kind: 'profile',
          value: profilePicture,
          maxBytes: MAX_PROFILE_BYTES,
        });
      } catch (err) {
        return res.status(err.statusCode || 400).json({ message: err.message });
      }
    }

    // Update banner picture if provided
    if (bannerPicture !== undefined) {
      try {
        user.bannerPicture = storePicture({
          ownerId: user._id,
          kind: 'banner',
          value: bannerPicture,
          maxBytes: MAX_BANNER_BYTES,
        });
      } catch (err) {
        return res.status(err.statusCode || 400).json({ message: err.message });
      }
    }

    await user.save();

    // Consume the email-change proof: it is single-use, so it can never
    // authorize a second, different rebinding later.
    if (emailChanged) emailChangeProofs.delete(String(user._id));

    // Security trail: profile password changes show up in Recent security activity
    if (newPassword) {
      // Session scope note: the backend enforces exactly ONE live session per
      // account (sign-in flips User.currentSessionId and revokes whatever it
      // displaced), and this route is itself authenticated. So the caller's
      // session is by definition the only one that exists — there is nothing
      // else to revoke, and signing the user straight back out here would be
      // a pure UX regression. The unauthenticated /reset-password flow, where
      // an intruder CAN still be holding a token, does revoke everything.
      try {
        const UserNotification = require('../models/UserNotification');
        await UserNotification.create({
          user: user._id,
          type: 'info',
          title: 'Password changed',
          detail: 'Your password was just changed. If this wasn\'t you, reset it and contact support immediately.',
        }).catch(() => {});
      } catch { /* best-effort */ }
    }

    res.json({
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.fullName,
      email: user.email,
      dateOfBirth: user.dateOfBirth,
      age: user.age,
      gender: user.gender,
      profilePicture: safePictureValue(user.profilePicture),
      bannerPicture: safePictureValue(user.bannerPicture),
      subscriptionActive: user.subscriptionActive,
      subscriptionPlan: user.subscriptionPlan,
      subscriptionUpdatedAt: user.subscriptionUpdatedAt,
      subscription: describeSubscription(user),
      twoFactorEnabled: user.twoFactorEnabled,
      twoFactorMethod: user.twoFactorEnabled ? (user.twoFactorMethod || 'authenticator') : null,
      passwordChangedAt: user.passwordChangedAt || null,
    });
  } catch (error) {
    console.error('[profile update]', error.message);
    if (error.name === 'ValidationError') {
      const msg = Object.values(error.errors).map(e => e.message).join(' ');
      return res.status(400).json({ message: msg });
    }
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
    }
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// @route   POST /api/auth/admin-activity
// @desc    "I am still here" — the admin dashboard's activity beacon.
//
// WHY THIS EXISTS
//
// The admin dashboard polls its data every 10 seconds, and those polls are
// marked `X-Admin-Background`, so the server deliberately does NOT count them
// as activity: an unattended tab left open overnight must not hold a session
// alive all night. That is right, and it creates a mismatch. The client
// countdown resets on real user input (key, mouse, scroll), while the server
// only ever learns of activity from a NON-background request. So an
// administrator could sit reading the dashboard, moving the mouse, never
// clicking anything — and watch a badge count down from ten minutes that never
// runs out, while the server signs them out underneath it. A countdown that
// lies about when you will be logged out is worse than no countdown.
//
// This is the missing signal: proof of a person at the keyboard, sent at most
// once a minute, and only while there is one. It is a real request, so the
// middleware's existing conditional heartbeat stamps `lastActivityAt` and the
// idle window genuinely slides — exactly as it does for any other activity.
//
// It mints NO token (unlike /auth/admin-refresh) and returns no data, so it is
// not on the token-keepalike path and cannot be used to extend anything. It is
// excluded from the sensitive auth budget in index.js, because spending a
// login attempt on a background ping would lock working admins out of signing
// in at all.
router.post('/admin-activity', protect, async (req, res) => {
  // `protect` has already run the full gauntlet for this request and stamped
  // the activity. There is nothing left to do but confirm it, and to report
  // what the server now believes, so the client can correct its own countdown
  // instead of continuing to display a number that was never enforced.
  return res.json({
    ok: true,
    idleLimitSeconds: ADMIN_IDLE_LIMIT_SECONDS,
    // Echoed so the client can tell "the server slid the window" from "the
    // request never arrived" and re-anchor on the server's clock rather than
    // assuming its own local one is right.
    serverTime: Date.now(),
  });
});

module.exports = router;
