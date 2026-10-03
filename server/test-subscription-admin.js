require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { connectTestDb, skipMessage } = require('./Test File/testDbGuard');
const { ensureE2eAdmin } = require('./Test File/e2eAdmin');
const { startTestServer } = require('./Test File/e2eServer');
const User = require('./models/User');
const AdminAccount = require('./models/AdminAccount');
const { issueUserSession } = require('./utils/sessions');
const C = require('./utils/planCatalogue');

/**
 * End-to-end subscription flows over the real HTTP API.
 *
 * Walks the exact scenario from the product spec — buy Premium (30 days), let
 * time pass (4 days left), an admin adds 6 days (10 days left), then "Restore
 * original subscription state" returns the account to PREMIUM with 4 days left
 * and the ORIGINAL expiry date — plus a permanent grant and the instant
 * entitlement changes every client depends on.
 *
 * Run with the server up:  node test-subscription-admin.js
 */

// Mutable, and reassigned to the suite's own server once it boots. A developer's
// server on :5000 is connected to the APPLICATION database, so pointing the suite
// at it would test nothing it just created — every session lookup 401s.
let BASE = 'http://localhost:5000';
const results = [];
let skipped = 0;
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};
// Keep the output readable: the API returns the whole entitlement map, which is
// thousands of characters and buries the assertion that actually failed.
const brief = (value) => {
  if (!value || typeof value !== 'object') return String(value);
  const s = value.subscription || value;
  return JSON.stringify({
    plan: s.currentPlan, status: s.subscriptionStatus, days: s.daysRemaining,
    perm: s.subscriptionPermanent, src: s.subscriptionSource, end: s.subscriptionEnd,
  });
};
const skip = (name, why) => {
  skipped += 1;
  console.log(`SKIP  ${name}  -> ${why}`);
};
const DAY = 24 * 60 * 60 * 1000;

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

// Open an SSE stream and collect `subscription` events.
async function openStream(token, events) {
  const res = await fetch(BASE + '/api/subscription/stream', { headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 200) { check('SSE stream opens', false, 'status ' + res.status); return () => {}; }
  check('SSE stream opens', true);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = false;
  (async () => {
    try {
      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!raw.startsWith('event: subscription')) continue;
          const line = raw.split('\n').find((l) => l.startsWith('data: '));
          if (line) { try { events.push(JSON.parse(line.slice(6))); } catch { /* malformed frame */ } }
        }
      }
    } catch { /* stream closed */ }
  })();
  return () => { done = true; try { reader.cancel(); } catch { /* already closed */ } };
}

async function waitForEvent(events, pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** Move an account's clock forward by rewriting its stored dates. */
async function rewind(userId, record, ms) {
  const now = new Date();
  const shift = (value) => (value ? new Date(new Date(value).getTime() - ms) : null);
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        'subscriptionRecord.paid.startedAt': shift(record.paid.startedAt),
        'subscriptionRecord.paid.expiresAt': shift(record.paid.expiresAt),
        'subscriptionExpiresAt': shift(record.subscriptionExpiresAt),
        'subscriptionStartedAt': shift(record.subscriptionStartedAt),
      },
    },
  );
}

(async () => {
  // Tests write real User documents. Never let them reach the application's
  // own database — see Test File/testDbGuard.js.
  const db = await connectTestDb();
  if (!db.connected) { console.log(skipMessage(db)); return; }

  // The suite's own API, connected to the SAME throwaway database. Without this
  // the developer's server (on the application database) cannot see the user
  // created below, and every authenticated call 401s — which looks like a
  // subscription regression and is really a wiring mistake.
  const server = await startTestServer();
  if (!server.ok) { console.log(`SKIPPED: ${server.reason}`); return; }
  BASE = server.base;
  console.log(`e2e API on ${server.base} (test database)\n`);
  const email = 'subadmin-test@example.com';
  await User.deleteOne({ email });
  const user = await User.create({
    firstName: 'Sub', lastName: 'Admin', email, password: 'TestPass123!',
    dateOfBirth: new Date('1995-06-15'), gender: 'Male',
  });
  // The throwaway database has none of the admins the server seeds at boot, so
  // the suite brings its own rather than assuming the environment arranged one.
  // See Test File/e2eAdmin.js — without this the lookup returned null and the
  // suite died on admin._id before running a check.
  const admin = await ensureE2eAdmin();
  const userToken = await issueUserSession(user._id);
  const adminToken = jwt.sign({ role: 'admin', adminId: admin._id, id: admin._id }, process.env.JWT_SECRET, { expiresIn: '15m' });
  console.log('test user:', user._id.toString(), '| admin:', admin.alias, '\n');

  const events = [];
  const closeStream = await openStream(userToken, events);
  await waitForEvent(events, (e) => e.subscription);

  // ── 0. The public catalogue ──────────────────────────────────────────────
  //
  // These assertions are derived from the catalogue itself, not hard-coded
  // figures. They used to pin `annual` at 60/599 and Team at 40 — USD numbers
  // that stopped being true when the catalogue moved to PHP base pricing, so
  // the check failed for reasons that had nothing to do with what it was
  // verifying. What actually matters is: the endpoint is public, every plan is
  // priced from the server's own catalogue (a client cannot invent a price),
  // and the conversion is internally consistent.
  let r = await api('/api/subscription/plans');
  const annualPhp = C.PLAN_CATALOGUE.find((p) => p.id === 'annual');
  const rate = C.CURRENCIES[r.data.currency] ? C.CURRENCIES[r.data.currency].rate : 1;
  const annualConverted = r.data.plans.find((p) => p.id === 'annual')?.pricing;
  check('GET /subscription/plans is public and priced', r.status === 200 && r.data.plans.length === 4
    && annualConverted?.php?.monthly === annualPhp.monthly
    && Math.abs(annualConverted.monthly - annualPhp.monthly / rate) < 0.01,
  `status ${r.status} annual ${JSON.stringify(annualConverted)} rate ${rate}`);
  check('catalogue states the 30-day standard period', r.data.standardPeriodDays === 30);
  // The Team band is priced per seat under `perSeatMonthly`/`perSeatYearly`
  // rather than `monthly`/`yearly`. The converter has to fall back to those
  // names — when it did not, the Team band priced at ZERO, i.e. a free seat.
  check('catalogue carries the Team band at its real per-seat price',
    !!r.data.team
      && r.data.team.pricing.php.monthly === C.TEAM_PLAN.perSeatMonthly
      && r.data.team.pricing.monthly > 0,
  `team ${JSON.stringify(r.data.team?.pricing)}`);

  // Self-serve purchasing FAILS CLOSED: unless the deployment explicitly sets
  // SUBSCRIPTION_SELF_SERVE_PURCHASE, an authenticated FREE user must not be able
  // to grant themselves the top tier. Verify the guard itself first.
  const selfServe = r.data.selfServe === true;
  if (!selfServe) {
    console.log('\n  (self-serve purchasing is OFF on this deployment — the purchase');
    console.log('   block below will seed the paid state through the admin API instead)');
    console.log('   enable it with SUBSCRIPTION_SELF_SERVE_PURCHASE=true to test checkout\n');
  }

  // ── 1. A purchase is 1 month / 30 days ───────────────────────────────────
  if (selfServe) {
    r = await api('/api/subscription/purchase', { method: 'POST', token: userToken, body: { plan: 'annual' } });
    check('purchase -> PREMIUM accepted', r.status === 200 && r.data.subscription.currentPlan === 'annual', 'status ' + r.status + ' ' + brief(r.data));
    check('purchase grants exactly 30 days', r.data?.subscription?.daysRemaining === 30, String(r.data?.subscription?.daysRemaining));
    check('purchase is recorded as PAID (not ADMIN)', r.data?.subscription?.subscriptionSource === 'payment', String(r.data?.subscription?.subscriptionSource));
  } else {
    // The guard: the very same call must be refused.
    r = await api('/api/subscription/purchase', { method: 'POST', token: userToken, body: { plan: 'custom' } });
    check('self-serve purchase is refused when the flag is off', r.status === 501 && r.data?.code === 'SELF_SERVE_DISABLED', 'status ' + r.status);
    r = await api('/api/subscription/purchase', { method: 'POST', token: userToken, body: { plan: 'platinum' } });
    check('an invalid plan is a 400 even when billing is off', r.status === 400, 'status ' + r.status);
    r = await api('/api/subscription/purchase', { method: 'POST', token: userToken, body: { plan: 'free' } });
    check('purchasing FREE is rejected', r.status === 400, 'status ' + r.status);
    r = await api('/api/subscription/purchase', { method: 'POST', body: { plan: 'annual' } });
    check('purchasing without a session is 401', r.status === 401, 'status ' + r.status);

    // Seed the equivalent paid state through the admin API (actor recorded as a
    // payment, so the two-layer bookkeeping below is identical).
    r = await api(`/api/admin/users/${user._id}/subscription`, {
      method: 'POST', token: adminToken, body: { action: 'setPaid', plan: 'annual', days: 30, note: 'Purchased PREMIUM — 1 month.' },
    });
    check('paid state seeded (30 days)', r.status === 200 && r.data.subscription.daysRemaining === 30, 'status ' + r.status + ' ' + brief(r.data));
    check('seeded paid state is recorded as PAID', r.data?.subscription?.subscriptionSource === 'payment', String(r.data?.subscription?.subscriptionSource));
  }
  const boughtExpiry = r.data?.subscription?.subscriptionEnd;

  const buyEvt = await waitForEvent(events, (e) => e.subscription && e.subscription.currentPlan === 'annual');
  check('SSE push on purchase (instant unlock)', !!buyEvt);
  check('SSE push carries the day count', buyEvt?.subscription?.daysRemaining === 30, String(buyEvt?.subscription?.daysRemaining));

  r = await api('/api/auth/me', { token: userToken });
  check('/auth/me reports 30 days + PAID', r.status === 200 && r.data.subscription.daysRemaining === 30
    && r.data.subscription.subscriptionSource === 'payment');
  check('/auth/me exposes both layers', !!r.data.subscription.subscriptionLayers
    && r.data.subscription.subscriptionLayers.paid.plan === 'annual'
    && r.data.subscription.subscriptionLayers.override.active === false);

  // ── 2. Time passes: 4 days remaining ─────────────────────────────────────
  // Rewind the stored window instead of waiting 26 real days. The PAID layer is
  // the one that was bought, so that is what moves.
  await rewind(user._id, { paid: { startedAt: new Date(), expiresAt: new Date(Date.now() + 30 * DAY) }, subscriptionExpiresAt: new Date(Date.now() + 30 * DAY), subscriptionStartedAt: new Date() }, 26 * DAY);
  r = await api('/api/subscription', { token: userToken });
  check('26 days later: 4 days remaining', r.data?.subscription?.daysRemaining === 4, brief(r.data));
  const originalExpiry = r.data?.subscription?.subscriptionEnd;
  // The rewind IS the test moving the clock, so the stored expiry must have moved
  // with it — by exactly 26 days, no more and no less. This is the baseline the
  // "restore" assertions below are measured against.
  const rewoundBy = new Date(boughtExpiry).getTime() - new Date(originalExpiry).getTime();
  check('the bought window moved back by exactly 26 days', Math.abs(rewoundBy - 26 * DAY) < 2000,
    `${Math.round(rewoundBy / DAY)}d`);

  // ── 3. Admin adds 6 days ─────────────────────────────────────────────────
  r = await api(`/api/admin/users/${user._id}/subscription`, {
    method: 'POST', token: adminToken,
    body: { action: 'addDays', days: 6, note: 'goodwill for the outage' },
  });
  check('admin +6 days accepted', r.status === 200 && r.data.subscription.daysRemaining === 10, 'status ' + r.status + ' ' + brief(r.data));
  check('override is now the source', r.data?.subscription?.subscriptionSource === 'admin', String(r.data?.subscription?.subscriptionSource));
  check('permanent flag is false after a day grant', r.data?.subscription?.subscriptionPermanent === false);

  const addEvt = await waitForEvent(events, (e) => e.subscription && e.subscription.daysRemaining === 10);
  check('SSE push: admin +6 days lands instantly', !!addEvt, addEvt ? addEvt.subscription.version : 'no event within 4s');

  // The paid state must be untouched underneath.
  r = await api(`/api/admin/users/${user._id}/subscription`, { token: adminToken });
  const detail = r.data?.detail;
  check('paid state still 4 days (not overwritten)', detail?.paid?.daysRemaining === 4, JSON.stringify(detail?.paid));
  check('paid expiry date preserved', detail?.paid?.expiresAt === originalExpiry, `${detail?.paid?.expiresAt}`);
  check('override layer is active', detail?.override?.active === true);
  check('restore target records 4 days', detail?.restoreTarget?.capturedDaysRemaining === 4, JSON.stringify(detail?.restoreTarget));
  check('restore target keeps the original expiry', detail?.restoreTarget?.expiresAt === originalExpiry);
  check('change log recorded the admin + reason', detail?.history?.[0]?.action === 'addDays'
    && detail.history[0].actor?.startsWith('admin:')
    && detail.history[0].note === 'goodwill for the outage', JSON.stringify(detail?.history?.[0]));

  // ── 4. Restore the original state ────────────────────────────────────────
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'POST', token: adminToken, body: { action: 'restore' } });
  check('restore accepted', r.status === 200, 'status ' + r.status);
  check('restore returns 4 days, NOT a fresh 30', r.data?.subscription?.daysRemaining === 4, brief(r.data));
  check('restore returns the ORIGINAL expiry date', r.data?.subscription?.subscriptionEnd === originalExpiry, `${r.data?.subscription?.subscriptionEnd} vs ${originalExpiry}`);
  check('restore returns to PAID', r.data?.subscription?.subscriptionSource === 'payment', String(r.data?.subscription?.subscriptionSource));
  check('restore keeps the plan PREMIUM', r.data?.subscription?.currentPlan === 'annual');
  check('override cleared after restore', r.data?.detail?.override?.active === false);

  const restoreEvt = await waitForEvent(events, (e) => e.subscription && e.subscription.subscriptionSource === 'payment');
  check('SSE push: restore lands instantly', !!restoreEvt, restoreEvt ? restoreEvt.subscription.version : 'no event within 4s');

  // ── 5. Permanent admin grant ─────────────────────────────────────────────
  r = await api(`/api/admin/users/${user._id}/subscription`, {
    method: 'POST', token: adminToken,
    body: { action: 'grant', plan: 'custom', permanent: true, note: 'ULTIMATE for life' },
  });
  check('permanent grant accepted', r.status === 200 && r.data.subscription.currentPlan === 'custom', 'status ' + r.status);
  check('permanent: subscriptionPermanent true', r.data?.subscription?.subscriptionPermanent === true);
  check('permanent: no expiry date', r.data?.subscription?.subscriptionEnd === null, String(r.data?.subscription?.subscriptionEnd));
  check('permanent: duration reads PERMANENT', r.data?.subscription?.subscriptionDuration === 'PERMANENT', String(r.data?.subscription?.subscriptionDuration));
  check('permanent: daysRemaining is null', r.data?.subscription?.daysRemaining === null);
  check('permanent: source is ADMIN', r.data?.subscription?.subscriptionSource === 'admin');
  check('permanent: label shows ULTIMATE', r.data?.detail?.effective?.label === 'ULTIMATE');

  // A permanent grant must still be live a long time later.
  await User.updateOne(
    { _id: user._id },
    { $set: { 'subscriptionRecord.override.appliedAt': new Date(Date.now() - 3000 * DAY), 'subscriptionRecord.override.startedAt': new Date(Date.now() - 3000 * DAY) } },
  );
  r = await api('/api/subscription', { token: userToken });
  check('permanent grant is still live years later', r.data?.subscription?.currentPlan === 'custom'
    && r.data?.subscription?.subscriptionPermanent === true, JSON.stringify(r.data?.subscription?.currentPlan));
  r = await api('/api/subscription/feature/chat', { token: userToken });
  check('permanent ULTIMATE unlocks chat', r.status === 200 && r.data.allowed === true);

  // …and it can be removed explicitly.
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'POST', token: adminToken, body: { action: 'remove' } });
  check('permanent grant can be removed', r.status === 200 && r.data.subscription.currentPlan === 'free', 'status ' + r.status);
  r = await api('/api/subscription/feature/chat', { token: userToken });
  check('chat locked again after removal', r.status === 403);

  // ── 6. Every admin action moves entitlements immediately ─────────────────
  const matrix = [
    ['grant', { plan: 'monthly', days: 30 }, (s) => s.entitlements.insights === true && s.entitlements.chat === false],
    ['grant', { plan: 'annual', days: 30 }, (s) => s.entitlements.priorityAssessment === true && s.entitlements.historyFull === true && s.entitlements.chat === false],
    ['grant', { plan: 'custom', days: 30 }, (s) => s.entitlements.chat === true],
    ['changePlan', { plan: 'monthly' }, (s) => s.entitlements.chat === false && s.entitlements.insights === true],
    ['deductDays', { days: 400 }, (s) => s.entitlements.insights === false && s.subscriptionStatus === 'expired'],
  ];
  for (const [action, payload, assert] of matrix) {
    const res = await api(`/api/admin/users/${user._id}/subscription`, { method: 'POST', token: adminToken, body: { action, ...payload } });
    const state = res.data?.subscription;
    check(`${action} ${JSON.stringify(payload)} -> entitlements correct`,
      res.status === 200 && !!state && assert(state),
      `status ${res.status} ${brief(res.data)}`);
  }

  // ── 7. A permanent plan refuses day arithmetic ───────────────────────────
  // Re-granted here, because the matrix above deliberately ended the account on
  // an expired window (deductDays 400) and there is nothing to adjust on a FREE
  // account — which is itself a rule worth proving.
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'POST', token: adminToken, body: { action: 'grant', plan: 'custom', permanent: true } });
  check('permanent re-grant for the guard test', r.status === 200 && r.data.subscription.subscriptionPermanent === true, 'status ' + r.status);
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'POST', token: adminToken, body: { action: 'addDays', days: 5 } });
  check('a permanent plan rejects day arithmetic with 400', r.status === 400 && /permanent/i.test(r.data?.message || ''), `${r.status} ${r.data?.message || ''}`);
  await api(`/api/admin/users/${user._id}/subscription`, { method: 'POST', token: adminToken, body: { action: 'remove' } });

  // ── 8. Bad input is a 400, never a 500 ───────────────────────────────────
  const rejects = [
    ['unknown action', { action: 'nonsense' }],
    ['free plan grant', { action: 'grant', plan: 'free', days: 5 }],
    ['unknown plan', { action: 'grant', plan: 'platinum', days: 5 }],
    ['zero days', { action: 'addDays', days: 0 }],
    ['negative days', { action: 'addDays', days: -5 }],
    ['bad expiry', { action: 'extend', expiresAt: 'not-a-date' }],
    ['restore with no override', { action: 'restore' }],
  ];
  for (const [label, body] of rejects) {
    const res = await api(`/api/admin/users/${user._id}/subscription`, { method: 'POST', token: adminToken, body });
    check(`rejects ${label} with 400`, res.status === 400, `got ${res.status} ${res.data?.message || ''}`);
  }

  // An adjustment with nothing in force must be refused, not silently faked:
  // the account is FREE right now, so there is no subscription to add days to.
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'POST', token: adminToken, body: { action: 'addDays', days: 5 } });
  check('adjusting a FREE account is refused with 400', r.status === 400 && /no active subscription/i.test(r.data?.message || ''), `${r.status} ${r.data?.message || ''}`);
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'POST', token: adminToken, body: { action: 'changePlan', plan: 'annual' } });
  check('changing the plan of a FREE account is refused with 400', r.status === 400, `${r.status} ${r.data?.message || ''}`);

  // ── 9. The legacy PATCH shim still works ─────────────────────────────────
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'PATCH', token: adminToken, body: { active: true, plan: 'monthly' } });
  check('legacy PATCH -> DELUXE still works', r.status === 200 && r.data.subscription.currentPlan === 'monthly', 'status ' + r.status + ' ' + brief(r.data));
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'PATCH', token: adminToken, body: { active: false, plan: 'free' } });
  check('legacy PATCH -> FREE still works', r.status === 200 && r.data.subscription.currentPlan === 'free', 'status ' + r.status);
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'PATCH', token: adminToken, body: { active: true, plan: 'nope' } });
  check('legacy PATCH rejects an unknown plan', r.status === 400, String(r.status));
  r = await api(`/api/admin/users/${user._id}/subscription`, { method: 'PATCH', token: adminToken, body: { active: 'yes' } });
  check('legacy PATCH rejects a non-boolean active', r.status === 400, String(r.status));

  // ── 10. The user-facing stream reflects the final state ──────────────────
  r = await api('/api/subscription', { token: userToken });
  check('user state ends on FREE', r.data?.subscription?.currentPlan === 'free');
  check('user payload does not leak the admin change log', Array.isArray(r.data?.subscription?.subscriptionLayers?.history)
    && r.data.subscription.subscriptionLayers.history.length === 0);

  closeStream();
  await User.deleteOne({ _id: user._id });
  await mongoose.disconnect();
  // Stop the suite's own server before exiting, so it cannot hold the port or
  // linger as an orphan process after the run.
  await server.stop();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  try { await User.deleteOne({ email: 'subadmin-test@example.com' }); await mongoose.disconnect(); } catch { /* cleanup best-effort */ }
  process.exit(1);
});
