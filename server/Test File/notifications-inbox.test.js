/**
 * Notification inbox — "delete all read" and the dismissal semantics it needs.
 *
 * The panel now offers a second destructive action next to "mark all as read",
 * and that action is the interesting one: a hard delete of a severe-flag row
 * lets the GET backfill rebuild it as unread on the very next poll, so the bell
 * would re-light itself the moment the user cleared the read history. These
 * tests pin the behaviour that prevents that, and the read/unread bookkeeping
 * both bells depend on.
 *
 *   1. THE INBOX     — dismissed rows are hidden, only live rows are counted
 *   2. MARK ALL READ — unread flips to read, dismissed stays dismissed
 *   3. DELETE-READ   — read rows go, unread rows stay, count is reported
 *   4. THE BACKFILL  — a read or dismissed flag is never re-created as unread
 *   5. DISMISSAL     — the × is idempotent and owner-scoped
 *   6. RETENTION     — old dismissed rows are reclaimed, not kept forever
 *   7. ROLE GATING   — an admin token never reaches the member inbox
 *   8. THE ADMIN BELL— read state is resolved per admin; delete-read is scoped
 *
 * The REAL routers are driven over real HTTP with the models backed by an
 * in-memory store, so the assertions are about status codes and what ended up
 * in the database. No MongoDB, no network, no fixtures on disk.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');

const Assessment = require('../models/Assessment');
const UserNotification = require('../models/UserNotification');
const AdminEvent = require('../models/AdminEvent');

// `protect`/`adminOnly` are destructured at import time by both routers, so they
// have to be replaced in the module cache BEFORE the routers are required. The
// per-request middleware below owns req.user instead, so a "member may / admin
// may not" assertion is never pinned to one identity.
const authPath = require.resolve('../middleware/auth');
const realAuth = require(authPath);
require.cache[authPath].exports = {
  ...realAuth,
  protect: (req, res, next) => next(),
  adminOnly: (req, res, next) => next(),
};

const notificationRouter = require('../routes/notifications');
const adminRouter = require('../routes/admin');

// ── Test harness ──────────────────────────────────────────────────────────

const oid = () => new mongoose.Types.ObjectId();
const key = (v) => (v === undefined || v === null ? null : String(v));
const add = (a, b) => (a == null || b == null ? a : a + b);
const DAY = 24 * 60 * 60 * 1000;

/** Minimal Mongo filter matcher: equality plus the operators these routes use. */
function matches(doc, filter = {}) {
  for (const [field, cond] of Object.entries(filter || {})) {
    const isOperatorObject =
      cond !== null && typeof cond === 'object' && !Array.isArray(cond) &&
      !(cond instanceof Date) && !(cond instanceof mongoose.Types.ObjectId);
    if (isOperatorObject) {
      const actual = doc[field] instanceof Date ? doc[field].getTime() : key(doc[field]);
      for (const [op, val] of Object.entries(cond)) {
        if (op === '$ne') {
          // $ne against an array field means "does not contain".
          const list = Array.isArray(doc[field]) ? doc[field].map(key) : null;
          if (list ? list.includes(key(val)) : key(doc[field]) === key(val)) return false;
        }
        if (op === '$in' && !(Array.isArray(doc[field]) ? doc[field] : [doc[field]]).map(key).includes(key(val))) return false;
        if (op === '$gt' && !(actual > (val instanceof Date ? val.getTime() : key(val)))) return false;
        if (op === '$lt' && !(actual < (val instanceof Date ? val.getTime() : key(val)))) return false;
      }
      continue;
    }
    // A scalar condition against an array field means "contains" — without
    // this, `String([a, b])` === "a,b" would miss every multi-element match.
    if (Array.isArray(doc[field])) {
      if (!doc[field].map(key).includes(key(cond))) return false;
      continue;
    }
    if (key(doc[field]) !== key(cond)) return false;
  }
  return true;
}

/** Mongoose update semantics: operators plus a flat object as an implicit $set. */
function applyUpdate(doc, update) {
  if (!update) return doc;
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$addToSet) {
    for (const [field, value] of Object.entries(update.$addToSet)) {
      const list = Array.isArray(doc[field]) ? doc[field] : [];
      if (!list.map(key).includes(key(value))) doc[field] = [...list, value];
    }
  }
  const flat = { ...update };
  for (const op of Object.keys(flat)) if (op.startsWith('$')) delete flat[op];
  Object.assign(doc, flat);
  return doc;
}

/** Newest-first, the order every inbox query asks for. */
function applySort(rows, spec) {
  if (!spec || !Array.isArray(rows)) return rows;
  const fields = Object.entries(spec);
  return [...rows].sort((a, b) => {
    for (const [field, direction] of fields) {
      const av = a[field] instanceof Date ? a[field].getTime() : a[field];
      const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
      if (av < bv) return -1 * direction;
      if (av > bv) return 1 * direction;
    }
    return 0;
  });
}

/** A chainable, awaitable stand-in for a Mongoose query. */
function chain(result) {
  let rows = Array.isArray(result) ? [...result] : result;
  let sortSpec = null;
  const q = {
    select: () => q,
    sort: (spec) => { sortSpec = spec; return q; },
    skip: (n) => { if (Array.isArray(rows)) rows = rows.slice(n); return q; },
    limit: (n) => { if (Array.isArray(rows)) rows = rows.slice(0, n); return q; },
    lean: () => Promise.resolve(applySort(rows, sortSpec)),
    then: (onFulfilled, onRejected) => Promise.resolve(applySort(rows, sortSpec)).then(onFulfilled, onRejected),
  };
  return q;
}

function makeStore() {
  return {
    assessments: [],
    notifications: [],
    events: [],
    users: {
      member: { _id: oid(), role: 'user', email: 'member@example.com' },
      other: { _id: oid(), role: 'user', email: 'other@example.com' },
      admin: { _id: oid(), role: 'admin', email: 'admin@example.com' },
      admin2: { _id: oid(), role: 'admin', email: 'admin2@example.com' },
    },
  };
}

function installFakes(store) {
  const saved = [];
  const stub = (obj, name, fn) => { saved.push([obj, name, obj[name]]); obj[name] = fn; };

  stub(Assessment, 'find', (filter) => chain(store.assessments.filter((a) => matches(a, filter))));

  stub(UserNotification, 'find', (filter) => chain(store.notifications.filter((n) => matches(n, filter))));
  stub(UserNotification, 'insertMany', async (docs) => {
    const created = docs.map((doc) => ({
      _id: oid(), read: false, dismissed: false, createdAt: new Date(), ...doc,
    }));
    store.notifications.push(...created);
    return created;
  });
  stub(UserNotification, 'countDocuments', async (filter) =>
    store.notifications.filter((n) => matches(n, filter)).length);
  stub(UserNotification, 'findOneAndUpdate', (filter, update) => {
    const doc = store.notifications.find((n) => matches(n, filter));
    if (!doc) return chain(null);
    applyUpdate(doc, update);
    return chain({ ...doc });
  });
  stub(UserNotification, 'updateMany', async (filter, update) => {
    let modified = 0;
    for (const doc of store.notifications) {
      if (!matches(doc, filter)) continue;
      applyUpdate(doc, update);
      modified += 1;
    }
    return { modifiedCount: modified };
  });
  stub(UserNotification, 'deleteMany', async (filter) => {
    const before = store.notifications.length;
    store.notifications = store.notifications.filter((n) => !matches(n, filter));
    return { deletedCount: before - store.notifications.length };
  });

  stub(AdminEvent, 'find', (filter) => chain(store.events.filter((e) => matches(e, filter))));
  stub(AdminEvent, 'updateMany', async (filter, update) => {
    let modified = 0;
    for (const doc of store.events) {
      if (!matches(doc, filter)) continue;
      applyUpdate(doc, update);
      modified += 1;
    }
    return { modifiedCount: modified };
  });
  stub(AdminEvent, 'deleteMany', async (filter) => {
    const before = store.events.length;
    store.events = store.events.filter((e) => !matches(e, filter));
    return { deletedCount: before - store.events.length };
  });
  stub(AdminEvent, 'findByIdAndDelete', async (id) => {
    const i = store.events.findIndex((e) => key(e._id) === key(id));
    return i < 0 ? null : store.events.splice(i, 1)[0];
  });

  return () => { for (const [obj, name, original] of saved) obj[name] = original; };
}

/** Seed one member notification row. */
function seedNotification(store, {
  user = store.users.member, type = 'info', title = 'Heads up', read = false,
  dismissed = false, createdAt = new Date(), assessmentId = null,
} = {}) {
  const doc = {
    _id: oid(), user: user._id, type, title, detail: '', read, dismissed, assessmentId,
    createdAt, updatedAt: createdAt,
  };
  store.notifications.push(doc);
  return doc;
}

/** Seed one admin audit row; `readBy` lists the admins who have seen it. */
function seedEvent(store, { title = 'Subscription grant', readBy = [], createdAt = new Date(), type = 'subscription' } = {}) {
  const doc = { _id: oid(), type, title, detail: 'Sub Admin — FREE (NONE), source FREE.', user: null, readBy: [...readBy], createdAt, updatedAt: createdAt };
  store.events.push(doc);
  return doc;
}

async function withStore(fn) {
  const store = makeStore();
  const restore = installFakes(store);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.get('x-test-user');
    req.user = who ? store.users[who] : undefined;
    next();
  });
  app.use('/api/notifications', notificationRouter);
  app.use('/api/admin', adminRouter);
  app.use((err, _req, res, _next) => {
    res.status((err && (err.status || err.statusCode)) || 500).json({ message: 'Unexpected error.' });
  });

  const server = app.listen(0);
  const { port } = server.address();

  const call = async (path, { as = 'member', method = 'GET', body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'x-test-user': as,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  };

  try {
    await fn({ call, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
}

// ── 1. The inbox ──────────────────────────────────────────────────────────

test('the inbox hides dismissed rows and only counts live unread ones', async () => {
  await withStore(async ({ call, store }) => {
    const shown = seedNotification(store, { title: 'Live' });
    seedNotification(store, { title: 'Gone', dismissed: true });

    const { status, body } = await call('/api/notifications');
    assert.equal(status, 200);
    assert.deepEqual(body.notifications.map((n) => n.title), ['Live']);
    assert.equal(body.unreadCount, 1);
    assert.equal(key(body.notifications[0]._id), key(shown._id));
  });
});

// ── 2. Mark all as read ───────────────────────────────────────────────────

test('mark all as read flips every unread row and leaves dismissed ones alone', async () => {
  await withStore(async ({ call, store }) => {
    seedNotification(store, { title: 'A' });
    seedNotification(store, { title: 'B' });
    const stale = seedNotification(store, { title: 'C', read: true, dismissed: true });

    const { status } = await call('/api/notifications/read-all', { method: 'POST' });
    assert.equal(status, 200);
    assert.ok(store.notifications.every((n) => n.read));
    assert.equal(stale.dismissed, true, 'a dismissed row stays dismissed');
  });
});

// ── 3. Delete all read ────────────────────────────────────────────────────

test('delete all read clears the read rows, keeps the unread ones and reports the count', async () => {
  await withStore(async ({ call, store }) => {
    seedNotification(store, { title: 'Read 1', read: true });
    seedNotification(store, { title: 'Read 2', read: true });
    seedNotification(store, { title: 'Unread' });

    const { status, body } = await call('/api/notifications/delete-read', { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(body.deletedCount, 2);
    // Dismissed, not destroyed — the row survives so the flag backfill can
    // still tell "seen" from "never existed".
    assert.deepEqual(store.notifications.filter((n) => !n.dismissed).map((n) => n.title), ['Unread']);
    assert.equal(store.notifications.filter((n) => n.dismissed).length, 2);

    // The next inbox read reflects it, and the badge is untouched.
    const inbox = await call('/api/notifications');
    assert.deepEqual(inbox.body.notifications.map((n) => n.title), ['Unread']);
    assert.equal(inbox.body.unreadCount, 1);
  });
});

test('delete all read on a fully-read inbox reports zero and is safe to repeat', async () => {
  await withStore(async ({ call, store }) => {
    seedNotification(store, { title: 'Only', read: true });

    const first = await call('/api/notifications/delete-read', { method: 'POST' });
    assert.equal(first.status, 200);
    assert.equal(first.body.deletedCount, 1);

    const second = await call('/api/notifications/delete-read', { method: 'POST' });
    assert.equal(second.status, 200);
    assert.equal(second.body.deletedCount, 0, 'a second press is a no-op, not an error');

    const inbox = await call('/api/notifications');
    assert.deepEqual(inbox.body.notifications, []);
    assert.equal(inbox.body.unreadCount, 0);
  });
});

test('delete all read only ever touches the caller rows', async () => {
  await withStore(async ({ call, store }) => {
    const mine = seedNotification(store, { title: 'Mine', read: true });
    const theirs = seedNotification(store, { user: store.users.other, title: 'Theirs', read: true });

    await call('/api/notifications/delete-read', { method: 'POST' });
    assert.equal(mine.dismissed, true);
    assert.equal(theirs.dismissed, false, "another member's read row is not the caller's to clear");
  });
});

// ── 4. The backfill must not resurrect a dismissed flag ───────────────────

test('a severe flag that was marked read is not rebuilt as unread', async () => {
  await withStore(async ({ call, store }) => {
    const assessment = { _id: oid(), user: store.users.member._id, priority: 'Priority', flagReasons: ['severe'], flaggedAt: new Date(), createdAt: new Date() };
    store.assessments.push(assessment);
    seedNotification(store, { type: 'severe-flag', title: 'Health review flagged for your assessment', read: true, assessmentId: assessment._id });

    await call('/api/notifications');
    await call('/api/notifications/read-all', { method: 'POST' });
    await call('/api/notifications/delete-read', { method: 'POST' });

    // The read history is gone, but the member already dealt with the flag.
    const inbox = await call('/api/notifications');
    assert.deepEqual(inbox.body.notifications, [], 'no resurrection after mark-read + delete-read');
    assert.equal(inbox.body.unreadCount, 0);
  });
});

test('a Priority assessment with no notification at all still gets one', async () => {
  await withStore(async ({ call, store }) => {
    store.assessments.push({ _id: oid(), user: store.users.member._id, priority: 'Priority', flagReasons: [], flaggedAt: new Date(), createdAt: new Date() });

    const inbox = await call('/api/notifications');
    assert.equal(inbox.body.notifications.length, 1);
    assert.equal(inbox.body.notifications[0].type, 'severe-flag');
    assert.equal(inbox.body.notifications[0].read, false);
    assert.equal(inbox.body.unreadCount, 1);
  });
});

test('another member Priority assessment never leaks into this inbox', async () => {
  await withStore(async ({ call, store }) => {
    store.assessments.push({ _id: oid(), user: store.users.other._id, priority: 'Priority', flagReasons: [], flaggedAt: new Date(), createdAt: new Date() });

    const inbox = await call('/api/notifications');
    assert.deepEqual(inbox.body.notifications, []);
  });
});

// ── 5. Dismissal ──────────────────────────────────────────────────────────

test('deleting a row dismisses it and a second delete is a 404', async () => {
  await withStore(async ({ call, store }) => {
    const doc = seedNotification(store, { title: 'Bye' });

    const first = await call(`/api/notifications/${doc._id}`, { method: 'DELETE' });
    assert.equal(first.status, 200);
    assert.equal(doc.dismissed, true, 'the row is kept, flagged dismissed');

    const second = await call(`/api/notifications/${doc._id}`, { method: 'DELETE' });
    assert.equal(second.status, 404);
  });
});

test('a member cannot read or delete another member row', async () => {
  await withStore(async ({ call, store }) => {
    const theirs = seedNotification(store, { user: store.users.other, title: 'Theirs' });

    assert.equal((await call(`/api/notifications/${theirs._id}/read`, { method: 'PATCH' })).status, 404);
    assert.equal((await call(`/api/notifications/${theirs._id}`, { method: 'DELETE' })).status, 404);
    assert.equal(theirs.read, false);
    assert.equal(theirs.dismissed, false);
  });
});

test('a malformed notification id is a 400, not a 500', async () => {
  await withStore(async ({ call }) => {
    assert.equal((await call('/api/notifications/not-an-id/read', { method: 'PATCH' })).status, 400);
    assert.equal((await call('/api/notifications/not-an-id', { method: 'DELETE' })).status, 400);
  });
});

// ── 6. Retention ──────────────────────────────────────────────────────────

test('dismissed rows past the retention window are reclaimed, fresh ones are kept', async () => {
  await withStore(async ({ call, store }) => {
    const old = new Date(Date.now() - 40 * DAY);
    seedNotification(store, { title: 'Ancient', read: true, dismissed: true, createdAt: old });
    seedNotification(store, { title: 'Recent dismissed', read: true, dismissed: true });

    await call('/api/notifications/delete-read', { method: 'POST' });
    assert.deepEqual(store.notifications.map((n) => n.title), ['Recent dismissed']);
  });
});

// ── 7. Role gating ────────────────────────────────────────────────────────

test('an admin token is refused by every member inbox route', async () => {
  await withStore(async ({ call, store }) => {
    const doc = seedNotification(store, { title: 'A member row' });
    for (const [path, method] of [
      ['/api/notifications', 'GET'],
      ['/api/notifications/read-all', 'POST'],
      ['/api/notifications/delete-read', 'POST'],
      [`/api/notifications/${doc._id}`, 'DELETE'],
    ]) {
      assert.equal((await call(path, { as: 'admin', method })).status, 403, `${method} ${path}`);
    }
    assert.equal(doc.dismissed, false);
  });
});

// ── 8. The admin bell ─────────────────────────────────────────────────────

test('the admin bell resolves read state per admin and flags live rows undismissable', async () => {
  await withStore(async ({ call, store }) => {
    const { admin, admin2 } = store.users;
    seedEvent(store, { title: 'Seen by admin only', readBy: [admin._id] });
    seedEvent(store, { title: 'Seen by nobody' });

    const mine = await call('/api/admin/notifications', { as: 'admin' });
    assert.equal(mine.status, 200);
    const byTitle = Object.fromEntries(mine.body.notifications.map((n) => [n.title, n]));
    assert.equal(byTitle['Seen by admin only'].read, true);
    assert.equal(byTitle['Seen by admin only'].dismissible, true);
    assert.equal(byTitle['Seen by nobody'].read, false);
    // Config warnings are synthesised per request: no id, nothing to dismiss.
    const live = mine.body.notifications.filter((n) => !n._id);
    assert.ok(live.every((n) => n.dismissible === false && n.read === false));
    assert.equal(mine.body.unreadCount, mine.body.notifications.filter((n) => !n.read).length);

    // The other admin has seen neither — read state is not global.
    const theirs = await call('/api/admin/notifications', { as: 'admin2' });
    assert.equal(theirs.body.notifications.find((n) => n.title === 'Seen by admin only').read, false);
    assert.equal(theirs.body.notifications.find((n) => n.title === 'Seen by nobody').read, false);
  });
});

test('admin delete-read only removes rows the calling admin has read', async () => {
  await withStore(async ({ call, store }) => {
    const { admin, admin2 } = store.users;
    const seenByBoth = seedEvent(store, { title: 'Read by both', readBy: [admin._id, admin2._id] });
    const seenByOther = seedEvent(store, { title: 'Read by admin2', readBy: [admin2._id] });
    const unseen = seedEvent(store, { title: 'Unread' });

    const { status, body } = await call('/api/admin/notifications/delete-read', { as: 'admin', method: 'POST' });
    assert.equal(status, 200);
    assert.equal(body.deletedCount, 1);
    assert.deepEqual(store.events.map((e) => e.title), ['Read by admin2', 'Unread']);
    assert.equal(store.events.includes(seenByBoth), false);
    assert.equal(store.events.includes(seenByOther), true);
    assert.equal(store.events.includes(unseen), true);
  });
});

test('admin mark all read is per-admin and leaves the other admin unread', async () => {
  await withStore(async ({ call, store }) => {
    const { admin, admin2 } = store.users;
    const doc = seedEvent(store, { title: 'Audit row' });

    assert.equal((await call('/api/admin/notifications/read-all', { as: 'admin', method: 'POST' })).status, 200);
    assert.deepEqual(doc.readBy.map(key), [key(admin._id)]);

    const inbox = await call('/api/admin/notifications', { as: 'admin2' });
    assert.equal(inbox.body.notifications.find((n) => n._id).read, false);
  });
});

test('admin mark-read rejects a malformed id list before touching the database', async () => {
  await withStore(async ({ call, store }) => {
    const doc = seedEvent(store, { title: 'Untouched' });
    for (const body of [{ notificationIds: [] }, { notificationIds: 'nope' }, { notificationIds: [{ $ne: null }] }]) {
      assert.equal((await call('/api/admin/notifications/read', { as: 'admin', method: 'POST', body })).status, 400);
    }
    assert.deepEqual(doc.readBy, []);
  });
});
