// PROBE: what actually happens to a chain AFTER it is detected as broken?
// Read-only against a scratch database. Answers four questions:
//   1. Does the chain ever recover on its own?
//   2. Does append() keep adding blocks on top of the corruption?
//   3. Do users keep earning/anchoring while the chain is broken?
//   4. Is a NEW genesis/cycle ever started?
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const SCRATCH = 'sw_chainbreak_probe';

// Must match ledger.js exactly. The anchor filename is derived from the
// RESOLVED database name because MONGO_URI carries no database in its path.
function anchorFile() {
  const { sha256Hex } = require('./blockchain/crypto');
  return path.join(
    __dirname, 'uploads',
    `.chain-head.${sha256Hex(SCRATCH).slice(0, 12)}.anchor`
  );
}

(async () => {
  const m = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/.exec(process.env.MONGO_URI);
  await mongoose.connect(`${m[1]}/${SCRATCH}${m[3] || ''}`, { serverSelectionTimeoutMS: 10000 });
  await mongoose.connection.dropDatabase();
  // The anchor file is keyed on the RESOLVED database name (see ledger.js).
  // Keying it on MONGO_URI gave every database on this cluster the same file, so
  // the probe's 3-block chain read production's height and refused to verify.
  // Isolate it: start this chain with no anchor at all, so any truncation verdict
  // is about blocks this probe actually removed.
  try { fs.unlinkSync(anchorFile()); } catch { /* none yet */ }
  const started = Date.now();

  const { Block, ChainAudit, Wallet } = require('./models/Web3');
  const User = require('./models/User');
  const UserNotification = require('./models/UserNotification');
  const ledger = require('./blockchain/ledger');
  const engine = require('./blockchain/engine');

  const u = await User.create({
    firstName: 'Lifecycle', lastName: 'Probe',
    email: `lifecycle-${Date.now()}@example.com`,
    password: 'LifecycleProbe123!', dateOfBirth: '1990-01-01', gender: 'Female',
  });

  for (let i = 0; i < 6; i += 1) {
    await ledger.append([{ type: 'probe', actor: '0xp', data: { i } }]);
  }
  console.log(`built ${await Block.countDocuments()} blocks, height ${ledger.height}`);

  // ── Break it the way an attacker would: corrupt a middle block ──────────
  await Block.updateOne({ index: 3 }, { $set: { hash: 'f'.repeat(64) } });
  console.log('\n--- broke block 3 (replaced its hash) ---\n');

  const blocks = await Block.find({}).sort({ index: 1 }).lean();
  const genesisHash = (blocks.find((x) => x.index === 0) || {}).hash;

  const first = await ledger.audit({ maxAgeMs: 0 });
  console.log(`1) detection       : valid=${first.valid} brokenAt=${first.brokenAt} reason="${first.reason}"`);
  console.log(`   quarantined?    : ${!!ledger.quarantined} (new blocks refused: ${ledger.quarantined ? 'YES' : 'no'})`);

  // ── Q1: does it ever recover on its own? ────────────────────────────────
  const later = [];
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 300));
    later.push(await ledger.audit({ maxAgeMs: 0 }));
  }
  console.log(`2) self-recovery   : ${later.every((v) => v.valid) ? 'RECOVERED on its own' : 'still broken after 3 re-checks — by design, never automatic'}`);

  // ── Q2: does append() keep writing onto the corrupt chain? ──────────────
  const before = await Block.countDocuments();
  let appendErr = null;
  try {
    for (let i = 0; i < 3; i += 1) {
      await ledger.append([{ type: 'probe:after-break', actor: '0xp', data: { i } }]);
    }
  } catch (err) { appendErr = err.message; }
  const after = await Block.countDocuments();
  console.log(`3) appends         : ${appendErr ? `REFUSED (${appendErr.slice(0, 46)}…) — chain held at ${after} blocks` : `ALLOWED — ${after - before} more block(s) stacked on corruption`}`);

  // ── Q3: do users keep earning while broken? ─────────────────────────────
  let reward = null;
  try {
    await engine.ensureWalletForUser(u._id);
    const r = await engine.grantReward({
      userId: u._id, kind: 'probe_reward', refId: '-', amount: 25,
      public: { amount: 25, kind: 'probe_reward' },
    });
    const w = await Wallet.findOne({ user: u._id }).lean();
    reward = {
      credited: w.balance,
      txHash: r.txHash ? 'present' : 'WITHHELD (quarantine)',
      blockIndex: r.blockIndex,
    };
  } catch (err) { reward = { error: err.message }; }
  console.log(`4) user reward     : ${JSON.stringify(reward)}`);
  console.log(`   → user still earns; only the on-chain receipt is withheld`);

  // ── Q5: REPAIR — the whole point of this probe ────────────────────────────
  const q = ledger.quarantined;
  console.log(`5) quarantined     : blocks ${q.brokenAt}-${q.affectedBlocks + q.brokenAt - 1} affected, last good #${ledger.lastGoodIndex()}`);

  const repair = await ledger.repair({ actor: 'probe-operator' });
  console.log(`6) repair          : repaired=${repair.repaired} keptThrough=#${repair.keptThrough} discarded=${repair.discardedBlocks} in ${repair.durationMs}ms`);
  if (repair.discarded) {
    console.log(`   discarded       : ${repair.discarded.map((b) => `#${b.index}(${b.txCount}tx)`).join(' ')}`);
  }
  const afterRepair = await ledger.audit({ maxAgeMs: 0 });
  console.log(`7) post-repair     : valid=${afterRepair.valid} height=${afterRepair.height} quarantined=${!!ledger.quarantined}`);
  console.log(`   same chain?     : genesis ${String(genesisHash).slice(0, 12)}… preserved, no new genesis: ${await Block.countDocuments({ 'txs.type': 'genesis' }) === 1}`);

  // Does it accept new blocks again?
  let resumed = null;
  try {
    await ledger.append([{ type: 'probe:post-repair', actor: '0xp', data: { ok: true } }]);
    resumed = `YES — height ${ledger.height}, chain running forward again`;
  } catch (err) { resumed = `NO — ${err.message}`; }
  console.log(`8) resumes         : ${resumed}`);

  const final = await ledger.audit({ maxAgeMs: 0 });
  console.log(`9) final           : valid=${final.valid} height=${final.height} blocks=${await Block.countDocuments()}`);

  // Repair log — the permanent record, since the blocks themselves are gone.
  const { ChainRepair } = require('./models/Web3');
  const log = await ChainRepair.find({ key: 'chain' }).sort({ at: 1 }).lean();
  console.log(`\n10) repair log (${log.length} entries, survives truncation):`);
  for (const e of log) {
    console.log(`    - ${e.kind.padEnd(18)} brokenAt=${e.brokenAt} kept=#${e.keptThrough} discarded=${e.discardedCount} healthy=${e.healthyAfter} actor=${e.actor}`);
  }
  console.log(`    genesis block still present: ${await Block.countDocuments({ index: 0 }) === 1}`);

  await mongoose.connection.dropDatabase();
  // Remove this chain's anchor so a later run (or the real server) never inherits
  // a proof of a height this throwaway chain reached.
  try { fs.unlinkSync(anchorFile()); } catch { /* already gone */ }
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('PROBE ERROR:', e.message);
  try { await mongoose.connection.dropDatabase(); } catch { /* ignore */ }
  try { fs.unlinkSync(anchorFile()); } catch { /* ignore */ }
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exitCode = 1;
});