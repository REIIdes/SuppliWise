/**
 * ENTITLEMENTS — the single source of truth for the subscription system.
 *
 * Tiers:    free < monthly < annual < custom  (labels: FREE, DELUXE, PREMIUM, ULTIMATE)
 *
 * Structure (authoritative — enforced by the backend AND served to the frontend
 * so the UI can never disagree with the API):
 *   FREE     — Health Assessment, Supplement Recommendations, Daily Intake
 *   DELUXE   — all Free + Insights & Analytics, PDF Report Export,
 *              and the blockchain layer (Web3 wallet/supply chain, Marketplace, DAO)
 *   PREMIUM  — all Free + Deluxe + Priority Assessment, 5-Year Record History
 *   ULTIMATE — unlocks all available features (incl. AI Chat Assistant)
 *
 * Backend rule: every protected feature calls `can()` / `requireFeature()` here
 * against the CURRENT user document — frontend visibility is UI only, never
 * the security mechanism.
 *
 * Expiry rule: a subscription whose subscriptionExpiresAt is in the past is
 * treated as FREE at read time (no cron needed — the check happens on every
 * request because the backend re-reads the user doc per request).
 */

const PLAN_RANK = { free: 0, monthly: 1, annual: 2, custom: 3 };

const PLAN_LABELS = {
  free: 'FREE',
  monthly: 'DELUXE',
  annual: 'PREMIUM',
  custom: 'ULTIMATE',
};

const PLAN_ORDER = ['free', 'monthly', 'annual', 'custom'];

/**
 * Accepted spellings for a plan id (APIs, admin payloads, imports).
 * Storage ids stay free/monthly/annual/custom; everything funnels through
 * normalizePlanId() so no call site can invent a fifth plan.
 */
const PLAN_ALIASES = {
  free: 'free', basic: 'free',
  monthly: 'monthly', deluxe: 'monthly',
  annual: 'annual', premium: 'annual',
  custom: 'custom', ultimate: 'custom',
};

/** Normalize any client-supplied plan name to a canonical id, or null if unknown. */
function normalizePlanId(value) {
  const key = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLAN_ALIASES, key) ? PLAN_ALIASES[key] : null;
}

/**
 * Canonical feature registry. minTier is INCLUSIVE (that tier and everything
 * above it). Add new gated features here only — never inline tier math in
 * routes or components.
 */
const FEATURES = {
  healthAssessment:   { minTier: 'free',    label: 'Health Assessment',          description: 'AI-powered health assessments' },
  recommendations:    { minTier: 'free',    label: 'Supplement Recommendations', description: 'Personalized supplement suggestions' },
  dailyIntake:        { minTier: 'free',    label: 'Daily Intake',               description: 'Log daily supplement intake' },
  insights:           { minTier: 'monthly', label: 'Insights & Analytics',       description: 'AI-driven health trends and analytics' },
  pdfExport:          { minTier: 'monthly', label: 'PDF Report Export',          description: 'Download assessment & history reports' },
  priorityAssessment: { minTier: 'annual',  label: 'Priority Assessment',        description: 'Severe cases flagged for priority review' },
  historyFull:        { minTier: 'annual',  label: '5-Year Record History',      description: 'Full assessment history with deeper pages' },
  chat:               { minTier: 'custom',  label: 'AI Chat Assistant',          description: 'Chat with SuppliWise AI' },
  // ── Blockchain layer — DELUXE and above ─────────────────────────────────
  // Split into three keys rather than one `blockchain` key so the UI can label
  // the exact panel the user clicked, and so a future pricing change can move
  // one of them without touching the others. All three are the same tier today.
  web3:               { minTier: 'monthly', label: 'Web3 Wallet & Supply Chain', description: 'Wallet, decentralized ID and supply-chain provenance' },
  market:             { minTier: 'monthly', label: 'Marketplace',                description: 'Buy and sell supplements with WELL tokens' },
  dao:                { minTier: 'monthly', label: 'DAO Governance',             description: 'Proposals, voting and treasury' },
};

const rankOf = (plan) => (Object.prototype.hasOwnProperty.call(PLAN_RANK, plan) ? PLAN_RANK[plan] : 0);

/**
 * Own-property lookup into the feature registry.
 *
 * `FEATURES[key]` with raw, user-supplied input is a prototype-chain read:
 * keys such as `constructor`, `toString`, `hasOwnProperty` or `__proto__`
 * resolve to inherited members that are truthy but carry no `minTier`.
 * `rankOf(undefined)` falls back to 0, so `can()` answered TRUE for a
 * "feature" that does not exist — a fail-open authorization check on
 * `/api/subscription/feature/:key` and on every `requireFeature()` gate.
 * Guarding with hasOwnProperty makes any unknown key fail closed, exactly
 * like a genuinely missing feature.
 */
const hasFeature = (key) =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(FEATURES, key);
const getFeature = (key) => (hasFeature(key) ? FEATURES[key] : undefined);

function toDateOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Resolve the CURRENT effective subscription for a user document.
 * Expired/inactive/unknown plans all fail closed to the free tier.
 */
function resolveSubscription(user, now = Date.now()) {
  if (!user) {
    return {
      plan: 'free', rank: 0, status: 'missing',
      subscriptionActive: false, subscriptionStart: null, subscriptionEnd: null,
    };
  }
  const configuredPlan = rankOf(user.subscriptionPlan) > 0 ? user.subscriptionPlan : 'free';
  const flaggedActive = user.subscriptionActive === true;
  const start = toDateOrNull(user.subscriptionStartedAt);
  const end = toDateOrNull(user.subscriptionExpiresAt);
  const expired = !!end && end.getTime() <= now;

  let status;
  if (expired) status = 'expired';
  else if (flaggedActive && configuredPlan !== 'free') status = 'active';
  else if (!flaggedActive && configuredPlan !== 'free') status = 'inactive'; // cancelled/removed
  else status = 'free';

  const plan = status === 'active' ? configuredPlan : 'free';
  return {
    plan,
    rank: PLAN_RANK[plan],
    status,
    subscriptionActive: status === 'active',
    subscriptionStart: start ? start.toISOString() : null,
    subscriptionEnd: end ? end.toISOString() : null,
  };
}

/** Feature -> boolean map for the user's current tier. */
function entitlementsFor(user, now) {
  const { rank } = resolveSubscription(user, now);
  const map = {};
  for (const [key, def] of Object.entries(FEATURES)) {
    map[key] = rank >= rankOf(def.minTier);
  }
  return map;
}

/**
 * UI-friendly feature list (frontend renders the profile/upgrade screens from
 * this instead of duplicating tier logic).
 */
function enabledFeatureList(user, now) {
  const map = entitlementsFor(user, now);
  return Object.entries(FEATURES).map(([key, def]) => ({
    key,
    label: def.label,
    description: def.description,
    minTier: def.minTier,
    enabled: map[key] === true,
  }));
}

/** Tier-shaped limits derived from entitlements (keep in sync with FEATURES). */
function limitsFor(user, now) {
  const { rank } = resolveSubscription(user, now);
  return {
    historyPageSize: rank >= PLAN_RANK.annual ? 20 : rank >= PLAN_RANK.monthly ? 10 : 5,
  };
}

/**
 * The complete authoritative subscription state. Served verbatim by
 * /api/auth/me and /api/subscription and pushed over SSE, so every client
 * surface renders from the same object.
 */
function describeSubscription(user, now = Date.now()) {
  const resolved = resolveSubscription(user, now);
  return {
    currentPlan: resolved.plan,
    subscriptionStatus: resolved.status,
    subscriptionActive: resolved.subscriptionActive,
    subscriptionStart: resolved.subscriptionStart,
    subscriptionEnd: resolved.subscriptionEnd,
    planRank: resolved.rank,
    planLabel: PLAN_LABELS[resolved.plan],
    enabledFeatures: enabledFeatureList(user, now),
    entitlements: entitlementsFor(user, now),
    limits: limitsFor(user, now),
    // Deterministic change signature: any entitlement-affecting mutation changes
    // it, letting clients apply state idempotently and skip redundant renders.
    version: [
      resolved.plan,
      resolved.status,
      resolved.subscriptionStart || '-',
      resolved.subscriptionEnd || '-',
      user?.subscriptionUpdatedAt ? new Date(user.subscriptionUpdatedAt).getTime() : 0,
    ].join('|'),
  };
}

/** True when the user's CURRENT subscription includes `featureKey`. Admins bypass. */
function can(user, featureKey, now) {
  if (user && user.role === 'admin') return true;
  const def = getFeature(featureKey);
  if (!def) return false; // unknown features (and prototype keys) fail closed
  return resolveSubscription(user, now).rank >= rankOf(def.minTier);
}

/**
 * Express middleware factory: 403 with a structured payload when the feature
 * is not in the caller's CURRENT subscription.
 */
function requireFeature(featureKey) {
  const def = getFeature(featureKey);
  return (req, res, next) => {
    if (req.user && req.user.role === 'admin') return next();
    if (!def || !can(req.user, featureKey)) {
      const resolved = resolveSubscription(req.user);
      const minTier = def ? def.minTier : 'free';
      return res.status(403).json({
        message: `${def ? def.label : 'This feature'} requires the ${PLAN_LABELS[minTier] || minTier} plan. Please upgrade to continue.`,
        feature: featureKey,
        requiresPlan: minTier,
        currentPlan: resolved.plan,
        subscriptionStatus: resolved.status,
        allowed: false,
      });
    }
    next();
  };
}

/** Backwards-compatible tier-gate (delegates to the same rank resolution). */
function requirePlan(minTier) {
  const min = rankOf(minTier);
  return (req, res, next) => {
    if (req.user && req.user.role === 'admin') return next();
    const resolved = resolveSubscription(req.user);
    if (resolved.rank < min) {
      return res.status(403).json({
        message: `This feature requires the ${PLAN_LABELS[minTier] || minTier} plan. Please upgrade to continue.`,
        requiresPlan: minTier,
        currentPlan: resolved.plan,
        subscriptionStatus: resolved.status,
      });
    }
    next();
  };
}

function tierOf(user) { return resolveSubscription(user).plan; }
function tierRank(user) { return resolveSubscription(user).rank; }
function historyLimitFor(user) { return limitsFor(user).historyPageSize; }

module.exports = {
  PLAN_RANK, PLAN_LABELS, PLAN_ORDER, PLAN_ALIASES, FEATURES,
  hasFeature, getFeature,
  normalizePlanId, rankOf, resolveSubscription, entitlementsFor, enabledFeatureList, limitsFor,
  describeSubscription, can, requireFeature, requirePlan,
  tierOf, tierRank, historyLimitFor,
};
