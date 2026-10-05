/**
 * Shared guards for the /api/web3 layer.
 *
 * WHY THE GATE LIVES HERE AND NOT PER SUB-ROUTER
 * All seven sub-routers are mounted at '/' in index.js. A `router.use()` guard
 * inside any one of them therefore runs for EVERY path, because the mount
 * matches everything. Putting `web3Guard('web3')` at the top of chain.js — the
 * first mount — made /market/listings and /dao/proposals answer
 * "Web3 requires DELUXE", because chainRouter's guard rejected the request
 * before marketRouter/governRouter were ever reached.
 *
 * The other two orderings fail too:
 *   router.use('/', sub, gate)  — the sub-router answers first, gate never runs
 *   router.use('/', gate, sub)  — the gate belongs to whichever sub-router is
 *                                 mounted first, so it gates the wrong feature
 *
 * So the decision is made ONCE, in index.js, from the request path. That gives
 * exactly one place to reason about, one 403 per request, and a payload naming
 * the feature the user actually clicked. Each sub-router ALSO keeps its own
 * router-level guard, which is defence in depth: if a sub-router is ever
 * mounted on its own, it is still gated.
 */
const { requireFeature } = require('../../utils/entitlements');

/** Admin identities have no health/wallet semantics here. */
function userOnly(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    return res.status(403).json({ message: 'User account required.' });
  }
  next();
}

/**
 * Path prefix -> entitlement key. The FIRST segment decides, so a new
 * sub-router inherits the 'web3' default rather than being accidentally open.
 */
const PATH_FEATURES = {
  market: 'market',
  dao: 'dao',
  knowledge: 'dao', // the knowledge base is part of the DAO area
};

/** Which entitlement a given /api/web3 path belongs to. */
function featureForPath(pathname) {
  const first = String(pathname || '').split('/').filter(Boolean)[0] || '';
  return PATH_FEATURES[first] || 'web3';
}

/**
 * The single authoritative plan gate for the whole authenticated layer.
 * Emits the same 403 body as requireFeature, for the feature that owns the path.
 */
function web3PlanGate(req, res, next) {
  const feature = featureForPath(req.path || req.originalUrl);
  return requireFeature(feature)(req, res, next);
}

/**
 * Router-level middleware enforcing both guards.
 * @param {'web3'|'market'|'dao'} feature entitlement key
 */
function web3Guard(feature) {
  const planGate = requireFeature(feature);
  return [userOnly, planGate];
}

module.exports = { userOnly, web3Guard, web3PlanGate, featureForPath };
