/**
 * THE LEDGER-TAMPERING ALARM MUST FIRE, NOT THROW.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * The CRITICAL message for a failed chain was assembled inside
 * `probe('bc_ledger', …)` in routes/admin.js. The `recovery` paragraph it
 * interpolated had been pasted into a DIFFERENT probe (`bc_wallet`), below that
 * probe's `return`, so nothing named `recovery` existed where it was used:
 * whenever `ledger.verify()` reported a real break, building the alarm threw a
 * ReferenceError and the monitor row rendered `status: 'error'` instead of
 * CRITICAL. Syntactically valid, so `node --check` and every suite passed while
 * the control was broken — and it only shows up when the chain is actually
 * compromised, which is the one moment it exists for.
 *
 * WHAT IS ASSERTED
 * ----------------
 * The message builder is now utils/chainAlarm.js, so each branch is called
 * directly here: truncation, tip-rewrite, linkage, with and without a live
 * quarantine record. Plus a source-level guard that the two probes in
 * routes/admin.js no longer reach for a variable the other one declares.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { chainIntegrityFailure, failureKind, recoverySteps } = require('../utils/chainAlarm');

test('every chain-failure kind is described in words an operator can act on', () => {
  assert.match(failureKind('truncation'), /blocks are missing/, 'truncation is DATA LOSS, not tampering');
  assert.match(failureKind('tip-rewrite'), /tip block was replaced/);
  assert.match(failureKind('linkage'), /linkage or a committed payload was altered/);
  // An unknown kind must still produce a sentence, never undefined.
  assert.equal(failureKind(undefined), 'block linkage or a committed payload was altered');
  assert.ok(!/undefined/.test(failureKind('')), 'no branch may interpolate an undefined kind');
});

test('a failed chain is CRITICAL and states that members were not blocked', () => {
  const out = chainIntegrityFailure(
    { valid: false, kind: 'linkage', brokenAt: 41, reason: 'hash mismatch' },
    null,
  );
  assert.equal(out.status, 'critical', 'this is the row that must never degrade to warning or error');
  assert.match(out.detail, /FAILED at block 41 \(hash mismatch\)/);
  assert.match(out.detail, /were NOT blocked/, 'otherwise an integrity warning reads as an outage');
  assert.equal(out.detail.includes('undefined'), false, 'a null quarantine must not leak the word undefined');
});

test('a live quarantine explains what the ledger does next', () => {
  const q = { brokenAt: 41, affectedBlocks: 7, unrecoverable: false };
  const detail = chainIntegrityFailure({ valid: false, kind: 'tip-rewrite', brokenAt: 41, reason: 'r' }, q).detail;
  assert.match(detail, /7 block\(s\) are affected/);
  assert.match(detail, /#41 onward/, 'names the region being discarded');
  assert.match(detail, /#40/, 'names the last provably-good block');
  assert.match(detail, /security\/chain\/repair/, 'and the manual trigger');
  assert.doesNotMatch(detail, /backup restore/, 'a rewritable tip is not missing data — do not tell operators to restore');
});

test('truncation says the discarded records only come back from a backup', () => {
  const q = { brokenAt: 12, affectedBlocks: 3, unrecoverable: true };
  const detail = chainIntegrityFailure({ valid: false, kind: 'truncation', brokenAt: 12, reason: 'missing' }, q).detail;
  assert.match(detail, /NOTE: blocks are missing/);
  assert.match(detail, /restore from backup/, 'the recovery gap is stated as outstanding work');
  assert.match(detail, /continues the chain without them/, 'the auto re-sync is not described as a blocker');
});

test('recoverySteps is empty, never null-text, without a quarantine record', () => {
  assert.equal(recoverySteps(null), '');
  assert.equal(recoverySteps(undefined), '');
});

test('the admin probes no longer share identifiers across return statements', () => {
  // The class of mistake, not just the one instance: a `const` declared after a
  // `return` is unreachable code, and a name used in one probe but declared in
  // another is a runtime error on a path tests cannot reach.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  const lines = src.split('\n');
  const offenders = [];
  // "Declaration right after a return" only means unreachable when the return
  // STATEMENT ended. `return (users || []).map(user => {` is one long expression
  // whose body continues below, and the `const` inside it is perfectly reachable
  // — flagging that is how a structural guard gets disabled by its own noise.
  const continues = /[{([,]\s*$|=>\s*$|[+?:&|.]\s*$/;
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\s*return\b/.test(lines[i]) && !continues.test(lines[i])
      && /^\s*(const|let|var)\s+/.test(lines[i + 1])) {
      offenders.push(`${i + 1}: declaration after return -> ${lines[i + 1].trim().slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [], 'an unreachable declaration is a sign text was pasted into the wrong branch');
  assert.equal(src.includes('+ recovery,'), false,
    'the chain alarm text comes from utils/chainAlarm.js, not a local binding');
});

test('the chain alarm is reachable from the probe that reports it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  const ledgerProbe = src.slice(src.indexOf("probe('bc_ledger'"), src.indexOf("probe('bc_seal'"));
  assert.ok(ledgerProbe.includes('chainIntegrityFailure('),
    'bc_ledger must build its failure verdict through the tested builder');
  assert.ok(ledgerProbe.includes('ledger.quarantined'), 'and pass the live quarantine record to it');
});
