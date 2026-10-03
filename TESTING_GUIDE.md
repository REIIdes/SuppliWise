# Testing Guide: AI Improvements

## Quick Test Scenarios

### 1. Test Chatbot Improvements

#### Test Supplement Knowledge
Open the chat assistant and try these questions:

```
✅ "What is vitamin D?"
Expected: Detailed explanation with sources, deficiency signs, safety info

✅ "What is magnesium?"
Expected: Explanation of 300+ enzymatic reactions, sleep, stress benefits

✅ "What is iron?"
Expected: Hemoglobin, anemia prevention, absorption tips

✅ "Can I mix supplements?"
Expected: Safe combinations, avoid combinations, drug interactions

✅ "When should I take magnesium?"
Expected: Evening with dinner or before bed, timing details

✅ "How much vitamin C should I take?"
Expected: Dosage ranges for adults (500-1000mg daily)

✅ "What are signs of deficiency?"
Expected: List of deficiency symptoms for common supplements
```

#### Test Off-Topic Rejection
```
❌ "What is 2+2?"
Expected: "I'm only able to help with questions related to supplements..."

❌ "Who is the president?"
Expected: Off-topic rejection

❌ "Tell me a joke"
Expected: Off-topic rejection
```

---

### 2. Test Allergy Checking

#### Scenario A: Fish Allergy
**Assessment Input:**
- Age: 30
- Gender: Female
- Symptoms: Fatigue, Anxiety
- Health Goals: Boost Immunity, Improve Mental Clarity
- **Allergies: "Fish, shellfish"**
- Medications: None
- Current Supplements: None

**Expected Results:**
- ✅ Should recommend **Algae-based Omega-3** (NOT fish oil)
- ✅ avoidList should include "Fish Oil - Patient has fish/shellfish allergy"
- ✅ No fish oil or krill oil recommendations

#### Scenario B: Iron Allergy
**Assessment Input:**
- Age: 25
- Gender: Female
- Symptoms: Fatigue (Severe)
- **Allergies: "Iron"**
- Recent Blood Test: "Low iron, anemia"

**Expected Results:**
- ✅ Should NOT recommend iron supplements
- ✅ avoidList should include "Iron - Patient has iron allergy"
- ✅ warnings should include "Iron allergy noted - consult doctor"

#### Scenario C: Soy Allergy
**Assessment Input:**
- Age: 35
- Gender: Male
- Health Goals: Build Muscle
- **Allergies: "Soy"**

**Expected Results:**
- ✅ Should NOT recommend soy-based supplements
- ✅ Should recommend whey or pea protein instead

---

### 3. Test Duplicate Prevention

#### Scenario D: Already Taking Multivitamin
**Assessment Input:**
- Age: 40
- Gender: Female
- Symptoms: Fatigue
- Current Supplements: **"Daily multivitamin"**

**Expected Results:**
- ✅ Should NOT recommend individual B12, Vitamin D, etc.
- ✅ May recommend targeted supplements not in multivitamins (magnesium, omega-3)

#### Scenario E: Already Taking Fish Oil
**Assessment Input:**
- Age: 50
- Gender: Male
- Health Goals: Heart Health
- Current Supplements: **"Fish oil 1000mg daily"**

**Expected Results:**
- ✅ Should NOT recommend omega-3 or fish oil
- ✅ Should recommend other heart health supplements (CoQ10, magnesium)

#### Scenario F: Already Taking Iron
**Assessment Input:**
- Age: 28
- Gender: Female
- Symptoms: Fatigue
- Current Supplements: **"Iron supplement"**
- Recent Blood Test: "Low iron"

**Expected Results:**
- ✅ Should NOT recommend additional iron
- ✅ May suggest checking dosage or absorption tips

---

### 4. Test Blood Test Integration

#### Scenario G: Low Vitamin D
**Assessment Input:**
- Age: 35
- Gender: Male
- Symptoms: Fatigue, Low Mood
- Recent Blood Test: **"Low vitamin D, 15 ng/mL"**

**Expected Results:**
- ✅ Vitamin D3 should be **HIGH priority**
- ✅ Reason should mention "Blood test indicates Vitamin D deficiency"
- ✅ Dosage should be higher (4000 IU vs 2000 IU)
- ✅ triggeredBy should be "Blood test - low Vitamin D"

#### Scenario H: Normal Iron Levels
**Assessment Input:**
- Age: 30
- Gender: Female
- Symptoms: Fatigue
- Recent Blood Test: **"Iron normal, ferritin 50"**

**Expected Results:**
- ✅ Iron should be **LOW priority** or excluded
- ✅ If included, reason should mention "Blood test shows normal levels"
- ✅ Should focus on other causes of fatigue (B12, magnesium, sleep)

#### Scenario I: Low B12
**Assessment Input:**
- Age: 45
- Gender: Female
- Symptoms: Fatigue, Brain Fog
- Recent Blood Test: **"B12 low, 200 pg/mL"**

**Expected Results:**
- ✅ B12 should be **HIGH priority**
- ✅ Reason should mention "Blood test indicates B12 deficiency"
- ✅ Dosage should be higher (2000mcg vs 1000mcg)
- ✅ triggeredBy should be "Blood test - low B12"

---

### 5. Test Medication Interactions

#### Scenario J: On Warfarin (Blood Thinner)
**Assessment Input:**
- Age: 65
- Gender: Male
- Medical Conditions: Heart Disease
- Medications: **"Warfarin"**

**Expected Results:**
- ✅ Should warn about Vitamin K interactions
- ✅ Should warn about high-dose fish oil (>1g)
- ✅ If recommending Vitamin K2, should note "May interact with warfarin - consult doctor"

#### Scenario K: On Metformin
**Assessment Input:**
- Age: 55
- Gender: Female
- Medical Conditions: Type 2 Diabetes
- Medications: **"Metformin"**

**Expected Results:**
- ✅ B12 should be **HIGH priority**
- ✅ Reason should mention "Metformin depletes B12"
- ✅ interactions should note "Critical - metformin depletes B12"

#### Scenario L: On Statin
**Assessment Input:**
- Age: 60
- Gender: Male
- Medical Conditions: High Cholesterol
- Medications: **"Atorvastatin (Lipitor)"**

**Expected Results:**
- ✅ CoQ10 should be **HIGH priority**
- ✅ Reason should mention "Statin medications deplete CoQ10"
- ✅ Dosage should be higher (200-300mg vs 100-200mg)

#### Scenario M: On Thyroid Medication
**Assessment Input:**
- Age: 45
- Gender: Female
- Medical Conditions: Hypothyroidism
- Medications: **"Levothyroxine (Synthroid)"**

**Expected Results:**
- ✅ If recommending calcium or iron, should note "Take 4+ hours away from thyroid medication"
- ✅ Should warn about timing restrictions

---

### 6. Test Combined Scenarios

#### Scenario N: Complex Case
**Assessment Input:**
- Age: 35
- Gender: Female
- Symptoms: Fatigue (Severe), Anxiety, Insomnia
- Health Goals: Boost Immunity, Improve Mental Clarity
- **Allergies: "Fish"**
- **Current Supplements: "Multivitamin"**
- **Recent Blood Test: "Low iron, anemia"**
- Medications: None

**Expected Results:**
- ✅ Iron should be **HIGH priority** (blood test shows deficiency)
- ✅ Should recommend **Algae-based Omega-3** (NOT fish oil due to allergy)
- ✅ Should NOT recommend individual vitamins (already taking multivitamin)
- ✅ Should recommend magnesium for sleep and anxiety
- ✅ avoidList should include "Fish Oil - Patient has fish allergy"

#### Scenario O: Pregnancy with Allergy
**Assessment Input:**
- Age: 28
- Gender: Female
- Pregnancy Status: **Pregnant**
- **Allergies: "Shellfish"**
- Current Supplements: None

**Expected Results:**
- ✅ Should recommend prenatal multivitamin (HIGH priority)
- ✅ Should recommend **Algae-based DHA** (NOT fish oil)
- ✅ Should avoid herbs (ashwagandha, St. John's Wort)
- ✅ avoidList should include fish oil and krill oil

---

## How to Test

### Method 1: Manual Testing via UI
1. Start the development server:
   ```bash
   cd my-react-app
   npm run dev
   ```

2. Start the backend server:
   ```bash
   cd server
   node index.js
   ```

3. Navigate to the assessment page
4. Fill out assessment with test scenario data
5. Review recommendations
6. Test chatbot with questions

### Method 2: API Testing with Postman/Thunder Client

#### Test Recommendation Endpoint
```http
POST http://localhost:5000/api/recommend
Content-Type: application/json

{
  "age": 30,
  "gender": "Female",
  "weight": 65,
  "height": 165,
  "symptoms": ["Fatigue", "Anxiety"],
  "healthGoals": ["Boost Immunity"],
  "allergies": "Fish, shellfish",
  "currentSupplements": "None",
  "recentBloodTest": "Low iron",
  "currentMedications": "None"
}
```

#### Test Chat Endpoint
```http
POST http://localhost:5000/api/chat
Content-Type: application/json

{
  "message": "What is vitamin D?",
  "context": []
}
```

---

## Expected Improvements Checklist

After testing, verify:

### Chatbot
- [ ] Answers "What is vitamin D?" accurately
- [ ] Answers "Can I mix supplements?" with detailed interaction guide
- [ ] Answers "What are signs of deficiency?" comprehensively
- [ ] Rejects off-topic questions appropriately
- [ ] Provides dosage information when asked
- [ ] Provides timing information when asked

### Recommendations
- [ ] Excludes supplements patient is allergic to
- [ ] Adds allergenic supplements to avoidList
- [ ] Provides alternative recommendations for allergies (algae omega-3 for fish allergy)
- [ ] Doesn't recommend supplements already being taken
- [ ] Prioritizes supplements based on blood test results (HIGH for deficiencies)
- [ ] Lowers priority for supplements with normal blood test levels
- [ ] Checks medication interactions (warfarin, metformin, statins, thyroid meds)
- [ ] Includes "triggeredBy" field explaining why supplement was recommended
- [ ] Provides appropriate warnings for allergies and interactions

---

## Common Issues & Solutions

### Issue: Chatbot still gives vague answers
**Solution:** Check that `localFallback()` function in `chat.js` has the SUPPLEMENT_KNOWLEDGE object

### Issue: Allergy checking not working
**Solution:** Verify `hasAllergy()` function is defined at top of `generateClinicalFallback()`

### Issue: Still recommending duplicates
**Solution:** Verify `alreadyTaking()` function is defined and being called before each recommendation

### Issue: Blood test not affecting priority
**Solution:** Verify `bloodTestShows` object is defined and priority adjustment logic is in place

---

## Performance Testing

### Load Testing
Test with multiple concurrent users:
```bash
# Install artillery if not already installed
npm install -g artillery

# Run load test
artillery quick --count 10 --num 5 http://localhost:5000/api/recommend
```

### Response Time
- Chat endpoint should respond in < 2 seconds (fallback) or < 20 seconds (AI)
- Recommend endpoint should respond in < 5 seconds (fallback) or < 30 seconds (AI)

---

## Regression Testing

Ensure existing functionality still works:
- [ ] Assessment form submission
- [ ] User authentication
- [ ] Results page display
- [ ] History page
- [ ] PDF export
- [ ] Email notifications (if implemented)

---

## Bug Reporting Template

If you find issues, report with:

```
**Issue:** [Brief description]

**Test Scenario:** [Which scenario from above]

**Input Data:**
- Age: 
- Gender:
- Allergies:
- Current Supplements:
- Blood Test:
- Medications:

**Expected Result:**
[What should happen]

**Actual Result:**
[What actually happened]

**Screenshots/Logs:**
[Attach if available]
```

---

## Success Criteria

The improvements are successful if:
1. ✅ Chatbot answers 90%+ of supplement questions accurately
2. ✅ 0% of recommendations include allergens
3. ✅ 0% of duplicate supplement recommendations
4. ✅ Blood test deficiencies result in HIGH priority recommendations
5. ✅ Medication interactions are flagged appropriately
6. ✅ Off-topic questions are rejected
7. ✅ Response times remain acceptable

---

**Last Updated:** May 23, 2026
