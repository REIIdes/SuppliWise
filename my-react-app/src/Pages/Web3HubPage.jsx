import { useState } from 'react';
import Navbar from '../Components/Navbar/Navbar';
import WalletPanel from '../Components/Web3Panels/WalletPanel';
import RewardsPanel from '../Components/Web3Panels/RewardsPanel';
import LedgerPanel from '../Components/Web3Panels/LedgerPanel';
import PrivacyPanel from '../Components/Web3Panels/PrivacyPanel';
import AiProofPanel from '../Components/Web3Panels/AiProofPanel';
import EcosystemPanel from '../Components/Web3Panels/EcosystemPanel';
import SupplyPanel from '../Components/Web3Panels/SupplyPanel';
import ExplorerPanel from '../Components/Web3Panels/ExplorerPanel';
import { AreaNav, Hero, TabBar } from '../Components/Web3Panels/w3ui';
import './Web3.css';

// Tab shell for the blockchain layer: one route (/web3) hosting every panel.
// Panels take no props and fetch their own data, so each is remounted with a
// fresh `key` on tab switch — the UI always reflects current chain state.
const TABS = [
  { key: 'wallet', icon: '🪪', label: 'Wallet & Identity', Panel: WalletPanel },
  { key: 'rewards', icon: '🏆', label: 'Rewards & NFTs', Panel: RewardsPanel },
  { key: 'ledger', icon: '📒', label: 'Health Ledger', Panel: LedgerPanel },
  { key: 'privacy', icon: '🔒', label: 'Privacy & Data', Panel: PrivacyPanel },
  { key: 'ai', icon: '🤖', label: 'AI Proof', Panel: AiProofPanel },
  { key: 'ecosystem', icon: '🌐', label: 'Trials & Oracles', Panel: EcosystemPanel },
  { key: 'supply', icon: '📦', label: 'Supply Chain', Panel: SupplyPanel },
  { key: 'explorer', icon: '⛏️', label: 'Block Explorer', Panel: ExplorerPanel },
];

function Web3HubPage() {
  const [activeKey, setActiveKey] = useState(TABS[0].key);
  const active = TABS.find((t) => t.key === activeKey) || TABS[0];
  const Panel = active.Panel;

  return (
    <div className="w3-page">
      <Navbar />
      <div className="w3-container">
        <Hero
          variant="emerald"
          mark="⛓️"
          eyebrow="Blockchain layer"
          title="SuppliWise Web3 Hub"
          subtitle="Your self-owned wallet, token rewards, immutable health records, data consent and the proof-of-work ledger behind every action on the platform."
        />

        <AreaNav />

        <TabBar tabs={TABS} active={activeKey} onChange={setActiveKey} label="Web3 sections" />

        {/* Keyed by tab so switching remounts the panel (fresh fetch, no stale state). */}
        <div
          className="w3-tabpanel"
          id="w3-tabpanel"
          role="tabpanel"
          aria-labelledby={`w3tab-${active.key}`}
          tabIndex={-1}
        >
          <div key={active.key}>
            <Panel />
          </div>
        </div>
      </div>
    </div>
  );
}

export default Web3HubPage;
