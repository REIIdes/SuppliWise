import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import './ProfilePage.css';

function ProfilePage() {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [otp, setOtp] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [pendingEmailChange, setPendingEmailChange] = useState('');
  const [profilePicture, setProfilePicture] = useState('');
  const [profilePicturePreview, setProfilePicturePreview] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendTimer, setResendTimer] = useState(null);
  const [otpTimeLeft, setOtpTimeLeft] = useState(600); // 10 minutes in seconds
  const [otpExpiryTimer, setOtpExpiryTimer] = useState(null);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    dateOfBirth: '',
    gender: '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login');
      return;
    }

    // Load user data from localStorage
    const userRaw = localStorage.getItem('user');
    if (userRaw) {
      const user = JSON.parse(userRaw);
      setFormData(prev => ({
        ...prev,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        email: user.email || '',
        dateOfBirth: user.dateOfBirth ? new Date(user.dateOfBirth).toISOString().split('T')[0] : '',
        gender: user.gender || '',
      }));
      setProfilePicture(user.profilePicture || '');
      setProfilePicturePreview(user.profilePicture || '');
    }

    // Cleanup timer on unmount
    return () => {
      if (resendTimer) {
        clearInterval(resendTimer);
      }
      if (otpExpiryTimer) {
        clearInterval(otpExpiryTimer);
      }
    };
  }, [navigate, resendTimer, otpExpiryTimer]);

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

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setError('');
    setSuccess('');
  };

  const handleProfilePictureChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file.');
      return;
    }

    // Validate file size (max 2MB)
    if (file.size > 2 * 1024 * 1024) {
      setError('Image size must be less than 2MB.');
      return;
    }

    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      setProfilePicturePreview(reader.result);
    };
    reader.readAsDataURL(file);

    setError('');
  };

  const handleProfilePictureClick = () => {
    if (isEditing) {
      fileInputRef.current?.click();
    }
  };

  const handleRemoveProfilePicture = () => {
    setProfilePicturePreview('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const requestEmailOtp = async (newEmail) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('http://localhost:5000/api/auth/request-email-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ newEmail }),
      });

      const data = await response.json();
      if (!response.ok) {
        // Handle rate limit specifically
        if (response.status === 429 && data.remainingSeconds) {
          startResendCooldown(data.remainingSeconds);
        }
        throw new Error(data.message || 'Failed to send OTP');
      }

      // Start cooldown timer (60 seconds)
      startResendCooldown(60);
      startOtpExpiryTimer(); // Start OTP expiry countdown

      return true;
    } catch (err) {
      throw err;
    }
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

  const handleResendOtp = async () => {
    if (resendCooldown > 0) return;
    
    setError('');
    setOtpLoading(true);

    try {
      await requestEmailOtp(pendingEmailChange);
      setSuccess('Verification code sent again!');
      setTimeout(() => setSuccess(''), 3000);
      startOtpExpiryTimer(); // Restart expiry timer with new OTP
    } catch (err) {
      setError(err.message || 'Failed to resend code. Please try again.');
    } finally {
      setOtpLoading(false);
    }
  };

  const verifyEmailOtp = async () => {
    setOtpLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('http://localhost:5000/api/auth/verify-email-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ 
          newEmail: pendingEmailChange,
          otp: otp.trim(),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Invalid OTP');
      }

      return true;
    } catch (err) {
      throw err;
    } finally {
      setOtpLoading(false);
    }
  };

  const handleOtpSubmit = async () => {
    if (otp.trim().length !== 6) {
      setError('Please enter a valid 6-digit OTP.');
      return;
    }

    try {
      await verifyEmailOtp();
      setShowOtpModal(false);
      setOtp('');
      // Continue with profile update
      await submitProfileUpdate(true);
    } catch (err) {
      setError(err.message || 'Invalid OTP. Please try again.');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    // Check if email has changed
    const userRaw = localStorage.getItem('user');
    const currentUser = userRaw ? JSON.parse(userRaw) : null;
    const newEmail = formData.email.trim().toLowerCase();
    
    if (currentUser && newEmail !== currentUser.email.toLowerCase()) {
      // Email changed - request OTP
      setLoading(true);
      try {
        await requestEmailOtp(newEmail);
        setPendingEmailChange(newEmail);
        setShowOtpModal(true);
        setError('');
        setLoading(false);
      } catch (err) {
        setError(err.message || 'Failed to send verification code.');
        setLoading(false);
      }
    } else {
      // No email change - proceed with update
      await submitProfileUpdate(false);
    }
  };

  const submitProfileUpdate = async (emailVerified) => {
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login');
        return;
      }

      // Prepare update data
      const updateData = {
        firstName: formData.firstName.trim(),
        lastName: formData.lastName.trim(),
        email: emailVerified ? pendingEmailChange : formData.email.trim().toLowerCase(),
        dateOfBirth: formData.dateOfBirth,
        gender: formData.gender,
        emailVerified: emailVerified,
      };

      // Add profile picture if changed
      if (profilePicturePreview !== profilePicture) {
        if (fileInputRef.current?.files[0]) {
          updateData.profilePicture = profilePicturePreview;
        } else if (profilePicturePreview === '') {
          updateData.profilePicture = '';
        }
      }

      // Add password fields only if user wants to change password
      if (formData.newPassword) {
        if (formData.newPassword !== formData.confirmPassword) {
          setError('New passwords do not match.');
          setLoading(false);
          return;
        }
        if (formData.newPassword.length < 8) {
          setError('New password must be at least 8 characters.');
          setLoading(false);
          return;
        }
        if (!/[A-Z]/.test(formData.newPassword)) {
          setError('New password must contain at least one uppercase letter.');
          setLoading(false);
          return;
        }
        if (!/[0-9]/.test(formData.newPassword)) {
          setError('New password must contain at least one number.');
          setLoading(false);
          return;
        }
        if (!formData.currentPassword) {
          setError('Please enter your current password to change it.');
          setLoading(false);
          return;
        }
        updateData.currentPassword = formData.currentPassword;
        updateData.newPassword = formData.newPassword;
      }

      const response = await fetch('http://localhost:5000/api/auth/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(updateData),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Failed to update profile');
      }

      // Update localStorage with new user data
      localStorage.setItem('user', JSON.stringify({
        _id: data._id,
        firstName: data.firstName,
        lastName: data.lastName,
        name: data.name,
        email: data.email,
        dateOfBirth: data.dateOfBirth,
        age: data.age,
        gender: data.gender,
        profilePicture: data.profilePicture || '',
      }));

      setProfilePicture(data.profilePicture || '');

      // Clear password fields
      setFormData(prev => ({
        ...prev,
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      }));

      setPendingEmailChange('');
      setSuccess('Profile updated successfully! Changes will apply to future assessments.');
      setIsEditing(false);

      // Refresh the page to update navbar
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    // Reload user data from localStorage
    const userRaw = localStorage.getItem('user');
    if (userRaw) {
      const user = JSON.parse(userRaw);
      setFormData({
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        email: user.email || '',
        dateOfBirth: user.dateOfBirth ? new Date(user.dateOfBirth).toISOString().split('T')[0] : '',
        gender: user.gender || '',
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      });
      setProfilePicturePreview(user.profilePicture || '');
    }
    setIsEditing(false);
    setError('');
    setSuccess('');
    setShowOtpModal(false);
    setOtp('');
    setPendingEmailChange('');
    setOtpTimeLeft(600);
    if (resendTimer) clearInterval(resendTimer);
    if (otpExpiryTimer) clearInterval(otpExpiryTimer);
  };

  const calculateAge = (dob) => {
    if (!dob) return '';
    const today = new Date();
    const birthDate = new Date(dob);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  };

  return (
    <>
      <Navbar />
      <div className="profile-page">
        <div className="profile-container">
          <div className="profile-header">
            <div 
              className="profile-avatar-large" 
              onClick={handleProfilePictureClick}
              style={{ 
                cursor: isEditing ? 'pointer' : 'default',
                backgroundImage: profilePicturePreview ? `url(${profilePicturePreview})` : 'none',
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            >
              {!profilePicturePreview && formData.firstName.charAt(0).toUpperCase()}
              {isEditing && (
                <div className="profile-avatar-overlay">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  <span>Change</span>
                </div>
              )}
            </div>
            {isEditing && profilePicturePreview && (
              <button 
                type="button"
                className="profile-remove-picture"
                onClick={handleRemoveProfilePicture}
              >
                Remove Picture
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleProfilePictureChange}
              style={{ display: 'none' }}
            />
            <h1 className="profile-title">Profile Settings</h1>
            <p className="profile-subtitle">Manage your account information</p>
          </div>

          <form onSubmit={handleSubmit} className="profile-form">
            <div className="profile-info-notice">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <div>
                <strong>Important:</strong> Changes to Date of Birth and Gender will only apply to future assessments. 
                Previously completed assessments and their AI recommendations will remain unchanged to preserve 
                the accuracy and history of past assessment records.
              </div>
            </div>

            {error && (
              <div className="profile-alert profile-alert-error">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {error}
              </div>
            )}

            {success && (
              <div className="profile-alert profile-alert-success">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                {success}
              </div>
            )}

            <div className="profile-section">
              <h2 className="profile-section-title">Personal Information</h2>
              
              <div className="profile-form-row">
                <div className="profile-form-group">
                  <label htmlFor="firstName">First Name</label>
                  <input
                    type="text"
                    id="firstName"
                    name="firstName"
                    value={formData.firstName}
                    onChange={handleChange}
                    disabled={!isEditing}
                    required
                  />
                </div>

                <div className="profile-form-group">
                  <label htmlFor="lastName">Last Name</label>
                  <input
                    type="text"
                    id="lastName"
                    name="lastName"
                    value={formData.lastName}
                    onChange={handleChange}
                    disabled={!isEditing}
                    required
                  />
                </div>
              </div>

              <div className="profile-form-group">
                <label htmlFor="email">Email Address</label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  disabled={!isEditing}
                  required
                />
                {isEditing && (
                  <span className="profile-helper-text">
                    Changing your email address requires verification before the update is applied.
                  </span>
                )}
              </div>

              <div className="profile-form-row">
                <div className="profile-form-group">
                  <label htmlFor="dateOfBirth">Date of Birth</label>
                  <input
                    type="date"
                    id="dateOfBirth"
                    name="dateOfBirth"
                    value={formData.dateOfBirth}
                    onChange={handleChange}
                    disabled={!isEditing}
                    required
                  />
                </div>

                <div className="profile-form-group">
                  <label htmlFor="gender">Gender</label>
                  <select
                    id="gender"
                    name="gender"
                    value={formData.gender}
                    onChange={handleChange}
                    disabled={!isEditing}
                    required
                  >
                    <option value="">Select gender</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                </div>
              </div>
            </div>

            {isEditing && (
              <div className="profile-section">
                <h2 className="profile-section-title">Change Password</h2>
                <p className="profile-section-subtitle">Leave blank to keep your current password</p>

                <div className="profile-form-group">
                  <label htmlFor="currentPassword">Current Password</label>
                  <div className="profile-password-input-wrap">
                    <input
                      type={showCurrentPassword ? 'text' : 'password'}
                      id="currentPassword"
                      name="currentPassword"
                      value={formData.currentPassword}
                      onChange={handleChange}
                      placeholder="Required to change password"
                    />
                    <button 
                      type="button" 
                      className="profile-eye-btn" 
                      onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                      aria-label="Toggle current password visibility"
                    >
                      {showCurrentPassword ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                          <line x1="1" y1="1" x2="23" y2="23"/>
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                          <circle cx="12" cy="12" r="3"/>
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                <div className="profile-form-row">
                  <div className="profile-form-group">
                    <label htmlFor="newPassword">New Password</label>
                    <div className="profile-password-input-wrap">
                      <input
                        type={showNewPassword ? 'text' : 'password'}
                        id="newPassword"
                        name="newPassword"
                        value={formData.newPassword}
                        onChange={handleChange}
                        placeholder="At least 8 characters"
                      />
                      <button 
                        type="button" 
                        className="profile-eye-btn" 
                        onClick={() => setShowNewPassword(!showNewPassword)}
                        aria-label="Toggle new password visibility"
                      >
                        {showNewPassword ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                            <line x1="1" y1="1" x2="23" y2="23"/>
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                            <circle cx="12" cy="12" r="3"/>
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="profile-form-group">
                    <label htmlFor="confirmPassword">Confirm New Password</label>
                    <div className="profile-password-input-wrap">
                      <input
                        type={showConfirmPassword ? 'text' : 'password'}
                        id="confirmPassword"
                        name="confirmPassword"
                        value={formData.confirmPassword}
                        onChange={handleChange}
                        placeholder="Re-enter new password"
                      />
                      <button 
                        type="button" 
                        className="profile-eye-btn" 
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                        aria-label="Toggle confirm password visibility"
                      >
                        {showConfirmPassword ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                            <line x1="1" y1="1" x2="23" y2="23"/>
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                            <circle cx="12" cy="12" r="3"/>
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="profile-actions">
              {!isEditing ? (
                <button
                  type="button"
                  className="profile-btn profile-btn-primary"
                  onClick={() => setIsEditing(true)}
                >
                  Edit Profile
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="profile-btn profile-btn-secondary"
                    onClick={handleCancel}
                    disabled={loading}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="profile-btn profile-btn-primary"
                    disabled={loading}
                  >
                    {loading ? 'Saving...' : 'Save Changes'}
                  </button>
                </>
              )}
            </div>
          </form>
        </div>
      </div>

      {/* OTP Verification Modal */}
      {showOtpModal && (
        <div className="profile-modal-overlay" onClick={() => !otpLoading && setShowOtpModal(false)}>
          <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Verify Email Change</h2>
            <p>We've sent a 6-digit verification code to:</p>
            <p className="profile-modal-email">{pendingEmailChange}</p>
            <p className="profile-modal-note">Please enter the code to confirm your email change.</p>
            
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
                onClick={handleResendOtp}
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
                onClick={() => {
                  setShowOtpModal(false);
                  setOtp('');
                  setPendingEmailChange('');
                  setError('');
                  setSuccess('');
                  setResendCooldown(0);
                  if (resendTimer) clearInterval(resendTimer);
                }}
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
                {otpLoading ? 'Verifying...' : 'Verify'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default ProfilePage;
