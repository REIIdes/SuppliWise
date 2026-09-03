const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const User = require('../models/User');
const emailUtils = require('../utils/email');

function buildApp() {
  delete require.cache[require.resolve('../routes/auth')];
  const authRouter = require('../routes/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

test('login route does not leak OTPs in the JSON response', async () => {
  const originalFindOne = User.findOne;
  const originalSendOtpEmail = emailUtils.sendOtpEmail;
  const originalNodeEnv = process.env.NODE_ENV;

  process.env.NODE_ENV = 'development';
  User.findOne = async () => ({
    _id: '507f1f77bcf86cd799439011',
    email: 'demo@example.com',
    firstName: 'Demo',
    lastName: 'User',
    fullName: 'Demo User',
    dateOfBirth: new Date('1990-01-01'),
    gender: 'Male',
    profilePicture: '',
    bannerPicture: '',
    matchPassword: async () => true,
  });
  emailUtils.sendOtpEmail = async () => true;

  const app = buildApp();
  const server = app.listen(0);

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com', password: 'Secret123' }),
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.requiresOtp, true);
    assert.equal(body.otp, undefined);
    assert.equal(body.message.includes('Verification code sent'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    User.findOne = originalFindOne;
    emailUtils.sendOtpEmail = originalSendOtpEmail;
    process.env.NODE_ENV = originalNodeEnv;
  }
});
