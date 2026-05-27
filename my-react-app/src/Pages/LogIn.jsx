import { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { loginUser, saveAssessment, getRecommendations, saveAssessmentResults } from '../api';
import './LogIn.css';

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
  const navigate = useNavigate();
  const location = useLocation();

  const fromAssessment = location.state?.fromAssessment;

  const validateField = (field, value) => {
    let msg = '';
    if (field === 'email') msg = validateEmail(value);
    if (field === 'password' && !value) msg = 'Please enter your password.';
    setFieldErrors(prev => ({ ...prev, [field]: msg }));
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
      const data = await loginUser(email, password);
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify({ name: data.name, email: data.email }));

      // Check for pending assessment saved before login
      const pending = sessionStorage.getItem(SESSION_KEY);
      if (pending) {
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
        navigate('/');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

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

          {error && <p className="auth-error">{error}</p>}

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

          <p className="auth-switch">
            Don't have an account?{' '}
            <NavLink to="/signup" state={location.state}>Create one</NavLink>
          </p>
        </form>
      </div>
    </div>
  );
}

export default LogIn;
