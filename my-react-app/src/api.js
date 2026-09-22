// Resolve the backend URL: explicit env override wins; otherwise derive it
// from the page host so phones/tablets on the LAN (e.g. 192.168.x.x) reach
// the backend instead of a dead localhost:5000 ("Failed to fetch").
const getBaseUrl = () => {
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  if (typeof window !== 'undefined') {
    const { hostname, protocol } = window.location;
    if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
      const scheme = protocol === 'https:' ? 'https:' : 'http:';
      return `${scheme}//${hostname}:5000/api`;
    }
  }
  return 'http://localhost:5000/api';
};
const BASE_URL = getBaseUrl();

// Export BASE_URL so other components can use it
export { BASE_URL };

// Log the environment for debugging
if (typeof window !== 'undefined') {
  console.log('🔧 API Configuration:', {
    BASE_URL: BASE_URL,
    location: window.location.href,
    platform: navigator.userAgent.includes('Android') ? 'Android' : 'Web'
  });
}

// Helper to get auth header
const authHeader = () => {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// Safely parse JSON — returns null if body is empty or unparseable
export const parseJSON = async (res) => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// fetch with a hard timeout so a stalled network can never spin loaders forever.
// AI calls get a longer budget via the timeoutMs argument.
// Safe GETs get one automatic retry on connection-level failures.
const apiFetch = async (path, options = {}, timeoutMs = 30000) => {
  const method = (options.method || 'GET').toUpperCase();
  const attempts = method === 'GET' ? 2 : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE_URL}${path}`, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        const timeoutError = new Error('Request timed out. Please check your connection and try again.');
        timeoutError.isTimeout = true;
        throw timeoutError;
      }
      lastError = err;
      // Retry once on connection failures (server restart, network blip)
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, 800));
        continue;
      }
      if (err instanceof TypeError) {
        throw new Error('Cannot reach the server. Check your connection and that the backend is running.', { cause: err });
      }
      throw err;
    }
  }
  throw lastError;
};

// Check if token is expired before making requests
const isTokenExpired = () => {
  const token = localStorage.getItem('token');
  if (!token) return true;
  
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    // Check if token expires in next 60 seconds
    return payload.exp * 1000 < Date.now() + 60000;
  } catch {
    return true;
  }
};

// Handle authentication errors by clearing token and redirecting.
// Only wipes the session when the stored token is actually unusable
// (missing, malformed, or expired) — a lone 401 with a healthy token is a
// server-side hiccup, not a logout reason.
const handleAuthError = (serverMessage) => {
  const tokenUsable = (() => {
    try {
      const token = localStorage.getItem('token');
      const payload = JSON.parse(atob(token.split('.')[1]));
      return !!token && payload.exp * 1000 > Date.now() + 5000;
    } catch {
      return false;
    }
  })();
  if (!tokenUsable) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('suppliwise_user_last_activity');
    // Redirect to login page
    if (window.location.pathname !== '/login' && window.location.pathname !== '/signin') {
      window.location.href = '/login';
    }
    return 'Your session has expired. Please sign in again.';
  }
  return serverMessage || 'Something went wrong. Please try again.';
};

// Map HTTP status codes to user-friendly messages.
// Server validation messages (4xx with a message field) are passed through as-is.
// Generic 5xx and network errors get a safe fallback message.
const friendlyError = (status, serverMessage, isLoginAttempt = false) => {
  // Handle 401 - but NOT for login/register attempts.
  // Session is only cleared when the stored token is truly unusable.
  if (status === 401 && !isLoginAttempt) {
    return handleAuthError(serverMessage);
  }
  
  // Trust explicit server validation messages for 4xx
  if (status >= 400 && status < 500 && serverMessage) return serverMessage;

  switch (status) {
    case 403: return 'You do not have permission to do that.';
    case 404: return 'The requested resource was not found.';
    case 413: return 'File is too large. Please use a smaller image (profile picture: max 2MB, banner: max 3MB).';
    case 429: return 'Too many requests. Please wait a moment and try again.';
    case 500:
    case 502:
    case 503:
    case 504: return 'Something went wrong on our end. Please try again later.';
    default:  return serverMessage || 'Something went wrong. Please try again.';
  }
};

// Build an Error that also carries plan-gate info (403 requiresPlan/currentPlan)
// so gated pages can show an upgrade prompt instead of a generic message.
const throwFriendly = (status, data, isLoginAttempt = false) => {
  const err = new Error(friendlyError(status, data?.message, isLoginAttempt));
  if (data?.requiresPlan) err.requiresPlan = data.requiresPlan;
  if (data?.currentPlan) err.currentPlan = data.currentPlan;
  err.status = status;
  throw err;
};

// Register a new user
export const registerUser = async (firstName, lastName, gender, dateOfBirth, email, password, captcha) => {
  const res = await apiFetch('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName, lastName, gender, dateOfBirth, email, password, captchaId: captcha?.id, captchaAnswer: captcha?.answer }),
  });
  const data = await parseJSON(res);
  if (!res.ok) {
    const err = new Error(friendlyError(res.status, data?.message, true)); // true = is register attempt
    if (data?.captchaFailed) err.captchaFailed = true;
    throw err;
  }
  return data;
};

// Math CAPTCHA challenge for registration
export const getCaptcha = async () => {
  const res = await apiFetch('/auth/captcha');
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message, true));
  return data;
};

// Login user
export const loginUser = async (email, password) => {
  try {
    console.log('Login attempt:', { BASE_URL, email });
    
    const res = await apiFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    
    console.log('Login response:', { status: res.status, ok: res.ok });
    
    // Check content type - if it's HTML, log and throw better error
    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('text/html')) {
      const htmlText = await res.text();
      console.error('Received HTML instead of JSON:', htmlText.substring(0, 200));
      throw new Error('Server returned an HTML page instead of data. Please check your network connection.');
    }
    
    const data = await parseJSON(res);
    if (!res.ok) {
      const err = new Error(friendlyError(res.status, data?.message, true)); // true = is login attempt
      if (data?.lockedBy) err.lockedBy = data.lockedBy;
      if (data?.remainingSeconds != null) err.remainingSeconds = data.remainingSeconds;
      throw err;
    }
    return data;
  } catch (error) {
    console.error('Login error:', error);
    throw error;
  }
};

// Save assessment (requires auth)
export const saveAssessment = async (assessmentData) => {
  // Check token expiration before making request
  if (isTokenExpired()) {
    handleAuthError();
    throw new Error('Your session has expired. Please sign in again.');
  }
  
  const res = await apiFetch('/assessment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
    },
    body: JSON.stringify(assessmentData),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get AI supplement recommendations
export const getRecommendations = async (assessmentData) => {
  // Check token expiration before making request
  if (isTokenExpired()) {
    handleAuthError();
    throw new Error('Your session has expired. Please sign in again.');
  }
  
  // AI generation can take minutes — budget 150s (server caps at 180s)
  const res = await apiFetch('/recommend', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
    },
    body: JSON.stringify(assessmentData),
  }, 150000);
  const data = await parseJSON(res);
  if (!res.ok) throwFriendly(res.status, data);
  return data;
};

// Get assessment history for logged-in user
// (page size is capped server-side by subscription tier;
// the response may include planLimit/currentPlan for upgrade hints)
export const getHistory = async (page = 1, limit = 10, fields = '') => {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (fields) params.set('fields', fields);
  const res = await apiFetch(`/assessment/history?${params.toString()}`, {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throwFriendly(res.status, data);
  if (Array.isArray(data)) {
    return {
      serverTime: new Date().toISOString(),
      assessments: data,
      pagination: null,
    };
  }
  return {
    serverTime: data.serverTime || new Date().toISOString(),
    assessments: data.assessments || [],
    pagination: data.pagination || null,
    planLimit: data.planLimit || null,
    currentPlan: data.currentPlan || null,
  };
};

// Save AI results to an assessment record
export const saveAssessmentResults = async (assessmentId, results) => {
  const res = await apiFetch(`/assessment/${assessmentId}/results`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(results),
  }, 60000);
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Delete an assessment
export const deleteAssessment = async (assessmentId) => {
  const res = await apiFetch(`/assessment/${assessmentId}`, {
    method: 'DELETE',
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Send a chat message to the AI assistant (Ultimate Package only — 403 carries requiresPlan)
export const sendChatMessage = async (message, context = [], history = []) => {
  const res = await apiFetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ message, context, history }),
  }, 45000);
  const data = await parseJSON(res);
  if (!res.ok) throwFriendly(res.status, data);
  return data;
};

// Fetch detailed supplement information (assessment-aware)
export const getSupplementDetail = async (supplementName, context = null) => {
  const res = await apiFetch('/supplement-detail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ supplementName, context }),
  }, 45000);
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get current user profile incl. subscription status (lightweight, no image blobs)
export const getMyProfile = async (timeoutMs = 15000) => {
  const res = await apiFetch('/auth/me', { headers: { ...authHeader() } }, timeoutMs);
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// ── User notifications ────────────────────────────────────────────────
export const getNotifications = async (limit = 20) => {
  const res = await apiFetch(`/notifications?limit=${limit}`, {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

export const markNotificationRead = async (notificationId) => {
  const res = await apiFetch(`/notifications/${notificationId}/read`, {
    method: 'PATCH',
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

export const markAllNotificationsRead = async () => {
  const res = await apiFetch('/notifications/read-all', {
    method: 'POST',
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

export const deleteNotification = async (notificationId) => {
  const res = await apiFetch(`/notifications/${notificationId}`, {
    method: 'DELETE',
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Titles the server uses for account-security events (lockout.js, admin.js,
// auth.js). Matched exactly so assessment notices never leak into the
// security feed.
const SECURITY_NOTIFICATION_TITLES = new Set([
  'Too many failed sign-in attempts',
  "You're back online",
  'Your account has been restricted',
  'Your account is active again',
  'Two-factor authentication enabled',
  'Two-factor authentication disabled',
  'Password changed',
]);

// True for account-security notices → these deep-link to Profile Security.
export const isSecurityNotification = (item) =>
  !!item && item.type !== 'severe-flag' && SECURITY_NOTIFICATION_TITLES.has(item.title);

// Check whether new assessments are blocked by unresolved Priority items
export const getPriorityStatus = async () => {
  const res = await apiFetch('/assessment/priority-status', {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get dashboard data (latest assessment metrics)
export const getDashboard = async () => {
  const res = await apiFetch('/dashboard', {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Mark supplement as taken or undo
export const updateIntake = async (recordId, taken) => {
  const res = await apiFetch('/dashboard/intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ recordId, taken }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Update energy level
export const updateEnergyLevel = async (energyLevel) => {
  const res = await apiFetch('/dashboard/energy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ energyLevel }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get insights and tracking data (Deluxe/Monthly plan and above)
export const getInsights = async () => {
  const res = await apiFetch('/insights', {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throwFriendly(res.status, data);
  return data;
};

// Get full intake records for one day (interactive calendar detail)
export const getDayRecords = async (dayKey) => {
  const res = await apiFetch(`/dashboard/day/${dayKey}`, {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get calendar completion history for a specific month
export const getCalendarData = async (year, month) => {
  const res = await apiFetch(`/dashboard/calendar/${year}/${month}`, {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Add supplement to user's daily plan
export const addSupplementToPlan = async (supplementData) => {
  const res = await apiFetch('/dashboard/add-supplement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(supplementData),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Remove supplement from user's daily plan
export const removeSupplementFromPlan = async (supplementName) => {
  const res = await apiFetch('/dashboard/remove-supplement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ supplementName }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get user's personalized supplement plan
export const getMyPlan = async () => {
  const res = await apiFetch('/dashboard/my-plan', {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get weekly adherence data
export const getWeeklyAdherence = async () => {
  const res = await apiFetch('/dashboard/weekly-adherence', {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};
