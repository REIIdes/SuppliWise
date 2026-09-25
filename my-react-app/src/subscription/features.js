/**
 * Canonical feature registry — the ONE frontend mirror of
 * server/utils/entitlements.js (the backend source of truth).
 *
 * UI-ONLY metadata: plan ranks/labels and feature -> minimum tier, used to
 * render gates, upgrade prompts and the profile feature list instantly.
 * The SECURITY decision is always made by the backend (requireFeature /
 * can / /api/subscription/feature/:key); this module only keeps the UI
 * consistent with it. When the server sends a resolved snapshot
 * (`subscription.entitlements`), prefer that over this table.
 *
 * Tiers: free < monthly < annual < custom
 *   FREE     (free)    — Health Assessment, Supplement Recommendations, Daily Intake
 *   DELUXE   (monthly) — all FREE + Insights & Analytics, PDF Report Export
 *   PREMIUM  (annual)  — all FREE/DELUXE + Priority Assessment, 5-Year Record History
 *   ULTIMATE (custom)  — unlocks all available features (incl. AI Chat Assistant)
 *
 * The blockchain layer (web3 / market / dao) is a DELUXE entitlement: it is the
 * first paid tier above FREE, so the three "Explore" entries are the most
 * visible thing a DELUXE upgrade unlocks.
 */

export const PLAN_RANK = { free: 0, monthly: 1, annual: 2, custom: 3 };

export const PLAN_ORDER = ['free', 'monthly', 'annual', 'custom'];

export const PLAN_LABELS = {
  free: 'FREE',
  monthly: 'DELUXE',
  annual: 'PREMIUM',
  custom: 'ULTIMATE',
};

/** Accepted spellings for a plan id (mirrors server normalizePlanId). */
const PLAN_ALIASES = {
  free: 'free', basic: 'free',
  monthly: 'monthly', deluxe: 'monthly',
  annual: 'annual', premium: 'annual',
  custom: 'custom', ultimate: 'custom',
};

export function normalizePlanId(value) {
  const key = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLAN_ALIASES, key) ? PLAN_ALIASES[key] : null;
}

/** Every gated feature with the lowest tier that unlocks it. Keep in exact
 *  sync with server/utils/entitlements.js FEATURES (same keys, same tiers). */
export const FEATURES = {
  healthAssessment:   { minTier: 'free',    label: 'Health Assessment',          description: 'AI-powered health assessments' },
  recommendations:    { minTier: 'free',    label: 'Supplement Recommendations', description: 'Personalized supplement suggestions' },
  dailyIntake:        { minTier: 'free',    label: 'Daily Intake',               description: 'Log daily supplement intake' },
  insights:           { minTier: 'monthly', label: 'Insights & Analytics',       description: 'AI-driven health trends and analytics' },
  pdfExport:          { minTier: 'monthly', label: 'PDF Report Export',          description: 'Download assessment & history reports' },
  priorityAssessment: { minTier: 'annual',  label: 'Priority Assessment',        description: 'Severe cases flagged for priority review' },
  historyFull:        { minTier: 'annual',  label: '5-Year Record History',      description: 'Full assessment history with deeper pages' },
  chat:               { minTier: 'custom',  label: 'AI Chat Assistant',          description: 'Chat with SuppliWise AI' },
  // ── Blockchain layer — DELUXE and above ─────────────────────────────────
  // Three keys, not one, so each panel is labelled for what the user clicked.
  // Mirrors server/utils/entitlements.js exactly (features.test.js enforces it).
  web3:               { minTier: 'monthly', label: 'Web3 Wallet & Supply Chain', description: 'Wallet, decentralized ID and supply-chain provenance' },
  market:             { minTier: 'monthly', label: 'Marketplace',                description: 'Buy and sell supplements with WELL tokens' },
  dao:                { minTier: 'monthly', label: 'DAO Governance',             description: 'Proposals, voting and treasury' },
};

export const FEATURE_KEYS = Object.keys(FEATURES);

/**
 * Accepted alternative spellings -> canonical feature key.
 *
 * Lets any caller use the spec's snake_case names
 * (canAccess("priority_assessment"), canAccess("pdf_reports")) alongside the
 * canonical camelCase keys. Both resolve to the ONE registry entry above, so
 * no part of the app can carry its own interpretation of a feature.
 *
 * Built into a prototype-less object: a lookup with raw input such as
 * "constructor"/"toString"/"__proto__" must miss, never resolve to an
 * inherited member (the frontend twin of the server's getFeature() guard).
 */
const FEATURE_ALIASES = {
  health_assessment: 'healthAssessment',
  supplement_recommendations: 'recommendations',
  supplement_recommendation: 'recommendations',
  daily_intake: 'dailyIntake',
  insights: 'insights',
  analytics: 'insights',
  insights_and_analytics: 'insights',
  insights_analytics: 'insights',
  pdf_export: 'pdfExport',
  pdf_report_export: 'pdfExport',
  pdf_reports: 'pdfExport',
  pdf: 'pdfExport',
  priority_assessment: 'priorityAssessment',
  priority: 'priorityAssessment',
  severe_case_flagging: 'priorityAssessment',
  five_year_history: 'historyFull',
  five_year_record_history: 'historyFull',
  record_history: 'historyFull',
  history: 'historyFull',
  chat: 'chat',
  ai_chat: 'chat',
  ai_chat_assistant: 'chat',
  // Blockchain layer. The nav labels are the discoverable spellings here.
  web3: 'web3',
  web_3: 'web3',
  wallet: 'web3',
  blockchain: 'web3',
  supply_chain: 'web3',
  provenance: 'web3',
  market: 'market',
  marketplace: 'market',
  shop: 'market',
  store: 'market',
  trading: 'market',
  escrow: 'market',
  dao: 'dao',
  governance: 'dao',
  voting: 'dao',
  treasury: 'dao',
  proposals: 'dao',
};

const OWN_FEATURES = Object.assign(Object.create(null), FEATURES);
const OWN_ALIASES = Object.assign(Object.create(null), FEATURE_ALIASES);
// lowercase canonical key -> canonical key, so "PRIORITYASSESSMENT",
// "priorityassessment" and "priority_assessment" all land on the same entry.
const LOWER_FEATURES = Object.assign(Object.create(null));
for (const canonical of Object.keys(FEATURES)) {
  LOWER_FEATURES[canonical.toLowerCase()] = canonical;
}

/**
 * Resolve any accepted spelling to a canonical feature key, or null if the
 * feature does not exist. FAIL CLOSED: unknown keys (and prototype keys)
 * return null so every gate built on this answers "locked" — mirroring
 * server getFeature()/can(), which never fail open.
 */
export function resolveFeatureKey(key) {
  const raw = typeof key === 'string' ? key.trim() : '';
  if (!raw) return null;
  if (Object.prototype.hasOwnProperty.call(OWN_FEATURES, raw)) return raw;
  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LOWER_FEATURES, lower)) return LOWER_FEATURES[lower];
  if (Object.prototype.hasOwnProperty.call(OWN_ALIASES, lower)) return OWN_ALIASES[lower];
  return null;
}

/** A feature exists in the registry (own-property, fail-closed). */
export function isKnownFeature(key) {
  return resolveFeatureKey(key) !== null;
}

// Legacy shape kept for existing imports (feature -> minimum tier).
export const FEATURE_TIERS = Object.fromEntries(
  Object.entries(FEATURES).map(([key, def]) => [key, def.minTier])
);

// Max history page size per tier (matches server historyLimitFor).
export const HISTORY_LIMITS = { free: 5, monthly: 10, annual: 20, custom: 20 };
