# Quick Start Testing Guide

## 🚀 Deploy the Fix (2 minutes)

### Step 1: Restart Server
```powershell
# Go to server directory
cd c:\Users\johnr\Downloads\SuppliWise-JDMv7\SuppliWise-JDMv7\server

# Stop current server (Ctrl+C if running)

# Start server
node index.js
```

### Step 2: Clear Browser Cache
- **Chrome:** Press `Ctrl+Shift+Delete` → Check "Cached images and files" → Click "Clear data"
- **OR:** Use Incognito/Private browsing mode

---

## ✅ Run Primary Test (5 minutes)

### Test Profile (Use Exactly This)
```
Age: 30
Gender: Female
Weight: 65 kg
Height: 165 cm
Activity Level: Moderate
Diet: Omnivore

Symptoms (click in ANY order):
- Fatigue
- Excessive Thirst
- Frequent Urination
- Dizziness / Lightheadedness
- Chest Tightness

Severity: All "Moderate"

Health Goals:
- Weight Management
- Muscle Building

Medical Conditions: Diabetes
Medications: Metformin
```

### Test Procedure
1. **Complete Assessment #1** with profile above
2. **View Results** - Note the supplement list and symptom order
3. **Wait 30 seconds** (important for cache)
4. **Complete Assessment #2** with **IDENTICAL** answers
5. **View Results** - Compare with Assessment #1

### ✅ Expected Results (ALL must be true)
- [ ] Symptoms in SAME alphabetical order in both assessments
- [ ] Supplement list IDENTICAL (same items, same order)
- [ ] Lifestyle advice IDENTICAL
- [ ] Server log shows: `[recommend] reusing finalised plan <hash> from assessment <id>`
- [ ] Assessment #2 loads in <1 second (cache hit)

### ❌ If Any Fail
- Check server logs for errors
- Verify both assessments used EXACTLY the same answers
- Ensure you waited 30 seconds between submissions
- Clear browser cache and try again

---

## 🔍 Quick Verification (30 seconds)

### Check Server Logs
Look for these messages after Assessment #2:

```
✅ GOOD: [recommend] reusing finalised plan abc123def456 from assessment 507f1f77bcf86cd799439011
✅ GOOD: Assessment saved to DB, id: 507f1f77bcf86cd799439012

❌ BAD: [recommend] no provider answered
❌ BAD: Using rule-based clinical fallback
```

If you see "BAD" messages, it means:
- Cache miss occurred (check answers match exactly)
- OR AI providers timed out (fallback working as designed, but cache should prevent this)

---

## 📊 Quick Results Check

### Symptom Order Should Be (alphabetically):
1. Chest Tightness
2. Dizziness / Lightheadedness
3. Excessive Thirst
4. Fatigue
5. Frequent Urination

### Top Supplements Should Include (in order):
1. Omega-3 (for heart health)
2. Magnesium (for blood pressure)
3. Vitamin D3 (general support)
4. Vitamin B12 (Metformin depletes it)
5. Berberine OR Alpha-Lipoic Acid (diabetes support)

*Note: Exact list depends on rule engine, but order is consistent*

---

## 🎨 Visual Consistency Check

### Lifestyle Recommendations Section
- **Color:** Light green gradient (#ecfdf5 to #f0fdfa)
- **Cards:** Should all be the SAME green color

### Meal Recommendations Section  
- **Color:** Light orange/yellow gradient (#fff7ed to #fffbeb)
- **Cards:** Should all be the SAME orange color

**Important:** Don't confuse lifestyle cards (green) with meal cards (orange)!

---

## 🐛 Troubleshooting

### Problem: Symptoms still in different order
**Solution:** 
- Clear browser cache completely
- Restart server
- Try Incognito mode

### Problem: Supplements different on second assessment
**Check:**
1. Did you use EXACTLY the same answers?
2. Did you wait 30 seconds between submissions?
3. Look at server logs - is there a cache hit message?

### Problem: Server crashes or errors
**Check:**
- Is MongoDB running?
- Are all dependencies installed? (`npm install`)
- Check server logs for specific error messages

### Problem: "Reusing finalised plan" but results different
**This is impossible** - if this happens:
1. Take screenshots of both results
2. Check if browser cached the HTML (hard refresh: Ctrl+Shift+R)
3. Report as a bug with screenshots

---

## 📞 Success Indicators

### ✅ Fix is Working if:
- Same symptom order in both assessments
- Cache hit message in server logs
- Second assessment loads in <1 second
- Results 100% identical

### ⚠️ Acceptable Variation:
- First assessment takes 5-10 seconds (AI generation)
- Different supplements if you changed ANY input
- Provider fallback messages (system designed to handle this)

### ❌ Fix is NOT Working if:
- Same inputs produce different symptom orders
- No cache hit message for identical inputs
- Both assessments take 5-10 seconds (no caching)

---

## 📄 Full Documentation

See `CONSISTENCY_FIX_REPORT.md` for:
- Complete root cause analysis
- All 7 test protocols
- Architecture details
- Rollback instructions
- Known limitations

---

## ⏱️ Time Estimates

- Deploy fix: 2 minutes
- Run primary test: 5 minutes
- Run all tests: 30 minutes
- **Total minimum:** 7 minutes to verify core fix

---

## 🎯 One-Sentence Summary

**Identical assessment inputs now produce identical results with consistent symptom ordering across all views.**

---

*Quick Start Guide | October 21, 2026*
