import { useState, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { registerUser, saveAssessment, getRecommendations, saveAssessmentResults, getCaptcha, startSession } from '../api';
import { beginAuthTransition, endAuthTransition } from '../auth/authState';
import { safeRedirectPath } from '../utils/safeUrl';
import './LogIn.css';
import './SignIn.css';

const SESSION_KEY = 'pending_assessment';

// Strict email regex — requires a proper TLD (2–6 letters), rejects .con, .cmo, etc.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,6}$/;

// Common typo TLDs to warn about
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

function validatePassword(password) {
  if (!password) return 'Please enter a password.';
  if (password.length < 8) return 'Your password is too short — please use at least 8 characters.';
  if (password.length > 128) return 'Your password must be 128 characters or fewer.';
  if (!/[A-Z]/.test(password)) return 'Add at least one capital letter to make your password stronger.';
  if (!/[0-9]/.test(password)) return 'Add at least one number to make your password stronger.';
  return '';
}

function SignIn() {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [gender, setGender] = useState('');
  const [birthMonth, setBirthMonth] = useState('');
  const [birthDay, setBirthDay] = useState('');
  const [birthYear, setBirthYear] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [captcha, setCaptcha] = useState(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const fromAssessment = location.state?.fromAssessment;

  const loadCaptcha = async () => {
    setCaptchaLoading(true);
    try {
      const data = await getCaptcha();
      setCaptcha(data);
      setCaptchaAnswer('');
    } catch {
      setCaptcha(null);
    } finally {
      setCaptchaLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time challenge fetch on mount
    loadCaptcha();
  }, []);

  // Months array
  const months = [
    { value: '01', label: 'January' },
    { value: '02', label: 'February' },
    { value: '03', label: 'March' },
    { value: '04', label: 'April' },
    { value: '05', label: 'May' },
    { value: '06', label: 'June' },
    { value: '07', label: 'July' },
    { value: '08', label: 'August' },
    { value: '09', label: 'September' },
    { value: '10', label: 'October' },
    { value: '11', label: 'November' },
    { value: '12', label: 'December' },
  ];

  // Shared date-of-birth validator (single source of truth for blur + submit).
  // Uses the local Date constructor (never an ISO string) so timezones can't
  // shift the day and falsely reject valid birthdays. Pure: takes explicit
  // values, so callers never validate stale state.
  const validateDob = (month, day, year) => {
    if (!month || !day || !year) {
      return 'Please select your complete date of birth.';
    }
    if (!months.some(m => m.value === month)) {
      return 'Please select a valid month.';
    }
    const dayStr = String(day).trim();
    const yearStr = String(year).trim();
    const currentYear = new Date().getFullYear();
    const minYear = currentYear - 120;
    if (!/^\d{1,2}$/.test(dayStr)) {
      return 'Day must be between 1 and 31.';
    }
    if (!/^\d{3,4}$/.test(yearStr)) {
      return `Year must be between ${minYear} and ${currentYear}.`;
    }
    const dayNum = parseInt(dayStr, 10);
    const yearNum = parseInt(yearStr, 10);
    if (yearNum < minYear || yearNum > currentYear) {
      return `Year must be between ${minYear} and ${currentYear}.`;
    }
    if (dayNum < 1 || dayNum > 31) {
      return 'Day must be between 1 and 31.';
    }
    // Local constructor: no UTC shift (Feb 30 etc. roll over -> detected below)
    const monthIdx = parseInt(month, 10) - 1;
    const birthDate = new Date(yearNum, monthIdx, dayNum);
    if (isNaN(birthDate.getTime()) ||
        birthDate.getFullYear() !== yearNum ||
        birthDate.getMonth() !== monthIdx ||
        birthDate.getDate() !== dayNum) {
      return 'Please enter a valid calendar date (e.g., February cannot have 30 days).';
    }
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    if (age < 1) {
      return 'You must be at least 1 year old.';
    }
    if (age > 120) {
      return 'Age must be 120 years or less.';
    }
    return '';
  };

  // Validate a single field and update fieldErrors
  const validateField = (field, value) => {
    let msg = '';
    if (field === 'firstName') {
      if (!value.trim()) msg = 'Please enter your first name.';
      else if (value.trim().length < 2) msg = 'First name must be at least 2 characters.';
      else if (value.trim().length > 50) msg = 'First name must be 50 characters or fewer.';
    } else if (field === 'lastName') {
      if (!value.trim()) msg = 'Please enter your last name.';
      else if (value.trim().length < 2) msg = 'Last name must be at least 2 characters.';
      else if (value.trim().length > 50) msg = 'Last name must be 50 characters or fewer.';
    } else if (field === 'gender') {
      if (!value) msg = 'Please select your gender.';
    } else if (field === 'dateOfBirth') {
      msg = validateDob(birthMonth, birthDay, birthYear);
    } else if (field === 'email') {
      msg = validateEmail(value);
    } else if (field === 'password') {
      msg = validatePassword(value);
    } else if (field === 'confirmPassword') {
      if (!value) msg = 'Please confirm your password.';
      else if (value !== password) msg = 'Passwords do not match.';
    }
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // Run all validations
    const firstNameErr = !firstName.trim() ? 'Please enter your first name.'
      : firstName.trim().length < 2 ? 'First name must be at least 2 characters.'
      : firstName.trim().length > 50 ? 'First name must be 50 characters or fewer.' : '';
    const lastNameErr = !lastName.trim() ? 'Please enter your last name.'
      : lastName.trim().length < 2 ? 'Last name must be at least 2 characters.'
      : lastName.trim().length > 50 ? 'Last name must be 50 characters or fewer.' : '';
    const genderErr = !gender ? 'Please select your gender.' : '';
    const dateOfBirthErr = validateDob(birthMonth, birthDay, birthYear);

    const emailErr = validateEmail(email);
    const passwordErr = validatePassword(password);
    const confirmErr = !confirmPassword ? 'Please confirm your password.'
      : confirmPassword !== password ? 'Passwords do not match.' : '';
    const captchaErr = !captcha
      ? 'Could not load the security check. Please refresh the challenge.'
      : !captchaAnswer.trim()
        ? 'Please solve the math challenge.'
        : !/^-?\d+$/.test(captchaAnswer.trim())
          ? 'The answer must be a number.' : '';

    const newErrors = { firstName: firstNameErr, lastName: lastNameErr, gender: genderErr, dateOfBirth: dateOfBirthErr, email: emailErr, password: passwordErr, confirmPassword: confirmErr, captcha: captchaErr };
    setFieldErrors(newErrors);

    if (Object.values(newErrors).some(Boolean)) return;

    setLoading(true);
    // Hold the public-route guard until this signup decides its landing
    // page — the token write below emits, and the guard must not bounce
    // /signup → /dashboard before the pending-assessment flow finishes.
    beginAuthTransition();
    try {
      const dateOfBirth = `${birthYear}-${birthMonth}-${birthDay.toString().padStart(2, '0')}`;
      const data = await registerUser(firstName, lastName, gender, dateOfBirth, email, password, { id: captcha.id, answer: captchaAnswer.trim() });
      // Per-account session keys — an account already signed in on this
      // browser keeps its own token and stays switchable.
      const switchedFrom = startSession(data.token, {
        firstName: data.firstName, 
        lastName: data.lastName, 
        name: data.name, 
        email: data.email,
        gender: data.gender,
        dateOfBirth: data.dateOfBirth,
        age: data.age,
        profilePicture: data.profilePicture || '',
        bannerPicture: data.bannerPicture || '',
        subscriptionActive: data.subscriptionActive === true,
        subscriptionPlan: data.subscriptionPlan || 'free',
        // Resolved snapshot (expiry-aware) — the plan store renders from this.
        subscription: data.subscription ?? null,
      });

      // Publish the new account's plan to the shared store immediately.
      try { window.dispatchEvent(new Event('suppliwise:subscription')); } catch { /* non-browser safe */ }

      const pending = sessionStorage.getItem(SESSION_KEY);
      if (pending) {
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
      } else {
        // Check if there's a redirect destination from HomePage.
        // Same-origin app paths only (see LogIn.jsx) — an absolute URL in
        // router state must never turn sign-up into an open redirect.
        const redirectTo = safeRedirectPath(location.state?.redirectTo);
        if (switchedFrom) window.location.href = redirectTo;
        else navigate(redirectTo);
      }
    } catch (err) {
      setError(err.message);
      // Challenge is single-use: a failed attempt needs a fresh one
      if (err.captchaFailed) {
        setCaptchaAnswer('');
        loadCaptcha();
      }
    } finally {
      endAuthTransition();
      setLoading(false);
    }
  };

  return (
    <div className="page-wrapper">
      <Navbar />
      <div className="auth-container">
        <form className="auth-card" onSubmit={handleSubmit}>
          <div className="auth-badge" aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12h4l2.5-6 4 12L16 12h5" />
            </svg>
          </div>
          <h2 className="auth-title">Create Account</h2>
          <p className="auth-subtitle">Create your free account to save assessments, track progress and get AI-powered recommendations.</p>
          <hr className="auth-divider" />

          {fromAssessment && (
            <div className="auth-info-banner">
              🔒 Create an account to view your supplement recommendations. Your assessment has been saved.
            </div>
          )}

          {error && <p className="auth-error">{error}</p>}

          <div className="name-row">
            <div className={`auth-field ${fieldErrors.firstName ? 'field-has-error' : ''}`}>
              <label>First Name</label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => { setFirstName(e.target.value); revalidateOnChange('firstName', e.target.value); }}
                onBlur={(e) => validateField('firstName', e.target.value)}
                placeholder="Enter your first name"
                maxLength={50}
                autoComplete="given-name"
                required
              />
              {fieldErrors.firstName && <span className="auth-field-error">{fieldErrors.firstName}</span>}
            </div>

            <div className={`auth-field ${fieldErrors.lastName ? 'field-has-error' : ''}`}>
              <label>Last Name</label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => { setLastName(e.target.value); revalidateOnChange('lastName', e.target.value); }}
                onBlur={(e) => validateField('lastName', e.target.value)}
                placeholder="Enter your last name"
                maxLength={50}
                autoComplete="family-name"
                required
              />
              {fieldErrors.lastName && <span className="auth-field-error">{fieldErrors.lastName}</span>}
            </div>
          </div>

          <div className={`auth-field ${fieldErrors.dateOfBirth ? 'field-has-error' : ''}`}>
            <label>Date of Birth</label>
            <div className="birthday-row-inline">
              <div className="birthday-field-wrapper">
                <select
                  value={birthMonth}
                  onChange={(e) => { setBirthMonth(e.target.value); }}
                  onBlur={() => validateField('dateOfBirth', birthMonth)}
                  className="birthday-select-inline"
                  required
                >
                  <option value="" disabled>Month</option>
                  {months.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              
              <div className="birthday-field-wrapper">
                <input
                  type="number"
                  value={birthDay}
                  onChange={(e) => { const clean = e.target.value.replace(/[^0-9]/g, '').slice(0, 2); setBirthDay(clean); }}
                  onBlur={() => validateField('dateOfBirth', birthDay)}
                  className="birthday-input-inline"
                  placeholder="DD"
                  min="1"
                  max="31"
                  required
                />
              </div>
              
              <div className="birthday-field-wrapper">
                <input
                  type="number"
                  value={birthYear}
                  onChange={(e) => { const clean = e.target.value.replace(/[^0-9]/g, '').slice(0, 4); setBirthYear(clean); }}
                  onBlur={() => validateField('dateOfBirth', birthYear)}
                  className="birthday-input-inline"
                  placeholder="YYYY"
                  min={new Date().getFullYear() - 120}
                  max={new Date().getFullYear()}
                  required
                />
              </div>
            </div>
            {fieldErrors.dateOfBirth && <span className="auth-field-error">{fieldErrors.dateOfBirth}</span>}
          </div>

          <div className={`auth-field ${fieldErrors.gender ? 'field-has-error' : ''}`}>
            <label>Gender</label>
            <div className="gender-pill-group">
              <button
                type="button"
                className={`gender-pill ${gender === 'Male' ? 'gender-pill-active' : ''}`}
                onClick={() => { setGender('Male'); if (fieldErrors.gender) validateField('gender', 'Male'); }}
              >
                Male
              </button>
              <button
                type="button"
                className={`gender-pill ${gender === 'Female' ? 'gender-pill-active' : ''}`}
                onClick={() => { setGender('Female'); if (fieldErrors.gender) validateField('gender', 'Female'); }}
              >
                Female
              </button>
            </div>
            {fieldErrors.gender && <span className="auth-field-error">{fieldErrors.gender}</span>}
          </div>

          <div className={`auth-field ${fieldErrors.email ? 'field-has-error' : ''}`}>
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); revalidateOnChange('email', e.target.value); }}
              onBlur={(e) => validateField('email', e.target.value)}
              placeholder="your.email@example.com"
              maxLength={254}
              autoComplete="email"
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
                onChange={(e) => { setPassword(e.target.value); revalidateOnChange('password', e.target.value); }}
                onBlur={(e) => validateField('password', e.target.value)}
                placeholder="Create a strong password"
                maxLength={128}
                autoComplete="new-password"
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

          <div className={`auth-field ${fieldErrors.confirmPassword ? 'field-has-error' : ''}`}>
            <label>Confirm Password</label>
            <div className="auth-input-wrap">
              <input
                type={showConfirm ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); revalidateOnChange('confirmPassword', e.target.value); }}
                onBlur={(e) => validateField('confirmPassword', e.target.value)}
                placeholder="Confirm your password"
                maxLength={128}
                autoComplete="new-password"
                required
              />
              <button type="button" className="eye-btn" onClick={() => setShowConfirm(s => !s)} aria-label="Toggle confirm password visibility">
                {showConfirm ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
            {fieldErrors.confirmPassword && <span className="auth-field-error">{fieldErrors.confirmPassword}</span>}
          </div>

          <div className={`auth-field ${fieldErrors.captcha ? 'field-has-error' : ''}`}>
            <label>Security Check</label>
            <div className="captcha-row">
              <div className="captcha-question" aria-live="polite">
                {captchaLoading ? 'Loading…' : (captcha ? captcha.question : 'Unavailable')}
              </div>
              <button
                type="button"
                className="captcha-refresh"
                onClick={loadCaptcha}
                disabled={captchaLoading}
                aria-label="Get a new math challenge"
                title="New challenge"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="1 4 1 10 7 10" />
                  <polyline points="23 20 23 14 17 14" />
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15" />
                </svg>
              </button>
              <input
                type="text"
                inputMode="numeric"
                value={captchaAnswer}
                onChange={(e) => { setCaptchaAnswer(e.target.value.replace(/[^0-9-]/g, '').slice(0, 6)); if (fieldErrors.captcha) validateField('captcha', e.target.value); }}
                placeholder="Answer"
                aria-label="Math challenge answer"
                className="captcha-input"
              />
            </div>
            {fieldErrors.captcha && <span className="auth-field-error">{fieldErrors.captcha}</span>}
          </div>

          <button type="submit" className="auth-btn" disabled={loading}>
            {loading ? 'Creating account...' : 'Register'}
          </button>

          <p className="auth-switch">
            Already Have an Account?{' '}
            <NavLink to="/login">Login</NavLink>
          </p>
        </form>
      </div>
    </div>
  );
}

export default SignIn;
