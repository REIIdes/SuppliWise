import { useEffect, useState } from 'react';
import { getChain, verifyChain, getTx, getChainStatus, getChainRepairs } from '../../api/web3';
import { Spinner, Alert, Stat, CopyChip, Empty, fmtTime, trunc, usePanelState } from './w3ui';

// A chain-repair row is a moment the ledger had to defend itself. Each kind
// tells a different story, and an incident with no matching 'repair' after it
// is still open — so the tone is decided by the sequence, not by the row alone.
const REPAIR_KIND = {
  incident: { icon: '⚠️', label: 'Integrity incident detected', tone: 'amber' },
  repair: { icon: '🛠️', label: 'Chain repaired', tone: 'green' },
  'repair-failed': { icon: '✖️', label: 'Repair attempt failed', tone: 'amber' },
  'quarantine-lifted': { icon: '📦', label: 'Quarantine lifted', tone: 'green' },
};

function repairTone(rows, i) {
  const row = rows[i];
  if (row.kind !== 'incident') return REPAIR_KIND[row.kind]?.tone || '';
  // rows are newest-first, so "resolved" means a repair at a LATER index.
  const later = rows.slice(i + 1);
  return later.some((r) => r.kind === 'repair' || r.kind === 'quarantine-lifted') ? 'green' : 'amber';
}

// Chain explorer: browse blocks, recompute the whole chain's integrity, and
// look up any transaction hash (from rewards, escrow, consent, votes…).
export default function ExplorerPanel() {
  const { loading, setLoading, alert, ok, fail, clear, info } = usePanelState();
  const [chain, setChain] = useState(null);
  const [verify, setVerify] = useState(null);
  const [status, setStatus] = useState(null);
  const [repairs, setRepairs] = useState([]);
  const [txInput, setTxInput] = useState('');
  const [tx, setTx] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async (before = null) => {
    try {
      setLoading(true);
      const res = await getChain(25, before);
      setChain((prev) => {
        if (!prev || before == null) return res;
        return { ...res, blocks: [...prev.blocks, ...res.blocks] };
      });
      // Best-effort: an empty incident log is the boring, correct default, and a
      // failure here must not blank the explorer that did load.
      getChainRepairs().then((r) => setRepairs(r.repairs || [])).catch(() => setRepairs([]));
      clear();
    } catch (err) {
      fail(err, 'Could not load the chain.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- intentional initial load on mount */ }, []);

  // Poll the compact integrity status so a break is visible WITHOUT the user
  // pressing "Verify". Previously the Integrity tile read "unverified" until
  // someone clicked the button — which is exactly backwards for a control whose
  // whole job is to report a problem nobody was looking for.
  useEffect(() => {
    let alive = true;
    const read = () => {
      getChainStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    };
    read();
    const timer = setInterval(read, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const runVerify = async () => {
    try {
      setBusy(true);
      clear();
      const res = await verifyChain({ full: true });
      setVerify(res);
      // A deep audit that has not finished is not a verdict. `valid: true` with
      // `pending: true` means "nothing has been found wrong yet", and claiming
      // "Chain valid ✓ — N blocks recomputed" for a check that recomputed none of
      // them is how a broken chain gets a green tick.
      if (res.pending) info(`Full check still running — ${res.checked ?? 0} blocks counted, nothing proven yet. The verdict appears when the audit finishes.`);
      else if (res.valid) ok(`Chain valid ✓ — ${res.checked} blocks recomputed at difficulty ${res.difficulty}.`);
      else fail({ message: `Chain BROKEN at block #${res.brokenAt}: ${res.reason} — everyone has been notified and the ledger is restarting on a fresh verified chain automatically.` });
    } catch (err) {
      fail(err, 'Could not verify the chain.');
    } finally {
      setBusy(false);
      // Re-read the compact status either way: a completed verification is what
      // closes an open incident, so the banner must refresh after it, not only
      // after a user-initiated full check.
      getChainStatus().then(setStatus).catch(() => {});
    }
  };

  const lookup = async () => {
    try {
      setBusy(true);
      clear();
      setTx(null);
      const res = await getTx(txInput.trim());
      setTx(res);
      info(`Transaction found in block #${res.block.index}.`);
    } catch (err) {
      fail(err, err.status === 404 ? 'No transaction with that hash.' : 'Lookup failed.');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !chain) return <Spinner />;
  if (!chain) return <Alert alert={alert} onClear={clear} />;

  const oldest = chain.blocks.length ? Math.min(...chain.blocks.map((b) => b.index)) : 0;

  // Prefer the polled status; fall back to the last manual verification while
  // the first poll is still in flight, so the tile never flashes "unverified"
  // on a chain that is fine.
  const verdict = status ?? verify;
  const integrityLabel = !verdict
    ? 'checking…'
    : verdict.valid === false
      ? 'BROKEN ✗'
      : verdict.state === 'verifying' || verdict.pending
        ? 'checking…'
        : 'Valid ✓';
  const integrityTone = !verdict || verdict.valid === false
    ? (verdict && verdict.valid === false ? 'amber' : '')
    : 'green';

  return (
    <div>
      <Alert alert={alert} onClear={clear} />

      <div className="w3-card accent">
        <div className="w3-row between">
          <div>
            <div className="w3-card-title">⛏️ SuppliWise Mainnet</div>
            <p className="w3-card-sub">
              Append-only proof-of-work ledger. Every reward, escrow movement, consent, vote and
              supply step lands here — impossible to rewrite after the fact.
            </p>
          </div>
          <button className="w3-btn" disabled={busy} onClick={runVerify}>
            🔎 Verify entire chain
          </button>
        </div>
        <div className="w3-grid">
          <Stat value={`#${chain.height}`} label="Chain height" tone="green" />
          <Stat value={chain.difficulty} label="PoW difficulty" />
          <Stat value={chain.blocks.length} label="Blocks loaded" />
          <Stat
            value={integrityLabel}
            label="Integrity"
            tone={integrityTone}
          />
          <Stat value={`#${(status ?? chain).cycle ?? 0}`} label="Chain cycle" />
        </div>
        {status && status.state === 'compromised' && (
          <div className="w3-alert err" style={{ marginTop: 14 }} role="alert">
            <strong>⚠️ Blockchain record integrity issue.</strong>{' '}
            {status.notice || 'An integrity problem was found in the blockchain record.'}
            {status.brokenAt != null && (
              <> Affected block: <span className="w3-mono">#{status.brokenAt}</span>. </>
            )}
            {status.reason && <> <span className="w3-mono">{status.reason}</span></>}
            {/*
              The one thing a user must never be told here is that their
              transactions are on hold. They are not: the ledger re-syncs itself
              and keeps issuing receipts. Calling it "paused" is what made the
              blockchain look broken while it was still working.
            */}
            <div style={{ marginTop: 8 }}>
              Your account, balance, rewards and orders are unaffected and every feature keeps
              working — nothing is on hold. The ledger has stopped writing on top of the damaged
              blocks and is discarding them to start a fresh, independently verified chain.
              {status.resyncing && <> A new chain is being opened right now.</>}
              {status.lastResync && status.lastResync.ok && (
                <> Last time: kept up to block #{status.lastResync.keptThrough ?? 0},{' '}
                  {status.lastResync.discarded ?? 0} block(s) discarded.</>
              )}
              {status.quarantine?.needsBackupRestore && (
                <> This one means some historical blocks are missing, so those records can only come
                  back from a backup restore — the chain itself continues without them.</>
              )}
            </div>
          </div>
        )}
        {status && status.lastVerifiedAt && status.state !== 'compromised' && (
          <p className="w3-card-sub" style={{ marginTop: 12 }}>
            Last full integrity re-check: {fmtTime(new Date(status.lastVerifiedAt).getTime())}. Every block added since is re-checked as it lands.
          </p>
        )}
        <div style={{ marginTop: 14 }}>
          <div className="w3-label">Tip hash</div>
          <CopyChip value={chain.tip} label={chain.tip} />
        </div>
      </div>

      <div className="w3-card">
        <div className="w3-card-title">🔍 Transaction lookup</div>
        <div className="w3-row">
          <input
            className="w3-input"
            style={{ flex: 1, minWidth: 260, fontFamily: 'monospace' }}
            placeholder="Paste a tx hash (from any reward, order, consent…)"
            value={txInput}
            onChange={(e) => setTxInput(e.target.value)}
            aria-label="Transaction hash"
          />
          <button className="w3-btn ghost" disabled={busy || !txInput.trim()} onClick={lookup}>
            Look up
          </button>
        </div>
        {tx && (
          <div className="w3-table-wrap" style={{ marginTop: 14 }}>
            <table className="w3-table">
              <tbody>
                <tr><td style={{ fontWeight: 600, width: 150 }}>Type</td><td><span className="w3-badge blue">{tx.tx.type}</span></td></tr>
                <tr><td style={{ fontWeight: 600 }}>Actor</td><td className="w3-mono">{tx.tx.actor}</td></tr>
                <tr><td style={{ fontWeight: 600 }}>Block</td><td className="w3-mono">#{tx.block.index} · {fmtTime(tx.block.timestamp)}</td></tr>
                <tr><td style={{ fontWeight: 600 }}>Data</td><td><div className="w3-mono" style={{ maxHeight: 120, overflow: 'auto' }}>{JSON.stringify(tx.tx.data, null, 2)}</div></td></tr>
                <tr><td style={{ fontWeight: 600 }}>Payload digest</td><td><CopyChip value={tx.tx.dataHash} label={trunc(tx.tx.dataHash, 14, 8)} /></td></tr>
                <tr><td style={{ fontWeight: 600 }}>Tx hash</td><td><CopyChip value={tx.tx.txHash} label={tx.tx.txHash} /></td></tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="w3-card">
        <div className="w3-row between">
          <div>
            <div className="w3-card-title">🛠️ Chain incident &amp; repair log</div>
            <p className="w3-card-sub">
              A repair rewrites the tip, so the discarded blocks are gone from the chain itself.
              This log is the permanent record that they existed and why they were dropped.
            </p>
          </div>
          <span className={`w3-badge ${repairs.some((r) => r.kind === 'incident') ? 'amber' : 'green'}`}>
            {repairs.length ? `${repairs.length} entries` : 'no incidents recorded'}
          </span>
        </div>

        {repairs.length === 0 ? (
          <Empty icon="🛡️">
            Nothing has ever needed repairing. Every integrity check this chain has run, it passed.
          </Empty>
        ) : (
          <div className="w3-table-wrap">
            <table className="w3-table">
              <thead>
                <tr><th>When</th><th>Event</th><th>Block</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {repairs.map((r, i) => {
                  const meta = REPAIR_KIND[r.kind] || { icon: '•', label: r.kind, tone: '' };
                  const tone = repairTone(repairs, i);
                  return (
                    <tr key={`${r.at}-${r.kind}-${i}`}>
                      <td>{fmtTime(r.at)}</td>
                      <td>
                        <span className={`w3-badge ${tone || 'blue'}`}>{meta.icon} {meta.label}</span>
                        {r.actor && r.actor !== 'system' && (
                          <div className="w3-mono" style={{ fontSize: 11, marginTop: 4 }}>{r.actor}</div>
                        )}
                      </td>
                      <td className="w3-mono">
                        {Number(r.brokenAt) >= 0 ? `#${r.brokenAt}` : Number(r.keptThrough) >= 0 ? `kept #${r.keptThrough}` : '—'}
                      </td>
                      <td>
                        <div className="w3-ellip" title={r.reason || ''}>{r.reason || r.failureKind || '—'}</div>
                        {Number(r.discardedCount) > 0 && (
                          <div className="w3-mono" style={{ fontSize: 11 }}>
                            {r.discardedCount} block(s) discarded
                            {r.healthyAfter === true ? ' · chain healthy after' : r.healthyAfter === false ? ' · still unhealthy' : ''}
                          </div>
                        )}
                        {Number(r.durationMs) > 0 && (
                          <div className="w3-mono" style={{ fontSize: 11 }}>{(r.durationMs / 1000).toFixed(1)}s</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="w3-card">
        <div className="w3-card-title">🧱 Recent blocks</div>
        {chain.blocks.length === 0 ? (
          <Empty icon="🧱">The chain is empty.</Empty>
        ) : (
          <div className="w3-table-wrap">
            <table className="w3-table">
              <thead>
                <tr><th>Block</th><th>Time</th><th>Txs</th><th>Actions</th><th>Hash</th></tr>
              </thead>
              <tbody>
                {chain.blocks.map((b) => (
                  <tr key={b.index}>
                    <td className="w3-mono" style={{ fontWeight: 700 }}>#{b.index}</td>
                    <td>{fmtTime(b.timestamp)}</td>
                    <td>{b.txs.length}</td>
                    <td>
                      <span className="w3-row" style={{ gap: 6 }}>
                        {[...new Set(b.txs.map((t) => t.type))].slice(0, 3).map((t) => (
                          <span className="w3-badge" key={t}>{t}</span>
                        ))}
                        {new Set(b.txs.map((t) => t.type)).size > 3 && (
                          <span className="w3-badge">+{new Set(b.txs.map((t) => t.type)).size - 3}</span>
                        )}
                      </span>
                    </td>
                    <td><CopyChip value={b.hash} label={trunc(b.hash, 8, 6)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {oldest > 0 && (
          <button className="w3-btn ghost" style={{ marginTop: 12 }} disabled={loading} onClick={() => load(oldest)}>
            {loading ? 'Loading…' : 'Load older blocks'}
          </button>
        )}
      </div>
    </div>
  );
}
