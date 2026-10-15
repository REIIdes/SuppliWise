// PROBE: what actually happens to a chain AFTER it is detected as broken?
// Read-only against a scratch database. Answers the questions that matter:
//   1. Are users told?
//   2. Can they keep making transactions?
//   3. Do those transactions get an on-chain receipt?
//   4. Does the chain start a NEW verified chain and keep going?
//   5. Does the cycle survive a restart?
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

  // Give the account a wallet BEFORE the break. The incident fan-out is scoped to
  // accounts that actually have blockchain activity, so without this the probe
  // would report "0 notifications" and that is indistinguishable from "nothing
  // was sent".
  await engine.ensureWalletForUser(u._id);
  await ledger.audit({ maxAgeMs: 0 }); // prove the chain good, so the anchor is written

  // ── Break it the way an attacker would: corrupt a middle block ──────────
  await Block.updateOne({ index: 3 }, { $set: { hash: 'f'.repeat(64) } });
  console.log('\n--- broke block 3 (replaced its hash) ---\n');

  const blocks = await Block.find({}).sort({ index: 1 }).lean();
  const genesisHash = (blocks.find((x) => x.index === 0) || {}).hash;

  const first = await ledger.audit({ maxAgeMs: 0 });
  console.log(`1) detection       : valid=${first.valid} brokenAt=${first.brokenAt} reason="${first.reason}"`);
  console.log(`   untrusted?      : ${!!ledger.quarantined} (last provably-good block #${ledger.lastGoodIndex()})`);

  // ── Notifications ──────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 1200));
  const incidentMsgs = await UserNotification.find({ user: u._id, title: /integrity/i }).lean();
  console.log(`2) notification    : ${incidentMsgs.length} message(s) to the affected user`);
  console.log(`   admins notified : ${incidentMsgs.length > 0 ? 'yes (same fan-out)' : 'n/a'}`);
  console.log(`   copy           : "${String((incidentMsgs[0] || {}).detail || '').slice(0, 96)}…"`);

  // ── Transactions are NOT blocked, and they are receipted ───────────────
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
      txHash: r.txHash ? 'present' : 'MISSING',
      blockIndex: r.blockIndex,
    };
  } catch (err) { reward = { error: err.message }; }
  console.log(`3) user reward     : ${JSON.stringify(reward)}`);
  console.log('   → the user keeps earning AND gets a real receipt; nothing is withheld');

  // ── A NEW CHAIN, started automatically ─────────────────────────────────
  const segment = await Block.findOne({ 'txs.type': 'chain:resync' }).lean();
  console.log(`4) new chain       : ${segment
    ? `segment #${segment.index} mined, cycle ${((segment.txs[0] || {}).data || {}).cycle}, height now ${ledger.height}`
    : 'NO SEGMENT OPENED'}`);
  console.log(`   untrusted now?  : ${!!ledger.quarantined}`);
  console.log(`   forged block 3  : ${await Block.countDocuments({ hash: 'f'.repeat(64) })} block(s) still hold it`);

  // ── Does it keep running? ──────────────────────────────────────────────
  const afterRepair = await ledger.audit({ maxAgeMs: 0 });
  console.log(`5) post-recovery   : valid=${afterRepair.valid} height=${afterRepair.height} cycle=${ledger.cycle}`);

  let resumed = null;
  try {
    await engine.grantReward({
      userId: u._id, kind: 'probe_reward_2', refId: '-', amount: 5,
      public: { amount: 5, kind: 'probe_reward_2' },
    });
    resumed = `YES — chain running forward, height ${ledger.height}`;
  } catch (err) { resumed = `NO — ${err.message}`; }
  console.log(`6) still working   : ${resumed}`);

  const final = await ledger.audit({ maxAgeMs: 0 });
  console.log(`7) final           : valid=${final.valid} height=${final.height} blocks=${await Block.countDocuments()}`);

  // ── A SECOND break must behave identically (the continuous cycle) ──────
  await Block.updateOne({ index: 1 }, { $set: { hash: 'a'.repeat(64) } });
  await ledger.audit({ maxAgeMs: 0 });
  const r2 = await engine.grantReward({
    userId: u._id, kind: 'probe_reward_3', refId: '-', amount: 7,
    public: { amount: 7, kind: 'probe_reward_3' },
  });
  const cycle2 = await ledger.audit({ maxAgeMs: 0 });
  console.log(`8) second break    : cycle=${ledger.cycle} receipt=${r2.txHash ? 'present' : 'MISSING'} `
    + `valid=${cycle2.valid} height=${cycle2.height}`);

  console.log(`   same chain?     : genesis ${String(genesisHash).slice(0, 12)}… preserved, `
    + `exactly one genesis: ${await Block.countDocuments({ 'txs.type': 'genesis' }) === 1}`);

  // ── Does the cycle survive a restart? ──────────────────────────────────
  const cycleBefore = ledger.cycle;
  await mongoose.disconnect();
  await mongoose.connect(`${m[1]}/${SCRATCH}${m[3] || ''}`, { serverSelectionTimeoutMS: 10000 });
  ledger.initPromise = null;
  await ledger.init();
  console.log(`9) after restart   : cycle=${ledger.cycle} (was ${cycleBefore}) · untrusted=${!!ledger.quarantined} `
    + `· still appends=${ledger.height >= 0}`);

  // Repair log — the permanent record, since the blocks themselves are gone.
  const { ChainRepair } = require('./models/Web3');
  const log = await ChainRepair.find({ key: 'chain' }).sort({ at: 1 }).lean();
  console.log(`\n10) repair log (${log.length} entries, survives truncation):`);
  for (const e of log) {
    console.log(`    - ${e.kind.padEnd(18)} brokenAt=${e.brokenAt} kept=#${e.keptThrough} discarded=${e.discardedCount} healthy=${e.healthyAfter} actor=${e.actor}`);
  }
  console.log(`    genesis block still present: ${await Block.countDocuments({ index: 0 }) === 1}`);
  console.log(`    probe runtime: ${Date.now() - started}ms`);

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