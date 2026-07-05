# 📱 Open SuppliWise on Your Phone

## Your Computer's IP Address: `192.168.0.102`

## Steps:

### 1️⃣ Start Both Servers

**Terminal 1 - Start Backend:**
```bash
cd server
node server.js
```

**Terminal 2 - Start Frontend:**
```bash
cd my-react-app
npm run dev
```

### 2️⃣ On Your Phone

Make sure your phone is on the **same WiFi network** as your computer!

**Then open in your phone's browser:**
```
http://192.168.0.102:5173
```

### 3️⃣ That's It!

The app should load on your phone. You can now:
- Browse around
- Test the mobile interface
- See the "Install SuppliWise" banner (on Chrome/Edge)
- Tap to install it to your home screen

---

## ⚠️ Important Notes:

1. **Both servers must be running** (backend on port 5000, frontend on port 5173)
2. **Same WiFi required** - Phone and computer on same network
3. **Service Worker limitations** - Full PWA features (offline mode) only work over HTTPS, but you can still install it and test most features

## 🔒 For Full PWA Features (Install, Offline, etc.):

You'll need to deploy to a platform with HTTPS (see QUICK_START_PWA.md for options like Vercel, Netlify, etc.)

But for testing the mobile interface, this works perfectly! 🎉
