/**
 * Subscription tiers shared by all plan gates.
 * free < monthly < annual < custom (Ultimate). Inactive subscriptions
 * always fall back to free.
 */
const PLAN_RANK = { free: 0, monthly: 1, annual: 2, custom: 3 };

const PLAN_LABELS = {
  free: 'Basic Package',
  monthly: 'Deluxe Package',
  annual: 'Premium Package',
  custom: 'Ultimate Package',
};

function tierOf(user) {
  if (!user || user.subscriptionActive !== true) return 'free';
  const plan = user.subscriptionPlan || 'free';
  return Object.prototype.hasOwnProperty.call(PLAN_RANK, plan) ? plan : 'free';
}

function tierRank(user) {
  return PLAN_RANK[tierOf(user)] ?? 0;
}

// Express middleware factory: requires at least `minTier`.
// Admins bypass plan gates (they manage, not consume, subscriptions).
// Blocked users get a 403 with requiresPlan/currentPlan so the client
// can show an upgrade prompt instead of a generic error.
function requirePlan(minTier) {
  const min = PLAN_RANK[minTier] ?? 0;
  return (req, res, next) => {
    if (req.user && req.user.role === 'admin') return next();
    if ((PLAN_RANK[tierOf(req.user)] ?? 0) < min) {
      return res.status(403).json({
        message: `This feature requires the ${PLAN_LABELS[minTier] || minTier}. Please upgrade to continue.`,
        requiresPlan: minTier,
        currentPlan: tierOf(req.user),
      });
    }
    next();
  };
}

// Max history page size per tier (5-year record history is an annual+ perk)
function historyLimitFor(user) {
  const rank = tierRank(user);
  if (rank >= PLAN_RANK.annual) return 20;
  if (rank >= PLAN_RANK.monthly) return 10;
  return 5;
}

module.exports = { PLAN_RANK, PLAN_LABELS, tierOf, tierRank, requirePlan, historyLimitFor };
