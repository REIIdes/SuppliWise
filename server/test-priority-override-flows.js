/**
 * LIVE end-to-end check of the admin override on an assessment.
 *
 * The unit suite (`Test File/admin-override.test.js`) drives the router against
 * an in-memory store, which is what makes it fast and runnable anywhere. This
 * script is the other half: it runs the real server, the real MongoDB and the
 * real auth, and walks the override the way an admin and a user actually would.
 * It is the check to run after touching routes/assessment.js, priorityGate.js,
 * or anything that feeds them.
 *
 * Requires: the API already running on PORT (default 5000) and MONGO_TEST_URI
 *   set to a DEDICATED throwaway database (never the application's MONGO_URI —
 *   this suite writes real documents and will refuse to run otherwise).
 *   npm start          # in another terminal
 *   npm run test:priority
 *
 * It creates its own throwaway user, exercises every branch, and deletes
 * everything it made. Exit code is non-zero if any check fails.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { connectTestDb, skipMessage } = require('./Test File/testDbGuard');

const User = require('./models/User');
const AdminAccount = require('./models/AdminAccount');
const Assessment = require('./models/Assessment');
const IntakeRecord = require('./models/IntakeRecord');
const UserNotification = require('./models/UserNotification');
const AdminEvent = require('./models/AdminEvent');
const { issueUserSession } = require('./utils/sessions');
const { expiryFrom } = require('./utils/assessments');

const BASE = `http://localhost:${process.env.PORT || 5000}`;
const TEST_EMAIL = 'priority-override-flow@example.com';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

const todayKey = () => new Date().toISOString().split('T')[0];

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  return { status: res.status, data };
}

/** A body the assessment route accepts, severe enough to auto-flag. */
const ASSESSMENT_BODY = {
  age: 34, gender: 'Male', weight: 78, height: 180,
  activityLevel: 'Moderate',
  symptoms: ['chest pain', 'shortness of breath'],
  medicalConditions: [],
  allergies: 'None',
  currentMedications: 'None',
};

/**
 * The same body with nothing severe in it, so the save does NOT auto-flag.
 * Used wherever the scenario needs an assessment that stays Standard until an
 * admin says otherwise — otherwise severity detection flags it on the way in
 * and the behaviour under test never gets to run.
 */
const MILD_ASSESSMENT_BODY = { ...ASSESSMENT_BODY, symptoms: ['mild fatigue'] };

async function cleanup(userId) {
  const filter = { user: userId };
  const assessments = await Assessment.find(filter).select('_id').lean();
  const ids = assessments.map((a) => a._id);
  await Promise.all([
    Assessment.deleteMany(filter),
    IntakeRecord.deleteMany(filter),
    DashboardMetricsCleanup(filter),
    UserNotification.deleteMany(filter),
    AdminEvent.deleteMany(filter),
    User.deleteOne({ _id: userId }),
  ]);
  return ids;
}

async function DashboardMetricsCleanup(filter) {
  const DashboardMetrics = require('./models/DashboardMetrics');
  return DashboardMetrics.deleteMany(filter);
}

/** Mark a whole day's plan as taken, which is what "the review is satisfied" means. */
async function completeTodaysPlan(userId, assessmentId, { total = 3, taken = 3 } = {}) {
  const rows = [];
  for (let i = 0; i < total; i += 1) {
    rows.push({
      user: userId,
      assessment: assessmentId,
      supplementName: `Flow Supplement ${i + 1}`,
      dosage: '1 capsule',
      priority: 'Medium',
      taken: i < taken,
      takenAt: i < taken ? new Date() : undefined,
      date: new Date(),
      dayKey: todayKey(),
    });
  }
  const created = await IntakeRecord.insertMany(rows);
  return created;
}

(async () => {
  // Tests write real User/IntakeRecord documents. Never let them reach the
  // application's own database — see Test File/testDbGuard.js.
  const db = await connectTestDb();
  if (!db.connected) { console.log(skipMessage(db)); return; }

  // Start from a clean slate even if a previous run was interrupted.
  const leftover = await User.findOne({ email: TEST_EMAIL }).select('_id').lean();
  if (leftover) await cleanup(leftover._id);

  const user = await User.create({
    firstName: 'Priority', lastName: 'Flow',
    email: TEST_EMAIL, password: 'TestPass123!',
    dateOfBirth: new Date('1992-06-15'), gender: 'Male',
  });

  // protect() idle-kills admin sessions after a few minutes, and this script
  // picks an arbitrary enabled account that may have been idle for days.
  const admin = await AdminAccount.findOneAndUpdate(
    { enabled: true },
    { $set: { lastActivityAt: new Date() } },
    { new: true }
  ).lean();
  if (!admin) throw new Error('No enabled admin account exists — cannot run the admin override flow.');

  // User tokens must come from the session store (sid claim); a raw sid-less JWT
  // is rejected by protect() since the session system landed.
  const userToken = await issueUserSession(user._id);
  const adminToken = jwt.sign(
    { role: 'admin', adminId: admin._id, id: admin._id },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  console.log(`test user: ${user._id} | admin: ${admin.alias}\n`);

  // ── 0. PREMIUM entitlement, or the pause is not enforced at all ───────────
  let r = await api(`/api/admin/users/${user._id}/subscription`, {
    method: 'PATCH', token: adminToken, body: { active: true, plan: 'annual' },
  });
  check('user is on PREMIUM (Priority Assessment is a PREMIUM+ entitlement)', r.status === 200 && r.data.subscription.currentPlan === 'annual', `status ${r.status}`);

  // ── 1. Severity auto-flag ────────────────────────────────────────────────
  r = await api('/api/assessment', { method: 'POST', token: userToken, body: ASSESSMENT_BODY });
  check('severe assessment is saved and auto-flagged', r.status === 201 && r.data.assessment.priority === 'Priority', `status ${r.status} priority=${r.data && r.data.assessment && r.data.assessment.priority}`);
  const first = r.data && r.data.assessment;
  if (!first) throw new Error('the first assessment was not created — aborting');

  r = await api('/api/assessment/priority-status', { token: userToken });
  check('the user is blocked from new assessments', r.status === 200 && r.data.blocked === true && r.data.assessments.length === 1, JSON.stringify(r.data));

  r = await api('/api/assessment', { method: 'POST', token: userToken, body: ASSESSMENT_BODY });
  check('a second assessment is refused while the review is open', r.status === 403 && r.data.priorityAssessment && String(r.data.priorityAssessment.id) === String(first._id), `status ${r.status}`);

  // ── 2. Authorization ────────────────────────────────────────────────────
  r = await api(`/api/assessment/${first._id}/priority`, { method: 'PATCH', token: userToken, body: { priority: 'Standard' } });
  check('a user cannot release their own review', r.status === 403, `status ${r.status}`);
  r = await api(`/api/assessment/${first._id}/priority`, { method: 'PATCH', token: adminToken, body: { priority: 'Standard' } });
  check('an admin can release it', r.status === 200, `status ${r.status}`);

  // ── 3. The release is visible, notified and audited ──────────────────────
  r = await api('/api/assessment/priority-status', { token: userToken });
  check('the user is unblocked after the release', r.status === 200 && r.data.blocked === false, JSON.stringify(r.data));

  const notified = await UserNotification.findOne({ user: user._id, assessmentId: first._id }).sort({ createdAt: -1 }).lean();
  check('the user was told an admin acted', !!notified, notified ? notified.title : 'no notification');
  const audited = await AdminEvent.findOne({ user: user._id, assessmentId: first._id, type: 'resolved' }).sort({ createdAt: -1 }).lean();
  check('the release is in the admin audit trail', !!audited, audited ? audited.title : 'no admin event');

  const released = await Assessment.findById(first._id).lean();
  const expectedExpiry = expiryFrom(released.createdAt).getTime();
  check('the 5-year retention date is restored from CREATION, not from now',
    new Date(released.expiresAt).getTime() === expectedExpiry,
    `${new Date(released.expiresAt).toISOString()} vs ${new Date(expectedExpiry).toISOString()}`);
  check('the release is recorded as an admin decision', released.resolvedReason === 'admin-resolved', released.resolvedReason);

  // ── 4. Input validation ─────────────────────────────────────────────────
  r = await api(`/api/assessment/${first._id}/priority`, { method: 'PATCH', token: adminToken, body: { priority: 'URGENT' } });
  check('an unknown priority value is a 400', r.status === 400, `status ${r.status}`);
  r = await api('/api/assessment/not-an-id/priority', { method: 'PATCH', token: adminToken, body: { priority: 'Priority' } });
  check('a malformed id is a 400, not a 500', r.status === 400, `status ${r.status}`);
  r = await api(`/api/assessment/${new mongoose.Types.ObjectId()}/priority`, { method: 'PATCH', token: adminToken, body: { priority: 'Priority' } });
  check('an unknown id is a 404', r.status === 404, `status ${r.status}`);

  // ── 5. The stacking rule ────────────────────────────────────────────────
  // MILD body on purpose: a severe one would auto-flag `second` on the way in,
  // so the stacking rule would be satisfied before the scenario starts.
  r = await api('/api/assessment', { method: 'POST', token: userToken, body: MILD_ASSESSMENT_BODY });
  const second = r.data && r.data.assessment;
  check('a second assessment saves once the review is released', r.status === 201 && second.priority === 'Standard', `status ${r.status}`);

  r = await api(`/api/assessment/${first._id}/priority`, { method: 'PATCH', token: adminToken, body: { priority: 'Priority' } });
  check('an admin can raise the first one', r.status === 200, `status ${r.status} ${(r.data && r.data.code) || ''}`);

  r = await api(`/api/assessment/${second._id}/priority`, { method: 'PATCH', token: adminToken, body: { priority: 'Priority' } });
  check('a second concurrent review is refused', r.status === 409 && r.data.code === 'already-open' && String(r.data.openAssessmentId) === String(first._id), `status ${r.status} code=${r.data && r.data.code}`);

  r = await api(`/api/assessment/${first._id}/priority`, { method: 'PATCH', token: adminToken, body: { priority: 'Priority' } });
  check('re-raising the same review is idempotent, not a stacking refusal', r.status === 200, `status ${r.status} ${(r.data && r.data.code) || ''}`);

  // ── 6. The "already finished" rule ──────────────────────────────────────
  await completeTodaysPlan(user._id, second._id, { total: 3, taken: 3 });
  r = await api(`/api/assessment/${second._id}/priority`, { method: 'PATCH', token: adminToken, body: { priority: 'Priority' } });
  check('a finished plan cannot be flagged', r.status === 409 && r.data.code === 'intake-complete', `status ${r.status} code=${r.data && r.data.code}`);
  check('the refusal explains itself to the admin', !!(r.data.message && r.data.message.length > 20), r.data && r.data.message);
  check('the refusal reports the intake facts', !!(r.data.intake && r.data.intake.total === 3 && r.data.intake.taken === 3 && r.data.intake.complete === true), JSON.stringify(r.data.intake));

  const stillStandard = await Assessment.findById(second._id).lean();
  check('a refusal does not write', stillStandard.priority === 'Standard', stillStandard.priority);

  // ── 7. Auto-release of a flag whose plan is already satisfied ────────────
  await completeTodaysPlan(user._id, first._id, { total: 2, taken: 2 });
  r = await api('/api/assessment/priority-status', { token: userToken });
  check('a satisfied review is released on read instead of pausing forever', r.status === 200 && r.data.blocked === false, JSON.stringify(r.data));

  const healed = await Assessment.findById(first._id).lean();
  check('the auto-release restores the retention date too',
    healed.priority === 'Standard' && !!healed.expiresAt && new Date(healed.expiresAt).getTime() === expiryFrom(healed.createdAt).getTime(),
    `priority=${healed.priority} expiresAt=${healed.expiresAt}`);
  const healAudit = await AdminEvent.findOne({
    user: user._id,
    title: 'Priority auto-resolved (intake complete)',
  }).lean();
  check('the auto-release is auditable, not silent', !!healAudit, healAudit ? healAudit.title : 'no admin event');

  // ── 8. The submit path agrees with the read paths ───────────────────────
  r = await api('/api/assessment', { method: 'POST', token: userToken, body: MILD_ASSESSMENT_BODY });
  check('a new assessment is accepted once the stale flag is released', r.status === 201, `status ${r.status}`);
  const third = r.data && r.data.assessment;

  // ── 9. The delete bypass ────────────────────────────────────────────────
  r = await api(`/api/assessment/${third._id}/priority`, { method: 'PATCH', token: adminToken, body: { priority: 'Priority' } });
  check('the third assessment can be flagged', r.status === 200, `status ${r.status}`);

  r = await api(`/api/assessment/${third._id}`, { method: 'DELETE', token: userToken });
  check('a user cannot delete an open review to escape the gate', r.status === 409 && r.data.code === 'priority-open', `status ${r.status} code=${r.data && r.data.code}`);
  check('the flagged record survives the refused delete', !!(await Assessment.findById(third._id).lean()));

  r = await api('/api/assessment/priority-status', { token: userToken });
  check('the user is still blocked after the refused delete', r.status === 200 && r.data.blocked === true, JSON.stringify(r.data));

  r = await api(`/api/assessment/${third._id}`, { method: 'DELETE', token: adminToken });
  check('an admin can delete it', r.status === 200, `status ${r.status}`);
  const orphanIntake = await IntakeRecord.countDocuments({ assessment: third._id });
  check('deleting cleans up the rows that pointed at it', orphanIntake === 0, `${orphanIntake} intake rows left`);

  // ── 10. A downgrade must not leave a premium lockout behind ─────────────
  await api(`/api/admin/users/${user._id}/subscription`, { method: 'PATCH', token: adminToken, body: { active: false, plan: 'free' } });
  r = await api('/api/assessment/priority-status', { token: userToken });
  check('a downgraded user is not paused', r.status === 200 && r.data.blocked === false, JSON.stringify(r.data));
  r = await api('/api/assessment', { method: 'POST', token: userToken, body: MILD_ASSESSMENT_BODY });
  check('a downgraded user can still submit an assessment', r.status === 201, `status ${r.status}`);
  check('and it is not auto-flagged (auto-flagging is PREMIUM+)', r.data.severityFlag && r.data.severityFlag.flagged === false, JSON.stringify(r.data.severityFlag));
  const kept = await Assessment.findById(r.data.assessment._id).lean();
  check('the record is kept for the admin view', kept.priority === 'Standard');

  // ── Cleanup ─────────────────────────────────────────────────────────────
  const created = await cleanup(user._id);
  const stillThere = await User.countDocuments({ _id: user._id });
  check('cleanup removed everything the run created', stillThere === 0 && created.length > 0, `${created.length} assessment ids reaped`);

  await mongoose.disconnect();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('FAILED:\n' + failed.map((f) => `  - ${f.name}`).join('\n'));
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  try {
    const leftover = await User.findOne({ email: TEST_EMAIL }).select('_id').lean();
    if (leftover) await cleanup(leftover._id);
    await mongoose.disconnect();
  } catch { /* best effort */ }
  process.exit(1);
});
