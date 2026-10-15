// ═══════════════════════════════════════════════════════════════════════════
// CHAIN TAMPER ATTACK HARNESS — SuppliWise blockchain layer.
//
// WHAT THIS DOES
// --------------
// Builds a real PoW chain with the real `blockchain/ledger.js` inside a
// throwaway database, then runs a catalogue of tamper attacks against the
// STORED blocks and asks the ledger's own verifier what it thinks.
//
// The question under test is exactly the product claim: "alter the hashes, the
// chain breaks, everybody finds out." So every attack below ends with the same
// question — did `audit()` / `verify()` notice?
//
//   DETECTED     the verifier returned valid:false / brokenAt  -> claim holds
//   UNDETECTED   the verifier still said valid:true            -> CLAIM FAILS
//
// ISOLATION
// ---------
// Runs against its OWN database (CHAIN_ATTACK_DB, default
// `sw_chaintamper_test`), derived from MONGO_URI so credentials/host are reused
// but the database name is replaced. The application's own database is never
// opened. The scratch database is dropped on exit unless KEEP_CHAIN_ATTACK_DB=1.
//
// Usage:  node chain-tamper-harness.js
// Exit 0 = every attack was detected AND every alert fired.
// Exit 2 = at least one attack went undetected (the claim is false).
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const SCRATCH_DB = process.env.CHAIN_ATTACK_DB || 'sw_chaintamper_test';
const CHAIN_LENGTH = Number(process.env.CHAIN_ATTACK_LENGTH) || 10;
const KEEP = process.env.KEEP_CHAIN_ATTACK_DB === '1';

/** Reuse the app's credentials/host, but point at our own database. */
function scratchUri() {
  const base = String(process.env.MONGO_URI || '');
  const m = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/.exec(base);
  if (!m) throw new Error('Cannot derive a scratch database URI from MONGO_URI.');
  return `${m[1]}/${SCRATCH_DB}${m[3] || ''}`;
}

const results = [];
let passed = 0;

// The host head anchor is SHARED state between the harness and the ledger, and
// the harness drops it between cases. Without this, running the harness would
// leave a stale anchor behind that the real server would later read as proof of
// a height this scratch chain never had — a false alarm in production caused by
// a test. Restored verbatim on the way out.
//
// The filename MUST match ledger.js exactly. The ledger derives it from the
// RESOLVED database name (from the live connection), because MONGO_URI carries no
// database in its path and keying on the URI gave every database on a cluster the
// same file. When the two disagreed the harness cleared a file the ledger never
// wrote, so a stale anchor from the previous run survived — and a freshly built,
// perfectly valid chain was reported as "tip rewritten" against a hash it had
// never had.
const ANCHOR_FILE = () => {
  const { sha256Hex } = require('./blockchain/crypto');
  return path.join(
    __dirname, 'uploads',
    `.chain-head.${sha256Hex(SCRATCH_DB).slice(0, 12)}.anchor`
  );
};

const ANCHOR_BACKUP = (() => {
  try { return fs.readFileSync(ANCHOR_FILE(), 'utf8'); }
  catch { return null; }
})();

function restoreDiskAnchor() {
  try {
    if (ANCHOR_BACKUP === null) fs.unlinkSync(ANCHOR_FILE());
    else fs.writeFileSync(ANCHOR_FILE(), ANCHOR_BACKUP, 'utf8');
  } catch { /* best effort */ }
}

function record(id, name, detected, detail) {
  results.push({ id, name, detected, detail });
  if (detected) passed += 1;
  const tag = detected ? '  DETECTED  ' : 'UNDETECTED  ';
  console.log(`  [${tag}] ${id.padEnd(5)} ${name}`);
  if (detail) console.log(`             ${detail}`);
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 66 - title.length))}`);
}

// ── Ledger singleton reset ────────────────────────────────────────────────
let ledger;
let Block;
let ChainAudit;
let ChainRepair;
let anchor;
let UserNotification;
let AdminEvent;
let crypto;

function resetLedgerSingleton() {
  ledger.height = -1;
  ledger.tip = '0'.repeat(64);
  ledger.checkpoint = null;
  ledger.verifiedAt = null;
  ledger.verifiedChecked = 0;
  ledger.verifyCache = null;
  ledger.fullAudit = null;
  ledger.initPromise = null;
  ledger.queue = Promise.resolve();
  // The high-water mark is in-memory state too. Resetting it between attacks is
  // what makes each case independent: leaving block N's high-water in place
  // would let the NEXT attack trip the truncation check for the wrong reason and
  // report a pass that the ledger had not actually earned.
  ledger.sealed = null;
  ledger.sealCompromised = false;
  // `unsealedWarned` is a once-only log guard on the instance and would
  // otherwise suppress the log line that proves the unsealed-checkpoint path ran.
  ledger.unsealedWarned = false;
  ledger.incident = null;
  // The untrusted mark and the chain-cycle counter are in-memory state too, and
  // mattering about them differently is how this harness used to be wrong:
  // leaving a stale `quarantined` behind made the NEXT case re-sync from an old
  // break point, and leaving a stale `cycle` behind made the recovery cases
  // report a chain "restarted into cycle 0".
  ledger.quarantined = null;
  ledger.lastRepair = null;
  ledger.cycle = 0;
  ledger.resyncing = false;
  ledger.lastResync = null;
  ledger.watchdogTimer = null;
  // The host-filesystem head anchor is process state too. Each attack case must
  // start from the same baseline, or a case would trip the PREVIOUS case's
  // anchor and be scored as detected for the wrong reason.
  ledger.diskAnchored = null;
  ledger.diskAnchorWarned = false;
  // Each attack case starts from a clean host anchor, so a case can never be
  // scored as detected on the strength of the PREVIOUS case's evidence.
  try { fs.unlinkSync(ANCHOR_FILE()); } catch { /* not written yet */ }
}

/** Deep-clone every block so an attack can be rolled back exactly. */
async function snapshot() {
  return Block.find({}).sort({ index: 1 }).lean();
}

async function restore(snap) {
  await Block.deleteMany({});
  await ChainAudit.deleteMany({});
  if (snap.length) await Block.insertMany(snap);
  // Re-establish a clean slate for the next case: no in-memory verdict, no
  // cached checkpoint, and no head anchor left over from this one.
  resetLedgerSingleton();
}

/**
 * Establish the baseline the next attack will be measured against.
 *
 * This is not cosmetic. Each attack starts by resetting state and then asking
 * for a verdict — and that verdict is what writes the high-water mark and the
 * host anchor. Without a verified verdict FIRST, the ledger has no record of how
 * tall the chain is supposed to be, so a truncation would have nothing to be
 * measured against and the case would be scored on the attack's merits alone
 * instead of "tamper a chain that was already proven good".
 */
async function armBaseline() {
  resetLedgerSingleton();
  const v = await verdict();
  if (v.full.valid === false || v.fast.valid === false) {
    throw new Error(`baseline chain does not verify (${v.fullSays} / ${v.fastSays}) — harness is broken`);
  }
  return v;
}

/**
 * Ask the request-path verifier ONLY, from a cold start.
 *
 * Used for the checkpoint-forgery case. It deliberately does NOT run the deep
 * audit first: a full re-hash re-derives the truth from the blocks and rewrites
 * a correct checkpoint, which would erase the forgery before it was ever tested
 * and score the case as a pass for the wrong reason. The realistic attack is a
 * forged checkpoint sitting in the database when the server starts, so that is
 * exactly the situation reproduced here.
 */
async function coldStartVerdict() {
  resetLedgerSingleton();
  await ledger.init();
  const fast = await ledger.verify({ maxAgeMs: 0 });
  return { fast, sealCompromised: ledger.sealCompromised === true };
}

/** Ask BOTH verifiers, freshly, and summarise. Never trust the caches. */
async function verdict() {
  // Force a full whole-chain re-hash (maxAgeMs:0 defeats the 5-minute memo).
  const full = await ledger.audit({ maxAgeMs: 0 });
  // And the request-path incremental check the monitor/UI actually calls.
  resetLedgerSingleton();
  await ledger.init();
  const fast = await ledger.verify({ maxAgeMs: 0 });
  const sealCompromised = ledger.sealCompromised === true;
  return {
    full,
    fast,
    sealCompromised,
    // "Detected" means EITHER verifier refused the chain.
    detected: full.valid === false || fast.valid === false,
    fullSays: full.valid === false ? `broken@${full.brokenAt} (${full.reason})` : 'valid:true',
    fastSays: fast.valid === false ? 'valid:false' : 'valid:true',
  };
}

// ── Attack implementations ────────────────────────────────────────────────
// Each mutates the stored block documents directly — i.e. exactly what an
// attacker with database write access (a leaked credential, an over-broad
// Atlas role, a bad migration script) can do.

/** A1..A4: rewrite a field of a tx INSIDE an already-mined block. */
async function editTxField(field, value) {
  const target = await Block.findOne({ index: { $gte: 2 } }).sort({ index: 1 }).lean();
  const txIdx = 0;
  await Block.updateOne(
    { index: target.index },
    { $set: { [`txs.${txIdx}.${field}`]: value } }
  );
  return `block ${target.index}, txs[0].${field} := ${JSON.stringify(value).slice(0, 70)}`;
}

/** A5: swap a stored hash for a different (still well-formed) one. */
async function swapHash() {
  const target = await Block.findOne({ index: { $gte: 2 } }).sort({ index: 1 }).lean();
  await Block.updateOne({ index: target.index }, { $set: { hash: 'a'.repeat(64) } });
  return `block ${target.index}.hash := "aaaa…"`;
}

/** A6: delete a block from the middle (omission). */
async function deleteMiddle() {
  const target = await Block.findOne({ index: { $gte: 2 } }).sort({ index: 1 }).lean();
  await Block.deleteOne({ index: target.index });
  return `deleted block ${target.index}`;
}

/**
 * A7: truncate the whole tail.
 *
 * Two variants, because they are genuinely different attacks:
 *   keepAudit — delete only the blocks. The sealed checkpoint survives and names
 *               the missing height, so the database itself is enough to catch it.
 *   wipeAudit  — delete the blocks AND the checkpoint row. Nothing left in
 *               MongoDB remembers the chain was ever longer. This is the one
 *               that needs the host-filesystem anchor, and it is the reason the
 *               anchor exists at all.
 */
async function truncateTail({ wipeAudit = false } = {}) {
  const tip = await Block.findOne({}).sort({ index: -1 }).lean();
  const cut = tip.index - 2;
  const res = await Block.deleteMany({ index: { $gte: cut } });
  if (wipeAudit) await ChainAudit.deleteMany({});
  return `dropped the last ${res.deletedCount} block(s); tip ${tip.index} -> ${cut - 1}`
    + (wipeAudit ? ' AND deleted the checkpoint record' : '');
}

/** A8: replay — duplicate an existing block at a fresh index (unique index). */
async function replayBlock() {
  const src = await Block.findOne({ index: 1 }).lean();
  const tip = await Block.findOne({}).sort({ index: -1 }).lean();
  let outcome = 'inserted';
  try {
    await Block.create({ ...src, index: tip.index + 1, _id: undefined });
  } catch (err) {
    outcome = `rejected by the unique index (code ${err.code})`;
  }
  return `replayed block 1 as block ${tip.index + 1} — ${outcome}`;
}

/**
 * Mine a header exactly the way the ledger does.
 *
 * MUST call the ledger's own `headerHash`, not a re-implementation: the header
 * commits to `txPart` (the joined txHash list), NOT to the `txs` array itself.
 * An earlier version of this harness re-hashed `{...header, nonce}`, which is a
 * different preimage, so every re-mined block came out with a hash the ledger
 * rejected — and the attack was reported as "detected" when the only thing that
 * detected it was the harness's own arithmetic error.
 */
function mineTheWayTheLedgerDoes(header) {
  for (let nonce = 0; ; nonce += 1) {
    const hash = ledger.headerHash({ ...header, nonce });
    if (hash.startsWith('0'.repeat(ledger.difficulty))) return { nonce, hash };
  }
}

/** A9: full self-consistent re-mine of everything from block N on. */
async function remineFrom(startIndex) {
  const blocks = await Block.find({ index: { $gte: startIndex } }).sort({ index: 1 }).lean();
  const before = await Block.findOne({ index: startIndex - 1 }).lean();
  let prev = before ? before.hash : '0'.repeat(64);
  for (const b of blocks) {
    // The attacker rewrites the payload AND re-mines a fresh, perfectly valid
    // PoW hash, then re-links every later block onto it. The result is a chain
    // that is internally flawless by every rule the ledger can check.
    const dataHash = crypto.hashPayload({ forged: true });
    const forgedTx = {
      txHash: crypto.sha256Hex(crypto.stableStringify({
        type: 'forged', actor: 'attacker', dataHash, timestamp: b.timestamp,
      })),
      type: 'forged',
      actor: 'attacker',
      data: { forged: true },
      dataHash,
      timestamp: b.timestamp,
    };
    const header = { index: b.index, timestamp: b.timestamp, prevHash: prev, txs: [forgedTx] };
    const { nonce, hash } = mineTheWayTheLedgerDoes(header);
    await Block.updateOne(
      { index: b.index },
      { $set: { prevHash: header.prevHash, nonce, hash, txs: [forgedTx] } }
    );
    prev = hash;
  }
  await ChainAudit.deleteMany({});
  return `re-wrote + re-mined ${blocks.length} block(s) from index ${startIndex} with forged txs`;
}

/** A10: insert a block with valid PoW but a wrong prevHash (fork). */
async function forkInsert() {
  const tip = await Block.findOne({}).sort({ index: -1 }).lean();
  const tx = {
    txHash: crypto.sha256Hex('fork'),
    type: 'fork',
    actor: 'attacker',
    data: null,
    dataHash: crypto.hashPayload(null),
    timestamp: Date.now(),
  };
  const header = { index: tip.index + 1, timestamp: Date.now(), prevHash: 'b'.repeat(64), txs: [tx] };
  const { nonce, hash } = mineTheWayTheLedgerDoes(header);
  let outcome = 'inserted';
  try {
    await Block.create({ ...header, nonce, hash });
  } catch (err) {
    outcome = `rejected (code ${err.code})`;
  }
  return `forked block ${tip.index + 1} onto a bogus prevHash — ${outcome}`;
}

/** A11: strip every tx out of a block, leaving the header hash untouched. */
async function stripTxs() {
  const target = await Block.findOne({ index: { $gte: 2 } }).sort({ index: 1 }).lean();
  await Block.updateOne({ index: target.index }, { $set: { txs: [] } });
  return `emptied txs[] on block ${target.index}`;
}

/**
 * C5: forge the persisted checkpoint so the fast path skips the whole chain.
 *
 * The attacker has no idea what the seal key is — that is the point of a seal.
 * They write a checkpoint that CLAIMS the tip is verified, with no proof behind
 * it. The only correct answer is for the ledger to refuse the claim and re-hash.
 */
async function forgeCheckpoint() {
  const tip = await Block.findOne({}).sort({ index: -1 }).lean();
  await ChainAudit.updateOne(
    { key: 'chain' },
    {
      $set: {
        upTo: tip.index,
        prevHash: tip.hash,
        verifiedAt: new Date(),
        checked: tip.index + 1,
        seal: 'f'.repeat(64), // plausible-looking, meaningless signature
      },
    },
    { upsert: true }
  );
  return `checkpoint forged to "verified up to ${tip.index}" carrying a bogus seal`;
}

/**
 * C6: the full-strength version — rewrite the tail AND forge the checkpoint that
 * claims to cover it, so the fast path, the high-water mark and the deep audit
 * are all fed the attacker's story. This is the attack the seal exists for.
 */
async function forgeCheckpointAndRewriteTail() {
  const before = await Block.findOne({}).sort({ index: -1 }).lean();
  const a = await remineFrom(2);
  const b = await forgeCheckpoint();
  return `${a}; ${b} (genuine tip was ${before.index}/${String(before.hash).slice(0, 12)}...)`;
}

/** A13: non-monotonic timestamps — block N older than block N-1. */
async function rewindTimestamps() {
  const target = await Block.findOne({ index: { $gte: 2 } }).sort({ index: 1 }).lean();
  await Block.updateOne({ index: target.index }, { $set: { timestamp: target.timestamp - 10 * 86400000 } });
  return `block ${target.index}.timestamp moved back 10 days`;
}

async function main() {
  console.log('═'.repeat(70));
  console.log('CHAIN TAMPER ATTACK HARNESS — SuppliWise blockchain layer');
  console.log('═'.repeat(70));

  await mongoose.connect(scratchUri(), { serverSelectionTimeoutMS: 10000 });
  console.log(`scratch database : ${SCRATCH_DB}`);
  console.log(`cluster         : ${mongoose.connection.host}`);
  console.log(`head anchor     : ${path.basename(ANCHOR_FILE())} (per-database, so production is untouched)`);

  // Models + ledger AFTER connect, so they bind to the scratch database.
  ({ Block, ChainAudit, ChainRepair } = require('./models/Web3'));
  UserNotification = require('./models/UserNotification');
  AdminEvent = require('./models/AdminEvent');
  crypto = require('./blockchain/crypto');
  ledger = require('./blockchain/ledger');
  // The REAL anchoring path, not a raw ledger.append: this is what a reward, an
  // order, a consent and a vote all go through, and `engine.anchor()` is what
  // used to quietly return an empty transaction hash while the chain refused
  // writes. Asserting on it is the only way to catch a regression at the layer
  // users actually touch.
  anchor = require('./blockchain/engine').anchor;

  await mongoose.connection.dropDatabase();
  // Start with NO anchor. The anchor is keyed on the resolved database name, so
  // this scratch chain has its own file — but it still carries over from the
  // previous run, and a leftover anchor would immediately condemn the chain we are
  // about to build.
  try { fs.unlinkSync(ANCHOR_FILE()); } catch { /* none yet */ }

  // ── Build a real chain ──────────────────────────────────────────────────
  section('Building a real PoW chain');
  resetLedgerSingleton();
  await ledger.init();
  for (let i = 0; i < CHAIN_LENGTH; i += 1) {
    await ledger.append([{
      type: 'test:anchor',
      actor: `0xtest${i}`,
      data: { i, note: 'legitimate block' },
    }]);
  }
  const clean = await verdict();
  console.log(`  built ${CHAIN_LENGTH + 1} block(s) · difficulty ${ledger.difficulty}`);
  console.log(`  baseline: full-audit says ${clean.fullSays}, fast-path says ${clean.fastSays}`);
  if (clean.full.valid === false || clean.fast.valid === false) {
    console.log('  ✗ the harness itself is broken: a freshly built chain must verify clean.');
  }

  const baseline = await snapshot();

  // ── Attacks ─────────────────────────────────────────────────────────────
  section('A. Editing a transaction payload already inside a sealed block');
  for (const [id, name, field, value] of [
    ['A1', 'Rewrite txs[].data (the actual payload)', 'data', { i: 999, note: 'PAYLOAD REWRITTEN' }],
    ['A2', 'Rewrite txs[].type', 'type', 'forged:type'],
    ['A3', 'Rewrite txs[].actor', 'actor', '0xattacker'],
    ['A4', 'Rewrite txs[].timestamp', 'timestamp', 1],
    ['A5', 'Rewrite txs[].dataHash (the "privacy digest")', 'dataHash', 'f'.repeat(64)],
  ]) {
    await restore(baseline);
    await armBaseline();
    const how = await editTxField(field, value);
    const v = await verdict();
    record(id, name, v.detected, `after ${how}\n             full-audit: ${v.fullSays} · fast-path: ${v.fastSays}`);
  }

  section('B. Attacking the block headers themselves');
  for (const [id, name, fn] of [
    ['B1', 'Swap a stored block hash', swapHash],
    ['B2', 'Delete a block from the middle', deleteMiddle],
    ['B3', 'Strip every tx out of a block, header untouched', stripTxs],
    ['B4', 'Move a block timestamp backwards', rewindTimestamps],
  ]) {
    await restore(baseline);
    await armBaseline();
    const how = await fn();
    const v = await verdict();
    record(id, name, v.detected, `after ${how}\n             full-audit: ${v.fullSays} · fast-path: ${v.fastSays}`);
  }

  section('C. Attacks that keep the chain internally consistent');
  // The optional 4th element `mode` selects special grading (see C5 below);
  // absent elements destructure to undefined rather than throwing.
  for (const [id, name, fn, mode] of [
    ['C1', 'Truncate the tail (chain gets shorter, still perfectly linked)', () => truncateTail()],
    ['C1b', 'Truncate the tail AND delete the checkpoint record', () => truncateTail({ wipeAudit: true })],
    ['C2', 'Replay an old block at a new index', replayBlock],
    ['C3', 'Insert a forked block with valid PoW but a bogus prevHash', forkInsert],
    ['C4', 'Re-mine the whole tail with forged transactions', () => remineFrom(2)],
    // C5 is graded on a DIFFERENT property, and the reason matters.
    //
    // Every other case asks "did the chain get reported as broken?". C5 cannot
    // ask that: it forges a checkpoint WITHOUT touching a single block, so the
    // history is genuinely intact and the honest answer IS "valid". Grading it
    // on a broken verdict would be wrong.
    //
    // What must never happen is the forged claim being TRUSTED — that is, the
    // fast path skipping verification because a bare database row said "already
    // verified". So this asserts the seal rejected the forgery and the ledger
    // fell back to a full re-hash from genesis. C6 then applies the same forgery
    // to a genuinely rewritten tail, where the only correct answer is "broken".
    ['C5', 'Forge the persisted checkpoint to skip verification', forgeCheckpoint, 'sealRejected'],
    // C6 keeps the same grading: the checkpoint was forged, so "was the claim
    // believed?" is the question — and here the blocks WERE rewritten, so the
    // correct answer is additionally that the chain reports itself broken.
    ['C6', 'Rewrite the tail AND forge the checkpoint covering it', forgeCheckpointAndRewriteTail, 'sealRejected'],
  ]) {
    await restore(baseline);
    await armBaseline();
    const how = await fn();

    if (mode === 'sealRejected') {
      // Cold start only — see coldStartVerdict. The claim must be refused AND the
      // fallback must actually re-hash, otherwise a rejected seal that then took
      // some other shortcut would be the same bug in a different hat.
      const cold = await coldStartVerdict();
      const rejected = cold.sealCompromised === true;
      const rewalked = cold.fast.pending === true || (cold.fast.checked || 0) >= CHAIN_LENGTH;
      // For C5 the blocks are untouched, so valid:true is correct. For C6 they
      // were rewritten, so valid:false is the only acceptable answer. Both must
      // reject the forged claim and re-hash from genesis.
      const blocksUntouched = mode === 'sealRejected' && id === 'C5';
      const rightVerdict = blocksUntouched
        ? cold.fast.valid === true
        : cold.fast.valid === false;
      record(id, name, rejected && rewalked && rightVerdict,
        `after ${how}\n             forged claim ${rejected ? 'REJECTED (seal did not verify)' : 'was TRUSTED'} · `
        + `fast path reported ${cold.fast.valid ? 'valid:true' : 'valid:false'} after checking ${cold.fast.checked} of ${CHAIN_LENGTH + 1} block(s)`
        + `\n             note: ${blocksUntouched
          ? 'no block was touched, so valid:true is the CORRECT integrity verdict here'
          : 'blocks WERE rewritten, so valid:false is the only acceptable verdict'} — `
        + `what matters is that the unsupported "already verified" claim was not believed.`);
      continue;
    }

    const v = await verdict();
    record(id, name, v.detected, `after ${how}\n             full-audit: ${v.fullSays} · fast-path: ${v.fastSays}`);
  }

  // ── E. Containment & recovery ────────────────────────────────────────────
  // Detection alone is not enough. These check that a detected break is never
  // built ON TOP OF, that the product keeps working and stays fully receipted
  // throughout, that the ledger recovers on its own, repeatedly, and that an
  // operator can still do it by hand without losing the record of what happened.
  section('E. Containment and recovery after a break');
  await restore(baseline);
  await armBaseline();

  const heightBefore = await Block.findOne({}).sort({ index: -1 }).lean();
  await Block.updateOne({ index: 3 }, { $set: { hash: 'c'.repeat(64) } });
  const broken = await verdict();

  // Assert the break point too, not just the flag. A related defect was seen here:
  // a second detector re-reported the SAME break at an earlier index and, because
  // quarantine was first-writer-wins, the ledger reported block 2 for a break it
  // had located at block 3 — which would make the re-sync discard a good block.
  const q1 = ledger.quarantined;
  record('E1', 'A detected break marks the chain untrusted at the CORRECT block',
    q1 !== null && q1.brokenAt === 3,
    `verdict ${broken.fullSays} · untrusted=${!!q1} at brokenAt=${q1 && q1.brokenAt} (expected 3), last good #${ledger.lastGoodIndex()}`);

  // The critical containment property: the corruption must not get buried under
  // new blocks. Before this, appends after a break were REFUSED outright, which
  // buried nothing but also receipted nothing — every reward, order and consent
  // made in that window silently came back without an on-chain hash. Now the
  // transaction is accepted AND the corrupt block is gone: not one, not the
  // other. Run through `engine.anchor()`, the real path.
  let anchorErr = null;
  let receipt = null;
  try {
    receipt = await anchor('test:after-break', '0xtest', { public: { amount: 1 } });
  } catch (err) { anchorErr = err.code || err.message; }
  const corruptStillThere = await Block.countDocuments({ hash: 'c'.repeat(64) });
  record('E2', 'A transaction during a break is accepted AND the corrupt block is discarded',
    !anchorErr && !!receipt && !!receipt.txs[0] && receipt.txs[0].length === 64 && corruptStillThere === 0,
    anchorErr
      ? `anchor THREW (${anchorErr}) — would break the business operation`
      : `anchor returned index=${receipt.index} txHash="${String(receipt.txs[0]).slice(0, 12)}…"`
        + ` · block(s) still holding the forged hash: ${corruptStillThere}`);

  // The transaction must land on a chain that verifies — never on the corruption.
  const afterResync = await ledger.audit({ maxAgeMs: 0 });
  record('E3', 'The chain recovers by itself and verifies from genesis again',
    afterResync.valid === true && ledger.quarantined === null,
    `full re-audit: valid=${afterResync.valid} at height ${afterResync.height}`
    + `${afterResync.reason ? ` (${afterResync.reason})` : ''} · still untrusted: ${!!ledger.quarantined}`);

  // And it must be a NEW, independently verified chain segment — not a silent
  // continuation, and not a second genesis.
  const segment = await Block.findOne({ 'txs.type': 'chain:resync' }).lean();
  const segData = segment ? ((segment.txs[0] || {}).data || {}) : {};
  record('E4', 'A fresh chain segment is opened and commits to what was discarded',
    !!segment && ledger.cycle >= 1 && Number(segData.discardedBlocks) > 0,
    segment
      ? `segment #${segment.index}, cycle ${segData.cycle}, discarding ${segData.discardedBlocks} block(s) from #${segData.brokenAt}`
      : 'no chain:resync block found');

  // Operator repair, on a chain that ALREADY recovered once. The host anchor file
  // is append-only and used to be never rewound, so a chain that had once been
  // healthy could not be repaired at all and stayed broken forever — the single
  // worst outcome available. Re-break it first, so this exercises the rewind
  // rather than the healthy-chain no-op.
  await Block.updateOne({ index: 1 }, { $set: { hash: 'b'.repeat(64) } });
  await ledger.audit({ maxAgeMs: 0 });
  const repair = await ledger.repair({ actor: 'harness-operator', resync: true });
  record('E5', 'An operator repair succeeds on a chain that already recovered once',
    repair.repaired === true && !!repair.verdict && repair.verdict.valid === true,
    `repaired=${repair.repaired} keptThrough=#${repair.keptThrough} discarded=${repair.discardedBlocks}`
    + `${repair.reason ? ` · ${repair.reason}` : ''}${repair.verdict ? ` · valid=${repair.verdict.valid}` : ''}`);

  record('E6', 'Repair names every discarded block (evidence is reported, not hidden)',
    Array.isArray(repair.discarded) && repair.discarded.length === repair.discardedBlocks
      && repair.discarded.every((b) => b.hash && Number.isInteger(b.index)),
    repair.discarded ? repair.discarded.map((b) => `#${b.index}(${b.txCount}tx)`).join(' ') : 'none');

  // The "continuous cycle" requirement: several breaks in a row must each
  // recover, each must start a new chain segment, and each transaction during
  // them must still be receipted. Block 1 is the target every time because it is
  // always the first non-genesis block (an anchor block or a re-sync segment) —
  // so the target cannot drift as the chain gets shorter, which is what made an
  // earlier version of this case report "STILL BROKEN" for the wrong reason.
  let cycles = ledger.cycle;
  let allRecovered = true;
  const cycleDetail = [];
  for (let n = 0; n < 3; n += 1) {
    const target = await Block.findOne({ index: 1 }).lean();
    if (!target) break;
    await Block.updateOne({ index: 1 }, { $set: { hash: String(n + 1).repeat(64) } });
    await ledger.audit({ maxAgeMs: 0 });
    const r = await anchor(`test:cycle-${n}`, '0xtest', { public: { n } });
    const clean = await ledger.audit({ maxAgeMs: 0 });
    if (!r.txs[0] || !clean.valid || ledger.cycle <= cycles) allRecovered = false;
    cycleDetail.push(`#1 → cycle ${ledger.cycle}${clean.valid ? '' : ' (STILL BROKEN)'}`);
    cycles = ledger.cycle;
  }
  record('E7', 'Repeated breaks each start a new cycle, and each transaction is receipted',
    allRecovered && ledger.cycle >= 4, `cycle reached ${ledger.cycle}: ${cycleDetail.join(' · ')}`);

  // One continuous chain — no recovery may mint a new genesis.
  const genesisCount = await Block.countDocuments({ 'txs.type': 'genesis' });
  const genesisNow = await Block.findOne({ index: 0 }).lean();
  const genesisBefore = (await snapshot()).find((b) => b.index === 0);
  record('E8', 'Every recovery continues the SAME chain — no new genesis, no silent reset',
    genesisCount === 1 && genesisNow && genesisNow.hash === genesisBefore.hash,
    `${genesisCount} genesis block(s); block 0 hash unchanged: ${genesisNow && genesisNow.hash === genesisBefore.hash}`);

  // The permanent log: it must exist and record BOTH the incident and the repair,
  // because the blocks it describes are gone.
  const repairs = await ChainRepair.find({ key: 'chain' }).sort({ at: 1 }).lean();
  const kinds = [...new Set(repairs.map((r) => r.kind))];
  record('E9', 'The repair log permanently records the incident and the repair',
    repairs.some((r) => r.kind === 'incident') && repairs.some((r) => r.kind === 'repair'),
    `${repairs.length} entr(ies): ${kinds.join(', ')}`);

  // A restart mid-incident must not be a way to make the ledger accept blocks on
  // a chain it already knows is broken, and it must not lose the open incident.
  await Block.updateOne({ index: 2 }, { $set: { hash: 'd'.repeat(64) } });
  await ledger.audit({ maxAgeMs: 0 });
  const beforeRestart = ledger.quarantined;
  resetLedgerSingleton(); // clears in-memory state ONLY; the DB rows persist
  await ledger.init();
  const afterRestart = ledger.quarantined;
  record('E10', 'The untrusted mark survives a server restart (not just in-memory)',
    afterRestart !== null && Number(afterRestart.brokenAt) === Number(beforeRestart && beforeRestart.brokenAt),
    `before restart brokenAt=${beforeRestart && beforeRestart.brokenAt} · after restart brokenAt=${afterRestart && afterRestart.brokenAt}`);

  let refusedAfterRestart = null;
  let restartReceipt = null;
  try {
    restartReceipt = await ledger.append([{ type: 'test:post-restart', actor: '0xtest', data: {} }]);
  } catch (err) { refusedAfterRestart = err.code || err.message; }
  record('E11', 'A transaction right after a restart recovers the chain and is receipted',
    !!restartReceipt && !refusedAfterRestart,
    restartReceipt
      ? `accepted at #${restartReceipt.index}; chain untrusted afterwards: ${!!ledger.quarantined}`
      : `append refused: ${refusedAfterRestart}`);

  // And the inverse: a RECOVERED chain must come back from a restart trusted, on
  // the same cycle. An earlier version gated the restart-quarantine on "an
  // incident row exists", which is true forever, so a repaired chain rebooted
  // still refusing writes — and with the cycle counter unread, it also claimed
  // to be on its first chain again.
  const recoveredBefore = await ledger.audit({ maxAgeMs: 0 });
  const cycleBeforeRestart = ledger.cycle;
  resetLedgerSingleton();
  await ledger.init();
  record('E12', 'A RECOVERED chain comes back from a restart trusted, on the same cycle',
    ledger.quarantined === null && ledger.cycle === cycleBeforeRestart && recoveredBefore.valid === true,
    `untrusted after restart: ${ledger.quarantined ? ledger.quarantined.reason : 'no'} · cycle ${ledger.cycle} (was ${cycleBeforeRestart})`);

  // Repair must be idempotent — an operator clicking twice must not truncate more.
  const noop = await ledger.repair({ actor: 'harness-operator-2' });
  const idempotent = await ledger.audit({ maxAgeMs: 0 });
  record('E13', 'Repairing an already-healthy chain changes nothing',
    idempotent.valid === true && noop.repaired !== true,
    `second repair: ${noop.reason || `repaired=${noop.repaired}`} · left the chain valid at height ${idempotent.height}`);

  // ── Alerting ────────────────────────────────────────────────────────────
  section('D. Does a BROKEN chain alert anybody?');
  await restore(baseline);
  // Alerting fans out to accounts that have blockchain activity, so the test
  // needs at least one such account to exist. Created here rather than assumed:
  // on a fresh scratch database there are none, and "0 notifications because
  // there was nobody to notify" is indistinguishable from "nothing was sent".
  const Owner = require('./models/User');
  const { Wallet } = require('./models/Web3');
  const owner = await Owner.create({
    firstName: 'Tamper', lastName: 'Probe',
    email: `tamper-probe-${Date.now()}@example.com`,
    password: 'TamperProbe123!',
    dateOfBirth: '1990-01-01',
    gender: 'Female', // the schema enum is exactly ['Male', 'Female']
  });
  await Wallet.create({
    user: owner._id,
    did: `did:suppliwise:${owner._id}`,
    address: `0xprobe${String(owner._id).slice(-8)}`,
    publicKey: '',
    balance: 10,
  });
  console.log(`  probe account ${owner.email} with a wallet, so the alert has a real recipient`);
  // The admin event fan-out is addressed to enabled admin accounts, and there are
  // none on a scratch database — so one is created. `totpSecret` is required by
  // the schema; this is a throwaway row in a database that gets dropped.
  const AdminAccount = require('./models/AdminAccount');
  await AdminAccount.create({
    alias: `tamper-probe-${Date.now()}`,
    passwordHash: 'x',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    enabled: true,
  }).catch((err) => console.error('  (harness) probe admin not created:', err.message));

  const tipBefore = await Block.findOne({}).sort({ index: -1 }).lean();
  await armBaseline(); // prove the chain good first, THEN break it
  await Block.deleteMany({ index: { $gte: 4 } });
  const brokenVerdict = await verdict();
  console.log(`  chain deliberately broken at block 4 — full-audit says ${brokenVerdict.fullSays}`);
  // Alerting is deliberately fire-and-forget, so give it a moment to land.
  await new Promise((r) => setTimeout(r, 2500));

  const userAlerts = await UserNotification.countDocuments({
    user: owner._id, title: /integrity/i,
  });
  const adminAlerts = await AdminEvent.countDocuments({ type: 'security', title: /integrity/i });
  record(
    'D1',
    'A broken chain notifies the affected user AND administrators',
    userAlerts > 0 && adminAlerts > 0,
    `user notifications written: ${userAlerts} · admin security events: ${adminAlerts}`
  );

  const height = (await Block.findOne({}).sort({ index: -1 }).lean()) || { index: -1 };
  record(
    'D2',
    'A truncated chain is reported as shorter (height regression is visible)',
    height.index < tipBefore.index || brokenVerdict.full.valid === false,
    `tip was ${tipBefore.index}, now ${height.index}`
  );

  // D3: the recovery notice. An alarm nobody can turn off is its own failure, so
  // a verified-healthy chain must close the loop with the same audience.
  //
  // Note this does NOT use restore(): that helper deletes the ChainAudit record,
  // which is where the open incident is persisted — so it would erase the very
  // state under test. Only the BLOCKS are repaired, exactly as an operator would
  // restore from backup, leaving the incident on record for the next check to
  // find and close.
  await Block.deleteMany({});
  if (baseline.length) await Block.insertMany(baseline);
  resetLedgerSingleton();
  await ledger.audit({ maxAgeMs: 0 }); // a clean walk must clear the open incident
  await new Promise((r) => setTimeout(r, 2500));
  console.log(`  incident still open after the chain was repaired? ${ledger.incident !== null}`);
  const recovery = await UserNotification.countDocuments({
    user: owner._id, title: /verified healthy again/i,
  });
  record('D3', 'Recovery is announced to the same audience', recovery > 0,
    `recovery notifications written: ${recovery}`);

  // ── Summary ─────────────────────────────────────────────────────────────
  await restore(baseline);
  const undetected = results.filter((r) => !r.detected);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`RESULT: ${passed}/${results.length} checks held · ${undetected.length} FAILED`);
  if (undetected.length) {
    console.log('\nVULNERABILITIES CONFIRMED — these attacks were NOT detected:');
    for (const r of undetected) console.log(`  ✗ [${r.id}] ${r.name}\n      ${r.detail.split('\n')[0]}`);
  }
  console.log('═'.repeat(70));

  if (!KEEP) {
    await mongoose.connection.dropDatabase();
    console.log(`scratch database ${SCRATCH_DB} dropped.`);
  } else {
    console.log(`KEEP_CHAIN_ATTACK_DB=1 — scratch database ${SCRATCH_DB} left in place.`);
  }
  restoreDiskAnchor();
  await mongoose.disconnect();
  process.exitCode = undetected.length ? 2 : 0;
}

main().catch(async (err) => {
  console.error('\nHARNESS ERROR:', err.stack || err.message);
  try { if (!KEEP) await mongoose.connection.dropDatabase(); } catch { /* ignore */ }
  restoreDiskAnchor();
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exitCode = 1;
});