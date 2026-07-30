# 📱 SuppliWise PWA Installation Guide

## What is a PWA (Progressive Web App)?

A Progressive Web App allows SuppliWise to be installed on your phone like a native app. Once installed:
- ✅ Opens in full screen (no browser UI, URL bars, etc.)
- ✅ Has its own app icon on your home screen
- ✅ Works offline with cached content
- ✅ Faster loading times
- ✅ Native app-like experience

---

## 🚀 Quick Setup

### 1. Build the PWA
First, make sure your development server is running and accessible on your network:

```bash
# From the my-react-app directory
npm run dev
```

The app should be accessible at `http://192.168.0.102:5173` from your phone.

### 2. Install on Your Phone

#### For Android (Chrome/Edge):

1. **Open the app** in Chrome or Edge browser at `http://192.168.0.102:5173`

2. **Wait for the install prompt** - After a few seconds, you'll see a green banner at the bottom:
   ```
   Install SuppliWise
   Get quick access and work offline anytime
   [Install App] [×]
   ```

3. **Tap "Install App"** - This will trigger the native install dialog

4. **Confirm installation** - Tap "Install" in the browser's native dialog

5. **App installed!** - SuppliWise icon will appear on your home screen

**Alternative method:**
- Tap the menu (⋮) in Chrome
- Select "Add to Home screen" or "Install app"
- Confirm the installation

#### For iOS (Safari):

Unfortunately, iOS Safari has limited PWA support. However, you can still add it to your home screen:

1. Open Safari and go to `http://192.168.0.102:5173`
2. Tap the **Share** button (box with arrow pointing up)
3. Scroll down and tap **"Add to Home Screen"**
4. Customize the name if desired
5. Tap **"Add"**

**Note:** On iOS, PWAs have limitations:
- No service worker support (limited offline functionality)
- No install prompt banner
- Some features may be restricted

---

## 🎨 PWA Features

### App Manifest
The app includes a complete manifest (`manifest.json`) with:
- **Name:** SuppliWise - Supplement Guidance
- **Theme Color:** Green (#22c55e)
- **Background:** Light green (#f0faf0)
- **Icons:** 192x192, 512x512, and Apple touch icon
- **Display:** Standalone (full screen, no browser UI)
- **Orientation:** Portrait-primary
- **Shortcuts:** Quick links to Dashboard and New Assessment

### Service Worker
The service worker (`sw.js`) provides:
- **Offline support** - Cached pages work without internet
- **Fast loading** - Assets cached for instant access
- **Network-first strategy** - Always tries to get fresh data
- **Auto-updates** - Service worker updates automatically

### Install Prompt
Custom install prompt with:
- SuppliWise branding (green gradient, logo)
- Smart timing (appears after 3 seconds)
- Dismissible (remembers dismissal for 7 days)
- Detects if already installed
- Only shows if browser supports installation

---

## 🔧 Development vs Production

### Current Setup (Development)
- Accessing via `http://192.168.0.102:5173`
- PWA features enabled in development mode
- Service worker registers but may have limited offline features
- Perfect for testing on your local network

### For Production Deployment

When you're ready to deploy SuppliWise publicly:

1. **Build the production version:**
   ```bash
   cd my-react-app
   npm run build
   ```

2. **Deploy the `dist` folder** to a hosting service:
   - **Vercel** (recommended for Vite apps)
   - **Netlify**
   - **GitHub Pages**
   - **AWS S3 + CloudFront**
   - **Firebase Hosting**

3. **Requirements for PWA to work:**
   - ✅ Must be served over HTTPS (required for service workers)
   - ✅ Must have valid SSL certificate
   - ✅ manifest.json must be accessible
   - ✅ Service worker must be at root scope

4. **Update your backend URL:**
   In `my-react-app/src/api.js`, update the base URL from:
   ```javascript
   const API_BASE = 'http://localhost:5000/api';
   ```
   to your production backend URL:
   ```javascript
   const API_BASE = 'https://your-backend.com/api';
   ```

---

## 📱 Testing the PWA

### Check PWA Readiness

1. **Chrome DevTools (Desktop):**
   - Open your app in Chrome
   - Press F12 to open DevTools
   - Go to "Application" tab
   - Check "Manifest" section - should show all details
   - Check "Service Workers" section - should show registered worker
   - Use "Lighthouse" tab → run "Progressive Web App" audit

2. **Mobile Testing:**
   - Open `http://192.168.0.102:5173` on your phone
   - Check that install prompt appears
   - Install the app
   - Verify it opens full screen without browser UI
   - Test offline by turning off WiFi (limited features)

### Common Issues

**Install prompt doesn't appear:**
- Check console for errors
- Ensure manifest.json is loaded (check Network tab)
- Make sure service worker registered successfully
- Some browsers require HTTPS (not http://)
- Try clearing browser data and reloading

**App doesn't work offline:**
- Service workers require HTTPS in production
- Development mode has limited offline support
- Check that service worker is active (DevTools → Application)

**Icons don't show:**
- Verify icon files exist in `public` folder
- Check manifest.json paths are correct
- Clear cache and reinstall

---

## 🎯 What Happens After Installation

Once installed:

1. **Home Screen Icon:** SuppliWise appears on your home screen with the green logo

2. **Full Screen Launch:** Opens without browser UI (no URL bar, no navigation buttons)

3. **Splash Screen:** Shows SuppliWise logo and green background while loading

4. **App Shortcuts:** Long-press the icon to see quick actions:
   - Dashboard
   - New Assessment

5. **Offline Support:** Previously visited pages work without internet (limited)

6. **Auto Updates:** Service worker updates automatically when you release new versions

---

## 🔄 Updating the PWA

When you make changes:

1. **Development:** Just refresh the page (Ctrl+R or ⌘+R)

2. **Production:** 
   - Build and deploy new version
   - Service worker detects changes
   - Users get update prompt on next visit
   - Alternatively, hard refresh clears cache

---

## 🗑️ Uninstalling the PWA

### Android:
- Long-press the SuppliWise icon
- Select "Uninstall" or drag to "Remove"

### iOS:
- Long-press the SuppliWise icon
- Select "Remove App" → "Delete App"

---

## 📊 PWA vs Native App

| Feature | SuppliWise PWA | Native App |
|---------|---------------|------------|
| Installation | One-tap from browser | App store download |
| Updates | Automatic, instant | Manual from store |
| Storage | Browser storage | Device storage |
| Offline | Limited (cached pages) | Full offline support |
| Push Notifications | ✅ (Android), ❌ (iOS) | ✅ Both |
| File Access | Limited | Full access |
| Size | ~5-10 MB | 20-100+ MB |
| Development | One codebase | Multiple (iOS/Android) |

---

## 🎉 You're All Set!

Your SuppliWise PWA is now ready to install and use like a native app. Enjoy the seamless mobile experience!

Need help? Check the browser console for errors or verify that all files in the checklist below are present.

### PWA Files Checklist:
- ✅ `index.html` - PWA meta tags
- ✅ `manifest.json` - App manifest
- ✅ `sw.js` - Service worker
- ✅ `vite.config.js` - PWA plugin configured
- ✅ `main.jsx` - Service worker registration
- ✅ `PWAInstallPrompt.jsx` - Custom install prompt
- ✅ Icon files: `pwa-192x192.png`, `pwa-512x512.png`, `apple-touch-icon.png`
