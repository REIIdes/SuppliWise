/**
 * The text of the ledger-tampering alarm, in one place so it can be TESTED.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The chain-integrity probe assembled this message inline. A `recovery` string
 * belonging to this branch had been pasted into a DIFFERENT probe, below that
 * probe's `return` — unreachable, and unreachable in a way `node --check` cannot
 * see, because it is syntactically fine. The result was that the single most
 * alarming thing this dashboard can report threw a ReferenceError whenever a
 * chain actually failed, and the row rendered `status: 'error'` instead of
 * CRITICAL. The control broke precisely at the moment it earned its keep.
 *
 * A message built inside a route handler can only be exercised by making the
 * ledger fail, which means tampering with a chain. Built here, every branch
 * (truncation, tip-rewrite, linkage, with and without a live quarantine record)
 * is a function call in a test.
 */

/** What kind of damage this is, in the words an operator needs. */
function failureKind(kind) {
  return kind === 'truncation'
    ? 'blocks are missing from the chain (truncation) — restore from backup before trusting any anchored digest'
    : kind === 'tip-rewrite'
      ? 'the tip block was replaced — history was altered after the fact'
      : 'block linkage or a committed payload was altered';
}

/**
 * What the ledger does next, and what only a human can do.
 *
 * `q` is `ledger.quarantined` — null when the damage has not yet been
 * quarantined, so the whole paragraph is conditional on there being a plan to
 * report. `unrecoverable` is the truncation case: discarding the broken region
 * cannot bring back blocks that are simply absent, so a backup restore stays
 * outstanding work rather than being described as already handled.
 */
function recoverySteps(q) {
  if (!q) return '';
  return `${q.affectedBlocks} block(s) are affected. `
    + 'The ledger stops writing on top of the damage and re-syncs automatically: it discards '
    + `the untrustworthy region from #${q.brokenAt} onward, rewinds its host head anchor and opens `
    + `a new verified chain segment (last provably-good block: #${q.brokenAt - 1}). `
    + (q.unrecoverable
      ? 'NOTE: blocks are missing, so those records can only come back from a backup restore — '
        + 'the automatic re-sync continues the chain without them. '
      : '')
    + 'Force it now with POST /api/admin/security/chain/repair (confirm: "DISCARD-BROKEN-BLOCKS"), '
    + 'or let the next transaction trigger it. ';
}

/**
 * The CRITICAL verdict for a failed chain verification.
 *
 * Members are NOT blocked when the chain breaks — anchored digests stop being
 * trustworthy, but every feature keeps working and transactions keep
 * completing — so the row says that explicitly. Without it, "chain integrity
 * FAILED" reads like an outage and gets treated as one.
 */
function chainIntegrityFailure(v, q) {
  return {
    status: 'critical',
    detail: `Chain integrity FAILED at block ${v.brokenAt} (${v.reason}) — ${failureKind(v.kind)}. `
      + 'All affected accounts have been notified automatically and were NOT blocked: every feature '
      + 'keeps working and transactions keep completing. '
      + recoverySteps(q),
  };
}

module.exports = { chainIntegrityFailure, failureKind, recoverySteps };
