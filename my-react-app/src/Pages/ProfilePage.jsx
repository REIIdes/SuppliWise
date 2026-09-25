import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import AccountSwitcher from '../Components/AccountSwitcher/AccountSwitcher';
import { BASE_URL, getMyProfile, getNotifications, markNotificationRead, isSecurityNotification, getToken, getStoredUser, setStoredUser } from '../api';
import ProfileSecurityControls from '../Components/ProfileSecurityControls/ProfileSecurityControls';
import ProfileAvatarImage from '../Components/ProfileAvatar/ProfileAvatarImage';
import { useSubscription, SUBSCRIPTION_EVENT } from '../hooks/useSubscription';
import { PLAN_LABELS, planFromUser } from '../utils/plan';
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
  const [showDisable2FAConfirm, setShowDisable2FAConfirm] = useState(false);
  const [show2FASetup, setShow2FASetup] = useState(false);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(() => storedUser.twoFactorEnabled === true);
  // WHICH second factor, and WHEN the password last changed — both come from
  // /auth/me and drive the Account Security cards below.
  const [twoFactorMethod, setTwoFactorMethod] = useState(() => storedUser.twoFactorMethod || null);
  const [passwordChangedAt, setPasswordChangedAt] = useState(() => storedUser.passwordChangedAt || null);

  // Re-read the security facts after any of the cards changes one. Deliberately
  // a fresh /me rather than trusting the local response, so the card can never
  // show a value the server disagrees with.
  const refreshSecurityFacts = useCallback(async () => {
    try {
      const fresh = await getMyProfile();
      setTwoFactorEnabled(fresh.twoFactorEnabled === true);
      setTwoFactorMethod(fresh.twoFactorEnabled ? (fresh.twoFactorMethod || 'authenticator') : null);
      setPasswordChangedAt(fresh.passwordChangedAt || null);
      try {
        const current = getStoredUser() || {};
        setStoredUser({
          ...current,
          twoFactorEnabled: fresh.twoFactorEnabled,
          twoFactorMethod: fresh.twoFactorMethod ?? null,
          passwordChangedAt: fresh.passwordChangedAt ?? null,
        });
      } catch { /* cache write best-effort */ }
    } catch { /* keep the last known values rather than blanking the card */ }
  }, []);
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
  // (password show/hide toggles live with the Change Password card now)

  // Recent security activity (lockouts, 2FA changes, password changes…)
  const [securityItems, setSecurityItems] = useState([]);
  const [secLoading, setSecLoading] = useState(true);
  const [secFlash, setSecFlash] = useState(false);
  const securityRef = useRef(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // Subscription status (starts from cache — resolved incl. expiry — then
  // syncs live + from server). Subscribing here means upgrades/downgrades by
  // admin, expiry, or another tab update the card + feature list instantly —
  // no reopen needed.
  const { active: liveActive, plan: livePlan, entitlements: liveEntitlements, refresh: refreshLivePlan, applyFresh } = useSubscription();
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
          setTwoFactorMethod(fresh.twoFactorEnabled ? (fresh.twoFactorMethod || 'authenticator') : null);
          setPasswordChangedAt(fresh.passwordChangedAt || null);
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
              twoFactorMethod: fresh.twoFactorEnabled ? (fresh.twoFactorMethod || 'authenticator') : null,
              passwordChangedAt: fresh.passwordChangedAt || null,
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

  // ── Which card is open ────────────────────────────────────────────────
  // The profile shows ONE card at a time, chosen by the navbar account menu.
  // There is no in-page switcher, so `view` is the only navigation state.
  //
  //   ?view=personal | security | accounts   — from the account menu
  //   ?section=security                     — legacy deep link kept working
  //                                            for the notification bell
  //   ?edit=1                               — implies view=personal
  //
  // Anything unrecognised (including no param at all) falls back to
  // 'personal', so /profile always opens on a real card. It previously fell
  // back to an empty hub that only existed to tell you to pick a card.
  //
  // It lives in the URL because the Navbar and this page are siblings with no
  // shared owner; a query param needs no lifted state or global event, and it
  // survives reload, so the deep link is shareable and Back behaves.
  const urlView = searchParams.get('view') || searchParams.get('section');
  const view = urlView === 'security' || urlView === 'accounts' ? urlView : 'personal';

  // The Security card still flashes when it is opened from a notification,
  // because that is the one case where its contents changed underneath the
  // user (2FA toggled, a device revoked) and the card should acknowledge it.
  // Opening it from the menu does not flash — the user chose it deliberately.
  useEffect(() => {
    if (searchParams.get('section') !== 'security') return undefined;
    const timer = window.setTimeout(() => {
      setSecFlash(true);
      window.setTimeout(() => setSecFlash(false), 2200);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchParams]);

  // `?edit=1` is adjusted DURING RENDER, not in an effect. It is a pure reaction
  // to the URL changing, and React's supported way to handle that is to derive it
  // where the value is read: an effect would set state after commit, so every
  // such navigation would paint once with the wrong state and then again with
  // the right one.
  //
  // The previous value is seeded with a SENTINEL (false), never with the
  // current param. Seeding it with the current value looks harmless but was the
  // whole bug: on the FIRST render they are equal, so the guard never fired.
  // ProfilePage is lazy-loaded and mounts fresh on every navigation to
  // /profile, which means the deep link arrives WITH that first render — so
  // `?edit=1` from the dashboard was swallowed and edit mode never engaged.
  // The sentinel makes the arrival count as a change.
  //
  // clearTransientParams() drops the param, which resets this to false and
  // leaves edit mode for good.
  const urlEdit = searchParams.get('edit') === '1';
  const [lastUrlEdit, setLastUrlEdit] = useState(false);
  if (urlEdit !== lastUrlEdit) {
    setLastUrlEdit(urlEdit);
    if (urlEdit) setIsEditing(true);
  }

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
      setTwoFactorMethod('authenticator');
      setShow2FASetup(false);
      setTwoFactorCode('');
      setSuccess('Google Authenticator is now enabled.');
      setStoredUser({ ...(getStoredUser() || {}), twoFactorEnabled: true, twoFactorMethod: 'authenticator' });
    } catch (err) {
      setError(err.message || 'Unable to verify the authenticator code.');
    } finally {
      setOtpLoading(false);
    }
  };

  // Which proof the server wants depends on the active method: an authenticator
  // account has a TOTP to present, an email account has to confirm with the
  // password instead (there is no code held on the device).
  const disableNeedsPassword = twoFactorEnabled && twoFactorMethod === 'email';
  const [disablePassword, setDisablePassword] = useState('');

  const handleDisable2FA = async () => {
    if (disableNeedsPassword) {
      if (!disablePassword) {
        setError('Enter your current password to turn off two-factor authentication.');
        return;
      }
    } else if (!/^\d{6}$/.test(twoFactorCode)) {
      setError('Enter the current 6-digit authenticator code to disable 2FA.');
      return;
    }
    setError('');
    setOtpLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/auth/disable-2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify(disableNeedsPassword ? { currentPassword: disablePassword } : { otp: twoFactorCode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to disable two-factor authentication.');
      setTwoFactorEnabled(false);
      setTwoFactorMethod(null);
      setShowDisable2FAConfirm(false);
      setTwoFactorCode('');
      setDisablePassword('');
      setStoredUser({ ...(getStoredUser() || {}), twoFactorEnabled: false, twoFactorMethod: null });
      setSuccess('Two-factor authentication has been turned off.');
    } catch (err) {
      setError(err.message || 'Unable to disable two-factor authentication.');
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

      // Password is deliberately NOT sent from here. It has its own form in
      // Account Security (POST /auth/change-password) because a credential
      // change is a different action with different rules: it verifies the
      // current password, signs out other devices, and must not be reachable
      // as a side effect of saving a profile form.

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

  /**
   * Drop the transient deep-link param (`?edit=1`), keeping only `view`.
   * `replace` keeps this out of history so Back does not replay the edit the
   * user just cancelled.
   */
  const clearTransientParams = () => {
    if (!searchParams.get('edit')) return;
    const next = {};
    if (urlView && urlView !== 'personal') next.view = urlView;
    setSearchParams(next, { replace: true });
  };

  const handleCancel = () => {
    // Discard every unsaved edit by restoring the last SERVER-CONFIRMED values.
    //
    // The pictures come from this component's own `profilePicture` /
    // `bannerPicture` state (written when a save succeeds, or when the profile
    // is first loaded) rather than from the shared localStorage cache. The
    // cache is a different concern — it is browser-wide, another tab can
    // rewrite it, and it may be ahead of or behind this page.
    //
    // The banner preview used to be left out of this reset entirely, which is
    // why Cancel appeared broken: pick a new banner, press Cancel, and the
    // unsaved banner stayed on screen. Both previews are now reset together.
    setProfilePicturePreview(profilePicture);
    setBannerPicturePreview(bannerPicture);

    const user = getStoredUser();
    if (user) {
      setFormData({
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        email: user.email || '',
        dateOfBirth: user.dateOfBirth ? new Date(user.dateOfBirth).toISOString().split('T')[0] : '',
        gender: user.gender || '',
      });
    }

    // THE CRITICAL PART — drop `?edit=1` (and any stray `?action=`) from the URL.
    //
    // Edit mode is entered by the `?edit=1` deep link, and that param used to
    // stay in the URL forever. The render-time rule that reads it then undid
    // every Cancel: the click set isEditing=false, the very next render saw
    // `?edit=1` still present with !isEditing, and turned edit mode straight
    // back on. That is why Cancel looked completely dead.
    //
    // Clearing it makes the deep link one-shot, so Cancel finally sticks AND
    // choosing "Edit Profile" from the menu again still works (it re-adds the
    // param, which is a fresh transition).
    clearTransientParams();

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

  // Leaving the Personal Info card while editing discards the draft, so a
  // half-typed form cannot follow the user to another card.
  //
  // This is an effect, not render-time derivation, because leaving edit mode
  // has to WRITE to the router (clear `?edit=1`) — and navigating during render
  // is not allowed. The lint rule prefers deriving during render, but the URL
  // is an external system, so reacting to it in an effect is the correct
  // trade-off. It also reuses handleCancel, so "discard my edits" is defined
  // exactly once.
  useEffect(() => {
    if (view === 'personal' || !isEditing) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to a URL change (external system)
    handleCancel();
    // Intentionally only `view`: isEditing/handleCancel are excluded so this
    // cannot re-fire and loop while cancelling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

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

  // Sign-out is NOT handled here. It used to be reached by navigating to
  // /profile?action=signout, which meant choosing "Sign out" dragged the user
  // to this page just to show a prompt. The confirmation now lives in the
  // Navbar's account menu and signs out in place, so this page has no logout
  // machinery at all.

  return (
    <>
      <Navbar />
      <div className="profile-page">
        <div className="profile-container">
          {/* ── Cover banner ── pure artwork; identity sits on the card below,
              so a very wide photo is never cropped just to fit a name. ── */}
          <div
            className="profile-cover"
            style={bannerPicturePreview ? {
              backgroundImage: `url(${bannerPicturePreview})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            } : undefined}
          >
            {isEditing && (
              <button
                type="button"
                className="banner-edit-btn"
                onClick={handleBannerPictureClick}
                title="Change banner"
                aria-label="Change banner picture"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
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
          </div>

          <input
            ref={bannerInputRef}
            type="file"
            accept="image/*"
            onChange={handleBannerPictureChange}
            style={{ display: 'none' }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleProfilePictureChange}
            style={{ display: 'none' }}
          />

          {/* ── Identity card: avatar straddles the cover edge ── */}
          <div className="profile-identity">
            <div
              className="profile-avatar-large"
              onClick={handleProfilePictureClick}
              style={{ cursor: isEditing ? 'pointer' : 'default' }}
              role={isEditing ? 'button' : undefined}
              tabIndex={isEditing ? 0 : undefined}
              onKeyDown={isEditing ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleProfilePictureClick(); } } : undefined}
              aria-label={isEditing ? 'Change profile picture' : undefined}
            >
              <ProfileAvatarImage
                src={profilePicturePreview}
                name={formData.firstName}
                className="profile-avatar-img"
              />
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

            <div className="profile-identity__text">
              <p className="profile-eyebrow">Your account</p>
              <h1 className="profile-title">
                {[formData.firstName, formData.lastName].filter(Boolean).join(' ') || 'Profile Settings'}
              </h1>
              <p className="profile-subtitle">
                {formData.email || 'Manage your account information'}
              </p>
            </div>

            <div className="profile-identity__actions">
              {isEditing && profilePicturePreview && (
                <button
                  type="button"
                  className="profile-chip-btn"
                  onClick={handleRemoveProfilePicture}
                >
                  Remove picture
                </button>
              )}
              <span className={`profile-plan-chip${subscription.active ? ' profile-plan-chip--active' : ''}`}>
                <span className="profile-plan-chip__dot" aria-hidden="true" />
                {subscription.active
                  ? (PLAN_LABELS[subscription.plan] || PLAN_LABELS.free)
                  : PLAN_LABELS.free}
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="profile-form">
            {/* No section switcher here on purpose. The account menu in the
                navbar is the single way between cards, so there is exactly one
                place to look for "where do I go" instead of two competing
                ones. Personal Info is the default view, so /profile with no
                query param lands somewhere useful rather than an empty hub. */}

            {isEditing && view === 'personal' && (
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

            {view === 'personal' && (
            <div className="profile-section profile-section--personal" id="profile-personal">
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
            )}

            {/* ── Load-failure recovery ──
                The retry affordance used to live inside the Subscription Status
                card. That card is gone, but the failure it reported concerns the
                PROFILE fetch (that fills this form), not billing — so recovery
                stays, promoted to the top of the form. Without it, a failed
                /auth/me would silently leave stale cached details on screen with
                no way to try again. */}
            {profileError && (
              <div className="profile-load-alert" role="alert">
                <span className="profile-load-alert__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.2v.1" />
                  </svg>
                </span>
                <span className="profile-load-alert__body">{profileError}</span>
                <button
                  type="button"
                  className="profile-load-alert__retry"
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

            {view === 'security' && (
            <div
              className={`profile-section profile-section--security${secFlash ? ' profile-section--flash' : ''}`}
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
                {twoFactorEnabled
                  ? `Two-factor authentication is on — you're signing in with ${twoFactorMethod === 'email' ? 'a code emailed to you' : 'your authenticator app'}.`
                  : 'Add a second step at sign-in so a stolen password alone is not enough.'}
              </p>

              <ProfileSecurityControls
                twoFactorEnabled={twoFactorEnabled}
                twoFactorMethod={twoFactorMethod}
                passwordChangedAt={passwordChangedAt}
                onSecurityChange={refreshSecurityFacts}
                onStartAuthenticatorSetup={handleSetup2FA}
                onDisableTwoFactor={() => { setTwoFactorCode(''); setError(''); setShowDisable2FAConfirm(true); }}
              />

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
            )}

            {view === 'accounts' && (
            <div className="profile-section profile-section--accounts" id="profile-accounts">
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
            )}

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

            {/* Only the edit-state controls live here. "Edit Profile" and
                "Log Out" were removed from this bar and now live in the
                account menu in the navbar, which is reachable from every page
                rather than only from here. Cancel/Save must stay inline: they
                act on this <form>, and a form whose submit button lives in
                another component is a keyboard trap and breaks the native
                Enter-to-submit behaviour. */}
            {isEditing && view === 'personal' && (
              <div className="profile-actions">
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
              </div>
            )}
          </form>
        </div>
      </div>

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
            <h2>Turn Off Two-Factor Authentication?</h2>
            {disableNeedsPassword ? (
              <>
                <p>You're using email codes as your second factor. Confirm with your current password to remove it.</p>
                <input
                  className="profile-otp-input"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Enter your current password"
                  value={disablePassword}
                  onChange={(e) => { setDisablePassword(e.target.value); setError(''); }}
                />
              </>
            ) : (
              <>
                <p>Enter your current authenticator code to confirm. Email verification codes will be used at sign-in after removal.</p>
                <input className="profile-otp-input" inputMode="numeric" maxLength="6" placeholder="Enter 6-digit code" value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
              </>
            )}
            <div className="profile-modal-actions">
              <button type="button" className="profile-modal-btn profile-modal-btn-secondary" onClick={() => setShowDisable2FAConfirm(false)} disabled={otpLoading}>Cancel</button>
              <button
                type="button"
                className="profile-modal-btn profile-modal-btn-primary"
                onClick={handleDisable2FA}
                disabled={otpLoading || (disableNeedsPassword ? !disablePassword : twoFactorCode.length !== 6)}
              >
                {otpLoading ? 'Verifying...' : 'Confirm Removal'}
              </button>
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
