'use strict';

/**
 * Test harness for the password-reset flow.
 *
 * Lives in its own file because two test files need it and the setup is long
 * enough that duplicating it would guarantee they drift.
 *
 * The database and the mailer are stubbed, so these run with no MongoDB and no
 * SMTP. The model stub is NOT a mock that records calls — it reproduces the one
 * behaviour the flow's correctness actually rests on: `claimByTokenHash` is
 * CONDITIONAL, so two concurrent redemptions of the same link cannot both win.
 * A permissive fake would let that regression through silently.
 */

const express = require('express');

// Load .env FIRST. `node --test` gives every test file its own process, so a
// variable in server/.env is NOT inherited the way it is when index.js boots —
// and this flow signs a JWT in the verify step, which threw
// "secretOrPrivateKey must have a value" and surfaced as a 500 from the route
// under test. server/index.js loads the env itself, so this is a harness-only
// responsibility.
require('dotenv').config();

const User = require('../models/User');
const PasswordResetToken = require('../models/PasswordResetToken');
const SecurityEvent = require('../models/SecurityEvent');
const UserNotification = require('../models/UserNotification');
const emailUtils = require('../utils/email');
const sessionUtils = require('../utils/sessions');
const { stubQuery } = require('./stubQuery');

const USER_ID = '507f1f77bcf86cd799439011';
const EMAIL = 'demo@example.com';
// Compliant with the current policy, so the "you cannot reuse your current
// password" check is reachable — it only runs after the new password has passed
// validation, and a legacy-weak fixture would be refused for its length first.
const CURRENT_PASSWORD = 'Cedar$Otter48!';

const TTL_MS = 30 * 60 * 1000;

function stubUser(overrides = {}) {
  return {
    _id: USER_ID,
    email: EMAIL,
    accountStatus: 'active',
    save: async function save() { this.lastSavedPassword = this.password; },
    matchPassword: async (value) => value === CURRENT_PASSWORD,
    ...overrides,
  };
}

/**
 * An in-memory stand-in for the PasswordResetToken collection.
 *
 * `hash` is a fake digest so a test can assert the stored value is not the raw
 * secret without needing real SHA-256.
 */
function tokenStore() {
  const rows = [];
  let seq = 0;
  const hash = (value) => `h:${value}`;
  const active = () => rows.filter((r) => !r.usedAt && r.expiresAt.getTime() > Date.now());
  const mine = (userId) => active().filter((r) => String(r.user) === String(userId));

  return {
    rows,
    hash,
    async countActiveForUser(userId) { return mine(userId).length; },
    async dropOldestActiveForUser(userId) {
      const oldest = mine(userId).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) rows.splice(rows.indexOf(oldest), 1);
    },
    async store({ userId, token, code, ttlMs }) {
      seq += 1;
      const row = {
        _id: `t${seq}`,
        user: userId,
        tokenHash: hash(token),
        codeHash: hash(code),
        codeAttempts: 0,
        expiresAt: new Date(Date.now() + (ttlMs || TTL_MS)),
        usedAt: null,
        createdAt: new Date(seq),
      };
      rows.push(row);
      return row;
    },
    async findActiveByTokenHash(raw) {
      return active().find((r) => r.tokenHash === hash(raw)) || null;
    },
    // Conditional, exactly like the real `findOneAndUpdate` on `usedAt: null`:
    // whoever gets here first takes it, everyone else matches nothing.
    async claimByTokenHash(raw) {
      const row = active().find((r) => r.tokenHash === hash(raw));
      if (!row) return null;
      row.usedAt = new Date();
      return row;
    },
    async findLatestActiveForUser(userId) {
      return mine(userId).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    },
    async invalidateAllForUser(userId) {
      mine(userId).forEach((r) => { r.usedAt = new Date(); });
    },
    async checkCode(userId, code, maxAttempts) {
      const row = mine(userId).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!row) return { ok: false, outcome: 'no_request' };
      if (row.expiresAt.getTime() <= Date.now()) return { ok: false, outcome: 'expired' };
      if (row.codeAttempts >= maxAttempts) {
        row.usedAt = new Date();
        return { ok: false, outcome: 'locked' };
      }
      if (row.codeHash !== hash(code)) {
        row.codeAttempts += 1;
        return { ok: false, outcome: 'mismatch' };
      }
      return { ok: true, record: row };
    },
  };
}

/**
 * Build the routers and run `fn(ctx)` against them.
 *
 * @param {{deliver?: Function, findUser?: Function, route?: string}} options
 *   `deliver` decides whether mail goes out; every payload is recorded in
 *   `sent`. `findUser` overrides the account (pass `() => null` for an address
 *   with no account). `route` selects the new link router (default) or the
 *   legacy aliases on routes/auth.js.
 */
async function withResetRouter({ deliver, findUser, route = 'link' } = {}, fn) {
  const originals = {
    findOne: User.findOne,
    findById: User.findById,
    sendPasswordResetEmail: emailUtils.sendPasswordResetEmail,
    sendPasswordChangedEmail: emailUtils.sendPasswordChangedEmail,
    revokeAllUserSessions: sessionUtils.revokeAllUserSessions,
    securityWrite: SecurityEvent.write,
    notificationCreate: UserNotification.create,
    nodeEnv: process.env.NODE_ENV,
    webUrl: process.env.PUBLIC_WEB_URL,
    staticKeys: Object.fromEntries(
      Object.keys(tokenStore()).map((key) => [key, PasswordResetToken[key]])
    ),
  };

  const sent = [];
  const store = tokenStore();
  const sessionUsers = new Set([USER_ID]);
  let revokedCount = 0;

  process.env.NODE_ENV = 'test';
  process.env.PUBLIC_WEB_URL = 'http://localhost:5173';

  // A Mongoose query is thenable AND chainable, so both `await User.findById()`
  // and `User.findOne().select().lean()` must work. A bare object breaks the
  // second, which is how fourteen assertions in three files went red.
  const lookup = () => (findUser ? findUser() : stubUser());
  User.findOne = () => stubQuery(lookup);
  User.findById = () => stubQuery(lookup);

  emailUtils.sendPasswordResetEmail = async (to, payload) => {
    sent.push({ to, ...payload });
    return deliver ? deliver(to, payload) : true;
  };
  emailUtils.sendPasswordChangedEmail = async () => true;
  sessionUtils.revokeAllUserSessions = async (userId) => {
    sessionUsers.delete(String(userId));
    revokedCount += 1;
    return 2;
  };
  // Both are best-effort in the service. Stubbed only so an unstubbed write
  // against a database that is not there does not block on driver
  // server-selection and add ~10s to every completed reset.
  SecurityEvent.write = async () => ({ _id: 'evt' });
  UserNotification.create = async () => ({ _id: 'note' });

  for (const [key, value] of Object.entries(store)) PasswordResetToken[key] = value;

  // Mounted at the SAME prefix index.js uses, so the paths a test writes are the
  // real deployed paths. Getting this wrong produced a 404 HTML body that the
  // assertions read as a wrong answer.
  const mod = route === 'legacy' ? '../routes/auth' : '../routes/passwordReset';
  const prefix = route === 'legacy' ? '/api/auth' : '/api/auth/password-reset';
  delete require.cache[require.resolve(mod)];
  delete require.cache[require.resolve('../utils/passwordReset')];
  const router = require(mod);
  const app = express();
  app.use(express.json());
  app.use(prefix, router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Hit an endpoint. `body === undefined` sends a GET. */
  const call = async (path, body) => {
    const res = await fetch(`${base}${prefix}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };

  const ctx = {
    call,
    /** Ask for a link. Both flows send one; only the path differs. */
    request: () => (route === 'legacy'
      ? call('/forgot-password', { email: EMAIL })
      : call('/request', { email: EMAIL })),
    /** Read the link out of the last email, as the user would. */
    linkFromLastMail: () => new URL(sent[sent.length - 1].resetUrl).searchParams.get('token'),
    sent,
    store,
    sessionUsers,
    revoked: () => revokedCount,
    TTL_MS,
  };

  try {
    return await fn(ctx);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    User.findOne = originals.findOne;
    User.findById = originals.findById;
    emailUtils.sendPasswordResetEmail = originals.sendPasswordResetEmail;
    emailUtils.sendPasswordChangedEmail = originals.sendPasswordChangedEmail;
    sessionUtils.revokeAllUserSessions = originals.revokeAllUserSessions;
    SecurityEvent.write = originals.securityWrite;
    UserNotification.create = originals.notificationCreate;
    for (const [key, value] of Object.entries(originals.staticKeys)) PasswordResetToken[key] = value;
    process.env.NODE_ENV = originals.nodeEnv;
    if (originals.webUrl === undefined) delete process.env.PUBLIC_WEB_URL;
    else process.env.PUBLIC_WEB_URL = originals.webUrl;
    delete require.cache[require.resolve(mod)];
    delete require.cache[require.resolve('../utils/passwordReset')];
  }
}

module.exports = {
  withResetRouter,
  stubUser,
  tokenStore,
  USER_ID,
  EMAIL,
  CURRENT_PASSWORD,
  TTL_MS,
};
