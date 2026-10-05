const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Assessment = require('../models/Assessment');
const AdminAccount = require('../models/AdminAccount');
const AdminEvent = require('../models/AdminEvent');
const Session = require('../models/Session');
const Passkey = require('../models/Passkey');
const { describeFactor } = require('../utils/strongestFactor');
const UserNotification = require('../models/UserNotification');
const SubscriptionRequest = require('../models/SubscriptionRequest');
const SubscriptionCancelRequest = require('../models/SubscriptionCancelRequest');
const IntakeRecord = require('../models/IntakeRecord');
const DashboardMetrics = require('../models/DashboardMetrics');
const ChatThread = require('../models/ChatThread');
const ChatMessage = require('../models/ChatMessage');
const { isArgon2id, isBcrypt } = require('../utils/password');
const { SECURITY_AUDIT } = require('../utils/securityAudit');
const { getAiProviders, oldestCheck, isEnvStale, checkAiProvider, AI_PROVIDERS } = require('../utils/aiProviders');
const { describeRouting } = require('../utils/aiRouter');
const { detectSystemThreats } = require('../utils/systemDetection');
const { getLastOutcome } = require('../utils/priorityFlagging');
const { reloadFromDisk } = require('../utils/envFile');
const {
  TREND_BUCKET_DAYS,
  dailyBucketPipeline,
  engagementPipeline,
  engagementFrom,
  profilePipeline,
  profileFrom,
  runwayPipeline,
  runwayFrom,
  reviewPipeline,
  reviewFrom,
  listValueMonthly,
  activationOf,
} = require('../utils/overviewAnalytics');
const speakeasy = require('speakeasy');
const { protect, adminOnly } = require('../middleware/auth');
const { verifyTotpOnce } = require('../utils/totp');
// Admin avatar/background bytes go to disk; the document keeps only the URL.
// See utils/pictures.js.
const { storePicture, safePictureValue } = require('../utils/pictures');
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
const { readBigDocument } = require('../utils/bigDocuments');

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
  SubscriptionRequest,
  SubscriptionCancelRequest,
  IntakeRecord,
  DashboardMetrics,
  // Support conversations. Both carry a `user` field, so the derivation below
  // picks them up with no edit here — a support transcript left behind by a
  // deleted account is a record of a conversation with nobody.
  ChatThread,
  ChatMessage,
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
// twoFactorMethod travels WITH twoFactorEnabled: the boolean says a second step
// exists, the method says which one. Without both, the admin grid had to guess,
// and it guessed wrong for every account on email codes.
const adminUserFields = 'firstName lastName email createdAt subscriptionActive subscriptionPlan subscriptionStartedAt subscriptionExpiresAt subscriptionPermanent subscriptionSource subscriptionUpdatedAt subscriptionRecord twoFactorEnabled twoFactorMethod lastLoginAt lastLoginIp lastLoginLocation lastLoginUserAgent accountRole accountStatus profilePicture';
// Same rows for the overview preview, minus the avatar: that table never
// draws one, and large fields are the dominant cost of reading from Atlas
// (measured ~10 ms/KB — the avatar alone was 668 ms of a 783 ms endpoint).
const adminOverviewUserFields = adminUserFields.replace(/\s*profilePicture/, '');

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

// ============================================================================
// OVERVIEW ANALYTICS
//
// The original /overview answered "how much is there" (four counters) and "how
// fast is it arriving" (one 14-day bucket list). Everything else on the Overview
// tab was derived client-side from those, which capped what the panel could
// honestly claim.
//
// The second tier - acquisition, activation, engagement depth, renewal runway, the
// health profile members submit, and the review backlog - is built here. The
// shaping helpers and the aggregation pipelines live in utils/overviewAnalytics.js
// so they can be unit tested against the malformed shapes a real database
// actually produces (a null count, an empty $facet stage, a trend that never
// sorted) instead of only when a panel happens to render.
//
// COST NOTE. Every step below is ONE query, and every one of them touches only
// small narrow fields (`user`, `createdAt`, `subscriptionExpiresAt`). None of them
// reads a document back, so the ~500 KB `aiResults` blob that once made this
// endpoint 783 ms stays out of it. They all run inside the SAME Promise.all as
// the existing counts, so wall-clock latency is that of the slowest query rather
// than the sum of all of them.
// ============================================================================


router.get('/overview', async (req, res) => {
  try {
    const now = new Date();
    const day7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const day30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [
      users, assessments, activeSubscriptions, recentUsers, assessmentTrend,
      signups7d, signups30d, planRows, twoFactorEnabled,
      signupSeries, engagementRows, profileRows, runwayRows, reviewRows,
    ] = await Promise.all([
      User.countDocuments(),
      Assessment.countDocuments(),
      // A "live" subscription is one that grants access RIGHT NOW: the flag is
      // set AND the window has not elapsed. A permanent grant has no end date,
      // so it is always live. Counting the bare flag overstated this metric by
      // every subscription that had quietly expired.
      User.countDocuments({
        subscriptionActive: true,
        subscriptionPlan: { $ne: 'free' },
        $or: [
          { subscriptionPermanent: true },
          { subscriptionExpiresAt: null },
          { subscriptionExpiresAt: { $gt: now } },
        ],
      }),
      // NO profilePicture here: the overview's Recent users table renders
      // name / joined / subscription / 2FA badges only — never an avatar —
      // yet the field made this single query account for 668 ms of the
      // endpoint's 783 ms, because large fields cost ~10 ms/KB to read back
      // from Atlas. The authoritative /users list (which does draw avatars)
      // keeps it.
      User.find().select(adminOverviewUserFields).sort({ createdAt: -1 }).limit(8).lean(),
      // 30 daily buckets, not 14: the client windows this down to 7 / 14 / 30 for
      // the range toggle, so widening the range costs no extra query — and three
      // separate aggregations over the same documents would be three chances for
      // the two charts to disagree.
      Assessment.aggregate(dailyBucketPipeline()),
      // Analytics (cheap indexed counts, same round-trip)
      User.countDocuments({ createdAt: { $gte: day7 } }),
      User.countDocuments({ createdAt: { $gte: day30 } }),
      // Plan distribution across LIVE subscriptions only, so the breakdown
      // agrees with the activeSubscriptions metric above instead of counting
      // windows that have already ended.
      User.aggregate([
        {
          $match: {
            subscriptionActive: true,
            subscriptionPlan: { $ne: 'free' },
            $or: [
              { subscriptionPermanent: true },
              { subscriptionExpiresAt: null },
              { subscriptionExpiresAt: { $gt: now } },
            ],
          },
        },
        { $group: { _id: '$subscriptionPlan', count: { $sum: 1 } } },
      ]),
      User.countDocuments({ twoFactorEnabled: true }),
      // ── Second tier (see the OVERVIEW ANALYTICS block above) ──
      // Acquisition: the same daily buckets, over registrations rather than
      // assessments. Same helper, so the two series are bucketed identically and
      // a signup can never be dated to a different day than an assessment.
      User.aggregate(dailyBucketPipeline()),
      Assessment.aggregate(engagementPipeline(day7, day30)),
      Assessment.aggregate(profilePipeline()),
      User.aggregate(runwayPipeline(now, day7, day30)),
      Assessment.aggregate(reviewPipeline()),
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

    const security = securityChecks();
    // recentUsers carry live lockout state too — otherwise the overview
    // payload (no lockout field) would overwrite the authoritative /users
    // list with "Clear" rows while login still enforces a 429.
    const recentWithLockout = attachLockout(recentUsers);
    // Shaped here, not in the panel, so the numbers are normalised ONCE and the
    // client receives the same shape whether the collections are full, sparse or
    // completely empty.
    const engagement = engagementFrom(engagementRows);
    const profile = profileFrom(profileRows);
    const runway = runwayFrom(runwayRows);
    const review = reviewFrom(reviewRows);
    const activation = activationOf(engagement.assessors, users);
    res.json({
      metrics: { users, assessments, activeSubscriptions, inactiveSubscriptions: users - activeSubscriptions },
      recentUsers: recentWithLockout,
      assessmentTrend: Array.isArray(assessmentTrend) ? assessmentTrend : [],
      // The window the two trend arrays actually cover. The client densifies back
      // to this many columns, so a server that trimmed the buckets must trim this
      // too — otherwise the chart would claim days it was never sent.
      trendDays: TREND_BUCKET_DAYS,
      signupTrend: Array.isArray(signupSeries) ? signupSeries : [],
      analytics: {
        signups7d, signups30d, planBreakdown, twoFactorEnabled, lockedAccounts,
        twoFactorPct: users > 0 ? Math.round((twoFactorEnabled / users) * 100) : 0,
        // Activation: how many members have EVER produced an assessment, as a
        // share of everyone who registered. Capped at `users` because the two
        // are independent queries — a signup landing between them would
        // otherwise report 108% of members as activated.
        activatedMembers: activation.members,
        activationPct: activation.pct,
        // Engagement depth: did they come back, and how recently?
        activeAssessors7d: engagement.active7d,
        activeAssessors30d: engagement.active30d,
        repeatAssessors: engagement.repeat,
        oneOffAssessors: engagement.singletons,
        repeatPct: engagement.assessors > 0
          ? Math.round((engagement.repeat / engagement.assessors) * 100)
          : 0,
        // What members actually say about themselves.
        profile,
        // Renewal runway, and the review backlog waiting on the admin.
        runway,
        review,
        // Priced from the same catalogue the checkout charges from — see
        // listValueMonthly. Labelled as list value in the UI.
        listValueMonthly: listValueMonthly(planBreakdown),
      },
      // Providers are no longer listed here. This block used to re-report
      // GROQ/OPENAI/ANTHROPIC from a set of *_HEALTH_URL variables that appear
      // in neither .env nor .env.example, so it always answered
      // `{configured: false, status: 'not-configured'}` while counting real keys
      // from process.env into `configuredCount` — a configuredCount that grew
      // with keys this object claimed were not configured. And `providers` was
      // an object here but an array on GET /ai, so any consumer that read both
      // got two different shapes for one concept. GET /ai is the single source
      // of truth for provider state; it also costs nothing when nobody is
      // looking, whereas this ran three unauthenticated HEAD requests on every
      // overview load.
      ai: { source: '/api/admin/ai' },
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
    //
    // subscriptionExpiresAt / subscriptionPermanent are NOT optional here.
    // The grid's isSubscriptionLive() reads them to decide whether a paid plan
    // has actually lapsed, and treats a MISSING end date as "open-ended" — so
    // omitting them made every expired subscriber render as "Subscribed ✓",
    // which is precisely the lie this projection exists to prevent. The
    // per-user detail route already selects both (adminUserFields above).
    const users = await User.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .select('firstName lastName email createdAt subscriptionActive subscriptionPlan subscriptionStartedAt subscriptionExpiresAt subscriptionPermanent subscriptionSource twoFactorEnabled twoFactorMethod lastLoginAt lastLoginIp lastLoginLocation lastLoginUserAgent accountRole accountStatus profilePicture')
      .lean();
    let countMap = new Map();
    let passkeyMap = new Map();
    if (users.length > 0) {
      const ids = users.map(u => u._id);
      // Two grouped aggregates, run together. A per-user countDocuments() loop
      // would be 100 extra round trips on every table render — the exact N+1
      // this endpoint was rewritten to remove.
      //
      // The passkey query is allowed to fail on its own: on a database where the
      // collection has not been created yet, a missing collection must degrade
      // the security column to "password only" rather than take down the whole
      // users table. Security display is important; the account list is load
      // bearing.
      const [counts, passkeyCounts] = await Promise.all([
        Assessment.aggregate([
          { $match: { user: { $in: ids } } },
          { $group: { _id: '$user', count: { $sum: 1 } } },
        ]),
        Passkey.aggregate([
          { $match: { user: { $in: ids } } },
          { $group: { _id: '$user', count: { $sum: 1 } } },
        ]).catch((error) => {
          console.error('[admin/users] passkey counts unavailable:', error.message);
          return [];
        }),
      ]);
      countMap = new Map(counts.map(c => [String(c._id), c.count]));
      passkeyMap = new Map(passkeyCounts.map(c => [String(c._id), c.count]));
    }
    const withCounts = users.map(user => ({
      ...user,
      assessmentCount: countMap.get(String(user._id)) || 0,
      passkeyCount: passkeyMap.get(String(user._id)) || 0,
      // Resolved server-side from the real rows above, so the badge cannot
      // drift from the account's actual state. `security` is the single field
      // the grid renders; the raw inputs stay on the row for anything that
      // needs them.
      security: describeFactor({
        passkeyCount: passkeyMap.get(String(user._id)) || 0,
        twoFactorEnabled: user.twoFactorEnabled,
        twoFactorMethod: user.twoFactorMethod,
      }),
    }));
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
    // An admin account has no `email` field — the address lives in the
    // ADMIN_EMAILS value in .env — so it is joined on here. The panel renders
    // `admin.email || 'No email on file'`; without this join that fallback was
    // the only thing it could ever show. Resolved per request rather than
    // cached: editing .env and restarting is how an address changes, and a
    // cached copy would show a retired address for the life of the process.
    const { configuredAdminEmails } = require('../utils/adminAccounts');
    const emailByAlias = new Map(configuredAdminEmails().map(entry => [entry.alias, entry.email]));
    const withLockout = (admins || []).map(admin => {
      const info = lockInfo(accountKey('admin', admin.alias || ''));
      return {
        ...admin,
        email: emailByAlias.get(admin.alias) || '',
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

// ── Administrator credential notices ─────────────────────────────────────
// Emails every configured administrator that the stored form of their
// credentials changed. It carries NO secret — see sendAdminCredentialUpdateEmail
// in utils/email.js for why a recurring channel must not. The recipients come
// from the ADMIN_EMAILS value in .env, and both this route and the
// `notify-admins` script resolve them through utils/adminCredentialNotice.js,
// so the button and the terminal can never disagree about who was reached.

// @route   GET /api/admin/admins/credential-notice/preview
// @desc    Who the notice would reach, and who has no address on file. Shown
//          before the send so an operator sees the recipients rather than
//          discovering a missing address after pressing the button.
// @access  Private (Admin)
router.get('/admins/credential-notice/preview', (req, res) => {
  try {
    const { configuredAdminEmails, adminAccountsMissingEmail } = require('../utils/adminAccounts');
    const { DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION } = require('../utils/email');
    res.json({
      description: DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION,
      recipients: configuredAdminEmails(),
      missingEmail: adminAccountsMissingEmail(),
      // Reported, not enforced here: whether a send is actually possible
      // depends on the SMTP config, which the security panel already probes.
      emailConfigured: Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD),
    });
  } catch (error) {
    console.error('[admin/credential-notice/preview]', error.message);
    res.status(500).json({ message: 'Unable to read the administrator address list.' });
  }
});

// A send is slow (one SMTP round trip per admin, deliberately not concurrent)
// and, more importantly, it is real email that a human will receive. Without a
// cooldown the button is a mailgun pointed at the whole admin team, and an
// accidental double-click sends every administrator a duplicate security
// notice — which reads to them as though a compromise happened twice.
const LAST_CREDENTIAL_NOTICE_AT = { at: 0 };
const CREDENTIAL_NOTICE_COOLDOWN_MS = 60_000;

// @route   POST /api/admin/admins/notify-credentials
// @desc    Email every configured administrator the credential-update notice.
// @access  Private (Admin)
router.post('/admins/notify-credentials', async (req, res) => {
  const { notifyAllAdminsAboutCredentials } = require('../utils/adminCredentialNotice');

  const body = req.body || {};
  // The recipient list is server-side config, so `description` is the only
  // field a caller may influence — and it is capped because it is rendered
  // into the message.
  const description = String(body.description || '').trim().slice(0, 400);
  // Not a security control (the address list is not caller-controlled) — this
  // exists so the endpoint cannot be pointed at an arbitrary recipient list,
  // which would turn an admin-only route into an open relay with an audit
  // trail pointing at whoever pressed it.
  if (body.to !== undefined || body.recipients !== undefined) {
    return res.status(400).json({ message: 'Recipients are configured on the server, not per request.' });
  }

  const elapsed = Date.now() - LAST_CREDENTIAL_NOTICE_AT.at;
  if (elapsed < CREDENTIAL_NOTICE_COOLDOWN_MS) {
    const retryAfter = Math.ceil((CREDENTIAL_NOTICE_COOLDOWN_MS - elapsed) / 1000);
    return res.status(429).json({
      message: `Please wait ${retryAfter} second${retryAfter === 1 ? '' : 's'} before sending this notice again.`,
      retryAfterSeconds: retryAfter,
    });
  }

  try {
    const report = await notifyAllAdminsAboutCredentials({
      description,
      triggeredBy: (req.user && req.user.alias) || 'operator',
    });
    // Only consumed once the send actually ran, so a rejected request does not
    // leave the operator locked out of a notice they never sent.
    LAST_CREDENTIAL_NOTICE_AT.at = Date.now();

    if (report.unconfigured) {
      return res.status(400).json({
        message: 'No administrator email addresses are configured. Add ADMIN_EMAILS to server/.env and restart the server.',
        ...report,
      });
    }

    const by = (req.user && req.user.alias) || 'an administrator';
    await AdminEvent.create({
      type: 'security',
      title: 'Credential update notice sent to administrators',
      detail: `${report.delivered.length} of ${report.recipients} delivered by ${by}.`
        + (report.missingEmail.length ? ` No address on file for: ${report.missingEmail.join(', ')}.` : ''),
    }).catch(() => {});

    // 207: the batch ran and at least one address was rejected. Reporting this
    // as a plain 200 would let the console paint "sent to everyone" over a list
    // where someone demonstrably was not reached.
    const partial = report.failed.length > 0;
    res.status(partial ? 207 : 200).json({
      message: partial
        ? `Notice sent to ${report.delivered.length} of ${report.recipients} administrator(s). ${report.failed.length} address(es) were rejected.`
        : `Notice sent to ${report.recipients} administrator(s).`,
      ...report,
    });
  } catch (error) {
    console.error('[admin/notify-credentials]', error.message);
    res.status(500).json({ message: 'Unable to send the administrator notice.' });
  }
});

// ── One-time administrator credential hand-off ───────────────────────────
// A DIFFERENT SEND FROM THE ONE ABOVE, and the difference is the whole point.
//
// The notice above tells administrators their stored credentials changed. It
// carries no secret, and never will: AdminNames.md records that this project's
// real TOTP seeds were committed to a public repository, and the fix for that
// was to keep every recurring channel secret-free.
//
// This endpoint is the other, sanctioned path — `sendAdminCredentialsEmail` in
// utils/email.js, which exists precisely to deliver a password and an
// authenticator key once. It is a separate module (utils/adminCredentialHandoff.js)
// rather than an option on the notice, so nothing here can widen what the notice
// sends. See that module's header for the full reasoning.
//
// It does not rotate anything: the passwords are the ones the accounts already
// have, supplied by the operator because .env stores a one-way hash and the
// plaintext is not recoverable from it.

/**
 * A send is slow (one SMTP round trip per admin, deliberately not concurrent)
 * and — far more importantly — it puts live passwords in real inboxes. Unlike
 * the notice above, a duplicate here is not a confusing message: the same
 * credential landing twice is a second copy in a forwarding rule somewhere. So
 * this cooldown is longer, and it is separate from the notice's rather than
 * shared, so pressing one button does not lock the other out.
 */
const LAST_CREDENTIAL_HANDOFF_AT = { at: 0 };
const CREDENTIAL_HANDOFF_COOLDOWN_MS = 10 * 60_000;

/**
 * Accept the operator's password map and return only the aliases it carries.
 *
 * The VALUES are the point of this endpoint and must never be logged, echoed in
 * an error, or written to an audit row — so the only thing that leaves this
 * function is a count and a list of names. Anything that needs to say "that
 * alias had no password" asks this for the names, never the map.
 *
 * A password is not trimmed: leading and trailing spaces are characters the
 * administrator chose, and silently trimming one would mail them a password that
 * does not work. An all-whitespace password IS rejected, because that is a field
 * nobody filled in rather than a password somebody set.
 *
 * @returns {{ok: true, passwords: Record<string,string>}|{ok: false, message: string}}
 */
function readPasswordMap(body) {
  const raw = body.passwords;
  if (raw === undefined || raw === null) {
    return { ok: false, message: 'No passwords were supplied. .env stores a one-way hash, so the server cannot read them back — pass the password each administrator already has.' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: '`passwords` must be an object of alias → password.' };
  }

  const passwords = {};
  for (const [alias, value] of Object.entries(raw)) {
    const key = String(alias || '').trim();
    if (!key) continue;
    if (typeof value !== 'string' || !value.trim()) continue;   // unsupplied, not empty
    passwords[key] = value;
  }
  if (Object.keys(passwords).length === 0) {
    return { ok: false, message: 'No usable password was supplied. Every value was empty.' };
  }
  return { ok: true, passwords };
}

// @route   GET /api/admin/admins/credential-handoff/preview
// @desc    Who the hand-off would reach, and which of them are ready. The
//          operator has to type a password per administrator, so they need to
//          know which aliases exist and which have an authenticator key before
//          they start typing — and NOT before they can see that one alias has no
//          key in .env and would be silently skipped.
// @access  Private (Admin)
router.get('/admins/credential-handoff/preview', (req, res) => {
  try {
    const { configuredAdminEmails, configuredAdminAccounts } = require('../utils/adminAccounts');
    const { DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION } = require('../utils/email');

    const accounts = new Map(configuredAdminAccounts().map((account) => [account.alias, account]));
    const recipients = configuredAdminEmails();

    res.json({
      description: DEFAULT_CREDENTIAL_UPDATE_DESCRIPTION,
      // Alias + address only. Whether an alias HAS a key is a boolean here; the
      // key itself is never in a response, for the same reason the notice
      // preview does not include one.
      recipients: recipients.map(({ alias, email }) => ({
        alias,
        email,
        hasTotpSecret: Boolean(accounts.get(alias) && String(accounts.get(alias).totpSecret || '').trim()),
      })),
      missingEmail: require('../utils/adminAccounts').adminAccountsMissingEmail(),
      // Stated in the response so the UI can warn before the operator types six
      // passwords: this sends live secrets.
      carriesSecrets: true,
      rotatesCredentials: false,
      emailConfigured: Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD),
    });
  } catch (error) {
    console.error('[admin/credential-handoff/preview]', error.message);
    res.status(500).json({ message: 'Unable to read the administrator address list.' });
  }
});

// @route   POST /api/admin/admins/credential-handoff
// @desc    Email every configured administrator their alias, password and
//          authenticator key. Body: { passwords: { Alias: "..." } }.
// @access  Private (Admin)
router.post('/admins/credential-handoff', async (req, res) => {
  const { handoffAdminCredentials } = require('../utils/adminCredentialHandoff');

  const body = req.body || {};
  // Same reasoning as the notice above: the recipient list is server-side config,
  // so this endpoint must not be pointable at an arbitrary list. That would turn
  // an admin-only route into an open relay carrying live passwords.
  if (body.to !== undefined || body.recipients !== undefined) {
    return res.status(400).json({ message: 'Recipients are configured on the server, not per request.' });
  }

  const supplied = readPasswordMap(body);
  if (!supplied.ok) return res.status(400).json({ message: supplied.message });

  const description = String(body.description || '').trim().slice(0, 400);

  const elapsed = Date.now() - LAST_CREDENTIAL_HANDOFF_AT.at;
  if (elapsed < CREDENTIAL_HANDOFF_COOLDOWN_MS) {
    const retryAfter = Math.ceil((CREDENTIAL_HANDOFF_COOLDOWN_MS - elapsed) / 1000);
    return res.status(429).json({
      message: `Please wait ${Math.ceil(retryAfter / 60)} minute(s) before sending credentials again.`,
      retryAfterSeconds: retryAfter,
    });
  }

  try {
    const report = await handoffAdminCredentials({
      passwords: supplied.passwords,
      description,
      triggeredBy: (req.user && req.user.alias) || 'operator',
    });

    if (report.unconfigured) {
      return res.status(400).json({
        message: 'No administrator email addresses are configured. Add ADMIN_EMAILS to server/.env and restart the server.',
        ...report,
      });
    }

    // Consumed only once the send actually ran, so a rejected request does not
    // lock the operator out of a hand-off they never made.
    LAST_CREDENTIAL_HANDOFF_AT.at = Date.now();

    const by = (req.user && req.user.alias) || 'an administrator';
    // Aliases and counts only — never a password, a hash or a seed.
    await AdminEvent.create({
      type: 'security',
      title: 'Administrator credentials sent by email',
      detail: `${report.delivered.length} of ${report.recipients} delivered by ${by}.`
        + (report.missingPassword.length ? ` No password supplied for: ${report.missingPassword.join(', ')}.` : '')
        + (report.missingSecret.length ? ` No authenticator key for: ${report.missingSecret.join(', ')}.` : ''),
    }).catch(() => {});

    // 207: the batch ran and at least one address was rejected. A plain 200 here
    // would let the console paint "sent to everyone" over a list where someone
    // demonstrably has no password.
    const partial = report.failed.length > 0;
    res.status(partial ? 207 : 200).json({
      message: partial
        ? `Credentials sent to ${report.delivered.length} of ${report.recipients} administrator(s). ${report.failed.length} address(es) were rejected.`
        : `Credentials sent to ${report.delivered.length} administrator(s).`,
      ...report,
    });
  } catch (error) {
    console.error('[admin/credential-handoff]', error.message);
    res.status(500).json({ message: 'Unable to send the administrator credentials.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION CONTROL
//
// Every change goes through utils/subscriptionState.applyAction, which keeps TWO
// layers apart:
//   paid     — what the user bought. An admin override never destroys it.
//   override — the admin layer on top, with a frozen `restore` snapshot of the
//              paid state.
// "Restore original subscription state" puts that exact snapshot back,
// including the ORIGINAL expiry date, so restoring a subscription that had 4
// days left returns 4 days — not a fresh 30.
//
//   GET   /users/:id/subscription   full two-layer detail + audit history
//   POST  /users/:id/subscription   { action, ... }  (see ACTIONS below)
//   PATCH /users/:id/subscription   legacy { active, plan, expiresAt } shim
// ══════════════════════════════════════════════════════════════════════════

// Every field the subscription surface reads, so the detail endpoint and the
// user list can never disagree about what an account's subscription is.
const subscriptionFields = [
  'firstName', 'lastName', 'email',
  'subscriptionActive', 'subscriptionPlan', 'subscriptionStartedAt',
  'subscriptionExpiresAt', 'subscriptionPermanent', 'subscriptionSource',
  'subscriptionUpdatedAt', 'subscriptionRecord',
].join(' ');

/** Who is performing the change, for the audit trail. */
function adminActor(req) {
  // The admin middleware populates req.user (not req.admin) with the alias.
  const alias = req.user?.alias || req.admin?.alias;
  return `admin:${alias || 'unknown'}`.slice(0, 64);
}

/**
 * Apply ONE subscription action and persist it.
 *
 * Every mutation validates, writes the durable record AND the projected
 * top-level fields in ONE atomic update, then pushes the new authoritative state
 * over SSE so the user's open tab/phone changes instantly — no refresh, no
 * re-login, no polling.
 *
 * Returns a result envelope instead of writing to `res`, so callers that are
 * NOT a plain "admin pressed a button" HTTP handler can use the same engine
 * without fighting over the response. Approving a proof-of-payment request does
 * exactly that: it needs the outcome before it can mark the request approved
 * and tell the user.
 *
 * @returns {{ok: true, user: object, state: object, detail: object}
 *          |{ok: false, status: number, error: string}}
 */
async function applySubscriptionAction(req, { userId, action, options }) {
  const { describeSubscription, subState, PLAN_LABELS } = require('../utils/entitlements');
  const bus = require('../utils/subscriptionBus');
  const id = String(userId);

  if (!mongoose.isValidObjectId(id)) {
    return { ok: false, status: 400, error: 'A valid user is required.' };
  }
  if (!subState.ACTIONS.includes(action)) {
    return { ok: false, status: 400, error: `Unknown subscription action "${action}".` };
  }

  const before = await User.findById(id).select(subscriptionFields).lean();
  if (!before) return { ok: false, status: 404, error: 'User not found.' };

  const result = subState.applyAction(before.subscriptionRecord, action, {
    actor: adminActor(req),
    ...options,
  }, new Date());
  // A rejected action is a 400 with a message the admin panel can show, never a
  // 500 and never a silent no-op.
  if (!result.ok) {
    return { ok: false, status: result.status || 400, error: result.error };
  }

  const user = await User.findByIdAndUpdate(id, {
    $set: { subscriptionRecord: result.record, ...result.patch },
  }, { new: true }).select(safeUserProjection).lean();
  if (!user) return { ok: false, status: 404, error: 'User not found.' };

  const state = describeSubscription(user);
  const detail = subState.describeRecord(user);
  const delivered = bus.publish(id, state);
  const remaining = state.daysRemaining === null ? state.subscriptionDuration : `${state.daysRemaining}d`;
  console.log(
    `[admin/subscription] user ${id} action=${action} -> ${state.currentPlan} `
    + `(${state.subscriptionStatus}, ${remaining}, source=${state.subscriptionSource}); `
    + `pushed to ${delivered} session(s)`,
  );

  // Durable admin audit trail, independent of the per-user subscription log.
  const who = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
  AdminEvent.create({
    type: 'subscription',
    title: `Subscription ${action}`,
    detail: `${who} — ${PLAN_LABELS[state.currentPlan]} (${state.subscriptionDuration}), source ${state.subscriptionSource.toUpperCase()}.`,
  }).catch((auditError) => {
    // An audit row must never fail a change that already succeeded — but it must
    // never vanish silently either.
    console.error('[admin/subscription] audit event', auditError.message);
  });

  return { ok: true, user, state, detail };
}

/** HTTP wrapper around applySubscriptionAction for the direct admin panel routes. */
async function runSubscriptionAction(req, res, { action, options, successMessage }) {
  const applied = await applySubscriptionAction(req, {
    userId: req.params.id,
    action,
    options,
  });
  if (!applied.ok) {
    return res.status(applied.status).json({ message: applied.error, action });
  }
  return res.json({
    message: successMessage,
    action,
    user: applied.user,
    subscription: applied.state,
    detail: applied.detail,
  });
}

// @route   GET /api/admin/users/:id/subscription
// @desc    The exact subscription state: effective plan, remaining duration,
//          expiry date, the user's original paid state, any admin override,
//          what "restore original" returns to, and the full change log.
// @access  Private (Admin)
router.get('/users/:id/subscription', async (req, res) => {
  try {
    const { describeSubscription, subState } = require('../utils/entitlements');
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'A valid user is required.' });
    }
    const user = await User.findById(req.params.id).select(subscriptionFields).lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });
    return res.json({
      user: { _id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email },
      subscription: describeSubscription(user, Date.now(), { history: true }),
      detail: subState.describeRecord(user),
    });
  } catch (error) {
    console.error('[admin/subscription GET]', error.message);
    return res.status(500).json({ message: 'Unable to load the subscription.' });
  }
});

// @route   POST /api/admin/users/:id/subscription
// @desc    Perform one subscription action. Supported `action` values:
//            grant | remove | addDays | deductDays | extend | permanent |
//            changePlan | restore | clearOverride | setPaid
// @access  Private (Admin)
router.post('/users/:id/subscription', async (req, res) => {
  const body = req.body || {};
  const action = String(body.action || '').trim();
  const options = {};
  if (body.note !== undefined && body.note !== null) options.note = String(body.note).slice(0, 240);
  // Only forward keys the caller actually sent, so an absent field keeps the
  // engine's own default instead of arriving as an explicit undefined.
  for (const key of ['plan', 'days', 'permanent', 'expiresAt', 'scope', 'active', 'keepPlan']) {
    if (body[key] !== undefined) options[key] = body[key];
  }

  const messages = {
    grant: 'Subscription granted. The user now has access.',
    remove: 'Subscription removed.',
    addDays: 'Days added.',
    deductDays: 'Days removed.',
    extend: 'Expiration date updated.',
    permanent: 'Subscription made permanent — it will not expire.',
    changePlan: 'Subscription plan changed.',
    restore: 'Original paid subscription state restored.',
    clearOverride: 'Admin override removed — back to the original subscription.',
    setPaid: 'Paid subscription updated.',
  };

  try {
    return await runSubscriptionAction(req, res, {
      action,
      options,
      successMessage: messages[action] || 'Subscription updated.',
    });
  } catch (error) {
    console.error('[admin/subscription POST]', error.message);
    return res.status(500).json({ message: 'Unable to update the subscription.' });
  }
});

/**
 * @route   PATCH /api/admin/users/:id/subscription
 * @desc    Backwards-compatible shim for the original { active, plan, expiresAt }
 *          panel. Routed through the same engine so the two layers, the source
 *          badge and the audit log stay consistent whichever endpoint is used.
 * @access  Private (Admin)
 */
router.patch('/users/:id/subscription', async (req, res) => {
  const { active, plan, expiresAt } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ message: 'A valid user and subscription state are required.' });
  }
  if (expiresAt !== undefined && expiresAt !== null && !Number.isFinite(new Date(expiresAt).getTime())) {
    return res.status(400).json({ message: 'Invalid expiry date.' });
  }

  try {
    const { normalizePlanId, PLAN_ORDER, subState } = require('../utils/entitlements');
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'A valid user is required.' });
    }
    const before = await User.findById(req.params.id)
      .select('subscriptionActive subscriptionPlan subscriptionRecord')
      .lean();
    if (!before) return res.status(404).json({ message: 'User not found.' });
    // Explicit plan wins (aliases like "deluxe"/"premium" are normalized);
    // reactivating without a plan KEEPS the user's existing paid tier and never
    // escalates — the previous default silently granted ULTIMATE.
    const requestedPlan = plan !== undefined && plan !== null && plan !== '' ? normalizePlanId(plan) : null;
    if (plan !== undefined && plan !== null && plan !== '' && !requestedPlan) {
      return res.status(400).json({ message: 'Invalid subscription plan.' });
    }
    const retainedPlan = PLAN_ORDER.includes(before.subscriptionPlan) && before.subscriptionPlan !== 'free'
      ? before.subscriptionPlan
      : 'free';
    const nextPlan = requestedPlan || (active ? retainedPlan : 'free');

    const options = { plan: nextPlan, active, actor: 'admin:legacy-panel' };
    if (expiresAt !== undefined) options.expiresAt = expiresAt;

    // `active: true` with no explicit expiry keeps a future window and replaces a
    // stale/absent one, so a reactivation is genuinely active (the old rule).
    if (active && expiresAt === undefined) {
      const detail = subState.describeRecord(before);
      const live = detail.override.active ? detail.override : detail.paid;
      if (live.permanent) {
        options.permanent = true;
      } else if (live.expiresAt && new Date(live.expiresAt).getTime() > Date.now()) {
        options.expiresAt = live.expiresAt;
      } else {
        options.days = subState.STANDARD_PERIOD_DAYS;
      }
    }

    return await runSubscriptionAction(req, res, {
      action: 'setPaid',
      options,
      successMessage: active ? 'Subscription activated.' : 'Subscription removed.',
    });
  } catch (error) {
    console.error('[admin/subscription]', error.message);
    return res.status(500).json({ message: 'Unable to update the subscription.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION MANAGEMENT — the "Subscription management" tab
//
// The queue of plan requests users submitted from /pricing with a
// proof-of-payment image attached. It is the ONLY place a pending request
// becomes a real subscription, and it goes through exactly the same engine as
// every other admin subscription edit: `setPaid` writes the PAID layer, the
// projected fields are updated in the same atomic write, and the result is
// pushed over SSE so the user's open tab unlocks immediately.
//
//   GET  /subscription-requests          the queue (proof image excluded)
//   GET  /subscription-requests/:id      one request, including the proof
//   POST /subscription-requests/:id/approve  grant it
//   POST /subscription-requests/:id/reject   turn it down
//
// The proof image is fetched per-request, never in the list: a page of 50 rows
// would otherwise be tens of megabytes per poll.
// ══════════════════════════════════════════════════════════════════════════

/** User columns the queue needs next to each request. No profile pictures. */
const REQUEST_USER_FIELDS = 'firstName lastName email accountStatus lastLoginAt';

/**
 * Plan label for display. Delegates to the shared rule so the admin queue, the
 * member's own request list, the audit trail and the bell notification all
 * print the same words for the same request.
 */
function requestPlanLabel(request) {
  return require('../utils/subscriptionRequests').planLabelFor(request);
}

/** "Jane Doe (jane@example.com)" — or just the email if the name is empty. */
function requestUserLabel(user) {
  if (!user) return 'Unknown account';
  const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return name ? `${name} (${user.email})` : String(user.email || 'Unknown account');
}

/** Tell the member what happened to their request. Best-effort, never blocking. */
function notifyRequestOwner(request, user, approved, { planLabel, days, formattedAmount, note }) {
  const title = approved
    ? `${planLabel} is now active`
    : `${planLabel} request was declined`;
  const detail = approved
    ? `Your payment of ${formattedAmount} was confirmed and your ${planLabel} plan is active `
      + `for ${days} day${days === 1 ? '' : 's'}. Your features have unlocked — no need to sign in again.`
      + (note ? ` Note from the reviewer: ${note}` : '')
    : `We could not approve your ${planLabel} request.`
      + (note ? ` Reason given: ${note}` : ' Please check the payment receipt and try again, or contact support.');
  return UserNotification.create({ user, type: 'info', title, detail })
    .catch((notifyError) => console.error('[admin/subscription-request] user notice', notifyError.message));
}

// @route   GET /api/admin/subscription-requests
// @desc    The review queue. `status` narrows it (pending | approved | rejected |
//          all, default pending) and `search` matches the member's name or email.
//          Returns per-status counts so the tab's badges are correct without a
//          second round trip.
// @access  Private (Admin)
router.get('/subscription-requests', async (req, res) => {
  try {
    const { LIST_FIELDS, REQUEST_STATUSES, toSummary } = require('../utils/subscriptionRequests');
    const statusParam = String(req.query.status || 'pending').trim().toLowerCase();
    if (statusParam !== 'all' && !REQUEST_STATUSES.includes(statusParam)) {
      return res.status(400).json({ message: 'Unknown request status.' });
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const search = String(req.query.search || '').trim().slice(0, 80);

    const filter = statusParam === 'all' ? {} : { status: statusParam };

    // A text search is on the USER, not the request, so it needs a lookup first.
    // Bounded to 500 ids: a broad search over the whole member base must not turn
    // into an unbounded $in.
    if (search) {
      const rx = new RegExp(escapeRegExp(search), 'i');
      const matches = await User.find({
        $or: [{ firstName: rx }, { lastName: rx }, { email: rx }],
      }).select('_id').limit(500).lean();
      const ids = (matches || []).map((m) => m._id);
      // No member matched: answer with an empty page rather than every request.
      if (ids.length === 0) {
        return res.json({ requests: [], counts: await requestStatusCounts(), status: statusParam });
      }
      filter.user = { $in: ids };
    }

    const [rows, counts] = await Promise.all([
      SubscriptionRequest.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(LIST_FIELDS)
        .populate('user', REQUEST_USER_FIELDS)
        .lean(),
      requestStatusCounts(),
    ]);

    return res.json({
      requests: (rows || []).map((row) => ({
        ...toSummary(row),
        planLabel: requestPlanLabel(row),
        userLabel: requestUserLabel(row.user),
      })),
      counts,
      status: statusParam,
    });
  } catch (error) {
    console.error('[admin/subscription-requests GET]', error.message);
    return res.status(500).json({ message: 'Unable to load the subscription requests.' });
  }
});

/** Pending / approved / rejected tallies for the queue's filter badges. */
async function requestStatusCounts() {
  const grouped = await SubscriptionRequest.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const row of grouped || []) {
    if (Object.prototype.hasOwnProperty.call(counts, row._id)) counts[row._id] = row.count;
  }
  return counts;
}

/** Escape a user-typed string before it becomes a RegExp (no ReDoS, no injection). */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// @route   GET /api/admin/subscription-requests/:id
// @desc    One request WITH its proof image, so the reviewer can actually check
//          the receipt before approving. This is the only response that carries
//          the image.
// @access  Private (Admin)
router.get('/subscription-requests/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid request.' });
    }
    const row = await SubscriptionRequest.findById(req.params.id)
      .populate('user', REQUEST_USER_FIELDS)
      .lean();
    if (!row) return res.status(404).json({ message: 'Request not found.' });
    return res.json({
      request: { ...row, planLabel: requestPlanLabel(row), userLabel: requestUserLabel(row.user) },
    });
  } catch (error) {
    console.error('[admin/subscription-requests GET /:id]', error.message);
    return res.status(500).json({ message: 'Unable to load that request.' });
  }
});

// @route   POST /api/admin/subscription-requests/:id/approve
// @desc    Grant the requested purchase. Optional `{ days, note }` override the
//          term and the audit note; without `days` the requested months are
//          granted at the standard 30-day period.
//
//          Exactly-once: the request is CLAIMED with one atomic conditional
//          update before any entitlement is written, so two admins pressing
//          Approve at the same moment produce one grant, never two. If the grant
//          then fails the claim is released again.
// @access  Private (Admin)
router.post('/subscription-requests/:id/approve', async (req, res) => {
  const { STANDARD_PERIOD_DAYS } = require('../utils/subscriptionState');
  const { MAX_MONTHS, cleanText, MAX_NOTE_LENGTH } = require('../utils/subscriptionRequests');
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid request.' });
    }
    const body = req.body || {};
    const note = cleanText(body.note, MAX_NOTE_LENGTH);
    const alias = req.user?.alias || req.admin?.alias || 'unknown';

    const existing = await SubscriptionRequest.findById(req.params.id)
      .populate('user', REQUEST_USER_FIELDS)
      .lean();
    if (!existing) return res.status(404).json({ message: 'Request not found.' });
    if (existing.status !== 'pending') {
      return res.status(409).json({
        message: `This request was already ${existing.status} by ${existing.review?.by || 'an administrator'}.`,
        code: 'ALREADY_REVIEWED',
      });
    }
    // An account deleted after the request was sent (a row predating the user
    // cascade delete, or a delete that raced it) leaves `user` unpopulated.
    // Close it out here rather than letting it sit in "pending" forever,
    // inflating the queue's badge with work nobody can ever do.
    if (!existing.user?._id) {
      await SubscriptionRequest.findOneAndUpdate(
        { _id: existing._id, status: 'pending' },
        { $set: {
          status: 'rejected',
          review: { by: alias, at: new Date(), note: 'The account no longer exists.' },
        } },
      );
      return res.status(404).json({ message: 'That account no longer exists — the request was closed.' });
    }

    const planLabel = requestPlanLabel(existing);
    // `days` is honoured but bounded, so a typo (or a tampered panel) cannot
    // mint a decade of access from one approval.
    const requestedDays = Number(body.days);
    const days = Number.isFinite(requestedDays) && requestedDays > 0
      ? Math.min(3650, Math.max(1, Math.round(requestedDays)))
      : Math.max(1, Math.min(MAX_MONTHS, existing.months || 1)) * STANDARD_PERIOD_DAYS;

    const reviewNote = note
      || `Approved from payment request (${existing.formattedAmount || 'amount on file'}).`;

    // ── Claim (compare-and-swap) ──────────────────────────────────────────
    const claimed = await SubscriptionRequest.findOneAndUpdate(
      { _id: existing._id, status: 'pending' },
      { $set: {
        status: 'approved',
        grantedPlan: existing.plan,
        grantedDays: days,
        review: { by: alias, at: new Date(), note: reviewNote },
      } },
      { new: true },
    );
    // Lost the race: another admin got there first. Say so plainly — the panel
    // reloads, and the second press must not look like it granted nothing.
    if (!claimed) {
      return res.status(409).json({
        message: 'Another administrator reviewed this request a moment ago.',
        code: 'ALREADY_REVIEWED',
      });
    }

    const applied = await applySubscriptionAction(req, {
      userId: existing.user ? existing.user._id : null,
      action: 'setPaid',
      options: {
        plan: existing.plan,
        days,
        note: `Payment approved: ${reviewNote}`.slice(0, 240),
      },
    });

    if (!applied.ok) {
      // Release the claim so the request is reviewable again. A missing account
      // is the one case that is NOT retryable, so it is closed out as rejected
      // instead of sitting in the queue forever.
      if (applied.status === 404) {
        await SubscriptionRequest.updateOne(
          { _id: existing._id, status: 'approved' },
          { $set: {
            status: 'rejected',
            grantedPlan: null,
            grantedDays: null,
            review: { by: alias, at: new Date(), note: 'The account no longer exists.' },
          } },
        );
        return res.status(404).json({ message: 'That account no longer exists — the request was closed.' });
      }
      await SubscriptionRequest.updateOne(
        { _id: existing._id, status: 'approved' },
        { $set: { status: 'pending', grantedPlan: null, grantedDays: null, review: { by: '', at: null, note: '' } } },
      );
      return res.status(applied.status).json({ message: applied.error });
    }

    console.log(
      `[admin/subscription-request] approved ${existing._id} — ${planLabel} x${days}d `
      + `for user ${existing.user?._id} by ${alias}`,
    );

    notifyRequestOwner(claimed, existing.user?._id, true, {
      planLabel,
      days,
      formattedAmount: existing.formattedAmount,
      note,
    });

    return res.json({
      message: `${planLabel} activated for ${requestUserLabel(existing.user)}.`,
      request: { ...claimed.toObject(), planLabel, userLabel: requestUserLabel(existing.user) },
      subscription: applied.state,
    });
  } catch (error) {
    console.error('[admin/subscription-requests POST /:id/approve]', error.message);
    return res.status(500).json({ message: 'Unable to approve this request.' });
  }
});

// @route   POST /api/admin/subscription-requests/:id/reject
// @desc    Turn a request down. `{ note }` is shown to the member as the reason,
//          so "declined" is never a dead end. Nothing about the subscription
//          changes — a rejection cannot take access away.
// @access  Private (Admin)
router.post('/subscription-requests/:id/reject', async (req, res) => {
  const { cleanText, MAX_NOTE_LENGTH } = require('../utils/subscriptionRequests');
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid request.' });
    }
    const note = cleanText((req.body || {}).note, MAX_NOTE_LENGTH);
    const alias = req.user?.alias || req.admin?.alias || 'unknown';

    const rejected = await SubscriptionRequest.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: {
        status: 'rejected',
        review: { by: alias, at: new Date(), note },
      } },
      { new: true },
    ).populate('user', REQUEST_USER_FIELDS);
    if (!rejected) {
      const current = await SubscriptionRequest.findById(req.params.id).select('status').lean();
      if (!current) return res.status(404).json({ message: 'Request not found.' });
      return res.status(409).json({
        message: `This request was already ${current.status}.`,
        code: 'ALREADY_REVIEWED',
      });
    }

    console.log(`[admin/subscription-request] rejected ${rejected._id} by ${alias}`);

    notifyRequestOwner(rejected, rejected.user?._id, false, {
      planLabel: requestPlanLabel(rejected),
      days: null,
      formattedAmount: rejected.formattedAmount,
      note,
    });

    return res.json({
      message: 'Request declined and the member was notified.',
      request: { ...rejected.toObject(), planLabel: requestPlanLabel(rejected), userLabel: requestUserLabel(rejected.user) },
    });
  } catch (error) {
    console.error('[admin/subscription-requests POST /:id/reject]', error.message);
    return res.status(500).json({ message: 'Unable to decline this request.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION CANCELLATION REQUESTS — the mirror queue
//
// A member on a paid plan can ask to be returned to Free, either immediately
// (their own call, no admin) or by review. This is the review door: a row sits
// pending until an administrator approves it, and ONLY the approval runs the
// subscription engine — the same 'remove' the immediate path runs, so both
// doors end in the same state and neither can invent one the app cannot read.
//
//   GET  /subscription-cancel-requests         the queue
//   POST /subscription-cancel-requests/:id/approve  apply it
//   POST /subscription-cancel-requests/:id/reject   turn it down
//
// Approval is exactly-once by the same compare-and-swap claim the upgrade queue
// uses: the row is CLAIMED with one atomic conditional update before any
// entitlement is written, so two admins pressing Approve together produce one
// cancellation. If the engine then fails, the claim is released.
// ══════════════════════════════════════════════════════════════════════════

// @route   GET /api/admin/subscription-cancel-requests
// @desc    The cancellation queue. `status` narrows it (pending | applied |
//          rejected | all, default pending) and `search` matches the member's
//          name or email.
// @access  Private (Admin)
router.get('/subscription-cancel-requests', async (req, res) => {
  try {
    const cancelRules = require('../utils/subscriptionCancels');
    const statusParam = String(req.query.status || 'pending').trim().toLowerCase();
    if (statusParam !== 'all' && !cancelRules.CANCEL_STATUSES.includes(statusParam)) {
      return res.status(400).json({ message: 'Unknown cancellation status.' });
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const search = String(req.query.search || '').trim().slice(0, 80);

    const filter = statusParam === 'all' ? {} : { status: statusParam };

    // A text search is on the USER, not the request, so it needs a lookup first.
    // Bounded to 500 ids, exactly as the upgrade queue does.
    if (search) {
      const rx = new RegExp(escapeRegExp(search), 'i');
      const matches = await User.find({
        $or: [{ firstName: rx }, { lastName: rx }, { email: rx }],
      }).select('_id').limit(500).lean();
      const ids = (matches || []).map((m) => m._id);
      if (ids.length === 0) {
        return res.json({ requests: [], counts: await cancelStatusCounts(), status: statusParam });
      }
      filter.user = { $in: ids };
    }

    const [rows, counts] = await Promise.all([
      SubscriptionCancelRequest.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(cancelRules.LIST_FIELDS)
        .populate('user', REQUEST_USER_FIELDS)
        .lean(),
      cancelStatusCounts(),
    ]);

    return res.json({
      requests: (rows || []).map((row) => ({
        ...cancelRules.toSummary(row),
        // `user` is added HERE, not in toSummary, and that placement matters.
        //
        // cancelRules.toSummary is an explicit whitelist and it does NOT include
        // `user`; subscriptionRequests.toSummary spreads everything except the
        // proof image, so it does. The plan-request queue therefore received the
        // populated member and the cancellation queue did not — and the console
        // renders the member's name, email and initials from `row.user`. Every
        // cancellation row consequently read "Unknown account" with an em-dash
        // for the email, which makes a queue you are meant to review impossible
        // to review.
        //
        // Adding it to the shared serialiser would also change the MEMBER-facing
        // payloads in routes/subscription.js, which call the same function, so
        // the field is added on the admin projection where it is actually used.
        user: row.user || null,
        planLabel: cancelRules.planLabelFor(row),
        userLabel: requestUserLabel(row.user),
      })),
      counts,
      status: statusParam,
    });
  } catch (error) {
    console.error('[admin/subscription-cancel-requests GET]', error.message);
    return res.status(500).json({ message: 'Unable to load the cancellation requests.' });
  }
});

/** pending / applied / rejected tallies for the queue's filter badges. */
async function cancelStatusCounts() {
  const grouped = await SubscriptionCancelRequest.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const counts = { pending: 0, applied: 0, rejected: 0 };
  for (const row of grouped || []) {
    if (Object.prototype.hasOwnProperty.call(counts, row._id)) counts[row._id] = row.count;
  }
  return counts;
}

/** Tell the member their cancellation was applied or turned down. */
function notifyCancelOwner(userId, { planLabel, approved, note }) {
  const title = approved ? `${planLabel} cancelled` : `${planLabel} cancellation declined`;
  const detail = approved
    ? `Your ${planLabel} plan has ended and you are back on the Free plan. Your paid features are locked again.`
      + (note ? ` Note from the reviewer: ${note}` : '')
    : `We did not cancel your ${planLabel} plan, so nothing has changed and your access continues.`
      + (note ? ` Reason given: ${note}` : '');
  return UserNotification.create({ user: userId, type: 'info', title, detail })
    .catch((notifyError) => console.error('[admin/subscription-cancel] user notice', notifyError.message));
}

// @route   POST /api/admin/subscription-cancel-requests/:id/approve
// @desc    Apply the cancellation: run 'remove' (scope 'all') on the member's
//          subscription record and tell them. Claimed atomically first, so an
//          approval is exactly-once.
// @access  Private (Admin)
router.post('/subscription-cancel-requests/:id/approve', async (req, res) => {
  const cancelRules = require('../utils/subscriptionCancels');
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid request.' });
    }
    const note = cancelRules.cleanReason((req.body || {}).note);
    const alias = req.user?.alias || req.admin?.alias || 'unknown';

    const existing = await SubscriptionCancelRequest.findById(req.params.id)
      .populate('user', REQUEST_USER_FIELDS)
      .lean();
    if (!existing) return res.status(404).json({ message: 'Request not found.' });
    if (existing.status !== 'pending') {
      return res.status(409).json({
        message: `This request was already ${existing.status}.`,
        code: 'ALREADY_REVIEWED',
      });
    }
    // An account deleted after the request was sent leaves `user` unpopulated.
    // Close it out rather than letting it sit in "pending" forever.
    if (!existing.user?._id) {
      await SubscriptionCancelRequest.findOneAndUpdate(
        { _id: existing._id, status: 'pending' },
        { $set: {
          status: 'rejected',
          review: { by: alias, at: new Date(), note: 'The account no longer exists.' },
        } },
      );
      return res.status(404).json({ message: 'That account no longer exists — the request was closed.' });
    }

    const planLabel = cancelRules.planLabelFor(existing);
    const reviewNote = note || `Approved cancellation from the review queue (${planLabel}).`;

    // ── Claim (compare-and-swap) ──────────────────────────────────────────
    const claimed = await SubscriptionCancelRequest.findOneAndUpdate(
      { _id: existing._id, status: 'pending' },
      { $set: {
        status: 'applied',
        appliedPlan: 'free',
        appliedAt: new Date(),
        review: { by: alias, at: new Date(), note: reviewNote },
      } },
      { new: true },
    );
    if (!claimed) {
      return res.status(409).json({
        message: 'Another administrator reviewed this request a moment ago.',
        code: 'ALREADY_REVIEWED',
      });
    }

    // The SAME engine the immediate path runs, so both doors end identically.
    const applied = await applySubscriptionAction(req, {
      userId: existing.user._id,
      action: cancelRules.ENGINE_ACTION,
      options: {
        scope: 'all',
        note: `Cancellation approved: ${reviewNote}`.slice(0, 240),
      },
    });

    if (!applied.ok) {
      if (applied.status === 404) {
        await SubscriptionCancelRequest.updateOne(
          { _id: existing._id, status: 'applied' },
          { $set: {
            status: 'rejected',
            appliedPlan: null,
            appliedAt: null,
            review: { by: alias, at: new Date(), note: 'The account no longer exists.' },
          } },
        );
        return res.status(404).json({ message: 'That account no longer exists — the request was closed.' });
      }
      // Release the claim so it is reviewable again.
      await SubscriptionCancelRequest.updateOne(
        { _id: existing._id, status: 'applied' },
        { $set: { status: 'pending', appliedPlan: null, appliedAt: null, review: { by: '', at: null, note: '' } } },
      );
      return res.status(applied.status).json({ message: applied.error });
    }

    console.log(
      `[admin/subscription-cancel] approved ${existing._id} — ${planLabel} -> FREE `
      + `for user ${existing.user._id} by ${alias}`,
    );

    notifyCancelOwner(existing.user._id, { planLabel, approved: true, note });

    return res.json({
      message: `${planLabel} cancelled for ${requestUserLabel(existing.user)} — they are back on Free.`,
      request: {
        ...cancelRules.toSummary(claimed.toObject()),
        planLabel,
        userLabel: requestUserLabel(existing.user),
      },
      subscription: applied.state,
    });
  } catch (error) {
    console.error('[admin/subscription-cancel-requests POST /:id/approve]', error.message);
    return res.status(500).json({ message: 'Unable to approve this cancellation.' });
  }
});

// @route   POST /api/admin/subscription-cancel-requests/:id/reject
// @desc    Turn a cancellation down. `{ note }` is shown to the member as the
//          reason. Nothing about the subscription changes — a rejection can
//          never take access away.
// @access  Private (Admin)
router.post('/subscription-cancel-requests/:id/reject', async (req, res) => {
  const cancelRules = require('../utils/subscriptionCancels');
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid request.' });
    }
    const note = cancelRules.cleanReason((req.body || {}).note);
    const alias = req.user?.alias || req.admin?.alias || 'unknown';

    const rejected = await SubscriptionCancelRequest.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: {
        status: 'rejected',
        review: { by: alias, at: new Date(), note },
      } },
      { new: true },
    ).populate('user', REQUEST_USER_FIELDS);
    if (!rejected) {
      const current = await SubscriptionCancelRequest.findById(req.params.id).select('status').lean();
      if (!current) return res.status(404).json({ message: 'Request not found.' });
      return res.status(409).json({
        message: `This request was already ${current.status}.`,
        code: 'ALREADY_REVIEWED',
      });
    }

    const planLabel = cancelRules.planLabelFor(rejected);
    console.log(`[admin/subscription-cancel] rejected ${rejected._id} (${planLabel}) by ${alias}`);

    notifyCancelOwner(rejected.user?._id, { planLabel, approved: false, note });

    return res.json({
      message: 'Cancellation declined and the member was notified.',
      request: {
        ...cancelRules.toSummary(rejected.toObject()),
        planLabel,
        userLabel: requestUserLabel(rejected.user),
      },
    });
  } catch (error) {
    console.error('[admin/subscription-cancel-requests POST /:id/reject]', error.message);
    return res.status(500).json({ message: 'Unable to decline this cancellation.' });
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
  // The timer is cleared on every path — a probe that finishes in 40 ms must
  // not leave a 10 s timer behind holding the event loop open.
  const PROBE_TIMEOUT_MS = 10000;
  async function probe(key, label, category, fn) {
    const t0 = Date.now();
    let timer;
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Probe timed out after ${PROBE_TIMEOUT_MS / 1000} s.`)), PROBE_TIMEOUT_MS); }),
      ]);
      return { key, label, category, status: result.status, detail: result.detail, latencyMs: Date.now() - t0, checkedAt: at };
    } catch (err) {
      const timedOut = /timed out/.test(err.message || '');
      // `incomplete` marks a check that never produced a verdict. The cache
      // refuses to store these, so a single slow probe cannot be pinned in
      // front of the admin for a whole cache window.
      return { key, label, category, status: timedOut ? 'warning' : 'error', detail: err.message || 'Probe threw an unexpected error.', latencyMs: Date.now() - t0, checkedAt: at, incomplete: true };
    } finally {
      clearTimeout(timer);
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
    // Reports the same OpenRouter card as the AI panel (one provider, one
    // verdict) instead of re-implementing the probe with a different timeout,
    // a different 403 rule and a hard-coded model string. The two could
    // disagree — the panel saying "Reachable" while Security Center said
    // "Unreachable" — with no way for an admin to tell which was stale.
    probe('openrouter', 'OpenRouter API', 'openrouter', async () => {
      const result = await checkAiProvider(AI_PROVIDERS.find((entry) => entry.key === 'openrouter'));

      // checkAiProvider never throws, so this is a straight mapping of its
      // vocabulary onto the Security Center's healthy/warning/critical scale.
      if (result.status === 'unconfigured') {
        return { status: 'critical', detail: 'OPENROUTER_API_KEY is not configured — AI features are unavailable.' };
      }
      if (result.status === 'rejected') {
        return { status: 'critical', detail: 'OpenRouter API key is invalid or revoked (HTTP 401).' };
      }
      if (result.status === 'unreachable' || result.status === 'error') {
        return { status: 'warning', detail: result.detail };
      }
      return {
        status: 'healthy',
        detail: result.detail.replace(/^Reachable — /, 'OpenRouter reachable. '),
      };
    }),

    // ── 6. Groq (system detection & threat prediction) ────────────────────
    // The detection engine's provider, watched by the same rule as the default
    // AI above: it is probed with a real request through the one shared probe
    // function, so this row can never disagree with the AI panel's card. It is
    // a WARNING rather than a CRITICAL when down, because detection has a
    // rule-based fallback and keeps reporting without it — calling a degraded
    // but working panel "critical" would train an admin to ignore the word.
    probe('groq', 'Groq (Detection AI)', 'openrouter', async () => {
      const result = await checkAiProvider(AI_PROVIDERS.find((entry) => entry.key === 'groq'));

      if (result.status === 'unconfigured') {
        return { status: 'warning', detail: 'GROQ_API_KEY is not configured — system detection falls back to rule-based verdicts.' };
      }
      if (result.status === 'rejected') {
        return { status: 'warning', detail: 'Groq key is invalid or revoked; detection falls back to rule-based verdicts.' };
      }
      if (result.status === 'unreachable' || result.status === 'error') {
        return { status: 'warning', detail: result.detail };
      }
      return {
        status: 'healthy',
        detail: result.detail.replace(/^Reachable — /, 'Detection AI reachable. ')
          + ' Powers system detection & threat prediction.',
      };
    }),

    // ── 7. Anthropic (priority assessment flagging) ───────────────────────
    // Watched by the same rule as the other two AI providers, and for the same
    // reason: a WARNING, not a CRITICAL, when it is down. Priority flagging
    // degrades to the rule engine (utils/severity.js), which is the
    // authoritative floor and needs no provider at all — so the feature still
    // flags the textbook emergencies. Reporting that as "critical" would
    // train an admin to ignore a word that is supposed to mean "a person needs
    // to look at this now".
    probe('anthropic', 'Anthropic (Priority Flagging AI)', 'openrouter', async () => {
      const result = await checkAiProvider(AI_PROVIDERS.find((entry) => entry.key === 'anthropic'));

      if (result.status === 'unconfigured') {
        return { status: 'warning', detail: 'ANTHROPIC_API_KEY is not configured — priority flagging runs on the rule engine alone.' };
      }
      if (result.status === 'rejected') {
        return { status: 'warning', detail: 'Anthropic key is invalid or revoked; priority flagging runs on the rule engine alone.' };
      }
      if (result.status === 'unreachable' || result.status === 'error') {
        return { status: 'warning', detail: result.detail };
      }
      return {
        status: 'healthy',
        detail: result.detail.replace(/^Reachable — /, 'Priority-flagging AI reachable. ')
          + ' Provides a second opinion on assessments; it can escalate a Priority flag but never clear one.',
      };
    }),

    // ── 8. Delete Account ────────────────────────────────────────────────
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
      // Same parser the boot seeder uses. A bare split(',') here would read
      // `$argon2id$v=19$m=19456` as the hash and call the config sound while
      // the seeder could not actually load it.
      const { parseAdminAccounts } = require('../utils/adminAccounts');
      const adminHashOk = hashOk(process.env.ADMIN_PASSWORD_HASH || '') ||
        parseAdminAccounts(process.env.ADMIN_ACCOUNTS).some(account => hashOk(account.passwordHash));
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
      // The whole-chain re-hash is O(chain) and the chain only ever grows, so
      // it is scheduled rather than awaited: awaiting it here is exactly what
      // used to overrun the 10 s probe budget on a chain of any size and report
      // a chain that was in fact perfectly valid as a warning. `verify()` below
      // re-hashes only the blocks appended since the last proven-good block
      // (~150 ms) and falls back to the full audit whenever that shortcut is
      // not provably safe.
      ledger.audit().catch((err) => {
        console.error('[security/monitor] blockchain deep audit failed:', err.message);
      });
      const v = await ledger.verify();
      if (!v.valid) {
        return { status: 'critical', detail: `Chain integrity FAILED at block ${v.brokenAt} (${v.reason}) — anchored digests cannot be trusted until the chain is re-synced.` };
      }
      // $sum of the per-block tx array sizes rather than $unwind + $count: same
      // answer, a fraction of the server-side work on a large collection.
      const [txAgg] = await Block.aggregate([
        { $group: { _id: null, txs: { $sum: { $size: { $ifNull: ['$txs', []] } } } } },
      ]);
      // The deep re-hash had not finished inside its budget. That is the check
      // still running, not a chain problem — say so plainly instead of letting
      // it surface as a warning the admin has to interpret.
      if (v.pending) {
        return { status: 'healthy', detail: `Append-only chain live at height ${v.height} (${v.checked} block(s), ${txAgg ? txAgg.txs : 0} anchored tx(s)). A whole-chain re-hash is running in the background; every block appended after it completes is re-checked as it lands.` };
      }
      const auditNote = v.verifiedAt
        ? ` Whole-chain re-hash passed across all ${v.verifiedChecked} block(s) at ${new Date(v.verifiedAt).toLocaleTimeString()}; every block since then is re-checked as it is appended.`
        : ' A whole-chain re-hash is running in the background.';
      return { status: 'healthy', detail: `Append-only chain verified: height ${v.height}, difficulty ${v.difficulty}, ${v.checked} block(s) linked, ${txAgg ? txAgg.txs : 0} anchored tx(s). Hash-linkage + nonce re-audit passed.${auditNote} Personal data never touches the chain — only sha256 digests.` };
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
      const now = Date.now();
      const ages = feeds.map((f) => (now - (Number(f.updatedAt) || 0)) / 36e5);
      // Freshness is a property of the SLOWEST feed, not the fastest. Using the
      // newest timestamp let a single feed that stopped publishing forever hide
      // behind the five that were still current, so a genuinely dead feed could
      // never raise the alarm.
      const oldestH = Math.max(...ages);
      const newestH = Math.min(...ages);
      const stale = oldestH > 48;
      const lagging = feeds.filter((f, i) => ages[i] > 48);
      const human = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.round(h)} h`);
      return {
        status: stale ? 'warning' : 'healthy',
        detail: `${feeds.length} feed(s) live across pricing/research/market. Oldest value: ${human(oldestH)} ago, newest ${human(newestH)} ago — values re-derived deterministically each day (auditable) and anchored.${stale ? ` Feeds are stale (>48 h): ${lagging.map((f) => f.key).join(', ')}. The background sweeper re-publishes every 30 min; trigger a refresh from the Web3 hub if this persists.` : ''}`,
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
  // Never cache a run in which some probe failed to produce a verdict. Those
  // results describe the checker's patience, not the system, and freezing one
  // in front of the admin for a whole cache window turned a single slow probe
  // into a minute of stale, alarming rows.
  if (!results.some(r => r.incomplete)) {
    monitorCache = { at: Date.now(), payload };
  } else {
    monitorCache = { at: 0, payload: null };
  }
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

// ── AI providers ────────────────────────────────────────────────────────
// `GET` serves the dashboard's 10 s poll and reuses a cached check;
// `POST` is the panel's "Check now" and bypasses that cache so an admin who
// has just rotated a key sees the verdict immediately. Both are admin-only
// (router.use(protect, adminOnly)) and neither returns key material.
//
// `checkedAt` is the OLDEST probe in the batch, not the time this response was
// built: the four checks expire independently, and dating the whole panel from
// its freshest card would let a stale one masquerade as just-checked.
//
// `envStale` is true when the running process is still using .env values that
// the file no longer agrees with. dotenv reads the file once at boot, so a
// cached poll can be answering with the pre-edit key — the exact reason a
// freshly rotated key kept reporting "Key rejected (HTTP 401)" while being
// perfectly valid. "Check now" reloads and clears it.
//
// It is computed AFTER the reload, on purpose, and is no longer special-cased
// on `force`. The old `!force && isStaleSinceStart()` returned a hardcoded
// false for every "Check now", which is a claim the reload might not have been
// able to keep: a missing or unparseable server/.env re-probes with the same
// stale keys and used to still report a clean reload. Now a successful reload
// clears the flag because the values genuinely agree, and a failed one leaves
// it set.
//
// The 10 s POLL also reloads, and only when the file and this process actually
// disagree. It used to never reload, on the reasonable grounds that a half-typed
// .env read every 10 s would make the panel flap — but the consequence was that
// pasting a key into the file changed nothing until somebody pressed a button or
// restarted the server, so a newly configured provider simply had no card. The
// flap concern is handled by the card policy instead: a provider with no usable
// key renders NO card at all, and one with a half-typed key renders one card
// that is corrected on the very next poll. `isEnvStale()` compares values rather
// than timestamps, so this costs a reload only when a reload would change
// something.
const aiPayload = async (force) => {
  // The reload belongs to this function, not to getAiProviders, because this is
  // the only place whose answer depends on whether it worked. It reports which
  // variable NAMES it applied — names only, never values.
  const autoReload = !force && isEnvStale();
  const reload = (force || autoReload) ? reloadFromDisk() : null;
  // A reload that actually moved a key must also re-probe: the cached verdict is
  // up to AI_CHECK_TTL_MS old and would keep describing the pre-edit key, which
  // is exactly the stale-verdict failure `envStale` exists to warn about.
  const applied = Boolean(reload && reload.error === null
    && (reload.changed.length > 0 || reload.removed.length > 0));
  const providers = await getAiProviders({ force: force || applied, reload: false });

  // Detection reads the Security Center's own probe results, so it is offered
  // whatever the most recent monitor run produced rather than re-running 40
  // probes. On a first load there is no cached run yet: detection then falls
  // back to the rule-based verdict and says so, instead of firing a monitor
  // run from inside the AI panel and paying for both.
  const monitors = monitorCache && monitorCache.payload ? monitorCache.payload.monitors : [];
  const overallStatus = monitorCache && monitorCache.payload
    ? monitorCache.payload.overallMonitorStatus
    : 'unknown';
  const detection = await detectSystemThreats({ monitors, overallStatus, force });

  return {
    providers,
    checkedAt: oldestCheck(providers) || new Date().toISOString(),
    // A read that skipped the reload may be answering with values from before a
    // .env edit. Saying so beats showing a confident stale verdict.
    envStale: isEnvStale(),
    // What the priority-flagging provider ACTUALLY did on its last real call.
    // The card above cannot answer this: `/v1/models` is served to a valid key
    // with no credit, so an account that passes every health check can still be
    // one that never completes a triage. null until a submission is triaged.
    priorityFlagging: getLastOutcome(),
    // Which provider each purpose is actually dispatched to. The cards above
    // report whether a provider is up; this reports which one this server
    // would call, which is the other half of "is the AI working".
    routing: describeRouting(),
    detection,
    // The reload receipt. It rides on BOTH paths deliberately: on "Check now" it
    // confirms the key was picked up, and on the poll it confirms the automatic
    // detection above did the same thing — which is the feedback that makes a
    // newly pasted key landing as a card feel like a response rather than a
    // coincidence. `error` is reported so a file that could not be read says so
    // instead of leaving the admin to conclude from an unchanged verdict that
    // their key is broken.
    reload: reload && {
      ok: reload.error === null,
      changed: reload.changed,
      removed: reload.removed,
      error: reload.error,
    },
  };
};

router.get('/ai', async (req, res) => {
  try {
    res.json(await aiPayload(false));
  } catch (error) {
    console.error('[admin/ai]', error.message);
    res.status(500).json({ message: 'Unable to check AI providers.' });
  }
});

router.post('/ai/check', async (req, res) => {
  try {
    res.json(await aiPayload(true));
  } catch (error) {
    console.error('[admin/ai/check]', error.message);
    res.status(500).json({ message: 'Unable to check AI providers.' });
  }
});

// ── Admin pictures ──────────────────────────────────────────────────────────
// Reading a large field back from Atlas is the dominant cost of this console:
// measured ~10 ms per KB (a 128 KB payload 1.4 s, a 2.96 MB banner 30.0 s).
// Pictures only ever change inside PATCH /profile, so the bytes are read once
// and served from RAM until that handler invalidates them. Bounded so a
// growing admin roster cannot pin unbounded heap — evicting just means the
// next read warms it again.
const adminPicturesCache = new Map();
const ADMIN_PICTURES_CACHE_MAX = 8;

function cacheAdminPictures(adminId, payload) {
  const key = String(adminId);
  adminPicturesCache.delete(key);
  adminPicturesCache.set(key, payload);
  while (adminPicturesCache.size > ADMIN_PICTURES_CACHE_MAX) {
    adminPicturesCache.delete(adminPicturesCache.keys().next().value);
  }
}
// PATCH /profile is the ONLY writer of these two fields (verified across the
// server), and it writes through this same cache — so there is no other code
// path that can leave a stale entry behind.

// ── GET /profile ───────────────────────────────────────────────────────────
// This route is polled by the admin console every 10 s, so it must stay
// tiny. It previously returned the two base64 pictures inline — and measured
// against the live Atlas cluster, a read that carries a large field costs
// ~10 ms per KB (a 2.96 MB banner took 30.0 s, a 128 KB payload 1.4 s).
// Because the console awaits this inside Promise.all, that 30 s stalled the
// WHOLE dashboard refresh and let 10 s poll ticks stack up behind it.
//
// Pictures therefore move to GET /profile/pictures, fetched only when the
// `picturesUpdatedAt` stamp below changes (i.e. when an admin actually saves
// a new picture) instead of on every tick.
router.get('/profile', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.user._id)) return res.json({ alias: req.user.alias, createdAt: null, lastLoginAt: null, picturesUpdatedAt: null });
    const account = await AdminAccount.findById(req.user._id).select('alias createdAt lastLoginAt picturesUpdatedAt').lean();
    res.json({
      alias: account?.alias || req.user.alias,
      createdAt: account?.createdAt || null,
      lastLoginAt: account?.lastLoginAt || null,
      picturesUpdatedAt: account?.picturesUpdatedAt || null,
    });
  } catch (error) {
    console.error('[admin/profile]', error.message);
    res.status(500).json({ message: 'Unable to load the admin profile.' });
  }
});

// The heavy half of /profile. Called once when the console mounts and again
// only after `picturesUpdatedAt` changes, so the megabytes cross the wire once
// per edit rather than once per 10 s. Served from the cache above wherever
// possible, so the expensive Atlas read happens once per save, not once per
// admin session.
// An absent picture is a cosmetic gap; a 500 here used to take the whole admin
// console's refresh with it, and — because every mount re-read ~3 MB over a
// 5 s socket budget — it saturated the pool hard enough to time out sign-ins too.
//
// So the read is on its own slow-tolerant connection (utils/bigDocuments), and a
// failure degrades to "no picture" instead of an error. The console must load
// even when the cluster is slow.
router.get('/profile/pictures', async (req, res) => {
  const none = { profilePicture: '', bannerPicture: '', picturesUpdatedAt: null };
  try {
    if (!mongoose.isValidObjectId(req.user._id)) return res.json(none);
    const cached = adminPicturesCache.get(String(req.user._id));
    if (cached) return res.json(cached);
    const account = await readBigDocument(
      AdminAccount.collection.name,
      new mongoose.Types.ObjectId(String(req.user._id)),
      { profilePicture: 1, bannerPicture: 1, picturesUpdatedAt: 1 }
    );
    if (!account) return res.json(none);
    // safePictureValue drops any not-yet-migrated inline blob, so this response
    // stays a few hundred bytes instead of re-shipping the megabytes this
    // document used to hold.
    const payload = {
      profilePicture: safePictureValue(account.profilePicture),
      bannerPicture: safePictureValue(account.bannerPicture),
      picturesUpdatedAt: account.picturesUpdatedAt || null,
    };
    cacheAdminPictures(req.user._id, payload);
    res.json(payload);
  } catch (error) {
    console.error('[admin/profile/pictures]', error.message);
    res.json(none);
  }
});

// ── Edit profile: picture + background picture ──────────────────────────
// Same contract as the member-facing /profile update (image data URLs in, a
// stored value out) so the client mirrors ProfilePage: either key may be sent
// alone, an empty string clears it, and anything else is rejected before it
// reaches Mongo.
//
// The bytes themselves are written to disk and only the resulting URL is
// stored — see utils/pictures.js. This document used to carry the base64
// itself, which made it multi-megabyte and forced every read of it (the
// console's appearance fetch, among others) to pay a ~30 s Atlas transfer.
const MAX_ADMIN_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_ADMIN_BANNER_BYTES = 3 * 1024 * 1024; // 3 MB

router.patch('/profile', async (req, res) => {
  try {
    const { profilePicture, bannerPicture } = req.body || {};
    if (profilePicture === undefined && bannerPicture === undefined) {
      return res.status(400).json({ message: 'Nothing to update.' });
    }
    if (!mongoose.isValidObjectId(req.user._id)) return res.status(409).json({ message: 'Please sign in again before editing the admin profile.' });

    // Decodes a `data:` URL to disk and hands back the URL to store. Throws
    // with `.statusCode` for a payload we will not accept; those are client
    // errors, so they are reported as-is rather than as a blanket 500.
    const writePicture = (value, kind, maxBytes) => {
      try {
        return storePicture({ ownerId: req.user._id, kind, value, maxBytes });
      } catch (err) {
        const wrapped = new Error(err.message);
        wrapped.statusCode = err.statusCode || 400;
        throw wrapped;
      }
    };

    let nextAvatar;
    let nextBanner;
    if (profilePicture !== undefined) {
      nextAvatar = writePicture(profilePicture, 'admin-profile', MAX_ADMIN_AVATAR_BYTES);
    }
    if (bannerPicture !== undefined) {
      nextBanner = writePicture(bannerPicture, 'admin-banner', MAX_ADMIN_BANNER_BYTES);
    }

    // A targeted $set — NOT findById().save(). Hydrating this document reads
    // the very picture the admin is replacing, and a large field costs ~10 ms/KB
    // to pull back from Atlas (the 2.96 MB banner measured 30.0 s), so the old
    // code took 30 s to save. $set writes only the changed keys and the
    // projection below keeps the read to a few dozen bytes. Nothing here needs
    // the previous picture values: validation runs on the incoming strings and
    // the caller already knows which keys it sent.
    const set = {};
    if (profilePicture !== undefined) set.profilePicture = nextAvatar;
    if (bannerPicture !== undefined) set.bannerPicture = nextBanner;
    // Advance the picture version so the console re-fetches GET /profile/
    // pictures exactly once — on this save — rather than on every poll tick.
    set.picturesUpdatedAt = new Date();

    const account = await AdminAccount.findByIdAndUpdate(
      req.user._id,
      { $set: set },
      { new: true }
    ).select('alias picturesUpdatedAt').lean();
    if (!account) return res.status(404).json({ message: 'Admin account not found.' });

    // Write through, do not delete. We know precisely what we just stored, so
    // merging it onto the cached copy keeps the cache correct WITHOUT throwing
    // it away — deleting would make the next fetch re-read ~3 MB from Atlas at
    // the measured ~10 ms/KB (30 s) even though nothing else changed. There is
    // nothing to preserve when nothing is cached, so there is nothing to do.
    const cached = adminPicturesCache.get(String(req.user._id));
    if (cached) {
      cacheAdminPictures(req.user._id, {
        ...cached,
        ...(profilePicture !== undefined ? { profilePicture: nextAvatar } : {}),
        ...(bannerPicture !== undefined ? { bannerPicture: nextBanner } : {}),
        picturesUpdatedAt: account.picturesUpdatedAt,
      });
    }

    // Only the keys that were actually written are echoed back, so the read
    // above never has to touch the megabyte fields to answer.
    res.json({
      alias: account.alias,
      ...(profilePicture !== undefined ? { profilePicture: nextAvatar } : {}),
      ...(bannerPicture !== undefined ? { bannerPicture: nextBanner } : {}),
      picturesUpdatedAt: account.picturesUpdatedAt,
      message: 'Profile picture and background saved.',
    });
  } catch (error) {
    // A picture we refuse (wrong type, too large) is the caller's mistake, so
    // it is reported as such rather than masked as a server failure.
    if (error && error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error('[admin/profile/patch]', error.message);
    res.status(500).json({ message: 'Unable to save the admin profile.' });
  }
});

// Reports the flag and the exact policy, so the forced-change screen can render
// the real requirements instead of restating them from memory.
//
// It is in middleware/auth.js's allowlist for the same reason
// PATCH /profile/password is: an admin who must change their password still has
// to be able to discover WHAT the new password has to look like.
router.get('/session-status', async (req, res) => {
  try {
    const { describePasswordRules } = require('../utils/passwordRules');
    res.json({
      alias: req.user.alias,
      mustChangePassword: !!req.user.mustChangePassword,
      passwordRules: describePasswordRules(),
    });
  } catch (error) {
    console.error('[admin/session-status]', error.message);
    res.status(500).json({ message: 'Unable to read the session status.' });
  }
});

router.patch('/profile/password', async (req, res) => {
  try {
    const { currentPassword, newPassword, otp } = req.body || {};
    if (!currentPassword || !newPassword || !/^\d{6}$/.test(String(otp || ''))) return res.status(400).json({ message: 'Current password, new password, and authenticator code are required.' });

    // The one policy, from utils/passwordRules - the same module the user-facing
    // checklist and the password-reset flow validate against.
    //
    // This route used to carry its own hand-written copy ("at least 8 characters
    // with a capital letter and number"), which is precisely the drift
    // passwordRules.js exists to prevent: it accepted a length the server-wide
    // minimum rejects, required no symbol, and enforced no guessability check.
    // An admin account is the highest-privilege credential in the product, so it
    // should not have been the one place with the weakest rule.
    const { evaluatePassword } = require('../utils/passwordRules');
    const verdict = evaluatePassword(newPassword, { email: (req.user.alias || '') + '@suppliwise.local' });
    if (!verdict.ok) return res.status(400).json({ message: verdict.message, passwordChecks: verdict.checks });

    if (!mongoose.isValidObjectId(req.user._id)) return res.status(409).json({ message: 'Please sign in again before changing the admin password.' });
    const account = await AdminAccount.findById(req.user._id).select('+passwordHash +totpSecret');
    if (!account) return res.status(404).json({ message: 'Admin account not found.' });
    const { verifyPassword, hashPassword } = require('../utils/password');

    // Both credential failures below answer 400, NOT 401.
    //
    // 401 means "your session is not valid" everywhere else in this API, and the
    // client is entitled to treat it that way. But these two are ordinary user
    // errors - a mistyped password or a mistyped code - and returning 401 made
    // the change-password page throw away a working admin token and bounce the
    // user to the sign-in form to retype the password they had just entered
    // correctly, only to be sent straight back here. One typo became a loop with
    // no way out. `code` is included so a client that does distinguish has a
    // precise signal rather than having to read the message.
    if (!await verifyPassword(currentPassword, account.passwordHash)) {
      return res.status(400).json({ message: 'Current password is incorrect.', code: 'CURRENT_PASSWORD_INVALID' });
    }
    // "Choose a new password" that silently accepts the current one is a no-op
    // the operator believes they completed - and it is how a forced change gets
    // dismissed with the generated value still in place.
    if (newPassword === currentPassword) return res.status(400).json({ message: 'Choose a password different from your current one.' });
    if (await verifyPassword(newPassword, account.passwordHash)) return res.status(400).json({ message: 'Choose a password different from your current one.' });

    const verified = verifyTotpOnce(account.totpSecret, otp, account.alias);
    if (!verified) return res.status(400).json({ message: 'Invalid authenticator code.', code: 'OTP_INVALID' });

    account.passwordHash = await hashPassword(newPassword);
    account.passwordChangedAt = new Date();
    // Clearing the flag is what releases the middleware gate, so it must be
    // written in the SAME save as the hash. Two writes would leave a window
    // where the new password is live but the account is still locked out (or,
    // worse, unlocked while the old hash is still current).
    account.mustChangePassword = false;
    await account.save();

    // Update the hand-off copy in .env too. Without this the change only lived
    // in MongoDB, and index.js's boot seeder inserts any account whose document
    // is MISSING — so the moment the document was gone (wiped collection, fresh
    // clone, restored backup) the seeder recreated the account from .env, the
    // temporary password started working again, and mustChangePassword came
    // back false, so nothing prompted the owner to replace it. The temporary
    // password was never actually spent.
    //
    // Best-effort by design: a read-only .env must not fail a password change
    // that already succeeded in the database. The flag is cleared either way.
    const { persistAdminPasswordToEnv } = require('../utils/adminAccounts');
    const persisted = persistAdminPasswordToEnv(account.alias, account.passwordHash);
    if (!persisted.written) {
      console.warn('[admin/profile/password] .env not updated for ' + account.alias + ': ' + persisted.reason +
        ' — if this account is ever recreated from .env it will come back on the previous password.');
    }

    res.json({ message: 'Admin password changed successfully.', mustChangePassword: false });
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
    if (!/^\d{6}$/.test(String(otp || '')) || !verifyTotpOnce(account.totpSecret, otp, account.alias)) return res.status(401).json({ message: 'Invalid current authenticator code.' });
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
    // Live config warnings. These are recomputed on every read, never stored,
    // so they have no _id and can be neither marked read nor deleted — the
    // client keys off `dismissible` instead of guessing from a missing id.
    const security = securityChecks()
      .filter(check => check.status !== 'Secure')
      .map(check => ({
        type: 'security',
        title: check.label,
        detail: check.fix || '',
        createdAt: new Date(),
        read: false,
        dismissible: false,
      }));
    const adminId = String(req.user._id);
    const events = await AdminEvent.find().sort({ createdAt: -1 }).limit(30).lean();
    // Read state is per-admin (readBy), so it is resolved here for the caller
    // rather than shipped as a raw array for every client to interpret.
    const persisted = events.map(event => ({
      ...event,
      read: Array.isArray(event.readBy) && event.readBy.some(id => String(id) === adminId),
      dismissible: true,
    }));
    const unreadCount = [...security, ...persisted].filter(item => !item.read).length;
    res.json({ unreadCount, notifications: [...security, ...persisted] });
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

// @route   POST /api/admin/notifications/delete-read
// @desc    Clear the audit rows this admin has already read. Matches the
//          per-row DELETE semantics below (hard delete, shared by all admins).
// @access  Admin
router.post('/notifications/delete-read', async (req, res) => {
  try {
    const cleared = await AdminEvent.deleteMany({ readBy: req.user._id });
    res.json({
      message: 'Read notifications cleared.',
      deletedCount: cleared.deletedCount || 0,
    });
  } catch (error) {
    console.error('[admin/notifications/delete-read]', error.message);
    res.status(500).json({ message: 'Unable to clear read notifications.' });
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
