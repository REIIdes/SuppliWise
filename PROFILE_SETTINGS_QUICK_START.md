# Profile Settings - Quick Start Guide

## What's New? 🎉

Your app now has a complete profile management system with these features:

### 👤 **Profile Picture Upload**
- Click your avatar to upload a picture (max 2MB)
- Displays everywhere your avatar shows
- Remove option available in edit mode

### 📧 **Email Verification (OTP)**
- Changing email requires verification
- 6-digit code sent (in dev: check console)
- 10-minute expiration

### ⚠️ **Future Assessments Only**
- Profile changes only apply to new assessments
- Past assessments remain unchanged
- Preserves historical accuracy

---

## Quick Test (Development)

### 1. Start the Application

```bash
# Terminal 1 - Backend
cd server
npm start

# Terminal 2 - Frontend
cd my-react-app
npm run dev
```

### 2. Test Profile Features

1. **Access Profile:**
   - Login to your account
   - Click your avatar/name in navbar
   - You'll see the profile page

2. **Upload Profile Picture:**
   - Click "Edit Profile"
   - Click the large avatar circle
   - Select an image file
   - Click "Save Changes"
   - ✅ Picture appears in navbar

3. **Change Email (with OTP):**
   - Click "Edit Profile"
   - Change email address
   - Click "Save Changes"
   - **Check your server console** for the OTP
   - Enter the 6-digit code in the modal
   - Click "Verify"
   - ✅ Email updated

4. **Update Other Info:**
   - Click "Edit Profile"
   - Change name, date of birth, gender
   - Click "Save Changes"
   - ✅ Changes saved

5. **Change Password:**
   - Click "Edit Profile"
   - Enter current password
   - Enter new password (8+ chars, 1 uppercase, 1 number)
   - Confirm new password
   - Click "Save Changes"
   - ✅ Password changed

---

## Important Files Modified

```
Frontend:
✨ my-react-app/src/Pages/ProfilePage.jsx (NEW)
✨ my-react-app/src/Pages/ProfilePage.css (NEW)
🔧 my-react-app/src/App.jsx
🔧 my-react-app/src/Components/Navbar/Navbar.jsx
🔧 my-react-app/src/Components/Navbar/Navbar.css

Backend:
🔧 server/routes/auth.js (3 new endpoints)
🔧 server/models/User.js (profilePicture field)
```

---

## New API Endpoints

```
POST   /api/auth/request-email-otp   # Request OTP for email change
POST   /api/auth/verify-email-otp    # Verify OTP
PUT    /api/auth/profile              # Update profile (existing, enhanced)
```

---

## Development Notes

### OTP in Development
- OTP is logged to the **server console**
- OTP is also included in the API response
- In production, send via email service

**Example Console Output:**
```
[OTP] Email change verification for john@old.com -> john@new.com: 482751
[OTP] Expires at: 2026-07-01T14:30:00.000Z
```

### Profile Pictures
- Currently stored as **base64** in database
- Max size: **2MB**
- For production: Use cloud storage (S3, Cloudinary)

---

## Validation Summary

| Field | Rules |
|-------|-------|
| Profile Picture | < 2MB, image formats only |
| First/Last Name | 2-50 characters |
| Email | Valid format, unique, requires OTP if changed |
| Date of Birth | Age 1-120 |
| Gender | Male or Female |
| Password | 8+ chars, 1 uppercase, 1 number |

---

## Important Notice Displayed

> **Important:** Changes made to your profile will only apply to future assessments. Previously completed assessments and their AI recommendations will remain unchanged to preserve the accuracy and history of past assessment records.

This notice is displayed prominently at the top of the profile form.

---

## Troubleshooting

### Can't see OTP?
- Check the **server terminal** console
- Look for `[OTP]` prefix
- OTP also in API response (dev mode only)

### Profile picture too large?
- Max 2MB allowed
- Compress image before uploading
- Use JPG instead of PNG for smaller size

### Email change not working?
- Verify OTP is correct
- Check if OTP expired (10 min limit)
- Request a new OTP

### Password change failed?
- Current password must be correct
- New password needs: 8+ chars, 1 uppercase, 1 number
- Passwords must match

---

## Next Steps for Production

1. **Integrate Email Service**
   - SendGrid, AWS SES, or similar
   - Send OTP via email
   - Remove OTP from API response

2. **Cloud Storage for Images**
   - AWS S3 or Cloudinary
   - Store URLs instead of base64
   - Add image optimization

3. **Enhanced Security**
   - Rate limiting on OTP requests
   - CAPTCHA for OTP
   - 2FA option
   - Device tracking

---

## Need More Details?

See `PROFILE_SETTINGS_COMPLETE.md` for:
- Complete API documentation
- Security features
- Database schema
- Error handling
- Future enhancements
- And much more!

---

**Ready to test?** Just start the servers and click your avatar! 🚀
