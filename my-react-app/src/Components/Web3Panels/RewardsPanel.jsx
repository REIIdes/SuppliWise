import { useEffect, useState } from 'react';
import {
  getRewardsStatus,
  claimCheckin,
  claimIntakeReward,
  getRewardEvents,
  getNfts,
  checkAchievements,
  stakeTokens,
  unstakeTokens,
  getLoyalty,
  redeemLoyalty,
} from '../../api/web3';
import { Spinner, Alert, Stat, CopyChip, Empty, fmtWell, fmtDay, usePanelState } from './w3ui';

const NFT_EMOJI = {
  'first-steps': '🌱', 'week-warrior': '🔥', 'monthly-master': '⭐',
  'year-hero': '👑', scholar: '🎓', 'data-pioneer': '🧪', governor: '🏛️',
  merchant: '🛒', 'diamond-hands': '💎', 'trailblazer': '🔬', 'verified-pro': '🩺',
};

// Deterministic gradient per token so every badge looks unique but stable.
function nftGradient(seed, kind) {
  const base = [...String(seed || kind)].reduce((a, c) => a + c.charCodeAt(0), 0);
  const h1 = base % 360;
  const h2 = (h1 + 48) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 48%), hsl(${h2} 72% 38%))`;
}

export default function RewardsPanel() {
  const { loading, setLoading, alert, ok, fail, clear, info } = usePanelState();
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [nfts, setNfts] = useState(null);
  const [loyalty, setLoyalty] = useState(null);
  const [stakeAmount, setStakeAmount] = useState('100');
  const [redeemAmount, setRedeemAmount] = useState('20');
  const [busy, setBusy] = useState(false);

  const loadAll = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const [st, ev, nf, lo] = await Promise.all([
        getRewardsStatus(), getRewardEvents(30), getNfts(), getLoyalty(),
      ]);
      setStatus(st);
      setEvents(ev.events || []);
      setNfts(nf);
      setLoyalty(lo);
      if (!silent) clear();
    } catch (err) {
      fail(err, 'Could not load rewards.');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { loadAll(); /* eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- intentional initial load on mount */ }, []);

  const run = async (fn, successMsg) => {
    try {
      setBusy(true);
      clear();
      const res = await fn();
      await loadAll(true);
      ok(typeof successMsg === 'function' ? successMsg(res) : successMsg || 'Done.');
      return res;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (loading && !status) return <Spinner />;
  if (!status) return <Alert alert={alert} onClear={clear} />;

  const { params, unlocks, achievements, pendingAchievements } = status;

  return (
    <div>
      <Alert alert={alert} onClear={clear} />

      {/* ── Rewards overview ─────────────────────────────────────────── */}
      <div className="w3-card accent">
        <div className="w3-row between">
          <div>
            <div className="w3-card-title">🏆 Token rewards for healthy habits</div>
            <p className="w3-card-sub">WELL tokens are minted on-chain for real, verified activity.</p>
          </div>
          <span className="w3-badge green">{status.checkinCount} check-in days</span>
        </div>

        <div className="w3-grid">
          <Stat value={`${status.streak}`} label="Current check-in streak" tone="green" />
          <Stat value={fmtWell(status.wallet.balance)} label="Wallet balance" />
          <Stat value={fmtWell(status.wallet.earnedTotal)} label="Lifetime earned" tone="amber" />
          <Stat value={status.nftCount} label="Achievement NFTs" />
        </div>

        <div className="w3-row" style={{ marginTop: 18 }}>
          <button
            className="w3-btn"
            disabled={busy || status.claimedToday.checkin}
            onClick={() => run(claimCheckin, (r) => `+${r.amount} WELL — streak is now ${r.streak} days! 🔥`)}
          >
            {status.claimedToday.checkin ? '✓ Checked in today' : `Daily check-in (+${status.nextCheckinAmount} WELL)`}
          </button>
          <button
            className="w3-btn ghost"
            disabled={busy || status.claimedToday.intake || !status.intakeEligible}
            title={status.intakeEligible ? '' : 'Mark a supplement as taken in Track Intake first'}
            onClick={() => run(claimIntakeReward, (r) => `+${r.amount} WELL for logging your intake.`)}
          >
            {status.claimedToday.intake ? '✓ Intake reward claimed' : `Intake logged today (+${params.rewardIntakeDay} WELL)`}
          </button>
          <button
            className="w3-btn ghost"
            disabled={busy || pendingAchievements.length === 0}
            onClick={() =>
              run(checkAchievements, (r) =>
                r.count ? `Minted ${r.count} achievement NFT${r.count > 1 ? 's' : ''}! 🎨` : 'No new achievements yet — keep going!'
              )
            }
          >
            {pendingAchievements.length ? `Mint ${pendingAchievements.length} new badge(s) ✨` : 'Check achievements'}
          </button>
        </div>
        {!status.intakeEligible && (
          <p className="w3-card-sub" style={{ marginTop: 10, marginBottom: 0 }}>
            💡 Intake reward unlocks once you mark at least one supplement as taken today.
          </p>
        )}
      </div>

      {/* ── Achievement NFTs ─────────────────────────────────────────── */}
      <div className="w3-card">
        <div className="w3-card-title">🎨 Achievement NFTs</div>
        <p className="w3-card-sub">Soulbound collectible badges minted to your wallet for real milestones.</p>
        {nfts && nfts.nfts.length > 0 ? (
          <div className="w3-grid" style={{ marginBottom: 18 }}>
            {nfts.nfts.map((nft) => (
              <div className="w3-nft" key={nft.tokenId} style={{ background: nftGradient(nft.imageSeed, nft.kind) }}>
                <span className="w3-nft-emoji">{NFT_EMOJI[nft.kind] || '🏅'}</span>
                <div className="w3-nft-name">{nft.name}</div>
                <div className="w3-nft-desc">{nft.description}</div>
                <div className="w3-nft-serial">#{nft.serial} · {nft.tokenId.slice(0, 14)}…</div>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon="🎨">No badges yet — hit a milestone and mint your first.</Empty>
        )}

        <div className="w3-label" style={{ marginTop: 6 }}>Milestone progress</div>
        {achievements.map((a) => (
          <div className="w3-ach" key={a.kind}>
            <div className="w3-ach-icon">{a.owned ? NFT_EMOJI[a.kind] || '🏅' : '🔒'}</div>
            <div className="w3-ach-body">
              <div className="w3-ach-name">
                {a.name} {a.owned && <span className="w3-badge green" style={{ marginLeft: 6 }}>Minted</span>}
              </div>
              <div className="w3-ach-desc">{a.description}</div>
              <div className="w3-progress" style={{ marginTop: 6 }}>
                <div className="w3-progress-bar" style={{ width: `${Math.round(a.progress * 100)}%` }} />
              </div>
            </div>
            <div className="w3-mono" style={{ whiteSpace: 'nowrap' }}>{a.current}/{a.min}</div>
          </div>
        ))}
      </div>

      {/* ── Staking ──────────────────────────────────────────────────── */}
      <div className="w3-card">
        <div className="w3-card-title">💎 Staking for premium access</div>
        <p className="w3-card-sub">
          {params.stakeApyPct}% APY, accrued daily · premium unlocks at {params.stakePremiumThreshold} WELL staked.
        </p>

        <div className="w3-grid">
          <Stat value={fmtWell(status.wallet.staked)} label="Staked" tone="amber" />
          <Stat value={fmtWell(status.wallet.balance)} label="Available" tone="green" />
          <Stat value={`${params.stakeApyPct}%`} label="Staking APY" />
          <Stat value={unlocks.unlocked ? 'Unlocked 🔓' : 'Locked 🔒'} label="Premium perks" tone={unlocks.unlocked ? 'green' : ''} />
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="w3-row between">
            <span className="w3-label" style={{ margin: 0 }}>
              Progress to premium: {Math.round(unlocks.progress * 100)}%
            </span>
            <span className="w3-mono">{fmtWell(status.wallet.staked)} / {fmtWell(unlocks.threshold)}</span>
          </div>
          <div className="w3-progress" style={{ marginTop: 6 }}>
            <div className="w3-progress-bar" style={{ width: `${Math.round(unlocks.progress * 100)}%` }} />
          </div>
        </div>

        <div className="w3-row" style={{ marginTop: 16 }}>
          <input
            className="w3-input"
            style={{ maxWidth: 160 }}
            type="number"
            min="1"
            value={stakeAmount}
            onChange={(e) => setStakeAmount(e.target.value)}
            aria-label="Stake amount"
          />
          <button
            className="w3-btn"
            disabled={busy}
            onClick={() => run(() => stakeTokens(Number(stakeAmount)), (r) => `Staked. Balance now ${fmtWell(r.staked)} WELL.`)}
          >
            Stake
          </button>
          <button
            className="w3-btn ghost"
            disabled={busy || !(Number(status.wallet.staked) > 0)}
            onClick={() => run(() => unstakeTokens(Number(stakeAmount)), (r) => `Unstaked. Free balance ${fmtWell(r.balance)} WELL.`)}
          >
            Unstake
          </button>
        </div>
        {status.accruedNow > 0 && (
          <p className="w3-card-sub" style={{ marginTop: 10, marginBottom: 0 }}>
            ☀️ {fmtWell(status.accruedNow)} WELL of staking yield was just auto-compounded.
          </p>
        )}
      </div>

      {/* ── Loyalty ──────────────────────────────────────────────────── */}
      <div className="w3-card">
        <div className="w3-card-title">🎁 Blockchain loyalty program</div>
        <p className="w3-card-sub">
          Convert WELL into one-time loyalty codes redeemable at marketplace checkout (min{' '}
          {params.loyaltyRedeemRate} WELL). Every burn and redemption is on-chain.
        </p>
        <div className="w3-grid">
          <Stat value={fmtWell(loyalty?.burned || 0)} label="WELL converted" tone="amber" />
          <Stat value={loyalty?.codes?.filter((c) => c.status === 'unused').length || 0} label="Unused codes" tone="green" />
          <Stat value={loyalty?.issuedCount || 0} label="Codes issued" />
        </div>
        <div className="w3-row" style={{ marginTop: 16 }}>
          <input
            className="w3-input"
            style={{ maxWidth: 160 }}
            type="number"
            min={params.loyaltyRedeemRate}
            value={redeemAmount}
            onChange={(e) => setRedeemAmount(e.target.value)}
            aria-label="Redeem amount"
          />
          <button
            className="w3-btn"
            disabled={busy}
            onClick={() => run(() => redeemLoyalty(Number(redeemAmount)), (r) => `Loyalty code ${r.code.code} created — copy it for checkout!`)}
          >
            Get loyalty code
          </button>
        </div>

        {loyalty && loyalty.codes.length > 0 && (
          <div className="w3-table-wrap" style={{ marginTop: 16 }}>
            <table className="w3-table">
              <thead>
                <tr><th>Code</th><th>Value</th><th>Status</th><th>Created</th></tr>
              </thead>
              <tbody>
                {loyalty.codes.map((c) => (
                  <tr key={c.code}>
                    <td><CopyChip value={c.code} label={c.code} /></td>
                    <td>{fmtWell(c.valueWell)} WELL</td>
                    <td>
                      <span className={`w3-badge ${c.status === 'unused' ? 'green' : 'amber'}`}>
                        {c.status === 'unused' ? 'Unused' : 'Redeemed'}
                      </span>
                    </td>
                    <td>{fmtDay(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Reward history ───────────────────────────────────────────── */}
      <div className="w3-card">
        <div className="w3-card-title">📜 Reward history</div>
        <p className="w3-card-sub">Every mint, anchored to a block — click a hash to inspect its transaction.</p>
        {events.length === 0 ? (
          <Empty icon="🌱">No rewards yet — start with today’s check-in above.</Empty>
        ) : (
          <div className="w3-table-wrap">
            <table className="w3-table">
              <thead>
                <tr><th>Event</th><th>Amount</th><th>Day</th><th>Tx</th></tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={`${e.kind}-${e.refId}-${e.at}`}>
                    <td>
                      <span className="w3-badge blue">{e.kind}</span>
                      {e.refId && e.refId !== '-' ? <span className="w3-mono" style={{ marginLeft: 8 }}>{e.refId.slice(0, 14)}</span> : null}
                    </td>
                    <td style={{ color: '#16a34a', fontWeight: 700 }}>+{fmtWell(e.amount)}</td>
                    <td>{e.day}</td>
                    <td>{e.txHash ? <CopyChip value={e.txHash} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button
          className="w3-btn ghost small"
          style={{ marginTop: 12 }}
          onClick={() => { info('Refreshed.'); loadAll(true); }}
        >
          Refresh history
        </button>
      </div>
    </div>
  );
}
