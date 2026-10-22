import { useEffect, useState } from 'react';
import {
  getDataShares,
  createDataShare,
  revokeDataShare,
  getProfileShares,
  createProfileShare,
  revokeProfileShare,
  getStorageList,
  getStorage,
  pinStorage,
} from '../../api/web3';
import { Spinner, Alert, Stat, CopyChip, Empty, fmtDay, fmtTime, usePanelState } from './w3ui';

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
  const [vault, setVault] = useState({ objects: [], count: 0, totalBytes: 0 });
  const [note, setNote] = useState('');
  const [opened, setOpened] = useState(null);
  const [recipient, setRecipient] = useState('');
  const [scope, setScope] = useState(SCOPES[0].key);
  const [ttl, setTtl] = useState('72');
  const [lastDataset, setLastDataset] = useState(null);
  const [busy, setBusy] = useState(false);

  // `keepMessage` exists because every action here reloads AFTER it has already
  // set its success line. Clearing during that reload erased "Consent granted
  // on-chain — +25 WELL" the instant it appeared, so the one message the user
  // earned was the one thing they never saw.
  const load = async (keepMessage = false) => {
    try {
      if (!keepMessage) setLoading(true);
      const [sh, li, vu] = await Promise.all([getDataShares(), getProfileShares(), getStorageList()]);
      setShares(sh);
      setLinks(li.links || []);
      setVault(vu);
      if (!keepMessage) clear();
    } catch (err) {
      fail(err, 'Could not load privacy settings.');
    } finally {
      if (!keepMessage) setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- intentional initial load on mount */ }, []);

  const run = async (fn, onSuccess) => {
    try {
      setBusy(true);
      clear();
      const res = await fn();
      if (onSuccess) onSuccess(res);
      // Quietly: the receipt onSuccess just wrote is the point of the action.
      await load(true);
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
      <div className="w3-card">
        <div className="w3-card-title">🗄️ Your encrypted vault</div>
        <p className="w3-card-sub">
          Notes you pin here are AES-256-GCM encrypted before they leave this device, stored under
          their own content hash, and that hash is anchored in a block. Decrypting re-hashes the
          ciphertext, so a tampered object fails its own integrity check instead of silently
          opening.
        </p>

        <div className="w3-row" style={{ alignItems: 'flex-end', marginTop: 14 }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <label className="w3-label" htmlFor="vault-note">Pin a note (only you can read it)</label>
            <textarea
              id="vault-note"
              className="w3-input"
              rows={2}
              maxLength={2000}
              placeholder="e.g. My doctor told me to recheck ferritin in March."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <button
            className="w3-btn"
            disabled={busy || note.trim().length < 3}
            onClick={() =>
              run(
                () => pinStorage({ text: note.trim(), at: Date.now() }, 'note'),
                (r) => {
                  setNote('');
                  ok(r.anchored
                    ? `Sealed and anchored in block #${r.blockIndex}.`
                    : 'Sealed and stored. The block is still being written — the vault re-anchors it on the next refresh.');
                }
              )
            }
          >
            Encrypt &amp; pin
          </button>
        </div>

        <div className="w3-grid" style={{ marginTop: 16 }}>
          <Stat value={vault.count} label="Objects pinned" tone="green" />
          <Stat value={`${Math.max(1, Math.round(vault.totalBytes / 1024))} KB`} label="Encrypted at rest" tone="amber" hint="Rounded up when the vault is empty" />
        </div>

        {vault.objects.length === 0 ? (
          <Empty icon="🗄️" title="Nothing pinned yet">
            A pinned note is proof that content-addressed storage is not only for research datasets.
          </Empty>
        ) : (
          <div className="w3-table-wrap" style={{ marginTop: 14 }}>
            <table className="w3-table">
              <thead>
                <tr><th>Kind</th><th>Content id</th><th>Pinned</th><th>Block tx</th><th /></tr>
              </thead>
              <tbody>
                {vault.objects.map((o) => (
                  <tr key={o.cid}>
                    <td><span className="w3-badge blue">{o.kind}</span></td>
                    <td><CopyChip value={o.cid} label={`${o.cid.slice(0, 14)}…`} /></td>
                    <td>{fmtTime(o.pinnedAt)}</td>
                    <td>{o.txHash ? <CopyChip value={o.txHash} /> : <span className="w3-badge amber">not anchored</span>}</td>
                    <td>
                      <button
                        className="w3-btn ghost small"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => getStorage(o.cid),
                            (r) => {
                              setOpened(r);
                              if (!r.integrityOk) fail({ message: 'Integrity check FAILED for this object — its ciphertext no longer hashes to its content id.' });
                              else ok('Decrypted and integrity verified ✓');
                            }
                          )
                        }
                      >
                        Decrypt
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {opened && (
          <div style={{ marginTop: 14 }}>
            <div className="w3-label">
              Decrypted {opened.kind} · {opened.integrityOk ? 'integrity verified ✓' : 'INTEGRITY FAILED ✗'}
            </div>
            <div className="w3-mono" style={{ background: '#f9fafb', padding: 10, borderRadius: 8, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {typeof opened.data === 'string' ? opened.data : JSON.stringify(opened.data, null, 2)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
