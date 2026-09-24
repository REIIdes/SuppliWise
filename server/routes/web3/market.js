const express = require('express');
const mongoose = require('mongoose');
const {
  Listing,
  Order,
  Dispute,
  LoyaltyCode,
  Wallet,
} = require('../../models/Web3');
const engine = require('../../blockchain/engine');
const { round2, sha256Hex } = require('../../blockchain/crypto');
const { escrowSplit, disputeOutcome } = require('../../blockchain/rules');

const router = express.Router();

function userOnly(req, res, next) {
  if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
  next();
}
router.use(userOnly);

// Settle an escrowed order: pay the seller (net of the DAO-set protocol fee)
// and route the fee to the treasury — exactly what the deployed smart
// contract would do on delivery confirmation.
async function releaseEscrow(order, reason) {
  // Atomic escrow→released claim: of N concurrent confirm/dispute triggers,
  // exactly one may move the funds — the rest get ALREADY_SETTLED (400).
  const claim = await Order.updateOne(
    { _id: order._id, status: 'escrow' },
    { $set: { status: 'released', settledAt: Date.now() } }
  );
  if (claim.modifiedCount !== 1) {
    throw new engine.EngineError('ALREADY_SETTLED', 'This order is already settled.');
  }
  order.status = 'released';
  const cfg = await engine.getConfig();
  const { fee, proceeds } = escrowSplit(order.total, cfg.params.marketplaceFeePct);
  let releaseTx = '';
  try {
    if (proceeds > 0) {
      const toSeller = await engine.transfer({
        from: 'sw_system_escrow',
        to: order.sellerAddress,
        amount: proceeds,
        type: 'escrow:release',
        public: { order: String(order._id), reason },
      });
      releaseTx = toSeller.txHash;
    }
    if (fee > 0) {
      await engine.transfer({
        from: 'sw_system_escrow',
        to: 'sw_system_treasury',
        amount: fee,
        type: 'escrow:fee',
        public: { order: String(order._id), feePct: cfg.params.marketplaceFeePct },
      });
    }
  } catch (err) {
    // Payment failed — release the claim so the order isn't stuck 'released'
    // without the seller being paid, then rethrow for a 4xx mapping.
    await Order.updateOne(
      { _id: order._id, status: 'released' },
      { $set: { status: 'escrow', settledAt: 0 } }
    ).catch(() => {});
    order.status = 'escrow';
    throw err;
  }
  order.fee = fee;
  order.settleTx = releaseTx || order.settleTx;
  order.settledAt = Date.now();
  await order.save();
  return { fee, proceeds, txHash: releaseTx };
}

// Refund an escrowed order back to the buyer (dispute resolved for buyer).
async function refundEscrow(order) {
  // Atomic escrow→refunded claim: exactly-once payout under any concurrency.
  const claim = await Order.updateOne(
    { _id: order._id, status: 'escrow' },
    { $set: { status: 'refunded', settledAt: Date.now() } }
  );
  if (claim.modifiedCount !== 1) {
    throw new engine.EngineError('ALREADY_SETTLED', 'This order is already settled.');
  }
  order.status = 'refunded';
  let txHash = '';
  try {
    if (order.total > 0) {
      const refund = await engine.transfer({
        from: 'sw_system_escrow',
        to: order.buyerAddress,
        amount: order.total,
        type: 'escrow:refund',
        public: { order: String(order._id) },
      });
      txHash = refund.txHash;
    }
  } catch (err) {
    await Order.updateOne(
      { _id: order._id, status: 'refunded' },
      { $set: { status: 'escrow', settledAt: 0 } }
    ).catch(() => {});
    order.status = 'escrow';
    throw err;
  }
  order.settleTx = txHash;
  order.settledAt = Date.now();
  await order.save();
  // Return stock so a refunded order doesn't permanently eat inventory.
  await Listing.updateOne({ _id: order.listing }, { $inc: { stock: order.qty } }).catch(() => {});
  return { amount: order.total, txHash };
}

// Pick jurors for a dispute: the STAKED non-party holders, up to 5. An empty
// panel means open jury (any non-party may vote until a clear verdict) —
// exactly what rules.js documents. Never pad with arbitrary unstaked wallets:
// an absent "juror" could deadlock escrow forever, sybil-adjacent wallets
// could be appointed without any stake at risk.
async function selectJurors(order, excludeAddresses) {
  const staked = await Wallet.find({
    isSystem: { $ne: true },
    address: { $nin: excludeAddresses },
    staked: { $gt: 0 },
  })
    .select('address')
    .limit(5)
    .lean();
  return staked.map((w) => w.address);
}

// Try to finalize a dispute: majority verdict once every juror voted (or a
// single clear verdict in an open jury). Payout happens exactly once, guarded
// by the status transition to 'resolved'.
async function tryResolve(dispute, order) {
  if (dispute.status !== 'open') return null;
  const verdict = disputeOutcome(dispute.votes, dispute.jurors);
  if (!verdict.complete) return null;
  const outcome = verdict.outcome || 'tie';

  // Atomic open→resolved claim: concurrent triggers (the vote POST plus lazy
  // dispute-list GETs) can never both execute the payout.
  const claim = await Dispute.updateOne(
    { _id: dispute._id, status: 'open' },
    { $set: { status: 'resolved', outcome, resolvedAt: Date.now() } }
  );
  if (claim.modifiedCount !== 1) return null;
  dispute.status = 'resolved';
  dispute.outcome = outcome;
  dispute.resolvedAt = Date.now();

  let txHash = '';
  try {
    if (outcome === 'buyer') {
      const refund = await refundEscrow(order);
      txHash = refund.txHash;
    } else if (outcome === 'seller') {
      const settle = await releaseEscrow(order, 'dispute→seller');
      txHash = settle.txHash || order.settleTx;
    }
  } catch (err) {
    // The dispute is already claimed resolved — a payout failure is logged
    // and retried via ops, never turned into a 500 or a second payout.
    console.error('[web3 dispute payout]', err.message);
  }

  // Jurors are paid for their work (feature 15), once per resolved dispute —
  // minted straight to the juror's wallet address.
  const cfg = await engine.getConfig();
  const jurorSet = dispute.jurors.length
    ? dispute.jurors
    : [...new Set(dispute.votes.map((v) => v.juror))];
  for (const juror of jurorSet) {
    try {
      // Recorded as a RewardEvent (kind 'juror') so the payout shows up in
      // the juror's on-chain reward history like every other mint.
      const jurorWallet = await Wallet.findOne({ address: juror }).lean();
      if (jurorWallet && jurorWallet.user) {
        await engine.grantReward({
          userId: jurorWallet.user,
          kind: 'juror',
          refId: String(dispute._id),
          amount: cfg.params.jurorReward,
          public: { dispute: String(dispute._id), outcome },
        });
      } else {
        // Defensive fallback: a juror without a linked account still gets paid.
        await engine.credit(juror, cfg.params.jurorReward, 'reward:juror', {
          public: { dispute: String(dispute._id), outcome },
          earned: true,
        });
      }
    } catch (err) {
      console.error('[web3 juror payout]', err.message);
    }
  }
  // Targeted update (not a full-doc save) so a concurrent juror vote pushed
  // meanwhile is never overwritten away.
  dispute.resolvedTx = txHash;
  await Dispute.updateOne({ _id: dispute._id }, { $set: { resolvedTx: txHash } }).catch(() => {});
  return outcome;
}

// ── Listings (feature 4: verified P2P marketplace) ────────────────────────
router.get('/market/listings', async (req, res) => {
  try {
    const mine = req.query.mine === '1';
    const query = mine ? { seller: { $ne: null } } : { active: true };
    if (mine) {
      const wallet = await engine.getWalletDoc(req.user._id);
      query.seller = wallet.address;
    }
    const listings = await Listing.find(query).sort({ createdAt: -1 }).limit(100).lean();
    const cfg = await engine.getConfig();
    const oracle = await require('../../models/Web3').OracleFeed.find({ category: { $in: ['pricing', 'market'] } })
      .sort({ key: 1 })
      .lean();
    res.json({ listings, feePct: cfg.params.marketplaceFeePct, oracleFeeds: oracle });
  } catch (error) {
    console.error('[web3 GET /market/listings]', error.message);
    res.status(500).json({ message: 'Could not load listings.' });
  }
});

router.post('/market/listings', async (req, res) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 120);
    const description = String(req.body.description || '').slice(0, 2000);
    const brand = String(req.body.brand || '').slice(0, 80);
    const category = String(req.body.category || 'Other');
    const priceWell = round2(Number(req.body.priceWell));
    const stock = parseInt(req.body.stock, 10);
    if (title.length < 4) return res.status(400).json({ message: 'Title must be at least 4 characters.' });
    if (!Number.isFinite(priceWell) || !(priceWell > 0)) {
      return res.status(400).json({ message: 'Price must be greater than zero.' });
    }
    if (!Number.isInteger(stock) || stock < 1 || stock > 100000) {
      return res.status(400).json({ message: 'Stock must be between 1 and 100000.' });
    }
    const allowed = ['Vitamins', 'Minerals', 'Herbs', 'Protein', 'Probiotics', 'Other'];
    if (!allowed.includes(category)) return res.status(400).json({ message: 'Unknown category.' });

    const wallet = await engine.getWalletDoc(req.user._id);
    const listing = await Listing.create({
      seller: wallet.address,
      sellerUser: req.user._id,
      title,
      description,
      brand,
      category,
      priceWell,
      stock,
    });
    const tx = await engine.anchor('market:list', wallet.address, {
      public: { listing: String(listing._id), title, priceWell },
    });
    res.status(201).json({ listing, txHash: tx.txs[0] });
  } catch (error) {
    console.error('[web3 POST /market/listings]', error.message);
    res.status(500).json({ message: 'Could not create the listing.' });
  }
});

// ── Orders with smart-contract escrow (feature 3) ─────────────────────────
// Return a claimed-but-unused loyalty code to the pool (only while it is still
// redeemed with no order attached — never after a successful redemption).
async function releaseLoyaltyClaim(id) {
  await LoyaltyCode.updateOne(
    { _id: id, status: 'redeemed', redeemedOrder: null },
    { $set: { status: 'unused', redeemedBy: null } }
  ).catch(() => {});
}

router.post('/market/orders', async (req, res) => {
  try {
    const listingId = String(req.body.listingId || '');
    // Strict numeric parse: parseInt used to silently truncate 1.5 → 1 (and
    // "1.5" too) — fractional/NaN quantities must be rejected outright.
    const qty = Number(req.body.qty);
    if (!mongoose.isValidObjectId(listingId)) return res.status(400).json({ message: 'Invalid listing.' });
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) return res.status(400).json({ message: 'Quantity must be 1–100.' });

    const listing = await Listing.findOne({ _id: listingId, active: true });
    if (!listing) return res.status(404).json({ message: 'Listing not found.' });
    if (listing.stock < qty) return res.status(400).json({ message: 'Not enough stock available.' });

    const wallet = await engine.getWalletDoc(req.user._id);
    if (listing.seller === wallet.address) {
      return res.status(400).json({ message: 'You cannot buy your own listing.' });
    }

    let total = round2(listing.priceWell * qty);
    let discount = 0;
    let discountCode = '';
    const providedCode = String(req.body.discountCode || '').trim();
    let loyaltyDoc = null;
    if (providedCode) {
      loyaltyDoc = await LoyaltyCode.findOne({ code: providedCode.toUpperCase(), owner: req.user._id, status: 'unused' });
      if (!loyaltyDoc) return res.status(400).json({ message: 'That loyalty code is invalid or already used.' });
      discount = Math.min(loyaltyDoc.valueWell, total);
      if (discount <= 0) return res.status(400).json({ message: 'Loyalty code has no value for this order.' });
      discountCode = loyaltyDoc.code;
      total = round2(total - discount);
      // Atomic claim (conditional unused→redeemed): two concurrent orders
      // carrying the same code can never both apply the discount.
      const claimed = await LoyaltyCode.updateOne(
        { _id: loyaltyDoc._id, status: 'unused' },
        { $set: { status: 'redeemed', redeemedBy: req.user._id } }
      );
      if (claimed.modifiedCount !== 1) {
        return res.status(400).json({ message: 'That loyalty code is invalid or already used.' });
      }
    }

    // Reserve stock atomically before moving any funds.
    const reserved = await Listing.updateOne(
      { _id: listing._id, stock: { $gte: qty } },
      { $inc: { stock: -qty } }
    );
    if (reserved.modifiedCount !== 1) {
      // Hand the claimed loyalty code back so a failed order never burns it.
      if (loyaltyDoc) await releaseLoyaltyClaim(loyaltyDoc._id);
      return res.status(400).json({ message: 'Not enough stock available.' });
    }

    let order;
    try {
      // Buyer → escrow wallet: funds are locked until delivery confirmation.
      // A fully-discounted order escrows zero (engine.transfer rejects 0).
      let escrowTxHash = '';
      if (total > 0) {
        const escrowTx = await engine.transfer({
          from: wallet.address,
          to: 'sw_system_escrow',
          amount: total,
          type: 'escrow:deposit',
          public: { listing: String(listing._id), qty },
        });
        escrowTxHash = escrowTx.txHash;
      }
      order = await Order.create({
        listing: listing._id,
        listingTitle: listing.title,
        buyer: req.user._id,
        buyerAddress: wallet.address,
        sellerAddress: listing.seller,
        sellerUser: listing.sellerUser || null,
        qty,
        unitPrice: listing.priceWell,
        total,
        discount,
        discountCode,
        escrowTx: escrowTxHash,
        status: 'escrow',
      });
      if (loyaltyDoc) {
        await LoyaltyCode.updateOne(
          { _id: loyaltyDoc._id, status: 'redeemed' },
          { $set: { redeemedOrder: order._id } }
        );
      }
    } catch (err) {
      // Roll the reservation (and the loyalty claim) back if the
      // payment/order step failed.
      await Listing.updateOne({ _id: listing._id }, { $inc: { stock: qty } }).catch(() => {});
      if (loyaltyDoc) await releaseLoyaltyClaim(loyaltyDoc._id);
      throw err;
    }

    res.status(201).json({ order, escrowTx: order.escrowTx });
  } catch (error) {
    if (error.code && typeof error.code === 'string') {
      return res.status(400).json({ message: error.message, code: error.code });
    }
    console.error('[web3 POST /market/orders]', error.message);
    res.status(500).json({ message: 'Could not place the order.' });
  }
});

router.get('/market/orders', async (req, res) => {
  try {
    const [bought, sold] = await Promise.all([
      Order.find({ buyer: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(),
      Order.find({ sellerUser: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);
    res.json({ bought, sold });
  } catch (error) {
    console.error('[web3 GET /market/orders]', error.message);
    res.status(500).json({ message: 'Could not load orders.' });
  }
});

// Delivery confirmation → execute the escrow contract (auto-release).
router.post('/market/orders/:id/confirm', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid order.' });
    const order = await Order.findOne({ _id: req.params.id, buyer: req.user._id });
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (order.status !== 'escrow') return res.status(400).json({ message: 'This order is already settled.' });
    // An open dispute freezes the escrow: releasing here would let the buyer
    // "confirm" away a contested order (and race the refund payout).
    if (await Dispute.exists({ order: order._id })) {
      return res.status(400).json({ message: 'A dispute is open for this order — confirm after it resolves.' });
    }
    const settled = await releaseEscrow(order, 'buyer-confirmed');
    res.json({ order, ...settled });
  } catch (error) {
    if (error.code && typeof error.code === 'string') {
      return res.status(400).json({ message: error.message, code: error.code });
    }
    console.error('[web3 POST /market/orders/:id/confirm]', error.message);
    res.status(500).json({ message: 'Could not confirm delivery.' });
  }
});

// ── Decentralized dispute resolution (feature 15) ─────────────────────────
router.post('/market/orders/:id/dispute', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid order.' });
    const order = await Order.findOne({ _id: req.params.id });
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    const isBuyer = String(order.buyer) === String(req.user._id);
    const isSeller = String(order.sellerUser || '') === String(req.user._id);
    if (!isBuyer && !isSeller) return res.status(403).json({ message: 'Only the order parties can open a dispute.' });
    if (order.status !== 'escrow') return res.status(400).json({ message: 'Only escrowed orders can be disputed.' });
    const existing = await Dispute.findOne({ order: order._id });
    if (existing) return res.status(400).json({ message: 'A dispute already exists for this order.' });

    const reason = String(req.body.reason || '').trim().slice(0, 1000);
    if (reason.length < 10) return res.status(400).json({ message: 'Describe the issue in at least 10 characters.' });

    const jurors = await selectJurors(order, [order.buyerAddress, order.sellerAddress]);
    const dispute = await Dispute.create({ order: order._id, opener: req.user._id, reason, jurors });

    const wallet = await engine.getWalletDoc(req.user._id);
    await engine.anchor('dispute:open', wallet.address, {
      public: { order: String(order._id), dispute: String(dispute._id), jurors: jurors.length },
    });
    res.status(201).json({ dispute });
  } catch (error) {
    // unique(order) race: two concurrent opens → the loser gets a clean 400.
    if (error && error.code === 11000) {
      return res.status(400).json({ message: 'A dispute already exists for this order.' });
    }
    console.error('[web3 POST /market/orders/:id/dispute]', error.message);
    res.status(500).json({ message: 'Could not open the dispute.' });
  }
});

router.get('/market/disputes', async (req, res) => {
  try {
    const wallet = await engine.getWalletDoc(req.user._id);
    const disputes = await Dispute.find({
      $or: [
        { opener: req.user._id },
        { jurors: wallet.address },
        { 'votes.juror': wallet.address },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const orderIds = disputes.map((d) => d.order);
    const orders = await Order.find({ _id: { $in: orderIds } }).lean();
    const orderMap = new Map(orders.map((o) => [String(o._id), o]));

    const enriched = [];
    for (const d of disputes) {
      const order = orderMap.get(String(d.order));
      if (!order) continue;
      // Attempts lazy finalization: if all votes are in, settle now.
      if (d.status === 'open') {
        const live = await Dispute.findById(d._id);
        const resolved = await tryResolve(live, order);
        if (resolved !== null) {
          const reloaded = await Dispute.findById(d._id).lean();
          enriched.push(shape(reloaded, order, wallet.address));
          continue;
        }
      }
      enriched.push(shape(d, order, wallet.address));
    }
    res.json({ disputes: enriched, jurorReward: (await engine.getConfig()).params.jurorReward });
  } catch (error) {
    console.error('[web3 GET /market/disputes]', error.message);
    res.status(500).json({ message: 'Could not load disputes.' });
  }
});

function shape(dispute, order, myAddress) {
  const isJuror = dispute.jurors.length
    ? dispute.jurors.includes(myAddress)
    : !dispute.votes.some((v) => v.juror === myAddress); // open jury: anyone unvoted
  const hasVoted = dispute.votes.some((v) => v.juror === myAddress);
  const verdict = disputeOutcome(dispute.votes, dispute.jurors);
  return {
    _id: dispute._id,
    order: {
      _id: order._id,
      listingTitle: order.listingTitle,
      qty: order.qty,
      total: order.total,
      status: order.status,
      createdAt: order.createdAt,
    },
    reason: dispute.reason,
    status: dispute.status,
    outcome: dispute.outcome,
    jurors: dispute.jurors,
    votes: dispute.votes,
    canVote: dispute.status === 'open' && isJuror && !hasVoted,
    hasVoted,
    progress: { cast: verdict.cast, needed: dispute.jurors.length || 1 },
    createdAt: dispute.createdAt,
    resolvedAt: dispute.resolvedAt,
  };
}

router.post('/market/disputes/:id/vote', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid dispute.' });
    const choice = String(req.body.choice || '');
    if (!['buyer', 'seller'].includes(choice)) return res.status(400).json({ message: 'Vote must be for buyer or seller.' });

    const wallet = await engine.getWalletDoc(req.user._id);
    const dispute = await Dispute.findById(req.params.id);
    if (!dispute) return res.status(404).json({ message: 'Dispute not found.' });
    if (dispute.status !== 'open') return res.status(400).json({ message: 'This dispute is already resolved.' });

    const order = await Order.findById(dispute.order);
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (wallet.address === order.buyerAddress || wallet.address === order.sellerAddress) {
      return res.status(403).json({ message: 'Order parties cannot vote on their own dispute.' });
    }
    const jurorEligible = dispute.jurors.length
      ? dispute.jurors.includes(wallet.address)
      : !dispute.votes.some((v) => v.juror === wallet.address);
    if (!jurorEligible) return res.status(403).json({ message: 'You are not a juror on this dispute.' });
    if (dispute.votes.some((v) => v.juror === wallet.address)) {
      return res.status(400).json({ message: 'You have already voted on this dispute.' });
    }

    const weight = round2((wallet.balance || 0) + (wallet.staked || 0));
    // Atomic push: concurrent juror votes APPEND instead of overwriting each
    // other, and the one-vote-per-juror rule is re-enforced in the filter.
    const pushed = await Dispute.updateOne(
      { _id: dispute._id, status: 'open', 'votes.juror': { $ne: wallet.address } },
      { $push: { votes: { juror: wallet.address, choice, weight, at: Date.now() } } }
    );
    if (pushed.modifiedCount !== 1) {
      const cur = await Dispute.findById(req.params.id).select('status votes').lean();
      if (!cur) return res.status(404).json({ message: 'Dispute not found.' });
      if (cur.status !== 'open') return res.status(400).json({ message: 'This dispute is already resolved.' });
      return res.status(400).json({ message: 'You have already voted on this dispute.' });
    }

    // Reload so resolution judges the full, current juror set.
    const live = await Dispute.findById(req.params.id);
    const outcome = await tryResolve(live, order);
    const fresh = await Dispute.findById(dispute._id).lean();
    const freshOrder = await Order.findById(dispute.order).lean();
    res.json({
      dispute: shape(fresh, freshOrder, wallet.address),
      resolved: outcome !== null,
      outcome: outcome || null,
      weight,
    });
  } catch (error) {
    console.error('[web3 POST /market/disputes/:id/vote]', error.message);
    res.status(500).json({ message: 'Could not cast the vote.' });
  }
});

module.exports = router;
