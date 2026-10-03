#!/usr/bin/env node
/**
 * Manually seed admin accounts from .env to database
 */

require('dotenv').config();
const mongoose = require('mongoose');
const AdminAccount = require('./models/AdminAccount');
const { configuredAdminAccounts } = require('./utils/adminAccounts');

async function seedAdminAccounts() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('   SEED ADMIN ACCOUNTS TO DATABASE');
  console.log('═══════════════════════════════════════════════════════\n');

  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/suppliwise';
  
  try {
    console.log(`Connecting to: ${mongoUri}...`);
    await mongoose.connect(mongoUri);
    console.log('✓ Connected to MongoDB\n');

    // Load accounts from .env
    const accounts = configuredAdminAccounts();
    console.log(`Found ${accounts.length} admin account(s) in .env:`);
    accounts.forEach(acc => console.log(`  - ${acc.alias}`));
    console.log('');

    // Check existing
    const existingCount = await AdminAccount.countDocuments();
    console.log(`Existing admin accounts in database: ${existingCount}\n`);

    // Seed accounts
    console.log('Seeding accounts...');
    const results = await Promise.all(
      accounts.map(account => 
        AdminAccount.updateOne(
          { alias: account.alias },
          { $setOnInsert: account },
          { upsert: true }
        )
      )
    );

    const inserted = results.filter(r => r.upsertedCount > 0).length;
    const updated = results.filter(r => r.matchedCount > 0).length;

    console.log(`✓ Seeding complete:`);
    console.log(`  - ${inserted} newly inserted`);
    console.log(`  - ${updated} already existed\n`);

    // Verify
    const finalCount = await AdminAccount.countDocuments();
    const seededAdmins = await AdminAccount.find({}).select('alias enabled').lean();
    
    console.log(`Final count: ${finalCount} admin account(s)`);
    console.log('Seeded admins:');
    seededAdmins.forEach(admin => {
      console.log(`  ✓ ${admin.alias} (enabled: ${admin.enabled})`);
    });
    console.log('');

    if (finalCount === accounts.length) {
      console.log('✅ All admin accounts seeded successfully!');
      console.log('✅ You can now login with any admin account\n');
      console.log('Example login:');
      console.log('  Username: AdminPoli');
      console.log('  Password: Poli101');
      console.log('  TOTP: [code from authenticator app]\n');
    } else {
      console.log('⚠️  Account count mismatch!');
      console.log(`   Expected: ${accounts.length}, Got: ${finalCount}\n`);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('✓ Database connection closed');
  }
}

seedAdminAccounts().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
