import { useEffect, useState } from 'react';
import { getWallet, exportWalletKey, getWeb3Config } from '../../api/web3';
import { Spinner, Alert, Stat, CopyChip, fmtWell, fmtTime, usePanelState } from './w3ui';

// Wallet + decentralized identity (feature 5): DID, address, balances, and
// an owner-only signing-key export. The welcome airdrop lands automatically
// on first ever fetch (server-side), so a brand-new account starts usable.
export default function WalletPanel() {
  const { loading, setLoading, alert, ok, fail, clear } = usePanelState();
  const [wallet, setWallet] = useState(null);
  const [config, setConfig] = useState(null);
  const [key, setKey] = useState(null);

  const load = async () => {
    try {
      setLoading(true);
      const [w, cfg] = await Promise.all([getWallet(), getWeb3Config()]);
      setWallet(w.wallet);
      setConfig(cfg.params);
      if (w.created) ok('Wallet provisioned — your 100 WELL welcome airdrop is already in it. 🎉');
      else clear();
    } catch (err) {
      fail(err, 'Could not load your wallet.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- intentional initial load on mount */ }, []);

  const revealKey = async () => {
    try {
      setKey(null);
      const res = await exportWalletKey();
      setKey(res);
      ok('Signing key decrypted for this session only — never share it.');
    } catch (err) {
      fail(err, 'Could not export the signing key.');
    }
  };

  if (loading && !wallet) return <Spinner />;

  return (
    <div>
      <Alert alert={alert} onClear={clear} />

      <div className="w3-card accent">
        <div className="w3-row between">
          <div>
            <div className="w3-card-title">🪪 Your Decentralized Identity</div>
            <p className="w3-card-sub">
              One self-owned identity for rewards, records, marketplace and governance.
            </p>
          </div>
          <button className="w3-btn ghost small" onClick={load} disabled={loading}>Refresh</button>
        </div>

        <div className="w3-grid">
          <Stat value={fmtWell(wallet?.balance)} label="Free balance (WELL)" tone="green" />
          <Stat value={fmtWell(wallet?.staked)} label="Staked (WELL)" tone="amber" />
          <Stat value={fmtWell(wallet?.earnedTotal)} label="Total earned" />
          <Stat value={fmtWell(wallet?.spentTotal)} label="Total spent" />
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="w3-label">Decentralized Identifier (DID)</div>
          <CopyChip value={wallet?.did} label={wallet?.did} />
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="w3-label">Wallet address</div>
          <CopyChip value={wallet?.address} label={wallet?.address} />
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="w3-label">Public key (ed25519)</div>
          <div className="w3-mono" style={{ maxHeight: 60, overflow: 'auto' }}>{wallet?.publicKey || '—'}</div>
        </div>
        {wallet?.welcomeBonusAt ? (
          <p className="w3-card-sub" style={{ marginTop: 12, marginBottom: 0 }}>
            Welcome airdrop claimed {fmtTime(wallet.welcomeBonusAt)}.
          </p>
        ) : null}
      </div>

      <div className="w3-card">
        <div className="w3-card-title">🔐 Signing key export</div>
        <p className="w3-card-sub">
          Your private key is stored encrypted (AES-256-GCM) and never leaves the server unencrypted
          except right now, for you. Anyone holding it controls the wallet.
        </p>
        <button className="w3-btn ghost" onClick={revealKey} disabled={loading}>
          Reveal my private key
        </button>
        {key && (
          <div style={{ marginTop: 14 }}>
            <Alert alert={{ kind: 'info', message: key.warning }} />
            <div className="w3-label">Private key (PKCS#8, ed25519)</div>
            <div className="w3-mono" style={{ maxHeight: 90, overflow: 'auto', background: '#f9fafb', padding: 10, borderRadius: 8 }}>
              {key.privateKey}
            </div>
          </div>
        )}
      </div>

      {config && (
        <div className="w3-card">
          <div className="w3-card-title">⚙️ Protocol parameters (DAO-governed)</div>
          <p className="w3-card-sub">
            These numbers are enforced by the smart-contract layer and can only change through a
            passed governance proposal.
          </p>
          <div className="w3-grid">
            {Object.entries(config).map(([k, v]) => (
              <div className="w3-stat" key={k}>
                <div className="w3-stat-value" style={{ fontSize: 18 }}>{String(v)}</div>
                <div className="w3-stat-label">{k}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
