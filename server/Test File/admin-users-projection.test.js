'use strict';
/**
 * Contract check: the admin Users grid <-> GET /api/admin/users projection.
 *
 *   node Test File/admin-users-projection.test.js
 *
 * THE FAILURE THIS GUARDS AGAINST
 * The grid decides whether a paid plan has lapsed with a client-side
 * `isSubscriptionLive(user)` that reads `subscriptionExpiresAt` and
 * `subscriptionPermanent`, and treats a MISSING end date as "open-ended".
 *
 * The list route's `.select()` omitted both fields, so an account whose
 * subscription had already expired still rendered as "Subscribed ✓" — and the
 * expiry note never appeared, because the date was not in the payload at all.
 * The same function is correct; it was being fed a projection that could not
 * answer the question. Nothing errored. The admin was simply told a paid user
 * was still paid, and every plan lock that followed looked like a server bug.
 *
 * This walks the two sources against each other and fails if the projection
 * stops supplying a field the client reads, or if the client starts reading one
 * the projection does not send. A silent omission on either side is exactly the
 * failure mode, so it is the only thing checked.
 */
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ADMIN_ROUTES = path.join(ROOT, 'routes', 'admin.js');
const DASHBOARD = path.join(ROOT, '..', 'my-react-app', 'src', 'Pages', 'AdminDashboard.jsx');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

/**
 * The projection string used by GET /admin/users.
 *
 * Scoped to the `/users` handler on purpose: the same file has several
 * `.select()` calls, including a `adminUserFields` constant used by the
 * per-user detail route which already carries the subscription fields. Reading
 * the wrong one would make this test pass while the list stays broken.
 */
function usersListProjection() {
  const source = read(ADMIN_ROUTES);
  const handler = source.indexOf("router.get('/users'");
  assert.ok(handler > -1, 'could not find the GET /users route in routes/admin.js');
  assert.equal(source.indexOf("router.get('/users/'"), -1,
    'expected /users to be matched before any /users/:id route');

  const end = source.indexOf("router.", handler + 10);
  const body = source.slice(handler, end > -1 ? end : source.length);

  const match = body.match(/\.select\(\s*'([^']+)'\s*\)/);
  assert.ok(match, 'could not find a .select() projection in the GET /users handler');
  return new Set(match[1].split(/\s+/).filter(Boolean));
}

/**
 * Field names read by the client's `isSubscriptionLive`.
 *
 * Pulled out of the source rather than hard-coded, so adding a check to that
 * function is enough to make this test demand the field from the server. That
 * is the drift direction that actually caused the bug.
 */
function clientSubscriptionReads() {
  const source = read(DASHBOARD);
  const start = source.indexOf('function isSubscriptionLive');
  assert.ok(start > -1, 'could not find isSubscriptionLive() in AdminDashboard.jsx');
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end > -1 ? end : start + 1200);

  const found = new Set();
  const re = /user\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(body)) !== null) found.add(m[1]);
  return found;
}

test('the /users projection supplies every field isSubscriptionLive reads', () => {
  const projection = usersListProjection();
  const reads = clientSubscriptionReads();

  // The exact set the expiry decision depends on. If this test ever needs
  // updating, the client is what changed — and the reason must be a real
  // requirement, not a rename.
  const REQUIRED = [
    'subscriptionActive',
    'subscriptionPlan',
    'subscriptionExpiresAt',
    'subscriptionPermanent',
  ];

  for (const field of REQUIRED) {
    assert.ok(reads.has(field), `isSubscriptionLive no longer reads user.${field} — update this test deliberately`);
    assert.ok(projection.has(field),
      `GET /admin/users does not project ${field}; the grid cannot tell a lapsed plan from a live one without it`);
  }
});

test('the projection carries the subscription fields, not just the active flag', () => {
  const projection = usersListProjection();
  // The pair that was missing. Naming them explicitly means a regression reads
  // as a sentence rather than a diff.
  assert.ok(projection.has('subscriptionExpiresAt'),
    'subscriptionExpiresAt is missing from the /users projection: an expired plan renders as "Subscribed"');
  assert.ok(projection.has('subscriptionPermanent'),
    'subscriptionPermanent is missing from the /users projection: a permanent grant is indistinguishable from an expiring one');
});

test('the projection still carries the fields the row and detail panel read', () => {
  const projection = usersListProjection();
  const REQUIRED = [
    'firstName', 'lastName', 'email', 'createdAt',
    'twoFactorEnabled', 'lastLoginAt', 'lastLoginIp', 'lastLoginLocation',
    'lastLoginUserAgent', 'accountRole', 'accountStatus', 'profilePicture',
  ];
  for (const field of REQUIRED) {
    assert.ok(projection.has(field), `GET /admin/users stopped projecting ${field}`);
  }
});

test('every subscription field the client reads is projected', () => {
  const projection = usersListProjection();
  const reads = clientSubscriptionReads();
  const subscriptionish = [...reads].filter(f => f.startsWith('subscription'));
  assert.ok(subscriptionish.length > 0, 'no subscription reads found — the guard is mis-parsing the client');
  for (const field of subscriptionish) {
    assert.ok(projection.has(field),
      `the client reads user.${field} but GET /admin/users does not project it`);
  }
});

test('the projection has no duplicate or empty field names', () => {
  const source = read(ADMIN_ROUTES);
  const handler = source.indexOf("router.get('/users'");
  const end = source.indexOf("router.", handler + 10);
  const body = source.slice(handler, end > -1 ? end : source.length);
  const match = body.match(/\.select\(\s*'([^']+)'\s*\)/);
  const fields = match[1].split(/\s+/).filter(Boolean);
  assert.equal(fields.length, new Set(fields).size, 'duplicate field in the /users projection');
  assert.ok(fields.every(f => f.length > 0), 'empty field name in the /users projection');
});
