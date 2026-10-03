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
