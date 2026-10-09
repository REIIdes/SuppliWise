// ═══════════════════════════════════════════════════════════════════════════
// Chain-integrity alerting.
//
// THE GAP THIS FILLS
// ------------------
// The ledger already DETECTS a broken chain — `bc_ledger` in the admin monitor
// reports `critical`, and /api/web3/chain/verify answers valid:false. Both were
// silent in the only way that matters in production:
//
//   · nothing was written to the user notification inbox, so a member whose
//     reward history, marketplace order or health anchor sits behind the broken
//     block had no way to learn their records were in question, and
//   · nothing was logged to the admin event stream, so the failure existed only
//     for as long as somebody happened to have the Security tab open. An admin
//     who never opened it learned nothing, ever.
//
// The tamper harness pinned this: after deliberately deleting blocks, 0 user
// notifications and 0 admin events existed.
//
// DESIGN CONSTRAINTS
// ------------------
//  · NEVER throws and never rejects. This is called from inside the verifier,
//    and an alerting failure must never mask or replace the verdict.
//  · Never blocks a request. Every step is fire-and-forget from the caller.
//  · Idempotent per incident (the ledger de-dupes; this also tolerates a repeat).
//  · No block data, payload or digest is ever put in a message — only the block
//    index and the kind of failure, which is all a recipient can act on.
// ═══════════════════════════════════════════════════════════════════════════

// How many notifications to insert in one batch. insertMany is far cheaper than
// N round trips, but a very large account base needs more than one batch or the
// single write exceeds the driver's limits.
const BATCH = 500;

// Human-readable framing per failure kind. The detector reports machine strings
// ("prevHash mismatch"); this is what a member actually reads.
function describe(incident) {
  const where = incident.brokenAt >= 0 ? `block ${incident.brokenAt}` : 'the chain';
  const quarantined = incident.quarantine === true;

  let userDetail =
    `An automatic integrity check found a problem in SuppliWise's blockchain ledger at ${where}. `
    + `Nothing has been deleted and your account is still safe, but records anchored around that block `
    + `are temporarily not being treated as verified, and the ledger is under investigation. `
    + `Your balances and order history are stored separately and are unaffected. `
    + `This notice is sent automatically to every account with blockchain activity the moment a `
    + `problem is detected. You do not need to do anything.`;

  // Say plainly that new receipts are paused. A member who claims a reward during
  // a quarantine and sees no transaction hash has otherwise no way to know
  // whether they lost it or whether it is simply not written yet.
  if (quarantined) {
    userDetail +=
      ' While this is being fixed the ledger is not accepting new records, so a reward or order you '
      + 'complete right now may not show an on-chain receipt yet. Your reward, balance and order are '
      + 'still recorded normally on your account — only the blockchain receipt is on hold.';
  }

  return {
    userTitle: 'Blockchain record integrity issue',
    userDetail,
    adminTitle: `Blockchain integrity FAILED at ${where}`,
    adminDetail:
      `Ledger verification failed: ${incident.reason}. `
      + `Detected ${new Date(incident.at || Date.now()).toISOString()} `
      + `at height ${incident.height}, ${incident.checked} block(s) checked. `
      + `Do not trust anchored digests from this block onward until the ledger is re-synced. `
      + `Investigate the database for an out-of-band write, and check whether CHAIN_SEAL_KEY changed.`,
  };
}

/**
 * Fan a chain-integrity incident out to every user who actually has blockchain
 * activity, plus every enabled administrator.
 *
 * Scoped to users with a wallet rather than the whole user table: a member who
 * never touched the blockchain layer has no on-chain record that could be
 * affected, and telling them so would be noise that trains people to ignore
 * alerts.
 */
async function notifyChainIncident(incident) {
  const copy = { ...incident };
  const copyText = describe(copy);

  // Required lazily and independently: a failure to load one model must not
  // stop the other channel from being delivered.
  const delivered = { users: 0, admins: 0 };

  try {
    const { Wallet } = require('../models/Web3');
    // models/UserNotification exports the MODEL itself, not an object of models
    // — so this must be a plain require. Destructuring it yields undefined and
    // the fan-out dies with "Cannot read properties of undefined (reading
    // 'insertMany')", i.e. it fails SILENTLY: the incident is detected, logged,
    // and then nobody is actually told. That is the exact failure this module
    // exists to prevent, so it is called out rather than left for a reader to
    // rediscover.
    const UserNotification = require('../models/UserNotification');
    const userIds = await Wallet.find({ isSystem: { $ne: true } }).select('user').lean();
    const ids = [...new Set(userIds.map((w) => w.user).filter(Boolean))];
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      await UserNotification.insertMany(
        slice.map((user) => ({
          user,
          type: 'info',
          title: copyText.userTitle,
          detail: copyText.userDetail,
        })),
        { ordered: false } // one bad row must not abandon the rest of the batch
      );
      delivered.users += slice.length;
    }
  } catch (err) {
    console.error('[chain-alert] user notification fan-out failed:', err.message);
  }

  try {
    const AdminEvent = require('../models/AdminEvent');
    const AdminAccount = require('../models/AdminAccount');
    const admins = await AdminAccount.find({ enabled: true }).select('_id').lean();
    const docs = admins.map((a) => ({
      type: 'security', // 'security' is already in AdminEvent's enum
      title: copyText.adminTitle,
      detail: copyText.adminDetail,
      user: null,
    }));
    if (docs.length) await AdminEvent.insertMany(docs, { ordered: false });
    delivered.admins = docs.length;
  } catch (err) {
    console.error('[chain-alert] admin event fan-out failed:', err.message);
  }

  console.error(
    `[chain-alert] incident delivered — ${delivered.users} user notification(s), ${delivered.admins} admin event(s)`
  );
  return delivered;
}

/**
 * Tell the same audience the chain verified clean again, so an unresolved
 * warning does not sit in everyone's inbox forever.
 *
 * Deliberately addressed to the accounts that received the incident rather than
 * re-queried: a wallet deleted in the meantime should not receive a recovery
 * notice for a chain they are no longer part of.
 */
async function notifyChainRecovered(incident) {
  const copy = { ...incident };
  // When a repair discarded blocks, say so. A recovery notice that only says
  // "all healthy" would leave every recipient who was told about the incident
  // unable to tell whether anything was lost — and in a repair, something WAS.
  const repaired = copy.repaired === true;
  let detail =
    'Good news: SuppliWise\'s blockchain ledger has passed a full integrity re-check and is verified healthy again. '
    + `The earlier problem at block ${copy.brokenAt} has been resolved and anchored records are being trusted normally again. `
    + 'No action was needed on your part.';

  if (repaired && copy.discardedCount > 0) {
    detail +=
      ` To restore a single consistent chain, ${copy.discardedCount} block(s) after the affected block could not be `
      + 'verified and were discarded. Records before that point are untouched and still verified, the chain continues '
      + 'from there, and every affected account was notified automatically. Nothing on your account was lost: balances, '
      + 'orders and rewards are held separately from the ledger.';
  }

  try {
    const { Wallet } = require('../models/Web3');
    // Plain require, for the same reason as in notifyChainIncident.
    const UserNotification = require('../models/UserNotification');
    const rows = await Wallet.find({ isSystem: { $ne: true } }).select('user').lean();
    const ids = [...new Set(rows.map((w) => w.user).filter(Boolean))];
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      await UserNotification.insertMany(
        slice.map((user) => ({
          user,
          type: 'info',
          title: 'Blockchain records verified healthy again',
          detail,
        })),
        { ordered: false }
      );
    }
    console.log(`[chain-alert] recovery notice sent to ${ids.length} account(s)`);
    return ids.length;
  } catch (err) {
    console.error('[chain-alert] recovery notice failed:', err.message);
    return 0;
  }
}

module.exports = { notifyChainIncident, notifyChainRecovered, describe, BATCH };