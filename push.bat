@echo off
cd /d "C:\Users\Techian\Downloads\SuppliWise-main\SuppliWise-main"
git add server/index.js
git commit -m "fix: Bind server to 0.0.0.0 to allow connections from phone/APK

app.listen(PORT) alone can bind to localhost only on some systems,
blocking requests from other devices on the same network.
Explicitly binding to 0.0.0.0 makes the server reachable from
the Android APK and any device on the same WiFi network."
git push origin main
echo.
echo Done! Now run build-apk.bat to rebuild the APK.
pause
