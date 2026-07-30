# 🔧 SuppliWise Troubleshooting Guide

This guide covers common issues and their solutions when developing and deploying SuppliWise.

---

## 📱 APK Issues

### Issue 1: APK Shows "Failed to Fetch" Error

**Symptoms:**
- APK cannot connect to backend server
- Web and mobile web work fine
- Alert shows correct backend URL

**Root Cause:**
Android's network security configuration blocks HTTP connections to IP addresses that aren't explicitly whitelisted.

**Solution:**

1. **Update Network Security Config:**
   
   Edit: `my-react-app/android/app/src/main/res/xml/network_security_config.xml`
   
   Add your computer's current IP address to the whitelist:
   ```xml
   <domain-config cleartextTrafficPermitted="true">
       <domain includeSubdomains="true">localhost</domain>
       <domain includeSubdomains="true">10.0.2.2</domain>
       <domain includeSubdomains="true">192.168.0.34</domain> <!-- Your current IP -->
       <domain includeSubdomains="true">192.168.1.1</domain>
   </domain-config>
   ```

2. **Update API Base URL:**
   
   Edit: `my-react-app/src/api.js`
   
   Update the IP address to match your computer's current IP:
   ```javascript
   const BASE_URL = 'http://192.168.0.34:5000/api'; // Use your actual IP
   ```

3. **Find Your Computer's IP Address:**
   
   **Windows:**
   ```cmd
   ipconfig
   ```
   Look for "IPv4 Address" under your WiFi adapter.
   
   **Mac/Linux:**
   ```bash
   ifconfig
   # or
   ip addr show
   ```

4. **Rebuild APK:**
   ```bash
   cd my-react-app
   npm run build
   npx cap sync android
   
   # Fix Java version (after every sync)
   # Edit: android/app/capacitor.build.gradle
   # Change VERSION_21 to VERSION_17
   
   cd android
   .\gradlew.bat clean assembleDebug
   ```

**Important Notes:**
- You must update **both** the network security config AND api.js when your IP changes
- Your IP typically stays the same but may change after router restarts
- For production, deploy backend to a public server with HTTPS to avoid this issue

---

### Issue 2: APK Build Fails with Java Version Error

**Symptoms:**
```
Cannot find a Java installation matching: {languageVersion=21}
```

**Root Cause:**
Capacitor 8.x generates config files requiring Java 21, but your system has Java 17.

**Solution:**

After **every** `npx cap sync android`, fix the Java version:

Edit: `android/app/capacitor.build.gradle`

Change:
```gradle
compileOptions {
    sourceCompatibility JavaVersion.VERSION_21
    targetCompatibility JavaVersion.VERSION_21
}
```

To:
```gradle
compileOptions {
    sourceCompatibility JavaVersion.VERSION_17
    targetCompatibility JavaVersion.VERSION_17
}
```

**Permanent Solution:**
Install JDK 21 from [Adoptium](https://adoptium.net/temurin/releases/) or upgrade to Java 21.

---

### Issue 3: PDF Download Doesn't Work in APK

**Symptoms:**
- PDF downloads work in browser
- APK shows "Download failed" or no file appears in Downloads

**Root Cause:**
Android 10+ uses Scoped Storage which requires MediaStore API instead of direct file access.

**Solution:**
The `MainActivity.java` has been updated to handle this automatically. Ensure you're using the latest version which includes:

1. **MediaStore API** for Android 10+ (handles scoped storage)
2. **Download notifications** with tap-to-open functionality
3. **Proper IS_PENDING flag** handling to make files visible immediately

If still not working:
- Uninstall old APK completely
- Install fresh APK
- Check phone's Downloads folder after download

---

## 🌐 Network & Connectivity Issues

### Issue 4: Mobile Web Shows "Mixed Content" Error

**Symptoms:**
- HTTPS frontend cannot connect to HTTP backend
- Console shows "Mixed Content" or "blocked:mixed-content" errors

**Root Cause:**
Vite's `basicSsl()` plugin forces HTTPS, but backend runs on HTTP.

**Solution:**

Disable HTTPS in development:

Edit: `my-react-app/vite.config.js`

Comment out the basicSsl plugin:
```javascript
export default defineConfig({
  plugins: [
    react(),
    // basicSsl(), // DISABLED: Causes Mixed Content errors with HTTP backend
    VitePWA({
      // ...
    })
  ],
  // ...
})
```

Restart the dev server:
```bash
cd my-react-app
npm run dev
```

**For Production:**
Use HTTPS for both frontend and backend, or deploy to a platform that handles SSL automatically.

---

### Issue 5: Windows Firewall Blocking Backend Server

**Symptoms:**
- Web works on same computer
- Mobile/APK cannot connect from other devices
- Connection times out

**Solution:**

**Option 1: Quick Test**
Temporarily disable Windows Firewall to confirm it's the issue.

**Option 2: Add Firewall Rule (Recommended)**

Open PowerShell as Administrator:
```powershell
New-NetFirewallRule -DisplayName "Node.js Server" -Direction Inbound -Program "C:\Program Files\nodejs\node.exe" -Action Allow -Profile Private
```

Or add a port-specific rule:
```powershell
New-NetFirewallRule -DisplayName "SuppliWise Port 5000" -Direction Inbound -LocalPort 5000 -Protocol TCP -Action Allow -Profile Private
```

**Option 3: Manual Firewall Configuration**
1. Open "Windows Defender Firewall with Advanced Security"
2. Click "Inbound Rules" → "New Rule"
3. Choose "Program" → Browse to Node.js executable
4. Allow connection → Private network only
5. Name: "Node.js Server"

---

### Issue 6: Router AP Isolation Preventing Device Communication

**Symptoms:**
- Devices are on same WiFi
- Firewall is off
- Still cannot connect between devices

**Root Cause:**
Some routers have "AP Isolation" or "Client Isolation" enabled, which prevents devices from communicating with each other.

**Solution:**
1. Open router admin panel (usually `192.168.0.1` or `192.168.1.1`)
2. Login with admin credentials
3. Look for settings named:
   - "AP Isolation"
   - "Client Isolation"
   - "Station Isolation"
   - "Wireless Isolation"
4. **Disable** this setting
5. Save and restart router if needed

---

## 🗄️ Database Issues

### Issue 7: Dashboard Welcome Message Doesn't Persist After APK Reinstall

**Symptoms:**
- Shows "Welcome, Name!" every time after reinstalling APK
- Should show "Welcome back, Name!" on subsequent visits

**Root Cause:**
Welcome message was tracked in localStorage which gets cleared when APK is uninstalled.

**Solution:**
The system now tracks first dashboard visit in the **database** (User model has `hasVisitedDashboard` field), so it persists across app reinstalls.

If you have existing users, they'll see "Welcome!" on their next visit (which marks them as visited), then "Welcome back!" after that.

---

## 🎨 UI/UX Issues

### Issue 8: Cancel Button Invisible on Light Backgrounds

**Symptoms:**
- Cancel button appears almost white
- Border not visible
- Hard to see on light backgrounds

**Solution:**
Updated in `Components/ConfirmModal/ConfirmModal.css`:
```css
.confirm-modal-btn-cancel {
  background: #e5e7eb;
  color: #374151;
  border: 2px solid #d1d5db;
}
```

Now has darker background, darker text, and visible border.

---

## 🔄 Common Development Workflow Issues

### Issue 9: Do I Need to Reinstall APK Every Time?

**No!** You only need to reinstall when:
- ✅ Frontend code changes (React components, CSS)
- ✅ Android-specific code changes (MainActivity.java, AndroidManifest.xml)
- ✅ Your computer's IP address changes

**You DON'T need to reinstall when:**
- ❌ Backend code changes (just restart Node.js server)
- ❌ Starting/stopping the development servers
- ❌ Restarting your computer (if IP stays the same)

---

### Issue 10: Changes Not Reflecting in APK

**Solution:**
Full rebuild process:
```bash
# 1. Build web assets
cd my-react-app
npm run build

# 2. Sync with Capacitor
npx cap sync android

# 3. Fix Java version (REQUIRED after every sync!)
# Edit: android/app/capacitor.build.gradle
# Change VERSION_21 to VERSION_17

# 4. Clean build APK
cd android
.\gradlew.bat clean assembleDebug

# 5. APK location:
# android/app/build/outputs/apk/debug/SuppliWise.apk
```

---

## 🚀 Quick Reference

### Starting Development Servers

**Terminal 1 - Backend:**
```bash
cd server
node index.js
```

**Terminal 2 - Frontend:**
```bash
cd my-react-app
npm run dev
```

**Access:**
- Desktop: `http://localhost:5173`
- Mobile (same WiFi): `http://YOUR_IP:5173`

### Building APK Checklist

- [ ] Update `api.js` with current IP address
- [ ] Update `network_security_config.xml` with current IP
- [ ] Run `npm run build`
- [ ] Run `npx cap sync android`
- [ ] Fix Java version in `capacitor.build.gradle` (VERSION_21 → VERSION_17)
- [ ] Run `.\gradlew.bat clean assembleDebug`
- [ ] Transfer APK to phone
- [ ] Uninstall old version
- [ ] Install new APK

### IP Address Quick Commands

**Windows:**
```cmd
ipconfig | findstr "IPv4"
```

**Mac/Linux:**
```bash
ifconfig | grep "inet "
# or
ip addr show | grep "inet "
```

---

## 📞 Still Having Issues?

1. **Check the logs:**
   - Backend: Look at terminal running `node index.js`
   - Frontend: Check browser console (F12)
   - APK: Use Chrome DevTools remote debugging

2. **Verify connectivity:**
   - Can you access `http://YOUR_IP:5000` from phone browser?
   - Can you access `http://YOUR_IP:5173` from phone browser?
   - If yes → APK issue (check network_security_config.xml)
   - If no → Network issue (check firewall, router isolation)

3. **Common debugging commands:**
   ```bash
   # Check if port 5000 is listening
   netstat -an | findstr "5000"
   
   # Test backend from phone
   # Open in phone browser: http://YOUR_IP:5000/api
   ```

---

## 🎯 Production Deployment

For production, to avoid these IP address issues:

1. **Deploy backend to a cloud service:**
   - Railway, Render, Heroku, DigitalOcean, etc.
   - Get a permanent URL like `https://suppliwise-api.railway.app`

2. **Update api.js to use production URL:**
   ```javascript
   const BASE_URL = import.meta.env.VITE_API_URL || 'https://suppliwise-api.railway.app/api';
   ```

3. **Update network_security_config.xml:**
   ```xml
   <domain-config cleartextTrafficPermitted="false">
       <domain includeSubdomains="true">suppliwise-api.railway.app</domain>
   </domain-config>
   ```

4. **Use environment variables** for different environments (development vs production)

With production deployment, these local network issues disappear! 🚀
