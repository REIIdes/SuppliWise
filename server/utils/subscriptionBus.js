/**
 * Subscription change bus (single-instance deploy — same assumption as
 * utils/lockout.js).
 *
 * Admins publish a user's new authoritative subscription state here; every open
 * SSE stream for that user receives it immediately. This is what makes
 * admin-initiated changes (upgrade, downgrade, cancel, removal, expiry) land in
 * the user's open tab/phone with no refresh, no re-login and no polling storm.
 *
 * The bus is intentionally dumb: it only fans out. The backend remains the
 * source of truth — a missed push is always recoverable from
 * GET /api/subscription.
 */

const listeners = new Map(); // userId -> Set<fn>
const lastPublished = new Map(); // userId -> { state, at }

const keyOf = (userId) => String(userId || '').trim();

function subscribe(userId, fn) {
  const key = keyOf(userId);
  if (!key || typeof fn !== 'function') return () => {};
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => {
    const set = listeners.get(key);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) listeners.delete(key);
  };
}

// Fan out a resolved state (see utils/entitlements.js -> describeSubscription).
function publish(userId, state) {
  const key = keyOf(userId);
  if (!key || !state) return 0;
  lastPublished.set(key, { state, at: Date.now() });
  const set = listeners.get(key);
  if (!set || set.size === 0) return 0;
  let delivered = 0;
  for (const fn of [...set]) {
    try {
      fn(state);
      delivered += 1;
    } catch (error) {
      // A dead client must never break the publisher.
      console.error('[subscription-bus] listener failed:', error.message);
    }
  }
  return delivered;
}

// Optional: lets a reconnecting client skip a redundant full fetch.
function lastState(userId) {
  const entry = lastPublished.get(keyOf(userId));
  return entry ? entry.state : null;
}

function listenerCount(userId) {
  const set = listeners.get(keyOf(userId));
  return set ? set.size : 0;
}

module.exports = { subscribe, publish, lastState, listenerCount };
