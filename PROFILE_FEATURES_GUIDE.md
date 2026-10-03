# Profile Settings - Quick Feature Guide

## 🎨 Visual Walkthrough

### Feature 1: Email Change with Timer ⏰

**Step-by-Step:**

```
1. Navigate to Profile Settings
   └─> Click "Edit Profile"

2. Change Email Address
   ┌────────────────────────────┐
   │ Email Address              │
   │ ┌────────────────────────┐ │
   │ │ newemail@example.com   │ │
   │ └────────────────────────┘ │
   └────────────────────────────┘
   
3. Click "Save Changes"
   └─> OTP Modal Appears!

4. OTP Modal with Timer
   ┌─────────────────────────────────────┐
   │  Verify Email Change                │
   ├─────────────────────────────────────┤
   │  We've sent a 6-digit code to:      │
   │  newemail@example.com               │
   │                                     │
   │  ┌───────────────────────────────┐ │
   │  │ 🕐 Code expires in 9:42       │ │ ← NEW TIMER!
   │  └───────────────────────────────┘ │
   │                                     │
   │  [___ ___ ___ ___ ___ ___]          │
   │  Enter 6-digit code                 │
   │                                     │
   │  [Send Again (55s)]  [Verify]       │
   └─────────────────────────────────────┘

5. Timer Behavior:
   9:42 → 9:41 → 9:40 ... (blue, calm)
   1:00 → 0:59 → 0:58 ... (red, pulsing!)
   0:00 → Input disabled, "Expired" error
```

---

### Feature 2: Password Visibility Toggle 👁️

**Step-by-Step:**

```
1. Navigate to Profile Settings
   └─> Click "Edit Profile"

2. Scroll to "Change Password"
   
3. Password Fields with Eye Icons
   
   Change Password
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   
   Current Password
   ┌────────────────────────────────┐
   │ ••••••••••••           👁️      │ ← Click eye
   └────────────────────────────────┘
   
   New Password
   ┌────────────────────────────────┐
   │ MyNewPass123       👁️‍🗨️       │ ← Visible!
   └────────────────────────────────┘
   
   Confirm New Password
   ┌────────────────────────────────┐
   │ ••••••••••••           👁️      │ ← Hidden
   └────────────────────────────────┘

4. Click Eye Icons:
   👁️ (open eye) = Show password
   👁️‍🗨️ (crossed eye) = Hide password
   
5. Each field independent:
   ✓ Can show Current while hiding New
   ✓ Can show New while hiding Confirm
   ✓ Any combination works!
```

---

## 🎯 Quick Actions

### Test Email Change Timer

```bash
1. Profile Settings
2. Edit Profile
3. Change email to: test@example.com
4. Save Changes
5. Watch timer: 10:00 → 9:59 → 9:58...
6. See red at 0:59
7. Let expire to 0:00 (or enter code!)
```

### Test Password Toggle

```bash
1. Profile Settings
2. Edit Profile
3. Scroll to "Change Password"
4. Type in Current Password field
5. Click eye icon → Password visible ✓
6. Click again → Password hidden ✓
7. Repeat for New Password field
8. Repeat for Confirm Password field
```

---

## 🎨 Visual States

### Timer States

**Normal (>1 min):**
```
┌───────────────────────────────┐
│ 🕐 Code expires in 8:42       │ Blue background
└───────────────────────────────┘ Calm, informative
```

**Warning (<1 min):**
```
┌───────────────────────────────┐
│ 🕐 Code expires in 0:47       │ Red text
└───────────────────────────────┘ Pulsing animation!
```

**Expired (0:00):**
```
┌───────────────────────────────┐
│ 🕐 Code expires in 0:00       │ Red, stopped
└───────────────────────────────┘ 
❌ Input disabled
❌ Button disabled
⚠️ Error: "Code has expired..."
```

### Password States

**Hidden:**
```
┌────────────────────────────┐
│ ••••••••••••        👁️     │
└────────────────────────────┘
Type: password
Icon: Eye (open)
Color: Gray
```

**Visible:**
```
┌────────────────────────────┐
│ MyPassword123   👁️‍🗨️      │
└────────────────────────────┘
Type: text
Icon: Eye-slash (crossed)
Color: Gray → Green on hover
```

---

## 🔄 User Flows

### Flow 1: Successful Email Change

```
Profile → Edit → Change Email
    ↓
Save Changes
    ↓
OTP Modal Opens (Timer: 10:00)
    ↓
Check Email for Code
    ↓
Enter 6-digit Code (Timer: 9:15)
    ↓
Click "Verify"
    ↓
✅ Success! Email Updated
    ↓
Page Refreshes with New Email
```

### Flow 2: OTP Expiration & Resend

```
Profile → Edit → Change Email
    ↓
Save Changes
    ↓
OTP Modal Opens (Timer: 10:00)
    ↓
User Distracted... Timer counts down
    ↓
Timer: 0:59 (Turns red, pulses)
    ↓
Timer: 0:00 (Input disabled)
    ↓
Error: "Code has expired"
    ↓
Click "Send Again"
    ↓
Timer Resets: 10:00
New OTP Generated
    ↓
Enter New Code
    ↓
✅ Success!
```

### Flow 3: Password Change with Visibility

```
Profile → Edit → Scroll to Password
    ↓
Enter Current Password
    ↓
Can't see what I typed...
    ↓
Click Eye Icon 👁️
    ↓
Password Visible! (Verify correct)
    ↓
Click Eye Again (Hide)
    ↓
Enter New Password
    ↓
Click Eye on New Password 👁️
    ↓
Verify it's strong
    ↓
Hide and Confirm
    ↓
Click Eye on Confirm 👁️
    ↓
Verify it matches
    ↓
✅ Save Changes
```

---

## 💡 Tips & Tricks

### Timer Tips

✅ **Don't Panic at 0:59**
- You still have 59 seconds
- Red color is just a warning
- Plenty of time to enter code

✅ **Use "Send Again"**
- If email delayed, resend immediately
- Timer resets to full 10 minutes
- Old code invalidated

✅ **Watch for Typos**
- Timer continues while you type
- Double-check code before submitting
- Each digit counts

### Password Visibility Tips

✅ **Verify Before Hiding**
- Show password
- Read it carefully
- Hide again

✅ **Use for Complex Passwords**
- Special characters hard to type
- Toggle to verify each one
- Reduces errors

✅ **Mobile Friendly**
- Large touch target
- Easy to tap
- Works on all devices

---

## 🐛 Troubleshooting

### Timer Issues

**Q: Timer not counting down?**
```
A: Refresh the page and try again
   Modal should show 10:00 and start counting
```

**Q: Timer stuck at 0:00?**
```
A: Code has expired
   Click "Send Again" for new code
   Timer will reset to 10:00
```

**Q: Can't click Verify at 0:00?**
```
A: This is correct behavior
   Button disabled when expired
   Click "Send Again" for new code
```

### Password Toggle Issues

**Q: Eye icon not showing?**
```
A: Scroll to "Change Password" section
   Only appears when editing
   Must click "Edit Profile" first
```

**Q: Password not toggling?**
```
A: Click directly on eye icon
   Should toggle between dots and text
   Each field independent
```

**Q: Can't see eye icon?**
```
A: Check field has focus
   Icon on right side of input
   Gray color (green on hover)
```

---

## ✅ Checklist

### Before Testing

- [ ] Logged in to account
- [ ] On Profile Settings page
- [ ] Clicked "Edit Profile" button

### Email Change Timer

- [ ] Changed email address
- [ ] Clicked "Save Changes"
- [ ] OTP modal appeared
- [ ] Timer shows 10:00
- [ ] Timer counting down
- [ ] Timer turns red at <1 minute
- [ ] Timer pulses when <1 minute
- [ ] Input disables at 0:00
- [ ] "Send Again" resets timer

### Password Visibility

- [ ] In "Change Password" section
- [ ] Eye icons visible on all 3 fields
- [ ] Current Password toggle works
- [ ] New Password toggle works
- [ ] Confirm Password toggle works
- [ ] Icons change (open/crossed)
- [ ] Hover effect works (green)
- [ ] Each field independent

---

## 🎉 Summary

Two new features make Profile Settings easier to use:

### ⏰ Email Change Timer
- Know exactly when code expires
- Visual warning when time running out
- Auto-disables when expired
- Easy to request new code

### 👁️ Password Visibility
- See what you're typing
- Verify passwords before submitting
- Reduce typos and errors
- Professional UX pattern

---

**Both features are now live!**  
**Go test them in Profile Settings!** 🚀

**Path:** Profile Settings → Edit Profile → Change Email / Change Password
