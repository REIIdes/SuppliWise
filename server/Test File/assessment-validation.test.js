/**
 * POST /api/assessment input-boundary tests (bug-hunt regressions).
 *
 * Before the fix: gender outside the enum and object/number values inside
 * array fields threw Mongoose CastError/ValidationError → HTTP 500; a bare
 * string for an array field CAST to ["nope"] and saved as 201; an empty body
 * saved as 201 with no identity fields at all. All four must now be clean 400s
 * — and they must be answered BEFORE any database write, so the whole file
 * runs with stubbed middleware and never connects to mongoose.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// Stub protect before require (routes destructure middleware at load).
const authPath = require.resolve(path.join(__dirname, '../middleware/auth'));
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    protect: (req, _res, next) => {
      req.user = { _id: '600000000000000000000001', email: 't@t.io', name: 'T', subscriptionPlan: 'free' };
      next();
    },
    adminOnly: (_req, res) => res.status(403).json({ message: 'no' }),
  },
};

// The route file pulls in providers/ai deps at load; keep the require hermetic.
const router = require(path.join(__dirname, '../routes/assessment'));

function call(body) {
  return new Promise((resolve, reject) => {
    const req = { body, user: { _id: '600000000000000000000001', email: 't@t.io', name: 'T', subscriptionPlan: 'free' }, query: {}, params: {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    const match = router.stack.find((l) => l.route?.path === '/' && l.route.methods.post);
    // The matched router Layer holds the Route; the handler chain is on the
    // ROUTE's stack, not the layer's.
    const layers = match.route.stack;
    let i = 0;
    const next = (err) => { if (err) return reject(err); const h = layers[i++]; if (!h) return reject(new Error('no handler ran')); Promise.resolve(h.handle(req, res, next)).catch(reject); };
    next();
  });
}

const VALID = { age: 30, gender: 'Male', weight: 70, height: 175 };

test('gender outside the enum is a 400, not a 500', async () => {
  const r = await call({ ...VALID, gender: 'Other' });
  assert.equal(r.status, 400);
  assert.match(r.payload.message, /Gender/i);
});

test('objects and numbers inside array fields are a 400, not a 500', async () => {
  for (const bad of [{ 0: 'x' }, [1, 2, 3], [{ name: 'obj' }], 'not-an-array']) {
    const r = await call({ ...VALID, healthGoals: bad });
    assert.equal(r.status, 400, `bare ${JSON.stringify(bad)} must not cast into the [String] schema`);
    assert.match(r.payload.message, /healthGoals must be an array/i);
  }
});

test('empty body is a 400 — identity fields are required', async () => {
  const r = await call({});
  assert.equal(r.status, 400);
  assert.match(r.payload.message, /required/i);
  for (const drop of ['age', 'gender', 'weight', 'height']) {
    const body = { ...VALID };
    delete body[drop];
    const rr = await call(body);
    assert.equal(rr.status, 400, `missing ${drop} must be refused`);
  }
});

test('objects in plain-text fields are refused before reaching castString', async () => {
  const r = await call({ ...VALID, dietType: { $gt: '' }, stressLevel: [1] });
  assert.equal(r.status, 400);
  assert.match(r.payload.message, /must be text/i);
});

test('symptomSeverity must be a map, not an array or string', async () => {
  for (const bad of ['x', [1, 2]]) {
    const r = await call({ ...VALID, symptomSeverity: bad });
    assert.equal(r.status, 400);
    assert.match(r.payload.message, /symptomSeverity/i);
  }
});

test('well-formed payloads still pass validation (reaches the DB layer)', async () => {
  // The stub never connects, so Assessment.create throws → the handler's own
  // 500 catch. Reaching that catch proves validation accepted the body.
  const r = await call({ ...VALID, dietType: 'Omnivore', healthGoals: ['Energy'], symptoms: [], medicalConditions: [] });
  assert.equal(r.status, 500);
});
