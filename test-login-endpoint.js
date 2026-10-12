// Test script to verify login endpoint returns OTP requirement
// Run: node test-login-endpoint.js
//
// Uses the same loopback-origin helper as the server, so it follows HTTPS when
// TLS is enabled instead of hard-coding a dead http://localhost:5000 URL.
require('./server/utils/envFile').reloadFromDisk();
const tls = require('./server/utils/tls');

console.log('🧪 Testing Login Endpoint...\n');

// Replace these with your actual test credentials
const TEST_EMAIL = 'test@example.com'; // <-- CHANGE THIS
const TEST_PASSWORD = 'YourPassword123'; // <-- CHANGE THIS

async function testLogin() {
  try {
    const loginUrl = `${process.env.API_ORIGIN || tls.loopbackOrigin()}/api/auth/login`;
    console.log(`📤 Sending login request to ${loginUrl}`);
    console.log(`   Email: ${TEST_EMAIL}`);
    console.log(`   Password: ${'*'.repeat(TEST_PASSWORD.length)}\n`);

    const response = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      }),
    });

    const data = await response.json();

    console.log(`📥 Response Status: ${response.status}`);
    console.log(`📥 Response Data:`, JSON.stringify(data, null, 2));
    console.log('');

    // Analyze response
    if (data.requiresOtp === true) {
      console.log('✅ SUCCESS! Login endpoint requires OTP');
      console.log(`   User ID: ${data.userId}`);
      console.log(`   Message: ${data.message}`);
      if (data.otp) {
        console.log(`   🔑 Development OTP: ${data.otp}`);
      }
    } else if (data.token) {
      console.log('❌ PROBLEM! Login endpoint returned token directly (no OTP)');
      console.log('   This means the server is still using OLD code');
      console.log('   ⚠️  ACTION: Restart your backend server!');
    } else if (response.status === 401) {
      console.log('⚠️  Invalid credentials - please update TEST_EMAIL and TEST_PASSWORD in this script');
    } else {
      console.log('❓ Unexpected response - check data above');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('\n⚠️  Make sure:');
    console.log('   1. Backend server is running (npm start in server folder)');
    console.log(`   2. API origin is reachable at ${process.env.API_ORIGIN || tls.loopbackOrigin()}`);
    console.log('   3. You have a valid test user account');
  }
}

// Run test
console.log('=' .repeat(60));
testLogin().then(() => {
  console.log('=' .repeat(60));
  console.log('\n💡 Next Steps:');
  console.log('   - If test FAILED: Restart backend server');
  console.log('   - If test PASSED: Check browser console for errors');
  console.log('   - Clear browser cache and try login again\n');
});
