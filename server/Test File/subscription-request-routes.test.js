'use strict';
/**
 * Route-level tests for the proof-of-payment subscription requests.
 *
 * These drive the REAL route handlers out of the real Express routers — the auth
 * middleware is stepped over, and Mongoose is replaced by small in-memory stubs,
 * so the code under test is the code that ships. What is being pinned:
 *
 *   1. the amount recorded is priced by the server, never taken from the body
 *   2. a request grants nothing; only an admin approval writes a subscription
 *   3. approving twice is impossible, even with two admins racing
 *   4. rejecting never touches the subscription
 *   5. the list response never carries the receipt image
 *
 * The subscription engine, the catalogue and the entitlements are all REAL — a
 * stubbed engine would make "approving actually grants the plan" untestable.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const AdminEvent = require('../models/AdminEvent');
const UserNotification = require('../models/UserNotification');
const SubscriptionRequest = require('../models/SubscriptionRequest');
const subscriptionRoutes = require('../routes/subscription');
const adminRoutes = require('../routes/admin');

// ── Express handler extraction ──────────────────────────────────────────────
/**
 * The last handler on a route, i.e. the one that actually does the work. The
 * guard middlewares in front of it (rate limit, `protect`) are deliberately
 * skipped: this file is about the handler's decisions, and a JWT round trip
 * would test jsonwebtoken rather than the queue.
 */
function handler(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`no ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

/** Minimal req/res pair that records what a handler answered. */
function call(fn, { body = {}, query = {}, params = {}, user = { _id: 'u1', role: 'user' } } = {}) {
  return new Promise((resolve) => {
    const res = {
      // Express answers 200 unless a handler says otherwise, and several of
      // these handlers use a bare `res.json(...)` for success — so 200 is the
      // default here, not 0.
      statusCode: 200,
      payload: null,
      headers: {},
      set(k, v) { this.headers[k] = v; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; resolve(this); return this; },
      end() { resolve(this); },
      write() { return true; },
    };
    fn({ body, query, params, user, ip: '127.0.0.1', headers: {} }, res);
  });
}

// ── In-memory Mongo ────────────────────────────────────────────────────────
// Ids must be REAL 24-hex ObjectIds: the routes call mongoose.isValidObjectId
// before they do anything, and a fake "id1" would make every test assert 400.
const oid = (() => { let n = 0; return () => (++n).toString(16).padStart(24, '0'); })();

// A real 1×1 PNG, so the proof is a genuine base64 data URL throughout.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function newUser(overrides = {}) {
  return {
    _id: oid(), firstName: 'Jane', lastName: 'Doe', email: `jane${Math.random().toString(36).slice(2, 8)}@example.com`,
    accountRole: 'user', accountStatus: 'active',
    subscriptionActive: false, subscriptionPlan: 'free',
    subscriptionRecord: undefined,
    ...overrides,
  };
}

const db = { users: new Map(), requests: new Map() };
let adminBells = [];
let userNotices = [];

function resetDb() {
  db.users = new Map();
  db.requests = new Map();
  adminBells = [];
  userNotices = [];
}

/**
 * A chainable query stub covering every call shape these routes use.
 *
 * Two behaviours have to match Mongoose, because the approve route depends on
 * both:
 *   • `populate()` is STICKY — a later `.lean()` must still return the populated
 *     rows, not the raw ObjectIds. Otherwise every approval looks like "the
 *     account no longer exists".
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

/** Store a subscription request in the fake collection. */
function seedRequest(fields = {}) {
  const row = {
    _id: oid(), user: null, plan: 'annual', months: 1,
    currency: 'PHP', symbol: '₱', amountPhp: 699, amount: 699, formattedAmount: '₱699',
    reference: '', note: '', proof: PNG, proofMime: 'image/png',
    proofBytes: Buffer.byteLength(PNG, 'utf8'), status: 'pending',
    review: { by: '', at: null, note: '' },
    grantedPlan: null, grantedDays: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...fields,
  };
  db.requests.set(row._id, row);
  return row;
}

// ── Stubs ──────────────────────────────────────────────────────────────────
// Installed in a `before` hook, never at module load. Patching the Mongoose
// models as a side effect of `require` would leak into every other test file
// that shares this process, which is exactly the kind of green-suite-lies bug
// this file should not introduce.
const originals = {
  reqCreate: SubscriptionRequest.create,
  reqFindOne: SubscriptionRequest.findOne,
  reqFindById: SubscriptionRequest.findById,
  reqFind: SubscriptionRequest.find,
  reqFindOneAndUpdate: SubscriptionRequest.findOneAndUpdate,
  reqUpdateOne: SubscriptionRequest.updateOne,
  reqCount: SubscriptionRequest.countDocuments,
  reqAgg: SubscriptionRequest.aggregate,
  userFindById: User.findById,
  userFindByIdAndUpdate: User.findByIdAndUpdate,
  userFind: User.find,
  eventCreate: AdminEvent.create,
  notifyCreate: UserNotification.create,
};

function installStubs() {
  SubscriptionRequest.create = async (doc) => {
    const row = { _id: oid(), createdAt: new Date(), updatedAt: new Date(), review: { by: '', at: null, note: '' }, status: 'pending', grantedPlan: null, grantedDays: null, ...doc };
    db.requests.set(row._id, row);
    return asDoc(row);
  };
  SubscriptionRequest.findOne = (filter) => query(
    [...db.requests.values()].find((r) => matches(r, filter)) || null,
  );
  SubscriptionRequest.findById = (id) => query(db.requests.get(id) || null);
  SubscriptionRequest.find = (filter) => query(
    [...db.requests.values()].filter((r) => matches(r, filter))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  );
  // The real findOneAndUpdate returns a Query, so the route can chain
  // `.populate(...)` onto it. Returning a chainable here is what makes the
  // reject route's populate-then-read-the-user work.
  SubscriptionRequest.findOneAndUpdate = (filter, update) => {
    const q = query(null);
    q._set((async () => {
      const row = [...db.requests.values()].find((r) => matches(r, filter));
      if (!row) return null;
      const next = { ...row, ...(update.$set || {}) };
      db.requests.set(row._id, next);
      return asDoc(next);
    })());
    return q;
  };
  SubscriptionRequest.updateOne = async (filter, update) => {
    const row = [...db.requests.values()].find((r) => matches(r, filter));
    if (!row) return { matchedCount: 0 };
    db.requests.set(row._id, { ...row, ...(update.$set || {}) });
    return { matchedCount: 1 };
  };
  SubscriptionRequest.countDocuments = async (filter) =>
    [...db.requests.values()].filter((r) => matches(r, filter)).length;
  SubscriptionRequest.aggregate = async () => {
    const counts = { pending: 0, approved: 0, rejected: 0 };
    for (const r of db.requests.values()) if (r.status in counts) counts[r.status] += 1;
    return Object.entries(counts).map(([status, count]) => ({ _id: status, count }));
  };

  User.findById = (id) => query(db.users.get(id) || null);
  // findByIdAndUpdate returns a Query in Mongoose, and the subscription engine
  // chains `.select(...).lean()` onto it.
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

test.before(() => { installStubs(); resetDb(); });

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
  Object.assign(SubscriptionRequest, {
    create: originals.reqCreate, findOne: originals.reqFindOne, findById: originals.reqFindById,
    find: originals.reqFind, findOneAndUpdate: originals.reqFindOneAndUpdate,
    updateOne: originals.reqUpdateOne, countDocuments: originals.reqCount, aggregate: originals.reqAgg,
  });
  User.findById = originals.userFindById;
  User.findByIdAndUpdate = originals.userFindByIdAndUpdate;
  User.find = originals.userFind;
  AdminEvent.create = originals.eventCreate;
  UserNotification.create = originals.notifyCreate;
});

const submit = handler(subscriptionRoutes, 'post', '/requests');
const listMine = handler(subscriptionRoutes, 'get', '/requests');
const mineOne = handler(subscriptionRoutes, 'get', '/requests/:id');
const queueList = handler(adminRoutes, 'get', '/subscription-requests');
const queueOne = handler(adminRoutes, 'get', '/subscription-requests/:id');
const approve = handler(adminRoutes, 'post', '/subscription-requests/:id/approve');
const reject = handler(adminRoutes, 'post', '/subscription-requests/:id/reject');

const adminReq = { _id: oid(), alias: 'root', role: 'admin' };

/** Submit a request as `user` (defaults to a throwaway account id). */
function newRequest(overrides = {}, user = { _id: oid(), role: 'user' }) {
  return call(submit, { user, body: { plan: 'annual', months: 1, proof: PNG, ...overrides } });
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Submitting a request
// ══════════════════════════════════════════════════════════════════════════

test('a submitted request is stored, priced by the server, and granted nothing', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);

  // A tampered body claiming a ₱1 Premium purchase must not change what is owed.
  const res = await call(submit, {
    user,
    body: { plan: 'annual', months: 1, proof: PNG, amount: 1, amountPhp: 1, formattedAmount: '₱1', reference: 'TRX-1' },
  });

  assert.equal(res.statusCode, 201);
  const row = db.requests.get(res.payload.request._id);
  assert.equal(row.formattedAmount, '₱699', 'the client-supplied amount was trusted');
  assert.equal(row.amountPhp, 699);
  // The critical assertion: nothing about the SUBSCRIPTION changed.
  assert.equal(db.users.get(user._id).subscriptionActive, false);
  assert.equal(db.users.get(user._id).subscriptionPlan, 'free');
  // And the image is never echoed back in the create response.
  assert.equal(res.payload.request.proof, undefined);
  assert.equal(res.payload.request.hasProof, true);
});

// ── The receipt requirement follows the payment destination ──
//
// Whether a receipt is MANDATORY is not a constant: it is the inverse of "is
// there anywhere to send money" (paymentInstructions.receiptRequired). Both
// halves matter, and this test used to assert only the one that made the flow
// unusable.
//
// The old test asserted unconditionally that a proof-less request is a 400. That
// is right when a bank account is configured and catastrophically wrong when one
// is not: with no destination the pricing page tells the member "there is nothing
// to transfer to, send an administrator a request" — and then refuses the request
// because the receipt is missing. The member is blocked from sending the one
// message the product asked them to send.

/** Run `fn` with a transfer destination configured (receipt mandatory). */
function withPaymentDestination(fn) {
  const before = process.env.PAYMENT_ACCOUNT_NUMBER;
  process.env.PAYMENT_ACCOUNT_NUMBER = '1234567890';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (before === undefined) delete process.env.PAYMENT_ACCOUNT_NUMBER;
      else process.env.PAYMENT_ACCOUNT_NUMBER = before;
    });
}

/** Run `fn` with no destination at all (receipt optional). */
function withoutPaymentDestination(fn) {
  const saved = ['PAYMENT_ACCOUNT_NUMBER', 'PAYMENT_INSTRUCTIONS'];
  const before = saved.map((k) => [k, process.env[k]]);
  saved.forEach((k) => { delete process.env[k]; });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      before.forEach(([k, v]) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    });
}

test('with a payment destination configured, a receipt is still mandatory', async () => {
  await withPaymentDestination(async () => {
    resetDb();
    const res = await newRequest({ proof: undefined });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.message, /screenshot|proof/i);
    assert.equal(db.requests.size, 0);
  });
});

test('with NO payment destination, a proof-less request is accepted rather than dead-ending', async () => {
  await withoutPaymentDestination(async () => {
    resetDb();
    const user = newUser();
    db.users.set(user._id, user);

    const res = await call(submit, { user, body: { plan: 'annual', months: 1 } });
    assert.equal(res.statusCode, 201, 'the member must be able to send the request');
    const row = db.requests.get(res.payload.request._id);
    assert.equal(row.proof, '');
    assert.equal(row.paymentRequired, false, 'the record explains why there is no receipt');
    // Still grants nothing — a request is a request.
    assert.equal(db.users.get(user._id).subscriptionActive, false);
    // And it does not pretend a payment was reviewed.
    assert.doesNotMatch(res.payload.message, /review your payment/i);
  });
});

test('the no-destination path never loosens what a SUPPLIED receipt must be', async () => {
  await withoutPaymentDestination(async () => {
    resetDb();
    const user = newUser();
    db.users.set(user._id, user);

    // An SVG is still refused: "no receipt required" must not become
    // "anything goes".
    const svg = await call(submit, { user, body: { plan: 'annual', proof: 'data:image/svg+xml;base64,PHN2Zz4=' } });
    assert.equal(svg.statusCode, 400);
    assert.equal(db.requests.size, 0);

    // …and a genuine receipt is still accepted and still recorded as required=false
    // so the reviewer can see it was voluntary.
    const ok = await call(submit, { user, body: { plan: 'custom', proof: PNG } });
    assert.equal(ok.statusCode, 201);
    assert.equal(db.requests.get(ok.payload.request._id).paymentRequired, false);
  });
});

test('a proof-less annual request still prices from the catalogue and still grants nothing', async () => {
  await withoutPaymentDestination(async () => {
    resetDb();
    const user = newUser();
    db.users.set(user._id, user);

    const res = await call(submit, { user, body: { plan: 'annual', months: 1 } });
    assert.equal(res.statusCode, 201);
    const row = db.requests.get(res.payload.request._id);
    // The amount is the catalogue's, computed server-side — never read from the
    // body, so a client that posted its own figure could not change it.
    const entry = require('../utils/planCatalogue').findEntry('annual');
    assert.equal(row.amountPhp, entry.monthly);
    assert.equal(row.formattedAmount, `₱${entry.monthly.toLocaleString('en-US')}`);
    // A request is a CLAIM, not a purchase: submitting one grants nothing. The
    // subscription only moves when an admin approves it.
    assert.equal(db.users.get(user._id).subscriptionActive, false);
  });
});

test('a non-image receipt, the Free plan and a removed Team id are each refused with 400', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);

  const svg = await call(submit, { user, body: { plan: 'annual', proof: 'data:image/svg+xml;base64,PHN2Zz4=' } });
  assert.equal(svg.statusCode, 400);

  const free = await call(submit, { user, body: { plan: 'free', proof: PNG } });
  assert.equal(free.statusCode, 400);
  assert.match(free.payload.message, /already yours/);

  // "team" is gone. A stale client must get a refusal, NOT a silently accepted
  // single annual request — that would bill a five-seat order as one seat and
  // queue it looking like a real purchase.
  for (const seats of [1, 4, 25]) {
    const team = await call(submit, { user, body: { plan: 'team', seats, proof: PNG } });
    assert.equal(team.statusCode, 400, `seats=${seats}`);
    assert.match(team.payload.message, /valid plan/i);
  }
  assert.equal(db.requests.size, 0, 'a rejected request must not be stored');
});

test('a request body cannot smuggle a seat count past the validator', async () => {
  // A stale client may still POST the old Team fields. They must be inert: the
  // price comes from the catalogue for the named plan and nothing multiplies it,
  // and none of the removed keys may be stored.
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);

  const res = await call(submit, { user, body: { plan: 'annual', seats: 999, isTeam: true, proof: PNG } });
  assert.equal(res.statusCode, 201);
  const row = db.requests.get(res.payload.request._id);
  const entry = require('../utils/planCatalogue').findEntry('annual');
  assert.equal(row.amountPhp, entry.monthly, 'the seat count must not multiply the price');
  assert.equal('seats' in row, false);
  assert.equal('isTeam' in row, false);
});

test('a second open request for the same plan is refused, and names the plan', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);

  assert.equal((await newRequest({ plan: 'monthly' }, user)).statusCode, 201);
  const second = await newRequest({ plan: 'monthly' }, user);
  assert.equal(second.statusCode, 409);
  assert.equal(second.payload.code, 'DUPLICATE_REQUEST');
  assert.equal(db.requests.size, 1);

  // A DIFFERENT plan is a different request.
  assert.equal((await newRequest({ plan: 'annual' }, user)).statusCode, 201);
  assert.equal((await newRequest({ plan: 'custom' }, user)).statusCode, 201);
});

test('an admin token cannot submit a member request', async () => {
  resetDb();
  const res = await call(submit, { user: adminReq, body: { plan: 'annual', proof: PNG } });
  assert.equal(res.statusCode, 403);
});

test('the request is announced on the admin bell with the amount and the plan', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  await newRequest({ plan: 'custom', months: 12 }, user);

  assert.equal(adminBells.length, 1);
  assert.equal(adminBells[0].type, 'subscription-request');
  // Ultimate billed yearly — the amount is the server's, and the bell is the
  // only place a reviewer sees it before opening the receipt.
  assert.match(adminBells[0].detail, /₱1,800/);
  assert.equal(adminBells[0].linkUserId, user._id);
});

test('a member can only read their OWN request', async () => {
  resetDb();
  const alice = newUser();
  const bob = newUser();
  db.users.set(alice._id, alice);
  db.users.set(bob._id, bob);
  const row = seedRequest({ user: alice._id });

  const mine = await call(mineOne, { user: alice, params: { id: row._id } });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.payload.request.proof, PNG, 'the owner must be able to see what they sent');

  // 404, not 403: the endpoint cannot be used to probe for valid ids.
  const theirs = await call(mineOne, { user: bob, params: { id: row._id } });
  assert.equal(theirs.statusCode, 404);

  const bad = await call(mineOne, { user: alice, params: { id: 'nope' } });
  assert.equal(bad.statusCode, 400);
});

test('my-requests list carries no image and reports the pending count', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  await newRequest({ plan: 'monthly' }, user);
  await newRequest({ plan: 'annual' }, user);

  const res = await call(listMine, { user });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.requests.length, 2);
  assert.equal(res.payload.pendingCount, 2);
  for (const row of res.payload.requests) assert.equal(row.proof, undefined);
});

// ══════════════════════════════════════════════════════════════════════════
// 2. The admin queue
// ══════════════════════════════════════════════════════════════════════════

test('the queue lists requests without the image and with per-status counts', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  seedRequest({ user: user._id, status: 'pending' });
  seedRequest({ user: user._id, status: 'approved' });
  seedRequest({ user: user._id, status: 'rejected' });

  const res = await call(queueList, { user: adminReq, query: { status: 'all' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.requests.length, 3);
  assert.deepEqual(res.payload.counts, { pending: 1, approved: 1, rejected: 1 });
  for (const row of res.payload.requests) assert.equal(row.proof, undefined);
  assert.equal(res.payload.requests[0].userLabel.includes('Jane Doe'), true);
});

test('the queue defaults to pending and rejects an unknown status', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  seedRequest({ user: user._id, status: 'pending' });
  seedRequest({ user: user._id, status: 'approved' });

  const res = await call(queueList, { user: adminReq, query: {} });
  assert.equal(res.payload.requests.length, 1);
  assert.equal(res.payload.requests[0].status, 'pending');

  const bad = await call(queueList, { user: adminReq, query: { status: 'sideways' } });
  assert.equal(bad.statusCode, 400);
});

test('a search that matches nobody returns an empty page, not every request', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  seedRequest({ user: user._id });

  const res = await call(queueList, { user: adminReq, query: { status: 'all', search: 'zzz-nobody' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.requests, []);
});

test('a search regex metacharacter is treated as text, not as a pattern', async () => {
  resetDb();
  const user = newUser({ email: 'a.b@example.com' });
  db.users.set(user._id, user);
  seedRequest({ user: user._id });

  // "." would match any character if it were not escaped, so this must NOT find
  // the literal-dot address.
  const res = await call(queueList, { user: adminReq, query: { status: 'all', search: 'aXb@example.com' } });
  assert.deepEqual(res.payload.requests, []);
  const hit = await call(queueList, { user: adminReq, query: { status: 'all', search: 'a.b@example.com' } });
  assert.equal(hit.payload.requests.length, 1);
});

test('the single-request detail endpoint is the only response that carries the image', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id });

  const res = await call(queueOne, { user: adminReq, params: { id: row._id } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.request.proof, PNG);
  assert.equal(res.payload.request.planLabel, 'PREMIUM');
});

test('a request is labelled by the tier it grants, never by a seat count', async () => {
  // A reviewer approves on the strength of this label, so it must name the plan
  // they are about to grant. It used to read "6× Team" for an order that stored
  // `plan: 'annual'` — a label describing a product that no longer exists.
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id, plan: 'annual', formattedAmount: '₱4,194' });

  const res = await call(queueOne, { user: adminReq, params: { id: row._id } });
  assert.equal(res.payload.request.planLabel, 'PREMIUM');
  // Not "6× Team", and not a label derived from any stored count: the reviewer
  // is about to grant exactly what this label says.
  assert.doesNotMatch(res.payload.request.planLabel, /Team|×/i);
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Approving — the only thing that grants a plan
// ══════════════════════════════════════════════════════════════════════════

test('approving grants the plan for the requested term and tells the member', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id, plan: 'annual', months: 1 });

  const res = await call(approve, { user: adminReq, params: { id: row._id }, body: {} });
  assert.equal(res.statusCode, 200);

  const granted = db.users.get(user._id);
  assert.equal(granted.subscriptionPlan, 'annual');
  assert.equal(granted.subscriptionActive, true);
  // A 1-month request is 30 days.
  const days = Math.round((new Date(granted.subscriptionExpiresAt) - Date.now()) / 86_400_000);
  assert.ok(Math.abs(days - 30) <= 1, `expected ~30 days, got ${days}`);

  assert.equal(db.requests.get(row._id).status, 'approved');
  assert.equal(db.requests.get(row._id).review.by, 'root');
  assert.equal(db.requests.get(row._id).grantedDays, 30);

  assert.equal(userNotices.length, 1);
  assert.equal(userNotices[0].user, user._id);
  assert.match(userNotices[0].detail, /active/i);
});

test('approving a 12-month request grants a year, not a month', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id, plan: 'annual', months: 12 });

  await call(approve, { user: adminReq, params: { id: row._id }, body: {} });
  assert.equal(db.requests.get(row._id).grantedDays, 360);
});

test('an explicit day override is honoured but bounded', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id });

  const res = await call(approve, { user: adminReq, params: { id: row._id }, body: { days: 99999 } });
  assert.equal(res.statusCode, 200);
  assert.equal(db.requests.get(row._id).grantedDays, 3650, 'an approval must not mint a decade');
});

test('an approval writes one plan and no seat count', async () => {
  // Approval is the only thing that grants a plan, so it is the last place a
  // removed field could still be written. Asserted on the stored record, not just
  // the response: a field persisted here and read elsewhere is the failure mode
  // the whole removal was meant to end.
  //
  // The seeded row deliberately carries the OLD Team fields, so this also proves
  // the approve route ignores them rather than granting 8 seats.
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id, plan: 'annual', isTeam: true, seats: 8 });

  const res = await call(approve, { user: adminReq, params: { id: row._id }, body: {} });
  assert.equal(res.statusCode, 200);
  const granted = db.users.get(user._id);
  assert.equal(granted.subscriptionPlan, 'annual');
  assert.equal('seats' in granted.subscriptionRecord.paid, false);
  assert.equal('isTeam' in granted.subscriptionRecord.paid, false);
  assert.equal('subscriptionSeats' in granted, false);
});

test('approving twice is refused, and the plan is granted exactly once', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id, plan: 'annual', months: 1 });

  assert.equal((await call(approve, { user: adminReq, params: { id: row._id } })).statusCode, 200);
  const afterFirst = db.users.get(user._id).subscriptionExpiresAt;

  const second = await call(approve, { user: adminReq, params: { id: row._id } });
  assert.equal(second.statusCode, 409);
  assert.equal(second.payload.code, 'ALREADY_REVIEWED');
  // The window must not have been extended by the second press.
  assert.equal(db.users.get(user._id).subscriptionExpiresAt, afterFirst);
});

test('two admins approving at once produce ONE grant', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id, plan: 'annual', months: 1 });

  // Fired without awaiting each other, which is what two browsers do.
  const results = await Promise.all([
    call(approve, { user: adminReq, params: { id: row._id } }),
    call(approve, { user: { _id: oid(), alias: 'second', role: 'admin' }, params: { id: row._id } }),
  ]);
  const ok = results.filter((r) => r.statusCode === 200);
  const conflict = results.filter((r) => r.statusCode === 409);
  assert.equal(ok.length, 1, 'exactly one approval may succeed');
  assert.equal(conflict.length, 1);

  const granted = db.users.get(user._id);
  const days = Math.round((new Date(granted.subscriptionExpiresAt) - Date.now()) / 86_400_000);
  assert.ok(Math.abs(days - 30) <= 1, `a double approval doubled the term to ${days} days`);
  assert.equal(userNotices.length, 1, 'the member was told once, not twice');
});

test('approving a request whose account is gone closes it instead of stranding it', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id });
  db.users.delete(user._id);

  const res = await call(approve, { user: adminReq, params: { id: row._id } });
  assert.equal(res.statusCode, 404);
  // Closed out, so it stops inflating the queue's pending badge forever.
  assert.equal(db.requests.get(row._id).status, 'rejected');
});

test('approving a request that does not exist is a 404, and a bad id a 400', async () => {
  resetDb();
  assert.equal((await call(approve, { user: adminReq, params: { id: 'nope' } })).statusCode, 400);
  assert.equal((await call(approve, { user: adminReq, params: { id: oid() } })).statusCode, 404);
});

// ══════════════════════════════════════════════════════════════════════════
// 4. Rejecting
// ══════════════════════════════════════════════════════════════════════════

test('rejecting closes the request, tells the member why, and changes no plan', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id, plan: 'annual' });

  const res = await call(reject, { user: adminReq, params: { id: row._id }, body: { note: 'Reference not found' } });
  assert.equal(res.statusCode, 200);
  assert.equal(db.requests.get(row._id).status, 'rejected');
  assert.equal(db.requests.get(row._id).review.note, 'Reference not found');
  // A rejection must never take access away.
  assert.equal(db.users.get(user._id).subscriptionPlan, 'free');
  assert.equal(userNotices.length, 1);
  assert.match(userNotices[0].detail, /Reference not found/);
});

test('rejecting twice is refused', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id });

  assert.equal((await call(reject, { user: adminReq, params: { id: row._id } })).statusCode, 200);
  const second = await call(reject, { user: adminReq, params: { id: row._id } });
  assert.equal(second.statusCode, 409);
});

test('a declined request cannot then be approved', async () => {
  resetDb();
  const user = newUser();
  db.users.set(user._id, user);
  const row = seedRequest({ user: user._id });

  await call(reject, { user: adminReq, params: { id: row._id } });
  const late = await call(approve, { user: adminReq, params: { id: row._id } });
  assert.equal(late.statusCode, 409);
  assert.equal(db.users.get(user._id).subscriptionPlan, 'free');
});
