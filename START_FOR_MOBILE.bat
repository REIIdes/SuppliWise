@echo off
echo ========================================
echo   Starting SuppliWise for Mobile Access
echo ========================================
echo.
echo Your IP Address: 192.168.0.102
echo.
echo Open on your phone: http://192.168.0.102:5173
echo (Make sure phone is on same WiFi!)
echo.
echo Starting servers...
echo.

REM Start backend server in new window
start "SuppliWise Backend" cmd /k "cd server && node index.js"

REM Wait a moment for backend to start
timeout /t 3 /nobreak >nul

REM Start frontend server in new window
start "SuppliWise Frontend" cmd /k "cd my-react-app && npm run dev"

echo.
echo ========================================
echo Both servers are starting!
echo ========================================
echo Backend: http://localhost:5000
echo Frontend: http://192.168.0.102:5173
echo.
echo On your phone, open: http://192.168.0.102:5173
echo ========================================
echo.
pause
