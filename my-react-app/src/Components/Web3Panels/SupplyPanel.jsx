import { useEffect, useState } from 'react';
import { listBatches, createBatch, addBatchEvent, addBatchCertification, getBatchQr } from '../../api/web3';
import { Spinner, Alert, CopyChip, Empty, fmtTime, usePanelState } from './w3ui';

// Supply chain studio (features 1 & 2): register batches, walk them through
// the journey (each step anchored first, then stored with its tx), anchor
// lab/certification evidence, and print the bottle's QR verification code.
const STEP_LABELS = {
  'raw-sourcing': '① Raw material sourcing',
  manufacturing: '② Manufacturing',
  'lab-testing': '③ Third-party lab testing',
  'quality-release': '④ Quality release',
  distribution: '⑤ Distribution',
  retail: '⑥ Retail receipt',
  delivered: '⑦ Delivered to customer',
};

const CERT_TYPES = [
  ['lab-report', 'Lab report'],
  ['organic', 'Organic'],
  ['non-gmo', 'Non-GMO'],
  ['third-party', 'Third-party tested'],
  ['gmp', 'GMP certified'],
  ['other', 'Other'],
];

export default function SupplyPanel() {
  const { loading, setLoading, alert, ok, fail, clear } = usePanelState();
  const [batches, setBatches] = useState([]);
  const [steps, setSteps] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [qr, setQr] = useState(null);
  const [busy, setBusy] = useState(false);

  // New batch form
  const [product, setProduct] = useState('');
  const [brand, setBrand] = useState('');
  const [notes, setNotes] = useState('');

  // New event form (per expanded batch)
  const [step, setStep] = useState('manufacturing');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');

  // New certification form
  const [certType, setCertType] = useState('lab-report');
  const [certName, setCertName] = useState('');
  const [certIssuer, setCertIssuer] = useState('');

  const load = async () => {
    try {
      setLoading(true);
      const res = await listBatches();
      setBatches(res.batches || []);
      setSteps(res.steps || []);
      clear();
    } catch (err) {
      fail(err, 'Could not load supply chain batches.');
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
      await load();
      return res;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submitBatch = () =>
    run(
      () => createBatch({ productName: product.trim(), brand: brand.trim(), notes: notes.trim() }),
      (r) => {
        setProduct(''); setBrand(''); setNotes('');
        setExpanded(r.batch._id);
        ok(`Batch ${r.batch.code} created — its journey starts on-chain now.`);
      }
    );

  const submitEvent = (batchId, actorName) =>
    run(
      () => addBatchEvent(batchId, { step, location: location.trim(), note: note.trim(), actorName }),
      () => { setLocation(''); setNote(''); ok('Step appended and anchored on-chain.'); }
    );

  const submitCert = (batchId) =>
    run(
      () => addBatchCertification(batchId, { type: certType, name: certName.trim(), issuer: certIssuer.trim() }),
      () => { setCertName(''); setCertIssuer(''); ok('Certification anchored — digest recorded on-chain.'); }
    );

  const showQr = async (code) => {
    try {
      setBusy(true);
      clear();
      const res = await getBatchQr(code);
      setQr(res);
    } catch (err) {
      fail(err, 'Could not render the QR code.');
    } finally {
      setBusy(false);
    }
  };

  if (loading && batches.length === 0) return <Spinner />;

  return (
    <div>
      <Alert alert={alert} onClear={clear} />

      <div className="w3-card accent">
        <div className="w3-card-title">🏭 Register a new batch</div>
        <p className="w3-card-sub">
          Every bottle gets an unchangeable history — consumers scan the QR and see the whole
          journey, from raw material to their doorstep.
        </p>
        <div className="w3-grid">
          <input className="w3-input" placeholder="Product (e.g. Vitamin D3 60ct)" value={product} onChange={(e) => setProduct(e.target.value)} aria-label="Product" />
          <input className="w3-input" placeholder="Brand" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand" />
          <input className="w3-input" placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
        </div>
        <button
          className="w3-btn"
          style={{ marginTop: 14 }}
          disabled={busy || product.trim().length < 3 || brand.trim().length < 2}
          onClick={submitBatch}
        >
          Create batch + QR code
        </button>
      </div>

      <div className="w3-card">
        <div className="w3-card-title">📦 My batches</div>
        {batches.length === 0 ? (
          <Empty icon="📦">No batches yet — create your first above. Demo batches seeded by the platform live on the public /verify page.</Empty>
        ) : (
          batches.map((b) => {
            const isOpen = expanded === b._id;
            const lastStep = b.events[b.events.length - 1]?.step;
            const nextSteps = steps.filter((s) => !b.events.some((e) => e.step === s.key));
            return (
              <div key={b._id} style={{ borderBottom: '1px solid #f3f4f6', padding: '14px 0' }}>
                <div className="w3-row between">
                  <div>
                    <div style={{ fontWeight: 700, color: '#111827' }}>
                      {b.productName} <span className="w3-badge green" style={{ marginLeft: 8 }}>{b.code}</span>
                    </div>
                    <div className="w3-mono" style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                      {b.brand} · {b.events.length} steps · {b.certifications.length} certifications · last: {lastStep || '—'}
                    </div>
                  </div>
                  <span className="w3-row" style={{ gap: 8 }}>
                    <button className="w3-btn ghost small" onClick={() => showQr(b.code)}>QR</button>
                    <button
                      className="w3-btn ghost small"
                      onClick={() => {
                        setExpanded(isOpen ? null : b._id);
                        setStep(nextSteps[0]?.key || 'manufacturing');
                        setQr(null);
                        clear();
                      }}
                    >
                      {isOpen ? 'Close' : 'Manage'}
                    </button>
                  </span>
                </div>

                {qr && qr.code === b.code && (
                  <div style={{ marginTop: 14, textAlign: 'center' }}>
                    <img src={qr.qr} alt={`QR code for batch ${b.code}`} style={{ width: 180, height: 180 }} />
                    <div className="w3-mono" style={{ fontSize: 12, marginTop: 6 }}>{qr.url}</div>
                    <div className="w3-card-sub" style={{ marginTop: 6 }}>
                      Print this on the bottle — anyone can scan it to verify.
                    </div>
                  </div>
                )}

                {isOpen && (
                  <div style={{ marginTop: 16 }}>
                    <div className="w3-label">Journey (each step = one block)</div>
                    <ul className="w3-timeline">
                      {b.events.map((e) => (
                        <li className="w3-timeline-item" key={e._id || e.txHash}>
                          <div className="w3-timeline-title">{STEP_LABELS[e.step] || e.step}</div>
                          <div className="w3-timeline-meta">
                            {fmtTime(e.at)} {e.location ? `· ${e.location}` : ''} {e.actorName ? `· ${e.actorName}` : ''}
                          </div>
                          {e.note && <div className="w3-timeline-note">{e.note}</div>}
                          {e.txHash && <div style={{ marginTop: 4 }}><CopyChip value={e.txHash} label={`block #${e.blockIndex}`} /></div>}
                        </li>
                      ))}
                    </ul>

                    {nextSteps.length > 0 && (
                      <div className="w3-card" style={{ background: '#f9fafb', marginBottom: 12 }}>
                        <div className="w3-label">Append next step</div>
                        <div className="w3-row" style={{ alignItems: 'flex-end' }}>
                          <select className="w3-select" style={{ maxWidth: 240 }} value={step} onChange={(e) => setStep(e.target.value)} aria-label="Step">
                            {nextSteps.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                          </select>
                          <input className="w3-input" style={{ maxWidth: 200 }} placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Location" />
                          <input className="w3-input" style={{ flex: 1, minWidth: 180 }} placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
                          <button className="w3-btn small" disabled={busy || !nextSteps.some((s) => s.key === step)} onClick={() => submitEvent(b._id, b.brand)}>
                            Log step
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="w3-label" style={{ marginTop: 8 }}>Certifications & lab results</div>
                    {b.certifications.length > 0 && (
                      <div className="w3-table-wrap" style={{ marginBottom: 10 }}>
                        <table className="w3-table">
                          <thead><tr><th>Type</th><th>Name</th><th>Issuer</th><th>Digest</th><th>Proof</th></tr></thead>
                          <tbody>
                            {b.certifications.map((c) => (
                              <tr key={c._id || c.txHash}>
                                <td><span className="w3-badge blue">{c.type}</span></td>
                                <td>{c.name}</td>
                                <td>{c.issuer}</td>
                                <td><CopyChip value={c.resultHash} label={`${String(c.resultHash).slice(0, 12)}…`} /></td>
                                <td>{c.txHash ? <CopyChip value={c.txHash} label={`#${c.blockIndex}`} /> : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="w3-row" style={{ alignItems: 'flex-end' }}>
                      <select className="w3-select" style={{ maxWidth: 170 }} value={certType} onChange={(e) => setCertType(e.target.value)} aria-label="Certification type">
                        {CERT_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      <input className="w3-input" style={{ maxWidth: 230 }} placeholder="Certificate name" value={certName} onChange={(e) => setCertName(e.target.value)} aria-label="Certificate name" />
                      <input className="w3-input" style={{ maxWidth: 190 }} placeholder="Issuing body" value={certIssuer} onChange={(e) => setCertIssuer(e.target.value)} aria-label="Issuer" />
                      <button
                        className="w3-btn small"
                        disabled={busy || certName.trim().length < 3 || certIssuer.trim().length < 2}
                        onClick={() => submitCert(b._id)}
                      >
                        Anchor certificate
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="w3-card">
        <div className="w3-card-title">🔍 Try the consumer experience</div>
        <p className="w3-card-sub">
          The public verification page needs no account — it's exactly what a customer sees after
          scanning the bottle.
        </p>
        <a className="w3-btn ghost" href="/verify" target="_blank" rel="noreferrer">
          Open /verify →
        </a>
      </div>
    </div>
  );
}
