import { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { registerUser, saveAssessment, getRecommendations, saveAssessmentResults } from '../api';
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
  const navigate = useNavigate();
  const location = useLocation();

  const fromAssessment = location.state?.fromAssessment;

  // Generate years array (current year down to 100 years ago)
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 100 }, (_, i) => currentYear - i);
  
  // Generate days array (1-31)
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  
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
      if (!birthMonth || !birthDay || !birthYear) {
        msg = 'Please select your complete date of birth.';
      } else {
        // Check year range (current year to 120 years ago)
        const year = parseInt(birthYear);
        const currentYear = new Date().getFullYear();
        const minYear = currentYear - 120;
        if (year < minYear || year > currentYear) {
          msg = `Year must be between ${minYear} and ${currentYear}.`;
        }
        // Check day range
        else if (parseInt(birthDay) < 1 || parseInt(birthDay) > 31) {
          msg = 'Day must be between 1 and 31.';
        }
        // Validate actual calendar date
        else {
          const dateOfBirth = `${birthYear}-${birthMonth}-${birthDay.toString().padStart(2, '0')}`;
          const birthDate = new Date(dateOfBirth);
          
          // Check if date is valid (e.g., Feb 30 would be invalid)
          if (isNaN(birthDate.getTime()) || 
              birthDate.getMonth() !== parseInt(birthMonth) - 1 ||
              birthDate.getDate() !== parseInt(birthDay)) {
            msg = 'Please enter a valid calendar date (e.g., February cannot have 30 days).';
          } else {
            // Check age
            const today = new Date();
            let age = today.getFullYear() - birthDate.getFullYear();
            const monthDiff = today.getMonth() - birthDate.getMonth();
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
              age--;
            }
            if (age < 1) {
              msg = 'You must be at least 1 year old.';
            } else if (age > 120) {
              msg = 'Age must be 120 years or less.';
            }
          }
        }
      }
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
    
    let dateOfBirthErr = '';
    if (!birthMonth || !birthDay || !birthYear) {
      dateOfBirthErr = 'Please select your complete date of birth.';
    } else {
      // Check year range (current year to 120 years ago)
      const year = parseInt(birthYear);
      const currentYear = new Date().getFullYear();
      const minYear = currentYear - 120;
      if (year < minYear || year > currentYear) {
        dateOfBirthErr = `Year must be between ${minYear} and ${currentYear}.`;
      }
      // Check day range
      else if (parseInt(birthDay) < 1 || parseInt(birthDay) > 31) {
        dateOfBirthErr = 'Day must be between 1 and 31.';
      }
      // Validate actual calendar date
      else {
        const dateOfBirth = `${birthYear}-${birthMonth}-${birthDay.toString().padStart(2, '0')}`;
        const birthDate = new Date(dateOfBirth);
        
        // Check if date is valid (e.g., Feb 30 would be invalid)
        if (isNaN(birthDate.getTime()) || 
            birthDate.getMonth() !== parseInt(birthMonth) - 1 ||
            birthDate.getDate() !== parseInt(birthDay)) {
          dateOfBirthErr = 'Please enter a valid calendar date (e.g., February cannot have 30 days).';
        } else {
          // Check age
          const today = new Date();
          let age = today.getFullYear() - birthDate.getFullYear();
          const monthDiff = today.getMonth() - birthDate.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
            age--;
          }
          if (age < 1) {
            dateOfBirthErr = 'You must be at least 1 year old.';
          } else if (age > 120) {
            dateOfBirthErr = 'Age must be 120 years or less.';
          }
        }
      }
    }

    const emailErr = validateEmail(email);
    const passwordErr = validatePassword(password);
    const confirmErr = !confirmPassword ? 'Please confirm your password.'
      : confirmPassword !== password ? 'Passwords do not match.' : '';

    const newErrors = { firstName: firstNameErr, lastName: lastNameErr, gender: genderErr, dateOfBirth: dateOfBirthErr, email: emailErr, password: passwordErr, confirmPassword: confirmErr };
    setFieldErrors(newErrors);

    if (Object.values(newErrors).some(Boolean)) return;

    setLoading(true);
    try {
      const dateOfBirth = `${birthYear}-${birthMonth}-${birthDay.toString().padStart(2, '0')}`;
      const data = await registerUser(firstName, lastName, gender, dateOfBirth, email, password);
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify({ 
        firstName: data.firstName, 
        lastName: data.lastName, 
        name: data.name, 
        email: data.email,
        gender: data.gender,
        dateOfBirth: data.dateOfBirth,
        age: data.age,
        profilePicture: data.profilePicture || '',
        bannerPicture: data.bannerPicture || ''
      }));

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
        <form className="auth-card" onSubmit={handleSubmit}>
          <h2 className="auth-title">Create Account</h2>
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
                onChange={(e) => { setFirstName(e.target.value); if (fieldErrors.firstName) validateField('firstName', e.target.value); }}
                onBlur={(e) => validateField('firstName', e.target.value)}
                placeholder="Enter your first name"
                required
              />
              {fieldErrors.firstName && <span className="auth-field-error">{fieldErrors.firstName}</span>}
            </div>

            <div className={`auth-field ${fieldErrors.lastName ? 'field-has-error' : ''}`}>
              <label>Last Name</label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => { setLastName(e.target.value); if (fieldErrors.lastName) validateField('lastName', e.target.value); }}
                onBlur={(e) => validateField('lastName', e.target.value)}
                placeholder="Enter your last name"
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
                  onChange={(e) => { setBirthMonth(e.target.value); if (fieldErrors.dateOfBirth) validateField('dateOfBirth', e.target.value); }}
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
                  onChange={(e) => { setBirthDay(e.target.value); if (fieldErrors.dateOfBirth) validateField('dateOfBirth', e.target.value); }}
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
                  onChange={(e) => { setBirthYear(e.target.value); if (fieldErrors.dateOfBirth) validateField('dateOfBirth', e.target.value); }}
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
                placeholder="Create a strong password"
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
                onChange={(e) => { setConfirmPassword(e.target.value); if (fieldErrors.confirmPassword) validateField('confirmPassword', e.target.value); }}
                onBlur={(e) => validateField('confirmPassword', e.target.value)}
                placeholder="Confirm your password"
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
