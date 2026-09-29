/**
 * Dev helper: mint a real password-reset link for a real user so the UI can be
 * driven through the actual flow rather than a hand-written URL.
 *
 *   node seed-ui-reset.cjs <email>
 *
 * Lives in the server package (not a temp dir) because it needs the same
 * node_modules as the models it uses. Deletes any prior grant for the address
 * so the printed link is the only live one.
 */
// The same .env the server boots from, so this writes to the database the
// running server is actually reading. Without it the grant lands in a local
// database the server never sees, and the link 400s for no visible reason.
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('./models/User');
const PasswordResetToken = require('./models/PasswordResetToken');

const EMAIL = process.argv[2] || 'ui-flow-demo@example.com';
const PASSWORD = 'Cedar$Otter48!';

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  await User.deleteMany({ email: EMAIL });
  await PasswordResetToken.deleteMany({});
  const user = await User.create({
    firstName: 'Ui',
    lastName: 'Flow',
    email: EMAIL,
    password: PASSWORD,
    dateOfBirth: new Date('1990-01-01'),
    gender: 'Male',
  });
  const { token, code } = PasswordResetToken.generateSecrets();
  await PasswordResetToken.store({
    userId: user._id,
    token,
    code,
    ttlMs: 30 * 60 * 1000,
  });
  console.log(JSON.stringify({ email: EMAIL, token, code, password: PASSWORD, userId: String(user._id) }));
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
