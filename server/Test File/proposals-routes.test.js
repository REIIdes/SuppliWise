/**
 * The AI learning log, without a live server.
 *
 * Run: node --test "Test File/proposals-routes.test.js"
 *
 * WHY THIS FILE EXISTS
 * The admin approve/reject gate was deliberately removed: the gap analysis
 * now decides AUTONOMOUSLY through the clinical evidence gate, and this
 * endpoint only SHOWS that reasoning. These tests pin the new construction:
 *   - the log is admin-read only (member token = 403);
 *   - there is NO human decision route anymore — POSTing a verdict is a 404,
 *     and the source itself contains no router.post;
 *   - every proposal row carries its liveNow / publishedStatus so the console
 *     can show what the AI actually published;
 *   - the sort is by decision weight (approved → pending → rejected), not by
 *     mongoose's lexical status order;
 *   - the model's upsertFromRanking still behaves (it stays test-covered even
 *     though the script now writes via the gate).
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
const DynamicCondition = require('../models/DynamicCondition');
const { invalidateCache } = require('../utils/dynamicConditions');
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

// Live AI-published bundles the read path joins against.
const LIVE_DOCS = [
  { label: 'Fibromyalgia', normalizedLabel: 'fibromyalgia', status: 'live' },
];

async function withProposalRoutes(store, fn) {
  const originals = {
    protect: authMiddleware.protect,
    adminOnly: authMiddleware.adminOnly,
    find: ConditionProposal.find,
    dynamicFind: DynamicCondition.find,
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
  DynamicCondition.find = (filter) => ({
    lean: async () => LIVE_DOCS.filter((d) => !filter?.status || d.status === filter.status).map((d) => ({ ...d })),
  });
  invalidateCache();

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
  const rawCall = async (pathname, { method = 'POST', body, role } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/proposals${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.status;
  };

  try {
    return await fn(call, rawCall);
  } finally {
    await new Promise((ok) => server.close(ok));
    invalidateCache();
    Object.assign(authMiddleware, originals);
    ConditionProposal.find = originals.find;
    DynamicCondition.find = originals.dynamicFind;
  }
}

test('GET / is admin-only', async () => {
  const r = await withProposalRoutes([pendingDoc()], (call) => call('/'));
  assert.equal(r.status, 403);
});

test('GET / is a read-only log: no human decision route exists', async () => {
  const status = await withProposalRoutes([pendingDoc()], (_call, rawCall) =>
    rawCall(`/${ID}/decision`, { method: 'POST', role: 'admin', body: { decision: 'approve', comment: 'x' } }));
  assert.equal(status, 404, 'POST /:id/decision must 404 — the gate decides, not the admin');
});

test('GET / orders approved → pending → rejected with counts, governedBy, liveNow and publishedStatus', async () => {
  const store = [
    pendingDoc({
      _id: '507f1f77bcf86cd7994390bb',
      name: 'Gout',
      normalizedName: 'gout',
      status: 'approved',
      supportingCount: 4,
    }),
    pendingDoc(),
    pendingDoc({
      _id: '507f1f77bcf86cd7994390cc',
      name: 'Vitamin D Deficiency',
      normalizedName: 'vitamin d deficiency',
      status: 'rejected',
      supportingCount: 9,
    }),
  ];
  const r = await withProposalRoutes(store, (call) => call('/', { role: 'admin' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.governedBy, 'clinical-evidence-gate (automated)');
  assert.deepEqual(r.body.counts, { pending: 1, approved: 1, rejected: 1 });
  assert.deepEqual(
    r.body.proposals.map((p) => p.status),
    ['approved', 'pending', 'rejected'],
    'decision weight sorts status-aware, not lexically'
  );
  const gout = r.body.proposals.find((p) => p.normalizedName === 'gout');
  assert.equal(gout.liveNow, MEDICAL_CONDITIONS.includes('Gout'));
  assert.equal(gout.liveNow, true);
  assert.equal(gout.publishedStatus, null, 'registry conditions have no dynamic bundle');
  const fibro = r.body.proposals.find((p) => p.normalizedName === 'fibromyalgia');
  assert.equal(fibro.liveNow, true, 'AI-published label counts as live');
  assert.equal(fibro.publishedStatus, 'live');
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
    // Already ratified by the gate — a re-run must not touch it.
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

test('routes/proposals.js is guarded and human-decision-free', () => {
  const src = require('fs').readFileSync(require.resolve('../routes/proposals.js'), 'utf8');
  assert.match(src, /require\('\.\.\/middleware\/auth'\)/);
  assert.match(src, /router\.get\('\/', protect, adminOnly/);
  assert.doesNotMatch(src, /router\.post/, 'no write endpoint may exist — the gate is the only decider');
});
