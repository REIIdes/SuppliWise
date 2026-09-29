/**
 * Mint a REAL session token for a member, the same way routes/auth.js does
 * (a Session row plus a matching user.currentSessionId), so a browser can be
 * dropped straight onto an authenticated page. The two-step email-OTP step is
 * the only thing being bypassed — the token itself is genuinely server-verified.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Session = require('../models/Session');

const EMAIL = process.argv[2] || 'support.demo@example.test';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ email: EMAIL });
  if (!user) { console.error('no such user'); process.exit(1); }

  // One active session per account: retire whatever is there first.
  await Session.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  const session = await Session.create({ user: user._id, tokenHash: 'manual', userAgent: 'manual', ip: '127.0.0.1' });

  // `currentSessionId` is `select: false` on the User schema, so `findOne` above
  // did NOT load it. Assigning it and calling save() therefore wrote nothing —
  // Mongoose only persists paths it knows about — and every token this script
  // minted failed verification with 401 INVALID_TOKEN. A direct updateOne is the
  // only way to write a field the query deliberately excluded.
  await User.updateOne({ _id: user._id }, { $set: { currentSessionId: session._id } });

  const token = jwt.sign(
    { id: String(user._id), sid: String(session._id) },
    process.env.JWT_SECRET,
    { algorithm: 'HS256' }
  );

  const snapshot = {
    _id: String(user._id),
    firstName: user.firstName,
    lastName: user.lastName,
    name: `${user.firstName} ${user.lastName}`,
    email: user.email,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender,
    accountRole: user.accountRole,
    accountStatus: user.accountStatus,
    subscriptionActive: user.subscriptionActive,
    subscriptionPlan: user.subscriptionPlan,
    profilePicture: user.profilePicture || '',
  };

  console.log(JSON.stringify({ token, user: snapshot }, null, 0));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
