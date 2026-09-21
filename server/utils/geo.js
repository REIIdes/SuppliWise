/**
 * IP-based device/location helpers.
 * - Normalizes IPs (strips IPv6-mapped IPv4 prefix).
 * - Classifies loopback / private ranges (no external lookup for those).
 * - Resolves public IPs to "City, Region, Country" via a cached, timed-out
 *   lookup so a slow geo service can never stall login or admin views.
 */

const GEO_TIMEOUT_MS = 3500;
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_CACHE_MAX = 1000;

// ip -> { value, at }
const geoCache = new Map();

function normalizeIp(raw) {
  if (!raw) return '';
  let ip = String(raw).trim();
  // Express often reports IPv4 as ::ffff:1.2.3.4
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  return ip;
}

function ipKind(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip) return 'unknown';
  if (ip === '127.0.0.1' || ip === '::1' || ip.toLowerCase() === 'localhost') return 'loopback';
  // IPv4 private ranges: 10/8, 172.16/12, 192.168/16, link-local, carrier-grade
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.)/.test(ip)) return 'private';
  // IPv6 unique-local / link-local
  if (/^(fc|fd)/i.test(ip.replace(/:/g, '')) || /^fe80:/i.test(ip)) return 'private';
  if (/^[0-9a-f:.]+$/i.test(ip)) return 'public';
  return 'unknown';
}

function pruneCache() {
  if (geoCache.size <= GEO_CACHE_MAX) return;
  const now = Date.now();
  for (const [key, entry] of geoCache) {
    if (now - entry.at > GEO_CACHE_TTL_MS) geoCache.delete(key);
    if (geoCache.size <= GEO_CACHE_MAX) break;
  }
}

/**
 * Resolve a public IP to a human location. Returns null when unknown —
 * callers must fall back to the raw IP or an "Unknown location" label.
 */
async function lookupLocation(rawIp) {
  const ip = normalizeIp(rawIp);
  const kind = ipKind(ip);
  if (kind === 'loopback') return 'This device';
  if (kind === 'private') return 'Local network';
  if (kind !== 'public') return null;

  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.at < GEO_CACHE_TTL_MS) return cached.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city`,
      { signal: controller.signal }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.status !== 'success') return null;
    const parts = [data.city, data.regionName, data.country].filter(Boolean);
    const value = parts.length > 0 ? parts.join(', ') : null;
    if (value) {
      geoCache.set(ip, { value, at: Date.now() });
      pruneCache();
    }
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort login-location resolution. Fire-and-forget: updates the user's
 * stored location in the background without delaying the login response.
 */
function resolveLoginLocation(userId, rawIp, currentLocation) {
  if (currentLocation && currentLocation !== 'Unknown location') return;
  const ip = normalizeIp(rawIp);
  if (!ip) return;
  lookupLocation(ip).then((value) => {
    if (!value) return;
    const User = require('../models/User');
    return User.updateOne({ _id: userId }, { $set: { lastLoginLocation: value } }).exec();
  }).catch(() => {});
}

/**
 * Background backfill for admin views: resolves unknown locations for the
 * given users (each needs _id + lastLoginIp) without blocking the response.
 */
function backfillLocations(users) {
  const targets = (users || []).filter(
    u => u && u._id && (!u.lastLoginLocation || u.lastLoginLocation === 'Unknown location') && u.lastLoginIp
  );
  if (targets.length === 0) return;
  Promise.allSettled(
    targets.slice(0, 25).map(u =>
      lookupLocation(u.lastLoginIp).then((value) => {
        if (!value) return;
        const User = require('../models/User');
        return User.updateOne({ _id: u._id }, { $set: { lastLoginLocation: value } }).exec();
      })
    )
  ).catch(() => {});
}

module.exports = {
  normalizeIp,
  ipKind,
  lookupLocation,
  resolveLoginLocation,
  backfillLocations,
};
