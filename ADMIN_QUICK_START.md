# 🚀 Admin Quick Start Guide

## ✅ Setup Complete!

All 6 admin accounts are configured and ready to use.

## Quick Login (AdminPoli)

**Username:** `AdminPoli`  
**Password:** `Poli101`  
**TOTP:** Setup required (see below)

---

## 📱 Step 1: Setup Authenticator (ONE TIME)

1. Open `server/all-admins-totp-setup.html` in your browser
2. Find your admin card (AdminPoli, AdminJoma, etc.)
3. Scan the QR code with your authenticator app:
   - Google Authenticator
   - Microsoft Authenticator
   - Authy
   - Any TOTP-compatible app

**Alternative:** Manually enter the secret key shown on the card

---

## 🖥️ Step 2: Start the Server

```powershell
cd server
npm start
```

Wait for: `Server running on port 5000`

---

## 🔐 Step 3: Login

1. Open browser: `http://localhost:5173/admin/login`
2. Enter username: `AdminPoli`
3. Enter password: `Poli101`
4. Enter 6-digit code from authenticator app
5. Click **Sign In**

---

## ✅ All Admin Accounts

1. **AdminJoma** - Setup TOTP from HTML file
2. **AdminPoli** - Password: `Poli101` ✓
3. **AdminJohn** - Setup TOTP from HTML file
4. **AdminShMa** - Setup TOTP from HTML file
5. **AdminRaNe** - Setup TOTP from HTML file
6. **AdminDevs** - Setup TOTP from HTML file

---

## 🧪 Test Configuration

Run this to verify everything:

```powershell
cd server
node test-admin-login.js
```

Expected output: `✅ ALL TESTS PASSED`

---

## 🔧 Troubleshooting

### "Invalid credentials"
- ✓ Server restarted after .env update?
- ✓ Username is case-sensitive: `AdminPoli` not `adminpoli`
- ✓ Password is case-sensitive: `Poli101` not `poli101`

### "Invalid authenticator code"
- ✓ Device clock synchronized?
- ✓ Used the correct QR code for your account?
- ✓ Code refreshes every 30 seconds - try the next one

### Account locked
- Wait 15 minutes after 3 failed attempts
- Or restart the server to clear locks

---

## 🛡️ Security Reminders

- [ ] Delete `server/all-admins-totp-setup.html` after setup
- [ ] Delete `server/admin-totp-setup.html` if exists
- [ ] Never commit `.env` file
- [ ] Backup authenticator app seeds
- [ ] Store passwords in password manager

---

## 📁 Important Files

- `server/.env` - Admin credentials (gitignored)
- `server/all-admins-totp-setup.html` - QR codes (DELETE after setup)
- `server/test-admin-login.js` - Verification script
- `ADMIN_LOGIN_SETUP_COMPLETE.md` - Full documentation

---

**Ready to go!** 🎉

Login URL: `http://localhost:5173/admin/login`  
Username: `AdminPoli`  
Password: `Poli101`  
TOTP: From your authenticator app
