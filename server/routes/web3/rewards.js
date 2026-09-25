const express = require('express');
const crypto = require('crypto');
const {
  Nft,
  RewardEvent,
  LoyaltyCode,
} = require('../../models/Web3');
const Assessment = require('../../models/Assessment');
const IntakeRecord = require('../../models/IntakeRecord');
const DashboardMetrics = require('../../models/DashboardMetrics');
const engine = require('../../blockchain/engine');
const { dayKey, sha256Hex, round2 } = require('../../blockchain/crypto');
const {
  checkinStreak,
  checkinReward,
  stakingUnlocks,
  ACHIEVEMENTS,
  eligibleAchievements,
} = require('../../blockchain/rules');
const { requireFeature } = require('../../utils/entitlements');

const router = express.Router();
const DAY = 86400000;

function userOnly(req, res, next) {
  if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
  next();
}
// DELUXE plan gate for rewards, NFTs and staking.
router.use(userOnly, requireFeature('web3'));

// Stats snapshot that feeds both the reward dashboard and NFT eligibility.
async function collectStats(userId, wallet) {
  const { DataShare: Share, Proposal, Order, TrialConsent, Booking } = require('../../models/Web3');
  const today = dayKey();
  const checkinRows = await engine.checkinDays(userId);
  const [assessments, dataShares, daoVotes, ordersCompleted, trials, bookings, metrics] = await Promise.all([
    Assessment.countDocuments({ user: userId }),
    Share.countDocuments({ user: userId, status: 'active' }),
    Proposal.countDocuments({ 'votes.user': userId }),
    engineOrOrderCount(userId),
    TrialConsent.countDocuments({ user: userId, status: 'opted-in' }),
    Booking.countDocuments({ user: userId, status: 'confirmed' }),
    DashboardMetrics.findOne({ user: userId, isActive: true }).lean(),
  ]);
  const streak = checkinStreak(checkinRows.map((r) => r.day), today);
  return {
    userId,
    streak,
    checkinDays: checkinRows.length,
    assessments,
    dataShares,
    daoVotes,
    ordersCompleted,
    trials,
    bookings,
    staked: wallet ? wallet.staked : 0,
    balance: wallet ? wallet.balance : 0,
    earnedTotal: wallet ? wallet.earnedTotal : 0,
    trackedStreak: metrics ? metrics.currentStreak || 0 : 0,
    today,
    checkinRows,
  };
}

// Orders completed as either buyer or seller (release = contract executed).
async function engineOrOrderCount(userId) {
  const { Order } = require('../../models/Web3');
  return Order.countDocuments({
    $or: [{ buyer: userId }, { sellerUser: userId }],
    status: 'released',
  });
}

// @route   GET /api/web3/rewards/status
// @desc    Wallet + streak + claim availability + achievement progress —
//          everything the Rewards tab needs in one call.
// @access  Private
router.get('/rewards/status', async (req, res) => {
  try {
    const wallet = await engine.getWalletDoc(req.user._id);
    const accrued = await engine.accrueStake(wallet.address);
    const cfg = await engine.getConfig();
    const fresh = await require('../../models/Web3').Wallet.findOne({ _id: wallet._id }).lean();
    const stats = await collectStats(req.user._id, fresh);
    const owned = (await Nft.find({ owner: req.user._id }).select('kind').lean()).map((n) => n.kind);
    const nftCount = await Nft.countDocuments({ owner: req.user._id });
    const pendingAchievements = eligibleAchievements(stats, owned);

    const today = stats.today;
    const claimedToday = {
      checkin: stats.checkinRows.some((r) => r.day === today),
      intake: await RewardEvent.exists({ user: req.user._id, kind: 'intake', day: today }) != null,
    };
    const takenToday = await IntakeRecord.exists({ user: req.user._id, taken: true, dayKey: today }) != null;

    res.json({
      wallet: {
        did: fresh.did,
        address: fresh.address,
        balance: fresh.balance,
        staked: fresh.staked,
        earnedTotal: fresh.earnedTotal,
        spentTotal: fresh.spentTotal,
        welcomeBonusAt: fresh.welcomeBonusAt,
      },
      params: cfg.params,
      streak: stats.streak,
      trackedStreak: stats.trackedStreak,
      checkinCount: stats.checkinDays,
      claimedToday,
      intakeEligible: takenToday,
      accruedNow: accrued && accrued.amount ? accrued.amount : 0,
      nftCount,
      achievements: ACHIEVEMENTS.map((a) => ({
        ...a,
        owned: owned.includes(a.kind),
        progress: Math.min(1, round2((Number(stats[a.metric]) || 0) / a.min)),
        current: Number(stats[a.metric]) || 0,
      })),
      pendingAchievements: pendingAchievements.map((a) => a.kind),
      unlocks: stakingUnlocks(fresh.staked, cfg.params),
      nextCheckinAmount: checkinReward(cfg.params, stats.streak + (claimedToday.checkin ? 0 : 1)),
    });
  } catch (error) {
    console.error('[web3 GET /rewards/status]', error.message);
    res.status(500).json({ message: 'Could not load rewards status.' });
  }
});

// @route   POST /api/web3/rewards/checkin
// @desc    Daily healthy-habit check-in (feature 9). Streak-scaled reward,
//          idempotent per day via the unique (user, kind, refId) index.
// @access  Private
router.post('/rewards/checkin', async (req, res) => {
  try {
    const cfg = await engine.getConfig();
    const today = dayKey();
    const rows = await engine.checkinDays(req.user._id);
    const prospective = checkinStreak([...rows.map((r) => r.day), today], today);
    const amount = checkinReward(cfg.params, Math.max(prospective, 1));
    const result = await engine.grantReward({
      userId: req.user._id,
      kind: 'checkin',
      refId: today,
      amount,
      public: { streak: prospective },
    });
    res.json({
      claimed: !result.alreadyClaimed,
      alreadyClaimed: result.alreadyClaimed,
      amount: result.amount,
      streak: prospective,
      txHash: result.txHash,
      blockIndex: result.blockIndex,
    });
  } catch (error) {
    console.error('[web3 POST /rewards/checkin]', error.message);
    res.status(500).json({ message: 'Could not record today’s check-in.' });
  }
});

// @route   POST /api/web3/rewards/intake
// @desc    Reward for logging supplement intake today (validated against the
//          real intake tracker — cannot be claimed without a taken record).
// @access  Private
router.post('/rewards/intake', async (req, res) => {
  try {
    const today = dayKey();
    const taken = await IntakeRecord.exists({ user: req.user._id, taken: true, dayKey: today });
    if (!taken) return res.status(400).json({ message: 'Mark at least one supplement as taken today first.' });
    const cfg = await engine.getConfig();
    const result = await engine.grantReward({
      userId: req.user._id,
      kind: 'intake',
      refId: today,
      amount: cfg.params.rewardIntakeDay,
    });
    res.json({ claimed: !result.alreadyClaimed, alreadyClaimed: result.alreadyClaimed, amount: result.amount, txHash: result.txHash });
  } catch (error) {
    console.error('[web3 POST /rewards/intake]', error.message);
    res.status(500).json({ message: 'Could not record the intake reward.' });
  }
});

// @route   POST /api/web3/rewards/assessment
// @desc    Reward for a completed AI assessment (validated server-side).
// @access  Private
router.post('/rewards/assessment', async (req, res) => {
  try {
    const assessmentId = String(req.body.assessmentId || '');
    if (!require('mongoose').isValidObjectId(assessmentId)) {
      return res.status(400).json({ message: 'Invalid assessment.' });
    }
    const assessment = await Assessment.findOne({ _id: assessmentId, user: req.user._id }).lean();
    if (!assessment) return res.status(404).json({ message: 'Assessment not found.' });
    if (!assessment.aiResults) return res.status(400).json({ message: 'This assessment has no AI results yet.' });
    const cfg = await engine.getConfig();
    const result = await engine.grantReward({
      userId: req.user._id,
      kind: 'assessment',
      refId: assessmentId,
      amount: cfg.params.rewardAssessment,
    });
    res.json({ claimed: !result.alreadyClaimed, alreadyClaimed: result.alreadyClaimed, amount: result.amount, txHash: result.txHash });
  } catch (error) {
    console.error('[web3 POST /rewards/assessment]', error.message);
    res.status(500).json({ message: 'Could not record the assessment reward.' });
  }
});

// @route   GET /api/web3/rewards/events
// @desc    The caller's on-chain reward history.
// @access  Private
router.get('/rewards/events', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const events = await RewardEvent.find({ user: req.user._id }).sort({ at: -1 }).limit(limit).lean();
    const total = await RewardEvent.aggregate([
      { $match: { user: req.user._id } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    res.json({
      events,
      totalEarned: total[0] ? round2(total[0].total) : 0,
      totalCount: total[0] ? total[0].count : 0,
    });
  } catch (error) {
    console.error('[web3 GET /rewards/events]', error.message);
    res.status(500).json({ message: 'Could not load reward history.' });
  }
});

// @route   GET /api/web3/rewards/nfts
// @desc    Achievement NFT gallery (feature 10).
// @access  Private
router.get('/rewards/nfts', async (req, res) => {
  try {
    const nfts = await Nft.find({ owner: req.user._id }).sort({ mintedAt: -1 }).lean();
    const totalSupply = await Nft.countDocuments({ kind: { $in: nfts.map((n) => n.kind) } });
    res.json({ nfts, catalog: ACHIEVEMENTS, totalMintedForOwnedKinds: totalSupply });
  } catch (error) {
    console.error('[web3 GET /rewards/nfts]', error.message);
    res.status(500).json({ message: 'Could not load your achievements.' });
  }
});

// @route   POST /api/web3/rewards/achievements/check
// @desc    Mint every achievement NFT the caller has just become eligible for.
//          Eligibility is computed server-side from real activity — nothing
//          the client sends is trusted.
// @access  Private
router.post('/rewards/achievements/check', async (req, res) => {
  try {
    const wallet = await engine.getWalletDoc(req.user._id);
    const stats = await collectStats(req.user._id, wallet);
    const owned = (await Nft.find({ owner: req.user._id }).select('kind').lean()).map((n) => n.kind);
    const eligible = eligibleAchievements(stats, owned);
    const minted = [];
    for (const achievement of eligible) {
      try {
        const serial = (await Nft.countDocuments({ kind: achievement.kind })) + 1;
        const tokenId = `sw-${sha256Hex(`${achievement.kind}:${req.user._id}:${serial}`)}`;
        const tx = await engine.anchor('nft:mint', wallet.address, {
          public: { kind: achievement.kind, serial, to: wallet.address },
        });
        const nft = await Nft.create({
          owner: req.user._id,
          ownerAddress: wallet.address,
          tokenId,
          kind: achievement.kind,
          name: achievement.name,
          description: achievement.description,
          imageSeed: sha256Hex(tokenId).slice(0, 16),
          serial,
          txHash: tx.txs[0] || '',
        });
        minted.push(nft);
      } catch (err) {
        // Lost a mint race (E11000 on the (owner, kind) index) —
        // the NFT already exists. Skip instead of crashing the request.
        if (err && err.code === 11000) continue;
        throw err;
      }
    }
    res.json({ minted, count: minted.length });
  } catch (error) {
    console.error('[web3 POST /rewards/achievements/check]', error.message);
    res.status(500).json({ message: 'Could not check achievements.' });
  }
});

// ── Staking (feature 11) ───────────────────────────────────────────────────
router.post('/stake', async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const result = await engine.stake(req.user._id, amount);
    const cfg = await engine.getConfig();
    res.json({
      staked: result.wallet.staked,
      balance: result.wallet.balance,
      txHash: result.txHash,
      unlocks: stakingUnlocks(result.wallet.staked, cfg.params),
    });
  } catch (error) {
    if (error.code) return res.status(400).json({ message: error.message, code: error.code });
    console.error('[web3 POST /stake]', error.message);
    res.status(500).json({ message: 'Could not stake tokens.' });
  }
});

router.post('/unstake', async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const result = await engine.unstake(req.user._id, amount);
    const cfg = await engine.getConfig();
    res.json({
      staked: result.wallet.staked,
      balance: result.wallet.balance,
      txHash: result.txHash,
      unlocks: stakingUnlocks(result.wallet.staked, cfg.params),
    });
  } catch (error) {
    if (error.code) return res.status(400).json({ message: error.message, code: error.code });
    console.error('[web3 POST /unstake]', error.message);
    res.status(500).json({ message: 'Could not unstake tokens.' });
  }
});

// ── Loyalty program (feature 12) ───────────────────────────────────────────
// @route   GET /api/web3/loyalty
// @desc    Loyalty codes minted from burned WELL (transparent, on-chain
//          redemption history; codes redeem against marketplace orders).
// @access  Private
router.get('/loyalty', async (req, res) => {
  try {
    const [codes, redeemed] = await Promise.all([
      LoyaltyCode.find({ owner: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(),
      LoyaltyCode.aggregate([
        { $match: { owner: req.user._id } },
        { $group: { _id: null, burned: { $sum: '$valueWell' }, count: { $sum: 1 } } },
      ]),
    ]);
    res.json({
      codes,
      burned: redeemed[0] ? round2(redeemed[0].burned) : 0,
      issuedCount: redeemed[0] ? redeemed[0].count : 0,
    });
  } catch (error) {
    console.error('[web3 GET /loyalty]', error.message);
    res.status(500).json({ message: 'Could not load loyalty data.' });
  }
});

// @route   POST /api/web3/loyalty/redeem
// @desc    Convert WELL into a redeemable loyalty code: tokens leave the
//          circulating balance (sent to the treasury) and a one-time code is
//          issued — the transparent on-chain loyalty program.
// @access  Private
router.post('/loyalty/redeem', async (req, res) => {
  try {
    const cfg = await engine.getConfig();
    const amount = round2(Number(req.body.amount));
    const min = Number(cfg.params.loyaltyRedeemRate) || 10;
    if (!(amount >= min)) return res.status(400).json({ message: `Minimum redemption is ${min} WELL.` });
    const wallet = await engine.getWalletDoc(req.user._id);
    const tx = await engine.transfer({
      from: wallet.address,
      to: 'sw_system_treasury',
      amount,
      type: 'loyalty:burn',
      public: { reason: 'loyalty code issuance' },
    });
    const code = `LOY-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const doc = await LoyaltyCode.create({ code, owner: req.user._id, valueWell: amount });
    res.status(201).json({ code: doc, txHash: tx.txHash, balance: tx.fromBalance });
  } catch (error) {
    if (error.code) return res.status(400).json({ message: error.message, code: error.code });
    console.error('[web3 POST /loyalty/redeem]', error.message);
    res.status(500).json({ message: 'Could not create the loyalty code.' });
  }
});

module.exports = router;
