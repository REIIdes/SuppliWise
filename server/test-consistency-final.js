/**
 * Final consistency test: Verify identical submissions produce identical signatures
 * 
 * Tests:
 * 1. Same answers → same signature (cache hits)
 * 2. Different symptom order → same signature (sorted)
 * 3. updatedFrom field → same signature (volatile)
 * 4. Actual weight change → different signature (correct behavior)
 */

require('dotenv').config();
const { answerSignature } = require('./utils/planSelection');
const { canonicaliseAnswers } = require('./utils/answerCanonical');

console.log('🧪 FINAL CONSISTENCY TEST');
console.log('='.repeat(80));

const baseAnswers = {
  age: '21',
  gender: 'Male',
  height: '166',
  weight: '65',
  diet: 'Omnivore',
  bmi: '23.6',
  physicalActivityLevel: 'Moderate (3-5 days/week)',
  healthGoals: ['Increase Energy', 'Improve Strength'],
  symptoms: ['Fatigue', 'Chest Tightness'],
  symptomSeverity: {
    'Fatigue': 'Moderate',
    'Chest Tightness': 'Mild'
  },
  medicalConditions: ['Hypertension (High Blood Pressure)', 'Diabetes', 'Anemia'],
  lifestyleHabits: [],
  currentMedications: [],
  allergies: [],
  currentSupplements: [],
};

// Test 1: Identical submissions
console.log('\n✅ TEST 1: Identical submissions');
const canonical1a = canonicaliseAnswers({ ...baseAnswers });
const canonical1b = canonicaliseAnswers({ ...baseAnswers });
const sig1a = answerSignature(canonical1a, { liveDynamic: [] });
const sig1b = answerSignature(canonical1b, { liveDynamic: [] });
console.log(`First submission:  ${sig1a}`);
console.log(`Second submission: ${sig1b}`);
console.log(`Match: ${sig1a === sig1b ? '✅ YES' : '❌ NO'}`);
if (sig1a !== sig1b) {
  console.log('❌ FAIL: Identical submissions should produce identical signatures!');
  process.exit(1);
}

// Test 2: Different symptom order (should be sorted)
console.log('\n✅ TEST 2: Different symptom order (should match after sorting)');
const answers2a = { ...baseAnswers, symptoms: ['Fatigue', 'Chest Tightness'] };
const answers2b = { ...baseAnswers, symptoms: ['Chest Tightness', 'Fatigue'] };
const canonical2a = canonicaliseAnswers(answers2a);
const canonical2b = canonicaliseAnswers(answers2b);
const sig2a = answerSignature(canonical2a, { liveDynamic: [] });
const sig2b = answerSignature(canonical2b, { liveDynamic: [] });
console.log(`Order A ['Fatigue', 'Chest Tightness']: ${sig2a}`);
console.log(`Order B ['Chest Tightness', 'Fatigue']: ${sig2b}`);
console.log(`Match: ${sig2a === sig2b ? '✅ YES' : '❌ NO'}`);
if (sig2a !== sig2b) {
  console.log('❌ FAIL: Different order should produce same signature after sorting!');
  process.exit(1);
}

// Test 3: updatedFrom field (should be volatile - no effect on signature)
console.log('\n✅ TEST 3: updatedFrom field (volatile - should not affect signature)');
const answers3a = { ...baseAnswers };
const answers3b = { ...baseAnswers, updatedFrom: '507f1f77bcf86cd799439011' };
const canonical3a = canonicaliseAnswers(answers3a);
const canonical3b = canonicaliseAnswers(answers3b);
const sig3a = answerSignature(canonical3a, { liveDynamic: [] });
const sig3b = answerSignature(canonical3b, { liveDynamic: [] });
console.log(`Without updatedFrom: ${sig3a}`);
console.log(`With updatedFrom:    ${sig3b}`);
console.log(`Match: ${sig3a === sig3b ? '✅ YES' : '❌ NO'}`);
if (sig3a !== sig3b) {
  console.log('❌ FAIL: updatedFrom should not affect signature!');
  process.exit(1);
}

// Test 4: Actual weight change (should produce different signature)
console.log('\n✅ TEST 4: Weight change (should produce DIFFERENT signature)');
const answers4a = { ...baseAnswers, weight: '65', bmi: '23.6' };
const answers4b = { ...baseAnswers, weight: '66', bmi: '23.9' };
const canonical4a = canonicaliseAnswers(answers4a);
const canonical4b = canonicaliseAnswers(answers4b);
const sig4a = answerSignature(canonical4a, { liveDynamic: [] });
const sig4b = answerSignature(canonical4b, { liveDynamic: [] });
console.log(`Weight 65kg: ${sig4a}`);
console.log(`Weight 66kg: ${sig4b}`);
console.log(`Different: ${sig4a !== sig4b ? '✅ YES' : '❌ NO'}`);
if (sig4a === sig4b) {
  console.log('❌ FAIL: Weight change should produce different signature!');
  process.exit(1);
}

// Test 5: Health goals order (multi-select, should be sorted)
console.log('\n✅ TEST 5: Health goals order (should match after sorting)');
const answers5a = { ...baseAnswers, healthGoals: ['Increase Energy', 'Improve Strength'] };
const answers5b = { ...baseAnswers, healthGoals: ['Improve Strength', 'Increase Energy'] };
const canonical5a = canonicaliseAnswers(answers5a);
const canonical5b = canonicaliseAnswers(answers5b);
const sig5a = answerSignature(canonical5a, { liveDynamic: [] });
const sig5b = answerSignature(canonical5b, { liveDynamic: [] });
console.log(`Order A: ${sig5a}`);
console.log(`Order B: ${sig5b}`);
console.log(`Match: ${sig5a === sig5b ? '✅ YES' : '❌ NO'}`);
if (sig5a !== sig5b) {
  console.log('❌ FAIL: Different health goal order should produce same signature!');
  process.exit(1);
}

// Test 6: Medical conditions order (multi-select, should be sorted)
console.log('\n✅ TEST 6: Medical conditions order (should match after sorting)');
const answers6a = { ...baseAnswers, medicalConditions: ['Hypertension (High Blood Pressure)', 'Diabetes', 'Anemia'] };
const answers6b = { ...baseAnswers, medicalConditions: ['Anemia', 'Diabetes', 'Hypertension (High Blood Pressure)'] };
const canonical6a = canonicaliseAnswers(answers6a);
const canonical6b = canonicaliseAnswers(answers6b);
const sig6a = answerSignature(canonical6a, { liveDynamic: [] });
const sig6b = answerSignature(canonical6b, { liveDynamic: [] });
console.log(`Order A: ${sig6a}`);
console.log(`Order B: ${sig6b}`);
console.log(`Match: ${sig6a === sig6b ? '✅ YES' : '❌ NO'}`);
if (sig6a !== sig6b) {
  console.log('❌ FAIL: Different medical condition order should produce same signature!');
  process.exit(1);
}

console.log('\n' + '='.repeat(80));
console.log('✅ ALL TESTS PASSED!');
console.log('\n📝 Summary:');
console.log('  • Identical submissions → Same signature (cache hits)');
console.log('  • Multi-select field order → Sorted consistently');
console.log('  • updatedFrom field → Ignored (volatile)');
console.log('  • Weight changes → Different signature (correct)');
console.log('\n🎯 System is ready for consistent AI recommendations!');
console.log('');
