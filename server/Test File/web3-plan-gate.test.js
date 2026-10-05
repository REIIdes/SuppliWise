/**
 * The /api/web3 router wiring — DELUXE gate coverage.
 *
 * These assert the MOUNTED express router, not the feature registry. The
 * registry tests prove web3/market/dao are DELUXE-only; this file proves the
 * gate is actually attached to the sub-routers, which is the part that
 * regresses silently.
 *
 * No database and no network: `protect` is stubbed, and every gated path is
 * asserted to answer 403 — which can only come from requireFeature, because
 * anything reaching a handler would try to query and time out.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');

const authPath = require.resolve('../middleware/auth');
const realAuth = require(authPath);
require.cache[authPath].exports = {
  ...realAuth,
  // The plan is set by the per-request middleware below, so this must NOT
  // overwrite req.user — an earlier version did, which pinned every request to
  // FREE and made the "DELUXE is allowed" case fail for the wrong reason.
  protect: (req, res, next) => next(),
};

const web3Router = require('../routes/web3');

/** Mount the router and issue one request as a user on `plan`. */
function request(pathname, plan = 'free') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      _id: '507f1f77bcf86cd799439011',
      role: 'user',
      subscriptionActive: true,
      subscriptionPlan: plan,
      subscriptionExpiresAt: null,
    };
    next();
  });
  app.use('/api/web3', web3Router);
  const server = app.listen(0);
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${pathname}`)
    .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
    .finally(() => server.close());
}

// Real paths, one or more per sub-router. A 403 can only come from the plan
// gate: a mistyped path would 404, and a real handler would query and hang.
const GATED = [
  ['/chain', 'web3'],
  ['/chain/verify', 'web3'],
  ['/wallet', 'web3'],
  ['/supply/batches', 'web3'],
  ['/rewards/status', 'web3'],
  ['/rewards/nfts', 'web3'],
  ['/data/shares', 'web3'],
  ['/market/listings', 'market'],
  ['/market/disputes', 'market'],
  ['/dao/config', 'dao'],
  ['/dao/proposals', 'dao'],
  ['/knowledge', 'dao'],
];

test('a FREE user is refused everywhere in the blockchain layer', async () => {
  for (const [sub, feature] of GATED) {
    const { status, body } = await request(`/api/web3${sub}`);
    assert.equal(status, 403, `${sub} must be gated for FREE, got ${status}`);
    assert.equal(body.allowed, false, sub);
    assert.equal(body.feature, feature, `${sub} should report "${feature}" as the locked feature`);
    assert.equal(body.requiresPlan, 'monthly', sub);
    assert.equal(body.currentPlan, 'free', sub);
    assert.match(body.message, /requires the DELUXE plan/i, sub);
  }
});

test('each sub-router reports its own feature key, not the first one', async () => {
  // Regression: mounting the gate in index.js made every path answer "web3",
  // because a gate attached to one sub-router runs for all of them. The 403
  // payload is what the upgrade card is built from, so a wrong key shows the
  // user the wrong feature name.
  const seen = new Map();
  for (const [sub, feature] of GATED) {
    const { body } = await request(`/api/web3${sub}`);
    seen.set(sub.split('/')[1], body.feature);
  }
  assert.equal(seen.get('chain'), 'web3');
  assert.equal(seen.get('supply'), 'web3');
  assert.equal(seen.get('rewards'), 'web3');
  assert.equal(seen.get('data'), 'web3');
  assert.equal(seen.get('market'), 'market');
  assert.equal(seen.get('dao'), 'dao');
  assert.equal(seen.get('knowledge'), 'dao', 'knowledge base belongs to the DAO gate');
});

test('a DELUXE user passes the gate', async () => {
  // Reaches the handler, which then fails on the absent database — 500, not
  // 403. Anything else would mean the gate is denying the tier it should allow.
  for (const [sub] of GATED) {
    const { status } = await request(`/api/web3${sub}`, 'monthly');
    assert.notEqual(status, 403, `${sub} must NOT be gated for DELUXE`);
  }
});

test('every sub-router keeps its own guard, as defence in depth', () => {
  // index.js owns the authoritative path-keyed gate, but each sub-router is
  // still gated on its own. If one is ever mounted outside index.js it must not
  // silently become an open endpoint for every FREE user.
  const dir = path.join(__dirname, '..', 'routes', 'web3');
  const subRouters = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !['index.js', 'guards.js'].includes(f));

  assert.equal(subRouters.length, 7, `expected 7 sub-routers, found ${subRouters.length}`);

  for (const file of subRouters) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // Comments stripped: guards.js documents the wrong orderings with literal
    // examples that would otherwise be matched as if they were real code.
    const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    assert.match(
      code,
      /requireFeature\('(web3|market|dao)'\)|web3Guard\('(web3|market|dao)'\)(\)|,)/,
      `${file} must apply a plan gate (requireFeature / web3Guard) at router level`,
    );
  }
});

test('the gate is applied at router level, before any handler', () => {
  // requireFeature must be a `router.use`, not a per-handler check: handlers
  // are added over time and a new one that forgets the check is a hole.
  // Matched per-LINE rather than with a balanced-paren regex: the argument
  // contains nested parens (`requireFeature('market')`) which `[^)]*` truncates.
  for (const file of ['market.js', 'govern.js', 'rewards.js', 'data.js', 'ecosystem.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'web3', file), 'utf8');
    const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const guards = code
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('router.use('));
    assert.ok(guards.length > 0, `${file} has no router-level guard`);
    assert.ok(
      guards.some((g) => /requireFeature|web3Guard/.test(g)),
      `${file} router.use must include the plan gate, got: ${guards.join(' | ')}`,
    );
  }
});

test('index.js applies one path-keyed gate, below protect and the public routes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'web3', 'index.js'), 'utf8');
  const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  const protectAt = code.indexOf('router.use(protect)');
  const gateAt = code.indexOf('router.use(userOnly, web3PlanGate)');
  const firstSubRouter = code.search(/router\.use\('\/',\s*\w+Router\)/);

  assert.ok(protectAt > -1, 'protect must still be applied');
  assert.ok(gateAt > -1, 'the path-keyed plan gate must be applied');
  assert.ok(firstSubRouter > -1, 'sub-routers must still be mounted');

  assert.ok(protectAt < gateAt, 'the gate must run AFTER protect (it needs req.user)');
  assert.ok(gateAt < firstSubRouter, 'the gate must run BEFORE any sub-router, or it never runs');

  // Public routes are registered before protect, so they cannot be gated.
  const verifyAt = code.indexOf("router.get('/verify/:code'");
  assert.ok(verifyAt > -1 && verifyAt < protectAt, 'bottle verification must stay public');
});

test('featureForPath maps each area to its own entitlement', () => {
  const { featureForPath } = require('../routes/web3/guards');
  assert.equal(featureForPath('/market/listings'), 'market');
  assert.equal(featureForPath('/market/orders/123'), 'market');
  assert.equal(featureForPath('/dao/proposals'), 'dao');
  assert.equal(featureForPath('/knowledge'), 'dao', 'knowledge base belongs to the DAO gate');
  // Everything else is the core web3 area, including brand-new prefixes —
  // the default must be the stricter of the two, not "open".
  for (const p of ['/chain', '/wallet', '/supply/batches', '/rewards/nfts', '/data/shares', '/brand/new']) {
    assert.equal(featureForPath(p), 'web3', `${p} should map to web3`);
  }
});

test('the public verification endpoint stays open to non-subscribers', async () => {
  // A consumer scanning a bottle QR has no account and no plan. Gating this
  // would break bottle verification for every FREE-tier holder in the world,
  // so it is registered before `protect` in index.js and must stay reachable.
  const { status } = await request('/api/web3/verify/NOT-A-REAL-CODE');
  assert.notEqual(status, 403, 'verification must NOT be plan-gated (got 403)');
  assert.notEqual(status, 401, 'verification must NOT require a session (got 401)');
});

test('the public share-link endpoint stays open to non-subscribers', async () => {
  // Same reasoning: a clinician opening a shared profile link has no account.
  const { status } = await request('/api/web3/share/not-a-real-token');
  assert.notEqual(status, 403, 'share links must NOT be plan-gated (got 403)');
  assert.notEqual(status, 401, 'share links must NOT require a session (got 401)');
});
