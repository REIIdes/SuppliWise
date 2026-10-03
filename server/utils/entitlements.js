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
 * request because the backend re-reads the user doc per request). A
 * subscription flagged permanent never expires at all.
 *
 * Duration, source and the two layers come from utils/subscriptionState.js, which
 * owns the paid-vs-admin-override model. The plan vocabulary is re-exported from
 * there so there is exactly ONE definition of every plan id.
 */

const subState = require('./subscriptionState');

const { PLAN_RANK, PLAN_LABELS, PLAN_ORDER, PLAN_ALIASES, normalizePlanId } = subState;
const { STANDARD_PERIOD_DAYS, daysRemainingFrom, describeRecord, durationLabel } = subState;

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
      permanent: false, source: 'free', daysRemaining: null, remainingMs: null,
    };
  }
  const configuredPlan = rankOf(user.subscriptionPlan) > 0 ? user.subscriptionPlan : 'free';
  const flaggedActive = user.subscriptionActive === true;
  const start = toDateOrNull(user.subscriptionStartedAt);
  // A permanent grant (an admin lifetime grant, or a lifetime purchase) has no
  // end date at all. The stored expiry is ignored for it, so a stale date can
  // never cut short a subscription that was explicitly sold as never expiring.
  const permanent = user.subscriptionPermanent === true && configuredPlan !== 'free';
  const end = permanent ? null : toDateOrNull(user.subscriptionExpiresAt);
  // `subscriptionActive` is the PROJECTED effective state, written by
  // subscriptionState.js on every mutation, so a null `subscriptionExpiresAt`
  // alongside `subscriptionActive: true` is this codebase's normal
  // representation of an active paid subscriber — NOT missing data. Do not
  // fail closed here: `subscriptionPermanent` already expresses "never
  // expires", and treating a null end date without it as expired revokes every
  // legitimate active subscription.
  const expired = !!end && end.getTime() <= now;

  let status;
  if (expired) status = 'expired';
  else if (flaggedActive && configuredPlan !== 'free') status = 'active';
  else if (!flaggedActive && configuredPlan !== 'free') status = 'inactive'; // cancelled/removed
  else status = 'free';

  const plan = status === 'active' ? configuredPlan : 'free';
  const active = status === 'active';
  const remainingMs = active && !permanent && end ? Math.max(0, end.getTime() - now) : null;

  return {
    plan,
    rank: PLAN_RANK[plan],
    status,
    subscriptionActive: active,
    subscriptionStart: start ? start.toISOString() : null,
    subscriptionEnd: end ? end.toISOString() : null,
    permanent,
    // 'admin' when an admin override is in force, 'payment' when the account is
    // running on what the user bought, 'free' when nothing is granting access.
    source: user.subscriptionSource === 'admin' ? 'admin'
      : (user.subscriptionSource === 'payment' ? 'payment' : (plan === 'free' ? 'free' : 'payment')),
    daysRemaining: active ? daysRemainingFrom(end, now) : null,
    remainingMs,
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

/**
 * Tier-shaped limits for a given rank.
 *
 * Split out from `limitsFor` so the PRICING PAGE can state the same numbers the
 * gate enforces. Writing "20 assessments per page" on a plan card while the gate
 * used a different constant is how a sales page ends up promising something the
 * product does not do — and the two copies would have no way to notice.
 */
function limitsForRank(rank) {
  return {
    historyPageSize: rank >= PLAN_RANK.annual ? 20 : rank >= PLAN_RANK.monthly ? 10 : 5,
  };
}

/** Tier-shaped limits derived from entitlements (keep in sync with FEATURES). */
function limitsFor(user, now) {
  return limitsForRank(resolveSubscription(user, now).rank);
}

/**
 * The complete authoritative subscription state. Served verbatim by
 * /api/auth/me and /api/subscription and pushed over SSE, so every client
 * surface renders from the same object.
 */
/**
 * The complete authoritative subscription state. Served verbatim by
 * /api/auth/me and /api/subscription and pushed over SSE, so every client
 * surface renders from the same object.
 *
 * Carries BOTH layers, kept apart on purpose:
 *   - the top-level fields are the EFFECTIVE subscription (what the user gets
 *     right now) — this is what every gate and every client renders;
 *   - `subscriptionLayers` exposes what the user originally bought, what an admin
 *     layered on top, and exactly what "Restore original subscription state"
 *     would return to, so a temporary admin change is visibly temporary.
 *
 * `daysRemaining` is what the UI shows ("4 days remaining"); it is null for a
 * permanent subscription, where `subscriptionPermanent` is true instead.
 */
function describeSubscription(user, now = Date.now(), options = {}) {
  const resolved = resolveSubscription(user, now);
  // The full audit trail is admin-only by default: a user surface gets the
  // summary plus the restore target, never the list of admin aliases.
  const withHistory = options.history === true;
  const detail = user ? describeRecord(user, now) : null;
  const restoreTarget = detail ? detail.restoreTarget : null;

  return {
    currentPlan: resolved.plan,
    subscriptionStatus: resolved.status,
    subscriptionActive: resolved.subscriptionActive,
    subscriptionStart: resolved.subscriptionStart,
    subscriptionEnd: resolved.subscriptionEnd,
    // ── Duration read-out ──────────────────────────────────────────────
    subscriptionPermanent: resolved.permanent,
    subscriptionSource: resolved.source,
    // Seats covered by this subscription: 1 for an individual plan, N for a
    // Team subscription. Team is the same tier as Premium shared across N
    // people, so this never changes what is unlocked — only how many people
    // share it, which is what the receipt and the billing screen need to show.
    subscriptionSeats: detail ? detail.effective.seats : 1,
    subscriptionIsTeam: detail ? detail.effective.isTeam === true : false,
    subscriptionDuration: resolved.permanent
      ? 'PERMANENT'
      : (resolved.daysRemaining === null ? 'NONE' : `${resolved.daysRemaining} days`),
    daysRemaining: resolved.daysRemaining,
    remainingMs: resolved.remainingMs,
    standardPeriodDays: STANDARD_PERIOD_DAYS,
    planRank: resolved.rank,
    planLabel: PLAN_LABELS[resolved.plan],
    enabledFeatures: enabledFeatureList(user, now),
    entitlements: entitlementsFor(user, now),
    limits: limitsFor(user, now),
    subscriptionLayers: detail
      ? {
        effective: detail.effective,
        paid: detail.paid,
        override: detail.override,
        canRestore: detail.canRestore,
        restoreTarget,
        history: withHistory ? detail.history : [],
      }
      : null,
    // Deterministic change signature: any entitlement-affecting mutation changes
    // it, letting clients apply state idempotently and skip redundant renders.
    // Permanence and source are folded in because both change the state a client
    // must repaint for, even when plan/status/start/end happen to match.
    version: [
      resolved.plan,
      resolved.status,
      resolved.subscriptionStart || '-',
      resolved.subscriptionEnd || '-',
      resolved.permanent ? 'perm' : '-',
      user?.subscriptionSource || '-',
      // Seats are part of the state a client repaints for: a Team subscription
      // going from 5 seats to 10 changes what the billing screen says, and the
      // signature has to move or the re-render is skipped.
      `s${detail ? detail.effective.seats : 1}`,
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
  normalizePlanId, rankOf, resolveSubscription, entitlementsFor, enabledFeatureList, limitsFor, limitsForRank,
  describeSubscription, can, requireFeature, requirePlan,
  tierOf, tierRank, historyLimitFor,
  // Re-exported so a route needs one import for the whole subscription surface.
  STANDARD_PERIOD_DAYS, daysRemainingFrom, durationLabel, describeRecord,
  subState,
};
