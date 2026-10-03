/**
 * End-to-end check of the two ways a subscription can be bought, and of the
 * seat handling on both.
 *
 *   self-serve   POST /api/subscription/purchase   -> active immediately
 *   proof upload POST /api/subscription/requests   -> queued, grants nothing
 *                POST /api/admin/…/approve         -> then active
 *
 * The point of the second pair is that a request must grant NOTHING on its own,
 * and an approval must produce exactly the state a direct purchase would have.
 *
 * Run with the API up:  node test-subscription-teams.js
 */
/**
 * End-to-end check of the two ways a subscription can be bought, and of the
 * seat handling on both.
 *
 *   self-serve   POST /api/subscription/purchase   -> active immediately
 *   proof upload POST /api/subscription/requests   -> queued, grants nothing
 *                POST /api/admin/…/approve         -> then active
 *
 * The point of the second pair is that a request must grant NOTHING on its own,
 * and an approval must produce exactly the state a direct purchase would have.
 *
 * Accounts and tokens are created directly against the database, the same way
 * test-subscription-admin.js does it. Registering over HTTP would drag the auth
 * CAPTCHA and its 15-minute network lockout into an unrelated suite — and
 * nothing here is testing registration.
 *
 * Run with the server up:  node test-subscription-teams.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { connectTestDb, skipMessage } = require('./Test File/testDbGuard');
const { ensureE2eAdmin } = require('./Test File/e2eAdmin');
const { startTestServer } = require('./Test File/e2eServer');

const User = require('./models/User');
const AdminAccount = require('./models/AdminAccount');
const { issueUserSession } = require('./utils/sessions');

// Mutable: reassigned to the suite's own server once it boots. A developer's
// server on :5000 reads the APPLICATION database, so the member this suite
// creates in the throwaway one is invisible to it and every call 401s.
let API = process.env.API_BASE || 'http://localhost:5000/api';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 56 - name.length))}`);
}

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

/**
 * The account's live subscription state, as the app itself reads it.
 *
 * `GET /api/subscription` wraps the snapshot in `{ serverTime, subscription }`,
 * so every read goes through here rather than reaching into the envelope — a
 * test that asserts on the wrong level silently reads `undefined` and reports a
 * failure that has nothing to do with the code under test.
 */
async function readState(token) {
  const res = await call('/subscription', { token });
  return res.data?.subscription || null;
}

const stamp = Date.now();
const member = {
  firstName: 'Seat',
  lastName: 'Tester',
  email: `seat.tester.${stamp}@example.com`,
  password: 'SeatTester!2026',
  dateOfBirth: '1990-04-12',
  gender: 'Female',
};

async function main() {
  console.log(`SuppliWise — seats & plan requests e2e\n${'='.repeat(64)}`);

  // ── Accounts ──────────────────────────────────────────────────────────
  section('Accounts');
  // Tests write real User documents. Never let them reach the application's
  // own database — see Test File/testDbGuard.js.
  const db = await connectTestDb();
  if (!db.connected) { console.log(skipMessage(db)); return; }

  // The suite's own API, connected to the SAME throwaway database — see
  // Test File/e2eServer.js for why the developer's server cannot be used.
  const server = await startTestServer({ port: 5101 });
  if (!server.ok) { console.log(`SKIPPED: ${server.reason}`); return; }
  API = `${server.base}/api`;
  console.log(`e2e API on ${server.base} (test database)\n`);
  await User.deleteOne({ email: member.email });
  const user = await User.create({
    firstName: member.firstName, lastName: member.lastName, email: member.email,
    password: member.password, dateOfBirth: new Date('1990-04-12'), gender: 'Female',
  });
  // The throwaway database has no seeded admins, so the suite brings its own.
  // See Test File/e2eAdmin.js.
  const admin = await ensureE2eAdmin();
  if (!admin) throw new Error('Could not provision an admin account to run the admin half against.');

  const memberToken = await issueUserSession(user._id);
  const adminToken = jwt.sign(
    { role: 'admin', adminId: admin._id, id: admin._id },
    process.env.JWT_SECRET,
    { expiresIn: '15m' },
  );
  const memberId = String(user._id);
  check('member account ready', !!memberToken);
  check('admin token ready', !!adminToken, admin.alias);
  console.log(`  info member ${memberId} · admin ${admin.alias}`);

  // ── Catalogue ─────────────────────────────────────────────────────────
  section('Catalogue');
  const plans = await call('/subscription/plans');
  const team = plans.data?.team;
  check('team tier is the Premium plan', team?.tier === 'annual', team?.tier);
  check('team has a per-seat monthly price', /699/.test(team?.pricing?.formatted?.monthly || ''), team?.pricing?.formatted?.monthly);
  check('team seat bounds are 2..500', team?.minSeats === 2 && team?.maxSeats === 500);
  const totals = team?.pricing?.seatTotals || [];
  const five = totals.find((row) => row.seats === 5);
  check('5 seats pre-computes a total', !!five, totals.map((t) => t.seats));

  // The quote endpoint works whether or not self-serve is on — it only prices.
  section('Quote endpoint (any seat count)');
  for (const [seats, expected] of [[2, 1398], [7, 4893], [11, 7689], [500, 349500]]) {
    const q = await call(`/subscription/quote?plan=team&seats=${seats}&months=1`);
    // The formatted string is the server's, so compare on the digits.
    const digits = Number(String(q.data?.formatted || '').replace(/[^0-9]/g, ''));
    check(`quote for ${seats} seats is ${expected}`, digits === expected, q.data?.formatted);
  }
  for (const seats of [1, 0, 501, 99999]) {
    const bad = await call(`/subscription/quote?plan=team&seats=${seats}`);
    check(`quote refuses seats=${seats}`, bad.status === 400, bad.status);
  }
  // A quote must agree with what a purchase would charge, or the visitor is
  // shown one figure and billed another.
  const qYearly = await call('/subscription/quote?plan=team&seats=4&months=12');
  check('a yearly Team quote is 4 × 1,700 = 6,800', Number(String(qYearly.data?.formatted).replace(/[^0-9]/g, '')) === 6800, qYearly.data?.formatted);
  check('a yearly quote grants 360 days', qYearly.data?.days === 360, qYearly.data?.days);

  // Self-serve is OPT-IN and fails closed. When it is off, the purchase half of
  // this suite cannot run — and that is the deployment's correct behaviour, not
  // a failure, so it is reported as a skip rather than 21 red checks.
  const selfServe = plans.data?.selfServe === true;
  if (!selfServe) {
    console.log('\n  SKIP  self-serve purchase checks — this deployment has');
    console.log('        SUBSCRIPTION_SELF_SERVE_PURCHASE off (the secure default).');
    console.log('        Restart with it on to exercise them:\n');
    console.log('          $env:SUBSCRIPTION_SELF_SERVE_PURCHASE=\'true\'; npm start\n');
  } else {
    // ── Self-serve: an individual plan ──────────────────────────────────
    section('Self-serve purchase — individual plan');
  const buyMonthly = await call('/subscription/purchase', {
    method: 'POST', token: memberToken, body: { plan: 'monthly', months: 1 },
  });
  check('purchase accepted', buyMonthly.status === 200, buyMonthly.data);
  check('receipt is priced', !!buyMonthly.data?.receipt?.formatted, buyMonthly.data?.receipt);
  check('30 days granted', buyMonthly.data?.subscription?.daysRemaining === 30, buyMonthly.data?.subscription?.daysRemaining);
  check('one seat', buyMonthly.data?.subscription?.subscriptionSeats === 1, buyMonthly.data?.subscription?.subscriptionSeats);

  // ── Self-serve: Team, with seats ──────────────────────────────────────
  section('Self-serve purchase — Team with seats');
  const buyTeam = await call('/subscription/purchase', {
    method: 'POST', token: memberToken, body: { plan: 'team', seats: 5, months: 1 },
  });
  check('team purchase accepted', buyTeam.status === 200, buyTeam.data);
  const teamSub = buyTeam.data?.subscription;
  check('team grants the Premium tier', teamSub?.currentPlan === 'annual', teamSub?.currentPlan);
  check('team seat count stored', teamSub?.subscriptionSeats === 5, teamSub?.subscriptionSeats);
  check('team flagged as team', teamSub?.subscriptionIsTeam === true);
  // This is the SECOND purchase, so it is a renewal: 30 days already paid for
  // plus 30 more. Renewal extending rather than replacing is the rule, and the
  // 60 is the proof of it — not a 30.
  check('renewal extends rather than replaces (30 + 30 = 60)', teamSub?.daysRemaining === 60, teamSub?.daysRemaining);
  const receipt = buyTeam.data?.receipt;
  check('receipt total is 5 × 699 = 3,495', /3,495/.test(receipt?.formatted || ''), receipt?.formatted);
  check('receipt records the per-seat price', /699/.test(receipt?.perSeatFormatted || ''), receipt?.perSeatFormatted);
  check('receipt names what a seat unlocks', /PREMIUM/i.test(receipt?.grantsPlanLabel || ''), receipt?.grantsPlanLabel);

  // Entitlements must be Premium's, not Ultimate's.
  const snap = await readState(memberToken);
  check('team unlocks Premium features', snap?.entitlements?.priorityAssessment === true, snap?.entitlements?.priorityAssessment);
  check('team does NOT unlock Ultimate features', snap?.entitlements?.chat === false, snap?.entitlements?.chat);

  // ── Seat bounds are enforced, not clamped ─────────────────────────────
  section('Seat validation (refused, never clamped)');
  for (const [seats, why] of [[1, 'below the Team minimum'], [0, 'zero'], [99999, 'far over the cap'], [501, 'one over the cap'], [2.5, 'fractional']]) {
    const bad = await call('/subscription/purchase', {
      method: 'POST', token: memberToken, body: { plan: 'team', seats, months: 1 },
    });
    check(`seats=${seats} refused (${why})`, bad.status === 400, bad.status);
  }
  // The seat count must be unchanged by all those refusals — in particular NOT
  // silently turned into 500 by the ceiling.
  const afterRefusals = await readState(memberToken);
  check('seat count survived the refusals', afterRefusals?.subscriptionSeats === 5, afterRefusals?.subscriptionSeats);
  check('a refused purchase granted no extra days', afterRefusals?.daysRemaining === 60, afterRefusals?.daysRemaining);

  // ── Downgrading an individual plan drops the seats ────────────────────
  section('Downgrade drops to a single seat');
  const downgrade = await call('/subscription/purchase', {
    method: 'POST', token: memberToken, body: { plan: 'monthly', months: 1 },
  });
  check('downgrade accepted', downgrade.status === 200, downgrade.data);
  check('seats reset to 1', downgrade.data?.subscription?.subscriptionSeats === 1, downgrade.data?.subscription?.subscriptionSeats);
  check('no longer a team account', downgrade.data?.subscription?.subscriptionIsTeam === false);
  } // end of the self-serve-only block

  // ── Proof-of-payment request ──────────────────────────────────────────
  // This half runs on EITHER deployment. It is the working route when self-serve
  // is off, and a supported alternative when it is on.
  section('Plan request with proof of payment');
  const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  // The account must be on Free here, so the "a request grants nothing" check
  // below is unambiguous. On a self-serve run it already bought and downgraded,
  // which lands on Deluxe; either way it holds a paid plan, so reset it.
  if (selfServe) {
    await call(`/admin/users/${memberId}/subscription`, {
      method: 'POST', token: adminToken, body: { action: 'setPaid', plan: 'free', active: false },
    });
  }
  const baseline = await readState(memberToken);
  check('the account starts on Free for the request checks', baseline?.currentPlan === 'free', baseline?.currentPlan);

  const noProof = await call('/subscription/requests', {
    method: 'POST', token: memberToken, body: { plan: 'annual', months: 1 },
  });
  check('a request without proof is refused', noProof.status === 400, noProof.status);

  const svgProof = await call('/subscription/requests', {
    method: 'POST', token: memberToken,
    body: { plan: 'annual', proof: `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}` },
  });
  check('an SVG receipt is refused (stored-XSS vector)', svgProof.status === 400, svgProof.status);

  const freeReq = await call('/subscription/requests', {
    method: 'POST', token: memberToken, body: { plan: 'free', proof: PNG_1PX },
  });
  check('a Free request is refused', freeReq.status === 400, freeReq.status);

  const teamReq = await call('/subscription/requests', {
    method: 'POST', token: memberToken,
    body: { plan: 'team', seats: 6, months: 1, reference: 'E2E-REF-1', note: 'Bank transfer', proof: PNG_1PX },
  });
  check('a Team request with proof is accepted', teamReq.status === 200 || teamReq.status === 201, teamReq.data);
  const requestId = teamReq.data?.request?._id;
  check('the request has an id', !!requestId);
  check('it is priced server-side', /4,194/.test(teamReq.data?.request?.formattedAmount || ''), teamReq.data?.request?.formattedAmount);
  check('it records the seat count', teamReq.data?.request?.seats === 6, teamReq.data?.request?.seats);
  check('it stores the tier, not "team"', teamReq.data?.request?.plan === 'annual', teamReq.data?.request?.plan);

  // A request must grant nothing on its own. The account is on Free at this
  // point; submitting a Team request must not move it off Free, or the queue
  // would be an unauthenticated upgrade path.
  const afterRequest = await readState(memberToken);
  check('the request granted nothing by itself — still Free', afterRequest?.currentPlan === 'free', afterRequest?.currentPlan);
  check('no seats were granted by the request', afterRequest?.subscriptionSeats === 1, afterRequest?.subscriptionSeats);
  check('no days were granted by the request', !afterRequest?.subscriptionActive, afterRequest?.daysRemaining);

  // Duplicate guard.
  const dupe = await call('/subscription/requests', {
    method: 'POST', token: memberToken, body: { plan: 'team', seats: 6, months: 1, proof: PNG_1PX },
  });
  check('a duplicate pending request is refused', dupe.status === 409, dupe.status);

  // ── Admin queue ───────────────────────────────────────────────────────
  section('Admin queue');
  const queue = await call('/admin/subscription-requests?status=pending', { token: adminToken });
  const queued = (queue.data?.requests || []).find((row) => row._id === requestId);
  check('the request is in the queue', !!queued);
  check('the list does not ship the image', queued && queued.proof === undefined, queued ? Object.keys(queued) : null);
  check('the list says an image exists', queued?.hasProof === true);

  // ── Approval ──────────────────────────────────────────────────────────
  section('Approval grants the plan');
  const approve = await call(`/admin/subscription-requests/${requestId}/approve`, {
    method: 'POST', token: adminToken, body: { note: 'Verified against the bank statement' },
  });
  check('approval succeeded', approve.status === 200, approve.data);
  check('the grant is recorded on the request', approve.data?.request?.grantedPlan === 'annual', approve.data?.request?.grantedPlan);
  check('30 days were granted', approve.data?.request?.grantedDays === 30, approve.data?.request?.grantedDays);

  const approved = await readState(memberToken);
  check('the plan is now Premium', approved?.currentPlan === 'annual', approved?.currentPlan);
  check('the seat count came through', approved?.subscriptionSeats === 6, approved?.subscriptionSeats);
  check('flagged as a team account', approved?.subscriptionIsTeam === true);
  check('Premium features unlocked', approved?.entitlements?.historyFull === true, approved?.entitlements?.historyFull);

  // Exactly-once.
  const reApprove = await call(`/admin/subscription-requests/${requestId}/approve`, {
    method: 'POST', token: adminToken, body: {},
  });
  check('a second approval is refused', reApprove.status === 409, reApprove.status);

  // ── Admin override keeps the paid state underneath ────────────────────
  section('Admin override over a Team purchase');
  const grant = await call(`/admin/users/${memberId}/subscription`, {
    method: 'POST', token: adminToken, body: { action: 'grant', plan: 'custom', days: 10, note: 'e2e' },
  });
  check('override granted', grant.status === 200, grant.data);
  const during = await readState(memberToken);
  check('the override is in force', during?.subscriptionSource === 'admin', during?.subscriptionSource);
  check('the override did NOT change the paid seats', during?.subscriptionSeats === 6, during?.subscriptionSeats);

  const restore = await call(`/admin/users/${memberId}/subscription`, {
    method: 'POST', token: adminToken, body: { action: 'restore' },
  });
  check('restore succeeded', restore.status === 200, restore.data);
  const after = await readState(memberToken);
  check('the paid plan is back', after?.currentPlan === 'annual', after?.currentPlan);
  check('the paid seats came back with it', after?.subscriptionSeats === 6, after?.subscriptionSeats);
  check('source is payment again', after?.subscriptionSource === 'payment', after?.subscriptionSource);

  // ── An admin seat edit keeps the paid window ──────────────────────────
  section('Admin changes the seat count');
  const beforeSeatEdit = await readState(memberToken);
  const setSeats = await call(`/admin/users/${memberId}/subscription`, {
    method: 'POST', token: adminToken, body: { action: 'setPaid', plan: 'annual', seats: 12 },
  });
  check('seat change accepted', setSeats.status === 200, setSeats.data);
  const twelve = await readState(memberToken);
  check('seats are now 12', twelve?.subscriptionSeats === 12, twelve?.subscriptionSeats);
  // No `days` was sent, so the window must be untouched — a seat change is not
  // another month of access.
  check(
    'the window was not extended by a seat change',
    twelve?.daysRemaining === beforeSeatEdit?.daysRemaining,
    `${beforeSeatEdit?.daysRemaining} -> ${twelve?.daysRemaining}`,
  );

  const badSeats = await call(`/admin/users/${memberId}/subscription`, {
    method: 'POST', token: adminToken, body: { action: 'setPaid', plan: 'annual', seats: 9999 },
  });
  check('an absurd seat count is refused', badSeats.status === 400, badSeats.status);
  const unchanged = await readState(memberToken);
  check('seats unchanged after the refusal', unchanged?.subscriptionSeats === 12, unchanged?.subscriptionSeats);

  // ── Cleanup ───────────────────────────────────────────────────────────
  section('Cleanup');
  const SubscriptionRequest = require('./models/SubscriptionRequest');
  await SubscriptionRequest.deleteMany({ user: user._id });
  await User.deleteOne({ _id: user._id });
  const gone = await User.findById(user._id).lean();
  check('the test account is removed', gone === null);
  pass += 1;

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(64)}`);
  console.log(`passed ${pass}   failed ${fail}`);
  if (fail) {
    console.log(`\nfailures:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  }
  await mongoose.disconnect();
  // Stop the suite's own server so it cannot linger holding the port.
  await server.stop();
  process.exit(fail ? 1 : 0);
}

main().catch(async (error) => {
  console.error('\nharness error:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
