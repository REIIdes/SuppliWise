/**
 * Check what signature the old assessment has
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Assessment = require('./models/Assessment');

async function checkOldAssessment() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB\n');

    const oldId = '6ad8df1b40d57834e982af4c'; // The updatedFrom ID from your logs
    
    const assessment = await Assessment.findById(oldId).lean();
    
    if (!assessment) {
      console.log('❌ Assessment not found:', oldId);
      await mongoose.disconnect();
      return;
    }
    
    console.log('Assessment Found:', oldId);
    console.log('Created:', assessment.createdAt);
    console.log('User:', assessment.user);
    console.log('\nStored Signature:', assessment.aiResults?.planSignature || 'MISSING!');
    console.log('\nSymptoms:', assessment.symptoms);
    console.log('Health Goals:', assessment.healthGoals);
    console.log('Medical Conditions:', assessment.medicalConditions);
    console.log('Weight:', assessment.weight);
    
    console.log('\n' + '='.repeat(80));
    console.log('Expected new signature: 5be1f1b73967f5e1eee1ca25');
    console.log('Actual stored signature:', assessment.aiResults?.planSignature || 'NONE');
    console.log('Match:', (assessment.aiResults?.planSignature === '5be1f1b73967f5e1eee1ca25' ? '✅ YES' : '❌ NO'));
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
}

checkOldAssessment();
