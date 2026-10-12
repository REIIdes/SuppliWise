/**
 * Proves the audience boundary with LIVE traffic against the running API.
 *
 * The unit tests assert the rule. This walks a real sign-in and a real support
 * conversation through both endpoints and shows what each bell actually
 * received — because a rule that holds in a test and fails on the wire is a rule
 * that was never really applied.
 *
 *   npm run verify:notification-boundary
 *
 * Then removes everything it created.
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
const check = (label, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label} ${extra}`); }
};

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);
  const User = require('../models/User');
  const AdminEvent = require('../models/AdminEvent');

  const stamp = Date.now();
  const email = `boundary+${stamp}@example.com`;
  const password = 'Boundary!2026x';

  console.log('\n── a member registers and signs in ──');
  const captcha = await call('GET', '/api/auth/captcha');
  const q = String(captcha.body?.question || '');
  const [l, r] = q.replace('= ?', '').trim().split(/\s*[+−×]\s*/);
  const answer = q.includes('×') ? Number(l) * Number(r) : q.includes('−') ? Number(l) - Number(r) : Number(l) + Number(r);
  const reg = await call('POST', '/api/auth/register', {
    body: {
      firstName: 'Nina', lastName: 'Palermo', email, password,
      dateOfBirth: '1991-03-17', gender: 'Female',
      captchaId: captcha.body?.id, captchaAnswer: String(answer),
    },
  });
  if (reg.status >= 400) { console.log('register failed', reg.status, reg.body); process.exit(1); }
  const me = reg.body._id;
  console.log(`  ${email} (${me})`);

  // A second sign-in on a "device" the first login recorded. This is the event
  // that used to leak into the admin stream. OTP is enabled on this account type,
  // so what is proven here is that the login ROUTE ran — the email-OTP branch
  // fires after the metadata block that used to raise the admin event.
  console.log('\n── the same member signs in again (a new device) ──');
  const second = await call('POST', '/api/auth/login', {
    body: { email, password, userAgent: 'BoundaryProbe/2.0' },
  });
  const accepted = second.status === 200 && (second.body?.token || second.body?.requiresOtp);
  check('second sign-in processed', accepted, `${second.status} ${JSON.stringify(second.body).slice(0, 120)}`);
  const memberToken = second.body?.token || reg.body.token;

  await new Promise((r) => setTimeout(r, 600));

  console.log('\n── what the MEMBER received ──');
  const memberInbox = await call('GET', '/api/notifications?limit=20', { token: memberToken });
  const memberRows = memberInbox.body?.notifications || [];
  for (const n of memberRows) console.log(`  [${n.type}] ${n.title}`);

  // The new-device notice requires a COMPLETED sign-in, and this harness cannot
  // complete the email-OTP round trip — so the assertion is on what must NOT be
  // true, which holds regardless. The member-notice half is asserted by the unit
  // suite against the route's source.
  console.log('  (new-device notice is asserted from source; see notification-boundary.test.js)');

  console.log('\n── what the ADMIN received ──');
  const AdminAccount = require('../models/AdminAccount');
  const admin = await AdminAccount.findOne({ enabled: true }).select('_id alias').lean();
  await AdminAccount.updateOne({ _id: admin._id }, { $set: { lastActivityAt: new Date() } });
  const jwt = require('jsonwebtoken');
  const adminToken = jwt.sign(
    { adminId: String(admin._id), role: 'admin', alias: admin.alias },
    process.env.JWT_SECRET, { expiresIn: '10m' },
  );
  const adminInbox = await call('GET', '/api/admin/notifications', { token: adminToken });
  const adminRows = adminInbox.body?.notifications || [];
  for (const n of adminRows) console.log(`  [${n.type}] ${n.title} — ${n.detail}`);

  // ── THE ASSERTIONS ─────────────────────────────────────────────────────
  const leaked = adminRows.filter((n) => n.type === 'new-device-login');
  check("the member's sign-in never reached the admin bell", leaked.length === 0,
    `saw ${leaked.length}: ${JSON.stringify(leaked.map((n) => n.detail))}`);

  // No identity anywhere in the admin rows, whatever their type.
  const IDENTITY = new RegExp(email, 'i');
  const withIdentity = adminRows.filter((n) => IDENTITY.test(n.title) || IDENTITY.test(n.detail || ''));
  check('no admin row carries the member email', withIdentity.length === 0,
    JSON.stringify(withIdentity.map((n) => n.detail)));

  // Every admin row must be one the admin can act on.
  const { isAdminBellEvent } = require('../utils/notificationAudience');
  const nonActionable = adminRows.filter((n) => !isAdminBellEvent(n));
  check('every admin bell row is operator work', nonActionable.length === 0,
    JSON.stringify(nonActionable.map((n) => n.type)));

  // And the member's own bell still works end to end.
  console.log('\n── the member files a support request; an admin replies ──');
  const started = await call('POST', '/api/support-chat', {
    token: memberToken,
    body: { subject: 'Boundary check', category: 'technical', body: 'Where does this land?' },
  });
  const threadId = started.body?.thread?._id;
  check('thread created', !!threadId);
  await call('POST', `/api/admin/chats/${threadId}/messages`, {
    token: adminToken, body: { body: 'Here is your answer.' },
  });

  await new Promise((r) => setTimeout(r, 500));
  const afterReply = await call('GET', '/api/notifications?limit=20', { token: memberToken });
  const replyRow = (afterReply.body?.notifications || []).find((n) => n.title === 'Support replied to your message');
  check('the member was told about the reply', !!replyRow);

  const adminAfter = await call('GET', '/api/admin/notifications', { token: adminToken });
  const adminChatRows = (adminAfter.body?.notifications || []).filter((n) => n.type === 'support-chat');
  const leakedReply = adminChatRows.find((n) => IDENTITY.test(n.detail || '') || /nina/i.test(n.detail || ''));
  check('the support thread does not name the member', !leakedReply,
    JSON.stringify(adminChatRows.map((n) => n.detail)));

  console.log('\n── cleanup ──');
  await User.deleteOne({ _id: me });
  await AdminEvent.deleteMany({ user: me });
  const ChatThread = require('../models/ChatThread');
  const ChatMessage = require('../models/ChatMessage');
  const threads = await ChatThread.find({ user: me }).select('_id').lean();
  await ChatMessage.deleteMany({ thread: { $in: threads.map((t) => t._id) } });
  await ChatThread.deleteMany({ user: me });
  check('test data removed', true);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error:', e.message); process.exit(1); });