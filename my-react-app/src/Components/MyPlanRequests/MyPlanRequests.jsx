import { useCallback, useEffect, useRef, useState } from 'react';
import { getMyPlanRequests } from '../../api';
import { planDisplayName } from '../../subscription/catalogue';
import './MyPlanRequests.css';

/**
 * MY PLAN REQUESTS
 *
 * The other half of the proof-of-payment flow. Submitting a request on the
 * pricing page queues it for an administrator; this is where the member finds
 * out what happened — pending, approved with the plan now live, or declined
 * with the reviewer's reason.
 *
 * It exists because a request that vanishes is indistinguishable from a request
 * that was ignored. A pending row states plainly that somebody still has to look
 * at it; a declined row always shows a reason.
 *
 * Failure here is NEVER fatal: the billing card above already shows the plan the
 * server considers current, so a failed fetch shows nothing rather than an error
 * about the plan itself.
 */

const STATUS = {
  pending: { label: 'Under review', tone: 'pending' },
  approved: { label: 'Approved', tone: 'approved' },
  rejected: { label: 'Declined', tone: 'rejected' },
};

function formatDay(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "3 days ago" — how long a request has been waiting is the question being asked. */
function waited(value) {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  return formatDay(value);
}

/**
 * A Team request stores the tier its seats grant (so approving it is an ordinary
 * subscription write), so the name has to be rebuilt from isTeam + seats — the
 * same reasoning the admin queue uses.
 */
function label(row) {
  if (row.isTeam === true) return `${row.seats > 1 ? `${row.seats}× ` : ''}Team`;
  return planDisplayName(row.plan) || row.plan;
}

export default function MyPlanRequests() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  // Kept out of the render on purpose: a fetch that fails simply leaves this
  // list empty, because the plan itself is already reported above.
  const loadToken = useRef(0);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    setLoading(true);
    try {
      const data = await getMyPlanRequests(5);
      if (token !== loadToken.current) return;
      setRows(Array.isArray(data.requests) ? data.requests : []);
    } catch {
      if (token !== loadToken.current) return;
      setRows([]);
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async load populates state from the server
  useEffect(() => { load(); }, [load]);

  useEffect(() => () => { loadToken.current += 1; }, []);

  // Nothing has ever been requested and there is nothing in flight: stay out of
  // the way rather than adding an empty heading to the billing page.
  if (!loading && rows.length === 0) return null;

  return (
    <div className="mpr">
      <div className="mpr-head">
        <p className="mpr-label">Plan requests</p>
        <button type="button" className="mpr-refresh" onClick={load} disabled={loading}>
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {loading && rows.length === 0 ? (
        <p className="mpr-empty">Checking for any requests…</p>
      ) : (
        <ul className="mpr-list">
          {rows.map((row) => {
            const copy = STATUS[row.status] || STATUS.pending;
            return (
              <li key={row._id} className={`mpr-row mpr-row--${copy.tone}`}>
                <div className="mpr-row__main">
                  <span className={`mpr-badge mpr-badge--${copy.tone}`}>{copy.label}</span>
                  <span className="mpr-plan">{label(row)}</span>
                </div>

                <p className="mpr-meta">
                  {row.months} month{row.months === 1 ? '' : 's'}
                  {row.formattedAmount ? ` · ${row.formattedAmount}` : ''}
                  {` · sent ${waited(row.createdAt)}`}
                </p>

                {row.status === 'pending' && (
                  <p className="mpr-note">
                    An administrator is checking your payment. Your plan switches on the
                    moment it is approved — you do not need to do anything else.
                  </p>
                )}

                {row.status === 'approved' && (
                  <p className="mpr-note mpr-note--ok">
                    Approved
                    {row.grantedDays ? ` — ${row.grantedDays} days granted` : ''}
                    {row.review?.at ? ` on ${formatDay(row.review.at)}` : ''}.
                  </p>
                )}

                {row.status === 'rejected' && (
                  <p className="mpr-note mpr-note--bad">
                    {row.review?.note
                      ? `Reason given: ${row.review.note}`
                      : 'This request was declined. Please check the receipt and try again, or contact support.'}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
