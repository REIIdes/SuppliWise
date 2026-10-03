/**
 * Simple in-memory cache with TTL for static data.
 *
 * Used for data that changes rarely (plan catalogue, supplement details)
 * to avoid repeated DB round-trips. Not suitable for user-specific data.
 */

const cache = new Map(); // key -> { value, exp }

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 1000;

function get(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlMs = DEFAULT_TTL_MS) {
  if (cache.size >= MAX_ENTRIES) {
    // Evict expired entries first
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.exp) cache.delete(k);
    }
    // If still too large, delete oldest 25%
    if (cache.size >= MAX_ENTRIES) {
      const keys = [...cache.keys()];
      for (let i = 0; i < keys.length / 4; i++) {
        cache.delete(keys[i]);
      }
    }
  }
  cache.set(key, { value, exp: Date.now() + ttlMs });
}

function del(key) {
  cache.delete(key);
}

function clear() {
  cache.clear();
}

/**
 * Request deduplication: if multiple identical requests arrive concurrently,
 * only one hits the DB. The others wait for the same promise.
 */
const inflight = new Map(); // key -> Promise

async function dedupe(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = fn().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}

module.exports = { get, set, del, clear, dedupe };
