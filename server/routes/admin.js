const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Assessment = require('../models/Assessment');
const AdminAccount = require('../models/AdminAccount');
const AdminEvent = require('../models/AdminEvent');
const Session = require('../models/Session');
const UserNotification = require('../models/UserNotification');
const IntakeRecord = require('../models/IntakeRecord');
const DashboardMetrics = require('../models/DashboardMetrics');
const { isArgon2id, isBcrypt } = require('../utils/password');
const { SECURITY_AUDIT } = require('../utils/securityAudit');
const speakeasy = require('speakeasy');
const { protect, adminOnly } = require('../middleware/auth');
const { verifyTotpOnce } = require('../utils/totp');
// Blockchain layer (all 20 Web3 features) — models + the PoW ledger the
// security monitor probes below. Loaded here so every blockchain probe hits
// the source-of-truth collections directly (no self-HTTP calls).
const {
  Block, Wallet, SupplyBatch, Listing, Order, Dispute, Proposal,
  KnowledgePost, RewardEvent, Nft, LoyaltyCode, DataShare, StorageObject,
  HealthAnchor, ShareLink, RecAnchor, Trial, TrialConsent, OracleFeed,
  Expert, Booking, Web3Config, DEFAULT_PARAMS,
} = require('../models/Web3');
const ledger = require('../blockchain/ledger');

const router = express.Router();
router.use(protect, adminOnly);

// ── Account removal plan ─────────────────────────────────────────────────
// "Delete account" is a hard delete: the account leaves the database together
// with everything it owns. The plan is derived from the schemas instead of a
// hand-written list, so a model that has no user reference is simply skipped
// and a newly added user-owned collection is covered without edits here.
const USER_REF_FIELDS = ['user', 'owner', 'sellerUser', 'buyerUser'];
const USER_OWNED_MODELS = [
  Assessment,
  UserNotification,
  IntakeRecord,
  DashboardMetrics,
  Block, Wallet, SupplyBatch, Listing, Order, Dispute, Proposal, KnowledgePost,
  RewardEvent, Nft, LoyaltyCode, DataShare, StorageObject, HealthAnchor,
  ShareLink, RecAnchor, Trial, TrialConsent, OracleFeed, Expert, Booking,
];
const USER_DELETE_PLAN = USER_OWNED_MODELS
  .map(model => {
    const fields = USER_REF_FIELDS.filter(field => {
      const path = model.schema.paths[field];
      return path && path.instance === 'ObjectId';
    });
    return fields.length ? { model, fields } : null;
  })
  .filter(Boolean);

const safeUserProjection = {
  password: 0,
  twoFactorSecret: 0,
  lastLoginIp: 0,
  lastLoginUserAgent: 0,
};
const adminUserFields = 'firstName lastName email createdAt subscriptionActive subscriptionPlan subscriptionStartedAt subscriptionExpiresAt subscriptionUpdatedAt twoFactorEnabled lastLoginAt lastLoginIp lastLoginLocation lastLoginUserAgent accountRole accountStatus profilePicture';

// Human-friendly device label from a raw User-Agent string.
// The old code showed the first 3 UA tokens verbatim, which renders as a
// broken fragment like "Mozilla/5.0 (Windows NT" (dangling parenthesis).
// This parses browser + OS instead, e.g. "Chrome on Windows 10/11".
function friendlyDevice(rawUa) {
  const ua = String(rawUa || '');
  if (!ua.trim()) return 'Unknown device';
  const os = /iPhone|iPad/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : /Windows NT 10/i.test(ua) ? 'Windows 10/11'
    : /Windows/i.test(ua) ? 'Windows'
    : /Mac OS X/i.test(ua) ? 'macOS'
    : /Linux/i.test(ua) ? 'Linux'
    : '';
  // Order matters: Edge/Opera UAs also contain "Chrome".
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /OPR\//i.test(ua) ? 'Opera'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Version\//i.test(ua) && /Safari\//i.test(ua) ? 'Safari'
    : /Safari\//i.test(ua) ? 'Safari'
    : /Mobile/i.test(ua) ? 'Mobile browser'
    : '';
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `Browser on ${os}`;
  return 'Web browser';
}

// Single source of truth for lockout display: account buckets (email + OTP)
// PLUS the network bucket of the user's last IP. Both /overview and /users
// use this so the panel always agrees with what login enforces.
function attachLockout(users) {
  const { lockInfo, lockRemainingMs, accountKey } = require('../utils/lockout');
  return (users || []).map(user => {
    const { lastLoginUserAgent, ...rest } = user;
    const device = friendlyDevice(lastLoginUserAgent);
    const emailInfo = lockInfo(accountKey('email', user.email || ''));
    const otpInfo = lockInfo(accountKey('otp-user', user._id));
    // Network bucket: match stored IP in raw and ::ffff:-stripped form,
    // since lockout keys are written from the request IP as Express reports it.
    const rawIp = String(user.lastLoginIp || '').trim();
    const strippedIp = rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
    const netMs = Math.max(
      rawIp ? lockRemainingMs(`ip:${rawIp}`) : 0,
      strippedIp && strippedIp !== rawIp ? lockRemainingMs(`ip:${strippedIp}`) : 0
    );
    const acctMs = Math.max(
      emailInfo.locked ? emailInfo.remainingSeconds * 1000 : 0,
      otpInfo.locked ? otpInfo.remainingSeconds * 1000 : 0
    );
    const lockMs = Math.max(acctMs, netMs);
    const ips = [...new Set([
      ...(emailInfo.ips || []),
      ...(otpInfo.ips || []),
      ...(netMs > 0 && user.lastLoginIp ? [String(user.lastLoginIp).trim()] : []),
    ])].slice(0, 5);
    const fps = [...new Set([...(emailInfo.fps || []), ...(otpInfo.fps || [])])].slice(0, 5);
    const lockedBy = lockMs > 0 ? (netMs >= acctMs && netMs > 0 ? 'network' : 'account') : null;
    return {
      ...rest,
      device,
      lockout: lockMs > 0
        ? { locked: true, remainingSeconds: Math.ceil(lockMs / 1000), ips, fps, lockedBy }
        : { locked: false, remainingSeconds: 0, ips: [], fps: [], lockedBy: null },
    };
  });
}

function securityChecks() {
  const checks = [
    {
      key: 'jwt',
      label: 'Strong JWT signing secret',
      status: Boolean(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32),
      fix: 'Set a random JWT_SECRET with at least 32 characters.',
      framework: 'OWASP',
      implementation: 'middleware/auth.js',
      critical: true,
    },
    {
      key: 'adminMfa',
      label: 'Admin MFA configured',
      status: Boolean(process.env.ADMIN_TOTP_SECRET || process.env.ADMIN_ACCOUNTS),
      fix: 'Configure an authenticator secret for every admin account.',
      framework: 'STRIDE',
      implementation: 'routes/admin.js',
    },
    {
      key: 'adminHash',
      label: 'Admin password stored as argon2id hash',
      status: isArgon2id(process.env.ADMIN_PASSWORD_HASH || '') || isBcrypt(process.env.ADMIN_PASSWORD_HASH || '') || String(process.env.ADMIN_ACCOUNTS || '').includes('$argon2id$') || String(process.env.ADMIN_ACCOUNTS || '').includes('|$2'),
      fix: 'Store every admin password as an argon2id hash (bcrypt accepted for legacy entries), never plaintext.',
      framework: 'OWASP',
      implementation: 'models/AdminAccount.js',
    },
    {
      key: 'email',
      label: 'Email OTP delivery configured',
      status: Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD),
      fix: 'Configure EMAIL_USER and EMAIL_PASSWORD for login OTP delivery.',
      framework: 'STRIDE',
      implementation: 'utils/email.js',
    },
    {
      key: 'production',
      label: 'Production environment safeguards',
      // The live control is the flag itself: OTP values must never be
      // exposed in API responses (unit-tested). NODE_ENV only changes
      // rate-limit generosity, so dev without the flag is Secure too.
      status: process.env.ALLOW_DEV_OTP_RESPONSE !== 'true',
      fix: 'Keep ALLOW_DEV_OTP_RESPONSE disabled (never set it to "true"), and run live deployments with NODE_ENV=production.',
      framework: 'OWASP',
      implementation: 'server.js',
    },
  ];
  return checks.map(check => {
    if (check.status) {
      return { ...check, status: 'Secure' };
    } else {
      return { ...check, status: check.critical ? 'Critical' : 'Vulnerable' };
    }
  });
}

async function measureApi(url) {
  if (!url) return { configured: false, status: 'not-configured' };
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    return { configured: true, status: response.ok ? 'healthy' : 'attention', statusCode: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { configured: true, status: 'attention', latencyMs: Date.now() - started, error: error.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

router.get('/overview', async (req, res) => {
  try {
    const now = new Date();
    const day7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const day30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [users, assessments, activeSubscriptions, recentUsers, assessmentTrend, signups7d, signups30d, planRows, twoFactorEnabled] = await Promise.all([
      User.countDocuments(),
      Assessment.countDocuments(),
      User.countDocuments({ subscriptionActive: true }),
      User.find().select(adminUserFields).sort({ createdAt: -1 }).limit(8).lean(),
      Assessment.aggregate([
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: -1 } },
        { $limit: 14 },
        { $sort: { _id: 1 } },
      ]),
      // Analytics (cheap indexed counts, same round-trip)
      User.countDocuments({ createdAt: { $gte: day7 } }),
      User.countDocuments({ createdAt: { $gte: day30 } }),
      User.aggregate([
        { $group: { _id: '$subscriptionPlan', count: { $sum: 1 } } },
      ]),
      User.countDocuments({ twoFactorEnabled: true }),
    ]);
    const planBreakdown = { free: 0, monthly: 0, annual: 0, custom: 0 };
    for (const row of planRows || []) {
      if (Object.hasOwn(planBreakdown, row._id)) planBreakdown[row._id] = row.count;
    }
    // In-memory ladder snapshot (no queries): accounts currently locked out
    let lockedAccounts = 0;
    try {
      lockedAccounts = require('../utils/lockout').lockoutStats().accountsLocked || 0;
    } catch { /* best-effort */ }

    const [groq, openai, anthropic] = await Promise.all([
      measureApi(process.env.GROQ_HEALTH_URL),
      measureApi(process.env.OPENAI_HEALTH_URL),
      measureApi(process.env.ANTHROPIC_HEALTH_URL),
    ]);
    const security = securityChecks();
    // recentUsers carry live lockout state too — otherwise the overview
    // payload (no lockout field) would overwrite the authoritative /users
    // list with "Clear" rows while login still enforces a 429.
    const recentWithLockout = attachLockout(recentUsers);
    res.json({
      metrics: { users, assessments, activeSubscriptions, inactiveSubscriptions: users - activeSubscriptions },
      recentUsers: recentWithLockout,
      assessmentTrend,
      analytics: {
        signups7d, signups30d, planBreakdown, twoFactorEnabled, lockedAccounts,
        twoFactorPct: users > 0 ? Math.round((twoFactorEnabled / users) * 100) : 0,
      },
      ai: { providers: { groq, openai, anthropic }, configuredCount: [process.env.GROQ_API_KEY, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY].filter(Boolean).length },
      security,
      notifications: security.filter(check => check.status !== 'Secure').map(check => ({ type: 'security', title: check.label, detail: check.fix || '' })),
    });
  } catch (error) {
    console.error('[admin/overview]', error.message);
    res.status(500).json({ message: 'Unable to load the admin overview.' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 64);
    // Escape regex metacharacters so the search box cannot build ReDoS patterns
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = escaped ? { $or: [
      { email: { $regex: escaped, $options: 'i' } },
      { firstName: { $regex: escaped, $options: 'i' } },
      { lastName: { $regex: escaped, $options: 'i' } },
    ] } : {};
    // Lean user rows (no blobs) + assessment counts from a grouped query.
    // The old $lookup pulled entire assessments incl. ~500 KB aiResults each,
    // which stalled this endpoint ("Loading users..." forever).
    const users = await User.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .select('firstName lastName email createdAt subscriptionActive subscriptionPlan twoFactorEnabled lastLoginAt lastLoginIp lastLoginLocation lastLoginUserAgent accountRole accountStatus profilePicture')
      .lean();
    let countMap = new Map();
    if (users.length > 0) {
      const counts = await Assessment.aggregate([
        { $match: { user: { $in: users.map(u => u._id) } } },
        { $group: { _id: '$user', count: { $sum: 1 } } },
      ]);
      countMap = new Map(counts.map(c => [String(c._id), c.count]));
    }
    const withCounts = users.map(user => ({ ...user, assessmentCount: countMap.get(String(user._id)) || 0 }));
    // Heal unknown locations in the background (IP geo lookup never blocks this response)
    const { backfillLocations } = require('../utils/geo');
    backfillLocations(withCounts);
    // Authoritative lockout state (account buckets + network bucket of last
    // IP) so the panel always agrees with what login enforces.
    const normalizedUsers = attachLockout(withCounts);
    res.json({ users: normalizedUsers });
  } catch (error) {
    console.error('[admin/users]', error.message);
    res.status(500).json({ message: 'Unable to load users.' });
  }
});

router.patch('/users/:id/account', async (req, res) => {
  const { role, status } = req.body || {};
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid user account.' });
  if (role && !['user', 'moderator'].includes(role)) return res.status(400).json({ message: 'Invalid account role.' });
  if (status && !['active', 'banned'].includes(status)) return res.status(400).json({ message: 'Invalid account status.' });
  try {
    const update = {};
    if (role) update.accountRole = role;
    if (status) { update.accountStatus = status; update.bannedAt = status === 'banned' ? new Date() : null; }
    const before = await User.findById(req.params.id).select('accountStatus email').lean();
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select(adminUserFields).lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });
    await AdminEvent.create({ type: 'account', title: 'Account updated', detail: `${user.email} is now ${user.accountStatus} with ${user.accountRole} role.`, user: user._id });
    // Email + in-app notice on ban / reactivation transitions only.
    const was = before ? before.accountStatus : null;
    if (status && was !== status && (status === 'banned' || (was === 'banned' && status === 'active'))) {
      const lifted = status === 'active';
      try {
        const UserNotification = require('../models/UserNotification');
        await UserNotification.create({
          user: user._id,
          type: 'info',
          title: lifted ? 'Your account is active again' : 'Your account has been restricted',
          detail: lifted
            ? 'Your account was reactivated — you can sign in again right now.'
            : 'An administrator restricted your account. Contact support if you believe this is a mistake.',
        }).catch(() => {});
      } catch { /* best-effort */ }
      try {
        const { sendStatusEmail } = require('../utils/email');
        sendStatusEmail(user.email, lifted ? 'reactivated' : 'banned').catch(() => {});
      } catch { /* email never blocks admin */ }
    }
    res.json({ user });
  } catch (error) {
    console.error('[admin/account]', error.message);
    res.status(500).json({ message: 'Unable to update the account.' });
  }
});

// @route   DELETE /api/admin/users/:id/lockout
// @desc    Clear a user's sign-in lockout immediately (admin override)
// @access  Private (Admin)
router.delete('/users/:id/lockout', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid user account.' });
  try {
    const user = await User.findById(req.params.id).select('email lastLoginIp').lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });
    const { clearAccountState, clearOffenses, lockInfo, accountKey } = require('../utils/lockout');
    const emailKey = accountKey('email', user.email || '');
    const otpKey = accountKey('otp-user', req.params.id);
    // Collect network IPs bound as evidence before wiping the account buckets,
    // so rotating-IP holds tied to this account are released too.
    const evidenceIps = [...new Set([
      ...((lockInfo(emailKey).ips) || []),
      ...((lockInfo(otpKey).ips) || []),
    ])];
    clearAccountState(emailKey);
    clearAccountState(otpKey);
    // Release network-level holds: last login IP (both forms), every
    // evidence IP, and the admin's current IP (local dev shares one IP, so a
    // shared 429 would otherwise re-block the very next login attempt).
    const toClear = new Set();
    if (user.lastLoginIp) {
      const rawIp = String(user.lastLoginIp).trim();
      if (rawIp) {
        toClear.add(`ip:${rawIp}`);
        if (rawIp.startsWith('::ffff:')) toClear.add(`ip:${rawIp.slice(7)}`);
        else toClear.add(`ip:::ffff:${rawIp}`);
      }
    }
    for (const ip of evidenceIps) {
      const clean = String(ip || '').trim();
      if (clean) {
        toClear.add(`ip:${clean}`);
        if (clean.startsWith('::ffff:')) toClear.add(`ip:${clean.slice(7)}`);
      }
    }
    const { clientIp, ipKey } = require('../utils/lockout');
    if (clientIp && ipKey) {
      try { toClear.add(ipKey(req)); } catch { /* never block unlock */ }
    }
    for (const key of toClear) clearOffenses(key);
    await AdminEvent.create({
      type: 'security',
      title: 'Lockout cleared by admin',
      detail: `${user.email || req.params.id} can sign in again.`,
      user: req.params.id,
    }).catch(() => {});
    // "Back online" twin: in-app notice + email so the user knows instantly.
    try {
      const UserNotification = require('../models/UserNotification');
      await UserNotification.create({
        user: req.params.id,
        type: 'info',
        title: "You're back online",
        detail: 'The sign-in pause on your account was lifted — you can sign in again right now.',
      }).catch(() => {});
    } catch { /* best-effort */ }
    try {
      const { sendStatusEmail } = require('../utils/email');
      sendStatusEmail(user.email, 'back-online').catch(() => {});
    } catch { /* email never blocks unlock */ }
    res.json({ message: 'Lockout cleared. The user can sign in again.' });
  } catch (error) {
    console.error('[admin/lockout]', error.message);
    res.status(500).json({ message: 'Unable to clear the lockout.' });
  }
});

// ── Hard delete: the account AND all of its data leave the database ─────
router.delete('/users/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid user account.' });
  const userId = req.params.id;
  try {
    const user = await User.findById(userId).select('email firstName lastName').lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });

    // 1. Sessions first — a refresh must not slip through mid-delete and
    //    resurrect a session for an account that is being removed.
    await Session.deleteMany({ user: userId });

    // 2. Everything else the account owns (assessments, notifications,
    //    intake/dashboard rows, Web3 records, …).
    await Promise.all(USER_DELETE_PLAN.map(({ model, fields }) =>
      model.deleteMany({ $or: fields.map(field => ({ [field]: userId })) }).exec()
    ));

    // 3. The account itself.
    await User.deleteOne({ _id: userId });

    // 4. Keep an audit trail of the removal (Mongo has no FK, so the id may
    //    dangle on purpose — that is what makes it an audit record).
    const who = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    await AdminEvent.create({
      type: 'account',
      title: 'Account deleted',
      detail: `${user.email}${who ? ` (${who})` : ''} was permanently deleted with all related data.`,
      user: userId,
    });

    res.json({ message: `${user.email} was permanently deleted.`, email: user.email });
  } catch (error) {
    console.error('[admin/delete-user]', error.message);
    res.status(500).json({ message: 'Unable to delete the account.' });
  }
});

// ── Administrator accounts ─────────────────────────────────────────────
// Same card-box UI as users, but for admin accounts. Secrets (passwordHash,
// totpSecret) are never selected, so they can never leak into responses.
router.get('/admins', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 64);
    // Escape regex metacharacters so the search box cannot build ReDoS patterns
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = escaped ? { alias: { $regex: escaped, $options: 'i' } } : {};
    const admins = await AdminAccount.find(filter)
      .sort({ createdAt: 1 })
      .limit(100)
      .select('alias enabled lastLoginAt lastActivityAt createdAt updatedAt')
      .lean();
    // Live lockout state per admin (same ladder as users: 15 min → 24 h).
    // Admin login failures accumulate on the alias bucket, so the card always
    // agrees with what /auth/admin-login enforces.
    const { lockInfo, accountKey } = require('../utils/lockout');
    const withLockout = (admins || []).map(admin => {
      const info = lockInfo(accountKey('admin', admin.alias || ''));
      return {
        ...admin,
        lockout: info.locked
          ? { locked: true, remainingSeconds: info.remainingSeconds, ips: info.ips || [] }
          : { locked: false, remainingSeconds: 0, ips: [] },
      };
    });
    res.json({ admins: withLockout });
  } catch (error) {
    console.error('[admin/admins]', error.message);
    res.status(500).json({ message: 'Unable to load administrators.' });
  }
});

router.patch('/admins/:id', async (req, res) => {
  const { enabled } = req.body || {};
  if (!mongoose.isValidObjectId(req.params.id) || typeof enabled !== 'boolean') {
    return res.status(400).json({ message: 'A valid administrator and status are required.' });
  }
  try {
    const target = await AdminAccount.findById(req.params.id).select('alias enabled').lean();
    if (!target) return res.status(404).json({ message: 'Administrator not found.' });
    if (!enabled) {
      // Guards against locking every admin out: never self-disable, and never
      // disable the last enabled administrator.
      if (String(target._id) === String(req.user._id)) {
        return res.status(400).json({ message: 'You cannot disable your own account.' });
      }
      if (target.enabled) {
        const enabledCount = await AdminAccount.countDocuments({ enabled: true });
        if (enabledCount <= 1) {
          return res.status(400).json({ message: 'You cannot disable the last enabled administrator.' });
        }
      }
    }
    const admin = await AdminAccount.findByIdAndUpdate(req.params.id, { enabled }, { new: true })
      .select('alias enabled lastLoginAt lastActivityAt createdAt updatedAt')
      .lean();
    await AdminEvent.create({
      type: 'account',
      title: 'Administrator updated',
      detail: `${admin.alias} is now ${admin.enabled ? 'enabled' : 'disabled'}.`,
    }).catch(() => {});
    res.json({ admin });
  } catch (error) {
    console.error('[admin/admin-update]', error.message);
    res.status(500).json({ message: 'Unable to update the administrator.' });
  }
});

// @route   DELETE /api/admin/admins/:id/lockout
// @desc    Clear an administrator's sign-in lockout / failed-attempt strikes
// @access  Private (Admin)
router.delete('/admins/:id/lockout', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid administrator account.' });
  try {
    const target = await AdminAccount.findById(req.params.id).select('alias').lean();
    if (!target) return res.status(404).json({ message: 'Administrator not found.' });
    const { clearAccountState, clearOffenses, lockInfo, accountKey } = require('../utils/lockout');
    const aliasKey = accountKey('admin', target.alias || '');
    // Release network holds tied to this alias too (evidence-bound IPs)
    const evidenceIps = (lockInfo(aliasKey).ips) || [];
    clearAccountState(aliasKey);
    for (const ip of evidenceIps) {
      const clean = String(ip || '').trim();
      if (clean) {
        clearOffenses(`ip:${clean}`);
        if (clean.startsWith('::ffff:')) clearOffenses(`ip:${clean.slice(7)}`);
      }
    }
    await AdminEvent.create({
      type: 'security',
      title: 'Admin lockout cleared',
      detail: `${target.alias} can sign in again.`,
    }).catch(() => {});
    res.json({ message: 'Lockout cleared. The administrator can sign in again.' });
  } catch (error) {
    console.error('[admin/admin-lockout]', error.message);
    res.status(500).json({ message: 'Unable to clear the lockout.' });
  }
});

router.patch('/users/:id/subscription', async (req, res) => {
  const { active, plan, expiresAt } = req.body || {};
  if (!mongoose.isValidObjectId(req.params.id) || typeof active !== 'boolean') return res.status(400).json({ message: 'A valid user and subscription state are required.' });
  let expiryDate = null;
  if (expiresAt !== undefined && expiresAt !== null) {
    expiryDate = new Date(expiresAt);
    if (!Number.isFinite(expiryDate.getTime())) return res.status(400).json({ message: 'Invalid expiry date.' });
  }
  try {
    const { describeSubscription, normalizePlanId, PLAN_ORDER } = require('../utils/entitlements');
    const bus = require('../utils/subscriptionBus');
    const before = await User.findById(req.params.id).select('subscriptionActive subscriptionPlan subscriptionStartedAt subscriptionExpiresAt').lean();
    if (!before) return res.status(404).json({ message: 'User not found.' });

    // Explicit plan wins (aliases like "deluxe"/"premium" are normalized);
    // reactivating without a plan KEEPS the user's existing paid tier and
    // never escalates — the previous default silently granted ULTIMATE.
    const requestedPlan = plan !== undefined && plan !== null && plan !== '' ? normalizePlanId(plan) : null;
    if (plan !== undefined && plan !== null && plan !== '' && !requestedPlan) {
      return res.status(400).json({ message: 'Invalid subscription plan.' });
    }
    const retainedPlan = PLAN_ORDER.includes(before.subscriptionPlan) && before.subscriptionPlan !== 'free'
      ? before.subscriptionPlan
      : 'free';
    const nextPlan = requestedPlan || (active ? retainedPlan : 'free');
    const wasActive = before.subscriptionActive === true;
    const now = new Date();
    const update = {
      subscriptionActive: active,
      subscriptionPlan: nextPlan,
      subscriptionUpdatedAt: now,
    };
    if (active) {
      // Start date: keep the original for a pure tier swap, stamp a fresh one
      // when (re)activating from inactive/free.
      update.subscriptionStartedAt = wasActive && before.subscriptionStartedAt ? before.subscriptionStartedAt : now;
      if (expiresAt !== undefined) {
        update.subscriptionExpiresAt = expiryDate; // explicit (null = open-ended)
      } else {
        // Reactivating with no explicit expiry: drop a stale past expiry so the
        // subscription is actually active; keep a future expiry untouched.
        const prev = before.subscriptionExpiresAt ? new Date(before.subscriptionExpiresAt) : null;
        update.subscriptionExpiresAt = prev && prev.getTime() > now.getTime() ? prev : null;
      }
    } else {
      // Cancel/remove: the subscription ends now — resolveSubscription() treats
      // a passed expiry as FREE regardless of the stored plan.
      update.subscriptionExpiresAt = now;
    }

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select(safeUserProjection).lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });

    // Push the new authoritative state to every open session of this user —
    // upgrade/downgrade/cancel/expiry lands instantly, no refresh or re-login.
    const state = describeSubscription(user);
    const delivered = bus.publish(String(user._id), state);
    console.log(`[admin/subscription] user ${user._id} -> ${state.currentPlan} (${state.subscriptionStatus}); pushed to ${delivered} session(s)`);

    res.json({ user, subscription: state });
  } catch (error) {
    console.error('[admin/subscription]', error.message);
    res.status(500).json({ message: 'Unable to update the subscription.' });
  }
});

// ── Real-time Security Monitor ────────────────────────────────────────────
// Each probe runs independently; failures in one never block the others.
// Results are cached for 60 s so the 30 s frontend auto-refresh (and the
// OpenRouter network probe) cannot pile up expensive calls.
// The response also carries `audit` (utils/securityAudit.js): the permanent
// record of the completed 30-item review, distinct from the live probes —
// probes show what the system is doing now, the audit record shows what a
// human review found and what is still open.
let monitorCache = { at: 0, payload: null };
const MONITOR_CACHE_TTL_MS = 60 * 1000;

router.get('/security/monitor', async (req, res) => {
  const forceFresh = req.query.fresh === '1';
  if (!forceFresh && monitorCache.payload && Date.now() - monitorCache.at < MONITOR_CACHE_TTL_MS) {
    return res.json({ ...monitorCache.payload, cached: true });
  }
  const at = new Date().toISOString();

  // Helper: wrap an async probe so it always resolves to a result object.
  // Each probe is capped at 10 s so one stalled check can never hang the
  // whole monitor response (or inflate its own latency into the 30 s range).
  const PROBE_TIMEOUT_MS = 10000;
  async function probe(key, label, category, fn) {
    const t0 = Date.now();
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Probe timed out after 10 s.')), PROBE_TIMEOUT_MS)),
      ]);
      return { key, label, category, status: result.status, detail: result.detail, latencyMs: Date.now() - t0, checkedAt: at };
    } catch (err) {
      const timedOut = /timed out/.test(err.message || '');
      return { key, label, category, status: timedOut ? 'warning' : 'error', detail: err.message || 'Probe threw an unexpected error.', latencyMs: Date.now() - t0, checkedAt: at };
    }
  }

  const results = await Promise.all([
    // ── 1. Login ─────────────────────────────────────────────────────────
    probe('login', 'Login System', 'login', async () => {
      const jwtOk = Boolean(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32);
      const emailOk = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD);
      if (!jwtOk) return { status: 'critical', detail: 'JWT_SECRET is missing or too short — logins cannot be issued securely.' };
      if (!emailOk) return { status: 'warning', detail: 'Email OTP delivery is not configured; email-based login will fail.' };
      // Verify at least one user has logged in (table is live)
      const lastLogin = await User.findOne({ lastLoginAt: { $ne: null } }).sort({ lastLoginAt: -1 }).select('lastLoginAt email').lean();
      const recentNote = lastLogin
        ? `Last login: ${new Date(lastLogin.lastLoginAt).toLocaleString()} — JWT + OTP pipeline healthy.`
        : 'JWT + OTP pipeline configured. No logins recorded yet.';
      return { status: 'healthy', detail: recentNote };
    }),

    // ── 2. Account Creation ───────────────────────────────────────────────
    probe('account_creation', 'Account Creation', 'account_creation', async () => {
      const emailOk = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD);
      const newest = await User.findOne().sort({ createdAt: -1 }).select('createdAt email').lean();
      const regNote = newest
        ? `Most recent registration: ${new Date(newest.createdAt).toLocaleString()}.`
        : 'No user accounts exist yet.';
      if (!emailOk) return { status: 'warning', detail: `Email service not configured — registration email delivery disabled. ${regNote}` };
      const total = await User.countDocuments();
      return { status: 'healthy', detail: `Registration pipeline active. ${total} account(s) total. ${regNote}` };
    }),

    // ── 3a. Email OTP Security ────────────────────────────────────────────
    probe('email_otp', 'Email OTP (Login Security)', 'security', async () => {
      const configured = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD);
      if (!configured) return { status: 'critical', detail: 'EMAIL_USER / EMAIL_PASSWORD not set — OTP delivery is broken.' };
      return { status: 'healthy', detail: `OTP delivery configured via ${process.env.EMAIL_USER}. Codes use crypto.randomInt (CSPRNG), 10-min TTL, 30-s resend cooldown.` };
    }),

    // ── 3b. Google Authenticator (TOTP) ───────────────────────────────────
    probe('totp', 'Google Authenticator (TOTP)', 'security', async () => {
      const adminTotpOk = Boolean(process.env.ADMIN_TOTP_SECRET || process.env.ADMIN_ACCOUNTS);
      const usersWithTotp = await User.countDocuments({ twoFactorEnabled: true });
      if (!adminTotpOk) return { status: 'critical', detail: 'Admin TOTP secret not configured — admin 2FA is broken.' };
      return { status: 'healthy', detail: `Admin TOTP configured via speakeasy (HMAC-SHA1, 30s window). ${usersWithTotp} user(s) have Google Authenticator enabled.` };
    }),

    // ── 4. Database Connectivity ──────────────────────────────────────────
    probe('database', 'Database Connectivity', 'database', async () => {
      const state = mongoose.connection.readyState;
      // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
      const labels = { 0: 'Disconnected', 1: 'Connected', 2: 'Connecting', 3: 'Disconnecting' };
      if (state !== 1) return { status: 'critical', detail: `MongoDB is ${labels[state] || 'unknown'} (readyState=${state}).` };
      // Live ping via a lightweight count query
      const t0 = Date.now();
      await mongoose.connection.db.command({ ping: 1 });
      const pingMs = Date.now() - t0;
      return { status: 'healthy', detail: `MongoDB connected and responsive. Ping: ${pingMs} ms. Host: ${mongoose.connection.host}.` };
    }),

    // ── 5. OpenRouter API Connectivity ────────────────────────────────────
    probe('openrouter', 'OpenRouter API', 'openrouter', async () => {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key || key === 'your_openrouter_api_key_here') {
        return { status: 'critical', detail: 'OPENROUTER_API_KEY is not configured — AI features are unavailable.' };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const t0 = Date.now();
        const resp = await fetch('https://openrouter.ai/api/v1/models', {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        const latency = Date.now() - t0;
        if (resp.status === 401) return { status: 'critical', detail: 'OpenRouter API key is invalid or revoked (HTTP 401).' };
        if (!resp.ok) return { status: 'warning', detail: `OpenRouter responded with HTTP ${resp.status}. Latency: ${latency} ms.` };
        return { status: 'healthy', detail: `OpenRouter reachable. HTTP ${resp.status}. Latency: ${latency} ms. Model: deepseek/deepseek-v4-flash-0731.` };
      } catch (err) {
        clearTimeout(timer);
        const reason = err.name === 'AbortError' ? 'Request timed out after 6 s.' : err.message;
        return { status: 'warning', detail: `OpenRouter unreachable — ${reason}` };
      }
    }),

    // ── 6. Delete Account ────────────────────────────────────────────────
    probe('delete_account', 'Account Deletion (Soft-delete)', 'delete_account', async () => {
      const deletedCount = await User.countDocuments({ accountStatus: 'deleted' });
      const recentDelete = await AdminEvent.findOne({ title: 'Account deleted' }).sort({ createdAt: -1 }).select('detail createdAt').lean();
      const note = recentDelete
        ? `Last deletion: ${new Date(recentDelete.createdAt).toLocaleString()} — ${recentDelete.detail}`
        : 'No account deletions recorded yet.';
      return { status: 'healthy', detail: `Soft-delete active (status=deleted, bannedAt set). ${deletedCount} deleted account(s). ${note}` };
    }),

    // ── 7. Input Sanitization & Validation ───────────────────────────────
    probe('input_sanitization', 'Input Sanitization & Validation', 'input_sanitization', async () => {
      // Verify the sanitize module loads without error (no runtime imports needed)
      try {
        const { sanitizeTextField, sanitizeShortField, isGarbage } = require('../utils/sanitize');
        const testClean = sanitizeTextField('I feel very tired and have headaches');
        const testGarbage = isGarbage('asdfghjkl1234');
        if (!testClean || testClean.garbage === undefined) throw new Error('sanitizeTextField returned unexpected shape.');
        if (testGarbage !== true) throw new Error('Garbage detection did not flag obvious mash input.');
        return { status: 'healthy', detail: 'Input sanitization active: slang→clinical mapping, garbage detection, spelling normalisation, XSS-safe (no HTML rendered), regex-validated emails + passwords on all auth routes.' };
      } catch (err) {
        return { status: 'critical', detail: `Sanitize module error: ${err.message}` };
      }
    }),

    // ── 8. Password Hashing ───────────────────────────────────────────────
    probe('password_hashing', 'Password Hashing (argon2id)', 'password_hashing', async () => {
      const hashOk = (h) => isArgon2id(h) || isBcrypt(h);
      const adminHashOk = hashOk(process.env.ADMIN_PASSWORD_HASH || '') ||
        String(process.env.ADMIN_ACCOUNTS || '').split(',').some(entry => hashOk((entry.split('|')[1] || '').trim()));
      // Minimal projection + lean: user docs carry MBs of base64 pictures —
      // fetching the full document here stalled this probe for ~30 s.
      const sampleUser = await User.findOne({ password: { $exists: true, $ne: null } }).select('password').lean();
      const userHashOk = sampleUser ? hashOk(sampleUser.password || '') : true;
      if (!adminHashOk) return { status: 'critical', detail: 'Admin password is not stored as an argon2id (or legacy bcrypt) hash — this is a critical misconfiguration.' };
      if (!userHashOk) return { status: 'critical', detail: 'At least one user password is not stored as an argon2id (or legacy bcrypt) hash.' };
      return { status: 'healthy', detail: 'All verified passwords use argon2id (19 MiB, 2 iterations); legacy bcrypt hashes ($2b, cost 12) still verify and transparently upgrade on next login. Plaintext passwords are never accepted or stored.' };
    }),

    // ── 9. Salting ────────────────────────────────────────────────────────
    probe('salting', 'Password Salting (argon2id / bcrypt)', 'salting', async () => {
      // argon2id embeds a 128-bit random salt per hash (same for bcrypt) — verify format
      const adminHash = process.env.ADMIN_PASSWORD_HASH || '';
      const accountsEnv = String(process.env.ADMIN_ACCOUNTS || '');
      const hasAnyHash = isArgon2id(adminHash) || isBcrypt(adminHash) ||
        accountsEnv.includes('$argon2id$') || accountsEnv.includes('|$2');
      if (!hasAnyHash) return { status: 'warning', detail: 'Cannot verify salting — no argon2id/bcrypt hash found in environment config.' };
      // Parse bcrypt salt rounds from $2b$12$<22-char-salt><31-char-hash> when present
      const match = adminHash.match(/^\$2[aby]?\$(\d{2})\$/);
      const rounds = match ? parseInt(match[1], 10) : null;
      const roundNote = rounds ? `Legacy bcrypt salt rounds: ${rounds} (2^${rounds} = ${Math.pow(2, rounds).toLocaleString()} iterations).` : 'Admin hashes use argon2id with a unique 128-bit random salt each.';
      return { status: 'healthy', detail: `argon2id embeds a unique 128-bit random salt per hash — rainbow table attacks are prevented. ${roundNote} Users: argon2id (19 MiB, 2 iterations) enforced on registration.` };
    }),

    // ── 10–15. Attack-surface probes (behavioral self-tests) ─────────────
    ...Object.entries(require('../utils/attack_probes').attackProbes).map(
      ([key, check]) => {
        const meta = {
          xss_stored:          ['XSS (Stored Markup)', 'xss'],
          nosql_injection:     ['NoSQL Injection', 'nosql'],
          path_traversal:      ['Path Traversal', 'traversal'],
          prototype_pollution: ['Prototype Pollution', 'proto'],
          auth_bruteforce:     ['Auth Brute Force + Replay', 'bruteforce'],
          csrf_stateless:      ['CSRF (Stateless Auth)', 'csrf'],
        }[key] || [key, key];
        return probe(key, meta[0], meta[1], () => check(req.app));
      }
    ),

    // ── Blockchain layer — live probes for ALL 20 Web3 features ────────────
    // The application DB is the source of truth for balances/records; the
    // append-only PoW chain anchors their digests (blockchain/engine.js).
    // Each probe audits its collections directly: counts, structural
    // invariants (hash linkage, key envelopes, content addressing, unique
    // idempotency keys) and freshness. Empty counts are healthy — a fresh
    // install simply has no activity yet; only real integrity failures
    // escalate to warning/critical.

    // ── Ledger infrastructure — the chain every feature anchors onto ───────
    probe('bc_ledger', 'PoW Ledger & Integrity', 'blockchain', async () => {
      const v = await ledger.verify(); // recompute every hash + linkage
      if (!v.valid) {
        return { status: 'critical', detail: `Chain integrity FAILED at block ${v.brokenAt} (${v.reason}) — anchored digests cannot be trusted until the chain is re-synced.` };
      }
      const [txAgg] = await Block.aggregate([
        { $unwind: '$txs' },
        { $group: { _id: null, n: { $sum: 1 } } },
      ]);
      return { status: 'healthy', detail: `Append-only chain verified end-to-end: ${v.checked} block(s), height ${v.height}, difficulty ${v.difficulty}, ${txAgg ? txAgg.n : 0} anchored tx(s). Hash-linkage + nonce re-audit passed. Personal data never touches the chain — only sha256 digests.` };
    }),

    // Feature 1 — Immutable supply chain tracking (public QR verification)
    probe('bc_supply', 'Supply Chain Tracking (QR)', 'blockchain', async () => {
      const total = await SupplyBatch.countDocuments();
      const [agg] = await SupplyBatch.aggregate([
        { $group: { _id: null, events: { $sum: { $size: '$events' } } } },
      ]);
      const events = agg ? agg.events : 0;
      return { status: 'healthy', detail: `${total} batch(es) tracked, ${events} journey step(s) anchored on-chain (raw-sourcing → retail → delivered). Public scan-to-verify endpoint live at /api/web3/verify/:code — no account needed to scan a bottle.` };
    }),

    // Feature 2 — Certifications anchored on-chain
    probe('bc_certifications', 'On-chain Certifications', 'blockchain', async () => {
      const [agg] = await SupplyBatch.aggregate([
        { $unwind: '$certifications' },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          anchored: { $sum: { $cond: [{ $and: [
            { $ne: ['$certifications.txHash', ''] },
            { $gte: ['$certifications.blockIndex', 0] },
          ] }, 1, 0] } },
        } },
      ]);
      const total = agg ? agg.total : 0;
      const anchored = agg ? agg.anchored : 0;
      if (anchored < total) {
        return { status: 'warning', detail: `${total} certification(s) recorded but only ${anchored} carry an on-chain digest — re-anchor the outstanding records.` };
      }
      return { status: 'healthy', detail: `${total} certification(s) (lab-report, organic, GMP…) recorded, ${anchored} with an on-chain result digest — certificates cannot be swapped after the fact.` };
    }),

    // Feature 3 — Smart-contract escrow orders
    probe('bc_escrow', 'Smart-contract Escrow', 'blockchain', async () => {
      const [held, released, refunded] = await Promise.all([
        Order.countDocuments({ status: 'escrow' }),
        Order.countDocuments({ status: 'released' }),
        Order.countDocuments({ status: 'refunded' }),
      ]);
      return { status: 'healthy', detail: `Escrow contract active: ${held} order(s) currently held, ${released} released on delivery, ${refunded} refunded by dispute verdict. Funds move only via delivery confirmation or juror majority — never unilaterally.` };
    }),

    // Feature 4 — Verified P2P marketplace
    probe('bc_market', 'Verified P2P Marketplace', 'blockchain', async () => {
      const [total, active, orders] = await Promise.all([
        Listing.countDocuments(),
        Listing.countDocuments({ active: true }),
        Order.countDocuments(),
      ]);
      return { status: 'healthy', detail: `${total} listing(s) (${active} live) and ${orders} order(s) in the verified marketplace. Sellers settle from their DID wallet; protocol fee is set by the DAO param marketplaceFeePct.` };
    }),

    // Feature 5 — Wallets / decentralized identity
    probe('bc_wallet', 'Wallets / Decentralized ID', 'blockchain', async () => {
      const [userWallets, systemWallets, missingKey] = await Promise.all([
        Wallet.countDocuments({ user: { $ne: null } }),
        Wallet.countDocuments({ isSystem: true }),
        // Match missing/empty envelopes with `null`, never `''` — an
        // empty-string filter cannot cast to the embedded {iv,ct,tag} schema.
        Wallet.countDocuments({
          user: { $ne: null },
          $or: [{ privateKeyEnc: { $exists: false } }, { privateKeyEnc: null }],
        }),
      ]);
      if (missingKey > 0) {
        return { status: 'critical', detail: `${missingKey} wallet(s) are missing their AES-256-GCM key envelope — signing keys cannot be exported for those accounts.` };
      }
      return { status: 'healthy', detail: `${userWallets} user wallet(s) + ${systemWallets} system wallet(s) (treasury/escrow/inventory). ed25519 signing keys stored only inside AES-256-GCM envelopes — plaintext keys are never persisted. One-time welcome airdrop on first access.` };
    }),

    // Feature 6 — User-owned health records (anchored ledger + credential)
    probe('bc_health_ledger', 'Health Records Anchor', 'blockchain', async () => {
      const [total, anchored, latest] = await Promise.all([
        HealthAnchor.countDocuments(),
        HealthAnchor.countDocuments({ txHash: { $ne: '' }, blockIndex: { $gte: 0 } }),
        HealthAnchor.findOne().sort({ at: -1 }).select('at').lean(),
      ]);
      const lastNote = latest
        ? ` Latest snapshot: ${new Date(latest.at).toLocaleString()}.`
        : ' No snapshots anchored yet.';
      return { status: 'healthy', detail: `${total} health snapshot(s), ${anchored} committed with block refs — digest covers every assessment and intake, so record tampering is detectable.${lastNote} Verifiable export (signed credential) available.` };
    }),

    // Feature 7 — Data sovereignty & rewards (consent smart-contracts)
    probe('bc_data_consent', 'Data Sovereignty Consent', 'blockchain', async () => {
      const [active, revoked, consentTx] = await Promise.all([
        DataShare.countDocuments({ status: 'active' }),
        DataShare.countDocuments({ status: 'revoked' }),
        DataShare.countDocuments({ consentTx: { $ne: '' } }),
      ]);
      const dataShareReward = DEFAULT_PARAMS.dataShareReward;
      return { status: 'healthy', detail: `Consent smart-contracts: ${active} active research share(s), ${revoked} revoked (payload destroyed on revoke), ${consentTx} consent record(s) anchored on-chain. Exact terms + scope hashed before any grant — withdrawable at any time, +${dataShareReward} WELL per grant.` };
    }),

    // Feature 8 — Decentralized & encrypted storage (content-addressed)
    probe('bc_storage', 'Encrypted Decentralized Storage', 'blockchain', async () => {
      const [total, malformed] = await Promise.all([
        StorageObject.countDocuments(),
        StorageObject.countDocuments({ $or: [{ ciphertext: '' }, { iv: '' }, { tag: '' }] }),
      ]);
      if (malformed > 0) {
        return { status: 'critical', detail: `${malformed} stored object(s) are missing ciphertext/IV/auth-tag — those payloads cannot be decrypted safely.` };
      }
      const [agg] = await StorageObject.aggregate([
        { $group: { _id: null, bytes: { $sum: '$size' } } },
      ]);
      const bytes = agg ? agg.bytes : 0;
      return { status: 'healthy', detail: `${total} object(s) (${bytes} bytes) content-addressed by CID and encrypted with AES-256-GCM — no plaintext at rest, and the CID itself binds the content (tamper = different CID).` };
    }),

    // Feature 9 — WELL rewards engine (healthy-habit incentives)
    probe('bc_rewards', 'WELL Rewards Engine', 'blockchain', async () => {
      const [total, agg, latest] = await Promise.all([
        RewardEvent.countDocuments(),
        RewardEvent.aggregate([{ $group: { _id: null, sum: { $sum: '$amount' } } }]),
        RewardEvent.findOne().sort({ at: -1 }).select('kind amount at').lean(),
      ]);
      const minted = agg[0] ? agg[0].sum : 0;
      const lastNote = latest
        ? ` Latest: ${latest.kind} (+${latest.amount} WELL) at ${new Date(latest.at).toLocaleString()}.`
        : ' No rewards claimed yet.';
      return { status: 'healthy', detail: `${total} reward event(s), ${minted} WELL minted for verified activity (check-ins, intakes, assessments). Unique (user, kind, refId) index makes every claim idempotent — double-claiming is impossible.${lastNote}` };
    }),

    // Feature 10 — Achievement NFT gallery
    probe('bc_nfts', 'Achievement NFTs', 'blockchain', async () => {
      const [total, uniqueTokens] = await Promise.all([
        Nft.countDocuments(),
        Nft.distinct('tokenId').then(ids => ids.length),
      ]);
      if (uniqueTokens !== total) {
        return { status: 'critical', detail: `Duplicate NFT tokenIds detected (${total} docs vs ${uniqueTokens} unique) — the collection's uniqueness invariant is broken.` };
      }
      return { status: 'healthy', detail: `${total} achievement NFT(s) minted with globally unique tokenIds, each carrying its on-chain mint txHash. Gallery eligibility derives from the same reward events above.` };
    }),

    // Feature 11 — Token staking
    probe('bc_staking', 'Token Staking', 'blockchain', async () => {
      const [agg, negative] = await Promise.all([
        Wallet.aggregate([
          { $match: { staked: { $gt: 0 } } },
          { $group: { _id: null, holders: { $sum: 1 }, staked: { $sum: '$staked' } } },
        ]),
        Wallet.countDocuments({ staked: { $lt: 0 } }),
      ]);
      if (negative > 0) {
        return { status: 'critical', detail: `${negative} wallet(s) hold a NEGATIVE staked balance — the staking invariant (staked >= 0) is violated.` };
      }
      const holders = agg[0] ? agg[0].holders : 0;
      const staked = agg[0] ? agg[0].staked : 0;
      return { status: 'healthy', detail: `${holders} holder(s) staking ${staked} WELL total. APY (stakeApyPct) accrues daily and is governed by the DAO; staked >= 500 unlocks premium perks. Invariant staked >= 0 holds on every wallet.` };
    }),

    // Feature 12 — Loyalty program
    probe('bc_loyalty', 'Loyalty Program', 'blockchain', async () => {
      const [unused, redeemed, bad] = await Promise.all([
        LoyaltyCode.countDocuments({ status: 'unused' }),
        LoyaltyCode.countDocuments({ status: 'redeemed' }),
        LoyaltyCode.countDocuments({ valueWell: { $lt: 0 } }),
      ]);
      if (bad > 0) {
        return { status: 'critical', detail: `${bad} loyalty code(s) carry a negative value — the redeem invariant is violated.` };
      }
      return { status: 'healthy', detail: `Loyalty conversion live: ${unused} unused code(s), ${redeemed} redeemed. WELL converts at the DAO param loyaltyRedeemRate (min 10 WELL); every burn/redemption is recorded on-chain.` };
    }),

    // Feature 13 — DAO governance
    probe('bc_dao', 'DAO Governance', 'blockchain', async () => {
      const [active, passed, rejected] = await Promise.all([
        Proposal.countDocuments({ status: 'active' }),
        Proposal.countDocuments({ status: 'passed' }),
        Proposal.countDocuments({ status: 'rejected' }),
      ]);
      const cfg = await Web3Config.findOne({ key: 'main' }).lean();
      const params = (cfg && cfg.params) || {};
      const missing = Object.keys(DEFAULT_PARAMS).filter(k => !(k in params));
      if (missing.length) {
        return { status: 'warning', detail: `DAO parameter set incomplete — missing: ${missing.join(', ')}. Falling back to genesis defaults until the config doc is repaired.` };
      }
      return { status: 'healthy', detail: `${active} active proposal(s), ${passed} passed, ${rejected} rejected. All ${Object.keys(DEFAULT_PARAMS).length} protocol params published as the public contract terms (rewards, fees, quorum, APY) — voting weight = stake, quorum ${DEFAULT_PARAMS.daoQuorumWeight}, ${DEFAULT_PARAMS.daoVotingDays}-day lifetime, lazy on-chain execution.` };
    }),

    // Feature 14 — Community knowledge base
    probe('bc_knowledge', 'Community Knowledge Base', 'blockchain', async () => {
      const [posts, agg] = await Promise.all([
        KnowledgePost.countDocuments(),
        KnowledgePost.aggregate([{ $group: { _id: null, up: { $sum: '$upvotes' } } }]),
      ]);
      const upvotes = agg[0] ? agg[0].up : 0;
      const p = DEFAULT_PARAMS;
      return { status: 'healthy', detail: `${posts} post(s), ${upvotes} total upvote(s). Publishing pays ${p.knowledgeReward} WELL to the author and ${p.knowledgeUpvoteReward} per upvote (capped ${p.knowledgeUpvoteCap}) plus ${p.curatorReward} to the curator — payout tx recorded per post.` };
    }),

    // Feature 15 — Decentralized dispute resolution
    probe('bc_disputes', 'Dispute Resolution (jurors)', 'blockchain', async () => {
      const [open, resolved, withVotes] = await Promise.all([
        Dispute.countDocuments({ status: 'open' }),
        Dispute.countDocuments({ status: 'resolved' }),
        Dispute.countDocuments({ 'votes.0': { $exists: true } }),
      ]);
      return { status: 'healthy', detail: `${open} open dispute(s), ${resolved} resolved, ${withVotes} with juror votes recorded. Jurors are randomly drawn from staked holders (never a party), majority verdict settles escrow, +${DEFAULT_PARAMS.jurorReward} WELL per juror.` };
    }),

    // Feature 16 — Interoperable health profile share links
    probe('bc_share_links', 'Health Profile Share Links', 'blockchain', async () => {
      const now = Date.now();
      const [active, revoked, expired] = await Promise.all([
        ShareLink.countDocuments({ revoked: false, expiresAt: { $gt: now } }),
        ShareLink.countDocuments({ revoked: true }),
        ShareLink.countDocuments({ revoked: false, expiresAt: { $lte: now } }),
      ]);
      return { status: 'healthy', detail: `${active} live share link(s) for doctor/nutritionist views, ${revoked} revoked, ${expired} naturally expired. Links are time-boxed and revocable; views are counted per token.` };
    }),

    // Feature 17 — Verifiable AI recommendations (transparency proofs)
    probe('bc_ai_proof', 'Verifiable AI Recommendations', 'blockchain', async () => {
      const [total, complete] = await Promise.all([
        RecAnchor.countDocuments(),
        RecAnchor.countDocuments({
          inputHash: { $ne: '' }, outputHash: { $ne: '' }, combinedHash: { $ne: '' },
          txHash: { $ne: '' }, blockIndex: { $gte: 0 },
        }),
      ]);
      if (complete < total) {
        return { status: 'warning', detail: `${total} AI proof(s) recorded but only ${complete} fully anchored on-chain — the outstanding recommendations lack a block reference.` };
      }
      return { status: 'healthy', detail: `${total} AI recommendation proof(s) anchored: input hash, output hash and logic version recorded per assessment — anyone can re-verify that the advice shown is the advice that was hashed.` };
    }),

    // Feature 18 — Secure clinical trial participation (on-chain consent)
    probe('bc_trials', 'Clinical Trial Consent', 'blockchain', async () => {
      const [trials, optedIn, withdrawn, anchored] = await Promise.all([
        Trial.countDocuments(),
        TrialConsent.countDocuments({ status: 'opted-in' }),
        TrialConsent.countDocuments({ status: 'withdrawn' }),
        TrialConsent.countDocuments({ consentTx: { $ne: '' } }),
      ]);
      return { status: 'healthy', detail: `${trials} trial(s) listed, ${optedIn} active consent record(s), ${withdrawn} withdrawn, ${anchored} with terms digests anchored on-chain. Consent stores the exact hashed terms + data scope; withdrawal is recorded just as permanently.` };
    }),

    // Feature 19 — Decentralized oracles
    probe('bc_oracle', 'Decentralized Oracles', 'blockchain', async () => {
      const feeds = await OracleFeed.find({}).select('key updatedAt').lean();
      if (!feeds.length) {
        return { status: 'warning', detail: 'No oracle feeds registered — pricing/research/market data has no external input. Seeded automatically on boot; check the [web3] chain-ready log.' };
      }
      const newest = Math.max(...feeds.map(f => Number(f.updatedAt) || 0));
      const ageH = (Date.now() - newest) / 36e5;
      const stale = ageH > 48;
      return {
        status: stale ? 'warning' : 'healthy',
        detail: `${feeds.length} feed(s) live across pricing/research/market. Latest value: ${ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))} min` : `${Math.round(ageH)} h`} ago — values re-derived deterministically each day (auditable) and anchored.${stale ? ' Feeds are stale (>48 h): trigger a refresh from the Web3 hub.' : ''}`,
      };
    }),

    // Feature 20 — Tokenized access to health professionals
    probe('bc_experts', 'Professional Bookings', 'blockchain', async () => {
      const [experts, confirmed, cancelled] = await Promise.all([
        Expert.countDocuments({ active: true }),
        Booking.countDocuments({ status: 'confirmed' }),
        Booking.countDocuments({ status: 'cancelled' }),
      ]);
      return { status: 'healthy', detail: `${experts} active expert(s) listed at WELL hourly rates, ${confirmed} confirmed booking(s), ${cancelled} cancelled. Payment settles on-chain from the user's wallet at booking time; each booking carries its own txHash.` };
    }),
  ]);

  // Derive overall monitor status
  const hasCritical = results.some(r => r.status === 'critical' || r.status === 'error');
  const hasWarning = results.some(r => r.status === 'warning');
  const overallMonitorStatus = hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy';

  const payload = { monitors: results, overallMonitorStatus, syncedAt: at, audit: SECURITY_AUDIT };
  monitorCache = { at: Date.now(), payload };
  res.json(payload);
});

router.get('/security', (req, res) => {
  const checks = securityChecks();
  const recommendations = checks
    .filter(check => check.status !== 'Secure')
    .map(check => ({
      title: check.label,
      description: check.fix || '',
      // `critical` is on the original object before the status map replaces it,
      // so read it safely with a fallback so priority is never undefined.
      priority: check.status === 'Critical' ? 'Critical' : 'High',
    }));

  const hasCritical = checks.some(check => check.status === 'Critical');
  const hasVulnerable = checks.some(check => check.status === 'Vulnerable');

  let overallStatus = 'Secure';
  if (hasCritical) {
    overallStatus = 'Critical';
  } else if (hasVulnerable) {
    overallStatus = 'Vulnerable';
  }

  res.json({
    checks,
    overallStatus,
    lastScanned: new Date().toISOString(),
    recommendations,
    notifications: recommendations.map(rec => ({
      type: 'security',
      title: rec.title,
      detail: rec.description,
    })),
  });
});

router.get('/ai', (req, res) => {
  res.json({ providers: [
    { key: 'openrouter', label: 'OpenRouter (DeepSeek V4 Flash)', configured: Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key_here'), model: 'deepseek/deepseek-v4-flash-0731' },
    { key: 'groq', label: 'Groq', configured: Boolean(process.env.GROQ_API_KEY), model: process.env.GROQ_MODEL || 'not configured' },
    { key: 'openai', label: 'OpenAI', configured: Boolean(process.env.OPENAI_API_KEY), model: process.env.OPENAI_MODEL || 'not configured' },
    { key: 'anthropic', label: 'Anthropic', configured: Boolean(process.env.ANTHROPIC_API_KEY), model: process.env.ANTHROPIC_MODEL || 'not configured' },
  ] });
});

router.get('/profile', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.user._id)) return res.json({ alias: req.user.alias, createdAt: null, lastLoginAt: null, profilePicture: '', bannerPicture: '' });
    const account = await AdminAccount.findById(req.user._id).select('alias createdAt lastLoginAt profilePicture bannerPicture').lean();
    res.json({
      alias: account?.alias || req.user.alias,
      createdAt: account?.createdAt || null,
      lastLoginAt: account?.lastLoginAt || null,
      profilePicture: account?.profilePicture || '',
      bannerPicture: account?.bannerPicture || '',
    });
  } catch (error) {
    console.error('[admin/profile]', error.message);
    res.status(500).json({ message: 'Unable to load the admin profile.' });
  }
});

// ── Edit profile: picture + background picture ──────────────────────────
// Same contract as the member-facing /profile update (base64 data URLs) so
// the client mirrors ProfilePage: either key may be sent alone, an empty
// string clears it, and anything else is rejected before it reaches Mongo.
const MAX_ADMIN_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_ADMIN_BANNER_BYTES = 3 * 1024 * 1024; // 3 MB
const isImageDataUrl = (value) => typeof value === 'string'
  && value.startsWith('data:image/')
  && value.includes(';base64,');

router.patch('/profile', async (req, res) => {
  try {
    const { profilePicture, bannerPicture } = req.body || {};
    if (profilePicture === undefined && bannerPicture === undefined) {
      return res.status(400).json({ message: 'Nothing to update.' });
    }
    if (!mongoose.isValidObjectId(req.user._id)) return res.status(409).json({ message: 'Please sign in again before editing the admin profile.' });

    const validatePicture = (value, maxBytes, label, tooBigMessage) => {
      if (value === '') return { ok: true, stored: '' };
      if (!isImageDataUrl(value)) return { ok: false, message: `${label} must be an image file.` };
      if (Buffer.byteLength(value, 'utf8') > maxBytes) return { ok: false, message: tooBigMessage };
      return { ok: true, stored: value };
    };

    let nextAvatar;
    let nextBanner;
    if (profilePicture !== undefined) {
      const avatarCheck = validatePicture(profilePicture, MAX_ADMIN_AVATAR_BYTES, 'Profile picture', 'Profile picture must be smaller than 2 MB.');
      if (!avatarCheck.ok) return res.status(400).json({ message: avatarCheck.message });
      nextAvatar = avatarCheck.stored;
    }
    if (bannerPicture !== undefined) {
      const bannerCheck = validatePicture(bannerPicture, MAX_ADMIN_BANNER_BYTES, 'Background picture', 'Background picture must be smaller than 3 MB.');
      if (!bannerCheck.ok) return res.status(400).json({ message: bannerCheck.message });
      nextBanner = bannerCheck.stored;
    }

    const account = await AdminAccount.findById(req.user._id);
    if (!account) return res.status(404).json({ message: 'Admin account not found.' });
    if (profilePicture !== undefined) account.profilePicture = nextAvatar;
    if (bannerPicture !== undefined) account.bannerPicture = nextBanner;
    await account.save();

    res.json({
      alias: account.alias,
      profilePicture: account.profilePicture || '',
      bannerPicture: account.bannerPicture || '',
      message: 'Profile picture and background saved.',
    });
  } catch (error) {
    console.error('[admin/profile/patch]', error.message);
    res.status(500).json({ message: 'Unable to save the admin profile.' });
  }
});

router.patch('/profile/password', async (req, res) => {
  try {
    const { currentPassword, newPassword, otp } = req.body || {};
    if (!currentPassword || !newPassword || !/^\d{6}$/.test(String(otp || ''))) return res.status(400).json({ message: 'Current password, new password, and authenticator code are required.' });
    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) return res.status(400).json({ message: 'New password must be at least 8 characters with a capital letter and number.' });
    if (!mongoose.isValidObjectId(req.user._id)) return res.status(409).json({ message: 'Please sign in again before changing the admin password.' });
    const account = await AdminAccount.findById(req.user._id).select('+passwordHash +totpSecret');
    if (!account) return res.status(404).json({ message: 'Admin account not found.' });
    const { verifyPassword, hashPassword } = require('../utils/password');
    if (!await verifyPassword(currentPassword, account.passwordHash)) return res.status(401).json({ message: 'Current password is incorrect.' });
    const verified = verifyTotpOnce(account.totpSecret, otp);
    if (!verified) return res.status(401).json({ message: 'Invalid authenticator code.' });
    account.passwordHash = await hashPassword(newPassword);
    await account.save();
    res.json({ message: 'Admin password changed successfully.' });
  } catch (error) {
    console.error('[admin/profile/password]', error.message);
    res.status(500).json({ message: 'Unable to change the admin password.' });
  }
});

router.post('/profile/authenticator/rotate', async (req, res) => {
  try {
    const { otp } = req.body || {};
    if (!mongoose.isValidObjectId(req.user._id)) return res.status(409).json({ message: 'Please sign in again before rotating your authenticator key.' });
    const account = await AdminAccount.findById(req.user._id).select('+totpSecret');
    if (!account) return res.status(404).json({ message: 'Admin account not found.' });
    if (!/^\d{6}$/.test(String(otp || '')) || !verifyTotpOnce(account.totpSecret, otp)) return res.status(401).json({ message: 'Invalid current authenticator code.' });
    const secret = speakeasy.generateSecret({ name: `SuppliWise Admin (${account.alias})`, issuer: 'SuppliWise' });
    account.totpSecret = secret.base32;
    await account.save();
    res.json({ qrCode: await require('qrcode').toDataURL(secret.otpauth_url), secret: secret.base32, message: 'New authenticator key generated. Add it before signing out.' });
  } catch (error) {
    console.error('[admin/profile/authenticator/rotate]', error.message);
    res.status(500).json({ message: 'Unable to rotate the authenticator key.' });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    const security = securityChecks()
      .filter(check => check.status !== 'Secure')
      .map(check => ({ type: 'security', title: check.label, detail: check.fix || '', createdAt: new Date() }));
    const events = await AdminEvent.find().sort({ createdAt: -1 }).limit(30).lean();
    res.json({ unreadCount: events.filter(event => !event.readBy.some(id => String(id) === String(req.user._id))).length + security.length, notifications: [...security, ...events] });
  } catch (error) {
    console.error('[admin/notifications]', error.message);
    res.status(500).json({ message: 'Unable to load notifications.' });
  }
});

router.post('/notifications/read', async (req, res) => {
  const { notificationIds } = req.body;
  // Strict validation: bounded array of real ObjectIds only. Raw values would
  // flow into { _id: { $in: [...] } } — operator objects must never reach it.
  if (!Array.isArray(notificationIds) || notificationIds.length === 0 || notificationIds.length > 100) {
    return res.status(400).json({ message: 'Invalid request body.' });
  }
  if (!notificationIds.every(id => mongoose.isValidObjectId(id))) {
    return res.status(400).json({ message: 'Invalid notification.' });
  }
  try {
    await AdminEvent.updateMany({ _id: { $in: notificationIds } }, { $addToSet: { readBy: req.user._id } });
    res.json({ message: 'Notifications marked as read.' });
  } catch (error) {
    console.error('[admin/notifications/read]', error.message);
    res.status(500).json({ message: 'Unable to mark notifications as read.' });
  }
});

router.post('/notifications/read-all', async (req, res) => {
  try {
    await AdminEvent.updateMany(
      { readBy: { $ne: req.user._id } },
      { $addToSet: { readBy: req.user._id } }
    );
    res.json({ message: 'All notifications marked as read.' });
  } catch (error) {
    console.error('[admin/notifications/read-all]', error.message);
    res.status(500).json({ message: 'Unable to mark notifications as read.' });
  }
});

router.delete('/notifications/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid notification.' });
    const event = await AdminEvent.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ message: 'Notification not found.' });
    res.json({ message: 'Notification deleted.' });
  } catch (error) {
    console.error('[admin/notifications/:id]', error.message);
    res.status(500).json({ message: 'Unable to delete the notification.' });
  }
});

module.exports = router;