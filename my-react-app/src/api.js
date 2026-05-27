const BASE_URL = '/api';

// Helper to get auth header
const authHeader = () => {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// Safely parse JSON — returns null if body is empty
const parseJSON = async (res) => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Register a new user
export const registerUser = async (name, email, password) => {
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(data?.message || `Server error (${res.status})`);
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
  if (!res.ok) throw new Error(data?.message || `Server error (${res.status})`);
  return data;
};

// Save assessment (requires auth)
export const saveAssessment = async (assessmentData) => {
  const res = await fetch(`${BASE_URL}/assessment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
    },
    body: JSON.stringify(assessmentData),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(data?.message || `Server error (${res.status})`);
  return data;
};

// Get AI supplement recommendations
export const getRecommendations = async (assessmentData) => {
  const res = await fetch(`${BASE_URL}/recommend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
    },
    body: JSON.stringify(assessmentData),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(data?.message || `Server error (${res.status})`);
  return data;
};

// Get assessment history for logged-in user
export const getHistory = async () => {
  const res = await fetch(`${BASE_URL}/assessment/history`, {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(data?.message || `Server error (${res.status})`);
  return data;
};

// Save AI results to an assessment record
export const saveAssessmentResults = async (assessmentId, results) => {
  const res = await fetch(`${BASE_URL}/assessment/${assessmentId}/results`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(results),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(data?.message || `Server error (${res.status})`);
  return data;
};

// Delete an assessment
export const deleteAssessment = async (assessmentId) => {
  const res = await fetch(`${BASE_URL}/assessment/${assessmentId}`, {
    method: 'DELETE',
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(data?.message || `Server error (${res.status})`);
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
  if (!res.ok) throw new Error(data?.message || `Server error (${res.status})`);
  return data;
};
