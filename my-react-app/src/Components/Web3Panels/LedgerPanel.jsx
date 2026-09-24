import { useEffect, useState } from 'react';
import {
  getHealthLedger,
  anchorHealthLedger,
  exportHealthCredential,
  backupHealthRecord,
  getStorage,
} from '../../api/web3';
import { Spinner, Alert, Stat, CopyChip, Empty, fmtTime, trunc, usePanelState } from './w3ui';

// User-owned health records (feature 6) + interoperable profile (feature 16):
// snapshot digests anchored to the chain, a signed portable credential, and
// an encrypted content-addressed backup (feature 8).
export default function LedgerPanel() {
  const { loading, setLoading, alert, ok, fail, clear, info } = usePanelState();
  const [ledger, setLedger] = useState(null);
  const [credential, setCredential] = useState(null);
  const [backup, setBackup] = useState(null);
  const [restoreCid, setRestoreCid] = useState('');
  const [restored, setRestored] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      setLedger(await getHealthLedger());
      clear();
    } catch (err) {
      fail(err, 'Could not load your health ledger.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- intentional initial load on mount */ }, []);

  const run = async (fn, onSuccess) => {
    try {
      setBusy(true);
      clear();
      const res = await fn();
      if (onSuccess) onSuccess(res);
      return res;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const downloadCredential = () => {
    if (!credential) return;
    const blob = new Blob([JSON.stringify(credential, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `suppliwise-health-credential-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    info('Credential downloaded — verify it at /web3/health/verify or share it with your clinician.');
  };

  if (loading && !ledger) return <Spinner />;
  if (!ledger) return <Alert alert={alert} onClear={clear} />;

  const { summary, anchors } = ledger;

  return (
    <div>
      <Alert alert={alert} onClear={clear} />

      <div className="w3-card accent">
        <div className="w3-card-title">📒 Your immutable health ledger</div>
        <p className="w3-card-sub">
          Assessment and intake history digests are anchored on-chain — proof the record existed,
          unchanged, at a point in time. The raw data never leaves the database.
        </p>
        <div className="w3-grid">
          <Stat value={summary.assessmentCount} label="Assessments on record" tone="green" />
          <Stat value={summary.intakeCount} label="Intake entries" />
          <Stat value={anchors.length} label="Chain anchors" tone="amber" />
          <Stat value={summary.latestAssessmentAt ? fmtTime(summary.latestAssessmentAt) : '—'} label="Latest assessment" />
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="w3-label">Current record digest (sha256)</div>
          <CopyChip value={summary.currentDigest} label={trunc(summary.currentDigest, 18, 10)} />
        </div>

        <div className="w3-row" style={{ marginTop: 16 }}>
          <button
            className="w3-btn"
            disabled={busy}
            onClick={() =>
              run(
                () => anchorHealthLedger(),
                async (r) => {
                  await load();
                  ok(`Anchored at block #${r.anchor.blockIndex}${r.reward ? ` (+${r.reward} WELL)` : ''}.`);
                }
              )
            }
          >
            ⛓️ Anchor snapshot now
          </button>
          <button
            className="w3-btn ghost"
            disabled={busy}
            onClick={() =>
              run(
                () => backupHealthRecord(),
                (r) => {
                  setBackup(r);
                  setRestored(null);
                  ok(`Encrypted backup pinned to decentralized storage (CID ${trunc(r.cid, 14, 8)}).`);
                }
              )
            }
          >
            🗄️ Encrypted backup (IPFS-style)
          </button>
          <button
            className="w3-btn ghost"
            disabled={busy}
            onClick={() =>
              run(
                () => exportHealthCredential(),
                (r) => { setCredential(r); ok('Signed credential generated.'); }
              )
            }
          >
            📜 Export signed credential
          </button>
        </div>

        {backup && (
          <div style={{ marginTop: 14 }}>
            <div className="w3-label">Backup content ID</div>
            <CopyChip value={backup.cid} label={backup.cid} />
          </div>
        )}
      </div>

      {credential && (
        <div className="w3-card">
          <div className="w3-card-title">✅ Verifiable credential</div>
          <p className="w3-card-sub">
            Signed with your wallet's ed25519 key. Anyone can check it against your public key —
            no SuppliWise account required.
          </p>
          <div className="w3-row" style={{ marginBottom: 12 }}>
            <span className="w3-badge purple">alg: {credential.proof.algorithm}</span>
            <CopyChip value={credential.proof.did} label={credential.proof.did} />
          </div>
          <div className="w3-label">Signature</div>
          <div className="w3-mono" style={{ background: '#f9fafb', padding: 10, borderRadius: 8, maxHeight: 70, overflow: 'auto' }}>
            {credential.proof.signature}
          </div>
          <div className="w3-row" style={{ marginTop: 12 }}>
            <button className="w3-btn small" onClick={downloadCredential}>Download JSON</button>
            <button
              className="w3-btn ghost small"
              onClick={() => { setCredential(null); clear(); }}
            >
              Hide
            </button>
          </div>
        </div>
      )}

      <div className="w3-card">
        <div className="w3-card-title">🔓 Restore from decentralized storage</div>
        <p className="w3-card-sub">
          Paste a CID from any backup you pinned — the server decrypts it only for its owner and
          re-checks the content hash.
        </p>
        <div className="w3-row">
          <input
            className="w3-input"
            style={{ flex: 1, minWidth: 240 }}
            placeholder="bafy…"
            value={restoreCid}
            onChange={(e) => setRestoreCid(e.target.value)}
            aria-label="Content ID"
          />
          <button
            className="w3-btn ghost"
            disabled={busy || !restoreCid.trim()}
            onClick={() =>
              run(
                () => getStorage(restoreCid.trim()),
                (r) => {
                  setRestored(r);
                  ok(r.integrityOk ? 'CID integrity verified ✓' : 'Warning: content does not match its CID.');
                }
              )
            }
          >
            Fetch & decrypt
          </button>
        </div>
        {restored && (
          <div style={{ marginTop: 12 }}>
            <div className="w3-row" style={{ marginBottom: 8 }}>
              <span className={`w3-badge ${restored.integrityOk ? 'green' : 'red'}`}>
                {restored.integrityOk ? 'Integrity ✓' : 'Integrity ✗'}
              </span>
              <span className="w3-badge">{restored.kind}</span>
              <span className="w3-badge">size: {restored.size}</span>
            </div>
            <div className="w3-mono" style={{ background: '#f9fafb', padding: 10, borderRadius: 8, maxHeight: 200, overflow: 'auto' }}>
              {JSON.stringify(restored.data, null, 2)}
            </div>
          </div>
        )}
      </div>

      <div className="w3-card">
        <div className="w3-card-title">⚓ Anchor history</div>
        <p className="w3-card-sub">Newest first — each row points at its block and transaction.</p>
        {anchors.length === 0 ? (
          <Empty icon="⚓">No snapshots anchored yet — use the button above to create your first.</Empty>
        ) : (
          <div className="w3-table-wrap">
            <table className="w3-table">
              <thead>
                <tr><th>When</th><th>Block</th><th>Assessments</th><th>Intakes</th><th>Digest</th><th>Tx</th></tr>
              </thead>
              <tbody>
                {anchors.map((a) => (
                  <tr key={a._id}>
                    <td>{fmtTime(a.at)}</td>
                    <td className="w3-mono">#{a.blockIndex}</td>
                    <td>{a.assessmentCount}</td>
                    <td>{a.intakeCount}</td>
                    <td><CopyChip value={a.digest} label={trunc(a.digest, 10, 6)} /></td>
                    <td>{a.txHash ? <CopyChip value={a.txHash} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
