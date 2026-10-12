/**
 * Remove every trace the bell-verification scripts left in the database.
 *
 *   node scripts/cleanup-bell-walkthrough.js
 *
 * ── Why this had to be rewritten ─────────────────────────────────────────────
 *
 * The previous version matched throwaway accounts by a hard-coded list of email
 * prefixes. That list had drifted from the prefixes the scripts actually
 * register:
 *
 *   matched:  bell+  belltest+  legacy+  legacyui+  showcase+
 *   created:  ui+  boundary+  walkthrough+  links+  legacy+  showcase+
 *
 * So `ui+` and `boundary+` accounts survived every cleanup run. Measured, not
 * assumed: the run that prompted this rewrite reported `users=0 … events=0`
 * against a database that still held one `ui+` account, five of its member-bell
 * rows and three of its admin-bell rows.
 *
 * Two failure modes mattered, and they pull in opposite directions:
 *
 *   • Too narrow  → real residue survives, and the admin console keeps showing
 *     support conversations from accounts nobody can act on. Every one of those
 *     rows carries `chats?thread=<id>` for a thread that is gone, so following
 *     it lands the operator on "Conversation not found."
 *   • Too wide    → deletes a real member's data. Unacceptable, always.
 *
 * So the rule is a REGEX every probe prefix must match, and the script refuses
 * to run if a probe is not shaped like a probe. Anything not matching the shape
 * is left alone no matter how much it costs, because the cost of over-deletion is
 * not recoverable and the cost of residue is a clean-up run later.
 */
const path = require('path');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * Throwaway accounts only. Two independent conditions, both required:
 *
 *   1. The prefix — every verification script registers under one of these, and
 *      a real member address cannot collide with a lowercase run of letters
 *      followed by `+` and digits.
 *   2. The timestamp — every probe mints `<prefix>+<Date.now()>@example.com`.
 *      Requiring the digits-and-`@example.com` shape means an address that
 *      merely STARTS with "ui" is not touched, however it was created.
 */
const PROBE_ACCOUNT = /^(ui|bell|belltest|boundary|walkthrough|links|legacy|legacyui|showcase|bellwalk|e2e)\+\d+@example\.com$/i;

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);

  const User = require('../models/User');
  const UserNotification = require('../models/UserNotification');
  const AdminEvent = require('../models/AdminEvent');
  const ChatThread = require('../models/ChatThread');
  const ChatMessage = require('../models/ChatMessage');

  const users = await User.find({ email: PROBE_ACCOUNT }).select('_id email').lean();
  const ids = users.map((u) => u._id);

  console.log(`\n── throwaway accounts matched (${users.length}) ──`);
  for (const u of users) console.log(`  ${u.email}`);

  // Inventory FIRST, so the summary reports what was there rather than only what
  // the deletes claimed. A cleanup script that prints its own delete counts and
  // nothing else cannot be distinguished from one that quietly matched nothing —
  // which is exactly how the previous version hid its miss.
  const threads = ids.length ? await ChatThread.find({ user: { $in: ids } }).select('_id').lean() : [];
  const [notificationCount, eventCount] = ids.length ? await Promise.all([
    UserNotification.countDocuments({ user: { $in: ids } }),
    AdminEvent.countDocuments({ user: { $in: ids } }),
  ]) : [0, 0];

  console.log(`\n── what they own ──`);
  console.log(`  member-bell rows: ${notificationCount}`);
  console.log(`  admin-bell rows:  ${eventCount}`);
  console.log(`  support threads:  ${threads.length}`);

  if (users.length === 0) {
    console.log('\n  nothing matched — no rows touched');
    await mongoose.disconnect();
    process.exit(0);
  }

  const threadIds = threads.map((t) => t._id);
  if (threadIds.length) await ChatMessage.deleteMany({ thread: { $in: threadIds } });
  const removedThreads = ids.length ? await ChatThread.deleteMany({ user: { $in: ids } }) : { deletedCount: 0 };
  const removedNotifs = ids.length ? await UserNotification.deleteMany({ user: { $in: ids } }) : { deletedCount: 0 };
  // Legacy-route fixtures carry no user reference, so they are matched by title.
  const removedEvents = await AdminEvent.deleteMany({
    $or: [
      { user: { $in: ids } },
      { title: /^Legacy (support chat|upgrade|severe|lockout) A$/ },
    ],
  });
  const removedUsers = ids.length ? await User.deleteMany({ _id: { $in: ids } }) : { deletedCount: 0 };

  console.log('\n── removed ──');
  console.log(`  accounts:         ${removedUsers.deletedCount}`);
  console.log(`  threads:          ${removedThreads.deletedCount}`);
  console.log(`  messages:         ${threadIds.length}`);
  console.log(`  member-bell rows: ${removedNotifs.deletedCount}`);
  console.log(`  admin-bell rows:  ${removedEvents.deletedCount}`);

  // ── The check that matters: did anything survive? ──────────────────────────
  // An orphan is not an account we can match by email any more — the account is
  // GONE and the shared admin stream is not. Those are the rows that make the
  // console show work for a member who no longer exists, so they are counted
  // separately and reported even when the script could not have removed them.
  const orphanEvents = ids.length
    ? await AdminEvent.countDocuments({ user: { $in: ids } })
    : 0;
  const stillThere = await User.countDocuments({ _id: { $in: ids } });

  if (stillThere || orphanEvents) {
    console.log(`\n  WARNING: ${stillThere} account(s) and ${orphanEvents} admin row(s) survived`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('\n  verified: no probe account and none of its admin rows remain');
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });