/**
 * What did the verification scripts leave behind?
 *
 * Every script I added writes real rows into the real database. Three of them
 * were run against it. This reports exactly what survived, so "the admin console
 * is showing fake data" is a measured fact rather than a suspicion.
 *
 *   node scripts/report-test-residue.js
 */
const path = require('path');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Every prefix the verification scripts registered a throwaway account under.
const PROBES = ['ui+', 'boundary+', 'walkthrough+', 'links+', 'legacy+', 'showcase+'];

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);

  const User = require('../models/User');
  const UserNotification = require('../models/UserNotification');
  const AdminEvent = require('../models/AdminEvent');
  const ChatThread = require('../models/ChatThread');
  const ChatMessage = require('../models/ChatMessage');

  const pattern = new RegExp(`^(${PROBES.map((p) => p.replace('+', String.raw`\+`)).join('|')})`);

  const users = await User.find({ email: pattern }).select('_id email createdAt').lean();
  console.log(`\n── throwaway ACCOUNTS still registered ──`);
  console.log(users.length ? users.map((u) => `  ${u.email}  (${u._id}, ${u.createdAt})`).join('\n') : '  none');

  const ids = users.map((u) => u._id);
  const [notifs, events, threads] = await Promise.all([
    ids.length ? UserNotification.find({ user: { $in: ids } }).lean() : [],
    ids.length ? AdminEvent.find({ user: { $in: ids } }).lean() : [],
    ids.length ? ChatThread.find({ user: { $in: ids } }).lean() : [],
  ]);

  console.log(`\n── their MEMBER-bell rows (${notifs.length}) ──`);
  console.log(notifs.length
    ? notifs.map((n) => `  [${n.type}] ${n.title}`).join('\n')
    : '  none');

  console.log(`\n── their ADMIN-bell rows (${events.length}) — these appear in the real console ──`);
  console.log(events.length
    ? events.map((e) => `  [${e.type}] ${e.title} — ${e.detail}`).join('\n')
    : '  none');

  const messages = threads.length
    ? await ChatMessage.find({ thread: { $in: threads.map((t) => t._id) } }).lean()
    : [];
  console.log(`\n── support threads (${threads.length}) and messages (${messages.length}) ──`);

  // Seeded rows can also point at ticket ids and subjects no account owns.
  const seeded = await AdminEvent.find({ detail: /SW-UI0001|Where did I pay\?/ }).lean();
  console.log(`\n── AdminEvent rows referencing the UI-seed fixtures (${seeded.length}) ──`);
  console.log(seeded.length ? seeded.map((e) => `  [${e.type}] ${e.title} — ${e.detail}`).join('\n') : '  none');

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });