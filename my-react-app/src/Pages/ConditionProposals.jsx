import { useCallback, useEffect, useMemo, useState } from 'react';
import { BASE_URL, parseJSON } from '../api';
import { formatShortDate } from '../utils/dates';
import './ConditionProposals.css';

/*
 * AI learning log — read-only.
 *
 * The gap analysis reads real assessments, drafts condition candidates, and
 * the clinical evidence gate decides each one AUTONOMOUSLY: a candidate
 * publishes itself into the live questionnaire only when every supplement it
 * proposes cites an authoritative health-professional source, and nothing
 * inside the prescription/danger blocklist survives review. No admin click
 * ships or blocks anything — this page exists to show WHY each verdict
 * happened: every row carries the gate's reasoning verbatim and the exact
 * citations it accepted or missed. There is deliberately no decision form.
 */

const STATUS_LABEL = {
  pending: 'Awaiting a gated re-run',
  approved: 'Auto-approved by the evidence gate',
  rejected: 'Auto-rejected by the evidence gate',
};

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}/proposals${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem('adminToken')}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(data?.message || 'Request failed.');
  return data;
}

function StatusChip({ status }) {
  return <span className={`cp-chip cp-chip--${status}`}>{STATUS_LABEL[status] || status}</span>;
}

function ProposalCard({ proposal }) {
  return (
    <article className="cp-card" aria-label={`AI learning entry: ${proposal.name}`}>
      <header className="cp-card__head">
        <div>
          <h3>{proposal.name}</h3>
          <div className="cp-tags">
            {proposal.group && <span className="cp-chip cp-chip--group">{proposal.group}</span>}
            <StatusChip status={proposal.status} />
            {proposal.publishedStatus === 'live' && (
              <span className="cp-chip cp-chip--live" title="The gate accepted this bundle — it is now offered in the live assessment and consumed by both recommendation engines.">
                Published in the live questionnaire
              </span>
            )}
            {proposal.liveNow && proposal.publishedStatus !== 'live' && (
              <span className="cp-chip cp-chip--live">Already in the built-in registry</span>
            )}
          </div>
        </div>
        <div className="cp-count" title="Assessment records citing this candidate">
          <strong>{proposal.supportingCount}</strong>
          <span>supporting {proposal.supportingCount === 1 ? 'report' : 'reports'}</span>
        </div>
      </header>

      <dl className="cp-evidence">
        <div><dt>Why the AI suggests it</dt><dd>{proposal.rationale || '—'}</dd></div>
        <div><dt>Supplement-safety impact</dt><dd>{proposal.safetyImpact || '—'}</dd></div>
        {proposal.covers?.length > 0 && (
          <div>
            <dt>Covers reported symptoms / hints</dt>
            <dd className="cp-covers">{proposal.covers.map((c) => <span key={c} className="cp-covers__tag">{c}</span>)}</dd>
          </div>
        )}
        <div>
          <dt>Evidence source</dt>
          <dd>
            {proposal.source?.script || 'conditionGapAnalysis'}
            {proposal.source?.runAt ? ` · run ${formatShortDate(proposal.source.runAt)}` : ''}
            {proposal.source?.assessmentsScanned ? ` · ${proposal.source.assessmentsScanned} assessments scanned` : ''}
          </dd>
        </div>
      </dl>

      {proposal.verdicts?.length > 0 ? (
        <ul className="cp-verdicts">
          {proposal.verdicts.map((v, i) => (
            <li key={`${v.at}-${i}`}>
              <span className={`cp-verdict cp-verdict--${v.decision}`}>{v.decision === 'approve' ? 'Accepted' : 'Refused'}</span>
              <strong>{v.reviewerAlias || 'Evidence Gate (automated)'}</strong>
              {v.discipline && <em>{v.discipline}</em>}
              <span className="cp-verdict__when">{v.at ? formatShortDate(v.at) : ''}</span>
              <p>{v.comment}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="cp-decided-note">
          Queued before the evidence gate existed — the next gated run publishes or refuses it automatically
          with the citations it accepted or missed recorded here.
        </p>
      )}
    </article>
  );
}

const ConditionProposals = () => {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    try {
      const json = await request('');
      setData(json);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // loading starts true on mount, so only the click flips it — inside load() that write would be synchronous in the effect.
  const reload = useCallback(() => {
    setLoading(true);
    load();
  }, [load]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load is async: every write lands after request('') settles
  useEffect(() => { load(); }, [load]);

  const proposals = useMemo(() => {
    const all = data?.proposals || [];
    return filter === 'all' ? all : all.filter((p) => p.status === filter);
  }, [data, filter]);

  const counts = data?.counts || { pending: 0, approved: 0, rejected: 0 };

  return (
    <section className="cp" aria-label="AI learning log">
      <header className="cp-head">
        <div>
          <h2>AI learning log</h2>
          <p className="cp-head__rule">
            The gap analysis reads real assessments and drafts new condition knowledge, then the{' '}
            <strong>clinical evidence gate</strong> (<code>{data?.governedBy || 'automated'}</code>) decides
            autonomously: a candidate publishes itself into the live questionnaire only when every supplement
            it proposes cites an authoritative health-professional source — otherwise it is refused, with the
            missing proof recorded verbatim. This log is read-only by design: the gate is the decider, not a
            button here.
          </p>
        </div>
        <button type="button" className="cp-btn cp-btn--ghost" onClick={reload} disabled={loading}>
          {loading ? 'Reloading…' : 'Reload'}
        </button>
      </header>

      <div className="cp-filters" role="tablist" aria-label="Filter learning log entries by gate outcome">
        {[['all', data ? data.proposals.length : 0], ['approved', counts.approved], ['rejected', counts.rejected], ['pending', counts.pending]].map(([key, n]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            className={filter === key ? 'cp-filter cp-filter--on' : 'cp-filter'}
            onClick={() => setFilter(key)}
          >
            {key === 'all' ? 'All entries' : STATUS_LABEL[key]} <strong>{n}</strong>
          </button>
        ))}
      </div>

      {loadError && <p className="cp-error" role="alert">{loadError}</p>}

      {!loadError && loading && !data && <p className="cp-empty">Loading the learning log…</p>}
      {!loadError && data && proposals.length === 0 && (
        <p className="cp-empty">
          {filter === 'pending'
            ? 'Nothing awaits a gated re-run.'
            : `No ${filter} entries yet — run the condition-gap analysis to let the AI learn and decide.`}
        </p>
      )}

      <div className="cp-list">
        {proposals.map((p) => (
          <ProposalCard key={p._id} proposal={p} />
        ))}
      </div>
    </section>
  );
};

export default ConditionProposals;
