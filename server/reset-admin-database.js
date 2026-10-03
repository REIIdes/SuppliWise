#!/usr/bin/env node
/**
 * Reset ONLY the AdminAccount collection in the database.
 * This script:
 * 1. Connects to MongoDB
 * 2. Deletes all documents in the AdminAccount collection ONLY
 * 3. Leaves all other collections (User, Subscription, etc.) untouched
 * 4. Closes the connection
 * 
 * The admin accounts will be re-seeded from .env when the server starts.
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function resetAdminDatabase() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('   RESET ADMIN DATABASE (AdminAccount Collection Only)');
  console.log('═══════════════════════════════════════════════════════\n');

  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/suppliwise';
  
  console.log(`Connecting to: ${mongoUri}...`);
  
  try {
    await mongoose.connect(mongoUri);
    console.log('✓ Connected to MongoDB\n');

    // Get the AdminAccount model
    const AdminAccount = require('./models/AdminAccount');
    
    // Count before deletion
    const countBefore = await AdminAccount.countDocuments();
    console.log(`Found ${countBefore} admin account(s) in database`);
    
    if (countBefore === 0) {
      console.log('ℹ No admin accounts to delete\n');
    } else {
      console.log('Deleting all admin accounts...');
      const result = await AdminAccount.deleteMany({});
      console.log(`✓ Deleted ${result.deletedCount} admin account(s)\n`);
    }

    // Verify deletion
    const countAfter = await AdminAccount.countDocuments();
    console.log(`Admin accounts remaining: ${countAfter}`);
    
    if (countAfter === 0) {
      console.log('✅ AdminAccount collection cleared successfully!\n');
    } else {
      console.log('⚠ Warning: Some admin accounts still remain\n');
    }

    // Verify other collections are untouched
    console.log('Checking other collections...');
    try {
      const User = require('./models/User');
      const userCount = await User.countDocuments();
      console.log(`  Users: ${userCount} (untouched)`);
    } catch (e) {
      console.log(`  Users: (model not found)`);
    }
    
    try {
      const Subscription = require('./models/Subscription');
      const subCount = await Subscription.countDocuments();
      console.log(`  Subscriptions: ${subCount} (untouched)`);
    } catch (e) {
      console.log(`  Subscriptions: (model not found)`);
    }
    
    console.log('\n✅ Database reset complete!');
    console.log('ℹ Admin accounts will be re-seeded from .env when server starts\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('✓ Database connection closed');
  }
}

// Run the reset
resetAdminDatabase().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
