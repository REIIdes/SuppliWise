/**
 * The survey routes end to end, without a live server.
 *
 * Run: node --test "Test File/survey-routes.test.js"
 *
 * WHY THIS FILE EXISTS
 * Reviewer item 3 ("validate the instruments") only holds if the endpoints
 * the research panel reads actually work: the instrument list the member
 * screen renders, the scored submission that becomes data, and the
 * admin-only validation report that computes reliability from that data.
 * Live sign-in cannot reach them in a test (login requires an emailed OTP),
 * so the routes are exercised against stubbed middleware and a stubbed
 * response store, exactly like assessment-active-route.test.js does.
 *
 * The properties pinned here:
 *   - /instruments ships the SERVER-defined instruments (ids, item counts,
 *     sources) — the client renders nothing it invented;
 *   - /respond rejects malformed answers BEFORE anything is stored, and
 *     stores the score and the reverse-flipped matrix it computed;
 *   - /validation is admin-only, and its alpha only appears once at least
 *     three complete responses exist.
 *
 * Middleware is stubbed BEFORE require (routes/survey.js destructures
 * protect/adminOnly at load time), and the protect stub stays dynamic —
 * a per-request `x-test-role` header picks the member or admin identity.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');

const authMiddleware = require('../middleware/auth');
const SurveyResponse = require('../models/SurveyResponse');

const USER_ID = '507f1f77bcf86cd799439011';

async function withSurveyRoutes(fn) {
  const originals = {
    protect: authMiddleware.protect,
    adminOnly: authMiddleware.adminOnly,
    create: SurveyResponse.create,
    find: SurveyResponse.find,
  };

  const store = [];
  // The router module is cached across boots, so the stubs must be dynamic:
  // the test picks an identity per request via a header.
  authMiddleware.protect = (req, _res, next) => {
    req.user = { _id: USER_ID, role: req.get('x-test-role') === 'admin' ? 'admin' : 'user' };
    next();
  };
  // adminOnly keeps its real semantics: refuse non-admins.
  authMiddleware.adminOnly = (req, res, next) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required.' });
    }
    next();
  };
  SurveyResponse.create = async (doc) => {
    const row = { _id: 'r' + store.length, ...doc };
    store.push(row);
    return row;
  };
  // The validation route reads `.find(...).sort().limit().lean()`.
  SurveyResponse.find = (filter) => {
    const rows = store.filter((r) => !filter?.instrument || r.instrument === filter.instrument);
    const q = {
      sort: () => q,
      limit: () => q,
      lean: () => Promise.resolve(rows),
      then: (ok, err) => Promise.resolve(rows).then(ok, err),
    };
    return q;
  };

  const router = require('../routes/survey');
  const app = express();
  app.use(express.json());
  app.use('/api/survey', router);

  const server = app.listen(0);
  const { port } = server.address();
  const call = async (pathname, { method = 'GET', body, role } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/survey${pathname}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(role ? { 'x-test-role': role } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    await fn({ call, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(authMiddleware, { protect: originals.protect, adminOnly: originals.adminOnly });
    Object.assign(SurveyResponse, { create: originals.create, find: originals.find });
  }
}

// A full SUS submission (10 items, 1-5 scale).
const SUS_ANSWERS = [4, 2, 4, 2, 4, 2, 3, 2, 4, 5];

test('/instruments serves the server-defined questionnaires', async () => {
  await withSurveyRoutes(async ({ call }) => {
    const r = await call('/instruments');
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.instruments.map((i) => [i.id, i]));
    assert.equal(byId.sus.items.length, 10, 'SUS is the canonical 10-item instrument');
    assert.equal(byId.efficiency.items.length, 4);
    assert.equal(byId.satisfaction.items.length, 5);
    for (const inst of r.body.instruments) {
      assert.ok(inst.source, `"${inst.id}" must cite its provenance`);
      assert.ok(inst.items.every((i) => typeof i.text === 'string' && i.text.length > 0));
    }
  });
});

test('/respond scores and stores a valid submission', async () => {
  await withSurveyRoutes(async ({ call, store }) => {
    const r = await call('/respond', { method: 'POST', body: { instrument: 'sus', values: SUS_ANSWERS } });
    assert.equal(r.status, 201);
    assert.equal(r.body.instrument, 'sus');
    assert.equal(store.length, 1);
    // scoreInstrument's SUS math is verified independently in
    // survey-instruments.test.js — here the ROUTE must store that score.
    assert.equal(store[0].score, r.body.score);
    assert.equal(store[0].user, USER_ID);
    assert.equal(store[0].reversed.length, 10);
    // Canonical SUS reverse-scores the EVEN items (0, 2, 4… in zero-based
    // indices 1, 3, 5…): answer 2 → 6-2 = 4. Odd items store unchanged.
    assert.equal(store[0].reversed[0], 4, 'forward items store unchanged');
    assert.equal(store[0].reversed[1], 4, 'reverse item 2 is flipped (6-2)');
  });
});

test('/respond refuses malformed answers without storing anything', async () => {
  await withSurveyRoutes(async ({ call, store }) => {
    const outOfRange = await call('/respond', {
      method: 'POST', body: { instrument: 'sus', values: [6, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
    });
    assert.equal(outOfRange.status, 400);

    const wrongLength = await call('/respond', {
      method: 'POST', body: { instrument: 'sus', values: [1, 2, 3] },
    });
    assert.equal(wrongLength.status, 400);

    const unknown = await call('/respond', {
      method: 'POST', body: { instrument: 'nonsense', values: SUS_ANSWERS },
    });
    assert.equal(unknown.status, 400);

    assert.equal(store.length, 0, 'a refused submission must leave no row');
  });
});

test('/validation is admin-only', async () => {
  await withSurveyRoutes(async ({ call }) => {
    const r = await call('/validation');
    assert.equal(r.status, 403);
  });
});

test('/validation computes reliability from three stored responses', async () => {
  await withSurveyRoutes(async ({ call, store }) => {
    const answers = [[4, 3, 5, 4], [3, 4, 4, 5], [5, 2, 4, 3]];
    for (const values of answers) {
      const r = await call('/respond', { method: 'POST', body: { instrument: 'efficiency', values } });
      assert.equal(r.status, 201);
    }
    assert.equal(store.length, 3);

    const forbidden = await call('/validation');
    assert.equal(forbidden.status, 403, 'a member must not read the research report');
    const r = await call('/validation', { role: 'admin' });
    assert.equal(r.status, 200);
    assert.match(r.body.threshold, /0\.70/);
    const eff = r.body.instruments.find((i) => i.instrument === 'efficiency');
    assert.equal(eff.respondents, 3);
    assert.ok(Number.isFinite(eff.scoreMean), 'score mean must compute from stored scores');
    assert.ok(Number.isFinite(eff.reliability.alpha), 'alpha must compute with 3+ complete rows');
  });
});
