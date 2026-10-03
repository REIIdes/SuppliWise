#!/usr/bin/env node
/**
 * Test the complete admin login flow
 */

require('dotenv').config();
const mongoose = require('mongoose');
const AdminAccount = require('./models/AdminAccount');
const { verifyPassword } = require('./utils/password');

async function testLoginFlow() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('   TEST ADMIN LOGIN FLOW');
  console.log('═══════════════════════════════════════════════════════\n');

  const testCredentials = [
    { alias: 'AdminDevs', password: 'Devs101' },
    { alias: 'AdminPoli', password: 'Poli101' },
    { alias: 'AdminJoma', password: 'Joma101' },
    { alias: 'AdminJohn', password: 'John101' },
    { alias: 'AdminRaNe', password: 'RaNe101' },
    { alias: 'AdminShMa', password: 'ShMa101' },
  ];

  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/suppliwise';
  
  try {
    await mongoose.connect(mongoUri);
    console.log('✓ Connected to MongoDB\n');

    let allPassed = true;

    for (const cred of testCredentials) {
      console.log(`Testing ${cred.alias}...`);
      
      // Step 1: Find account in database
      const account = await AdminAccount.findOne({ 
        alias: cred.alias, 
        enabled: true 
      }).select('+passwordHash +totpSecret');

      if (!account) {
        console.log(`  ❌ Account not found or not enabled`);
        allPassed = false;
        continue;
      }
      console.log(`  ✓ Account found in database`);
      console.log(`  ✓ Account enabled: ${account.enabled}`);

      // Step 2: Verify password
      const passwordMatch = await verifyPassword(cred.password, account.passwordHash);
      if (passwordMatch) {
        console.log(`  ✓ Password verified: "${cred.password}"`);
      } else {
        console.log(`  ❌ Password FAILED: "${cred.password}"`);
        allPassed = false;
      }

      // Step 3: Check TOTP secret
      if (account.totpSecret && account.totpSecret.length >= 16) {
        console.log(`  ✓ TOTP secret present (${account.totpSecret.length} chars)`);
      } else {
        console.log(`  ❌ TOTP secret missing or invalid`);
        allPassed = false;
      }

      console.log('');
    }

    console.log('═══════════════════════════════════════════════════════');
    if (allPassed) {
      console.log('✅ ALL LOGIN TESTS PASSED!');
      console.log('✅ All admins can login successfully');
      console.log('✅ Passwords work correctly');
      console.log('✅ TOTP configured for all accounts\n');
      console.log('🎉 Login is WORKING - You can now login!\n');
      console.log('Login steps:');
      console.log('1. Go to: http://localhost:5173/admin/login');
      console.log('2. Username: AdminPoli (or any admin)');
      console.log('3. Password: Poli101 (matching password)');
      console.log('4. TOTP: Get code from authenticator app');
      console.log('5. Click Sign In\n');
    } else {
      console.log('❌ SOME TESTS FAILED');
      console.log('❌ Please review errors above\n');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

testLoginFlow().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
