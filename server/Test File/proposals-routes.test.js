/**
 * The AI condition-proposal ratification queue, without a live server.
 *
 * Run: node --test "Test File/proposals-routes.test.js"
 *
 * WHY THIS FILE EXISTS
 * The "tested by health professionals" claim only holds if the AI's
 * suggestions CANNOT ship on their own. These tests pin the construction:
 *   - the queue is admin-read and admin-decide only (member token = 403);
 *   - a verdict REQUIRES a written comment and one of approve|reject —
 *     there is no silent/empty ratification path;
 *   - verdicts append to an audit trail and flip the status;
 *   - the analysis upsert never overwrites a decided proposal, so a re-run
 *     cannot undo a professional's ratification;
 *   - liveNow reflects the real registry, not a stored guess.
 *
 * Middleware is stubbed BEFORE require (routes/proposals.js destructures
 * protect/adminOnly at load time), per the survey-routes.test.js pattern.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');

const authMiddleware = require('../middleware/auth');
const ConditionProposal = require('../models/ConditionProposal');
const { MEDICAL_CONDITIONS } = require('../utils/healthAssessmentInstrument');

const ID = '507f1f77bcf86cd7994390aa';

function pendingDoc(over = {}) {
  return {
    _id: ID,
    name: 'Fibromyalgia',
    normalizedName: 'fibromyalgia',
    group: 'Musculoskeletal',
    rationale: 'Muscle Weakness reported by users selecting no condition.',
    covers: ['Muscle Weakness'],
    supportingCount: 1,
    safetyImpact: 'Scopes pain support.',
    status: 'pending',
    alreadyLive: false,
    verdicts: [],
    ...over,
  };
}

async function withProposalRoutes(store, fn) {
  const originals = {
    protect: authMiddleware.protect,
    adminOnly: authMiddleware.adminOnly,
    find: ConditionProposal.find,
    findByIdAndUpdate: ConditionProposal.findByIdAndUpdate,
  };

  authMiddleware.protect = (req, _res, next) => {
    req.user = {
      _id: '507f1f77bcf86cd799439011',
      role: req.get('x-test-role') === 'admin' ? 'admin' : 'user',
      alias: req.get('x-test-role') === 'admin' ? 'Dr Test' : undefined,
    };
    next();
  };
  authMiddleware.adminOnly = (req, res, next) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required.' });
    next();
  };
  ConditionProposal.find = (filter) => {
    const rows = store.filter((r) => !filter?.status || r.status === filter.status);
    const q = {
      sort: () => q,
      lean: async () => rows.map((r) => ({ ...r })),
      then: (ok, err) => Promise.resolve(rows).then(ok, err),
    };
    return q;
  };
  ConditionProposal.findByIdAndUpdate = async (id, update) => {
    const row = store.find((r) => String(r._id) === String(id));
    if (!row) return null;
    if (update.$set?.status) row.status = update.$set.status;
    if (update.$push?.verdicts) row.verdicts = [...(row.verdicts || []), update.$push.verdicts];
    return { ...row };
  };

  const router = require('../routes/proposals');
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', router);

  const server = app.listen(0);
  const { port } = server.address();
  const call = async (pathname, { method = 'GET', body, role } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/proposals${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    return await fn(call);
  } finally {
    await new Promise((ok) => server.close(ok));
    Object.assign(authMiddleware, originals);
    ConditionProposal.find = originals.find;
    ConditionProposal.findByIdAndUpdate = originals.findByIdAndUpdate;
  }
}

test('GET / is admin-only', async () => {
  const r = await withProposalRoutes([pendingDoc()], (call) => call('/'));
  assert.equal(r.status, 403);
});

test('GET / lists proposals pending-first with counts and liveNow', async () => {
  const store = [
    pendingDoc({
      _id: '507f1f77bcf86cd7994390bb',
      name: 'Gout',
      normalizedName: 'gout',
      status: 'approved',
      supportingCount: 4,
    }),
    pendingDoc(),
  ];
  const r = await withProposalRoutes(store, (call) => call('/', { role: 'admin' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.counts, { pending: 1, approved: 1, rejected: 0 });
  assert.equal(r.body.proposals[0]._id, ID, 'pending sorts before approved');
  const gout = r.body.proposals.find((p) => p.normalizedName === 'gout');
  assert.equal(gout.liveNow, MEDICAL_CONDITIONS.includes('Gout'));
  assert.equal(gout.liveNow, true);
});

test('a member token cannot record a decision', async () => {
  const r = await withProposalRoutes([pendingDoc()], (call) =>
    call(`/${ID}/decision`, { method: 'POST', body: { decision: 'approve', comment: 'ok' } }));
  assert.equal(r.status, 403);
});

test('decision must be approve|reject and carries no silent path', async () => {
  const r = await withProposalRoutes([pendingDoc()], (call) =>
    call(`/${ID}/decision`, { method: 'POST', role: 'admin', body: { decision: 'ship it', comment: 'x' } }));
  assert.equal(r.status, 400);
});

test('an empty comment is refused — every verdict needs a written rationale', async () => {
  for (const comment of [undefined, '', '   ']) {
    const r = await withProposalRoutes([pendingDoc()], (call) =>
      call(`/${ID}/decision`, { method: 'POST', role: 'admin', body: { decision: 'reject', comment } }));
    assert.equal(r.status, 400, `comment ${JSON.stringify(comment)} must be refused`);
  }
});

test('malformed object id is refused before touching the database', async () => {
  const r = await withProposalRoutes([pendingDoc()], (call) =>
    call('/not-an-id/decision', { method: 'POST', role: 'admin', body: { decision: 'approve', comment: 'x' } }));
  assert.equal(r.status, 400);
});

test('approve appends an audit verdict and flips status', async () => {
  const store = [pendingDoc()];
  const r = await withProposalRoutes(store, (call) =>
    call(`/${ID}/decision`, {
      method: 'POST',
      role: 'admin',
      body: { decision: 'approve', comment: 'Covers a real gap; add with myalgia symptom scoping.', discipline: 'clinician' },
    }));
  assert.equal(r.status, 200);
  assert.equal(r.body.proposal.status, 'approved');
  assert.equal(r.body.proposal.verdicts.length, 1);
  const v = r.body.proposal.verdicts[0];
  assert.equal(v.decision, 'approve');
  assert.equal(v.reviewerAlias, 'Dr Test');
  assert.equal(v.discipline, 'clinician');
  assert.ok(v.at);
});

test('unknown-but-valid id is a 404, not a 500', async () => {
  const r = await withProposalRoutes([], (call) =>
    call('/507f1f77bcf86cd7994390ff/decision', { method: 'POST', role: 'admin', body: { decision: 'reject', comment: 'no' } }));
  assert.equal(r.status, 404);
});

test('normalizeConditionName folds case, whitespace and punctuation drift', () => {
  assert.equal(ConditionProposal.normalizeConditionName('  GERD / Acid   Reflux (SUAN) '), 'gerd / acid reflux (suan)');
});

test('upsertFromRanking: creates pending rows, never reopens decided ones, refreshes pending evidence', async () => {
  const originals = {
    findOne: ConditionProposal.findOne,
    create: ConditionProposal.create,
    updateOne: ConditionProposal.updateOne,
  };
  const store = [
    // Already ratified by the panel — a re-run must not touch it.
    { _id: 'x1', normalizedName: 'gout', status: 'approved', rationale: 'old', supportingCount: 3 },
  ];
  try {
    ConditionProposal.findOne = async (filter) =>
      store.find((r) => r.normalizedName === filter.normalizedName) || null;
    // Mirrors the schema default the real create() would apply.
    ConditionProposal.create = async (doc) => { store.push({ status: 'pending', ...doc }); return doc; };
    ConditionProposal.updateOne = async (filter, update) => {
      const row = store.find((r) => String(r._id) === String(filter._id));
      // Mirror dotted-path $set semantics the real driver applies.
      for (const [key, value] of Object.entries(update.$set || {})) {
        if (key.includes('.')) {
          const [parent, child] = key.split('.');
          row[parent] = { ...(row[parent] || {}), [child]: value };
        } else row[key] = value;
      }
      return { modifiedCount: 1 };
    };

    const ranked = {
      candidates: [
        { name: 'Fibromyalgia', group: 'Musculoskeletal', rationale: 'r1', covers: ['Muscle Weakness'], supportingCount: 1, safetyImpact: 's1' },
        { name: 'Gout ', group: 'Bone & Joint', rationale: 'decided already', supportingCount: 9, safetyImpact: 'x' },
        { name: '', supportingCount: 2 },
        { name: 'Sleep Apnea', supportingCount: 1 },
      ],
    };
    const stats = await ConditionProposal.upsertFromRanking(ranked, { runAt: new Date('2026-10-18'), assessmentsScanned: 7 });
    assert.deepEqual({ ...stats }, { created: 2, refreshed: 0, skipped: 2 });

    const fibro = store.find((r) => r.normalizedName === 'fibromyalgia');
    assert.equal(fibro.status, 'pending');
    assert.equal(fibro.alreadyLive, false);
    assert.equal(fibro.source.assessmentsScanned, 7);
    assert.equal(store.find((r) => r.normalizedName === 'gout').supportingCount, 3, 'decided evidence untouched');

    // A second run refreshes the still-pending row's evidence.
    Object.assign(fibro, { _id: 'x2' });
    const stats2 = await ConditionProposal.upsertFromRanking(
      { candidates: [ranked.candidates[0], ranked.candidates[1]] },
      { assessmentsScanned: 40 }
    );
    assert.equal(stats2.refreshed, 1);
    assert.equal(stats2.skipped, 1);
    assert.equal(fibro.supportingCount, 1);
    assert.equal(fibro.source.assessmentsScanned, 40);
    assert.equal(store.filter((r) => r.normalizedName === 'fibromyalgia').length, 1, 'no duplicate row on re-run');
  } finally {
    ConditionProposal.findOne = originals.findOne;
    ConditionProposal.create = originals.create;
    ConditionProposal.updateOne = originals.updateOne;
  }
});

test('routes/proposals.js enforces protect+adminOnly on both routes', () => {
  const src = require('fs').readFileSync(require.resolve('../routes/proposals.js'), 'utf8');
  assert.match(src, /require\('\.\.\/middleware\/auth'\)/);
  assert.match(src, /router\.get\('\/', protect, adminOnly/);
  assert.match(src, /router\.post\('\/:id\/decision', protect, adminOnly/);
});
