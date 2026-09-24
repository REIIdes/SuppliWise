const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════════════════════════
// SuppliWise Web3 layer — data models
//
// The application database remains the source of truth for balances and
// business records. Every state change is additionally ANCHORED to an
// append-only proof-of-work chain (Block/tx), which provides the tamper
// evident, auditable trail the product promises. Payloads that may contain
// personal data are never stored on-chain — only their sha256 digest is.
// ═══════════════════════════════════════════════════════════════════════════

// ── Chain ───────────────────────────────────────────────────────────────────
const txSchema = new mongoose.Schema(
  {
    txHash: { type: String, required: true }, // indexed via block 'txs.txHash' below
    type: { type: String, required: true },
    actor: { type: String, required: true },
    // Public, non-personal metadata only (amounts, step names, ids…).
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    // Always present: sha256 of the canonical payload. Personal payloads are
    // stored ONLY here (as a digest) so the chain never leaks private data.
    dataHash: { type: String, required: true },
    timestamp: { type: Number, required: true },
  },
  { _id: false }
);

const blockSchema = new mongoose.Schema({
  index: { type: Number, required: true, unique: true },
  timestamp: { type: Number, required: true },
  prevHash: { type: String, required: true },
  nonce: { type: Number, required: true },
  hash: { type: String, required: true },
  txs: { type: [txSchema], default: [] },
});
blockSchema.index({ 'txs.txHash': 1 });

const Block = mongoose.model('SwBlock', blockSchema);

// ── Wallet / Decentralized Identity ────────────────────────────────────────
// Keyed by `address`. Users get one wallet (`user` set — unique + sparse, so
// system wallets, which omit the field entirely, can coexist). System wallets
// hold treasury / escrow / marketplace inventory funds.
const walletSchema = new mongoose.Schema(
  {
    // Absent (undefined) for system wallets — never null, or the unique
    // sparse index would collide on duplicate nulls.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, sparse: true },
    did: { type: String, required: true, unique: true },
    address: { type: String, required: true, unique: true },
    publicKey: { type: String, default: '' },
    // AES-256-GCM envelope { iv, ct, tag } exactly as blockchain/crypto.js
    // encrypt() returns it. This MUST be an object column: declared as
    // String, every wallet save failed with "Cast to string failed" and
    // first-access /wallet (feature 5) was broken for all users.
    privateKeyEnc: {
      type: new mongoose.Schema(
        {
          iv: { type: String, required: true },
          ct: { type: String, required: true },
          tag: { type: String, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    label: { type: String, default: '' },
    isSystem: { type: Boolean, default: false },
    balance: { type: Number, default: 0 },
    staked: { type: Number, default: 0 },
    earnedTotal: { type: Number, default: 0 },
    spentTotal: { type: Number, default: 0 },
    lastStakeAccrualAt: { type: Number, default: () => Date.now() },
    welcomeBonusAt: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const Wallet = mongoose.model('SwWallet', walletSchema);

// ── DAO-governed configuration ─────────────────────────────────────────────
const DEFAULT_PARAMS = {
  welcomeBonus: 100,          // WELL minted on wallet creation
  rewardCheckin: 5,           // daily healthy-habit check-in
  rewardStreakStep: 1,        // extra WELL per consecutive check-in day
  rewardAssessment: 15,       // completed AI assessment
  rewardIntakeDay: 5,         // day with at least one tracked intake
  stakeApyPct: 12,            // staking yield, compounded daily on activity
  stakePremiumThreshold: 500, // staked >= this unlocks premium perks
  marketplaceFeePct: 3,       // protocol fee on order release
  loyaltyRedeemRate: 10,      // minimum WELL convertible into a loyalty code
  knowledgeReward: 10,        // publishing to the knowledge base
  knowledgeUpvoteReward: 2,   // to the author per upvote (capped)
  knowledgeUpvoteCap: 40,
  curatorReward: 1,           // to the upvoter (curator) per accepted post
  dataShareReward: 25,        // granting a research data share
  jurorReward: 5,             // resolving a marketplace dispute
  daoVotingDays: 3,           // proposal lifetime
  daoQuorumWeight: 50,        // min total voting weight for validity
  healthAnchorReward: 3,      // anchoring a health ledger snapshot
};

const configSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  params: { type: mongoose.Schema.Types.Mixed, default: () => ({ ...DEFAULT_PARAMS }) },
  updatedBy: { type: String, default: 'genesis' },
  updatedAt: { type: Number, default: () => Date.now() },
});

const Web3Config = mongoose.model('SwConfig', configSchema);

// ── Supply chain (feature 1) + certifications (feature 2) ─────────────────
const SUPPLY_STEPS = [
  'raw-sourcing',
  'manufacturing',
  'lab-testing',
  'quality-release',
  'distribution',
  'retail',
  'delivered',
];

const supplyEventSchema = new mongoose.Schema(
  {
    step: { type: String, required: true, enum: SUPPLY_STEPS },
    location: { type: String, default: '' },
    note: { type: String, default: '' },
    actorName: { type: String, default: '' },
    txHash: { type: String, default: '' },
    blockIndex: { type: Number, default: -1 },
    at: { type: Number, default: () => Date.now() },
  },
  { _id: true }
);

const certificationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['lab-report', 'organic', 'non-gmo', 'third-party', 'gmp', 'other'],
    },
    name: { type: String, required: true },
    issuer: { type: String, required: true },
    resultHash: { type: String, default: '' },
    fileCid: { type: String, default: '' },
    txHash: { type: String, default: '' },
    blockIndex: { type: Number, default: -1 },
    at: { type: Number, default: () => Date.now() },
  },
  { _id: true }
);

const supplyBatchSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    productName: { type: String, required: true },
    brand: { type: String, required: true },
    notes: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    events: { type: [supplyEventSchema], default: [] },
    certifications: { type: [certificationSchema], default: [] },
    createdAt: { type: Number, default: () => Date.now() },
  },
  { timestamps: true }
);

const SupplyBatch = mongoose.model('SwSupplyBatch', supplyBatchSchema);

// ── Marketplace (features 3, 4, 15) ───────────────────────────────────────
const listingSchema = new mongoose.Schema(
  {
    seller: { type: String, required: true },      // wallet address
    sellerUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 2000 },
    brand: { type: String, default: '', maxlength: 80 },
    category: {
      type: String,
      default: 'Vitamins',
      enum: ['Vitamins', 'Minerals', 'Herbs', 'Protein', 'Probiotics', 'Other'],
    },
    priceWell: { type: Number, required: true, min: 0 },
    stock: { type: Number, required: true, min: 0 },
    active: { type: Boolean, default: true },
    createdAt: { type: Number, default: () => Date.now() },
  },
  { timestamps: true }
);

const Listing = mongoose.model('SwListing', listingSchema);

const orderSchema = new mongoose.Schema(
  {
    listing: { type: mongoose.Schema.Types.ObjectId, ref: 'SwListing', required: true },
    listingTitle: { type: String, default: '' },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    buyerAddress: { type: String, required: true },
    sellerAddress: { type: String, required: true },
    sellerUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    fee: { type: Number, default: 0 },
    discountCode: { type: String, default: '' },
    discount: { type: Number, default: 0 },
    // Smart-contract escrow lifecycle: funds sit in the escrow wallet until
    // delivery confirmation (auto-release) or a resolved dispute.
    status: {
      type: String,
      enum: ['escrow', 'released', 'refunded', 'cancelled'],
      default: 'escrow',
      index: true,
    },
    escrowTx: { type: String, default: '' },
    settleTx: { type: String, default: '' },
    createdAt: { type: Number, default: () => Date.now() },
    settledAt: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const Order = mongoose.model('SwOrder', orderSchema);

const disputeSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SwOrder', required: true, unique: true },
    opener: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true, maxlength: 1000 },
    // Randomly selected jurors: staked token holders (never a party).
    jurors: { type: [String], default: [] },
    votes: {
      type: [
        new mongoose.Schema(
          { juror: String, choice: String, weight: Number, at: Number },
          { _id: false }
        ),
      ],
      default: [],
    },
    status: { type: String, enum: ['open', 'resolved'], default: 'open', index: true },
    outcome: { type: String, enum: ['buyer', 'seller', ''], default: '' },
    resolvedTx: { type: String, default: '' },
    createdAt: { type: Number, default: () => Date.now() },
    resolvedAt: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const Dispute = mongoose.model('SwDispute', disputeSchema);

// ── Governance (features 13, 14) ──────────────────────────────────────────
const proposalSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, maxlength: 140 },
    description: { type: String, default: '', maxlength: 4000 },
    param: { type: String, default: '' },   // config key to change when passed
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    proposer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    proposerAddress: { type: String, required: true },
    status: { type: String, enum: ['active', 'passed', 'rejected'], default: 'active', index: true },
    votes: {
      type: [
        new mongoose.Schema(
          { user: mongoose.Schema.Types.ObjectId, address: String, choice: String, weight: Number, at: Number },
          { _id: false }
        ),
      ],
      default: [],
    },
    endsAt: { type: Number, required: true },
    executedTx: { type: String, default: '' },
    createdAt: { type: Number, default: () => Date.now() },
  },
  { timestamps: true }
);

const Proposal = mongoose.model('SwProposal', proposalSchema);

const knowledgeSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    authorAddress: { type: String, required: true },
    type: { type: String, enum: ['review', 'research', 'story'], default: 'review' },
    title: { type: String, required: true, maxlength: 140 },
    body: { type: String, required: true, maxlength: 4000 },
    upvoters: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    upvotes: { type: Number, default: 0 },
    rewardPaid: { type: Number, default: 0 },
    txHash: { type: String, default: '' },
    createdAt: { type: Number, default: () => Date.now() },
  },
  { timestamps: true }
);

const KnowledgePost = mongoose.model('SwKnowledgePost', knowledgeSchema);

// ── Incentives (features 9, 10, 11, 12) ──────────────────────────────────
const rewardEventSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, required: true },
  refId: { type: String, default: '-' },
  day: { type: String, required: true }, // YYYY-MM-DD (server local time)
  amount: { type: Number, required: true },
  txHash: { type: String, default: '' },
  at: { type: Number, default: () => Date.now() },
});
// One payout per (user, kind, refId) — the idempotency key against double
// claiming the same healthy-habit reward.
rewardEventSchema.index({ user: 1, kind: 1, refId: 1 }, { unique: true });
rewardEventSchema.index({ user: 1, kind: 1, day: -1 });

const RewardEvent = mongoose.model('SwRewardEvent', rewardEventSchema);

const nftSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  ownerAddress: { type: String, required: true },
  tokenId: { type: String, required: true, unique: true },
  kind: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  imageSeed: { type: String, default: '' },
  serial: { type: Number, default: 1 },
  mintedAt: { type: Number, default: () => Date.now() },
  txHash: { type: String, default: '' },
});

nftSchema.index({ owner: 1, kind: 1 }, { unique: true });

const Nft = mongoose.model('SwNft', nftSchema);

const loyaltyCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  valueWell: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['unused', 'redeemed'], default: 'unused', index: true },
  redeemedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  redeemedOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SwOrder', default: null },
  createdAt: { type: Number, default: () => Date.now() },
});

const LoyaltyCode = mongoose.model('SwLoyaltyCode', loyaltyCodeSchema);

// ── User data, privacy & records (features 5, 6, 7, 8, 16, 17) ───────────
const dataShareSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    scope: {
      type: String,
      enum: ['nutrition-outcomes', 'adherence-study', 'general-research'],
      default: 'general-research',
    },
    recipient: { type: String, required: true, maxlength: 120 },
    // Anonymized, coarse dataset — encrypted and content-addressed (IPFS-like)
    datasetCid: { type: String, default: '' },
    reward: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
    consentTx: { type: String, default: '' },
    revokeTx: { type: String, default: '' },
    createdAt: { type: Number, default: () => Date.now() },
    revokedAt: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const DataShare = mongoose.model('SwDataShare', dataShareSchema);

const storageObjectSchema = new mongoose.Schema({
  cid: { type: String, required: true, unique: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, default: 'generic' },
  ciphertext: { type: String, required: true },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  size: { type: Number, default: 0 },
  pinnedAt: { type: Number, default: () => Date.now() },
});

const StorageObject = mongoose.model('SwStorageObject', storageObjectSchema);

const healthAnchorSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  digest: { type: String, required: true },
  assessmentCount: { type: Number, default: 0 },
  intakeCount: { type: Number, default: 0 },
  latestAssessmentAt: { type: Number, default: 0 },
  blockIndex: { type: Number, default: -1 },
  txHash: { type: String, default: '' },
  at: { type: Number, default: () => Date.now() },
});

const HealthAnchor = mongoose.model('SwHealthAnchor', healthAnchorSchema);

const shareLinkSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  expiresAt: { type: Number, required: true },
  revoked: { type: Boolean, default: false },
  views: { type: Number, default: 0 },
  createdAt: { type: Number, default: () => Date.now() },
});

const ShareLink = mongoose.model('SwShareLink', shareLinkSchema);

const recAnchorSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment', required: true },
  logicVersion: { type: String, required: true },
  inputHash: { type: String, required: true },
  outputHash: { type: String, required: true },
  combinedHash: { type: String, required: true },
  blockIndex: { type: Number, default: -1 },
  txHash: { type: String, default: '' },
  at: { type: Number, default: () => Date.now() },
});
recAnchorSchema.index({ user: 1, assessmentId: 1 }, { unique: true });

const RecAnchor = mongoose.model('SwRecAnchor', recAnchorSchema);

// ── Trials, oracles & professionals (features 18, 19, 20) ────────────────
const trialSchema = new mongoose.Schema({
  title: { type: String, required: true },
  sponsor: { type: String, required: true },
  phase: { type: String, default: 'Phase I' },
  description: { type: String, default: '' },
  rewardWell: { type: Number, default: 0 },
  spots: { type: Number, default: 100 },
  status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
  createdAt: { type: Number, default: () => Date.now() },
});

const Trial = mongoose.model('SwTrial', trialSchema);

const trialConsentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  trial: { type: mongoose.Schema.Types.ObjectId, ref: 'SwTrial', required: true },
  status: { type: String, enum: ['opted-in', 'withdrawn'], default: 'opted-in', index: true },
  reward: { type: Number, default: 0 },
  termsHash: { type: String, default: '' },
  consentTx: { type: String, default: '' },
  withdrawTx: { type: String, default: '' },
  createdAt: { type: Number, default: () => Date.now() },
  withdrawnAt: { type: Number, default: 0 },
});
trialConsentSchema.index({ user: 1, trial: 1 }, { unique: true });

const TrialConsent = mongoose.model('SwTrialConsent', trialConsentSchema);

const oracleFeedSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  value: { type: Number, required: true },
  unit: { type: String, default: '' },
  category: { type: String, enum: ['pricing', 'research', 'market'], default: 'pricing' },
  source: { type: String, default: 'SuppliWise Oracle' },
  txHash: { type: String, default: '' },
  updatedAt: { type: Number, default: () => Date.now() },
});

const OracleFeed = mongoose.model('SwOracleFeed', oracleFeedSchema);

const expertSchema = new mongoose.Schema({
  name: { type: String, required: true },
  specialty: { type: String, required: true },
  title: { type: String, default: '' },
  credential: { type: String, default: '' },
  bio: { type: String, default: '' },
  rateWell: { type: Number, required: true, min: 0 },
  address: { type: String, default: '' },
  active: { type: Boolean, default: true },
});

const Expert = mongoose.model('SwExpert', expertSchema);

const bookingSchema = new mongoose.Schema({
  expert: { type: mongoose.Schema.Types.ObjectId, ref: 'SwExpert', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userAddress: { type: String, required: true },
  hours: { type: Number, required: true, min: 1, max: 8 },
  cost: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['confirmed', 'cancelled'], default: 'confirmed' },
  txHash: { type: String, default: '' },
  createdAt: { type: Number, default: () => Date.now() },
});

const Booking = mongoose.model('SwBooking', bookingSchema);

module.exports = {
  Block,
  Wallet,
  Web3Config,
  DEFAULT_PARAMS,
  SupplyBatch,
  SUPPLY_STEPS,
  Listing,
  Order,
  Dispute,
  Proposal,
  KnowledgePost,
  RewardEvent,
  Nft,
  LoyaltyCode,
  DataShare,
  StorageObject,
  HealthAnchor,
  ShareLink,
  RecAnchor,
  Trial,
  TrialConsent,
  OracleFeed,
  Expert,
  Booking,
};
