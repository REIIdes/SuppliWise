import { useEffect, useState } from 'react';
import { getHistory } from '../../api';
import { anchorRecommendations, getRecommendationAnchor } from '../../api/web3';
import { Spinner, Alert, Empty, fmtDay, trunc, CopyChip, usePanelState } from './w3ui';

// Verifiable AI recommendations (feature 17): the recommender's inputs,
// outputs and logic version are hashed and anchored on-chain. Verification
// recomputes both digests from the stored record — if anything drifted since
// anchoring (results edited, record tampered), the check fails loudly.
export default function AiProofPanel() {
  const { loading, setLoading, alert, ok, fail, clear } = usePanelState();
  const [assessments, setAssessments] = useState([]);
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const hist = await getHistory(1, 20);
        setAssessments(hist.assessments || []);
        clear();
      } catch (err) {
        fail(err, 'Could not load your assessments.');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only initial fetch
  }, []);

  const anchor = async () => {
    if (!selected) return;
    try {
      setBusy(true);
      clear();
      setResult(null);
      const res = await anchorRecommendations(selected);
      setResult({ anchor: res.anchor, verification: null });
      ok('Recommendation inputs/outputs hashed and anchored on-chain. Now verify it below.');
    } catch (err) {
      fail(err, 'Could not anchor this recommendation.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!selected) return;
    try {
      setBusy(true);
      clear();
      const res = await getRecommendationAnchor(selected);
      setResult(res);
      if (res.verification.valid) ok('✓ Verified — inputs, outputs and logic version are intact since anchoring.');
      else fail({ message: 'Verification FAILED: the record changed after it was anchored.' });
    } catch (err) {
      fail(err, err.status === 404 ? 'No anchor yet for this assessment — anchor it first.' : 'Could not verify.');
    } finally {
      setBusy(false);
    }
  };

  if (loading && assessments.length === 0) return <Spinner />;

  return (
    <div>
      <Alert alert={alert} onClear={clear} />

      <div className="w3-card accent">
        <div className="w3-card-title">🤖 Why was I recommended this?</div>
        <p className="w3-card-sub">
          Black-box AI is the opposite of what a health product needs. Anchor every recommendation
          run — inputs, outputs and the engine version — then re-verify it any time. If a single
          byte changed afterwards, verification fails.
        </p>

        {assessments.length === 0 ? (
          <Empty icon="🧪">Complete an assessment first — its AI results become anchorable here.</Empty>
        ) : (
          <>
            <div className="w3-row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <label className="w3-label" htmlFor="ai-assess">Assessment</label>
                <select
                  id="ai-assess"
                  className="w3-select"
                  value={selected}
                  onChange={(e) => { setSelected(e.target.value); setResult(null); clear(); }}
                >
                  <option value="">Select an assessment…</option>
                  {assessments.map((a) => (
                    <option key={a._id} value={a._id}>
                      {fmtDay(a.createdAt)} {a.priority === 'Priority' ? '· Priority' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <button className="w3-btn" disabled={!selected || busy} onClick={anchor}>
                ⛓️ Anchor recommendations
              </button>
              <button className="w3-btn ghost" disabled={!selected || busy} onClick={verify}>
                🔍 Verify anchor
              </button>
            </div>
          </>
        )}
      </div>

      {result && (
        <div className="w3-card">
          <div className="w3-card-title">🔍 Audit trail</div>

          {result.verification && (
            <div className="w3-row" style={{ marginBottom: 14 }}>
              <span className={`w3-badge ${result.verification.inputIntact ? 'green' : 'red'}`}>
                Inputs {result.verification.inputIntact ? 'intact ✓' : 'CHANGED ✗'}
              </span>
              <span className={`w3-badge ${result.verification.outputIntact ? 'green' : 'red'}`}>
                Outputs {result.verification.outputIntact ? 'intact ✓' : 'CHANGED ✗'}
              </span>
              <span className={`w3-badge ${result.verification.valid ? 'green' : 'red'}`}>
                {result.verification.valid ? 'Fully verified ✓' : 'Verification failed ✗'}
              </span>
              <span className="w3-badge blue">logic: {result.verification.logicVersion}</span>
            </div>
          )}

          <div className="w3-table-wrap">
            <table className="w3-table">
              <tbody>
                <tr>
                  <td style={{ fontWeight: 600, width: 180 }}>Logic version</td>
                  <td className="w3-mono">{result.anchor.logicVersion}</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Input hash</td>
                  <td><CopyChip value={result.anchor.inputHash} label={trunc(result.anchor.inputHash, 16, 8)} /></td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Output hash</td>
                  <td><CopyChip value={result.anchor.outputHash} label={trunc(result.anchor.outputHash, 16, 8)} /></td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Combined hash</td>
                  <td><CopyChip value={result.anchor.combinedHash} label={trunc(result.anchor.combinedHash, 16, 8)} /></td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Block</td>
                  <td className="w3-mono">#{result.anchor.blockIndex}</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Transaction</td>
                  <td>{result.anchor.txHash ? <CopyChip value={result.anchor.txHash} /> : '—'}</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Anchored</td>
                  <td>{fmtDay(result.anchor.at || result.anchor.createdAt)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
