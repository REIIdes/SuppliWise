import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ConfirmModal from '../ConfirmModal/ConfirmModal';
import { PLAN_LABELS, daysLeftFrom } from '../../utils/plan';
import './AdminSubscriptionPanel.css';

/**
 * ADMIN SUBSCRIPTION CONTROL
 *
 * Full control over one account's subscription, with the paid state and the
 * admin override kept visibly separate:
 *
 *   ┌ EFFECTIVE ──────────────────────────────────────────────┐
 *   │ ULTIMATE · 10 days remaining · expires 12 Apr 2026       │
 *   │ [ADMIN GRANT] [PERMANENT]                                │
 *   └──────────────────────────────────────────────────────────┘
 *   ┌ USER'S OWN PAID SUBSCRIPTION ─────────┐ ┌ ADMIN OVERRIDE ─┐
 *   │ PREMIUM · 4 days remaining           │ │ +6 days by root  │
 *   │ started 1 Mar · ends 1 Apr           │ │ [Restore original]│
 *   └───────────────────────────────────────┘ └──────────────────┘
 *
 * The restore target is stated in the admin's own words ("returns to PREMIUM
 * with 4 days remaining") before the button is pressed, so it is never a guess
 * whether "restore" means "back to what he paid for" or "a fresh 30 days".
 */

const PLAN_IDS = ['monthly', 'annual', 'custom'];

const ACTION_COPY = {
  grant: 'Grant',
  remove: 'Remove',
  addDays: 'Add days',
  deductDays: 'Deduct days',
  extend: 'Extend',
  permanent: 'Make permanent',
  changePlan: 'Change plan',
  restore: 'Restore original',
  clearOverride: 'Clear override',
  setPaid: 'Set paid plan',
  renewPaid: 'Renew paid plan',
  cancelPaid: 'Cancel paid plan',
};

function formatStamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatDay(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "10 days remaining" / "Permanent" / "Expired". */
function remainingText(layer) {
  if (!layer) return '—';
  if (layer.plan === 'free' && !layer.active) return 'No subscription';
  if (layer.permanent) return 'Permanent — never expires';
  if (layer.expiresAt === null) return 'No expiry set';
  const days = daysLeftFrom(layer.expiresAt);
  if (days === null) return 'No expiry set';
  if (days <= 0) return 'Expired';
  return `${days} day${days === 1 ? '' : 's'} remaining`;
}

/** Days the layer was granted, for the "30-day plan" sub-line. */
function periodText(layer) {
  if (!layer) return null;
  if (layer.permanent) return 'No expiry';
  if (!Number.isFinite(layer.periodDays) || layer.periodDays <= 0) return null;
  return `${layer.periodDays}-day period`;
}

/** Fraction of the granted window still unused (0–100). */
function progressPercent(layer) {
  if (!layer || layer.permanent || !Number.isFinite(layer.periodDays) || layer.periodDays <= 0) return null;
  if (!layer.startedAt || !layer.expiresAt) return null;
  const start = new Date(layer.startedAt).getTime();
  const end = new Date(layer.expiresAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const total = end - start;
  const left = Math.max(0, Math.min(total, end - Date.now()));
  return Math.round((left / total) * 100);
}

export default function AdminSubscriptionPanel({ user, request, onUserUpdated }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState(null);
  const [panelError, setPanelError] = useState('');
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef(null);

  // Grant / change-plan form state
  const [grantPlan, setGrantPlan] = useState('annual');
  const [grantDays, setGrantDays] = useState('30');
  const [grantPermanent, setGrantPermanent] = useState(false);
  const [grantReason, setGrantReason] = useState('');
  const [showGrantForm, setShowGrantForm] = useState(false);

  // Day arithmetic input
  const [dayInput, setDayInput] = useState('7');
  const [extendDate, setExtendDate] = useState('');
  // Seat count, seeded from the loaded detail so the field always opens showing
  // the CURRENT count rather than a blank that invites a mistake.
  const [seatInput, setSeatInput] = useState('1');

  const [confirm, setConfirm] = useState(null);
  const mountToken = useRef(0);

  // Seed the "set expiry date" field from the CURRENT expiry as part of the
  // load, not in a separate effect: the value comes from the fetched payload, so
  // deriving it here keeps it correct after every action and avoids a render
  // pass that only exists to copy a value we already have.
  const seedExtendDate = useCallback((expiresAt) => {
    setExtendDate(expiresAt ? new Date(expiresAt).toISOString().slice(0, 10) : '');
  }, []);

  // Same for seats: the loaded record is the only truth about how many there are.
  const seedSeats = useCallback((seats) => {
    const n = Number(seats);
    setSeatInput(String(Number.isFinite(n) && n > 0 ? Math.round(n) : 1));
  }, []);

  const load = useCallback(async () => {
    const token = ++mountToken.current;
    setLoading(true);
    try {
      const data = await request(`/users/${user._id}/subscription`);
      // A response for a previously-selected user must never paint over the
      // panel for the user actually open now.
      if (token !== mountToken.current) return;
      setDetail(data.detail);
      seedExtendDate(data.detail?.effective?.expiresAt);
      seedSeats(data.detail?.paid?.seats);
      setPanelError('');
    } catch (error) {
      if (token !== mountToken.current) return;
      setPanelError(error?.message || 'Unable to load the subscription.');
    } finally {
      if (token === mountToken.current) setLoading(false);
    }
  }, [request, user._id, seedExtendDate, seedSeats]);

  // Fetching the panel's data is an external-system sync; every setState lands
  // after the await, so there is no cascading render on mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- async load populates state from the server
  useEffect(() => { load(); }, [load]);

  // Success notices auto-dismiss. Cleared on unmount so a panel that is closed
  // mid-toast does not fire a setState into a dead component.
  useEffect(() => () => { if (noticeTimer.current) window.clearTimeout(noticeTimer.current); }, []);

  const showNotice = useCallback((message) => {
    setNotice(message || '');
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 5000);
  }, []);

  // The extend field starts from the current expiry, seeded by load() above.
  // `run` re-seeds it too: after an action the expiry may have moved, and the
  // "Set expiry date" button must act on what is now on screen, not on a stale
  // pre-action date.

  const effective = detail?.effective;
  const paid = detail?.paid;
  const override = detail?.override;
  const restoreTarget = detail?.restoreTarget;

  /** Run one action against POST /users/:id/subscription, then adopt the reply. */
  const run = useCallback(async (action, payload = {}) => {
    setBusyAction(action);
    setPanelError('');
    try {
      const data = await request(`/users/${user._id}/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      // The server response is authoritative — adopt it rather than guessing
      // what the new state is. This is also why the panel and the user list can
      // never disagree after an edit.
      if (data.detail) {
        setDetail(data.detail);
        seedExtendDate(data.detail?.effective?.expiresAt);
        seedSeats(data.detail?.paid?.seats);
      }
      if (data.user && onUserUpdated) onUserUpdated(data.user);
      showNotice(data.message || 'Subscription updated.');
      return data;
    } catch (error) {
      setPanelError(error?.message || 'The subscription could not be updated.');
      return null;
    } finally {
      setBusyAction(null);
    }
  }, [request, user._id, onUserUpdated, showNotice, seedExtendDate, seedSeats]);

  const askRestore = useCallback(() => {
    setConfirm({
      title: 'Restore original subscription state?',
      message: restoreTarget
        ? `The admin override is removed and this account returns to its own paid subscription: ${restoreTarget.label}`
          + `${restoreTarget.permanent ? ' (permanent)' : ` with ${restoreTarget.capturedDaysRemaining} day${restoreTarget.capturedDaysRemaining === 1 ? '' : 's'} remaining`}`
          + `${restoreTarget.expiresAt ? `, expiring ${formatDay(restoreTarget.expiresAt)}` : ''}. `
          + 'Any days the admin added are discarded.'
        : 'The admin override is removed and the account returns to its own paid subscription.',
      confirmText: 'Restore original',
      onConfirm: () => { setConfirm(null); return run('restore'); },
    });
  }, [restoreTarget, run]);

  const askRemove = useCallback(() => {
    setConfirm({
      title: 'Remove this subscription?',
      message: 'The admin override AND the user\'s own paid subscription are both cancelled, and the account drops to the Free tier. '
        + 'The previous state stays in the change log below.',
      confirmText: 'Remove subscription',
      onConfirm: () => { setConfirm(null); return run('remove'); },
    });
  }, [run]);

  const askCancelPaid = useCallback(() => {
    setConfirm({
      title: 'Cancel the paid subscription?',
      message: 'The user\'s own purchase is cancelled and any admin override is dropped. '
        + 'This is what "the customer cancelled" looks like — use "Remove override" if you only want to undo your own change.',
      confirmText: 'Cancel paid plan',
      onConfirm: () => {
        setConfirm(null);
        return run('setPaid', { plan: paid?.plan || 'free', active: false });
      },
    });
  }, [paid?.plan, run]);

  const submitGrant = useCallback((event) => {
    event.preventDefault();
    run('grant', {
      plan: grantPlan,
      permanent: grantPermanent,
      days: grantPermanent ? undefined : Number(grantDays),
      note: grantReason.trim() || undefined,
    }).then(() => { setShowGrantForm(false); setGrantReason(''); });
  }, [run, grantPlan, grantPermanent, grantDays, grantReason]);

  const daysInputValid = useMemo(() => {
    const n = Number(dayInput);
    return Number.isFinite(n) && n > 0;
  }, [dayInput]);

  const seatInputValid = useMemo(() => {
    const n = Number(seatInput);
    return Number.isFinite(n) && n >= 1 && n <= 500;
  }, [seatInput]);

  const isPermanent = effective?.permanent === true;
  const hasOverride = override?.active === true;
  const canRestore = detail?.canRestore === true;
  const busy = busyAction !== null;

  if (loading && !detail) {
    return (
      <div className="asp asp--loading" aria-busy="true">
        Loading subscription…
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="asp">
        <p className="asp__error" role="alert">{panelError || 'Unable to load the subscription.'}</p>
        <button type="button" className="asp-btn" onClick={load}>Try again</button>
      </div>
    );
  }

  const progress = progressPercent(effective);

  return (
    <div className="asp">
      {panelError && <p className="asp__error" role="alert">{panelError}</p>}
      {notice && !panelError && <p className="asp__notice" role="status">{notice}</p>}

      {/* ── Effective state ─────────────────────────────────────────── */}
      <div className="asp-effective">
        <div className="asp-effective__head">
          <div>
            <p className="asp-label">Effective subscription</p>
            <p className="asp-effective__plan">{PLAN_LABELS[effective?.plan] || 'FREE'}</p>
            {/* A cancelled or elapsed window reports FREE as the plan actually
                granted, but the plan it used to be is still on the record —
                showing it here stops a lapsed subscription from looking like it
                never existed. */}
            {!effective?.active && effective?.recordedPlan
              && effective.recordedPlan !== 'free' && (
              <p className="asp-effective__was">
                Was {PLAN_LABELS[effective.recordedPlan] || effective.recordedPlan}
                {' · '}
                {String(effective.status || '').toUpperCase()}
              </p>
            )}
          </div>
          <div className="asp-badges">
            <span className={`asp-chip asp-chip--${effective?.source || 'free'}`}>
              {effective?.sourceLabel || 'FREE'}
            </span>
            {isPermanent && <span className="asp-chip asp-chip--permanent">PERMANENT</span>}
            <span className={`asp-chip asp-chip--${effective?.active ? 'active' : 'muted'}`}>
              {String(effective?.status || 'none').toUpperCase()}
            </span>
          </div>
        </div>

        <p className="asp-effective__remaining">{remainingText(effective)}</p>
        <p className="asp-effective__meta">
          {effective?.permanent
            ? 'Expires: never'
            : `Expires: ${effective?.expiresAt ? formatStamp(effective.expiresAt) : 'not set'}`}
          {effective?.startedAt ? ` · Started: ${formatDay(effective.startedAt)}` : ''}
          {periodText(effective) ? ` · ${periodText(effective)}` : ''}
        </p>

        {/* Seats. Shown whenever there is more than one, because that is the whole
            difference between an individual Premium plan and a Team one — and an
            admin about to change a seat count has to see the current one. */}
        {Number(paid?.seats) > 1 && (
          <p className="asp-effective__seats">
            <span className="asp-chip asp-chip--team">TEAM</span>
            {paid.seats} seats · each a full Premium account
          </p>
        )}

        {progress !== null && (
          <div
            className="asp-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label="Subscription time remaining"
          >
            <span className="asp-progress__bar" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>

      {/* ── The two layers, side by side ────────────────────────────── */}
      <div className="asp-layers">
        <section className={`asp-layer${hasOverride ? ' asp-layer--muted' : ' asp-layer--live'}`}>
          <header className="asp-layer__head">
            <p className="asp-label">User's paid subscription</p>
            <span className="asp-chip asp-chip--paid">PAID</span>
          </header>
          <p className="asp-layer__plan">{PLAN_LABELS[paid?.plan] || 'FREE'}</p>
          <p className="asp-layer__remaining">{remainingText(paid)}</p>
          <p className="asp-layer__meta">
            {paid?.permanent
              ? 'Never expires'
              : `Started: ${formatDay(paid?.startedAt)} · Expires: ${formatDay(paid?.expiresAt)}`}
          </p>
          {paid?.updatedBy && (
            <p className="asp-layer__meta">
              Last set by <strong>{paid.updatedBy}</strong>
              {paid.updatedAt ? ` · ${formatStamp(paid.updatedAt)}` : ''}
            </p>
          )}
        </section>

        <section className={`asp-layer${hasOverride ? ' asp-layer--live' : ' asp-layer--muted'}`}>
          <header className="asp-layer__head">
            <p className="asp-label">Admin override</p>
            {hasOverride
              ? <span className="asp-chip asp-chip--admin">ACTIVE</span>
              : <span className="asp-chip asp-chip--muted">NONE</span>}
          </header>
          {hasOverride ? (
            <>
              <p className="asp-layer__plan">{PLAN_LABELS[override.plan] || 'FREE'}</p>
              <p className="asp-layer__remaining">{remainingText(override)}</p>
              <p className="asp-layer__meta">
                {override.permanent
                  ? 'Never expires'
                  : `Expires: ${formatStamp(override.expiresAt)}`}
              </p>
              <p className="asp-layer__meta">
                By <strong>{override.adminAlias || 'admin'}</strong>
                {override.appliedAt ? ` · ${formatStamp(override.appliedAt)}` : ''}
              </p>
              {override.reason ? <p className="asp-layer__reason">“{override.reason}”</p> : null}
            </>
          ) : (
            <p className="asp-layer__empty">
              No admin override. The account is running on the user&rsquo;s own paid plan.
            </p>
          )}
        </section>
      </div>

      {/* ── Restore ─────────────────────────────────────────────────── */}
      <div className={`asp-restore${canRestore ? '' : ' asp-restore--off'}`}>
        <div className="asp-restore__text">
          <p className="asp-label">Restore original subscription state</p>
          <p className="asp-restore__body">
            {canRestore && restoreTarget
              ? `Returns this account to ${restoreTarget.label}`
                + `${restoreTarget.permanent ? ' (permanent)' : ` with ${restoreTarget.capturedDaysRemaining} day${restoreTarget.capturedDaysRemaining === 1 ? '' : 's'} remaining`}`
                + `${restoreTarget.expiresAt ? `, expiring ${formatDay(restoreTarget.expiresAt)}` : ''} — the exact state before any admin change.`
              : 'Available once an admin override has been applied. The user’s original paid expiry date is captured at that moment and returned exactly.'}
          </p>
        </div>
        <button
          type="button"
          className="asp-btn asp-btn--restore"
          onClick={askRestore}
          disabled={!canRestore || busy}
        >
          {busyAction === 'restore' ? 'Restoring…' : 'Restore original'}
        </button>
      </div>

      {/* ── Actions ─────────────────────────────────────────────────── */}
      <div className="asp-actions">
        <button
          type="button"
          className={`asp-btn asp-btn--primary${showGrantForm ? ' asp-btn--on' : ''}`}
          onClick={() => setShowGrantForm((v) => !v)}
          disabled={busy}
          aria-expanded={showGrantForm}
        >
          {hasOverride ? 'Re-grant' : 'Grant subscription'}
        </button>

        <label className="asp-days">
          <span className="asp-days__label">Days</span>
          <input
            type="number"
            min="1"
            max="3650"
            value={dayInput}
            onChange={(e) => setDayInput(e.target.value)}
            disabled={busy}
            aria-label="Number of days to add or deduct"
          />
        </label>

        <button
          type="button"
          className="asp-btn"
          onClick={() => {
            if (!daysInputValid) return;
            run('addDays', { days: Number(dayInput) });
          }}
          disabled={busy || !daysInputValid || isPermanent}
          title={isPermanent ? 'A permanent subscription has no days to add' : undefined}
        >
          {busyAction === 'addDays' ? 'Adding…' : `+${daysInputValid ? dayInput : '0'} days`}
        </button>

        <button
          type="button"
          className="asp-btn"
          onClick={() => {
            if (!daysInputValid) return;
            run('deductDays', { days: Number(dayInput) });
          }}
          disabled={busy || !daysInputValid || isPermanent}
          title={isPermanent ? 'A permanent subscription has no days to remove' : undefined}
        >
          {busyAction === 'deductDays' ? 'Removing…' : `−${daysInputValid ? dayInput : '0'} days`}
        </button>

        <button
          type="button"
          className="asp-btn"
          onClick={() => run('permanent')}
          disabled={busy || isPermanent}
        >
          {busyAction === 'permanent' ? 'Updating…' : 'Make permanent'}
        </button>

        <button
          type="button"
          className="asp-btn"
          onClick={() => run('changePlan', { plan: grantPlan })}
          disabled={busy || grantPlan === effective?.plan}
          title="Change the plan on the layer currently in force"
        >
          Change plan
        </button>

        <button
          type="button"
          className="asp-btn"
          onClick={() => run('extend', { expiresAt: extendDate ? new Date(`${extendDate}T23:59:59`).toISOString() : undefined })}
          disabled={busy || !extendDate || isPermanent}
        >
          {busyAction === 'extend' ? 'Updating…' : 'Set expiry date'}
        </button>

        {hasOverride && (
          <button
            type="button"
            className="asp-btn"
            onClick={() => run('clearOverride')}
            disabled={busy}
            title="Undo the admin change and go back to the paid plan"
          >
            {busyAction === 'clearOverride' ? 'Removing…' : 'Remove override'}
          </button>
        )}

        <button
          type="button"
          className="asp-btn asp-btn--danger"
          onClick={askRemove}
          disabled={busy || (!hasOverride && !paid?.active)}
        >
          {busyAction === 'remove' ? 'Removing…' : 'Remove subscription'}
        </button>
      </div>

      {/* ── Grant / change-plan form ────────────────────────────────── */}
      {showGrantForm && (
        <form className="asp-form" onSubmit={submitGrant}>
          <div className="asp-form__row">
            <label className="asp-field">
              <span>Plan</span>
              <select value={grantPlan} onChange={(e) => setGrantPlan(e.target.value)}>
                {PLAN_IDS.map((id) => <option key={id} value={id}>{PLAN_LABELS[id]}</option>)}
              </select>
            </label>
            <label className="asp-field">
              <span>Duration (days)</span>
              <input
                type="number"
                min="1"
                max="3650"
                value={grantDays}
                onChange={(e) => setGrantDays(e.target.value)}
                disabled={grantPermanent}
              />
            </label>
          </div>

          <label className="asp-check">
            <input
              type="checkbox"
              checked={grantPermanent}
              onChange={(e) => setGrantPermanent(e.target.checked)}
            />
            <span>
              Permanent — never expires
              <small>Stays active until an administrator explicitly removes or changes it.</small>
            </span>
          </label>

          <label className="asp-field">
            <span>Reason (optional, shown in the change log)</span>
            <input
              type="text"
              maxLength={240}
              value={grantReason}
              onChange={(e) => setGrantReason(e.target.value)}
              placeholder="e.g. Support case #4821"
            />
          </label>

          <p className="asp-form__note">
            This is an <strong>admin override</strong>. The user&rsquo;s own paid subscription is kept
            untouched underneath, so “Restore original” can always put it back exactly as it was.
          </p>

          <div className="asp-form__actions">
            <button type="button" className="asp-btn" onClick={() => setShowGrantForm(false)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="asp-btn asp-btn--primary" disabled={busy || (!grantPermanent && !(Number(grantDays) > 0))}>
              {busyAction === 'grant' ? 'Granting…' : 'Apply override'}
            </button>
          </div>
        </form>
      )}

      {/* ── Paid-record actions (what the customer bought) ──────────── */}
      <div className="asp-paid-actions">
        <p className="asp-label">The user&rsquo;s own purchase</p>
        <div className="asp-paid-actions__row">
          <button
            type="button"
            className="asp-btn"
            // `seats` MUST be passed through: omitting it resets the count to 1,
            // so renewing a 10-seat account from here would silently halve it.
            onClick={() => run('setPaid', {
              plan: paid?.plan === 'free' ? 'annual' : paid.plan,
              days: 30,
              seats: Number(paid?.seats) || 1,
              note: 'Renewed by an administrator',
            })}
            disabled={busy}
          >
            {busyAction === 'setPaid' ? 'Working…' : 'Record a paid month'}
          </button>
          <button
            type="button"
            className="asp-btn"
            onClick={askCancelPaid}
            disabled={busy || !paid?.active}
          >
            Cancel paid plan
          </button>
        </div>

        {/* Seats. Only meaningful for a live paid plan: seats are what a Team
            subscription is, and an expired window grants nothing to share. */}
        {paid?.active && Number(paid?.seats) > 1 && (
          <div className="asp-seats">
            <label className="asp-field">
              <span>Seats (each a full Premium account)</span>
              <input
                type="number"
                min="1"
                max="500"
                value={seatInput}
                onChange={(e) => setSeatInput(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="asp-btn"
              onClick={() => run('setPaid', {
                plan: paid.plan,
                seats: Number(seatInput),
                // No `days`: this changes the seat count on the window that is
                // already paid for, it does not buy another month.
                note: `Seats changed from ${paid.seats} to ${Number(seatInput)} by an administrator`,
              })}
              disabled={busy || !seatInputValid}
            >
              {busyAction === 'setPaid' ? 'Saving…' : 'Update seats'}
            </button>
          </div>
        )}
      </div>

      {/* ── History ─────────────────────────────────────────────────── */}
      <details className="asp-history" open={false}>
        <summary>Change log ({detail.history.length})</summary>
        {detail.history.length === 0 ? (
          <p className="asp-history__empty">No subscription changes recorded yet.</p>
        ) : (
          <ol className="asp-history__list">
            {detail.history.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="asp-history__item">
                <span className="asp-history__action">{ACTION_COPY[entry.action] || entry.action}</span>
                <span className="asp-history__note">{entry.note}</span>
                <span className="asp-history__meta">
                  {entry.actor} · {formatStamp(entry.at)}
                  {entry.from && entry.to
                    ? ` · ${PLAN_LABELS[entry.from.plan] || 'FREE'} → ${PLAN_LABELS[entry.to.plan] || 'FREE'}`
                    : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
      </details>

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmText={confirm.confirmText}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
