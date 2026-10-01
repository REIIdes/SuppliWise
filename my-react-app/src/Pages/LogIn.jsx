import { useState, useEffect } from 'react';
import { NavLink, Link, useNavigate, useLocation } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { BASE_URL, saveAssessment, getRecommendations, saveAssessmentResults, parseJSON, startSession, takeAuthNotice, getToken, redeemBackupCode, accountIdOf, getActiveAccountId, getStoredUser } from '../api';
import { beginAuthTransition, endAuthTransition } from '../auth/authState';
// Passkey sign-in: two server calls with a browser gesture between them.
// The client never names the account - the assertion does.
import { isPasskeySupported, signInWithPasskey } from '../api';
import { safeRedirectPath } from '../utils/safeUrl';
import './LogIn.css';
import './ProfilePage.css'; // Import for OTP modal styles

const SESSION_KEY = 'pending_assessment';

// One-shot notice left behind by a forced sign-out (session replaced by a
// newer sign-in, signed out elsewhere, or a token the session store no
// longer vouches for). Consumed ONCE at module load so React StrictMode's
// double-run of the lazy useState initializer below still sees the same text.
const LOGIN_NOTICE = takeAuthNotice();

// Strict email regex — requires a proper TLD (2+ letters; long TLDs allowed)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const SUSPICIOUS_TLDS = ['.con', '.cmo', '.ocm', '.nte', '.ogr', '.cpm'];

function validateEmail(email) {
  const trimmed = email.trim();
  if (!trimmed) return 'Please enter your email address.';
  if (!EMAIL_REGEX.test(trimmed)) return 'Please enter a valid email address (e.g. name@example.com).';
  const lower = trimmed.toLowerCase();
  if (SUSPICIOUS_TLDS.some(tld => lower.endsWith(tld)))
    return 'That email looks like a typo. Did you mean .com or .net?';
  return '';
}

function LogIn() {
  // Prefill from ?add=1&email= — the Accounts panel sends it when a switch
  // can't be handed over and falls back to a fresh sign-in, so the form opens
  // on the target account's own email instead of a blank field.
  const [email, setEmail] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('add') !== '1') return '';
      return (params.get('email') || '').trim().slice(0, 254);
    } catch { return ''; }
  });
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(LOGIN_NOTICE);
  const [loading, setLoading] = useState(false);
  // OPT-IN saved login: checked by default so switching accounts later never
  // asks for this password again (server stores only a session-bound
  // remember credential — never this password or an access token).
  const [remember, setRemember] = useState(true);
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [otp, setOtp] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [pendingUserId, setPendingUserId] = useState('');
  // The server-side MFA_REQUIRED state, minted by the password step. Held in
  // component state for the life of the prompt and never persisted: it is a
  // one-shot capability for finishing THIS sign-in, not a credential.
  const [mfaTransaction, setMfaTransaction] = useState('');
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendTimer, setResendTimer] = useState(null);
  const [success, setSuccess] = useState('');
  const [otpTimeLeft, setOtpTimeLeft] = useState(600); // 10 minutes in seconds
  const [otpExpiryTimer, setOtpExpiryTimer] = useState(null);
  const [requiresTwoFactor, setRequiresTwoFactor] = useState(false);
  // Whether the second-factor box is collecting a live authenticator code or a
  // printed recovery code. They are the same 11 characters with a hyphen in the
  // middle, typed by someone who may be locked out, so the field has to accept
  // letters and digits — not just the digits a TOTP is made of.
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  
  // Whether to offer the passkey button at all. Resolved once, in the state
  // initialiser rather than an effect: it is a static property of the browser,
  // not something that changes, and a setState in an effect body causes a
  // cascading render to learn something already knowable at mount.
  // Presentation only - the server decides everything that matters.
  const [passkeyAvailable] = useState(isPasskeySupported);

  const navigate = useNavigate();
  const location = useLocation();

  const fromAssessment = location.state?.fromAssessment;
  // "Add another account" (?add=1 from Profile → Accounts): the navbar no
  // longer shows the signed-in chip on auth pages, so this banner supplies
  // the context and a way back to the current session. The account switcher
  // also lands here when a switch can't be handed over — with &email= naming
  // the target account (prefilled above) so the banner says who it's for.
  const searchParams = new URLSearchParams(location.search);
  const addingAccount = searchParams.get('add') === '1' && !!getToken();
  const targetEmail = searchParams.get('add') === '1' ? (searchParams.get('email') || '').trim() : '';

  // Browsers often paint autofill without firing onChange, so React state
  // stays empty and the form reports "please enter your email" over a
  // visibly filled field. Pull the real DOM values in after paint.
  useEffect(() => {
    const syncAutofill = () => {
      const emailInput = document.getElementById('login-email');
      const passwordInput = document.getElementById('login-password');
      if (emailInput?.value) setEmail(emailInput.value);
      if (passwordInput?.value) setPassword(passwordInput.value);
    };
    syncAutofill();
    const timers = [50, 300, 1000].map((ms) => setTimeout(syncAutofill, ms));
    return () => timers.forEach(clearTimeout);
  }, []);

  // The alternate route to the admin login, now that the visible link is gone.
  // Ctrl+Shift+A. Ignored while the user is typing so it can't fire mid-email,
  // and it carries no session state — /admin/login is a public route, so this
  // is convenience, not an authorisation decision.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.key !== 'A' && e.key !== 'a') return;
      const el = e.target;
      if (el instanceof HTMLElement) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return;
      }
      e.preventDefault();
      navigate('/admin/login');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  const validateField = (field, value) => {
    let msg = '';
    if (field === 'email') msg = validateEmail(value);
    if (field === 'password' && !value) msg = 'Please enter your password.';
    setFieldErrors(prev => ({ ...prev, [field]: msg }));
  };

  // While typing: revalidate a non-empty value, but an emptied field just
  // drops its error instead of being validated as '' (which put
  // "Please enter your email address." on a blank input mid-keystroke).
  // Empty fields are still validated on blur and on submit.
  const revalidateOnChange = (field, value) => {
    if (!fieldErrors[field]) return;
    if (value) validateField(field, value);
    else setFieldErrors(prev => ({ ...prev, [field]: '' }));
  };

  const startResendCooldown = (seconds) => {
    setResendCooldown(seconds);
    
    // Clear existing timer if any
    if (resendTimer) {
      clearInterval(resendTimer);
    }

    // Start countdown
    const timer = setInterval(() => {
      setResendCooldown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    setResendTimer(timer);
  };

  const startOtpExpiryTimer = () => {
    setOtpTimeLeft(600); // Reset to 10 minutes
    
    // Clear existing timer if any
    if (otpExpiryTimer) {
      clearInterval(otpExpiryTimer);
    }

    // Start countdown
    const timer = setInterval(() => {
      setOtpTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          setError('Verification code has expired. Please request a new one.');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    setOtpExpiryTimer(timer);
  };

  const formatTimeLeft = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleResendOtp = async () => {
    if (resendCooldown > 0) return;
    
    setOtp('');
    setError('');
    setSuccess('');
    setOtpLoading(true);

    try {
      const response = await fetch(`${BASE_URL}/auth/resend-login-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: pendingUserId }),
      });

      const data = await parseJSON(response);

      if (!response.ok) {
        if (response.status === 429 && data.remainingSeconds) {
          startResendCooldown(data.remainingSeconds);
        }
        throw new Error(data.message || 'Failed to resend code');
      }

      startResendCooldown(30);
      startOtpExpiryTimer(); // Restart expiry timer with new OTP
      setSuccess('Verification code sent again!');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.message || 'Failed to resend code. Please try again.');
    } finally {
      setOtpLoading(false);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');

    const emailInput = document.getElementById('login-email');
    const passwordInput = document.getElementById('login-password');
    const emailValue = (emailInput?.value || email || '').trim();
    const passwordValue = passwordInput?.value || password || '';
    if (emailValue !== email) setEmail(emailValue);
    if (passwordValue !== password) setPassword(passwordValue);

    const emailErr = validateEmail(emailValue);
    const passwordErr = !passwordValue ? 'Please enter your password.' : '';
    const newErrors = { email: emailErr, password: passwordErr };
    setFieldErrors(newErrors);
    if (Object.values(newErrors).some(Boolean)) return;

    setLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailValue, password: passwordValue }),
      });

      const data = await parseJSON(response);

      if (!response.ok) {
        throw new Error(data.message || 'Login failed');
      }

      if (data?.requiresTwoFactor) {
        setRequiresTwoFactor(true);
        setPendingUserId(data.userId);
        setMfaTransaction(data.mfaTransaction || '');
        setOtp('');
        // Never carry the choice across attempts: the next sign-in may be for
        // an account whose second factor is an emailed code, which has no
        // recovery codes to offer.
        setUseRecoveryCode(false);
        setShowOtpModal(true);
        setLoading(false);
        return;
      }

      // Check if OTP is required
      if (data.requiresOtp) {
        setOtp('');
        setError('');
        setSuccess('');
        setPendingUserId(data.userId);
        setMfaTransaction(data.mfaTransaction || '');
        setShowOtpModal(true);
        startResendCooldown(30);
        startOtpExpiryTimer(); // Start OTP expiry countdown
        setLoading(false);
        return;
      }

      // Old flow (shouldn't happen with OTP enabled)
      await completeLogin(data);
    } catch (err) {
      const message = err.lockedBy === 'network'
        ? 'Too many attempts from this network. Please wait a few minutes or switch networks and try again.'
        : err.message;
      setError(message);
      setLoading(false);
    }
  };

  /**
   * Is what is in the box a complete second factor? Recovery codes are
   * XXXXX-XXXXX; the separator is optional because people retype from paper
   * and inconsistently include it.
   */
  const secondFactorComplete = () => (
    useRecoveryCode
      ? /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(otp.trim())
      : otp.trim().length === 6
  );

  const handleOtpSubmit = async () => {
    if (!secondFactorComplete()) {
      setError(useRecoveryCode
        ? 'Enter one of your recovery codes, like A1B2C-D3E4F.'
        : 'Please enter a valid 6-digit code.');
      return;
    }

    setOtpLoading(true);
    setError('');

    try {
      let data;
      if (useRecoveryCode) {
        // The recovery route is reached before there is a session, so it is
        // unauthenticated — see redeemBackupCode in api.js.
        data = await redeemBackupCode(pendingUserId, otp.trim(), remember);
      } else {
        const response = await fetch(`${BASE_URL}/auth/${requiresTwoFactor ? 'login-2fa' : 'verify-login-otp'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: pendingUserId,
            // Preferred: the opaque, single-use transaction. `userId` is still
            // sent so an older server build keeps working.
            mfaTransaction,
            otp: otp.trim(),
            remember,
          }),
        });

        data = await parseJSON(response);

        if (!response.ok) {
          throw new Error(data.message || 'Invalid verification code');
        }
      }

      // Second factor verified - complete login
      setShowOtpModal(false);
      setOtp('');
      await completeLogin(data);
    } catch (err) {
      const message = useRecoveryCode
        ? (err.message || 'That recovery code is not valid. Each code works only once.')
        : (err.message?.includes('Invalid verification code')
          ? 'That code is no longer valid. Please use the newest verification code sent to your email.'
          : err.message || 'Invalid verification code. Please try again.');
      setError(message);
    } finally {
      setOtpLoading(false);
    }
  };

  /**
   * Sign in with a passkey: no password, no emailed code, no account picker.
   *
   * The account is decided by the credential the authenticator returns, never by
   * anything on this page — which is why there is no email field involved and no
   * way to ask "which account?".
   */
  const handlePasskeySignIn = async () => {
    if (passkeyBusy) return;
    setPasskeyBusy(true);
    setError('');
    setSuccess('');
    try {
      const data = await signInWithPasskey(remember);
      // null means a stale-chunk self-heal scheduled a reload, so the WebAuthn
      // SDK never loaded. The page is being replaced; do NOT call completeLogin
      // with nothing, and do not show a banner over a working screen.
      if (!data) return;
      await completeLogin(data);
    } catch (err) {
      // A dismissed prompt is a choice, not a failure, so it gets no banner.
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        setError(err?.message || 'Could not sign in with a passkey.');
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  const completeLogin = async (data) => {
    // Hold the public-route guard while we decide where this sign-in lands —
    // the token write below emits immediately, and the guard must not bounce
    // /login → /dashboard before the pending-assessment flow reaches /results.
    beginAuthTransition();
    try {
    // Pictures are kept unless this response actually spoke about them.
    //
    // This cached profile is the ONLY copy the app renders an avatar or banner
    // from, and a field missing from a sign-in response means "the server did
    // not read it" — not "you have none". Defaulting a missing field to ''
    // therefore made a passwordless (passkey) sign-in wipe a real profile
    // picture and banner for the rest of the session.
    //
    // The carry-over is scoped by ACCOUNT, so switching accounts can never hand
    // one person's avatar to another; and it only applies when the key is
    // absent, so a server that really does send '' (the picture was removed)
    // still clears it.
    const sameAccount = (() => {
      const incoming = accountIdOf(data.token);
      if (!incoming) return false;
      const previous = getActiveAccountId();
      return !!previous && previous === incoming;
    })();
    const cached = sameAccount ? getStoredUser() : null;
    const picture = (field) => {
      if (Object.prototype.hasOwnProperty.call(data, field)) return data[field] || '';
      return (cached && cached[field]) || '';
    };

    // Store this account under its OWN session keys and make it active —
    // any account already signed in on this browser stays signed in.
    const switchedFrom = startSession(data.token, {
      firstName: data.firstName, 
      lastName: data.lastName, 
      name: data.name, 
      email: data.email,
      gender: data.gender,
      dateOfBirth: data.dateOfBirth,
      age: data.age,
      twoFactorEnabled: data.twoFactorEnabled === true,
      profilePicture: picture('profilePicture'),
      bannerPicture: picture('bannerPicture'),
      subscriptionActive: data.subscriptionActive === true,
      subscriptionPlan: data.subscriptionPlan || 'free',
      // Resolved snapshot (expiry-aware) — the plan store renders from this.
      subscription: data.subscription ?? null,
      subscriptionUpdatedAt: data.subscriptionUpdatedAt ?? null,
    }, data.rememberToken || '');

    // Publish the freshly signed-in account's plan to the shared store so no
    // page can keep showing the previous session's subscription state.
    try { window.dispatchEvent(new Event('suppliwise:subscription')); } catch { /* non-browser safe */ }

    // Check for pending assessment saved before login
    const pending = sessionStorage.getItem(SESSION_KEY);
    if (pending && fromAssessment) {
      // Only process pending assessment if user came from assessment flow
      try {
        const formData = JSON.parse(pending);
        const [savedAssessment, recommendations] = await Promise.all([
          saveAssessment(formData),
          getRecommendations(formData),
        ]);
        // Attach AI results to the saved record so history shows all tabs
        if (savedAssessment?.assessment?._id && recommendations) {
          saveAssessmentResults(savedAssessment.assessment._id, recommendations)
            .catch(e => console.warn('saveAssessmentResults failed:', e.message));
        }
        sessionStorage.removeItem(SESSION_KEY);
        navigate('/results', { state: { recommendations, assessment: formData } });
      } catch {
        // If recommendations fail, just go home — don't block login
        sessionStorage.removeItem(SESSION_KEY);
        navigate('/');
      }
    } else {
      // Clear any stale pending assessment data
      sessionStorage.removeItem(SESSION_KEY);
      
      // Check if there's a redirect destination from HomePage.
      // Only a same-origin app path is resumed: this value is fed straight
      // into `window.location.href` on the account-switch path, so an
      // absolute URL in router state would have been an open redirect. Anything
      // else falls back to the dashboard.
      const redirectTo = safeRedirectPath(location.state?.redirectTo);
      if (switchedFrom) {
        // We just took over from a different signed-in account: navigate with
        // a full page load so none of the previous account's state survives.
        window.location.href = redirectTo;
      } else {
        navigate(redirectTo);
      }
    }
    } finally {
      // Re-open the guard: if we navigated it re-evaluates harmlessly; if we
      // failed after writing the token it redirects instead of stranding
      // the user on the login form with a signed-in navbar.
      endAuthTransition();
    }
  };

  const handleCancelOtp = () => {
    setShowOtpModal(false);
    setRequiresTwoFactor(false);
    // The transaction is single-use and short-lived; there is nothing worth
    // keeping, and holding it would invite a stale retry.
    setMfaTransaction('');
    setUseRecoveryCode(false);
    setOtp('');
    setPendingUserId('');
    setError('');
    setSuccess('');
    setResendCooldown(0);
    setOtpTimeLeft(600);
    if (resendTimer) clearInterval(resendTimer);
    if (otpExpiryTimer) clearInterval(otpExpiryTimer);
    setLoading(false);
  };

  // Password recovery was a three-step modal on this page (email → 6-digit
  // code → new password). It now lives on /forgot-password and
  // /reset-password, because the flow ends in a link clicked out of an email
  // — usually in a new tab, sometimes hours later. A modal that only exists
  // while this component is mounted cannot survive that, and the back button
  // walked out of the flow while it silently kept its state.
  // See the link below.
  return (
    <div className="page-wrapper">
      <Navbar />
      <div className="auth-container">
        <form className="auth-card" onSubmit={handleLogin}>
          <div className="auth-badge" aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12h4l2.5-6 4 12L16 12h5" />
            </svg>
          </div>
          <h2 className="auth-title">Sign In to your account</h2>
          <p className="auth-subtitle">Welcome back — sign in to continue to your dashboard and insights.</p>

          {/* Banner shown when redirected from assessment */}
          {fromAssessment && (
            <div className="auth-info-banner">
              🔒 Please sign in to view your supplement recommendations. Your assessment has been saved.
            </div>
          )}

          {/* Add-another-account flow: current sessions stay signed in */}
          {addingAccount && (
            <div className="auth-info-banner">
              {targetEmail ? (
                <>➕ Sign in as <strong>{targetEmail}</strong> to continue. Your other accounts stay signed in on this browser.</>
              ) : (
                <>➕ Sign in to add another account. Your other accounts stay signed in on this browser.</>
              )}{' '}
              <NavLink to="/profile" className="auth-banner-link">Back to my session</NavLink>
            </div>
          )}

          {error && !showOtpModal && <p className="auth-error">{error}</p>}

          <div className={`auth-field ${fieldErrors.email ? 'field-has-error' : ''}`}>
            <label>Email</label>
            <div className="auth-input-ic">
              <span className="auth-ic" aria-hidden="true">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m3 7 8.4 5.6a2 2 0 0 0 2.2 0L21 7"/></svg>
              </span>
              <input
                id="login-email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); revalidateOnChange('email', e.target.value); }}
                onBlur={(e) => { if (e.target.value) validateField('email', e.target.value); }}
                onInput={(e) => { if (e.target.value && e.target.value !== email) setEmail(e.target.value); }}
                placeholder="your.email@example.com"
                autoComplete="email"
                required
              />
            </div>
            {fieldErrors.email && <span className="auth-field-error">{fieldErrors.email}</span>}
          </div>

          <div className={`auth-field ${fieldErrors.password ? 'field-has-error' : ''}`}>
            <label>Password</label>
            <div className="auth-input-wrap auth-input-pw">
              <span className="auth-ic" aria-hidden="true">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
              </span>
              <input
                id="login-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => { setPassword(e.target.value); revalidateOnChange('password', e.target.value); }}
                onBlur={(e) => { if (e.target.value) validateField('password', e.target.value); }}
                onInput={(e) => { if (e.target.value && e.target.value !== password) setPassword(e.target.value); }}
                placeholder="Enter your password"
                autoComplete="current-password"
                required
              />
              <button type="button" className="eye-btn" onClick={() => setShowPassword(s => !s)} aria-label="Toggle password visibility">
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
            {fieldErrors.password && <span className="auth-field-error">{fieldErrors.password}</span>}
          </div>

          <label className="auth-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Save my login on this browser — switch accounts later without typing your password</span>
          </label>

          <button type="submit" className="auth-btn" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

          {/* Passkeys. Offered ABOVE the email field in the visual order on
              wide screens (see .auth-passkey in the stylesheet) because it is
              the shortest and strongest path in. Rendered here, after the
              submit button in source order, so a screen reader meets the form
              fields before the alternative.

              Deliberately labelled as a separate method rather than folded into
              the password box: it uses neither the email nor the password, and
              the server decides which account it belongs to from the credential
              the authenticator returns. There is no "which account?" question
              to ask, because there is nothing here to ask it with. */}
          {passkeyAvailable && (
            <div className="auth-passkey">
              <div className="auth-passkey__divider"><span>or</span></div>
              <button
                type="button"
                className="auth-btn auth-btn--passkey"
                onClick={handlePasskeySignIn}
                disabled={passkeyBusy || loading}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
                {passkeyBusy ? 'Waiting for your device…' : 'Sign in with a passkey'}
              </button>
              <p className="auth-passkey__hint">
                Use your fingerprint, face or screen lock. A passkey is tied to this
                website, so it cannot be used on a fake sign-in page.
              </p>
            </div>
          )}

          {/* Password recovery lives on its own page now — /forgot-password,
              reached from the link in the email. It used to be a three-step
              modal on this form, which could not work: the reset was completed
              by clicking a link in an email, usually in a new tab, so the flow
              needed an address of its own to land on rather than a modal that
              only exists while this component is mounted. The address is
              carried across as ?email= so a user who mistyped it here can fix
              it there instead of starting over. */}
          <div className="auth-forgot-password">
            <Link
              className="auth-forgot-password-link"
              to={`/forgot-password?email=${encodeURIComponent(email.trim())}`}
            >
              Forgot your password?
            </Link>
          </div>

          <p className="auth-switch">
            Don't have an account?{' '}
            <NavLink to="/signup" state={location.state}>Create one</NavLink>
          </p>
          {/* No admin link here on purpose. "Are You an Admin? Administrator
              access" was a standing, crawlable pointer at the privileged login
              on the most-visited page in the app, inviting password spray and
              lockout-farming against the 6 admin accounts for no benefit —
              /admin/login is public regardless, so the link was pure
              reconnaissance. Admins reach it by URL or with Ctrl+Shift+A (see
              the shortcut in useEffect above). The real defences are the TOTP
              second factor and rate limiting, not the absence of a link. */}
        </form>
      </div>

      {/* OTP Verification Modal */}
      {showOtpModal && (
        <div
          className="profile-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="login-otp-title"
          onClick={() => !otpLoading && handleCancelOtp()}
        >
          <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="login-otp-title">Login Verification</h2>
            <p>
              {useRecoveryCode
                ? 'Enter one of your recovery codes.'
                : requiresTwoFactor
                  ? 'Enter the current code from Google Authenticator.'
                  : "For your security, we've sent a 6-digit verification code to:"}
            </p>
            {!requiresTwoFactor && !useRecoveryCode && <p className="profile-modal-email">{email}</p>}
            <p className="profile-modal-note">
              {useRecoveryCode
                ? 'Each code works once. Using one signs you in and burns it.'
                : 'Please enter the code to complete your login.'}
            </p>
            
            {/* Email-OTP expiry timer — hidden for Google Authenticator
                (TOTP codes rotate every 30s in the app itself) and for a
                recovery code, which does not expire. */}
            {!requiresTwoFactor && !useRecoveryCode && (
            <div className="otp-expiry-timer">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
              <span className={otpTimeLeft <= 60 ? 'expiring-soon' : ''}>
                Code expires in {formatTimeLeft(otpTimeLeft)}
              </span>
            </div>
            )}

            <input
              type="text"
              className={`profile-otp-input${useRecoveryCode ? ' profile-otp-input--code' : ''}`}
              placeholder={useRecoveryCode ? 'A1B2C-D3E4F' : 'Enter 6-digit code'}
              value={otp}
              onChange={(e) => {
                // A recovery code is letters and digits; a TOTP is digits only.
                // Stripping the wrong set would silently eat the user's input.
                const value = useRecoveryCode
                  ? e.target.value.replace(/[^A-Za-z0-9-]/g, '').slice(0, 11)
                  : e.target.value.replace(/\D/g, '').slice(0, 6);
                setOtp(value);
                setError('');
              }}
              maxLength={useRecoveryCode ? 11 : 6}
              inputMode={useRecoveryCode ? 'text' : 'numeric'}
              autoComplete={useRecoveryCode ? 'off' : 'one-time-code'}
              autoCapitalize="characters"
              spellCheck={false}
              disabled={otpLoading || (!requiresTwoFactor && !useRecoveryCode && otpTimeLeft === 0)}
              autoFocus
            />

            {error && (
              <div className="profile-modal-error">
                {error}
              </div>
            )}

            {success && (
              <div className="profile-modal-success">
                {success}
              </div>
            )}

            {!requiresTwoFactor && <div className="profile-modal-resend">
              <button
                type="button"
                className="profile-modal-resend-btn"
                onClick={handleResendOtp}
                disabled={resendCooldown > 0 || otpLoading}
              >
                {resendCooldown > 0 
                  ? `Send Again (${resendCooldown}s)` 
                  : 'Send Again'}
              </button>
            </div>}

            <div className="profile-modal-actions">
              <button
                type="button"
                className="profile-modal-btn profile-modal-btn-secondary"
                onClick={handleCancelOtp}
                disabled={otpLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                className="profile-modal-btn profile-modal-btn-primary"
                onClick={handleOtpSubmit}
                disabled={otpLoading || !secondFactorComplete() || (!requiresTwoFactor && !useRecoveryCode && otpTimeLeft === 0)}
              >
                {otpLoading ? 'Verifying...' : 'Verify & Sign In'}
              </button>
            </div>

            {/* The way back in when the phone is gone. Only offered for the
                authenticator method — on the email method the emailed code is
                already the second factor and there is no recovery code to use. */}
            {requiresTwoFactor && (
              <div className="profile-modal-resend">
                <button
                  type="button"
                  className="profile-modal-resend-btn"
                  onClick={() => { setUseRecoveryCode((v) => !v); setOtp(''); setError(''); setSuccess(''); }}
                  disabled={otpLoading}
                >
                  {useRecoveryCode
                    ? 'Use my authenticator instead'
                    : 'Lost your phone? Use a recovery code'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default LogIn;
