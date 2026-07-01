require('dotenv').config();
const { sendOtpEmail } = require('./utils/email');

console.log('Testing email configuration...');
console.log('EMAIL_SERVICE:', process.env.EMAIL_SERVICE);
console.log('EMAIL_USER:', process.env.EMAIL_USER);
console.log('EMAIL_PASSWORD:', process.env.EMAIL_PASSWORD ? '***configured***' : 'NOT SET');

// Test sending OTP
const testEmail = 'lunarei001017@gmail.com'; // The email you're trying to use
const testOtp = '123456';

console.log(`\nSending test OTP to ${testEmail}...`);

sendOtpEmail(testEmail, testOtp, 'email-change')
  .then((result) => {
    console.log('Email send result:', result);
    if (result) {
      console.log('✅ SUCCESS! Email sent. Check your inbox (and spam folder).');
    } else {
      console.log('❌ FAILED! Check the error messages above.');
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  });
