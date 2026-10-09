import { useEffect, useState } from 'react';
import { getChain, verifyChain, getTx, getChainStatus } from '../../api/web3';
import { Spinner, Alert, Stat, CopyChip, Empty, fmtTime, trunc, usePanelState } from './w3ui';

// Chain explorer: browse blocks, recompute the whole chain's integrity, and
// look up any transaction hash (from rewards, escrow, consent, votes…).
export default function ExplorerPanel() {
  const { loading, setLoading, alert, ok, fail, clear, info } = usePanelState();
  const [chain, setChain] = useState(null);
  const [verify, setVerify] = useState(null);
  const [status, setStatus] = useState(null);
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
      const res = await verifyChain();
      setVerify(res);
      if (res.valid) ok(`Chain valid ✓ — ${res.checked} blocks recomputed at difficulty ${res.difficulty}.`);
      else fail({ message: `Chain BROKEN at block #${res.brokenAt}: ${res.reason}` });
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
      : verdict.state === 'verifying'
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
        </div>
        {status && status.state === 'compromised' && (
          <div className="w3-alert err" style={{ marginTop: 14 }} role="alert">
            <strong>⚠️ Blockchain record integrity issue.</strong>{' '}
            {status.notice || 'Records anchored around the affected block are not being treated as verified.'}
            {status.brokenAt != null && (
              <> Affected block: <span className="w3-mono">#{status.brokenAt}</span>. </>
            )}
            {status.reason && <> <span className="w3-mono">{status.reason}</span></>}
            {/*
              Say the two things a user would otherwise have to guess: that the
              ledger is frozen rather than broken-forever, and what that means for
              a receipt they are waiting on. Without this the warning reads as
              "everything is lost", which is the opposite of the truth.
            */}
            {status.quarantined && (
              <div style={{ marginTop: 8 }}>
                The ledger has paused rather than continuing on the damaged blocks, and your
                account, balance and orders are unaffected. New on-chain receipts are temporarily
                withheld — anything you complete is still recorded on your account and will be
                anchored once the chain is repaired.
                {status.quarantine?.needsBackupRestore && (
                  <> This one requires a backup restore rather than a repair.</>
                )}
              </div>
            )}
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
