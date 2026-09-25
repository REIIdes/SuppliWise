const express = require('express');
const mongoose = require('mongoose');
const { Proposal, KnowledgePost, DEFAULT_PARAMS } = require('../../models/Web3');
const engine = require('../../blockchain/engine');
const ledger = require('../../blockchain/ledger');
const { round2 } = require('../../blockchain/crypto');
const { tallyProposal } = require('../../blockchain/rules');
const { requireFeature } = require('../../utils/entitlements');

const router = express.Router();
const DAY = 86400000;

function userOnly(req, res, next) {
  if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
  next();
}
// DELUXE plan gate for the DAO (proposals, voting, treasury, knowledge base).
router.use(userOnly, requireFeature('dao'));

// Finalize every expired proposal (lazy execution — no cron needed): tally,
// flip status, and if it passed, APPLY the parameter change on-chain. This is
// what makes the DAO real: passed proposals change how the platform pays,
// charges and quorums.
async function finalizeExpired() {
  const expired = await Proposal.find({ status: 'active', endsAt: { $lte: Date.now() } }).lean();
  if (!expired.length) return;
  const cfg = await engine.getConfig();
  for (const proposal of expired) {
    try {
      const tally = tallyProposal(proposal.votes, cfg.params);
      const status = tally.passed ? 'passed' : 'rejected';
      // Claim the finalization FIRST (atomic active→passed/rejected): two
      // concurrent lazy finalizers can never both execute + double-anchor the
      // same parameter change.
      const claim = await Proposal.updateOne(
        { _id: proposal._id, status: 'active' },
        { $set: { status } }
      );
      if (claim.modifiedCount !== 1) continue;
      if (tally.passed && proposal.param
          && Object.prototype.hasOwnProperty.call(DEFAULT_PARAMS, proposal.param)) {
        await engine.setParam(proposal.param, proposal.value, `dao:${proposal._id}`);
        const tx = await ledger.append([
          {
            type: 'dao:execute',
            actor: 'sw:dao',
            data: { proposal: String(proposal._id), param: proposal.param, value: proposal.value, tally },
          },
        ]);
        await Proposal.updateOne({ _id: proposal._id }, { $set: { executedTx: tx.txs[0] } });
      }
    } catch (err) {
      // A single bad proposal must never abort the sweep (or the GET that
      // triggered it) — log it and keep finalizing the rest.
      console.error('[web3 dao finalize]', String(proposal._id), err.message);
    }
  }
}

// ── DAO (feature 13) ──────────────────────────────────────────────────────
router.get('/dao/config', async (req, res) => {
  try {
    const cfg = await engine.getConfig();
    const wallet = await engine.getWalletDoc(req.user._id);
    res.json({
      params: cfg.params,
      updatable: Object.keys(DEFAULT_PARAMS),
      updatedBy: cfg.updatedBy,
      myWeight: round2(wallet.balance + wallet.staked),
      votingDays: cfg.params.daoVotingDays,
      quorum: cfg.params.daoQuorumWeight,
    });
  } catch (error) {
    console.error('[web3 GET /dao/config]', error.message);
    res.status(500).json({ message: 'Could not load governance config.' });
  }
});

router.get('/dao/proposals', async (req, res) => {
  try {
    await finalizeExpired();
    const cfg = await engine.getConfig();
    const proposals = await Proposal.find({}).sort({ createdAt: -1 }).limit(50).lean();
    const wallet = await engine.getWalletDoc(req.user._id);
    const shaped = proposals.map((p) => {
      const tally = tallyProposal(p.votes, cfg.params);
      const myVote = p.votes.find((v) => String(v.user) === String(req.user._id)) || null;
      return {
        _id: p._id,
        title: p.title,
        description: p.description,
        param: p.param,
        value: p.value,
        status: p.status,
        endsAt: p.endsAt,
        createdAt: p.createdAt,
        proposerAddress: p.proposerAddress,
        executedTx: p.executedTx,
        voterCount: tally.voterCount,
        tally,
        myVote: myVote ? { choice: myVote.choice, weight: myVote.weight } : null,
        canVote: p.status === 'active' && !myVote && (wallet.balance + wallet.staked) > 0,
        votes: p.votes.map((v) => ({ address: v.address, choice: v.choice, weight: v.weight, at: v.at })),
      };
    });
    res.json({ proposals: shaped, params: cfg.params, myWeight: round2(wallet.balance + wallet.staked) });
  } catch (error) {
    console.error('[web3 GET /dao/proposals]', error.message);
    res.status(500).json({ message: 'Could not load proposals.' });
  }
});

router.post('/dao/proposals', async (req, res) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 140);
    const description = String(req.body.description || '').slice(0, 4000);
    const param = String(req.body.param || '').trim();
    const valueRaw = req.body.value;
    if (title.length < 6) return res.status(400).json({ message: 'Title must be at least 6 characters.' });
    if (description.length < 10) return res.status(400).json({ message: 'Describe the proposal (min 10 characters).' });

    let value = null;
    if (param) {
      // hasOwnProperty (not `in`): prototype-chain keys like "toString" can
      // never masquerade as a governance parameter.
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_PARAMS, param)) {
        return res.status(400).json({ message: 'Unknown parameter.' });
      }
      if (typeof DEFAULT_PARAMS[param] === 'number') {
        if (valueRaw === null || valueRaw === undefined || valueRaw === '') {
          return res.status(400).json({ message: 'Parameter value must be a number.' });
        }
        value = Number(valueRaw);
        try {
          engine.assertParamValue(param, value);
        } catch (err) {
          return res.status(400).json({ message: err.message });
        }
      } else {
        value = String(valueRaw).slice(0, 200);
      }
    }

    const wallet = await engine.getWalletDoc(req.user._id);
    const weight = round2(wallet.balance + wallet.staked);
    if (weight <= 0) return res.status(400).json({ message: 'You need a wallet balance or stake to propose or vote.' });

    const cfg = await engine.getConfig();
    const proposal = await Proposal.create({
      title,
      description,
      param,
      value,
      proposer: req.user._id,
      proposerAddress: wallet.address,
      endsAt: Date.now() + (Number(cfg.params.daoVotingDays) || 3) * DAY,
      status: 'active',
    });
    const tx = await engine.anchor('dao:propose', wallet.address, {
      public: { proposal: String(proposal._id), title, param, value },
    });
    proposal.votes.push({ user: req.user._id, address: wallet.address, choice: 'for', weight, at: Date.now() });
    await proposal.save();

    const tally = tallyProposal(proposal.votes, cfg.params);
    res.status(201).json({ proposal: { _id: proposal._id, title, endsAt: proposal.endsAt, tally }, txHash: tx.txs[0] });
  } catch (error) {
    console.error('[web3 POST /dao/proposals]', error.message);
    res.status(500).json({ message: 'Could not create the proposal.' });
  }
});

router.post('/dao/proposals/:id/vote', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid proposal.' });
    const choice = String(req.body.choice || '');
    if (!['for', 'against'].includes(choice)) return res.status(400).json({ message: 'Vote must be for or against.' });

    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) return res.status(404).json({ message: 'Proposal not found.' });
    if (proposal.status !== 'active') return res.status(400).json({ message: 'Voting has ended on this proposal.' });
    // Lazy finalization may not have run yet — the deadline itself still ends
    // voting (a late vote would be tallied after the window closed).
    if (Number(proposal.endsAt) <= Date.now()) {
      return res.status(400).json({ message: 'Voting has ended on this proposal.' });
    }
    if (proposal.votes.some((v) => String(v.user) === String(req.user._id))) {
      return res.status(400).json({ message: 'You have already voted on this proposal.' });
    }

    const wallet = await engine.getWalletDoc(req.user._id);
    const weight = round2(wallet.balance + wallet.staked);
    if (weight <= 0) return res.status(400).json({ message: 'You need a wallet balance or stake to vote.' });

    // Atomic push: concurrent votes append instead of overwriting each other,
    // with the one-vote-per-user rule enforced in the filter itself.
    const pushed = await Proposal.updateOne(
      { _id: proposal._id, status: 'active', 'votes.user': { $ne: req.user._id } },
      { $push: { votes: { user: req.user._id, address: wallet.address, choice, weight, at: Date.now() } } }
    );
    if (pushed.modifiedCount !== 1) {
      const cur = await Proposal.findById(req.params.id).select('status votes endsAt').lean();
      if (!cur) return res.status(404).json({ message: 'Proposal not found.' });
      if (cur.status !== 'active' || Number(cur.endsAt) <= Date.now()) {
        return res.status(400).json({ message: 'Voting has ended on this proposal.' });
      }
      return res.status(400).json({ message: 'You have already voted on this proposal.' });
    }
    const tx = await engine.anchor('dao:vote', wallet.address, {
      public: { proposal: String(proposal._id), choice, weight },
    });

    // Re-tally from the stored (complete) vote set, not the stale in-memory doc.
    const fresh = await Proposal.findById(req.params.id).lean();
    const cfg = await engine.getConfig();
    res.json({ tally: tallyProposal(fresh.votes, cfg.params), txHash: tx.txs[0], weight });
  } catch (error) {
    console.error('[web3 POST /dao/proposals/:id/vote]', error.message);
    res.status(500).json({ message: 'Could not cast the vote.' });
  }
});

// ── Community knowledge base (feature 14) ─────────────────────────────────
router.get('/knowledge', async (req, res) => {
  try {
    const posts = await KnowledgePost.find({}).sort({ createdAt: -1 }).limit(100).lean();
    const mine = new Set(
      (await KnowledgePost.find({ author: req.user._id }).select('_id').lean()).map((p) => String(p._id))
    );
    const cfg = await engine.getConfig();
    res.json({
      posts: posts.map((p) => ({
        ...p,
        mine: mine.has(String(p._id)),
        iUpvoted: (p.upvoters || []).some((u) => String(u) === String(req.user._id)),
        canUpvote: !mine.has(String(p._id)) && !(p.upvoters || []).some((u) => String(u) === String(req.user._id)),
      })),
      rewards: {
        post: cfg.params.knowledgeReward,
        upvote: cfg.params.knowledgeUpvoteReward,
        curator: cfg.params.curatorReward,
      },
    });
  } catch (error) {
    console.error('[web3 GET /knowledge]', error.message);
    res.status(500).json({ message: 'Could not load the knowledge base.' });
  }
});

router.post('/knowledge', async (req, res) => {
  try {
    const type = String(req.body.type || 'review');
    if (!['review', 'research', 'story'].includes(type)) return res.status(400).json({ message: 'Unknown post type.' });
    const title = String(req.body.title || '').trim().slice(0, 140);
    const body = String(req.body.body || '').trim().slice(0, 4000);
    if (title.length < 6) return res.status(400).json({ message: 'Title must be at least 6 characters.' });
    if (body.length < 20) return res.status(400).json({ message: 'Share a bit more detail (min 20 characters).' });

    const wallet = await engine.getWalletDoc(req.user._id);
    const post = await KnowledgePost.create({
      author: req.user._id,
      authorAddress: wallet.address,
      type,
      title,
      body,
    });
    const cfg = await engine.getConfig();
    const reward = await engine.grantReward({
      userId: req.user._id,
      kind: 'knowledge',
      refId: String(post._id),
      amount: cfg.params.knowledgeReward,
      public: { post: String(post._id), type },
    });
    const tx = await engine.anchor('knowledge:post', wallet.address, {
      public: { post: String(post._id), title, type },
    });
    post.txHash = tx.txs[0] || '';
    post.rewardPaid = reward.amount;
    await post.save();
    res.status(201).json({ post, reward: reward.amount });
  } catch (error) {
    console.error('[web3 POST /knowledge]', error.message);
    res.status(500).json({ message: 'Could not publish the post.' });
  }
});

router.post('/knowledge/:id/upvote', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid post.' });
    const post = await KnowledgePost.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found.' });
    if (String(post.author) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot upvote your own post.' });
    }
    if ((post.upvoters || []).some((u) => String(u) === String(req.user._id))) {
      return res.status(400).json({ message: 'You already upvoted this post.' });
    }
    const cfg = await engine.getConfig();
    // Atomic push + increment: concurrent upvotes append instead of clobbering
    // each other (lost updates used to leave 1 of 4 votes behind).
    const pushed = await KnowledgePost.updateOne(
      { _id: post._id, upvoters: { $ne: req.user._id } },
      { $push: { upvoters: req.user._id }, $inc: { upvotes: 1 } }
    );
    if (pushed.modifiedCount !== 1) {
      return res.status(400).json({ message: 'You already upvoted this post.' });
    }
    const fresh = await KnowledgePost.findById(post._id).lean();
    const upvotesNow = fresh.upvotes || 0;

    // Author is paid per upvote up to a cap; the upvoter (curator) is paid
    // for surfacing useful content.
    const paidToAuthor = await require('../../models/Web3').RewardEvent.aggregate([
      { $match: { user: fresh.author, kind: 'knowledge-upvote' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const alreadyPaid = paidToAuthor[0] ? paidToAuthor[0].total : 0;
    const cap = Number(cfg.params.knowledgeUpvoteCap) || 0;
    let authorPayout = 0;
    if (alreadyPaid < cap) {
      const grant = await engine.grantReward({
        userId: fresh.author,
        kind: 'knowledge-upvote',
        refId: `${String(post._id)}:${upvotesNow}`,
        amount: Math.min(cfg.params.knowledgeUpvoteReward, cap - alreadyPaid),
        public: { post: String(post._id), upvotes: upvotesNow },
      });
      authorPayout = grant.amount;
    }
    const curator = await engine.grantReward({
      userId: req.user._id,
      kind: 'curator',
      refId: String(post._id),
      amount: cfg.params.curatorReward,
      public: { post: String(post._id) },
    });
    res.json({ upvotes: upvotesNow, authorPayout, curatorPayout: curator.amount });
  } catch (error) {
    console.error('[web3 POST /knowledge/:id/upvote]', error.message);
    res.status(500).json({ message: 'Could not upvote the post.' });
  }
});

module.exports = router;
