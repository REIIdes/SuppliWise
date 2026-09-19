@echo off
echo ============================================
echo  SuppliWise APK Builder
echo ============================================
echo.

:: Add common JDK 17 install paths to PATH
set "PATH=%PATH%;C:\Program Files\Eclipse Adoptium\jdk-17.0.14.7-hotspot\bin"
set "PATH=%PATH%;C:\Program Files\Java\jdk-17\bin"
set "PATH=%PATH%;C:\Program Files\Microsoft\jdk-17.0.14.7-hotspot\bin"
set "PATH=%PATH%;C:\Program Files\Eclipse Adoptium\jdk-17\bin"

:: Find actual java.exe anywhere under Program Files
for /f "delims=" %%i in ('dir /s /b "C:\Program Files\*java.exe" 2^>nul ^| findstr /i "jdk-17"') do (
    set "JAVA_EXE=%%i"
    goto :found_java
)
for /f "delims=" %%i in ('dir /s /b "C:\Program Files\*java.exe" 2^>nul ^| findstr /i "jdk"') do (
    set "JAVA_EXE=%%i"
    goto :found_java
)

:no_java
echo X Java not found!
echo.
echo Please install JDK 17 from:
echo https://adoptium.net/temurin/releases/?version=17
pause
exit /b 1

:found_java
echo Found Java at: %JAVA_EXE%
for %%i in ("%JAVA_EXE%") do set "JAVA_BIN=%%~dpi"
set "PATH=%JAVA_BIN%;%PATH%"
java -version
echo.

:: Auto-detect current WiFi IP (skip VirtualBox/VMware adapters)
echo Detecting local WiFi IP...
set "LOCAL_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /r "IPv4.*192\.168\."') do (
    for /f "tokens=1" %%b in ("%%a") do (
        set "CANDIDATE=%%b"
        :: Skip 192.168.56.x (VirtualBox) and 192.168.0.x VMware ranges
        echo %%b | findstr /v "192.168.56" >nul && (
            set "LOCAL_IP=%%b"
            goto :ip_found
        )
    )
)
:: Fallback: take any 192.168 IP if WiFi one not found
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /r "IPv4.*192\.168\."') do (
    for /f "tokens=1" %%b in ("%%a") do set "LOCAL_IP=%%b"
    goto :ip_found
)
:ip_found
if not defined LOCAL_IP (
    echo WARNING: Could not auto-detect IP, using fallback 192.168.1.166
    set "LOCAL_IP=192.168.1.166"
)
echo Detected WiFi IP: %LOCAL_IP%
echo VITE_SERVER_IP=%LOCAL_IP% > "C:\Users\Techian\Downloads\SuppliWise-main\SuppliWise-main\my-react-app\.env.local"
echo.

cd /d "C:\Users\Techian\Downloads\SuppliWise-main\SuppliWise-main\my-react-app"

:: Step 0 - Generate app icons
echo [0/4] Generating app icons...
call node generate-android-icons.cjs
if %errorlevel% neq 0 (
    echo WARNING: Icon generation failed ^(sharp may not be installed^), continuing with existing icons...
)
echo.

:: Step 1 - Build web app
echo [1/4] Building web app...
call npm run build
if %errorlevel% neq 0 (
    echo X npm run build failed
    pause
    exit /b 1
)
echo [OK] Web build done
echo.

:: Step 2 - Sync Capacitor
echo [2/4] Syncing Capacitor to Android...
call npx cap sync android
if %errorlevel% neq 0 (
    echo X cap sync failed
    pause
    exit /b 1
)
echo [OK] Capacitor sync done
echo.

:: Step 3 - Fix Java version in ALL gradle files
echo [3/4] Fixing Java version (VERSION_21 to VERSION_17)...
set "GRADLE_FILE=C:\Users\Techian\Downloads\SuppliWise-main\SuppliWise-main\my-react-app\android\app\capacitor.build.gradle"
powershell -Command "(Get-Content '%GRADLE_FILE%') -replace 'VERSION_21', 'VERSION_17' | Set-Content '%GRADLE_FILE%'"

set "CAP_GRADLE=C:\Users\Techian\Downloads\SuppliWise-main\SuppliWise-main\my-react-app\node_modules\@capacitor\android\capacitor\build.gradle"
powershell -Command "(Get-Content '%CAP_GRADLE%') -replace 'VERSION_21', 'VERSION_17' | Set-Content '%CAP_GRADLE%'"

set "PROPS_FILE=C:\Users\Techian\Downloads\SuppliWise-main\SuppliWise-main\my-react-app\android\gradle.properties"
for /f "delims=" %%i in ('dir /s /b "C:\Program Files\Eclipse Adoptium\*java.exe" 2^>nul') do (
    for %%j in ("%%~dpi..") do set "ACTUAL_JDK=%%~fj"
    goto :fix_props
)
:fix_props
if defined ACTUAL_JDK (
    powershell -Command "(Get-Content '%PROPS_FILE%') -replace 'org\.gradle\.java\.home=.*', ('org.gradle.java.home=' + '%ACTUAL_JDK%'.Replace('\','\\')) | Set-Content '%PROPS_FILE%'"
)
echo [OK] Java version fixed
echo.

:: Step 4 - Build APK
echo [4/4] Building APK (this may take a few minutes)...
cd /d "C:\Users\Techian\Downloads\SuppliWise-main\SuppliWise-main\my-react-app\android"
set "JAVA_HOME=%JAVA_BIN%.."
call gradlew.bat assembleDebug
if %errorlevel% neq 0 (
    echo X APK build failed
    pause
    exit /b 1
)

echo.
echo ============================================
echo [OK] APK built successfully!
echo.
echo APK location:
echo C:\Users\Techian\Downloads\SuppliWise-main\SuppliWise-main\my-react-app\android\app\build\outputs\apk\debug\SuppliWise.apk
echo.
echo Server IP in this APK: %LOCAL_IP%
echo Make sure your server is running and phone is on the same WiFi.
echo ============================================

:: Clean up temp .env.local
del "C:\Users\Techian\Downloads\SuppliWise-main\SuppliWise-main\my-react-app\.env.local" >nul 2>&1
pause
