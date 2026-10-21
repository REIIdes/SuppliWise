/**
 * Check recent assessments to see if any have the signature we're looking for
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Assessment = require('./models/Assessment');

async function checkRecentAssessments() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB\n');

    const userId = '6ad8c5c414b795a859c13ea4'; // From your logs
    const targetSignature = '5be1f1b73967f5e1eee1ca25'; // The signature we're looking for
    
    console.log('Looking for assessments with signature:', targetSignature);
    console.log('='.repeat(80));
    
    // Find all recent assessments for this user
    const assessments = await Assessment.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('_id createdAt updatedFrom aiResults')
      .lean();
    
    console.log(`Found ${assessments.length} recent assessments:\n`);
    
    for (const assessment of assessments) {
      const storedSig = assessment.aiResults?.planSignature;
      const hasRecommendations = Array.isArray(assessment.aiResults?.recommendations);
      const recCount = hasRecommendations ? assessment.aiResults.recommendations.length : 0;
      
      console.log(`Assessment: ${assessment._id}`);
      console.log(`  Created: ${assessment.createdAt}`);
      console.log(`  Updated From: ${assessment.updatedFrom || 'N/A'}`);
      console.log(`  Stored Signature: ${storedSig || 'MISSING!'}`);
      console.log(`  Has aiResults: ${!!assessment.aiResults}`);
      console.log(`  Has recommendations: ${hasRecommendations} (${recCount} items)`);
      console.log(`  Match target: ${storedSig === targetSignature ? '✅ YES' : '❌ NO'}`);
      console.log('');
    }
    
    // Now check specifically for the target signature
    console.log('='.repeat(80));
    console.log('Direct query for target signature...\n');
    
    const match = await Assessment.findOne({
      user: userId,
      'aiResults.planSignature': targetSignature,
    }).select('_id createdAt aiResults').lean();
    
    if (match) {
      console.log('✅ FOUND assessment with target signature!');
      console.log(`   Assessment ID: ${match._id}`);
      console.log(`   Created: ${match.createdAt}`);
      console.log(`   Recommendations: ${match.aiResults?.recommendations?.length || 0}`);
    } else {
      console.log('❌ NO assessment found with signature:', targetSignature);
      console.log('\nThis means:');
      console.log('  1. No assessment has been saved with this signature yet, OR');
      console.log('  2. The assessment was saved but aiResults.planSignature is missing/different');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
}

checkRecentAssessments();
