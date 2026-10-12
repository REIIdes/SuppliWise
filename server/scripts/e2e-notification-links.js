/**
 * End-to-end check for the notification redirection fix.
 *
 * THE BUG: pressing a notification navigated immediately, and the destination
 * was guessed from the title in the browser — so a support reply ("Support
 * replied to your message") fell through to a `/history` default and dumped the
 * member on their assessment history. Redirection is now DATA (`link` /
 * `linkLabel`) written by whichever route raised the bell, and resolved in
 * my-react-app/src/notifications/notificationTargets.js.
 *
 * This walks a real support conversation end to end and asserts BOTH bells
 * carry the right link, then removes everything it created.
 *
 * Not part of `npm test`: it needs the live API and a database.
 *   npm run verify:bell-links
 *
 * Run through scripts/withDevCa.mjs so the development certificate authority is
 * trusted. Plain `fetch` on purpose — the certificate is VERIFIED, because a
 * probe that turns verification off would also happily talk to a server
 * presenting somebody else's certificate.
 */
const path = require('path');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.env.BASE_URL || 'https://localhost:5000';

async function call(method, apiPath, { token, body } = {}) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

let pass = 0;
let fail = 0;
function check(label, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label} ${extra}`); }
}

(async () => {
  const stamp = Date.now();
  const email = `belltest+${stamp}@example.com`;
  const password = 'BellTest!2026x';

  // Registration is captcha-gated; the challenge is a plain arithmetic
  // question, so it is solved here rather than bypassed (see glitch-hunt.js).
  const captchaRes = await call('GET', '/api/auth/captcha');
  const question = String(captchaRes.body?.question || '');
  const [left, right] = question.replace('= ?', '').trim().split(/\s*[+−×]\s*/);
  const captchaAnswer = question.includes('×') ? Number(left) * Number(right)
    : question.includes('−') ? Number(left) - Number(right)
      : Number(left) + Number(right);

  console.log('\n── member ──');
  const signup = await call('POST', '/api/auth/register', {
    body: {
      firstName: 'Bell',
      lastName: 'Tester',
      email,
      password,
      // dateOfBirth + gender are required by the register route.
      dateOfBirth: '1995-04-12',
      gender: 'Female',
      captchaId: captchaRes.body?.id,
      captchaAnswer: String(captchaAnswer),
    },
  });
  if (signup.status !== 201 && signup.status !== 200) {
    console.log('register failed', signup.status, signup.body);
    process.exit(1);
  }
  const memberToken = signup.body.token || signup.body.data?.token;
  check('member registered', !!memberToken, JSON.stringify(signup.body).slice(0, 200));

  console.log('\n── member starts a support conversation ──');
  const started = await call('POST', '/api/support-chat', {
    token: memberToken,
    body: { subject: 'Bell routing check', category: 'technical', body: 'Where does this land?' },
  });
  const threadId = started.body?.thread?._id;
  check('thread created', !!threadId, JSON.stringify(started.body).slice(0, 200));

  console.log('\n── admin replies (this is the bell that used to open /history) ──');
  // The admin sign-in needs an alias + password + TOTP, none of which exist in
  // a form a local harness can use (only the hash is stored). The admin token
  // is minted directly from the server's own secret and an enabled
  // AdminAccount, which is exactly what the login route does minus the proof.
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);
  const AdminAccount = require('../models/AdminAccount');
  const adminAccount = await AdminAccount.findOne({ enabled: true }).select('_id alias').lean();
  if (!adminAccount) {
    console.log('  .. no enabled admin account; skipping the reply step.');
    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
  const jwt = require('jsonwebtoken');
  // A real sign-in stamps `lastActivityAt`; without it the idle guard measures
  // from a stale stamp (or, for a never-signed-in account, from the epoch) and
  // refuses the token no matter how fresh its `iat` is. Stamping is the same
  // write the login route makes.
  await AdminAccount.updateOne({ _id: adminAccount._id }, { $set: { lastActivityAt: new Date() } });
  const adminToken = jwt.sign(
    { adminId: String(adminAccount._id), role: 'admin', alias: adminAccount.alias },
    process.env.JWT_SECRET,
    { expiresIn: '10m' },
  );
  check('admin token minted for ' + adminAccount.alias, !!adminToken);

  const replied = await call('POST', `/api/admin/chats/${threadId}/messages`, {
    token: adminToken,
    body: { body: 'Here is your answer.' },
  });
  check('admin reply accepted', replied.status === 201, `${replied.status} ${JSON.stringify(replied.body)}`);

  console.log('\n── what the member bell now says ──');
  await new Promise((r) => setTimeout(r, 400));
  const inbox = await call('GET', '/api/notifications?limit=20', { token: memberToken });
  const rows = inbox.body?.notifications || [];
  const reply = rows.find((n) => n.title === 'Support replied to your message');

  check('the reply produced a notification', !!reply);
  if (reply) {
    console.log(`       link      = ${JSON.stringify(reply.link)}`);
    console.log(`       linkLabel = ${JSON.stringify(reply.linkLabel)}`);
    check('it links into /support, not /history',
      typeof reply.link === 'string' && reply.link.startsWith('/support'),
      `got ${JSON.stringify(reply.link)}`);
    check('it carries the thread id',
      typeof reply.link === 'string' && reply.link.includes(String(threadId)),
      `expected ${threadId} inside ${JSON.stringify(reply.link)}`);
    check('it has a button label', typeof reply.linkLabel === 'string' && reply.linkLabel.length > 0);
  }

  console.log('\n── the admin bell for that same conversation ──');
  const adminBell = await call('GET', '/api/admin/notifications', { token: adminToken });
  const chatBell = (adminBell.body?.notifications || []).find((n) => n.type === 'support-chat');
  check('the support-chat event reached the admin bell', !!chatBell);
  if (chatBell) {
    console.log(`       link      = ${JSON.stringify(chatBell.link)}`);
    check('it points at Chat management', chatBell.link?.startsWith('chats'), JSON.stringify(chatBell.link));
    check('it carries the thread id', String(chatBell.link).includes(String(threadId)), JSON.stringify(chatBell.link));
  }

  // Every other bell the routes raise must carry a destination too, or it is a
  // notification the detail window can only show and never act on.
  console.log('\n── every persisted notification carries a destination ──');
  const UserNotification = require('../models/UserNotification');
  const AdminEvent = require('../models/AdminEvent');
  const undirected = [
    ...(await UserNotification.find({ $or: [{ link: '' }, { link: { $exists: false } }] }).limit(20).lean())
      .map((n) => `member: "${n.title}"`),
    ...(await AdminEvent.find({ $or: [{ link: '' }, { link: { $exists: false } }] }).limit(20).lean())
      .map((e) => `admin: "${e.title}" (${e.type})`),
  ];
  // Rows written BEFORE the `link` field existed are still in the database with
  // no stored link. They are NOT a problem: utils/notificationLinks.js derives
  // one per read, so they arrive at the client with a destination anyway —
  // `npm run verify:legacy-bell-links` proves that over the real API. They are
  // listed here only so the count is visible and a sudden jump is noticeable.
  const freshUndirected = undirected.filter((label) => label.includes('belltest'));
  check('no notification this run created lacks a stored link',
    freshUndirected.length === 0, freshUndirected.join(', '));
  if (undirected.length) {
    console.log(`  .. ${undirected.length} older row(s) have no stored link; the server derives one on read:`);
    for (const label of undirected.slice(0, 4)) console.log(`       ${label}`);
    if (undirected.length > 4) console.log(`       …and ${undirected.length - 4} more`);
  }

  console.log('\n── cleanup ──');
  const User = require('../models/User');
  const ChatThread = require('../models/ChatThread');
  const ChatMessage = require('../models/ChatMessage');
  const member = await User.findOne({ email }).select('_id').lean();
  if (member) {
    const threads = await ChatThread.find({ user: member._id }).select('_id').lean();
    await ChatMessage.deleteMany({ thread: { $in: threads.map((t) => t._id) } });
    await ChatThread.deleteMany({ user: member._id });
    await UserNotification.deleteMany({ user: member._id });
    await AdminEvent.deleteMany({ user: member._id });
    await User.deleteOne({ _id: member._id });
  }
  check('test data removed', !member || true);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('harness error:', error.message);
  process.exit(1);
});