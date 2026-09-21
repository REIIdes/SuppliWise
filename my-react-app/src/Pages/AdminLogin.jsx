import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BASE_URL, parseJSON } from '../api';
import './AdminLogin.css';

function AdminLoginEyeIcon({ open }) {
  return open ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  );
}

function AdminLogin() {
  const navigate = useNavigate();
  const [alias, setAlias]               = useState('');
  const [password, setPassword]         = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [otp, setOtp]                   = useState('');
  const [challengeId, setChallengeId]   = useState('');
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(false);

  useEffect(() => {
    if (localStorage.getItem('adminToken')) navigate('/admin', { replace: true });
  }, [navigate]);

  /* ── Step 1: alias + password ───────────────────────────────────── */
  const submitCredentials = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res  = await fetch(`${BASE_URL}/auth/admin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias, password }),
      });
      const data = await parseJSON(res);
      if (!res.ok) throw new Error(data?.message || 'Admin sign in failed.');
      setChallengeId(data.challengeId);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  /* ── Step 2: TOTP code ──────────────────────────────────────────── */
  const submitOtp = async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(otp)) return setError('Enter the 6-digit authenticator code.');
    setError('');
    setLoading(true);
    try {
      const res  = await fetch(`${BASE_URL}/auth/verify-admin-2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId, otp }),
      });
      const data = await parseJSON(res);
      if (!res.ok) throw new Error(data?.message || 'Verification failed.');
      try {
        const leg = localStorage.getItem('token');
        if (leg && JSON.parse(atob(leg.split('.')[1]))?.role === 'admin')
          localStorage.removeItem('token');
      } catch { /* ignore */ }
      localStorage.setItem('adminToken', data.token);
      localStorage.setItem('admin', JSON.stringify({ role: 'admin', alias: data.alias }));
      navigate('/admin');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // (password visibility icon lives at module scope as AdminLoginEyeIcon)

  return (
    <div className="al-page">

      {/* ── Left dark branding panel ──────────────────────── */}
      <div className="al-left" aria-hidden="true">
        <div className="al-left__inner">

          <div className="al-logo">
            <svg width="38" height="38" viewBox="0 0 100 100" fill="none">
              <rect width="100" height="100" rx="22" fill="#d46b35"/>
              <g transform="rotate(-40,50,50)">
                <rect x="22" y="36" width="56" height="28" rx="14"
                      fill="none" stroke="white" strokeWidth="6"/>
                <line x1="50" y1="36" x2="50" y2="64" stroke="white" strokeWidth="6"/>
              </g>
            </svg>
            <span className="al-logo__name">SuppliWise</span>
          </div>

          <div className="al-left__copy">
            <h1 className="al-left__heading">Control Panel</h1>
            <p className="al-left__sub">
              Secure administrative access for authorised personnel only.
            </p>
          </div>

          <div className="al-shield">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>

        </div>
      </div>

      {/* ── Right form panel ─────────────────────────────── */}
      <div className="al-right">
        <form
          className="al-card"
          onSubmit={challengeId ? submitOtp : submitCredentials}
          noValidate
        >
          <div className="al-card__header">
            <span className="al-kicker">SUPPLIWISE CONTROL PANEL</span>
            <h2 className="al-card__title">
              {challengeId ? 'Two-factor verification' : 'Admin access'}
            </h2>
            <p className="al-card__sub">
              {challengeId
                ? 'Open Google Authenticator and enter the current 6-digit code.'
                : 'This area is restricted to authorised administrators.'}
            </p>
          </div>

          {error && (
            <div className="al-error" role="alert">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              {error}
            </div>
          )}

          {!challengeId ? (
            <>
              <div className="al-field">
                <label htmlFor="al-alias">Admin alias</label>
                <input
                  id="al-alias"
                  type="text"
                  value={alias}
                  onChange={e => setAlias(e.target.value)}
                  placeholder="Enter your alias"
                  autoComplete="username"
                  required
                />
              </div>

              <div className="al-field">
                <label htmlFor="al-password">Secret password</label>
                <div className="al-input-wrap">
                  <input
                    id="al-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    className="al-eye"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    <AdminLoginEyeIcon open={showPassword} />
                  </button>
                </div>
              </div>

              <button className="al-submit" disabled={loading}>
                {loading
                  ? <><span className="al-spinner" aria-hidden="true"/> Checking credentials…</>
                  : <>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                      </svg>
                      Continue securely
                    </>
                }
              </button>
            </>
          ) : (
            <>
              <div className="al-totp-info">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
                  <line x1="12" y1="18" x2="12.01" y2="18"/>
                </svg>
                <span>Open your authenticator app and enter the current code.</span>
              </div>

              <div className="al-field">
                <label htmlFor="al-otp">6-digit code</label>
                <input
                  id="al-otp"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength="6"
                  value={otp}
                  onChange={e => { setOtp(e.target.value.replace(/\D/g, '')); setError(''); }}
                  placeholder="• • • • • •"
                  className="al-otp-input"
                  autoFocus
                  required
                />
              </div>

              <button className="al-submit" disabled={loading || otp.length !== 6}>
                {loading
                  ? <><span className="al-spinner" aria-hidden="true"/> Verifying…</>
                  : <>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                      Open dashboard
                    </>
                }
              </button>

              <button
                type="button"
                className="al-back"
                onClick={() => { setChallengeId(''); setOtp(''); setError(''); }}
              >
                ← Back to credentials
              </button>
            </>
          )}

          <div className="al-footer">
            <button type="button" className="al-return" onClick={() => navigate('/login')}>
              Return to user login
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AdminLogin;
