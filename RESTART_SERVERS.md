# ⚠️ IMPORTANT: Restart Servers for Login OTP

## 🔴 The Issue

You can still login without OTP because the server hasn't loaded the new code changes yet.

## ✅ Solution: Restart Both Servers

### Step 1: Stop Current Servers

**In your terminals where servers are running:**

```bash
# Press Ctrl+C in each terminal to stop the servers
```

You should have 2 terminals running:
1. Backend (server) - Port 5000
2. Frontend (my-react-app) - Port 5173

### Step 2: Restart Backend (REQUIRED)

```bash
# Terminal 1: Backend
cd server
npm start
```

**Wait for:**
```
Server running on port 5000
Connected to MongoDB
[Email] Email service configured successfully
```

### Step 3: Restart Frontend (Recommended)

```bash
# Terminal 2: Frontend
cd my-react-app
npm run dev
```

**Wait for:**
```
VITE ready in XXX ms
Local: http://localhost:5173/
```

---

## 🧪 Test Again

### 1. Clear Browser Cache (Important!)

**Option A: Hard Refresh**
- Windows/Linux: `Ctrl + Shift + R`
- Mac: `Cmd + Shift + R`

**Option B: Clear Site Data**
1. Open DevTools (F12)
2. Go to Application tab
3. Click "Clear site data"
4. Refresh page

### 2. Try Login

1. Go to `http://localhost:5173/login`
2. Enter your credentials
3. Click "Sign In"

**Expected Result:**
```
✅ OTP Modal appears!
✅ Email sent (check server console)
✅ Cannot login without entering OTP
```

### 3. Check Server Console

You should see:
```bash
[OTP] Login verification for user@example.com: 123456
[OTP] Expires at: 2026-07-01T12:30:00.000Z
[Email] OTP sent successfully to user@example.com
```

---

## 🐛 Still Not Working?

### Check 1: Server Logs

Look for errors in server console:
```bash
# Should NOT see any errors
# Should see OTP generation logs
```

### Check 2: Browser Console

Open DevTools (F12) → Console tab:
```javascript
// Should see successful API calls
// Should NOT see errors
```

### Check 3: Network Tab

Open DevTools (F12) → Network tab:
1. Try to login
2. Look for `/api/auth/login` request
3. Check response body:
   ```json
   {
     "requiresOtp": true,
     "userId": "...",
     "message": "Verification code sent..."
   }
   ```

If you see `{ token: "...", user: {...} }` instead → **Server didn't restart properly**

### Check 4: Verify Server File

```bash
# Check if auth.js has the new OTP code
cd server
# Look for "requiresOtp" in the file
grep -n "requiresOtp" routes/auth.js

# Should return:
# [line number]: requiresOtp: true,
```

---

## 💡 Common Issues

### Issue 1: Server Cached Old Code

**Solution:**
```bash
# Stop server (Ctrl+C)
# Clear node cache
cd server
rm -rf node_modules/.cache
npm start
```

### Issue 2: Browser Cached Old JavaScript

**Solution:**
```bash
# Clear browser cache completely
# Or use Incognito/Private mode
```

### Issue 3: Multiple Server Instances Running

**Solution:**
```bash
# Check if multiple servers running on port 5000
netstat -ano | findstr :5000

# Kill all node processes
taskkill /F /IM node.exe

# Start fresh
cd server
npm start
```

### Issue 4: Environment Variables Not Loaded

**Solution:**
```bash
# Check .env file exists
cd server
dir .env

# Should contain:
# EMAIL_SERVICE=gmail
# EMAIL_USER=...
# EMAIL_PASSWORD=...
```

---

## ✅ Success Checklist

After restart, verify:

- [ ] Server started without errors
- [ ] Server console shows email service configured
- [ ] Frontend loaded successfully
- [ ] Browser cache cleared
- [ ] Login page opens normally
- [ ] Entering credentials shows OTP modal
- [ ] Email received or OTP in console
- [ ] Cannot login without OTP

**All checked?** 🎉 **Login OTP is now active!**

---

## 🚀 Quick Restart Script

```bash
# Kill all node processes
taskkill /F /IM node.exe

# Start backend
start cmd /k "cd server && npm start"

# Start frontend  
start cmd /k "cd my-react-app && npm run dev"

# Wait 10 seconds, then open browser
timeout /t 10
start http://localhost:5173/login
```

Save this as `restart.bat` in your SuppliWise folder and run it.

---

## 📞 Still Having Issues?

If OTP modal still doesn't appear after:
1. ✅ Restarting both servers
2. ✅ Clearing browser cache
3. ✅ Checking server logs show OTP code

Then check:
- Server console for actual OTP codes being generated
- Network tab for API response containing `requiresOtp: true`
- Browser console for JavaScript errors

**The code is correct - it's most likely a caching issue!**

---

**Next:** After restart, check [LOGIN_OTP_TESTING.md](./LOGIN_OTP_TESTING.md) for full test suite.
