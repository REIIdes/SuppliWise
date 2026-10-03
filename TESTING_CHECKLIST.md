# Testing Checklist - Dashboard Functional Update

Use this checklist to verify all features are working correctly.

---

## 🔧 Pre-Testing Setup

### Backend Setup
- [ ] MongoDB is running
- [ ] `.env` file exists in `server/` folder
- [ ] All environment variables configured:
  - [ ] `MONGO_URI`
  - [ ] `JWT_SECRET`
  - [ ] `OPENROUTER_API_KEY`
- [ ] Server starts without errors: `cd server && npm start`
- [ ] Server console shows: "Connected to MongoDB" and "Server running on port 5000"

### Frontend Setup
- [ ] Frontend starts without errors: `cd my-react-app && npm run dev`
- [ ] Browser opens to `http://localhost:5173`
- [ ] No console errors on initial load

---

## ✅ Feature Testing

### 1. User Registration & Login
- [ ] Can register a new user
- [ ] Can login with credentials
- [ ] Token saved to localStorage
- [ ] Redirected to dashboard after login

### 2. First Assessment Flow
**Steps:**
1. Navigate to Assessment page
2. Complete all 4 steps
3. Submit assessment

**Expected Results:**
- [ ] Assessment saves successfully
- [ ] Redirected to Results page
- [ ] AI generates 20 recommendations
- [ ] Results display properly
- [ ] "View Dashboard" button appears

### 3. Dashboard - First Load
**Steps:**
1. Click "View Dashboard" or navigate to `/dashboard`

**Expected Results:**
- [ ] Page loads without errors
- [ ] Welcome message shows user's name
- [ ] Today's supplements section populated with recommendations
- [ ] Supplements show dosage and scheduled time
- [ ] Initial stats displayed:
  - [ ] Wellness Score: 0
  - [ ] Days Streak: 0 Days
  - [ ] Adherence rate: 0%
  - [ ] Energy: Medium
  - [ ] Today's Progress: 0/X (X = number of supplements)
- [ ] All supplements have "Mark Taken" button
- [ ] No "taken" badges visible yet

### 4. Mark Supplement as Taken
**Steps:**
1. Click "Mark Taken" on first supplement

**Expected Results:**
- [ ] Supplement immediately shows:
  - [ ] "taken" badge with checkmark
  - [ ] "Taken at HH:MM AM/PM" timestamp
  - [ ] Button changes to "Undo"
  - [ ] Supplement moves to bottom of list
- [ ] Stats update instantly:
  - [ ] Today's Progress: 1/X (e.g., 14%)
  - [ ] Adherence rate increases
  - [ ] Wellness score increases

### 5. Undo Functionality
**Steps:**
1. Click "Undo" on taken supplement

**Expected Results:**
- [ ] Supplement returns to untaken state
- [ ] "taken" badge disappears
- [ ] Button changes back to "Mark Taken"
- [ ] Supplement moves back to top
- [ ] Stats revert to previous values

### 6. Complete All Supplements (Streak Test)
**Steps:**
1. Mark ALL supplements as taken
2. Wait for updates

**Expected Results:**
- [ ] Today's Progress: X/X (100%)
- [ ] Adherence rate updates
- [ ] Days Streak increments to 1
- [ ] Wellness score increases
- [ ] All supplements show "taken" badge

### 7. Track Intake Page
**Steps:**
1. Navigate to Track Intake page

**Expected Results:**
- [ ] Page loads successfully
- [ ] Shows same supplements as Dashboard
- [ ] Taken status matches Dashboard
- [ ] Streak displayed matches Dashboard
- [ ] Adherence percentage shown
- [ ] Calendar displays current month
- [ ] Current day highlighted

**Additional Tests:**
- [ ] Can mark supplements taken from Track Intake
- [ ] Can undo from Track Intake
- [ ] Stats update in sync with Dashboard

### 8. Recommendations Page
**Steps:**
1. Navigate to Recommendations page

**Expected Results:**
- [ ] Shows 20 recommendations
- [ ] Each recommendation card shows:
  - [ ] Supplement name and dosage
  - [ ] Timing instructions
  - [ ] Priority badge (High/Medium/Low)
  - [ ] Reason for recommendation
  - [ ] Confidence score
- [ ] Filter buttons work (All/High/Medium/Low)
- [ ] Click on supplement shows detail view

### 9. Insights Page - Initial State
**Steps:**
1. Navigate to Insights page

**Expected Results:**
- [ ] Overview tab displays:
  - [ ] Stats cards with real numbers
  - [ ] Current phase card with AI guidance
  - [ ] Lifestyle recommendations
- [ ] Adherence tab shows:
  - [ ] Recent adherence pattern graph
  - [ ] Wellness journey phases list
- [ ] Energy & Sleep tab shows "Coming Soon" message
- [ ] AI Insight tab shows:
  - [ ] Current phase with AI badge
  - [ ] Action steps
  - [ ] Expected changes
  - [ ] Lifestyle tips

### 10. History Page
**Steps:**
1. Navigate to History page

**Expected Results:**
- [ ] Shows assessment card
- [ ] Displays creation date
- [ ] Shows number of recommendations
- [ ] Can click to view details
- [ ] Can delete assessment (with confirmation)

### 11. NEW ASSESSMENT RESET TEST ⚠️ CRITICAL
**Steps:**
1. Note current dashboard stats (e.g., Streak: 1, Adherence: 100%)
2. Navigate to Assessment page
3. Complete a NEW assessment (different answers)
4. Return to Dashboard

**Expected Results - Dashboard Must Reset:**
- [ ] ✅ NEW supplements displayed (from new assessment)
- [ ] ✅ OLD supplements NOT visible
- [ ] ✅ Wellness Score reset to 0
- [ ] ✅ Days Streak reset to 0
- [ ] ✅ Adherence rate reset to 0%
- [ ] ✅ Today's Progress reset to 0/X
- [ ] ✅ All supplements show "Mark Taken" (none taken yet)

**Expected Results - History Preservation:**
- [ ] ✅ History page shows BOTH assessments
- [ ] ✅ Old assessment still viewable
- [ ] ✅ Old recommendations still accessible

### 12. Persistence Test (Refresh Page)
**Steps:**
1. Mark some supplements as taken
2. Note the stats
3. Refresh the page (F5 or Ctrl+R)

**Expected Results:**
- [ ] Supplements still show as taken
- [ ] Stats remain the same
- [ ] No data loss
- [ ] Page loads with correct state

### 13. Multi-Day Streak Test
**Steps:**
1. Mark all supplements taken today
2. Verify streak = 1
3. NEXT DAY: Return to dashboard
4. Mark all supplements taken again

**Expected Results:**
- [ ] Streak increments to 2
- [ ] Continues incrementing each consecutive day
- [ ] If a day is skipped, streak resets to 0

### 14. Empty State Tests

**Test 14a: No Assessment**
1. Login with brand new user (no assessment)
2. Navigate to Dashboard

**Expected:**
- [ ] Shows message: "No assessment found..."
- [ ] Shows button to take assessment

**Test 14b: No Tracking Data (Insights)**
1. Complete assessment but don't track anything
2. Navigate to Insights

**Expected:**
- [ ] Shows message: "Not enough tracking data yet..."
- [ ] Shows button to start tracking

---

## 🔍 Error Scenarios

### Test 1: Network Error
**Steps:**
1. Stop backend server
2. Try marking supplement as taken

**Expected:**
- [ ] Error caught gracefully
- [ ] UI reverts to previous state
- [ ] Error message shown (in console or alert)

### Test 2: Invalid Token
**Steps:**
1. Clear localStorage
2. Try accessing Dashboard

**Expected:**
- [ ] Redirected to login page
- [ ] No crash or error screen

### Test 3: Missing Assessment ID
**Steps:**
1. Manually delete assessment from database
2. Try loading Dashboard

**Expected:**
- [ ] "No assessment found" message
- [ ] Button to take assessment
- [ ] No crash

---

## 📊 Database Verification

### Collections to Check
Open MongoDB Compass or mongo shell and verify:

**assessments Collection:**
- [ ] Assessment documents exist
- [ ] Each has `aiResults` field with recommendations
- [ ] `createdAt` timestamp present

**dashboardmetrics Collection:**
- [ ] One document per assessment per user
- [ ] `isActive: true` for latest assessment only
- [ ] Stats match what's shown on Dashboard

**intakerecords Collection:**
- [ ] Records created when supplements marked taken
- [ ] `dayKey` field in "YYYY-MM-DD" format
- [ ] `taken` field updated correctly
- [ ] `takenAt` timestamp when supplement taken

---

## 🎯 Performance Checks

### Load Time Tests
- [ ] Dashboard loads in < 500ms
- [ ] Mark supplement updates in < 200ms
- [ ] Insights page loads in < 500ms
- [ ] Track Intake loads in < 500ms

### Responsiveness
- [ ] No lag when clicking buttons
- [ ] Smooth transitions between pages
- [ ] No loading spinners that hang

---

## 🔐 Security Checks

### Authentication
- [ ] Cannot access Dashboard without login
- [ ] Cannot access Track Intake without login
- [ ] Cannot access Insights without login
- [ ] Token expires appropriately

### Authorization
- [ ] Users only see their own data
- [ ] Cannot access other users' assessments
- [ ] API returns 401 for invalid tokens

---

## 🐛 Common Issues & Solutions

### Issue: Supplements not showing
**Check:**
- [ ] Assessment has `aiResults.recommendations` array
- [ ] Recommendations not empty
- [ ] API returning data in correct format

### Issue: Stats not updating
**Check:**
- [ ] Backend running
- [ ] Network requests succeeding (check Network tab)
- [ ] DashboardMetrics document exists
- [ ] No console errors

### Issue: Streak not incrementing
**Verify:**
- [ ] ALL supplements marked as taken (100%)
- [ ] Previous day was completed
- [ ] `lastTrackedDate` in DashboardMetrics correct

### Issue: Old supplements showing after new assessment
**Fix:**
- [ ] Clear browser cache
- [ ] Check `isActive` flag in DashboardMetrics
- [ ] Verify assessment POST route ran successfully

---

## ✨ Bonus Features to Test

### Edge Cases
- [ ] What if user takes 3rd assessment? (Should reset again)
- [ ] What if user undoes all supplements? (Streak should reset)
- [ ] What if daylight saving time changes? (Check timezone handling)
- [ ] What if assessment has 0 recommendations? (Should show empty state)

---

## 📝 Test Report Template

```
Date: _____________
Tester: _____________
Environment: Development / Staging / Production

PASSED: ___/50 tests
FAILED: ___/50 tests
BLOCKED: ___/50 tests

Critical Issues Found:
1. 
2. 
3. 

Minor Issues Found:
1. 
2. 
3. 

Notes:


Sign-off: _____________
```

---

## 🎉 Success Criteria

All tests must pass for production readiness:

- [ ] ✅ All 50+ test cases pass
- [ ] ✅ No console errors
- [ ] ✅ No network errors
- [ ] ✅ Database properly populated
- [ ] ✅ Performance targets met
- [ ] ✅ Security checks pass
- [ ] ✅ Empty states handled
- [ ] ✅ Error scenarios graceful

---

## 🚀 Ready for Production When:

- [ ] Testing checklist 100% complete
- [ ] All critical bugs fixed
- [ ] Performance acceptable
- [ ] Security verified
- [ ] Documentation reviewed
- [ ] Backup strategy in place

---

**Good luck with testing! 🎊**

If you find any issues, refer to:
- `DASHBOARD_FUNCTIONAL_UPDATE.md` for technical details
- `QUICK_START_GUIDE.md` for setup help
- Server logs for backend errors
- Browser console for frontend errors
