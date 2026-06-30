# Login OTP Testing Guide

## Quick Test Checklist

### ✅ Prerequisites
- [ ] Server running on `http://localhost:5000`
- [ ] Frontend running on `http://localhost:5173` (or configured port)
- [ ] Email service configured in `server/.env`
- [ ] Test email account accessible

---

## 🧪 Test Scenarios

### Test 1: Basic Login with OTP ⭐ PRIORITY

**Steps:**
1. Navigate to login page
2. Enter valid email and password
3. Click "Sign In"
4. **Expected:** OTP modal appears with message
5. Check email inbox for OTP code
6. **Expected:** Email from "SuppliWise" with 6-digit code
7. Enter OTP in modal
8. Click "Verify & Sign In"
9. **Expected:** Successfully logged in and redirected to home

**Success Criteria:**
- ✅ Modal appears after credentials validated
- ✅ Email received within 10 seconds
- ✅ OTP code works
- ✅ User logged in successfully

---

### Test 2: Resend OTP

**Steps:**
1. Start login process (Test 1, steps 1-4)
2. Wait 5 seconds (don't enter OTP)
3. Click "Send Again" button
4. **Expected:** Button shows "Send Again (60s)"
5. **Expected:** Countdown decreases: 59, 58, 57...
6. Check email for second OTP
7. **Expected:** New email received
8. Enter new OTP from second email
9. **Expected:** Successfully logged in

**Success Criteria:**
- ✅ "Send Again" button shows countdown
- ✅ New email received
- ✅ New OTP code works
- ✅ Old OTP code no longer works

---

### Test 3: Invalid OTP

**Steps:**
1. Start login process
2. Enter wrong OTP (e.g., "000000")
3. Click "Verify & Sign In"
4. **Expected:** Error message: "Invalid verification code"
5. Enter correct OTP
6. **Expected:** Successfully logged in

**Success Criteria:**
- ✅ Wrong OTP rejected
- ✅ Clear error message shown
- ✅ Can retry with correct OTP without requesting new one

---

### Test 4: Rate Limiting

**Steps:**
1. Start login process
2. Immediately click "Send Again" (before 60 seconds)
3. **Expected:** Button disabled with countdown
4. Try clicking multiple times
5. **Expected:** Nothing happens (button stays disabled)
6. Wait for countdown to reach 0
7. **Expected:** Button becomes enabled: "Send Again"
8. Click "Send Again"
9. **Expected:** New OTP sent, countdown restarts

**Success Criteria:**
- ✅ Cannot spam "Send Again"
- ✅ Countdown timer accurate
- ✅ Button re-enables after 60 seconds

---

### Test 5: Cancel OTP

**Steps:**
1. Start login process
2. OTP modal appears
3. Click "Cancel" button
4. **Expected:** Modal closes
5. **Expected:** Back at login page
6. Re-enter credentials and login again
7. **Expected:** New OTP modal appears

**Success Criteria:**
- ✅ Can cancel OTP process
- ✅ Can restart login
- ✅ Previous OTP still valid if not expired

---

### Test 6: Wrong Credentials (No OTP)

**Steps:**
1. Enter wrong email or password
2. Click "Sign In"
3. **Expected:** Error: "Invalid email or password"
4. **Expected:** NO OTP modal appears
5. Enter correct credentials
6. **Expected:** OTP modal now appears

**Success Criteria:**
- ✅ OTP only sent for valid credentials
- ✅ Clear error message for wrong credentials
- ✅ No OTP wasted on failed login attempts

---

### Test 7: OTP Expiration (Long Test - 11 minutes)

**Steps:**
1. Start login process
2. Note the time
3. Wait 11 minutes (OTP expires after 10 minutes)
4. Enter the OTP
5. **Expected:** Error: "Verification code has expired"
6. Click "Send Again"
7. Enter new OTP
8. **Expected:** Successfully logged in

**Success Criteria:**
- ✅ OTP expires after 10 minutes
- ✅ Clear expiration message
- ✅ Can request new OTP

---

### Test 8: Email Not Received

**Steps:**
1. Start login process
2. Wait 30 seconds for email
3. If no email, check spam folder
4. If still no email, click "Send Again"
5. Check server console for logs:
   ```
   [OTP] Login verification for user@example.com: 123456
   [Email] OTP sent successfully to user@example.com
   ```

**Success Criteria:**
- ✅ Server logs show OTP generated
- ✅ Server logs show email sent
- ✅ Can resend if not received

---

### Test 9: Assessment Flow Integration

**Steps:**
1. Go to Assessment page (not logged in)
2. Complete assessment form
3. Click "Get Recommendations"
4. **Expected:** Redirected to login with banner
5. **Banner Message:** "Please sign in to view your supplement recommendations. Your assessment has been saved."
6. Enter credentials
7. **Expected:** OTP modal appears
8. Enter OTP
9. **Expected:** Logged in AND see assessment results

**Success Criteria:**
- ✅ Assessment saved during login
- ✅ OTP process doesn't lose assessment data
- ✅ User sees results after login

---

### Test 10: Multiple Browser Sessions

**Steps:**
1. Browser A: Start login, get OTP
2. Browser B: Start login with same account, get new OTP
3. Browser A: Try to use first OTP
4. **Expected:** First OTP still works (OTP per user, not session)
5. Browser B: Use second OTP
6. **Expected:** Successfully logged in
7. Browser A: Try first OTP again
8. **Expected:** Should still work if not expired

**Success Criteria:**
- ✅ Multiple OTPs can exist per user
- ✅ Each browser session independent
- ✅ No conflicts between sessions

---

## 🔍 Things to Verify

### Visual Checks

- [ ] Modal is centered on screen
- [ ] Modal is responsive on mobile
- [ ] OTP input field is large and clear
- [ ] Countdown timer updates smoothly
- [ ] Error messages are visible and clear
- [ ] Success messages display correctly
- [ ] Buttons are properly styled
- [ ] Email shows user's actual email address

### Functional Checks

- [ ] Can only enter digits in OTP field
- [ ] OTP input limited to 6 characters
- [ ] Submit button disabled until 6 digits entered
- [ ] Loading states work correctly
- [ ] Can't submit while loading
- [ ] Modal prevents clicking outside when loading
- [ ] All errors display properly
- [ ] Can dismiss errors by typing

### Email Checks

- [ ] Email arrives quickly (< 10 seconds)
- [ ] Email is from "SuppliWise"
- [ ] Email subject correct
- [ ] Email contains 6-digit code
- [ ] Email has SuppliWise branding
- [ ] Email shows expiration time
- [ ] Email includes security tips
- [ ] Plain text version readable

### Security Checks

- [ ] OTP expires after 10 minutes
- [ ] Rate limiting works (60 seconds)
- [ ] Invalid OTP rejected
- [ ] Expired OTP rejected
- [ ] OTP deleted after use
- [ ] Cannot reuse same OTP
- [ ] OTP not visible in network requests (except dev mode)
- [ ] No sensitive data in error messages

---

## 🐛 Common Issues & Solutions

### Issue: Email Not Arriving

**Check:**
```bash
# Server console should show:
[Email] Email service configured successfully
[OTP] Login verification for user@example.com: 123456
[Email] OTP sent successfully to user@example.com
```

**Solutions:**
1. Check spam/junk folder
2. Verify EMAIL_USER and EMAIL_PASSWORD in .env
3. For Gmail: Use App Password, not regular password
4. Check email service logs

### Issue: Modal Not Appearing

**Check:**
- Browser console for JavaScript errors
- Network tab for failed API calls

**Solutions:**
1. Refresh page and retry
2. Clear browser cache
3. Check backend is running
4. Verify API endpoint responding

### Issue: OTP Always Invalid

**Check:**
```bash
# Server console for OTP value
[OTP] Login verification for user@example.com: 123456
```

**Solutions:**
1. Compare console OTP with entered OTP
2. Check for extra spaces
3. Ensure OTP not expired
4. Check system time is correct

### Issue: "Send Again" Always Disabled

**Check:**
- Does countdown reach 0?
- Any JavaScript errors?

**Solutions:**
1. Wait full 60 seconds
2. Close and reopen modal
3. Refresh page and restart login

---

## 📊 Testing Checklist Summary

| Test | Priority | Duration | Status |
|------|----------|----------|--------|
| Basic Login with OTP | ⭐⭐⭐ High | 1 min | [ ] |
| Resend OTP | ⭐⭐ Medium | 2 min | [ ] |
| Invalid OTP | ⭐⭐ Medium | 1 min | [ ] |
| Rate Limiting | ⭐⭐ Medium | 2 min | [ ] |
| Cancel OTP | ⭐ Low | 1 min | [ ] |
| Wrong Credentials | ⭐⭐ Medium | 1 min | [ ] |
| OTP Expiration | ⭐ Low | 11 min | [ ] |
| Email Not Received | ⭐⭐ Medium | 2 min | [ ] |
| Assessment Flow | ⭐⭐⭐ High | 3 min | [ ] |
| Multiple Sessions | ⭐ Low | 2 min | [ ] |

**Total Testing Time:** ~26 minutes (or ~15 minutes without expiration test)

---

## 🚀 Quick Start Testing

### 1. Start Development Servers

```bash
# Terminal 1: Start backend
cd server
npm start

# Terminal 2: Start frontend
cd my-react-app
npm run dev
```

### 2. Test Basic Flow (1 minute)

1. Open browser: `http://localhost:5173/login`
2. Enter test credentials
3. Check for OTP modal
4. Check email
5. Enter OTP
6. Verify login success

### 3. If Issues

Check server console for:
```
[Email] Email service configured successfully
[OTP] Login verification for user@example.com: 123456
[OTP] Expires at: 2026-07-01T12:30:00.000Z
[OTP] Email sent: true
```

---

## 📝 Test Results Template

```
Date: _________________
Tester: _________________
Environment: [ ] Development [ ] Staging [ ] Production

Test 1 - Basic Login with OTP: [ ] PASS [ ] FAIL
Notes: _______________________________________________

Test 2 - Resend OTP: [ ] PASS [ ] FAIL
Notes: _______________________________________________

Test 3 - Invalid OTP: [ ] PASS [ ] FAIL
Notes: _______________________________________________

Test 4 - Rate Limiting: [ ] PASS [ ] FAIL
Notes: _______________________________________________

Test 5 - Cancel OTP: [ ] PASS [ ] FAIL
Notes: _______________________________________________

Test 6 - Wrong Credentials: [ ] PASS [ ] FAIL
Notes: _______________________________________________

Test 7 - OTP Expiration: [ ] PASS [ ] FAIL
Notes: _______________________________________________

Test 8 - Email Not Received: [ ] PASS [ ] FAIL
Notes: _______________________________________________

Test 9 - Assessment Flow: [ ] PASS [ ] FAIL
Notes: _______________________________________________

Test 10 - Multiple Sessions: [ ] PASS [ ] FAIL
Notes: _______________________________________________

Overall Status: [ ] ALL PASS [ ] SOME FAIL
```

---

**Ready to test? Start with Test 1 (Basic Login with OTP)! 🚀**
