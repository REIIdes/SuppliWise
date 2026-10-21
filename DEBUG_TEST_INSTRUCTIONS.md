# Debug Test: Why Cache Isn't Hitting

## What We Added

Enhanced logging in `server/routes/recommend.js` to show:
- Computed signature
- Cache lookup result
- Canonicalized multi-select fields (symptoms, healthGoals, medicalConditions)
- Weight and updatedFrom values

## How to Test

### 1. Restart Server with New Logging
```powershell
cd server
node index.js
```

**Watch for these log messages:**
```
[recommend] DEBUG - Canonicalized multi-select fields:
  symptoms: ["Chest Tightness","Fatigue"]
  healthGoals: ["Improve Strength","Increase Energy"]
  medicalConditions: ["Anemia","Diabetes","Hypertension (High Blood Pressure)"]
  weight: 65   updatedFrom: not set
[recommend] computed signature: 0945e208464c0c043801742e for user 6ad8c5c414b795a859c13ea4
[recommend] cache lookup: no match
[recommend] ❌ CACHE MISS - generating fresh plan (signature: 0945e208464c0c043801742e)
```

### 2. Submit First Assessment
1. Go to Assessment page
2. Fill form with these exact values:
   - Age: 21, Male
   - Height: 166cm, Weight: 65kg
   - Symptoms: **Fatigue**, **Chest Tightness** (order doesn't matter)
   - Health Goals: **Increase Energy**, **Improve Strength** (order doesn't matter)
   - Medical Conditions: **Diabetes**, **Anemia**, **Hypertension**
3. Submit

**Expected Logs:**
```
[recommend] DEBUG - Canonicalized multi-select fields:
  symptoms: ["Chest Tightness","Fatigue"]  ← alphabetically sorted
  healthGoals: ["Improve Strength","Increase Energy"]  ← alphabetically sorted
  ...
[recommend] computed signature: XXXXXXXXXXXXXXXXXXXXXXXX
[recommend] cache lookup: no match  ← First time
[recommend] ❌ CACHE MISS - generating fresh plan
```

### 3. Click "Update Health Assessment"
1. After results load, go to History page
2. Find your active assessment
3. Click "Update Health Assessment"
4. Form pre-fills with your previous answers
5. **Don't change anything** - just click Next → Next → Submit

**Expected Logs (SHOULD be cache hit):**
```
[recommend] DEBUG - Canonicalized multi-select fields:
  symptoms: ["Chest Tightness","Fatigue"]  ← SAME as before
  healthGoals: ["Improve Strength","Increase Energy"]  ← SAME as before
  ...
  updatedFrom: 6ad8d999cebcf095d7fde999  ← ID of previous assessment
[recommend] computed signature: XXXXXXXXXXXXXXXXXXXXXXXX  ← SAME signature
[recommend] cache lookup: found assessment 6ad8d999...
[recommend] ✅ CACHE HIT - reusing finalised plan
```

**If it shows CACHE MISS:**
```
[recommend] ❌ CACHE MISS - generating fresh plan (signature: YYYYYYYYYYYYYYYYYYYYYYYY)
                                                              ↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑
                                                              DIFFERENT signature!
```

### 4. What to Look For

#### ✅ SUCCESS Indicators:
- First submission: `CACHE MISS` (expected)
- Second submission (Update): `✅ CACHE HIT`
- Arrays are alphabetically sorted: `["Chest Tightness","Fatigue"]` not `["Fatigue","Chest Tightness"]`
- Signature is identical on both submissions
- Response time: <1 second on cache hit

#### ❌ FAILURE Indicators:
- Update shows `❌ CACHE MISS`
- Signatures are DIFFERENT
- Arrays in different order between submissions
- `updatedFrom` appears in signature computation (it shouldn't)

### 5. Compare Signatures

**If cache misses, copy both signatures and compare them:**

First submission:
```
[recommend] computed signature: 0945e208464c0c043801742e
```

Second submission (Update):
```
[recommend] computed signature: b3ecab2b69f04e112159d540  ← DIFFERENT!
```

**Then look at the canonicalized fields above each signature:**
- Are the arrays in the same order?
- Are all values identical?
- Is weight the same?
- Is anything unexpectedly different?

### 6. Test Different Symptom Order

To verify sorting is working:

1. Submit assessment with symptoms: **Fatigue**, **Chest Tightness**
2. Note the signature in logs
3. Submit again with symptoms: **Chest Tightness**, **Fatigue**
4. **Should show CACHE HIT** (same signature)

If cache misses, the sorting isn't working.

---

## Common Issues

### Issue 1: Signatures Always Different
**Symptom:** Every submission generates new signature  
**Cause:** Something in the data is changing (timestamp, random ID, etc.)  
**Solution:** Check DEBUG logs - compare what's different between submissions

### Issue 2: Arrays Not Sorted
**Symptom:** Logs show `["Fatigue","Chest Tightness"]` then `["Chest Tightness","Fatigue"]`  
**Cause:** Canon icalization not sorting  
**Solution:** Verify `answerCanonical.js` has `.sort()` on line 98-101

### Issue 3: updatedFrom Affecting Signature
**Symptom:** Different signatures when `updatedFrom` present vs absent  
**Cause:** `updatedFrom` not in VOLATILE_FIELDS  
**Solution:** Already fixed in `planSelection.js` line 162

### Issue 4: Cache Found But No Recommendations
**Symptom:** Logs show "found assessment" but still generates fresh  
**Cause:** Prior assessment has no saved aiResults  
**Solution:** Expected on first run after version bump

---

## Expected Timeline

**First Test (after server restart):**
- Submit #1: 8-12 seconds (MISS - generating)
- Submit #2 (Update, no changes): **<1 second (HIT - cached)**

**Subsequent Tests:**
- All identical submissions: <1 second (HIT)
- Changed weight: 8-12 seconds (MISS - correct behavior)

---

## If Cache Still Not Hitting

Share these logs:
1. Full `[recommend] DEBUG` output from both submissions
2. Both computed signatures
3. The "cache lookup" result
4. Any differences in the canonicalized fields

This will show us exactly what's changing between submissions.
