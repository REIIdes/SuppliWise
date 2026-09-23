import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import ConfirmModal from '../Components/ConfirmModal/ConfirmModal';
import AccountSwitcher from '../Components/AccountSwitcher/AccountSwitcher';
import { BASE_URL, getMyProfile, getNotifications, markNotificationRead, isSecurityNotification, signOutCurrentAccount, getToken, getStoredUser, setStoredUser } from '../api';
import { useSubscription, SUBSCRIPTION_EVENT } from '../hooks/useSubscription';
import { PLAN_LABELS, PLAN_RANK, FEATURES, planFromUser } from '../utils/plan';
import './ProfilePage.css';

// Relative time for the security activity feed
function secTimeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Display metadata for the feature showcase — the tier for each entry comes
// from the canonical registry (subscription/features.js), never from a local
// copy, so the profile can't disagree with the API.
const FEATURE_CARDS = [
  { key: 'healthAssessment',   icon: 'clipboard', text: 'Guided 4-step assessments with instant results' },
  { key: 'recommendations',    icon: 'pill',      text: 'Personalized AI picks with dosage & timing' },
  { key: 'dailyIntake',        icon: 'check',     text: 'Mark taken, streaks, calendar & adherence stats' },
  { key: 'insights',           icon: 'chart',     text: 'Wellness score, trends and phase guidance' },
  { key: 'pdfExport',          icon: 'pdf',       text: 'Download & share full assessment reports' },
  { key: 'historyFull',        icon: 'history',   text: 'Every assessment kept, searchable anytime' },
  { key: 'priorityAssessment', icon: 'flag',      text: 'Severe cases flagged for fast admin review' },
  { key: 'chat',               icon: 'spark',     text: 'Ask anything about supplements & wellness' },
];

function FeatureIcon({ icon }) {
  const paths = {
    clipboard: (<><rect x="8" y="2" width="8" height="4" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 14l2 2 4-4" /></>),
    pill: (<><path d="M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7z" /><line x1="7" y1="10" x2="14" y2="17" /></>),
    check: (<><polyline points="22 4 12 14.01 9 11.01" /><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /></>),
    chart: (<><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></>),
    pdf: (<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>),
    history: (<><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>),
    flag: (<><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></>),
    spark: (<><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /><circle cx="12" cy="12" r="3" /></>),
    lock: (<><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>),
  };
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[icon] || paths.spark}
    </svg>
  );
}

function ProfilePage() {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const bannerInputRef = useRef(null);
  // One-time read of the cached user (localStorage is the source of truth here)
  const [storedUser] = useState(() => {
    try {
      return getStoredUser() || {};
    } catch {
      return {};
    }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showDisable2FAConfirm, setShowDisable2FAConfirm] = useState(false);
  const [show2FASetup, setShow2FASetup] = useState(false);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(() => storedUser.twoFactorEnabled === true);
  const [twoFactorQrCode, setTwoFactorQrCode] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [otp, setOtp] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [pendingEmailChange, setPendingEmailChange] = useState('');
  const [profilePicture, setProfilePicture] = useState(() => storedUser.profilePicture || '');
  const [profilePicturePreview, setProfilePicturePreview] = useState(() => storedUser.profilePicture || '');
  const [bannerPicture, setBannerPicture] = useState(() => storedUser.bannerPicture || '');
  const [bannerPicturePreview, setBannerPicturePreview] = useState(() => storedUser.bannerPicture || '');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendTimer, setResendTimer] = useState(null);
  const [otpTimeLeft, setOtpTimeLeft] = useState(600); // 10 minutes in seconds
  const [otpExpiryTimer, setOtpExpiryTimer] = useState(null);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Recent security activity (lockouts, 2FA changes, password changes…)
  const [securityItems, setSecurityItems] = useState([]);
  const [secLoading, setSecLoading] = useState(true);
  const [secFlash, setSecFlash] = useState(false);
  const securityRef = useRef(null);
  const [searchParams] = useSearchParams();

  // Subscription status (starts from cache — resolved incl. expiry — then
  // syncs live + from server). Subscribing here means upgrades/downgrades by
  // admin, expiry, or another tab update the card + feature list instantly —
  // no reopen needed.
  const { active: liveActive, plan: livePlan, entitlements: liveEntitlements, refresh: refreshLivePlan, applyFresh, canAccess } = useSubscription();
  const [subscription, setSubscription] = useState(() => {
    const resolved = planFromUser(storedUser);
    return {
      active: resolved.active,
      plan: resolved.plan,
      updatedAt: storedUser.subscriptionUpdatedAt || null,
      entitlements: resolved.entitlements,
    };
  });

  // Mirror the live store into local card state (avoids stale plan display).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirroring the external subscription store is an external-system sync
    setSubscription((prev) => {
      if (prev.active === liveActive && prev.plan === livePlan && prev.entitlements === liveEntitlements) return prev;
      return { ...prev, active: liveActive, plan: livePlan, entitlements: liveEntitlements };
    });
  }, [liveActive, livePlan, liveEntitlements]);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState('');
  const profileLoadedRef = useRef(false);

  // A throttled/rate-limited refresh is never surfaced: the shared plan store
  // retries on its own, so syncing stays completely invisible. Only a real
  // failure (server down, unreachable) becomes a retriable error.
  const handleProfileRefreshError = (err) => {
    if (err?.status === 429 || err?.remainingSeconds || err?.retryAfterSeconds) {
      setProfileError('');
      return;
    }
    setProfileError(err?.message || 'Could not refresh your profile.');
  };

  const [formData, setFormData] = useState({
    firstName: storedUser.firstName || '',
    lastName: storedUser.lastName || '',
    email: storedUser.email || '',
    dateOfBirth: storedUser.dateOfBirth ? new Date(storedUser.dateOfBirth).toISOString().split('T')[0] : '',
    gender: storedUser.gender || '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  useEffect(() => {
    const token = getToken();
    if (!token) {
      navigate('/login');
      return;
    }

    // Refresh profile + subscription from the server once (cached values render instantly).
    // Keep listening: if the plan changes elsewhere (admin console, another
    // tab, expiry), the card re-syncs without reopening the profile.
    if (!profileLoadedRef.current) {
      profileLoadedRef.current = true;
      (async () => {
        try {
          setProfileLoading(true);
          setProfileError('');
          const fresh = await getMyProfile();
          setFormData(prev => ({
            ...prev,
            firstName: fresh.firstName || prev.firstName,
            lastName: fresh.lastName || prev.lastName,
            email: fresh.email || prev.email,
            dateOfBirth: fresh.dateOfBirth
              ? new Date(fresh.dateOfBirth).toISOString().split('T')[0]
              : prev.dateOfBirth,
            gender: fresh.gender || prev.gender,
          }));
          setTwoFactorEnabled(fresh.twoFactorEnabled === true);
          const live = applyFresh(fresh);
          setSubscription({
            active: live.active,
            plan: live.plan,
            updatedAt: fresh.subscriptionUpdatedAt || null,
            entitlements: live.entitlements,
          });
          // Keep the cache fresh (pictures stay untouched — /me excludes the blobs)
          try {
            const current = getStoredUser() || {};
            setStoredUser({
              ...current,
              firstName: fresh.firstName,
              lastName: fresh.lastName,
              name: fresh.name,
              email: fresh.email,
              dateOfBirth: fresh.dateOfBirth,
              gender: fresh.gender,
              twoFactorEnabled: fresh.twoFactorEnabled,
              subscriptionActive: fresh.subscriptionActive,
              subscriptionPlan: fresh.subscriptionPlan,
              subscriptionUpdatedAt: fresh.subscriptionUpdatedAt,
              // Always refreshed alongside the snapshot: dropping the window
              // made the raw fallback unable to see that a plan had expired.
              subscriptionExpiresAt: fresh.subscription?.subscriptionEnd ?? current.subscriptionExpiresAt ?? null,
              subscription: fresh.subscription ?? current.subscription ?? null,
            });
          } catch { /* cache write best-effort */ }
        } catch (err) {
          // Cached values stay on screen; show a retry instead of hanging
          handleProfileRefreshError(err);
        } finally {
          setProfileLoading(false);
        }
      })();
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

  // Live plan sync: admin changes, expiry, or another tab update this card
  // without reopening the profile.
  useEffect(() => {
    const onPlan = () => { refreshLivePlan(); };
    window.addEventListener(SUBSCRIPTION_EVENT, onPlan);
    return () => window.removeEventListener(SUBSCRIPTION_EVENT, onPlan);
  }, [refreshLivePlan]);

  // Recent security activity: newest security notices first (max 5 shown)
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getNotifications(20);
        if (cancelled) return;
        setSecurityItems((data.notifications || []).filter(isSecurityNotification).slice(0, 5));
      } catch {
        if (!cancelled) setSecurityItems([]);
      } finally {
        if (!cancelled) setSecLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Deep link from notification bell (?section=security): scroll the Account
  // Security card into view and flash it so users land where they can act.
  useEffect(() => {
    if (searchParams.get('section') !== 'security') return;
    const timer = window.setTimeout(() => {
      securityRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setSecFlash(true);
      window.setTimeout(() => setSecFlash(false), 2200);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchParams]);

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

  const handleSetup2FA = async () => {
    setError('');
    setLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/auth/setup-2fa`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to start authenticator setup.');
      setTwoFactorQrCode(data.qrCode);
      setTwoFactorCode('');
      setShow2FASetup(true);
    } catch (err) {
      setError(err.message || 'Unable to start authenticator setup.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify2FA = async () => {
    if (!/^\d{6}$/.test(twoFactorCode)) {
      setError('Enter the 6-digit code from Google Authenticator.');
      return;
    }
    setError('');
    setOtpLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/auth/verify-2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ otp: twoFactorCode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Invalid authenticator code.');
      setTwoFactorEnabled(true);
      setShow2FASetup(false);
      setTwoFactorCode('');
      setSuccess('Google Authenticator is now enabled.');
      setStoredUser({ ...(getStoredUser() || {}), twoFactorEnabled: true });
    } catch (err) {
      setError(err.message || 'Unable to verify the authenticator code.');
    } finally {
      setOtpLoading(false);
    }
  };

  const handleDisable2FA = async () => {
    if (!/^\d{6}$/.test(twoFactorCode)) {
      setError('Enter the current 6-digit authenticator code to disable 2FA.');
      return;
    }
    setError('');
    setOtpLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/auth/disable-2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ otp: twoFactorCode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to disable Google Authenticator.');
      setTwoFactorEnabled(false);
      setShowDisable2FAConfirm(false);
      setTwoFactorCode('');
      setStoredUser({ ...(getStoredUser() || {}), twoFactorEnabled: false });
      setSuccess('Google Authenticator has been disabled. Email OTP will be used at login.');
    } catch (err) {
      setError(err.message || 'Unable to disable Google Authenticator.');
    } finally {
      setOtpLoading(false);
    }
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

  const handleBannerPictureChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file.');
      return;
    }

    // Validate file size (max 3MB for banner)
    if (file.size > 3 * 1024 * 1024) {
      setError('Banner image size must be less than 3MB.');
      return;
    }

    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      setBannerPicturePreview(reader.result);
    };
    reader.readAsDataURL(file);

    setError('');
  };

  const handleBannerPictureClick = () => {
    if (isEditing) {
      bannerInputRef.current?.click();
    }
  };

  const handleRemoveBannerPicture = () => {
    setBannerPicturePreview('');
    if (bannerInputRef.current) {
      bannerInputRef.current.value = '';
    }
  };

  const requestEmailOtp = async (newEmail) => {
    const token = getToken();
    const response = await fetch(`${BASE_URL}/auth/request-email-otp`, {
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
      const token = getToken();
      const response = await fetch(`${BASE_URL}/auth/verify-email-otp`, {
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
    
    // Prevent submission if not in editing mode
    if (!isEditing) {
      return;
    }
    
    setError('');
    setSuccess('');

    // Check if email has changed
    const currentUser = getStoredUser();
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
      const token = getToken();
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

      // Add banner picture if changed
      if (bannerPicturePreview !== bannerPicture) {
        if (bannerInputRef.current?.files[0]) {
          updateData.bannerPicture = bannerPicturePreview;
        } else if (bannerPicturePreview === '') {
          updateData.bannerPicture = '';
        }
      }

      // Add password fields only if user wants to change password
      if (formData.newPassword) {
        if (!formData.currentPassword) {
          setError('Please enter your current password to change it.');
          setLoading(false);
          return;
        }
        if (formData.newPassword !== formData.confirmPassword) {
          setError('Passwords do not match.');
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
        updateData.currentPassword = formData.currentPassword;
        updateData.newPassword = formData.newPassword;
      }

      const response = await fetch(`${BASE_URL}/auth/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(updateData),
      });

      // Handle payload too large error
      if (response.status === 413) {
        throw new Error('File is too large. Please use a smaller image (profile picture: max 2MB, banner: max 3MB).');
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Failed to update profile');
      }

      // Persist fresh profile in the tab session (plan broadcast + directory refresh happen inside)
      const live = applyFresh(data);
      // Spread the CURRENT cache: rebuilding field-by-field silently dropped
      // subscriptionExpiresAt/subscriptionStartedAt, so the expiry-aware
      // fallback could no longer tell an expired plan from an active one.
      const currentCache = getStoredUser() || {};
      setStoredUser({
        ...currentCache,
        _id: data._id,
        firstName: data.firstName,
        lastName: data.lastName,
        name: data.name,
        email: data.email,
        dateOfBirth: data.dateOfBirth,
        age: data.age,
        gender: data.gender,
        profilePicture: data.profilePicture || '',
        bannerPicture: data.bannerPicture || '',
        twoFactorEnabled: twoFactorEnabled,
        subscriptionActive: data.subscriptionActive,
        subscriptionPlan: data.subscriptionPlan,
        subscriptionUpdatedAt: data.subscriptionUpdatedAt,
        subscriptionExpiresAt: data.subscription?.subscriptionEnd ?? data.subscriptionExpiresAt ?? currentCache.subscriptionExpiresAt ?? null,
        subscription: data.subscription ?? currentCache.subscription ?? null,
      });

      setSubscription({
        active: live.active,
        plan: live.plan,
        updatedAt: data.subscriptionUpdatedAt || null,
        // Without this the lock grid fell back to rank-only resolution and
        // could disagree with the rest of the app after a profile save.
        entitlements: live.entitlements,
      });

      setProfilePicture(data.profilePicture || '');
      setBannerPicture(data.bannerPicture || '');

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
    // Reload user data from the tab session
    const user = getStoredUser();
    if (user) {
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

  const handleLogout = async () => {
    // Revokes this account's token server-side (so no copy of it survives)
    // and forgets only THIS account — other accounts signed in on this
    // browser remain in the switcher, ready to be picked up.
    await signOutCurrentAccount();
    sessionStorage.removeItem('pending_assessment');
    // replace: the now-dead profile page must not linger in history, or
    // Back after sign-out bounces through the guards into /admin.
    navigate('/login', { replace: true });
  };

  const handleLogoutClick = () => {
    setShowLogoutConfirm(true);
  };

  const confirmLogout = () => {
    setShowLogoutConfirm(false);
    handleLogout();
  };

  return (
    <>
      <Navbar />
      <div className="profile-page">
        <div className="profile-container">
          <div 
            className="profile-header"
            style={{
              backgroundImage: bannerPicturePreview ? `url(${bannerPicturePreview})` : 'linear-gradient(135deg, #22c55e, #16a34a)',
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          >
            {isEditing && (
              <button
                type="button"
                className="banner-edit-btn"
                onClick={handleBannerPictureClick}
                title="Change banner"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
            )}
            <input
              ref={bannerInputRef}
              type="file"
              accept="image/*"
              onChange={handleBannerPictureChange}
              style={{ display: 'none' }}
            />
            <div
              className="profile-avatar-large"
              onClick={handleProfilePictureClick}
              style={{ cursor: isEditing ? 'pointer' : 'default' }}
            >
              <span className="profile-avatar-initial" aria-hidden="true">
                {(formData.firstName || 'U').charAt(0).toUpperCase()}
              </span>
              {profilePicturePreview && (
                <img
                  src={profilePicturePreview}
                  alt=""
                  aria-hidden="true"
                  className="profile-avatar-img"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
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
            {isEditing && bannerPicturePreview && (
              <button 
                type="button"
                className="profile-remove-banner"
                onClick={handleRemoveBannerPicture}
              >
                Remove Banner
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
            {isEditing && (
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
            )}

            <div className="profile-section">
              <h2 className="profile-section-title">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                Personal Information
              </h2>
              
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
                  <label htmlFor="dateOfBirth">Date of Birth{formData.dateOfBirth && calculateAge(formData.dateOfBirth) !== '' ? ` (Age ${calculateAge(formData.dateOfBirth)})` : ''}</label>
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

            <div className="profile-section">
              <h2 className="profile-section-title">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="2" y="5" width="20" height="14" rx="2" />
                  <line x1="2" y1="10" x2="22" y2="10" />
                </svg>
                Subscription Status
              </h2>
              <p className="profile-section-subtitle">Your Plan is based on what you purchase.</p>
              {!profileLoading && (() => {
                // Server entitlements first; tier table as the UI fallback.
                const planState = {
                  active: subscription.active,
                  plan: subscription.plan,
                  rank: subscription.active ? (PLAN_RANK[subscription.plan] ?? 0) : 0,
                  entitlements: subscription.entitlements || null,
                };
                return (
                <div className="plan-features">
                  <p className="plan-features__heading">
                    {subscription.active
                      ? `Unlocked with ${PLAN_LABELS[subscription.plan] || 'your plan'}`
                      : `Included in ${PLAN_LABELS.free} — upgrade to unlock more`}
                  </p>
                  <div className="plan-features__grid">
                    {FEATURE_CARDS.map(f => {
                      const def = FEATURES[f.key];
                      const unlocked = canAccess(f.key);
                      return (
                        <div key={f.key} className={`plan-feature${unlocked ? ' plan-feature--on' : ' plan-feature--locked'}`}>
                          <span className="plan-feature__icon"><FeatureIcon icon={unlocked ? f.icon : 'lock'} /></span>
                          <div>
                            <span className="plan-feature__title">{def.label}</span>
                            <span className="plan-feature__text">{f.text}</span>
                          </div>
                          <span className="plan-feature__check" aria-label={unlocked ? 'Included' : 'Locked'}>
                            {unlocked ? '✓' : <FeatureIcon icon="lock" />}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {planState.rank < PLAN_RANK.custom && (
                    <p className="plan-features__note">Want more? Contact an administrator to upgrade your plan.</p>
                  )}
                </div>
                );
              })()}
              {profileLoading ? (
                <div className="subscription-card subscription-card--loading" aria-live="polite">
                  <span className="subscription-skeleton subscription-skeleton--badge" />
                  <span className="subscription-skeleton subscription-skeleton--line" />
                </div>
              ) : (
                <div className={`subscription-card${subscription.active ? ' subscription-card--active' : ''}`}>
                  <span className={`subscription-badge${subscription.active ? ' subscription-badge--active' : ' subscription-badge--free'}`}>
                    {subscription.active ? 'Active ✓' : PLAN_LABELS.free}
                  </span>
                  <div className="subscription-details">
                    <span className="subscription-plan">
                      {subscription.active
                        ? (PLAN_LABELS[subscription.plan] || PLAN_LABELS.free)
                        : `${PLAN_LABELS.free} — core assessments, recommendations & tracking included`}
                    </span>
                    {subscription.updatedAt && (
                      <span className="subscription-updated">
                        Updated {new Date(subscription.updatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {profileError && (
                <div className="subscription-error" role="alert">
                  <span>{profileError}</span>
                  <button
                    type="button"
                    className="profile-btn profile-btn-secondary"
                    disabled={profileLoading}
                    onClick={() => {
                      profileLoadedRef.current = false;
                      setProfileError('');
                      setProfileLoading(true);
                      getMyProfile()
                        .then((fresh) => {
                          // Resolve through the shared store so this retry
                          // also refreshes every gated surface (expiry-aware).
                          const live = applyFresh(fresh);
                          setSubscription({
                            active: live.active,
                            plan: live.plan,
                            updatedAt: fresh.subscriptionUpdatedAt || null,
                            entitlements: live.entitlements,
                          });
                          setFormData(prev => ({
                            ...prev,
                            firstName: fresh.firstName || prev.firstName,
                            lastName: fresh.lastName || prev.lastName,
                            email: fresh.email || prev.email,
                            gender: fresh.gender || prev.gender,
                          }));
                        })
                        .catch((err) => handleProfileRefreshError(err))
                        .finally(() => {
                          profileLoadedRef.current = true;
                          setProfileLoading(false);
                        });
                    }}
                  >
                    {profileLoading ? 'Retrying…' : 'Retry'}
                  </button>
                </div>
              )}
            </div>

            {isEditing && (
              <div className="profile-section">
                <h2 className="profile-section-title">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  Change Password
                </h2>
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

            <div
              className={`profile-section${secFlash ? ' profile-section--flash' : ''}`}
              ref={securityRef}
              id="account-security"
            >
              <h2 className="profile-section-title">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                Account Security
              </h2>
              <p className="profile-section-subtitle">
                {twoFactorEnabled ? 'Google Authenticator is active. It is the only second factor used at login.' : 'Email verification codes are used at login.'}
              </p>
              {!twoFactorEnabled ? (
                <button type="button" className="profile-btn profile-btn-primary" onClick={handleSetup2FA} disabled={loading}>
                  {loading ? 'Preparing...' : 'Enable Google Authenticator'}
                </button>
              ) : (
                <button type="button" className="profile-btn profile-btn-secondary" onClick={() => { setTwoFactorCode(''); setError(''); setShowDisable2FAConfirm(true); }}>
                  Turn Off Google Authenticator
                </button>
              )}

              {/* Recent security activity — lockouts, 2FA and password events */}
              <div className="security-activity">
                <h3 className="security-activity__title">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  Recent security activity
                </h3>
                {secLoading ? (
                  <p className="security-activity__empty">Loading…</p>
                ) : securityItems.length === 0 ? (
                  <p className="security-activity__empty">No recent security activity. Lockouts, password changes and authenticator updates will appear here.</p>
                ) : (
                  <ul className="security-activity__list">
                    {securityItems.map(item => (
                      <li
                        key={item._id}
                        className={`security-activity__item${item.read ? '' : ' security-activity__item--unread'}`}
                        onClick={async () => {
                          if (!item.read) {
                            try {
                              await markNotificationRead(item._id);
                              setSecurityItems(prev => prev.map(n => (n._id === item._id ? { ...n, read: true } : n)));
                            } catch { /* display-only; read receipt best-effort */ }
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.click();
                        }}
                        title={item.read ? item.title : 'Mark as read'}
                      >
                        {!item.read && <span className="security-activity__dot" aria-hidden="true" />}
                        <div className="security-activity__body">
                          <span className="security-activity__name">{item.title}</span>
                          {item.detail && <span className="security-activity__detail">{item.detail}</span>}
                          <span className="security-activity__time">{secTimeAgo(item.createdAt)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="profile-section">
              <h2 className="profile-section-title">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                Accounts
              </h2>
              <p className="profile-section-subtitle">
                Accounts signed in on this browser. Switch instantly — every account keeps its own session, so the others stay signed in.
              </p>
              <AccountSwitcher />
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

            <div className="profile-actions">
              {!isEditing ? (
                <>
                  <button
                    type="button"
                    className="profile-btn profile-btn-logout"
                    onClick={handleLogoutClick}
                  >
                    Log Out
                  </button>
                  <button
                    type="button"
                    className="profile-btn profile-btn-primary"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setIsEditing(true);
                    }}
                  >
                    Edit Profile
                  </button>
                </>
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

      {/* Logout Confirmation Modal */}
      {showLogoutConfirm && (
        <ConfirmModal
          title="Confirm Logout"
          message="Are you sure you want to log out?"
          confirmText="Log Out"
          cancelText="Cancel"
          type="warning"
          onConfirm={confirmLogout}
          onCancel={() => setShowLogoutConfirm(false)}
        />
      )}

      {show2FASetup && (
        <div className="profile-modal-overlay">
          <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Set Up Google Authenticator</h2>
            <p>Scan this QR code in Google Authenticator, then enter the current 6-digit code.</p>
            {twoFactorQrCode && <img src={twoFactorQrCode} alt="Google Authenticator setup QR code" style={{ display: 'block', width: 220, height: 220, margin: '16px auto' }} />}
            <input className="profile-otp-input" inputMode="numeric" maxLength="6" placeholder="Enter 6-digit code" value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            <div className="profile-modal-actions">
              <button type="button" className="profile-modal-btn profile-modal-btn-secondary" onClick={() => setShow2FASetup(false)} disabled={otpLoading}>Cancel</button>
              <button type="button" className="profile-modal-btn profile-modal-btn-primary" onClick={handleVerify2FA} disabled={otpLoading || twoFactorCode.length !== 6}>{otpLoading ? 'Verifying...' : 'Enable 2FA'}</button>
            </div>
          </div>
        </div>
      )}

      {showDisable2FAConfirm && (
        <div className="profile-modal-overlay">
          <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Turn Off Google Authenticator?</h2>
            <p>Enter your current authenticator code to confirm. Email OTP will be restored after removal.</p>
            <input className="profile-otp-input" inputMode="numeric" maxLength="6" placeholder="Enter 6-digit code" value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            <div className="profile-modal-actions">
              <button type="button" className="profile-modal-btn profile-modal-btn-secondary" onClick={() => setShowDisable2FAConfirm(false)} disabled={otpLoading}>Cancel</button>
              <button type="button" className="profile-modal-btn profile-modal-btn-primary" onClick={handleDisable2FA} disabled={otpLoading || twoFactorCode.length !== 6}>{otpLoading ? 'Verifying...' : 'Confirm Removal'}</button>
            </div>
          </div>
        </div>
      )}

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