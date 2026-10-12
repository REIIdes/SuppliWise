/**
 * Proves the fix reaches rows that ALREADY EXIST.
 *
 * The writers all stamp a link, but the database is full of rows written before
 * the field existed — the ones a member actually has sitting in their bell. This
 * seeds a handful of those deliberately undirected rows, reads them back through
 * the real API, and asserts every one arrives with a destination. It also checks
 * the admin bell the same way.
 *
 * Then it removes everything it created.
 *
 *   npm run verify:legacy-bell-links
 *
 * Run through scripts/withDevCa.mjs so the development certificate authority is
 * trusted, with plain `fetch` — the certificate is VERIFIED, never bypassed.
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

// The titles an OLD database row can carry, with where each must now arrive.
// Deliberately written with NO link — that is the whole point.
const LEGACY_MEMBER_ROWS = [
  { type: 'info', title: 'Support replied to your message', detail: 'x', want: '/support' },
  { type: 'info', title: 'Support conversation resolved', detail: 'x', want: '/support' },
  { type: 'info', title: 'Password changed', detail: 'x', want: '/profile?section=security' },
  { type: 'info', title: "You're back online", detail: 'x', want: '/profile?section=security' },
  { type: 'info', title: 'Recovery codes generated', detail: 'x', want: '/profile?section=security' },
  { type: 'severe-flag', title: 'Health review flagged for your assessment', detail: 'x', want: '/history' },
  { type: 'info', title: 'ULTIMATE is now active', detail: 'x', want: '/profile?section=billing' },
  { type: 'info', title: 'Blockchain records verified healthy again', detail: 'x', want: '/web3' },
];

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);
  const User = require('../models/User');
  const UserNotification = require('../models/UserNotification');
  const AdminEvent = require('../models/AdminEvent');

  const stamp = Date.now();
  const email = `legacy+${stamp}@example.com`;
  const password = 'LegacyBell!2026x';

  const captcha = await call('GET', '/api/auth/captcha');
  const q = String(captcha.body?.question || '');
  const [l, r] = q.replace('= ?', '').trim().split(/\s*[+−×]\s*/);
  const answer = q.includes('×') ? Number(l) * Number(r) : q.includes('−') ? Number(l) - Number(r) : Number(l) + Number(r);
  const reg = await call('POST', '/api/auth/register', {
    body: {
      firstName: 'Legacy', lastName: 'Row', email, password,
      dateOfBirth: '1994-02-03', gender: 'Male',
      captchaId: captcha.body?.id, captchaAnswer: String(answer),
    },
  });
  if (reg.status >= 400) { console.log('register failed', reg.status, reg.body); process.exit(1); }
  const memberToken = reg.body.token;
  // POST /auth/register returns the user's fields at the TOP level, not nested
  // under `user` — so the id is `body._id`.
  const memberId = reg.body._id;
  if (!memberToken || !memberId) {
    console.log('unexpected register response', reg.status, reg.body);
    process.exit(1);
  }

  console.log('\n── seeding rows with NO link, as an old database has ──');
  await UserNotification.insertMany(
    LEGACY_MEMBER_ROWS.map((row) => ({ ...row, user: memberId, read: false, dismissed: false })),
  );
  const seeded = await UserNotification.find({ user: memberId }).select('link').lean();
  check('the seeded rows really have no link', seeded.every((n) => !n.link), JSON.stringify(seeded.map((n) => n.link)));

  console.log('\n── reading them back through GET /api/notifications ──');
  const inbox = await call('GET', '/api/notifications?limit=20', { token: memberToken });
  const byTitle = Object.fromEntries((inbox.body?.notifications || []).map((n) => [n.title, n]));
  for (const row of LEGACY_MEMBER_ROWS) {
    const got = byTitle[row.title];
    check(`"${row.title}" arrives with ${row.want}`,
      got?.link === row.want, `got ${JSON.stringify(got?.link)}`);
  }

  console.log('\n── and the same for the admin bell ──');
  const AdminAccount = require('../models/AdminAccount');
  const admin = await AdminAccount.findOne({ enabled: true }).select('_id alias').lean();
  await AdminAccount.updateOne({ _id: admin._id }, { $set: { lastActivityAt: new Date() } });
  const jwt = require('jsonwebtoken');
  const adminToken = jwt.sign(
    { adminId: String(admin._id), role: 'admin', alias: admin.alias },
    process.env.JWT_SECRET, { expiresIn: '10m' },
  );
  await AdminEvent.insertMany([
    { type: 'support-chat', title: 'Legacy support chat A', detail: 'x', user: null, link: '' },
    { type: 'subscription-request', title: 'Legacy upgrade A', detail: 'x', user: null, link: '' },
    { type: 'severe-flag', title: 'Legacy severe A', detail: 'x', user: null, link: '' },
    { type: 'security', title: 'Legacy lockout A', detail: 'x', user: null, link: '' },
  ]);
  const bell = await call('GET', '/api/admin/notifications', { token: adminToken });
  const adminRows = Object.fromEntries((bell.body?.notifications || []).map((n) => [n.title, n]));
  for (const [title, want] of [
    ['Legacy support chat A', 'chats'],
    ['Legacy upgrade A', 'subscriptions'],
    ['Legacy severe A', 'assessment-management'],
    ['Legacy lockout A', 'security'],
  ]) {
    check(`"${title}" arrives on the ${want} tab`, adminRows[title]?.link === want, `got ${JSON.stringify(adminRows[title]?.link)}`);
  }

  console.log('\n── cleanup ──');
  await UserNotification.deleteMany({ user: memberId });
  await AdminEvent.deleteMany({ title: /^Legacy (support chat|upgrade|severe|lockout) A$/ });
  await User.deleteOne({ _id: memberId });
  const left = await UserNotification.countDocuments({ user: memberId });
  check('test data removed', left === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error:', e.message); process.exit(1); });