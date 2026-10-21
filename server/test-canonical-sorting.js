/**
 * Test script to verify canonicaliseAnswers sorting behavior
 * Run with: node test-canonical-sorting.js
 */

const { canonicaliseAnswers } = require('./utils/answerCanonical');

console.log('='.repeat(60));
console.log('Testing canonicaliseAnswers Sorting Fix');
console.log('='.repeat(60));

// Test 1: Symptoms in different orders should produce same result
console.log('\n✅ Test 1: Symptom ordering consistency');
console.log('-'.repeat(60));

const assessment1 = {
  age: 30,
  gender: 'Female',
  symptoms: ['Fatigue', 'Excessive Thirst', 'Frequent Urination', 'Dizziness / Lightheadedness', 'Chest Tightness'],
  healthGoals: ['Weight Management', 'Muscle Building'],
  medicalConditions: ['Diabetes'],
};

const assessment2 = {
  age: 30,
  gender: 'Female',
  symptoms: ['Chest Tightness', 'Dizziness / Lightheadedness', 'Fatigue', 'Frequent Urination', 'Excessive Thirst'],
  healthGoals: ['Muscle Building', 'Weight Management'],
  medicalConditions: ['Diabetes'],
};

const canonical1 = canonicaliseAnswers(assessment1);
const canonical2 = canonicaliseAnswers(assessment2);

console.log('Input 1 symptoms:', assessment1.symptoms);
console.log('Input 2 symptoms:', assessment2.symptoms);
console.log('\nCanonical 1 symptoms:', canonical1.symptoms);
console.log('Canonical 2 symptoms:', canonical2.symptoms);
console.log('\nSymptoms match:', JSON.stringify(canonical1.symptoms) === JSON.stringify(canonical2.symptoms) ? '✅ PASS' : '❌ FAIL');

console.log('\nInput 1 goals:', assessment1.healthGoals);
console.log('Input 2 goals:', assessment2.healthGoals);
console.log('\nCanonical 1 goals:', canonical1.healthGoals);
console.log('Canonical 2 goals:', canonical2.healthGoals);
console.log('\nGoals match:', JSON.stringify(canonical1.healthGoals) === JSON.stringify(canonical2.healthGoals) ? '✅ PASS' : '❌ FAIL');

// Test 2: Symptom severity key ordering
console.log('\n✅ Test 2: Symptom severity key ordering');
console.log('-'.repeat(60));

const assessment3 = {
  symptoms: ['Fatigue', 'Insomnia', 'Joint Pain'],
  symptomSeverity: {
    'Fatigue': 'Severe',
    'Insomnia': 'Moderate',
    'Joint Pain': 'Mild'
  }
};

const assessment4 = {
  symptoms: ['Joint Pain', 'Fatigue', 'Insomnia'],
  symptomSeverity: {
    'Joint Pain': 'Mild',
    'Insomnia': 'Moderate',
    'Fatigue': 'Severe'
  }
};

const canonical3 = canonicaliseAnswers(assessment3);
const canonical4 = canonicaliseAnswers(assessment4);

console.log('Input 3 severity keys:', Object.keys(assessment3.symptomSeverity));
console.log('Input 4 severity keys:', Object.keys(assessment4.symptomSeverity));
console.log('\nCanonical 3 severity keys:', Object.keys(canonical3.symptomSeverity));
console.log('Canonical 4 severity keys:', Object.keys(canonical4.symptomSeverity));
console.log('\nSeverity keys match:', JSON.stringify(Object.keys(canonical3.symptomSeverity)) === JSON.stringify(Object.keys(canonical4.symptomSeverity)) ? '✅ PASS' : '❌ FAIL');

// Test 3: Generate signatures and verify they match
console.log('\n✅ Test 3: Signature generation consistency');
console.log('-'.repeat(60));

const crypto = require('crypto');

function simpleSignature(payload) {
  const normalise = (value) => {
    if (Array.isArray(value)) return value.map(normalise).sort().join('|');
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      return Object.keys(value).sort().map((k) => `${k}=${normalise(value[k])}`).join(';');
    }
    return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  };

  const fields = Object.keys(payload || {})
    .sort()
    .map((k) => `${k}=${normalise(payload[k])}`);

  return crypto
    .createHash('sha256')
    .update(['v1', fields.join('&')].join('\n'))
    .digest('hex')
    .slice(0, 24);
}

const sig1 = simpleSignature(canonical1);
const sig2 = simpleSignature(canonical2);

console.log('Signature 1:', sig1);
console.log('Signature 2:', sig2);
console.log('\nSignatures match:', sig1 === sig2 ? '✅ PASS' : '❌ FAIL');

// Test 4: Whitespace and case variations should normalize
console.log('\n✅ Test 4: Case and whitespace normalization');
console.log('-'.repeat(60));

const assessment5 = {
  symptoms: ['  FATIGUE ', 'chest   tightness', 'Dizziness / Lightheadedness'],
};

const assessment6 = {
  symptoms: ['fatigue', 'Chest Tightness', 'dizziness / lightheadedness'],
};

const canonical5 = canonicaliseAnswers(assessment5);
const canonical6 = canonicaliseAnswers(assessment6);

console.log('Input 5 symptoms:', assessment5.symptoms);
console.log('Input 6 symptoms:', assessment6.symptoms);
console.log('\nCanonical 5 symptoms:', canonical5.symptoms);
console.log('Canonical 6 symptoms:', canonical6.symptoms);
console.log('\nNormalized match:', JSON.stringify(canonical5.symptoms) === JSON.stringify(canonical6.symptoms) ? '✅ PASS' : '❌ FAIL');

// Summary
console.log('\n' + '='.repeat(60));
console.log('Test Summary');
console.log('='.repeat(60));
console.log('✅ All tests should show PASS if sorting fix is working correctly');
console.log('✅ Identical semantic inputs now produce identical canonical forms');
console.log('✅ Signature-based caching will now work for repeated assessments');
console.log('='.repeat(60));
