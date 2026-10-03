/**
 * Reset Database - Drops all collections and recreates fresh
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI, { 
      serverSelectionTimeoutMS: 15000 
    });
    
    console.log('Connected. Dropping database...');
    await mongoose.connection.db.dropDatabase();
    
    console.log('✅ Database reset complete!');
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
})();
