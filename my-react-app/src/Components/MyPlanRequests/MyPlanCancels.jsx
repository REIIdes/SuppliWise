import { useCallback, useEffect, useRef, useState } from 'react';
import { getMyCancelRequests } from '../../api';
import './MyPlanRequests.css';

/**
 * "My cancellations" on the profile billing page.
 *
 * The mirror of MyPlanRequests, and separate from it for the same reason the two
 * admin queues are separate: an upgrade says "turn this on" and a cancellation
 * says "turn this off", and a member scanning their billing page must be able to
 * tell at a glance which is which. Merging the two lists would mean every row
 * carried a direction flag, and the one time that matters most — a declined
 * cancellation, where the plan is still active — is exactly the row that reads
 * wrong when it is filed under the wrong heading.
 *
 * The `statusMessage` shown here is the SERVER's sentence (see
 * utils/subscriptionCancels.statusMessageFor), so this screen and the admin
 * queue and the notification a member gets by email all describe the same state
 * the same way.
 */

const STATUS = {
  pending: { label: 'Waiting', tone: 'warn' },
  applied: { label: 'Ended', tone: 'ok' },
  rejected: { label: 'Declined', tone: 'bad' },
};

function formatDay(value) {
  if (!value) return '';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function waited(value) {
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
  return formatDay(value);
}

export default function MyPlanCancels() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  // Kept out of the render on purpose: a fetch that fails simply leaves this
  // list empty, because the plan itself is already reported above.
  const loadToken = useRef(0);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    setLoading(true);
    try {
      const data = await getMyCancelRequests(5);
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
        <p className="mpr-label">Cancellations</p>
        <button type="button" className="mpr-refresh" onClick={load} disabled={loading}>
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {loading && rows.length === 0 ? (
        <p className="mpr-empty">Checking for any cancellations…</p>
      ) : (
        <ul className="mpr-list">
          {rows.map((row) => {
            const copy = STATUS[row.status] || STATUS.pending;
            return (
              <li key={row._id} className={`mpr-row mpr-row--${copy.tone}`}>
                <div className="mpr-row__main">
                  <span className={`mpr-badge mpr-badge--${copy.tone}`}>{copy.label}</span>
                  <span className="mpr-plan">Ending {row.planLabel || 'your plan'}</span>
                </div>

                <p className="mpr-meta">
                  {row.mode === 'immediate' ? 'Ended by you' : 'Asked for review'}
                  {` · ${waited(row.createdAt)}`}
                </p>

                {row.statusMessage && (
                  <p className={`mpr-note${row.status === 'rejected' ? ' mpr-note--bad' : (row.status === 'applied' ? ' mpr-note--ok' : '')}`}>
                    {row.statusMessage}
                  </p>
                )}

                {row.status === 'rejected' && row.review?.at && (
                  <p className="mpr-meta">Reviewed on {formatDay(row.review.at)}.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
