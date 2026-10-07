/**
 * GET /api/assessment/active returns the newest assessment still
 * in force, with the aiResults blob projected out.
 *
 * Run: node --test "Test File/assessment-active-route.test.js"
 *
 * WHY THIS FILE EXISTS
 * The dashboard's New Assessment card offers "Update current
 * assessment" only when this endpoint answers, and the form
 * pre-fill is built from the document it returns. Two properties
 * had to be pinned by a test rather than by reading the code:
 *
 *   - the route must apply the same not-expired filter the
 *     dashboard applies, so a retired record can never be served
 *     as "active" (an expired newest assessment must 404), and
 *   - the aiResults projection must actually be honoured — the
 *     entire point of the endpoint is NOT shipping the ~500 KB
 *     blob that the history list carries per assessment.
 *
 * The chainable-query stand-in below applies string exclusion
 * projections (`-field`), which is the one behaviour the shared
 * harness's stand-in leaves out, because no other route under
 * test selects a projection.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');

const Assessment = require('../models/Assessment');
const authMiddleware = require('../middleware/auth');

const USER_ID = '507f1f77bcf86cd799439011';
const ASSESSMENT_ID = '507f1f77bcf86cd7994390aa';

/**
 * Chainable query stand-in. Unlike the shared harness's version,
 * `select()` applies exclusion projections (`-field`) to the
 * resolved document, so a route's projection is part of what
 * the test can assert.
 */
function chainableQuery(result) {
  let doc = result;
  const q = {
    select(projection) {
      if (doc && typeof projection === 'string' && projection.startsWith('-')) {
        const field = projection.slice(1);
        if (field && typeof doc === 'object') {
          const copy = { ...doc };
          delete copy[field];
          doc = copy;
        }
      }
      return q;
    },
    sort() { return q; },
    limit() { return q; },
    lean() { return q; },
    then(resolve, reject) { return Promise.resolve(doc).then(resolve, reject); },
    catch(reject) { return Promise.resolve(doc).catch(reject); },
  };
  return q;
}

/**
 * Boots routes/assessment.js against a stand-in Assessment.findOne.
 *
 * @param {object|null} doc  What findOne resolves to.
 * @param {(filter: object) => void} onFilter  Receives every filter.
 * @param {(ctx) => Promise<void>} fn
 */
async function withActiveRoute(doc, onFilter, fn) {
  const originals = {
    findOne: Assessment.findOne,
    protect: authMiddleware.protect,
  };

  Assessment.findOne = (filter) => {
    onFilter(filter);
    return chainableQuery(doc);
  };
  authMiddleware.protect = (req, _res, next) => {
    req.user = { _id: USER_ID, plan: 'Premium', role: 'user', timeZone: '' };
    next();
  };

  delete require.cache[require.resolve('../routes/assessment')];
  const app = express();
  app.use(express.json());
  app.use('/api/assessment', require('../routes/assessment'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/assessment`;

  try {
    await fn({ status: (path) => fetch(`${base}${path}`), base });
  } finally {
    server.close();
    Assessment.findOne = originals.findOne;
    authMiddleware.protect = originals.protect;
    delete require.cache[require.resolve('../routes/assessment')];
  }
}

test('GET /active serves the newest non-expired assessment, aiResults projected out', async () => {
  const activeDoc = {
    _id: ASSESSMENT_ID,
    user: USER_ID,
    createdAt: new Date(),
    age: 30,
    gender: 'Female',
    dietType: 'Balanced',
    symptoms: ['Fatigue'],
    symptomSeverity: { Fatigue: 'Moderate' },
    medicalConditions: ['Anemia'],
    allergies: ['Nuts'],
    aiResults: { recommendations: [{ name: 'Vitamin D3' }], dailySchedule: [] },
  };
  let seenFilter = null;

  await withActiveRoute(activeDoc, (filter) => { seenFilter = filter; }, async ({ status }) => {
    const res = await status('/active');
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(String(body._id), String(ASSESSMENT_ID));
    // Form fields the pre-fill reads must survive.
    assert.equal(body.age, 30);
    assert.deepEqual(body.symptoms, ['Fatigue']);
    assert.deepEqual(body.symptomSeverity, { Fatigue: 'Moderate' });
    // The projection is the contract: no aiResults on the wire.
    assert.equal(body.aiResults, undefined);
    // The route must ask for the newest still-in-force record,
    // not merely the newest — the same filter the dashboard runs.
    assert.ok(seenFilter, 'route must query the assessment store');
    assert.equal(String(seenFilter.user), String(USER_ID));
    assert.ok(Array.isArray(seenFilter.$or), 'route must apply the not-expired filter');
  });
});

test('GET /active answers 404 when no assessment is in force', async () => {
  await withActiveRoute(null, () => {}, async ({ status }) => {
    const res = await status('/active');
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.ok(body.message);
  });
});
