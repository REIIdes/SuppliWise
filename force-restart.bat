@echo off
echo ========================================
echo  Force Restart - Kill All Node Processes
echo ========================================
echo.

echo Step 1: Killing all Node.js processes...
taskkill /F /IM node.exe 2>nul
if %ERRORLEVEL% EQU 0 (
    echo    [OK] Node processes killed
) else (
    echo    [INFO] No Node processes running
)

echo.
echo Step 2: Waiting 3 seconds...
timeout /t 3 /nobreak > nul

echo.
echo Step 3: Starting Backend Server...
cd /d "%~dp0server"
start "SuppliWise Backend" cmd /k "echo Backend Server Starting... & npm run dev"

echo.
echo Step 4: Waiting 5 seconds for backend to start...
timeout /t 5 /nobreak > nul

echo.
echo Step 5: Starting Frontend...
cd /d "%~dp0my-react-app"
start "SuppliWise Frontend" cmd /k "echo Frontend Starting... & npm run dev"

echo.
echo Step 6: Waiting 5 seconds for frontend to start...
timeout /t 5 /nobreak > nul

echo.
echo ========================================
echo  Servers should now be running!
echo ========================================
echo.
echo  Backend: http://localhost:5000
echo  Frontend: http://localhost:5173
echo.
echo Opening browser in 3 seconds...
timeout /t 3 /nobreak > nul

start http://localhost:5173/login

echo.
echo Done! Check the two new console windows.
echo Press any key to close this window...
pause > nul
