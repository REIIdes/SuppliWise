# Quick Setup - Email OTP

## 🚀 Quick Start (3 Steps)

### Step 1: Install Nodemailer
```bash
cd server
npm install nodemailer
```

### Step 2: Configure Gmail

1. **Enable 2FA on Gmail:**
   - Visit: https://myaccount.google.com/security
   - Turn on 2-Step Verification

2. **Create App Password:**
   - Visit: https://myaccount.google.com/apppasswords
   - Generate password for "Mail" app
   - Copy the 16-character code

3. **Update `server/.env`:**
   ```env
   EMAIL_SERVICE=gmail
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASSWORD=abcd efgh ijkl mnop
   EMAIL_FROM_NAME=SuppliWise
   EMAIL_FROM_ADDRESS=your-email@gmail.com
   ```

### Step 3: Restart Server
```bash
cd server
npm start
```

---

## ✅ Test It

1. Login to your account
2. Go to Profile Settings → Edit Profile
3. Change your email address
4. Click "Save Changes"
5. **Check your email for the OTP!**
6. Search "SuppliWise" in your inbox

---

## 🎯 New Features

✨ **Real emails sent** - No more console-only OTPs  
✨ **"Send Again" button** - Resend with 60s cooldown  
✨ **Searchable** - Find by "SuppliWise" in inbox  
✨ **Professional design** - Branded email template  
✨ **Countdown timer** - Shows remaining cooldown time  

---

## 📧 What the Email Looks Like

**From:** SuppliWise <your-email@gmail.com>  
**Subject:** Verify Your Email Change - SuppliWise  

**Body:**
- SuppliWise logo
- Large OTP code: **482751**
- Expires in 10 minutes
- Security tips
- Professional green design

---

## 🐛 Not Working?

### No Email Received?
1. Check spam/junk folder
2. Verify Gmail App Password is correct
3. Check server console for logs
4. Try "Send Again" button

### Can't Install?
```bash
# Make sure you're in the server folder
cd server
pwd  # Should show: .../SuppliWise/server

# Then install
npm install nodemailer
```

### Server Won't Start?
```bash
# Check if nodemailer installed
npm list nodemailer

# If not listed, install again
npm install nodemailer
```

---

## 💡 Tips

- Use your **personal Gmail** for testing
- Email appears from **"SuppliWise"** 
- "Send Again" has **60-second cooldown**
- OTP **expires in 10 minutes**
- Check **spam folder** first time

---

For detailed setup instructions, see: `EMAIL_OTP_SETUP.md`
