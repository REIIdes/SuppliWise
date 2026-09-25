/**
 * Account security controls — the things that are security decisions rather
 * than profile data.
 *
 * Why these were pulled out of the profile form:
 *
 *   • Changing a password is not "editing your profile". It used to live
 *     behind "Edit Profile" alongside name and date of birth, which meant a
 *     user who only wanted a strong new password had to also satisfy every
 *     profile field, and the strength rules looked like form validation for
 *     their name.
 *   • "When did I last change this?" is information, not an input. It belongs
 *     on screen permanently, not behind a toggle.
 *   • "Sign out everywhere else" and "which second factor do I use" are account
 *     actions. Burying them in a profile form hides them from exactly the
 *     person who needs them during a suspected compromise.
 *
 * All three cards are self-contained: this component owns its own form state
 * and calls the API directly, so ProfilePage only has to hand down the facts
 * it already loads and a way to refresh them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { changePassword, getSecuritySummary, setTwoFactorMethod } from '../../api';
import StepUpDialog from './StepUpDialog';
import { BackupCodesCard, RecoveryEmailCard } from './RecoveryPanel';
import SessionActivity from './SessionActivity';
import './ProfileSecurityControls.css';

const METHODS = [
  {
    id: 'authenticator',
    label: 'Authenticator app',
    blurb: 'A 6-digit code from Google Authenticator or any TOTP app.',
    strength: 'Strongest',
    tone: 'strong',
  },
  {
    id: 'email',
    label: 'Email codes',
    blurb: 'A 6-digit code sent to the address on your account.',
    strength: 'Weaker',
    tone: 'weak',
  },
];

/** "3 days ago" / "on 12 Mar 2026" — the relative form for recent changes,
 *  absolute once it's old enough that relative stops being useful. */
function changedAgoLabel(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  return `on ${then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function Row({ icon, children }) {
  return (
    <div className="psc-row">
      <span className="psc-row__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {icon}
        </svg>
      </span>
      <span className="psc-row__body">{children}</span>
    </div>
  );
}

const ShieldIcon = <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />;
const ClockIcon = <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>;
const MailIcon = <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="m2 7 10 6 10-6" /></>;
const KeyIcon = <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9 2 2-2 2 2 2-3 3-2-2-2 2" /></>;

export default function ProfileSecurityControls({
  twoFactorEnabled = false,
  twoFactorMethod = null,
  passwordChangedAt = null,
  onSecurityChange,
  onStartAuthenticatorSetup,
  onDisableTwoFactor,
}) {
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwDone, setPwDone] = useState('');

  const [methodBusy, setMethodBusy] = useState(false);
  const [methodError, setMethodError] = useState('');
  const [showEmailConfirm, setShowEmailConfirm] = useState(false);
  const [downgradePassword, setDowngradePassword] = useState('');

  const changedLabel = useMemo(() => changedAgoLabel(passwordChangedAt), [passwordChangedAt]);
  // A stored date with no value means the account predates the field.
  const neverChanged = !changedLabel;

  const activeMethod = twoFactorEnabled ? (twoFactorMethod || 'authenticator') : null;

  // ── Dashboard data + step-up orchestration ─────────────────────────────
  // summary is the single server-authoritative read for the 2FA state, backup
  // codes, recovery email and device counts, so the cards cannot disagree with
  // each other or with the server.
  const [summary, setSummary] = useState(null);
  const [pending, setPending] = useState(null); // { reason, action }
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const refreshSummary = useCallback(async () => {
    try {
      const data = await getSecuritySummary();
      if (!mounted.current) return;
      setSummary(data);
      onSecurityChange?.();
    } catch {
      // Leave the last good values on screen rather than blanking the page.
    }
  }, [onSecurityChange]);

  // Deferred a tick so the fetch is not dispatched synchronously from the
  // effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    const timer = setTimeout(() => { void refreshSummary(); }, 0);
    return () => clearTimeout(timer);
  }, [refreshSummary]);

  // onRequireStepUp({ reason, action }) — shows the confirm dialog, then runs
  // `action` with a short-lived, session-bound step-up token.
  const requireStepUp = useCallback(({ reason, action }) => {
    setPending({ reason, action });
  }, []);

  const handleVerified = (stepUp) => {
    const action = pending?.action;
    setPending(null);
    if (action) action(stepUp);
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    const currentPassword = pw.currentPassword;
    const newPassword = pw.newPassword;

    if (!currentPassword) { setPwError('Enter your current password.'); return; }
    if (newPassword.length < 8) { setPwError('New password must be at least 8 characters.'); return; }
    if (!/[A-Z]/.test(newPassword)) { setPwError('New password must contain at least one uppercase letter.'); return; }
    if (!/[0-9]/.test(newPassword)) { setPwError('New password must contain at least one number.'); return; }
    if (newPassword !== pw.confirmPassword) { setPwError('The two new passwords do not match.'); return; }
    if (newPassword === currentPassword) { setPwError('Your new password must be different from the current one.'); return; }

    setPwError('');
    setPwDone('');
    setPwBusy(true);
    try {
      const res = await changePassword(currentPassword, newPassword);
      setPw({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setPwDone(res.message || 'Your password has been updated.');
      onSecurityChange?.();
    } catch (err) {
      setPwError(err.message || 'Unable to change your password.');
    } finally {
      setPwBusy(false);
    }
  };

  // "Sign out all other devices" now lives in SessionActivity, which lists the
  // devices and can revoke them individually as well as in bulk. The old
  // standalone card was removed rather than left duplicated.

  const applyMethod = async (method, currentPassword = '') => {
    setMethodError('');
    setMethodBusy(true);
    try {
      const res = await setTwoFactorMethod(method, currentPassword);
      setShowEmailConfirm(false);
      setDowngradePassword('');
      onSecurityChange?.(res);
    } catch (err) {
      setMethodError(err.message || 'Unable to change your second factor.');
    } finally {
      setMethodBusy(false);
    }
  };

  return (
    <div className="psc-stack">
      {/* ── Second factor ────────────────────────────────────────────── */}
      <section className="psc-card" aria-labelledby="psc-2fa-title">
        <header className="psc-card__head">
          <h3 className="psc-card__title" id="psc-2fa-title">
            <span className="psc-card__icon psc-card__icon--shield" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{ShieldIcon}</svg>
            </span>
            Two-Factor Authentication
          </h3>
          <span className={`psc-badge${twoFactorEnabled ? ' psc-badge--on' : ''}`}>
            {twoFactorEnabled ? 'On' : 'Off'}
          </span>
        </header>

        <p className="psc-card__lede">
          {twoFactorEnabled
            ? 'A second code is required at sign-in, so a stolen password alone is not enough to get in.'
            : 'Add a second step at sign-in so a stolen password alone is not enough to get in.'}
        </p>

        {methodError && <p className="psc-alert psc-alert--error" role="alert">{methodError}</p>}

        <div className="psc-methods" role="radiogroup" aria-label="Second factor method">
          {METHODS.map((m) => {
            const selected = activeMethod === m.id;
            // Turning the authenticator ON still has to go through setup —
            // that's what proves the person owns the app. Accounts on email
            // count too: choosing email clears the TOTP secret server-side, so
            // there is no working authenticator to go back to without setting
            // one up again.
            const needsSetup = m.id === 'authenticator' && (!twoFactorEnabled || activeMethod === 'email');
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={methodBusy}
                className={`psc-method${selected ? ' psc-method--selected' : ''}`}
                onClick={() => {
                  if (selected) return;
                  if (needsSetup) { onStartAuthenticatorSetup?.(); return; }
                  // Choosing email over a live authenticator removes a stronger
                  // factor, so it gets a password prompt first.
                  if (m.id === 'email' && twoFactorEnabled) { setShowEmailConfirm(true); return; }
                  applyMethod(m.id);
                }}
              >
                <span className={`psc-method__icon psc-method__icon--${m.id}`} aria-hidden="true">
                  {m.id === 'email'
                    ? <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{MailIcon}</svg>
                    : <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{KeyIcon}</svg>}
                </span>
                <span className="psc-method__text">
                  <span className="psc-method__label">
                    {m.label}
                    {m.tone === 'weak' && <span className="psc-method__warn">{m.strength}</span>}
                  </span>
                  <span className="psc-method__blurb">{needsSetup ? 'Set up an app to turn on two-factor.' : m.blurb}</span>
                </span>
                <span className="psc-method__tick" aria-hidden="true">
                  {selected
                    ? <svg viewBox="0 0 20 20" width="14" height="14" fill="none"><path d="M4.5 10.5l3.4 3.4 7.6-7.8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    : null}
                </span>
              </button>
            );
          })}
        </div>

        {twoFactorEnabled && activeMethod === 'email' && (
          <p className="psc-note psc-note--warn">
            <strong>Email codes are the weaker option.</strong> They protect your password, but not
            an attacker who already has access to your inbox.
          </p>
        )}

        {showEmailConfirm && (
          <div className="psc-confirm" role="group" aria-label="Confirm switching to email codes">
            <p className="psc-confirm__text">
              Switching to email codes removes your authenticator app as the second factor.
              Confirm with your current password.
            </p>
            <label className="psc-label" htmlFor="psc-downgrade-pw">Current password</label>
            <input
              id="psc-downgrade-pw"
              className="psc-input"
              type="password"
              autoComplete="current-password"
              value={downgradePassword}
              onChange={(e) => setDowngradePassword(e.target.value)}
              placeholder="Your current password"
            />
            <div className="psc-confirm__actions">
              <button type="button" className="psc-btn psc-btn--primary" disabled={methodBusy || !downgradePassword} onClick={() => applyMethod('email', downgradePassword)}>
                {methodBusy ? 'Switching…' : 'Switch to email codes'}
              </button>
              <button type="button" className="psc-btn psc-btn--ghost" disabled={methodBusy} onClick={() => { setShowEmailConfirm(false); setDowngradePassword(''); }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {twoFactorEnabled && onDisableTwoFactor && (
          <button type="button" className="psc-btn psc-btn--danger-ghost" onClick={onDisableTwoFactor}>
            Turn off two-factor authentication
          </button>
        )}
      </section>

      {/* ── Password ─────────────────────────────────────────────────── */}
      <section className="psc-card" aria-labelledby="psc-pw-title">
        <header className="psc-card__head">
          <h3 className="psc-card__title" id="psc-pw-title">
            <span className="psc-card__icon psc-card__icon--key" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{KeyIcon}</svg>
            </span>
            Change Password
          </h3>
        </header>

        <p className="psc-card__lede">
          Choose something you don&apos;t use anywhere else. Changing it signs out your other devices.
        </p>

        <Row icon={ClockIcon}>
          <span className="psc-row__label">Last password changed</span>
          <span className={`psc-row__value${neverChanged ? ' psc-row__value--muted' : ''}`}>
            {neverChanged ? 'Never recorded' : changedLabel}
            {passwordChangedAt && !neverChanged && (
              <span className="psc-row__exact">
                {' '}({new Date(passwordChangedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })})
              </span>
            )}
          </span>
        </Row>

        {pwError && <p className="psc-alert psc-alert--error" role="alert">{pwError}</p>}
        {pwDone && <p className="psc-alert psc-alert--ok" role="status">{pwDone}</p>}

        <form className="psc-form" onSubmit={handleChangePassword} noValidate>
          <div className="psc-field">
            <label className="psc-label" htmlFor="psc-current-pw">Current password</label>
            <input
              id="psc-current-pw"
              className="psc-input"
              type="password"
              autoComplete="current-password"
              value={pw.currentPassword}
              onChange={(e) => { setPw({ ...pw, currentPassword: e.target.value }); setPwError(''); }}
              required
            />
          </div>

          <div className="psc-field">
            <label className="psc-label" htmlFor="psc-new-pw">New password</label>
            <input
              id="psc-new-pw"
              className="psc-input"
              type="password"
              autoComplete="new-password"
              value={pw.newPassword}
              onChange={(e) => { setPw({ ...pw, newPassword: e.target.value }); setPwError(''); }}
              aria-describedby="psc-pw-rules"
              required
            />
            <p className="psc-rules" id="psc-pw-rules">
              At least 8 characters, including an uppercase letter and a number.
            </p>
          </div>

          <div className="psc-field">
            <label className="psc-label" htmlFor="psc-confirm-pw">Confirm new password</label>
            <input
              id="psc-confirm-pw"
              className="psc-input"
              type="password"
              autoComplete="new-password"
              value={pw.confirmPassword}
              onChange={(e) => { setPw({ ...pw, confirmPassword: e.target.value }); setPwError(''); }}
              required
            />
          </div>

          <button type="submit" className="psc-btn psc-btn--primary" disabled={pwBusy}>
            {pwBusy ? 'Updating…' : 'Change password'}
          </button>
        </form>
      </section>

      {/* ── Recovery & Authentication ──────────────────────────────────── */}
      <BackupCodesCard summary={summary} onRequireStepUp={requireStepUp} onChanged={refreshSummary} />
      <RecoveryEmailCard summary={summary} onRequireStepUp={requireStepUp} onChanged={refreshSummary} />

      {/* ── Sessions & Activity ─────────────────────────────────────────── */}
      <SessionActivity onRequireStepUp={requireStepUp} onChanged={refreshSummary} />

      {pending && (
        <StepUpDialog
          needsTotp={twoFactorEnabled && activeMethod === 'authenticator'}
          reason={pending.reason}
          onClose={() => setPending(null)}
          onVerified={handleVerified}
        />
      )}
    </div>
  );
}
