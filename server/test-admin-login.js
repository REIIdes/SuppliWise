#!/usr/bin/env node
/**
 * Test script to verify admin login configuration
 * Run with: node test-admin-login.js
 */

require('dotenv').config();
const { configuredAdminAccounts } = require('./utils/adminAccounts');
const { verifyPassword } = require('./utils/password');

async function testAdminLogin() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('   SUPPLIWISE ADMIN LOGIN CONFIGURATION TEST');
  console.log('═══════════════════════════════════════════════════════\n');

  // Load accounts
  const accounts = configuredAdminAccounts();
  
  if (accounts.length === 0) {
    console.error('❌ ERROR: No admin accounts configured!');
    console.error('   Check ADMIN_ACCOUNTS in server/.env\n');
    process.exit(1);
  }

  console.log(`✅ Found ${accounts.length} admin account(s)\n`);

  // Test each account structure
  let allValid = true;
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    console.log(`${i + 1}. Testing ${account.alias}...`);
    
    // Check alias
    if (!account.alias || account.alias.trim() === '') {
      console.log(`   ❌ Missing alias`);
      allValid = false;
      continue;
    }
    console.log(`   ✓ Alias: ${account.alias}`);

    // Check password hash
    if (!account.passwordHash || account.passwordHash.trim() === '') {
      console.log(`   ❌ Missing password hash`);
      allValid = false;
      continue;
    }
    
    // Verify hash format
    if (account.passwordHash.startsWith('$argon2id$')) {
      console.log(`   ✓ Password hash: Argon2id (secure)`);
    } else if (account.passwordHash.startsWith('$2')) {
      console.log(`   ⚠ Password hash: bcrypt (legacy, will auto-upgrade)`);
    } else {
      console.log(`   ❌ Password hash: Unknown format`);
      allValid = false;
    }

    // Check TOTP secret
    if (!account.totpSecret || account.totpSecret.trim() === '') {
      console.log(`   ❌ Missing TOTP secret`);
      allValid = false;
      continue;
    }
    
    if (account.totpSecret.length >= 16) {
      console.log(`   ✓ TOTP secret: ${account.totpSecret.substring(0, 8)}... (${account.totpSecret.length} chars)`);
    } else {
      console.log(`   ⚠ TOTP secret too short: ${account.totpSecret.length} chars`);
    }

    console.log('');
  }

  // Test AdminPoli specifically with password Poli101
  console.log('═══════════════════════════════════════════════════════');
  console.log('   TESTING AdminPoli WITH PASSWORD: Poli101');
  console.log('═══════════════════════════════════════════════════════\n');

  const adminPoli = accounts.find(a => a.alias === 'AdminPoli');
  if (!adminPoli) {
    console.log('❌ AdminPoli not found in accounts list\n');
    allValid = false;
  } else {
    console.log('Testing password verification...');
    try {
      const isValid = await verifyPassword('Poli101', adminPoli.passwordHash);
      if (isValid) {
        console.log('✅ Password "Poli101" VERIFIED successfully!\n');
      } else {
        console.log('❌ Password "Poli101" FAILED verification\n');
        allValid = false;
      }
    } catch (error) {
      console.log(`❌ Error during verification: ${error.message}\n`);
      allValid = false;
    }
  }

  // Final summary
  console.log('═══════════════════════════════════════════════════════');
  console.log('   SUMMARY');
  console.log('═══════════════════════════════════════════════════════\n');

  if (allValid) {
    console.log('✅ ALL TESTS PASSED');
    console.log('✅ Admin login is properly configured');
    console.log('✅ Ready to start the server\n');
    console.log('Next steps:');
    console.log('1. Setup authenticator apps using: all-admins-totp-setup.html');
    console.log('2. Start server: npm start');
    console.log('3. Login at: /admin/login');
    console.log('4. Use AdminPoli with password: Poli101\n');
    process.exit(0);
  } else {
    console.log('❌ SOME TESTS FAILED');
    console.log('❌ Please fix the errors above before starting the server\n');
    process.exit(1);
  }
}

// Run tests
testAdminLogin().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
