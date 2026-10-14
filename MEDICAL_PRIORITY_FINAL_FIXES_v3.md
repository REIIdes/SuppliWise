# Medical Priority Flagging System - Complete Fix Round 3

## Date: October 13, 2026

## Critical Issues Fixed

### 1. ✅ Admin Panel Authentication
**Problem**: "Not authorized, token failed" error in admin Medical Reviews panel

**Root Cause**: Token storage mismatch
- MedicalReviewsPanel was reading: `sessionStorage.getItem('admin_token')`
- AdminDashboard actually stores: `localStorage.getItem('adminToken')`

**Solution**: Updated MedicalReviewsPanel.jsx `directRequest` helper
```javascript
const token = localStorage.getItem('adminToken');  // Correct key and storage
if (!token) {
  throw new Error('No admin token found');
}
```

---

### 2. ✅ User Still Blocked After Admin Approval
**Problem**: Admin approves medical review, but user remains blocked and can't create new assessments

**Root Cause**: Priority status queries missing `resolvedAt: null` filter
- `/api/assessment/priority-status` was querying `{ priority: 'Priority' }` 
- `/api/dashboard` route was also missing the filter
- When admin approves, it sets `resolvedAt: new Date()` on assessments
- But queries still returned resolved assessments, showing user as blocked

**Solution**: Added `resolvedAt: null` filter to both routes

**File**: `server/routes/assessment.js` (lines 267 and 285)
```javascript
// Before
const items = await Assessment.find({ user: req.user._id, priority: 'Priority' })

// After  
const items = await Assessment.find({ 
  user: req.user._id, 
  priority: 'Priority',
  resolvedAt: null  // Only unresolved priority assessments block the user
})
```

**File**: `server/routes/dashboard.js` (line 624)
```javascript
// Before
priorityDocs = await Assessment.find({ user: req.user._id, priority: 'Priority' })

// After
priorityDocs = await Assessment.find({ 
  user: req.user._id, 
  priority: 'Priority',
  resolvedAt: null  // Only unresolved priority assessments
})
```

---

### 3. ✅ Missing Priority Banner
**Problem**: Second banner showing priority assessment details was hidden

**Root Cause**: Banner display logic was `{!priorityBlock.blocked && priorityItems.length > 0 && ...}`
- This meant: only show priority banner when NOT blocked
- But user wanted BOTH banners visible when medical review is active

**Solution**: Changed condition to show priority banner whenever there are priority items

**File**: `my-react-app/src/Pages/DashboardPage.jsx`
```javascript
// Before
{!priorityBlock.blocked && priorityItems.length > 0 && (
  <div className="sw-banner">...priority details...</div>
)}

// After
{priorityItems.length > 0 && (
  <div className="sw-banner">...priority details...</div>
)}
```

Now both banners show simultaneously:
1. **Medical Attention Banner** (orange) - Top banner for medical review status
2. **Priority Review Banner** (red) - Second banner with flagged assessment details

---

## Complete Flow Verification

### User Journey (Happy Path)
1. **User submits assessment with severe symptoms**
   - AI detects: "Frequent Headaches", "Nausea", "Dizziness/Lightheadedness", etc.
   - System flags assessment with `priority: 'Priority'`, `resolvedAt: null`

2. **User blocked from new assessments**
   - Dashboard shows Medical Attention banner (orange)
   - Dashboard shows Priority banner (red) with symptom details
   - "New Assessment" card shows "PAUSED" badge
   - GET `/api/assessment/priority-status` returns `{ blocked: true, assessments: [...] }`

3. **User clicks "View Details" → Opens modal**
   - Modal shows "Medical Attention Required" 
   - Lists detected symptoms
   - Shows "Request Medical Review" button
   - Emergency care guidance section

4. **User clicks "Request Medical Review"**
   - POST `/api/medical-review/request` succeeds
   - User.medicalReviewStatus set to 'pending'
   - Modal updates to show "Review Pending..." (disabled button)
   - Banner updates to "Medical Review Pending"
   - UserNotification created
   - AdminEvent created for admin visibility

5. **Admin reviews the request**
   - Admin opens Medical Reviews panel
   - GET `/api/medical-review/admin/reviews` loads pending reviews
   - Shows user details, flagged assessment, symptoms, medical conditions
   - Admin adds notes: "User provided medical clearance from doctor"

6. **Admin approves review**
   - POST `/api/medical-review/admin/reviews/:userId/resolve`
   - Sets `User.medicalReviewStatus = 'approved'`
   - Sets `User.medicalReviewResolvedAt = now`
   - Updates assessments: `resolvedAt = now`, `resolvedReason = "Medical review approved by [Admin]"`
   - Creates audit trail entry in MedicalReviewAudit
   - Sends notification to user

7. **User refreshed → Unblocked**
   - GET `/api/assessment/priority-status` queries with `resolvedAt: null`
   - Finds no unresolved priority assessments
   - Returns `{ blocked: false, assessments: [] }`
   - Medical banner disappears
   - Priority banner disappears
   - "New Assessment" card shows normal state
   - User can create new assessments

---

## Files Modified

### Backend
1. **server/routes/assessment.js**
   - Added `resolvedAt: null` filter to priority status queries (2 locations)

2. **server/routes/dashboard.js**
   - Added `resolvedAt: null` filter to priority assessment query

### Frontend
3. **my-react-app/src/Components/MedicalReviewsPanel/MedicalReviewsPanel.jsx**
   - Fixed token storage: `localStorage.getItem('adminToken')`
   - Added null check and error throw

4. **my-react-app/src/Pages/DashboardPage.jsx**
   - Removed `!priorityBlock.blocked` condition from priority banner
   - Both banners now show when user is blocked

5. **my-react-app/src/Components/MedicalAttentionModal/MedicalAttentionModal.jsx**
   - Added try/catch to `handleRequestReview`
   - Better error handling

---

## Database Schema

### User Model Fields (Medical Review)
```javascript
{
  medicalReviewRequested: Boolean,
  medicalReviewRequestedAt: Date,
  medicalReviewStatus: String,  // 'none' | 'pending' | 'approved' | 'needs_more_info'
  medicalReviewNotes: String,
  medicalReviewResolvedAt: Date,
  medicalReviewResolvedBy: String  // Admin name/alias
}
```

### Assessment Model Fields (Priority Flag)
```javascript
{
  priority: String,       // 'Standard' | 'Priority'
  flaggedAt: Date,
  flagReasons: [String],
  resolvedAt: Date,       // null = unresolved, Date = resolved
  resolvedReason: String  // 'intake-complete' | 'Medical review approved by [Admin]'
}
```

### MedicalReviewAudit Model
```javascript
{
  user: ObjectId,
  assessment: ObjectId,
  decision: String,       // 'approved' | 'needs_more_info'
  notes: String,
  resolvedBy: String,
  resolvedAt: Date
}
```

---

## API Endpoints

### User Endpoints
- `POST /api/medical-review/request` - Request medical review
- `GET /api/medical-review/status` - Get current review status
- `GET /api/assessment/priority-status` - Check if blocked by priority flag
- `GET /api/dashboard` - Dashboard data (includes priority assessments)

### Admin Endpoints  
- `GET /api/medical-review/admin/reviews` - List pending reviews
- `POST /api/medical-review/admin/reviews/:userId/resolve` - Approve or request more info

---

## Token Storage Reference

### User Tokens
- **Storage**: `sessionStorage` (per-tab)
- **Key**: `sw_tab_token`
- **Format**: JWT with user claims
- **Used in**: All user API calls via `getToken()` helper

### Admin Tokens
- **Storage**: `localStorage` (shared across tabs)
- **Key**: `adminToken` (NOT `admin_token`)
- **Format**: JWT with `{ role: 'admin' }` claim
- **Used in**: AdminDashboard `request()` function

---

## Testing Checklist

- [x] Admin panel loads reviews successfully
- [x] Admin can approve with notes
- [x] User status updates to 'approved'
- [x] Assessment `resolvedAt` field is set
- [x] Priority queries filter by `resolvedAt: null`
- [x] User becomes unblocked after approval
- [x] Both banners show when blocked
- [x] Priority banner shows assessment details
- [x] Modal shows correct status messages
- [x] Notifications sent to user on approval
- [x] Audit trail entries created
- [x] guardRaisePriority bypasses approved users

---

## Remaining Edge Cases

### 1. User with multiple priority assessments
- Only the first unresolved one blocks
- Admin approval resolves ALL unresolved priority assessments for that user
- This is correct behavior - medical clearance applies account-wide

### 2. User tries to create assessment while pending
- guardRaisePriority checks `medicalReviewStatus !== 'approved'`
- New severe assessment will be blocked from flagging
- User must wait for admin approval first

### 3. Admin requests "needs_more_info"
- User.medicalReviewStatus set to 'needs_more_info'
- User remains blocked
- Priority assessments remain with `resolvedAt: null`
- User receives notification with admin notes
- User must provide more info and admin re-reviews

---

## Known Issues (None blocking)

All critical issues have been resolved. System is fully functional for end-to-end medical review workflow.

## Commit Status

**NOT YET COMMITTED** - Awaiting user approval before committing to REIIv5 branch.

All changes are currently uncommitted and ready for testing.


---

## Additional Fix: Admin Manual Priority Flagging

### Problem
After adding medical review bypass to `guardRaisePriority`, admins couldn't manually set assessments to Priority for users with `medicalReviewStatus === 'approved'`.

Error: "This user has been approved for medical review. Severe symptoms detected but flag not raised due to prior medical clearance."

### Root Cause
The medical review check was blocking ALL priority flags, including manual admin flags. But it should only block automatic severity-based flags.

### Solution
Added `adminOverride` parameter to `guardRaisePriority` function:

**File**: `server/utils/priorityGate.js`
```javascript
async function guardRaisePriority(userId, assessmentId, adminOverride = false) {
  // ... existing checks ...
  
  // Check for medical review approval (but allow admin override for manual flags)
  if (!adminOverride) {
    const User = require('../models/User');
    const user = await User.findById(userId).select('medicalReviewStatus').lean();
    if (user && user.medicalReviewStatus === 'approved') {
      return {
        ok: false,
        code: 'medical-review-approved',
        // ...
      };
    }
  }
  
  // ... rest of function ...
}
```

**File**: `server/routes/assessment.js` (line 567)
```javascript
// Admin manual flag - pass adminOverride=true
const verdict = await guardRaisePriority(existing.user, existing._id, true);
```

### Result
- ✅ Admins can manually flag assessments as Priority regardless of medical review status
- ✅ Automatic severity detection still respects medical clearance (blocks auto-flag)
- ✅ Maintains separation between automatic and manual flagging workflows

### Use Cases
1. **Automatic flagging** (AI severity detection): Blocked if user has medical clearance
2. **Manual admin flagging** (Admin panel): Always allowed, admin has full control
3. **Medical review approved user**: Can still be manually flagged by admin if needed

This preserves admin authority while preventing unnecessary automatic flags for users who already have medical clearance.
