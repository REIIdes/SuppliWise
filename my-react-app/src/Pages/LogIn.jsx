import { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { BASE_URL, loginUser, saveAssessment, getRecommendations, saveAssessmentResults, parseJSON } from '../api';
import './LogIn.css';
import './ProfilePage.css'; // Import for OTP modal styles

const SESSION_KEY = 'pending_assessment';

// Strict email regex — requires a proper TLD (2–6 letters)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,6}$/;
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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [otp, setOtp] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [pendingUserId, setPendingUserId] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendTimer, setResendTimer] = useState(null);
  const [success, setSuccess] = useState('');
  const [otpExpiresAt, setOtpExpiresAt] = useState(null);
  const [otpTimeLeft, setOtpTimeLeft] = useState(600); // 10 minutes in seconds
  const [otpExpiryTimer, setOtpExpiryTimer] = useState(null);
  const [requiresTwoFactor, setRequiresTwoFactor] = useState(false);
  
  // Forgot password states
  const [showForgotPasswordModal, setShowForgotPasswordModal] = useState(false);
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState('');
  const [forgotPasswordStep, setForgotPasswordStep] = useState('email'); // 'email', 'otp', 'password'
  const [resetOtp, setResetOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);
  const [resetUserId, setResetUserId] = useState('');
  const [otpVerified, setOtpVerified] = useState(false);
  
  const navigate = useNavigate();
  const location = useLocation();

  const fromAssessment = location.state?.fromAssessment;

  const validateField = (field, value) => {
    let msg = '';
    if (field === 'email') msg = validateEmail(value);
    if (field === 'password' && !value) msg = 'Please enter your password.';
    setFieldErrors(prev => ({ ...prev, [field]: msg }));
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

    const emailErr = validateEmail(email);
    const passwordErr = !password ? 'Please enter your password.' : '';
    const newErrors = { email: emailErr, password: passwordErr };
    setFieldErrors(newErrors);
    if (Object.values(newErrors).some(Boolean)) return;

    setLoading(true);
    try {
      console.log('[DEBUG] Sending login request...');
      const response = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await parseJSON(response);
      console.log('[DEBUG] Login response:', data);

      if (!response.ok) {
        throw new Error(data.message || 'Login failed');
      }

      if (data?.requiresTwoFactor) {
        setRequiresTwoFactor(true);
        setPendingUserId(data.userId);
        setOtp('');
        setShowOtpModal(true);
        setLoading(false);
        return;
      }

      // Check if OTP is required
      if (data.requiresOtp) {
        console.log('[DEBUG] OTP required, showing modal');
        setOtp('');
        setError('');
        setSuccess('');
        setPendingUserId(data.userId);
        setShowOtpModal(true);
        startResendCooldown(30);
        startOtpExpiryTimer(); // Start OTP expiry countdown
        setLoading(false);
        return;
      }

      // Old flow (shouldn't happen with OTP enabled)
      console.log('[DEBUG] No OTP required - using old flow (this should not happen!)');
      await completeLogin(data);
    } catch (err) {
      console.error('[DEBUG] Login error:', err);
      setError(err.message);
      setLoading(false);
    }
  };

  const handleOtpSubmit = async () => {
    if (otp.trim().length !== 6) {
      setError('Please enter a valid 6-digit code.');
      return;
    }

    setOtpLoading(true);
    setError('');

    try {
      const response = await fetch(`${BASE_URL}/auth/${requiresTwoFactor ? 'login-2fa' : 'verify-login-otp'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: pendingUserId, otp: otp.trim() }),
      });

      const data = await parseJSON(response);

      if (!response.ok) {
        throw new Error(data.message || 'Invalid verification code');
      }

      // OTP verified - complete login
      setShowOtpModal(false);
      setOtp('');
      await completeLogin(data);
    } catch (err) {
      const message = err.message?.includes('Invalid verification code')
        ? 'That code is no longer valid. Please use the newest verification code sent to your email.'
        : err.message || 'Invalid verification code. Please try again.';
      setError(message);
    } finally {
      setOtpLoading(false);
    }
  };

  const completeLogin = async (data) => {
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify({ 
      firstName: data.firstName, 
      lastName: data.lastName, 
      name: data.name, 
      email: data.email,
      gender: data.gender,
      dateOfBirth: data.dateOfBirth,
      age: data.age,
      twoFactorEnabled: data.twoFactorEnabled === true,
      profilePicture: data.profilePicture || '',
      bannerPicture: data.bannerPicture || ''
    }));

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
      } catch (err) {
        // If recommendations fail, just go home — don't block login
        sessionStorage.removeItem(SESSION_KEY);
        navigate('/');
      }
    } else {
      // Clear any stale pending assessment data
      sessionStorage.removeItem(SESSION_KEY);
      
      // Check if there's a redirect destination from HomePage
      const redirectTo = location.state?.redirectTo;
      navigate(redirectTo || '/dashboard');
    }
  };

  const handleCancelOtp = () => {
    setShowOtpModal(false);
    setRequiresTwoFactor(false);
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

  // ============== FORGOT PASSWORD HANDLERS ==============
  
  const handleForgotPasswordClick = () => {
    setShowForgotPasswordModal(true);
    setForgotPasswordStep('email');
    setForgotPasswordEmail(email); // Pre-fill if email is already entered
    setError('');
    setSuccess('');
  };

  const handleCloseForgotPassword = () => {
    setShowForgotPasswordModal(false);
    setForgotPasswordStep('email');
    setForgotPasswordEmail('');
    setResetOtp('');
    setNewPassword('');
    setConfirmNewPassword('');
    setResetUserId('');
    setOtpVerified(false);
    setError('');
    setSuccess('');
    setResendCooldown(0);
    setOtpTimeLeft(600);
    if (resendTimer) clearInterval(resendTimer);
    if (otpExpiryTimer) clearInterval(otpExpiryTimer);
  };

  const handleForgotPasswordSubmitEmail = async (e) => {
    e.preventDefault();
    setError('');
    
    const emailErr = validateEmail(forgotPasswordEmail);
    if (emailErr) {
      setError(emailErr);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotPasswordEmail }),
      });

      const data = await parseJSON(response);

      if (!response.ok) {
        if (response.status === 429 && data.remainingSeconds) {
          startResendCooldown(data.remainingSeconds);
        }
        throw new Error(data.message || 'Failed to send verification code');
      }

      setResetUserId(data.userId);
      setForgotPasswordStep('otp');
      startResendCooldown(30);
      startOtpExpiryTimer();
      setSuccess('Verification code sent to your email!');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyResetOtp = async () => {
    if (resetOtp.trim().length !== 6) {
      setError('Please enter a valid 6-digit code.');
      return;
    }

    setOtpLoading(true);
    setError('');

    try {
      const response = await fetch(`${BASE_URL}/auth/verify-password-reset-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: resetUserId, otp: resetOtp.trim() }),
      });

      const data = await parseJSON(response);

      if (!response.ok) {
        throw new Error(data.message || 'Invalid verification code');
      }

      setOtpVerified(true);
      setForgotPasswordStep('password');
      setSuccess('Code verified! Now set your new password.');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      const message = err.message?.includes('Invalid verification code')
        ? 'That code is no longer valid. Please use the newest verification code sent to your email.'
        : err.message || 'Invalid verification code. Please try again.';
      setError(message);
    } finally {
      setOtpLoading(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError('');

    // Validate passwords
    const passwordErr = validatePassword(newPassword);
    if (passwordErr) {
      setError(passwordErr);
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          userId: resetUserId, 
          otp: resetOtp.trim(), 
          newPassword 
        }),
      });

      const data = await parseJSON(response);

      if (!response.ok) {
        throw new Error(data.message || 'Failed to reset password');
      }

      setSuccess('Password reset successfully! You can now sign in.');
      setTimeout(() => {
        handleCloseForgotPassword();
        // Pre-fill the email in login form
        setEmail(forgotPasswordEmail);
      }, 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleResendResetOtp = async () => {
    if (resendCooldown > 0) return;
    
    setResetOtp('');
    setError('');
    setSuccess('');
    setOtpLoading(true);

    try {
      const response = await fetch(`${BASE_URL}/auth/resend-password-reset-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: resetUserId }),
      });

      const data = await parseJSON(response);

      if (!response.ok) {
        if (response.status === 429 && data.remainingSeconds) {
          startResendCooldown(data.remainingSeconds);
        }
        throw new Error(data.message || 'Failed to resend code');
      }

      startResendCooldown(30);
      startOtpExpiryTimer();
      setSuccess('Verification code sent again!');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.message || 'Failed to resend code. Please try again.');
    } finally {
      setOtpLoading(false);
    }
  };

  function validatePassword(password) {
    if (!password) return 'Please enter a password.';
    if (password.length < 8) return 'Your password is too short — please use at least 8 characters.';
    if (!/[A-Z]/.test(password)) return 'Add at least one capital letter to make your password stronger.';
    if (!/[0-9]/.test(password)) return 'Add at least one number to make your password stronger.';
    return '';
  }

  return (
    <div className="page-wrapper">
      <Navbar />
      <div className="auth-container">
        <form className="auth-card" onSubmit={handleLogin}>
          <h2 className="auth-title">Sign In to your account</h2>

          {/* Banner shown when redirected from assessment */}
          {fromAssessment && (
            <div className="auth-info-banner">
              🔒 Please sign in to view your supplement recommendations. Your assessment has been saved.
            </div>
          )}

          {error && !showOtpModal && <p className="auth-error">{error}</p>}

          <div className={`auth-field ${fieldErrors.email ? 'field-has-error' : ''}`}>
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (fieldErrors.email) validateField('email', e.target.value); }}
              onBlur={(e) => validateField('email', e.target.value)}
              placeholder="your.email@example.com"
              required
            />
            {fieldErrors.email && <span className="auth-field-error">{fieldErrors.email}</span>}
          </div>

          <div className={`auth-field ${fieldErrors.password ? 'field-has-error' : ''}`}>
            <label>Password</label>
            <div className="auth-input-wrap">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => { setPassword(e.target.value); if (fieldErrors.password) validateField('password', e.target.value); }}
                onBlur={(e) => validateField('password', e.target.value)}
                placeholder="Enter your password"
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

          <button type="submit" className="auth-btn" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

          <div className="auth-forgot-password">
            <button 
              type="button" 
              className="auth-forgot-password-link" 
              onClick={handleForgotPasswordClick}
            >
              Forgot Password?
            </button>
          </div>

          <p className="auth-switch">
            Don't have an account?{' '}
            <NavLink to="/signup" state={location.state}>Create one</NavLink>
          </p>
        </form>
      </div>

      {/* OTP Verification Modal */}
      {showOtpModal && (
        <div className="profile-modal-overlay" onClick={() => !otpLoading && handleCancelOtp()}>
          <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Login Verification</h2>
            <p>{requiresTwoFactor ? 'Enter the current code from Google Authenticator.' : "For your security, we've sent a 6-digit verification code to:"}</p>
            {!requiresTwoFactor && <p className="profile-modal-email">{email}</p>}
            <p className="profile-modal-note">Please enter the code to complete your login.</p>
            
            {/* OTP Expiry Timer */}
            <div className="otp-expiry-timer">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
              <span className={otpTimeLeft <= 60 ? 'expiring-soon' : ''}>
                Code expires in {formatTimeLeft(otpTimeLeft)}
              </span>
            </div>
            
            <input
              type="text"
              className="profile-otp-input"
              placeholder="Enter 6-digit code"
              value={otp}
              onChange={(e) => {
                const value = e.target.value.replace(/\D/g, '').slice(0, 6);
                setOtp(value);
                setError('');
              }}
              maxLength="6"
              disabled={otpLoading || otpTimeLeft === 0}
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
                disabled={otpLoading || otp.length !== 6 || otpTimeLeft === 0}
              >
                {otpLoading ? 'Verifying...' : 'Verify & Sign In'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Forgot Password Modal */}
      {showForgotPasswordModal && (
        <div className="profile-modal-overlay" onClick={() => !loading && !otpLoading && handleCloseForgotPassword()}>
          <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
            {forgotPasswordStep === 'email' && (
              <>
                <h2>Reset Your Password</h2>
                <p>Enter your email address and we'll send you a verification code.</p>
                
                <form onSubmit={handleForgotPasswordSubmitEmail}>
                  <div className="auth-field">
                    <label>Email</label>
                    <input
                      type="email"
                      className="profile-otp-input"
                      placeholder="your.email@example.com"
                      value={forgotPasswordEmail}
                      onChange={(e) => {
                        setForgotPasswordEmail(e.target.value);
                        setError('');
                      }}
                      disabled={loading}
                      autoFocus
                      required
                    />
                  </div>

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

                  <div className="profile-modal-actions">
                    <button
                      type="button"
                      className="profile-modal-btn profile-modal-btn-secondary"
                      onClick={handleCloseForgotPassword}
                      disabled={loading}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="profile-modal-btn profile-modal-btn-primary"
                      disabled={loading || resendCooldown > 0}
                    >
                      {loading ? 'Sending...' : resendCooldown > 0 ? `Wait ${resendCooldown}s` : 'Send Code'}
                    </button>
                  </div>
                </form>
              </>
            )}

            {forgotPasswordStep === 'otp' && (
              <>
                <h2>Verify Your Email</h2>
                <p>We've sent a 6-digit verification code to:</p>
                <p className="profile-modal-email">{forgotPasswordEmail}</p>
                <p className="profile-modal-note">Enter the code to continue.</p>
                
                {/* OTP Expiry Timer */}
                <div className="otp-expiry-timer">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                  <span className={otpTimeLeft <= 60 ? 'expiring-soon' : ''}>
                    Code expires in {formatTimeLeft(otpTimeLeft)}
                  </span>
                </div>
                
                <input
                  type="text"
                  className="profile-otp-input"
                  placeholder="Enter 6-digit code"
                  value={resetOtp}
                  onChange={(e) => {
                    const value = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setResetOtp(value);
                    setError('');
                  }}
                  maxLength="6"
                  disabled={otpLoading || otpTimeLeft === 0}
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

                <div className="profile-modal-resend">
                  <button
                    type="button"
                    className="profile-modal-resend-btn"
                    onClick={handleResendResetOtp}
                    disabled={resendCooldown > 0 || otpLoading}
                  >
                    {resendCooldown > 0 
                      ? `Send Again (${resendCooldown}s)` 
                      : 'Send Again'}
                  </button>
                </div>

                <div className="profile-modal-actions">
                  <button
                    type="button"
                    className="profile-modal-btn profile-modal-btn-secondary"
                    onClick={handleCloseForgotPassword}
                    disabled={otpLoading}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="profile-modal-btn profile-modal-btn-primary"
                    onClick={handleVerifyResetOtp}
                    disabled={otpLoading || resetOtp.length !== 6 || otpTimeLeft === 0}
                  >
                    {otpLoading ? 'Verifying...' : 'Verify Code'}
                  </button>
                </div>
              </>
            )}

            {forgotPasswordStep === 'password' && (
              <>
                <h2>Create New Password</h2>
                <p>Enter a strong password for your account.</p>
                
                <form onSubmit={handleResetPassword}>
                  <div className="auth-field">
                    <label>New Password</label>
                    <div className="auth-input-wrap">
                      <input
                        type={showNewPassword ? 'text' : 'password'}
                        className="profile-otp-input"
                        placeholder="Create a strong password"
                        value={newPassword}
                        onChange={(e) => {
                          setNewPassword(e.target.value);
                          setError('');
                        }}
                        disabled={loading}
                        required
                      />
                      <button type="button" className="eye-btn" onClick={() => setShowNewPassword(s => !s)} aria-label="Toggle password visibility">
                        {showNewPassword ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="auth-field">
                    <label>Confirm New Password</label>
                    <div className="auth-input-wrap">
                      <input
                        type={showConfirmNewPassword ? 'text' : 'password'}
                        className="profile-otp-input"
                        placeholder="Confirm your password"
                        value={confirmNewPassword}
                        onChange={(e) => {
                          setConfirmNewPassword(e.target.value);
                          setError('');
                        }}
                        disabled={loading}
                        required
                      />
                      <button type="button" className="eye-btn" onClick={() => setShowConfirmNewPassword(s => !s)} aria-label="Toggle confirm password visibility">
                        {showConfirmNewPassword ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        )}
                      </button>
                    </div>
                  </div>

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

                  <div className="profile-modal-actions">
                    <button
                      type="button"
                      className="profile-modal-btn profile-modal-btn-secondary"
                      onClick={handleCloseForgotPassword}
                      disabled={loading}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="profile-modal-btn profile-modal-btn-primary"
                      disabled={loading}
                    >
                      {loading ? 'Resetting...' : 'Reset Password'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default LogIn;
