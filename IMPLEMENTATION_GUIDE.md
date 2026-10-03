# Implementation Guide: Applying Allergy & Duplicate Checking

## Quick Reference

The helper functions are now available at the top of `generateClinicalFallback()`:

```javascript
// Check if patient has allergy
hasAllergy('iron')              // Returns true if allergic to iron
hasAllergy('fish|shellfish')    // Returns true if allergic to fish OR shellfish

// Check if already taking supplement
alreadyTaking('iron|ferrous')   // Returns true if taking iron or ferrous
alreadyTaking('omega|fish oil') // Returns true if taking omega-3 or fish oil

// Blood test interpretation
bloodTestShows.lowIron          // true if blood test mentions low iron/anemia
bloodTestShows.lowVitD          // true if blood test mentions low vitamin D
bloodTestShows.normalIron       // true if blood test mentions normal iron
```

---

## Pattern to Apply Throughout recommend.js

### Before (Old Code):
```javascript
// Old way - no checking
recs.push({ 
  name: 'Iron (as Iron Bisglycinate)', 
  reason: 'Iron deficiency causes fatigue...',
  dosage: '18mg daily',
  priority: 'High'
});
```

### After (New Code with Checking):
```javascript
// New way - with allergy, duplicate, and blood test checking
if (hasAllergy('iron')) {
  avoidList.push('Iron - Patient has reported iron allergy');
  warnings.push('Iron allergy noted - consult doctor about alternative treatments');
} else if (alreadyTaking('iron|ferrous')) {
  // Skip - already taking iron
} else {
  // Adjust priority based on blood test
  let ironPriority = 'Medium';
  let ironReason = 'Iron deficiency causes fatigue...';
  
  if (bloodTestShows.normalIron) {
    ironPriority = 'Low';
    ironReason = 'Blood test shows normal iron - preventive only';
  }
  
  if (bloodTestShows.lowIron) {
    ironPriority = 'High';
    ironReason = 'Blood test indicates iron deficiency/anemia. Immediate supplementation recommended.';
  }
  
  recs.push({ 
    name: 'Iron (as Iron Bisglycinate)', 
    reason: ironReason,
    dosage: '18mg daily',
    priority: ironPriority,
    triggeredBy: bloodTestShows.lowIron ? 'Blood test - low iron' : 'Fatigue symptoms'
  });
}
```

---

## Common Supplement Patterns

### 1. Iron Supplementation
```javascript
if (hasAllergy('iron')) {
  avoidList.push('Iron - Patient has iron allergy');
  warnings.push('Iron allergy noted - consult hematologist');
} else if (alreadyTaking('iron|ferrous|ferritin')) {
  // Skip
} else {
  let priority = bloodTestShows.lowIron ? 'High' : 'Medium';
  if (bloodTestShows.normalIron) priority = 'Low';
  
  recs.push({
    name: 'Iron (as Iron Bisglycinate)',
    reason: bloodTestShows.lowIron 
      ? 'Blood test indicates iron deficiency/anemia' 
      : 'Iron supports energy and prevents anemia',
    dosage: '18mg daily',
    priority: priority,
    timing: 'Morning with Vitamin C on empty stomach',
    triggeredBy: bloodTestShows.lowIron ? 'Blood test - anemia' : 'Fatigue symptoms'
  });
}
```

### 2. Omega-3 / Fish Oil
```javascript
if (hasAllergy('fish|shellfish')) {
  avoidList.push('Fish Oil - Patient has fish/shellfish allergy');
  // Recommend algae alternative
  if (!alreadyTaking('omega|dha|epa|algae')) {
    recs.push({
      name: 'Omega-3 (Algae-based)',
      reason: 'Algae-based omega-3 provides EPA and DHA without fish allergens. Supports heart health, brain function, and reduces inflammation.',
      dosage: '500-1000mg DHA+EPA daily',
      priority: 'High',
      timing: 'With meals',
      triggeredBy: 'Fish allergy accommodation'
    });
  }
} else if (alreadyTaking('omega|fish oil|dha|epa')) {
  // Skip
} else {
  recs.push({
    name: 'Omega-3 (Fish Oil)',
    reason: 'EPA and DHA support heart health, brain function, and reduce inflammation.',
    dosage: '1000-2000mg EPA+DHA daily',
    priority: 'High',
    timing: 'With meals',
    triggeredBy: 'Heart health and inflammation'
  });
}
```

### 3. Vitamin D3
```javascript
if (alreadyTaking('vitamin d|vitamin d3|cholecalciferol')) {
  // Skip
} else {
  let priority = 'Medium';
  let reason = 'Vitamin D supports immune function, bone health, and mood regulation.';
  
  if (bloodTestShows.normalVitD) {
    priority = 'Low';
    reason = 'Blood test shows normal Vitamin D levels - preventive supplementation.';
  }
  
  if (bloodTestShows.lowVitD) {
    priority = 'High';
    reason = 'Blood test indicates Vitamin D deficiency. Immediate supplementation recommended.';
  }
  
  recs.push({
    name: 'Vitamin D3',
    reason: reason,
    dosage: bloodTestShows.lowVitD ? '4000 IU daily' : '2000 IU daily',
    priority: priority,
    timing: 'With a meal containing fat',
    triggeredBy: bloodTestShows.lowVitD ? 'Blood test - low Vitamin D' : 'General wellness'
  });
}
```

### 4. Vitamin B12
```javascript
if (alreadyTaking('b12|b-12|cobalamin|methylcobalamin')) {
  // Skip
} else {
  let priority = 'Medium';
  let reason = 'B12 supports nerve function, energy production, and red blood cell formation.';
  
  if (bloodTestShows.normalB12) {
    priority = 'Low';
  }
  
  if (bloodTestShows.lowB12 || onMetformin) {
    priority = 'High';
    reason = bloodTestShows.lowB12 
      ? 'Blood test indicates B12 deficiency.' 
      : 'Metformin depletes B12 - supplementation critical.';
  }
  
  recs.push({
    name: 'Vitamin B12 (Methylcobalamin)',
    reason: reason,
    dosage: '1000mcg daily (sublingual)',
    priority: priority,
    timing: 'Morning',
    triggeredBy: bloodTestShows.lowB12 ? 'Blood test - low B12' : onMetformin ? 'Metformin use' : 'Fatigue symptoms'
  });
}
```

### 5. Magnesium
```javascript
if (alreadyTaking('magnesium')) {
  // Skip
} else {
  recs.push({
    name: 'Magnesium Glycinate',
    reason: 'Magnesium supports muscle function, sleep quality, stress management, and over 300 enzymatic reactions.',
    dosage: '200-400mg daily',
    priority: 'Medium',
    timing: 'Evening with dinner or before bed',
    triggeredBy: 'Sleep quality and stress symptoms'
  });
}
```

### 6. Calcium
```javascript
if (alreadyTaking('calcium')) {
  // Skip
} else {
  recs.push({
    name: 'Calcium Citrate',
    reason: 'Calcium supports bone health, muscle contraction, and nerve signaling.',
    dosage: '500mg twice daily (max 1200mg total)',
    priority: 'Medium',
    timing: 'With meals, split into two doses',
    interactions: onThyroid ? 'Take 4+ hours away from thyroid medication' : 'Take 2+ hours away from iron',
    triggeredBy: 'Bone health and age'
  });
}
```

### 7. Zinc
```javascript
if (alreadyTaking('zinc')) {
  // Skip
} else {
  recs.push({
    name: 'Zinc',
    reason: 'Zinc supports immune function, wound healing, and sense of taste/smell.',
    dosage: '15-30mg daily',
    priority: 'Medium',
    timing: 'With food to avoid nausea',
    triggeredBy: 'Immune support and frequent colds'
  });
}
```

### 8. Probiotics
```javascript
if (alreadyTaking('probiotic|probiotics')) {
  // Skip
} else {
  recs.push({
    name: 'Multi-Strain Probiotic',
    reason: 'Probiotics support gut health, digestion, immune function, and may improve mood.',
    dosage: '10-50 billion CFU daily',
    priority: 'Medium',
    timing: 'On empty stomach, 30 minutes before breakfast or before bed',
    triggeredBy: 'Digestive symptoms and gut health'
  });
}
```

### 9. CoQ10 (especially for statin users)
```javascript
if (alreadyTaking('coq10|ubiquinol')) {
  // Skip
} else {
  let priority = onStatin ? 'High' : 'Medium';
  let reason = onStatin 
    ? 'Statin medications deplete CoQ10. Supplementation is critical for energy and heart health.'
    : 'CoQ10 supports energy production in cells and heart health.';
  
  recs.push({
    name: 'CoQ10 (Ubiquinol)',
    reason: reason,
    dosage: onStatin ? '200-300mg daily' : '100-200mg daily',
    priority: priority,
    timing: 'With a meal containing fat',
    triggeredBy: onStatin ? 'Statin medication use' : 'Energy and heart health'
  });
}
```

### 10. Prenatal Vitamins (Pregnancy/Breastfeeding)
```javascript
if (isPregnant || isBreastfeeding) {
  if (alreadyTaking('prenatal')) {
    // Skip
  } else {
    recs.push({
      name: 'Prenatal Multivitamin with Methylfolate',
      reason: `${isPregnant ? 'Pregnancy' : 'Breastfeeding'} significantly increases requirements for folate, iron, iodine, and DHA.`,
      dosage: '1 serving daily per label',
      priority: 'High',
      timing: 'With food to reduce nausea',
      triggeredBy: 'Pregnancy/breastfeeding status'
    });
  }
  
  // DHA for pregnancy
  if (hasAllergy('fish|shellfish')) {
    if (!alreadyTaking('dha|omega')) {
      recs.push({
        name: 'Algae-based DHA (prenatal)',
        reason: 'DHA is critical for fetal brain development. Algae-based DHA avoids fish allergens and mercury concerns.',
        dosage: '200-300mg DHA daily',
        priority: 'High',
        triggeredBy: 'Pregnancy and fish allergy'
      });
    }
  } else if (!alreadyTaking('dha|omega')) {
    recs.push({
      name: 'DHA (prenatal)',
      reason: 'DHA is critical for fetal brain and eye development.',
      dosage: '200-300mg DHA daily',
      priority: 'High',
      triggeredBy: 'Pregnancy status'
    });
  }
}
```

---

## Allergy-Specific Alternatives

### Fish/Shellfish Allergy
```javascript
if (hasAllergy('fish|shellfish')) {
  avoidList.push('Fish Oil - Patient has fish/shellfish allergy');
  avoidList.push('Krill Oil - Derived from shellfish');
  avoidList.push('Glucosamine (shellfish-derived) - Use plant-based alternative');
  
  // Recommend algae omega-3 instead
  if (!alreadyTaking('omega|dha|algae')) {
    recs.push({
      name: 'Omega-3 (Algae-based)',
      reason: 'Algae-based omega-3 provides EPA and DHA without fish allergens.',
      dosage: '500-1000mg DHA+EPA daily',
      priority: 'High'
    });
  }
}
```

### Soy Allergy
```javascript
if (hasAllergy('soy')) {
  avoidList.push('Soy-based supplements - Patient has soy allergy');
  avoidList.push('Lecithin (soy-derived) - Use sunflower lecithin instead');
  warnings.push('Check supplement labels for soy-derived ingredients');
}
```

### Dairy/Lactose Allergy
```javascript
if (hasAllergy('dairy|lactose|milk')) {
  avoidList.push('Whey Protein - Dairy-derived');
  avoidList.push('Casein - Dairy-derived');
  warnings.push('Ensure calcium supplements are dairy-free (calcium citrate is safe)');
}
```

### Iodine Allergy
```javascript
if (hasAllergy('iodine')) {
  avoidList.push('Kelp - High iodine content');
  avoidList.push('Seaweed supplements - High iodine content');
  warnings.push('Iodine allergy noted - avoid sea-based supplements');
}
```

---

## Where to Apply These Patterns

Search for these locations in `recommend.js` and apply the checking pattern:

1. **Line ~530**: Teen female iron recommendation
2. **Line ~535**: Teen omega-3 recommendation
3. **Line ~570**: Pregnancy prenatal and DHA
4. **Line ~600**: Senior vitamin D + K2
5. **Line ~605**: Senior calcium
6. **Line ~610**: Senior B12
7. **Line ~615**: Senior omega-3
8. **Line ~670**: Vegan omega-3 (algae)
9. **Line ~672**: Vegan iron
10. **Line ~680**: Fatigue - B12 and iron
11. **Line ~700**: Insomnia - magnesium
12. **Line ~720**: Anxiety - omega-3, magnesium
13. **Line ~750**: Immune support - vitamin D, zinc, vitamin C
14. **Line ~780**: Digestive issues - probiotics
15. **Line ~800**: Heart health - omega-3, CoQ10

---

## Testing Checklist

After applying these patterns, test with:

- [ ] User with fish allergy → Gets algae omega-3, NOT fish oil
- [ ] User with iron allergy → Gets warning, NO iron recommendation
- [ ] User already taking "multivitamin" → Doesn't get individual vitamins
- [ ] User already taking "fish oil" → Doesn't get omega-3 recommendation
- [ ] User with "low iron" blood test → Iron is HIGH priority
- [ ] User with "vitamin D normal" blood test → Vitamin D is LOW priority
- [ ] User on metformin → B12 is HIGH priority
- [ ] User on warfarin → Warning about Vitamin K and fish oil
- [ ] Pregnant user with fish allergy → Gets algae DHA, NOT fish oil DHA

---

## Summary

**Key Principle**: Always check in this order:
1. **Allergy check** → If allergic, add to avoidList and skip OR recommend alternative
2. **Duplicate check** → If already taking, skip
3. **Blood test check** → Adjust priority based on results
4. **Recommend** → Add to recs array with proper triggeredBy field

This ensures safe, personalized, and accurate recommendations.
