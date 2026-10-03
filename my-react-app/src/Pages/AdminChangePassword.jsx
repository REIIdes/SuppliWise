import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { BASE_URL, parseJSON, getPasswordRules } from '../api';
import { FALLBACK_RULES, evaluate } from '../utils/passwordPolicy';
import './AdminLogin.css';
import './AdminChangePassword.css';

// The admin is signed in but held here until the account's password belongs to
// the person holding it.
//
// The server enforces the same rule (middleware/auth.js refuses every
// /api/admin route except the change itself with PASSWORD_CHANGE_REQUIRED), so
// this screen is the friendly face of a lock that already exists, not the lock.
// Navigating straight to /admin lands on that error instead — by design.
const AdminChangePassword = () => {
  const navigate = useNavigate();

  // No admin token means there is nothing to change a password FOR. Without
  // this the screen renders happily on a cold visit and only fails on submit.
  useEffect(() => {
    if (!localStorage.getItem('adminToken')) navigate('/admin/login', { replace: true });
  }, [navigate]);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [otp, setOtp] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState(FALLBACK_RULES);

  // Read the alias the admin signed in with. This is display only; every
  // decision that matters comes back from the server.
  //
  // Lazy initial state, not an effect: localStorage is read once here and can
  // never change for the life of this screen (nothing calls a setter, and the
  // alias only changes by a re-login, which remounts this route anyway). Doing
  // it in an effect meant rendering an empty card and then re-rendering a
  // second time to fill in a value that was available before the first paint.
  const [alias] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('admin') || '{}').alias || '';
    } catch {
      return '';
    }
  });

  // The policy the SERVER enforces, so the checklist and the verdict cannot
  // disagree. The fallback is only what renders if this request fails.
  useEffect(() => {
    let cancelled = false;
    getPasswordRules()
      .then((r) => { if (!cancelled && r?.checks?.length) setRules(r); })
      .catch(() => { /* keep FALLBACK_RULES */ });
    return () => { cancelled = true; };
  }, []);

  const verdict = evaluate(next, rules);
  const mismatch = confirm.length > 0 && next !== confirm;
  const sameAsCurrent = next.length > 0 && next === current;
  const otpValid = /^\d{6}$/.test(otp);

  const canSubmit = Boolean(current) && verdict.ok && Boolean(confirm) && !mismatch && !sameAsCurrent && otpValid && !busy;

  const submit = useCallback(async (e) => {
    e.preventDefault();
    if (mismatch) { setError('The two new passwords do not match.'); return; }
    if (sameAsCurrent) { setError('Choose a password different from your current one.'); return; }
    if (!verdict.ok) { setError(verdict.message || 'That password does not meet the requirements.'); return; }
    if (!otpValid) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    setError('');
    setBusy(true);
    try {
      const res = await fetch(`${BASE_URL}/admin/profile/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('adminToken')}` },
        body: JSON.stringify({ currentPassword: current, newPassword: next, otp }),
      });
      const data = await parseJSON(res);

      if (res.status === 401) {
        // 401 is AMBIGUOUS here, and treating it as one thing is a trap.
        //
        // This endpoint returns 401 for a wrong current password and a wrong
        // authenticator code — both ordinary user errors, reported identically
        // to a real session expiry. The session codes below are what the
        // middleware attaches when the token is genuinely dead, so they are the
        // only safe signal to sign out on.
        //
        // Reading every 401 as an expiry meant one mistyped authenticator code
        // discarded a perfectly good admin token and threw the user back to the
        // sign-in page to re-enter the very password they had just typed
        // correctly — and, because the flag was still set, to land right back
        // here. A single typo became an unwinnable loop.
        const sessionGone = ['NO_SESSION', 'INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(data?.code);
        if (sessionGone) {
          localStorage.removeItem('adminToken');
          localStorage.removeItem('admin');
          navigate('/admin/login', { replace: true });
          return;
        }
        setError(data?.message || 'Unable to change the password.');
        return;
      }
      if (!res.ok) {
        // A 403 here means the flag is STILL set, so this account stays parked
        // on this screen — report it and stay, rather than bouncing to a
        // dashboard the server will refuse.
        setError(data?.message || 'Unable to change the password.');
        return;
      }

      // The stored session is what AdminProtectedRoute reads to decide whether
      // to allow the dashboard. Clearing the flag here is what stops this page
      // from being its own redirect loop.
      try {
        const stored = JSON.parse(localStorage.getItem('admin') || '{}');
        localStorage.setItem('admin', JSON.stringify({ ...stored, mustChangePassword: false }));
      } catch { /* the server flag is authoritative either way */ }
      setCurrent(''); setNext(''); setConfirm(''); setOtp('');
      navigate('/admin', { replace: true });
    } catch (err) {
      setError(err?.message === 'Failed to fetch'
        ? 'Cannot reach the server. Check your connection and try again.'
        : (err?.message || 'Unable to change the password.'));
    } finally {
      setBusy(false);
    }
  }, [current, next, otp, mismatch, sameAsCurrent, verdict, otpValid, navigate]);

  const signOut = useCallback(() => {
    localStorage.removeItem('adminToken');
    localStorage.removeItem('admin');
    navigate('/admin/login', { replace: true });
  }, [navigate]);

  return (
    <div className="al-page">
      <div className="al-left" aria-hidden="true">
        <span className="al-orb al-orb--1" />
        <span className="al-orb al-orb--2" />
        <span className="al-orb al-orb--3" />
        <div className="al-left__inner">
          <span className="al-logo">
            <span className="al-logo__mark" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M12 2 4 5.5v6c0 4.5 3.2 8.4 8 10.5 4.8-2.1 8-6 8-10.5v-6L12 2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                <path d="M9 12.2l2.2 2.2L15.5 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="al-logo__name">SuppliWise</span>
          </span>
          <div className="al-left__copy">
            <p className="al-eyebrow">One more step</p>
            <h1 className="al-left__heading">Secure your account</h1>
            <p className="al-left__sub">
              You signed in with a temporary password. Choose your own before using
              the control panel.
            </p>
          </div>
        </div>
      </div>

      <div className="al-right">
        <form className="al-card" onSubmit={submit} noValidate>
          <header className="al-card__head">
            <h2 className="al-card__title">Set your password</h2>
            {alias ? <p className="al-card__sub">Signed in as <strong>{alias}</strong></p> : null}
          </header>

          {error ? <p className="al-error" role="alert">{error}</p> : null}

          <label className="al-field">
            <span className="al-field__label">Temporary password</span>
            <span className="al-input-wrap">
              <input
                type={showCurrent ? 'text' : 'password'}
                className="al-input"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
                disabled={busy}
              />
              <button
                type="button"
                className="al-input-wrap__btn"
                onClick={() => setShowCurrent((v) => !v)}
                aria-label={showCurrent ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >{showCurrent ? 'Hide' : 'Show'}</button>
            </span>
          </label>

          <label className="al-field">
            <span className="al-field__label">New password</span>
            <span className="al-input-wrap">
              <input
                type={showNext ? 'text' : 'password'}
                className="al-input"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                required
                disabled={busy}
              />
              <button
                type="button"
                className="al-input-wrap__btn"
                onClick={() => setShowNext((v) => !v)}
                aria-label={showNext ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >{showNext ? 'Hide' : 'Show'}</button>
            </span>
          </label>

          {/* aria-live: this re-renders on every keystroke, so it must not
              interrupt a screen reader mid-word. */}
          <div className="al-strength" aria-live="polite">
            <span className="al-strength__meter" data-score={verdict.score}>
              <i style={{ width: `${(verdict.score / 4) * 100}%` }} />
            </span>
            <span className="al-strength__label">{verdict.scoreLabel}</span>
          </div>

          <ul className="al-checks">
            {verdict.checks.map((c) => (
              <li key={c.id} className={c.ok ? 'al-check al-check--met' : 'al-check'}>
                <span className="al-check__icon" aria-hidden="true">{c.ok ? '✓' : '•'}</span>
                <span>{c.label}</span>
              </li>
            ))}
          </ul>

          {sameAsCurrent ? (
            <p className="al-hint al-hint--bad">This is your current password — choose a different one.</p>
          ) : null}

          <label className="al-field">
            <span className="al-field__label">Confirm new password</span>
            <input
              type="password"
              className="al-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              disabled={busy}
            />
            {mismatch ? <span className="al-hint al-hint--bad">The two passwords do not match.</span> : null}
          </label>

          <label className="al-field">
            <span className="al-field__label">Authenticator code</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="al-input al-input--code"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              required
              disabled={busy}
            />
            <span className="al-hint">The current code from your authenticator app, to confirm it is you.</span>
          </label>

          <button type="submit" className="al-submit" disabled={!canSubmit}>
            {busy ? 'Saving…' : 'Set password and continue'}
          </button>
          <button type="button" className="al-ghost" onClick={signOut} disabled={busy}>
            Sign out instead
          </button>
        </form>
      </div>
    </div>
  );
};

export default AdminChangePassword;
