/**
 * Check the most recent assessment to see if signature is being saved
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Assessment = require('./models/Assessment');

async function checkLatest() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB\n');

    const latest = await Assessment.findOne()
      .sort({ createdAt: -1 })
      .lean();
    
    if (!latest) {
      console.log('No assessments found');
      await mongoose.disconnect();
      return;
    }
    
    console.log('Most Recent Assessment:');
    console.log('ID:', latest._id);
    console.log('User:', latest.user);
    console.log('Created:', latest.createdAt);
    console.log('Updated From:', latest.updatedFrom || 'N/A');
    console.log('\nHas aiResults:', !!latest.aiResults);
    console.log('Has recommendations:', Array.isArray(latest.aiResults?.recommendations));
    console.log('Recommendation count:', latest.aiResults?.recommendations?.length || 0);
    console.log('\n📝 Stored planSignature:', latest.aiResults?.planSignature || '❌ MISSING!');
    
    if (latest.aiResults?.planSignature) {
      console.log('\n✅ Signature IS being saved to database');
      
      // Test if we can find it
      const found = await Assessment.findOne({
        user: latest.user,
        'aiResults.planSignature': latest.aiResults.planSignature,
      }).lean();
      
      if (found) {
        console.log('✅ Signature IS queryable (cache lookup would work)');
      } else {
        console.log('❌ Signature NOT queryable (cache lookup would FAIL)');
      }
    } else {
      console.log('\n❌ Signature NOT being saved to database!');
      console.log('   This is why cache never hits.');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
}

checkLatest();
