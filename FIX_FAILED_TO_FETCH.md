# Fix: "Failed to Fetch" Error

## ✅ Fixed!

The error was caused by:
1. ❌ Nodemailer not installed
2. ❌ Port 5000 already in use (old server instance)

### What I Did:
1. ✅ Installed nodemailer: `npm install nodemailer`
2. ✅ Killed the old server process on port 5000
3. ✅ Started fresh server
4. ✅ Server now running successfully on port 5000

---

## Current Status

✅ **Server:** Running on http://localhost:5000  
✅ **Nodemailer:** Installed  
✅ **Email Service:** Ready (needs configuration)

---

## Next Steps

### To Enable Email Sending:

**Option 1: Configure Gmail (Recommended)**

1. **Get Gmail App Password:**
   - Visit: https://myaccount.google.com/apppasswords
   - Enable 2FA first if not already enabled
   - Create App Password for "Mail"
   - Copy the 16-character password

2. **Update `server/.env`:**
   ```env
   EMAIL_SERVICE=gmail
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASSWORD=abcd efgh ijkl mnop
   EMAIL_FROM_NAME=SuppliWise
   EMAIL_FROM_ADDRESS=your-email@gmail.com
   ```

3. **Restart Server:**
   - Stop current server (Ctrl+C in terminal)
   - Start again: `npm start`

**Option 2: Use Without Email (Development)**

The system will work without email configuration:
- OTP codes will be logged to the server console
- Still works for testing
- No actual emails sent

---

## Test It Now

1. **Login** to your account
2. Go to **Profile Settings**
3. Click **"Edit Profile"**
4. Change your **email address**
5. Click **"Save Changes"**
6. ✅ OTP modal should open
7. Check **server console** for OTP (if email not configured)

---

## Common Issues

### "Failed to Fetch" Again?

**Check 1: Is Server Running?**
```bash
# Should see: Server running on port 5000
# Check server terminal
```

**Check 2: Port Already in Use?**
```bash
# Kill processes on port 5000
Get-NetTCPConnection -LocalPort 5000 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }

# Then restart server
npm start
```

**Check 3: Frontend Running?**
```bash
# Make sure frontend is running too
cd my-react-app
npm run dev
```

### OTP Not Showing in Console?

**With Email Configured:**
- Check your email inbox
- Check spam/junk folder
- Look for sender "SuppliWise"

**Without Email Configured:**
- Check server console/terminal
- Look for: `[OTP] Email change verification`
- OTP is the 6-digit number

### Can't Install Nodemailer?

```bash
# Make sure you're in server folder
cd server
pwd  # Should show: .../SuppliWise/server

# Clear npm cache
npm cache clean --force

# Install again
npm install nodemailer
```

---

## Quick Commands

### Kill Port 5000
```powershell
Get-NetTCPConnection -LocalPort 5000 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }
```

### Check if Nodemailer Installed
```bash
cd server
npm list nodemailer
# Should show: nodemailer@x.x.x
```

### Restart Server
```bash
cd server
npm start
```

### Check Server Status
```bash
# Visit in browser:
http://localhost:5000
```

---

## Current Configuration

```
✅ Nodemailer: Installed (v6.9.x)
✅ Server: Running on port 5000
✅ MongoDB: Connected
⚠️  Email: Not configured (uses console fallback)
```

---

## Email Configuration Status

**If you see this in server console:**
```
[Email] Email service not configured. OTP will only be logged to console.
```

This is **normal** if you haven't configured Gmail App Password yet. The system still works - OTP codes will appear in the server console instead of email.

---

## Ready to Test!

Your server is running and ready. The OTP system will:
- ✅ Work with or without email configuration
- ✅ Show OTP in console if email not configured
- ✅ Send real emails once you configure Gmail
- ✅ Include "Send Again" button with 60s cooldown

Try changing your email in Profile Settings now! 🚀

---

**Status:** ✅ Server Running  
**Port:** 5000  
**Database:** Connected  
**Nodemailer:** Installed
