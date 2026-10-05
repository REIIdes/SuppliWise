require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const u = await User.findOne({ email: 'verbojanrich20@gmail.com' }).lean();
  console.log(JSON.stringify({
    subscriptionActive: u.subscriptionActive,
    subscriptionPlan: u.subscriptionPlan,
    subscriptionEnd: u.subscriptionEnd,
    subscriptionFeatures: u.subscriptionFeatures,
  }, null, 1));
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
