# Status Code Fix - Wrong Password vs Session Expired

## ✅ Issue Fixed!

### The Problem
When entering wrong password in Profile Settings, the system showed:
- ❌ "Your session has expired. Please sign in again."

This was **incorrect** because:
- The session was NOT expired
- The password was just wrong
- Confusing for users

### Root Cause
Wrong HTTP status code used:
```javascript
// BEFORE (Wrong)
if (!isMatch) {
  return res.status(401).json({ message: 'Invalid email or password.' });
}
// 401 = Unauthorized = Frontend thinks session expired
```

### The Fix
Changed to correct status code:
```javascript
// AFTER (Correct)
if (!isMatch) {
  return res.status(400).json({ message: 'Invalid email or password.' });
}
// 400 = Bad Request = Validation error, not session issue
```

---

## HTTP Status Codes Explained

### 400 - Bad Request (Validation Errors)
**Use for:**
- ✅ Wrong password
- ✅ Invalid email format
- ✅ Missing required fields
- ✅ Password too short
- ✅ Age out of range

**Message examples:**
- "Invalid email or password."
- "Please fill in all required fields."
- "Password must be at least 8 characters."

### 401 - Unauthorized (Authentication Failures)
**Use for:**
- ✅ Session expired (JWT token expired)
- ✅ Invalid token
- ✅ No token provided
- ✅ Token verification failed

**Message examples:**
- "Your session has expired. Please log in again."
- "Not authorized, no token"

---

## What Changed

### File Modified
```
🔧 server/routes/auth.js
   Line ~420: Changed status(401) → status(400)
   Endpoint: PUT /api/auth/profile
   Function: Password verification
```

### Status Code Logic
```javascript
// Profile Update Endpoint

// ✅ 400 - Wrong password (user's mistake)
if (!isMatch) {
  return res.status(400).json({ message: 'Invalid email or password.' });
}

// ✅ 401 - Session expired (token issue)
if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
  return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
}

// ✅ 400 - Validation error (input issue)
if (!firstName || !lastName) {
  return res.status(400).json({ message: 'Please fill in all required fields.' });
}

// ✅ 500 - Server error (our problem)
res.status(500).json({ message: 'Something went wrong. Please try again later.' });
```

---

## User Experience

### Before Fix:
```
User enters wrong password
   ↓
Backend returns: 401 Unauthorized
   ↓
Frontend sees: 401 = Session expired
   ↓
Shows: "Your session has expired. Please sign in again." ❌
   ↓
User is confused (session didn't expire!)
```

### After Fix:
```
User enters wrong password
   ↓
Backend returns: 400 Bad Request
   ↓
Frontend sees: 400 = Validation error
   ↓
Shows: "Invalid email or password." ✅
   ↓
User knows to check their password
```

---

## Testing

### Test 1: Wrong Password ✅
1. Go to Profile Settings → Edit Profile
2. Enter **wrong current password**
3. Try to change password
4. ✅ Should show: **"Invalid email or password."**
5. ❌ Should NOT show: "Your session has expired"

### Test 2: Correct Password ✅
1. Enter **correct current password**
2. Enter new password
3. Confirm new password
4. Click "Save Changes"
5. ✅ Should update successfully

### Test 3: Actual Session Expiration ✅
1. Login to account
2. Wait 7 days (or modify JWT to expire quickly)
3. Try to update profile
4. ✅ Should show: **"Your session has expired. Please log in again."**

---

## Complete Status Code Reference

### Success Codes
- **200** - OK (Request successful)
- **201** - Created (User registered successfully)

### Client Error Codes (4xx)
- **400** - Bad Request (Validation error, wrong input)
- **401** - Unauthorized (Session expired, invalid token)
- **429** - Too Many Requests (Rate limited)

### Server Error Codes (5xx)
- **500** - Internal Server Error (Something went wrong on our end)

---

## Why This Matters

### 1. **Correct Semantics**
- HTTP status codes have specific meanings
- Using them correctly makes debugging easier
- Frontend can handle errors appropriately

### 2. **Better User Experience**
- Clear, accurate error messages
- Users know what went wrong
- No confusion about session status

### 3. **Standard Practice**
```
Wrong credentials    → 400 (validation error)
Expired session      → 401 (authentication error)
Rate limited         → 429 (too many requests)
Server crashed       → 500 (server error)
```

---

## Backend Error Handling Pattern

```javascript
// Profile Update Endpoint Structure

try {
  // 1. Verify token (401 if fails)
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  
  // 2. Validate input (400 if fails)
  if (!firstName || !lastName) {
    return res.status(400).json({ message: 'Please fill in all required fields.' });
  }
  
  // 3. Check password if changing (400 if wrong)
  if (newPassword) {
    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid email or password.' });
    }
  }
  
  // 4. Update user
  await user.save();
  
  // 5. Return success (200)
  res.json({ ...userData });
  
} catch (error) {
  // Token error → 401
  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
  }
  
  // Validation error → 400
  if (error.name === 'ValidationError') {
    return res.status(400).json({ message: validationMessage });
  }
  
  // Unknown error → 500
  res.status(500).json({ message: 'Something went wrong. Please try again later.' });
}
```

---

## Server Restarted ✅

The server has been restarted with the fix applied.

**Current Status:**
- ✅ Server running on port 5000
- ✅ Status codes corrected
- ✅ Wrong password → 400 (not 401)
- ✅ Session expired → 401
- ✅ Ready to test

---

## Quick Test Commands

### Test in Browser Console:
```javascript
// Test wrong password (should return 400)
fetch('http://localhost:5000/api/auth/profile', {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN_HERE'
  },
  body: JSON.stringify({
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@example.com',
    dateOfBirth: '1990-01-01',
    gender: 'Male',
    currentPassword: 'WrongPassword123',
    newPassword: 'NewPassword123'
  })
})
.then(r => r.json())
.then(console.log);
```

---

**Status:** ✅ Fixed and Deployed  
**Date:** July 1, 2026  
**Impact:** Better error handling and user experience
