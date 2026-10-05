import { useEffect, useState } from 'react';
import {
  getDataShares,
  createDataShare,
  revokeDataShare,
  getProfileShares,
  createProfileShare,
  revokeProfileShare,
} from '../../api/web3';
import { Spinner, Alert, Stat, CopyChip, Empty, fmtDay, usePanelState } from './w3ui';

const SCOPES = [
  { key: 'nutrition-outcomes', label: 'Nutrition outcomes study' },
  { key: 'adherence-study', label: 'Supplement adherence study' },
  { key: 'general-research', label: 'General wellness research' },
];

// Data sovereignty & rewards (feature 7): users grant/revoke anonymized,
// coarse datasets to research institutions and earn WELL for each grant —
// with the consent itself anchored on-chain and the payload encrypted in
// decentralized storage (feature 8). Plus doctor-facing share links (16).
export default function PrivacyPanel() {
  const { loading, setLoading, alert, ok, fail, clear } = usePanelState();
  const [shares, setShares] = useState(null);
  const [links, setLinks] = useState(null);
  const [recipient, setRecipient] = useState('');
  const [scope, setScope] = useState(SCOPES[0].key);
  const [ttl, setTtl] = useState('72');
  const [lastDataset, setLastDataset] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const [sh, li] = await Promise.all([getDataShares(), getProfileShares()]);
      setShares(sh);
      setLinks(li.links || []);
      clear();
    } catch (err) {
      fail(err, 'Could not load privacy settings.');
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

  if (loading && !shares) return <Spinner />;
  if (!shares) return <Alert alert={alert} onClear={clear} />;

  const active = shares.shares.filter((s) => s.status === 'active');
  const revoked = shares.shares.filter((s) => s.status === 'revoked');

  return (
    <div>
      <Alert alert={alert} onClear={clear} />

      <div className="w3-card accent">
        <div className="w3-card-title">🔬 Share anonymized data, earn WELL</div>
        <p className="w3-card-sub">
          You choose who gets what. The dataset is built from coarse bands only (age decade,
          adherence band…) — no IDs, dates or free text — encrypted, content-addressed, and the
          consent record lives on-chain. Revoke anytime and the payload is destroyed.
        </p>

        <div className="w3-grid">
          <Stat value={active.length} label="Active shares" tone="green" />
          <Stat value={shares.totalRewards} label="WELL earned sharing" tone="amber" />
          <Stat value={revoked.length} label="Revoked" />
        </div>

        <div className="w3-row" style={{ marginTop: 18, alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label className="w3-label" htmlFor="ds-recipient">Research institution</label>
            <input
              id="ds-recipient"
              className="w3-input"
              placeholder="e.g. Kinetic Health Institute"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>
          <div style={{ minWidth: 200 }}>
            <label className="w3-label" htmlFor="ds-scope">Data scope</label>
            <select id="ds-scope" className="w3-select" value={scope} onChange={(e) => setScope(e.target.value)}>
              {SCOPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          <button
            className="w3-btn"
            disabled={busy || recipient.trim().length < 3}
            onClick={() =>
              run(
                () => createDataShare({ recipient: recipient.trim(), scope }),
                (r) => {
                  setLastDataset(r.anonymizedDataset);
                  setRecipient('');
                  ok(`Consent granted on-chain — +${r.reward} WELL. Dataset CID: ${r.share.datasetCid.slice(0, 16)}…`);
                }
              )
            }
          >
            Grant access (+25 WELL)
          </button>
        </div>

        {lastDataset && (
          <div style={{ marginTop: 14 }}>
            <div className="w3-label">Exactly what the researcher receives:</div>
            <div className="w3-mono" style={{ background: '#f9fafb', padding: 10, borderRadius: 8, maxHeight: 160, overflow: 'auto' }}>
              {JSON.stringify(lastDataset, null, 2)}
            </div>
          </div>
        )}
      </div>

      <div className="w3-card">
        <div className="w3-card-title">🤝 Data share consents</div>
        {shares.shares.length === 0 ? (
          <Empty icon="🔒">No shares yet — you are the only holder of your data.</Empty>
        ) : (
          <div className="w3-table-wrap">
            <table className="w3-table">
              <thead>
                <tr><th>Recipient</th><th>Scope</th><th>Dataset</th><th>Consent tx</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {shares.shares.map((s) => (
                  <tr key={s._id}>
                    <td style={{ fontWeight: 600 }}>{s.recipient}</td>
                    <td>{SCOPES.find((x) => x.key === s.scope)?.label || s.scope}</td>
                    <td>{s.datasetCid ? <CopyChip value={s.datasetCid} label={`${s.datasetCid.slice(0, 12)}…`} /> : '—'}</td>
                    <td>{s.consentTx ? <CopyChip value={s.consentTx} /> : '—'}</td>
                    <td>
                      <span className={`w3-badge ${s.status === 'active' ? 'green' : 'red'}`}>{s.status}</span>
                    </td>
                    <td>
                      {s.status === 'active' && (
                        <button
                          className="w3-btn danger small"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () => revokeDataShare(s._id),
                              () => ok('Consent revoked and encrypted dataset destroyed.')
                            )
                          }
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="w3-card">
        <div className="w3-card-title">🩺 Share your health profile (doctors & nutritionists)</div>
        <p className="w3-card-sub">
          Time-boxed, revocable links that expose only what you hold — latest assessment context,
          tracking stats and your last ledger anchor. Perfect for a consultation.
        </p>
        <div className="w3-row" style={{ alignItems: 'flex-end' }}>
          <div style={{ minWidth: 170 }}>
            <label className="w3-label" htmlFor="ps-ttl">Valid for (hours)</label>
            <select id="ps-ttl" className="w3-select" value={ttl} onChange={(e) => setTtl(e.target.value)}>
              <option value="1">1 hour</option>
              <option value="24">24 hours</option>
              <option value="72">3 days</option>
              <option value="168">7 days</option>
              <option value="720">30 days</option>
            </select>
          </div>
          <button
            className="w3-btn"
            disabled={busy}
            onClick={() =>
              run(
                () => createProfileShare(Number(ttl)),
                () => ok('Share link created — copy it from the table below and send it to your clinician.')
              )
            }
          >
            Create share link
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          {links.length === 0 ? (
            <Empty icon="🔗">No share links yet.</Empty>
          ) : (
            <div className="w3-table-wrap">
              <table className="w3-table">
                <thead>
                  <tr><th>Link</th><th>Expires</th><th>Views</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {links.map((l) => {
                    const url = `${window.location.origin}/share/${l.token}`;
                    return (
                      <tr key={l._id}>
                        <td><CopyChip value={url} label={`${url.slice(0, 34)}…`} /></td>
                        <td>{fmtDay(l.expiresAt)}</td>
                        <td>{l.views}</td>
                        <td>
                          <span className={`w3-badge ${l.revoked ? 'red' : l.expired ? 'amber' : 'green'}`}>
                            {l.revoked ? 'Revoked' : l.expired ? 'Expired' : 'Active'}
                          </span>
                        </td>
                        <td>
                          {!l.revoked && (
                            <button
                              className="w3-btn danger small"
                              disabled={busy}
                              onClick={() =>
                                run(
                                  () => revokeProfileShare(l._id),
                                  () => ok('Share link revoked.')
                                )
                              }
                            >
                              Revoke
                            </button>
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
      </div>
    </div>
  );
}
