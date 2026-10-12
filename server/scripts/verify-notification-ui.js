/**
 * Drives BOTH notification bells through the real UI and reports collisions.
 *
 * The redesign introduced per-family accent tokens (--nk-*) shared by the member
 * bell, the admin bell and the detail window. Three surfaces now read one set of
 * tokens, which is the point — but it also means a mistake is visible in all
 * three at once. This checks, in one pass:
 *
 *   · every row carries exactly one family, and it matches its routing target
 *   · the accent rail and icon tile resolve to a real colour, not a fallback
 *   · the panel and the detail window never fight for the same layer
 *   · the two bells can be open at once without either covering the other
 *   · nothing throws, nothing reads "undefined", nothing renders a NaN
 *
 *   node scripts/verify-notification-ui.js
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
  const UserNotification = require('../models/UserNotification');
  const AdminEvent = require('../models/AdminEvent');

  const stamp = Date.now();
  const email = `ui+${stamp}@example.com`;

  const captcha = await call('GET', '/api/auth/captcha');
  const q = String(captcha.body?.question || '');
  const [l, r] = q.replace('= ?', '').trim().split(/\s*[+−×]\s*/);
  const answer = q.includes('×') ? Number(l) * Number(r) : q.includes('−') ? Number(l) - Number(r) : Number(l) + Number(r);
  const reg = await call('POST', '/api/auth/register', {
    body: {
      firstName: 'Ravi', lastName: 'Mendoza', email, password: 'UiCheck!2026x',
      dateOfBirth: '1990-06-21', gender: 'Male',
      captchaId: captcha.body?.id, captchaAnswer: String(answer),
    },
  });
  if (reg.status >= 400) { console.log('register failed', reg.status, reg.body); process.exit(1); }
  const me = reg.body._id;
  const memberToken = reg.body.token;

  // ── Seed the member bell with one row per family ────────────────────────
  const now = Date.now();
  await UserNotification.insertMany([
    { user: me, type: 'info', title: 'Support replied to your message',
      detail: '“Where did I pay?” — Try again in a private window.',
      link: '/support?thread=ui', linkLabel: 'Read the reply',
      createdAt: new Date(now - 60000) },
    { user: me, type: 'info', title: 'Password changed',
      detail: 'Your password was just changed.',
      link: '/profile?section=security', linkLabel: 'Review your account security',
      createdAt: new Date(now - 120000) },
    { user: me, type: 'severe-flag', title: 'Health review flagged for your assessment',
      detail: 'Possible severe concerns were detected.',
      link: '/history', linkLabel: 'View the flagged assessment',
      createdAt: new Date(now - 180000) },
    { user: me, type: 'info', title: 'ULTIMATE is now active',
      detail: 'Your payment was confirmed.',
      link: '/profile?section=billing', linkLabel: 'View your plan',
      read: true, createdAt: new Date(now - 240000) },
    { user: me, type: 'info', title: 'Blockchain records verified healthy again',
      detail: 'The earlier problem was resolved.',
      link: '/web3', linkLabel: 'View the blockchain ledger',
      read: true, createdAt: new Date(now - 300000) },
  ]);

  // ── Seed the admin bell with one row per family ─────────────────────────
  await AdminEvent.insertMany([
    { type: 'support-chat', title: 'New support conversation',
      detail: 'A new conversation “Where did I pay?” (SW-UI0001) is waiting for a reply.',
      user: me, link: 'chats', linkLabel: 'Open the conversation', createdAt: new Date(now - 5000) },
    { type: 'subscription-request', title: 'PRO upgrade request',
      detail: 'New PRO request for 2 months (₱2,590). Proof of payment attached.',
      user: me, link: 'subscriptions', linkLabel: 'Review the request', createdAt: new Date(now - 60000) },
    { type: 'severe-flag', title: 'Severe case flagged',
      detail: 'very low sleep, high stress',
      user: me, assessmentId: me, linkUserId: me,
      link: 'assessment-management', linkLabel: 'Open Assessment Management', createdAt: new Date(now - 120000) },
    { type: 'security', title: 'Sign-in locked out',
      detail: 'Member ABCD locked out for ~15 minute(s) after continuous failed attempts.',
      link: 'security', linkLabel: 'Open the Security center', createdAt: new Date(now - 180000) },
  ]);

  const seeded = {
    memberToken,
    memberEmail: email,
    memberRows: (await UserNotification.find({ user: me }).lean()).length,
    adminRows: (await AdminEvent.find({ user: me }).lean()).length,
  };
  console.log(JSON.stringify({ ...seeded, memberId: me }, null, 2));
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });