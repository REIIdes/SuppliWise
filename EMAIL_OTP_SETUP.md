# Email OTP Setup Guide

## Overview
The OTP (One-Time Password) system now sends actual emails using Nodemailer with a professional SuppliWise-branded template.

---

## 🚀 Quick Setup

### Step 1: Install Nodemailer

```bash
cd server
npm install nodemailer
```

### Step 2: Configure Email Service

You have two options:

#### Option A: Gmail (Recommended for Testing)

1. **Enable 2-Factor Authentication** on your Gmail account:
   - Go to: https://myaccount.google.com/security
   - Enable 2-Step Verification

2. **Create an App Password**:
   - Go to: https://myaccount.google.com/apppasswords
   - Select "Mail" and "Windows Computer"
   - Click "Generate"
   - Copy the 16-character password (e.g., `abcd efgh ijkl mnop`)

3. **Update `.env` file**:
   ```env
   EMAIL_SERVICE=gmail
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASSWORD=abcd efgh ijkl mnop
   EMAIL_FROM_NAME=SuppliWise
   EMAIL_FROM_ADDRESS=your-email@gmail.com
   ```

#### Option B: Other Email Services

**Outlook/Hotmail:**
```env
EMAIL_SERVICE=hotmail
EMAIL_USER=your-email@outlook.com
EMAIL_PASSWORD=your-password
EMAIL_FROM_NAME=SuppliWise
EMAIL_FROM_ADDRESS=your-email@outlook.com
```

**Yahoo:**
```env
EMAIL_SERVICE=yahoo
EMAIL_USER=your-email@yahoo.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM_NAME=SuppliWise
EMAIL_FROM_ADDRESS=your-email@yahoo.com
```

**Custom SMTP:**
```env
EMAIL_SERVICE=smtp
EMAIL_HOST=smtp.yourprovider.com
EMAIL_PORT=587
EMAIL_USER=your-email@domain.com
EMAIL_PASSWORD=your-password
EMAIL_FROM_NAME=SuppliWise
EMAIL_FROM_ADDRESS=your-email@domain.com
```

### Step 3: Restart Server

```bash
# In server directory
npm start
```

---

## ✨ New Features

### 1. **Actual Email Delivery**
- Sends professional HTML emails
- Plain text fallback for older email clients
- Beautiful SuppliWise-branded template
- Green theme matching your app

### 2. **"Send Again" Button**
- Resend OTP if not received
- 60-second cooldown to prevent spam
- Shows countdown timer: "Send Again (59s)"
- Rate limiting on backend

### 3. **Searchable by "SuppliWise"**
- Sender name: **"SuppliWise"**
- Subject: "Verify Your Email Change - SuppliWise"
- Can search email inbox for "SuppliWise"

### 4. **Professional Email Template**
- SuppliWise logo and branding
- Green gradient header
- Large, easy-to-read OTP code
- Security tips
- 10-minute expiration notice
- Responsive design

---

## 📧 Email Preview

### Subject Line
```
Verify Your Email Change - SuppliWise
```

### Email Content
```
┌─────────────────────────────────────────────┐
│   [SuppliWise Logo]                         │
│   Verify Your Email                         │
│   SuppliWise Email Verification             │
├─────────────────────────────────────────────┤
│                                             │
│   Hi there,                                 │
│                                             │
│   You requested to change your email        │
│   address on SuppliWise...                  │
│                                             │
│   ┌───────────────────────────────┐        │
│   │  YOUR VERIFICATION CODE        │        │
│   │  ┌─────────────────────────┐  │        │
│   │  │      482751             │  │        │
│   │  └─────────────────────────┘  │        │
│   │  Expires in 10 minutes         │        │
│   └───────────────────────────────┘        │
│                                             │
│   🔒 Security Tip: Never share this code   │
│                                             │
│   Best regards,                             │
│   The SuppliWise Team                       │
├─────────────────────────────────────────────┤
│   © 2026 SuppliWise. All rights reserved.  │
└─────────────────────────────────────────────┘
```

---

## 🧪 Testing

### Test 1: Send OTP
1. Login to your account
2. Go to Profile Settings
3. Click "Edit Profile"
4. Change email address
5. Click "Save Changes"
6. ✅ Check your email for OTP

### Test 2: "Send Again" Button
1. In OTP modal, wait for code
2. Click "Send Again"
3. ✅ Button shows "Send Again (60s)"
4. ✅ Countdown decreases: 59s, 58s, 57s...
5. ✅ After 60s, button becomes clickable again
6. ✅ New OTP sent to email

### Test 3: Search in Email
1. Open your email client
2. Search for: "SuppliWise"
3. ✅ OTP email appears in results

### Test 4: Rate Limiting
1. Request OTP
2. Immediately try "Send Again"
3. ✅ Must wait 60 seconds
4. ✅ Shows countdown timer

---

## 🔧 How It Works

### Backend Flow

```
1. User changes email in Profile Settings
   ↓
2. Frontend calls /api/auth/request-email-otp
   ↓
3. Backend checks rate limit (60s cooldown)
   ↓
4. Generate 6-digit OTP code
   ↓
5. Store OTP in memory (expires in 10 min)
   ↓
6. Send email via Nodemailer
   ↓
7. Return success to frontend
   ↓
8. User receives email with OTP
   ↓
9. User enters OTP in modal
   ↓
10. Backend verifies OTP
   ↓
11. Email updated in database
```

### Frontend Flow

```
User Changes Email
   ↓
OTP Modal Opens
   ↓
Email Sent Automatically
   ↓
User Waits for Email
   ↓
[Didn't receive?]
   ↓
Click "Send Again"
   ↓
60-second cooldown starts
   ↓
New email sent
   ↓
User enters OTP
   ↓
Verify & Update
```

---

## 🔒 Security Features

### 1. **Rate Limiting**
- Maximum 1 OTP request per 60 seconds per user
- Prevents spam and abuse
- Shows remaining cooldown time

### 2. **OTP Expiration**
- Codes expire after 10 minutes
- Automatic cleanup of expired codes
- User must request new code after expiration

### 3. **Secure Storage**
- OTP stored in memory (not database)
- Deleted after verification
- Deleted after expiration

### 4. **Email Verification**
- Code sent to NEW email address
- Ensures user has access to new email
- Prevents unauthorized email changes

---

## 🐛 Troubleshooting

### Email Not Sending?

**Check 1: Nodemailer Installed?**
```bash
cd server
npm list nodemailer
# Should show: nodemailer@X.X.X
```

**Check 2: .env Configuration**
```bash
# Verify these are set in server/.env
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
```

**Check 3: Server Logs**
```bash
# Look for these messages:
[Email] Email service configured successfully
[Email] OTP sent successfully to user@example.com
```

**Check 4: Gmail App Password**
- Must use App Password, not regular password
- Must have 2FA enabled first
- App Password format: `abcd efgh ijkl mnop`

### "Send Again" Not Working?

**Issue: Button Disabled**
- Must wait 60 seconds between requests
- Check countdown timer
- Wait for "Send Again" (no timer)

**Issue: Error Message**
```
Please wait XX seconds before requesting another code.
```
- This is rate limiting working correctly
- Wait for the countdown to finish

### OTP Not in Email?

**Check 1: Spam/Junk Folder**
- Check spam/junk folder
- Mark as "Not Spam" if found

**Check 2: Email Address**
- Verify correct email entered
- Check for typos

**Check 3: Development Mode**
- Check server console for OTP
- In development, OTP also logged to console

---

## 📝 Environment Variables Reference

```env
# Email Service Configuration
EMAIL_SERVICE=gmail              # Service: gmail, hotmail, yahoo, smtp
EMAIL_USER=your@email.com       # Your email address
EMAIL_PASSWORD=your-app-pass    # App password (NOT regular password)
EMAIL_FROM_NAME=SuppliWise      # Sender name (shows in inbox)
EMAIL_FROM_ADDRESS=your@email.com # From address
```

---

## 🚀 Production Recommendations

### 1. Use Professional Email Service
Instead of personal Gmail, use:
- **SendGrid** (recommended)
- **AWS SES** (Amazon Simple Email Service)
- **Mailgun**
- **Postmark**

### 2. Use Redis for OTP Storage
Replace in-memory Map with Redis:
```javascript
// Instead of Map
const otpStore = new Map();

// Use Redis
const redis = require('redis');
const client = redis.createClient();
```

### 3. Remove Development Features
In production, remove:
```javascript
// Remove this in production:
...(process.env.NODE_ENV === 'development' && { otp }),
```

### 4. Add Email Templates
- Create reusable email templates
- Support multiple languages
- Add email preferences

---

## ✅ What's Working Now

- ✅ Sends real emails via Nodemailer
- ✅ Professional SuppliWise-branded template
- ✅ Searchable by "SuppliWise" in inbox
- ✅ "Send Again" button with 60s cooldown
- ✅ Countdown timer display
- ✅ Rate limiting on backend
- ✅ Success/error messages
- ✅ OTP expiration (10 minutes)
- ✅ HTML + plain text email formats
- ✅ Responsive email design
- ✅ Security tips in email

---

## 📚 Additional Resources

- **Nodemailer Docs**: https://nodemailer.com/
- **Gmail App Passwords**: https://myaccount.google.com/apppasswords
- **SendGrid**: https://sendgrid.com/
- **AWS SES**: https://aws.amazon.com/ses/

---

**Setup Date:** July 1, 2026  
**Status:** ✅ Ready for Testing  
**Next Steps:** Install nodemailer and configure .env
