/**
 * Does an orphaned AdminEvent break the admin console?
 *
 * Every verification script created support-chat events against accounts it
 * then deleted. Those rows survive — they are the shared admin stream, not the
 * member's — so they still render in the bell. The question is what happens when
 * an operator presses one: the row carries `link: "chats?thread=<id>"`, and the
 * thread that id named is gone.
 *
 *   node scripts/probe-orphan-routing.js
 *
 * Batches every existence check into two queries, because 40 sequential Atlas
 * round-trips is a two-minute script.
 */
const path = require('path');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);
  const AdminEvent = require('../models/AdminEvent');
  const User = require('../models/User');
  const ChatThread = require('../models/ChatThread');

  const events = await AdminEvent.find({ type: 'support-chat' }).sort({ createdAt: -1 }).limit(20).lean();

  const ownerIds = [...new Set(events.map((e) => String(e.user || '')).filter(Boolean))];
  const threadIds = [...new Set(events.map(
    (e) => /thread=([0-9a-f]{24})/.exec(String(e.link || ''))?.[1] || '',
  ).filter(Boolean))];

  const [liveOwners, liveThreads] = await Promise.all([
    ownerIds.length ? User.find({ _id: { $in: ownerIds } }).select('_id').lean() : [],
    threadIds.length ? ChatThread.find({ _id: { $in: threadIds } }).select('_id').lean() : [],
  ]);
  const ownerAlive = new Set(liveOwners.map((u) => String(u._id)));
  const threadAlive = new Set(liveThreads.map((t) => String(t._id)));

  console.log(`\n── support-chat rows in the shared admin stream (${events.length}) ──`);
  let orphan = 0;
  for (const e of events) {
    const ownerOk = !e.user || ownerAlive.has(String(e.user));
    const threadId = /thread=([0-9a-f]{24})/.exec(String(e.link || ''))?.[1] || null;
    const threadOk = !threadId || threadAlive.has(threadId);
    if (!ownerOk || !threadOk) orphan += 1;
    console.log(`  ${ownerOk && threadOk ? '  ok  ' : 'ORPHAN'} ${e.detail}`);
    console.log(`         owner alive: ${ownerOk}   thread alive: ${threadOk}   link: ${e.link || 'none'}`);
  }
  console.log(`\n${orphan} of ${events.length} support-chat rows point at something that no longer exists.`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });