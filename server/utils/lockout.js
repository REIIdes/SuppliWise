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
// one IP failing DIFFERENT accounts gets its own cooldown.
const ipAccountHits = new Map(); // ip -> { emails: Set, firstAt }

// How many DISTINCT accounts one IP may fail before it is treated as spraying.
//
// This was 3, which was not a credential-stuffing threshold at all — it was a
// typo threshold. Three ordinary mistakes from one address locked that address
// out of ALL authentication for 15 minutes:
//
//   • forgetting which of your two accounts you are signing into,
//   • mistyping your own address twice in a row,
//   • any two family/office members behind one NAT each getting it wrong once.
//
// The lock is a HARD pre-limiter stop (`lockoutCheck`), so it also refused
// requests carrying the CORRECT password — the tripwire designed to protect
// accounts was what locked legitimate users out of theirs, and nothing they
// could do cleared it but waiting.
//
// 20 distinct accounts in 15 minutes cannot be human error, while a real
// credential-stuffing run reaches it in seconds: the defence is unchanged
// where it matters and unreachable by accident.
const IP_ACCOUNT_THRESHOLD = 20;
const IP_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Cooldown the tripwire imposes once it fires.
 *
 * Deliberately short, and deliberately NOT on the escalating ladder. The
 * tripwire's job is to make spraying uneconomic, which it does by refusing each
 * further FAILED attempt. It is not proof the address is an attacker, and a
 * shared address is not a single person — so it must never become a multi-hour
 * ban on everyone behind that NAT. The escalating ladder (15 min → 1 day) stays
 * where it belongs: behind one ACCOUNT's repeated wrong passwords, which really
 * is one person guessing one account.
 */
const STUFFING_COOLDOWN_MS = 5 * 60 * 1000;

// Prefix for the tripwire's own bucket. Deliberately NOT `ip:`, so `lockoutCheck`
// — which reads `ip:<addr>` and hard-stops the entire /api/auth surface — can
// never see it. That separation is the point: the tripwire throttles FAILED
// attempts; the IP ladder denies the address; only the latter is severe enough
// to be worth refusing a correct password.
const STUFFING_KEY_PREFIX = 'stuffing:';

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

function ladderFor(offenses, capMs) {
  const ms = LADDER_MS[Math.min(Math.max(offenses - 1, 0), LADDER_MS.length - 1)];
  return capMs ? Math.min(ms, capMs) : ms;
}

// Hard ceiling for buckets that a party who has NOT proven control of the
// account can drive: the OTP/2FA bucket.
//
// That bucket is reached from public, unauthenticated routes keyed on a
// client-supplied userId. Anyone who knows a victim's email can request a reset
// code (which is sent to the victim, not the attacker), then submit five wrong
// codes to /verify-login-otp — which records an offense and walks this ladder.
// Because one shared bucket gates /verify-login-otp, /login-2fa,
// /verify-password-reset-otp, /reset-password, /verify-email-otp AND
// /security/backup-codes/redeem, climbing it to the top rung removed a victim's
// ability to log in, reset their password, change their email or use recovery
// codes for a full day — repeatedly, since offenses only decay after 30 days.
// One hour still throttles code-guessing to a crawl; a day is an outage.
const OTP_LADDER_CAP_MS = 60 * 60 * 1000;

// Record an offense; returns the new lockout expiry timestamp.
// Optional meta binds evidence to the entry: { ip, fp, agent }.
function recordOffense(rawKey, meta, capMs) {
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
  const lockedUntil = now + ladderFor(offenses, capMs);
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
//
// Records into the tripwire's OWN bucket, not the escalating `ip:` bucket, so a
// detected spray is slowed down without banning every other user behind the same
// address. Call on every failed credential check; returns true the moment the
// address earns a cooldown.
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
    // Start the cooldown from scratch: the counter has done its job, and
    // keeping it would mean one early mistake keeps the address throttled for
    // the rest of the window.
    ipAccountHits.delete(cleanIp);
    recordOffense(stuffingKeyFor(cleanIp), { ip: cleanIp }, STUFFING_COOLDOWN_MS);
    return true;
  }
  if (ipAccountHits.size > MAX_ENTRIES) {
    for (const [k, v] of ipAccountHits) {
      if (now - v.firstAt > IP_ACCOUNT_WINDOW_MS) ipAccountHits.delete(k);
    }
  }
  return false;
}

// Forget an address's distinct-account failure history.
//
// Called when a password is ACCEPTED. A correct password is proof a human is at
// that address, so the tripwire forgets them — otherwise a shared address stays
// one typo away from being throttled for the rest of the window, even though
// someone on it just proved they are a legitimate user.
//
// It deliberately does NOT release an active cooldown. Doing so would let an
// attacker with one valid account launder a spray by signing in with it between
// bursts. Nothing is lost by letting the cooldown expire on its own: it is five
// minutes, and it only ever refuses FAILED attempts, so it can never deny
// someone who knows their own password.
function clearIpAccountFailures(ip) {
  const cleanIp = String(ip || '').trim();
  if (cleanIp) ipAccountHits.delete(cleanIp);
}

/** Milliseconds left on the tripwire cooldown for this address, or 0. */
function stuffingCooldownMs(ip) {
  const cleanIp = String(ip || '').trim();
  if (!cleanIp) return 0;
  return lockRemainingMs(stuffingKeyFor(cleanIp));
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

// OTP/2FA code exhaustion, with the ladder ceiling applied.
//
// Use this INSTEAD of recordOffense for every public, unauthenticated code
// check (login OTP, 2FA, password-reset OTP, email OTP). It is deliberately
// separate so the cap cannot be forgotten at a call site: the bare
// recordOffense ladder is for credential failures, where the caller already
// proved possession of something (a password), and for the IP bucket.
function recordOtpOffense(rawKey, meta) {
  return recordOffense(rawKey, meta, OTP_LADDER_CAP_MS);
}

// ── Account failure tracking (3-strike lockout) ──────────────────────────
// Single failures (wrong password / bad TOTP) must NOT lock instantly —
// an account locks only after 3 consecutive failures inside 15 minutes,
// then climbs the ladder. OTP-code exhaustion calls recordOtpOffense directly
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

// The tripwire's bucket key. A function (not a const arrow) so it is hoisted and
// usable from the tripwire regardless of declaration order in this file.
function stuffingKeyFor(ip) {
  return `${STUFFING_KEY_PREFIX}${normKey(ip)}`;
}

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
  let stuffing = 0;
  for (const [key, entry] of buckets) {
    if (now > entry.lockedUntil) continue;
    if (key.startsWith('ip:')) ips += 1;
    // The tripwire's bucket is neither a locked address nor a locked account —
    // it is an address currently being throttled. Counted separately so the
    // admin panel's "IPs locked / accounts locked" figures stay truthful.
    else if (key.startsWith(STUFFING_KEY_PREFIX)) stuffing += 1;
    else accounts += 1;
  }
  return {
    ipsLocked: ips,
    accountsLocked: accounts,
    addressesThrottled: stuffing,
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
  recordOtpOffense,
  recordAccountFailure,
  noteIpAccountFailure,
  clearIpAccountFailures,
  stuffingCooldownMs,
  IP_ACCOUNT_THRESHOLD,
  STUFFING_COOLDOWN_MS,
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
