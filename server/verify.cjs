require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const PRT = require('./models/PasswordResetToken');
const { verifyPassword, isArgon2id } = require('./utils/password');
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const u = await User.findOne({ email: 'ui-flow-demo@example.com' });
  console.log('hash is argon2id :', isArgon2id(u.password));
  console.log('new verifies    :', await verifyPassword('Mango$Tulip77!', u.password));
  console.log('old rejected    :', !(await verifyPassword('Cedar$Otter48!', u.password)));
  const grants = await PRT.find({ user: u._id }).select('+tokenHash');
  console.log('grants used     :', grants.map(g => !!g.usedAt).join(','));
  console.log('grant claimed   :', String(grants[0] && grants[0].usedAt));
  await mongoose.disconnect();
})();
