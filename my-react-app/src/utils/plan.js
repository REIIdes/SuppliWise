// Shared subscription plan helpers.
// The registry (ranks, labels, feature tiers) lives in subscription/features.js
// — the single frontend mirror of server/utils/entitlements.js. This module
// holds the resolution/caching logic only.
//
// Resolution rules (mirror the backend resolveSubscription):
// - a server-resolved snapshot (`subscription` from /auth/me, login, SSE)
//   is authoritative when present;
// - otherwise raw fields are re-checked against subscriptionExpiresAt at
//   READ time, so an expired/cancelled plan falls back to FREE immediately;
// - inactive subscriptions always fall back to FREE.
import {
  PLAN_RANK, PLAN_LABELS, PLAN_ORDER, FEATURES, FEATURE_TIERS,
  HISTORY_LIMITS, normalizePlanId, resolveFeatureKey,
} from '../subscription/features';
// The tab session lives in api.js (its single owner); plan.js reads/writes
// the cached profile through it so plan changes also refresh the shared
// account-directory metadata (never a direct localStorage credential write).
import { getStoredUser, setStoredUser } from '../api';

export {
  PLAN_RANK, PLAN_LABELS, PLAN_ORDER, FEATURES, FEATURE_TIERS,
  HISTORY_LIMITS, normalizePlanId, resolveFeatureKey,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const nowMs = () => Date.now();

function isPast(value) {
  if (!value) return false;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

/**
 * Whole days left, rounded UP — the same rule the server uses, so a value read
 * from a fresh payload and one computed locally always agree ("30 days
 * remaining" at purchase, "4 days" 26 days later).
 */
export function daysLeftFrom(expiresAt, from = Date.now()) {
  if (!expiresAt) return null;
  const t = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return null;
  const ms = t - from;
  if (ms <= 0) return 0;
  return Math.ceil(ms / DAY_MS);
}

function readStoredUser() {
  // Tab-scoped cached profile (owned by api.js) — never shared localStorage.
  return getStoredUser() || {};
}

// Extract a server-resolved snapshot: either nested under `subscription`
// (/auth/me, login responses) or a top-level describeSubscription payload
// (SSE push, /api/subscription).
function snapshotOf(source) {
  if (source?.subscription && typeof source.subscription === 'object'
      && typeof source.subscription.currentPlan === 'string') {
    return source.subscription;
  }
  if (source && typeof source.currentPlan === 'string') return source;
  return null;
}

// Current plan from the cached user: { active, plan, rank, ... }.
export function getStoredPlan() {
  const user = readStoredUser();
  return planFromUser(user);
}

/**
 * Normalize a server snapshot into the shape every component consumes.
 *
 * Carries the DURATION read-out alongside the plan, so the UI can say
 * "4 days remaining" or "PERMANENT" straight from the server's value instead of
 * recomputing day counts in a dozen places (and getting them out of step).
 *
 * `daysRemaining` is a point-in-time value from the server. A countdown that has
 * to keep ticking uses a local 1-minute ticker (see CountdownText) rather than
 * this snapshot, so the shared store never re-renders on a clock.
 */
function fromSnapshot(snap) {
  const expired = isPast(snap.subscriptionEnd) && snap.subscriptionPermanent !== true;
  const plan = !expired && PLAN_RANK[snap.currentPlan] !== undefined ? snap.currentPlan : 'free';
  const active = !expired && snap.subscriptionActive === true && plan !== 'free';
  const permanent = active && snap.subscriptionPermanent === true;
  const daysRemaining = permanent ? null : (Number.isFinite(snap.daysRemaining) ? snap.daysRemaining : null);
  // Seats: 1 for an individual plan, N for a Team subscription (the same tier,
  // shared). Never below 1 — a zero here would read as "no seats" and break the
  // Team band's own labelling.
  const seats = active ? Math.max(1, Number(snap.subscriptionSeats) || 1) : 1;
  return {
    active,
    plan,
    rank: PLAN_RANK[plan] ?? 0,
    label: PLAN_LABELS[plan] || PLAN_LABELS.free,
    status: expired && snap.subscriptionStatus ? 'expired' : (snap.subscriptionStatus || (active ? 'active' : 'free')),
    end: snap.subscriptionEnd || null,
    start: snap.subscriptionStart || null,
    permanent,
    daysRemaining,
    remainingMs: Number.isFinite(snap.remainingMs) ? snap.remainingMs : null,
    seats,
    isTeam: active && seats > 1,
    // 'PAID' | 'ADMIN' | 'FREE' — where the access in force came from.
    source: snap.subscriptionSource || (active ? 'payment' : 'free'),
    // The two layers, when the server sends them: what the user paid for and
    // what an admin layered on top (plus what "restore original" returns to).
    layers: snap.subscriptionLayers && typeof snap.subscriptionLayers === 'object'
      ? snap.subscriptionLayers
      : null,
    version: snap.version || null,
    entitlements: snap.entitlements && typeof snap.entitlements === 'object' ? snap.entitlements : null,
    limits: snap.limits && typeof snap.limits === 'object' ? snap.limits : null,
  };
}

/**
 * Normalize any user-like object (server /me, login payload, SSE snapshot,
 * admin PATCH) into { active, plan, rank, label, status, end, version,
 * entitlements, limits, daysRemaining, permanent, source }.
 * Inactive/expired always falls back to FREE.
 */
export function planFromUser(user) {
  const snap = snapshotOf(user);
  if (snap) return fromSnapshot(snap);

  const flaggedActive = user?.subscriptionActive === true;
  const permanent = flaggedActive && user?.subscriptionPermanent === true;
  const expired = !permanent && isPast(user?.subscriptionExpiresAt);
  const plan = flaggedActive && !expired && PLAN_RANK[user?.subscriptionPlan] !== undefined
    ? user.subscriptionPlan
    : 'free';
  const active = plan !== 'free';
  const end = user?.subscriptionExpiresAt || null;
  const remainingMs = active && !permanent && end ? Math.max(0, new Date(end).getTime() - Date.now()) : null;
  const seats = active ? Math.max(1, Number(user?.subscriptionSeats) || 1) : 1;
  return {
    active,
    plan,
    rank: PLAN_RANK[plan] ?? 0,
    label: PLAN_LABELS[plan] || PLAN_LABELS.free,
    status: expired ? 'expired' : active ? 'active' : 'free',
    end,
    start: user?.subscriptionStartedAt || null,
    permanent,
    daysRemaining: active ? daysLeftFrom(end, nowMs()) : null,
    remainingMs,
    seats,
    isTeam: active && seats > 1,
    source: user?.subscriptionSource || (active ? 'payment' : 'free'),
    layers: null,
    version: null,
    entitlements: null,
    limits: null,
  };
}

// Merge server-fresh subscription fields into the cached user and return the
// normalized plan. Never touches pictures/blobs.
//
// IMPORTANT: the change event lives in the subscription store's commit() and
// fires ONLY when the plan actually changed. Broadcasting on every call made
// subscription listeners (which refresh the plan) feed themselves:
// publish → listen → refresh → publish. That loop once burned the auth rate
// limit in seconds and escalated the lockout ladder.
export function applyPlanToCache(fresh) {
  const cached = readStoredUser();

  const snap = snapshotOf(fresh);
  const hasRaw = !!fresh && (fresh.subscriptionActive !== undefined || fresh.subscriptionPlan !== undefined);
  // A resolved snapshot wins; a raw-only payload REPLACES a cached snapshot
  // so stale premium state can never mask a server-side downgrade. Guarded on
  // the payload actually carrying a plan worth trusting — otherwise a caller
  // that merely echoes one field would wipe a perfectly good snapshot (and
  // with it the entitlement map + subscriptionEnd the gates render from).
  const nextSnap = snap || (hasRaw && fresh.subscriptionPlan !== undefined ? null : (cached.subscription ?? null));

  const merged = {
    ...cached,
    subscriptionActive: fresh?.subscriptionActive ?? (snap ? snap.subscriptionActive : cached.subscriptionActive),
    subscriptionPlan: fresh?.subscriptionPlan ?? (snap ? snap.currentPlan : cached.subscriptionPlan),
    subscriptionExpiresAt: fresh?.subscriptionExpiresAt
      ?? (snap ? snap.subscriptionEnd : cached.subscriptionExpiresAt)
      ?? null,
    subscriptionStartedAt: fresh?.subscriptionStartedAt ?? (snap ? snap.subscriptionStart : cached.subscriptionStartedAt) ?? null,
    // Permanence and source must survive in the raw fields too: they are what
    // lets a page rendered from the CACHE (before its first network reply)
    // still say "PERMINENT" or "ADMIN GRANT" instead of guessing from a null
    // expiry date.
    subscriptionPermanent: fresh?.subscriptionPermanent
      ?? (snap ? snap.subscriptionPermanent : cached.subscriptionPermanent)
      ?? false,
    subscriptionSource: fresh?.subscriptionSource
      ?? (snap ? snap.subscriptionSource : cached.subscriptionSource)
      ?? null,
    // Seats ride along in the raw fields too, so a page rendered from the
    // CACHE (before its first network reply) still knows whether this is a Team
    // subscription rather than guessing from a plan id.
    subscriptionSeats: fresh?.subscriptionSeats
      ?? (snap ? snap.subscriptionSeats : cached.subscriptionSeats)
      ?? null,
    subscriptionUpdatedAt: fresh?.subscriptionUpdatedAt ?? cached.subscriptionUpdatedAt ?? null,
    subscription: nextSnap ?? null,
  };

  // Tab session + directory metadata; internal best-effort, no throw path.
  setStoredUser(merged);

  return planFromUser(merged);
}

// True when a normalized plan object meets the minimum tier.
// Use this with `useSubscription()`'s live plan so gates react instantly
// (hasPlanAccess below reads the cache — fine for one-shot checks).
export function planMeetsTier(plan, minTier) {
  return (plan?.rank ?? 0) >= (PLAN_RANK[minTier] ?? 0);
}

// Feature-key gate used by every page: prefers the server-resolved
// entitlement map (snapshot) and falls back to the shared tier table.
//
// The key is resolved through resolveFeatureKey() first, which does an
// OWN-property lookup. Without it, `FEATURES['constructor']` (and
// toString/__proto__/hasOwnProperty) resolves to an inherited member that is
// truthy but has no `minTier` — PLAN_RANK[undefined] ?? 0 is 0, so a FREE
// user would have been answered TRUE for a feature that does not exist.
// Unknown keys now fail closed, exactly like the server's can()/getFeature().
export function hasFeature(plan, featureKey) {
  const key = resolveFeatureKey(featureKey);
  if (!key) return false; // unknown features fail closed (mirrors the server)
  const def = FEATURES[key];
  const entitlements = plan?.entitlements;
  if (entitlements && typeof entitlements[key] === 'boolean') {
    return entitlements[key];
  }
  return (plan?.rank ?? 0) >= (PLAN_RANK[def.minTier] ?? 0);
}

/**
 * THE centralized entitlement check.
 *
 *   canAccess('priority_assessment')   // spec spelling
 *   canAccess('priorityAssessment')    // canonical spelling
 *
 * Reads a plan object when one is supplied (components pass their live
 * `useSubscription()` state so the result re-renders with the store), and
 * otherwise falls back to the shared store — so non-React code, event
 * handlers and one-shot checks all consult the SAME authoritative state
 * instead of re-deriving tier rules locally.
 *
 * Frontend visibility ONLY. The backend re-decides every request via
 * can()/requireFeature(); a 403 from the API always wins.
 */
export function canAccess(featureKey, plan) {
  return hasFeature(plan ?? getStoredPlan(), featureKey);
}

// True when the plan (or the shared store) meets the minimum tier.
export function canAccessTier(minTier, plan) {
  return planMeetsTier(plan ?? getStoredPlan(), minTier);
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
