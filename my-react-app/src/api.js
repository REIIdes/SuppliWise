const BASE_URL = '/api';

// Helper to get auth header
const authHeader = () => {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// Safely parse JSON — returns null if body is empty or unparseable
const parseJSON = async (res) => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

// Handle authentication errors by clearing token and redirecting
const handleAuthError = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  // Redirect to login page
  if (window.location.pathname !== '/login' && window.location.pathname !== '/signin') {
    window.location.href = '/login';
  }
};

// Map HTTP status codes to user-friendly messages.
// Server validation messages (4xx with a message field) are passed through as-is.
// Generic 5xx and network errors get a safe fallback message.
const friendlyError = (status, serverMessage, isLoginAttempt = false) => {
  // Handle 401 - but NOT for login/register attempts
  if (status === 401 && !isLoginAttempt) {
    handleAuthError();
    return 'Your session has expired. Please sign in again.';
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

// Register a new user
export const registerUser = async (firstName, lastName, gender, dateOfBirth, email, password) => {
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName, lastName, gender, dateOfBirth, email, password }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message, true)); // true = is register attempt
  return data;
};

// Login user
export const loginUser = async (email, password) => {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message, true)); // true = is login attempt
  return data;
};

// Save assessment (requires auth)
export const saveAssessment = async (assessmentData) => {
  // Check token expiration before making request
  if (isTokenExpired()) {
    handleAuthError();
    throw new Error('Your session has expired. Please sign in again.');
  }
  
  const res = await fetch(`${BASE_URL}/assessment`, {
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
  
  const res = await fetch(`${BASE_URL}/recommend`, {
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

// Get assessment history for logged-in user
export const getHistory = async (page = 1, limit = 10) => {
  const res = await fetch(`${BASE_URL}/assessment/history?page=${page}&limit=${limit}`, {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  // Support both old array response and new paginated response
  return Array.isArray(data) ? data : (data.assessments || []);
};

// Save AI results to an assessment record
export const saveAssessmentResults = async (assessmentId, results) => {
  const res = await fetch(`${BASE_URL}/assessment/${assessmentId}/results`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(results),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Delete an assessment
export const deleteAssessment = async (assessmentId) => {
  const res = await fetch(`${BASE_URL}/assessment/${assessmentId}`, {
    method: 'DELETE',
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Send a chat message to the AI assistant
export const sendChatMessage = async (message, context = [], history = []) => {
  const res = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ message, context, history }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Fetch detailed supplement information (assessment-aware)
export const getSupplementDetail = async (supplementName, context = null) => {
  const res = await fetch(`${BASE_URL}/supplement-detail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ supplementName, context }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};
