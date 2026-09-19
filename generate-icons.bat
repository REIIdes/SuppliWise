@echo off
cd /d "C:\Users\Techian\Downloads\SuppliWise-main\SuppliWise-main\my-react-app"
echo Generating SuppliWise icons...
node generate-android-icons.cjs
echo.
echo Done! Now run build-apk.bat to rebuild the APK with the new icons.
pause
