import { useEffect, useState } from 'react';
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
  Hero,
  AreaNav,
  TabBar,
  fmtWell,
  fmtDay,
  timeLeft,
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

// One vocabulary for proposal state, used by the card rail, the badge and the
// vote affordances. Previously the same three states were spelled out inline
// in three different nested ternaries, which is how "passed" ended up red on
// one screen and green on another.
const STATUS = {
  active: { label: 'Open for voting', badge: 'blue' },
  passed: { label: 'Passed', badge: 'green' },
  rejected: { label: 'Rejected', badge: 'red' },
  executed: { label: 'Executed', badge: 'purple' },
};

const statusOf = (p) => STATUS[p.status] || { label: p.status || 'Unknown', badge: '' };

// Share of the cast weight that voted in favour. A proposal with no votes yet
// reads as an even bar rather than a full green one, which used to imply
// unanimous support before anyone had voted.
const forShare = (p) => {
  const forW = p.tally.forWeight || 0;
  const againstW = p.tally.againstWeight || 0;
  const total = forW + againstW;
  return total > 0 ? Math.round((forW / total) * 100) : 0;
};

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

  // The Navbar is kept while the first load is in flight. Returning a bare
  // spinner replaced the whole page, so the bar blinked out and back in on
  // every cold start of the route.
  if (loading && !config) {
    return (
      <div className="w3-page">
        <Navbar />
        <div className="w3-container">
          <Spinner />
        </div>
      </div>
    );
  }

  const activeCount = proposals.filter((p) => p.status === 'active').length;
  const canPropose = myWeight > 0;
  const proposalReady =
    pForm.title.trim().length >= 6 &&
    pForm.description.trim().length >= 10 &&
    (!pForm.param || String(pForm.value).trim() !== '');

  return (
    <div className="w3-page">
      <Navbar />
      <div className="w3-container">
        <Hero
          variant="violet"
          mark="🏛️"
          eyebrow="On-chain governance"
          title="SuppliWise DAO"
          subtitle="Token holders govern the protocol: voting weight equals your WELL balance plus stake, and passed proposals change the platform’s actual parameters."
        />

        <AreaNav />

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
            <div className="w3-card-head">
              <div>
                <div className="w3-card-title">🗳️ Governance at a glance</div>
                <p className="w3-card-sub">
                  Weight is your free WELL balance plus anything you have staked — one number,
                  applied to every vote.
                </p>
              </div>
              <span className="w3-badge purple">settled on-chain</span>
            </div>
            <div className="w3-grid">
              <Stat
                icon="⚖️"
                tone="green"
                value={fmtWell(myWeight)}
                unit="WELL"
                label="Your voting weight"
                hint={canPropose ? 'You can propose and vote' : 'Stake WELL to take part'}
              />
              <Stat
                icon="⏳"
                tone="amber"
                value={config.votingDays}
                unit="days"
                label="Voting period"
              />
              <Stat
                icon="🎯"
                tone="violet"
                value={fmtWell(config.quorum)}
                unit="WELL"
                label="Quorum weight"
              />
              <Stat
                icon="📌"
                tone="sky"
                value={activeCount}
                label="Active proposals"
              />
            </div>
          </div>
        )}

        {/* ── Proposals ──────────────────────────────────────────────── */}
        {tab === 'proposals' && (
          <div>
            {proposals.length === 0 ? (
              <Empty
                icon="🗳️"
                title="No proposals yet"
                action={
                  <button className="w3-btn" onClick={() => setTab('new')}>
                    ✍️ Draft the first proposal
                  </button>
                }
              >
                Every parameter on this platform is DAO-governed. Open the first proposal and set
                the rules yourself.
              </Empty>
            ) : (
              proposals.map((p) => {
                const status = statusOf(p);
                const share = forShare(p);
                const closed = p.status !== 'active';
                return (
                  <article className={`w3-card w3-proposal status-${p.status || 'active'}`} key={p._id}>
                    <div className="w3-card-head">
                      <div>
                        <h3 className="w3-card-title">
                          {p.title}
                          <span className={`w3-badge ${status.badge}`}>{status.label}</span>
                        </h3>
                        <p className="w3-card-sub" style={{ whiteSpace: 'pre-wrap' }}>
                          {p.description}
                        </p>
                      </div>
                      {/* Deadline and turnout as separate meta chips — they used
                          to be one mono string ending in "2 voter(s)", which read
                          as debug output rather than a deadline. */}
                      <div className="w3-row" style={{ gap: 8 }}>
                        <span className={`w3-badge ${closed ? '' : 'amber'}`}>
                          ⏳ {closed ? fmtDay(p.endsAt) : timeLeft(p.endsAt)}
                        </span>
                        <span className="w3-badge blue">
                          {p.voterCount} voter{p.voterCount === 1 ? '' : 's'}
                        </span>
                      </div>
                    </div>

                    {p.param && (
                      <div className="w3-param">
                        <span>Rewrites</span>
                        <b>{p.param}</b>
                        <i>→</i>
                        <b>{String(p.value)}</b>
                      </div>
                    )}

                    <div
                      className="w3-vote-bar"
                      role="img"
                      aria-label={`${share}% of cast weight voted in favour`}
                    >
                      <div className="w3-vote-for" style={{ width: `${share}%` }} />
                    </div>
                    <div className="w3-vote-legend">
                      <span className="for">▲ For · {fmtWell(p.tally.forWeight)}</span>
                      <span className={`quorum ${p.tally.quorumReached ? 'met' : ''}`}>
                        Quorum {fmtWell(p.tally.quorum)} {p.tally.quorumReached ? '✓ reached' : '— not met'}
                      </span>
                      <span className="against">▼ Against · {fmtWell(p.tally.againstWeight)}</span>
                    </div>

                    <div className="w3-row" style={{ marginTop: 16 }}>
                      {p.myVote ? (
                        <span className="w3-badge green">
                          ✓ You voted “{p.myVote.choice}” with {fmtWell(p.myVote.weight)} WELL
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
                            👍 Vote For
                          </button>
                          <button
                            className="w3-btn ghost small"
                            disabled={busy}
                            onClick={() => run(
                              () => voteProposal(p._id, 'against'),
                              (r) => ok(`Vote “against” cast with ${fmtWell(r.weight)} WELL — tx ${String(r.txHash).slice(0, 12)}…`)
                            )}
                          >
                            👎 Vote Against
                          </button>
                        </>
                      ) : (
                        <span className="w3-badge">
                          {closed ? 'Voting ended' : 'Voting closed for you'}
                        </span>
                      )}
                      {p.executedTx ? <CopyChip value={p.executedTx} label="executed on-chain ✓" /> : null}
                    </div>
                  </article>
                );
              })
            )}
          </div>
        )}

        {/* ── New proposal ───────────────────────────────────────────── */}
        {tab === 'new' && (
          <div className="w3-card accent">
            <div className="w3-card-head">
              <div>
                <div className="w3-card-title">✍️ Draft a proposal</div>
                <p className="w3-card-sub">
                  Pick a protocol parameter to change, or leave it blank for a discussion-only
                  proposal. Your own vote is cast automatically on creation — you need a balance or
                  a stake to propose.
                </p>
              </div>
              <span className={`w3-badge ${canPropose ? 'green' : 'red'}`}>
                {canPropose ? '✓ eligible to propose' : '⚠ needs WELL to propose'}
              </span>
            </div>

            <div className="w3-field">
              <label className="w3-label" htmlFor="prop-title">Title</label>
              <input
                id="prop-title"
                className="w3-input"
                placeholder="e.g. Raise the daily check-in reward"
                value={pForm.title}
                onChange={(e) => setPForm({ ...pForm, title: e.target.value })}
              />
              <p className="w3-hint">At least 6 characters.</p>
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
              <p className="w3-hint">At least 10 characters. Say what changes and who it helps.</p>
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
                disabled={busy || !proposalReady}
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
              <div className="w3-card-head">
                <div>
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
                </div>
              </div>
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
              <div className="w3-field" style={{ marginTop: 14, marginBottom: 0 }}>
                <label className="w3-label" htmlFor="kb-body">Details</label>
                <textarea
                  id="kb-body"
                  className="w3-textarea"
                  placeholder="Share the details… (min 20 characters)"
                  value={kForm.body}
                  onChange={(e) => setKForm({ ...kForm, body: e.target.value })}
                />
              </div>
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
              <Empty icon="📚" title="No posts yet">
                Be the first contributor — reviews, research and success stories all earn WELL.
              </Empty>
            ) : (
              knowledge.posts.map((p) => (
                <article className="w3-card" key={p._id}>
                  <div className="w3-card-head">
                    <div>
                      <h3 className="w3-card-title">
                        {p.title}
                        <span className="w3-badge blue">
                          {POST_TYPES.find(([k]) => k === p.type)?.[1] || p.type}
                        </span>
                        {p.mine ? <span className="w3-badge green">Yours</span> : null}
                      </h3>
                      <p className="w3-card-sub" style={{ whiteSpace: 'pre-wrap' }}>{p.body}</p>
                    </div>
                    <span className="w3-mono" style={{ fontSize: 12 }}>{fmtDay(p.createdAt)}</span>
                  </div>
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
                </article>
              ))
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
