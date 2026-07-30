# 📱 Build SuppliWise APK

## ✅ Setup Complete!

I've configured your app with Capacitor. Now you need Android Studio to build the APK.

---

## 🔧 Prerequisites

### 1. Install Android Studio
- Download: https://developer.android.com/studio
- Install with default settings
- Make sure to install Android SDK during installation

### 2. Open Android Studio
- Launch Android Studio
- Wait for it to finish loading

---

## 📦 Build the APK

### Method 1: Using Android Studio (Recommended)

1. **Open the project in Android Studio:**
   ```bash
   npx cap open android
   ```
   This will open Android Studio with your SuppliWise project

2. **Wait for Gradle sync:**
   - Android Studio will sync Gradle files
   - This may take 2-5 minutes the first time
   - Wait for "Gradle sync finished" message

3. **Build the APK:**
   - Menu → Build → Build Bundle(s) / APK(s) → Build APK(s)
   - Wait for build to complete (1-3 minutes)
   - You'll see a notification: "APK(s) generated successfully"

4. **Find your APK:**
   - Click "locate" in the notification, or
   - Navigate to: `my-react-app\android\app\build\outputs\apk\debug\app-debug.apk`

5. **Install on your phone:**
   - Copy `app-debug.apk` to your phone
   - Tap to install
   - Enable "Install from unknown sources" if prompted

---

### Method 2: Command Line (If Android Studio is configured)

```bash
cd android
./gradlew assembleDebug
```

APK will be at: `android\app\build\outputs\apk\debug\app-debug.apk`

---

## 📱 Install APK on Phone

### Option A: Direct Transfer
1. Connect phone to PC via USB
2. Copy `app-debug.apk` to your phone
3. On phone: tap the APK file
4. Tap "Install"
5. Open SuppliWise!

### Option B: ADB Install
```bash
adb install android\app\build\outputs\apk\debug\app-debug.apk
```

### Option C: Upload to Drive/Dropbox
1. Upload APK to Google Drive or Dropbox
2. Download on phone
3. Install

---

## ⚙️ Important: Backend Server

**The APK connects to your backend at `http://192.168.0.102:5000`**

For the app to work:
1. Your backend must be running: `node server.js`
2. Phone must be on same WiFi network
3. Or update `src/api.js` to point to a public server URL

---

## 🎨 App Features

✅ Native Android app (no browser UI)
✅ Full screen experience
✅ Installable APK
✅ Home screen icon
✅ Works like any other Android app
✅ All SuppliWise features included

---

## 🔄 Update the App

When you make changes:

1. **Update code in React**
2. **Build web assets:**
   ```bash
   npm run build
   ```
3. **Sync to Android:**
   ```bash
   npx cap sync android
   ```
4. **Build new APK:**
   - Open Android Studio: `npx cap open android`
   - Build → Build APK(s)

---

## 📝 Quick Commands Reference

```bash
# Build web assets
npm run build

# Sync to Android
npx cap sync android

# Open in Android Studio
npx cap open android

# Full rebuild flow
npm run build && npx cap sync android && npx cap open android
```

---

## 🐛 Troubleshooting

**"Android Studio not installed"**
- Download from https://developer.android.com/studio
- Install with default settings

**"Gradle sync failed"**
- Wait and try again (Gradle downloads dependencies)
- Check internet connection
- In Android Studio: File → Invalidate Caches → Restart

**"APK won't install"**
- Enable "Install from unknown sources" in phone settings
- Check file isn't corrupted
- Try different transfer method

**"App can't connect to backend"**
- Make sure backend is running (`node server.js`)
- Check phone is on same WiFi
- Verify IP address is correct (192.168.0.102)

---

## 🚀 Next Steps

1. Install Android Studio
2. Run: `npx cap open android`
3. Build → Build APK(s)
4. Install on your phone
5. Enjoy SuppliWise as a native app!

---

**Your app is ready to be built!** 🎉

Just install Android Studio and run `npx cap open android` to get started.
