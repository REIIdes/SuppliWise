const {
  Wallet,
  Web3Config,
  DEFAULT_PARAMS,
  RewardEvent,
} = require('../models/Web3');
const ledger = require('./ledger');
const {
  generateIdentity,
  encrypt,
  decrypt,
  hashPayload,
  dayKey,
  round2,
} = require('./crypto');
const { computeStakeReward } = require('./rules');

// ═══════════════════════════════════════════════════════════════════════════
// State engine: the only place that mutates Web3 state.
//
// Contract with the ledger: mutate the database FIRST (it is the source of
// truth for balances/records), then ANCHOR the change on-chain for the
// tamper-evident audit trail. An anchor failure is logged, never able to
// roll back or fail the business operation — availability over perfect
// atomicity, with the DB remaining authoritative.
// ═══════════════════════════════════════════════════════════════════════════

const DAY_MS = 86400000;
const SYSTEM_WALLETS = [
  { address: 'sw_system_treasury', label: 'Protocol Treasury' },
  { address: 'sw_system_escrow', label: 'Smart-Contract Escrow' },
  { address: 'sw_system_brand', label: 'SuppliWise Verified Brands' },
  { address: 'sw_system_expert_pool', label: 'Verified Professionals Pool' },
];

// Operational error codes the routes map to 4xx responses.
class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

// ── Config (DAO-governed params, cached 30s) ───────────────────────────────
let configCache = { at: 0, doc: null };

async function getConfig() {
  if (configCache.doc && Date.now() - configCache.at < 30000) return configCache.doc;
  let doc = await Web3Config.findOne({ key: 'main' }).lean();
  if (!doc) {
    doc = await Web3Config.findOneAndUpdate(
      { key: 'main' },
      { $setOnInsert: { key: 'main', params: { ...DEFAULT_PARAMS }, updatedBy: 'genesis' } },
      { upsert: true, new: true }
    ).lean();
  }
  // Backfill any params added after the config row was first written.
  const missing = Object.keys(DEFAULT_PARAMS).filter((k) => doc.params?.[k] === undefined);
  if (missing.length) {
    const patch = {};
    missing.forEach((k) => { patch[`params.${k}`] = DEFAULT_PARAMS[k]; });
    doc = await Web3Config.findOneAndUpdate({ key: 'main' }, { $set: patch }, { new: true }).lean();
  }
  configCache = { at: Date.now(), doc };
  return doc;
}

// DAO parameter bounds, enforced at proposal creation AND at execution so an
// out-of-range value can never reach the config: numeric params must be finite
// and non-negative with a sane ceiling (1e9); voting windows are ≥ 1 day.
function assertParamValue(param, value) {
  if (typeof DEFAULT_PARAMS[param] !== 'number') return; // non-numeric params unconstrained (sliced at creation)
  if (!Number.isFinite(value)) throw new EngineError('BAD_PARAM', 'Parameter value must be a number.');
  if (value < 0) throw new EngineError('BAD_PARAM', 'Parameter value cannot be negative.');
  if (value > 1e9) throw new EngineError('BAD_PARAM', 'Parameter value is out of range.');
  if (param === 'daoVotingDays' && (value < 1 || value > 365)) throw new EngineError('BAD_PARAM', 'Voting window must be 1–365 days.');
}

async function setParam(param, value, actor) {
  // hasOwnProperty (not `in`): never resolve prototype-chain keys like
  // "toString"/"constructor"/"__proto__" as governance parameters.
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_PARAMS, param)) {
    throw new EngineError('BAD_PARAM', 'Unknown governance parameter.');
  }
  const parsed = typeof DEFAULT_PARAMS[param] === 'number' ? Number(value) : value;
  assertParamValue(param, parsed);
  const doc = await Web3Config.findOneAndUpdate(
    { key: 'main' },
    { $set: { [`params.${param}`]: parsed, updatedBy: String(actor), updatedAt: Date.now() } },
    { new: true }
  ).lean();
  configCache = { at: Date.now(), doc };
  return doc;
}

// ── Chain anchoring helper ─────────────────────────────────────────────────
// Never throws: anchoring is an audit enhancement, not the source of truth.
async function anchor(type, actor, { public: pub = null, secret = null }) {
  try {
    const dataHash = hashPayload(secret !== null ? secret : pub);
    return await ledger.append([{ type, actor, data: pub, dataHash }]);
  } catch (err) {
    console.error('[web3 anchor]', type, err.message);
    return { index: -1, hash: '', txs: [''] };
  }
}

// ── Wallets / decentralized identity (feature 5) ──────────────────────────
async function ensureSystemWallets() {
  for (const sys of SYSTEM_WALLETS) {
    await Wallet.findOneAndUpdate(
      { address: sys.address },
      {
        $setOnInsert: {
          did: `did:suppliwise:${sys.address}`,
          address: sys.address,
          label: sys.label,
          isSystem: true,
          balance: 0,
          staked: 0,
          earnedTotal: 0,
          spentTotal: 0,
          lastStakeAccrualAt: Date.now(),
        },
      },
      { upsert: true }
    );
  }
}

async function ensureWalletForUser(userId) {
  const existing = await Wallet.findOne({ user: userId });
  if (existing) return { wallet: existing, created: false };

  const identity = generateIdentity();
  let wallet;
  try {
    wallet = await Wallet.create({
      user: userId,
      did: `did:suppliwise:${userId}`,
      address: identity.address,
      publicKey: identity.publicKey,
      privateKeyEnc: encrypt(identity.privateKey, process.env.JWT_SECRET),
      balance: 0,
      staked: 0,
      earnedTotal: 0,
      spentTotal: 0,
      lastStakeAccrualAt: Date.now(),
    });
  } catch (err) {
    // Concurrent first-hit: unique(user) race — the winner's doc is the one
    // every caller should use.
    if (err && err.code === 11000) {
      const winner = await Wallet.findOne({ user: userId });
      if (winner) return { wallet: winner, created: false };
    }
    throw err;
  }

  // Welcome bonus (feature 9): one-time airdrop so the wallet is usable.
  // Recorded through grantReward so it shows up in reward history with its
  // on-chain tx like every other mint (idempotent per user via the unique
  // (user, kind, refId) index).
  const cfg = await getConfig();
  const bonus = Number(cfg.params.welcomeBonus) || 0;
  if (bonus > 0) {
    await grantReward({
      userId,
      kind: 'welcome_bonus',
      refId: '-',
      amount: bonus,
      public: { amount: bonus, reason: 'Wallet welcome bonus' },
    });
    wallet = await Wallet.findOne({ _id: wallet._id });
    await Wallet.updateOne({ _id: wallet._id }, { $set: { welcomeBonusAt: Date.now() } });
    wallet.welcomeBonusAt = Date.now();
  }
  return { wallet, created: true };
}

async function getWalletDoc(userId) {
  const { wallet } = await ensureWalletForUser(userId);
  return wallet;
}

async function walletView(wallet, userId) {
  const cfg = await getConfig();
  const accrued = await accrueStake(wallet.address);
  const fresh = await Wallet.findOne({ _id: wallet._id }).lean();
  return {
    did: fresh.did,
    address: fresh.address,
    publicKey: fresh.publicKey,
    label: fresh.label,
    balance: fresh.balance,
    staked: fresh.staked,
    earnedTotal: fresh.earnedTotal,
    spentTotal: fresh.spentTotal,
    welcomeBonusAt: fresh.welcomeBonusAt,
    accruedThisCall: accrued,
    params: cfg.params,
    createdAt: fresh.createdAt,
    _userId: userId,
  };
}

function decryptPrivateKey(wallet) {
  if (!wallet.privateKeyEnc) throw new EngineError('NO_KEY', 'No signing key on this wallet.');
  return decrypt(wallet.privateKeyEnc, process.env.JWT_SECRET);
}

// ── Token movements ────────────────────────────────────────────────────────
async function credit(address, amount, type, { public: pub = null, earned = false, actor = null } = {}) {
  const value = round2(amount);
  if (!Number.isFinite(value) || !(value > 0)) throw new EngineError('BAD_AMOUNT', 'Amount must be greater than zero.');
  const update = { $inc: { balance: value } };
  if (earned) update.$inc.earnedTotal = value;
  const doc = await Wallet.findOneAndUpdate({ address }, update, { new: true });
  if (!doc) throw new EngineError('NO_WALLET', 'Destination wallet not found.');
  const res = await anchor(type, actor || address, {
    public: { amount: value, to: address, ...(pub || {}) },
  });
  return { balance: doc.balance, txHash: res.txs[0], blockIndex: res.index };
}

async function debit(address, amount, type, { public: pub = null, spent = false, actor = null } = {}) {
  const value = round2(amount);
  if (!Number.isFinite(value) || !(value > 0)) throw new EngineError('BAD_AMOUNT', 'Amount must be greater than zero.');
  const update = { $inc: { balance: -value } };
  if (spent) update.$inc.spentTotal = value;
  const doc = await Wallet.findOneAndUpdate({ address, balance: { $gte: value } }, update, { new: true });
  if (!doc) throw new EngineError('INSUFFICIENT', 'Insufficient WELL balance for this action.');
  const res = await anchor(type, actor || address, {
    public: { amount: value, from: address, ...(pub || {}) },
  });
  return { balance: doc.balance, txHash: res.txs[0], blockIndex: res.index };
}

// Atomic two-sided transfer: debit is conditional on sufficient funds, credit
// is verified, and a failed credit rolls the debit back before rethrowing.
async function transfer({ from, to, amount, type, public: pub = null }) {
  const value = round2(amount);
  if (!Number.isFinite(value) || !(value > 0)) throw new EngineError('BAD_AMOUNT', 'Amount must be greater than zero.');
  if (from === to) throw new EngineError('SAME_WALLET', 'Cannot transfer to the same wallet.');

  const debited = await Wallet.findOneAndUpdate(
    { address: from, balance: { $gte: value } },
    { $inc: { balance: -value, spentTotal: value } },
    { new: true }
  );
  if (!debited) throw new EngineError('INSUFFICIENT', 'Insufficient WELL balance for this action.');

  const credited = await Wallet.findOneAndUpdate(
    { address: to },
    { $inc: { balance: value, earnedTotal: value } },
    { new: true }
  ).catch(() => null);
  if (!credited) {
    await Wallet.updateOne({ address: from }, { $inc: { balance: value, spentTotal: -value } });
    throw new EngineError('NO_WALLET', 'Destination wallet not found.');
  }

  const res = await anchor(type, from, {
    public: { amount: value, from, to, ...(pub || {}) },
  });
  return { amount: value, txHash: res.txs[0], blockIndex: res.index, fromBalance: debited.balance, toBalance: credited.balance };
}

// ── Staking (feature 11) ───────────────────────────────────────────────────
async function stake(userId, amount) {
  const value = round2(amount);
  if (!Number.isFinite(value) || !(value > 0)) throw new EngineError('BAD_AMOUNT', 'Amount must be greater than zero.');
  await accrueStakeForUser(userId);
  const wallet = await getWalletDoc(userId);
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id, balance: { $gte: value } },
    { $inc: { balance: -value, staked: value } },
    { new: true }
  );
  if (!updated) throw new EngineError('INSUFFICIENT', 'Insufficient free balance to stake.');
  const res = await anchor('stake', updated.address, { public: { amount: value, action: 'stake' } });
  return { wallet: updated, txHash: res.txs[0] };
}

async function unstake(userId, amount) {
  const value = round2(amount);
  if (!Number.isFinite(value) || !(value > 0)) throw new EngineError('BAD_AMOUNT', 'Amount must be greater than zero.');
  await accrueStakeForUser(userId);
  const wallet = await getWalletDoc(userId);
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id, staked: { $gte: value } },
    { $inc: { staked: -value, balance: value } },
    { new: true }
  );
  if (!updated) throw new EngineError('INSUFFICIENT', 'Insufficient staked balance to unstake.');
  const res = await anchor('unstake', updated.address, { public: { amount: value, action: 'unstake' } });
  return { wallet: updated, txHash: res.txs[0] };
}

// Time-based APY accrual. Conditional update on the exact last-accrual
// timestamp read, so a concurrent double-claim can never pay twice.
async function accrueStake(address) {
  try {
    const w = await Wallet.findOne({ address }).lean();
    if (!w || !(w.staked > 0) || !w.lastStakeAccrualAt) return 0;
    const elapsed = Date.now() - w.lastStakeAccrualAt;
    if (elapsed < DAY_MS) return 0;
    const cfg = await getConfig();
    const reward = computeStakeReward(w.staked, cfg.params.stakeApyPct, elapsed);
    const res = await Wallet.updateOne(
      { address, lastStakeAccrualAt: w.lastStakeAccrualAt, staked: { $gt: 0 } },
      { $set: { lastStakeAccrualAt: Date.now() }, $inc: { balance: reward, earnedTotal: reward } }
    );
    if (res.modifiedCount !== 1 || reward <= 0) return 0;
    const anch = await anchor('stake_reward', address, {
      public: { amount: reward, apyPct: cfg.params.stakeApyPct, days: round2(elapsed / DAY_MS) },
    });
    return reward ? { amount: reward, txHash: anch.txs[0] } : 0;
  } catch (err) {
    console.error('[web3 accrue]', err.message);
    return 0;
  }
}

async function accrueStakeForUser(userId) {
  const wallet = await Wallet.findOne({ user: userId }).lean();
  if (!wallet) return 0;
  return accrueStake(wallet.address);
}

// ── Rewards (features 7 & 9) ───────────────────────────────────────────────
// Idempotent by (user, kind, refId): the unique index rejects replays, so a
// double-click or retried request can never mint twice.
async function grantReward({ userId, kind, refId = '-', amount, public: pub = null }) {
  const value = round2(amount);
  if (!Number.isFinite(value) || !(value > 0)) return { alreadyClaimed: false, amount: 0, txHash: '' };
  const wallet = await getWalletDoc(userId);
  try {
    await RewardEvent.create({ user: userId, kind, refId, day: dayKey(), amount: value });
  } catch (err) {
    if (err && err.code === 11000) return { alreadyClaimed: true, amount: 0, txHash: '' };
    throw err;
  }
  const creditRes = await credit(wallet.address, value, `reward:${kind}`, {
    public: { amount: value, kind, ...(pub || {}) },
    earned: true,
    actor: wallet.address,
  });
  // Backfill the anchor tx onto the history row: the RewardEvent is created
  // before the credit exists (the unique index is what makes the claim
  // idempotent), so the tx reference is only known afterwards.
  await RewardEvent.updateOne(
    { user: userId, kind, refId },
    { $set: { txHash: creditRes.txHash || '' } }
  );
  return { alreadyClaimed: false, amount: value, txHash: creditRes.txHash, blockIndex: creditRes.blockIndex };
}

async function checkinDays(userId, limit = 400) {
  const rows = await RewardEvent.find({ user: userId, kind: 'checkin' })
    .sort({ day: -1 })
    .limit(limit)
    .lean();
  return rows;
}

module.exports = {
  EngineError,
  DAY_MS,
  SYSTEM_WALLETS,
  getConfig,
  assertParamValue,
  setParam,
  anchor,
  ensureSystemWallets,
  ensureWalletForUser,
  getWalletDoc,
  walletView,
  decryptPrivateKey,
  credit,
  debit,
  transfer,
  stake,
  unstake,
  accrueStake,
  accrueStakeForUser,
  grantReward,
  checkinDays,
};
