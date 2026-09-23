/**
 * End-to-end session behaviour checks against the RUNNING API
 * (http://127.0.0.1:5000) using throwaway accounts.
 *
 * Covers the session rules / acceptance tests:
 *   1. two different accounts stay active side by side
 *   2. the same account signing in again kills only ITS previous session
 *   3. three different accounts active simultaneously
 *   4. re-login invalidates the old session, other accounts unaffected
 *   5. "another browser" = just another token: replaced everywhere
 *   6. an old session hitting any protected/inline API gets 401 SESSION_REVOKED
 *      and the server-side record flips to revoked
 *   plus: logout scoping, no-expiry tokens, sid claims, no-token 401,
 *         legacy (sid-less) tokens rejected, and a concurrent-sign-in race
 *         where exactly one session may survive.
 *
 * Run (API must be up):  node test-session-flows.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const mongoose = require('mongoose');
const User = require('./models/User');
const Session = require('./models/Session');
const { issueUserSession } = require('./utils/sessions');

const BASE = `http://127.0.0.1:${process.env.PORT || 5000}/api`;

let failures = 0;
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
};

const headers = (token, json = true) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

const call = async (method, urlPath, { token, body } = {}) => {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
};

// 200 = session is live; 401 + code = definitively rejected.
const me = (token) => call('GET', '/auth/me', { token });

// TOTP codes are single-use (verifyTotpOnce): wait until the wall-clock code
// differs from every code already consumed in this run, then reserve it.
// First use never waits; a reuse inside the same 30 s step waits ≤30 s.
const usedTotpCodes = [];
const freshTotp = async (base32Secret) => {
  let code = speakeasy.totp({ secret: base32Secret, encoding: 'base32' });
  for (let guard = 0; guard < 90 && usedTotpCodes.includes(code); guard += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    code = speakeasy.totp({ secret: base32Secret, encoding: 'base32' });
  }
  usedTotpCodes.push(code);
  return code;
};

// Solve the server-issued math CAPTCHA ("12 − 5 = ?").
const solveCaptcha = async () => {
  const { data } = await call('GET', '/auth/captcha');
  const [left, right] = data.question.replace('= ?', '').trim().split(/\s*[+−×]\s*/);
  const op = data.question.includes('×') ? '*' : data.question.includes('−') ? '-' : '+';
  const answer = op === '*' ? Number(left) * Number(right)
    : op === '-' ? Number(left) - Number(right)
      : Number(left) + Number(right);
  return { id: data.id, answer: String(answer) };
};

async function registerAccount(stamp, tag) {
  const captcha = await solveCaptcha();
  const res = await call('POST', '/auth/register', {
    body: {
      firstName: tag.first,
      lastName: `${tag.last}${String(stamp).slice(-4)}`,
      email: tag.email,
      password: 'SessionTest123',
      dateOfBirth: '1995-05-05',
      gender: 'Male',
      captchaId: captcha.id,
      captchaAnswer: captcha.answer,
    },
  });
  if (res.status !== 201) throw new Error(`register ${tag.email} failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { id: res.data._id, token: res.data.token };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const stamp = Date.now();
  const emailA = `session-a-${stamp}@example.com`;
  const emailB = `session-b-${stamp}@example.com`;
  const emailC = `session-c-${stamp}@example.com`;
  const secret = speakeasy.generateSecret({ name: `SuppliWise Session Test (${emailA})` });
  const created = [];

  try {
    // ── Setup: three accounts, each signed in (register issues session 1) ─
    const A = await registerAccount(stamp, { first: 'Session', last: 'Alpha', email: emailA });
    const B = await registerAccount(stamp, { first: 'Session', last: 'Beta', email: emailB });
    const C = await registerAccount(stamp, { first: 'Session', last: 'Gamma', email: emailC });
    created.push(A.id, B.id, C.id);

    // ── Token shape: sid present, sub === id, NO exp (never times out) ────
    const regClaims = jwt.decode(A.token);
    check('register token embeds a session id (sid)', typeof regClaims?.sid === 'string' && regClaims.sid.length > 10,
      JSON.stringify({ sid: regClaims?.sid }));
    check('register token: sub matches id (no account confusion)', regClaims?.sub === regClaims?.id);
    check('register token has no exp claim (no session expiry)', regClaims?.exp === undefined);
    check('register token has no admin role', regClaims?.role === undefined);

    const A1 = A.token; // Account A, session 1
    const a1Live = await me(A1);
    check('Test 1 setup — Account A session is ACTIVE', a1Live.status === 200, `status ${a1Live.status}`);

    // ── Test 1 — two different accounts active simultaneously ─────────────
    const bLive = await me(B.token);
    check('Test 1 — Account B is ACTIVE alongside Account A',
      bLive.status === 200, `status ${bLive.status}`);

    // ── Test 3 — three different accounts at once ─────────────────────────
    const cLive = await me(C.token);
    const aStill1 = await me(A1);
    const bStill1 = await me(B.token);
    check('Test 3 — A, B and C all ACTIVE together',
      aStill1.status === 200 && bStill1.status === 200 && cLive.status === 200,
      `A=${aStill1.status} B=${bStill1.status} C=${cLive.status}`);

    // ── Test 2/5 — same account signs in again ("another browser") ───────
    await User.updateOne({ _id: A.id }, { twoFactorEnabled: true, twoFactorSecret: secret.base32 });

    // Single 2FA sign-in: the freshly generated code has never been used
    // (TOTP codes are single-use server-side, so no waiting is required).
    const loginA2 = await call('POST', '/auth/login-2fa', {
      body: { userId: A.id, otp: await freshTotp(secret.base32) },
    });
    check('Account A signs in again → new session issued',
      loginA2.status === 200 && !!loginA2.data?.token, `status ${loginA2.status} ${JSON.stringify(loginA2.data)}`);
    const A2 = loginA2.data?.token;

    const a2Live = await me(A2);
    check('Test 2 — the NEW session (A2) is ACTIVE', a2Live.status === 200, `status ${a2Live.status}`);
    const a1Dead = await me(A1);
    check('Test 2/6 — the OLD session (A1) is rejected',
      a1Dead.status === 401, `status ${a1Dead.status}`);
    check('Test 6 — rejection carries machine-readable SESSION_REVOKED',
      a1Dead.data?.code === 'SESSION_REVOKED', `code ${a1Dead.data?.code}`);

    const bAfterA = await me(B.token);
    const cAfterA = await me(C.token);
    check('Test 1/4 — Account B unaffected by Account A re-login',
      bAfterA.status === 200, `status ${bAfterA.status}`);
    check('Test 3/4 — Account C unaffected by Account A re-login',
      cAfterA.status === 200, `status ${cAfterA.status}`);

    // ── Test 6 — old session hitting every verification surface ───────────
    const inlineOld = await call('POST', '/auth/request-email-otp', { token: A1, body: {} });
    check('Old session rejected by inline route (request-email-otp)',
      inlineOld.status === 401 && inlineOld.data?.code === 'SESSION_REVOKED',
      `status ${inlineOld.status} code ${inlineOld.data?.code}`);
    const inlineProfileOld = await call('PUT', '/auth/profile', { token: A1, body: {} });
    check('Old session rejected by inline route (PUT profile)',
      inlineProfileOld.status === 401 && inlineProfileOld.data?.code === 'SESSION_REVOKED',
      `status ${inlineProfileOld.status} code ${inlineProfileOld.data?.code}`);
    const inlineVerifyOld = await call('POST', '/auth/verify-email-otp', { token: A1, body: {} });
    check('Old session rejected by inline route (verify-email-otp)',
      inlineVerifyOld.status === 401 && inlineVerifyOld.data?.code === 'SESSION_REVOKED',
      `status ${inlineVerifyOld.status} code ${inlineVerifyOld.data?.code}`);

    // Live session still passes the same surfaces.
    const inlineLive = await call('POST', '/auth/request-email-otp', { token: A2, body: {} });
    check('Live session accepted by inline route (reaches validation)',
      inlineLive.status === 400 && /email/i.test(inlineLive.data?.message || ''),
      `status ${inlineLive.status} ${JSON.stringify(inlineLive.data)}`);

    // ── Server-side state: pointer + revoked records ──────────────────────
    const aDoc = await User.findById(A.id).select('+currentSessionId +sessionVersion').lean();
    const a2Claims = jwt.decode(A2);
    check('DB: account points at the NEW session only',
      String(aDoc?.currentSessionId) === String(a2Claims?.sid),
      JSON.stringify({ pointer: String(aDoc?.currentSessionId), sid: a2Claims?.sid }));
    const a1Record = await Session.findOne({ user: A.id, _id: a1ClaimsSid(A1) }).lean();
    check('DB: displaced session A1 is marked REVOKED',
      !!a1Record && !!a1Record.revokedAt, JSON.stringify({ revokedAt: a1Record?.revokedAt }));

    // ── Logout scoping ────────────────────────────────────────────────────
    // A stale token cannot even reach logout (protect rejects it first) —
    // so an old session can never revoke the account's newest session.
    const staleLogout = await call('POST', '/auth/logout', { token: A1 });
    check('Stale session cannot log out (and cannot kill the new session)',
      staleLogout.status === 401, `status ${staleLogout.status}`);
    const a2AfterStale = await me(A2);
    check('Newest session survives a stale logout attempt',
      a2AfterStale.status === 200, `status ${a2AfterStale.status}`);

    const outA = await call('POST', '/auth/logout', { token: A2 });
    check('Logout of Account A succeeds', outA.status === 200, `status ${outA.status}`);
    const a2Dead = await me(A2);
    check('Account A session is dead after logout', a2Dead.status === 401, `status ${a2Dead.status}`);
    const bAfterLogout = await me(B.token);
    const cAfterLogout = await me(C.token);
    check("Logout of Account A leaves Account B's session alive",
      bAfterLogout.status === 200, `status ${bAfterLogout.status}`);
    check("Logout of Account A leaves Account C's session alive",
      cAfterLogout.status === 200, `status ${cAfterLogout.status}`);

    // ── Legacy / malformed tokens ─────────────────────────────────────────
    const legacy = jwt.sign({ id: A.id }, process.env.JWT_SECRET); // no sid
    const legacyRes = await me(legacy);
    check('Legacy token without sid is rejected (401)',
      legacyRes.status === 401, `status ${legacyRes.status}`);
    const forgedSid = jwt.sign({ id: A.id, sub: A.id, sid: '64b000000000000000000000' }, process.env.JWT_SECRET);
    const forgedRes = await me(forgedSid);
    check('Valid signature + unknown sid is rejected (401 SESSION_REVOKED)',
      forgedRes.status === 401 && forgedRes.data?.code === 'SESSION_REVOKED',
      `status ${forgedRes.status} code ${forgedRes.data?.code}`);
    const crossClaims = jwt.sign({ id: B.id, sub: B.id, sid: jwt.decode(A.token)?.sid }, process.env.JWT_SECRET);
    const crossRes = await me(crossClaims);
    check("Account B's token carrying Account A's sid is rejected (session/user mismatch)",
      crossRes.status === 401, `status ${crossRes.status}`);
    const noToken = await me(null);
    check('Missing token still returns 401 with NO_SESSION code',
      noToken.status === 401 && noToken.data?.code === 'NO_SESSION',
      `status ${noToken.status} code ${noToken.data?.code}`);

    // ── Race: three near-simultaneous sign-ins → exactly ONE survives ─────
    const raceTokens = await Promise.all([
      issueUserSession(A.id),
      issueUserSession(A.id),
      issueUserSession(A.id),
    ]);
    const raceResults = await Promise.all(raceTokens.map((t) => me(t)));
    const survivors = raceResults.filter((r) => r.status === 200).length;
    check('Concurrent sign-ins leave exactly ONE active session', survivors === 1,
      `survivors=${survivors} statuses=${raceResults.map((r) => r.status).join(',')}`);
    // Probing the losers stamps them revoked (fire-and-forget) — give it a beat.
    await new Promise((r) => setTimeout(r, 300));
    const winnerIdx = raceResults.findIndex((r) => r.status === 200);
    const winnerClaims = jwt.decode(raceTokens[winnerIdx === -1 ? 0 : winnerIdx]);
    const finalDoc = await User.findById(A.id).select('+currentSessionId').lean();
    check('Race winner matches the account pointer',
      String(finalDoc?.currentSessionId) === String(winnerClaims?.sid),
      JSON.stringify({ pointer: String(finalDoc?.currentSessionId), sid: winnerClaims?.sid }));
    const unrevoked = await Session.countDocuments({ user: A.id, revokedAt: null });
    check('After probing, only the winner session is unrevoked', unrevoked === 1,
      `unrevoked=${unrevoked}`);
    const bAfterRace = await me(B.token);
    check('Race on Account A never touches Account B',
      bAfterRace.status === 200, `status ${bAfterRace.status}`);

    // ── OPT-IN saved login ("Save my login on this browser") ─────────────
    // Fresh sign-in WITH remember → a remember credential comes back.
    const remLogin = await call('POST', '/auth/login-2fa', {
      body: { userId: A.id, otp: await freshTotp(secret.base32), remember: true },
    });
    check('Sign-in with remember returns a remember credential',
      remLogin.status === 200 && typeof remLogin.data?.rememberToken === 'string'
        && remLogin.data.rememberToken.length >= 20,
      `status ${remLogin.status} len ${remLogin.data?.rememberToken?.length}`);
    const remTokenA = remLogin.data?.rememberToken;
    const liveA = remLogin.data?.token;

    // The credential re-mints an access token for the SAME session — no
    // password, no new session (the account pointer must not move).
    const pointerBefore = String(
      (await User.findById(A.id).select('+currentSessionId').lean())?.currentSessionId);
    const minted = await call('POST', '/auth/remember', { body: { token: remTokenA } });
    check('Saved login re-mints a working access token (no password)',
      minted.status === 200 && !!minted.data?.token,
      `status ${minted.status} ${JSON.stringify(minted.data)}`);
    const mintedMe = await me(minted.data?.token);
    check('Minted token is live on protected routes', mintedMe.status === 200,
      `status ${mintedMe.status}`);
    const pointerAfter = String(
      (await User.findById(A.id).select('+currentSessionId').lean())?.currentSessionId);
    check('Minting creates NO new session (pointer unchanged — same session)',
      pointerBefore === pointerAfter, JSON.stringify({ pointerBefore, pointerAfter }));
    check('Minted access token carries the SAME sid as the sign-in',
      jwt.decode(minted.data?.token)?.sid === jwt.decode(liveA)?.sid,
      JSON.stringify({
        mintedSid: jwt.decode(minted.data?.token)?.sid,
        liveSid: jwt.decode(liveA)?.sid,
      }));
    check('Minted profile arrives for passwordless re-entry',
      minted.data?.user?.email === `session-a-${stamp}@example.com`,
      `email ${minted.data?.user?.email}`);

    // Sign-out kills the saved login server-side too.
    const outRem = await call('POST', '/auth/logout', { token: liveA });
    check('Logout of the remembered session succeeds', outRem.status === 200,
      `status ${outRem.status}`);
    const mintAfterOut = await call('POST', '/auth/remember', { body: { token: remTokenA } });
    check('Saved login is DEAD after sign-out',
      mintAfterOut.status === 401, `status ${mintAfterOut.status} ${JSON.stringify(mintAfterOut.data)}`);

    // A newer sign-in (Rule: newest wins) also invalidates an old saved login.
    const remLogin2 = await call('POST', '/auth/login-2fa', {
      body: { userId: A.id, otp: await freshTotp(secret.base32), remember: true },
    });
    check('Re-sign-in with remember issues a NEW credential',
      remLogin2.status === 200 && !!remLogin2.data?.rememberToken,
      `status ${remLogin2.status} ${JSON.stringify(remLogin2.data)}`);
    const remTokenA2 = remLogin2.data?.rememberToken;
    // "Another browser" signs in for the same account (direct session issue,
    // same atomic displacement as a real login) — no OTP needed here.
    await issueUserSession(A.id);
    const mintOld = await call('POST', '/auth/remember', { body: { token: remTokenA2 } });
    check('Saved login dies when a NEWER sign-in replaces the session',
      mintOld.status === 401, `status ${mintOld.status} ${JSON.stringify(mintOld.data)}`);
    const mintGarbage = await call('POST', '/auth/remember', { body: { token: 'not-a-real-remember-token' } });
    check('Unknown saved login is rejected (401)',
      mintGarbage.status === 401, `status ${mintGarbage.status}`);

    // Cleanup account B and C sessions.
    await call('POST', '/auth/logout', { token: B.token });
    await call('POST', '/auth/logout', { token: C.token });
  } finally {
    for (const id of created) {
      await Session.deleteMany({ user: id });
      await User.deleteOne({ _id: id });
    }
    await mongoose.disconnect();
  }

  console.log(failures === 0 ? '\nAll session checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

// Extract the sid claim from a token (used to locate a Session record).
function a1ClaimsSid(token) {
  return jwt.decode(token)?.sid;
}

main().catch(async (err) => {
  console.error('session test crashed:', err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
