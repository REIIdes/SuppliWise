import { useCallback, useEffect, useMemo, useState } from 'react';
import { BASE_URL, parseJSON } from '../api';
import { formatShortDate } from '../utils/dates';
import './ConditionProposals.css';

/*
 * AI condition-proposal ratification queue.
 *
 * The gap analysis proposes medical conditions from real assessment data; it
 * cannot ship any of them. A condition only moves from `pending` to live when
 * a health professional — signed in here as an admin, the same identity the
 * instrument panel uses — records a verdict, and the server refuses a verdict
 * without a written comment. There is deliberately no "create", "edit" or
 * "approve all" affordance: the queue is the ratification step, not a form.
 */

const DISCIPLINES = ['clinician', 'dietitian', 'statistician', 'public-health'];

const STATUS_LABEL = { pending: 'Pending ratification', approved: 'Approved', rejected: 'Rejected' };

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

function ProposalCard({ proposal, busy, onDecide, error }) {
  const [comment, setComment] = useState('');
  const [discipline, setDiscipline] = useState('');
  const canDecide = proposal.status === 'pending';
  const trimmed = comment.trim();

  const submit = (decision) => {
    if (!trimmed || busy) return;
    onDecide(proposal._id, { decision, comment: trimmed, discipline });
  };

  return (
    <article className="cp-card" aria-label={`Proposal: ${proposal.name}`}>
      <header className="cp-card__head">
        <div>
          <h3>{proposal.name}</h3>
          <div className="cp-tags">
            {proposal.group && <span className="cp-chip cp-chip--group">{proposal.group}</span>}
            <StatusChip status={proposal.status} />
            {proposal.alreadyLive && (
              <span className="cp-chip cp-chip--live" title="An earlier human review shipped this option before the queue existed. Ratify or retire it.">
                Shipped in 2026-10 audit — ratify or retire
              </span>
            )}
            {!proposal.alreadyLive && proposal.liveNow && (
              <span className="cp-chip cp-chip--live">Already in the live registry</span>
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

      {proposal.verdicts?.length > 0 && (
        <ul className="cp-verdicts">
          {proposal.verdicts.map((v, i) => (
            <li key={`${v.at}-${i}`}>
              <span className={`cp-verdict cp-verdict--${v.decision}`}>{v.decision === 'approve' ? 'Approved' : 'Rejected'}</span>
              <strong>{v.reviewerAlias || 'Panelist'}</strong>
              {v.discipline && <em>{v.discipline}</em>}
              <span className="cp-verdict__when">{v.at ? formatShortDate(v.at) : ''}</span>
              <p>{v.comment}</p>
            </li>
          ))}
        </ul>
      )}

      {canDecide ? (
        <div className="cp-decision">
          <label className="cp-decision__discipline">
            Your discipline (optional)
            <select value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
              <option value="">—</option>
              {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="cp-decision__comment">
            Written rationale — required for every verdict
            <textarea
              rows={2}
              maxLength={2000}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="e.g. Clinically common in PH cohorts; add with myalgia symptom scoping and an interactions review."
            />
          </label>
          <div className="cp-decision__actions">
            <button type="button" className="cp-btn cp-btn--approve" disabled={!trimmed || busy} onClick={() => submit('approve')}>
              {busy === 'approve' ? 'Recording…' : 'Approve'}
            </button>
            <button type="button" className="cp-btn cp-btn--reject" disabled={!trimmed || busy} onClick={() => submit('reject')}>
              {busy === 'reject' ? 'Recording…' : 'Reject'}
            </button>
          </div>
          {error && <p className="cp-decision__error" role="alert">{error}</p>}
        </div>
      ) : (
        <p className="cp-decided-note">
          Ratified {proposal.verdicts?.length ? `in ${proposal.verdicts.length} recorded verdict${proposal.verdicts.length === 1 ? '' : 's'}` : ''} — a further panel verdict can still revise this decision through the API.
        </p>
      )}
    </article>
  );
}

const ConditionProposals = () => {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending');
  const [busy, setBusy] = useState(null); // { id, decision }
  const [decisionError, setDecisionError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
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

  useEffect(() => { load(); }, [load]);

  const decide = useCallback(async (id, { decision, comment, discipline }) => {
    setBusy({ id, decision });
    setDecisionError('');
    try {
      await request(`/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, comment, ...(discipline ? { discipline } : {}) }),
      });
      await load();
    } catch (err) {
      setDecisionError(err.message);
    } finally {
      setBusy(null);
    }
  }, [load]);

  const proposals = useMemo(() => {
    const all = data?.proposals || [];
    return filter === 'all' ? all : all.filter((p) => p.status === filter);
  }, [data, filter]);

  const counts = data?.counts || { pending: 0, approved: 0, rejected: 0 };

  return (
    <section className="cp" aria-label="AI condition proposal queue">
      <header className="cp-head">
        <div>
          <h2>AI condition proposals</h2>
          <p className="cp-head__rule">
            The gap analysis reads real assessments and <strong>proposes</strong> new medical-condition options.
            Nothing ships without your written verdict — approve or reject requires a rationale, and every
            verdict is stored in an audit trail attributed to your admin identity.
          </p>
        </div>
        <button type="button" className="cp-btn cp-btn--ghost" onClick={load} disabled={loading}>
          {loading ? 'Reloading…' : 'Reload'}
        </button>
      </header>

      <div className="cp-filters" role="tablist" aria-label="Filter proposals by status">
        {[['pending', counts.pending], ['approved', counts.approved], ['rejected', counts.rejected], ['all', data ? data.proposals.length : 0]].map(([key, n]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            className={filter === key ? 'cp-filter cp-filter--on' : 'cp-filter'}
            onClick={() => setFilter(key)}
          >
            {STATUS_LABEL[key] || 'All proposals'} <strong>{n}</strong>
          </button>
        ))}
      </div>

      {loadError && <p className="cp-error" role="alert">{loadError}</p>}

      {!loadError && loading && !data && <p className="cp-empty">Loading the queue…</p>}
      {!loadError && data && proposals.length === 0 && (
        <p className="cp-empty">
          {filter === 'pending'
            ? 'Nothing awaits ratification. Run the condition-gap analysis to queue new candidates.'
            : `No ${filter} proposals yet.`}
        </p>
      )}

      <div className="cp-list">
        {proposals.map((p) => (
          <ProposalCard
            key={p._id}
            proposal={p}
            busy={busy?.id === p._id ? busy.decision : null}
            onDecide={decide}
            error={busy?.id === p._id ? decisionError : ''}
          />
        ))}
      </div>
    </section>
  );
};

export default ConditionProposals;
