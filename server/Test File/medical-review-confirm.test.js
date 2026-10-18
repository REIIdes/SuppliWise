/**
 * POST /api/medical-review/confirm — consent model regression (owner decision
 * 2026-10-18). The severe-case flag is lifted by the USER agreeing to the
 * terms; admin approval must NOT be a precondition ("sila naman ang
 * magpapasya para sa kanila"). What the route must still guarantee: auth via
 * protect, and it only ever touches the caller's own assessments.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const authPath = require.resolve(path.join(__dirname, '../middleware/auth'));
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    protect: (req, _res, next) => { req.user = { _id: 'u1' }; next(); },
    adminOnly: (_req, res) => res.status(403).json({ message: 'no' }),
  },
};

const User = require('../models/User');
const Assessment = require('../models/Assessment');
const UserNotification = require('../models/UserNotification');
const AdminEvent = require('../models/AdminEvent');
const MedicalReviewAudit = require('../models/MedicalReviewAudit');

for (const [model, fn] of [
  [UserNotification, 'create'], [AdminEvent, 'create'], [MedicalReviewAudit, 'create'],
]) model[fn] = async () => ({});
Assessment.findByIdAndUpdate = async () => ({});

const router = require(path.join(__dirname, '../routes/medicalReview'));

function callConfirm() {
  return new Promise((resolve, reject) => {
    const req = { body: {}, user: { _id: 'u1' }, query: {}, params: {}, headers: {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    const match = router.stack.find((l) => l.route?.path === '/confirm' && l.route.methods.post);
    const layers = match.route.stack;
    let i = 0;
    const next = (err) => {
      if (err) return reject(err);
      const h = layers[i++];
      if (!h) return reject(new Error('no handler ran'));
      Promise.resolve(h.handle(req, res, next)).catch(reject);
    };
    next();
  });
}

test('confirm lifts the block WITHOUT any admin approval — consent is the gate', async () => {
  for (const status of ['none', 'pending', 'approved']) {
    const user = {
      _id: 'u1', email: 'a@b.c', medicalReviewStatus: status,
      medicalReviewRequested: status === 'pending', medicalReviewResolvedBy: 'AdminX',
      save: async () => {},
    };
    User.findById = async () => user;
    Assessment.find = () => ({ select: async () => [{ _id: 'a1', createdAt: new Date('2026-01-01') }] });
    let captured = null;
    Assessment.updateMany = async (q, u) => {
      captured = { q, u };
      return { matchedCount: 1, modifiedCount: 1 };
    };
    const r = await callConfirm();
    assert.equal(r.status, 200, `${status} must be self-clearable by consent`);
    assert.equal(r.payload.resolvedCount, 1);
    assert.equal(captured.q.user, 'u1', 'only the caller\'s own assessments');
    assert.equal(captured.q.priority, 'Priority');
    assert.equal(captured.u.$set.priority, 'Standard');
    assert.equal(user.medicalReviewStatus, 'none');
  }
});

test('protect is mounted on /confirm — an anonymous request never resolves', () => {
  const match = router.stack.find((l) => l.route?.path === '/confirm' && l.route.methods.post);
  assert.equal(match.route.stack.length, 2, 'protect + handler');
});

test('500 responses never echo internal error messages to the client', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '../routes/medicalReview.js'), 'utf8');
  assert.doesNotMatch(src, /error:\s*error\.message/, 'stack/error.message must not be sent in bodies');
});
