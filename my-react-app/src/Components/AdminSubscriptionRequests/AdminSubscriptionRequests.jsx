import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ConfirmModal from '../ConfirmModal/ConfirmModal';
import AdminSubscriptionPanel from '../AdminSubscriptionPanel/AdminSubscriptionPanel';
import AdminSubscriptionCancels from '../AdminSubscriptionCancels/AdminSubscriptionCancels';
import ImageLightbox from '../ImageLightbox/ImageLightbox';
import './AdminSubscriptionRequests.css';

/**
 * SUBSCRIPTION MANAGEMENT
 *
 * The review queue for plan requests submitted from /pricing with a
 * proof-of-payment image attached. Each row is one member's request; the
 * reviewer checks the picture, then either
 *
 *   APPROVE  →  grants the plan through the ordinary subscription engine
 *               (setPaid), so the paid layer, the projected fields, the audit
 *               log and the member's live session all update exactly as they do
 *               for a manual grant. Nothing is special-cased here.
 *   REJECT   →  closes the request and tells the member why. It never touches
 *               the subscription, so a rejection cannot quietly take access away.
 *
 * Design notes that matter:
 *   • The proof image is fetched ON DEMAND (one request at a time). A page of 25
 *     receipts inline would be tens of megabytes per poll.
 *   • A row is only actionable while it is `pending`; approved/rejected rows
 *     show the decision and who made it, so the queue doubles as the log.
 *   • Approving shows the exact outcome in the confirmation first — plan, days,
 *     money — because this is the one button here that gives somebody access.
 */

const FILTERS = [
  { id: 'pending', label: 'Pending', tone: 'pending', hint: 'Waiting on a decision', icon: 'clock' },
  { id: 'approved', label: 'Approved', tone: 'ok', hint: 'Plan activated', icon: 'check' },
  { id: 'rejected', label: 'Declined', tone: 'down', hint: 'Turned down', icon: 'x' },
  { id: 'all', label: 'All', tone: 'all', hint: 'Everything on record', icon: 'layers' },
];

const STATUS_COPY = {
  pending: { label: 'Pending review', tone: 'pending' },
  approved: { label: 'Approved', tone: 'approved' },
  rejected: { label: 'Declined', tone: 'rejected' },
};

/* Shared with the cancellation queue so a member keeps the same avatar colour
   in both lists — a queue of identical brown circles is a queue you read one
   row at a time. Hues are spaced far enough apart that neighbours differ. */
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #f97316 0%, #e11d48 100%)',
  'linear-gradient(135deg, #4f6bed 0%, #7c3aed 100%)',
  'linear-gradient(135deg, #10b981 0%, #0d9488 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #d946ef 100%)',
  'linear-gradient(135deg, #f43f5e 0%, #f59e0b 100%)',
  'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
];

function avatarStyle(user) {
  const seed = String(user?._id || user?.email || user?.firstName || 'x');
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 100000;
  return { backgroundImage: AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length] };
}

const ICONS = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" />
    </>
  ),
  check: (
    <>
      <path d="M20 6 9 17l-5-5" />
    </>
  ),
  x: (
    <>
      <circle cx="12" cy="12" r="9" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
    </>
  ),
  layers: (
    <>
      <polygon points="12 2.5 22 7.5 12 12.5 2 7.5" />
      <polyline points="2 16.5 12 21.5 22 16.5" />
      <polyline points="2 12 12 17 22 12" />
    </>
  ),
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  cart: (
    <>
      <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </>
  ),
};

function StatIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

function formatStamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatInitials(user) {
  const first = String(user?.firstName || '').trim();
  const last = String(user?.lastName || '').trim();
  const text = `${first} ${last}`.trim();
  if (!text) return '?';
  if (text.length === 1) return text.toUpperCase();
  return (first[0] + (last[0] || first[1] || '')).toUpperCase();
}

/** "in 3 days" / "3 days ago" — a queue is read by how urgent it is. */
function relativeTime(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const diffDays = Math.round((then - Date.now()) / 86_400_000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays === -1) return 'yesterday';
  return diffDays > 0 ? `in ${diffDays} days` : `${Math.abs(diffDays)} days ago`;
}

export default function AdminSubscriptionRequests({ request }) {
  // Which queue this tab is showing. Added as a plain `useState` here rather
  // than promoted to a second admin tab, because both queues are the same job —
  // reviewing a member's subscription change — and an administrator should not
  // have to know which drawer item a cancellation happens to live under.
  //
  // The cancellation queue renders in its OWN component (below the switch), so
  // nothing in the upgrade path can be affected by it: no shared state, no
  // shared effect, and no branch in the approve/reject logic that could be
  // pointed at the wrong endpoint.
  const [queue, setQueue] = useState('upgrades');
  const [status, setStatus] = useState('pending');
  const [search, setSearch] = useState('');
  // The search value that has actually been applied to a request. Kept apart
  // from `search` (the input) so typing is instant while the network is
  // debounced — and so the "no results" message can read the applied value
  // during render without touching a ref.
  const [activeSearch, setActiveSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  // Whether a load has ever completed. `loading` alone cannot drive the empty
  // state, because the first load no longer sets it synchronously — so "still
  // loading" is tracked separately from "currently refreshing".
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Expanded row + its proof image, loaded on demand.
  const [openId, setOpenId] = useState(null);
  const [proof, setProof] = useState(null); // { id, src }
  const [proofLoading, setProofLoading] = useState(false);
  const [proofError, setProofError] = useState('');
  // The full-size viewer, or null. It holds the row's own src so the caption
  // and the download name can name the member whose receipt this is.
  const [viewer, setViewer] = useState(null); // { src, label, fileBase }

  // Per-row review form.
  const [reviewNote, setReviewNote] = useState('');
  const [reviewDays, setReviewDays] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind, row, days, note }
  // The full per-user subscription controls are opt-in: expanding a row must not
  // fire a second request for something most reviewers never open.
  const [showControls, setShowControls] = useState(false);

  const noticeTimer = useRef(null);
  // Monotonic token: a response for a filter the admin has since changed must
  // never paint over the list they are actually looking at.
  const loadToken = useRef(0);
  const proofToken = useRef(0);

  const showNotice = useCallback((message) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 6000);
  }, []);

  // ── Full-size viewer ─────────────────────────────────────────────────────
  /**
   * Open the receipt at full size.
   *
   * This used to be an <a href={src} target="_blank">, which is why it never
   * worked: the proof is a `data:` URL, and no current browser will navigate a
   * tab to one. The tab opened blank and reported nothing at all. Rendering
   * the same src in an overlay sidesteps the restriction — the image was
   * always loadable, it just could never be a link target.
   *
   * The viewer belongs to the row that opened it, so every path that takes
   * that row away closes it too (see toggleRow and runDecision). Leaving it
   * open would float a receipt over a queue it no longer belongs to.
   */
  const openViewer = useCallback((row, src) => {
    const who = row?.user?.email || row?.user?.firstName || 'receipt';
    setViewer({
      src,
      label: `Payment proof — ${who}`,
      // The id keeps two receipts for the same member from overwriting each
      // other in the downloads folder.
      fileBase: `payment-proof-${row?._id || 'receipt'}`,
    });
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    // A pending list/proof response must not set state after unmount.
    loadToken.current += 1;
    proofToken.current += 1;
  }, []);

  // ── Load the queue ──────────────────────────────────────────────────────
  //
  // Deliberately NOT the `background` flag. That header exists so the
  // dashboard's 10 s auto-refresh does not count as activity and keep an idle
  // admin session alive forever. These loads are deliberate — opening the tab,
  // typing a search, pressing Refresh, expanding a row — and an administrator
  // reading receipts is unambiguously still there, so the heartbeat must run.
  const load = useCallback(async (nextStatus, nextSearch) => {
    const token = ++loadToken.current;
    // NO setState before the first await. This runs from an effect whose
    // dependencies include `load`, so a synchronous setState here makes the
    // effect's own output a render input: if `request` is ever passed down
    // without being memoized, `load` changes identity every render, the effect
    // re-runs, and the dashboard spins until React throws "Maximum update depth
    // exceeded". Doing all the state work after the await makes that impossible
    // no matter how the parent builds the prop. The spinner is driven by
    // `busyId` for the explicit Refresh button, so nothing is lost.
    try {
      const params = new URLSearchParams({ status: nextStatus, limit: '25' });
      if (nextSearch) params.set('search', nextSearch);
      const data = await request(`/subscription-requests?${params.toString()}`);
      if (token !== loadToken.current) return;
      setError('');
      setRows(Array.isArray(data.requests) ? data.requests : []);
      setCounts(data.counts || { pending: 0, approved: 0, rejected: 0 });
      setLoaded(true);
    } catch (loadError) {
      if (token !== loadToken.current) return;
      setError(loadError.message);
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, [request]);

  // Reload whenever the filter or the APPLIED search changes. `search` is the
  // raw input and is deliberately not a dependency — it is debounced below.
  //
  // `load` is read through a ref rather than called directly, so the effect
  // depends only on the things that are MEANT to trigger a reload. If the parent
  // ever hands down an unmemoized `request`, `load` changes identity on every
  // render; depending on it here would re-run this effect on every render and
  // spin the dashboard until React throws "Maximum update depth exceeded".
  // Reading it through a ref means the effect re-runs only when the filter or the
  // applied search genuinely changes, which is the behaviour described above.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    loadRef.current(status, activeSearch);
  }, [status, activeSearch]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setActiveSearch((current) => (search.trim() === current ? current : search.trim()));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  // ── Expand a row and pull its proof ──────────────────────────────────────
  //
  // Re-clicking an open row collapses it. Collapsing bumps the token so a proof
  // still in flight is discarded rather than popping into a closed row.
  const toggleRow = useCallback(async (row) => {
    if (openId === row._id) {
      proofToken.current += 1;
      setOpenId(null);
      setProof(null);
      setProofError('');
      setProofLoading(false);
      setReviewNote('');
      setReviewDays('');
      setShowControls(false);
      setViewer(null);
      return;
    }
    setOpenId(row._id);
    setReviewNote('');
    setReviewDays('');
    setShowControls(false);
    setProof(null);
    setProofError('');
    // Switching rows abandons the previous receipt, so its viewer goes too.
    setViewer(null);

    const token = ++proofToken.current;
    setProofLoading(true);
    try {
      const data = await request(`/subscription-requests/${row._id}`);
      if (token !== proofToken.current) return;
      if (!data.request?.proof) {
        setProofError('This request has no proof image attached.');
        return;
      }
      setProof({ id: row._id, src: data.request.proof });
    } catch (loadError) {
      if (token !== proofToken.current) return;
      setProofError(loadError.message);
    } finally {
      if (token === proofToken.current) setProofLoading(false);
    }
  }, [openId, request]);

  // ── Approve / reject ────────────────────────────────────────────────────
  /**
   * Open the confirmation for a decision.
   *
   * The "days to grant" field is read HERE, not recomputed from the requested
   * term — otherwise an admin who typed "45" would approve 30 and find out from
   * the member. A blank or unparseable field falls back to the requested term,
   * which is what the placeholder advertises.
   */
  const openConfirm = useCallback((kind, row) => {
    const requestedDays = Math.max(1, Math.min(12, Number(row.months) || 1)) * 30;
    const typed = Number(reviewDays);
    const days = Number.isFinite(typed) && typed > 0 ? Math.round(typed) : requestedDays;
    // Seed the field only when it is empty, so opening the dialog does not
    // discard a value the reviewer already typed.
    if (!reviewDays.trim()) setReviewDays(String(requestedDays));
    setConfirm({
      kind,
      row,
      days: kind === 'approve' ? days : 0,
      note: reviewNote.trim(),
    });
  }, [reviewNote, reviewDays]);

  const runDecision = useCallback(async () => {
    if (!confirm || busyId) return;
    const { kind, row, days, note } = confirm;
    setConfirm(null);
    setBusyId(row._id);
    setError('');
    try {
      if (kind === 'approve') {
        const data = await request(`/subscription-requests/${row._id}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days, note }),
        });
        showNotice(data.message || 'Plan activated.');
      } else {
        const data = await request(`/subscription-requests/${row._id}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        });
        showNotice(data.message || 'Request declined.');
      }
      // The row left the current filter (or gained a decision), and the counts
      // moved — so the whole list is refetched rather than patched locally.
      proofToken.current += 1;
      setOpenId(null);
      setProof(null);
      setProofLoading(false);
      setReviewNote('');
      setReviewDays('');
      setShowControls(false);
      setViewer(null);
      await load(status, activeSearch);
    } catch (decisionError) {
      setError(decisionError.message);
      // A 409 means someone else got there first — refetch so the admin sees the
      // real state instead of a button that will keep failing.
      if (decisionError.message?.toLowerCase().includes('already')) {
        load(status, activeSearch);
      }
    } finally {
      setBusyId(null);
    }
  }, [confirm, busyId, request, showNotice, load, status, activeSearch]);

  // ── Derived ─────────────────────────────────────────────────────────────
  const pendingTotal = counts.pending || 0;
  const filterCounts = useMemo(() => ({
    pending: counts.pending || 0,
    approved: counts.approved || 0,
    rejected: counts.rejected || 0,
    all: (counts.pending || 0) + (counts.approved || 0) + (counts.rejected || 0),
  }), [counts]);

  return (
    <div className="asr">
      {/* ── Which queue ──────────────────────────────────────────────────── */}
      <div className="asr-queues" role="tablist" aria-label="Subscription request queues">
        <button
          type="button"
          role="tab"
          aria-selected={queue === 'upgrades'}
          className={`asr-queue${queue === 'upgrades' ? ' asr-queue--active' : ''}`}
          onClick={() => setQueue('upgrades')}
        >
          <StatIcon name="cart" />
          Plan requests
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={queue === 'cancels'}
          className={`asr-queue${queue === 'cancels' ? ' asr-queue--active' : ''}`}
          onClick={() => setQueue('cancels')}
        >
          <StatIcon name="x" />
          Cancellations
        </button>
      </div>

      {queue === 'cancels' ? <AdminSubscriptionCancels request={request} /> : (
        <>
      {/* ── Stat cards — these are the filters ─────────────────────────── */}
      <div className="asr-stats" role="group" aria-label="Filter requests by status">
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

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
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
              aria-label="Search requests by member name or email"
            />
          </div>
          <button
            type="button"
            className={`asr-refresh${loading ? ' asr-refresh--busy' : ''}`}
            onClick={() => load(status, activeSearch)}
            disabled={loading}
            aria-label="Refresh the request queue"
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
            <strong>{pendingTotal} request{pendingTotal === 1 ? '' : 's'}</strong> waiting. Check the
            payment proof, then approve to activate the plan — the member is notified and their
            features unlock immediately.
          </span>
        </p>
      )}

      {error && <p className="asr-error" role="alert">{error}</p>}
      {notice && <p className="asr-notice" role="status">{notice}</p>}

      {/* ── Queue ───────────────────────────────────────────────────────── */}
      {!loaded ? (
        <div className="asr-skeletons" aria-hidden="true">
          {[0, 1, 2].map((n) => (
            <div className="asr-skeleton" key={n}>
              <div className="asr-skeleton__top">
                <span className="asr-skeleton__avatar" />
                <span className="asr-skeleton__lines">
                  <span className="asr-skeleton__line asr-skeleton__line--sm" />
                  <span className="asr-skeleton__line" />
                </span>
              </div>
              <div className="asr-skeleton__facts">
                <span className="asr-skeleton__fact" />
                <span className="asr-skeleton__fact" />
                <span className="asr-skeleton__fact" />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="asr-empty">
          <span className="asr-empty__icon" aria-hidden="true"><StatIcon name="inbox" /></span>
          <p className="asr-empty__title">Nothing to review</p>
          <p className="asr-empty__text">
            {activeSearch
              ? `No requests match “${activeSearch}”.`
              : (status === 'pending'
                ? 'No plan requests are waiting. New ones land here with their payment proof attached.'
                : `No ${status} subscription requests on record.`)}
          </p>
        </div>
      ) : (
        <ul className="asr-list">
          {rows.map((row) => {
            const copy = STATUS_COPY[row.status] || STATUS_COPY.pending;
            const isOpen = openId === row._id;
            const busy = busyId === row._id;
            const user = row.user || null;
            const isPending = row.status === 'pending';
            const banned = user?.accountStatus && user.accountStatus !== 'active';

            return (
              <li key={row._id} className={`asr-card asr-card--${copy.tone}${isOpen ? ' asr-card--open' : ''}`}>
                <div className="asr-card__head">
                  <span className="asr-avatar" style={avatarStyle(user)} aria-hidden="true">{formatInitials(user)}</span>
                  <div className="asr-card__who">
                    <p className="asr-card__name">
                      {user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email : 'Unknown account'}
                      {banned && <span className="asr-flag asr-flag--banned">{String(user.accountStatus).toUpperCase()}</span>}
                    </p>
                    <p className="asr-card__email">{user?.email || '—'}</p>
                  </div>
                  <span className={`asr-status asr-status--${copy.tone}`}>{copy.label}</span>
                </div>

                <dl className="asr-facts">
                  <div className="asr-fact">
                    <dt>Plan requested</dt>
                    <dd>{row.planLabel || row.plan}</dd>
                  </div>
                  <div className="asr-fact">
                    <dt>Term</dt>
                    <dd>{row.months} month{row.months === 1 ? '' : 's'}</dd>
                  </div>
                  {/* The amount is the number a reviewer scans for, so it is the
                      one fact given a colour and extra weight. */}
                  <div className="asr-fact asr-fact--money">
                    <dt>Amount due</dt>
                    <dd>{row.formattedAmount || '—'}</dd>
                  </div>
                  <div className="asr-fact">
                    <dt>Submitted</dt>
                    <dd>
                      {formatStamp(row.createdAt)}
                      {row.status === 'pending' && relativeTime(row.createdAt)
                        ? <span className="asr-fact__sub">{relativeTime(row.createdAt)}</span>
                        : null}
                    </dd>
                  </div>
                  {row.reference ? (
                    <div className="asr-fact">
                      <dt>Payment reference</dt>
                      <dd className="asr-mono">{row.reference}</dd>
                    </div>
                  ) : null}
                </dl>

                {row.note && <p className="asr-note">“{row.note}”</p>}

                {row.status !== 'pending' && (
                  <p className="asr-decision">
                    <strong>{row.status === 'approved' ? 'Approved' : 'Declined'}</strong>
                    {' by '}{row.review?.by || 'an administrator'}
                    {row.review?.at ? ` · ${formatStamp(row.review.at)}` : ''}
                    {row.status === 'approved' && row.grantedDays ? ` · granted ${row.grantedDays} days` : ''}
                    {row.review?.note ? <span className="asr-decision__note">{row.review.note}</span> : null}
                  </p>
                )}

                <div className="asr-card__actions">
                  <button
                    type="button"
                    className="asr-btn asr-btn--ghost"
                    onClick={() => toggleRow(row)}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? 'Hide proof' : 'View proof'}
                  </button>

                  {isPending ? (
                    <>
                      <button
                        type="button"
                        className="asr-btn asr-btn--danger"
                        onClick={() => openConfirm('reject', row)}
                        disabled={busy}
                      >
                        Decline
                      </button>
                      <button
                        type="button"
                        className="asr-btn asr-btn--primary"
                        onClick={() => openConfirm('approve', row)}
                        disabled={busy}
                      >
                        {busy ? 'Working…' : 'Approve & activate'}
                      </button>
                    </>
                  ) : null}
                </div>

                {/* ── Expanded: the proof + the review form ─────────────────── */}
                {isOpen && (
                  <div className="asr-detail">
                    <div className="asr-proof">
                      <p className="asr-label">Proof of payment</p>
                      {proofLoading ? (
                        <p className="asr-empty">Loading the image…</p>
                      ) : proofError ? (
                        <p className="asr-error" role="alert">{proofError}</p>
                      ) : proof && proof.id === row._id ? (
                        /* A <button>, not an <a href={proof.src} target="_blank">.
                           The proof is a `data:` URL and browsers refuse to
                           navigate a tab to one, so that link opened an empty
                           tab with no error — while the <img> beside it kept
                           working, which is exactly why it looked like the
                           image was broken. */
                        <button
                          type="button"
                          className="asr-proof__link"
                          onClick={() => openViewer(row, proof.src)}
                          aria-label="View the payment receipt at full size"
                        >
                          <img className="asr-proof__img" src={proof.src} alt="Payment receipt submitted with this request" />
                          <span className="asr-proof__hint">View full size</span>
                        </button>
                      ) : (
                        <p className="asr-empty">Select “View proof” to load the image.</p>
                      )}
                    </div>

                    {isPending && (
                      <div className="asr-review">
                        <p className="asr-label">Review</p>
                        <label className="asr-field">
                          <span>Days to grant (blank = the requested term)</span>
                          <input
                            type="number"
                            min="1"
                            max="3650"
                            inputMode="numeric"
                            value={reviewDays}
                            onChange={(e) => setReviewDays(e.target.value)}
                            placeholder={String((Number(row.months) || 1) * 30)}
                          />
                        </label>
                        <label className="asr-field">
                          <span>Note to the member (shown if declined)</span>
                          <input
                            type="text"
                            maxLength={240}
                            value={reviewNote}
                            onChange={(e) => setReviewNote(e.target.value)}
                            placeholder="e.g. Reference not found in our records"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Per-user subscription control, for the account that owns
                    this request. Opt-in, so expanding a row does not fire a
                    second request for something most reviewers never open. ── */}
                {isOpen && user?._id && (
                  <div className="asr-manual">
                    {showControls ? (
                      <>
                        <button
                          type="button"
                          className="asr-btn asr-btn--ghost asr-btn--small"
                          onClick={() => setShowControls(false)}
                        >
                          Hide full subscription controls
                        </button>
                        <AdminSubscriptionPanel user={{ _id: user._id }} request={request} />
                      </>
                    ) : (
                      <button
                        type="button"
                        className="asr-btn asr-btn--ghost asr-btn--small"
                        onClick={() => setShowControls(true)}
                      >
                        Open full subscription controls for this account
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {confirm && (
        <ConfirmModal
          type={confirm.kind === 'approve' ? 'warning' : 'danger'}
          title={confirm.kind === 'approve' ? 'Activate this plan?' : 'Decline this request?'}
          message={confirm.kind === 'approve'
            ? `${confirm.row.planLabel || confirm.row.plan} for ${confirm.days} days will be granted to ${confirm.row.user?.email || 'this member'}. They are notified and their features unlock immediately.`
            : `${confirm.row.user?.email || 'This member'} will be told the request was declined${confirm.note ? `: “${confirm.note}”` : ''}. Their current subscription is not changed.`}
          confirmText={confirm.kind === 'approve' ? 'Activate plan' : 'Decline request'}
          cancelText="Cancel"
          onConfirm={runDecision}
          onCancel={() => setConfirm(null)}
        />
      )}
        </>
      )}

      {/* ── Full-size receipt viewer ─────────────────────────────────────── */}
      {/* Rendered OUTSIDE the queue switch above, so it cannot be torn out from
          under itself by anything that happens to re-render that branch. */}
      {viewer && (
        <ImageLightbox
          key={viewer.src}
          src={viewer.src}
          alt={viewer.label}
          fileBase={viewer.fileBase}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
