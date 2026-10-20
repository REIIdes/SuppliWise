import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import {
  completePasswordReset,
  getPasswordRules,
  redeemPasswordResetCode,
  validatePasswordResetToken,
} from '../api';
import { FALLBACK_RULES, evaluate } from '../utils/passwordPolicy';
import './PasswordReset.css';

// Mirrors the server's address check in utils/passwordReset.js, so an obvious
// typo is caught before the round trip. The server still validates.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

// Phases, in the order the screen can be in. `checking` and `checkingRules`
// are folded into one `loading` view — they are both "we don't know yet", and
// flashing a form in between would be worse than a brief spinner.
// THROTTLED is separate from DEAD on purpose. A 429 from the shared /api/auth
// lockout says nothing about the link — it may be perfectly valid, and the
// address is simply being slowed down (three wrong codes from a shared NAT, a
// test run, anything). Telling such a user "this link has expired" sends them
// off to request a new link they did not need, and hides a real throttle.
const PHASE = { LOADING: 'loading', DEAD: 'dead', THROTTLED: 'throttled', FORM: 'form', DONE: 'done' };

function Icon({ name }) {
  const common = {
    width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  };
  if (name === 'lock') {
    return (
      <svg {...common} width="26" height="26">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    );
  }
  if (name === 'check') {
    return <svg {...common} strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>;
  }
  if (name === 'cross') {
    return <svg {...common}><path d="M18 6 6 18M6 6l12 12" /></svg>;
  }
  if (name === 'eye') {
    return (
      <svg {...common} width="18" height="18">
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  if (name === 'eyeOff') {
    return (
      <svg {...common} width="18" height="18">
        <path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17.6 17.6 0 0 1-2.1 2.9M6.6 6.6A17.8 17.8 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.5-1.1" />
        <path d="M14.1 14.1a3 3 0 1 1-4.2-4.2" />
        <path d="m2 2 20 20" />
      </svg>
    );
  }
  if (name === 'alert') {
    return (
      <svg {...common} width="18" height="18">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
    );
  }
  if (name === 'clock') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
    );
  }
  return null;
}

function ResetPassword() {
  const [searchParams] = useSearchParams();
  // Read once at mount. The token is a single-use credential that is about to
  // be burned — re-reading it on every render would let a stray state change
  // silently swap the grant out from under the form.
  const [token] = useState(() => (searchParams.get('token') || '').trim());

  const [phase, setPhase] = useState(PHASE.LOADING);
  const [notice, setNotice] = useState('');
  // WHY the link is unusable. The server distinguishes a missing token (the URL
  // was truncated or hand-typed) from a spent one, and the screen says so
  // rather than telling someone who never had a link that it "expired".
  const [reason, setReason] = useState('');
  const [rules, setRules] = useState(FALLBACK_RULES);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Bumped by "Try again" to re-run the link check. The only way out of a
  // throttle, and a way to re-check a link that was valid but unreachable when
  // the page first loaded.
  const [retry, setRetry] = useState(0);

  // ── The emailed 6-digit code ────────────────────────────────────────────
  // The reset email carries a code beside the link and tells the reader to use
  // it "on the reset screen instead" when they are opening the message on a
  // different device. Until now this screen had no field for it, so that
  // instruction led nowhere: someone without a working link had no way forward
  // except requesting yet another email, which is exactly what does not work
  // when the mailbox is the problem.
  //
  // Redeeming one hands back the same single-use grant the link carries, so the
  // password is still changed in one place — the form below — with the token
  // arriving by navigation rather than by URL.
  //
  // The grant is kept in STATE rather than pushed into the URL, which is the
  // better of the two available routes and not a stylistic choice. Navigating to
  // `/reset-password?token=…` from this component would not work at all: `token`
  // is read once in a `useState` initializer (see above), so the link check would
  // never re-run and the screen would sit on "This page needs a reset link" with
  // a perfectly good grant in hand. And holding it in state keeps the credential
  // out of the address bar, out of history and out of any Referer the next
  // navigation sends — `ForgotPassword` has to scrub it because it navigates to
  // a different route, and here there is no reason to put it there at all.
  const [grant, setGrant] = useState('');
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeEmail, setCodeEmail] = useState('');
  const [codeValue, setCodeValue] = useState('');
  const [codeError, setCodeError] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);

  // The grant actually in force. A redeemed code's grant wins over the URL's,
  // and the two can never both be live: this screen only leaves its initial
  // check once, and a redeemed code arrives only from the no-link screen.
  const activeToken = grant || token;

  const handleCodeSubmit = async (event) => {
    event.preventDefault();
    const address = codeEmail.trim();
    const digits = codeValue.trim();

    if (!EMAIL_REGEX.test(address)) {
      setCodeError('Enter the email address you asked for the reset from.');
      return;
    }
    if (!/^\d{6}$/.test(digits)) {
      setCodeError('Enter the 6-digit code from your reset email.');
      return;
    }

    setCodeError('');
    setCodeBusy(true);
    try {
      const data = await redeemPasswordResetCode(address, digits);
      if (!aliveRef.current) return;
      // Straight to the form. The link check is not re-run: this grant was minted
      // seconds ago by the server, so there is nothing left to verify.
      setGrant(String(data?.resetToken || ''));
      setNotice('');
      setCodeValue('');
      setPhase(PHASE.FORM);
    } catch (err) {
      if (!aliveRef.current) return;
      // The server answers one message for every failure — unknown address, no
      // reset running, wrong code, expired — so whatever it says is shown
      // verbatim. Adding local commentary here would rebuild the account oracle
      // the server deliberately refuses to expose.
      setCodeError(err.message || 'That did not work. Please try again.');
    } finally {
      if (aliveRef.current) setCodeBusy(false);
    }
  };

  // Guards against a late-arriving response writing state onto an unmounted
  // page. The requests below are fire-and-forget, and a slow one on a mobile
  // connection very easily outlives the screen.
  //
  // Re-armed INSIDE the effect, not during render, and that matters: this app
  // renders under StrictMode, which mounts, unmounts and remounts to surface
  // exactly this class of bug. A one-shot `useRef(true)` plus an unmount
  // cleanup leaves the flag `false` after the simulated remount, so the second
  // run bailed out and the page sat on "Checking your reset link…" forever.
  // Setting it in the effect body keeps the invariant ("true while this
  // instance is mounted") and satisfies the refs rule.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      // Rules and token are fetched together: whichever fails, the other is
      // still worth having. The policy degrades to the bundled copy; the token
      // is the whole page.
      const [rulesResult, tokenResult] = await Promise.allSettled([
        getPasswordRules(),
        token ? validatePasswordResetToken(token) : Promise.resolve({ valid: false, reason: 'missing' }),
      ]);
      if (cancelled) return;

      if (rulesResult.status === 'fulfilled' && rulesResult.value?.checks?.length) {
        setRules(rulesResult.value);
      }

      if (tokenResult.status === 'fulfilled' && tokenResult.value?.valid) {
        setPhase(PHASE.FORM);
        return;
      }
      if (tokenResult.status === 'rejected' && tokenResult.reason?.rateLimited) {
        // The link was never judged. Do not tell the user it expired.
        setNotice(tokenResult.reason.message);
        setPhase(PHASE.THROTTLED);
        return;
      }
      const why = tokenResult.status === 'rejected' ? '' : (tokenResult.value?.reason || 'invalid');
      setReason(why);
      // A missing token is not a spent one. It used to fall through to the generic
      // "no longer valid", which contradicted the heading directly above it
      // ("This page needs a reset link") and told someone who never had a link
      // that the link they do not have had expired.
      setNotice(
        tokenResult.status === 'rejected'
          ? tokenResult.reason?.message || 'We could not check that reset link. Please try again.'
          : why === 'missing'
            ? 'This address has no reset link in it. Open the link from your reset email, or use the 6-digit code from that email below.'
            : tokenResult.value?.message || 'This reset link is no longer valid.'
      );
      setPhase(PHASE.DEAD);
    };
    check();
    return () => { cancelled = true; };
    // `retry` is in the deps on purpose: bumping it re-runs the check, which is
    // how "Try again" recovers from a throttle. `token` cannot change — it is
    // read once at mount, because it is a single-use credential.
  }, [token, retry]);

  const verdict = evaluate(password, rules);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (!verdict.ok) {
      const firstUnmet = verdict.checks.find((check) => !check.ok);
      setError(firstUnmet ? `Still needed: ${firstUnmet.label.toLowerCase()}.` : 'That password does not meet the requirements.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const data = await completePasswordReset(activeToken, password);
      if (!aliveRef.current) return;
      setNotice(data?.message || 'Your password has been changed.');
      setPassword('');
      setConfirm('');
      setPhase(PHASE.DONE);
    } catch (err) {
      if (!aliveRef.current) return;
      // A 400 covers both "your password was refused" and "the link is spent".
      // Only the latter is unrecoverable on this screen, and only the server
      // knows which it was — so this matches on what it said.
      if (err.linkInvalid && /no longer valid|already been used|has just been used|expired/i.test(err.message)) {
        setNotice(err.message);
        setReason('invalid');
        setPhase(PHASE.DEAD);
        return;
      }
      // A throttle says nothing about the link, so the form stays and the wait
      // is reported in place. Bouncing to the "expired" screen here would tell a
      // user their good link is dead when it is merely rate-limited.
      if (err.status === 429) {
        setError(err.message || 'Too many attempts. Please wait a moment and try again.');
        return;
      }
      setError(err.message || 'We could not change your password. Please try again.');
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  };

  /** Re-run the link check from the top. */
  const recheck = useCallback(() => {
    setError('');
    setNotice('');
    setPhase(PHASE.LOADING);
    setRetry((n) => n + 1);
  }, []);

  // ── Checking the link ──────────────────────────────────────────────────
  if (phase === PHASE.LOADING) {
    return (
      <div className="pwreset-page">
        <Navbar />
        <main className="pwreset-card">
          <div className="pwreset-loading" role="status" aria-live="polite">
            <div className="pwreset-spinner" aria-hidden="true" />
            <span>Checking your reset link…</span>
          </div>
        </main>
      </div>
    );
  }

  // ── The link is gone ───────────────────────────────────────────────────
  if (phase === PHASE.DEAD) {
    // A URL with no token at all is a different situation from a spent one, and
    // saying "this link has expired" to someone who never had a link is just
    // wrong. It happens whenever the link is pasted without its query string.
    const missing = reason === 'missing';
    return (
      <div className="pwreset-page">
        <Navbar />
        <main className="pwreset-card">
          <div className="pwreset-badge is-alert" aria-hidden="true"><Icon name="alert" /></div>
          <h1 className="pwreset-title">{missing ? 'This page needs a reset link' : 'This link has expired'}</h1>
          <p className="pwreset-subtitle">{notice}</p>

          <div className="pwreset-alert is-info" style={{ textAlign: 'left' }}>
            <Icon name="alert" />
            <span>
              {missing
                ? 'Your reset email now carries a 6-digit code rather than a link, so nothing is '
                  + 'missing here — enter that code below with the email address you asked for the '
                  + 'reset from. If you followed an older email that did have a link, open it again.'
                : 'Reset links work once and expire after 30 minutes. Requesting a new one '
                  + 'is quick and does not change anything else on your account.'}
            </span>
          </div>

          <Link className="pwreset-btn pwreset-btn-primary" to="/forgot-password" style={{ textDecoration: 'none' }}>
            Send me a new code
          </Link>
          {/* Not shown when there was no token: there is nothing in the URL to
              re-check, so this button could only ever report the same thing. */}
          {!missing && (
            <button type="button" className="pwreset-btn pwreset-btn-secondary" style={{ marginTop: 10 }} onClick={recheck}>
              Check another link
            </button>
          )}

          {/* The code path, offered exactly where the email sends people who
              cannot use the link. Without it the "6-digit code" in every reset
              email was a dead end. */}
          {missing && (
            <div className="pwreset-alt">
              <button
                type="button"
                className="pwreset-alt-toggle"
                aria-expanded={codeOpen}
                onClick={() => { setCodeOpen((v) => !v); setCodeError(''); }}
              >
                <Icon name="shield" />
                {codeOpen ? 'Hide the code option' : 'Use the 6-digit code from my email'}
              </button>

              {codeOpen && (
                <div className="pwreset-alt-panel">
                  <p className="pwreset-alt-intro">
                    Enter the address you asked for the reset from, and the 6-digit code in that
                    email. This opens the same form the link would have.
                  </p>

                  <form onSubmit={handleCodeSubmit} noValidate>
                    <div className="pwreset-field">
                      <label htmlFor="pwreset-code-email">Email address</label>
                      <div className="pwreset-lead">
                        <span className="pwreset-lead__icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="4" width="20" height="16" rx="2" />
                            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                          </svg>
                        </span>
                        <input
                          id="pwreset-code-email"
                          name="codeEmail"
                          type="email"
                          className="pwreset-input"
                          value={codeEmail}
                          onChange={(e) => { setCodeEmail(e.target.value); setCodeError(''); }}
                          placeholder="you@example.com"
                          autoComplete="email"
                          maxLength={254}
                          disabled={codeBusy}
                        />
                      </div>
                    </div>

                    <div className="pwreset-field">
                      <label htmlFor="pwreset-code-value">6-digit code</label>
                      <div className="pwreset-lead">
                        <input
                          id="pwreset-code-value"
                          name="resetCode"
                          type="text"
                          className="pwreset-input"
                          value={codeValue}
                          onChange={(e) => {
                            setCodeValue(e.target.value.replace(/\D/g, '').slice(0, 6));
                            setCodeError('');
                          }}
                          placeholder="000000"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          disabled={codeBusy}
                        />
                      </div>
                      <p className="pwreset-hint">
                        Use the code from the newest reset email. Each code works once and expires
                        with the link beside it.
                      </p>
                    </div>

                    {codeError && (
                      <div className="pwreset-alert is-error" role="alert">
                        <Icon name="alert" />
                        <span>{codeError}</span>
                      </div>
                    )}

                    <button type="submit" className="pwreset-btn pwreset-btn-primary" disabled={codeBusy}>
                      {codeBusy && <span className="pwreset-btn-spinner" aria-hidden="true" />}
                      {codeBusy ? 'Checking…' : 'Continue with this code'}
                    </button>
                  </form>
                </div>
              )}
            </div>
          )}

          <Link className="pwreset-back" to="/login">Back to sign in</Link>
        </main>
      </div>
    );
  }

  // ── Throttled, not dead ────────────────────────────────────────────────
  // Deliberately does NOT say the link expired. A 429 from the shared
  // /api/auth lockout means the address is being slowed down; the link in the
  // URL may be perfectly valid and waiting will open the form.
  if (phase === PHASE.THROTTLED) {
    return (
      <div className="pwreset-page">
        <Navbar />
        <main className="pwreset-card">
          <div className="pwreset-badge is-muted" aria-hidden="true"><Icon name="clock" /></div>
          <h1 className="pwreset-title">Too many attempts</h1>
          <p className="pwreset-subtitle">{notice}</p>

          <div className="pwreset-alert is-info" style={{ textAlign: 'left' }}>
            <Icon name="clock" />
            <span>
              This is a short pause to protect your account, not a problem with your code.
              Wait a moment, then try again — you do not need a new one.
            </span>
          </div>

          <button type="button" className="pwreset-btn pwreset-btn-primary" onClick={recheck}>
            Try again
          </button>
          <Link className="pwreset-btn pwreset-btn-secondary" to="/forgot-password" style={{ marginTop: 10, textDecoration: 'none' }}>
            Send me a new code
          </Link>

          <Link className="pwreset-back" to="/login">Back to sign in</Link>
        </main>
      </div>
    );
  }

  // ── Done ───────────────────────────────────────────────────────────────
  if (phase === PHASE.DONE) {
    return (
      <div className="pwreset-page">
        <Navbar />
        <main className="pwreset-card">
          <div className="pwreset-badge" aria-hidden="true"><Icon name="check" /></div>
          <h1 className="pwreset-title">Password changed</h1>
          <p className="pwreset-subtitle">{notice}</p>

          <div className="pwreset-alert is-info" style={{ textAlign: 'left' }}>
            <Icon name="alert" />
            <span>
              We also emailed you to confirm the change. If you did not make it,
              reset your password again and contact support straight away.
            </span>
          </div>

          <Link className="pwreset-btn pwreset-btn-primary" to="/login" style={{ textDecoration: 'none' }}>
            Sign in
          </Link>

          <p className="pwreset-footnote">This link has now been used and cannot be used again.</p>
        </main>
      </div>
    );
  }

  // ── The form ───────────────────────────────────────────────────────────
  const showMeter = password.length > 0;
  const confirmMismatch = confirm.length > 0 && confirm !== password;

  return (
    <div className="pwreset-page">
      <Navbar />
      <main className="pwreset-card">
        <div className="pwreset-badge" aria-hidden="true"><Icon name="lock" /></div>
        <h1 className="pwreset-title">Choose a new password</h1>
        <p className="pwreset-subtitle">
          Pick something you don&apos;t use anywhere else. You&apos;ll be signed out of
          every device once it&apos;s changed.
        </p>

        {error && (
          <div className="pwreset-alert is-error" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="pwreset-field">
            <label htmlFor="pwreset-new">New password</label>
            <div className="pwreset-input-wrap">
              <input
                id="pwreset-new"
                name="newPassword"
                type={showPassword ? 'text' : 'password'}
                className="pwreset-input"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(''); }}
                placeholder="At least 10 characters"
                autoComplete="new-password"
                disabled={submitting}
                maxLength={Number(rules.maxLength) || 128}
                autoFocus
              />
              <button
                type="button"
                className="pwreset-eye"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                <Icon name={showPassword ? 'eyeOff' : 'eye'} />
              </button>
            </div>
          </div>

          {showMeter && (
            <div className="pwreset-meter">
              <div className="pwreset-meter-track" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((index) => (
                  <span
                    key={index}
                    className={`pwreset-meter-bar s${index}${index < verdict.score ? ' is-on' : ''}`}
                  />
                ))}
              </div>
              {/* Polite, because this fires on every keystroke; the checklist
                  below is what a screen reader user actually needs. */}
              <div className="pwreset-meter-label" aria-live="polite">
                <strong className={`is-s${verdict.score}`}>{verdict.scoreLabel}</strong>
                <span>{verdict.met} of {verdict.total} requirements met</span>
              </div>
            </div>
          )}

          <ul className="pwreset-checks">
            {verdict.checks.map((check) => (
              <li key={check.id} className={`pwreset-check${check.ok ? ' is-met' : ''}`}>
                <span style={{ color: check.ok ? '#16a34a' : '#9ca3af', display: 'flex' }} aria-hidden="true">
                  <Icon name={check.ok ? 'check' : 'cross'} />
                </span>
                <span>{check.label}</span>
              </li>
            ))}
          </ul>

          <div className="pwreset-field">
            <label htmlFor="pwreset-confirm">Confirm new password</label>
            <div className="pwreset-input-wrap">
              <input
                id="pwreset-confirm"
                name="confirmPassword"
                type={showConfirm ? 'text' : 'password'}
                className="pwreset-input"
                value={confirm}
                onChange={(e) => { setConfirm(e.target.value); setError(''); }}
                onBlur={() => { if (confirm && confirm !== password) setError('The two passwords do not match.'); }}
                placeholder="Type it once more"
                autoComplete="new-password"
                disabled={submitting}
                aria-invalid={confirmMismatch || undefined}
                maxLength={Number(rules.maxLength) || 128}
              />
              <button
                type="button"
                className="pwreset-eye"
                onClick={() => setShowConfirm((v) => !v)}
                aria-label={showConfirm ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                <Icon name={showConfirm ? 'eyeOff' : 'eye'} />
              </button>
            </div>
            {confirmMismatch && <p className="pwreset-hint">The two passwords do not match yet.</p>}
          </div>

          <button type="submit" className="pwreset-btn pwreset-btn-primary" disabled={submitting}>
            {submitting ? 'Changing your password…' : 'Change my password'}
          </button>
        </form>

        <Link className="pwreset-back" to="/login">Back to sign in</Link>
      </main>
    </div>
  );
}

export default ResetPassword;
