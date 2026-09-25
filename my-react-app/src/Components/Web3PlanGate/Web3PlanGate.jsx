import { useNavigate } from 'react-router-dom';
import Navbar from '../Navbar/Navbar';
import PlanLockedCard from '../PlanLockedCard/PlanLockedCard';
import useSubscription from '../../hooks/useSubscription';
// Web3.css is REQUIRED here, not optional: the locked screen reuses .w3-page,
// .w3-container and .w3-btn, and all three are defined in that file. Without
// this import the shell and the two buttons render completely unstyled.
import '../../Pages/Web3.css';
import './Web3PlanGate.css';

/**
 * DELUXE gate for the blockchain layer (/web3, /marketplace, /governance).
 *
 * These three routes are one feature area split across three screens, so the
 * gate lives here rather than being repeated in each page. The locked branch
 * renders INSTEAD of the page, which matters: the panels fetch on mount, so
 * rendering the page and covering it would still fire the requests.
 *
 * The backend is the real enforcement — each sub-router applies
 * requireFeature() at the router level (routes/web3/guards.js), re-checked on
 * every request. This exists so a FREE user gets an explanation instead of a
 * page of failed fetches, and so the plan change is reflected the moment the
 * subscription store updates.
 */
const GATES = {
  web3: {
    feature: 'web3',
    featureLabel: 'Web3 Wallet & Supply Chain',
    blurb:
      'Your self-owned wallet, token rewards, immutable health records and the proof-of-work ledger behind every action on the platform.',
    benefits: [
      'Self-custodied wallet & decentralized ID',
      'Immutable supply-chain provenance',
      'Rewards, NFTs and staking with WELL tokens',
      'Portable, AI-anchored health credentials',
    ],
  },
  market: {
    feature: 'market',
    featureLabel: 'Marketplace',
    blurb:
      'Buy and sell supplements with WELL tokens, with escrow holding funds until delivery is confirmed.',
    benefits: [
      'Peer-to-peer supplement trading',
      'Escrow protection on every order',
      'Dispute resolution with DAO jury',
      'On-chain order history',
    ],
  },
  dao: {
    feature: 'dao',
    featureLabel: 'DAO Governance',
    blurb:
      'Propose and vote on the platform rules themselves, and follow where the treasury is spent.',
    benefits: [
      'Submit and vote on proposals',
      'Parameter changes applied on-chain',
      'Transparent treasury oversight',
      'Curated knowledge base',
    ],
  },
};

export default function Web3PlanGate({ area, children }) {
  const navigate = useNavigate();
  const { canAccess, plan } = useSubscription();
  const gate = GATES[area];

  // Unknown area: render normally rather than locking a screen by typo.
  if (!gate) return children;
  if (canAccess(gate.feature)) return children;

  return (
    <div className="w3-page">
      <Navbar />
      <div className="w3-container">
        <PlanLockedCard
          featureLabel={gate.featureLabel}
          requiresPlan="monthly"
          currentPlan={plan}
          benefits={gate.benefits}
          onViewPlans={() => navigate('/profile')}
          onBack={() => navigate('/dashboard')}
          footnote="The blockchain layer is part of the DELUXE plan. Contact an administrator to upgrade and unlock it instantly."
        />
        <p className="w3gate-note">{gate.blurb}</p>
        <div className="w3gate-actions">
          <button type="button" className="w3-btn ghost" onClick={() => navigate('/dashboard')}>
            ← Back to Dashboard
          </button>
          <button type="button" className="w3-btn" onClick={() => navigate('/profile')}>
            View my plan
          </button>
        </div>
      </div>
    </div>
  );
}
