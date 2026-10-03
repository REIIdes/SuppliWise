'use strict';
/**
 * Route-level tests for subscription CANCELLATIONS — the mirror of
 * subscription-request-routes.test.js.
 *
 * These drive the REAL handlers out of the real Express routers with the auth
 * middleware stepped over and Mongoose replaced by in-memory stubs, so the code
 * under test is the code that ships. The subscription engine, the catalogue and
 * the entitlements are all REAL: a stubbed engine would make "cancelling
 * actually returns the account to Free" untestable, which is the whole point.
 *
 * What is being pinned:
 *
 *   1. the immediate path strips the paid layer and returns the account to Free
 *   2. the review path changes NOTHING until an admin approves
 *   3. approving is exactly-once, even with two admins racing
 *   4. rejecting never touches the subscription
 *   5. an account already on Free is refused, not no-op'd onto the audit trail
 *   6. one open cancellation per account
 *   7. an admin cannot smuggle the review door past the claim
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const AdminEvent = require('../models/AdminEvent');
const UserNotification = require('../models/UserNotification');
const SubscriptionCancelRequest = require('../models/SubscriptionCancelRequest');
const subscriptionRoutes = require('../routes/subscription');
const adminRoutes = require('../routes/admin');
const subState = require('../utils/subscriptionState');

// ── Express handler extraction ──────────────────────────────────────────────
/** The last handler on a route: the one that does the work. Guard middlewares
 *  (rate limit, `protect`) are skipped on purpose — this file is about the
 *  handler's decisions, not about jsonwebtoken. */
function handler(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`no ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

/** Minimal req/res pair that records what a handler answered. */
function call(fn, { body = {}, query = {}, params = {}, user = { _id: 'u1', role: 'user' }, alias } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      payload: null,
      headers: {},
      set(k, v) { this.headers[k] = v; return this; },
      status(code) { this.statusCode = code; return this; },
      json(out) { this.payload = out; resolve(this); return this; },
      end() { resolve(this); },
      write() { return true; },
    };
    // An admin route reads `req.user.alias`; a user route reads `req.user.role`.
    const withAlias = { ...user, alias: alias || user.alias };
    fn({ body, query, params, user: withAlias, ip: '127.0.0.1', headers: {} }, res);
  });
}

// ── In-memory Mongo ────────────────────────────────────────────────────────
// Ids must be REAL 24-hex ObjectIds: the routes call mongoose.isValidObjectId
// before anything else, and a fake "id1" would make every test assert 400.
const oid = (() => { let n = 0; return () => (++n).toString(16).padStart(24, '0'); })();

function newUser(overrides = {}) {
  return {
    _id: oid(), firstName: 'Jane', lastName: 'Doe', email: `jane${Math.random().toString(36).slice(2, 8)}@example.com`,
    accountRole: 'user', accountStatus: 'active',
    subscriptionActive: true, subscriptionPlan: 'free',
    subscriptionRecord: undefined,
    ...overrides,
  };
}

const db = { users: new Map(), cancels: new Map() };
let adminBells = [];
let userNotices = [];

function resetDb() {
  db.users = new Map();
  db.cancels = new Map();
  adminBells = [];
  userNotices = [];
}

/**
 * A chainable query stub covering every call shape these routes use.
 *
 * Two behaviours have to match Mongoose:
 *   • `populate()` is STICKY — a later `.lean()` must still return the populated
 *     rows, or every approval looks like "the account no longer exists".
 *   • an unpopulated ref resolves to `null`, not to the id, which is what lets
 *     the route tell "gone" apart from "not found".
 */
function query(result) {
  let current = result;
  const ref = (row) => (row && typeof row === 'object' && typeof row.user === 'string'
    ? { ...row, user: db.users.get(row.user) || null }
    : row);
  const resolved = () => (Array.isArray(current) ? current.map(ref) : ref(current));

  const q = {
    _current: () => current,
    _set: (v) => { current = v; return q; },
    select: () => q,
    sort: () => q,
    limit: () => q,
    skip: () => q,
    populate: () => { current = resolved(); return q; },
    lean: () => Promise.resolve(current),
    toObject: () => current,
  };
  q.then = (ok, bad) => Promise.resolve(current).then(ok, bad);
  return q;
}

/** A document-like value: a plain object with a `toObject()`, like a Mongoose doc. */
function asDoc(row) {
  return { ...row, toObject: () => ({ ...row }) };
}

/**
 * Give an account a REAL paid subscription through the real engine, so
 * "cancelling returns them to Free" is tested against the engine that ships.
 */
function seedPaidPlan(fields = {}) {
  const user = newUser(fields);
  const result = subState.applyAction(undefined, 'setPaid', {
    actor: 'test', plan: 'annual', days: 30, note: 'seeded',
  }, new Date());
  assert.ok(result.ok, `seeding a paid plan failed: ${result.error}`);
  const next = { ...user, subscriptionRecord: result.record, ...result.patch };
  db.users.set(next._id, next);
  return next;
}

/** Store a cancellation request in the fake collection. */
function seedCancel(fields = {}) {
  const row = {
    _id: oid(), user: null, plan: 'annual', isTeam: false, seats: 1,
    mode: 'review', reason: '', status: 'pending',
    review: { by: '', at: null, note: '' },
    appliedPlan: null, appliedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...fields,
  };
  db.cancels.set(row._id, row);
  return row;
}

// ── Stubs ──────────────────────────────────────────────────────────────────
// Installed in a `before` hook, never at module load: patching the Mongoose
// models as a side effect of `require` would leak into every other test file
// sharing this process.
const originals = {
  cancelCreate: SubscriptionCancelRequest.create,
  cancelFindOne: SubscriptionCancelRequest.findOne,
  cancelFindById: SubscriptionCancelRequest.findById,
  cancelFind: SubscriptionCancelRequest.find,
  cancelFindOneAndUpdate: SubscriptionCancelRequest.findOneAndUpdate,
  cancelUpdateOne: SubscriptionCancelRequest.updateOne,
  cancelCount: SubscriptionCancelRequest.countDocuments,
  cancelAgg: SubscriptionCancelRequest.aggregate,
  userFindById: User.findById,
  userFindByIdAndUpdate: User.findByIdAndUpdate,
  userFind: User.find,
  eventCreate: AdminEvent.create,
  notifyCreate: UserNotification.create,
};

function installStubs() {
  SubscriptionCancelRequest.create = async (doc) => {
    const row = {
      _id: oid(), createdAt: new Date(), updatedAt: new Date(),
      mode: 'review', status: 'pending', review: { by: '', at: null, note: '' },
      appliedPlan: null, appliedAt: null, ...doc,
    };
    db.cancels.set(row._id, row);
    return asDoc(row);
  };
  SubscriptionCancelRequest.findOne = (filter) => query(
    [...db.cancels.values()].find((r) => matches(r, filter)) || null,
  );
  SubscriptionCancelRequest.findById = (id) => query(db.cancels.get(id) || null);
  SubscriptionCancelRequest.find = (filter) => query(
    [...db.cancels.values()].filter((r) => matches(r, filter))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  );
  // The real findOneAndUpdate returns a Query, so the route can chain
  // `.populate(...)` onto it. This one has to do two things at once:
  //
  //   • stay ASYNC, so the "two admins press Approve together" test below
  //     genuinely interleaves and the claim is really a race;
  //   • let `populate()` and `toObject()` see the settled value, because the
  //     approve route reads `claimed.toObject()` and the reject route reads
  //     `rejected.user` straight after populating.
  //
  // A plain `query(promise)` cannot do that — `populate()` would map over the
  // promise and see nothing, so every approval would look like "the account no
  // longer exists". The box is filled by the promise and read by the terminal
  // methods, which the route only reaches after awaiting the query.
  SubscriptionCancelRequest.findOneAndUpdate = (filter, update) => {
    const box = { value: null };
    // `populate()` is called on the query BEFORE it is awaited, so the flag has
    // to be recorded now and acted on when the promise settles — dereferencing
    // inside populate() itself would run against a still-null value and leave
    // `rejected.user` as a bare id, which is not what Mongoose returns.
    let populated = false;
    const deref = (row) => (row && typeof row === 'object' && typeof row.user === 'string'
      ? { ...row, user: db.users.get(row.user) || null }
      : row);

    const settled = (async () => {
      const row = [...db.cancels.values()].find((r) => matches(r, filter));
      if (!row) return null;
      const next = { ...row, ...(update.$set || {}) };
      db.cancels.set(row._id, next);
      return asDoc(next);
    })().then((value) => {
      box.value = populated ? deref(value) : value;
      return box.value;
    });

    const q = {
      select: () => q,
      sort: () => q,
      limit: () => q,
      populate: () => { populated = true; return q; },
      lean: () => settled.then(() => box.value),
      toObject: () => box.value,
      then: (ok, bad) => settled.then(ok, bad),
    };
    return q;
  };
  SubscriptionCancelRequest.updateOne = async (filter, update) => {
    const row = [...db.cancels.values()].find((r) => matches(r, filter));
    if (!row) return { matchedCount: 0 };
    db.cancels.set(row._id, { ...row, ...(update.$set || {}) });
    return { matchedCount: 1 };
  };
  SubscriptionCancelRequest.countDocuments = async (filter) =>
    [...db.cancels.values()].filter((r) => matches(r, filter)).length;
  SubscriptionCancelRequest.aggregate = async () => {
    const counts = { pending: 0, applied: 0, rejected: 0 };
    for (const r of db.cancels.values()) if (r.status in counts) counts[r.status] += 1;
    return Object.entries(counts).map(([status, count]) => ({ _id: status, count }));
  };

  User.findById = (id) => query(db.users.get(id) || null);
  // findByIdAndUpdate returns a Query in Mongoose, and the engine chains
  // `.select(...).lean()` onto it.
  User.findByIdAndUpdate = (id, update) => query((() => {
    const row = db.users.get(id);
    if (!row) return null;
    const next = { ...row, ...(update.$set || {}) };
    db.users.set(id, next);
    return next;
  })());
  User.find = (filter = {}) => query(
    [...db.users.values()].filter((u) => {
      if (filter.$or) {
        return filter.$or.some((clause) => Object.entries(clause).every(([k, rx]) => rx.test(String(u[k] || ''))));
      }
      return true;
    }),
  );

  AdminEvent.create = async (doc) => { adminBells.push(doc); return doc; };
  UserNotification.create = async (doc) => { userNotices.push(doc); return doc; };
}

// Stubs installed once; the fake collections are emptied before EVERY test.
// The assertions below count rows globally ("a double-tap must not add a second
// request"), so a shared store across tests would make one test's rows look like
// the next test's duplicates.
test.before(() => { installStubs(); });
test.beforeEach(() => { resetDb(); });

/** The tiny slice of Mongo query semantics these handlers rely on. */
function matches(row, filter = {}) {
  for (const [key, want] of Object.entries(filter)) {
    if (key === '$or') {
      if (!want.some((clause) => Object.entries(clause).every(([k, rx]) => rx.test(String(row[k] || ''))))) return false;
      continue;
    }
    if (want && typeof want === 'object' && '$in' in want) {
      if (!want.$in.map(String).includes(String(row[key]))) return false;
      continue;
    }
    if (String(row[key]) !== String(want)) return false;
  }
  return true;
}

test.after(() => {
  Object.assign(SubscriptionCancelRequest, {
    create: originals.cancelCreate, findOne: originals.cancelFindOne,
    findById: originals.cancelFindById, find: originals.cancelFind,
    findOneAndUpdate: originals.cancelFindOneAndUpdate, updateOne: originals.cancelUpdateOne,
    countDocuments: originals.cancelCount, aggregate: originals.cancelAgg,
  });
  User.findById = originals.userFindById;
  User.findByIdAndUpdate = originals.userFindByIdAndUpdate;
  User.find = originals.userFind;
  AdminEvent.create = originals.eventCreate;
  UserNotification.create = originals.notifyCreate;
});

const downgrade = handler(subscriptionRoutes, 'post', '/downgrade');
const askForReview = handler(subscriptionRoutes, 'post', '/cancel-requests');
const listMine = handler(subscriptionRoutes, 'get', '/cancel-requests');
const queueList = handler(adminRoutes, 'get', '/subscription-cancel-requests');
const approve = handler(adminRoutes, 'post', '/subscription-cancel-requests/:id/approve');
const reject = handler(adminRoutes, 'post', '/subscription-cancel-requests/:id/reject');

const asUser = (u) => ({ _id: u._id, role: 'user' });

/** Ask an administrator to do it, as `user`. */
function ask(body = {}, user) {
  return call(askForReview, { user: asUser(user), body: { mode: 'review', ...body } });
}

/** Press Approve in the admin panel. */
function approveAs(id, body = {}, alias = 'root') {
  return call(approve, { user: { _id: oid(), alias, role: 'admin' }, params: { id }, body });
}

// ══════════════════════════════════════════════════════════════════════════
// 1. THE IMMEDIATE PATH
// ══════════════════════════════════════════════════════════════════════════

test('cancelling now returns a Premium account to Free', async () => {
  const jane = seedPaidPlan();
  const res = await call(downgrade, { user: asUser(jane), body: { reason: 'Too expensive' } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.subscription.currentPlan, 'free');
  assert.equal(res.payload.subscription.subscriptionActive, false);
  assert.match(res.payload.message, /back on Free/);

  // And the write actually landed, not just the response.
  const stored = db.users.get(jane._id);
  assert.equal(stored.subscriptionRecord.paid.plan, 'free');
});

test('cancelling now strips a Team seat count back to one', async () => {
  const team = seedPaidPlan();
  // A Team purchase writes the TIER its seats grant, plus the seat count.
  const bought = subState.applyAction(team.subscriptionRecord, 'setPaid', {
    actor: 'test', plan: 'annual', seats: 10, days: 30, note: 'team',
  }, new Date());
  assert.ok(bought.ok);
  db.users.set(team._id, { ...team, subscriptionRecord: bought.record, ...bought.patch });

  const res = await call(downgrade, { user: asUser(team) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.subscription.currentPlan, 'free');
  assert.equal(res.payload.subscription.subscriptionSeats, 1);
});

test('cancelling now records an auditable row marked applied', async () => {
  const jane = seedPaidPlan();
  await call(downgrade, { user: asUser(jane), body: { reason: 'Not using it' } });

  const rows = [...db.cancels.values()];
  assert.equal(rows.length, 1, 'the immediate path must still leave an audit row');
  assert.equal(rows[0].status, 'applied');
  assert.equal(rows[0].mode, 'immediate');
  assert.equal(rows[0].appliedPlan, 'free');
  assert.equal(rows[0].reason, 'Not using it');
  // The plan that was given up is snapshotted, not left null.
  assert.equal(rows[0].plan, 'annual');
});

test('cancelling now tells the admin panel about it', async () => {
  const jane = seedPaidPlan();
  await call(downgrade, { user: asUser(jane) });
  const bell = adminBells.find((b) => b.type === 'subscription-cancel-request');
  assert.ok(bell, 'an admin audit event is expected');
  assert.equal(bell.user, jane._id);
  assert.match(bell.title, /cancelled/i);
});

// ══════════════════════════════════════════════════════════════════════════
// 2. THE REVIEW PATH — INERT UNTIL AN ADMIN SAYS SO
// ══════════════════════════════════════════════════════════════════════════

test('asking for review changes NOTHING about the subscription', async () => {
  const jane = seedPaidPlan();
  const res = await ask({ reason: 'Need to talk to someone' }, jane);

  assert.equal(res.statusCode, 201);
  // The account is untouched — this is the whole point of the review door.
  const stored = db.users.get(jane._id);
  assert.equal(stored.subscriptionRecord.paid.plan, 'annual');
  assert.equal(stored.subscriptionActive, true);
  assert.match(res.payload.message, /stays active until then/);
});

test('asking for review leaves a pending row for the queue', async () => {
  const jane = seedPaidPlan();
  await ask({ reason: 'Billing question' }, jane);

  const rows = [...db.cancels.values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].mode, 'review');
  assert.equal(rows[0].plan, 'annual');
  assert.equal(rows[0].reason, 'Billing question');
});

test('asking for review rings the admin bell', async () => {
  const jane = seedPaidPlan();
  await ask({}, jane);
  const bell = adminBells.find((b) => b.type === 'subscription-cancel-request');
  assert.ok(bell, 'an admin bell is expected');
  assert.equal(bell.user, jane._id);
  assert.match(bell.detail, /Nothing has changed yet/);
});

test('a Team cancellation is labelled by seat count, not by bare tier', async () => {
  const team = seedPaidPlan();
  const bought = subState.applyAction(team.subscriptionRecord, 'setPaid', {
    actor: 'test', plan: 'annual', seats: 10, days: 30, note: 'team',
  }, new Date());
  db.users.set(team._id, { ...team, subscriptionRecord: bought.record, ...bought.patch });

  const res = await ask({}, team);
  assert.equal(res.payload.request.planLabel, '10× Team');
  assert.equal(res.payload.request.seats, 10);
});

test('a mode the client invented is refused, never defaulted', async () => {
  const jane = seedPaidPlan();
  const res = await call(askForReview, { user: asUser(jane), body: { mode: 'someday' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.message, /cancel now or request an administrator/);
  assert.equal(db.cancels.size, 0, 'a rejected mode must not create a row');
});

test('an omitted mode defaults to the slower, human-in-the-loop door', async () => {
  // A client that simply forgot the field must not land on the immediate path.
  const jane = seedPaidPlan();
  const res = await call(askForReview, { user: asUser(jane), body: {} });
  assert.equal(res.statusCode, 201);
  assert.equal([...db.cancels.values()][0].mode, 'review');
  assert.equal(db.users.get(jane._id).subscriptionRecord.paid.plan, 'annual');
});

test('mode immediate through the one endpoint behaves like /downgrade', async () => {
  const jane = seedPaidPlan();
  const res = await call(askForReview, { user: asUser(jane), body: { mode: 'immediate' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.subscription.currentPlan, 'free');
  assert.equal([...db.cancels.values()][0].status, 'applied');
});

// ══════════════════════════════════════════════════════════════════════════
// 3. THE ADMIN DOOR
// ══════════════════════════════════════════════════════════════════════════

test('approving applies the cancellation and returns the member to Free', async () => {
  const jane = seedPaidPlan();
  await ask({}, jane);
  const row = [...db.cancels.values()][0];

  const res = await approveAs(row._id);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.subscription.currentPlan, 'free');
  assert.equal(db.users.get(jane._id).subscriptionRecord.paid.plan, 'free');
  assert.match(res.payload.message, /back on Free/);
});

test('approving records who did it, and when', async () => {
  const jane = seedPaidPlan();
  await ask({}, jane);
  const row = [...db.cancels.values()][0];
  await approveAs(row._id, { note: 'Confirmed with the member' }, 'joma');

  const stored = db.cancels.get(row._id);
  assert.equal(stored.status, 'applied');
  assert.equal(stored.review.by, 'joma');
  assert.ok(stored.review.at instanceof Date);
  assert.equal(stored.appliedPlan, 'free');
  assert.ok(stored.appliedAt instanceof Date);
});

test('approving notifies the member', async () => {
  const jane = seedPaidPlan();
  await ask({}, jane);
  const row = [...db.cancels.values()][0];
  await approveAs(row._id, { note: 'All good' });
  const notice = userNotices.find((n) => n.user === jane._id);
  assert.ok(notice, 'the member must be told their plan ended');
  assert.match(notice.title, /cancelled/i);
  assert.match(notice.detail, /back on the Free plan/);
});

test('approving twice is impossible — the second press is a 409', async () => {
  const jane = seedPaidPlan();
  await ask({}, jane);
  const row = [...db.cancels.values()][0];

  const first = await approveAs(row._id);
  assert.equal(first.statusCode, 200);

  const second = await approveAs(row._id);
  assert.equal(second.statusCode, 409);
  assert.equal(second.payload.code, 'ALREADY_REVIEWED');
  // Still exactly one cancellation recorded, not two.
  assert.equal(db.cancels.size, 1);
});

test('two admins approving at once produce ONE cancellation', async () => {
  const jane = seedPaidPlan();
  await ask({}, jane);
  const row = [...db.cancels.values()][0];

  // Both read the row while it is still pending, then both try to claim it.
  const [a, b] = await Promise.all([approveAs(row._id, {}, 'alice'), approveAs(row._id, {}, 'bob')]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 409], 'exactly one approval must win');

  // The engine ran once: one history entry for the cancellation, not two.
  const history = db.users.get(jane._id).subscriptionRecord.history || [];
  const cancels = history.filter((h) => /cancel/i.test(String(h.note || '')));
  assert.ok(cancels.length <= 1, `cancellation applied ${cancels.length} times`);
});

test('rejecting never touches the subscription', async () => {
  const jane = seedPaidPlan();
  await ask({}, jane);
  const row = [...db.cancels.values()][0];

  const res = await call(reject, {
    user: { _id: oid(), alias: 'root', role: 'admin' },
    params: { id: row._id },
    body: { note: 'Please email support first' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.request.status, 'rejected');
  assert.equal(res.payload.request.review.note, 'Please email support first');
  // The whole point: access is untouched.
  assert.equal(db.users.get(jane._id).subscriptionRecord.paid.plan, 'annual');
  assert.equal(db.users.get(jane._id).subscriptionActive, true);
});

test('rejecting tells the member their plan continues', async () => {
  const jane = seedPaidPlan();
  await ask({}, jane);
  const row = [...db.cancels.values()][0];
  await call(reject, {
    user: { _id: oid(), alias: 'root', role: 'admin' },
    params: { id: row._id },
    body: { note: 'Talk to us first' },
  });
  const notice = userNotices.find((n) => n.user === jane._id);
  assert.ok(notice);
  assert.match(notice.detail, /nothing has changed/i);
});

test('an already-decided row cannot be re-decided by either door', async () => {
  const jane = seedPaidPlan();
  await ask({}, jane);
  const row = [...db.cancels.values()][0];
  await call(reject, {
    user: { _id: oid(), alias: 'root', role: 'admin' }, params: { id: row._id }, body: {},
  });

  const late = await approveAs(row._id);
  assert.equal(late.statusCode, 409);
  assert.equal(late.payload.code, 'ALREADY_REVIEWED');
  // And the rejection stands — nothing sneaked through.
  assert.equal(db.cancels.get(row._id).status, 'rejected');
  assert.equal(db.users.get(jane._id).subscriptionRecord.paid.plan, 'annual');
});

// ══════════════════════════════════════════════════════════════════════════
// 4. THE EDGES THAT WROTE "no bugs"
// ══════════════════════════════════════════════════════════════════════════

test('an account already on Free is refused, not no-opped', async () => {
  const jane = newUser();
  db.users.set(jane._id, jane);

  const now = await call(downgrade, { user: asUser(jane) });
  assert.equal(now.statusCode, 400);
  assert.match(now.payload.message, /already on the Free plan/);

  const review = await ask({}, jane);
  assert.equal(review.statusCode, 400);

  // Nothing was written to the audit trail for a cancellation that had no subject.
  assert.equal(db.cancels.size, 0);
});

test('only one cancellation can be pending at a time', async () => {
  const jane = seedPaidPlan();
  const first = await ask({}, jane);
  assert.equal(first.statusCode, 201);

  const second = await ask({}, jane);
  assert.equal(second.statusCode, 409);
  assert.equal(second.payload.code, 'DUPLICATE_REQUEST');
  assert.equal(db.cancels.size, 1, 'a double-tap must not fill the queue');
});

test('a rejected request frees the slot for a new one', async () => {
  // Otherwise a member who changed their mind once could never ask again.
  const jane = seedPaidPlan();
  await ask({}, jane);
  const row = [...db.cancels.values()][0];
  await call(reject, {
    user: { _id: oid(), alias: 'root', role: 'admin' }, params: { id: row._id }, body: {},
  });

  const again = await ask({}, jane);
  assert.equal(again.statusCode, 201);
});

test('an admin account cannot cancel its own way to Free', async () => {
  const res = await call(downgrade, { user: { _id: oid(), role: 'admin' } });
  assert.equal(res.statusCode, 403);
});

test('a missing or malformed id is a 400, not a crash', async () => {
  for (const id of ['nope', '', '12345']) {
    const a = await approveAs(id);
    assert.equal(a.statusCode, 400, `approve ${JSON.stringify(id)}`);
    const r = await call(reject, {
      user: { _id: oid(), alias: 'root', role: 'admin' }, params: { id }, body: {},
    });
    assert.equal(r.statusCode, 400, `reject ${JSON.stringify(id)}`);
  }
});

test('an unknown id is a 404 on both doors', async () => {
  const a = await approveAs(oid());
  assert.equal(a.statusCode, 404);
  const r = await call(reject, {
    user: { _id: oid(), alias: 'root', role: 'admin' }, params: { id: oid() }, body: {},
  });
  assert.equal(r.statusCode, 404);
});

test('a cancellation for an account that no longer exists is closed out, not left pending', async () => {
  const ghost = seedPaidPlan();
  await ask({}, ghost);
  const row = [...db.cancels.values()][0];
  // The user is gone, so the populate cannot resolve the ref.
  db.users.delete(ghost._id);

  const res = await approveAs(row._id);
  assert.equal(res.statusCode, 404);
  // Closed as rejected, so it stops inflating the queue's badge.
  assert.equal(db.cancels.get(row._id).status, 'rejected');
});

test('an unknown status filter is refused rather than silently emptying the queue', async () => {
  const res = await call(queueList, {
    user: { _id: oid(), alias: 'root', role: 'admin' }, query: { status: 'weird' },
  });
  assert.equal(res.statusCode, 400);
});

test('the queue lists pending rows with the member and their plan', async () => {
  const jane = seedPaidPlan();
  await ask({ reason: 'Too costly' }, jane);

  const res = await call(queueList, { user: { _id: oid(), alias: 'root', role: 'admin' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.requests.length, 1);
  const row = res.payload.requests[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.planLabel, 'PREMIUM');
  assert.equal(row.reason, 'Too costly');
  assert.match(row.userLabel, /Jane Doe/);
  assert.match(row.userLabel, /@example\.com/);
  assert.equal(res.payload.counts.pending, 1);
});

test('the queue can be searched by member email', async () => {
  const jane = seedPaidPlan();
  const john = seedPaidPlan({ email: 'john@example.com' });
  await ask({}, jane);
  await ask({}, john);

  const hit = await call(queueList, {
    user: { _id: oid(), alias: 'root', role: 'admin' }, query: { search: 'john@' },
  });
  assert.equal(hit.payload.requests.length, 1);
  assert.equal(hit.payload.requests[0].userLabel.includes('john@example.com'), true);

  // A search nobody matches must return an empty page, never the whole queue.
  const miss = await call(queueList, {
    user: { _id: oid(), alias: 'root', role: 'admin' }, query: { search: 'nobody@' },
  });
  assert.equal(miss.payload.requests.length, 0);
});

test('my list shows what I asked to give up and where it stands', async () => {
  const jane = seedPaidPlan();
  await ask({ reason: 'Trying the free tier' }, jane);

  const res = await call(listMine, { user: asUser(jane) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.requests.length, 1);
  const row = res.payload.requests[0];
  assert.equal(row.planLabel, 'PREMIUM');
  assert.equal(row.status, 'pending');
  assert.equal(row.pendingCount, undefined, 'pendingCount is a sibling, not a row field');
  assert.equal(res.payload.pendingCount, 1);
  assert.match(row.statusMessage, /waiting for an administrator/);
});

test('my list is scoped to me', async () => {
  const jane = seedPaidPlan();
  const john = seedPaidPlan({ email: 'john@example.com' });
  await ask({}, jane);

  const res = await call(listMine, { user: asUser(john) });
  assert.equal(res.payload.requests.length, 0);
});

test('a reason is trimmed, newlines collapsed and capped', async () => {
  const jane = seedPaidPlan();
  await ask({ reason: `  Too\n\t expensive   ${'x'.repeat(900)}  ` }, jane);
  const stored = [...db.cancels.values()][0];
  assert.equal(stored.reason.includes('\n'), false, 'a multi-line reason would break the queue row');
  assert.ok(stored.reason.length <= 500, `reason was ${stored.reason.length} chars`);
});

test('a non-string reason is dropped rather than stringified', async () => {
  const jane = seedPaidPlan();
  const res = await ask({ reason: { evil: true } }, jane);
  assert.equal(res.statusCode, 201);
  assert.equal([...db.cancels.values()][0].reason, '');
});

test('an empty body on the review door still creates a reviewable row', async () => {
  // A reason is worth asking for but must never be mandatory: a member who
  // clicks without typing still gets a working request.
  const jane = seedPaidPlan();
  const res = await call(askForReview, { user: asUser(jane), body: {} });
  assert.equal(res.statusCode, 201);
  assert.equal([...db.cancels.values()][0].status, 'pending');
});
