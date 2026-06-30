// Quick diagnostic script to verify Login OTP setup
// Run: node check-otp-setup.js

const fs = require('fs');
const path = require('path');

console.log('🔍 Checking Login OTP Implementation...\n');

let allGood = true;

// Check 1: Backend auth.js has new OTP code
console.log('1️⃣  Checking server/routes/auth.js...');
const authPath = path.join(__dirname, 'server', 'routes', 'auth.js');
if (fs.existsSync(authPath)) {
  const authContent = fs.readFileSync(authPath, 'utf8');
  
  const hasVerifyEndpoint = authContent.includes('verify-login-otp');
  const hasResendEndpoint = authContent.includes('resend-login-otp');
  const hasRequiresOtp = authContent.includes('requiresOtp: true');
  
  if (hasVerifyEndpoint && hasResendEndpoint && hasRequiresOtp) {
    console.log('   ✅ Backend OTP endpoints found');
  } else {
    console.log('   ❌ Backend missing OTP code');
    if (!hasVerifyEndpoint) console.log('      - Missing verify-login-otp endpoint');
    if (!hasResendEndpoint) console.log('      - Missing resend-login-otp endpoint');
    if (!hasRequiresOtp) console.log('      - Missing requiresOtp: true response');
    allGood = false;
  }
} else {
  console.log('   ❌ server/routes/auth.js not found');
  allGood = false;
}

// Check 2: Frontend LogIn.jsx has OTP modal
console.log('\n2️⃣  Checking my-react-app/src/Pages/LogIn.jsx...');
const loginPath = path.join(__dirname, 'my-react-app', 'src', 'Pages', 'LogIn.jsx');
if (fs.existsSync(loginPath)) {
  const loginContent = fs.readFileSync(loginPath, 'utf8');
  
  const hasOtpModal = loginContent.includes('showOtpModal');
  const hasVerifyFunction = loginContent.includes('handleOtpSubmit');
  const hasResendFunction = loginContent.includes('handleResendOtp');
  
  if (hasOtpModal && hasVerifyFunction && hasResendFunction) {
    console.log('   ✅ Frontend OTP modal code found');
  } else {
    console.log('   ❌ Frontend missing OTP code');
    if (!hasOtpModal) console.log('      - Missing showOtpModal state');
    if (!hasVerifyFunction) console.log('      - Missing handleOtpSubmit function');
    if (!hasResendFunction) console.log('      - Missing handleResendOtp function');
    allGood = false;
  }
} else {
  console.log('   ❌ my-react-app/src/Pages/LogIn.jsx not found');
  allGood = false;
}

// Check 3: Email utility has login support
console.log('\n3️⃣  Checking server/utils/email.js...');
const emailPath = path.join(__dirname, 'server', 'utils', 'email.js');
if (fs.existsSync(emailPath)) {
  const emailContent = fs.readFileSync(emailPath, 'utf8');
  
  const hasTypeParameter = emailContent.includes("type = 'email-change'") || emailContent.includes('type === \'login\'');
  const hasLoginTemplate = emailContent.includes('Login Verification') || emailContent.includes('login');
  
  if (hasTypeParameter && hasLoginTemplate) {
    console.log('   ✅ Email template supports login OTP');
  } else {
    console.log('   ⚠️  Email template may need update');
    if (!hasTypeParameter) console.log('      - Missing type parameter');
    if (!hasLoginTemplate) console.log('      - Missing login template');
  }
} else {
  console.log('   ❌ server/utils/email.js not found');
  allGood = false;
}

// Check 4: Environment variables
console.log('\n4️⃣  Checking server/.env configuration...');
const envPath = path.join(__dirname, 'server', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  
  const hasEmailUser = envContent.includes('EMAIL_USER=');
  const hasEmailPassword = envContent.includes('EMAIL_PASSWORD=');
  const hasEmailService = envContent.includes('EMAIL_SERVICE=');
  
  if (hasEmailUser && hasEmailPassword && hasEmailService) {
    console.log('   ✅ Email configuration found in .env');
  } else {
    console.log('   ⚠️  Email configuration incomplete');
    if (!hasEmailUser) console.log('      - Missing EMAIL_USER');
    if (!hasEmailPassword) console.log('      - Missing EMAIL_PASSWORD');
    if (!hasEmailService) console.log('      - Missing EMAIL_SERVICE');
  }
} else {
  console.log('   ⚠️  server/.env not found (may not be committed)');
}

// Final summary
console.log('\n' + '='.repeat(50));
if (allGood) {
  console.log('✅ ALL CHECKS PASSED!');
  console.log('\n📋 Next Steps:');
  console.log('   1. Restart your backend server:');
  console.log('      cd server && npm start');
  console.log('   2. Restart your frontend:');
  console.log('      cd my-react-app && npm run dev');
  console.log('   3. Clear browser cache (Ctrl+Shift+R)');
  console.log('   4. Try logging in at http://localhost:5173/login');
  console.log('   5. OTP modal should appear!');
} else {
  console.log('❌ SOME CHECKS FAILED');
  console.log('\n📋 Action Required:');
  console.log('   - Review failed checks above');
  console.log('   - Re-apply the Login OTP changes');
  console.log('   - Restart servers after fixing');
}
console.log('='.repeat(50));

// Additional debug info
console.log('\n🔧 Debug Info:');
console.log(`   Working Directory: ${__dirname}`);
console.log(`   Node Version: ${process.version}`);
console.log(`   Platform: ${process.platform}`);
