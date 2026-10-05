/**
 * Create a throwaway member so the support UI can be exercised in a browser.
 * Registration needs a server-issued CAPTCHA, so seed the account directly
 * using the SAME hashing the login route verifies against.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { hashPassword } = require('../utils/password');

const EMAIL = process.argv[2] || 'support.demo@example.test';
const PASSWORD = process.argv[3] || 'SupportDemo123!';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const passwordHash = await hashPassword(PASSWORD);
  const user = await User.findOneAndUpdate(
    { email: EMAIL },
    {
      $set: {
        firstName: 'Support',
        lastName: 'Demo',
        password: passwordHash,
        dateOfBirth: new Date('1992-04-11'),
        gender: 'Female',
        accountStatus: 'active',
      },
    },
    { new: true, upsert: true }
  );
  console.log(JSON.stringify({ email: user.email, id: String(user._id) }));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
