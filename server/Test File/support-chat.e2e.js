/**
 * End-to-end check for the support-chat feature against a RUNNING server.
 *
 * Mints real user + admin tokens the same way the auth routes do (a Session row
 * with a matching user.currentSessionId, and an admin JWT against an enabled
 * AdminAccount), then drives the whole conversation through HTTP.
 *
 * Run: node "Test File/support-chat.e2e.js"   (server must be listening)
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
require('dotenv').config();

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const assert = require('node:assert/strict');

const User = require('../models/User');
const Session = require('../models/Session');
const AdminAccount = require('../models/AdminAccount');
const ChatThread = require('../models/ChatThread');
const ChatMessage = require('../models/ChatMessage');
const AdminEvent = require('../models/AdminEvent');
const UserNotification = require('../models/UserNotification');

// TLS_ENABLED-aware, so this suite follows the API's scheme when it runs against a
// live server rather than the throwaway one it starts itself.
const BASE = `${require('../utils/tls').loopbackOrigin()}/api`;

let passed = 0;
const check = (label, cond) => {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok  ${label}`);
};

async function call(token, path, method = 'GET', body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, data };
}

/** Create a throwaway member with a live session, and mint its token. */
async function makeUser(label) {
  const user = await User.create({
    firstName: `Chat${label}`,
    lastName: 'Tester',
    email: `sw.chat.${label}.${Date.now()}@example.test`,
    password: 'not-used-here',
    dateOfBirth: new Date('1990-01-01'),
    gender: 'Female',
  });
  const session = await Session.create({
    user: user._id,
    tokenHash: 'e2e',
    userAgent: 'e2e',
    ip: '127.0.0.1',
  });
  user.currentSessionId = session._id;
  await user.save();
  const token = jwt.sign({ id: String(user._id), sid: String(session._id) }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  return { user, token };
}

async function makeAdminToken() {
  const admin = await AdminAccount.findOne({ enabled: true }).lean();
  assert.ok(admin, 'an enabled admin account must exist');

  // Stamp `lastActivityAt` the way routes/auth.js does on a real admin login.
  //
  // `protect` runs an idle check against this stamp BEFORE anything else, and
  // the heartbeat that would refresh it sits after that check — so an account
  // that has not been signed into through the UI is rejected as idle no matter
  // how fresh its token is. That is correct behaviour for the product (an admin
  // who walked away must lose their session) and wrong for this test, which
  // mints its own token and is therefore claiming a session that began just now.
  // Without this, the run passes or fails depending on whether a human happened
  // to open the admin dashboard recently — a 401 in section 6 has nothing to do
  // with what this file is actually checking.
  await AdminAccount.updateOne({ _id: admin._id }, { $set: { lastActivityAt: new Date() } });

  return jwt.sign(
    { id: String(admin._id), adminId: String(admin._id), role: 'admin' },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '10m' },
  );
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('connected\n');

  // A previous run that failed mid-way leaves fixtures behind (cleanup is at the
  // end). They are matched by the throwaway email prefix, so this can never
  // touch a real account.
  const stale = await User.find({ email: /^sw\.chat\./ }).select('_id').lean();
  for (const u of stale) {
    await ChatThread.deleteMany({ user: u._id });
    await ChatMessage.deleteMany({ user: u._id });
    await AdminEvent.deleteMany({ user: u._id });
    await UserNotification.deleteMany({ user: u._id });
    await Session.deleteMany({ user: u._id });
    await User.deleteOne({ _id: u._id });
  }
  if (stale.length) console.log(`cleaned ${stale.length} stale fixture(s)\n`);

  const alice = await makeUser('Alice');
  const bob = await makeUser('Bob');
  const adminToken = await makeAdminToken();
  console.log('fixtures ready\n');

  // ── 1. Member starts a conversation ─────────────────────────────────────
  console.log('1. start a conversation');
  let r = await call(alice.token, '/support-chat', 'POST', {
    subject: 'Where did I pay?',
    category: 'payment',
    body: 'I transferred 1295 last Tuesday but my plan is still Free.',
  });
  check('201 created', r.status === 201);
  check('status is open (waiting on admin)', r.data.thread.status === 'open');
  check('unreadByAdmin is 1', r.data.thread.unreadByAdmin === 1);
  check('subject kept', r.data.thread.subject === 'Where did I pay?');
  check('category kept', r.data.thread.category === 'payment');
  const threadId = r.data.thread._id;
  check('thread id returned', !!threadId);

  // The admin bell must actually have been written. The AdminEvent enum once
  // omitted a type and every such write was silently swallowed by the
  // fire-and-forget catch — so assert the row exists, not just that it sent.
  await new Promise((res) => setTimeout(res, 400));
  const bell = await AdminEvent.findOne({ type: 'support-chat', user: alice.user._id });
  check('admin bell row written with type in the enum', !!bell);

  // ── 2. Blank message is refused ─────────────────────────────────────────
  console.log('\n2. validation');
  r = await call(alice.token, '/support-chat', 'POST', { subject: 'x', body: '   ' });
  check('400 on whitespace-only body', r.status === 400);
  r = await call(alice.token, '/support-chat', 'POST', { body: 'a'.repeat(2001) });
  check('400 on over-length body', r.status === 400);
  r = await call(alice.token, '/support-chat/not-an-object-id');
  check('400 on invalid ObjectId', r.status === 400);
  r = await call(alice.token, '/support-chat', 'POST', { body: 'no subject given here' });
  check('empty subject falls back to an excerpt', r.data.thread.subject === 'no subject given here');

  // ── 3. The member's own list ────────────────────────────────────────────
  console.log('\n3. member list');
  r = await call(alice.token, '/support-chat');
  check('two threads listed', r.data.threads.length === 2);
  // ZERO: both threads were opened by the member, so neither is unread to them.
  // The badge means "an admin has replied and you have not read it" — it is not
  // "a thread exists".
  check('unreadCount is 0 — both threads are the member\'s own', r.data.unreadCount === 0);
  check('preview present', typeof r.data.threads[0].lastMessagePreview === 'string' && r.data.threads[0].lastMessagePreview.length > 0);

  // ── 4. Reading a thread marks it read ───────────────────────────────────
  console.log('\n4. read marks read');
  r = await call(alice.token, `/support-chat/${threadId}`);
  check('thread loads', r.status === 200);
  check('one message in transcript', r.data.messages.length === 1);
  check('author is the member', r.data.messages[0].author === 'user');
  check('reading returns unreadByUser 0', r.data.thread.unreadByUser === 0);
  // The write is persisted, not just echoed back in the response.
  const afterRead = await ChatThread.findById(threadId).lean();
  check('unreadByUser zeroed in the database', afterRead.unreadByUser === 0);

  // ── 5. Cross-account isolation (404, NOT 403) ───────────────────────────
  console.log('\n5. isolation');
  r = await call(bob.token, `/support-chat/${threadId}`);
  check('404 — not 403 — for another account', r.status === 404);
  r = await call(bob.token, `/support-chat/${threadId}/messages`, 'POST', { body: 'hijack' });
  check('404 on replying to another account thread', r.status === 404);
  const stillOne = await ChatMessage.countDocuments({ thread: new mongoose.Types.ObjectId(threadId) });
  check('the hijack wrote nothing', stillOne === 1);

  // ── 6. An admin token cannot use the member routes ──────────────────────
  console.log('\n6. token separation');
  r = await call(adminToken, '/support-chat');
  check('403 for an admin token on the member list', r.status === 403);
  r = await call(alice.token, '/admin/chats');
  check('403 for a member token on the admin queue', r.status === 403);

  // ── 7. The admin queue ──────────────────────────────────────────────────
  console.log('\n7. admin queue');
  r = await call(adminToken, '/admin/chats?status=open');
  check('open filter returns the thread', r.data.threads.some((t) => t._id === threadId));
  check('counts include open', r.data.counts.open >= 1);
  check('unread count tracked', r.data.counts.unread >= 1);
  check('member identity populated', !!r.data.threads.find((t) => t._id === threadId).user.email);
  r = await call(adminToken, '/admin/chats?status=nonsense');
  check('400 on an unknown status filter', r.status === 400);
  r = await call(adminToken, '/admin/chats?category=nonsense');
  check('400 on an unknown category filter', r.status === 400);
  // A regex metacharacter must not 500 the search.
  r = await call(adminToken, '/admin/chats?search=' + encodeURIComponent('('));
  check('200 on a regex-metacharacter search', r.status === 200);
  check('metacharacter search returns an empty page', r.data.threads.length === 0);
  r = await call(adminToken, '/admin/chats?search=Tester');
  check('search by member last name finds it', r.data.threads.some((t) => t._id === threadId));
  r = await call(adminToken, '/admin/chats?search=' + encodeURIComponent(alice.user.email));
  check('search by email finds it', r.data.threads.some((t) => t._id === threadId));
  r = await call(adminToken, '/admin/chats?search=Where did I pay');
  check('search by subject finds it', r.data.threads.some((t) => t._id === threadId));

  // ── 8. The admin replies ────────────────────────────────────────────────
  console.log('\n8. admin reply');
  r = await call(adminToken, `/admin/chats/${threadId}/messages`, 'POST', { body: 'We received it on Tuesday; your plan is activating now.' });
  check('201 on reply', r.status === 201);
  check('author recorded as admin', r.data.message_record.author === 'admin');
  // List FIRST: GET /support-chat/:id marks the thread read, so opening it
  // before checking the badge would clear the very counter being asserted.
  r = await call(alice.token, '/support-chat');
  check('unreadCount is 1 after an admin reply', r.data.unreadCount === 1);
  r = await call(alice.token, `/support-chat/${threadId}`);
  check('member sees two messages', r.data.messages.length === 2);
  check('status is now pending (waiting on member)', r.data.thread.status === 'pending');
  r = await call(alice.token, '/support-chat');
  check('unreadCount back to 0 once read', r.data.unreadCount === 0);

  // ── 8b. The member is shown the CHANNEL, never the operator ─────────────
  // An admin reply is attributed to the alias the operator signed in with
  // (`AdminDevs`, `AdminJoma`, …), which is an internal identity taken from
  // server/.env. The member router substitutes a label for it on the way out,
  // because a member asking about their billing is entitled to the support
  // channel and not to which named person is holding it. The alias must still
  // be on the document — the console needs it — so these assertions are about
  // what CROSSES THE WIRE, and the next block checks the console still has it.
  const SUPPORT_LABEL = 'Suppliwise Support';
  r = await call(alice.token, `/support-chat/${threadId}`);
  const adminReplies = (r.data.messages || []).filter((m) => m.author === 'admin');
  check('the member has the admin reply to label', adminReplies.length === 1);
  check(
    'the member sees a support label, not the admin alias',
    adminReplies[0].authorName === SUPPORT_LABEL,
  );
  check(
    'and no message in the transcript carries an admin alias',
    (r.data.messages || []).every(
      (m) => m.author !== 'admin' || m.authorName === SUPPORT_LABEL
    )
  );
  // The list endpoint is the other half of the payload — redacting only the
  // transcript would still hand over the identity through the queue.
  r = await call(alice.token, '/support-chat');
  check(
    'the member list never carries an assignee or a resolver',
    (r.data.threads || []).every(
      (t) => !t.assignedTo && !(t.resolved && t.resolved.by)
    )
  );
  // …and the member still gets everything the UI actually renders, so this is
  // a redaction rather than a field removal.
  check('the resolution timestamp still reaches the member', r.data.threads.length > 0);
  await new Promise((res) => setTimeout(res, 400));
  const memberBell = await UserNotification.findOne({ user: alice.user._id, type: 'info' });
  check('member was notified of the reply', !!memberBell);

  // ── 9. The member replies back — the thread returns to the queue ────────
  console.log('\n9. member reply reopens the queue');
  r = await call(alice.token, `/support-chat/${threadId}/messages`, 'POST', { body: 'Still showing Free — can you check again?' });
  check('201 on member reply', r.status === 201);
  r = await call(alice.token, `/support-chat/${threadId}`);
  check('status back to open', r.data.thread.status === 'open');
  r = await call(adminToken, `/admin/chats/${threadId}`);
  check('reading as admin zeroed unreadByAdmin', r.data.thread.unreadByAdmin === 0);
  check('three messages in transcript', r.data.messages.length === 3);

  // The other half of the redaction: the CONSOLE must be unaffected, or the fix
  // would just have cost the operators the ability to see who is handling what.
  const consoleAdminReply = (r.data.messages || []).find((m) => m.author === 'admin');
  check(
    'the console still shows the real alias on an admin reply',
    !!consoleAdminReply && consoleAdminReply.authorName !== SUPPORT_LABEL
  );
  check(
    'and that alias is the one the operator actually signed in with',
    !!consoleAdminReply && consoleAdminReply.authorName.length > 0
  );

  // ── 10. Resolve is admin-only, and freezes the thread for both sides ────
  console.log('\n10. resolve is admin-only, and locks the thread');
  r = await call(alice.token, `/support-chat/${threadId}/resolve`, 'POST', {});
  check('member cannot resolve (endpoint does not exist)', r.status === 404);
  r = await call(alice.token, `/support-chat/${threadId}/reopen`, 'POST', {});
  check('member cannot reopen either', r.status === 404);

  r = await call(adminToken, `/admin/chats/${threadId}/resolve`, 'POST', {});
  check('200 on admin resolve', r.status === 200);
  check('status resolved', r.data.thread.status === 'resolved');
  check('resolver recorded', r.data.thread.resolved.by.length > 0);
  check('resolver is an admin alias, never "member"', r.data.thread.resolved.by !== 'member');
  r = await call(adminToken, '/admin/chats?status=open');
  check('resolved thread left the open queue', !r.data.threads.some((t) => t._id === threadId));

  // The lock: nothing can be written until an admin reopens.
  r = await call(alice.token, `/support-chat/${threadId}/messages`, 'POST', { body: 'Any news?' });
  check('member reply refused on a resolved thread', r.status === 409);
  r = await call(adminToken, `/admin/chats/${threadId}/messages`, 'POST', { body: 'One more thing.' });
  check('admin reply ALSO refused on a resolved thread', r.status === 409);
  r = await call(alice.token, `/support-chat/${threadId}`);
  check('the refused sends left no messages behind', r.data.messages.length === 3);
  check('and the thread is still resolved', r.data.thread.status === 'resolved');
  // The member is told WHEN it was closed, never WHO closed it — the UI dates
  // the resolution but has no use for the resolver, so `by` stays empty here
  // while the console (asserted above) keeps the alias.
  check('the member sees the resolution date', !!r.data.thread.resolved.at);
  check('but not the admin who resolved it', r.data.thread.resolved.by === '');

  // ── 11. Admin reopen is the only way back in ────────────────────────────
  console.log('\n11. admin reopen unfreezes the thread');
  r = await call(adminToken, `/admin/chats/${threadId}/reopen`, 'POST', {});
  check('200 on admin reopen', r.status === 200);
  check('reopen clears the resolved stamp', !r.data.thread.resolved.at);
  check('reopened thread is back in the working queue', r.data.thread.status === 'open');
  r = await call(adminToken, '/admin/chats?status=open');
  check('and it appears in the open queue again', r.data.threads.some((t) => t._id === threadId));

  r = await call(adminToken, `/admin/chats/${threadId}/messages`, 'POST', { body: 'Sorry, one more thing.' });
  check('admin can reply after reopening', r.status === 201);
  r = await call(alice.token, `/support-chat/${threadId}/messages`, 'POST', { body: 'Thank you!' });
  check('member can reply after reopening', r.status === 201);

  // ── 12. Assign + delete ─────────────────────────────────────────────────
  console.log('\n12. assign and delete');
  r = await call(adminToken, `/admin/chats/${threadId}/assign`, 'POST', { alias: 'AdminJoma' });
  check('assign records the alias', r.data.thread.assignedTo === 'AdminJoma');
  r = await call(adminToken, `/admin/chats/${threadId}/messages`, 'POST', { body: 'Closing this out.' });
  check('a reply does not clobber the assignee', r.status === 201);
  r = await call(adminToken, `/admin/chats/${threadId}`);
  check('assignee still set after a reply', r.data.thread.assignedTo === 'AdminJoma');

  r = await call(adminToken, `/admin/chats/${threadId}`, 'DELETE');
  check('200 on delete', r.status === 200);
  check('thread gone', (await ChatThread.findById(threadId)) === null);
  check('transcript gone', (await ChatMessage.countDocuments({ thread: new mongoose.Types.ObjectId(threadId) })) === 0);
  r = await call(alice.token, `/support-chat/${threadId}`);
  check('member gets 404 after admin deletion', r.status === 404);

  // ── 13. Account deletion takes the transcripts with it ──────────────────
  console.log('\n13. account-deletion cascade');
  const carol = await makeUser('Carol');
  r = await call(carol.token, '/support-chat', 'POST', { subject: 'Cascade test', body: 'please delete me' });
  check('carol opened a thread', r.status === 201);
  r = await call(adminToken, `/admin/chats/${r.data.thread._id}`, 'GET');
  check('carol thread visible to admin', r.status === 200);
  await carol.user.deleteOne();
  check('thread deleted with the account', (await ChatThread.find({ user: carol.user._id })).length === 0);
  check('messages deleted with the account', (await ChatMessage.find({ user: carol.user._id })).length === 0);

  // ── cleanup ─────────────────────────────────────────────────────────────
  for (const u of [alice.user, bob.user]) {
    await ChatThread.deleteMany({ user: u._id });
    await ChatMessage.deleteMany({ user: u._id });
    await AdminEvent.deleteMany({ user: u._id });
    await UserNotification.deleteMany({ user: u._id });
    await Session.deleteMany({ user: u._id });
    await User.deleteOne({ _id: u._id });
  }

  console.log(`\nALL ${passed} CHECKS PASSED`);
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error('\nFAILED:', error.message);
  console.error(error.stack);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
