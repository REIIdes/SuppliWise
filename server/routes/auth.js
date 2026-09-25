const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const User = require('../models/User');
const AdminAccount = require('../models/AdminAccount');
const AdminEvent = require('../models/AdminEvent');
// Admin idle window (single source of truth — middleware/auth.js mirrors it).
// Frontend countdown (3:30) must match the server idle kill exactly.
const ADMIN_IDLE_TIMEOUT_MS = (3 * 60 + 30) * 1000;
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
const { sendOtpEmail } = require('../utils/email');
const { normalizeIp, ipKind, resolveLoginLocation } = require('../utils/geo');
const { verifyTotpOnce } = require('../utils/totp');
const { newChallenge, verifyCaptcha } = require('../utils/captcha');

// Math CAPTCHA challenge for registration (bot-resistant signup).
// Public but rate-limited with the rest of /api/auth.
router.get('/captcha', (req, res) => {
  res.json(newChallenge());
});
const { recordOffense, recordAccountFailure, lockRemainingMs, clearOffenses, clearAccountState, accountKey, limitReachedHandler, reportAccountLockout, deviceFingerprint, noteIpAccountFailure, lockMeta } = require('../utils/lockout');

// lockMeta (the evidence bundle attached to lockout entries) now lives in
// utils/lockout.js so every caller builds the same shape.

// Stricter brute-force guard for the most sensitive auth steps (admin login,
// 2FA and OTP verification). Layered on top of the global /api/auth limiter;
// every 429 climbs the 15 min → 1 day lockout ladder.
const rateLimit = require('express-rate-limit');
const sensitiveLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
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
const otpStore = new Map(); // Format: { email: { otp, expiresAt, requestedAt, attempts } }

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

// Max wrong-code attempts per OTP before it is invalidated (brute-force guard)
const MAX_OTP_ATTEMPTS = 5;

// Fire-and-forget OTP delivery — responds at admin-login speed instead of
// blocking on Gmail SMTP (often 3-10s per send). On failure the stored OTP
// and cooldown are cleared so the user can retry immediately; the failure
// is logged server-side for diagnosis.
function sendOtpInBackground(toEmail, otp, type, otpKey, rateKey) {
  sendOtpEmail(toEmail, otp, type).then((sent) => {
    if (!sent) {
      otpStore.delete(otpKey);
      if (rateKey) otpRateLimitMap.delete(rateKey);
      console.error(`[otp-email] background delivery failed (${type}) to ${maskEmail(toEmail)}`);
    }
  }).catch((err) => {
    otpStore.delete(otpKey);
    if (rateKey) otpRateLimitMap.delete(rateKey);
    console.error(`[otp-email] background delivery error (${type}) for ${maskEmail(toEmail)}:`, err.message);
  });
}

// Records a failed OTP attempt. Returns true when the caller should reject the
// attempt, and invalidates the stored OTP once the limit is reached.
function registerOtpAttempt(key, storedData) {
  storedData.attempts = (storedData.attempts || 0) + 1;
  if (storedData.attempts >= MAX_OTP_ATTEMPTS) {
    otpStore.delete(key);
    return 'locked';
  }
  otpStore.set(key, storedData);
  return 'mismatch';
}

// Rate limiting map for OTP requests
const otpRateLimitMap = new Map(); // Format: { userId: lastRequestTime }
const OTP_COOLDOWN_MS = 30000; // 30 seconds cooldown

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

function adminToken(account) {
  return generateToken(String(account._id), { role: 'admin', alias: account.alias, adminId: String(account._id) }, { expiresIn: '5m' });
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

    // Password validation (length capped — keeps hashing inputs bounded)
    if (password.length < 8) {
      return res.status(400).json({ message: 'Your password is too short — please use at least 8 characters.' });
    }
    if (password.length > 128) {
      return res.status(400).json({ message: 'Your password must be 128 characters or fewer.' });
    }
    if (!/[A-Z]/.test(password)) {
      return res.status(400).json({ message: 'Add at least one capital letter to make your password stronger.' });
    }
    if (!/[0-9]/.test(password)) {
      return res.status(400).json({ message: 'Add at least one number to make your password stronger.' });
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
      profilePicture: user.profilePicture,
      bannerPicture: user.bannerPicture,
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

    const user = await User.findOne({ email: trimmedEmail });

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
    if (typeof user.save === 'function') await user.save();
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
    const usesAuthenticator = user.twoFactorEnabled === true && twoFactorMethod === 'authenticator';

    if (usesAuthenticator) {
      // Kick off background geo-resolution (never blocks the response)
      resolveLoginLocation(user._id, loginIp, user.lastLoginLocation);
      return res.json({
        requiresTwoFactor: true,
        userId: user._id,
        message: 'Google Authenticator verification required.',
      });
    }

    // Credentials valid - generate and send OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP with user ID
    const otpKey = `login_${user._id}`;
    otpStore.set(otpKey, { otp, expiresAt, requestedAt: Date.now() });

    // Update rate limit
    otpRateLimitMap.set(user._id.toString(), Date.now());

    // Deliver in the background — respond now at admin-login speed
    sendOtpInBackground(trimmedEmail, otp, 'login', otpKey, user._id.toString());
    // Geo-resolve the login IP in the background too (never blocks login)
    resolveLoginLocation(user._id, loginIp, user.lastLoginLocation);

    res.json({
      message: 'Verification code sent to your email successfully',
      requiresOtp: true,
      userId: user._id,
      // Lets the client label the step honestly: "your second factor" when the
      // user chose email as their method, plain email verification otherwise.
      twoFactorMethod: user.twoFactorEnabled === true ? 'email' : null,
    });
  } catch (error) {
    console.error('[login]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
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
  adminChallenges.set(challengeId, { accountId: account._id, alias: account.alias, totpSecret: account.totpSecret, expiresAt: Date.now() + ADMIN_CHALLENGE_TTL_MS });
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

  const verified = verifyTotpOnce(challenge.totpSecret, otp);
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
  if (account._id && account._id !== 'admin') await AdminAccount.findByIdAndUpdate(account._id, { lastLoginAt: new Date(), lastActivityAt: new Date() });
  return res.json({ token: adminToken(account), role: 'admin', alias: account.alias });
});

// @route   POST /api/auth/admin-refresh
// @desc    Sliding admin session: verify the current token, touch activity,
//          and issue a fresh 5-minute JWT. Called by "Stay Signed In" so the
//          countdown visibly resets only after the backend confirms.
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
    if (admin.lastActivityAt && Date.now() - admin.lastActivityAt.getTime() > ADMIN_IDLE_TIMEOUT_MS) {
      return res.status(401).json({ message: 'Admin session expired after inactivity.' });
    }
    await AdminAccount.updateOne({ _id: admin._id }, { $set: { lastActivityAt: new Date() } }).exec()
      .catch(() => {});
    return res.json({
      token: adminToken({ _id: String(admin._id), alias: admin.alias }),
      role: 'admin',
      alias: admin.alias,
      expiresInSeconds: 5 * 60,
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

  try {
    if (!userId || !otp) {
      return res.status(400).json({ message: 'User ID and OTP are required' });
    }

    // Account lockout: repeated OTP failures escalate 15 min → 1 day
    const otpLockKey = accountKey('otp-user', userId);
    const otpLockedMs = lockRemainingMs(otpLockKey);
    if (otpLockedMs > 0) {
      reportAccountLockout({ userId, minutes: Math.ceil(otpLockedMs / 60000), lockKey: otpLockKey });
      return res.status(429).json({
        message: `Too many incorrect attempts. Try again in ${Math.ceil(otpLockedMs / 60000)} minute(s).`,
        remainingSeconds: Math.ceil(otpLockedMs / 1000),
        escalated: true,
        lockedBy: 'account',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const otpKey = `login_${userId}`;
    const storedData = otpStore.get(otpKey);

    if (!storedData) {
      return res.status(400).json({ message: 'No OTP request found. Please try logging in again.' });
    }

    // Check if OTP has expired
    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(otpKey);
      return res.status(400).json({ message: 'Verification code has expired. Please try logging in again.' });
    }

    // Verify OTP (wrong attempts are counted; the code is invalidated after MAX_OTP_ATTEMPTS)
    if (storedData.otp !== str(otp).trim()) {
      const outcome = registerOtpAttempt(otpKey, storedData);
      if (outcome === 'locked') {
        recordOffense(accountKey('otp-user', userId));
        return res.status(429).json({ message: 'Too many incorrect attempts. Please request a new code.' });
      }
      return res.status(400).json({ message: 'Invalid verification code. Please try again.' });
    }

    // OTP is valid, remove from store
    otpStore.delete(otpKey);
    clearOffenses(accountKey('otp-user', userId));

    // One active session per account: this atomically becomes the account's
    // current session and revokes the previous one — in ANY other tab,
    // browser or device (the "last session gets logged out" rule). Other
    // accounts are untouched.
    const token = await issueUserSession(user._id, describeDevice({
      userAgent: req.get('user-agent'), ip: req.ip,
      location: user.lastLoginLocation || '',
    }));

    // OPT-IN "save my login": attach a remember credential to THIS session so
    // this browser can re-enter (and switch back) without retyping the
    // password. Best-effort — a failed attach must never fail the sign-in.
    let rememberToken = '';
    if (remember === true || remember === 'true') {
      try { rememberToken = await attachRememberToken(token); } catch { rememberToken = ''; }
    }
    if (rememberToken) {
      // Marks the device as trusted in its own right so the security page can
      // list it and the user can revoke it. The credential hash stays the
      // trust anchor; trustedAt is only a timestamp for display.
      await markSessionTrusted(token).catch(() => {});
    }

    await SecurityEvent.write({
      user: user._id,
      type: user.twoFactorEnabled === true ? 'mfa-success' : 'login-success',
      success: true,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      location: user.lastLoginLocation || '',
      reason: user.twoFactorEnabled === true ? 'Signed in with an emailed code' : 'Password accepted',
    });

    // Return user data and token (no expiry — revocation is session-based)
    res.json({
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.fullName,
      email: user.email,
      dateOfBirth: user.dateOfBirth,
      age: user.age,
      gender: user.gender,
      profilePicture: user.profilePicture,
      bannerPicture: user.bannerPicture,
      subscriptionActive: user.subscriptionActive,
      subscriptionPlan: user.subscriptionPlan,
      subscription: describeSubscription(user),
      token,
      ...(rememberToken ? { rememberToken } : {}),
    });
  } catch (error) {
    console.error('[verify-login-otp]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
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
        profilePicture: user.profilePicture,
        bannerPicture: user.bannerPicture,
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
    user.twoFactorSecret = secret.base32;
    await user.save();
    res.json({ qrCode: await QRCode.toDataURL(secret.otpauth_url), secret: secret.base32 });
  } catch (error) {
    res.status(401).json({ message: 'Unable to start two-factor setup.' });
  }
});

router.post('/verify-2fa', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const user = await User.findById(req.user._id).select('+twoFactorSecret');
    if (!user || !user.twoFactorSecret) return res.status(400).json({ message: 'Two-factor setup was not started.' });
    const verified = verifyTotpOnce(user.twoFactorSecret, req.body.otp);
    if (!verified) return res.status(401).json({ message: 'Invalid verification code.' });
    user.twoFactorEnabled = true;
    // Verifying a TOTP IS choosing the authenticator method — record it, so
    // the UI and the login branch agree on which factor this account uses.
    user.twoFactorMethod = 'authenticator';
    await user.save();
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
  try {
    const user = await User.findById(req.body.userId).select('+twoFactorSecret');
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) return res.status(401).json({ message: 'Two-factor authentication is not enabled.' });
    // Account lockout check + failure recording (ladder 15 min → 1 day)
    const tfaLockKey = accountKey('otp-user', req.body.userId);
    if (lockRemainingMs(tfaLockKey) > 0) {
      const left = lockRemainingMs(tfaLockKey);
      reportAccountLockout({ userId: req.body.userId, minutes: Math.ceil(left / 60000), lockKey: tfaLockKey });
      return res.status(429).json({
        message: `Too many incorrect attempts. Try again in ${Math.ceil(left / 60000)} minute(s).`,
        remainingSeconds: Math.ceil(left / 1000),
        escalated: true,
        lockedBy: 'account',
      });
    }
    const verified = verifyTotpOnce(user.twoFactorSecret, req.body.otp);
    if (!verified) {
      recordAccountFailure(tfaLockKey, lockMeta(req, req.ip));
      await SecurityEvent.write({
        user: user._id, type: 'mfa-failure', success: false,
        ip: req.ip, userAgent: req.get('user-agent'),
        location: user.lastLoginLocation || '',
        reason: 'Authenticator code rejected at sign-in',
      });
      return res.status(401).json({ message: 'Invalid Google Authenticator code.' });
    }
    clearAccountState(tfaLockKey);
    // One active session per account (same atomic rotation as /verify-login-otp):
    // this sign-in displaces the account's previous session only — other
    // accounts' sessions are never affected.
    const token = await issueUserSession(user._id, describeDevice({
      userAgent: req.get('user-agent'), ip: req.ip,
      location: user.lastLoginLocation || '',
    }));
    // OPT-IN "save my login" (same contract as /verify-login-otp): best-effort
    // attach — a failed attach never fails the sign-in itself.
    let rememberToken = '';
    if (req.body.remember === true || req.body.remember === 'true') {
      try { rememberToken = await attachRememberToken(token); } catch { rememberToken = ''; }
    }
    if (rememberToken) await markSessionTrusted(token).catch(() => {});
    await SecurityEvent.write({
      user: user._id, type: 'mfa-success', success: true,
      ip: req.ip, userAgent: req.get('user-agent'),
      location: user.lastLoginLocation || '',
      reason: 'Signed in with your authenticator app',
    });
    res.json({ _id: user._id, firstName: user.firstName, lastName: user.lastName, name: user.fullName, email: user.email, dateOfBirth: user.dateOfBirth, age: user.age, gender: user.gender, profilePicture: user.profilePicture, bannerPicture: user.bannerPicture, twoFactorEnabled: true, subscriptionActive: user.subscriptionActive, subscriptionPlan: user.subscriptionPlan, subscription: describeSubscription(user), token, ...(rememberToken ? { rememberToken } : {}) });
  } catch (error) {
    res.status(401).json({ message: 'Unable to verify the 2FA code.' });
  }
});

router.post('/disable-2fa', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const user = await User.findById(req.user._id).select('+twoFactorSecret');
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
      const verified = verifyTotpOnce(user.twoFactorSecret, req.body.otp);
      if (!verified) return res.status(401).json({ message: 'Invalid Google Authenticator code.' });
    } else {
      const ok = await user.matchPassword(str(req.body.currentPassword));
      if (!ok) return res.status(401).json({ message: 'Enter your current password to turn off two-factor authentication.' });
    }

    user.twoFactorEnabled = false;
    user.twoFactorSecret = '';
    user.twoFactorMethod = 'authenticator'; // reset so a later re-enable defaults to the strong factor
    await user.save();
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

    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
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

    // Generate new OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP
    const otpKey = `login_${user._id}`;
    otpStore.set(otpKey, { otp, expiresAt, requestedAt: Date.now() });

    // Update rate limit
    otpRateLimitMap.set(user._id.toString(), Date.now());

    // Deliver in the background — respond now at admin-login speed
    sendOtpInBackground(user.email, otp, 'login', otpKey, user._id.toString());

    res.json({
      message: 'Verification code sent to your email successfully',
    });
  } catch (error) {
    console.error('[resend-login-otp]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// @route   POST /api/auth/forgot-password
// @desc    Request password reset - Send OTP to email
// @access  Public
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    if (!email) {
      return res.status(400).json({ message: 'Please enter your email address.' });
    }

    const trimmedEmail = str(email).trim().toLowerCase();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }

    const user = await User.findOne({ email: trimmedEmail });
    
    // Security: Don't reveal if email exists or not
    if (!user) {
      // Still return success to prevent email enumeration
      return res.json({ 
        message: 'If an account exists with this email, a verification code has been sent.',
      });
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

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP with password_reset prefix
    const otpKey = `password_reset_${user._id}`;
    otpStore.set(otpKey, { otp, expiresAt, requestedAt: Date.now() });

    // Update rate limit
    otpRateLimitMap.set(user._id.toString(), Date.now());

    // Deliver in the background — respond now at admin-login speed
    sendOtpInBackground(trimmedEmail, otp, 'password-reset', otpKey, user._id.toString());

    res.json({
      message: 'Verification code sent to your email successfully',
      userId: user._id,
    });
  } catch (error) {
    console.error('[forgot-password]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// @route   POST /api/auth/verify-password-reset-otp
// @desc    Verify OTP for password reset
// @access  Public
router.post('/verify-password-reset-otp', async (req, res) => {
  const { userId, otp } = req.body;

  try {
    if (!userId || !otp) {
      return res.status(400).json({ message: 'User ID and OTP are required' });
    }

    // Account lockout: repeated OTP failures escalate 15 min → 1 day
    const resetLockKey = accountKey('otp-user', userId);
    const resetLockedMs = lockRemainingMs(resetLockKey);
    if (resetLockedMs > 0) {
      reportAccountLockout({ userId, minutes: Math.ceil(resetLockedMs / 60000), lockKey: resetLockKey });
      return res.status(429).json({
        message: `Too many incorrect attempts. Try again in ${Math.ceil(resetLockedMs / 60000)} minute(s).`,
        remainingSeconds: Math.ceil(resetLockedMs / 1000),
        escalated: true,
        lockedBy: 'account',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ message: 'Invalid request' });
    }

    const otpKey = `password_reset_${userId}`;
    const storedData = otpStore.get(otpKey);

    if (!storedData) {
      return res.status(400).json({ message: 'No password reset request found. Please try again.' });
    }

    // Check if OTP has expired
    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(otpKey);
      return res.status(400).json({ message: 'Verification code has expired. Please request a new one.' });
    }

    // Verify OTP (wrong attempts are counted; the code is invalidated after MAX_OTP_ATTEMPTS)
    if (storedData.otp !== str(otp).trim()) {
      const outcome = registerOtpAttempt(otpKey, storedData);
      if (outcome === 'locked') {
        recordOffense(accountKey('otp-user', userId));
        return res.status(429).json({ message: 'Too many incorrect attempts. Please request a new code.' });
      }
      return res.status(400).json({ message: 'Invalid verification code. Please try again.' });
    }

    // OTP is valid - return success but DON'T delete OTP yet
    // We'll delete it after password is actually reset
    clearOffenses(accountKey('otp-user', userId));
    res.json({ 
      message: 'Code verified successfully',
      verified: true,
    });
  } catch (error) {
    console.error('[verify-password-reset-otp]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// @route   POST /api/auth/reset-password
// @desc    Reset password after OTP verification
// @access  Public
router.post('/reset-password', async (req, res) => {
  const { userId, otp, newPassword } = req.body;

  try {
    if (!userId || !otp || !newPassword) {
      return res.status(400).json({ message: 'User ID, OTP, and new password are required' });
    }

    // Lockout gate — this route verifies the SAME code as
    // /verify-password-reset-otp, so it must be just as hard to brute-force.
    // It previously had no gate at all (and was not in sensitiveLimiter), so
    // an attacker could skip the verify step entirely and hammer guesses here
    // forever: the offenses it recorded were never checked by this route.
    const resetLockKey = accountKey('otp-user', userId);
    const resetLockedMs = lockRemainingMs(resetLockKey);
    if (resetLockedMs > 0) {
      reportAccountLockout({ userId, minutes: Math.ceil(resetLockedMs / 60000), lockKey: resetLockKey });
      return res.status(429).json({
        message: `Too many incorrect attempts. Try again in ${Math.ceil(resetLockedMs / 60000)} minute(s).`,
        remainingSeconds: Math.ceil(resetLockedMs / 1000),
        escalated: true,
        lockedBy: 'account',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ message: 'Invalid request' });
    }

    const otpKey = `password_reset_${userId}`;
    const storedData = otpStore.get(otpKey);

    if (!storedData) {
      return res.status(400).json({ message: 'No password reset request found. Please try again.' });
    }

    // Check if OTP has expired
    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(otpKey);
      return res.status(400).json({ message: 'Verification code has expired. Please try again.' });
    }

    // Verify OTP one more time. Wrong attempts share the per-OTP attempt
    // counter used by /verify-password-reset-otp (5 strikes invalidates the
    // code and escalates the ladder) instead of only recording an offense
    // that nothing on this route ever consulted.
    if (storedData.otp !== str(otp).trim()) {
      const outcome = registerOtpAttempt(otpKey, storedData);
      if (outcome === 'locked') {
        recordOffense(resetLockKey);
        return res.status(429).json({ message: 'Too many incorrect attempts. Please request a new code.' });
      }
      return res.status(400).json({ message: 'Invalid verification code. Please try again.' });
    }

    // Password validation
    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'Your password is too short — please use at least 8 characters.' });
    }
    if (!/[A-Z]/.test(newPassword)) {
      return res.status(400).json({ message: 'Add at least one capital letter to make your password stronger.' });
    }
    if (!/[0-9]/.test(newPassword)) {
      return res.status(400).json({ message: 'Add at least one number to make your password stronger.' });
    }

    // Check if new password is same as current password
    const isSamePassword = await user.matchPassword(newPassword);
    if (isSamePassword) {
      return res.status(400).json({ message: 'Your new password must be different from your current password.' });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    // End every existing session for this account. A password reset is the
    // account owner proving they recovered from a compromise — the whole
    // point is that any token an intruder still holds stops working. This
    // route is unauthenticated, so before this fix someone who had already
    // signed in simply kept their access after the victim reset.
    await revokeAllUserSessions(user._id).catch(() => {});

    // Delete OTP after successful password reset
    otpStore.delete(otpKey);
    clearOffenses(accountKey('otp-user', userId));

    console.log(`[PASSWORD RESET] Password successfully reset for user: ${maskEmail(user.email)}`);

    // Security trail: password resets show up in Recent security activity
    try {
      const UserNotification = require('../models/UserNotification');
      await UserNotification.create({
        user: user._id,
        type: 'info',
        title: 'Password changed',
        detail: 'Your password was just reset. If this wasn\'t you, reset it again and contact support immediately.',
      }).catch(() => {});
    } catch { /* best-effort */ }

    res.json({
      message: 'Password reset successfully. You can now sign in with your new password.',
      success: true,
    });
  } catch (error) {
    console.error('[reset-password]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// @route   GET /api/auth/me
// @desc    Current user profile incl. subscription status (lightweight: no image blobs)
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const user = await User.findById(req.user._id)
      .select('-password -profilePicture -bannerPicture -twoFactorSecret -lastLoginIp -lastLoginUserAgent')
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
    const user = await User.findById(req.user._id).select('+twoFactorSecret');
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });

    const currentPassword = str(req.body?.currentPassword);
    const newPassword = str(req.body?.newPassword);

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Your current password and a new password are both required.' });
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
    if (newPassword === currentPassword) {
      return res.status(400).json({ message: 'Your new password must be different from your current one.' });
    }

    const ok = await user.matchPassword(currentPassword);
    if (!ok) {
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

    // twoFactorSecret is `select: false`, so it has to be asked for explicitly —
    // and it is the ONLY thing that proves an authenticator was actually set up.
    const user = await User.findById(req.user._id).select('+twoFactorSecret');
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });

    // Switching TO the authenticator requires a real, already-verified
    // authenticator. Checking `twoFactorEnabled` here is NOT enough: an account
    // on email 2FA has that flag set, so the old guard let them "choose" an
    // authenticator they never configured — and then login demanded a TOTP
    // they had no way to produce, locking them out of their own account.
    if (method === 'authenticator' && !user.twoFactorSecret) {
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
    // secret behind: it is dead weight that a future switch back would silently
    // re-enable. Disabled accounts already clear it below.
    if (method === 'email') user.twoFactorSecret = '';
    await user.save();

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

// @route   POST /api/auth/resend-password-reset-otp
// @desc    Resend OTP for password reset
// @access  Public
router.post('/resend-password-reset-otp', async (req, res) => {
  const { userId } = req.body;

  try {
    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ message: 'Invalid request' });
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

    // Generate new OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP
    const otpKey = `password_reset_${user._id}`;
    otpStore.set(otpKey, { otp, expiresAt, requestedAt: Date.now() });

    // Update rate limit
    otpRateLimitMap.set(user._id.toString(), Date.now());

    // Deliver in the background — respond now at admin-login speed
    sendOtpInBackground(user.email, otp, 'password-reset', otpKey, user._id.toString());

    res.json({
      message: 'Verification code sent to your email successfully',
    });
  } catch (error) {
    console.error('[resend-password-reset-otp]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

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

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP
    const otpKey = `${user._id}_${trimmedEmail}`;
    otpStore.set(otpKey, { otp, expiresAt, requestedAt: Date.now() });

    // Update rate limit
    otpRateLimitMap.set(user._id.toString(), Date.now());

    // Deliver in the background — respond now at admin-login speed
    sendOtpInBackground(trimmedEmail, otp, 'email-change', otpKey, user._id.toString());

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
    const storedData = otpStore.get(otpKey);

    if (!storedData) {
      return res.status(400).json({ message: 'No OTP request found. Please request a new code.' });
    }

    // Check if OTP has expired
    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(otpKey);
      return res.status(400).json({ message: 'Verification code has expired. Please request a new one.' });
    }

    // Verify OTP (wrong attempts are counted; the code is invalidated after MAX_OTP_ATTEMPTS)
    if (storedData.otp !== str(otp).trim()) {
      const outcome = registerOtpAttempt(otpKey, storedData);
      if (outcome === 'locked') {
        recordOffense(accountKey('otp-user', user._id));
        return res.status(429).json({ message: 'Too many incorrect attempts. Please request a new code.' });
      }
      return res.status(400).json({ message: 'Invalid verification code. Please try again.' });
    }

    // OTP is valid, remove from store
    otpStore.delete(otpKey);
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

    // Base64 images are capped so a single profile update cannot bloat the DB
    // (profile ≤ ~2 MB, banner ≤ ~3 MB incl. data-URL overhead)
    const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
    const MAX_BANNER_BYTES = 3 * 1024 * 1024;

    // Update profile picture if provided
    if (profilePicture !== undefined) {
      if (typeof profilePicture !== 'string' || Buffer.byteLength(profilePicture, 'utf8') > MAX_PROFILE_BYTES) {
        return res.status(413).json({ message: 'Profile picture is too large (max 2 MB).' });
      }
      user.profilePicture = profilePicture;
    }

    // Update banner picture if provided
    if (bannerPicture !== undefined) {
      if (typeof bannerPicture !== 'string' || Buffer.byteLength(bannerPicture, 'utf8') > MAX_BANNER_BYTES) {
        return res.status(413).json({ message: 'Banner image is too large (max 3 MB).' });
      }
      user.bannerPicture = bannerPicture;
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
      profilePicture: user.profilePicture,
      bannerPicture: user.bannerPicture,
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

module.exports = router;