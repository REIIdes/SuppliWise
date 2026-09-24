const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stableStringify,
  hashPayload,
  sha256Hex,
  generateIdentity,
  sign,
  verify,
  encrypt,
  decrypt,
  contentId,
  dayKey,
  round2,
  addressFromPublicKey,
} = require('../blockchain/crypto');

const {
  tallyProposal,
  checkinStreak,
  checkinReward,
  shiftDay,
  computeStakeReward,
  stakingUnlocks,
  ACHIEVEMENTS,
  eligibleAchievements,
  escrowSplit,
  disputeOutcome,
} = require('../blockchain/rules');

const { headerHash, normalizeTx, DIFFICULTY } = require('../blockchain/ledger');

// ── Canonical hashing ──────────────────────────────────────────────────────
test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(
    stableStringify({ x: { z: 1, y: [3, 2] } }),
    stableStringify({ x: { y: [3, 2], z: 1 } })
  );
});

test('hashPayload is deterministic and content-sensitive', () => {
  assert.equal(hashPayload({ a: 1, b: 'two' }), hashPayload({ b: 'two', a: 1 }));
  assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }));
  assert.match(hashPayload({}), /^[a-f0-9]{64}$/);
});

test('nested arrays keep order (order changes the hash)', () => {
  assert.notEqual(hashPayload({ list: [1, 2] }), hashPayload({ list: [2, 1] }));
});

// ── Identity ───────────────────────────────────────────────────────────────
test('ed25519 identity signs and verifies', () => {
  const id = generateIdentity();
  const sig = sign(id.privateKey, 'suppliwise');
  assert.ok(verify(id.publicKey, 'suppliwise', sig));
  assert.equal(verify(id.publicKey, 'tampered', sig), false);
  assert.match(id.address, /^0x[a-f0-9]{40}$/);
  assert.equal(id.address, addressFromPublicKey(id.publicKey));
});

// ── Encryption / content addressing ────────────────────────────────────────
test('AES-GCM round-trips and detects tampering', () => {
  const sealed = encrypt('{"records":42}', 'secret');
  assert.equal(decrypt(sealed, 'secret'), '{"records":42}');
  assert.throws(() => decrypt(sealed, 'wrong-secret'));
  const flipped = { ...sealed, ct: Buffer.from('x').toString('base64') };
  assert.throws(() => decrypt(flipped, 'secret'));
});

test('contentId is deterministic (same bytes → same CID)', () => {
  const cid = contentId(Buffer.from('hello'));
  assert.equal(cid, contentId(Buffer.from('hello')));
  assert.notEqual(cid, contentId(Buffer.from('hello!')));
  assert.match(cid, /^bafy[a-z2-7]+$/);
});

// ── DAO tally ──────────────────────────────────────────────────────────────
test('proposal passes with quorum and more FOR than AGAINST', () => {
  const tally = tallyProposal(
    [
      { address: '0xa', choice: 'for', weight: 100 },
      { address: '0xb', choice: 'against', weight: 40 },
    ],
    { daoQuorumWeight: 50 }
  );
  assert.equal(tally.passed, true);
  assert.equal(tally.forWeight, 100);
  assert.equal(tally.voterCount, 2);
});

test('proposal fails without quorum even when FOR dominates', () => {
  const tally = tallyProposal([{ address: '0xa', choice: 'for', weight: 10 }], { daoQuorumWeight: 50 });
  assert.equal(tally.quorumReached, false);
  assert.equal(tally.passed, false);
});

test('one vote per wallet — duplicate addresses are ignored', () => {
  const tally = tallyProposal(
    [
      { address: '0xa', choice: 'for', weight: 100 },
      { address: '0xa', choice: 'against', weight: 100 },
    ],
    { daoQuorumWeight: 10 }
  );
  assert.equal(tally.voterCount, 1);
  assert.equal(tally.forWeight, 100);
  assert.equal(tally.againstWeight, 0);
});

test('proposal fails on a tie', () => {
  const tally = tallyProposal(
    [
      { address: '0xa', choice: 'for', weight: 50 },
      { address: '0xb', choice: 'against', weight: 50 },
    ],
    { daoQuorumWeight: 10 }
  );
  assert.equal(tally.passed, false);
});

// ── Check-in streaks ───────────────────────────────────────────────────────
test('streak counts consecutive days ending today', () => {
  const today = '2026-09-24';
  const days = ['2026-09-24', '2026-09-23', '2026-09-22'];
  assert.equal(checkinStreak(days, today), 3);
});

test('streak survives until today is claimed (yesterday still counts)', () => {
  const today = '2026-09-24';
  assert.equal(checkinStreak(['2026-09-23', '2026-09-22'], today), 2);
});

test('broken streak resets to zero', () => {
  const today = '2026-09-24';
  assert.equal(checkinStreak(['2026-09-20', '2026-09-19'], today), 0);
  assert.equal(checkinStreak([], today), 0);
});

test('streak stops at the first gap', () => {
  const today = '2026-09-24';
  const days = ['2026-09-24', '2026-09-23', '2026-09-21'];
  assert.equal(checkinStreak(days, today), 2);
});

test('shiftDay crosses month and year boundaries', () => {
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDay('2026-02-28', 1), '2026-03-01');
});

test('checkin reward grows with streak and is capped', () => {
  const params = { rewardCheckin: 5, rewardStreakStep: 1 };
  assert.equal(checkinReward(params, 0), 5);
  assert.equal(checkinReward(params, 3), 8);
  assert.equal(checkinReward(params, 999), 15); // 10-step cap
});

// ── Staking ────────────────────────────────────────────────────────────────
test('stake reward pro-rates APY over elapsed time', () => {
  const year = computeStakeReward(36500, 10, 365 * 86400000);
  assert.equal(year, 3650); // 10% of 36500 for a full year
  assert.equal(computeStakeReward(1000, 10, 0), 0);
  assert.equal(computeStakeReward(0, 10, 86400000), 0);
});

test('staking unlocks at the DAO threshold', () => {
  const params = { stakePremiumThreshold: 500 };
  assert.equal(stakingUnlocks(499, params).unlocked, false);
  assert.equal(stakingUnlocks(500, params).unlocked, true);
  assert.equal(stakingUnlocks(250, params).progress, 0.5);
});

// ── Achievements ───────────────────────────────────────────────────────────
test('achievement eligibility respects owned kinds and minimums', () => {
  const stats = { assessments: 1, checkinStreak: 7, staked: 100 };
  const eligible = eligibleAchievements(stats, ['first-steps']);
  const kinds = eligible.map((a) => a.kind);
  assert.ok(kinds.includes('week-warrior'));
  assert.ok(!kinds.includes('first-steps')); // already owned
  assert.ok(!kinds.includes('year-hero')); // not enough streak
});

test('achievement catalog metrics are unique and documented', () => {
  const kinds = ACHIEVEMENTS.map((a) => a.kind);
  assert.equal(new Set(kinds).size, kinds.length);
});

// ── Escrow economics ───────────────────────────────────────────────────────
test('escrow split takes the protocol fee and pays out the remainder', () => {
  const { fee, proceeds } = escrowSplit(100, 3);
  assert.equal(fee, 3);
  assert.equal(proceeds, 97);
  assert.equal(proceeds + fee, 100);
});

test('escrow split is safe for zero/odd fees', () => {
  assert.deepEqual(escrowSplit(10, 0), { fee: 0, proceeds: 10 });
  const part = escrowSplit(33.33, 3);
  assert.equal(round2(part.fee + part.proceeds), 33.33);
});

// ── Dispute resolution ─────────────────────────────────────────────────────
test('juror majority decides the dispute', () => {
  const verdict = disputeOutcome(
    [
      { juror: '0xj1', choice: 'buyer' },
      { juror: '0xj2', choice: 'buyer' },
      { juror: '0xj3', choice: 'seller' },
    ],
    ['0xj1', '0xj2', '0xj3']
  );
  assert.equal(verdict.outcome, 'buyer');
  assert.equal(verdict.complete, true);
});

test('non-juror votes are ignored', () => {
  const verdict = disputeOutcome(
    [
      { juror: '0xintruder', choice: 'buyer' },
      { juror: '0xj1', choice: 'seller' },
    ],
    ['0xj1', '0xj2']
  );
  assert.equal(verdict.buyer, 0);
  assert.equal(verdict.outcome, 'seller');
  assert.equal(verdict.complete, false); // 0xj2 has not voted yet
});

test('open jury (no appointed jurors) resolves on first clear verdict', () => {
  const verdict = disputeOutcome([{ juror: '0xany', choice: 'seller' }], []);
  assert.equal(verdict.outcome, 'seller');
  assert.equal(verdict.complete, true);
});

test('a tie yields no verdict', () => {
  const verdict = disputeOutcome(
    [
      { juror: '0xj1', choice: 'buyer' },
      { juror: '0xj2', choice: 'seller' },
    ],
    ['0xj1', '0xj2']
  );
  assert.equal(verdict.outcome, '');
  assert.equal(verdict.complete, true);
});

// ── Ledger primitives (pure part — no database needed) ─────────────────────
test('normalizeTx produces a stable hash for identical content', () => {
  const a = normalizeTx({ type: 'transfer', actor: '0xabc', data: { amount: 5 }, timestamp: 1700000000000 });
  const b = normalizeTx({ type: 'transfer', actor: '0xabc', data: { amount: 5 }, timestamp: 1700000000000 });
  assert.equal(a.txHash, b.txHash);
  assert.equal(a.dataHash, hashPayload({ amount: 5 }));
});

test('headerHash changes when any field changes (tamper evidence)', () => {
  const header = {
    index: 1,
    timestamp: 1700000000000,
    prevHash: 'a'.repeat(64),
    nonce: 42,
    txs: [normalizeTx({ type: 'x', actor: 'y', data: { v: 1 }, timestamp: 1 })],
  };
  const base = headerHash(header);
  assert.equal(headerHash({ ...header }), base);
  assert.notEqual(headerHash({ ...header, nonce: 43 }), base);
  assert.notEqual(headerHash({ ...header, prevHash: 'b'.repeat(64) }), base);
  assert.notEqual(
    base,
    headerHash({ ...header, txs: [normalizeTx({ type: 'x', actor: 'y', data: { v: 2 }, timestamp: 1 })] })
  );
});

test('proof-of-work difficulty is sane', () => {
  assert.ok(DIFFICULTY >= 1 && DIFFICULTY <= 5);
});

test('dayKey formats YYYY-MM-DD', () => {
  assert.match(dayKey(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
});

test('sha256Hex matches a known vector', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});
