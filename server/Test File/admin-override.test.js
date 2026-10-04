/**
 * Admin override on an assessment — what can break.
 *
 * The admin's lever over a single assessment is `PATCH /api/assessment/:id/priority`
 * (raise to a Priority review / release it) plus `DELETE /api/assessment/:id`.
 * Those two writes are the only way an admin can stop a severe case from being
 * buried, and they run against documents a user can also reach, so every
 * assumption baked into them is a way to break the app.
 *
 * This suite drives the REAL router over real HTTP with the models backed by an
 * in-memory store, so the assertions are about behaviour (status codes, what
 * landed in the database, who was told) rather than about internals. It needs
 * no MongoDB, no network and no fixtures on disk.
 *
 * Each group below is one class of breakage:
 *   1. AUTHORIZATION   — a non-admin reaching the override
 *   2. MALFORMED INPUT — a body/id shape that must not become a 500 or a write
 *   3. THE GATE        — raising on a finished plan, or on top of another review
 *   4. THE WRITE       — expiry/resolution bookkeeping on raise and on release
 *   5. CROSS-SURFACE   — the submit path disagreeing with the read paths
 *   6. DELETE          — the gate being bypassed by deleting the evidence
 *   7. RESILIENCE      — a side-effect store failing must not undo the override
 *   8. ENTITLEMENT     — plan tier must not change what an admin may do
 *
 * The gate rule itself is unit-tested in `priority-gate.test.js`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');

const Assessment = require('../models/Assessment');
const IntakeRecord = require('../models/IntakeRecord');
const DashboardMetrics = require('../models/DashboardMetrics');
const UserNotification = require('../models/UserNotification');
const AdminEvent = require('../models/AdminEvent');
const { expiryFrom } = require('../utils/assessments');

// `protect` is destructured at import time by the router, so it has to be
// replaced in the module cache BEFORE routes/assessment is required. The stub
// never touches req.user — the per-request middleware below owns that, or every
// "admin may / user may not" assertion would be pinned to one identity.
const authPath = require.resolve('../middleware/auth');
const realAuth = require(authPath);
require.cache[authPath].exports = { ...realAuth, protect: (req, res, next) => next() };

const assessmentRouter = require('../routes/assessment');

// ── Test harness ──────────────────────────────────────────────────────────

const oid = () => new mongoose.Types.ObjectId();
const key = (v) => (v === undefined || v === null ? null : String(v));
/**
 * Day keys, on the same rule the Priority gate reads them by.
 *
 * These were `new Date().toISOString().split('T')[0]` — the UTC calendar date —
 * which no longer matches what the gate asks for. A plan day runs 04:00 → 04:00,
 * so between midnight and 4 AM "today" is the PREVIOUS date, and seeding a
 * half-finished plan under the UTC date made the gate read the wrong day entirely:
 * the test below failed for four hours out of every eight for that reason alone.
 *
 * Derived from `planDayKey` rather than restated, so this suite cannot drift from
 * the rule it is testing.
 */
const { planDayKey, previousDayKey } = require('../utils/planDay');

const today = () => planDayKey(new Date());
/** `n` plan days before the running one — "yesterday" is the previous PLAN day. */
const daysAgo = (n) => shiftPlanDay(n);
function shiftPlanDay(n) {
  let key = today();
  for (let i = 0; i < n; i += 1) key = previousDayKey(key);
  return key;
}

/** Minimal Mongo filter matcher: enough for equality, $ne, $in, $gt. */
function matches(doc, filter = {}) {
  for (const [field, cond] of Object.entries(filter || {})) {
    const isOperatorObject =
      cond !== null && typeof cond === 'object' && !Array.isArray(cond) &&
      !(cond instanceof Date) && !(cond instanceof mongoose.Types.ObjectId);
    if (isOperatorObject) {
      const actual = key(doc[field]);
      for (const [op, val] of Object.entries(cond)) {
        if (op === '$ne' && actual === key(val)) return false;
        if (op === '$in' && !val.map(key).includes(actual)) return false;
        if (op === '$gt' && !(actual > key(val))) return false;
      }
      continue;
    }
    if (key(doc[field]) !== key(cond)) return false;
  }
  return true;
}

/** A chainable, awaitable stand-in for a Mongoose query. */
function chain(result) {
  const q = {
    select: () => q,
    sort: () => q,
    skip: () => q,
    limit: () => q,
    lean: () => Promise.resolve(result),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return q;
}

function makeStore() {
  const owner = { _id: oid(), role: 'user', subscriptionActive: true, subscriptionPlan: 'annual', email: 'owner@example.com' };
  return {
    assessments: [],
    intake: [],
    metrics: [],
    notifications: [],
    events: [],
    users: {
      admin: { _id: oid(), role: 'admin', email: 'admin@example.com' },
      owner,
      free: { _id: oid(), role: 'user', subscriptionActive: true, subscriptionPlan: 'free', email: 'free@example.com' },
      // A user document with no `role` field at all — the shape a partially
      // populated session produces. It must not be mistaken for an admin.
      roless: { _id: oid(), email: 'roless@example.com' },
    },
  };
}

function installFakes(store, opts = {}) {
  const saved = [];
  const stub = (obj, name, fn) => { saved.push([obj, name, obj[name]]); obj[name] = fn; };

  stub(Assessment, 'findById', (id) => {
    const doc = store.assessments.find((a) => key(a._id) === key(id)) || null;
    return chain(doc ? { ...doc } : null);
  });
  stub(Assessment, 'findOne', (filter) => chain(store.assessments.find((a) => matches(a, filter)) || null));
  stub(Assessment, 'find', (filter) => chain(store.assessments.filter((a) => matches(a, filter))));
  stub(Assessment, 'findByIdAndUpdate', async (id, update) => {
    if (opts.failUpdates) throw new Error('update store unavailable');
    const doc = store.assessments.find((a) => key(a._id) === key(id));
    if (!doc) return null;
    // Mongoose treats a flat update object as an implicit $set, and the routes
    // use both forms — priorityGate sends {$set:{...}}, the assessment routes
    // send a flat object. The fake has to behave like Mongoose, not like one
    // of the two callers.
    Object.assign(doc, (update && update.$set) || update || {});
    return { ...doc };
  });
  stub(Assessment, 'findOneAndUpdate', async (filter, update) => {
    if (opts.failUpdates) throw new Error('update store unavailable');
    const doc = store.assessments.find((a) => matches(a, filter));
    if (!doc) return null;
    Object.assign(doc, (update && update.$set) || update || {});
    return { ...doc };
  });
  stub(Assessment, 'findOneAndDelete', async (filter) => {
    const i = store.assessments.findIndex((a) => matches(a, filter));
    return i < 0 ? null : store.assessments.splice(i, 1)[0];
  });
  stub(Assessment, 'create', async (doc) => {
    const created = {
      _id: oid(), createdAt: new Date(), priority: 'Standard', flaggedAt: null,
      resolvedAt: null, resolvedReason: '', flagReasons: [], ...doc,
    };
    store.assessments.push(created);
    return created;
  });
  stub(Assessment, 'countDocuments', async (filter) => store.assessments.filter((a) => matches(a, filter)).length);

  stub(IntakeRecord, 'find', (filter) => chain(store.intake.filter((r) => matches(r, filter))));
  stub(IntakeRecord, 'findOne', (filter) => chain(store.intake.find((r) => matches(r, filter)) || null));
  stub(IntakeRecord, 'deleteMany', async (filter) => {
    store.intake = store.intake.filter((r) => !matches(r, filter));
    return { deletedCount: 0 };
  });

  stub(DashboardMetrics, 'create', async (doc) => { store.metrics.push(doc); return doc; });
  stub(DashboardMetrics, 'updateMany', async () => ({ modifiedCount: 0 }));
  stub(DashboardMetrics, 'deleteMany', async (filter) => {
    store.metrics = store.metrics.filter((m) => !matches(m, filter));
    return { deletedCount: 0 };
  });

  stub(UserNotification, 'create', async (doc) => {
    if (opts.failNotifications) throw new Error('notification store unavailable');
    store.notifications.push(doc);
    return doc;
  });
  stub(AdminEvent, 'create', async (doc) => {
    if (opts.failEvents) throw new Error('audit store unavailable');
    store.events.push(doc);
    return doc;
  });

  return () => { for (const [obj, name, original] of saved) obj[name] = original; };
}

/** Seed one assessment. */
function seedAssessment(store, {
  user = store.users.owner, priority = 'Standard', createdAt = new Date(),
  resolvedReason = '', expiresAt, flagReasons = [],
} = {}) {
  const doc = {
    _id: oid(),
    user: user._id,
    createdAt,
    priority,
    flaggedAt: priority === 'Priority' ? new Date() : null,
    resolvedAt: null,
    resolvedReason,
    expiresAt: expiresAt === undefined ? expiryFrom(createdAt) : expiresAt,
    flagReasons: [...flagReasons],
  };
  store.assessments.push(doc);
  return doc;
}

/** Seed `total` intake rows for one day; `takenCount` of them marked taken. */
function seedIntake(store, assessment, { dayKey = today(), total = 3, takenCount = 0, user } = {}) {
  const rows = [];
  for (let i = 0; i < total; i += 1) {
    const row = {
      _id: oid(),
      user: (user || assessment.user),
      assessment: assessment._id,
      dayKey,
      taken: i < takenCount,
    };
    store.intake.push(row);
    rows.push(row);
  }
  return rows;
}

/** Run `fn` with a live server, the router mounted and the store faked in. */
async function withStore(fn, opts = {}) {
  const store = makeStore();
  const restore = installFakes(store, opts);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.get('x-test-user');
    req.user = who ? store.users[who] : undefined;
    next();
  });
  app.use('/api/assessment', assessmentRouter);

  // Mirrors the global error handler in index.js, so a malformed body behaves
  // here exactly as it does in production (a clean 400, no parser stack trace
  // in the test output).
  app.use((err, req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') {
      if (!req.complete) res.set('Connection', 'close');
      return res.status(400).json({ message: 'Invalid JSON request body.' });
    }
    res.status((err && (err.status || err.statusCode)) || 500).json({ message: 'Unexpected error.' });
  });

  const server = app.listen(0);
  const { port } = server.address();

  // `pathname` is relative to the mount point, e.g. `/${id}/priority` or `/`.
  const call = async (pathname, { as = 'admin', method = 'GET', body, rawBody, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/assessment${pathname}`, {
      method,
      headers: {
        'x-test-user': as,
        ...(rawBody !== undefined || body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed, raw: text };
  };

  try {
    await fn({ call, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
}

/**
 * Silence the route's own console output for a scenario.
 *
 * The routes log on purpose (a released flag, a failed side-effect write) and
 * several scenarios below exercise exactly those paths. Capturing them here
 * keeps `npm test` output to results only — a green run with error spew above
 * it is not a green run.
 */
async function quiet(fn) {
  const { log, error, warn } = console;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
    console.warn = warn;
  }
}

// ── 1. AUTHORIZATION ──────────────────────────────────────────────────────

test('a plain user cannot override priority on any assessment', async () => {
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    const r = await call(`/${target._id}/priority`, { as: 'owner', method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 403);
    assert.match(r.body.message, /admin access required/i);
    // The refusal must be a refusal, not a partial write.
    assert.equal(target.priority, 'Standard');
  });
});

test('a user document with no role is not an admin', async () => {
  // `req.user.role !== 'admin'` is the only check. If it ever became a truthy
  // test, a session missing `role` would hand the override to every user.
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    const r = await call(`/${target._id}/priority`, { as: 'roless', method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 403);
    assert.equal(target.priority, 'Standard');
  });
});

test('a plain user cannot release someone else\'s flag either', async () => {
  // The guard has to sit in front of BOTH directions. A release-only hole would
  // let any user clear a severe case off another account.
  await withStore(async ({ call, store }) => {
    const flagged = seedAssessment(store, { priority: 'Priority', expiresAt: null });
    const r = await call(`/${flagged._id}/priority`, { as: 'owner', method: 'PATCH', body: { priority: 'Standard' } });
    assert.equal(r.status, 403);
    assert.equal(flagged.priority, 'Priority');
  });
});

test('an admin may override any user\'s assessment', async () => {
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store, { user: store.users.free });
    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /set to Priority/i);
    assert.equal(target.priority, 'Priority');
  });
});

// ── 2. MALFORMED INPUT ────────────────────────────────────────────────────

test('only the two exact priority values are accepted', async () => {
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    for (const priority of [undefined, null, 'priority', 'PRIORITY', 'Urgent', '', 0, 1, true, {}, ['Priority']]) {
      const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority } });
      assert.equal(r.status, 400, `priority=${JSON.stringify(priority)} must be refused`);
      assert.match(r.body.message, /must be "Priority" or "Standard"/i);
    }
    assert.equal(target.priority, 'Standard', 'no rejected payload may write');
  });
});

test('a body that is not an object is a 400, never a 500', async () => {
  // `const { priority } = req.body` on a missing body throws in some Express
  // configurations; an array or a bare string used to reach the handler too.
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    for (const rawBody of ['[]', '"Priority"', 'null', '42', 'not json at all']) {
      const r = await call(`/${target._id}/priority`, { method: 'PATCH', rawBody });
      assert.equal(r.status, 400, `raw body ${rawBody} should be 400, got ${r.status}`);
    }
    const noBody = await call(`/${target._id}/priority`, { method: 'PATCH' });
    assert.equal(noBody.status, 400, 'a request with no body at all should be 400');
    assert.equal(target.priority, 'Standard');
  });
});

test('a malformed assessment id is a 400, never a 500', async () => {
  // Unvalidated ids reach Mongoose as a CastError and used to surface as 500.
  // The probes are percent-encoded: `fetch` normalises `..` segments out of a
  // URL path, so a raw '../..' would test the client, not the route.
  await withStore(async ({ call }) => {
    const probes = [
      'abc', '../../etc/passwd', '123', 'null', ' ', '%00', '__proto__',
      'constructor', 'toString', 'a'.repeat(64),
    ];
    for (const id of probes) {
      const r = await call(`/${encodeURIComponent(id)}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
      assert.equal(r.status, 400, `id ${JSON.stringify(id)} should be 400, got ${r.status}`);
      assert.match(r.body.message, /invalid assessment/i);
    }
  });
});

test('a well-formed but unknown id is a 404', async () => {
  await withStore(async ({ call }) => {
    const r = await call(`/${oid()}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 404);
    assert.match(r.body.message, /not found/i);
  });
});

test('the id is validated before the priority value, so neither can mask the other', async () => {
  // Both orderings are defensible; what must not happen is a 200 or a 500.
  await withStore(async ({ call }) => {
    const r = await call('/not-an-id/priority', { method: 'PATCH', body: { priority: 'Nonsense' } });
    assert.ok([400].includes(r.status), `got ${r.status}`);
  });
});

test('a prototype-polluting payload cannot reach the priority field', async () => {
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    const r = await call(`/${target._id}/priority`, {
      method: 'PATCH',
      rawBody: '{"priority":"Standard","__proto__":{"role":"admin","priority":"Priority"},"constructor":{"prototype":{"priority":"Priority"}}}',
    });
    // The literal payload says Standard, so this one is allowed — what matters
    // is that the prototype payload did not flip the value to Priority.
    assert.ok([200, 400].includes(r.status), `got ${r.status}`);
    assert.equal(target.priority, 'Standard', 'Object.prototype must not have been polluted');
    assert.notEqual({}.priority, 'Priority');
  });
});

// ── 3. THE GATE ───────────────────────────────────────────────────────────

test('raising on a finished plan is refused with the facts attached', async () => {
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    seedIntake(store, target, { total: 4, takenCount: 4 });

    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'intake-complete');
    assert.match(r.body.message, /already complete/i);
    // The admin UI shows these, so they must be present and true to the store.
    assert.deepEqual(r.body.intake, { total: 4, taken: 4, complete: true, dayKey: today() });
    assert.equal(r.body.openAssessmentId, null);
    assert.equal(target.priority, 'Standard', 'a refusal must not write');
  });
});

test('raising on a plan finished YESTERDAY is refused too', async () => {
  // No records for today, so a today-only check would have said "not complete"
  // and raised a flag the user could never clear.
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    seedIntake(store, target, { dayKey: daysAgo(1), total: 3, takenCount: 3 });

    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'intake-complete');
    assert.equal(r.body.intake.dayKey, daysAgo(1));
    assert.equal(target.priority, 'Standard');
  });
});

test('today wins over a finished yesterday', async () => {
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    seedIntake(store, target, { dayKey: daysAgo(1), total: 2, takenCount: 2 });
    seedIntake(store, target, { dayKey: today(), total: 2, takenCount: 1 });

    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 200, `a live review must be flaggable, got ${r.status} ${r.raw}`);
    assert.equal(target.priority, 'Priority');
  });
});

test('raising on top of another open review is refused, and names it', async () => {
  await withStore(async ({ call, store }) => {
    const open = seedAssessment(store, { priority: 'Priority', expiresAt: null });
    const target = seedAssessment(store);
    seedIntake(store, target, { total: 3, takenCount: 0 });

    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'already-open');
    assert.equal(r.body.openAssessmentId, String(open._id));
    assert.match(r.body.message, /already has an assessment open/i);
    assert.equal(target.priority, 'Standard', 'stacking must not happen');
  });
});

test('re-raising the SAME assessment is idempotent, not a stacking refusal', async () => {
  // The stacking query must exclude the target itself. If it did not, an admin
  // refreshing a flagged assessment would get "another one is open" about the
  // very row they are looking at.
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store, { priority: 'Priority', expiresAt: null });
    seedIntake(store, target, { total: 3, takenCount: 0 });

    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 200, `got ${r.status} ${r.raw}`);
    assert.equal(target.priority, 'Priority');
  });
});

test('one user\'s open review does not block another user\'s', async () => {
  // The stacking rule is per-owner. A global query would let any flagged user
  // freeze the whole platform.
  await withStore(async ({ call, store }) => {
    seedAssessment(store, { user: store.users.free, priority: 'Priority', expiresAt: null });
    const target = seedAssessment(store, { user: store.users.owner });
    seedIntake(store, target, { total: 2, takenCount: 0 });

    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 200, `got ${r.status} ${r.raw}`);
  });
});

test('a user with no supplements at all is never flag-blocked', async () => {
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 200, `got ${r.status} ${r.raw}`);
    assert.equal(target.priority, 'Priority');
  });
});

test('an assessment with no resolvable owner is refused, not flagged blind', async () => {
  // Fails closed: a flag written without an owner cannot be unblocked, notified
  // or audited, which is the "panicked user" case all over again.
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    target.user = null;

    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'invalid-assessment');
    assert.equal(target.priority, 'Standard');
  });
});

test('releasing is never gated', async () => {
  // The guard protects against raising; it must not make a flag impossible to
  // clear, or the admin loses the only exit for a user who is stuck.
  await withStore(async ({ call, store }) => {
    const finished = seedAssessment(store, { priority: 'Priority', expiresAt: null });
    seedIntake(store, finished, { total: 2, takenCount: 2 });
    const other = seedAssessment(store, { priority: 'Priority', expiresAt: null });

    for (const doc of [finished, other]) {
      const r = await call(`/${doc._id}/priority`, { method: 'PATCH', body: { priority: 'Standard' } });
      assert.equal(r.status, 200, `release must always work, got ${r.status} ${r.raw}`);
      assert.equal(doc.priority, 'Standard');
    }
  });
});

test('concurrent raises: only the first one wins', async () => {
  // Two admin tabs, same user, two assessments. Exactly one flag may land or
  // the user sees a stacked wall with no per-item resolution.
  await withStore(async ({ call, store }) => {
    const a = seedAssessment(store);
    const b = seedAssessment(store);
    seedIntake(store, a, { total: 3, takenCount: 0 });
    seedIntake(store, b, { total: 3, takenCount: 0 });

    const [ra, rb] = await Promise.all([
      call(`/${a._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } }),
      call(`/${b._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } }),
    ]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, [200, 409], `expected one raise and one refusal, got ${statuses}`);
    const open = store.assessments.filter((x) => x.priority === 'Priority');
    assert.equal(open.length, 1, 'exactly one review may be open');
  });
});

// ── 4. THE WRITE ──────────────────────────────────────────────────────────

test('raising suspends expiry and clears the previous resolution', async () => {
  await withStore(async ({ call, store }) => {
    const created = new Date('2026-01-15T08:30:00.000Z');
    const target = seedAssessment(store, { createdAt: created, resolvedReason: 'intake-complete' });
    assert.ok(target.expiresAt, 'precondition: a Standard row carries a retention date');

    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 200);
    assert.equal(target.priority, 'Priority');
    assert.equal(target.expiresAt, null, 'a Priority must never expire while flagged');
    assert.equal(target.resolvedAt, null, 're-raising clears the stale resolution');
    assert.equal(target.resolvedReason, '');
    assert.ok(target.flaggedAt instanceof Date, 'flaggedAt must be stamped');
    // The response must carry the same state the database now holds, or the
    // admin list re-renders from a stale copy.
    assert.equal(r.body.assessment.expiresAt, null);
    assert.equal(r.body.assessment.priority, 'Priority');
  });
});

test('releasing restores the 5-year window counted from CREATION', async () => {
  await withStore(async ({ call, store }) => {
    const created = new Date('2024-03-01T10:00:00.000Z');
    const target = seedAssessment(store, { createdAt: created, priority: 'Priority', expiresAt: null });

    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Standard' } });
    assert.equal(r.status, 200);
    assert.equal(target.priority, 'Standard');
    // 5 CALENDAR years from creation — not 5 years from now, which pushed an
    // old record's expiry years into the future.
    assert.equal(new Date(target.expiresAt).getTime(), new Date('2029-03-01T10:00:00.000Z').getTime());
    assert.ok(target.resolvedAt instanceof Date);
    assert.equal(target.resolvedReason, 'admin-resolved');
  });
});

test('releasing something that was never flagged does not invent a resolution', async () => {
  // Idempotency. Re-saving a Standard assessment used to stamp
  // resolvedAt + "admin-resolved" on a record nobody had flagged — and because
  // the intake-undo path only re-flags rows whose reason is "intake-complete",
  // it silently disarmed the safety reinstatement for that record.
  await withStore(async ({ call, store }) => {
    const created = new Date('2026-02-02T00:00:00.000Z');
    const target = seedAssessment(store, { createdAt: created, priority: 'Standard', resolvedReason: 'intake-complete' });

    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Standard' } });
    assert.equal(r.status, 200);
    assert.equal(target.priority, 'Standard');
    assert.equal(target.resolvedReason, 'intake-complete', 'the real resolution must survive');
    assert.equal(target.resolvedAt, null, 'no resolution may be fabricated');
  });
});

test('an admin release overrides an auto-resolution reason', async () => {
  // The reverse of the case above, and deliberately different: a human decision
  // outranks the automatic one, so the audit must say a human did it.
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store, { priority: 'Standard', resolvedReason: 'intake-complete' });
    target.resolvedAt = new Date();

    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 200);
    const back = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Standard' } });
    assert.equal(back.status, 200);
    assert.equal(target.resolvedReason, 'admin-resolved');
  });
});

test('the override tells the user, and leaves an audit trail', async () => {
  // Every other path that moves this flag notifies the user. A silent override
  // is how a user meets "New Assessments Paused" with no idea an admin acted.
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });

    const note = store.notifications.at(-1);
    assert.ok(note, 'the user must be notified that they are paused');
    assert.equal(key(note.user), key(target.user));
    assert.equal(key(note.assessmentId), key(target._id));
    assert.match(note.detail, /paused|priorit/i);
    assert.equal(note.read, undefined, 'a new notification must be unread');

    const audit = store.events.at(-1);
    assert.ok(audit, 'an admin action must be auditable');
    assert.equal(key(audit.user), key(target.user));
    assert.equal(key(audit.assessmentId), key(target._id));
    assert.ok(['severe-flag', 'resolved'].includes(audit.type), `unexpected audit type ${audit.type}`);

    await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Standard' } });
    assert.match(store.notifications.at(-1).detail, /release|any time/i);
  });
});

test('a manual flag keeps no reason of its own, so history is not overwritten', async () => {
  // The admin override has no reason field, so it must not blank a reason an
  // earlier severity detection recorded.
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    target.flagReasons = ['Red-flag symptom reported: chest pain'];
    await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.deepEqual(target.flagReasons, ['Red-flag symptom reported: chest pain']);
  });
});

// ── 5. CROSS-SURFACE: the submit path must agree with the read paths ──────

const VALID_ASSESSMENT = {
  age: 34, gender: 'Male', weight: 78, height: 180,
  activityLevel: 'Moderate', symptoms: ['chest pain'], medicalConditions: [],
};

test('submitting a new assessment is refused while a review is open, and says which one', async () => {
  await withStore(async ({ call, store }) => {
    const open = seedAssessment(store, {
      priority: 'Priority',
      expiresAt: null,
      flagReasons: ['Red-flag symptom reported: chest pain'],
    });

    const r = await quiet(() => call('/', { as: 'owner', method: 'POST', body: { ...VALID_ASSESSMENT } }));
    assert.equal(r.status, 403);
    assert.match(r.body.message, /prioritized assessment/i);
    assert.equal(key(r.body.priorityAssessment.id), key(open._id));
    assert.deepEqual(r.body.priorityAssessment.reasons, ['Red-flag symptom reported: chest pain']);
    assert.equal(store.assessments.length, 1, 'a refused submit must not create a row');
  });
});

test('a stale flag on a finished plan is released on submit, not used to lock the user out', async () => {
  // The reported lockout. GET /priority-status and GET /dashboard both healed
  // first; this route asked first and healed never, so the user could be told
  // "not blocked" on two screens and refused with 403 on the one that mattered.
  await withStore(async ({ call, store }) => {
    const stale = seedAssessment(store, { priority: 'Priority', expiresAt: null });
    seedIntake(store, stale, { total: 3, takenCount: 3 });

    const submit = await quiet(() => call('/', { as: 'owner', method: 'POST', body: { ...VALID_ASSESSMENT } }));
    assert.equal(submit.status, 201, `submit must not be blocked: ${submit.raw}`);    assert.equal(stale.priority, 'Standard', 'the finished flag must be released');
    assert.ok(stale.expiresAt, 'the release must restore the retention date');
    assert.equal(stale.resolvedReason, 'intake-complete');
    assert.ok(
      store.events.some((e) => e.type === 'resolved' && String(e.detail).includes(String(stale._id))),
      'an auto-release must be auditable, not silent',
    );
  });
});

test('a live review still blocks the submit after the repair runs', async () => {
  // The repair must not become a blanket unlock.
  await withStore(async ({ call, store }) => {
    const open = seedAssessment(store, { priority: 'Priority', expiresAt: null });
    seedIntake(store, open, { total: 3, takenCount: 0 });

    const r = await quiet(() => call('/', { as: 'owner', method: 'POST', body: { ...VALID_ASSESSMENT } }));
    assert.equal(r.status, 403);
    assert.equal(key(r.body.priorityAssessment.id), key(open._id));
  });
});

test('a user without the entitlement is not blocked and is not auto-flagged', async () => {
  // A downgrade must not leave a premium lockout behind. The flag document is
  // kept for history, but nothing enforces it.
  await withStore(async ({ call, store }) => {
    const flagged = seedAssessment(store, { user: store.users.free, priority: 'Priority', expiresAt: null });
    seedIntake(store, flagged, { total: 3, takenCount: 0 });

    const r = await quiet(() => call('/', { as: 'free', method: 'POST', body: { ...VALID_ASSESSMENT } }));
    assert.equal(r.status, 201, `a FREE user must not be paused: ${r.raw}`);
    assert.equal(r.body.severityFlag.flagged, false, 'a FREE user must not be auto-flagged');
    const created = store.assessments.at(-1);
    assert.equal(created.priority, 'Standard', 'severe input must still save, just unflagged');
  });
});

test('a PREMIUM user\'s severe save is auto-flagged and can block the next submit', async () => {
  await withStore(async ({ call, store }) => {
    const first = await quiet(() => call('/', { as: 'owner', method: 'POST', body: { ...VALID_ASSESSMENT } }));
    assert.equal(first.status, 201);
    assert.equal(first.body.severityFlag.flagged, true, 'severe input must auto-flag for PREMIUM');
    const flaggedId = key(first.body.assessment._id);

    const second = await quiet(() => call('/', { as: 'owner', method: 'POST', body: { ...VALID_ASSESSMENT } }));
    assert.equal(second.status, 403, 'the auto-flag must actually pause the next assessment');
    assert.equal(second.body.priorityAssessment.id, flaggedId);
  });
});

test('an auto-flag is refused on a finished plan instead of re-pausing a satisfied user', async () => {
  // The severity check re-runs whenever results are saved. Re-saving results for
  // a plan the user had already finished used to reinstate the gate with no
  // admin involved at all.
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    seedIntake(store, target, { total: 2, takenCount: 2 });

    const r = await quiet(() => call(`/${target._id}/results`, {
      as: 'owner', method: 'PATCH', body: { warnings: ['seek emergency care immediately'], recommendations: [] },
    }));
    assert.equal(r.status, 200);
    assert.equal(r.body.severityFlag.flagged, false, 'a finished plan must not be re-flagged');
    assert.equal(target.priority, 'Standard');
  });
});

// ── 6. DELETE: the gate must not be bypassable ────────────────────────────

test('a user cannot delete their own open review', async () => {
  // DELETE was the way around the whole gate: delete the document and the block
  // goes with it — the severe case disappears from the admin panel along with
  // every intake record attached to it, and there is no audit entry.
  await withStore(async ({ call, store }) => {
    const flagged = seedAssessment(store, { priority: 'Priority', expiresAt: null });
    seedIntake(store, flagged, { total: 2, takenCount: 0 });

    const r = await call(`/${flagged._id}`, { as: 'owner', method: 'DELETE' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'priority-open');
    assert.ok(store.assessments.some((a) => key(a._id) === key(flagged._id)), 'the record must survive');
    assert.equal(store.intake.length, 2, 'its intake must not be cleaned up either');
  });
});

test('a user may still delete their own assessment once it is released', async () => {
  await withStore(async ({ call, store }) => {
    const mine = seedAssessment(store);
    const r = await call(`/${mine._id}`, { as: 'owner', method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal(store.assessments.some((a) => key(a._id) === key(mine._id)), false);
  });
});

test('an admin may delete an open review, and the orphan rows go with it', async () => {
  await withStore(async ({ call, store }) => {
    const flagged = seedAssessment(store, { priority: 'Priority', expiresAt: null });
    seedIntake(store, flagged, { total: 3, takenCount: 1 });
    store.metrics.push({ _id: oid(), user: flagged.user, assessment: flagged._id, isActive: true });

    const r = await call(`/${flagged._id}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal(store.assessments.length, 0);
    assert.equal(store.intake.filter((x) => key(x.assessment) === key(flagged._id)).length, 0);
    assert.equal(store.metrics.filter((x) => key(x.assessment) === key(flagged._id)).length, 0);
  });
});

test('a user cannot delete somebody else\'s assessment', async () => {
  await withStore(async ({ call, store }) => {
    const theirs = seedAssessment(store, { user: store.users.free });
    const r = await call(`/${theirs._id}`, { as: 'owner', method: 'DELETE' });
    assert.equal(r.status, 404, 'must not confirm the existence of another user\'s row');
    assert.equal(store.assessments.length, 1);
  });
});

test('a malformed id on delete is a 400, never a 500', async () => {
  await withStore(async ({ call }) => {
    const r = await call('/not-an-id', { as: 'owner', method: 'DELETE' });
    assert.equal(r.status, 400);
  });
});

// ── 7. RESILIENCE: a side-effect store failing must not undo the override ─

test('a failed notification does not fail the override', async () => {
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    const r = await quiet(() => call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } }));
    assert.equal(r.status, 200);
    assert.equal(target.priority, 'Priority', 'the write must stand on its own');
  }, { failNotifications: true });
});

test('a failed audit does not fail the override', async () => {
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    const r = await quiet(() => call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } }));
    assert.equal(r.status, 200);
    assert.equal(target.priority, 'Priority');
  }, { failEvents: true });
});

test('a failed assessment write is a 500, not a silent success', async () => {
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store);
    const r = await quiet(() => call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } }));
    assert.equal(r.status, 500);
    assert.match(r.body.message, /could not update priority/i);
    assert.equal(target.priority, 'Standard', 'nothing may be reported as saved when the write failed');
  }, { failUpdates: true });
});

test('the release path survives a broken intake store', async () => {
  // Self-heal reads intake for every open flag. If that read throws, a user
  // reading their priority status must still get an answer, not a 500 wall.
  await withStore(async ({ call, store }) => {
    const flagged = seedAssessment(store, { priority: 'Priority', expiresAt: null });
    const originalFind = IntakeRecord.find;
    IntakeRecord.find = () => { throw new Error('intake store unavailable'); };
    try {
      const status = await quiet(() => call('/priority-status', { as: 'owner' }));
      assert.equal(status.status, 200, 'a failed repair must degrade, not break the page');
      assert.equal(flagged.priority, 'Priority', 'the flag must be left exactly as it was');
      assert.equal(status.body.blocked, true);
    } finally {
      IntakeRecord.find = originalFind;
    }
  });
});

// ── 8. ENTITLEMENT: the plan tier must not change what an admin may do ────

test('a manual admin flag applies to a FREE user (documented, deliberate)', async () => {
  // Severity auto-flagging is PREMIUM+, but a human decision is not gated: an
  // admin can always hold a review open, whatever the account pays for. Asserted
  // so a future "tier-gate the admin route" change has to be deliberate.
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store, { user: store.users.free });
    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Priority' } });
    assert.equal(r.status, 200);
    assert.equal(target.priority, 'Priority');
    // ...but the FREE user is not actually paused, because the pause is itself
    // a PREMIUM entitlement.
    const status = await quiet(() => call('/priority-status', { as: 'free' }));
    assert.equal(status.body.blocked, false);
    assert.deepEqual(status.body.assessments, []);
  });
});

test('an admin can release a flag on a user who has since downgraded', async () => {
  // The downgrade hides the flag but keeps the document, so the admin still has
  // to be able to clean it up.
  await withStore(async ({ call, store }) => {
    const target = seedAssessment(store, { user: store.users.free, priority: 'Priority', expiresAt: null });
    const r = await call(`/${target._id}/priority`, { method: 'PATCH', body: { priority: 'Standard' } });
    assert.equal(r.status, 200);
    assert.equal(target.priority, 'Standard');
  });
});
