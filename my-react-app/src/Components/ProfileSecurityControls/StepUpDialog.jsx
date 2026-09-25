/**
 * StepUpDialog — the "confirm it's really you" gate.
 *
 * A live session is not enough to change a security setting. Anything that
 * could hand an attacker lasting control (turning MFA off, minting recovery
 * codes, repointing recovery email, revoking devices) requires a fresh proof:
 * the account password, plus the authenticator code when that is the active
 * factor. The server issues a short-lived, session-bound token; we hold it in
 * component state for the duration of the flow and never persist it.
 */
import { useState } from 'react';
import { securityStepUp } from '../../api';
import './StepUpDialog.css';

// Rendered only while open, so the fields start empty every time without an
// effect that resets state (which just cascades an extra render on mount).
export default function StepUpDialog({ onClose, onVerified, needsTotp, reason }) {
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!password) {
      setError('Enter your current password.');
      return;
    }
    if (needsTotp && !/^\d{6}$/.test(otp)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const res = await securityStepUp(password, otp);
      onVerified(res.stepUp);
    } catch (err) {
      setError(err.message || 'Could not confirm your identity.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="psud-overlay" onClick={() => !busy && onClose()} role="presentation">
      <div
        className="psud"
        role="dialog"
        aria-modal="true"
        aria-labelledby="psud-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="psud__badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <rect x="9" y="11" width="6" height="5" rx="1" />
            <path d="M10 11V9.5a2 2 0 0 1 4 0V11" />
          </svg>
        </div>

        <h2 className="psud__title" id="psud-title">Confirm it&apos;s you</h2>
        <p className="psud__lede">
          {reason || 'For your protection, security changes need your password before they can be made.'}
        </p>

        <form onSubmit={submit} noValidate>
          {error && <p className="psud__error" role="alert">{error}</p>}

          <label className="psud__label" htmlFor="psud-pw">Current password</label>
          <input
            id="psud-pw"
            className="psud__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            autoFocus
          />

          {needsTotp && (
            <>
              <label className="psud__label" htmlFor="psud-otp">Authenticator code</label>
              <input
                id="psud-otp"
                className="psud__input psud__input--otp"
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                placeholder="000000"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </>
          )}

          <div className="psud__actions">
            <button type="button" className="psud__btn psud__btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="psud__btn psud__btn--primary" disabled={busy}>
              {busy ? 'Confirming…' : 'Confirm'}
            </button>
          </div>
        </form>

        <p className="psud__note">Your confirmation is valid for 5 minutes and only for this device.</p>
      </div>
    </div>
  );
}
