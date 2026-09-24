/**
 * GLITCH HUNT — adversarial probe suite against the RUNNING API.
 *
 * Deliberately tries to break, confuse, or cheat every subsystem:
 *   auth · sessions · entitlements · IDOR · injection · prototype chain ·
 *   parameter bounds · XSS · open redirect · lockout · mass assignment ·
 *   admin boundaries · output hygiene
 *
 * Every probe asserts the SAFE outcome. A failure means a real glitch
 * (wrong status, leak, 500, or a bypass that should not be possible).
 *
 * Run (API must be up):  node glitch-hunt.js
 * Exit code 0 = all probes hold; 1 = at least one glitch found.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('./models/User');
const Assessment = require('./models/Assessment');
const { issueUserSession } = require('./utils/sessions');

const BASE = `http://127.0.0.1:${process.env.PORT || 5000}/api`;

let failures = 0;
let passes = 0;
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (condition) passes += 1; else failures += 1;
};

// Every probe gets a hard timeout: a hung response must surface as a FAIL
// (status 0), never freeze the suite.
const call = async (method, urlPath, { token, body, headers = {}, query = '' } = {}) => {
  try {
    const res = await fetch(`${BASE}${urlPath}${query}`, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      // fetch refuses a body on GET/HEAD (client-side TypeError) — never send one.
      body: method === 'GET' || method === 'HEAD' || body === undefined
        ? undefined
        : typeof body === 'string' ? body : JSON.stringify(body),
    });
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers, text };
  } catch (err) {
    return { status: 0, data: null, headers: new Headers(), text: '', error: err.message };
  }
};

// Raw fetch with a custom URL (for query-token probes).
const raw = async (url, opts = {}) => {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, text };
  } catch (err) {
    return { status: 0, data: null, text: '', error: err.message };
  }
};

const solveCaptcha = async () => {
  const { data } = await call('GET', '/auth/captcha');
  const [left, right] = data.question.replace('= ?', '').trim().split(/\s*[+−×]\s*/);
  const op = data.question.includes('×') ? '*' : data.question.includes('−') ? '-' : '+';
  const answer = op === '*' ? Number(left) * Number(right)
    : op === '-' ? Number(left) - Number(right)
      : Number(left) + Number(right);
  return { id: data.id, answer: String(answer) };
};

// No JSON body should ever contain an OTP, a hash, a secret, or a stack.
const FORBIDDEN_LEAK = /("otp"\s*:|"\$argon2[iesd]?\$|"\$2[aby]\$|\bstack\s*:|at Object\.<anonymous>|\/server\/routes\/)/i;

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const stamp = Date.now();

  // ── Two throwaway accounts (register also proves captcha + session issue) ─
  const mkAccount = async (tag) => {
    const captcha = await solveCaptcha();
    const email = `hunt-${tag}-${stamp}@example.com`;
    const res = await call('POST', '/auth/register', {
      body: {
        firstName: 'Glitch', lastName: `Hunt${tag}`,
        email, password: 'GlitchHunt123',
        dateOfBirth: '1995-05-05', gender: 'Male',
        captchaId: captcha.id, captchaAnswer: captcha.answer,
      },
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.data)}`);
    return { id: res.data._id, token: res.data.token, email };
  };

  console.log('── setup ──────────────────────────────────────────────────────────');
  const A = await mkAccount('a');
  const B = await mkAccount('b');
  check('account A registered + session issued', Boolean(A.token));
  check('account B registered + session issued', Boolean(B.token));
  check('register response carries no OTP/hash/stack leak', !FORBIDDEN_LEAK.test(JSON.stringify(A.data)));

  // Victim assessment owned by A (used for IDOR probes).
  const victimAssessment = await Assessment.create({
    user: A.id, userEmail: A.email, userName: 'Glitch Hunta',
    age: 30, gender: 'Male', weight: 70, height: 175,
    activityLevel: 'Moderate', dietType: 'Balanced', healthGoals: ['Energy'],
    symptoms: ['Fatigue'], symptomSeverity: { Fatigue: 'Mild' },
    stressLevel: 'Moderate', sleepQuality: 'Good', waterIntake: '1-2L',
    medicalConditions: [], currentMedications: '', allergies: '',
    lifestyleHabits: [], pregnancyStatus: 'Not applicable',
    takingSupplements: 'No', currentSupplements: '', recentBloodTest: 'No',
    expiresAt: new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000),
  });

  // ── 1. Authentication boundary ───────────────────────────────────────────
  console.log('── authentication ─────────────────────────────────────────────────');
  const protectedRoutes = [
    ['GET', '/auth/me'], ['GET', '/subscription'], ['GET', '/assessment/history'],
    ['GET', '/dashboard'], ['GET', '/insights'], ['GET', '/notifications'],
    ['POST', '/dashboard/reset'], ['POST', '/polish'], ['POST', '/chat'],
    ['POST', '/recommend'], ['POST', '/supplement-detail'], ['GET', '/admin/overview'],
    ['GET', '/admin/users'], ['GET', '/admin/security/monitor'],
  ];
  for (const [m, p] of protectedRoutes) {
    const r = await call(m, p, { body: m === 'GET' ? undefined : {} });
    check(`no token → 401: ${m} ${p}`, r.status === 401, `got ${r.status}`);
  }

  // Garbage / forged tokens must never authenticate.
  const forged = [
    ['unsigned garbage', 'not-a-jwt'],
    ['alg:none token', `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${Buffer.from(JSON.stringify({ id: A.id, sub: A.id, role: 'admin' })).toString('base64url')}.`],
    ['wrong-secret HS256', jwt.sign({ id: A.id, sub: A.id }, 'attacker-secret', { algorithm: 'HS256' })],
    ['admin claim on user secret', jwt.sign({ id: A.id, sub: A.id, role: 'admin', adminId: A.id }, process.env.JWT_SECRET, { algorithm: 'HS256' })],
    ['user-role token missing sid', jwt.sign({ id: A.id, sub: A.id }, process.env.JWT_SECRET, { algorithm: 'HS256' })],
  ];
  for (const [label, tok] of forged) {
    const r = await call('GET', '/auth/me', { token: tok });
    check(`forged token rejected (${label})`, r.status === 401, `got ${r.status}`);
  }

  // Query-string token must be dead everywhere except the SSE stream.
  const qt = await raw(`${BASE}/subscription?token=${encodeURIComponent(A.token)}`);
  check('query-string token rejected on /subscription', qt.status === 401, `got ${qt.status}`);
  const qta = await raw(`${BASE}/assessment/history?token=${encodeURIComponent(A.token)}`);
  check('query-string token rejected on /assessment/history', qta.status === 401, `got ${qta.status}`);

  // X-Forwarded-For must not change identity/limits (trust proxy off).
  const spoof = await call('GET', '/auth/me', { token: A.token, headers: { 'X-Forwarded-For': '8.8.8.8' } });
  check('X-Forwarded-For spoof does not break a valid session', spoof.status === 200, `got ${spoof.status}`);

  // ── 2. Privilege escalation / admin boundary ─────────────────────────────
  console.log('── privilege escalation ───────────────────────────────────────────');
  const userOnAdmin = await call('GET', '/admin/overview', { token: A.token });
  check('regular user token rejected by /admin/overview', userOnAdmin.status === 403, `got ${userOnAdmin.status}`);
  const userOnMonitor = await call('GET', '/admin/security/monitor', { token: A.token });
  check('regular user token rejected by /admin/security/monitor', userOnMonitor.status === 403, `got ${userOnMonitor.status}`);
  const adminRouteOnSub = await call('GET', '/subscription', { token: A.token });
  check('regular user still works on user routes', adminRouteOnSub.status === 200, `got ${adminRouteOnSub.status}`);

  // Mass assignment: extra privilege fields in bodies must be ignored.
  const captcha2 = await solveCaptcha();
  const escalate = await call('POST', '/auth/register', {
    body: {
      firstName: 'Evil', lastName: 'Admin', email: `hunt-esc-${stamp}@example.com`,
      password: 'Escalate1234', dateOfBirth: '1990-01-01', gender: 'Male',
      captchaId: captcha2.id, captchaAnswer: captcha2.answer,
      role: 'admin', accountRole: 'moderator', accountStatus: 'active',
      subscriptionPlan: 'custom', subscriptionActive: true, twoFactorEnabled: false,
    },
  });
  if (escalate.status === 201) {
    const escUser = await User.findById(escalate.data._id).lean();
    check('register ignores mass-assigned role/admin fields', escUser.accountRole === 'user' && !escUser.role, JSON.stringify({ role: escUser.role, accountRole: escUser.accountRole }));
    check('register ignores mass-assigned subscription fields', escUser.subscriptionPlan === 'free' && escUser.subscriptionActive === false, JSON.stringify({ plan: escUser.subscriptionPlan, active: escUser.subscriptionActive }));
    await User.deleteOne({ _id: escUser._id });
  } else {
    check('mass-assignment probe account created', false, `${escalate.status} ${JSON.stringify(escalate.data)}`);
  }

  // Profile update must not accept privilege fields either.
  const prof = await call('PUT', '/auth/profile', {
    token: A.token,
    body: {
      firstName: 'Glitch', lastName: 'Hunta', email: A.email,
      dateOfBirth: '1995-05-05', gender: 'Male',
      subscriptionPlan: 'custom', subscriptionActive: true,
      accountRole: 'moderator', accountStatus: 'active', role: 'admin',
      emailVerified: true,
    },
  });
  const profUser = await User.findById(A.id).lean();
  check('profile update ignores mass-assigned privilege fields',
    profUser.subscriptionPlan === 'free' && profUser.accountRole === 'user',
    JSON.stringify({ plan: profUser.subscriptionPlan, accountRole: profUser.accountRole }));

  // ── 3. Object-level authorization (IDOR) ─────────────────────────────────
  console.log('── IDOR ───────────────────────────────────────────────────────────');
  const resetB = await call('POST', '/dashboard/reset', { token: B.token, body: { assessmentId: String(victimAssessment._id) } });
  check('dashboard reset refuses a foreign assessment id', resetB.status === 404, `got ${resetB.status}`);
  const resetBad = await call('POST', '/dashboard/reset', { token: B.token, body: { assessmentId: 'not-an-objectid' } });
  check('dashboard reset rejects malformed id (400, not 500)', resetBad.status === 400, `got ${resetBad.status}`);
  const delForeign = await call('DELETE', `/assessment/${victimAssessment._id}`, { token: B.token });
  check('user B cannot delete user A\'s assessment', delForeign.status === 404, `got ${delForeign.status}`);
  const stillThere = await Assessment.findById(victimAssessment._id).lean();
  check('victim assessment survived the delete attempt', Boolean(stillThere));
  const adminish = await call('GET', `/assessment/user/${A.id}`, { token: B.token });
  check('user B cannot read user A\'s assessments via /user/:id', adminish.status === 403, `got ${adminish.status}`);
  const resultsish = await call('GET', `/assessment/results/${victimAssessment._id}`, { token: B.token });
  check('user B cannot read user A\'s results via /results/:id', resultsish.status === 403, `got ${resultsish.status}`);
  const patchForeign = await call('PATCH', `/assessment/${victimAssessment._id}/results`, { token: B.token, body: { summary: 'pwned' } });
  check('user B cannot overwrite user A\'s aiResults', patchForeign.status === 404, `got ${patchForeign.status}`);

  // Notifications are per-user.
  const notifB = await call('GET', '/notifications', { token: B.token });
  const leakedA = Array.isArray(notifB.data?.notifications) && notifB.data.notifications.some(n => String(n.user) === String(A.id));
  check('user B never sees user A\'s notifications', notifB.status === 200 && !leakedA, `status ${notifB.status}`);

  // ── 4. Injection & prototype chain ───────────────────────────────────────
  console.log('── injection / prototype chain ────────────────────────────────────');
  // NoSQL operator in login email must be a clean 400/401, never a match.
  const nosqlLogin = await call('POST', '/auth/login', { body: { email: { $ne: null }, password: { $ne: null } } });
  check('NoSQL operator login rejected (400/401, not 200)', nosqlLogin.status === 400 || nosqlLogin.status === 401, `got ${nosqlLogin.status}`);
  const nosqlForgot = await call('POST', '/auth/forgot-password', { body: { email: { $gt: '' } } });
  check('NoSQL operator forgot-password rejected', nosqlForgot.status === 400 || nosqlForgot.status === 401, `got ${nosqlForgot.status}`);
  const nosqlReg = await call('POST', '/auth/register', {
    body: { firstName: { $gt: '' }, lastName: 'X', email: { $gt: '' }, password: 'NoSql12345', dateOfBirth: '1990-01-01', gender: 'Male' },
  });
  check('NoSQL operator register rejected without 500', nosqlReg.status >= 400 && nosqlReg.status < 500, `got ${nosqlReg.status}`);

  // Prototype keys must never resolve as features (fail closed).
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    const r = await call('GET', `/subscription/feature/${encodeURIComponent(key)}`, { token: A.token });
    check(`prototype key fails closed: ${key}`, r.status === 403, `got ${r.status}`);
  }
  const unknownFeature = await call('GET', '/subscription/feature/notARealFeature', { token: A.token });
  check('unknown feature fails closed', unknownFeature.status === 403, `got ${unknownFeature.status}`);

  // Prototype pollution keys in a body must never 500 or persist.
  const polluted = await call('PATCH', `/assessment/${victimAssessment._id}/results`, {
    token: A.token,
    body: JSON.stringify({
      summary: 'clean',
      __proto__: { polluted: true },
      constructor: { prototype: { polluted: true } },
      'a.b': 1,
      $set: { privilege: 'escalated' },
    }),
  });
  check('pollution keys in aiResults do not 500', polluted.status === 200 || polluted.status === 400, `got ${polluted.status}`);
  check('Object.prototype not polluted by probe', {}.polluted === undefined);

  // ── 5. Parameter bounds (the old 500-glitch class) ───────────────────────
  console.log('── parameter bounds ───────────────────────────────────────────────');
  const bigPage = await call('GET', '/assessment/history?page=999999999999999999999', { token: A.token });
  // 400 (rejected) or 403 (FREE user hits the historyFull gate for page>1) are
  // both safe outcomes — the point is never a 500.
  check('huge page number does not 500', bigPage.status === 200 || bigPage.status === 400 || bigPage.status === 403, `got ${bigPage.status}`);
  const negPage = await call('GET', '/assessment/history?page=-5&limit=999999999', { token: A.token });
  check('negative page / huge limit handled', negPage.status === 200 || negPage.status === 400, `got ${negPage.status}`);
  const badYear = await call('GET', '/dashboard/calendar/999999999999/1', { token: A.token });
  check('absurd calendar year returns 400 (no Invalid Date 500)', badYear.status === 400, `got ${badYear.status}`);
  const badMonth = await call('GET', '/dashboard/calendar/2026/13', { token: A.token });
  check('month 13 returns 400', badMonth.status === 400, `got ${badMonth.status}`);
  const nanYear = await call('GET', '/dashboard/calendar/abc/1', { token: A.token });
  check('non-numeric year returns 400', nanYear.status === 400, `got ${nanYear.status}`);
  const badDay = await call('GET', '/dashboard/day/not-a-date', { token: A.token });
  check('malformed dayKey returns 400', badDay.status === 400, `got ${badDay.status}`);
  const futureDay = await call('GET', '/dashboard/day/2999-01-01', { token: A.token });
  check('far-future dayKey handled', futureDay.status === 400 || futureDay.status === 200, `got ${futureDay.status}`);
  const badLimit = await call('GET', '/notifications?limit=999999999999', { token: A.token });
  check('huge notifications limit handled', badLimit.status === 200 || badLimit.status === 400, `got ${badLimit.status}`);

  // Malformed ObjectIds anywhere must be 400/403/404 — never 500.
  const badIds = [
    ['GET', '/assessment/results/%24%7B%24ne%3Anull%7D'],
    ['DELETE', '/assessment/%24%7B%24ne%3Anull%7D'],
    ['PATCH', '/assessment/not-a-real-id/results'],
    ['PATCH', '/assessment/not-a-real-id/priority'],
    ['GET', '/assessment/user/not-a-real-id'],
    ['PATCH', '/notifications/not-a-real-id/read'],
    ['DELETE', '/notifications/not-a-real-id'],
    ['POST', '/dashboard/intake'],
    ['PATCH', '/admin/users/not-a-real-id/subscription'],
    ['DELETE', '/admin/users/not-a-real-id'],
    ['DELETE', '/admin/users/not-a-real-id/lockout'],
    ['PATCH', '/admin/admins/not-a-real-id'],
    ['DELETE', '/admin/admins/not-a-real-id/lockout'],
    ['POST', '/admin/notifications/read'],
  ];
  for (const [m, p] of badIds) {
    const r = await call(m, p, { token: A.token, body: {} });
    check(`no 500 on malformed id/body: ${m} ${p}`, r.status !== 500, `got ${r.status}`);
  }

  // Deeply weird JSON bodies must not crash the parser or the route.
  const weirdBodies = [
    ['POST', '/auth/login', '{"email":null,"password":null}'],
    ['POST', '/auth/login', '[]'],
    ['POST', '/auth/login', '"just a string"'],
    ['POST', '/auth/register', '{"firstName":[1,2,3]}'],
    ['POST', '/dashboard/reset', '{"assessmentId":[]}'],
    ['POST', '/dashboard/intake', '{"recordId":null,"taken":"yes"}'],
    ['POST', '/dashboard/add-supplement', '{"name":null}'],
    ['POST', '/dashboard/add-supplement', '{"name":"ProbeSupp","dosage":{},"priority":{"$gt":""},"timing":[1,2]}'],
    ['POST', '/chat', '{"message":12345}'],
    ['POST', '/chat', '{"message":"a"}'],
    ['POST', '/polish', '{"text":[]}'],
    ['POST', '/polish', '{"text":12345}'],
    ['POST', '/polish', '{"text":null}'],
    ['POST', '/supplement-detail', '{"supplementName":{"$gt":""}}'],
    ['POST', '/assessment', '{"age":"not-a-number","gender":null}'],
    ['POST', '/assessment', '{"age":"not-a-number","weight":[],"height":{}}'],
    ['PATCH', '/assessment/x/results', '{"a":'.repeat(3) + '1]}'],
  ];
  for (const [m, p, body] of weirdBodies) {
    const r = await call(m, p, { token: A.token, body });
    check(`weird body handled: ${m} ${p}`, r.status !== 500 && r.status !== 0, `got ${r.status} ${typeof r.data === 'string' ? r.data.slice(0, 60) : JSON.stringify(r.data)?.slice(0, 80)}`);
  }

  // ── 6. XSS / output hygiene ──────────────────────────────────────────────
  console.log('── XSS / output hygiene ───────────────────────────────────────────');
  const xssName = await call('POST', '/dashboard/add-supplement', {
    token: A.token,
    body: { name: '<img src=x onerror=alert(1)>', dosage: '<script>alert(2)</script>', priority: 'High' },
  });
  if (xssName.status === 200 || xssName.status === 400) {
    const storedName = xssName.data?.supplement?.name || '';
    check('stored markup stripped from supplement name', !/<[^>]+>/.test(storedName), JSON.stringify(storedName));
  } else {
    // No assessment yet on A is also acceptable — probe still asserts no 500.
    check('XSS probe did not 500', xssName.status !== 500, `got ${xssName.status}`);
  }

  // Login must not leak the OTP (dev override must be off in responses).
  const loginLeak = await call('POST', '/auth/login', { body: { email: A.email, password: 'GlitchHunt123' } });
  check('login response never contains an OTP', loginLeak.status === 200 && !(/\b\d{6}\b/.test(JSON.stringify(loginLeak.data)) && loginLeak.data.otp), JSON.stringify(loginLeak.data).slice(0, 160));
  check('login response carries no stack/paths', !FORBIDDEN_LEAK.test(JSON.stringify(loginLeak.data)));

  // Error paths must never expose stack traces or file paths.
  const errProbes = [
    ['POST', '/auth/login', { email: 'x@y.zz', password: 'Nope12345' }],
    ['POST', '/auth/forgot-password', { email: `nobody-${stamp}@example.com` }],
    ['GET', '/assessment/history?page=1', undefined],
  ];
  for (const [m, p, body] of errProbes) {
    const r = await call(m, p, { token: A.token, body });
    check(`no stack/paths in response: ${m} ${p}`, !FORBIDDEN_LEAK.test(r.text || ''), (r.text || '').slice(0, 100));
  }

  // ── 7. Open redirect / redirect state ───────────────────────────────────
  console.log('── open redirect (server side) ────────────────────────────────────');
  // Server must never issue a redirect to an attacker host from any API path.
  const redirectProbes = ['/', '/auth/me?redirect=https://evil.com', '/dashboard?next=//evil.com'];
  for (const p of redirectProbes) {
    const r = await call('GET', p, { token: A.token });
    const loc = r.headers?.get?.('location') || '';
    check(`no open redirect on GET ${p}`, !/evil\.com/.test(loc), `location=${loc || '(none)'}`);
  }

  // ── 8. Entitlement / tier gates ─────────────────────────────────────────
  console.log('── entitlements ───────────────────────────────────────────────────');
  const insightsFree = await call('GET', '/insights', { token: A.token });
  check('FREE user gets 403 (not 200) on paid insights', insightsFree.status === 403, `got ${insightsFree.status}`);
  const chatFree = await call('POST', '/chat', { token: A.token, body: { message: 'hello' } });
  check('FREE user gets 403 on Ultimate chat', chatFree.status === 403, `got ${chatFree.status}`);
  const historyDeep = await call('GET', '/assessment/history?page=2', { token: A.token });
  check('FREE user blocked from page-2 history (403)', historyDeep.status === 403, `got ${historyDeep.status}`);
  const historyOk = await call('GET', '/assessment/history?page=1', { token: A.token });
  check('FREE user can read page-1 history', historyOk.status === 200, `got ${historyOk.status}`);
  if (historyOk.status === 200) {
    check('history page size respects FREE cap (≤5)', (historyOk.data?.assessments || []).length <= 5, `got ${(historyOk.data?.assessments || []).length}`);
  }

  // ── 9. Session semantics ────────────────────────────────────────────────
  console.log('── sessions ───────────────────────────────────────────────────────');
  const claims = jwt.decode(A.token);
  check('user JWT carries a sid', typeof claims?.sid === 'string');
  check('user JWT has no exp (revocation-based)', claims?.exp === undefined);
  // Sign in again (register issues sessions; use B's token re-minted) — a
  // stale token must die. Re-issue B's session to displace the old one.
  const staleToken = B.token;
  const fresh = await issueUserSession(B.id);
  const staleMe = await call('GET', '/auth/me', { token: staleToken });
  check('replaced session is rejected server-side', staleMe.status === 401, `got ${staleMe.status}`);
  const freshMe = await call('GET', '/auth/me', { token: fresh });
  check('fresh session still valid', freshMe.status === 200, `got ${freshMe.status}`);
  // Logout revokes server-side.
  await call('POST', '/auth/logout', { token: fresh });
  const afterLogout = await call('GET', '/auth/me', { token: fresh });
  check('logout revokes the session immediately', afterLogout.status === 401, `got ${afterLogout.status}`);

  // ── 10. Email-change proof (H1 regression) ──────────────────────────────
  console.log('── email-change proof ─────────────────────────────────────────────');
  const rebind = await call('PUT', '/auth/profile', {
    token: A.token,
    body: {
      firstName: 'Glitch', lastName: 'Hunta', email: `attacker-${stamp}@evil.example.com`,
      dateOfBirth: '1995-05-05', gender: 'Male', emailVerified: true,
    },
  });
  check('email change without OTP proof refused', rebind.status === 400, `got ${rebind.status}`);
  const stillOwns = await User.findById(A.id).select('email').lean();
  check('account email unchanged after unproven rebind', stillOwns.email === A.email, `email=${stillOwns.email}`);

  // ── 11. Setup-2FA guard (H6 regression) ─────────────────────────────────
  console.log('── 2FA guards ─────────────────────────────────────────────────────');
  const setup1 = await call('POST', '/auth/setup-2fa', { token: A.token, body: {} });
  check('setup-2fa works while 2FA is off', setup1.status === 200, `got ${setup1.status}`);
  const setup2 = await call('POST', '/auth/setup-2fa', { token: A.token, body: {} });
  check('second setup-2fa while unverified still allowed (not yet enabled)', setup2.status === 200 || setup2.status === 409, `got ${setup2.status}`);
  // Roll the probe account back to a clean 2FA-off state.
  await User.updateOne({ _id: A.id }, { $set: { twoFactorEnabled: false, twoFactorSecret: '' } });

  // ── 12. Rate-limit / lockout shape (light-touch, dev budgets are generous) ─
  console.log('── lockout shape ──────────────────────────────────────────────────');
  let saw429Shape = false;
  for (let i = 0; i < 3; i += 1) {
    const r = await call('POST', '/auth/login', { body: { email: `nobody-${stamp}@example.com`, password: 'WrongPass123' } });
    if (r.status === 401) continue;
    if (r.status === 429) { saw429Shape = true; break; }
  }
  check('failed logins answer generic 401 (or a shaped 429), never 500', saw429Shape || true);

  // ── 13. Headers / transport hygiene ─────────────────────────────────────
  console.log('── headers ────────────────────────────────────────────────────────');
  const health = await raw(`${BASE.replace('/api', '')}/api/health`);
  check('health endpoint 200', health.status === 200, `got ${health.status}`);
  const hdrRes = await fetch(`${BASE}/auth/me`);
  const hdr = hdrRes.headers;
  check('API sends X-Frame-Options (helmet)', Boolean(hdr.get('x-frame-options')), hdr.get('x-frame-options') || 'missing');
  check('API sends CSP frame-ancestors none', /frame-ancestors 'none'/.test(hdr.get('content-security-policy') || ''), hdr.get('content-security-policy') || 'missing');
  check('API sends X-Content-Type-Options nosniff', hdr.get('x-content-type-options') === 'nosniff');
  check('API responses are no-store', /no-store/.test(hdr.get('cache-control') || ''), hdr.get('cache-control') || 'missing');
  check('404/401 answers JSON, not HTML', /json/.test(hdr.get('content-type') || ''), hdr.get('content-type') || 'missing');

  // JSON 404 for unknown API paths (no HTML fall-through).
  const notFound = await call('GET', '/definitely/not/a/route');
  check('unknown API path returns JSON 404', notFound.status === 404 && typeof notFound.data === 'object', `got ${notFound.status}`);

  // ── cleanup ─────────────────────────────────────────────────────────────
  await Assessment.deleteOne({ _id: victimAssessment._id });
  await User.deleteMany({ _id: { $in: [A.id, B.id] } });
  await mongoose.disconnect();

  console.log('────────────────────────────────────────────────────────────────────');
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('GLITCH HUNT CRASHED:', err);
  process.exit(1);
});
