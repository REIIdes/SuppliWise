/**
 * Prints a signed admin token for a LOCAL UI walkthrough of /admin.
 * Not a credential generator — it needs JWT_SECRET and a live database, both of
 * which only exist on the machine running the server.
 *
 *   npm run mint-admin-token
 */
const path = require('path');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);
  const AdminAccount = require('../models/AdminAccount');
  const admin = await AdminAccount.findOne({ enabled: true }).select('_id alias').lean();
  // Same writes the login route makes: the idle guard measures from
  // lastActivityAt, and mustChangePassword would 403 every route.
  await AdminAccount.updateOne(
    { _id: admin._id },
    { $set: { lastActivityAt: new Date(), mustChangePassword: false } },
  );
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { adminId: String(admin._id), role: 'admin', alias: admin.alias },
    process.env.JWT_SECRET,
    { expiresIn: '2h' },
  );
  console.log(token);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });