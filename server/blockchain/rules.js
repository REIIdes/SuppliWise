// ═══════════════════════════════════════════════════════════════════════════
// Pure decision rules for the Web3 layer. No I/O, no database — everything
// here is deterministic and covered by server "Test File" unit tests.
// Keeping these separate from the routes is what makes the smart-contract
// style behaviour (tallies, yields, milestone minting) auditable.
// ═══════════════════════════════════════════════════════════════════════════

// ── DAO proposal tally (feature 13) ────────────────────────────────────────
// Weight = tokens held + staked at vote time. A proposal passes when, at
// quorum, `for` strictly outweighs `against` and total weight reaches quorum.
function tallyProposal(votes, params = {}, now = Date.now()) {
  let forWeight = 0;
  let againstWeight = 0;
  const voters = new Set();
  for (const v of votes || []) {
    if (!v || !v.address) continue;
    const weight = Math.max(0, Number(v.weight) || 0);
    if (v.choice === 'for') {
      if (voters.has(v.address)) continue; // one vote per wallet
      voters.add(v.address);
      forWeight += weight;
    } else if (v.choice === 'against') {
      if (voters.has(v.address)) continue;
      voters.add(v.address);
      againstWeight += weight;
    }
  }
  const totalWeight = forWeight + againstWeight;
  const quorum = Number(params.daoQuorumWeight) || 0;
  const expired = !Number.isFinite(now) || now >= 0; // tally is evaluated now
  const quorumReached = totalWeight >= quorum;
  const passed = quorumReached && forWeight > againstWeight;
  return {
    forWeight: round(forWeight),
    againstWeight: round(againstWeight),
    totalWeight: round(totalWeight),
    quorum,
    quorumReached,
    passed,
    expired,
    voterCount: voters.size,
  };
}

function round(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// ── Check-in streak (features 9 & 10) ─────────────────────────────────────
// `days` = sorted-descending YYYY-MM-DD keys of past check-in rewards.
// Consecutive run ending today (or yesterday, if today isn't claimed yet).
function checkinStreak(days, todayKey) {
  const sorted = [...new Set(days || [])].sort().reverse();
  if (!sorted.length) return 0;
  if (sorted[0] !== todayKey && sorted[0] !== shiftDay(todayKey, -1)) return 0;
  let streak = 0;
  let expected = sorted[0];
  for (const day of sorted) {
    if (day !== expected) break;
    streak += 1;
    expected = shiftDay(day, -1);
  }
  return streak;
}

function shiftDay(dayKey, delta) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

// Reward for a check-in: base + one step per day of streak (capped at 10 steps
// so the daily faucet can't be inflated without bound).
function checkinReward(params, streak) {
  const base = Number(params.rewardCheckin) || 0;
  const step = Number(params.rewardStreakStep) || 0;
  return round(base + step * Math.min(Math.max(streak, 0), 10));
}

// ── Staking yield (feature 11) ────────────────────────────────────────────
// Simple APY pro-rated over elapsed time, floored at 2 decimals.
function computeStakeReward(staked, apyPct, elapsedMs) {
  const amount = Number(staked) || 0;
  const apy = Number(apyPct) || 0;
  const days = (Number(elapsedMs) || 0) / 86400000;
  if (amount <= 0 || apy <= 0 || days <= 0) return 0;
  return round(amount * (apy / 100) * (days / 365));
}

// Premium perks unlock when the staked balance reaches the DAO threshold.
function stakingUnlocks(staked, params) {
  const threshold = Number(params.stakePremiumThreshold) || 0;
  const amount = Number(staked) || 0;
  return {
    threshold,
    unlocked: amount >= threshold,
    progress: threshold > 0 ? Math.min(1, round(amount / threshold)) : 1,
  };
}

// ── Achievement NFTs (feature 10) ─────────────────────────────────────────
// Pure eligibility check given a stats snapshot; the route supplies the stats
// (streak, assessment count, orders, shares, votes, staked balance…).
const ACHIEVEMENTS = [
  { kind: 'first-steps', name: 'First Steps', description: 'Completed your first AI assessment.', min: 1, metric: 'assessments' },
  { kind: 'week-warrior', name: '7-Day Streak', description: 'Seven consecutive days of healthy check-ins.', min: 7, metric: 'checkinStreak' },
  { kind: 'monthly-master', name: '30-Day Streak', description: 'Thirty consecutive days of healthy check-ins.', min: 30, metric: 'checkinStreak' },
  { kind: 'year-hero', name: '365-Day Streak', description: 'A full year of unbroken healthy check-ins.', min: 365, metric: 'checkinStreak' },
  { kind: 'scholar', name: 'Wellness Scholar', description: 'Ten completed assessments.', min: 10, metric: 'assessments' },
  { kind: 'data-pioneer', name: 'Data Pioneer', description: 'Shared anonymized health data with researchers.', min: 1, metric: 'dataShares' },
  { kind: 'governor', name: 'Governor', description: 'Cast a vote in platform governance.', min: 1, metric: 'daoVotes' },
  { kind: 'merchant', name: 'Market Participant', description: 'Completed a verified marketplace order.', min: 1, metric: 'ordersCompleted' },
  { kind: 'diamond-hands', name: 'Diamond Hands', description: 'Staked 500 WELL or more.', min: 500, metric: 'staked' },
  { kind: 'trailblazer', name: 'Trailblazer', description: 'Opted in to a secure clinical trial.', min: 1, metric: 'trials' },
  { kind: 'verified-pro', name: 'Verified Professional', description: 'Booked a tokenized expert consultation.', min: 1, metric: 'bookings' },
];

function eligibleAchievements(stats = {}, ownedKinds = []) {
  const owned = new Set(ownedKinds);
  return ACHIEVEMENTS.filter(
    (a) => !owned.has(a.kind) && (Number(stats[a.metric]) || 0) >= a.min
  );
}

// ── Marketplace escrow fee (features 3 & 4) ───────────────────────────────
function escrowSplit(total, feePct) {
  const amount = Math.max(0, round(total));
  const pct = Math.min(100, Math.max(0, Number(feePct) || 0));
  const fee = round((amount * pct) / 100);
  return { fee, proceeds: round(amount - fee) };
}

// ── Dispute resolution (feature 15) ───────────────────────────────────────
// Majority of cast juror votes wins; ties keep funds in escrow (no payout
// without a clear verdict).
function disputeOutcome(votes, jurors = []) {
  let buyer = 0;
  let seller = 0;
  const seen = new Set();
  // Empty juror list = open jury (no staked juror existed when the dispute
  // was filed): any non-party wallet with a stake-backed voice may vote, and
  // a single clear verdict resolves it.
  const openJury = !Array.isArray(jurors) || jurors.length === 0;
  for (const v of votes || []) {
    if (!v || !v.juror || seen.has(v.juror)) continue;
    if (!openJury && !jurors.includes(v.juror)) continue; // non-juror votes ignored
    seen.add(v.juror);
    if (v.choice === 'buyer') buyer += 1;
    else if (v.choice === 'seller') seller += 1;
  }
  const cast = buyer + seller;
  const complete = openJury ? cast >= 1 : cast >= jurors.length;
  if (buyer > seller) return { outcome: 'buyer', buyer, seller, cast, complete };
  if (seller > buyer) return { outcome: 'seller', buyer, seller, cast, complete };
  return { outcome: '', buyer, seller, cast, complete: complete && cast > 0 };
}

module.exports = {
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
};
