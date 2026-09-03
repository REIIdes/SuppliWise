const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const User = require('../models/User');
const { sendOtpEmail } = require('../utils/email');

// In-memory OTP storage (in production, use Redis or database)
const otpStore = new Map(); // Format: { email: { otp, expiresAt, requestedAt } }

// Rate limiting map for OTP requests
const otpRateLimitMap = new Map(); // Format: { userId: lastRequestTime }
const OTP_COOLDOWN_MS = 30000; // 30 seconds cooldown
const shouldExposeDevOtp = () => process.env.ALLOW_DEV_OTP_RESPONSE === 'true';

// Generate JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '12h' });
};

// Email regex — requires a real TLD (2–6 letters), rejects .con, .cmo, etc.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,6}$/;
const SUSPICIOUS_TLDS = ['.con', '.cmo', '.ocm', '.nte', '.ogr', '.cpm'];

function isValidEmail(email) {
  if (!EMAIL_REGEX.test(email)) return false;
  const lower = email.toLowerCase();
  if (SUSPICIOUS_TLDS.some(tld => lower.endsWith(tld))) return false;
  return true;
}

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post('/register', async (req, res) => {
  const { firstName, lastName, name, email, password, dateOfBirth, gender } = req.body;

  try {
    // Support both new format (firstName + lastName) and old format (name)
    let first, last;
    
    if (firstName && lastName) {
      // New format
      first = firstName.trim();
      last = lastName.trim();
    } else if (name) {
      // Old format - split name into first and last
      const parts = name.trim().split(/\s+/);
      first = parts[0] || '';
      last = parts.slice(1).join(' ') || parts[0] || ''; // If only one word, use it for both
    } else {
      return res.status(400).json({ message: 'Please fill in all fields.' });
    }

    if (!email || !password || !dateOfBirth || !gender) {
      return res.status(400).json({ message: 'Please fill in all fields.' });
    }

    // Name validation
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
    const trimmedEmail = email.trim().toLowerCase();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address (e.g. name@example.com).' });
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

    // Password validation
    if (password.length < 8) {
      return res.status(400).json({ message: 'Your password is too short — please use at least 8 characters.' });
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
      token: generateToken(user._id),
    });
  } catch (error) {
    console.error('[register]', error.message);
    // Pass Mongoose validation errors through cleanly; hide everything else
    if (error.name === 'ValidationError') {
      const msg = Object.values(error.errors).map(e => e.message).join(' ');
      return res.status(400).json({ message: msg });
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
    if (!email || !password) {
      return res.status(400).json({ message: 'Please fill in all fields.' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }

    const user = await User.findOne({ email: trimmedEmail });
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    if (user.twoFactorEnabled) {
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

    // Send OTP via email
    const emailSent = await sendOtpEmail(trimmedEmail, otp, 'login');

    console.log(`[OTP] Login verification for ${user.email}: ${otp}`);
    console.log(`[OTP] Expires at: ${new Date(expiresAt).toISOString()}`);
    console.log(`[OTP] Email sent: ${emailSent}`);
    console.log(`[OTP] *** RELOADED - NEW CODE IS RUNNING ***`);

    res.json({
      message: emailSent 
        ? 'Verification code sent to your email successfully' 
        : 'Verification code generated (check console in development)',
      requiresOtp: true,
      userId: user._id,
      // In development, include OTP in response (remove in production!)
      ...(shouldExposeDevOtp() && { otp }),
    });
  } catch (error) {
    console.error('[login]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

// @route   POST /api/auth/verify-login-otp
// @desc    Login user - Step 2: Verify OTP and issue token
// @access  Public
router.post('/verify-login-otp', async (req, res) => {
  const { userId, otp } = req.body;

  try {
    if (!userId || !otp) {
      return res.status(400).json({ message: 'User ID and OTP are required' });
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

    // Verify OTP
    if (storedData.otp !== otp.trim()) {
      return res.status(400).json({ message: 'Invalid verification code. Please try again.' });
    }

    // OTP is valid, remove from store
    otpStore.delete(otpKey);

    // Return user data and token
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
      token: generateToken(user._id),
    });
  } catch (error) {
    console.error('[verify-login-otp]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

router.post('/setup-2fa', async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Not authorized.' });
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ message: 'Not authorized.' });
    const secret = speakeasy.generateSecret({ name: `SuppliWise (${user.email})`, issuer: 'SuppliWise' });
    user.twoFactorSecret = secret.base32;
    await user.save();
    res.json({ qrCode: await QRCode.toDataURL(secret.otpauth_url), secret: secret.base32 });
  } catch (error) {
    res.status(401).json({ message: 'Unable to start two-factor setup.' });
  }
});

router.post('/verify-2fa', async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Not authorized.' });
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('+twoFactorSecret');
    if (!user || !user.twoFactorSecret) return res.status(400).json({ message: 'Two-factor setup was not started.' });
    const verified = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token: String(req.body.otp || '').trim(), window: 1 });
    if (!verified) return res.status(401).json({ message: 'Invalid verification code.' });
    user.twoFactorEnabled = true;
    await user.save();
    res.json({ message: 'Two-factor authentication enabled successfully.', twoFactorEnabled: true });
  } catch (error) {
    res.status(401).json({ message: 'Unable to verify the authentication code.' });
  }
});

router.post('/login-2fa', async (req, res) => {
  try {
    const user = await User.findById(req.body.userId).select('+twoFactorSecret');
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) return res.status(401).json({ message: 'Two-factor authentication is not enabled.' });
    const verified = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token: String(req.body.otp || '').trim(), window: 1 });
    if (!verified) return res.status(401).json({ message: 'Invalid Google Authenticator code.' });
    res.json({ _id: user._id, firstName: user.firstName, lastName: user.lastName, name: user.fullName, email: user.email, dateOfBirth: user.dateOfBirth, age: user.age, gender: user.gender, profilePicture: user.profilePicture, bannerPicture: user.bannerPicture, twoFactorEnabled: true, token: generateToken(user._id) });
  } catch (error) {
    res.status(401).json({ message: 'Unable to verify the 2FA code.' });
  }
});

router.post('/disable-2fa', async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Not authorized.' });
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('+twoFactorSecret');
    const verified = user && user.twoFactorEnabled && speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token: String(req.body.otp || '').trim(), window: 1 });
    if (!verified) return res.status(401).json({ message: 'Invalid Google Authenticator code.' });
    user.twoFactorEnabled = false;
    user.twoFactorSecret = '';
    await user.save();
    res.json({ message: 'Google Authenticator has been disabled successfully.', twoFactorEnabled: false });
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

    // Send OTP via email
    const emailSent = await sendOtpEmail(user.email, otp, 'login');

    console.log(`[OTP] Login resend verification for ${user.email}: ${otp}`);
    console.log(`[OTP] Expires at: ${new Date(expiresAt).toISOString()}`);
    console.log(`[OTP] Email sent: ${emailSent}`);

    res.json({ 
      message: emailSent 
        ? 'Verification code sent to your email successfully' 
        : 'Verification code generated (check console in development)',
      // In development, include OTP in response (remove in production!)
      ...(shouldExposeDevOtp() && { otp }),
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

    const trimmedEmail = email.trim().toLowerCase();
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

    // Send OTP via email
    const emailSent = await sendOtpEmail(trimmedEmail, otp, 'password-reset');

    console.log(`[OTP] Password reset verification for ${user.email}: ${otp}`);
    console.log(`[OTP] Expires at: ${new Date(expiresAt).toISOString()}`);
    console.log(`[OTP] Email sent: ${emailSent}`);

    res.json({ 
      message: emailSent 
        ? 'Verification code sent to your email successfully' 
        : 'Verification code generated (check console in development)',
      userId: user._id,
      // In development, include OTP in response (remove in production!)
      ...(process.env.NODE_ENV === 'development' && { otp }),
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

    // Verify OTP
    if (storedData.otp !== otp.trim()) {
      return res.status(400).json({ message: 'Invalid verification code. Please try again.' });
    }

    // OTP is valid - return success but DON'T delete OTP yet
    // We'll delete it after password is actually reset
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

    // Verify OTP one more time
    if (storedData.otp !== otp.trim()) {
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

    // Delete OTP after successful password reset
    otpStore.delete(otpKey);

    console.log(`[PASSWORD RESET] Password successfully reset for user: ${user.email}`);

    res.json({ 
      message: 'Password reset successfully. You can now sign in with your new password.',
      success: true,
    });
  } catch (error) {
    console.error('[reset-password]', error.message);
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

    // Send OTP via email
    const emailSent = await sendOtpEmail(user.email, otp, 'password-reset');

    console.log(`[OTP] Password reset resend verification for ${user.email}: ${otp}`);
    console.log(`[OTP] Expires at: ${new Date(expiresAt).toISOString()}`);
    console.log(`[OTP] Email sent: ${emailSent}`);

    res.json({ 
      message: emailSent 
        ? 'Verification code sent to your email successfully' 
        : 'Verification code generated (check console in development)',
      // In development, include OTP in response (remove in production!)
      ...(process.env.NODE_ENV === 'development' && { otp }),
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: 'Not authorized, user not found' });
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

    const trimmedEmail = newEmail.trim().toLowerCase();
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

    // Send OTP via email
    const emailSent = await sendOtpEmail(trimmedEmail, otp);

    console.log(`[OTP] Email change verification for ${user.email} -> ${trimmedEmail}: ${otp}`);
    console.log(`[OTP] Expires at: ${new Date(expiresAt).toISOString()}`);
    console.log(`[OTP] Email sent: ${emailSent}`);

    res.json({ 
      message: emailSent 
        ? 'Verification code sent to your email successfully' 
        : 'Verification code generated (check console in development)',
      // In development, include OTP in response (remove in production!)
      ...(process.env.NODE_ENV === 'development' && { otp }),
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: 'Not authorized, user not found' });
    }

    const { newEmail, otp } = req.body;

    if (!newEmail || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    const trimmedEmail = newEmail.trim().toLowerCase();
    const otpKey = `${user._id}_${trimmedEmail}`;
    const storedData = otpStore.get(otpKey);

    if (!storedData) {
      return res.status(400).json({ message: 'No OTP request found. Please request a new code.' });
    }

    // Check if OTP has expired
    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(otpKey);
      return res.status(400).json({ message: 'Verification code has expired. Please request a new one.' });
    }

    // Verify OTP
    if (storedData.otp !== otp.trim()) {
      return res.status(400).json({ message: 'Invalid verification code. Please try again.' });
    }

    // OTP is valid, remove from store
    otpStore.delete(otpKey);

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
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: 'Not authorized, user not found' });
    }

    const { firstName, lastName, email, dateOfBirth, gender, currentPassword, newPassword, profilePicture, bannerPicture, emailVerified } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !dateOfBirth || !gender) {
      return res.status(400).json({ message: 'Please fill in all required fields.' });
    }

    // Name validation
    const first = firstName.trim();
    const last = lastName.trim();

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
    const trimmedEmail = email.trim().toLowerCase();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address (e.g. name@example.com).' });
    }

    // Check if email is taken by another user and verify OTP was validated
    if (trimmedEmail !== user.email) {
      if (!emailVerified) {
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
    
    // Update profile picture if provided
    if (profilePicture !== undefined) {
      user.profilePicture = profilePicture;
    }

    // Update banner picture if provided
    if (bannerPicture !== undefined) {
      user.bannerPicture = bannerPicture;
    }

    await user.save();

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
