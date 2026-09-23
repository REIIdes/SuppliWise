/**
 * Plan helpers — re-exported from utils/entitlements.js, which is the single
 * source of truth for all tier/feature rules. This module exists only so older
 * imports keep working; new code should import utils/entitlements directly.
 */
const entitlements = require('./entitlements');

module.exports = {
  PLAN_RANK: entitlements.PLAN_RANK,
  PLAN_LABELS: entitlements.PLAN_LABELS,
  tierOf: entitlements.tierOf,
  tierRank: entitlements.tierRank,
  requirePlan: entitlements.requirePlan,
  historyLimitFor: entitlements.historyLimitFor,
  requireFeature: entitlements.requireFeature,
  can: entitlements.can,
  describeSubscription: entitlements.describeSubscription,
  resolveSubscription: entitlements.resolveSubscription,
  normalizePlanId: entitlements.normalizePlanId,
  FEATURES: entitlements.FEATURES,
  PLAN_ORDER: entitlements.PLAN_ORDER,
};
