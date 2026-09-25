/**
 * Sessions & Activity — the signed-in devices list and the login/security
 * history, both read from /api/security.
 *
 * The history is server-structured (an event type + success flag), NOT the
 * notification-title string matching this page used before — which silently
 * dropped any event whose wording changed and could not show a failure.
 *
 * Wording is deliberately even-handed. A failed sign-in is recorded as a
 * failed sign-in; nothing here claims an attack happened, because a wrong
 * password is not evidence of one.
 */
import { useCallback, useEffect, useState } from 'react';
import { getSecurityDevices, getSecurityEvents, revokeSecurityDevice, revokeOtherSecurityDevices } from '../../api';
import './SessionActivity.css';

const EVENT_LABELS = {
  'login-success': 'Signed in',
  'unrecognized-login': 'Signed in from a new device',
  'login-failure': 'Failed sign-in',
  'mfa-success': 'Second factor accepted',
  'mfa-failure': 'Second factor rejected',
  'mfa-enabled': 'Two-factor enabled',
  'mfa-disabled': 'Two-factor disabled',
  'password-changed': 'Password changed',
  'password-change-failed': 'Incorrect password',
  'backup-codes-generated': 'Recovery codes created',
  'backup-codes-invalidated': 'Recovery codes invalidated',
  'backup-code-used': 'Recovery code used',
  'session-revoked': 'Session revoked',
  'sessions-revoked-all': 'All other sessions signed out',
  'device-trust-revoked': 'Device removed',
  'recovery-email-changed': 'Recovery email changed',
  'account-locked': 'Sign-in temporarily paused',
};

// Events worth drawing the eye to. Neutral phrasing: these are notable, not
// proven malicious.
const NOTABLE = new Set(['unrecognized-login', 'mfa-failure', 'account-locked', 'backup-code-used', 'password-changed', 'mfa-disabled', 'recovery-email-changed']);

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)} d ago`;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function SessionActivity({ onRequireStepUp, onChanged }) {
  const [devices, setDevices] = useState([]);
  const [note, setNote] = useState('');
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [d, e] = await Promise.all([getSecurityDevices(), getSecurityEvents(100)]);
      setDevices(d.devices || []);
      setNote(d.note || '');
      setEvents(e.events || []);
      setError('');
    } catch (err) {
      setError(err.message || 'Could not load your security activity.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Deferred by a tick so the initial load is not dispatched synchronously from
  // the effect body (react-hooks/set-state-in-effect); the state updates belong
  // to the fetch, not to the commit.
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const revoke = (id, label) => onRequireStepUp({
    reason: `Signing out "${label}" removes its access, so we need to confirm it is you.`,
    action: async (stepUp) => {
      await revokeSecurityDevice(id, stepUp);
      await load();
      onChanged?.();
    },
  });

  const revokeOthers = () => onRequireStepUp({
    reason: 'Signing out your other devices removes their access, so we need to confirm it is you.',
    action: async (stepUp) => {
      await revokeOtherSecurityDevices(stepUp);
      await load();
      onChanged?.();
    },
  });

  const visible = showAll ? events : events.slice(0, 8);

  return (
    <>
      <section className="psc-card" aria-labelledby="psc-devices-title">
        <header className="psc-card__head">
          <h3 className="psc-card__title" id="psc-devices-title">
            <span className="psc-card__icon psc-card__icon--devices" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="14" height="10" rx="2" />
                <path d="M6 20h6M9 14v6" />
                <path d="M20 8v6a2 2 0 0 1-2 2h-2" />
              </svg>
            </span>
            Signed-in Devices
          </h3>
          <span className="psc-badge psc-badge--on">{devices.length} active</span>
        </header>

        {note && <p className="psc-note">{note}</p>}
        {error && <p className="psc-alert psc-alert--error" role="alert">{error}</p>}

        {loading ? (
          <p className="psc-muted">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="psc-muted">No active sessions found.</p>
        ) : (
          <ul className="psc-devices">
            {devices.map((d) => (
              <li key={d.id} className="psc-device">
                <div className="psc-device__main">
                  <span className="psc-device__label">
                    {d.label}
                    {d.isCurrent && <span className="psc-chip psc-chip--current">This device</span>}
                    {d.isTrusted && <span className="psc-chip">Saved login</span>}
                  </span>
                  <span className="psc-device__meta">
                    {d.location || 'Unknown location'}
                    {d.ip ? ` · ${d.ip}` : ''}
                  </span>
                  <span className="psc-device__times">
                    Signed in {when(d.createdAt)} · Last active {when(d.lastActiveAt)}
                  </span>
                </div>
                {!d.isCurrent && (
                  <button
                    type="button"
                    className="psc-btn psc-btn--outline psc-btn--sm"
                    onClick={() => revoke(d.id, d.label)}
                  >
                    Sign out
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {devices.length > 1 && (
          <button type="button" className="psc-btn psc-btn--outline psc-btn--mt" onClick={revokeOthers}>
            Sign out all other devices
          </button>
        )}
      </section>

      <section className="psc-card" aria-labelledby="psc-activity-title">
        <header className="psc-card__head">
          <h3 className="psc-card__title" id="psc-activity-title">
            <span className="psc-card__icon psc-card__icon--shield" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            </span>
            Login &amp; Security Activity
          </h3>
        </header>

        {loading ? (
          <p className="psc-muted">Loading…</p>
        ) : events.length === 0 ? (
          <p className="psc-muted">
            No activity recorded yet. Sign-ins, failed attempts and security changes appear here.
          </p>
        ) : (
          <>
            <ul className="psc-events">
              {visible.map((e) => (
                <li key={e.id} className={`psc-event${e.success ? '' : ' psc-event--failed'}${NOTABLE.has(e.type) ? ' psc-event--notable' : ''}`}>
                  <span className="psc-event__dot" aria-hidden="true" />
                  <div className="psc-event__body">
                    <span className="psc-event__name">
                      {EVENT_LABELS[e.type] || 'Security event'}
                      {!e.success && <span className="psc-event__status">failed</span>}
                    </span>
                    {e.reason && <span className="psc-event__reason">{e.reason}</span>}
                    <span className="psc-event__meta">
                      {when(e.createdAt)}
                      {e.location ? ` · ${e.location}` : ''}
                      {e.ip ? ` · ${e.ip}` : ''}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            {events.length > 8 && (
              <button type="button" className="psc-btn psc-btn--ghost psc-btn--mt" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show less' : `View all ${events.length} events`}
              </button>
            )}
          </>
        )}
      </section>
    </>
  );
}
