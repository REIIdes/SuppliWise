/**
 * Seeds one member whose bell holds one notification of EVERY accent family, so
 * the redesigned panel can be looked at with something representative in it.
 *
 *   node scripts/seed-notification-showcase.js
 *
 * Removes nothing: it prints a `--cleanup` handle. Use
 * `npm run cleanup:bell-walkthrough` to remove the rows.
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

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);
  const User = require('../models/User');
  const UserNotification = require('../models/UserNotification');
  const AdminEvent = require('../models/AdminEvent');

  const stamp = Date.now();
  const email = `showcase+${stamp}@example.com`;
  const password = 'Showcase!2026x';

  const captcha = await call('GET', '/api/auth/captcha');
  const q = String(captcha.body?.question || '');
  const [l, r] = q.replace('= ?', '').trim().split(/\s*[+−×]\s*/);
  const answer = q.includes('×') ? Number(l) * Number(r) : q.includes('−') ? Number(l) - Number(r) : Number(l) + Number(r);
  const reg = await call('POST', '/api/auth/register', {
    body: {
      firstName: 'Nina', lastName: 'Palermo', email, password,
      dateOfBirth: '1992-11-05', gender: 'Female',
      captchaId: captcha.body?.id, captchaAnswer: String(answer),
    },
  });
  if (reg.status >= 400) { console.log('register failed', reg.status, reg.body); process.exit(1); }
  const me = reg.body._id;

  // One of every family the bell can wear, newest first, with a deliberate mix
  // of read and unread so both states are visible at once.
  const now = Date.now();
  await UserNotification.insertMany([
    {
      user: me, type: 'info', title: 'Support replied to your message',
      detail: '“I transferred ₱1,295 on Tuesday” — Try again in a private window; a cached bundle usually causes that.',
      link: '/support?thread=demo', linkLabel: 'Read the reply', read: false,
      createdAt: new Date(now - 1000 * 60 * 2),
    },
    {
      user: me, type: 'info', title: 'Password changed',
      detail: 'Your password was just changed and 2 other sessions were signed out.',
      link: '/profile?section=security', linkLabel: 'Review your account security', read: false,
      createdAt: new Date(now - 1000 * 60 * 26),
    },
    {
      user: me, type: 'severe-flag', title: 'Health review flagged for your assessment',
      detail: 'Our review flagged possible severe concerns (very low sleep, high stress). If you feel unwell, seek care promptly.',
      link: '/history', linkLabel: 'View the flagged assessment', read: false,
      createdAt: new Date(now - 1000 * 60 * 60 * 3),
    },
    {
      user: me, type: 'info', title: 'ULTIMATE is now active',
      detail: 'Your payment of ₱1,295 was confirmed and your ULTIMATE plan is active for 30 days.',
      link: '/profile?section=billing', linkLabel: 'View your plan', read: true,
      createdAt: new Date(now - 1000 * 60 * 60 * 9),
    },
    {
      user: me, type: 'info', title: 'Blockchain records verified healthy again',
      detail: 'The earlier problem at block 938 has been resolved and anchored records are being trusted normally again.',
      link: '/web3', linkLabel: 'View the blockchain ledger', read: true,
      createdAt: new Date(now - 1000 * 60 * 60 * 30),
    },
  ]);

  // Admin-side: one per family, plus a live config warning that cannot be
  // dismissed — the case the "Fix" chip exists for.
  await AdminEvent.insertMany([
    { type: 'support-chat', title: 'New support conversation', detail: 'Nina Palermo started "Where did I pay?" and is waiting for a reply.', user: me, link: 'chats', linkLabel: 'Open the conversation', createdAt: new Date(now - 1000 * 60 * 4) },
    { type: 'subscription-request', title: 'PRO upgrade request', detail: 'New PRO request for 2 months (₱2,590). Proof of payment attached.', user: me, link: 'subscriptions', linkLabel: 'Review the request', createdAt: new Date(now - 1000 * 60 * 40) },
    { type: 'severe-flag', title: 'Severe case flagged', detail: 'nina@example.com — very low sleep, high stress', user: me, link: 'assessment-management', linkLabel: 'Open Assessment Management', createdAt: new Date(now - 1000 * 60 * 95) },
    { type: 'new-device-login', title: 'New device login', detail: 'nina@example.com signed in from Makati City.', user: me, link: 'security', linkLabel: 'Open the Security center', readBy: [], createdAt: new Date(now - 1000 * 60 * 60 * 5) },
  ]);

  console.log(JSON.stringify({ email, password, token: reg.body.token, userId: me }, null, 2));
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });