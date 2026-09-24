import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import {
  getDaoConfig,
  getProposals,
  createProposal,
  voteProposal,
  getKnowledge,
  createKnowledgePost,
  upvoteKnowledge,
} from '../api/web3';
import {
  Spinner,
  Alert,
  Stat,
  CopyChip,
  Empty,
  TabBar,
  fmtWell,
  fmtDay,
  usePanelState,
} from '../Components/Web3Panels/w3ui';
import './Web3.css';

// DAO governance (feature 13) + community knowledge base (feature 14):
// stake-weighted voting on real protocol parameters, and a rewarded,
// on-chain-anchored forum.
const TABS = [
  { key: 'proposals', icon: '🗳️', label: 'Proposals' },
  { key: 'new', icon: '✍️', label: 'New Proposal' },
  { key: 'knowledge', icon: '📚', label: 'Knowledge Base' },
];

const POST_TYPES = [
  ['review', '🧾 Product review'],
  ['research', '🔬 Research finding'],
  ['story', '💬 Success story'],
];

export default function GovernancePage() {
  const { loading, setLoading, alert, ok, fail, clear, info } = usePanelState();
  const [tab, setTab] = useState('proposals');
  const [config, setConfig] = useState(null); // { params, updatable, myWeight, votingDays, quorum }
  const [proposals, setProposals] = useState([]);
  const [myWeight, setMyWeight] = useState(0);
  const [knowledge, setKnowledge] = useState({ posts: [], rewards: null });
  const [busy, setBusy] = useState(false);

  // Proposal form
  const [pForm, setPForm] = useState({ title: '', description: '', param: '', value: '' });

  // Knowledge form
  const [kForm, setKForm] = useState({ type: 'review', title: '', body: '' });

  const load = async () => {
    try {
      setLoading(true);
      const [cfg, props, know] = await Promise.all([
        getDaoConfig(),
        getProposals(),
        getKnowledge(),
      ]);
      setConfig(cfg);
      setProposals(props.proposals || []);
      setMyWeight(props.myWeight ?? cfg.myWeight ?? 0);
      setKnowledge({ posts: know.posts || [], rewards: know.rewards || null });
      clear();
    } catch (err) {
      fail(err, 'Could not load governance data.');
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

  const submitProposal = () =>
    run(
      () => createProposal({
        title: pForm.title.trim(),
        description: pForm.description.trim(),
        param: pForm.param,
        value: pForm.value,
      }),
      (r) => {
        setPForm({ title: '', description: '', param: '', value: '' });
        setTab('proposals');
        ok(`Proposal "${r.proposal.title}" opened — your vote is already cast. Voting weight: ${fmtWell(r.proposal.tally.forWeight)} WELL.`);
      }
    );

  const submitPost = () =>
    run(
      () => createKnowledgePost({
        type: kForm.type,
        title: kForm.title.trim(),
        body: kForm.body.trim(),
      }),
      (r) => {
        setKForm({ type: 'review', title: '', body: '' });
        ok(`Published! +${r.reward} WELL earned for contributing.`);
      }
    );

  if (loading && !config) return <Spinner />;

  const tallyPct = (p) => {
    const total = (p.tally.forWeight || 0) + (p.tally.againstWeight || 0);
    return total > 0 ? Math.round((p.tally.forWeight / total) * 100) : 50;
  };

  return (
    <div className="w3-page">
      <Navbar />
      <div className="w3-container">
        <header className="w3-header">
          <h1 className="w3-title">🏛️ SuppliWise DAO</h1>
          <p className="w3-subtitle">
            Token holders govern the protocol: voting weight equals your WELL balance plus stake,
            and passed proposals change the platform’s actual parameters.
          </p>
        </header>

        <div className="w3-subnav">
          <Link className="w3-btn ghost small" to="/web3">← Web3 Hub</Link>
          <Link className="w3-btn ghost small" to="/marketplace">🛒 Marketplace</Link>
        </div>

        <TabBar
          tabs={TABS}
          active={tab}
          onChange={(key) => { setTab(key); clear(); }}
          label="Governance sections"
        />

        <Alert alert={alert} onClear={clear} />

        <div
          className="w3-tabpanel"
          id="w3-tabpanel"
          role="tabpanel"
          aria-labelledby={`w3tab-${tab}`}
          tabIndex={-1}
        >

        {config && (
          <div className="w3-card accent">
            <div className="w3-grid">
              <Stat value={fmtWell(myWeight)} label="Your voting weight (WELL)" tone="green" />
              <Stat value={`${config.votingDays} days`} label="Voting period" />
              <Stat value={fmtWell(config.quorum)} label="Quorum weight" tone="amber" />
              <Stat value={proposals.filter((p) => p.status === 'active').length} label="Active proposals" />
            </div>
          </div>
        )}

        {/* ── Proposals ──────────────────────────────────────────────── */}
        {tab === 'proposals' && (
          <div>
            {proposals.length === 0 ? (
              <Empty icon="🗳️">No proposals yet — start the first one in the “New Proposal” tab.</Empty>
            ) : (
              proposals.map((p) => (
                <div className="w3-card" key={p._id}>
                  <div className="w3-row between">
                    <div className="w3-card-title" style={{ marginBottom: 0 }}>
                      {p.title}{' '}
                      <span className={`w3-badge ${p.status === 'passed' ? 'green' : p.status === 'rejected' ? 'red' : 'blue'}`}>
                        {p.status}
                      </span>
                      {p.param ? <span className="w3-badge purple" style={{ marginLeft: 6 }}>{p.param} → {String(p.value)}</span> : null}
                    </div>
                    {/* Deadline + turnout as proper meta chips. These were one
                        mono string ending in "2 voter(s)", which read as debug
                        output rather than a deadline. */}
                    <span className="w3-row" style={{ gap: 8 }}>
                      <span className="w3-badge amber">⏳ ends {fmtDay(p.endsAt)}</span>
                      <span className="w3-badge blue">
                        {p.voterCount} voter{p.voterCount === 1 ? '' : 's'}
                      </span>
                    </span>
                  </div>
                  <p className="w3-card-sub" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{p.description}</p>

                  <div className="w3-tally">
                    <div className="w3-tally-for" style={{ width: `${tallyPct(p)}%` }} />
                  </div>
                  <div className="w3-tally-labels">
                    <span style={{ color: '#15803d', fontWeight: 700 }}>
                      For {fmtWell(p.tally.forWeight)}
                    </span>
                    <span className={p.tally.quorumReached ? '' : ''}>
                      quorum {fmtWell(p.tally.quorum)} {p.tally.quorumReached ? '✓' : '—'}
                    </span>
                    <span style={{ color: '#b91c1c', fontWeight: 700 }}>
                      Against {fmtWell(p.tally.againstWeight)}
                    </span>
                  </div>

                  <div className="w3-row" style={{ marginTop: 14 }}>
                    {p.myVote ? (
                      <span className="w3-badge green">
                        You voted “{p.myVote.choice}” with {fmtWell(p.myVote.weight)} WELL
                      </span>
                    ) : p.canVote ? (
                      <>
                        <button
                          className="w3-btn small"
                          disabled={busy}
                          onClick={() => run(
                            () => voteProposal(p._id, 'for'),
                            (r) => ok(`Vote “for” cast with ${fmtWell(r.weight)} WELL — tx ${String(r.txHash).slice(0, 12)}…`)
                          )}
                        >
                          Vote For
                        </button>
                        <button
                          className="w3-btn ghost small"
                          disabled={busy}
                          onClick={() => run(
                            () => voteProposal(p._id, 'against'),
                            (r) => ok(`Vote “against” cast with ${fmtWell(r.weight)} WELL — tx ${String(r.txHash).slice(0, 12)}…`)
                          )}
                        >
                          Vote Against
                        </button>
                      </>
                    ) : (
                      <span className="w3-badge">{p.status === 'active' ? 'Voting closed for you' : 'Voting ended'}</span>
                    )}
                    {p.executedTx ? <CopyChip value={p.executedTx} label="executed ✓" /> : null}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── New proposal ───────────────────────────────────────────── */}
        {tab === 'new' && (
          <div className="w3-card accent">
            <div className="w3-card-title">✍️ Draft a proposal</div>
            <p className="w3-card-sub">
              Pick a protocol parameter to change (or leave it blank for a discussion-only
              proposal). Your own vote is cast automatically on creation — you need a balance or
              a stake to propose.
            </p>
            <div className="w3-field">
              <label className="w3-label" htmlFor="prop-title">Title</label>
              <input
                id="prop-title"
                className="w3-input"
                placeholder="e.g. Raise the daily check-in reward"
                value={pForm.title}
                onChange={(e) => setPForm({ ...pForm, title: e.target.value })}
              />
            </div>
            <div className="w3-field">
              <label className="w3-label" htmlFor="prop-desc">Description</label>
              <textarea
                id="prop-desc"
                className="w3-textarea"
                placeholder="Why this change matters for the protocol… (min 10 chars)"
                value={pForm.description}
                onChange={(e) => setPForm({ ...pForm, description: e.target.value })}
              />
            </div>
            <div className="w3-row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <label className="w3-label" htmlFor="prop-param">Parameter (optional)</label>
                <select
                  id="prop-param"
                  className="w3-select"
                  value={pForm.param}
                  onChange={(e) => setPForm({ ...pForm, param: e.target.value, value: '' })}
                >
                  <option value="">— Discussion only —</option>
                  {(config?.updatable || []).map((k) => (
                    <option key={k} value={k}>
                      {k} (current: {String(config?.params?.[k])})
                    </option>
                  ))}
                </select>
              </div>
              {pForm.param && (
                <div style={{ minWidth: 180 }}>
                  <label className="w3-label" htmlFor="prop-value">New value</label>
                  <input
                    id="prop-value"
                    className="w3-input"
                    placeholder={String(config?.params?.[pForm.param] ?? '')}
                    value={pForm.value}
                    onChange={(e) => setPForm({ ...pForm, value: e.target.value })}
                  />
                </div>
              )}
              <button
                className="w3-btn"
                disabled={busy || pForm.title.trim().length < 6 || pForm.description.trim().length < 10 || (!!pForm.param && String(pForm.value).trim() === '')}
                onClick={submitProposal}
              >
                Open proposal
              </button>
            </div>
          </div>
        )}

        {/* ── Knowledge base ─────────────────────────────────────────── */}
        {tab === 'knowledge' && (
          <div>
            <div className="w3-card accent">
              <div className="w3-card-title">✍️ Share with the community</div>
              <p className="w3-card-sub">
                Posts are anchored on-chain and rewarded:
                {knowledge.rewards ? (
                  <> +{knowledge.rewards.post} WELL per post, +{knowledge.rewards.upvote} WELL to the
                  author per upvote (capped), +{knowledge.rewards.curator} WELL to curators.</>
                ) : (
                  ' earn WELL for useful contributions.'
                )}
              </p>
              <div className="w3-row" style={{ alignItems: 'flex-end' }}>
                <div style={{ minWidth: 200 }}>
                  <label className="w3-label" htmlFor="kb-type">Type</label>
                  <select
                    id="kb-type"
                    className="w3-select"
                    value={kForm.type}
                    onChange={(e) => setKForm({ ...kForm, type: e.target.value })}
                  >
                    {POST_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <label className="w3-label" htmlFor="kb-title">Title</label>
                  <input
                    id="kb-title"
                    className="w3-input"
                    placeholder="Min 6 characters"
                    value={kForm.title}
                    onChange={(e) => setKForm({ ...kForm, title: e.target.value })}
                  />
                </div>
              </div>
              <textarea
                className="w3-textarea"
                style={{ marginTop: 14 }}
                placeholder="Share the details… (min 20 characters)"
                value={kForm.body}
                onChange={(e) => setKForm({ ...kForm, body: e.target.value })}
                aria-label="Post body"
              />
              <button
                className="w3-btn"
                style={{ marginTop: 14 }}
                disabled={busy || kForm.title.trim().length < 6 || kForm.body.trim().length < 20}
                onClick={submitPost}
              >
                Publish (+{knowledge.rewards?.post ?? '…'} WELL)
              </button>
            </div>

            {knowledge.posts.length === 0 ? (
              <Empty icon="📚">No posts yet — be the first contributor.</Empty>
            ) : (
              knowledge.posts.map((p) => (
                <div className="w3-card" key={p._id}>
                  <div className="w3-row between">
                    <div className="w3-card-title" style={{ marginBottom: 0 }}>
                      {p.title}{' '}
                      <span className="w3-badge blue">
                        {POST_TYPES.find(([k]) => k === p.type)?.[1] || p.type}
                      </span>
                      {p.mine ? <span className="w3-badge green" style={{ marginLeft: 6 }}>Yours</span> : null}
                    </div>
                    <span className="w3-mono" style={{ fontSize: 12 }}>{fmtDay(p.createdAt)}</span>
                  </div>
                  <p className="w3-card-sub" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{p.body}</p>
                  <div className="w3-row between">
                    <span className="w3-row" style={{ gap: 8 }}>
                      <span className="w3-badge amber">▲ {p.upvotes || 0} upvotes</span>
                      {p.txHash ? <CopyChip value={p.txHash} label="anchored" /> : null}
                      <span className="w3-mono" style={{ fontSize: 12 }}>{p.authorAddress}</span>
                    </span>
                    {p.canUpvote && (
                      <button
                        className="w3-btn ghost small"
                        disabled={busy}
                        onClick={() => run(
                          () => upvoteKnowledge(p._id),
                          (r) => { info(`Upvoted — you earned ${r.curatorPayout} WELL${r.authorPayout ? `, author +${r.authorPayout}` : ''}.`); }
                        )}
                      >
                        ▲ Upvote
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
