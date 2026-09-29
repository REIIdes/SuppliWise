/**
 * Mint a real admin JWT and refresh the account's idle stamp, so the admin
 * console can be opened in a browser without the password + TOTP step. The
 * token is signed with the same secret and carries the same claims routes/auth.js
 * issues, and middleware/auth.js still verifies the AdminAccount is enabled and
 * not idle-expired — so the admin guards are genuinely exercised.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const AdminAccount = require('../models/AdminAccount');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const admin = await AdminAccount.findOne({ enabled: true }).select('_id alias').lean();
  if (!admin) { console.error('no enabled admin account'); process.exit(1); }
  await AdminAccount.updateOne({ _id: admin._id }, { $set: { lastActivityAt: new Date() } });

  const token = jwt.sign(
    { id: String(admin._id), adminId: String(admin._id), role: 'admin' },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '30m' }
  );

  const out = path.join(process.env.TEMP, 'sw_admin.json');
  fs.writeFileSync(out, JSON.stringify({ token, admin: { _id: String(admin._id), alias: admin.alias } }));
  console.log(`alias=${admin.alias} tokenLen=${token.length} -> ${out}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
