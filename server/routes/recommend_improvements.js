// ============================================================================
// SUPPLEMENT RECOMMENDATION IMPROVEMENTS
// Add these helper functions to the generateClinicalFallback function
// ============================================================================

/**
 * Helper function to check if patient has allergy to a supplement ingredient
 * @param {string} allergies - Patient's allergy string (lowercase)
 * @param {string} substance - Substance to check (can use | for alternatives)
 * @returns {boolean} - True if patient is allergic
 */
function hasAllergy(allergies, substance) {
  if (!allergies || allergies === 'none known' || allergies === 'not specified') return false;
  const allergyTerms = substance.toLowerCase().split('|');
  return allergyTerms.some(term => allergies.includes(term.trim()));
}

/**
 * Helper function to check if patient is already taking a supplement
 * @param {string} currentSupps - Patient's current supplements (lowercase)
 * @param {string} suppName - Supplement name to check (can use | for alternatives)
 * @returns {boolean} - True if already taking
 */
function alreadyTaking(currentSupps, suppName) {
  if (!currentSupps || currentSupps === 'none reported' || currentSupps === 'not specified') return false;
  const suppTerms = suppName.toLowerCase().split('|');
  return suppTerms.some(term => currentSupps.includes(term.trim()));
}

/**
 * Interpret blood test results to prioritize supplements
 * @param {string} bloodTest - Patient's blood test description
 * @returns {object} - Object with boolean flags for various deficiencies
 */
function interpretBloodTest(bloodTest) {
  const bt = (bloodTest || '').toLowerCase();
  return {
    lowIron: /low.*iron|anemi|ferritin.*low|iron.*deficien/i.test(bt),
    lowVitD: /low.*vitamin d|vitamin d.*low|d.*deficien/i.test(bt),
    lowB12: /low.*b12|b12.*low|cobalamin.*low/i.test(bt),
    highCholesterol: /high.*cholesterol|cholesterol.*high|hyperlipid/i.test(bt),
    thyroidIssue: /thyroid|tsh|hypothyroid|hyperthyroid/i.test(bt),
    normalIron: /iron.*normal|ferritin.*normal/i.test(bt),
    normalVitD: /vitamin d.*normal|d.*normal/i.test(bt),
    normalB12: /b12.*normal|cobalamin.*normal/i.test(bt),
  };
}

/**
 * Check if a supplement should be recommended based on allergies and current supplements
 * @param {object} params - Parameters object
 * @returns {object} - { shouldRecommend: boolean, reason: string }
 */
function shouldRecommendSupplement(params) {
  const { suppName, allergyCheck, allergies, currentSupps, bloodTestResults, bloodTestKey } = params;
  
  // Check allergies first (absolute exclusion)
  if (allergyCheck && hasAllergy(allergies, allergyCheck)) {
    return {
      shouldRecommend: false,
      reason: `Patient is allergic to ${allergyCheck.split('|')[0]}`
    };
  }
  
  // Check if already taking (avoid duplicates)
  if (alreadyTaking(currentSupps, suppName)) {
    return {
      shouldRecommend: false,
      reason: `Patient is already taking ${suppName}`
    };
  }
  
  // Check blood test results if provided
  if (bloodTestResults && bloodTestKey) {
    // If blood test shows normal levels, lower priority
    const normalKey = 'normal' + bloodTestKey.charAt(3).toUpperCase() + bloodTestKey.slice(4);
    if (bloodTestResults[normalKey]) {
      return {
        shouldRecommend: true,
        adjustPriority: 'Low',
        reason: `Blood test shows normal levels - preventive only`
      };
    }
    
    // If blood test shows deficiency, high priority
    if (bloodTestResults[bloodTestKey]) {
      return {
        shouldRecommend: true,
        adjustPriority: 'High',
        reason: `Blood test indicates deficiency`
      };
    }
  }
  
  return { shouldRecommend: true };
}

// ============================================================================
// USAGE EXAMPLES - Add to generateClinicalFallback function
// ============================================================================

/*
// At the start of generateClinicalFallback, add:
const allergies = (a.allergies || '').toLowerCase();
const currentSupps = (a.currentSupplements || '').toLowerCase();
const bloodTestResults = interpretBloodTest(a.recentBloodTest);

// Before recommending Iron:
const ironCheck = shouldRecommendSupplement({
  suppName: 'iron|ferrous',
  allergyCheck: 'iron',
  allergies,
  currentSupps,
  bloodTestResults,
  bloodTestKey: 'lowIron'
});

if (!ironCheck.shouldRecommend) {
  avoidList.push(`Iron - ${ironCheck.reason}`);
} else {
  const priority = ironCheck.adjustPriority || 'High';
  recs.push({
    name: 'Iron (as Iron Bisglycinate)',
    reason: ironCheck.reason || 'Iron deficiency causes fatigue...',
    dosage: '18mg daily',
    timing: 'Morning with Vitamin C',
    priority: priority,
    // ... rest of recommendation
  });
}

// Before recommending Fish Oil:
const omegaCheck = shouldRecommendSupplement({
  suppName: 'omega|fish oil|omega-3',
  allergyCheck: 'fish|shellfish',
  allergies,
  currentSupps
});

if (!omegaCheck.shouldRecommend) {
  avoidList.push(`Fish Oil - ${omegaCheck.reason}`);
  // Recommend algae-based alternative instead
  recs.push({
    name: 'Omega-3 (Algae-based)',
    reason: 'Algae-based omega-3 provides EPA and DHA without fish allergens...',
    // ... rest of recommendation
  });
} else {
  recs.push({
    name: 'Omega-3 (Fish Oil)',
    // ... rest of recommendation
  });
}

// Before recommending Vitamin D:
const vitDCheck = shouldRecommendSupplement({
  suppName: 'vitamin d|vitamin d3',
  allergyCheck: null, // No common allergies
  allergies,
  currentSupps,
  bloodTestResults,
  bloodTestKey: 'lowVitD'
});

if (!vitDCheck.shouldRecommend) {
  avoidList.push(`Vitamin D - ${vitDCheck.reason}`);
} else {
  const priority = vitDCheck.adjustPriority || 'High';
  recs.push({
    name: 'Vitamin D3',
    reason: vitDCheck.reason || 'Vitamin D deficiency is common...',
    priority: priority,
    // ... rest of recommendation
  });
}
*/

module.exports = {
  hasAllergy,
  alreadyTaking,
  interpretBloodTest,
  shouldRecommendSupplement
};
