/**
 * Published-condition read path — the questionnaire and engine side of the
 * autonomous pipeline.
 *
 * Run: node --test "Test File/instrument-live-extensions.test.js"
 *
 * Pins the contract the client relies on:
 *   - GET /api/instrument/live-extensions is available to any authenticated
 *     member (protect, NOT adminOnly — the intake form must render what the
 *     AI published);
 *   - it exposes curated fields (label, group, sexGate, symptomPool and a
 *     name+citation evidence list), never the internal supplement rows;
 *   - recommend.js and assessmentPrompt.js actually consume the live
 *     snapshot (source grep — the merge is unit-tested in
 *     evidence-gate.test.js).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const express = require('express');
const authMiddleware = require('../middleware/auth');
const DynamicCondition = require('../models/DynamicCondition');
const { invalidateCache } = require('../utils/dynamicConditions');

const LIVE = [{
  label: 'Sleep Apnea',
  normalizedLabel: 'sleep apnea',
  group: 'Respiratory & Immune',
  sexGate: '',
  rationale: 'Reported snoring + unrefreshed sleep with no condition selected.',
  symptomPool: ['Loud Snoring', 'Daytime Sleepiness'],
  supplements: [{ name: 'Magnesium Glycinate', evidence: 'NIH Office of Dietary Supplements.', dosage: '200 mg' }],
  source: { runAt: '2026-10-18T00:00:00.000Z' },
  status: 'live',
}];

async function withInstrumentRoutes(fn) {
  const originals = {
    protect: authMiddleware.protect,
    adminOnly: authMiddleware.adminOnly,
    dynamicFind: DynamicCondition.find,
  };
  authMiddleware.protect = (req, _res, next) => {
    req.user = { _id: '507f1f77bcf86cd799439011', role: req.get('x-test-role') === 'admin' ? 'admin' : 'user' };
    next();
  };
  authMiddleware.adminOnly = (req, res, next) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required.' });
    next();
  };
  DynamicCondition.find = () => ({ lean: async () => LIVE.map((d) => ({ ...d })) });
  invalidateCache();

  const router = require('../routes/instrument');
  const app = express();
  app.use(express.json());
  app.use('/api/instrument', router);
  const server = app.listen(0);
  const { port } = server.address();
  const call = async (pathname, { role } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/instrument${pathname}`, {
      headers: role ? { 'x-test-role': role } : {},
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    return await fn(call);
  } finally {
    await new Promise((ok) => server.close(ok));
    invalidateCache();
    Object.assign(authMiddleware, originals);
    DynamicCondition.find = originals.dynamicFind;
  }
}

test('GET /live-extensions is member-readable and curates the bundle', async () => {
  const r = await withInstrumentRoutes((call) => call('/live-extensions'));
  assert.equal(r.status, 200, 'a plain member token must be able to load the form extensions');
  assert.equal(r.body.instrument, 'health-assessment-v2');
  const c = r.body.conditions[0];
  assert.equal(c.label, 'Sleep Apnea');
  assert.deepEqual(c.symptomPool, ['Loud Snoring', 'Daytime Sleepiness']);
  assert.deepEqual(c.evidence, [{ name: 'Magnesium Glycinate', citation: 'NIH Office of Dietary Supplements.' }]);
  assert.equal('supplements' in c, false, 'internal rows are not leaked');
  assert.equal('dosage' in c.evidence[0], false);
  assert.equal(c.publishedAt, '2026-10-18T00:00:00.000Z');
});

test('routes/instrument.js guards live-extensions with protect (not adminOnly) and validation with both', () => {
  const src = fs.readFileSync(require.resolve('../routes/instrument.js'), 'utf8');
  assert.match(src, /router\.get\('\/live-extensions', protect, async/);
  assert.match(src, /router\.get\('\/validation', protect, adminOnly/);
});

test('the AI path and the rule path both consume the live published conditions', () => {
  const rec = fs.readFileSync(require.resolve('../routes/recommend.js'), 'utf8');
  assert.match(rec, /getLiveConditions\(\)/);
  assert.match(rec, /_dynamicKb/);
  assert.match(rec, /mergeSelectedBundles/);
  const prompt = fs.readFileSync(require.resolve('../utils/assessmentPrompt.js'), 'utf8');
  assert.match(prompt, /_dynamicKb/);
});
