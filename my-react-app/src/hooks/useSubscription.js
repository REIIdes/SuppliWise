// Reactive subscription store — single source of truth for the user's plan.
// Any part of the app can publish a fresh plan and every subscriber updates
// instantly: no refresh, no reopen, no re-login needed.
//
// Sync paths (all funnel into commit(), which notifies + dispatches exactly
// once per REAL change):
// - GET /api/subscription/stream (SSE): admin upgrade/downgrade/cancel/remove
//   lands in this tab instantly, cross-device, with no polling at all.
// - A BroadcastChannel relay between same-account tabs: if one tab's stream is
//   down, another tab's committed state still corrects it immediately.
// - A local expiry timer flips the plan to FREE at the exact second
//   subscriptionExpiresAt passes, even with no server round-trip.
// - A shared throttled poll + focus/visibility refresh as the fallback.
// - resetSubscriptionStore() on sign-out: no state or stream outlives a session.
//
// The store is kept alive by <SubscriptionSync /> in App.jsx — NOT by whichever
// page happens to be mounted (see that component for why).
//
// Access rules: use the hook's canAccess("priority_assessment") /
// canAccessTier("annual") for every subscription-dependent UI check. That is
// the single frontend interpretation of entitlements; the backend independently
// enforces each request through can()/requireFeature() and answers 403.
//
// Design notes (learned the hard way):
// - ONE shared network refresh for the whole app. Previously every component
//   using this hook ran its own interval + focus listener, which multiplied
//   /auth/me traffic by the number of mounted pages.
// - refresh() is deduped (single in-flight promise) and throttled, so event
//   listeners that call it cannot storm the server.
// - Events publish ONLY on a real plan change, so a listener that refreshes
//   can never feed itself (publish → refresh → publish loop).
// - A 429 pauses refreshing for the server cooldown instead of retrying into
//   the lockout ladder.
import { useCallback, useEffect, useMemo, useState } from 'react';
import useAuth from './useAuth';
import { getStoredPlan, applyPlanToCache, planFromUser, hasFeature, planMeetsTier } from '../utils/plan';
import { getMyProfile, getToken, getStoredUser, BASE_URL } from '../api';
import { SUBSCRIPTION_REVALIDATE_EVENT } from '../auth/authState';

export const SUBSCRIPTION_EVENT = 'suppliwise:subscription';
export const SUBSCRIPTION_ADMIN_EVENT = 'suppliwise:subscription-admin';

// How often one shared background refresh runs (visible tabs only). Kept at
// 60s: it is the safety net for a downgrade whose live push was missed (closed
// SSE stream, asleep tab, admin edited the record outside the panel), and a
// stale premium UI is worse than one extra lightweight /auth/me per minute.
export const SUBSCRIPTION_POLL_MS = 60000;
// Hard floor between two shared network refreshes.
const MIN_REFRESH_INTERVAL_MS = 30000;
// Escalating client-side cool-down when the server says 429.
const BACKOFF_STEPS_MS = [60000, 300000, 900000];
const MAX_BACKOFF_MS = 15 * 60 * 1000;

// ── Shared store (module-level, one per browser tab) ─────────────────────
let sharedPlan = null;          // canonical { active, plan, rank, ... }
const subscribers = new Set();  // React state setters
let inFlight = null;            // dedupe concurrent refreshes
let lastFetchAt = 0;            // throttle floor
let cooldownUntil = 0;          // 429 backoff
let backoffStep = 0;
let pollTimer = null;
let globalListenersAttached = false;
// True only while a payload from ANOTHER tab is being applied, so the
// cross-tab relay can never echo a message back at its sender.
let applyingRemote = false;
// Hard floor for forced refreshes: even if an event listener calls refresh()
// repeatedly, the server never sees more than one request per FORCE_MIN_GAP_MS.
const FORCE_MIN_GAP_MS = 5000;
let lastForcedAt = 0;

function samePlan(a, b) {
  return !!a && !!b && a.active === b.active && a.plan === b.plan;
}

// Accept a normalized plan OR a full user doc ({ subscriptionActive, ... }).
function normalize(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  if (candidate.subscriptionActive !== undefined || typeof candidate.currentPlan === 'string') {
    return planFromUser(candidate);
  }
  if (candidate.plan && candidate.rank !== undefined) {
    // Keep entitlement metadata (end/version/entitlements) when present.
    return { ...candidate, active: candidate.active === true };
  }
  return null;
}

function readShared() {
  if (!sharedPlan) sharedPlan = getStoredPlan();
  return sharedPlan;
}

// ── Expiry watch: flip to FREE the moment the subscription ends ─────────
let expiryTimer = null;
function scheduleExpiryWatch(plan) {
  if (typeof window === 'undefined') return;
  if (expiryTimer) {
    window.clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  if (!plan?.active || !plan.end) return;
  const at = new Date(plan.end).getTime();
  const delay = at - Date.now();
  if (!Number.isFinite(at) || delay <= 0 || delay > 2147483647) return;
  expiryTimer = window.setTimeout(() => {
    expiryTimer = null;
    const prev = readShared();
    const next = getStoredPlan(); // re-resolves the cached state against NOW
    if (next.active !== prev.active || next.plan !== prev.plan) {
      commit(next); // notifies subscribers + dispatches SUBSCRIPTION_EVENT
    }
  }, delay + 1500);
}

// ── Server push (SSE): instant cross-device sync, no refresh needed ─────
let eventSource = null;
let sseToken = null;
let sseRetryTimer = null;
let sseBackoffStep = 0;
const SSE_RETRY_STEPS_MS = [5000, 15000, 60000];

function closeSubscriptionStream() {
  if (sseRetryTimer) {
    window.clearTimeout(sseRetryTimer);
    sseRetryTimer = null;
  }
  if (eventSource) {
    try { eventSource.close(); } catch { /* already closed */ }
    eventSource = null;
  }
  sseToken = null;
  sseBackoffStep = 0;
}

function startSubscriptionStream() {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
  const token = getToken();
  if (!token) {
    closeSubscriptionStream();
    return;
  }
  if (eventSource && sseToken === token) return; // live for this session
  closeSubscriptionStream();
  sseToken = token;
  try {
    const es = new EventSource(`${BASE_URL}/subscription/stream?token=${encodeURIComponent(token)}`);
    eventSource = es;
    es.addEventListener('subscription', (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload?.subscription) {
          sseBackoffStep = 0;
          const next = applyPlanToCache(payload.subscription);
          commit(next); // no-ops unless the plan really changed
        }
      } catch { /* malformed frame — the reconnect snapshot recovers state */ }
    });
    es.onerror = () => {
      // EventSource retries transient failures itself; a hard close (401 after
      // token expiry) needs a fresh token before reconnecting.
      if (es.readyState === EventSource.CLOSED) {
        try { es.close(); } catch { /* ignore */ }
        if (eventSource === es) eventSource = null;
        const wait = SSE_RETRY_STEPS_MS[Math.min(sseBackoffStep, SSE_RETRY_STEPS_MS.length - 1)];
        sseBackoffStep += 1;
        if (!sseRetryTimer) {
          sseRetryTimer = window.setTimeout(() => {
            sseRetryTimer = null;
            startSubscriptionStream();
          }, wait);
        }
      }
    };
  } catch {
    eventSource = null;
    sseToken = null;
  }
}

// Keep the stream aligned with the auth token (login/logout in this tab).
function syncSubscriptionStream() {
  const token = getToken();
  if (!token) {
    if (eventSource) closeSubscriptionStream();
    return;
  }
  if (!eventSource || sseToken !== token) startSubscriptionStream();
}

function notify() {
  for (const setter of subscribers) setter(sharedPlan);
}

// ── Cross-tab relay ──────────────────────────────────────────────────────
// Sessions are deliberately per-tab (Tab 1 = Account A, Tab 2 = Account B), so
// storage events can never be used to share a plan. Each tab does hold its own
// SSE stream, but if one stream is down (proxy buffering, throttled background
// tab, network blip) that tab silently keeps rendering the OLD plan until its
// next poll. Relaying the committed doc closes the gap instantly with no
// polling: every tab agrees within one message.
//
// Echo safety: a receiving tab sets applyingRemote, so its own commit() will
// not re-broadcast. Messages are also dropped unless they belong to the SAME
// account id — a second account's tab must never be repainted with someone
// else's entitlements (the same guard SUBSCRIPTION_ADMIN_EVENT uses).
const TAB_SUBSCRIPTION_CHANNEL = 'suppliwise:subscription';
let tabChannel = null;

function ensureTabChannel() {
  if (tabChannel || typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(TAB_SUBSCRIPTION_CHANNEL);
    channel.onmessage = (event) => {
      const doc = event?.data;
      if (!doc || typeof doc !== 'object' || !doc._id) return;
      const mine = getStoredUser()?._id;
      if (!mine || String(doc._id) !== String(mine)) return;
      applyingRemote = true;
      try {
        commit(applyPlanToCache(doc)); // no-ops unless the plan really changed
      } finally {
        applyingRemote = false;
      }
    };
    tabChannel = channel;
  } catch {
    tabChannel = null; // unsupported context — SSE + poll still cover us
  }
}

function broadcastToTabs() {
  if (applyingRemote || !tabChannel) return;
  const doc = getStoredUser();
  const snapshot = doc?.subscription;
  // Only relay a server-resolved snapshot: it carries subscriptionEnd/version,
  // which the receiving tab's expiry watch and idempotent commit both need.
  // Without one, SSE and the shared poll still cover that tab.
  if (!doc?._id || !snapshot || typeof snapshot.currentPlan !== 'string') return;
  // Minimal payload — identity for the receiver's same-account guard plus the
  // fields applyPlanToCache() reads. Deliberately NOT the whole profile: the
  // cached user can carry multi-megabyte base64 profile/banner images, and
  // this runs on every commit. Nothing here is a credential (the JWT lives in
  // its own storage key and is never included).
  try {
    tabChannel.postMessage({
      _id: doc._id,
      subscriptionActive: doc.subscriptionActive,
      subscriptionPlan: doc.subscriptionPlan,
      subscriptionExpiresAt: doc.subscriptionExpiresAt ?? null,
      subscriptionUpdatedAt: doc.subscriptionUpdatedAt ?? null,
      subscription: snapshot,
    });
  } catch { /* structured-clone failure — self state is already correct */ }
}

// Update the shared plan; notify subscribers + dispatch the change event
// only on an actual change. This is the ONE dispatch point for
// SUBSCRIPTION_EVENT, so refresh results, SSE pushes, the expiry timer and
// admin broadcasts all reach page listeners exactly once per real change.
function commit(next, { force = false } = {}) {
  if (!next) return readShared();
  const prev = readShared();
  if (!force && samePlan(prev, next) && prev.rank === next.rank) {
    // Same plan/rank, but the entitlement METADATA may have changed (extended
    // expiry, new version, first real entitlement map after the cache resolved
    // from raw flags). Commit it AND re-render subscribers.
    //
    // This used to write sharedPlan without notify(), so every hook consumer
    // (the profile's lock grid, the history gates…) kept rendering the stale
    // snapshot — a qualified user could stay visibly "locked" with no way to
    // recover short of a remount or a rank change.
    //
    // Deliberately NO SUBSCRIPTION_EVENT dispatch here: that event is what
    // used to feed listeners that refresh() back into publish → refresh →
    // publish. React setState alone cannot loop.
    //
    // version is a deterministic signature over plan/status/start/end/updated,
    // and entitlements+limits are pure functions of the plan — so comparing
    // version, end and status catches every real metadata change without
    // re-rendering on every poll (the maps are rebuilt objects each call).
    if (prev.end !== next.end || prev.version !== next.version
        || prev.status !== next.status) {
      sharedPlan = next;
      scheduleExpiryWatch(next);
      notify();
      broadcastToTabs();
    }
    return sharedPlan;
  }
  sharedPlan = next;
  scheduleExpiryWatch(next);
  notify();
  broadcastToTabs();
  try {
    window.dispatchEvent(new CustomEvent(SUBSCRIPTION_EVENT, { detail: next }));
  } catch { /* non-browser safe */ }
  return sharedPlan;
}

// Public: broadcast a plan (or a full user doc) to every subscriber.
export function publishSubscription(candidate) {
  const normalized = normalize(candidate);
  if (!normalized) return null;
  if (candidate && (candidate.subscriptionActive !== undefined || typeof candidate.currentPlan === 'string')) {
    return commit(applyPlanToCache(candidate));
  }
  return commit(normalized);
}

function scheduleCooldown(seconds, error) {
  const fromError = Number(seconds) || Number(error?.retryAfterSeconds) || 0;
  const wait = fromError > 0
    ? fromError * 1000
    : BACKOFF_STEPS_MS[Math.min(backoffStep, BACKOFF_STEPS_MS.length - 1)];
  if (fromError <= 0) backoffStep += 1;
  const capped = Math.min(wait, MAX_BACKOFF_MS);
  cooldownUntil = Date.now() + capped;
  // One long timer so the store self-heals after the cooldown — no retry storm.
  window.setTimeout(() => { refreshShared({ force: true }); }, capped + 500);
}

// Shared refresh: throttled, deduped, cooldown-aware, visibility-gated.
export function refreshShared({ force = false } = {}) {
  // Keep the live push channel aligned with the auth token even when the
  // network refresh itself is throttled (login/logout in this tab).
  syncSubscriptionStream();
  const now = Date.now();
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && !force) {
    return Promise.resolve(readShared());
  }
  if (!force && now < cooldownUntil) return Promise.resolve(readShared());
  if (!force && now - lastFetchAt < MIN_REFRESH_INTERVAL_MS) return Promise.resolve(readShared());
  // Forced calls (plan-change reactions) still respect a small hard gap so a
  // misbehaving listener can never turn into a request storm.
  if (force && now - lastForcedAt < FORCE_MIN_GAP_MS) {
    return inFlight || Promise.resolve(readShared());
  }
  if (inFlight) return inFlight;

  lastFetchAt = now;
  if (force) lastForcedAt = now;
  inFlight = (async () => {
    try {
      const fresh = await getMyProfile();
      backoffStep = 0;
      return commit(applyPlanToCache(fresh));
    } catch (error) {
      // 429 / network blip: cool down silently. Never surfaces to the UI and
      // never retries in a tight loop (that is what escalated the lockout).
      if (error?.status === 429) scheduleCooldown(error.retryAfterSeconds, error);
      return readShared();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function attachGlobalListeners() {
  if (globalListenersAttached || typeof window === 'undefined') return;
  globalListenersAttached = true;

  // Same-account tabs relay committed state to each other (see above).
  ensureTabChannel();

  const onEvent = (e) => {
    const detail = e?.detail;
    const next = normalize(detail);
    if (next) {
      // Full user docs are cached too (login payloads, own-profile saves).
      if (detail && detail.subscriptionActive !== undefined) applyPlanToCache(detail);
      // commit() re-dispatches only on a real change; echoing our own
      // unchanged detail settles immediately (no loop).
      commit(next);
    } else {
      commit(getStoredPlan());
    }
  };

  // The admin console broadcasts the document of whichever account it just
  // edited. That payload is almost never THIS session's account, so feeding it
  // through onEvent() silently replaced the signed-in user's cached plan with
  // a stranger's — every gate on the page then rendered someone else's
  // entitlements. Only accept a match on the signed-in account id; SSE already
  // delivers the authoritative push to the target user's own sessions.
  const onAdminEvent = (e) => {
    const detail = e?.detail;
    if (!detail || typeof detail !== 'object') return;
    // getStoredUser() is internally try/caught — never throws here.
    const mine = getStoredUser()?._id || null;
    if (!mine || !detail._id || String(detail._id) !== String(mine)) return;
    const next = normalize(detail);
    if (!next) return;
    applyPlanToCache(detail);
    commit(next);
  };

  const onVisible = () => { if (document.visibilityState === 'visible') refreshShared(); };

  // The API layer fires this when the SERVER refuses a request for plan
  // reasons (403 + requiresPlan). That verdict is authoritative proof this
  // tab's plan is stale — a revoked/expired plan must lock every gate at once
  // rather than wait for the next push or poll. Forced (not throttled) because
  // it is triggered by a real rejection, and deduped + gap-floored by the store.
  const onRevalidate = () => { refreshShared({ force: true }); };

  window.addEventListener(SUBSCRIPTION_EVENT, onEvent);
  window.addEventListener(SUBSCRIPTION_ADMIN_EVENT, onAdminEvent);
  window.addEventListener(SUBSCRIPTION_REVALIDATE_EVENT, onRevalidate);
  window.addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);

  // Live server push + local expiry watch from the moment the app mounts.
  syncSubscriptionStream();
  scheduleExpiryWatch(readShared());
}

function startSharedPolling() {
  if (pollTimer || typeof window === 'undefined') return;
  pollTimer = window.setInterval(() => { refreshShared(); }, SUBSCRIPTION_POLL_MS);
}

function stopSharedPolling() {
  if (!pollTimer) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}

/**
 * Tear the store down when the session ends (sign-out, account switch, 401).
 *
 * sharedPlan and lastFetchAt used to survive sign-out, which caused two real
 * bugs:
 *   1. The next sign-in mounted with `useState(() => readShared())` = the
 *      PREVIOUS user's plan, and refreshShared() was still inside its 30s
 *      throttle, so that user's entitlements were rendered for up to 30s.
 *   2. The previous session's EventSource stayed open (user tokens carry no
 *      `exp`), so a push addressed to the old account could land in a cache
 *      that now belonged to someone else.
 *
 * Clearing here closes the stream and forces the next session to re-read the
 * (now empty) cache and fetch fresh state immediately.
 */
export function resetSubscriptionStore() {
  closeSubscriptionStream();
  sharedPlan = null;
  inFlight = null;
  lastFetchAt = 0;
  lastForcedAt = 0;
  cooldownUntil = 0;
  backoffStep = 0;
  if (expiryTimer) {
    window.clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  stopSharedPolling();
}

export function useSubscription() {
  const { token } = useAuth();
  const [plan, setPlan] = useState(() => readShared());

  // Register the setter so store updates re-render only this component. Guest
  // widgets (including the global chat) may mount this hook, but must never
  // call /auth/me without a token — apiFetch treats that 401 as a dead session
  // and redirects a perfectly valid public page to /login.
  useEffect(() => {
    subscribers.add(setPlan);
    if (!token) {
      const timer = setTimeout(() => setPlan(planFromUser({})), 0);
      return () => {
        clearTimeout(timer);
        subscribers.delete(setPlan);
      };
    }

    attachGlobalListeners();
    startSharedPolling();
    // Pull once when a user session becomes active (throttled — safe for many
    // simultaneous mounts). The token dependency also handles account switches.
    refreshShared();
    return () => {
      subscribers.delete(setPlan);
      if (subscribers.size === 0) stopSharedPolling();
    };
  }, [token]);

  // Accept a full user doc (server /me, login payload, profile save).
  const applyFresh = useCallback((fresh) => {
    const normalized = normalize(fresh);
    if (!normalized) return null;
    if (fresh && (fresh.subscriptionActive !== undefined || typeof fresh.currentPlan === 'string')) {
      return commit(applyPlanToCache(fresh));
    }
    return commit(normalized);
  }, []);

  const refresh = useCallback(() => refreshShared({ force: true }), []);

  // Centralized gates, bound to THIS component's snapshot of the store.
  // Binding to `plan` (rather than reading the module store during render)
  // keeps render pure: the value changes only when the store notifies, which
  // is exactly when React re-renders. Any feature spelling works —
  // canAccess('pdf_reports') === canAccess('pdfExport').
  const canAccess = useCallback(
    (featureKey) => hasFeature(plan, featureKey),
    [plan],
  );
  const canAccessTier = useCallback(
    (minTier) => planMeetsTier(plan, minTier),
    [plan],
  );

  // Stable identity across renders unless the plan actually changed, so
  // consumers can safely list it in dependency arrays.
  const gates = useMemo(
    () => ({ canAccess, canAccessTier }),
    [canAccess, canAccessTier],
  );

  return { ...plan, refresh, applyFresh, ...gates };
}

export default useSubscription;
