/**
 * POST /api/medical-review/confirm — self-clear regression (bug-hunt find).
 *
 * The confirm step exists so a user acknowledges an ADMIN'S approval. It used
 * to resolve every open Priority assessment regardless of medicalReviewStatus,
 * so a flagged member could POST it directly and lift the severe-case block
 * with no admin ever acting. It must now 403 unless status is 'approved'.
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

test('confirm refuses to lift the block while no admin approval exists', async () => {
  for (const status of ['none', 'pending', 'needs_more_info']) {
    User.findById = async () => ({
      _id: 'u1', email: 'a@b.c', medicalReviewStatus: status,
      medicalReviewRequested: status === 'pending',
      save: async () => {},
    });
    let resolved = false;
    Assessment.find = () => ({ select: async () => { resolved = true; return []; } });
    const r = await callConfirm();
    assert.equal(r.status, 403, `${status} must not be self-clearable`);
    assert.match(r.payload.message, /administrator must approve/i);
    assert.equal(resolved, false, `${status}: must refuse BEFORE querying assessments`);
  }
});

test('confirm still works after a real admin approval', async () => {
  const user = {
    _id: 'u1', email: 'a@b.c', medicalReviewStatus: 'approved',
    medicalReviewRequested: true, medicalReviewResolvedBy: 'AdminX',
    save: async () => {},
  };
  User.findById = async () => user;
  Assessment.find = () => ({ select: async () => [{ _id: 'a1', createdAt: new Date('2026-01-01') }] });
  let updates = 0;
  Assessment.updateMany = async (q, u) => {
    updates++;
    assert.equal(q.user, 'u1');
    assert.equal(q.priority, 'Priority');
    assert.equal(u.$set.priority, 'Standard');
    return { matchedCount: 1, modifiedCount: 1 };
  };
  const r = await callConfirm();
  assert.equal(r.status, 200);
  assert.equal(updates, 1);
  assert.equal(user.medicalReviewStatus, 'none');
});

test('500 responses never echo internal error messages to the client', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '../routes/medicalReview.js'), 'utf8');
  assert.doesNotMatch(src, /error:\s*error\.message/, 'stack/error.message must not be sent in bodies');
});
