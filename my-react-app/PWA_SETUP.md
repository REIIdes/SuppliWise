# Progressive Web App (PWA) Setup Guide for SuppliWise

## ✅ What's Been Done

Your SuppliWise app is now a Progressive Web App! Here's what was configured:

### 1. **PWA Plugin Installed**
- `vite-plugin-pwa` - Generates service worker and manifest
- `workbox-window` - Service worker management

### 2. **Service Worker Configuration**
- Auto-updates when new content is available
- Caches static assets (JS, CSS, HTML, images)
- Caches Google Fonts
- Network-first strategy for API calls with 5-minute cache fallback
- Offline support for previously visited pages

### 3. **Web App Manifest**
- App name: SuppliWise
- Standalone display mode (looks like a native app)
- Portrait orientation for mobile devices
- Theme colors configured

### 4. **Install Prompt Component**
- Custom install banner that appears on supported browsers
- Users can install the app with one tap
- Located at: `src/components/PWAInstallPrompt.jsx`

### 5. **Mobile Meta Tags**
- Viewport configuration
- Theme color for browser UI
- Apple touch icon support

## 📱 Next Steps: Create PWA Icons

You need to create icon images for the app to be installable. Here are three methods:

### Option 1: Online Tool (EASIEST) ⭐
1. Visit [PWA Builder Image Generator](https://www.pwabuilder.com/imageGenerator)
2. Upload your SuppliWise logo (ideally 512x512px or larger)
3. Download the generated icon pack
4. Extract and copy these files to `public/` folder:
   - `pwa-192x192.png`
   - `pwa-512x512.png`
   - `apple-touch-icon.png` (180x180px)

### Option 2: Use Existing Favicon
If you have a logo file, you can manually resize it:
1. Open your logo in any image editor (Photoshop, GIMP, Paint.NET)
2. Create three PNG files with these exact sizes:
   - `pwa-192x192.png` - 192x192 pixels
   - `pwa-512x512.png` - 512x512 pixels
   - `apple-touch-icon.png` - 180x180 pixels
3. Save them in the `public/` folder

### Option 3: Use Sharp (Node.js tool)
If you have Node.js installed:
```bash
npm install --save-dev sharp
node generate-icons.js
```

## 🚀 How to Test

### Testing on Desktop (Chrome/Edge)
1. Build the app: `npm run build`
2. Preview: `npm run preview`
3. Open in Chrome/Edge
4. Look for the install icon in the address bar
5. Click to install

### Testing on Mobile
1. Deploy your app to a server with HTTPS (required for PWA)
2. Visit the site on your mobile device
3. You should see the custom install prompt
4. Tap "Install App"
5. The app will be added to your home screen

### Testing Locally on Mobile
1. Find your computer's local IP address
   - Windows: `ipconfig` (look for IPv4 Address)
   - Mac/Linux: `ifconfig` or `ip addr`
2. Make sure mobile and computer are on same WiFi
3. Update `vite.config.js` to allow external access:
   ```javascript
   server: {
     host: '0.0.0.0', // Add this line
     proxy: { ... }
   }
   ```
4. Start dev server: `npm run dev`
5. Visit `http://YOUR_IP_ADDRESS:5173` on your mobile device

**Note:** Service workers only work over HTTPS or on localhost. For mobile testing with http://, you'll need to use Chrome flags or deploy to HTTPS.

## 📋 PWA Features Enabled

✅ **Install to Home Screen** - Users can add your app to their device  
✅ **Offline Support** - Previously visited pages work without internet  
✅ **App-like Experience** - No browser UI when installed  
✅ **Auto-Updates** - App automatically updates when you deploy changes  
✅ **Fast Loading** - Assets are cached for instant loading  
✅ **Mobile Optimized** - Portrait orientation, full-screen mode  
✅ **Install Prompt** - Custom UI to encourage installation  

## 🔧 Customization Options

### Change Theme Colors
Edit `vite.config.js`:
```javascript
manifest: {
  theme_color: '#yourcolor',
  background_color: '#yourcolor',
}
```

### Adjust Cache Strategy
Edit `vite.config.js` under `workbox.runtimeCaching` to change how different resources are cached.

### Customize Install Prompt
Edit `src/components/PWAInstallPrompt.jsx` and `PWAInstallPrompt.css` to change the appearance and behavior.

## 🐛 Troubleshooting

### "Install" button doesn't appear
- Make sure you're on HTTPS or localhost
- Icons must be present in the public folder
- Try incognito/private mode
- Check browser console for errors

### Service worker not updating
- Clear site data in browser DevTools (Application tab)
- Hard refresh (Ctrl+Shift+R or Cmd+Shift+R)
- Rebuild: `npm run build`

### App not working offline
- Visit pages while online first (they need to be cached)
- Check service worker is active in DevTools > Application > Service Workers
- API calls require network (unless previously cached)

## 📚 Additional Resources

- [PWA Documentation](https://web.dev/progressive-web-apps/)
- [Vite PWA Plugin Docs](https://vite-pwa-org.netlify.app/)
- [Workbox Documentation](https://developers.google.com/web/tools/workbox)

## 🎯 Deployment Checklist

Before deploying to production:
- [ ] Create all required icon files (192x192, 512x512, 180x180)
- [ ] Test install on Chrome desktop
- [ ] Test install on mobile (iOS Safari, Android Chrome)
- [ ] Verify offline functionality
- [ ] Check service worker updates correctly
- [ ] Ensure HTTPS is enabled on your hosting
- [ ] Test on slow network connection
- [ ] Verify API caching works as expected

## 🌐 Deployment Platforms with HTTPS

Your PWA will work on any of these platforms (all provide HTTPS by default):
- **Vercel** - `npm run build` then deploy
- **Netlify** - Connect GitHub repo for auto-deploy
- **Firebase Hosting** - `firebase deploy`
- **GitHub Pages** - Enable in repo settings
- **Railway** - Container-based deployment
- **Render** - Free tier available

---

**Ready to go mobile!** 📱✨

Once you add the icons, rebuild the app (`npm run build`) and your PWA will be fully functional!
