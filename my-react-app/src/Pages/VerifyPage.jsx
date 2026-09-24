import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { verifyBatchCode } from '../api/web3';
import { Spinner, CopyChip, fmtTime, trunc } from '../Components/Web3Panels/w3ui';
import './Web3.css';

// PUBLIC (no account): what a consumer sees after scanning a bottle's QR
// code. Recomputes every anchored transaction's block hash so the verdict is
// tamper-evidence, not a marketing claim.
export default function VerifyPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [input, setInput] = useState(code || '');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const runVerify = async (value) => {
    const codeToCheck = String(value || '').trim().toUpperCase();
    if (!codeToCheck) return;
    try {
      setLoading(true);
      setError('');
      setResult(null);
      const res = await verifyBatchCode(codeToCheck);
      setResult(res);
    } catch (err) {
      setError(err.message || 'Verification failed.');
    } finally {
      setLoading(false);
    }
  };

  // Verify whenever the URL carries a code (initial scan or after submit).
  useEffect(() => { if (code) runVerify(code); /* eslint-disable-line react-hooks/set-state-in-effect -- intentional verify-on-scan */ }, [code]);

  const submit = (e) => {
    e.preventDefault();
    const v = input.trim().toUpperCase();
    if (!v) return;
    if (v !== code) navigate(`/verify/${v}`); // effect below performs the fetch
    else runVerify(v);
  };

  const verified = !!result && result.verified;

  return (
    <div className="w3-page">
      <Navbar />
      <div className="w3-container" style={{ maxWidth: 860 }}>
        {/* The form previously floated bare on the page background, so the
            whole screen read as empty until a code was entered. */}
        <div className="w3-verify-shell">
          <div className="w3-verify-hero">
            <div className="w3-verify-icon" aria-hidden="true">🔎</div>
            <h1 className="w3-title" style={{ marginBottom: 6 }}>Product Verification</h1>
            <p className="w3-subtitle" style={{ marginBottom: 0 }}>
              Enter the code printed on the bottle (or scan its QR) to see its full, unchangeable
              journey — no account required.
            </p>
            <form onSubmit={submit} className="w3-verify-form">
              <input
                className="w3-code-input"
                placeholder="SW-XXXXXXXX"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                aria-label="Verification code"
                autoComplete="off"
                spellCheck={false}
              />
              <button className="w3-btn" type="submit" disabled={loading || !input.trim()}>
                {loading ? 'Verifying…' : 'Verify'}
              </button>
            </form>
          </div>
        </div>

        {/* Single polite live region: loading, failure and the verdict are all
            announced to assistive tech without stealing focus. */}
        <div aria-live="polite" aria-busy={loading}>
          {loading && <Spinner />}

          {!loading && error && (
          <div className="w3-card">
            <div className="w3-verify-hero" style={{ padding: '10px 0' }}>
              <span className="w3-verify-badge bad">⚠️ NOT VERIFIED</span>
              <p className="w3-subtitle">{error}</p>
              <p className="w3-card-sub" style={{ marginTop: 8 }}>
                This code does not match any registered batch on the SuppliWise supply-chain
                ledger. Do not trust the product.
              </p>
            </div>
          </div>
        )}

        {!loading && result && (
          <>
            <div className="w3-card accent">
              <div className="w3-verify-hero" style={{ padding: '4px 0 18px' }}>
                <span className={`w3-verify-badge ${verified ? 'good' : 'bad'}`}>
                  {verified ? '✓ AUTHENTIC & VERIFIED' : '⚠️ PROOF INCOMPLETE'}
                </span>
                <div style={{ fontSize: 24, fontWeight: 800, color: '#111827' }}>{result.productName}</div>
                <div className="w3-listing-brand" style={{ marginTop: 4 }}>{result.brand}</div>
                <div className="w3-row" style={{ justifyContent: 'center', marginTop: 12 }}>
                  <span className="w3-badge green">{result.code}</span>
                  <span className="w3-badge blue">registered {fmtTime(result.createdAt)}</span>
                  <span className="w3-badge">
                    proofs {result.proof.valid}/{result.proof.checks} valid
                  </span>
                </div>
                {result.notes ? (
                  <p className="w3-card-sub" style={{ marginTop: 12, marginBottom: 0 }}>{result.notes}</p>
                ) : null}
              </div>

              <div className="w3-grid">
                <div className="w3-stat">
                  <div className="w3-stat-value green">{result.proof.checks}</div>
                  <div className="w3-stat-label">On-chain proofs checked</div>
                </div>
                <div className="w3-stat">
                  <div className="w3-stat-value">{result.proof.difficulty}</div>
                  <div className="w3-stat-label">PoW difficulty</div>
                </div>
                <div className="w3-stat">
                  <div className="w3-stat-value">#{result.proof.height}</div>
                  <div className="w3-stat-label">Chain height</div>
                </div>
                <div className="w3-stat">
                  <div className="w3-stat-value" style={{ fontSize: 16 }}>{result.steps.length}</div>
                  <div className="w3-stat-label">Journey steps</div>
                </div>
              </div>
            </div>

            <div className="w3-card">
              <div className="w3-card-title">🧭 Full journey</div>
              <p className="w3-card-sub">
                Every step below is anchored to block {result.proof.network} — each hash was
                recomputed just now.
              </p>
              {result.steps.length === 0 ? (
                <p className="w3-card-sub">No journey steps recorded yet.</p>
              ) : (
                <ul className="w3-timeline">
                  {result.steps.map((s) => (
                    <li className="w3-timeline-item" key={`${s.step}-${s.at}`}>
                      <div className="w3-timeline-title">{s.label}</div>
                      <div className="w3-timeline-meta">
                        {fmtTime(s.at)} {s.location ? `· ${s.location}` : ''} {s.actorName ? `· ${s.actorName}` : ''}
                      </div>
                      {s.note ? <div className="w3-timeline-note">{s.note}</div> : null}
                      {s.txHash ? (
                        <div style={{ marginTop: 4 }}>
                          <CopyChip value={s.txHash} label={`block #${s.blockIndex} · ${trunc(s.txHash, 8, 6)}`} />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {result.certifications.length > 0 && (
              <div className="w3-card">
                <div className="w3-card-title">📜 Certifications & lab results</div>
                <div className="w3-table-wrap">
                  <table className="w3-table">
                    <thead>
                      <tr><th>Type</th><th>Certificate</th><th>Issuer</th><th>Proof</th></tr>
                    </thead>
                    <tbody>
                      {result.certifications.map((c, i) => (
                        <tr key={`${c.txHash}-${i}`}>
                          <td><span className="w3-badge blue">{c.type}</span></td>
                          <td style={{ fontWeight: 600 }}>{c.name}</td>
                          <td>{c.issuer}</td>
                          <td>
                            {c.txHash ? (
                              <CopyChip value={c.txHash} label={`#${c.blockIndex} · ${trunc(c.resultHash, 8, 6)}`} />
                            ) : (
                              <CopyChip value={c.resultHash} label={trunc(c.resultHash, 10, 6)} />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
