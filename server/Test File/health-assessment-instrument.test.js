/**
 * Health Assessment instrument registry + expert/statistical validation.
 *
 * Run: node --test "Test File/health-assessment-instrument.test.js"
 *
 * WHY THIS FILE EXISTS
 * Reviewer item 3 targets the System Health Assessment questionnaire
 * itself — the 4-step intake form every recommendation is built from. That
 * claim only holds if (a) the registry mirrors real form questions with
 * published provenance, (b) the Lawshe CVR math is pinned by independently
 * computed values, and (c) the endpoints a review panel reads actually work.
 * Live sign-in cannot reach them in a test, so the routes run against
 * stubbed middleware and stubbed model stores, exactly like
 * survey-routes.test.js does.
 *
 * The properties pinned here:
 *   - GET / serves every registry item with label, type, step (1-4) and a
 *     provenance citation;
 *   - lawsheCvr / cvrMinThreshold reproduce Lawshe 1975 Table 1;
 *   - contentValidityReport counts one rating per reviewer per item,
 *     computes I-CVI/CVR/S-CVI and the pass/fail against 1.645/sqrt(N);
 *   - severityMatrix maps Mild/Moderate/Severe to 1/2/3, handles
 *     "Category::symptom" keys, and drops all-unrated rows;
 *   - /review is admin-only, refuses unknown items or bad ratings without
 *     storing, and a re-submission REPLACES that reviewer's earlier review;
 *   - /validation is admin-only and reports panel CVR + severity alpha from
 *     stored reviews and real assessment rows.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');

const authMiddleware = require('../middleware/auth');
const Assessment = require('../models/Assessment');
const InstrumentReview = require('../models/InstrumentReview');
const {
  ITEMS,
  INSTRUMENT_VERSION,
} = require('../utils/healthAssessmentInstrument');
const {
  lawsheCvr,
  cvrMinThreshold,
  contentValidityReport,
  severityMatrix,
  statisticalValidationReport,
} = require('../utils/instrumentValidation');

const USER_ID = '507f1f77bcf86cd799439011';

async function withInstrumentRoutes(fn) {
  const originals = {
    protect: authMiddleware.protect,
    adminOnly: authMiddleware.adminOnly,
    reviewFind: InstrumentReview.find,
    reviewCreate: InstrumentReview.create,
    reviewDeleteMany: InstrumentReview.deleteMany,
    assessmentFind: Assessment.find,
  };

  const reviewStore = [];
  let assessmentRows = [];

  // Stub BEFORE require (routes/instrument.js destructures protect/adminOnly
  // at load time), and keep protect dynamic via headers so one cached router
  // can serve member and admin requests.
  authMiddleware.protect = (req, _res, next) => {
    req.user = {
      _id: req.get('x-test-user') || USER_ID,
      role: req.get('x-test-role') === 'admin' ? 'admin' : 'user',
    };
    next();
  };
  authMiddleware.adminOnly = (req, res, next) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required.' });
    }
    next();
  };

  InstrumentReview.find = (filter) => {
    const rows = reviewStore.filter(
      (r) => !filter?.instrument || r.instrument === filter.instrument
    );
    const q = {
      sort: () => q,
      lean: () => Promise.resolve(rows),
      then: (ok, err) => Promise.resolve(rows).then(ok, err),
    };
    return q;
  };
  InstrumentReview.create = async (doc) => {
    const row = { _id: 'rev' + reviewStore.length, ...doc };
    reviewStore.push(row);
    return row;
  };
  InstrumentReview.deleteMany = async (filter) => {
    const before = reviewStore.length;
    for (let i = reviewStore.length - 1; i >= 0; i -= 1) {
      if (
        (!filter.instrument || reviewStore[i].instrument === filter.instrument) &&
        String(reviewStore[i].submittedBy) === String(filter.submittedBy)
      ) {
        reviewStore.splice(i, 1);
      }
    }
    return { deletedCount: before - reviewStore.length };
  };
  Assessment.find = () => ({
    sort: () => Assessment.find(),
    limit: () => ({ lean: () => Promise.resolve(assessmentRows) }),
  });

  const router = require('../routes/instrument');
  const app = express();
  app.use(express.json());
  app.use('/api/instrument', router);

  const server = app.listen(0);
  const { port } = server.address();
  const call = async (pathname, { method = 'GET', body, role, user } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/instrument${pathname}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(role ? { 'x-test-role': role } : {}),
        ...(user ? { 'x-test-user': user } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    await fn({ call, reviewStore, setAssessments: (rows) => { assessmentRows = rows; } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(authMiddleware, { protect: originals.protect, adminOnly: originals.adminOnly });
    Object.assign(InstrumentReview, {
      find: originals.reviewFind,
      create: originals.reviewCreate,
      deleteMany: originals.reviewDeleteMany,
    });
    Assessment.find = originals.assessmentFind;
  }
}

// ── Pure math: Lawshe CVR ─────────────────────────────────────────────────

test('lawsheCvr matches the published formula', () => {
  // CVR = (Ne - N/2) / (N/2)
  assert.equal(lawsheCvr(6, 6), 1);
  assert.equal(lawsheCvr(5, 6), (5 - 3) / 3);
  assert.equal(lawsheCvr(3, 6), 0);
  assert.equal(lawsheCvr(0, 6), -1);
  assert.equal(lawsheCvr(2, 1), null, 'a panel of one is not a panel');
  assert.equal(lawsheCvr(7, 6), null, 'essential count cannot exceed panel size');
});

test('cvrMinThreshold reproduces Lawshe Table 1 (1.645/sqrt(N), p<.05)', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} vs ${b}`);
  near(cvrMinThreshold(2), 1.0);           // capped at 1.00
  near(cvrMinThreshold(3), 0.95);
  near(cvrMinThreshold(4), 0.82);
  near(cvrMinThreshold(5), 0.74);
  near(cvrMinThreshold(10), 0.52);
  near(cvrMinThreshold(20), 0.37);
});

test('contentValidityReport computes I-CVI, CVR pass/fail and S-CVI', () => {
  const ids = ['a', 'b', 'c'];
  const mk = (reviewer, itemId, rating) => ({ reviewer, itemId, rating });
  const ratings = [];
  // Three reviewers: all rate a essential; b gets two essential one useful;
  // c never gets rated.
  for (const rv of ['r1', 'r2', 'r3']) ratings.push(mk(rv, 'a', 3));
  ratings.push(mk('r1', 'b', 3), mk('r2', 'b', 3), mk('r3', 'b', 2));
  // A duplicate from r1 on b must not double-count (latest review wins is
  // enforced upstream; the report still guards against repeats).
  ratings.push(mk('r1', 'b', 3));

  const rep = contentValidityReport(ratings, ids);
  assert.equal(rep.panelSize, 3);
  const byId = Object.fromEntries(rep.items.map((i) => [i.itemId, i]));
  assert.equal(byId.a.cvr, 1);
  assert.equal(byId.a.icvi, 1);
  assert.equal(byId.a.meetsThreshold, true);
  assert.equal(byId.b.reviewers, 3, 'duplicate rating ignored');
  assert.equal(byId.b.essentialCount, 2);
  assert.equal(byId.b.icvi, Math.round((2 / 3) * 1000) / 1000);
  assert.equal(byId.c.reviewers, 0);
  assert.equal(byId.c.cvr, null);
  assert.deepEqual(rep.itemsMissingReview, ['c']);
  // S-CVI/Ave averages only the computed items.
  assert.ok(Math.abs(rep.scviAve - (1 + 1 / 3) / 2) < 0.001);
  // b's CVR is (2-1.5)/1.5 = 0.333, below 0.95 -> only item a passes.
  assert.equal(rep.scviUa, 0.5);
});

test('severityMatrix maps anchors, strips Category:: keys, drops empty rows', () => {
  const docs = [
    { symptomSeverity: { 'General::Fatigue': 'Severe', Headaches: 'Mild' } },
    { symptomSeverity: { Fatigue: 'Moderate', Headaches: 'Moderate' } },
    { symptomSeverity: {} },                    // nothing rated -> dropped
    { symptomSeverity: null },                  // legacy row -> skipped
  ];
  const rows = severityMatrix(docs, ['Fatigue', 'Headaches']);
  assert.deepEqual(rows, [[3, 1], [2, 2]]);
});

test('statisticalValidationReport computes alpha + completeness from real-shaped rows', () => {
  const rows = [
    { age: 30, sleepQuality: 'Good', symptomSeverity: { Fatigue: 'Mild', Headaches: 'Mild' } },
    { age: 40, sleepQuality: 'Poor', symptomSeverity: { 'General::Fatigue': 'Severe', 'General::Headaches': 'Severe' } },
    { age: null, sleepQuality: 'Average', symptomSeverity: { Fatigue: 'Moderate', Headaches: 'Moderate' } },
  ];
  const rep = statisticalValidationReport(rows, {
    fields: [{ id: 'age', label: 'Age', extract: (d) => d.age }],
  });
  assert.equal(rep.assessments, 3);
  const sub = rep.severitySubscale;
  assert.deepEqual(sub.symptoms.sort(), ['Fatigue', 'Headaches']);
  assert.equal(sub.respondentsWithSeverity, 3);
  assert.ok(Number.isFinite(sub.alpha), 'alpha must compute with 3 rows x 2 symptoms');
  assert.equal(sub.severityDistribution.Mild, 2);
  assert.equal(sub.severityDistribution.Severe, 2);
  assert.equal(sub.severityDistribution.Moderate, 2);
  const ageField = rep.completeness.find((c) => c.field === 'age');
  assert.equal(ageField.answered, 2);
  assert.equal(ageField.completeness, Math.round((2 / 3) * 1000) / 1000);
});

// ── Routes ────────────────────────────────────────────────────────────────

test('GET / serves the full registry with provenance on every item', async () => {
  await withInstrumentRoutes(async ({ call }) => {
    const r = await call('');
    assert.equal(r.status, 200);
    assert.equal(r.body.instrument, INSTRUMENT_VERSION);
    assert.equal(r.body.items.length, ITEMS.length);
    assert.ok(ITEMS.length >= 24, 'the 4-step form asks at least two dozen questions');
    for (const step of [1, 2, 3, 4]) {
      assert.ok(ITEMS.some((i) => i.step === step), `step ${step} must be represented`);
    }
    for (const item of r.body.items) {
      assert.ok(item.label && item.type, `${item.id} needs label + type`);
      assert.ok(item.provenance?.source, `${item.id} must cite a source`);
      assert.ok(item.provenance?.citation, `${item.id} must cite the standard`);
      assert.ok(['standardized', 'expert-panel'].includes(item.provenance.kind),
        `${item.id} provenance.kind must be standardized or expert-panel`);
    }
    // The severity subscale is the ordinal core of the instrument.
    const sev = r.body.items.find((i) => i.id === 'symptomSeverity');
    assert.deepEqual(sev.options, ['Mild', 'Moderate', 'Severe']);
  });
});

test('POST /review is admin-only', async () => {
  await withInstrumentRoutes(async ({ call, reviewStore }) => {
    const ratings = [{ itemId: 'age', rating: 3 }];
    const asMember = await call('/review', {
      method: 'POST', body: { reviewerAlias: 'Dr. Who', discipline: 'clinician', ratings },
    });
    assert.equal(asMember.status, 403);
    assert.equal(reviewStore.length, 0);
  });
});

test('POST /review refuses unknown items or ratings without storing', async () => {
  await withInstrumentRoutes(async ({ call, reviewStore }) => {
    const unknown = await call('/review', {
      method: 'POST', role: 'admin',
      body: { reviewerAlias: 'Dr. Who', discipline: 'clinician', ratings: [{ itemId: 'nope', rating: 3 }] },
    });
    assert.equal(unknown.status, 400);

    const badRating = await call('/review', {
      method: 'POST', role: 'admin',
      body: { reviewerAlias: 'Dr. Who', discipline: 'clinician', ratings: [{ itemId: 'age', rating: 5 }] },
    });
    assert.equal(badRating.status, 400);

    const noAlias = await call('/review', {
      method: 'POST', role: 'admin',
      body: { discipline: 'clinician', ratings: [{ itemId: 'age', rating: 3 }] },
    });
    assert.equal(noAlias.status, 400);

    assert.equal(reviewStore.length, 0, 'a refused review must leave no row');
  });
});

test('POST /review stores a valid panel submission and replaces re-submissions', async () => {
  await withInstrumentRoutes(async ({ call, reviewStore }) => {
    const first = await call('/review', {
      method: 'POST', role: 'admin', user: '507f1f77bcf86cd7994390b1',
      body: {
        reviewerAlias: 'Dr. A', discipline: 'clinician',
        ratings: [{ itemId: 'age', rating: 3 }, { itemId: 'sleepQuality', rating: 2, comment: 'keep hour bands' }],
      },
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.ratedItems, 2);
    assert.equal(reviewStore.length, 1);

    const again = await call('/review', {
      method: 'POST', role: 'admin', user: '507f1f77bcf86cd7994390b1',
      body: { reviewerAlias: 'Dr. A', discipline: 'clinician', ratings: [{ itemId: 'age', rating: 2 }] },
    });
    assert.equal(again.status, 201);
    assert.equal(reviewStore.length, 1, 're-submitting replaces the reviewer\'s earlier review');
    assert.equal(reviewStore[0].ratings[0].rating, 2);
    assert.equal(reviewStore[0].instrument, INSTRUMENT_VERSION);
  });
});

test('GET /validation is admin-only and reports CVR + alpha from stored data', async () => {
  await withInstrumentRoutes(async ({ call, setAssessments }) => {
    const forbidden = await call('/validation');
    assert.equal(forbidden.status, 403, 'a member must not read the panel report');

    // A three-expert panel, every item rated essential.
    const allEssential = ITEMS.map((i) => ({ itemId: i.id, rating: 3 }));
    for (let u = 1; u <= 3; u += 1) {
      const r = await call('/review', {
        method: 'POST', role: 'admin', user: `507f1f77bcf86cd7994390c${u}`,
        body: { reviewerAlias: `Dr. ${u}`, discipline: 'clinician', ratings: allEssential },
      });
      assert.equal(r.status, 201);
    }

    setAssessments([
      { age: 30, symptomSeverity: { Fatigue: 'Mild', 'Frequent Headaches': 'Mild' } },
      { age: 40, symptomSeverity: { Fatigue: 'Severe', 'General::Frequent Headaches': 'Severe' } },
      { age: 50, symptomSeverity: { Fatigue: 'Moderate', FrequentHeadachesProxy: 'Moderate' } },
    ]);

    const r = await call('/validation', { role: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(r.body.instrument, INSTRUMENT_VERSION);
    assert.equal(r.body.items, ITEMS.length);

    const cv = r.body.contentValidity;
    assert.equal(cv.panelSize, 3);
    assert.equal(cv.scviAve, 1, 'all-essential panel -> S-CVI 1');
    assert.equal(cv.scviUa, 1, 'every item clears 1.645/sqrt(3)=0.95');
    assert.ok(Array.isArray(cv.itemsMissingReview) && cv.itemsMissingReview.length === 0);
    assert.deepEqual(cv.panelDisciplines, ['clinician']);

    assert.ok(Number.isFinite(r.body.statistics.severitySubscale.alpha),
      'severity alpha must compute from 3 real-shaped assessments');
    assert.match(r.body.interpretation.cvr, /1\.645\/sqrt/);
  });
});
