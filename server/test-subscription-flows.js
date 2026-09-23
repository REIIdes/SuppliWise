require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const AdminAccount = require('./models/AdminAccount');
const { issueUserSession } = require('./utils/sessions');

const BASE = 'http://localhost:5000';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function openStream(token, events) {
  const res = await fetch(BASE + '/api/subscription/stream', { headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 200) { check('SSE stream opens', false, 'status ' + res.status); return () => {}; }
  check('SSE stream opens', true);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = ''; let done = false;
  (async () => {
    try { while (!done) { const { value, done: d } = await reader.read(); if (d) break; buf += dec.decode(value, { stream: true });
      let idx; while ((idx = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (raw.startsWith('event: subscription')) { const line = raw.split('\n').find(l => l.startsWith('data: ')); if (line) { try { events.push(JSON.parse(line.slice(6))); } catch {} } } } } } catch {}
  })();
  return () => { done = true; try { reader.cancel(); } catch {} };
}

async function waitForEvent(events, pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const hit = events.find(pred); if (hit) return hit; await new Promise(r => setTimeout(r, 100)); }
  return null;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const email = 'subflow-test@example.com';
  await User.deleteOne({ email });
  const user = await User.create({ firstName: 'Sub', lastName: 'Flow', email, password: 'TestPass123!', dateOfBirth: new Date('1995-06-15'), gender: 'Male' });
  // Refresh the admin's activity stamp: protect() idle-kills admin sessions
  // after 3.5 minutes, and this test picks an arbitrary enabled account that
  // may have been idle for days — without this every admin call 401s.
  const admin = await AdminAccount.findOneAndUpdate(
    { enabled: true },
    { $set: { lastActivityAt: new Date() } },
    { new: true }
  ).lean();
  // User tokens must come from the session store (sid claim) — a raw
  // sid-less JWT is rejected by protect() since the session system landed.
  const userToken = await issueUserSession(user._id);
  const adminToken = jwt.sign({ role: 'admin', adminId: admin._id, id: admin._id }, process.env.JWT_SECRET, { expiresIn: '15m' });
  console.log('test user:', user._id.toString(), '| admin:', admin.alias);

  const events = [];
  const closeStream = await openStream(userToken, events);
  await waitForEvent(events, e => e.subscription);
  check('SSE snapshot on connect (free)', events[0] && events[0].subscription.currentPlan === 'free', JSON.stringify(events[0] && events[0].subscription.entitlements));

  // --- FREE baseline ---
  let r = await api('/api/subscription', { token: userToken });
  check('GET /subscription (free)', r.status === 200 && r.data.subscription.currentPlan === 'free' && r.data.subscription.entitlements.insights === false);
  r = await api('/api/subscription/feature/pdfExport', { token: userToken });
  check('feature/pdfExport denied (free)', r.status === 403 && r.data.requiresPlan === 'monthly');
  r = await api('/api/subscription/feature/priorityAssessment', { token: userToken });
  check('feature/priorityAssessment denied (free)', r.status === 403 && r.data.requiresPlan === 'annual');
  r = await api('/api/insights', { token: userToken });
  check('GET /insights 403 (free)', r.status === 403 && r.data.requiresPlan === 'monthly');
  r = await api('/api/auth/me', { token: userToken });
  check('GET /auth/me carries subscription state', r.status === 200 && r.data.subscription && r.data.subscription.currentPlan === 'free');

  // --- FREE -> PREMIUM (annual) ---
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'PATCH', token: adminToken, body: { active: true, plan: 'annual' } });
  check('admin PATCH -> annual accepted', r.status === 200 && r.data.subscription.currentPlan === 'annual', 'status ' + r.status + ' ' + JSON.stringify(r.data));
  const upEvt = await waitForEvent(events, e => e.subscription && e.subscription.currentPlan === 'annual');
  check('SSE push: FREE -> PREMIUM instant', !!upEvt, upEvt ? upEvt.subscription.version : 'no event within 3s');
  r = await api('/api/subscription', { token: userToken });
  check('state = annual, entitlements match spec', r.status === 200 && r.data.subscription.entitlements.insights === true && r.data.subscription.entitlements.pdfExport === true && r.data.subscription.entitlements.priorityAssessment === true && r.data.subscription.entitlements.historyFull === true && r.data.subscription.entitlements.chat === false);
  r = await api('/api/insights', { token: userToken });
  check('GET /insights 200 (annual)', r.status === 200);
  r = await api('/api/subscription/feature/pdfExport', { token: userToken });
  check('feature/pdfExport allowed (annual)', r.status === 200 && r.data.allowed === true);

  // --- PREMIUM -> FREE (admin removal) ---
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'PATCH', token: adminToken, body: { active: false, plan: 'free' } });
  check('admin PATCH -> free accepted', r.status === 200 && r.data.subscription.currentPlan === 'free');
  const downEvt = await waitForEvent(events, e => e.subscription && e.subscription.currentPlan === 'free' && e.subscription.subscriptionStatus !== 'free' ? false : (e.subscription && e.subscription.currentPlan === 'free'));
  check('SSE push: PREMIUM -> FREE instant', !!downEvt);
  r = await api('/api/insights', { token: userToken });
  check('GET /insights 403 again (removed)', r.status === 403);
  r = await api('/api/subscription/feature/pdfExport', { token: userToken });
  check('feature/pdfExport denied again', r.status === 403);
  r = await api('/api/subscription/feature/priorityAssessment', { token: userToken });
  check('feature/priorityAssessment denied again', r.status === 403);

  // --- FREE -> DELUXE (monthly) ---
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'PATCH', token: adminToken, body: { active: true, plan: 'monthly' } });
  check('admin PATCH -> monthly accepted', r.status === 200 && r.data.subscription.currentPlan === 'monthly');
  const deluxeEvt = await waitForEvent(events, e => e.subscription && e.subscription.currentPlan === 'monthly');
  check('SSE push: -> DELUXE instant', !!deluxeEvt);
  r = await api('/api/subscription', { token: userToken });
  const ent = r.data.subscription.entitlements;
  check('DELUXE entitlements exact', ent.insights === true && ent.pdfExport === true && ent.priorityAssessment === false && ent.historyFull === false && ent.chat === false, JSON.stringify(ent));
  r = await api('/api/subscription/feature/priorityAssessment', { token: userToken });
  check('priorityAssessment still 403 on DELUXE', r.status === 403 && r.data.requiresPlan === 'annual');
  r = await api('/api/assessment/history?limit=50', { token: userToken });
  check('history capped at 10 on DELUXE', r.status === 200 && r.data.planLimit === 10 && r.data.pagination.limit === 10, 'limit=' + (r.data.pagination && r.data.pagination.limit));

  // --- DELUXE -> ULTIMATE (custom) ---
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'PATCH', token: adminToken, body: { active: true, plan: 'custom' } });
  check('admin PATCH -> custom accepted', r.status === 200 && r.data.subscription.currentPlan === 'custom');
  await waitForEvent(events, e => e.subscription && e.subscription.currentPlan === 'custom');
  r = await api('/api/subscription/feature/chat', { token: userToken });
  check('feature/chat allowed (ULTIMATE)', r.status === 200 && r.data.allowed === true);
  r = await api('/api/assessment/history?limit=50', { token: userToken });
  check('history capped at 20 on ULTIMATE', r.status === 200 && r.data.planLimit === 20);

  // --- Expiry: set an expiry in the past ---
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'PATCH', token: adminToken, body: { active: true, plan: 'annual', expiresAt: new Date(Date.now() - 60000).toISOString() } });
  check('admin PATCH with past expiry accepted', r.status === 200 && r.data.subscription.subscriptionStatus === 'expired' && r.data.subscription.currentPlan === 'free');
  const expEvt = await waitForEvent(events, e => e.subscription && e.subscription.subscriptionStatus === 'expired');
  check('SSE push: expiry instant', !!expEvt);
  r = await api('/api/insights', { token: userToken });
  check('GET /insights 403 after expiry', r.status === 403);
  r = await api('/api/auth/me', { token: userToken });
  check('/auth/me reports expired/free', r.status === 200 && r.data.subscription.subscriptionStatus === 'expired' && r.data.subscription.currentPlan === 'free');

  closeStream();
  await User.deleteOne({ _id: user._id });
  await mongoose.disconnect();
  const failed = results.filter(x => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await User.deleteOne({ email: 'subflow-test@example.com' }); await mongoose.disconnect(); } catch {} process.exit(1); });
