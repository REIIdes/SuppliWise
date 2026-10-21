# AI Consistency Fix - Final Status (October 21, 2026)

## Summary

Implemented fixes for AI consistency issues in Update Health Assessment flow. The root cause was **multi-select fields not being sorted** before signature computation, causing identical clinical data to produce different cache keys.

---

## Changes Made

### 1. Multi-Select Field Sorting (`answerCanonical.js`)
**File:** `server/utils/answerCanonical.js`  
**Lines:** 84 (symptomSeverity keys), 98-101 (LIST_FIELDS)

```javascript
// Sort symptomSeverity object keys
const sortedSymptoms = Object.keys(value).sort((a, b) => a.localeCompare(b));

// Sort all multi-select arrays
out[field] = raw
  .map((entry) => (typeof entry === 'string' ? canonical(field, entry) : entry))
  .filter((entry) => typeof entry !== 'string' || entry.length > 0)
  .sort((a, b) => String(a).localeCompare(String(b)));
```

**Affects:** symptoms, healthGoals, medicalConditions, lifestyleHabits

### 2. Version Bump (`planSelection.js`)
**File:** `server/utils/planSelection.js`  
**Line:** ~158

```javascript
// Invalidates all old cached plans (created before sorting fix)
const SELECTION_RULES_VERSION = 'spine-2-sorted';
```

**Why:** Old assessments have unsorted arrays → old signature format. Version bump forces fresh generation with new sorted format.

### 3. Enhanced Logging (`recommend.js`)
**File:** `server/routes/recommend.js`  
**Lines:** ~340, ~410-418

```javascript
// DEBUG: Log canonicalized fields
console.log('[recommend] DEBUG - Canonicalized multi-select fields:');
console.log('  symptoms:', JSON.stringify(answers.symptoms));
console.log('  healthGoals:', JSON.stringify(answers.healthGoals));

// Enhanced cache logging
console.log(`[recommend] computed signature: ${signature} for user ${req.user?._id}`);
console.log(`[recommend] cache lookup: ${prior ? `found assessment ${prior._id}` : 'no match'}`);
console.log(`[recommend] ✅ CACHE HIT` or `❌ CACHE MISS - generating fresh plan`);
```

**Purpose:** Diagnose why cache isn't hitting during testing

---

## Expected Behavior

### Scenario 1: First Submission (After Restart)
```
User: Submits assessment
System: No cached plan exists (old signatures invalid)
Action: Generates fresh AI plan (~8-12 seconds)
Stores: Plan with signature "0945e208464c0c043801742e"
```

### Scenario 2: Update Health Assessment (No Changes)
```
User: Clicks "Update Health Assessment" → Submits without changes
System: Computes signature "0945e208464c0c043801742e"
Lookup: Finds prior assessment with same signature
Action: Returns cached plan instantly (<1 second)
Result: Identical recommendations, identical PDF
```

### Scenario 3: Different Selection Order
```
User A: Selects [Fatigue, Chest Tightness]
User B: Selects [Chest Tightness, Fatigue]
Canonical: Both become ["Chest Tightness", "Fatigue"] (sorted)
Result: Same signature → Cache hit (if already generated)
```

### Scenario 4: Actual Clinical Change
```
User: Changes weight from 65kg → 66kg
System: Different data → Different signature
Action: Generates fresh plan (correct behavior)
```

---

## Testing Status

### Automated Tests
✅ **test-consistency-final.js** - All 6 tests passing:
1. Identical submissions → Same signature
2. Different symptom order → Same signature (sorted)
3. updatedFrom field → Same signature (volatile)
4. Weight change → Different signature (correct)
5. Health goals order → Same signature (sorted)
6. Medical conditions order → Same signature (sorted)

### Manual Testing Required
⏳ **Awaiting user testing with enhanced logging**

Follow `DEBUG_TEST_INSTRUCTIONS.md` to:
1. Restart server with new logging
2. Submit first assessment
3. Update assessment without changes
4. Verify cache hit in logs
5. Verify instant response (<1s)
6. Verify identical PDF exports

---

## Current Issue

**User reports:** Update Health Assessment still generating new plans, not consistent

**Possible causes:**
1. ❓ Server not restarted with new code
2. ❓ Browser cache not cleared
3. ❓ Data actually changing between submissions (hidden fields, timestamps)
4. ❓ Something else in payload affecting signature
5. ❓ Frontend sending data in different format on updates

**Next step:** Run with enhanced logging to see exact data being received and computed signatures

---

## Debug Logs to Check

When you test, watch for these in server console:

### ✅ Good (Cache Hit):
```
[recommend] DEBUG - Canonicalized multi-select fields:
  symptoms: ["Chest Tightness","Fatigue"]
  healthGoals: ["Improve Strength","Increase Energy"]
  medicalConditions: ["Anemia","Diabetes","Hypertension (High Blood Pressure)"]
  weight: 65   updatedFrom: 6ad8d999cebcf095d7fde999

[recommend] computed signature: 0945e208464c0c043801742e for user 6ad8c5c414b795a859c13ea4
[recommend] cache lookup: found assessment 6ad8d999cebcf095d7fde999
[recommend] ✅ CACHE HIT - reusing finalised plan 0945e208464c0c043801742e from assessment 6ad8d999...
```

### ❌ Bad (Cache Miss):
```
[recommend] DEBUG - Canonicalized multi-select fields:
  symptoms: ["Chest Tightness","Fatigue"]
  healthGoals: ["Improve Strength","Increase Energy"]
  medicalConditions: ["Anemia","Diabetes","Hypertension (High Blood Pressure)"]
  weight: 65   updatedFrom: 6ad8daabbccddeeffe123456  ← Different ID

[recommend] computed signature: b3ecab2b69f04e112159d540 for user 6ad8c5c414b795a859c13ea4
                                ^^^^^^^^^^^^^^^^^^^^^^^^ DIFFERENT signature
[recommend] cache lookup: no match
[recommend] ❌ CACHE MISS - generating fresh plan (signature: b3ecab2b69f04e112159d540)
```

**Compare signatures:** If they're different, look at what changed in the DEBUG output above them

---

## Files Modified

1. ✅ `server/utils/answerCanonical.js` - Sorting fix
2. ✅ `server/utils/planSelection.js` - Version bump + updatedFrom volatile
3. ✅ `server/routes/recommend.js` - Enhanced logging

## Files Created

1. `server/test-canonical-sorting.js` - Unit tests for sorting
2. `server/test-update-consistency.js` - Unit tests for update flow
3. `server/test-consistency-final.js` - Complete test suite
4. `server/test-update-signature-debug.js` - Database diagnostic
5. `CONSISTENCY_FIX_REPORT.md` - Original fix documentation
6. `UPDATE_ASSESSMENT_FIX_REPORT.md` - Update flow analysis
7. `CONSISTENCY_FIX_VERSION_BUMP.md` - Version bump documentation
8. `DEBUG_TEST_INSTRUCTIONS.md` - Testing guide with logging
9. `CONSISTENCY_FIX_FINAL_STATUS.md` - This file

---

## Next Actions

### For You (Testing)
1. ✅ Restart server: `cd server; node index.js`
2. ✅ Clear browser cache
3. ✅ Submit new assessment (will be slow - cache miss expected)
4. ✅ Copy server logs showing DEBUG output + signature
5. ✅ Click "Update Health Assessment" - submit without changes
6. ✅ Copy server logs again
7. ✅ Compare signatures - should be identical
8. ✅ If cache misses, share both log outputs

### For Me (If Still Broken)
1. ⏳ Analyze actual data being sent
2. ⏳ Find what's different between submissions
3. ⏳ Fix the root cause
4. ⏳ Test again

---

## Success Criteria

- [x] Automated tests pass (6/6)
- [x] Sorting implemented
- [x] Version bumped
- [x] Volatile fields configured
- [x] Enhanced logging added
- [ ] Cache hits on identical submissions (manual test)
- [ ] Update Health Assessment instant (<1s)
- [ ] PDFs identical
- [ ] User confirms consistency

---

## Theory vs Reality

### Theory (How It Should Work)
1. User submits assessment
2. Backend canonicalizes (sorts arrays)
3. Computes signature from sorted data
4. Checks cache for signature
5. HIT: Returns cached plan
6. MISS: Generates fresh, stores with signature

### Reality (What User Reports)
- Update Health Assessment always generates new plans
- Results not consistent
- Taking 8-12 seconds every time (no cache hits)

### Gap
- ❓ Something between theory and reality
- Need logs to identify what's actually happening
- Enhanced logging will show us the truth

---

## Rollback Plan

If this breaks something:

```javascript
// In planSelection.js, revert to:
const SELECTION_RULES_VERSION = 'spine-1';

// In answerCanonical.js, remove .sort() calls
out[field] = raw
  .map((entry) => (typeof entry === 'string' ? canonical(field, entry) : entry))
  .filter((entry) => typeof entry !== 'string' || entry.length > 0);
  // .sort((a, b) => String(a).localeCompare(String(b)));  ← Remove this

// Restart server
```

---

**Status:** ✅ Code changes complete, ⏳ awaiting manual testing with enhanced logs  
**Date:** October 21, 2026  
**Version:** spine-2-sorted  
**Next:** Share server logs from Update Health Assessment test
