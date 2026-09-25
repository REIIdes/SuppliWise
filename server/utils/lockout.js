/**
 * Escalating lockout: repeated abuse stretches from 15 minutes up to 1 day.
 * - IP bucket: every rate-limit (429) hit records an offense for the IP.
 * - Account bucket: failed credentials / bad codes record an offense for the
 *   account key (email or admin alias). Success clears the account bucket.
 * Both are in-memory (single-instance dev/small deploy). Entries prune lazily.
 */

const LADDER_MS = [15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const MAX_ENTRIES = 2000;

// How long an offense history survives after the last incident.
//
// The ladder is meant to escalate: 3 bad passwords, wait out 15 minutes, 3
// more, and the next pause is an HOUR. That only works if the offense count
// outlives the lock. It previously did not — `lockRemainingMs` deleted the
// whole entry the moment the lock expired, so every subsequent incident
// restarted at rung 1 and the 1 h / 6 h / 24 h rungs were unreachable on the
// ordinary request path.
//
// The count still has to decay, or a user who had one bad month would still be
// served a 24 h lock a year later. A month of clean sign-ins resets the ladder.
const OFFENSE_DECAY_MS = 30 * 24 * 60 * 60 * 1000;

const crypto = require('crypto');

// Browsers never expose MAC addresses to web apps, so bypass resistance
// binds IP + device fingerprint instead: rotating IPs alone won't dodge an
// account lock, and hammering many accounts from one IP trips an IP lock.

// Device fingerprint from request signals (UA + language + IP class).
// Stable per device/network, opaque (hashed, truncated).
function deviceFingerprint(req, ip) {
  const ua = String((req && req.get && req.get('user-agent')) || '');
  const lang = String((req && req.get && req.get('accept-language')) || '').split(',')[0];
  const shortIp = String(ip || '').split('.').slice(0, 2).join('.');
  return crypto.createHash('sha256').update(`${ua}|${lang}|${shortIp}`).digest('hex').slice(0, 12);
}

// Per-IP distinct-account failure tracking (credential-stuffing tripwire):
// one IP failing DIFFERENT accounts hits the IP ladder fast.
const IP_ACCOUNT_THRESHOLD = 3;
const IP_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
const ipAccountHits = new Map(); // ip -> { emails: Set, firstAt }

// key -> { offenses, lockedUntil, lastOffenseAt, ips: [], fps: [], agents: [] }
const buckets = new Map();

/**
 * Evidence bundle attached to lockout entries (IP + device fingerprint + UA)
 * so rotating IPs cannot dodge an account lock unnoticed.
 *
 * Lives here rather than in a route so every caller builds the same shape —
 * this was previously private to routes/auth.js, and a second caller reaching
 * for it got `undefined`, which turned a handled 401 into a 500.
 */
function lockMeta(req, ip) {
  const cleanIp = ip || (req && req.ip) || '';
  return {
    ip: cleanIp,
    fp: deviceFingerprint(req, cleanIp),
    agent: String((req && req.get && req.get('user-agent')) || '').slice(0, 120),
  };
}

function normKey(key) {
  return String(key || '').trim().toLowerCase().slice(0, 160);
}

// True when this entry's offense history is too old to still count.
function decayed(entry, now) {
  return !entry.lastOffenseAt || (now - entry.lastOffenseAt) > OFFENSE_DECAY_MS;
}

function prune() {
  if (buckets.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of buckets) {
    // Evict only entries that are BOTH unlocked and fully decayed — never one
    // still serving a lock, and never one whose offense count still matters.
    if (now > entry.lockedUntil && decayed(entry, now)) buckets.delete(key);
    if (buckets.size <= MAX_ENTRIES) break;
  }
}

function ladderFor(offenses) {
  return LADDER_MS[Math.min(Math.max(offenses - 1, 0), LADDER_MS.length - 1)];
}

// Record an offense; returns the new lockout expiry timestamp.
// Optional meta binds evidence to the entry: { ip, fp, agent }.
function recordOffense(rawKey, meta) {
  const key = normKey(rawKey);
  if (!key) return 0;
  const now = Date.now();
  const prev = buckets.get(key);
  // Resume the ladder rather than restarting it: an expired-but-not-decayed
  // entry keeps its offense count, so the next incident escalates. A decayed
  // one starts clean, so a long-quiet account isn't punished forever.
  const carried = prev && !decayed(prev, now) ? prev.offenses : 0;
  const base = (prev && !decayed(prev, now)) ? prev : { ips: [], fps: [], agents: [] };
  const offenses = carried + 1;
  const lockedUntil = now + ladderFor(offenses);
  const push = (arr, value, max) => {
    const v = String(value || '').slice(0, 200);
    if (v && !arr.includes(v)) arr.push(v);
    return arr.slice(-max);
  };
  buckets.set(key, {
    offenses,
    lockedUntil,
    lastOffenseAt: now,
    ips: push(base.ips || [], meta && meta.ip, 5),
    fps: push(base.fps || [], meta && meta.fp, 5),
    agents: push(base.agents || [], meta && meta.agent, 3),
  });
  prune();
  return lockedUntil;
}

// Raw lockout entry (for admin evidence display). Returns null when clear.
function lockEntry(rawKey) {
  const key = normKey(rawKey);
  if (!key) return null;
  if (lockRemainingMs(rawKey) <= 0) return null;
  const entry = buckets.get(key) || {};
  return {
    offenses: entry.offenses || 0,
    remainingSeconds: Math.ceil(lockRemainingMs(rawKey) / 1000),
    ips: entry.ips || [],
    fps: entry.fps || [],
    agents: entry.agents || [],
  };
}
// Full lockout snapshot for admin display (never exposes internals beyond
// what's needed: remaining time + bound IPs/fingerprints).
function lockInfo(rawKey) {
  const key = normKey(rawKey);
  if (!key) return { locked: false, remainingSeconds: 0, ips: [], fps: [] };
  const left = lockRemainingMs(rawKey);
  if (left <= 0) return { locked: false, remainingSeconds: 0, ips: [], fps: [] };
  const entry = buckets.get(key) || {};
  return {
    locked: true,
    remainingSeconds: Math.ceil(left / 1000),
    ips: entry.ips || [],
    fps: entry.fps || [],
  };
}

// Credential-stuffing tripwire: distinct accounts failing from ONE ip.
// Call on every failed credential check; returns true the moment the IP
// itself earns a ladder lock.
function noteIpAccountFailure(ip, accountId) {
  const cleanIp = String(ip || '').trim();
  const cleanAcct = String(accountId || '').trim().toLowerCase();
  if (!cleanIp || !cleanAcct) return false;
  const now = Date.now();
  let hit = ipAccountHits.get(cleanIp);
  if (!hit || now - hit.firstAt > IP_ACCOUNT_WINDOW_MS) {
    hit = { emails: new Set(), firstAt: now };
  }
  hit.emails.add(cleanAcct);
  ipAccountHits.set(cleanIp, hit);
  if (hit.emails.size >= IP_ACCOUNT_THRESHOLD) {
    ipAccountHits.delete(cleanIp);
    recordOffense(`ip:${cleanIp}`, { ip: cleanIp });
    return true;
  }
  if (ipAccountHits.size > MAX_ENTRIES) {
    for (const [k, v] of ipAccountHits) {
      if (now - v.firstAt > IP_ACCOUNT_WINDOW_MS) ipAccountHits.delete(k);
    }
  }
  return false;
}

// Milliseconds remaining, or 0 when not locked.
//
// An expired lock is CLEARED but the entry is kept, so the offense count that
// drives escalation survives the wait. Deleting the entry here (as this once
// did) is what silently pinned every account to the 15-minute rung.
function lockRemainingMs(rawKey) {
  const key = normKey(rawKey);
  if (!key) return 0;
  const entry = buckets.get(key);
  if (!entry) return 0;
  const left = entry.lockedUntil - Date.now();
  if (left <= 0) {
    if (decayed(entry, Date.now())) buckets.delete(key);
    else entry.lockedUntil = 0;
    return 0;
  }
  return left;
}

// ── Account failure tracking (3-strike lockout) ──────────────────────────
// Single failures (wrong password / bad TOTP) must NOT lock instantly —
// an account locks only after 3 consecutive failures inside 15 minutes,
// then climbs the ladder. OTP-code exhaustion calls recordOffense directly
// (5 wrong codes already happened by then).
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAILS_TO_LOCK = 3;
const attemptTrackers = new Map(); // key -> { count, firstAt }

function recordAccountFailure(rawKey, meta) {
  const key = normKey(rawKey);
  if (!key) return 0;
  const now = Date.now();
  let tracker = attemptTrackers.get(key);
  if (!tracker || now - tracker.firstAt > FAIL_WINDOW_MS) {
    tracker = { count: 0, firstAt: now };
  }
  tracker.count += 1;
  if (tracker.count >= FAILS_TO_LOCK) {
    attemptTrackers.delete(key);
    return recordOffense(key, meta); // ladder lock starts here
  }
  attemptTrackers.set(key, tracker);
  return 0;
}

function clearOffenses(rawKey) {
  const key = normKey(rawKey);
  if (key) buckets.delete(key);
}

// Full reset for an account (success path): clears strikes and ladder locks.
function clearAccountState(rawKey) {
  const key = normKey(rawKey);
  if (!key) return;
  attemptTrackers.delete(key);
  buckets.delete(key);
}

function clientIp(req) {
  // `req.ip` honours Express's `trust proxy` setting, which is the ONLY
  // trustworthy source for a client address:
  //   • trust proxy OFF (the default, and the value used unless
  //     TRUST_PROXY=true) → req.ip is the real socket peer, so a
  //     client-supplied X-Forwarded-For header is ignored entirely. That
  //     header is attacker-controlled: honouring it let anyone rotate their
  //     claimed "IP" and walk straight out of an IP lockout.
  //   • trust proxy ON (explicitly configured for a proxy we control)
  //     → Express itself picks the correct hop from the forwarded chain.
  // Either way the value is derived from server state, never from raw
  // attacker input.
  return String(req.ip || '').trim();
}

const ipKey = (req) => `ip:${clientIp(req)}`;
const accountKey = (kind, id) => `acct:${kind}:${String(id || '').trim().toLowerCase()}`;

// Express middleware: hard-stop IPs sitting out an escalated lockout.
function lockoutCheck(req, res, next) {
  const left = lockRemainingMs(ipKey(req));
  if (left > 0) {
    res.set('Retry-After', String(Math.ceil(left / 1000)));
    return res.status(429).json({
      message: `Too many attempts. Try again in ${Math.ceil(left / 60000)} minute(s).`,
      remainingSeconds: Math.ceil(left / 1000),
      escalated: true,
      lockedBy: 'network',
    });
  }
  next();
}

// Handler factory for express-rate-limit: every 429 escalates the IP ladder.
function limitReachedHandler(message) {
  return (req, res) => {
    const until = recordOffense(ipKey(req));
    const left = Math.max(0, until - Date.now());
    res.set('Retry-After', String(Math.ceil(left / 1000)));
    res.status(429).json({
      message,
      remainingSeconds: Math.ceil(left / 1000),
      escalated: true,
      lockedBy: 'network',
    });
  };
}

function lockoutStats() {
  const now = Date.now();
  let ips = 0;
  let accounts = 0;
  for (const [key, entry] of buckets) {
    if (now > entry.lockedUntil) continue;
    if (key.startsWith('ip:')) ips += 1;
    else accounts += 1;
  }
  return {
    ipsLocked: ips,
    accountsLocked: accounts,
    ladderMinutes: LADDER_MS.map(ms => Math.round(ms / 60000)),
  };
}

// Throttled one-shot notifier: runs fn at most once per ttl per key.
// Used so lockouts page admins once instead of on every blocked attempt.
const notifyMarks = new Map();
function notifyOnce(key, ttlMs, fn) {
  const now = Date.now();
  const last = notifyMarks.get(key) || 0;
  if (now - last < ttlMs) return;
  notifyMarks.set(key, now);
  if (notifyMarks.size > 500) {
    for (const [k, at] of notifyMarks) {
      if (now - at > ttlMs) notifyMarks.delete(k);
    }
  }
  try {
    const out = fn();
    if (out && typeof out.catch === 'function') out.catch(() => {});
  } catch { /* notifications never break auth */ }
}

// Report an account lockout to admins (AdminEvent, with bound IP + device
// evidence) and, when the user is known, to the user (UserNotification for
// their next sign-in). Throttled to one alert per hour per account.
function reportAccountLockout({ email, userId, alias, minutes, lockKey }) {
  const who = email || (userId ? `user ${userId}` : null) || (alias ? `admin "${alias}"` : 'unknown account');
  const key = `lockout-notify:${email || userId || alias || 'unknown'}`;
  notifyOnce(key, 60 * 60 * 1000, async () => {
    let evidence = '';
    try {
      const entry = lockKey ? lockEntry(lockKey) : null;
      const bits = [];
      if (entry && entry.ips.length > 0) bits.push(`IP(s): ${entry.ips.join(', ')}`);
      if (entry && entry.fps.length > 0) bits.push(`device: ${entry.fps.join(', ')}`);
      if (bits.length > 0) evidence = ` [${bits.join(' | ')}]`;
    } catch { /* evidence is best-effort */ }
    const AdminEvent = require('../models/AdminEvent');
    await AdminEvent.create({
      type: 'security',
      title: 'Sign-in locked out',
      detail: `${who} locked out for ~${minutes} minute(s) after continuous failed attempts.${evidence} Escalates to 24 h if abuse continues.`,
    }).catch(() => {});
    try {
      const User = require('../models/User');
      const user = userId
        ? await User.findById(userId).select('_id email').lean()
        : email
          ? await User.findOne({ email: String(email).toLowerCase() }).select('_id email').lean()
          : null;
      if (user) {
        const UserNotification = require('../models/UserNotification');
        await UserNotification.create({
          user: user._id,
          type: 'info',
          title: 'Too many failed sign-in attempts',
          detail: `Sign-in was temporarily paused for your account (~${minutes} minute(s)). If this wasn't you, please change your password once you're back in.`,
        }).catch(() => {});
        // Email twin of the in-app notice (fire-and-await inside the
        // throttled block only — still never blocks the auth response).
        if (user.email) {
          try {
            const { sendStatusEmail } = require('./email');
            await sendStatusEmail(user.email, 'lockout', { minutes }).catch(() => {});
          } catch { /* email never breaks lockout reporting */ }
        }
      }
    } catch { /* best-effort */ }
  });
}

module.exports = {
  LADDER_MS,
  FAILS_TO_LOCK,
  recordOffense,
  recordAccountFailure,
  noteIpAccountFailure,
  deviceFingerprint,
  lockInfo,
  lockEntry,
  lockRemainingMs,
  clearOffenses,
  clearAccountState,
  clientIp,
  ipKey,
  accountKey,
  lockMeta,
  lockoutCheck,
  limitReachedHandler,
  lockoutStats,
  notifyOnce,
  reportAccountLockout,
};
