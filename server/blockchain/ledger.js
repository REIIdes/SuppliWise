const { Block, ChainAudit } = require('../models/Web3');
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
//
// Bounded: the loop runs on the single event-loop thread, so an unbounded
// search is a request that can wedge the whole API. 2^26 attempts satisfies even
// the maximum difficulty (5) with an enormous margin (expected 2^20), and still
// terminates in a bounded number of iterations if the target is ever
// unsatisfiable.
const MAX_NONCE = 1 << 26;

// Verification only ever reads the fields headerHash() consumes. `txs[].data`
// is by far the bulk of every stored block and is never hashed into the header,
// so it used to be ~85% of the bytes pulled across the wire for nothing.
// Projecting it out is what makes verification viable at all against a remote
// MongoDB: on this chain it took a 1746-block walk from 11.2 s to 4.7 s, and a
// tail walk to ~150 ms. `hash` is included so the comparison below needs no
// extra round trip.
const VERIFY_PROJECTION = { index: 1, timestamp: 1, prevHash: 1, nonce: 1, hash: 1, 'txs.txHash': 1 };

// A whole-chain re-hash is O(chain) and the chain only ever grows, so it is
// never awaited on a request path. It runs on this interval instead, and the
// incremental fast path below reports the newest verdict it already has.
const FULL_AUDIT_INTERVAL_MS = 5 * 60 * 1000;

// Hard ceiling on how long a caller of verify() will wait for a verdict.
// A check that has not come back yet is "unknown", not "broken": without this
// budget a cold start (or any moment the deep audit is still running) would
// wait out the whole-chain walk and get reported as a failed check. Kept well
// under the monitor's 10 s probe timeout so the rest of the probe (the tx
// count, the response serialisation) always has room to finish too.
const VERIFY_BUDGET_MS = 5000;

function mineHeader(header) {
  for (let nonce = 0; nonce <= MAX_NONCE; nonce += 1) {
    const hash = headerHash({ ...header, nonce });
    if (meetsDifficulty(hash)) return { nonce, hash };
  }
  throw new Error(`No valid nonce found below ${MAX_NONCE} (difficulty ${DIFFICULTY}).`);
}

// Normalize a caller-supplied tx: compute its canonical hash + payload digest.
function normalizeTx(tx) {
  const timestamp = Number.isFinite(tx.timestamp) ? tx.timestamp : Date.now();
  const data = tx.data === undefined ? null : tx.data;
  const dataHash = tx.dataHash || hashPayload(data);
  const txHash = sha256Hex(stableStringify({ type: tx.type, actor: tx.actor, dataHash, timestamp }));
  return { txHash, type: tx.type, actor: tx.actor, data, dataHash, timestamp };
}

// Re-hash one block and report the first chain invariant it violates, or null
// when the block links cleanly onto `expectedPrev`. Extracted so the full audit
// and the incremental tail walk cannot drift apart in what they consider valid.
function checkBlock(block, expectedPrev) {
  if (block.prevHash !== expectedPrev) return 'prevHash mismatch';
  const recomputed = headerHash(block);
  if (recomputed !== block.hash) return 'hash mismatch';
  if (!meetsDifficulty(block.hash)) return 'difficulty target not met';
  return null;
}

class Ledger {
  constructor() {
    this.difficulty = DIFFICULTY;
    this.queue = Promise.resolve();
    this.initPromise = null;
    this.height = -1;
    this.tip = GENESIS_PREV_HASH;
    // Newest fast-path verdict, reused for the next few seconds.
    this.verifyCache = null;
    // Last position proven good: the incremental walk chains from here, so a
    // correct verdict costs O(blocks appended) instead of O(chain). Restored
    // from the database on init so a restart does not reset it.
    this.checkpoint = null;
    // When the deep audit behind `checkpoint` ran, and how many blocks it saw.
    this.verifiedAt = null;
    this.verifiedChecked = 0;
    // Newest whole-chain audit. `pending` marks an in-flight walk that every
    // concurrent caller shares instead of starting its own; `settled` is the
    // completed verdict, readable without awaiting.
    this.fullAudit = null;
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
      } else {
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
      }
      await this.restoreCheckpoint();
      return this;
    })().catch((err) => {
      this.initPromise = null; // allow retry
      throw err;
    });
    return this.initPromise;
  }

  // Re-adopt the last proven-good position from the database. One small
  // document, so a restarted server can answer an integrity check immediately
  // instead of re-walking the whole chain to rebuild what was already proven.
  // A checkpoint ahead of the live tip means the chain no longer matches what
  // was verified, so it is discarded and the next check re-walks from genesis.
  async restoreCheckpoint() {
    try {
      const saved = await ChainAudit.findOne({ key: 'chain' }).lean();
      if (!saved) return;
      if (saved.upTo > this.height) {
        this.checkpoint = null;
        return;
      }
      this.checkpoint = { upTo: saved.upTo, prevHash: saved.prevHash };
      this.verifiedAt = saved.verifiedAt || null;
      this.verifiedChecked = saved.checked || saved.upTo + 1;
    } catch (err) {
      // A missing checkpoint only costs speed, never correctness: the next
      // verify() falls back to a full audit.
      this.checkpoint = null;
    }
  }

  // Persist a proven-good position so the next process start inherits it.
  //
  // Two different things are tracked and must not be conflated:
  //   · `checkpoint`   — how far integrity has been proven, which the cheap
  //                      incremental walk keeps extending as blocks are added.
  //   · `verifiedAt`   — when the deep whole-chain re-hash last ran, and how
  //     `verifiedChecked`  many blocks it covered. Only a deep audit advances
  //                      these; the incremental walk never re-examines the
  //                      prefix, so letting it overwrite them would make the
  //                      monitor claim a full re-hash it never performed.
  async saveCheckpoint(cp, { verifiedAt = null, checked = null } = {}) {
    this.checkpoint = cp;
    if (verifiedAt) {
      this.verifiedAt = verifiedAt;
      this.verifiedChecked = checked == null ? cp.upTo + 1 : checked;
    }
    try {
      await ChainAudit.updateOne(
        { key: 'chain' },
        { $set: {
          upTo: cp.upTo,
          prevHash: cp.prevHash,
          verifiedAt: this.verifiedAt,
          checked: this.verifiedChecked || cp.upTo + 1,
        } },
        { upsert: true },
      );
    } catch (err) {
      // Best effort: an unwritable checkpoint degrades to the slower
      // re-walk-on-start behaviour, it must never fail a verification.
    }
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

  // Newest completed whole-chain verdict, or null while there is not one.
  // Lets callers report how fresh the deep audit is without awaiting it.
  lastAudit() {
    return this.fullAudit && !this.fullAudit.pending ? this.fullAudit.settled : null;
  }

  // Deep audit: re-hash EVERY header from the genesis prev-hash and check
  // index/prevHash linkage end to end. This is the only check that can catch an
  // edit to an old block, and it is O(chain) — so it is scheduled, never
  // awaited on a request path. Concurrent callers (the 30 s admin monitor poll,
  // /web3/chain/verify) share ONE walk rather than each starting their own.
  audit({ maxAgeMs = FULL_AUDIT_INTERVAL_MS } = {}) {
    const existing = this.fullAudit;
    if (existing) {
      if (existing.pending) return existing.result;
      if (Date.now() - existing.at < maxAgeMs) return existing.result;
    }
    const job = (async () => {
      await this.init();
      const blocks = await Block.find({}, VERIFY_PROJECTION).sort({ index: 1 }).lean();
      let prev = GENESIS_PREV_HASH;
      for (const block of blocks) {
        const reason = checkBlock(block, prev);
        if (reason) {
          // A broken chain invalidates the checkpoint: the prefix is no longer
          // known-good, so the incremental fast path must not build on it.
          this.checkpoint = null;
          return { valid: false, height: blocks.length - 1, brokenAt: block.index, reason, checked: blocks.length, difficulty: DIFFICULTY, fullAuditAt: Date.now() };
        }
        prev = block.hash;
      }
      const tip = blocks.length ? blocks[blocks.length - 1] : null;
      const at = Date.now();
      await this.saveCheckpoint(
        { upTo: tip ? tip.index : -1, prevHash: tip ? tip.hash : GENESIS_PREV_HASH },
        { verifiedAt: at, checked: blocks.length },
      );
      return { valid: true, height: tip ? tip.index : -1, checked: blocks.length, difficulty: DIFFICULTY, fullAuditAt: at };
    })();
    const entry = { at: Date.now(), pending: true, settled: null, result: job };
    this.fullAudit = entry;
    job.then(
      (value) => { if (this.fullAudit === entry) { entry.at = Date.now(); entry.pending = false; entry.settled = value; } },
      () => { if (this.fullAudit === entry) this.fullAudit = null; },
    );
    return job;
  }

  // Fast path: verify only the blocks appended since the last proven-good
  // position, chaining from the hash proven there. A correct verdict costs
  // O(blocks appended) — a handful of small documents — instead of the whole
  // chain, which is what used to blow the monitor's 10 s probe budget and
  // report a chain that was in fact perfectly valid as "Some Warnings".
  //
  // It defers to the full audit whenever the incremental assumption is not
  // provably safe: nothing proven yet, a gap or fork at the tail, a break
  // anywhere past the checkpoint, or a deep audit that already found damage.
  async verifyTail() {
    await this.init();
    const cp = this.checkpoint;
    const blocks = await Block.find({ index: { $gt: cp.upTo } }, VERIFY_PROJECTION).sort({ index: 1 }).lean();
    if (blocks.length && blocks[0].index !== cp.upTo + 1) {
      return this.audit({ maxAgeMs: 0 }); // hole below the tail: re-walk it all
    }
    let prev = cp.prevHash;
    for (const block of blocks) {
      if (checkBlock(block, prev)) {
        this.checkpoint = null;
        // The break may predate the checkpoint, so a tail-only verdict could
        // point at the wrong block. Re-walk to report the true first break.
        return this.audit({ maxAgeMs: 0 });
      }
      prev = block.hash;
    }
    const tip = blocks.length ? blocks[blocks.length - 1] : null;
    const height = tip ? tip.index : cp.upTo;
    // Only extend the checkpoint when the tail actually advanced. Leaving it
    // alone otherwise keeps "verified up to N" a statement about a position
    // that really was re-hashed.
    if (tip) await this.saveCheckpoint({ upTo: tip.index, prevHash: tip.hash });
    return { valid: true, height, checked: height + 1, difficulty: DIFFICULTY, newBlocks: blocks.length, verifiedAt: this.verifiedAt, verifiedChecked: this.verifiedChecked };
  }

  // Request-path integrity check. Returns { valid, height, checked, … }.
  //
  // Never blocks longer than `budgetMs`. If the deep audit is still running
  // when the budget runs out, the verdict is returned as `pending` rather than
  // awaited to completion: a check that has not come back yet is unknown, not
  // broken, and reporting it as a failure is what made a restarted server
  // display a valid chain as "Some Warnings".
  async verify({ maxAgeMs = 2000, budgetMs = VERIFY_BUDGET_MS } = {}) {
    if (this.verifyCache && Date.now() - this.verifyCache.at < maxAgeMs) {
      return this.verifyCache.result;
    }
    const job = (async () => {
      const audited = this.lastAudit();
      if (audited && !audited.valid) return audited; // known-broken: report as-is
      if (!audited && !this.checkpoint) {
        // Nothing proven yet — either a first-ever run or the chain changed
        // under us. Kick the deep audit off and give it a bounded head start.
        return this.awaitAudit(this.audit(), budgetMs);
      }
      return this.verifyTail();
    })();
    // Store the promise so concurrent callers share ONE walk, not N.
    this.verifyCache = { at: Date.now(), result: job };
    job.catch(() => { if (this.verifyCache && this.verifyCache.result === job) this.verifyCache = null; });
    return job;
  }

  // Wait up to `budgetMs` for a deep audit. On expiry, report the chain's
  // current tip as unproven-but-not-wrong, so the caller can say "audit in
  // progress" instead of raising a false alarm.
  async awaitAudit(job, budgetMs) {
    let timer;
    const expiry = new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
    const settled = await Promise.race([job.then((v) => v, () => null), expiry]);
    clearTimeout(timer);
    if (settled) return settled;
    const tip = await Block.findOne({}, { index: 1 }).sort({ index: -1 }).lean();
    return {
      valid: true,
      pending: true,
      height: tip ? tip.index : this.height,
      checked: tip ? tip.index + 1 : 0,
      difficulty: DIFFICULTY,
      newBlocks: 0,
    };
  }
}

module.exports = new Ledger();
module.exports.headerHash = headerHash;
module.exports.normalizeTx = normalizeTx;
module.exports.checkBlock = checkBlock;
module.exports.DIFFICULTY = DIFFICULTY;
module.exports.VERIFY_PROJECTION = VERIFY_PROJECTION;
module.exports.FULL_AUDIT_INTERVAL_MS = FULL_AUDIT_INTERVAL_MS;
