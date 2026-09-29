import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// This queue reuses the upgrade queue's stylesheet on purpose: same rows, same
// badges, same confirm shape. A second near-identical copy of that CSS is how
// the two queues slowly stop looking the same, which is the opposite of what a
// reviewer needs. Only the switcher and the cancellation-specific status colours
// are added, and those live at the end of the shared file.
import '../AdminSubscriptionRequests/AdminSubscriptionRequests.css';

/**
 * The admin side of subscription CANCELLATIONS.
 *
 * A member who wants out can either end the plan themselves (their own call, no
 * admin involved — that path leaves an `applied` audit row and never reaches
 * this queue) or ask an administrator to do it. THIS is the second queue: rows a
 * member is waiting on, where pressing Approve is the only thing that changes
 * their subscription.
 *
 * WHY A SEPARATE COMPONENT RATHER THAN A TAB INSIDE AdminSubscriptionRequests
 * -------------------------------------------------------------------------
 * The two queues share a shape but not a single decision. An upgrade carries
 * money, a proof image and a term, and approving it GRANTS a plan. A
 * cancellation carries a reason, and approving it REMOVES one. Folding the
 * second into the first would mean every row, every badge and every confirm
 * dialog had to branch on which kind it was — and a confirm dialog that forgets
 * to branch is how an administrator cancels someone's plan while meaning to
 * approve a purchase. Two components, one admin tab, one switcher.
 *
 * Exactly-once is enforced SERVER-side by an atomic claim before any
 * entitlement is written, so two administrators pressing Approve on the same
 * row produce one cancellation. This component's disabled-while-busy is UI
 * politiness; the 409 it gets back is the rule.
 */

const FILTERS = [
  { id: 'pending', label: 'Pending', tone: 'pending', hint: 'Waiting on a decision', icon: 'clock' },
  { id: 'applied', label: 'Applied', tone: 'ok', hint: 'Plan already ended', icon: 'check' },
  { id: 'rejected', label: 'Declined', tone: 'down', hint: 'They kept their plan', icon: 'x' },
  { id: 'all', label: 'All', tone: 'all', hint: 'Everything on record', icon: 'layers' },
];

/** What each status means here, in the reviewer's words. */
const STATUS_COPY = {
  pending: 'Waiting for review',
  applied: 'Plan ended',
  rejected: 'Declined',
};

const MODE_COPY = {
  review: 'Member asked for this',
  immediate: 'Member ended it themselves',
};

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #f97316 0%, #e11d48 100%)',
  'linear-gradient(135deg, #4f6bed 0%, #7c3aed 100%)',
  'linear-gradient(135deg, #10b981 0%, #0d9488 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #d946ef 100%)',
  'linear-gradient(135deg, #f43f5e 0%, #f59e0b 100%)',
  'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
];

/** The same per-member hue the plan-request queue uses, so a face keeps its colour. */
function avatarStyle(user) {
  const seed = String(user?._id || user?.email || user?.firstName || 'x');
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 100000;
  return { backgroundImage: AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length] };
}

const ICONS = {
  clock: <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  x: <><circle cx="12" cy="12" r="9" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>,
  layers: <><polygon points="12 2.5 22 7.5 12 12.5 2 7.5" /><polyline points="2 16.5 12 21.5 22 16.5" /><polyline points="2 12 12 17 22 12" /></>,
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>,
};

function StatIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

function formatStamp(value) {
  if (!value) return '';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatInitials(user) {
  const first = String(user?.firstName || '').trim();
  const last = String(user?.lastName || '').trim();
  const text = `${first} ${last}`.trim();
  if (!text) return '?';
  // A single-letter name, or a surname with no first name, must not index past
  // the end of the string — `first[1]` on "A" is undefined and would render "A?".
  if (text.length === 1) return text.toUpperCase();
  return (first[0] + (last[0] || first[1] || '')).toUpperCase();
}

function relativeTime(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatStamp(value);
}

export default function AdminSubscriptionCancels({ request }) {
  const [status, setStatus] = useState('pending');
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ pending: 0, applied: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openId, setOpenId] = useState(null);
  const [reviewNote, setReviewNote] = useState('');
  const [busyId, setBusyId] = useState(null);
  // The row an administrator is about to act on, held until they confirm — a
  // cancellation is irreversible, so it never happens on the first click.
  const [confirm, setConfirm] = useState(null);

  const noticeTimer = useRef(null);
  const loadToken = useRef(0);

  const showNotice = useCallback((message) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 6000);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    loadToken.current += 1;
  }, []);

  // ── Load the queue ──────────────────────────────────────────────────────
  // Same deliberate-load contract as the upgrade queue (see the comment there):
  // these reads must count as activity, because an administrator reviewing
  // cancellations is unambiguously still present.
  const load = useCallback(async (nextStatus, nextSearch) => {
    const token = ++loadToken.current;
    // NO setState before the first await — see the upgrade queue's `load` for
    // why a synchronous setState here can spin the dashboard.
    try {
      const params = new URLSearchParams({ status: nextStatus, limit: '25' });
      if (nextSearch) params.set('search', nextSearch);
      const data = await request(`/subscription-cancel-requests?${params.toString()}`);
      if (token !== loadToken.current) return;
      setError('');
      setRows(Array.isArray(data.requests) ? data.requests : []);
      setCounts(data.counts || { pending: 0, applied: 0, rejected: 0 });
      setLoaded(true);
    } catch (loadError) {
      if (token !== loadToken.current) return;
      setError(loadError.message);
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, [request]);

  // `load` is read through a ref so this effect depends only on the things that
  // are MEANT to trigger a reload, not on a possibly-unmemoized parent prop.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => { loadRef.current(status, activeSearch); }, [status, activeSearch]);

  // Debounce the search so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setActiveSearch((current) => (search.trim() === current ? current : search.trim()));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  // ── Approve / decline ───────────────────────────────────────────────────
  const run = useCallback(async (row, action) => {
    if (busyId) return;
    setBusyId(row._id);
    setError('');
    try {
      const data = await request(`/subscription-cancel-requests/${row._id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ note: reviewNote }),
      });
      showNotice(data?.message || (action === 'approve' ? 'Cancellation applied.' : 'Cancellation declined.'));
      setConfirm(null);
      setOpenId(null);
      setReviewNote('');
      await loadRef.current(status, activeSearch);
    } catch (actionError) {
      // A 409 means another reviewer got there first. That is not a failure of
      // this screen — reload so the row shows what actually happened.
      if (actionError?.status === 409) {
        showNotice(actionError.message || 'Another administrator reviewed this a moment ago.');
        setConfirm(null);
        await loadRef.current(status, activeSearch);
      } else {
        setError(actionError.message);
      }
    } finally {
      setBusyId(null);
    }
  }, [busyId, request, reviewNote, status, activeSearch, showNotice]);

  const filterCounts = useMemo(() => ({
    pending: counts.pending || 0,
    applied: counts.applied || 0,
    rejected: counts.rejected || 0,
    all: (counts.pending || 0) + (counts.applied || 0) + (counts.rejected || 0),
  }), [counts]);

  const pendingTotal = counts.pending || 0;

  return (
    <div className="asr">
      {/* Stat cards are the filters, exactly as in the plan-request queue. */}
      <div className="asr-stats" role="group" aria-label="Filter cancellations by status">
        {FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={`asr-stat asr-stat--${filter.tone}${status === filter.id ? ' asr-stat--on' : ''}`}
            aria-pressed={status === filter.id}
            onClick={() => setStatus(filter.id)}
          >
            <span className="asr-stat__icon" aria-hidden="true"><StatIcon name={filter.icon} /></span>
            <span className="asr-stat__body">
              <span className="asr-stat__value">{filterCounts[filter.id]}</span>
              <span className="asr-stat__label">{filter.label}</span>
              <span className="asr-stat__hint">{filter.hint}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="asr-toolbar">
        <div className="asr-toolbar__right">
          <div className="asr-searchbar">
            <svg className="asr-searchbar__icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
            </svg>
            <input
              type="search"
              className="asr-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or email…"
              aria-label="Search cancellations by member name or email"
            />
          </div>
          <button
            type="button"
            className={`asr-refresh${loading ? ' asr-refresh--busy' : ''}`}
            onClick={() => load(status, activeSearch)}
            disabled={loading}
            aria-label="Refresh the cancellation queue"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
            </svg>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {pendingTotal > 0 && status === 'pending' && (
        <p className="asr-hint" role="status">
          <span className="asr-hint__dot" aria-hidden="true" />
          <span>
            <strong>{pendingTotal} member{pendingTotal === 1 ? '' : 's'}</strong> waiting on you.
            Their plan stays active until you approve.
          </span>
        </p>
      )}

      {error && <p className="asr-error" role="alert">{error}</p>}
      {notice && <p className="asr-notice" role="status">{notice}</p>}

      {!loaded && loading && (
        <div className="asr-skeletons" aria-hidden="true">
          {[0, 1].map((n) => (
            <div className="asr-skeleton" key={n}>
              <div className="asr-skeleton__top">
                <span className="asr-skeleton__avatar" />
                <span className="asr-skeleton__lines">
                  <span className="asr-skeleton__line asr-skeleton__line--sm" />
                  <span className="asr-skeleton__line" />
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {loaded && rows.length === 0 && (
        <div className="asr-empty">
          <span className="asr-empty__icon" aria-hidden="true"><StatIcon name="inbox" /></span>
          <p className="asr-empty__title">Nothing to review</p>
          <p className="asr-empty__text">
            {activeSearch
              ? `No cancellations match “${activeSearch}”.`
              : (status === 'pending'
                ? 'No members are waiting to cancel. Their plans stay exactly as they are.'
                : `No ${status} cancellations on record.`)}
          </p>
        </div>
      )}

      <ul className="asr-list">
        {rows.map((row) => {
          const expanded = openId === row._id;
          const busy = busyId === row._id;
          return (
            <li key={row._id} className={`asr-row asr-row--${row.status}${expanded ? ' asr-row--open' : ''}`}>
              <button
                type="button"
                className="asr-row__head"
                onClick={() => { setOpenId(expanded ? null : row._id); setReviewNote(''); }}
                aria-expanded={expanded}
              >
                <span className="asr-avatar" style={avatarStyle(row.user)} aria-hidden="true">{formatInitials(row.user)}</span>
                <span className="asr-row__who">
                  <strong>
                    {`${row.user?.firstName || ''} ${row.user?.lastName || ''}`.trim() || row.user?.email || 'Unknown account'}
                  </strong>
                  <span className="asr-row__sub">{row.user?.email || '—'}</span>
                </span>
                <span className={`asr-status asr-status--${row.status}`}>{STATUS_COPY[row.status] || row.status}</span>
                <span className="asr-row__plan">Ending {row.planLabel}</span>
                <span className="asr-row__when" title={formatStamp(row.createdAt)}>{relativeTime(row.createdAt)}</span>
              </button>

              {expanded && (
                <div className="asr-row__body">
                  <dl className="asr-detail">
                    <div><dt>Plan</dt><dd>{row.planLabel}</dd></div>
                    <div><dt>Requested</dt><dd>{formatStamp(row.createdAt)}</dd></div>
                    <div><dt>Route</dt><dd>{MODE_COPY[row.mode] || row.mode}</dd></div>
                    {row.reason && <div><dt>Reason</dt><dd>{row.reason}</dd></div>}
                    {row.review?.by && (
                      <div>
                        <dt>{row.status === 'rejected' ? 'Declined by' : 'Approved by'}</dt>
                        <dd>{row.review.by}{row.review.at ? ` · ${formatStamp(row.review.at)}` : ''}</dd>
                      </div>
                    )}
                    {row.review?.note && <div><dt>Note</dt><dd>{row.review.note}</dd></div>}
                  </dl>

                  {row.status === 'pending' ? (
                    <>
                      <label className="asr-note-label" htmlFor={`cancel-note-${row._id}`}>
                        Note for the member <span>(optional)</span>
                      </label>
                      {/* `.asr-note-input`, not `.asr-note`: that class is the
                          member's quoted blockquote, and a textarea inheriting
                          its italic and one-sided border radius is a bug. */}
                      <textarea
                        id={`cancel-note-${row._id}`}
                        className="asr-note-input"
                        rows={2}
                        maxLength={500}
                        value={reviewNote}
                        onChange={(e) => setReviewNote(e.target.value)}
                        placeholder="Shown to the member with the decision."
                        disabled={busy}
                      />
                      <div className="asr-actions">
                        <button
                          type="button"
                          className="asr-btn asr-btn--plain"
                          onClick={() => setConfirm(null)}
                          disabled={busy}
                        >
                          Keep their plan
                        </button>
                        <button
                          type="button"
                          className="asr-btn asr-btn--solid"
                          onClick={() => setConfirm({ kind: 'approve', row })}
                          disabled={busy}
                        >
                          Approve &amp; end plan
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="asr-resolved">
                      {row.status === 'applied'
                        ? `Their plan was ended${row.appliedAt ? ` on ${formatStamp(row.appliedAt)}` : ''}.`
                        : 'Nothing about their subscription changed.'}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* Confirm — a cancellation is irreversible, so it is never one click. */}
      {confirm && (
        <div className="asr-modal" role="dialog" aria-modal="true" aria-labelledby="asr-confirm-title">
          <div className="asr-modal__card" onClick={(e) => e.stopPropagation()}>
            <h3 id="asr-confirm-title" className="asr-modal__title">
              End {confirm.row.planLabel} for {`${confirm.row.user?.firstName || ''} ${confirm.row.user?.lastName || ''}`.trim() || confirm.row.user?.email}?
            </h3>
            <p className="asr-modal__text">
              This removes their paid access immediately and puts them back on Free.
              It cannot be undone from this screen, and the days already paid for are
              not refunded.
            </p>
            <div className="asr-modal__actions">
              <button
                type="button"
                className="asr-btn asr-btn--plain"
                onClick={() => setConfirm(null)}
                disabled={busyId === confirm.row._id}
              >
                Go back
              </button>
              <button
                type="button"
                className="asr-btn asr-btn--solid"
                onClick={() => run(confirm.row, 'approve')}
                disabled={busyId === confirm.row._id}
              >
                {busyId === confirm.row._id ? 'Ending…' : 'Yes, end the plan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
