# Quick Test Guide: Update Health Assessment Consistency

## 🚀 Deploy (2 minutes)

```powershell
# 1. Restart server
cd c:\Users\johnr\Downloads\SuppliWise-JDMv7\SuppliWise-JDMv7\server
# Stop current server (Ctrl+C)
node index.js

# 2. Verify fix
node test-update-consistency.js
# Should see: 🎉 ALL TESTS PASSED!
```

## ✅ Primary Test (5 minutes)

### Test: Update Assessment Twice with Identical Data

**Step 1:** Complete a new assessment
```
Age: 30
Gender: Female  
Weight: 65kg
Height: 165cm
Symptoms: Fatigue, Dizziness, Chest Tightness (click in any order)
Goals: Increase Energy, Muscle Gain (click in any order)
→ Submit
→ View results
→ Note supplements and symptom order
```

**Step 2:** Update that assessment (don't change anything)
```
From History page → Click "Update Health Assessment"
Form is pre-filled
Don't change anything
→ Submit
```

**Step 3:** Check server console
```
Look for this message:
[recommend] reusing finalised plan <hash> from assessment <id>
```

**Step 4:** Update again (don't change anything)
```
From History → Click "Update Health Assessment" again
Don't change anything
→ Submit
```

### ✅ Expected Results (ALL must be true):

- [ ] Step 1 takes 5-10 seconds (AI generation)
- [ ] Step 2 takes <1 second (cache hit) ⚡
- [ ] Step 3 console shows cache hit message
- [ ] Step 4 takes <1 second (cache hit again) ⚡
- [ ] All three results show IDENTICAL supplements
- [ ] Symptoms in SAME order across all three
- [ ] Goals in SAME order across all three

### ❌ If Test Fails:

**Problem:** Step 2 or 4 takes 5-10 seconds

**Diagnosis:**
1. Check server console for cache hit message
2. If no message: Fix didn't apply, check `planSelection.js`
3. If AI generation message: Cache missed, check answers are truly identical

**Problem:** Results different

**Check:**
1. Did you change ANY field? (Even whitespace counts)
2. Server logs show cache hit but results differ? (Should be impossible)
3. Browser cached old HTML? (Hard refresh: Ctrl+Shift+R)

---

## 🧪 Additional Quick Tests

### Test A: New vs Update (Same Data)

```
1. Complete new assessment with profile A
2. Update that assessment, keep everything same
3. Compare results

Expected:
✅ Update instant (<1s)
✅ Results identical
```

### Test B: Weight Change

```
1. Assessment with 65kg
2. Update to 66kg
3. Update back to 65kg

Expected:
✅ Step 1: New AI (5-10s)
✅ Step 2: New AI (weight changed)
✅ Step 3: Cache hit! (<1s, reuses Step 1)
```

### Test C: PDF Consistency

```
1. Complete assessment
2. Export PDF → Save as Test1.pdf
3. Export PDF again → Save as Test2.pdf
4. Compare files

Expected:
✅ 100% identical content
✅ Same symptom order
✅ Same supplement order
```

---

## 📊 Success Indicators

### ✅ Fix Working:
- Update with identical data → <1 second
- Console shows cache hit message
- Results 100% identical
- PDF exports identical

### ⚠️ Expected Behavior:
- Update with changed data → 5-10 seconds (AI runs, correct)
- First assessment always → 5-10 seconds (no cache yet, correct)

### ❌ Fix NOT Working:
- Update with identical data → 5-10 seconds (should be <1s)
- No cache hit message in console
- Results vary between identical updates

---

## 🔧 Troubleshooting

### Server logs: "no provider answered" or "Using rule-based fallback"
**This is OK!** If all AI providers are down, the system falls back to rule-based recommendations. These are still consistent and cached.

### Server logs: "finalised-plan lookup failed"
**Check MongoDB** is running. Cache lookups need database access.

### Results still different
**Check browser cache.** Clear it completely or use Incognito mode.

### Update still slow
**Check actual answers.** Use browser DevTools → Network → Payload to verify:
- All fields identical
- No unexpected whitespace differences
- Symptom arrays in ANY order (backend will sort them)

---

## 📝 Test Checklist

Run through these and check off:

- [ ] Unit tests pass (`node test-update-consistency.js`)
- [ ] Server restarted
- [ ] Browser cache cleared
- [ ] Primary test: Update twice with identical data (both instant)
- [ ] Console shows cache hit messages
- [ ] Results identical across updates
- [ ] Symptoms sorted consistently
- [ ] PDF exports identical

If ALL checked ✅ → **Fix working perfectly!**

If ANY failed ❌ → See troubleshooting section

---

## 🎯 One-Minute Smoke Test

**Fastest way to verify fix is working:**

```
1. Complete assessment
2. Update it immediately (don't change anything)
3. Check response time

✅ <1 second = Fix working
❌ 5-10 seconds = Fix not applied or cache missed
```

---

*See UPDATE_ASSESSMENT_FIX_REPORT.md for complete documentation*
