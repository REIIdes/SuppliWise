// Shared subscription plan helpers (mirrors server/utils/plan.js).
// Tiers: free < monthly < annual < custom (Ultimate).
// Inactive subscriptions always fall back to free.

export const PLAN_RANK = { free: 0, monthly: 1, annual: 2, custom: 3 };

export const PLAN_LABELS = {
  free: 'Basic Package',
  monthly: 'Deluxe Package',
  annual: 'Premium Package',
  custom: 'Ultimate Package',
};

// Each gated feature declares the lowest tier that unlocks it.
export const FEATURE_TIERS = {
  insights: 'monthly', // Insights & Analytics
  pdfExport: 'monthly', // PDF Report Exports
  historyFull: 'annual', // 5-Year Record History (page-size cap below)
  priorityReviews: 'annual', // Priority Health Reviews
  chat: 'custom', // AI Chat Assistant (Ultimate)
};

// Max history page size per tier (matches server historyLimitFor).
export const HISTORY_LIMITS = { free: 5, monthly: 10, annual: 20, custom: 20 };

function readStoredUser() {
  try {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Current plan from the cached user: { active, plan, rank }.
export function getStoredPlan() {
  const user = readStoredUser();
  const active = user.subscriptionActive === true;
  const plan = active && PLAN_RANK[user.subscriptionPlan] !== undefined
    ? user.subscriptionPlan
    : 'free';
  return { active, plan, rank: PLAN_RANK[plan] ?? 0 };
}

// True when the stored plan meets the minimum tier.
export function hasPlanAccess(minTier) {
  const { rank } = getStoredPlan();
  return rank >= (PLAN_RANK[minTier] ?? 0);
}

export function historyLimitForStoredPlan() {
  const { plan } = getStoredPlan();
  return HISTORY_LIMITS[plan] ?? HISTORY_LIMITS.free;
}
