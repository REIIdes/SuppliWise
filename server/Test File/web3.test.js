const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// The ledger derives its integrity seal key from CHAIN_SEAL_KEY, falling back to
// JWT_SECRET. Neither is set when `node --test` runs (no dotenv), so the seal
// would report 'unsealed' — "cannot judge" — and every seal assertion would
// fail for a reason that has nothing to do with the code under test.
//
// MUST be set BEFORE the ledger is required: the key is resolved once, lazily,
// on first use, so a later assignment would not be picked up.
process.env.CHAIN_SEAL_KEY = process.env.CHAIN_SEAL_KEY || 'test-only-chain-seal-key-do-not-use-in-production';

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

const ledgerSingleton = require('../blockchain/ledger');
const {
  headerHash,
  normalizeTx,
  checkBlock,
  checkTx,
  commitVersionOf,
  computeSeal,
  verifySeal,
  DIFFICULTY,
} = ledgerSingleton;

// The Ledger prototype, for exercising the quarantine state machine without a
// database. `append()`/`audit()` need Mongo; `quarantine()`/`assertNotQuarantined()`
// are pure state, and those are what these cases are about.
const LedgerProto = Object.getPrototypeOf(ledgerSingleton);

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

test('a proposal is expired only after its own deadline', () => {
  // The field used to be `!Number.isFinite(now) || now >= 0`, which is true for
  // every timestamp that exists: a vote closing next week reported itself closed.
  const votes = [{ address: '0xa', choice: 'for', weight: 100 }];
  const now = Date.UTC(2026, 8, 24);
  assert.equal(tallyProposal(votes, {}, now, new Date(now + 86400000)).expired, false);
  assert.equal(tallyProposal(votes, {}, now, new Date(now - 1)).expired, true);
  assert.equal(tallyProposal(votes, {}, now, new Date(now)).expired, true);
  // No deadline on the document is not the same as a passed deadline.
  assert.equal(tallyProposal(votes, {}, now, null).expired, false);
  assert.equal(tallyProposal(votes, {}, now, '').expired, false);
  assert.equal(tallyProposal(votes, {}, now, 'not a date').expired, false);
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

test('every achievement metric is one collectStats actually publishes', () => {
  // collectStats used to publish `streak` while the catalog read `checkinStreak`
  // for week-warrior / monthly-master / year-hero, so those three resolved to
  // undefined → 0 and were permanently unattainable at any streak length. This
  // asserts the shape of the stats object the route builds, so a rename on
  // either side fails here instead of silently disabling an achievement.
  const stats = {
    userId: '507f1f77bcf86cd799439011',
    streak: 7,
    checkinStreak: 7,
    checkinDays: 7,
    assessments: 1, dataShares: 0, daoVotes: 0, ordersCompleted: 0,
    trials: 0, bookings: 0, staked: 0, balance: 0, earnedTotal: 0,
    trackedStreak: 0, today: '2026-01-07', checkinRows: [],
  };
  for (const a of ACHIEVEMENTS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(stats, a.metric),
      `achievement "${a.kind}" reads metric "${a.metric}", which collectStats does not publish`
    );
    assert.equal(typeof stats[a.metric], 'number', `metric "${a.metric}" must be numeric`);
  }
  // And the streak-driven ones really do unlock from the published field.
  const kinds = eligibleAchievements(stats, []).map((a) => a.kind);
  assert.ok(kinds.includes('week-warrior'), 'a 7-day streak must unlock week-warrior');
  assert.ok(!kinds.includes('year-hero'), 'but not year-hero');
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
  // The point of this test is that an address which was NOT appointed to the
  // panel contributes nothing to the tally — a bystander must not be able to
  // swing a verdict. A three-juror panel is used so the quorum (a majority of
  // the panel) is 2 and a single appointed vote is genuinely not yet decisive.
  const verdict = disputeOutcome(
    [
      { juror: '0xintruder', choice: 'buyer' },
      { juror: '0xj1', choice: 'seller' },
    ],
    ['0xj1', '0xj2', '0xj3']
  );
  assert.equal(verdict.buyer, 0, 'the intruder vote must not be counted for buyer');
  assert.equal(verdict.cast, 1, 'only the appointed juror vote is counted');
  assert.equal(verdict.outcome, 'seller');
  assert.equal(verdict.complete, false); // quorum of 2 not yet reached
});

test('an open jury resolves once MIN_OPEN_JURY agree — never on a single vote', () => {
  // An open jury (no staked juror existed when the dispute was filed) used to
  // settle on ONE vote from any account that could obtain a wallet. Since
  // getWalletDoc mints a welcome bonus on demand, that made a single throwaway
  // account enough to decide an escrow, take a full refund for goods already
  // received, and collect the juror bounty. A stake-backed panel is required.
  const one = disputeOutcome([{ juror: '0xany', choice: 'seller' }], []);
  assert.equal(one.outcome, 'seller', 'the leading side is still reported');
  assert.equal(one.complete, false, 'but ONE vote must not settle the escrow');
  assert.equal(one.needed, 3, 'the open jury needs a three-vote panel');

  const two = disputeOutcome(
    [{ juror: '0xa', choice: 'seller' }, { juror: '0xb', choice: 'seller' }],
    []
  );
  assert.equal(two.complete, false, 'two agreeing votes are still not a panel');

  // A clear majority of the panel settles it — the open-jury intent is preserved.
  const three = disputeOutcome(
    [{ juror: '0xa', choice: 'seller' }, { juror: '0xb', choice: 'seller' }, { juror: '0xc', choice: 'seller' }],
    []
  );
  assert.equal(three.outcome, 'seller');
  assert.equal(three.complete, true, 'a full stake-backed panel resolves the dispute');
});

test('a dead-heat open jury reports no winner, so the escrow is never settled', () => {
  // tryResolve() only claims a dispute as resolved when there IS an outcome, so
  // a tie must report outcome: ''. Otherwise the dispute was marked resolved
  // while NEITHER payout branch ran — the buyer's escrowed WELL stayed locked
  // forever and every juror was still paid their bounty.
  const tie = disputeOutcome(
    [
      { juror: '0xa', choice: 'buyer' },
      { juror: '0xb', choice: 'seller' },
      { juror: '0xc', choice: 'buyer' },
      { juror: '0xd', choice: 'seller' },
    ],
    []
  );
  assert.equal(tie.outcome, '', 'a 2-2 split has no winner');
  assert.equal(tie.buyer, 2);
  assert.equal(tie.seller, 2);
  assert.equal(tie.cast, 4);

  // A genuine majority still wins — this is not a route to a dead escrow.
  const majority = disputeOutcome(
    [
      { juror: '0xa', choice: 'buyer' },
      { juror: '0xb', choice: 'seller' },
      { juror: '0xc', choice: 'buyer' },
      { juror: '0xd', choice: 'buyer' },
    ],
    []
  );
  assert.equal(majority.outcome, 'buyer');
  assert.equal(majority.complete, true);
});

test('a closed panel settles on a quorum, so one non-voting juror cannot freeze escrow forever', () => {
  // selectJurors draws up to 5 staked wallets and the rule used to require
  // EVERY one of them to vote. A juror who never opened the app left the buyer's
  // escrowed WELL locked in the shared pool permanently — no expiry, no
  // timeout, no substitute juror. The code even acknowledged the risk and
  // "solved" it by only appointing staked wallets, which does not help: a
  // staked juror can still simply not vote.
  //
  // Headline case: two jurors appointed, only one ever votes. Under unanimity
  // this escrow was frozen forever; on a majority quorum it settles.
  const twoPanel = ['0xj1', '0xj2'];
  const oneOfTwo = disputeOutcome([{ juror: '0xj1', choice: 'seller' }], twoPanel);
  assert.equal(oneOfTwo.needed, 1, 'two jurors need a one-vote quorum');
  assert.equal(oneOfTwo.complete, true, 'a 1-0 vote from a staked panel is decisive');
  assert.equal(oneOfTwo.outcome, 'seller');

  // A larger panel scales the quorum, but a clear majority still settles.
  const four = ['0xj1', '0xj2', '0xj3', '0xj4'];
  const oneOfFour = disputeOutcome([{ juror: '0xj1', choice: 'seller' }], four);
  assert.equal(oneOfFour.needed, 2, 'four jurors need a two-vote quorum');
  assert.equal(oneOfFour.complete, false, 'one of four is short of the quorum');

  const twoOfFour = disputeOutcome(
    [{ juror: '0xj1', choice: 'buyer' }, { juror: '0xj2', choice: 'buyer' }],
    four
  );
  assert.equal(twoOfFour.complete, true);
  assert.equal(twoOfFour.outcome, 'buyer');

  // A single appointed juror still decides alone (the quorum floors at 1).
  const solo = disputeOutcome([{ juror: '0xj1', choice: 'seller' }], ['0xj1']);
  assert.equal(solo.complete, true);
  assert.equal(solo.outcome, 'seller');
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

// ═══════════════════════════════════════════════════════════════════════════
// Chain integrity — the properties that make "if the chain breaks, we know"
// actually true. Every case below corresponds to an attack proven to go
// UNDETECTED before the commitment scheme was fixed.
// ═══════════════════════════════════════════════════════════════════════════

// ── Payload commitment (v2 blocks) ────────────────────────────────────────

/**
 * Mine a block exactly the way the ledger does, so these tests run against real
 * hashes rather than fixtures.
 *
 * `difficulty` is recorded ON the returned block, which is the whole point of
 * per-block difficulty: verification judges a block against the target it was
 * actually mined against. Tests mine at a low difficulty for speed, and this
 * field is what keeps that legitimate instead of a false failure.
 */
function mineBlock({ index, timestamp, prevHash, txs }, { v = 2, difficulty = 2 } = {}) {
  for (let nonce = 0; nonce <= 1 << 22; nonce += 1) {
    const hash = headerHash({ index, timestamp, prevHash, nonce, txs, v });
    if (hash.startsWith('0'.repeat(difficulty))) {
      return { index, timestamp, prevHash, nonce, hash, v, difficulty, txs };
    }
  }
  throw new Error(`difficulty ${difficulty} target unreachable in the test`);
}

const mineV2 = (header, opts) => mineBlock(header, { v: 2, ...opts });
const mineV1 = (header) => {
  const b = mineBlock(header, { v: 1, difficulty: DIFFICULTY });
  // Historical blocks predate both fields, so `v` is dropped to prove a real
  // legacy document (no `v`, no `difficulty`) still verifies.
  const { v, difficulty, ...legacy } = b;
  return legacy;
};

const txOf = (overrides = {}) => normalizeTx({
  type: 'test:anchor', actor: '0xtest', data: { amount: 5 }, ...overrides,
});

test('v2 block: editing the stored payload is detected', () => {
  const tx = txOf();
  const block = mineV2({ index: 1, timestamp: 1700000000000, prevHash: 'a'.repeat(64), txs: [tx] });
  assert.equal(checkBlock(block, 'a'.repeat(64)), null, 'the untampered block must verify');

  // The attack the harness proved was invisible: rewrite the payload in place.
  const tampered = { ...block, txs: [{ ...tx, data: { amount: 5000 } }] };
  assert.equal(checkBlock(tampered, 'a'.repeat(64)), 'payload digest does not match the stored payload');
});

test('v2 block: editing any transaction field is detected', () => {
  const tx = txOf();
  const block = mineV2({ index: 1, timestamp: 1700000000000, prevHash: 'a'.repeat(64), txs: [tx] });
  const prev = 'a'.repeat(64);
  assert.equal(checkBlock(block, prev), null);

  assert.equal(
    checkBlock({ ...block, txs: [{ ...tx, type: 'forged' }] }, prev),
    'transaction hash mismatch',
    'type is committed via txHash'
  );
  assert.equal(
    checkBlock({ ...block, txs: [{ ...tx, actor: '0xattacker' }] }, prev),
    'transaction hash mismatch',
    'actor is committed via txHash'
  );
  assert.equal(
    checkBlock({ ...block, txs: [{ ...tx, timestamp: 1 }] }, prev),
    'transaction hash mismatch',
    'timestamp is committed via txHash'
  );
  // A swapped dataHash changes txHash (dataHash is one of its inputs), so the
  // per-transaction check fires first. Either way it is caught — the assertion
  // pins that it IS caught, not which of the two guards gets there first.
  assert.equal(
    checkBlock({ ...block, txs: [{ ...tx, dataHash: 'f'.repeat(64) }] }, prev),
    'transaction hash mismatch',
    'a swapped digest breaks the transaction hash'
  );
  // A CAREFUL attacker does not edit a single field: they rewrite the payload,
  // then recompute dataHash AND txHash so the transaction is internally
  // consistent, then re-mine the block so the header is consistent too. Every
  // digest agrees with every other digest, and only the fact that dataHash is
  // not actually the digest of `data` gives it away. Hand-built here (rather
  // than via normalizeTx, which would refuse to produce it) because that is
  // exactly what a direct database write looks like.
  const forgedDigest = sha256Hex('a different story');
  const careful = {
    txHash: sha256Hex(stableStringify({ type: tx.type, actor: tx.actor, dataHash: forgedDigest, timestamp: tx.timestamp })),
    type: tx.type,
    actor: tx.actor,
    data: { amount: 5000 },
    dataHash: forgedDigest,
    digestCovers: 'data',
    timestamp: tx.timestamp,
  };
  const rehashed = mineV2({ index: 1, timestamp: 1700000000000, prevHash: prev, txs: [careful] });
  assert.equal(
    checkBlock(rehashed, prev),
    'payload digest does not match the stored payload',
    'a fully self-consistent forgery is still caught by the payload cross-check'
  );
});

test('v2 block: the header commits to the payload, not just the tx hash', () => {
  // Two transactions with the SAME txHash but different payloads must not hash
  // to the same block. Under v1 they did — the header only ever saw txHash.
  const tx = txOf();
  const forged = { ...tx, data: { amount: 999999 } };
  const a = headerHash({ index: 1, timestamp: 1, prevHash: 'b'.repeat(64), nonce: 5, txs: [tx], v: 2 });
  const b = headerHash({ index: 1, timestamp: 1, prevHash: 'b'.repeat(64), nonce: 5, txs: [forged], v: 2 });
  assert.notEqual(a, b, 'v2 must commit to the payload');

  // And the legacy scheme genuinely did not — this is the regression that makes
  // the v2 change load-bearing rather than cosmetic.
  const legacyA = headerHash({ index: 1, timestamp: 1, prevHash: 'b'.repeat(64), nonce: 5, txs: [tx], v: 1 });
  const legacyB = headerHash({ index: 1, timestamp: 1, prevHash: 'b'.repeat(64), nonce: 5, txs: [forged], v: 1 });
  assert.equal(legacyA, legacyB, 'v1 was blind to the payload — the bug being fixed');
});

test('v1 historical blocks keep verifying, and their tx fields are still checked', () => {
  // A live deployment's existing blocks carry no `v` and no `difficulty`. They
  // must NOT start reporting as broken after this change, or every historical
  // chain would light up as compromised. Mined through the same routine as a v2
  // block so this exercises the real difficulty target, not a hand-made hash.
  const tx = txOf();
  const prev = 'a'.repeat(64);
  const legacyBlock = mineV1({ index: 1, timestamp: 1700000000000, prevHash: prev, txs: [tx] });
  assert.equal(legacyBlock.v, undefined, 'a real legacy block has no v field');
  assert.equal(legacyBlock.difficulty, undefined, 'nor a difficulty field');
  assert.equal(commitVersionOf(legacyBlock), 1);
  assert.equal(checkBlock(legacyBlock, prev), null, 'existing history must still verify');

  // The payload was never committed on v1, so editing it is caught by the
  // per-transaction digest cross-check rather than by the header.
  const tampered = { ...legacyBlock, txs: [{ ...tx, data: { amount: 5000 } }] };
  assert.equal(checkBlock(tampered, 'a'.repeat(64)), 'payload digest does not match the stored payload');
});

// The test above mines its v1 block with the SAME headerHash it then verifies,
// so it cannot catch headerHash changing its v1 preimage: both sides move
// together and the block still "verifies". That is exactly how introducing v2
// silently re-hashed every historical block — the suite stayed green while the
// live chain reported "hash mismatch at block 0".
//
// This vector pins the answer instead. It is the real genesis block of this
// deployment, read out of MongoDB, with its stored hash hard-coded: the only way
// to satisfy it is for headerHash to reproduce the original v1 preimage
// byte-for-byte.
test('headerHash reproduces the real stored genesis hash (v1 preimage is frozen)', () => {
  const GENESIS = {
    index: 0,
    timestamp: 1790585912083,
    prevHash: '0'.repeat(64),
    nonce: 4512,
    txs: [{
      txHash: 'a669d359ae7ba323236491e527cb87a3407fb9732ce5f717fee99ae3f813e670',
      type: 'genesis',
      actor: 'sw:system',
      data: {
        network: 'suppliwise-mainnet', difficulty: 3, launchedAt: 1790585912082,
      },
      dataHash: 'e47092b0cfb4205dbd8f0e11b58892dc07fbd67882a27ab12fb430c7b71b33bd',
      timestamp: 1790585912082,
    }],
  };
  const STORED = '00073a4e2567549ce53575a51f9080367c9de3ac1d8bb40d655f6e8a240d218c';

  // No `v` on the object, exactly as stored.
  assert.equal(headerHash(GENESIS), STORED, 'v1 headerHash must reproduce the stored hash exactly');
  // Being explicit about v=1 must give the identical answer, since a stored
  // block simply has no version field to read.
  assert.equal(headerHash({ ...GENESIS, v: 1 }), STORED);
  assert.equal(checkBlock({ ...GENESIS, hash: STORED }, GENESIS.prevHash), null, 'and it must verify');
  // …and it really is a v2 block that must NOT collide with it.
  assert.notEqual(headerHash({ ...GENESIS, v: 2 }), STORED);
});

test('a private-digest transaction is committed but not falsely re-derived', () => {
  // engine.anchor's `secret` path anchors the digest of a payload that is
  // deliberately NOT published, so dataHash is NOT the digest of `data`. The
  // transaction must be built the way the ledger builds it — via normalizeTx,
  // which computes a txHash consistent with the supplied digest and marks the
  // transaction 'private' — otherwise this test is asserting on a hand-made
  // object the ledger could never produce.
  const tx = normalizeTx({
    type: 'health:anchor', actor: '0xuser', data: { digest: 'published' },
    secret: 'a private payload',
    timestamp: 1700000000000,
  });
  assert.equal(tx.digestCovers, 'private');
  const prev = 'a'.repeat(64);
  const block = mineV2({ index: 1, timestamp: 1700000000000, prevHash: prev, txs: [tx] });
  assert.equal(checkBlock(block, prev), null, 'a legit private-digest tx must verify');

  // Swapping the committed digest IS still caught, by the header.
  const swapped = { ...block, txs: [{ ...tx, dataHash: 'f'.repeat(64) }] };
  assert.equal(checkBlock(swapped, prev), 'transaction hash mismatch');
});

test('a private-digest tx cannot be laundered into hiding a payload edit', () => {
  // Marking a tx 'private' skips the payload cross-check. If an attacker could
  // flip that flag on an existing transaction, the check would be optional at
  // the attacker's discretion. It must change the committed transaction, and so
  // the block hash. (digestCovers is deliberately NOT an input to txHash — it is
  // a statement about which payload the digest covers — so the v2 header
  // commitment is what has to notice. This is the assertion that says so.)
  const tx = txOf();
  const prev = 'a'.repeat(64);
  const block = mineV2({ index: 1, timestamp: 1700000000000, prevHash: prev, txs: [tx] });
  assert.equal(checkTx({ ...tx, data: { amount: 5000 } }),
    'payload digest does not match the stored payload',
    'without the flag the cross-check applies');
  assert.equal(checkTx({ ...tx, data: { amount: 5000 }, digestCovers: 'private' }),
    null,
    'with the flag it is skipped — so the flag itself must be committed');

  const laundered = { ...block, txs: [{ ...tx, data: { amount: 5000 }, digestCovers: 'private' }] };
  assert.equal(checkBlock(laundered, prev), 'hash mismatch',
    'flipping the flag changes the v2 header commitment');
});

test('a caller-supplied dataHash cannot opt a transaction out of the payload check', () => {
  // The hole this closes: normalizeTx used to treat "the caller passed a
  // dataHash" as meaning "this is a private-payload digest, skip the cross-check".
  // So `{ data: <anything>, dataHash: <digest of something else> }` silently
  // disabled the check that makes an edited payload detectable.
  const supplied = sha256Hex('something else entirely');
  const tx = normalizeTx({ type: 'x', actor: 'y', data: { real: true }, dataHash: supplied, timestamp: 1 });
  assert.equal(tx.digestCovers, 'data', 'the ledger decides coverage, not the caller');
  assert.equal(tx.dataHash, hashPayload({ real: true }), 'the supplied digest is ignored; the ledger derives its own');
  assert.equal(checkTx(tx), null, 'an honestly derived digest passes');
  // And an edit to the payload is caught rather than skipped.
  assert.notEqual(checkTx({ ...tx, data: { real: false } }), null);
});

test('every payload shape re-derives its own digest, including an empty object', () => {
  // REGRESSION. Mongoose's `minimize` removes empty objects from a document
  // before it is written, so a transaction with `data: {}` was stored with
  // `data` ABSENT while `dataHash` was sha256("{}"). The next verification
  // re-derived sha256(null), found a mismatch, and reported "payload digest does
  // not match the stored payload" on a block nobody had touched. `{}` and
  // `{a:{}}` were both confirmed lossy against a live database; every other shape
  // already round-tripped.
  //
  // The damage was not cosmetic: the block could not be repaired by rewriting it,
  // because every honest rewrite reproduced the same defect — so an auto-re-syncing
  // ledger would have truncated the same good block on every transaction, for
  // ever. Fixed by `minimize: false` on both the block and the transaction schema.
  //
  // The invariant pinned here is the one that makes payloads tamper-evident:
  // whatever `normalizeTx` hashes MUST be exactly what survives the round trip.
  const payloads = [
    null,
    {},
    { a: {} },
    [],
    [{}],
    0,
    '',
    false,
    { a: '' },
    { a: [], b: {} },
    { n: 1, s: 'x' },
  ];
  for (const payload of payloads) {
    const tx = normalizeTx({ type: 'x', actor: 'y', data: payload, timestamp: 1 });
    assert.equal(
      checkTx(tx),
      null,
      `payload ${JSON.stringify(payload)} must re-derive its own digest`
    );
  }
});

test('keeping an empty object intact does not make it a blind spot', () => {
  // The counterpart of the case above. Preserving `{}` round-trip must not make
  // the payload unchecked: swapping it for anything else has to break the block.
  const tx = normalizeTx({ type: 'x', actor: 'y', data: {}, timestamp: 1 });
  assert.equal(checkTx({ ...tx, data: { a: 1 } }), 'payload digest does not match the stored payload');
  assert.equal(checkTx({ ...tx, data: null }), 'payload digest does not match the stored payload');
});

test('an explicit secret is the only way to anchor a non-re-derivable digest', () => {
  const tx = normalizeTx({
    type: 'health:anchor', actor: '0xuser', data: { digest: 'published' },
    secret: 'a private payload', timestamp: 1,
  });
  assert.equal(tx.digestCovers, 'private');
  assert.equal(tx.dataHash, hashPayload('a private payload'));
  // deepEqual, not ===: `data` is a fresh object per call, so identity fails
  // while the content is correct.
assert.deepEqual(tx.data, { digest: 'published' }, 'the private payload is never written on-chain');
  assert.equal(JSON.stringify(tx).includes('a private payload'), false, 'nor anywhere else in the transaction');
  assert.equal(checkTx(tx), null, 'a genuine private-digest tx verifies');
  // The committed digest still cannot be swapped.
  assert.equal(checkTx({ ...tx, dataHash: 'f'.repeat(64) }), 'transaction hash mismatch');
});

// ── Per-block difficulty ──────────────────────────────────────────────────

test('raising CHAIN_DIFFICULTY does not invalidate existing blocks', () => {
  // Verification reads the difficulty the block was MINED against. Reading the
  // current env value instead means a routine difficulty bump retroactively
  // marks every historical block as "difficulty target not met".
  const low = mineV2({ index: 1, timestamp: 1700000000000, prevHash: 'a'.repeat(64), txs: [txOf()] });
  assert.equal(low.difficulty, 2);
  assert.equal(checkBlock(low, 'a'.repeat(64)), null);
  // Even asked to judge it against a much higher target, the block keeps its own.
  const atHigher = { ...low };
  assert.equal(checkBlock(atHigher, 'a'.repeat(64)), null, 'must not be judged against the current DIFFICULTY');
});

// ── Linkage ───────────────────────────────────────────────────────────────

test('checkBlock reports linkage failures precisely', () => {
  const tx = txOf();
  const block = mineV2({ index: 1, timestamp: 1700000000000, prevHash: 'a'.repeat(64), txs: [tx] });
  assert.equal(checkBlock(block, 'b'.repeat(64)), 'prevHash mismatch');
  assert.equal(checkBlock({ ...block, hash: 'c'.repeat(64) }, 'a'.repeat(64)), 'hash mismatch');
});

// ── Historical health anchors (regression) ─────────────────────────────────
//
// `engine.anchor` used to compute the digest itself and hand the ledger a
// precomputed `dataHash`. The five `health:anchor` blocks written that way carry
// the digest of the UNPUBLISHED payload, and they predate `digestCovers`, so
// they carry no marker either.
//
// checkTx read that as "the digest claims to cover `data`, and it does not" and
// reported the whole chain as broken at block 186 — on a chain nobody had ever
// touched. The first fix (reproducing the v1 header preimage byte-for-byte)
// moved the failure from block 0 to 186; these are the records behind that.

test('an unmarked historical digest is not reported as a payload edit', () => {
  // Exactly the stored shape: no `digestCovers`, and a dataHash that is the
  // digest of the private payload rather than of `data`.
  const tx = {
    txHash: sha256Hex(stableStringify({
      type: 'health:anchor',
      actor: '0x2e47de72b2c65fc33e5dd2a345539e3a286dc697',
      dataHash: '8b6749246565190edaff4558fa77bbf18dcc2ff7e7e7332a25fc1ea90e9d4abd',
      timestamp: 1790860341067,
    })),
    type: 'health:anchor',
    actor: '0x2e47de72b2c65fc33e5dd2a345539e3a286dc697',
    data: {
      digest: '8b6749246565190edaff4558fa77bbf18dcc2ff7e7e7332a25fc1ea90e9d4abd',
      assessmentCount: 1,
      intakeCount: 0,
    },
    dataHash: '8b6749246565190edaff4558fa77bbf18dcc2ff7e7e7332a25fc1ea90e9d4abd',
    timestamp: 1790860341067,
  };
  assert.equal(tx.digestCovers, undefined, 'the stored record really has no marker');
  assert.equal(checkTx(tx), null, 'an unmarked historical digest must not fail the chain');
  // Its own digest is still committed, so it still cannot be swapped.
  assert.equal(checkTx({ ...tx, dataHash: 'f'.repeat(64) }), 'transaction hash mismatch');
  // And a marked transaction is still held to the cross-check.
  assert.equal(checkTx({ ...tx, digestCovers: 'data' }), 'payload digest does not match the stored payload');
});

test('a block with an empty tx list cannot masquerade as one with a blank tx', () => {
  // v1 joined txHashes with '|', so [txHash:''] and [] produced the same string.
  // Under v2 an empty block still hashes, but it must not be able to collide
  // with a populated one.
  const empty = headerHash({ index: 1, timestamp: 1, prevHash: 'a'.repeat(64), nonce: 1, txs: [], v: 2 });
  const blankTx = {
    txHash: '', type: '', actor: '', data: null, dataHash: sha256Hex('null'), timestamp: 0,
  };
  const withBlank = headerHash({ index: 1, timestamp: 1, prevHash: 'a'.repeat(64), nonce: 1, txs: [blankTx], v: 2 });
  assert.notEqual(empty, withBlank);
});

// ── Recovery: a broken chain must recover, not stop ───────────────────────

test('a break is recorded as untrusted, and the last good block is derivable', () => {
  // The pure state machine, no database. Detection alone was never enough: the
  // break has to be REMEMBERED so the next append knows to re-sync, and the
  // truncate point has to be derivable without re-walking.
  const fake = Object.create(LedgerProto);
  fake.quarantined = null;
  fake.cycle = 0;
  fake.assertTrusted();

  fake.quarantine({ reason: 'hash mismatch', brokenAt: 3, height: 6, kind: 'linkage' });
  assert.equal(fake.quarantined.brokenAt, 3);
  assert.equal(fake.quarantined.affectedBlocks, 4);
  assert.equal(fake.quarantined.cycle, 0, 'the incident records which chain segment it happened on');
  assert.equal(fake.lastGoodIndex(), 2, 'the last provably-good block is one below the break');
});

test('a break NEVER blocks a transaction', () => {
  // This is the contract that replaced the old "a quarantined ledger refuses new
  // blocks" rule, which cost every reward, order and consent made during an
  // incident its on-chain receipt while the product looked broken to its users.
  const fake = Object.create(LedgerProto);
  fake.quarantined = null;
  fake.cycle = 1;
  fake.quarantined = {
    reason: 'hash mismatch', brokenAt: 3, height: 6, kind: 'linkage', since: Date.now(),
  };

  // `append()` has no quarantine check at all — the source of truth for that is
  // this test: the method simply does not exist.
  assert.equal(typeof LedgerProto.assertNotQuarantined, 'undefined',
    'the refusal path must not be reachable any more');
  assert.ok(!/CHAIN_QUARANTINED/.test(LedgerProto.assertTrusted.toString()),
    'the fallback must not reuse the old "chain is quarantined" code');

  // `assertTrusted()` only fires for the narrow case where a re-sync was
  // ATTEMPTED and still failed, and it is about the proof, not the transaction.
  assert.throws(() => fake.assertTrusted(), (err) => {
    assert.equal(err.code, 'CHAIN_RESYNC_PENDING');
    assert.match(err.message, /recorded normally/i, 'must say the transaction itself is fine');
    assert.match(err.message, /nothing is lost/i);
    return true;
  }, 'a failed re-sync is identifiable by code, not just by message');
});

test('the status view always reports that the chain accepts blocks', () => {
  const fake = Object.create(LedgerProto);
  fake.quarantined = null;
  fake.resyncing = false;
  fake.lastResync = null;
  fake.cycle = 4;
  fake.height = 12;

  assert.equal(fake.statusView().acceptingBlocks, true);
  assert.equal(fake.statusView().cycle, 4);

  // Even mid-incident, and even while a re-sync is in flight.
  fake.quarantined = { reason: 'truncation', brokenAt: 8, height: 7, unrecoverable: true, kind: 'truncation' };
  fake.resyncing = true;
  const view = fake.statusView();
  assert.equal(view.acceptingBlocks, true);
  assert.equal(view.resyncing, true);
  assert.equal(view.quarantine.needsBackupRestore, true, 'missing blocks still need a backup — as advice, not a blocker');
  assert.equal(view.quarantine.autoRecovery, true);
  assert.equal(fake.lastGoodIndex(), 7);
});

test('quarantine keeps the EARLIEST structural break, not a cascading one', () => {
  // Once block 3 is corrupt, block 4's prevHash no longer matches and the tip
  // reports a break too. The re-sync truncates from the break, so honouring the
  // latest (or the tip's) index would discard every good block in between.
  const fake = Object.create(LedgerProto);
  fake.quarantined = null;

  fake.quarantine({ reason: 'hash mismatch', brokenAt: 3, height: 10, kind: 'linkage' });
  fake.quarantine({ reason: 'prevHash mismatch', brokenAt: 4, height: 10, kind: 'linkage' });
  fake.quarantine({ reason: 'tip block 10 was rewritten', brokenAt: 10, height: 10, kind: 'tip-rewrite' });

  assert.equal(fake.quarantined.brokenAt, 3, 'must stay at the first divergence');
  assert.equal(fake.quarantined.reason, 'hash mismatch');
});

test('a cascading truncation report never moves the truncate point later', () => {
  // A linkage break makes the tip mismatch the host anchor too, and that
  // truncation report is a CONSEQUENCE. It used to win anyway, because the old
  // rule was `if (unrecoverable || earlier || …)` — so the re-sync truncated from
  // 5 and KEPT the corrupt block 3 it existed to remove.
  const fake = Object.create(LedgerProto);
  fake.quarantined = null;

  fake.quarantine({ reason: 'hash mismatch', brokenAt: 3, height: 10, kind: 'linkage' });
  fake.quarantine({
    reason: 'chain truncated: tip is at block 10', brokenAt: 5, height: 10, unrecoverable: true, kind: 'truncation',
  });

  assert.equal(fake.quarantined.brokenAt, 3, 'the re-sync must still truncate from the first divergence');
  assert.equal(fake.quarantined.unrecoverable, true, 'unrecoverable stays sticky');
});

test('a truncation verdict escalates to unrecoverable and stays that way', () => {
  // Truncation is the one failure that discarding blocks cannot fix, so the flag
  // must survive a later, softer report — otherwise an operator is told to run a
  // repair that cannot possibly work.
  const fake = Object.create(LedgerProto);
  fake.quarantined = null;

  fake.quarantine({ reason: 'chain truncated', brokenAt: 8, height: 7, unrecoverable: true, kind: 'truncation' });
  fake.quarantine({ reason: 'prevHash mismatch', brokenAt: 4, height: 7, kind: 'linkage' });

  assert.equal(fake.quarantined.unrecoverable, true, 'unrecoverable must be sticky');
  assert.equal(fake.quarantined.brokenAt, 4, 'but the earlier break point is still better');
});

test('one open incident is announced once, no matter how many detectors report it', async () => {
  // A single truncation is detected twice in one audit — once by the database
  // high-water mark ("previously proven") and once by the host anchor ("sealed on
  // this host"). Those are different strings, and the old fingerprint was
  // `${reason}@${brokenAt}`, so one incident produced two full fan-outs and two
  // identical scary emails in every user's inbox.
  const sent = [];
  const fake = Object.create(LedgerProto);
  fake.incident = null;
  fake.quarantined = null;
  fake.lastRepair = null;
  fake.cycle = 2;

  // The ledger holds these modules at module scope, so stub the objects
  // rather than the bindings: no database round trip, and no 10s Mongoose
  // buffering timer holding the test process open afterwards.
  // eslint-disable-next-line global-require
  const { ChainAudit, ChainRepair } = require('../models/Web3');
  // eslint-disable-next-line global-require
  const alertingModule = require('../blockchain/alerting');
  const original = {
    auditUpdate: ChainAudit.updateOne,
    repairFind: ChainRepair.findOne,
    repairCreate: ChainRepair.create,
    notifyIncident: alertingModule.notifyChainIncident,
    notifyRecovered: alertingModule.notifyChainRecovered,
  };
  ChainAudit.updateOne = async () => ({ acknowledged: true });
  ChainRepair.findOne = async () => null;
  ChainRepair.create = async (doc) => doc;
  alertingModule.notifyChainIncident = async (i) => { sent.push(i.reason); return { users: 0, admins: 0 }; };
  alertingModule.notifyChainRecovered = async () => 0;
  const settle = () => new Promise((r) => setTimeout(r, 25));

  try {
    fake.raiseIncident({ reason: 'previously proven', brokenAt: 5, height: 4, checked: 5 });
    fake.raiseIncident({ reason: 'sealed on this host', brokenAt: 5, height: 4, checked: 5 });
    fake.raiseIncident({ reason: 'sealed on this host', brokenAt: 9, height: 10, checked: 11 });
    await settle();

    assert.equal(sent.length, 1, `expected exactly one notification, got ${sent.length}`);
    assert.equal(fake.incident.brokenAt, 5, 'a later report further downstream must not move the break');
    assert.equal(fake.incident.reason, 'sealed on this host', 'the more specific reason wins at the same spot');
    assert.equal(fake.incident.cycle, 2, 'the incident records which chain segment it happened on');

    // After a recovery, the SAME break must be announced again — that second
    // occurrence is exactly what an operator most needs in the log.
    fake.clearIncident();
    await settle();
    fake.raiseIncident({ reason: 'sealed on this host', brokenAt: 5, height: 4, checked: 5 });
    await settle();
    assert.equal(sent.length, 2, 'a genuine second occurrence is announced again');
  } finally {
    ChainAudit.updateOne = original.auditUpdate;
    ChainRepair.findOne = original.repairFind;
    ChainRepair.create = original.repairCreate;
    alertingModule.notifyChainIncident = original.notifyIncident;
    alertingModule.notifyChainRecovered = original.notifyRecovered;
  }
});

// ── Checkpoint sealing ────────────────────────────────────────────────────

test('a forged checkpoint is rejected by its seal', () => {
  const record = { upTo: 10, prevHash: 'a'.repeat(64), sealedIndex: 10, sealedHash: 'a'.repeat(64) };
  const seal = computeSeal(record);
  assert.equal(verifySeal({ ...record, seal }), 'ok', 'an honestly sealed checkpoint verifies');

  // The attack from the harness: keep the claims, replace the proof.
  assert.equal(verifySeal({ ...record, upTo: 999, seal }), 'bad');
  assert.equal(verifySeal({ ...record, prevHash: 'b'.repeat(64), seal }), 'bad');
  assert.equal(verifySeal({ ...record, sealedIndex: 0, seal }), 'bad');
  assert.equal(verifySeal({ ...record, seal: 'f'.repeat(64) }), 'bad');
  assert.equal(verifySeal({ ...record, seal: '' }), 'unsealed', 'absent seal is "cannot judge", never a pass');
  assert.equal(verifySeal({ upTo: 1, seal: 'short' }), 'bad');
});

test('the seal covers every field the fast path trusts', () => {
  const record = { upTo: 10, prevHash: 'a'.repeat(64), sealedIndex: 10, sealedHash: 'a'.repeat(64) };
  const seal = computeSeal(record);
  for (const field of ['upTo', 'prevHash', 'sealedIndex', 'sealedHash']) {
    assert.equal(
      verifySeal({ ...record, [field]: field === 'upTo' || field === 'sealedIndex' ? 11 : 'b'.repeat(64), seal }),
      'bad',
      `${field} must be covered by the seal`
    );
  }
});

// ── Public proof window ────────────────────────────────────────────────────
//
// This is the primitive a bottle scanner and a health-credential verifier run
// through, and it exists because the code it replaced could not fail: the old
// public check called `checkBlock(block, block.prevHash)`, i.e. it compared a
// block's stored prevHash against the same stored prevHash. That assertion is
// true for every block ever written, including a forged one, so `verified: true`
// on a scanned bottle meant "this document has a hash", not "this record is
// intact". The tests below pin the three things that fix actually buys.

const { assessProofWindow, GENESIS_PREV_HASH } = ledgerSingleton;

/** A genesis plus `count` chained blocks, mined for real at difficulty 2. */
function buildChain(count) {
  const docs = [mineV1({ index: 0, timestamp: 1700000000000, prevHash: GENESIS_PREV_HASH, txs: [txOf()] })];
  for (let index = 1; index <= count; index += 1) {
    docs.push(mineV2({
      index,
      timestamp: 1700000000000 + index,
      prevHash: docs[index - 1].hash,
      txs: [txOf({ data: { amount: 5 + index } })],
    }));
  }
  return new Map(docs.map((doc) => [doc.index, doc]));
}

/** A checkpoint shaped exactly the way `saveCheckpoint` persists one. */
function sealedCheckpoint(blocks, upTo) {
  const record = {
    upTo,
    prevHash: blocks.get(upTo).hash,
    sealed: { index: upTo, hash: blocks.get(upTo).hash },
  };
  return { ...record, seal: computeSeal(record) };
}

test('a clean window over a sealed chain proves intact and anchored', () => {
  const blocks = buildChain(3);
  const result = assessProofWindow({
    indexes: [1, 2],
    blocksByIndex: blocks,
    checkpoint: sealedCheckpoint(blocks, 3),
  });
  assert.equal(result.valid, true);
  assert.equal(result.requested, 2);
  assert.equal(result.missing.length, 0);
  assert.deepEqual(result.blocks.map((b) => b.intact), [true, true]);
  assert.equal(result.integrity.seal, 'ok');
  assert.equal(result.integrity.anchored, true, 'the sealed checkpoint reaches past this window');
});

test('a rewritten block is caught at its SUCCESSOR, which the self-referential check missed', () => {
  const blocks = buildChain(4);
  // The attack someone with database write access can actually afford: rewrite
  // block 2's payload, re-derive its txHash and digest, and RE-MINE its hash.
  // There is no network to convince and no key to steal — just a few thousand
  // SHA-256 rounds at difficulty 2. Every invariant inside block 2 then holds.
  const target = blocks.get(2);
  const rewrittenTx = normalizeTx({ type: 'test:anchor', actor: target.txs[0].actor, data: { amount: 999999 } });
  const rewritten = mineV2({
    index: 2,
    timestamp: target.timestamp,
    prevHash: target.prevHash,
    txs: [rewrittenTx],
  });
  const doctored = new Map(blocks);
  doctored.set(2, rewritten);

  // Exactly what the old public check looked at: the block and its own stored
  // prevHash. It reports nothing wrong, which is why a scanned bottle used to
  // read `verified: true` over rewritten history.
  assert.equal(checkBlock(rewritten, rewritten.prevHash), null,
    'a re-mined block is internally flawless — judging it against itself proves nothing');

  // Judged against what is ACTUALLY stored one block below, the edit cannot be
  // contained: block 3 still chains from the original hash of block 2.
  const result = assessProofWindow({
    indexes: [2, 3],
    blocksByIndex: doctored,
    checkpoint: sealedCheckpoint(blocks, 4),
  });
  assert.equal(result.valid, false);
  assert.equal(result.blocks[0].intact, true, 'the rewritten block does look fine on its own');
  assert.equal(result.blocks[1].intact, false, 'and its successor exposes it');
  assert.equal(result.blocks[1].linked, false);
  assert.equal(result.blocks[1].reason, 'prevHash mismatch');
});

test('a claim pointing at a missing block is a failure, not a skip', () => {
  const blocks = buildChain(3);
  blocks.delete(2); // the tail-delete that `if (!block) continue` used to hide
  const result = assessProofWindow({
    indexes: [1, 2, 3],
    blocksByIndex: blocks,
    checkpoint: sealedCheckpoint(blocks, 3),
  });
  assert.equal(result.requested, 3, 'every claim is counted, including the unresolvable one');
  assert.deepEqual(result.missing, [2]);
  assert.equal(result.present, 2);
  assert.equal(result.valid, false);
});

test('a block with no predecessor cannot have its linkage proven', () => {
  const blocks = buildChain(3);
  blocks.delete(1);
  const result = assessProofWindow({ indexes: [2], blocksByIndex: blocks });
  assert.equal(result.valid, false);
  assert.equal(result.blocks[0].intact, false);
  assert.match(result.blocks[0].reason, /block 1 is missing/);
});

test('genesis links to the zero hash, not to a missing predecessor', () => {
  const blocks = buildChain(2);
  const result = assessProofWindow({ indexes: [0], blocksByIndex: blocks });
  assert.equal(result.valid, true, 'index 0 has no predecessor to load, and does not need one');
});

test('an edited payload inside the window fails even when the header was re-mined', () => {
  const blocks = buildChain(3);
  const target = blocks.get(2);
  const edited = { ...target, txs: [{ ...target.txs[0], data: { amount: 999999 } }] };
  const tampered = new Map(blocks);
  tampered.set(2, edited);
  const result = assessProofWindow({
    indexes: [2],
    blocksByIndex: tampered,
    checkpoint: sealedCheckpoint(blocks, 3),
  });
  assert.equal(result.valid, false);
  assert.equal(result.blocks[0].intact, false);
});

test('a window is only anchored by a seal that actually verifies', () => {
  const blocks = buildChain(3);
  const honest = sealedCheckpoint(blocks, 3);

  const forgedHeight = { ...honest, sealed: { index: 99, hash: 'a'.repeat(64) } };
  assert.equal(
    assessProofWindow({ indexes: [3], blocksByIndex: blocks, checkpoint: forgedHeight }).integrity.anchored,
    false,
    'raising the high-water mark without the key must not anchor anything',
  );

  const tamperedSeal = { ...honest, seal: 'f'.repeat(64) };
  assert.equal(
    assessProofWindow({ indexes: [3], blocksByIndex: blocks, checkpoint: tamperedSeal }).integrity.seal,
    'bad',
  );
  assert.equal(
    assessProofWindow({ indexes: [3], blocksByIndex: blocks, checkpoint: null }).integrity.seal,
    'absent',
    'no checkpoint is "nothing proven", never a pass',
  );
  // Intact blocks plus a broken seal: the chain re-hashes, but nothing signs the
  // claim that the whole prefix was ever checked.
  const broken = assessProofWindow({ indexes: [3], blocksByIndex: blocks, checkpoint: tamperedSeal });
  assert.equal(broken.valid, true, 'the window itself still re-hashes');
  assert.equal(broken.integrity.anchored, false, 'and it is still not anchored');
});

test('a checkpoint stored in the nested shape seals the high-water mark', () => {
  // Regression: the on-disk anchor writes `sealedIndex`/`sealedHash` flat and
  // the database checkpoint writes `sealed: { index, hash }`. `sealPayload`
  // destructured the flat names only, so a persisted record was sealed over
  // `sealedIndex: NaN, sealedHash: ''` — it matched itself on verify and reported
  // 'ok' while authenticating NOTHING about the height that truncation detection
  // depends on.
  const nested = { upTo: 12, prevHash: 'a'.repeat(64), sealed: { index: 12, hash: 'a'.repeat(64) } };
  const flat = { upTo: 12, prevHash: 'a'.repeat(64), sealedIndex: 12, sealedHash: 'a'.repeat(64) };
  assert.equal(computeSeal(nested), computeSeal(flat), 'both shapes must seal the same bytes');
  const seal = computeSeal(nested);
  assert.equal(verifySeal({ ...nested, seal }), 'ok');
  assert.equal(verifySeal({ ...nested, sealed: { index: 4, hash: 'a'.repeat(64) }, seal }), 'bad',
    'lowering the high-water mark launders a truncation — the seal must reject it');
  assert.equal(verifySeal({ ...nested, sealed: { index: 12, hash: 'b'.repeat(64) }, seal }), 'bad');
});

test('an empty window proves nothing, and dirty indexes are normalised', () => {
  assert.equal(assessProofWindow({ indexes: [], blocksByIndex: new Map() }).valid, false);
  const blocks = buildChain(2);
  const result = assessProofWindow({
    indexes: [1, 1, '1', null, undefined, -3, 1.5],
    blocksByIndex: blocks,
  });
  assert.equal(result.requested, 1, 'heights are de-duplicated and non-heights dropped');
  assert.equal(result.valid, true);
});


// `GET /admin/security/monitor` runs ~48 probes. It cached its result for 60 s,
// but the cache is only populated once a run COMPLETES, so a 30 s poll, a
// "Sync now" click and a report download landing together each started their
// own full run. They contended for the same pool and the same self-HTTP probes:
// measured 1.5 s for one run against 8.8 s for five, which is what pushed probes
// past their 10 s timeout and the browser past its 20 s abort budget — the
// "The security check did not respond in time" banner.
//
// These assert the two properties that fix removes the failure:
//   1. the shared run never closes over a request object, and
//   2. concurrent callers join one run rather than starting their own.

test('the monitor probe run is a pure function of `app`, not of `req`', () => {
  const src = readFileSync(join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  const start = src.indexOf('const runMonitorProbes = async (app) =>');
  assert.notEqual(start, -1, 'the monitor run was not extracted into runMonitorProbes');
  const end = src.indexOf("router.get('/security/monitor'", start);
  assert.notEqual(end, -1, 'the monitor route was not found after the run');
  const body = src.slice(start, end);

  // `req.app` used to be read inside this block. The run is now shared by every
  // concurrent caller, so it outlives the request that started it — reading
  // `req` after that response was sent is a ReferenceError, which is exactly how
  // 14 probes started reporting "req is not defined".
  //
  // Comments are stripped first: this file explains the rule in prose, and prose
  // is allowed to name `req`. What must not survive is a real reference.
  const code = body
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  assert.doesNotMatch(
    code,
    /\breq\b/,
    'the shared monitor run must not reference the request object',
  );
  // …and it must actually receive the app, or the attack probes lose the handle
  // they introspect (`check(app)`).
  assert.match(body, /check\(app\)/, 'the attack probes need the app passed in');
  assert.match(
    src.slice(end),
    /runMonitorProbes\(req\.app\)/,
    'the route must hand the run `req.app`',
  );
});

test('concurrent monitor callers share one run', () => {
  const src = readFileSync(join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  const start = src.indexOf("router.get('/security/monitor'");
  const end = src.indexOf("router.get('/security'", start);
  const route = src.slice(start, end);

  // One shared promise, created only when nothing is already running, and
  // cleared on completion — a rejected run must not wedge later callers.
  assert.match(route, /if \(!monitorInFlight\)/, 'a second run can still be started while one is in flight');
  assert.match(route, /\.finally\(\(\) => \{ monitorInFlight = null; \}\)/, 'a settled run is never released');
  assert.match(route, /return monitorInFlight\.then\(/, 'callers do not await the shared run');

  // `fresh=1` bypasses the CACHE, which is a different thing from duplicating
  // the WORK. Sync now must still join a run already in progress.
  const cacheGuard = route.indexOf('monitorCache.payload');
  const inFlightGuard = route.indexOf('if (!monitorInFlight)');
  assert.ok(cacheGuard !== -1 && inFlightGuard !== -1);
  assert.ok(
    inFlightGuard > cacheGuard,
    'the in-flight guard must sit below the cache check, so `fresh=1` skips the cache but not the shared run',
  );
});
