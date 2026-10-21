/**
 * Compare the last two assessments for the user to see why signatures differ
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Assessment = require('./models/Assessment');
const { answerSignature } = require('./utils/planSelection');
const { canonicaliseAnswers } = require('./utils/answerCanonical');

async function compareSignatures() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB\n');

    const userId = '6ad8e1a14d9c86bb1c0ea05c';
    
    const assessments = await Assessment.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(2)
      .lean();
    
    if (assessments.length < 2) {
      console.log('Need at least 2 assessments to compare');
      await mongoose.disconnect();
      return;
    }
    
    const [newer, older] = assessments;
    
    console.log('NEWER Assessment:', newer._id);
    console.log('  Created:', newer.createdAt);
    console.log('  Stored Signature:', newer.aiResults?.planSignature);
    console.log('  Updated From:', newer.updatedFrom);
    
    console.log('\nOLDER Assessment:', older._id);
    console.log('  Created:', older.createdAt);
    console.log('  Stored Signature:', older.aiResults?.planSignature);
    
    console.log('\n' + '='.repeat(80));
    console.log('COMPARISON:');
    console.log('='.repeat(80));
    
    // Compare key fields
    const fields = ['symptoms', 'healthGoals', 'medicalConditions', 'weight', 'height', 'age', 'gender', 'diet'];
    
    for (const field of fields) {
      const newerVal = JSON.stringify(newer[field]);
      const olderVal = JSON.stringify(older[field]);
      
      if (newerVal !== olderVal) {
        console.log(`\n❌ ${field} DIFFERENT:`);
        console.log(`   Newer: ${newerVal}`);
        console.log(`   Older: ${olderVal}`);
      } else {
        console.log(`✅ ${field}: identical`);
      }
    }
    
    // Recompute signatures from actual data
    console.log('\n' + '='.repeat(80));
    console.log('RECOMPUTED SIGNATURES:');
    console.log('='.repeat(80));
    
    const newerCanonical = canonicaliseAnswers(newer);
    const olderCanonical = canonicaliseAnswers(older);
    
    const newerRecomputed = answerSignature(newerCanonical, { liveDynamic: [] });
    const olderRecomputed = answerSignature(olderCanonical, { liveDynamic: [] });
    
    console.log('\nNewer recomputed:', newerRecomputed);
    console.log('Older recomputed:', olderRecomputed);
    console.log('\nMatch:', newerRecomputed === olderRecomputed ? '✅ YES' : '❌ NO');
    
    if (newerRecomputed !== olderRecomputed) {
      console.log('\n🔍 Finding what\'s different in canonicalized data...\n');
      
      const newerKeys = Object.keys(newerCanonical).sort();
      const olderKeys = Object.keys(olderCanonical).sort();
      
      const allKeys = new Set([...newerKeys, ...olderKeys]);
      
      for (const key of allKeys) {
        if (key.startsWith('_') || ['aiResults', 'updatedFrom', 'createdAt', '__v'].includes(key)) continue;
        
        const newerVal = JSON.stringify(newerCanonical[key]);
        const olderVal = JSON.stringify(olderCanonical[key]);
        
        if (newerVal !== olderVal) {
          console.log(`❌ ${key}:`);
          console.log(`   Newer: ${newerVal.slice(0, 100)}${newerVal.length > 100 ? '...' : ''}`);
          console.log(`   Older: ${olderVal.slice(0, 100)}${olderVal.length > 100 ? '...' : ''}`);
        }
      }
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('Expected cache lookup signature: 9a96798f16e6eed7e95a39cd');
    console.log('Older stored signature:         ', older.aiResults?.planSignature);
    console.log('Match:', '9a96798f16e6eed7e95a39cd' === older.aiResults?.planSignature ? '✅ YES - SHOULD HIT CACHE' : '❌ NO - CACHE MISS EXPECTED');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
  }
}

compareSignatures();
