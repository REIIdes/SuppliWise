const express = require('express');
const { Pledge, DEFAULT_PARAMS } = require('../../models/Web3');
const User = require('../../models/User');
const engine = require('../../blockchain/engine');
const { dayKey, round2 } = require('../../blockchain/crypto');
const { sanitizePledge, maskName } = require('../../blockchain/rules');
const { requireFeature } = require('../../utils/entitlements');

const router = express.Router();

function userOnly(req, res, next) {
  if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
  next();
}
router.use(userOnly, requireFeature('web3'));

// The reward amount for a pledge. getConfig() backfills params added after the
// config row was written, so `pledgeReward` is normally present; the fallback
// only covers a config document whose key was explicitly removed. A value of 0
// is honoured — that is a live DAO-governed parameter, and silently minting the
// default instead would pay out against a governance decision.
async function pledgeRewardAmount() {
  const cfg = await engine.getConfig();
  const n = Number(cfg.params.pledgeReward);
  return Number.isFinite(n) && n >= 0 ? round2(n) : round2(DEFAULT_PARAMS.pledgeReward);
}

// Lazily re-anchor pledge rows that missed their chain tx at mint time
// (the ledger can be briefly busy or resyncing). Anchoring never re-pays the
// reward: the RewardEvent row was committed separately and is the ledger of
// what was paid.
//
// Deduplicated by _id across every list the caller holds: the wall and the
// member's own history contain the SAME document twice as two separate objects,
// so an un-deduped pass would write two blocks for one pledge.
async function reAnchorPending(...lists) {
  const byId = new Map();
  for (const rows of lists) {
    for (const p of rows) if (!p.txHash && !byId.has(String(p._id))) byId.set(String(p._id), p);
  }
  const unanchored = [...byId.values()];
  if (unanchored.length === 0) return;
  const chain = await engine.anchorMany(unanchored.map((p) => ({
    type: 'pledge:health',
    actor: p.address,
    data: { text: p.text, day: p.day, by: p.address },
  })));
  if (!chain.anchored) return; // ledger busy again — try next request
  await Promise.all(unanchored.map((p, i) => Pledge.updateOne(
    { _id: p._id },
    { $set: { txHash: chain.txs[i] || '', blockIndex: chain.index } },
  )));
  // The ids just repaired, so the caller can stamp them onto every list that
  // holds a copy. A response still showing "pending" for a pledge this very
  // request anchored would look like the repair had not happened.
  const healed = new Map(unanchored.map((p, i) => [String(p._id), { txHash: chain.txs[i] || '', blockIndex: chain.index }]));
  for (const rows of lists) {
    for (const p of rows) {
      const fix = healed.get(String(p._id));
      if (fix) Object.assign(p, fix);
    }
  }
}

function view(p, names) {
  return {
    id: String(p._id),
    text: p.text,
    day: p.day,
    reward: p.reward,
    txHash: p.txHash || '',
    blockIndex: p.blockIndex,
    at: p.createdAt,
    by: maskName(names.get(String(p.user)) || {}),
  };
}

async function hydrateNames(rows) {
  const ids = [...new Set(rows.map((p) => String(p.user)))];
  const users = await User.find({ _id: { $in: ids } }).select('firstName lastName').lean();
  return new Map(users.map((u) => [String(u._id), u]));
}

// @route   GET /api/web3/pledges
// @desc    The member's own pledges plus the public community wall. Names on
//          the wall are masked (first + last initial) — a pledge is public,
//          a full identity on it is not.
// @access  Private
router.get('/pledges', async (req, res) => {
  try {
    const [mine, wall] = await Promise.all([
      Pledge.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(30).lean(),
      Pledge.find({}).sort({ createdAt: -1 }).limit(60).lean(),
    ]);
    await reAnchorPending(mine, wall);
    const names = await hydrateNames([...mine, ...wall]);
    res.json({
      mine: mine.map((p) => view(p, names)),
      wall: wall.map((p) => view(p, names)),
      claimedToday: mine.some((p) => p.day === dayKey()),
    });
  } catch (error) {
    console.error('[web3 GET /pledges]', error.message);
    res.status(500).json({ message: 'Could not load pledges.' });
  }
});

// @route   POST /api/web3/pledges
// @desc    Mint a health pledge on-chain (+pledgeReward WELL, once per day).
// @access  Private
router.post('/pledges', async (req, res) => {
  try {
    const pledge = sanitizePledge(req.body.text);
    if (!pledge.ok) return res.status(400).json({ message: pledge.error });
    const wallet = await engine.getWalletDoc(req.user._id);
    const day = dayKey();
    const reward = await pledgeRewardAmount();

    // Row first, reward second, anchor last — each step's failure leaves a
    // recoverable state and none of them can double-pay:
    //  * (user, day) unique index makes "two pledges today" a 409, not two rows.
    //  * grantReward is idempotent on (user, 'pledge', day), so a crash between
    //    the two writes can be retried by the member without minting twice.
    //  * a failed anchor never fakes a receipt: txHash stays '' and
    //    reAnchorPending retries it on the next list read.
    let doc;
    try {
      doc = await Pledge.create({
        user: req.user._id, address: wallet.address, text: pledge.text, day, reward,
      });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ message: 'You already minted a pledge today. One commitment per day keeps them meaningful.' });
      }
      throw err;
    }

    const grant = await engine.grantReward({
      userId: req.user._id, kind: 'pledge', refId: day, amount: reward,
      public: { text: pledge.text },
    });
    if (!grant.alreadyClaimed && grant.txHash) {
      await Pledge.updateOne({ _id: doc._id }, { $set: { rewardTx: grant.txHash } });
      doc.rewardTx = grant.txHash;
    }

    const chain = await engine.anchor('pledge:health', wallet.address, {
      public: { text: pledge.text, day, by: wallet.address },
    });
    // THE ANCHOR CHECK. `engine.anchor` never throws; reading txs[0] without
    // testing `anchored` is the exact bug the ledger comments warn about.
    if (chain.anchored) {
      await Pledge.updateOne({ _id: doc._id }, { $set: { txHash: chain.txs[0] || '', blockIndex: chain.index } });
    }

    res.status(201).json({
      // The receipt fields come from THIS anchor result, not from `doc`, which
      // was written before the block existed. Reporting an empty hash beside a
      // real block index (or the reverse) is the mismatch that made health
      // records claim to be "anchored at block -1".
      pledge: view({ ...doc.toObject(), txHash: chain.anchored ? (chain.txs[0] || '') : '', blockIndex: chain.anchored ? chain.index : -1 },
        new Map([[String(req.user._id), req.user]])),
      reward: grant.alreadyClaimed ? 0 : reward,
      anchored: !!chain.anchored,
    });
  } catch (error) {
    if (error.code && typeof error.code === 'string') {
      return res.status(400).json({ message: error.message, code: error.code });
    }
    console.error('[web3 POST /pledges]', error.message);
    res.status(500).json({ message: 'Could not mint that pledge.' });
  }
});

module.exports = router;
