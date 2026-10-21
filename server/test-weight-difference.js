/**
 * Test to verify weight changes produce different signatures
 * This is EXPECTED behavior - different inputs should generate different results
 */

const { canonicaliseAnswers } = require('./utils/answerCanonical');
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

console.log('='.repeat(70));
console.log('Testing Weight Change Impact');
console.log('='.repeat(70));

// Assessment 1: 66kg
const assessment1 = {
  age: 30,
  gender: 'Female',
  weight: 66,
  height: 165,
  symptoms: ['Fatigue', 'Dizziness'],
  healthGoals: ['Increase Energy', 'Muscle Gain'],
};

// Assessment 2: 65kg (everything else same)
const assessment2 = {
  age: 30,
  gender: 'Female',
  weight: 65,  // ← ONLY DIFFERENCE
  height: 165,
  symptoms: ['Fatigue', 'Dizziness'],
  healthGoals: ['Increase Energy', 'Muscle Gain'],
};

const canonical1 = canonicaliseAnswers(assessment1);
const canonical2 = canonicaliseAnswers(assessment2);

const sig1 = simpleSignature(canonical1);
const sig2 = simpleSignature(canonical2);

console.log('\n📊 Assessment 1 (66kg):');
console.log('  Weight:', canonical1.weight);
console.log('  Goals:', canonical1.healthGoals);
console.log('  Signature:', sig1);

console.log('\n📊 Assessment 2 (65kg):');
console.log('  Weight:', canonical2.weight);
console.log('  Goals:', canonical2.healthGoals);
console.log('  Signature:', sig2);

console.log('\n🔍 Comparison:');
console.log('  Weights match:', canonical1.weight === canonical2.weight ? '❌' : '✅ Different (expected)');
console.log('  Goals match:', JSON.stringify(canonical1.healthGoals) === JSON.stringify(canonical2.healthGoals) ? '✅' : '❌');
console.log('  Signatures match:', sig1 === sig2 ? '❌ UNEXPECTED!' : '✅ Different (correct)');

console.log('\n' + '='.repeat(70));
console.log('Result: Different weights → Different signatures → No cache hit');
console.log('This is CORRECT behavior!');
console.log('='.repeat(70));

console.log('\n' + '='.repeat(70));
console.log('Now testing IDENTICAL inputs with different health goal ORDER:');
console.log('='.repeat(70));

// Assessment 3: Goals in order A
const assessment3 = {
  age: 30,
  weight: 65,
  healthGoals: ['Muscle Gain', 'Increase Energy', 'Brain & Mental Health'],
  symptoms: ['Fatigue', 'Chest Tightness', 'Dizziness'],
};

// Assessment 4: Goals in order B (different order, same semantic content)
const assessment4 = {
  age: 30,
  weight: 65,
  healthGoals: ['Brain & Mental Health', 'Increase Energy', 'Muscle Gain'],  // ← Different order
  symptoms: ['Dizziness', 'Fatigue', 'Chest Tightness'],  // ← Different order
};

const canonical3 = canonicaliseAnswers(assessment3);
const canonical4 = canonicaliseAnswers(assessment4);

const sig3 = simpleSignature(canonical3);
const sig4 = simpleSignature(canonical4);

console.log('\n📊 Assessment 3:');
console.log('  Input goals:', assessment3.healthGoals);
console.log('  Canonical goals:', canonical3.healthGoals);
console.log('  Input symptoms:', assessment3.symptoms);
console.log('  Canonical symptoms:', canonical3.symptoms);
console.log('  Signature:', sig3);

console.log('\n📊 Assessment 4 (different order):');
console.log('  Input goals:', assessment4.healthGoals);
console.log('  Canonical goals:', canonical4.healthGoals);
console.log('  Input symptoms:', assessment4.symptoms);
console.log('  Canonical symptoms:', canonical4.symptoms);
console.log('  Signature:', sig4);

console.log('\n🔍 Comparison:');
console.log('  Goals sorted identically:', JSON.stringify(canonical3.healthGoals) === JSON.stringify(canonical4.healthGoals) ? '✅ PASS' : '❌ FAIL');
console.log('  Symptoms sorted identically:', JSON.stringify(canonical3.symptoms) === JSON.stringify(canonical4.symptoms) ? '✅ PASS' : '❌ FAIL');
console.log('  Signatures match:', sig3 === sig4 ? '✅ PASS - Cache will hit!' : '❌ FAIL - Cache will miss');

console.log('\n' + '='.repeat(70));
console.log('THIS is what the consistency fix ensures!');
console.log('Same semantic content → Same signature → Cache hit → Instant results');
console.log('='.repeat(70));
