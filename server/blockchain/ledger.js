const { Block } = require('../models/Web3');
const { stableStringify, sha256Hex, hashPayload } = require('./crypto');

// ═══════════════════════════════════════════════════════════════════════════
// Append-only proof-of-work ledger.
//
// Every state change in the Web3 layer is anchored here as an immutable,
// hash-chained block. Consistency rules:
//   · block.hash = sha256(canonical header incl. nonce) with N leading zeros
//   · block.prevHash = previous block's hash (breaks the chain if edited)
//   · every tx carries a canonical dataHash — personal payloads are stored
//     ONLY as digests, never in the clear, on the chain.
//
// All appends are serialized through a single promise queue so concurrent
// requests can never race on height/tip (which would fork the chain).
// ═══════════════════════════════════════════════════════════════════════════

const GENESIS_PREV_HASH = '0'.repeat(64);
const DIFFICULTY = Math.max(1, Math.min(5, Number(process.env.CHAIN_DIFFICULTY) || 3));

function headerHash({ index, timestamp, prevHash, nonce, txs }) {
  const txPart = (txs || []).map((t) => t.txHash).join('|');
  return sha256Hex(stableStringify({ index, timestamp, prevHash, nonce, txPart }));
}

function meetsDifficulty(hash) {
  return hash.startsWith('0'.repeat(DIFFICULTY));
}

// Brute-force a nonce so the header hash satisfies the difficulty target.
function mineHeader(header) {
  let nonce = 0;
  for (;;) {
    const hash = headerHash({ ...header, nonce });
    if (meetsDifficulty(hash)) return { nonce, hash };
    nonce += 1;
  }
}

// Normalize a caller-supplied tx: compute its canonical hash + payload digest.
function normalizeTx(tx) {
  const timestamp = Number.isFinite(tx.timestamp) ? tx.timestamp : Date.now();
  const data = tx.data === undefined ? null : tx.data;
  const dataHash = tx.dataHash || hashPayload(data);
  const txHash = sha256Hex(stableStringify({ type: tx.type, actor: tx.actor, dataHash, timestamp }));
  return { txHash, type: tx.type, actor: tx.actor, data, dataHash, timestamp };
}

class Ledger {
  constructor() {
    this.difficulty = DIFFICULTY;
    this.queue = Promise.resolve();
    this.initPromise = null;
    this.height = -1;
    this.tip = GENESIS_PREV_HASH;
  }

  // Load the tip (or create the genesis block on first boot). Errors are not
  // cached, so a transient DB failure retries on the next append.
  init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const tip = await Block.findOne({}, { index: 1, hash: 1 }).sort({ index: -1 }).lean();
      if (tip) {
        this.height = tip.index;
        this.tip = tip.hash;
        return this;
      }
      const genesisTx = normalizeTx({
        type: 'genesis',
        actor: 'sw:system',
        data: { network: 'suppliwise-mainnet', difficulty: DIFFICULTY, launchedAt: Date.now() },
      });
      const header = { index: 0, timestamp: Date.now(), prevHash: GENESIS_PREV_HASH, txs: [genesisTx] };
      const { nonce, hash } = mineHeader(header);
      await Block.create({ ...header, nonce, hash, txs: [genesisTx] });
      this.height = 0;
      this.tip = hash;
      return this;
    })().catch((err) => {
      this.initPromise = null; // allow retry
      throw err;
    });
    return this.initPromise;
  }

  // Append one or more txs as the next block. Serialized via the queue.
  // Returns { index, hash, txs:[txHash…] }.
  append(txs) {
    const list = (Array.isArray(txs) ? txs : [txs]).filter(Boolean);
    if (!list.length) {
      return Promise.reject(new Error('Nothing to append'));
    }
    const run = async () => {
      await this.init();
      const normalized = list.map(normalizeTx);
      const index = this.height + 1;
      const timestamp = Date.now();
      const header = { index, timestamp, prevHash: this.tip, txs: normalized };
      const { nonce, hash } = mineHeader(header);
      await Block.create({ index, timestamp, prevHash: this.tip, nonce, hash, txs: normalized });
      this.height = index;
      this.tip = hash;
      return { index, hash, txs: normalized.map((t) => t.txHash) };
    };
    // Chain onto the queue regardless of the previous outcome, but keep a
    // rejected job from poisoning the chain for later appends.
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => {});
    return job;
  }

  // Recent blocks, newest first.
  async getBlocks({ limit = 25, before = null } = {}) {
    await this.init();
    const query = Number.isFinite(before) ? { index: { $lt: Number(before) } } : {};
    return Block.find(query).sort({ index: -1 }).limit(Math.min(100, Math.max(1, limit))).lean();
  }

  async findByTx(txHash) {
    await this.init();
    return Block.findOne({ 'txs.txHash': txHash }).lean();
  }

  // Full chain audit: recompute every block hash and check index/prevHash
  // linkage. Reports the first broken position, if any.
  async verify() {
    await this.init();
    const blocks = await Block.find({}).sort({ index: 1 }).lean();
    let prev = GENESIS_PREV_HASH;
    for (const block of blocks) {
      const recomputed = headerHash(block);
      if (block.prevHash !== prev) {
        return { valid: false, height: blocks.length - 1, brokenAt: block.index, reason: 'prevHash mismatch' };
      }
      if (recomputed !== block.hash) {
        return { valid: false, height: blocks.length - 1, brokenAt: block.index, reason: 'hash mismatch' };
      }
      if (!meetsDifficulty(block.hash)) {
        return { valid: false, height: blocks.length - 1, brokenAt: block.index, reason: 'difficulty target not met' };
      }
      prev = block.hash;
    }
    return { valid: true, height: blocks.length - 1, checked: blocks.length, difficulty: DIFFICULTY };
  }
}

module.exports = new Ledger();
module.exports.headerHash = headerHash;
module.exports.normalizeTx = normalizeTx;
module.exports.DIFFICULTY = DIFFICULTY;
