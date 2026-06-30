# Authentication Troubleshooting Guide

## Error: "Not authorized, token failed"

This error occurs when the JWT token validation fails in the backend authentication middleware.

---

## Common Causes & Solutions

### 1. **Token Expired** (Most Common)
JWT tokens have an expiration time. If you haven't logged in recently, your token may have expired.

**Solution:**
```javascript
// User needs to log out and log back in
localStorage.removeItem('token');
localStorage.removeItem('user');
// Then navigate to /login
```

**In Browser Console:**
```javascript
// Check if you have a token
localStorage.getItem('token')

// Check token expiration (decode JWT)
const token = localStorage.getItem('token');
if (token) {
  const payload = JSON.parse(atob(token.split('.')[1]));
  console.log('Token expires:', new Date(payload.exp * 1000));
  console.log('Current time:', new Date());
  console.log('Token is expired:', payload.exp * 1000 < Date.now());
}
```

---

### 2. **Missing Token**
User is not logged in or token was cleared.

**Solution:**
- Navigate to login page
- Sign in again
- Token will be stored automatically

---

### 3. **Invalid Token Format**
Token is corrupted or not in proper format.

**Solution:**
```javascript
// Clear and re-login
localStorage.clear();
// Navigate to /login
```

---

### 4. **JWT_SECRET Mismatch**
Server restarted with different JWT_SECRET.

**Check:**
```bash
# In server/.env
JWT_SECRET=suppliwise_jwt_secret_key_change_in_production
```

**Solution:**
- All users need to re-login after server restart if JWT_SECRET changed
- Don't change JWT_SECRET in production unless necessary

---

## Quick Fix Steps

### For Users:
1. **Log out** (click logout button or clear localStorage)
2. **Log back in** with your credentials
3. Try the action again

### For Developers:

**Option 1: Quick Clear (Browser Console)**
```javascript
localStorage.removeItem('token');
localStorage.removeItem('user');
window.location.href = '/login';
```

**Option 2: Programmatic Logout**
```javascript
// Add to your logout function
const handleLogout = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  navigate('/login');
};
```

---

## Improving the Error Handling

### Better Frontend Error Messages

Update `api.js` to handle 401 specifically:

```javascript
// In api.js - add automatic logout on 401
const handleAuthError = (status) => {
  if (status === 401) {
    // Token expired or invalid - auto logout
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  }
};

// Use in fetch calls
export const getRecommendations = async (assessmentData) => {
  const res = await fetch(`${BASE_URL}/recommend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
    },
    body: JSON.stringify(assessmentData),
  });
  
  if (res.status === 401) {
    handleAuthError(401);
  }
  
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};
```

---

## Adding Token Expiration Warning

### Set Token Expiration (Backend)

In `server/routes/auth.js`:

```javascript
// When generating token, set expiration
const token = jwt.sign(
  { id: user._id }, 
  process.env.JWT_SECRET, 
  { expiresIn: '7d' }  // Token expires in 7 days
);
```

### Check Token Before Requests (Frontend)

```javascript
// Add to api.js
const isTokenExpired = () => {
  const token = localStorage.getItem('token');
  if (!token) return true;
  
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
};

// Use before API calls
export const getRecommendations = async (assessmentData) => {
  if (isTokenExpired()) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    throw new Error('Your session has expired. Please sign in again.');
  }
  
  // ... rest of function
};
```

---

## Enhanced Auth Middleware (Optional)

### More Detailed Error Messages

```javascript
// In server/middleware/auth.js
const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer')) {
    return res.status(401).json({ 
      message: 'Not authorized, no token',
      code: 'NO_TOKEN'
    });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    
    if (!req.user) {
      return res.status(401).json({ 
        message: 'Not authorized, user not found',
        code: 'USER_NOT_FOUND'
      });
    }
    
    next();
  } catch (error) {
    // Different error messages for different scenarios
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        message: 'Your session has expired. Please sign in again.',
        code: 'TOKEN_EXPIRED'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        message: 'Invalid token. Please sign in again.',
        code: 'INVALID_TOKEN'
      });
    }
    
    return res.status(401).json({ 
      message: 'Not authorized, token failed',
      code: 'AUTH_FAILED',
      error: error.message
    });
  }
};
```

---

## Testing Authentication Flow

### Manual Test Checklist

- [ ] Register new user → should receive token
- [ ] Login with credentials → should receive token
- [ ] Make authenticated request → should succeed
- [ ] Make request without token → should return 401
- [ ] Make request with expired token → should return 401
- [ ] Logout → token should be cleared

### Automated Tests (Future)

```javascript
describe('Authentication', () => {
  test('rejects requests without token', async () => {
    const res = await fetch('/api/recommend', {
      method: 'POST',
      body: JSON.stringify(testData)
    });
    expect(res.status).toBe(401);
  });
  
  test('accepts requests with valid token', async () => {
    const token = await loginAndGetToken();
    const res = await fetch('/api/recommend', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(testData)
    });
    expect(res.status).toBe(200);
  });
});
```

---

## Production Considerations

### Security Best Practices

1. **Use Strong JWT_SECRET**
   ```bash
   # Generate with:
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

2. **Set Reasonable Expiration**
   ```javascript
   // 7 days for web
   { expiresIn: '7d' }
   
   // 30 days for mobile (with refresh token)
   { expiresIn: '30d' }
   ```

3. **Use HTTPS in Production**
   - Tokens sent over HTTP can be intercepted
   - Always use HTTPS in production

4. **Implement Refresh Tokens** (Advanced)
   - Short-lived access tokens (15 min)
   - Long-lived refresh tokens (7 days)
   - Auto-refresh before expiration

---

## Debugging Commands

### Check if MongoDB is running
```bash
# Windows
net start MongoDB

# Mac/Linux
sudo systemctl status mongodb
```

### Check if server is running
```bash
# Should show server process
netstat -ano | findstr :5000
```

### Check environment variables
```javascript
// In server/index.js, add:
console.log('JWT_SECRET loaded:', !!process.env.JWT_SECRET);
console.log('MONGO_URI:', process.env.MONGO_URI);
```

### Check database connection
```bash
# Connect to MongoDB
mongosh
use suppliwise
db.users.find()
```

---

## Common Development Workflow

### When You Get "Not authorized, token failed"

1. **Check Browser Console**
   ```javascript
   localStorage.getItem('token')
   // Should return a long string like "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
   ```

2. **If no token or expired:**
   - Go to /login
   - Sign in again
   - Try action again

3. **If token exists but still fails:**
   - Clear localStorage
   - Sign in again
   - Check server logs for errors

4. **If still failing:**
   - Check JWT_SECRET in .env
   - Restart server
   - Clear database and re-register

---

## Server Logs to Monitor

```javascript
// In server/middleware/auth.js, add logging:
const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  console.log('[AUTH] Request to:', req.path);
  console.log('[AUTH] Header present:', !!authHeader);

  if (!authHeader || !authHeader.startsWith('Bearer')) {
    console.log('[AUTH] No token provided');
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const token = authHeader.split(' ')[1];
    console.log('[AUTH] Token:', token.substring(0, 20) + '...');
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('[AUTH] Token valid for user:', decoded.id);
    
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) {
      console.log('[AUTH] User not found in database');
      return res.status(401).json({ message: 'Not authorized, user not found' });
    }
    
    console.log('[AUTH] Auth successful for:', req.user.email);
    next();
  } catch (error) {
    console.error('[AUTH] Token verification failed:', error.message);
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};
```

---

## Quick Reference

| Error Message | Cause | Solution |
|--------------|-------|----------|
| "Not authorized, no token" | No Authorization header | Log in |
| "Not authorized, token failed" | Token expired or invalid | Log in again |
| "Not authorized, user not found" | User deleted from DB | Re-register |
| "Your session has expired" | Token expired (with enhanced errors) | Log in again |

---

**Last Updated:** 2024
**Status:** Production Ready
