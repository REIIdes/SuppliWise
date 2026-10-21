/**
 * Test script to verify Update Health Assessment consistency
 * Run with: node test-update-consistency.js
 */

const { canonicaliseAnswers } = require('./utils/answerCanonical');
const { answerSignature } = require('./utils/planSelection');

console.log('='.repeat(70));
console.log('Testing Update Health Assessment Consistency Fix');
console.log('='.repeat(70));

// Test 1: Verify updatedFrom is excluded from signature
console.log('\n✅ Test 1: updatedFrom field should NOT affect signature');
console.log('-'.repeat(70));

const assessment1 = {
  age: 30,
  gender: 'Female',
  weight: 65,
  height: 165,
  symptoms: ['Fatigue', 'Dizziness'],
  healthGoals: ['Increase Energy', 'Muscle Gain'],
};

const assessment2 = {
  age: 30,
  gender: 'Female',
  weight: 65,
  height: 165,
  symptoms: ['Fatigue', 'Dizziness'],
  healthGoals: ['Increase Energy', 'Muscle Gain'],
  updatedFrom: '507f1f77bcf86cd799439011',  // ← This should be IGNORED
};

const canonical1 = canonicaliseAnswers(assessment1);
const canonical2 = canonicaliseAnswers(assessment2);

const sig1 = answerSignature(canonical1);
const sig2 = answerSignature(canonical2);

console.log('Assessment 1 (new):');
console.log('  updatedFrom:', assessment1.updatedFrom);
console.log('  Signature:', sig1);

console.log('\nAssessment 2 (update):');
console.log('  updatedFrom:', assessment2.updatedFrom);
console.log('  Signature:', sig2);

console.log('\n🔍 Result:');
console.log('  Signatures match:', sig1 === sig2 ? '✅ PASS - updatedFrom excluded!' : '❌ FAIL - updatedFrom included in signature');

if (sig1 === sig2) {
  console.log('  ✅ Cache hit will occur for Update Health Assessment');
  console.log('  ✅ Identical answers = Instant results');
} else {
  console.log('  ❌ Cache miss will occur');
  console.log('  ❌ Unnecessary AI generation');
}

// Test 2: Verify other volatile fields are excluded
console.log('\n' + '='.repeat(70));
console.log('✅ Test 2: Other volatile fields should NOT affect signature');
console.log('-'.repeat(70));

const assessment3 = {
  age: 30,
  weight: 65,
  symptoms: ['Fatigue'],
};

const assessment4 = {
  age: 30,
  weight: 65,
  symptoms: ['Fatigue'],
  _id: '507f1f77bcf86cd799439011',
  assessmentId: '507f1f77bcf86cd799439012',
  createdAt: '2026-10-21T10:00:00Z',
  updatedAt: '2026-10-21T10:05:00Z',
  updatedFrom: '507f1f77bcf86cd799439013',
  aiResults: { recommendations: [] },
};

const sig3 = answerSignature(canonicaliseAnswers(assessment3));
const sig4 = answerSignature(canonicaliseAnswers(assessment4));

console.log('Assessment 3 (minimal):', Object.keys(assessment3));
console.log('  Signature:', sig3);

console.log('\nAssessment 4 (with metadata):', Object.keys(assessment4));
console.log('  Signature:', sig4);

console.log('\n🔍 Result:');
console.log('  Signatures match:', sig3 === sig4 ? '✅ PASS - All volatile fields excluded!' : '❌ FAIL - Volatile fields affecting signature');

// Test 3: Verify symptom and goal ordering still works
console.log('\n' + '='.repeat(70));
console.log('✅ Test 3: Multi-select field ordering (from previous fix)');
console.log('-'.repeat(70));

const assessment5 = {
  age: 30,
  weight: 65,
  symptoms: ['Fatigue', 'Dizziness', 'Chest Tightness'],
  healthGoals: ['Muscle Gain', 'Increase Energy'],
  updatedFrom: '507f1f77bcf86cd799439011',  // Include this to verify it doesn't break
};

const assessment6 = {
  age: 30,
  weight: 65,
  symptoms: ['Chest Tightness', 'Fatigue', 'Dizziness'],  // Different order
  healthGoals: ['Increase Energy', 'Muscle Gain'],  // Different order
  updatedFrom: '507f1f77bcf86cd799439012',  // Different value, should be ignored
};

const canonical5 = canonicaliseAnswers(assessment5);
const canonical6 = canonicaliseAnswers(assessment6);

const sig5 = answerSignature(canonical5);
const sig6 = answerSignature(canonical6);

console.log('Assessment 5:');
console.log('  Input symptoms:', assessment5.symptoms);
console.log('  Canonical symptoms:', canonical5.symptoms);
console.log('  updatedFrom:', assessment5.updatedFrom);
console.log('  Signature:', sig5);

console.log('\nAssessment 6:');
console.log('  Input symptoms:', assessment6.symptoms);
console.log('  Canonical symptoms:', canonical6.symptoms);
console.log('  updatedFrom:', assessment6.updatedFrom);
console.log('  Signature:', sig6);

console.log('\n🔍 Result:');
console.log('  Symptoms sorted identically:', JSON.stringify(canonical5.symptoms) === JSON.stringify(canonical6.symptoms) ? '✅ PASS' : '❌ FAIL');
console.log('  Goals sorted identically:', JSON.stringify(canonical5.healthGoals) === JSON.stringify(canonical6.healthGoals) ? '✅ PASS' : '❌ FAIL');
console.log('  Signatures match:', sig5 === sig6 ? '✅ PASS - Complete consistency!' : '❌ FAIL');

// Test 4: Weight change should still generate different signature
console.log('\n' + '='.repeat(70));
console.log('✅ Test 4: Meaningful changes should still affect signature');
console.log('-'.repeat(70));

const assessment7 = {
  age: 30,
  weight: 65,
  symptoms: ['Fatigue'],
  updatedFrom: '507f1f77bcf86cd799439011',
};

const assessment8 = {
  age: 30,
  weight: 66,  // ← CHANGED
  symptoms: ['Fatigue'],
  updatedFrom: '507f1f77bcf86cd799439012',
};

const sig7 = answerSignature(canonicaliseAnswers(assessment7));
const sig8 = answerSignature(canonicaliseAnswers(assessment8));

console.log('Assessment 7: weight=65, updatedFrom=' + assessment7.updatedFrom);
console.log('  Signature:', sig7);

console.log('\nAssessment 8: weight=66, updatedFrom=' + assessment8.updatedFrom);
console.log('  Signature:', sig8);

console.log('\n🔍 Result:');
console.log('  Signatures different:', sig7 !== sig8 ? '✅ PASS - Weight change detected!' : '❌ FAIL - Should be different');

// Summary
console.log('\n' + '='.repeat(70));
console.log('Test Summary');
console.log('='.repeat(70));

const test1Pass = sig1 === sig2;
const test2Pass = sig3 === sig4;
const test3Pass = sig5 === sig6;
const test4Pass = sig7 !== sig8;

console.log('Test 1 (updatedFrom excluded):       ', test1Pass ? '✅ PASS' : '❌ FAIL');
console.log('Test 2 (all volatile fields):        ', test2Pass ? '✅ PASS' : '❌ FAIL');
console.log('Test 3 (sorting + updatedFrom):      ', test3Pass ? '✅ PASS' : '❌ FAIL');
console.log('Test 4 (meaningful changes):         ', test4Pass ? '✅ PASS' : '❌ FAIL');

if (test1Pass && test2Pass && test3Pass && test4Pass) {
  console.log('\n🎉 ALL TESTS PASSED!');
  console.log('✅ Update Health Assessment will now use caching correctly');
  console.log('✅ Identical inputs = Identical results = Instant response');
  console.log('✅ Meaningful changes = New signature = Appropriate recalculation');
} else {
  console.log('\n❌ SOME TESTS FAILED - Review implementation');
}

console.log('='.repeat(70));
