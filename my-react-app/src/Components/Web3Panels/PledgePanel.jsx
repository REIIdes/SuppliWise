import { useEffect, useState } from 'react';
import { getPledges, createPledge, getRewardsStatus } from '../../api/web3';
import { streakDays } from '../../utils/streakDays';
import { Spinner, Alert, Stat, CopyChip, Empty, fmtWell, usePanelState } from './w3ui';

const MAX = 280;

// Starting points, not placeholders. A blank box is the hardest thing to write
// into; these give the member a sentence shape they can edit.
const SEEDS = [
  'I will take my morning supplements before 9am.',
  'I will walk 20 minutes after dinner.',
  'I will sleep by 11pm on weeknights.',
  'I will drink 8 glasses of water today.',
  'I will log every dose in my plan today.',
];

// Newest day first, then the wall's own order. `day` is YYYY-MM-DD so string
// sort is chronological.
function byDayDesc(a, b) {
  return a.day < b.day ? 1 : a.day > b.day ? -1 : 0;
}

export default function PledgePanel() {
  const { loading, setLoading, alert, ok, fail, clear, info } = usePanelState();
  const [data, setData] = useState(null);
  const [reward, setReward] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const [pledges, status] = await Promise.all([getPledges(), getRewardsStatus()]);
      setData(pledges);
      setReward(Number(status?.params?.pledgeReward) || 0);
      if (!silent) clear();
    } catch (err) {
      fail(err, 'Could not load pledges.');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- intentional initial load on mount */ }, []);

  const mint = async () => {
    try {
      setBusy(true);
      clear();
      const res = await createPledge(text);
      setText('');
      await load(true);
      // The row is saved either way; only the block is in question, so the
      // message must not claim a receipt the ledger did not write.
      const paid = Number(res.reward) > 0 ? ` +${fmtWell(res.reward)} WELL` : '';
      if (res.anchored) ok(`Pledge minted on-chain${paid}. Come back tomorrow and stack another.`);
      else info(`Pledge saved${paid}. The block is still being written — refresh in a moment.`);
      return res;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Spinner />;
  if (!data) return <Alert alert={alert} onClear={clear} />;

  const mine = [...data.mine].sort(byDayDesc);
  const wall = [...data.wall].sort(byDayDesc);
  const streak = streakDays(mine.map((p) => p.day));
  const left = MAX - text.length;

  return (
    <div>
      <Alert alert={alert} onClear={clear} />

      {/* ── Composer ─────────────────────────────────────────────────── */}
      <div className="w3-card accent">
        <div className="w3-row between">
          <div>
            <div className="w3-card-title">🤝 Mint a health pledge</div>
            <p className="w3-card-sub">
              One commitment a day, written into the ledger. It cannot be edited or
              deleted afterwards — that is what makes it a promise rather than a note.
            </p>
          </div>
          <span className="w3-badge green">+{fmtWell(reward)} WELL</span>
        </div>

        <textarea
          className="w3-input"
          rows={3}
          maxLength={MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="This week I will…"
          aria-label="Your health pledge"
          disabled={busy || data.claimedToday}
        />
        <div className="w3-row between" style={{ marginTop: 8 }}>
          <div className="w3-row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {SEEDS.slice(0, 3).map((seed) => (
              <button
                key={seed}
                type="button"
                className="w3-btn ghost small"
                disabled={busy || data.claimedToday}
                onClick={() => setText(seed)}
              >
                {seed}
              </button>
            ))}
          </div>
          <span className="w3-mono" style={{ color: left < 20 ? '#b45309' : undefined }}>
            {left} left
          </span>
        </div>

        <div className="w3-row" style={{ marginTop: 14 }}>
          <button
            className="w3-btn"
            disabled={busy || data.claimedToday || text.trim().length < 3}
            onClick={mint}
          >
            {data.claimedToday ? '✓ Minted today — come back tomorrow' : 'Mint my pledge'}
          </button>
        </div>
        {data.claimedToday && (
          <p className="w3-card-sub" style={{ marginTop: 10, marginBottom: 0 }}>
            💡 One pledge per day keeps them worth something. Your history and the
            community wall are below.
          </p>
        )}
      </div>

      {/* ── Your record ──────────────────────────────────────────────── */}
      <div className="w3-card">
        <div className="w3-card-title">📜 Your pledges</div>
        <div className="w3-grid" style={{ marginBottom: mine.length ? 14 : 0 }}>
          <Stat value={mine.length} label="Minted all-time" tone="green" />
          <Stat value={streak} label="Consecutive days" tone="amber" hint="Runs of back-to-back pledges" />
          <Stat value={fmtWell(mine.reduce((s, p) => s + (Number(p.reward) || 0), 0))} label="WELL earned" />
        </div>
        {mine.length === 0 ? (
          <Empty icon="🤝" title="Nothing minted yet">
            Write your first commitment above — it takes one sentence.
          </Empty>
        ) : (
          <div className="w3-table-wrap">
            <table className="w3-table">
              <thead>
                <tr><th>Day</th><th>Pledge</th><th>Reward</th><th>Tx</th></tr>
              </thead>
              <tbody>
                {mine.map((p) => (
                  <tr key={p.id}>
                    <td className="w3-mono">{p.day}</td>
                    <td>{p.text}</td>
                    <td style={{ color: '#16a34a', fontWeight: 700 }}>
                      {Number(p.reward) > 0 ? `+${fmtWell(p.reward)}` : '—'}
                    </td>
                    <td>{p.txHash ? <CopyChip value={p.txHash} /> : <span className="w3-badge amber">pending</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Community wall ───────────────────────────────────────────── */}
      <div className="w3-card">
        <div className="w3-card-title">🧱 The community wall</div>
        <p className="w3-card-sub">
          Every pledge is public. Names are reduced to a first name and an initial —
          your commitments are visible, your full identity is not.
        </p>
        {wall.length === 0 ? (
          <Empty icon="🧱">The wall is empty. Be the first commitment on it.</Empty>
        ) : (
          <div className="w3-grid">
            {wall.map((p) => (
              <div className="w3-pledge" key={p.id}>
                <div className="w3-pledge-text">“{p.text}”</div>
                <div className="w3-pledge-meta">
                  <span className="w3-badge blue">{p.by}</span>
                  <span className="w3-mono">{p.day}</span>
                </div>
                <div className="w3-pledge-foot">
                  {p.txHash ? <CopyChip value={p.txHash} /> : <span className="w3-mono">anchoring…</span>}
                  {Number(p.blockIndex) >= 0 && <span className="w3-mono">block #{p.blockIndex}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          className="w3-btn ghost small"
          style={{ marginTop: 12 }}
          onClick={() => { info('Refreshed.'); load(true); }}
        >
          Refresh the wall
        </button>
      </div>
    </div>
  );
}
