import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { requestPasswordReset } from '../api';
import './PasswordReset.css';

// Matches the client's own address check. The server validates independently —
// this exists only so a typo is caught before a round trip, never as a
// substitute for it.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
// Mirror of the per-account cooldown in server/utils/passwordReset.js. The
// server suppresses rather than rejects while cooling down (a 429 here would
// tell an enumerator the address has an account), so the client is the only
// place the wait can be communicated — which makes this timer load-bearing,
// not decoration.
const RESEND_COOLDOWN_SECONDS = 60;

function Icon({ name }) {
  if (name === 'mail') {
    return (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </svg>
    );
  }
  if (name === 'check') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  if (name === 'error') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
    );
  }
  return null;
}

function ForgotPassword() {
  const [searchParams] = useSearchParams();
  // Pre-filled from the sign-in page, so a user who misspelled their address
  // can correct it here instead of starting over.
  const [email, setEmail] = useState(() => (searchParams.get('email') || '').trim().slice(0, 254));
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // Held in a ref, not state: resetting it must not re-render. The interval is
  // cleared on unmount so a countdown cannot outlive the page and keep ticking
  // against a dead component.
  const timerRef = useRef(null);
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const startCooldown = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    timerRef.current = setInterval(() => {
      setCooldown((seconds) => {
        if (seconds <= 1) {
          clearInterval(timerRef.current);
          timerRef.current = null;
          return 0;
        }
        return seconds - 1;
      });
    }, 1000);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    const trimmed = email.trim();
    if (!trimmed) {
      setError('Please enter your email address.');
      return;
    }
    if (!EMAIL_REGEX.test(trimmed)) {
      setError('Please enter a valid email address (e.g. name@example.com).');
      return;
    }

    setLoading(true);
    try {
      const data = await requestPasswordReset(trimmed);
      setSent(true);
      setMessage(data?.message || 'If an account exists for that address, a reset link is on its way.');
      startCooldown();
    } catch (err) {
      setError(err.message || 'We could not send your reset link. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Sent ───────────────────────────────────────────────────────────────
  if (sent) {
    return (
      <div className="pwreset-page">
        <Navbar />
        <main className="pwreset-card">
          <div className="pwreset-badge" aria-hidden="true"><Icon name="mail" /></div>
          <h1 className="pwreset-title">Check your email</h1>
          <p className="pwreset-subtitle">{message}</p>

          <div className="pwreset-inbox">
            <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>We sent the link to</p>
            <span className="pwreset-inbox-address">{email.trim()}</span>
            <p className="pwreset-inbox-note">
              The link works once and expires in 30 minutes.<br />
              Nothing arrived? Look in your spam folder, or send another.
            </p>
          </div>

          <button
            type="button"
            className="pwreset-btn pwreset-btn-secondary"
            onClick={handleSubmit}
            disabled={loading || cooldown > 0}
          >
            {loading
              ? 'Sending…'
              : cooldown > 0
                ? `Send another link (${cooldown}s)`
                : 'Send another link'}
          </button>

          <Link className="pwreset-back" to="/login">Back to sign in</Link>

          <p className="pwreset-footnote">
            For your security we show the same confirmation whether or not an account exists.
          </p>
        </main>
      </div>
    );
  }

  // ── Ask ────────────────────────────────────────────────────────────────
  return (
    <div className="pwreset-page">
      <Navbar />
      <main className="pwreset-card">
        <div className="pwreset-badge is-muted" aria-hidden="true"><Icon name="mail" /></div>
        <h1 className="pwreset-title">Reset your password</h1>
        <p className="pwreset-subtitle">
          Enter the email address on your account and we&apos;ll send you a link to choose a new password.
        </p>

        {error && (
          <div className="pwreset-alert is-error" role="alert">
            <Icon name="error" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="pwreset-field">
            <label htmlFor="pwreset-email">Email address</label>
            <input
              id="pwreset-email"
              name="email"
              type="email"
              className="pwreset-input"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              placeholder="you@example.com"
              autoComplete="email"
              // Not readOnly: browsers do not offer a password-manager entry
              // for a readOnly field, which is exactly what we want here.
              readOnly={false}
              disabled={loading}
              maxLength={254}
              autoFocus
            />
          </div>

          <button type="submit" className="pwreset-btn pwreset-btn-primary" disabled={loading}>
            {loading ? 'Sending…' : 'Send reset link'}
          </button>
        </form>

        <Link className="pwreset-back" to="/login">Back to sign in</Link>
      </main>
    </div>
  );
}

export default ForgotPassword;
