const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Block, ChainAudit, ChainRepair } = require('../models/Web3');
const {
  stableStringify,
  sha256Hex,
  hashPayload,
  hmacHex,
  timingSafeEqualHex,
} = require('./crypto');

// Alerting is loaded LAZILY on purpose. This module is also required by the
// pure unit tests with no database connected, and a top-level require of the
// alerting module would drag the notification and admin-event models in with it.
let alertingModule = null;
function alerting() {
  if (!alertingModule) alertingModule = require('./alerting');
  return alertingModule;
}

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

// Commitment scheme version. 2 is what new blocks are mined under.
const COMMIT_V2 = 2;

// ── Integrity seal key ─────────────────────────────────────────────────────
//
// The seal key is the one secret in this system that must NOT live in MongoDB:
// it is what makes a checkpoint unforgeable by anyone who can only write to the
// database it describes.
//
// CHAIN_SEAL_KEY is used when set. Otherwise it is DERIVED from JWT_SECRET,
// which every deployment already has and which is required to boot at all — so
// the seal works out of the box rather than depending on an operator noticing a
// new variable. Deriving is sound here because the two secrets never travel
// together: JWT_SECRET signs tokens, and this key only ever authenticates an
// integrity record.
//
// Deliberately NOT derived from anything in the chain. A seal key an attacker
// can read from the database they are attacking certifies nothing.
let cachedSealKey = null;
function sealKey() {
  if (cachedSealKey !== null) return cachedSealKey;
  const raw = process.env.CHAIN_SEAL_KEY || process.env.JWT_SECRET || '';
  // An empty/absent secret would silently produce a well-formed but worthless
  // seal, so an unsealable deployment reports "no seal" instead of pretending.
  cachedSealKey = raw.length >= 16 ? raw : '';
  return cachedSealKey;
}

/** True when this deployment can produce/verify integrity seals at all. */
function sealAvailable() {
  return sealKey().length >= 16;
}

// Canonical bytes the seal covers. Every field the fast path trusts is in here,
// so a single HMAC authenticates the whole record at once.
function sealPayload({ upTo, prevHash, sealedIndex, sealedHash }) {
  return stableStringify({
    v: COMMIT_V2,
    upTo: Number(upTo),
    prevHash: String(prevHash || ''),
    sealedIndex: Number(sealedIndex),
    sealedHash: String(sealedHash || ''),
  });
}

function computeSeal(record) {
  const key = sealKey();
  if (!key) return '';
  return hmacHex(key, sealPayload(record));
}

/**
 * Verify a persisted checkpoint's seal.
 * @returns {'ok'|'bad'|'unsealed'} 'unsealed' means this deployment has no key
 *   (or the record predates sealing) and therefore cannot judge — NOT a pass.
 */
function verifySeal(record) {
  if (!sealAvailable()) return 'unsealed';
  const stored = String((record && record.seal) || '');
  if (!stored) return 'unsealed';
  return timingSafeEqualHex(computeSeal(record), stored) ? 'ok' : 'bad';
}

// ── Block commitment ───────────────────────────────────────────────────────
//
// v1 (historical blocks): the header committed to the joined list of txHash
// values. A txHash is itself a digest of {type, actor, dataHash, timestamp}, so
// editing any of those four fields — or `data`, which was never in it at all —
// left the block hash untouched and the chain reported itself valid. Five of the
// tamper attacks in chain-tamper-harness.js exploited exactly this.
//
// v2: the header commits to a digest of EACH FULL TRANSACTION, payload included.
// Editing anything inside a transaction now changes the block hash, so the break
// is detectable even by the cheap incremental walk.
function txCommitmentV2(tx) {
  return sha256Hex(stableStringify({
    txHash: tx.txHash,
    type: tx.type,
    actor: tx.actor,
    dataHash: tx.dataHash,
    data: tx.data === undefined ? null : tx.data,
    timestamp: tx.timestamp,
  }));
}

function headerHash({ index, timestamp, prevHash, nonce, txs, v }) {
  const list = txs || [];
  // v1 committed to the joined txHash list, and its canonical object did NOT
  // carry a version key at all. Reproducing v1 byte-for-byte is what lets the
  // whole existing chain keep verifying after v2 was introduced: adding `v` to
  // the preimage would re-hash every historical block and report a chain that
  // had never been touched as "hash mismatch at block 0".
  if (commitVersionOf({ v }) < COMMIT_V2) {
    return sha256Hex(stableStringify({
      index, timestamp, prevHash, nonce, txPart: list.map((t) => t.txHash).join('|'),
    }));
  }
  const txPart = list.map(txCommitmentV2).join('|');
  return sha256Hex(stableStringify({ v: COMMIT_V2, index, timestamp, prevHash, nonce, txPart }));
}

// The version to use when MINE-ING. New blocks are always v2.
function commitVersionForNewBlocks() {
  return COMMIT_V2;
}

// The version a STORED block was mined under. Absent means v1 (history).
function commitVersionOf(block) {
  return Number(block && block.v) || 1;
}

function meetsDifficulty(hash, difficulty = DIFFICULTY) {
  return hash.startsWith('0'.repeat(difficulty));
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
const VERIFY_PROJECTION = {
  index: 1, timestamp: 1, prevHash: 1, nonce: 1, hash: 1, v: 1, difficulty: 1,
  'txs.txHash': 1, 'txs.type': 1, 'txs.actor': 1, 'txs.dataHash': 1,
  'txs.digestCovers': 1, 'txs.timestamp': 1,
  // `txs.data` IS needed — verifying that each stored payload still matches its
  // committed digest is the entire point of the v2 commitment scheme, and it is
  // a projection so the walk still transfers headers plus payloads rather than
    // whole documents. The old projection dropped it, which is precisely why an
  // edited payload used to verify clean.
  'txs.data': 1,
};

// A whole-chain re-hash is O(chain) and the chain only ever grows, so it is
// never awaited on a request path. It runs on this interval instead, and the
// incremental fast path below reports the newest verdict it already has.
const FULL_AUDIT_INTERVAL_MS = 5 * 60 * 1000;

// Append-only log of sealed head positions, on the HOST filesystem rather than
// in MongoDB — see anchorHeadToDisk for why that distinction is the whole point.
// Set CHAIN_HEAD_ANCHOR=false to disable (e.g. a read-only container fs).
//
// THE FILENAME MUST BE PER-DATABASE, and the digest has to come from the
// RESOLVED database name, not from MONGO_URI. MONGO_URI carries no database in
// its path (`mongodb+srv://…@cluster/?appName=…`), so every database on a
// cluster resolves from the same URI string — keying on the URI gave every one of
// them the SAME anchor file. Two chains then read each other's anchors: a scratch
// chain of 3 blocks immediately saw production's height and refused to verify,
// reporting itself truncated at a height it had never reached.
//
// `defaultAnchorPath()` therefore resolves the name from the live connection and
// falls back to a digest of MONGO_URI only while disconnected.
function defaultAnchorPath() {
  const dbName = (mongoose.connection && mongoose.connection.name)
    || dbFromUri(String(process.env.MONGO_URI || ''))
    || 'default';
  return path.join(
    __dirname, '..', 'uploads',
    `.chain-head.${sha256Hex(dbName).slice(0, 12)}.anchor`
  );
}

/** The database name embedded in a Mongo URI, or null when it carries none. */
function dbFromUri(uri) {
  const m = /mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(String(uri || ''));
  return (m && m[1]) || null;
}

let diskAnchorPath = null;
function anchorPath() {
  // Resolved lazily: at require() time there is no connection yet, so the
  // database name is not knowable.
  if (process.env.CHAIN_HEAD_ANCHOR === 'false') return null;
  if (!diskAnchorPath) diskAnchorPath = defaultAnchorPath();
  return diskAnchorPath;
}

// Hard ceiling on how long a caller of verify() will wait for a verdict.
// A check that has not come back yet is "unknown", not "broken": without this
// budget a cold start (or any moment the deep audit is still running) would
// wait out the whole-chain walk and get reported as a failed check. Kept well
// under the monitor's 10 s probe timeout so the rest of the probe (the tx
// count, the response serialisation) always has room to finish too.
const VERIFY_BUDGET_MS = 5000;

function mineHeader(header) {
  const v = commitVersionForNewBlocks();
  for (let nonce = 0; nonce <= MAX_NONCE; nonce += 1) {
    const hash = headerHash({ ...header, v, nonce });
    if (meetsDifficulty(hash)) return { nonce, hash };
  }
  throw new Error(`No valid nonce found below ${MAX_NONCE} (difficulty ${DIFFICULTY}).`);
}

// Normalize a caller-supplied tx: compute its canonical hash + payload digest.
//
// `tx.secret` (not `tx.dataHash`) is what marks a transaction as carrying a
// private-payload digest. Inferring it from the mere PRESENCE of a caller-supplied
// dataHash was a hole: anyone able to call append() could pass
// `{ data: <anything>, dataHash: <digest of something else> }` and have the
// transaction silently classified 'private', which skips the payload cross-check
// — turning the check into something the caller opts out of. So the ledger
// derives the digest itself and only honours an explicit `secret`, which is the
// one case where the digest genuinely cannot be re-derived from `data`.
//
// A caller-supplied `dataHash` is therefore IGNORED unless `secret` is also
// given. Silently trusting it would let a route anchor a digest that does not
// describe the payload it claims to prove.
function normalizeTx(tx) {
  const timestamp = Number.isFinite(tx.timestamp) ? tx.timestamp : Date.now();
  const data = tx.data === undefined ? null : tx.data;
  const privatePayload = tx.secret !== undefined && tx.secret !== null;
  const dataHash = privatePayload ? hashPayload(tx.secret) : hashPayload(data);
  const txHash = sha256Hex(stableStringify({ type: tx.type, actor: tx.actor, dataHash, timestamp }));
  return {
    txHash,
    type: tx.type,
    actor: tx.actor,
    data,
    dataHash,
    digestCovers: privatePayload ? 'private' : 'data',
    timestamp,
  };
}

// Re-derive a transaction's own hash from its stored fields. Returns null when
// the stored txHash still matches, or a reason string when it does not.
//
// This is what makes a v1 block's TRANSACTION FIELDS tamper-evident: the header
// only ever committed to txHash, but txHash is a pure function of these fields,
// so re-deriving it proves none of them were edited after mining. (The payload
// `data` was never part of txHash and remains uncommitted on v1 blocks — that
// is precisely why v2 exists.)
function checkTx(tx) {
  if (!tx || typeof tx !== 'object') return 'malformed transaction';
  const expected = sha256Hex(stableStringify({
    type: tx.type,
    actor: tx.actor,
    dataHash: tx.dataHash,
    timestamp: tx.timestamp,
  }));
  if (expected !== tx.txHash) return 'transaction hash mismatch';
  // A payload digest that claims to cover `data` must actually be the digest of
  // `data`. Otherwise anyone could rewrite a stored payload AND leave the digest
  // alone, and the digest — the thing the product tells users proves the payload
  // — would be describing something else.
  //
  // A transaction with NO coverage marker predates both schemes. `engine.anchor`
  // used to derive the digest itself and hand the ledger a precomputed
  // `dataHash`, so `health:anchor` blocks written before `digestCovers` existed
  // carry the digest of the UNPUBLISHED payload — which is what this check reads
  // as a mismatch. Those are legitimate records, not tampering, so an unmarked
  // transaction is judged by its digest alone rather than reported as broken.
  //
  // This cannot be used to launder an edit: on v2 the header commits to the
  // payload, and on v1 an unmarked transaction's `data` was never committed by
  // anything, so there is no claim being broken. It is only ever a statement
  // about which payload a historical digest covered.
  if (tx.digestCovers !== 'private' && tx.digestCovers !== undefined) {
    if (hashPayload(tx.data === undefined ? null : tx.data) !== tx.dataHash) {
      return 'payload digest does not match the stored payload';
    }
  }
  return null;
}


  /**
 * Re-hash one block and report the first chain invariant it violates, or null
 * when the block links cleanly onto `expectedPrev`. Extracted so the full audit
 * and the incremental tail walk cannot drift apart in what they consider valid.
 */
function checkBlock(block, expectedPrev) {
  if (block.prevHash !== expectedPrev) return 'prevHash mismatch';
  // Verify the transactions BEFORE the header. On a v2 block the header already
  // covers the payload, so a payload edit shows up as a hash mismatch; on a v1
  // block it does not, and this per-transaction check is the only thing that
  // catches it. Reporting the specific reason beats a generic "hash mismatch",
  // because "your records were rewritten" and "the block linkage is wrong" are
  // very different incidents.
  for (const tx of block.txs || []) {
    const reason = checkTx(tx);
    if (reason) return reason;
  }
  const recomputed = headerHash({ ...block, v: commitVersionOf(block) });
  if (recomputed !== block.hash) return 'hash mismatch';
  // Difficulty is read from the BLOCK, not the current env value: raising
  // CHAIN_DIFFICULTY later must not retroactively invalidate existing history.
  if (!meetsDifficulty(block.hash, blockDifficulty(block))) return 'difficulty target not met';
  return null;
}

// The difficulty a stored block was mined against. Blocks written before the
// field existed fall back to the current setting.
function blockDifficulty(block) {
  const d = Number(block && block.difficulty);
  return Number.isInteger(d) && d >= 1 ? d : DIFFICULTY;
}

/**
 * Append one permanent, human-readable entry to the repair log.
 *
 * Deliberately NOT anchored into the chain: the chain is the thing that just
 * proved unreliable, so the record of its failure has to live outside it. This is
 * also why repair() truncates blocks — without this log, the discarded range
 * would leave no trace anywhere.
 *
 * Best effort. An unwritable audit log must not fail a repair that succeeded.
 */
async function writeRepairRecord(entry) {
  try {
    if (entry.dedupeKey) {
      const existing = await ChainRepair.findOne({ dedupeKey: entry.dedupeKey }).lean();
      if (existing) return existing;
    }
    return await ChainRepair.create({ key: 'chain', ...entry });
  } catch (err) {
    console.error('[chain] could not write the repair record:', err.message);
    return null;
  }
}

// The difficulty a stored block was mined against. Blocks written before the
// field existed fall back to the current setting.
function blockDifficulty(block) {
  const d = Number(block && block.difficulty);
  return Number.isInteger(d) && d >= 1 ? d : DIFFICULTY;
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
    // Deepest height ever proven, and that block's hash. Monotonic in-memory
    // mirror of ChainAudit.sealed, and what makes TRUNCATION visible: deleting
    // the tail produces a shorter chain that is internally flawless, so without
    // a high-water mark there is nothing to compare the shrunken tip against.
    this.sealed = null;
    // Set when a persisted checkpoint failed its seal. The checkpoint is only a
    // performance claim, so this never invalidates the chain by itself — it
    // forces the next check back to a full re-hash from genesis.
    this.sealCompromised = false;
    // Outstanding integrity incident, so a recovery notice can be raised once
    // and so /chain/status can explain itself without re-walking.
    this.incident = null;
    // Set when the chain has been proven broken and must not be extended until
    // an operator repairs it. Distinct from `incident`: an incident is a fact
    // that happened, quarantine is a rule about what the ledger may do next.
    this.quarantined = null;
    // The most recent successful repair, so the recovery notice can state
    // whether blocks were discarded. Reset by raiseIncident() when a new
    // incident opens, so a stale repair can never be attributed to it.
    this.lastRepair = null;
    // Deepest head position written to the host filesystem anchor.
    this.diskAnchored = null;
    this.diskAnchorWarned = false;
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
        await Block.create({
          ...header,
          nonce,
          hash,
          v: commitVersionForNewBlocks(),
          difficulty: DIFFICULTY,
          txs: [genesisTx],
        });
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

      // AUTHENTICATE THE CHECKPOINT BEFORE TRUSTING IT.
      //
      // Without this, the checkpoint is a bare assertion in the same database it
      // describes: anyone who can write to the blocks can write
      // { upTo: <tip>, prevHash: <tip> } and the fast path then re-hashes zero
      // blocks, forever reporting a fully rewritten chain as valid. A seal that
      // does not verify is discarded, which costs one full re-walk and nothing
      // else — the same cost as having no checkpoint at all.
      const verdict = verifySeal(saved);
      if (verdict === 'bad') {
        this.sealCompromised = true;
        this.checkpoint = null;
        console.error(
          '[chain] checkpoint seal did not verify — discarding it and re-hashing from genesis. '
          + 'Either the record was edited or CHAIN_SEAL_KEY changed.'
        );
        return;
      }
      if (verdict === 'unsealed') {
      // Unsealed, not merely unverified. A checkpoint with no valid seal is an
      // UNSUPPORTED CLAIM ("this is verified, trust me") sitting in the same
      // database as the data it describes — and it must not be able to end an
      // open incident. Trusting it would mean a forged row could both skip the
      // deep audit AND silence the recovery notice, so every unsealed
      // checkpoint is discarded and the chain re-hashed from genesis.
      this.sealCompromised = true;
      this.checkpoint = null;
      if (!this.unsealedWarned) {
        this.unsealedWarned = true;
        console.error(
          '[chain] checkpoint carries no valid seal — discarding it and re-hashing from genesis. '
          + 'Set CHAIN_SEAL_KEY so the "already verified" record can be authenticated.'
        );
      }
    }

      this.checkpoint = { upTo: saved.upTo, prevHash: saved.prevHash };
      this.verifiedAt = saved.verifiedAt || null;
      this.verifiedChecked = saved.checked || saved.upTo + 1;
      if (saved.sealed && Number(saved.sealed.index) >= 0) {
        this.sealed = { index: Number(saved.sealed.index), hash: String(saved.sealed.hash || '') };
      }
      // Re-adopt an incident that was open when the process last stopped, so the
      // recovery notice can still be delivered after a restart.
      // The newest repair-log entry decides whether an incident is still OPEN.
      //
      // The previous attempt gated this on "an incident row exists", which is true
      // forever — repair writes its record but never deletes the incident, so a
      // repaired chain came back from a restart still quarantined and refused
      // every append. The log is ordered by time, so the correct question is
      // simply: was the LAST entry an incident? If the last entry is a repair (or
      // a repair that failed), the incident it closed is closed.
      const latest = await ChainRepair.findOne({ key: 'chain' }).sort({ at: -1 }).lean();
      const openInLog = !!latest && latest.kind === 'incident';
      const savedIncident = saved.incident && saved.incident.fingerprint;

      if (openInLog) {
        this.quarantine({
          reason: latest.reason || 'integrity failure',
          brokenAt: Number(latest.brokenAt) >= 0 ? Number(latest.brokenAt) : 0,
          height: this.height,
          // A truncation cannot be undone by discarding blocks — remember that
          // across the restart or the operator would be told the wrong remedy.
          unrecoverable: latest.failureKind === 'truncation',
          kind: latest.failureKind || 'linkage',
        });
      }

      if (savedIncident) {
        this.incident = {
          fingerprint: savedIncident.fingerprint,
          reason: saved.incident.reason,
          brokenAt: Number(saved.incident.brokenAt),
          height: this.height,
          checked: this.verifiedChecked,
          at: Number(saved.incident.raisedAt) || Date.now(),
          notified: true,
        };
        // The incident record is still open even if the repair log is not (e.g.
        // the log write failed). Trust the more conservative signal: keep the
        // chain closed until a repair has demonstrably run.
        if (!openInLog) {
          this.quarantine({
            reason: saved.incident.reason || 'integrity failure',
            brokenAt: Number(saved.incident.brokenAt) >= 0 ? Number(saved.incident.brokenAt) : 0,
            height: this.height,
          });
        }
      }
    } catch (err) {
      // A missing checkpoint only costs speed, never correctness: the next
      // verify() falls back to a full audit.
      this.checkpoint = null;
    }
  }

  /**
   * Advance the on-disk head anchor and re-check it against the live chain.
   *
   * WHY A FILE, WHEN THERE IS ALREADY A SEALED CHECKPOINT IN MONGODB
   * ---------------------------------------------------------------
   * Because the sealed checkpoint lives in the database it is meant to describe.
   * Anyone able to rewrite history can delete that row too — and once it is
   * gone there is nothing left in MongoDB that remembers the chain used to be
   * longer. The harness proved exactly that: deleting the tail *and* the
   * checkpoint record leaves a short, perfectly valid chain with no trace of the
   * blocks that went missing.
   *
   * The filesystem is a genuinely different trust domain. A leaked database
   * credential does not grant write access to the host's disk, so an append-only
   * log of sealed head positions survives the one attack the database cannot
   * survive on its own.
   *
   * Format is one JSON object per line: { i, h, t, s } — index, hash, time, seal.
   * Append-only, fsync'd, and only ever written with strictly-increasing index,
   * so the file cannot itself be used to hide a truncation.
   */
  async anchorHeadToDisk(index, hash) {
    if (index < 0) return;
    const diskAnchorPath = anchorPath();
    if (!diskAnchorPath) return;
    if (this.diskAnchored && index <= this.diskAnchored.index) return; // monotonic
    const record = { i: index, h: String(hash || ''), t: Date.now(), s: computeSeal({ upTo: index, prevHash: hash, sealedIndex: index, sealedHash: hash }) };
    try {
      await fs.promises.appendFile(diskAnchorPath, `${JSON.stringify(record)}\n`, 'utf8');
      this.diskAnchored = { index, hash: record.h };
    } catch (err) {
      // A read-only or full disk must never fail a verification. It only costs
      // the extra layer of truncation detection.
      if (!this.diskAnchorWarned) {
        this.diskAnchorWarned = true;
        console.error('[chain] could not write the on-disk head anchor:', err.message);
      }
    }
  }

  /**
   * The deepest head position ever recorded on disk.
   *
   * Read at boot and compared against the live tip. A chain whose tip is behind
   * this was truncated; one at the same height with a different hash had its tip
   * block replaced.
   */
  async readDiskAnchor() {
    const diskAnchorPath = anchorPath();
    if (!diskAnchorPath) return null;
    try {
      const raw = await fs.promises.readFile(diskAnchorPath, 'utf8');
      let best = null;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (!Number.isInteger(rec.i) || typeof rec.h !== 'string') continue;
          // A line whose seal does not verify was written by something that is
          // not this server. Ignore it rather than treating it as proof — the
          // file is an integrity aid, not an authority to fail a chain on.
          if (rec.s && verifySeal({ upTo: rec.i, prevHash: rec.h, sealedIndex: rec.i, sealedHash: rec.h }) !== 'bad') {
            if (!best || rec.i > best.index) best = { index: rec.i, hash: rec.h };
          }
        } catch {
          // A truncated final line (power loss mid-append) is expected; skip it.
        }
      }
      return best;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[chain] could not read the on-disk head anchor:', err.message);
      }
      return null;
    }
  }

  /**
   * Compare the live tip against the deepest position ever recorded on disk.
   *
   * Complements checkHighWater: that one compares against the database record,
   * this one against a medium the database attacker cannot reach. Either alone
   * has a hole; together, deleting a block AND its database audit row still
   * leaves the missing height recorded on the host.
   */
  async checkDiskAnchor(tipIndex, tipHash) {
    const anchored = await this.readDiskAnchor();
    if (!anchored) return null;
    this.diskAnchored = anchored;
    if (tipIndex < anchored.index) {
      return {
        valid: false,
        reason: `chain truncated: tip is at block ${tipIndex} but block ${anchored.index} was sealed on this host (${anchored.hash.slice(0, 12)}...)`,
        brokenAt: tipIndex + 1,
        kind: 'truncation',
      };
    }
    if (tipIndex === anchored.index && tipHash && anchored.hash && tipHash !== anchored.hash) {
      return {
        valid: false,
        reason: `tip block ${tipIndex} was rewritten: sealed on this host as ${anchored.hash.slice(0, 12)}..., now ${String(tipHash).slice(0, 12)}...`,
        brokenAt: tipIndex,
        kind: 'tip-rewrite',
      };
    }
    return null;
  }

  /**
   * Raise an integrity incident: record it, log it, and notify every account
   * with blockchain activity plus every administrator.
   *
   * Best effort by construction. It runs from inside the verifier, and a failure
   * to deliver a warning must never turn a detected break into a swallowed one
   * — so every step is individually guarded.
   */
  raiseIncident({ reason, brokenAt, height, checked }) {
    const fingerprint = `${reason}@${brokenAt}`;
    const now = Date.now();
    // Re-entrant: the audit, the monitor probe and /chain/verify can all report
    // the same break within milliseconds. One notification per break, not three.
    if (this.incident && this.incident.fingerprint === fingerprint) return this.incident;
    // A NEW incident must not inherit the previous one's repair summary, or the
    // recovery notice for this incident would claim blocks were discarded when
    // they were not.
    this.lastRepair = null;
    this.incident = { fingerprint, reason, brokenAt, height, checked, at: now, notified: false,
      // Whether new blocks are being refused. Carried into the user-facing
      // message so a member is told receipts are on hold rather than left to
      // wonder why a reward has no transaction hash.
      quarantine: !!this.quarantined };
    // Two independent records, because they fail differently: the ChainAudit row
    // tells a restarted process an incident is open (so the all-clear is still
    // delivered), while the ChainRepair log is the permanent human-readable
    // account of what happened that survives every future truncation.
    ChainAudit.updateOne(
      { key: 'chain' },
      { $set: { incident: { fingerprint, reason, brokenAt, raisedAt: now } } },
      { upsert: true }
    ).catch((err) => console.error('[chain] could not persist the incident:', err.message));
    // No dedupeKey here on purpose. raiseIncident() already de-duplicates within a
    // process, and a persisted key would suppress a genuine SECOND occurrence of
    // the same break after a repair — which is exactly the event an operator most
    // needs in this log ("it broke here, we repaired, it broke here again").
    writeRepairRecord({
      kind: 'incident',
      actor: 'ledger',
      brokenAt,
      reason,
      failureKind: this.quarantined && this.quarantined.unrecoverable ? 'truncation' : 'linkage',
      healthyAfter: false,
    });
    console.error(
      `[chain] INTEGRITY FAILURE at block ${brokenAt}: ${reason} `
      + `(height ${height}, ${checked} block(s) checked) — notifying users and administrators.`
    );
    // Fire-and-forget: the verdict is already decided, so delivery must never gate
    // it. Wrapped so a throw inside the alerting module cannot escape into the
    // verifier and replace the break we just found with a different error.
    Promise.resolve()
      .then(() => alerting().notifyChainIncident(this.incident))
      .catch((err) => console.error('[chain] incident notification failed:', err.message));
    return this.incident;
  }

  /** Clear an open incident once the chain verifies clean again. */
  clearIncident() {
    if (!this.incident) return null;
    const resolved = this.incident;
    // Carry the repair facts into the incident so the recovery notice can tell
    // the audience whether blocks were discarded. Without this a repair and a
    // no-op self-heal would send an identical "all healthy" message, hiding the
    // one thing recipients most need to know.
    const lastRepair = this.lastRepair;
    if (lastRepair) {
      resolved.repaired = true;
      resolved.discardedCount = Number(lastRepair.discardedCount) || 0;
      resolved.keptThrough = Number(lastRepair.keptThrough);
    }
    this.incident = null;
    // Clear the persisted record first: it is what stops a crash between here and
    // the notification from re-sending the all-clear on the next boot.
    ChainAudit.updateOne(
      { key: 'chain' },
      { $set: { incident: { fingerprint: '', reason: '', brokenAt: -1, raisedAt: 0 } } },
      { upsert: true }
    ).catch((err) => console.error('[chain] could not clear the incident record:', err.message));
    Promise.resolve()
      .then(() => alerting().notifyChainRecovered(resolved))
      .catch((err) => console.error('[chain] recovery notice failed:', err.message));
    return resolved;
  }

  /**
   * Compare a freshly-walked tip against the high-water mark.
   *
   * This is the check that catches the one attack a self-consistent re-hash
   * cannot hide: deleting the tail. Every other invariant still holds on a
   * truncated chain — the hashes link, the difficulty is met, the transactions
   * re-derive — so nothing else in the verifier would ever notice that the
   * chain is now 500 blocks shorter than it was an hour ago.
   */
  checkHighWater(tipIndex, tipHash) {
    const sealed = this.sealed;
    if (!sealed || sealed.index < 0) return null;
    if (tipIndex < sealed.index) {
      return {
        valid: false,
        reason: `chain truncated: tip is at block ${tipIndex} but block ${sealed.index} was previously proven (${sealed.hash.slice(0, 12)}…)`,
        brokenAt: tipIndex + 1,
        kind: 'truncation',
      };
    }
    // Same height, different hash = the tip block itself was replaced. An
    // append-only chain cannot produce this; only a rewrite can.
    if (tipIndex === sealed.index && tipHash && sealed.hash && tipHash !== sealed.hash) {
      return {
        valid: false,
        reason: `tip block ${tipIndex} was rewritten: was ${sealed.hash.slice(0, 12)}…, now ${String(tipHash).slice(0, 12)}…`,
        brokenAt: tipIndex,
        kind: 'tip-rewrite',
      };
    }
    return null;
  }

  /** Advance the high-water mark. Only ever moves forward. */
  advanceSeal(index, hash) {
    if (index < 0) return;
    if (!this.sealed || index > this.sealed.index) {
      this.sealed = { index, hash: String(hash || '') };
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
    // The high-water mark only ever moves forward, and is written INSIDE the
    // same record the seal authenticates — so the two can never disagree.
    if (!this.sealed || cp.upTo > this.sealed.index) {
      this.sealed = { index: cp.upTo, hash: String(cp.prevHash || '') };
    }
    const record = {
      upTo: this.checkpoint.upTo,
      prevHash: this.checkpoint.prevHash,
      verifiedAt: this.verifiedAt,
      checked: this.verifiedChecked || cp.upTo + 1,
      sealed: this.sealed || { index: cp.upTo, hash: String(cp.prevHash || '') },
    };
    try {
      await ChainAudit.updateOne(
        { key: 'chain' },
        { $set: { ...record, seal: computeSeal(record) } },
        { upsert: true },
      );
    } catch (err) {
      // Best effort: an unwritable checkpoint degrades to the slower
      // re-walk-on-start behaviour, it must never fail a verification.
    }
  }

  // Append one or more txs as the next block. Serialized via the queue.
  // Returns { index, hash, txs:[txHash…] }.
  //
  // REFUSES while the chain is quarantined — see assertNotQuarantined. Appending
  // to a chain already known to be broken buries the corruption deeper on every
  // call and mints new proofs that inherit the defect.
  append(txs) {
    this.assertNotQuarantined();
    const list = (Array.isArray(txs) ? txs : [txs]).filter(Boolean);
    if (!list.length) {
      return Promise.reject(new Error('Nothing to append'));
    }
    const run = async () => {
      await this.init();
      const normalized = list.map(normalizeTx);
      const index = this.height + 1;
      const timestamp = Date.now();
      const v = commitVersionForNewBlocks();
      const header = { index, timestamp, prevHash: this.tip, txs: normalized };
      const { nonce, hash } = mineHeader(header);
      // `v` and `difficulty` are stored per block, not read from the environment
      // at verify time. A block has to keep verifying under the rules it was
      // actually mined under, so raising CHAIN_DIFFICULTY later cannot
      // retroactively mark months of history as broken.
      await Block.create({
        index, timestamp, prevHash: this.tip, nonce, hash, v, difficulty: DIFFICULTY, txs: normalized,
      });
      this.height = index;
      this.tip = hash;
      // The chain grew to a position no one has proven yet, so it becomes the new
      // high-water mark only once a check actually re-hashes it. Recording it
      // here would mean a block that was written but never verified still counts
      // as "proven", and would mask a truncation back to this point.
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
      // A structural break is located FIRST and quarantined on its own, because it is
      // the authoritative answer: walkChain returns the FIRST violation, so its
      // index is where the chain genuinely diverged. The high-water / disk-anchor
      // checks run afterwards and can only refine this — see quarantine() for why
      // they must never move the break later.
      const walked = this.walkChain(blocks);
      if (walked.reason) {
        // A broken chain invalidates the checkpoint: the prefix is no longer
        // known-good, so the incremental fast path must not build on it.
        this.checkpoint = null;
        // CONTAINMENT. Reporting the break is only half the job — the ledger
        // must also stop extending a chain it has just proven untrustworthy.
        this.quarantine({
          reason: walked.reason,
          brokenAt: walked.brokenAt,
          height: blocks.length - 1,
          kind: 'linkage',
        });
        this.raiseIncident({
          reason: walked.reason,
          brokenAt: walked.brokenAt,
          height: blocks.length - 1,
          checked: blocks.length,
        });
        return {
          valid: false,
          height: blocks.length - 1,
          brokenAt: walked.brokenAt,
          reason: walked.reason,
          kind: 'linkage',
          checked: blocks.length,
          difficulty: DIFFICULTY,
          notified: true,
          fullAuditAt: Date.now(),
        };
      }
      const tip = blocks.length ? blocks[blocks.length - 1] : null;
      const tipIndex = tip ? tip.index : -1;
      const tipHash = tip ? tip.hash : GENESIS_PREV_HASH;

      // Structurally clean — but it may still be SHORTER than the chain that was
      // last proven. Truncation satisfies every other invariant, so this is the
      // only check that can catch it.
      // Consulted even when walkChain already found a break: after a corrupted block
      // the tip will not match the host anchor either, and that is a CONSEQUENCE of
      // the corruption, not a second incident. quarantine() keeps the earlier
      // (structural) break point so repair does not discard the good blocks in
      // between — but `unrecoverable` is sticky, so a genuine truncation still
      // forces the "restore a backup" message.
      const truncated = this.checkHighWater(tipIndex, tipHash)
        || await this.checkDiskAnchor(tipIndex, tipHash);
      if (truncated) {
        // Only escalate to unrecoverable when the chain is STRUCTURALLY fine.
        // If the blocks themselves are broken, discarding them can restore
        // consistency, and telling an operator to restore a backup would be
        // wrong advice.
        const structurallyClean = !walked.reason;
        if (structurallyClean) {
          this.checkpoint = null;
          this.quarantine({
            reason: truncated.reason,
            brokenAt: truncated.brokenAt,
            height: tipIndex,
            // Nothing from here up can be re-verified — the missing blocks are the
            // evidence. Only a backup restore recovers them.
            unrecoverable: true,
            kind: truncated.kind,
          });
        }
        this.raiseIncident({
          reason: truncated.reason,
          brokenAt: truncated.brokenAt,
          height: tipIndex,
          checked: blocks.length,
        });
        return {
          ...truncated,
          checked: blocks.length,
          difficulty: DIFFICULTY,
          notified: true,
          fullAuditAt: Date.now(),
        };
      }

      const at = Date.now();
      await this.saveCheckpoint(
        { upTo: tipIndex, prevHash: tipHash },
        { verifiedAt: at, checked: blocks.length },
      );
      // Only now that this height has actually been re-hashed is it written to
      // the host anchor — so the file can only ever over-claim, never under-claim.
      await this.anchorHeadToDisk(tipIndex, tipHash);
      // Verified clean: close any open incident, so the audience that was warned
      // about a break also learns that it is over rather than living with a
      // permanent alarm in their inbox.
      this.clearIncident();
      return { valid: true, height: tipIndex, checked: blocks.length, difficulty: DIFFICULTY, fullAuditAt: at };
    })();
    const entry = { at: Date.now(), pending: true, settled: null, result: job };
    this.fullAudit = entry;
    job.then(
      (value) => { if (this.fullAudit === entry) { entry.at = Date.now(); entry.pending = false; entry.settled = value; } },
      () => { if (this.fullAudit === entry) this.fullAudit = null; },
    );
    return job;
  }

  /**
   * Re-hash an ordered block list end to end and report the FIRST break.
   *
   * Shared by the full audit and the incremental tail walk so the two can never
   * drift apart on what counts as valid — the failure mode where the cheap check
   * passes something the expensive one would have rejected.
   */
  walkChain(blocks, startIndex = 0, startPrev = GENESIS_PREV_HASH) {
    let prev = startPrev;
    for (let i = startIndex; i < blocks.length; i += 1) {
      const block = blocks[i];
      const reason = checkBlock(block, prev);
      if (reason) return { reason, brokenAt: block.index };
      prev = block.hash;
    }
    return { reason: null, brokenAt: -1, tip: prev };
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
    const walked = this.walkChain(blocks, 0, cp.prevHash);
    if (walked.reason) {
      this.checkpoint = null;
      // The break may predate the checkpoint, so a tail-only verdict could
      // point at the wrong block. Re-walk to report the true first break.
      return this.audit({ maxAgeMs: 0 });
    }
    const tip = blocks.length ? blocks[blocks.length - 1] : null;
    const height = tip ? tip.index : cp.upTo;

    // The tail re-hashed cleanly, but the chain as a whole may still be shorter
    // than the high-water mark — blocks can be deleted *below* the checkpoint,
    // where this walk never looks. Cheap to check, and it is the only thing that
    // sees a truncation the fast path is blind to.
    const truncated = this.checkHighWater(height, tip ? tip.hash : cp.prevHash)
      || await this.checkDiskAnchor(height, tip ? tip.hash : cp.prevHash);
    if (truncated) return this.audit({ maxAgeMs: 0 });

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
/**
   * Quarantine: refuse to extend a chain that is known to be broken.
   *
   * WHY THIS EXISTS
   * ---------------
   * Before it, a detected break changed nothing about how the ledger behaved. It
   * reported `valid:false`, notified everyone, and then carried on appending new
   * blocks on top of the corruption — a probe measured the chain growing from 7
   * blocks to 10 while `valid` stayed false. That is the worst of both worlds:
   *
   *   · the integrity record kept getting longer and therefore harder to reason
   *     about, with the broken block buried deeper on every append, and
   *   · every new reward, order and consent was anchored onto a chain already
   *     known to be untrustworthy, so those new proofs inherited the defect.
   *
   * A chain that cannot prove its own integrity must not be extended. Quarantine
   * is the containment step between "we detected this" and "an operator decides
   * what to do".
   *
   * WHY IT THROWS
   * -------------
   * Failing loudly is the point. The alternative — silently dropping the block —
   * would make callers believe they were anchored when they were not, and
   * `engine.anchor()` would return an empty txHash that looks like a success.
   * Throwing forces the anchor to be recorded as failed at every call site.
   *
   * Note this does NOT block the product. `engine.anchor()` catches and logs, and
   * balances and orders live in the database, so a quarantined chain degrades to
   * "no new proofs" rather than "feature offline". Users keep earning; only the
   * on-chain receipt is withheld, which is the honest state.
   */
  assertNotQuarantined() {
    if (!this.quarantined) return;
    const err = new Error(
      `Chain is quarantined after an integrity failure at block ${this.quarantined.brokenAt} `
      + `(${this.quarantined.reason}). New blocks are refused until the chain is repaired. `
      + 'Business operations are unaffected — this withholds on-chain proofs only.'
    );
    // A distinct code so callers can tell "the chain is unusable" apart from a
    // generic database failure, and so an operator-facing message can be precise.
    err.code = 'CHAIN_QUARANTINED';
    throw err;
  }

  /**
   * Enter quarantine. Idempotent, but NOT "first writer wins blindly".
   *
   * Two different checks can report the same underlying break: `walkChain`
   * (structural, e.g. a swapped hash) and `checkDiskAnchor` (the tip no longer
   * matches what this host sealed). When both fire, the second is a CONSEQUENCE of
   * the first, and its `unrecoverable` flag is what tells an operator that
   * discarding blocks will not help. Keeping whichever arrived first therefore
   * discarded the more informative verdict — the ledger reported "quarantined at
   * block 2, payload digest mismatch" for a break it had just located at block 3.
   *
   * So a later, more specific call may refine the existing record, while a later
   * one that is merely a re-statement of the same break leaves it alone.
   */
  quarantine({ reason, brokenAt, height, unrecoverable = false, kind = null }) {
    const incoming = { reason, brokenAt, height, unrecoverable, kind };
    if (this.quarantined) {
      const cur = this.quarantined;
      // Prefer the LATER (more downstream) break point and the more specific
      // reason: repair truncates from the break, and truncating too early would
      // discard blocks that were provably fine.
      // A structural break CASCADES: once block 3 is wrong, block 4's prevHash no
      // longer matches and block 11 reports "prevHash mismatch" too. Those
      // downstream reports are all true but they are all CONSEQUENCES, so taking
      // the highest index would quarantine at the tip and make repair discard the
      // eight good blocks between. The ORIGINAL structural break is the one that
      // matters: it is where the chain actually diverged.
      //
      // So: prefer the EARLIEST break point among structural (linkage) reports,
      // and let an `unrecoverable` (truncation) report take precedence, because
      // that one genuinely changes the recovery procedure.
      const sameClass = kind === cur.kind;
      const earlier = Number(brokenAt) < Number(cur.brokenAt);
      const sameSpot = Number(brokenAt) === Number(cur.brokenAt);

      if (unrecoverable || earlier || (sameSpot && sameClass)) {
        cur.reason = reason;
        cur.brokenAt = brokenAt;
        cur.kind = kind || cur.kind;
      }
      if (height != null) cur.height = height;
      cur.affectedBlocks = Math.max(0, (cur.height ?? -1) - Math.max(0, cur.brokenAt) + 1);
      // unrecoverable is sticky: once we know a backup restore is required, a
      // later structural check must not downgrade that to "just discard blocks".
      cur.unrecoverable = cur.unrecoverable || unrecoverable;
      return cur;
    }
    this.quarantined = {
      ...incoming,
      since: Date.now(),
      // Retained so /chain/status can tell an operator exactly what to inspect.
      affectedBlocks: Math.max(0, (height ?? -1) - Math.max(0, brokenAt) + 1),
    };
    console.error(
      `[chain] QUARANTINED at block ${brokenAt}: ${reason}. `
      + 'The ledger will refuse new blocks until it is repaired. '
      + 'The application keeps running; on-chain proofs are withheld.'
    );
    return this.quarantined;
  }

  /**
   * Repair a quarantined chain by discarding everything from the first broken
   * block onward, then re-anchoring the tip.
   *
   * WHAT IT DOES, AND WHY IT IS THE ONLY HONEST OPTION
   * --------------------------------------------------
   * A hash chain has no "fix the bad block" operation. Any edit to block N
   * changes its hash, which invalidates the `prevHash` recorded by N+1, which
   * invalidates N+1's hash, and so on to the tip. The only consistent chain
   * containing the still-valid prefix is the prefix itself — so repair means
   * truncating to the last provably-good block and continuing from there.
   *
   * This is NOT a silent reset. It never invents history and never starts a new
   * chain: the surviving prefix keeps its original blocks, hashes and genesis.
   * The discarded blocks are named in the returned report, persisted as a repair
   * record, and reported to the same audience that received the incident — so
   * "the chain broke and blocks 3-9 were discarded" is on the record, rather than
   * a quietly shorter chain that looks healthy.
   *
   * WHY IT IS NOT AUTOMATIC
   * ----------------------
   * Auto-repairing would be the single worst possible behaviour for an integrity
   * system: an attacker could corrupt a block and the system would helpfully
   * erase the evidence and re-verify itself clean. Repair is therefore always an
   * explicit operator decision.
   *
   * Never throws for a missing/invalid chain — it reports what it found so the
   * caller can render a decision.
   *
   * @param {object} opts
   * @param {string} opts.actor      who authorised it, recorded in the audit trail
   * @param {number} [opts.keepTo]   explicit truncate point; defaults to the last
   *                                 provably-good block
   */
  async repair({ actor = 'operator', keepTo = null } = {}) {
    // Serialized against appends, so no block can be written mid-repair.
    const job = this.queue.then(() => this._repair({ actor, keepTo }), () => this._repair({ actor, keepTo }));
    this.queue = job.catch(() => {});
    return job;
  }

  async _repair({ actor, keepTo }) {
    await this.init();
    const started = Date.now();

    const blocks = await Block.find({}).sort({ index: 1 }).lean();
    if (!blocks.length) {
      return { repaired: false, reason: 'no blocks to repair', actor, at: started };
    }

    // Re-walk to find the true first break rather than trusting the quarantine
    // record: the chain may have changed since it was raised.
    const walked = this.walkChain(blocks);

    // High-water / disk anchor: a truncation shows up as a shrunken tip rather
    // than a linkage error, so both must be consulted before concluding the
    // chain is clean.
    const tip = blocks[blocks.length - 1];
    const shortened = this.checkHighWater(tip.index, tip.hash)
      || await this.checkDiskAnchor(tip.index, tip.hash);

    let brokenAt = -1;
    let why = null;
    if (walked.reason) {
      brokenAt = walked.brokenAt;
      why = walked.reason;
    } else if (shortened) {
      brokenAt = shortened.brokenAt;
      why = shortened.reason;
    }

    if (brokenAt < 0) {
      // Nothing is actually broken. Clearing quarantine here is the correct
      // response to a false alarm — e.g. a transient read that looked like a
      // break — rather than truncating a healthy chain.
      const cleared = this.clearQuarantine();
      if (cleared) {
        console.log('[chain] repair found no actual break — quarantine lifted, nothing discarded.');
        this.checkpoint = null;
        const v = await this.audit({ maxAgeMs: 0 });
        await writeRepairRecord({
          kind: 'quarantine-lifted',
          actor,
          reason: 'no break found on re-verification; nothing was discarded',
          healthyAfter: v.valid === true,
        });
        return { repaired: false, reason: 'no break found; quarantine lifted', actor, at: started, verdict: v };
      }
      return { repaired: false, reason: 'chain is already healthy', actor, at: started };
    }

    // An explicit keepTo may not exceed the last provably-good block: letting a
    // caller name a HIGHER point would let a repair "heal" a break by keeping the
    // corrupt blocks, which is exactly what repair must never do.
    const lastGood = brokenAt - 1;
    if (keepTo != null && Number(keepTo) > lastGood) {
      return {
        repaired: false,
        actor,
        at: started,
        reason: `refused: keepTo=${keepTo} is past the last provably-good block (${lastGood}). `
          + 'Repair may only discard blocks, never keep a broken one.',
      };
    }
    const target = keepTo != null ? Math.min(Number(keepTo), lastGood) : lastGood;

    // How the break was detected, named once so the report and the repair log
    // agree. Truncation is called out separately because it is the one failure a
    // repair cannot undo.
    const failureKind = shortened && !walked.reason ? 'truncation' : 'linkage';

    // Capture what is about to be discarded BEFORE deleting it, so the repair
    // report can name every block that existed only in the corrupted region.
    const discarded = blocks.filter((b) => b.index > target);
    const summary = discarded.map((b) => ({
      index: b.index,
      hash: b.hash,
      txCount: (b.txs || []).length,
      txTypes: [...new Set((b.txs || []).map((t) => t.type))],
    }));

    let deleted = 0;
    try {
      const res = await Block.deleteMany({ index: { $gt: target } });
      deleted = res.deletedCount || 0;
    } catch (err) {
      return { repaired: false, reason: `could not discard blocks: ${err.message}`, actor, at: started };
    }

    // Re-anchor in-memory state to the surviving tip, then prove the result.
    const survivor = target >= 0 ? await Block.findOne({ index: target }).lean() : null;
    this.height = survivor ? survivor.index : -1;
    this.tip = survivor ? survivor.hash : GENESIS_PREV_HASH;
    this.checkpoint = null;
    this.verifiedAt = null;
    this.verifiedChecked = 0;
    this.verifyCache = null;
    this.fullAudit = null;
    // The high-water mark claimed a height that no longer exists. Resetting it is
    // what lets the repaired chain verify; the REPAIR RECORD below is what keeps
    // the fact that it once reached that height from being erased.
    this.sealed = null;
    this.diskAnchored = null;

    const verdict = await this.audit({ maxAgeMs: 0 });
    const healthy = verdict.valid === true;

    // Permanent record, written whether the repair worked or not. A failed repair
    // is exactly the case where an operator most needs the history.
    await writeRepairRecord({
      kind: healthy ? 'repair' : 'repair-failed',
      actor,
      brokenAt,
      reason: why,
      failureKind,
      keptThrough: target,
      discardedCount: deleted,
      discardedIndexes: summary.map((b) => b.index),
      healthyAfter: healthy,
      durationMs: Date.now() - started,
      // One record per distinct break point: clicking repair twice does not
      // produce two audit entries for one incident.
      dedupeKey: `repair:${brokenAt}:${target}`,
    });
    // Held in memory so clearIncident() (called by the audit below) can tell the
    // recovery notice that blocks were discarded.
    this.lastRepair = healthy
      ? { discardedCount: deleted, keptThrough: target }
      : null;

    if (healthy) {
      this.clearQuarantine();
      console.log(
        `[chain] REPAIRED by ${actor}: discarded ${deleted} block(s) above #${target} `
        + `(first break at #${brokenAt}: ${why}). Chain verified healthy at height ${verdict.height}.`
      );
    } else {
      console.error(
        `[chain] repair by ${actor} did NOT restore integrity: still broken at #${verdict.brokenAt} `
        + `(${verdict.reason}). Quarantine remains in force.`
      );
    }

    return {
      repaired: healthy,
      actor,
      at: started,
      durationMs: Date.now() - started,
      firstBreak: { index: brokenAt, reason: why, kind: failureKind },
      keptThrough: target,
      discardedBlocks: deleted,
      // `summary`, not the raw `discarded` docs: the raw lean documents come back
      // through Mongoose with `txs` stripped to a count, so a report built from
      // them showed `undefined` for every transaction. The summary is captured
      // before deletion and is what an operator actually reads.
      discarded: summary,
      verdict,
    };
  }

  /** Clear quarantine — only ever called by repair() after a full re-verify. */
  clearQuarantine() {
    const was = this.quarantined;
    this.quarantined = null;
    return was;
  }

  /** The last height that verified cleanly, or -1. Read by repair(). */
  lastGoodIndex() {
    if (!this.quarantined) return this.height;
    return this.quarantined.brokenAt - 1;
  }

}

module.exports = new Ledger();
module.exports.headerHash = headerHash;
module.exports.normalizeTx = normalizeTx;
module.exports.checkBlock = checkBlock;
module.exports.checkTx = checkTx;
module.exports.DIFFICULTY = DIFFICULTY;
module.exports.COMMIT_V2 = COMMIT_V2;
module.exports.commitVersionOf = commitVersionOf;
module.exports.commitVersionForNewBlocks = commitVersionForNewBlocks;
module.exports.GENESIS_PREV_HASH = GENESIS_PREV_HASH;
module.exports.verifySeal = verifySeal;
module.exports.computeSeal = computeSeal;
module.exports.sealPayload = sealPayload;
module.exports.sealAvailable = sealAvailable;
module.exports.VERIFY_PROJECTION = VERIFY_PROJECTION;
module.exports.FULL_AUDIT_INTERVAL_MS = FULL_AUDIT_INTERVAL_MS;
