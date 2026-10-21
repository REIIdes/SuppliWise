/**
 * Debug script: Why Update Health Assessment isn't hitting cache
 * 
 * This script examines actual assessment documents to see:
 * 1. What signatures are stored
 * 2. Whether identical updates produce the same signature
 * 3. What fields might be causing signature mismatches
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Assessment = require('./models/Assessment');
const { answerSignature } = require('./utils/planSelection');
const { canonicaliseAnswers } = require('./utils/answerCanonical');

async function debugUpdateSignatures() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB\n');

    // Find recent assessments for a test user
    const assessments = await Assessment.find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .select('user createdAt updatedFrom aiResults')
      .lean();

    if (assessments.length === 0) {
      console.log('No assessments found in database.');
      await mongoose.disconnect();
      return;
    }

    console.log(`Found ${assessments.length} recent assessment(s)\n`);
    console.log('='.repeat(80));

    for (const assessment of assessments) {
      const storedSig = assessment.aiResults?.planSignature;
      console.log(`\nAssessment ID: ${assessment._id}`);
      console.log(`User ID: ${assessment.user}`);
      console.log(`Created: ${assessment.createdAt}`);
      console.log(`Updated From: ${assessment.updatedFrom || 'N/A (new assessment)'}`);
      console.log(`Stored Signature: ${storedSig || 'MISSING!'}`);
      
      // Load full assessment to recompute signature
      const fullAssessment = await Assessment.findById(assessment._id).lean();
      
      // Canonicalize answers
      const canonical = canonicaliseAnswers(fullAssessment);
      
      // Recompute signature
      const recomputedSig = answerSignature(canonical, { liveDynamic: [] });
      
      console.log(`Recomputed Signature: ${recomputedSig}`);
      console.log(`Signatures Match: ${storedSig === recomputedSig ? '✅ YES' : '❌ NO'}`);
      
      // Check if this signature exists in other assessments for same user
      const matchingAssessments = await Assessment.find({
        user: assessment.user,
        'aiResults.planSignature': recomputedSig,
      }).select('_id createdAt').lean();
      
      console.log(`Other assessments with same signature: ${matchingAssessments.length}`);
      if (matchingAssessments.length > 1) {
        console.log('  → Cache SHOULD have hit!');
        matchingAssessments.forEach(a => {
          console.log(`     - ${a._id} (${a.createdAt})`);
        });
      }
      
      console.log('-'.repeat(80));
    }

    // Now test cache lookup logic
    console.log('\n\n📊 CACHE LOOKUP TEST');
    console.log('='.repeat(80));
    
    const testAssessment = assessments[0];
    if (testAssessment) {
      const fullTest = await Assessment.findById(testAssessment._id).lean();
      const canonicalTest = canonicaliseAnswers(fullTest);
      const signatureTest = answerSignature(canonicalTest, { liveDynamic: [] });
      
      console.log(`\nTest Assessment: ${testAssessment._id}`);
      console.log(`Signature: ${signatureTest}`);
      
      // Simulate the cache lookup from recommend.js
      const cached = await Assessment.findOne({
        user: testAssessment.user,
        'aiResults.planSignature': signatureTest,
      }).sort({ createdAt: -1 }).select('aiResults').lean();
      
      if (cached) {
        console.log('✅ Cache lookup would SUCCEED');
        console.log(`   Found cached plan from assessment: ${cached._id}`);
        console.log(`   Recommendations count: ${cached.aiResults?.recommendations?.length || 0}`);
      } else {
        console.log('❌ Cache lookup would FAIL');
        console.log('   Reasons:');
        console.log('   1. No assessment found with this signature');
        console.log('   2. Signature changed between submissions');
        console.log('   3. User ID mismatch');
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ Debug complete\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
  }
}

debugUpdateSignatures();
