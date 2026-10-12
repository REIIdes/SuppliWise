/**
 * Diagnostic: is there any cross-contamination between the two notification
 * collections, and does either bell render something it should not?
 *
 *   node scripts/audit-notification-boundary.js
 *
 * The rule this checks: `UserNotification` rows belong to ONE member and are
 * read only by GET /api/notifications. `AdminEvent` rows are the shared admin
 * stream read only by GET /api/admin/notifications. The three families the
 * product treats as ADMIN-ONLY are subscription requests, priority-assessment
 * detections and security threats — none of which a member should ever see.
 */
const path = require('path');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);

  const UserNotification = require('../models/UserNotification');
  const AdminEvent = require('../models/AdminEvent');

  const members = await UserNotification.find({}).sort({ createdAt: -1 }).limit(40).lean();
  const events = await AdminEvent.find({}).sort({ createdAt: -1 }).limit(40).lean();

  const memberTitles = new Set(members.map((m) => m.title));
  const eventTitles = new Set(events.map((e) => e.title));

  console.log('\n── MEMBER BELL SOURCE (UserNotification) ──');
  for (const m of members) {
    console.log(`  [${m.type}] "${m.title}"`);
  }

  console.log('\n── ADMIN BELL SOURCE (AdminEvent) ──');
  for (const e of events) {
    console.log(`  [${e.type}] "${e.title}"`);
  }

  // ── Cross-contamination ────────────────────────────────────────────────
  // 1. A title that exists in BOTH collections is the clearest sign of a row
  //    written to the wrong place.
  const sharedTitles = [...memberTitles].filter((t) => eventTitles.has(t));
  console.log('\n── titles appearing in BOTH collections ──');
  console.log(sharedTitles.length ? sharedTitles.map((t) => `  ${t}`).join('\n') : '  none');

  // 2. Admin-only vocabulary inside the member collection.
  const ADMIN_ONLY = /subscription|upgrade request|cancellation|administrator|lockout cleared|admin lockout|severe case|threat/i;
  const leaked = members.filter((m) => ADMIN_ONLY.test(m.title));
  console.log('\n── admin-only wording inside UserNotification ──');
  console.log(leaked.length ? leaked.map((m) => `  [${m.type}] "${m.title}"`).join('\n') : '  none');

  // 3. User-only vocabulary inside the admin collection.
  const USER_ONLY = /your account|your password|your passkey|your recovery|your assessment|sign-in to your|you're back online|your plan/i;
  const leakedUser = events.filter((e) => USER_ONLY.test(e.title));
  console.log('\n── user-only wording inside AdminEvent ──');
  console.log(leakedUser.length ? leakedUser.map((e) => `  [${e.type}] "${e.title}"`).join('\n') : '  none');

  // ── Which member has the most rows, so the bell can be exercised ──────
  const counts = await UserNotification.aggregate([
    { $group: { _id: '$user', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 3 },
  ]);
  console.log('\n── most-notified members ──');
  for (const c of counts) {
    const u = await require('../models/User').findById(c._id).select('email').lean();
    console.log(`  ${c.n} row(s) — ${u?.email || c._id}`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });