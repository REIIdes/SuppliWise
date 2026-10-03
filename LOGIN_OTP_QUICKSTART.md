# Login OTP - Quick Start Guide

## 🚀 5-Minute Setup & Test

### Step 1: Verify Email Configuration (30 seconds)

```bash
# Check server/.env file has these lines:
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM_NAME=SuppliWise
```

✅ **Already configured?** Skip to Step 2!

❌ **Not configured?** See [EMAIL_OTP_SETUP.md](./EMAIL_OTP_SETUP.md)

---

### Step 2: Start Servers (30 seconds)

```bash
# Terminal 1: Backend
cd server
npm start

# Terminal 2: Frontend  
cd my-react-app
npm run dev
```

Wait for: `Server running on port 5000` and `Local: http://localhost:5173`

---

### Step 3: Test Login (2 minutes)

1. **Open browser:** `http://localhost:5173/login`

2. **Enter credentials:**
   - Email: your test user email
   - Password: your test user password

3. **Click "Sign In"**

4. **See OTP Modal?** ✅ Working!
   ```
   ┌─────────────────────────────┐
   │   Login Verification        │
   │   Enter 6-digit code        │
   │   [______]                  │
   │   [Send Again] [Verify]     │
   └─────────────────────────────┘
   ```

5. **Check Email** (or server console)
   - Subject: "Your Login Verification Code - SuppliWise"
   - Code: 6 digits (e.g., 123456)

6. **Enter OTP & Click "Verify & Sign In"**

7. **Logged in?** ✅ Success! You're done!

---

## 🐛 Quick Troubleshooting

### Problem: No OTP Modal

**Check browser console for errors:**
```javascript
// Open DevTools (F12) → Console tab
// Look for red errors
```

**Solution:** Refresh page and retry

---

### Problem: Email Not Received

**Check server console:**
```bash
# Look for these lines:
[Email] Email service configured successfully
[OTP] Login verification for user@example.com: 123456
[Email] OTP sent successfully to user@example.com
```

**Solution 1:** Check spam/junk folder  
**Solution 2:** Click "Send Again" button  
**Solution 3:** Use OTP from server console (development mode)

---

### Problem: OTP Invalid

**Check server console for OTP code:**
```bash
[OTP] Login verification for user@example.com: 123456
```

**Solution:** Copy exact code from console or email

---

### Problem: Button Always Disabled

**Issue:** "Send Again (60s)" countdown stuck?

**Solution:** Wait full 60 seconds, then try again

---

## 📱 User Instructions

### How to Login (New Process)

**Before:**
1. Enter email/password → Sign in ✅

**Now:**
1. Enter email/password
2. Click "Sign In"
3. **Check your email** 📧
4. Enter 6-digit code
5. Click "Verify & Sign In" ✅

**Extra 10-30 seconds for enhanced security!**

---

## 🔑 Quick Reference

### OTP Specs
- **Length:** 6 digits
- **Valid for:** 10 minutes
- **Resend cooldown:** 60 seconds
- **Delivery:** Email (+ console in dev mode)

### API Endpoints
- `POST /api/auth/login` → Get OTP
- `POST /api/auth/verify-login-otp` → Verify & get token
- `POST /api/auth/resend-login-otp` → Resend OTP

### Files Changed
- ✅ `server/routes/auth.js` (backend)
- ✅ `server/utils/email.js` (email template)
- ✅ `my-react-app/src/Pages/LogIn.jsx` (frontend)

---

## 📚 Full Documentation

Need more details? Check these docs:

1. **[LOGIN_OTP_SUMMARY.md](./LOGIN_OTP_SUMMARY.md)** - Complete overview
2. **[LOGIN_OTP_SECURITY.md](./LOGIN_OTP_SECURITY.md)** - Technical details
3. **[LOGIN_OTP_TESTING.md](./LOGIN_OTP_TESTING.md)** - Testing guide

---

## ✅ Success Checklist

After testing, verify:

- [ ] OTP modal appears after login
- [ ] Email received with 6-digit code
- [ ] OTP code works
- [ ] "Send Again" button works
- [ ] Countdown timer works
- [ ] Can cancel and retry
- [ ] Successfully logged in
- [ ] Assessment flow still works

**All checked?** 🎉 **You're all set!**

---

## 🎯 What This Gives You

✅ **Enhanced Security** - 2FA for all logins  
✅ **Email Verification** - Confirm user identity  
✅ **Account Protection** - Prevent unauthorized access  
✅ **Professional UX** - Smooth, polished interface  
✅ **Rate Limiting** - Prevent abuse  

---

## 🚨 Important Notes

⚠️ **Breaking Change:** Login endpoint now requires OTP verification

⚠️ **Email Required:** Users must have email access to login

⚠️ **Production:** Remove development OTP logging before deploy

---

## 💬 Quick FAQ

**Q: Can I disable OTP?**  
A: Not recommended, but you can modify `/api/auth/login` to skip OTP

**Q: What if user doesn't receive email?**  
A: Click "Send Again" button (60-second cooldown)

**Q: How long is OTP valid?**  
A: 10 minutes

**Q: Can I use same OTP twice?**  
A: No, single-use only

**Q: Does this affect signup?**  
A: No, only login is affected

---

## 🎮 Testing Commands

```bash
# Quick test (copy-paste ready)

# 1. Start backend
cd server && npm start

# 2. Start frontend (new terminal)
cd my-react-app && npm run dev

# 3. Open browser
# Navigate to: http://localhost:5173/login

# 4. Login and check console for:
# [OTP] Login verification for user@example.com: 123456
```

---

## 🔥 Pro Tips

1. **Development Mode:** OTP shown in console (no email needed!)
2. **Testing:** Use "Send Again" to get fresh OTP codes
3. **Email Issues:** Check spam folder first
4. **Rate Limited:** Wait 60 seconds between "Send Again"
5. **Expired OTP:** Just click "Send Again" for new code

---

**That's it! Login OTP is now protecting your application! 🔐**

**Questions?** Check the [full documentation](./LOGIN_OTP_SECURITY.md)

**Issues?** See [troubleshooting guide](./LOGIN_OTP_SECURITY.md#troubleshooting)

---

**Last Updated:** July 1, 2026  
**Status:** ✅ Active  
**Version:** 1.0.0
