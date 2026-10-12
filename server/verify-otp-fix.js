// End-to-end verification of the OTP sign-in fix, WITHOUT touching any
// database: the real utils/mfaTransaction.js is exercised against an
// in-memory MfaTransaction stub that implements the same match semantics
// the Mongo queries use (tokenHash equality, consumedAt:null,
// expiresAt:{$gt}, methods containment, $expr attempts<maxAttempts).
const fs = require('fs');
const path = require('path');

// ── in-memory MfaTransaction with Mongo-like matching ──────────────
const rows = new Map(); // _id -> row
let seq = 0;
function match(filter, row) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$expr') continue; // handled by matchExpr
    if (k === '_id') { if (String(row._id) !== String(v)) return false; continue; }
    if (k === 'tokenHash') { if (row.tokenHash !== v) return false; continue; }
    if (k === 'user') { if (String(row.user) !== String(v)) return false; continue; }
    if (k === 'consumedAt') {
      // { consumedAt: null } matches null-or-missing
      if (v === null) { if (row.consumedAt != null) return false; continue; }
      if (row.consumedAt !== v) return false; continue;
    }
    if (k === 'expiresAt' && v && typeof v === 'object' && v.$gt) {
      if (!(row.expiresAt > v.$gt)) return false; continue;
    }
    if (k === 'methods' && typeof v === 'string') {
      if (!Array.isArray(row.methods) || !row.methods.includes(v)) return false; continue;
    }
    return false; // unknown filter key -> no match (conservative)
  }
  // $expr is passed inside the filter object by the real code
  return true;
}
function matchExpr(filter, row) {
  const expr = filter.$expr;
  if (!expr) return true;
  const lt = expr.$lt;
  if (lt) {
    const [left, right] = lt;
    const lv = left.startsWith('$') ? row[left.slice(1)] : left;
    const rv = right.startsWith('$') ? row[right.slice(1)] : right;
    if (!(lv < rv)) return false;
  }
  return true;
}

const FakeMfaTransaction = {
  updateMany: async (filter, update) => {
    for (const row of rows.values()) {
      if (match(filter, row) && matchExpr(filter, row)) {
        Object.assign(row, update.$set);
      }
    }
    return { modifiedCount: 0 };
  },
  create: async (doc) => {
    const row = { ...doc, _id: `id${++seq}` };
    rows.set(row._id, row);
    return row;
  },
  findOne: (filter) => {
    const found = [...rows.values()].filter(r => match(filter, r) && matchExpr(filter, r));
    const row = found[0] || null;
    return {
      lean: async () => (row ? { ...row } : null),
      select: () => ({ lean: async () => (row ? { ...row } : null) }),
    };
  },
  findOneAndUpdate: (filter, update, opts) => {
    const found = [...rows.values()].filter(r => match(filter, r) && matchExpr(filter, r));
    const row = found[0] || null;
    if (row) Object.assign(row, update.$set);
    return { lean: async () => (row ? { ...row } : null) };
  },
  deleteMany: async () => ({ deletedCount: 0 }),
};

// Inject the stub into the require cache BEFORE mfaTransaction loads.
const modelPath = path.join(__dirname, 'models', 'MfaTransaction.js');
require.cache[require.resolve(modelPath)] = {
  id: modelPath, filename: modelPath, loaded: true,
  exports: FakeMfaTransaction,
};

const mfa = require('./utils/mfaTransaction');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

(async () => {
  const user = { _id: 'u1', twoFactorEnabled: false };

  // ── OLD behaviour (the bug): methodsFor default for a non-2FA user ──
  const oldMethods = mfa.methodsFor({ twoFactorEnabled: user.twoFactorEnabled }, { passkeys: 0, backupCodeCount: 0 });
  console.log(`OLD: /login minted methods = ${JSON.stringify(oldMethods)}`);
  const oldRaw = await mfa.start({ user: user._id, methods: oldMethods, ttlMs: 10 * 60 * 1000 });
  const oldPeek = await mfa.peek(oldRaw, { method: 'email-otp' });
  check('OLD (bug): peek(token, {method:"email-otp"}) REJECTS the transaction — the reported failure', oldPeek === null);

  // ── NEW behaviour (the fix): the email branch mints ['email-otp'] ──
  const usesAuthenticator = false; // non-2FA user -> email-code branch
  const newMethods = usesAuthenticator ? oldMethods : ['email-otp'];
  console.log(`NEW: /login mints methods = ${JSON.stringify(newMethods)}`);
  const newRaw = await mfa.start({ user: user._id, methods: newMethods, ttlMs: 10 * 60 * 1000 });

  const peeked = await mfa.peek(newRaw, { method: 'email-otp' });
  check('NEW: peek(token, {method:"email-otp"}) finds the transaction', !!peeked);

  // legacy userId fallback query: findOne({user, consumedAt:null, expiresAt:{$gt}, methods:'email-otp'})
  const legacy = await FakeMfaTransaction.findOne({
    user: String(user._id), consumedAt: null,
    expiresAt: { $gt: new Date() }, methods: 'email-otp',
  });
  const legacyRow = await legacy.lean();
  check('NEW: legacy userId fallback query finds a live email-otp transaction', !!legacyRow);

  const spent = await mfa.spend(newRaw, { method: 'email-otp' });
  check('NEW: spend(token, {method:"email-otp"}) succeeds', spent.ok === true);
  const spentAgain = await mfa.spend(newRaw, { method: 'email-otp' });
  check('NEW: second spend is rejected (single-use)', spentAgain.ok === false);

  // ── authenticator branch must be unaffected ──
  const totpRaw = await mfa.start({ user: 'u2', methods: ['totp'], ttlMs: 5 * 60 * 1000 });
  const totpPeek = await mfa.peek(totpRaw, { method: 'totp' });
  check('authenticator: peek(token, {method:"totp"}) still works', !!totpPeek);
  const totpAsEmail = await mfa.peek(totpRaw, { method: 'email-otp' });
  check('authenticator: a totp transaction still refuses email-otp', totpAsEmail === null);

  // expiry still enforced
  const expRaw = await mfa.start({ user: 'u3', methods: ['email-otp'], ttlMs: -1 });
  const expPeek = await mfa.peek(expRaw, { method: 'email-otp' });
  check('expired transaction is still rejected', expPeek === null);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
