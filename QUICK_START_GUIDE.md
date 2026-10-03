# Quick Start Guide - Dashboard Functional Update

## 🚀 Getting Started

### Prerequisites
- MongoDB running
- Node.js installed
- All environment variables configured (`.env` in server folder)

### Starting the Application

#### 1. Start Backend Server
```bash
cd server
npm start
```
The server should start on `http://localhost:5000`

#### 2. Start Frontend
```bash
cd my-react-app
npm run dev
```
The frontend should start on `http://localhost:5173`

---

## ✅ What Was Implemented

### Core Features
1. **100% Real Data** - All mock data removed
2. **Latest Assessment Integration** - Dashboard only shows current assessment
3. **Automatic Reset** - New assessment automatically resets all tracking
4. **Real-Time Updates** - Marking supplements updates stats instantly
5. **AI Insights** - Phase guidance and lifestyle tips from AI

### Pages Updated
- ✅ Dashboard Page (fully functional)
- ✅ Track Intake Page (fully functional)
- ✅ Recommendations Page (already working)
- ✅ Insights Page (fully functional)
- ✅ History Page (no changes needed)

---

## 📊 Testing the Implementation

### Test Scenario 1: First Time User
1. Register/Login
2. Complete an assessment
3. Navigate to Dashboard
4. **Expected Results:**
   - See supplements from assessment
   - Stats all at 0 (streak, adherence, wellness score)
   - Can mark supplements as taken
   - Stats update in real-time

### Test Scenario 2: Mark Supplements Taken
1. Go to Dashboard or Track Intake
2. Click "Mark Taken" on a supplement
3. **Expected Results:**
   - Supplement moves to bottom with "taken" badge
   - Today's progress updates (e.g., 1/7 → 14%)
   - Overall adherence percentage updates
   - Wellness score recalculates
4. Click "Undo"
5. **Expected Results:**
   - Supplement returns to pending state
   - Stats revert

### Test Scenario 3: Complete All Supplements (Streak)
1. Mark ALL supplements as taken for today
2. **Expected Results:**
   - Today's progress → 100%
   - Streak increments to 1
   - Wellness score increases
3. Next day, mark all supplements again
4. **Expected Results:**
   - Streak increments to 2
   - Continues each consecutive day

### Test Scenario 4: New Assessment Reset
1. Have an active assessment with some tracking data
2. Note current stats (e.g., streak: 5, adherence: 85%)
3. Complete a NEW assessment
4. Navigate back to Dashboard
5. **Expected Results:**
   - Streak reset to 0
   - Adherence reset to 0%
   - Today's Progress reset to 0/X
   - NEW supplements from new assessment shown
   - OLD supplements NOT visible (but in History)

### Test Scenario 5: Insights Page
1. Go to Insights page
2. If no tracking data:
   - **Expected:** "Not enough tracking data" message
3. After tracking supplements:
   - **Expected:**
     - Overview tab: Stats cards with real numbers
     - Current phase from AI action plan
     - Lifestyle advice
   - Adherence tab: 7-day trend graph
   - AI Insight tab: Phase guidance and tips

---

## 🔍 API Endpoints Reference

### Dashboard Endpoints
```
GET  /api/dashboard           → Get dashboard data
POST /api/dashboard/intake    → Mark supplement taken/undo
POST /api/dashboard/energy    → Update energy level
```

### Insights Endpoint
```
GET  /api/insights            → Get AI insights and trends
```

### Existing Endpoints (Unchanged)
```
POST /api/assessment          → Create new assessment (now resets dashboard)
GET  /api/assessment/history  → Get assessment history
GET  /api/assessment/me       → Get latest assessment
POST /api/recommend           → Generate AI recommendations
```

---

## 🗄️ Database Collections

### New Collections
1. **intakerecords** - Daily supplement tracking
   - user, assessment, supplementName, dosage, taken, takenAt, date, dayKey

2. **dashboardmetrics** - Per-assessment statistics
   - user, assessment, currentStreak, overallAdherence, wellnessScore, energyLevel, isActive

### Existing Collections
- users
- assessments
- supplementdetails

---

## 🐛 Troubleshooting

### Issue: Dashboard shows "No assessment found"
**Solution:** User needs to complete at least one assessment first
- Navigate to `/assessment` and complete the form

### Issue: Supplements not showing on Dashboard
**Cause:** Assessment might not have AI results saved
**Solution:** 
1. Check if assessment has `aiResults` field in database
2. Verify `/api/recommend` endpoint is working
3. Re-complete assessment if necessary

### Issue: Stats not updating when marking supplements
**Cause:** API error or network issue
**Solution:**
1. Check browser console for errors
2. Verify server is running
3. Check MongoDB connection
4. Look at server logs for error messages

### Issue: Streak not incrementing
**Cause:** Not all supplements marked as taken
**Solution:** User must mark ALL supplements as taken for streak to increase
- Check "Today's Progress" shows X/X (100%)

### Issue: Old supplements still showing after new assessment
**Cause:** Dashboard might be cached or backend didn't reset properly
**Solution:**
1. Hard refresh browser (Ctrl + Shift + R)
2. Check `DashboardMetrics` collection for `isActive` flag
3. Verify assessment POST route ran successfully

---

## 📁 Key Files to Know

### Backend
```
server/
├── models/
│   ├── IntakeRecord.js          ← NEW: Tracks supplement intake
│   ├── DashboardMetrics.js      ← NEW: Stores dashboard stats
│   ├── Assessment.js            ← Modified: Auto-resets dashboard
│   └── User.js
├── routes/
│   ├── dashboard.js             ← NEW: Dashboard endpoints
│   ├── insights.js              ← NEW: Insights endpoint
│   ├── assessment.js            ← Modified: Resets on new assessment
│   └── recommend.js
└── index.js                     ← Modified: Registered new routes
```

### Frontend
```
my-react-app/src/
├── Pages/
│   ├── DashboardPage.jsx        ← Refactored: Real data integration
│   ├── TrackIntakePage.jsx      ← Refactored: Real data integration
│   ├── InsightsPage.jsx         ← Refactored: Real data integration
│   └── RecommendationsPage.jsx  ← No changes (already working)
└── api.js                       ← Added: New API functions
```

---

## 🎯 User Flow Diagram

```
┌─────────────────────┐
│ User Registers      │
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ Takes Assessment    │ ← Completes health questionnaire
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ AI Generates Recs   │ ← 20 supplement recommendations
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ Results Saved       │ ← aiResults stored in assessment
│ Dashboard Reset     │ ← New DashboardMetrics created
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ Dashboard Loads     │ ← Shows supplements from THIS assessment
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ Track Supplements   │ ← User marks supplements taken
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ Stats Update        │ ← Adherence, streak, wellness score
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ View Insights       │ ← AI phase guidance, trends
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ Take New Assessment │ ← Cycle repeats with RESET
└─────────────────────┘
           ↓
      (Back to top)
```

---

## 🔐 Security Notes

- All routes use JWT authentication (`protect` middleware)
- Users can only access their own data
- Assessment IDs validated to prevent unauthorized access
- Input validation on all POST routes

---

## 📈 Performance Considerations

### Database Indexes
IntakeRecord and DashboardMetrics have compound indexes for efficient queries:
- `{ user: 1, assessment: 1, dayKey: 1 }`
- `{ user: 1, dayKey: 1 }`
- `{ user: 1, isActive: 1 }`

### Query Optimization
- Latest assessment: Uses MongoDB sort with limit 1
- Today's supplements: Indexed by dayKey for fast retrieval
- Metrics lookup: Single query by user + assessment + isActive

### Expected Load Times
- Dashboard load: < 500ms
- Mark supplement taken: < 200ms
- Insights page: < 500ms

---

## 🚦 Deployment Checklist

Before deploying to production:

- [ ] MongoDB connection string configured
- [ ] Environment variables set
- [ ] JWT secret configured
- [ ] OPENROUTER_API_KEY set (for AI recommendations — DeepSeek V4 Flash)
- [ ] CORS origins updated for production domain
- [ ] Rate limiters reviewed
- [ ] Error logging configured
- [ ] Database backups enabled
- [ ] Frontend build tested
- [ ] API endpoints tested with production data

---

## 📞 Need Help?

### Common Questions

**Q: Can users have multiple active assessments?**
A: No, only one assessment is active at a time. Taking a new assessment deactivates the previous one.

**Q: What happens to old tracking data?**
A: It's preserved in the database with `isActive: false`. You can query historical data by assessment ID.

**Q: Can users edit past intake records?**
A: Currently no, but this can be added as a future feature.

**Q: How is wellness score calculated?**
A: `(Adherence × 0.5) + (Streak × 1.0) + Energy Points` (see documentation for details)

**Q: What if user misses a day?**
A: Streak resets to 0, but overall adherence continues to track all-time performance.

---

## 🎉 Success!

You've successfully implemented a fully functional dashboard with:
- ✅ Real-time tracking
- ✅ AI-powered insights
- ✅ Automatic assessment lifecycle management
- ✅ Comprehensive progress analytics
- ✅ Seamless user experience

The app is ready for users to start tracking their supplement journey!

---

## 📝 Next Steps (Optional Enhancements)

1. Add push notifications for supplement reminders
2. Implement energy/sleep logging
3. Add historical calendar view with adherence dots
4. Create export/share functionality
5. Add gamification (badges, achievements)
6. Implement family/group tracking
7. Add healthcare provider integration

Refer to `DASHBOARD_FUNCTIONAL_UPDATE.md` for full technical documentation.
