# E2E Encryption Debug Steps

## Problem: "Sign in to send encrypted messages" appears even when logged in

This means the encryption system thinks you're not authenticated.

## Debug Steps:

### 1. Check if user object exists

Open browser console (F12) on the Support page and run:

```javascript
// Check if user is loaded
console.log("Auth check:", {
  token: localStorage.getItem('token'),
  user: localStorage.getItem('user'),
  userParsed: JSON.parse(localStorage.getItem('user') || 'null')
});
```

**Expected output:**
- `token`: Should be a long JWT string
- `user`: Should be a JSON string with your user data
- `userParsed`: Should show `{ _id: "...", name: "Rei Rin", ... }`

**If `user` is null or `_id` is missing:** This is the problem!

---

### 2. Check useAuth hook

In console, type:

```javascript
// This won't work directly, but we can check localStorage
const userData = JSON.parse(localStorage.getItem('user') || 'null');
console.log("User ID:", userData?._id);
console.log("User data:", userData);
```

**Expected:** Should show your user ID (24-character hex string like `"507f1f77bcf86cd799439011"`)

---

### 3. Check if secure chat detects authentication

In console:

```javascript
// Check crypto availability
console.log("Crypto available:", {
  crypto: !!window.crypto,
  subtle: !!window.crypto?.subtle,
  TextEncoder: typeof TextEncoder !== 'undefined'
});
```

**Expected:** All should be `true`

---

### 4. Force refresh authentication

Try this:

1. **Logout** (click your name → Logout)
2. **Login again**
3. **Go to Support page**
4. **Check if orange notice is gone**

---

### 5. Check network requests

1. Open DevTools (F12)
2. Go to **Network** tab
3. Filter by **Fetch/XHR**
4. Refresh the Support page
5. Look for these requests:
   - `GET /api/auth/me` or similar - should return your user data
   - `GET /api/secure/key` - should return your encryption key (or 404 if first time)
   - `POST /api/secure/key/publish` - should publish your key

**Check the responses:**
- If `/api/auth/me` returns 401: You're not actually logged in
- If `/api/secure/key` returns 500: Server error with encryption
- If requests are missing: Authentication might be broken

---

## Common Fixes:

### Fix 1: Clear localStorage and re-login

```javascript
// In console
localStorage.clear();
location.reload();
// Then login again
```

### Fix 2: Check if server is running HTTPS

E2E encryption requires **HTTPS** or **localhost**. If you're running on HTTP (not localhost), crypto APIs won't work.

**Check your URL:**
- ✅ `http://localhost:5173` - OK
- ✅ `https://localhost:5173` - OK  
- ❌ `http://192.168.1.x:5173` - NOT OK (needs HTTPS)

### Fix 3: Check browser console for errors

Look for red errors mentioning:
- "crypto"
- "subtle"
- "undefined"
- "Cannot read property"

---

## Quick Test Script

Run this in browser console to get a full diagnostic:

```javascript
(async function diagnose() {
  console.log("=== E2E ENCRYPTION DIAGNOSTIC ===");
  
  // 1. Auth check
  const token = localStorage.getItem('token');
  const userData = JSON.parse(localStorage.getItem('user') || 'null');
  console.log("1. Authentication:");
  console.log("   Token exists:", !!token);
  console.log("   User data:", userData);
  console.log("   User ID:", userData?._id);
  
  // 2. Crypto check
  console.log("\n2. Crypto APIs:");
  console.log("   window.crypto:", !!window.crypto);
  console.log("   crypto.subtle:", !!window.crypto?.subtle);
  console.log("   TextEncoder:", typeof TextEncoder !== 'undefined');
  
  // 3. Connection check
  console.log("\n3. Connection:");
  console.log("   URL:", window.location.href);
  console.log("   Protocol:", window.location.protocol);
  console.log("   Hostname:", window.location.hostname);
  
  // 4. Try API call
  console.log("\n4. API Test:");
  try {
    const response = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    console.log("   API response:", data);
  } catch (error) {
    console.error("   API error:", error.message);
  }
  
  console.log("\n=== END DIAGNOSTIC ===");
})();
```

**Copy this entire block, paste in console, press Enter**

---

## What the output should show:

```
=== E2E ENCRYPTION DIAGNOSTIC ===
1. Authentication:
   Token exists: true
   User data: {_id: "...", name: "Rei Rin", email: "..."}
   User ID: "507f1f77bcf86cd799439011"

2. Crypto APIs:
   window.crypto: true
   crypto.subtle: true
   TextEncoder: true

3. Connection:
   URL: http://localhost:5173/support
   Protocol: http:
   Hostname: localhost

4. API Test:
   API response: {_id: "...", name: "Rei Rin", ...}

=== END DIAGNOSTIC ===
```

If ANY of these are false or null, that's the problem!

---

## Send me the output!

Run the diagnostic script and copy-paste the output here. I'll tell you exactly what's wrong and how to fix it.
