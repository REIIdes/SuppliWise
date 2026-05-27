const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Generate JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });
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
  const { name, email, password } = req.body;

  try {
    // Presence check
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please fill in all fields.' });
    }

    // Name validation
    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      return res.status(400).json({ message: 'Name must be at least 2 characters.' });
    }
    if (trimmedName.length > 50) {
      return res.status(400).json({ message: 'Name must be 50 characters or fewer.' });
    }

    // Email validation
    const trimmedEmail = email.trim().toLowerCase();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address (e.g. name@example.com).' });
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
    const user = await User.create({ name: trimmedName, email: trimmedEmail, password });

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
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
// @desc    Login user
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

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      token: generateToken(user._id),
    });
  } catch (error) {
    console.error('[login]', error.message);
    res.status(500).json({ message: 'Something went wrong. Please try again later.' });
  }
});

module.exports = router;
