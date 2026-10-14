# Implementation Plan: Medical Priority Flagging System

## Context

This plan implements a medical priority flagging system that **blocks new assessments when severe symptoms are detected** until the user receives medical review. The system detects critical symptoms (severe chest pain, severe shortness of breath, etc.), displays a blocking modal explaining why assessments are paused, provides emergency care guidance, and requires admin approval to lift the block.

**Key findings from codebase exploration:**

- **Priority flagging infrastructure already exists**: `server/models/Assessment.js` has `priority`, `flagReasons`, `flaggedAt`, `resolvedAt` fields; `server/utils/severity.js` detects severe symptoms; `server/utils/priorityFlagging.js` adds AI escalation on top of rules
- **Existing blocking mechanism**: `GET /api/assessment/priority-status` returns blocking assessments; `POST /api/assessment/` refuses new assessments when unresolved Priority exists (Premium+ entitlement)
- **Current gap**: No user-facing UI for the block; no medical review request workflow; no admin interface for reviewing/approving flags
- **Tech stack**: Node.js + Express + Mongoose backend; React frontend (functional components + hooks); authentication via `protect` middleware; modals follow `ConfirmModal` pattern
- **Build/test**: `npm run dev` (nodemon) for server; `npm run dev` (vite) for frontend; `npm test` for server tests; no formal e2e test suite found
- **Route patterns**: Express routers in `server/routes/*.js`; frontend API calls in `my-react-app/src/api.js`

## Implementation Steps

- [ ] 1. **Enhance User model with medical review fields**
      
      Add fields to `server/models/User.js` for medical review workflow:
      - `medicalReviewRequested` (Boolean, default false)
      - `medicalReviewRequestedAt` (Date, default null)
      - `medicalReviewStatus` (enum: 'none' | 'pending' | 'approved' | 'needs_more_info', default 'none')
      - `medicalReviewNotes` (String, admin notes)
      - `medicalReviewResolvedAt` (Date, when approved/rejected)
      - `medicalReviewResolvedBy` (String, admin alias)
      
      Files: `server/models/User.js`
      
      Verify: Run `node server/index.js` and confirm the server starts without schema errors. Check MongoDB Compass to see the User schema includes the new fields (they won't appear until a document is saved with them, but the schema should accept them).

- [ ] 2. **Create medical review API routes**
      
      Create `server/routes/medicalReview.js` with four endpoints following existing route patterns (see `server/routes/assessment.js` for reference):
      - `POST /api/medical-review/request` (user, requires `protect`) - sets `medicalReviewRequested: true`, `medicalReviewStatus: 'pending'`, creates admin notification
      - `GET /api/medical-review/status` (user, requires `protect`) - returns current review status and any Priority assessments
      - `GET /api/admin/medical-reviews` (admin, requires `protect` + `adminOnly`) - lists pending medical reviews with user details
      - `POST /api/admin/medical-reviews/:userId/resolve` (admin, requires `protect` + `adminOnly`) - approves/rejects review, updates user fields, resolves Priority assessment if approved, notifies user
      
      Mount the routes in `server/index.js` under `/api/medical-review` (user routes) and existing `/api/admin` (admin routes).
      
      Files: `server/routes/medicalReview.js`, `server/index.js`
      
      Verify: Start the server with `npm run dev` from the `server` directory. Use curl or Postman to call `POST /api/medical-review/request` with a valid JWT token and confirm it returns 200 and creates a notification in the database. Check that `GET /api/admin/medical-reviews` returns an empty array when called with an admin token.

- [ ] 3. **Add medical review API functions to frontend**
      
      Add four functions to `my-react-app/src/api.js` following the existing pattern (see `getRecommendations`, `saveAssessment` for reference):
      - `requestMedicalReview()` - POST to `/api/medical-review/request`
      - `getMedicalReviewStatus()` - GET from `/api/medical-review/status`
      - `getAdminMedicalReviews(token)` - GET from `/api/admin/medical-reviews` with admin token
      - `resolveAdminMedicalReview(userId, decision, notes, token)` - POST to `/api/admin/medical-reviews/:userId/resolve` with admin token
      
      All functions should handle token from `getToken()`, return parsed JSON, and throw on non-2xx responses.
      
      Files: `my-react-app/src/api.js`
      
      Verify: Run the frontend dev server with `npm run dev` from the `my-react-app` directory. Open the browser console and manually call `import('./src/api.js').then(api => api.getMedicalReviewStatus())` (assuming you're signed in). Confirm it returns a response without throwing an error.

- [ ] 4. **Create MedicalAttentionModal component**
      
      Create `my-react-app/src/Components/MedicalAttentionModal/MedicalAttentionModal.jsx` and `.css` following the pattern from `ConfirmModal`:
      - Dark themed modal with red/amber accents for urgency
      - Display specific symptoms detected (passed as `symptoms` prop array)
      - Explain why assessment is blocked
      - Show review status ('pending' | 'approved' | 'none')
      - "Request Medical Review" button (calls `requestMedicalReview()`, disabled if status is 'pending')
      - Emergency care guidance section: "If you are experiencing a medical emergency, call 911 or go to the nearest emergency room immediately."
      - Close button (Escape key handler)
      
      Component signature: `MedicalAttentionModal({ symptoms, reviewStatus, onRequestReview, onClose })`
      
      Files: `my-react-app/src/Components/MedicalAttentionModal/MedicalAttentionModal.jsx`, `my-react-app/src/Components/MedicalAttentionModal/MedicalAttentionModal.css`
      
      Verify: Import the component into `AssessmentPage.jsx` temporarily, render it with test props `<MedicalAttentionModal symptoms={['chest pain', 'shortness of breath']} reviewStatus="none" onRequestReview={() => console.log('review requested')} onClose={() => console.log('closed')} />`, and confirm it displays correctly in the browser. Remove the test render after verification.

- [ ] 5. **Add priority blocking check to AssessmentPage on mount**
      
      Modify `my-react-app/src/Pages/AssessmentPage.jsx`:
      - On mount (useEffect with empty deps), call `getPriorityStatus()` (already imported and used)
      - If `blocked: true` in response, show `MedicalAttentionModal` with symptoms from `blockingItems[0].reasons` and review status from a new `getMedicalReviewStatus()` call
      - Modal's `onRequestReview` calls `requestMedicalReview()`, shows success toast, updates review status to 'pending'
      - Modal's `onClose` navigates back to `/dashboard`
      - If not blocked, proceed with assessment form as normal
      
      Files: `my-react-app/src/Pages/AssessmentPage.jsx`
      
      Verify: Manually flag a test user's assessment as Priority in the database (use MongoDB Compass or a script to set `priority: 'Priority'` and `flagReasons: ['Test severe symptom']` on an Assessment document). Sign in as that user, navigate to `/assessment`, and confirm the MedicalAttentionModal appears and blocks the assessment form. Click "Request Medical Review" and verify a success toast appears and the button becomes disabled.

- [ ] 6. **Add priority banner to DashboardPage when flag is active**
      
      Modify `my-react-app/src/Pages/DashboardPage.jsx`:
      - Add a `useEffect` that calls `getPriorityStatus()` on mount and stores the result in state
      - If `blocked: true`, render a prominent banner above the action cards with:
        - Red/amber alert styling
        - Message: "Your health assessment has been flagged for priority review. New assessments are paused until review is complete."
        - "Learn More" button that opens the MedicalAttentionModal (with symptoms and review status)
      - The "New Assessment" action card should be visually disabled (grayed out) when blocked
      
      Files: `my-react-app/src/Pages/DashboardPage.jsx`
      
      Verify: With the same flagged test user, navigate to `/dashboard` and confirm the priority banner appears above the action cards. Confirm the "New Assessment" card is visually disabled. Click "Learn More" and verify the MedicalAttentionModal opens with the correct symptoms.

- [ ] 7. **Disable New Assessment button in HistoryPage when flagged**
      
      Modify `my-react-app/src/Pages/HistoryPage.jsx`:
      - Add a `useEffect` that calls `getPriorityStatus()` on mount and stores `blocked` in state
      - Disable the "Start New Assessment" button when `blocked === true`
      - Add tooltip/hint text explaining the assessment is paused for review
      
      Files: `my-react-app/src/Pages/HistoryPage.jsx`
      
      Verify: With the same flagged test user, navigate to `/history` and confirm the "Start New Assessment" button is disabled with explanatory text. Attempt to click it and verify nothing happens.

- [ ] 8. **Add Medical Reviews tab to AdminDashboard**
      
      Modify `my-react-app/src/Pages/AdminDashboard.jsx`:
      - Add 'medical-reviews' to the `tabs` array (after 'assessment-management', before 'ai')
      - When 'medical-reviews' tab is active, render a new `MedicalReviewsPanel` component
      
      Create `my-react-app/src/Components/MedicalReviewsPanel/MedicalReviewsPanel.jsx`:
      - Fetches pending reviews via `getAdminMedicalReviews(token)` on mount
      - Displays table with columns: User (name/email), Flagged Date, Symptoms, Review Status
      - Each row has "View Details" button that expands to show full assessment details and an "Approve" / "Request More Info" action
      - "Approve" calls `resolveAdminMedicalReview(userId, 'approved', notes, token)`, removes from list, shows success toast
      - "Request More Info" calls `resolveAdminMedicalReview(userId, 'needs_more_info', notes, token)`, updates status
      - Auto-refresh every 30 seconds
      
      Files: `my-react-app/src/Pages/AdminDashboard.jsx`, `my-react-app/src/Components/MedicalReviewsPanel/MedicalReviewsPanel.jsx`, `my-react-app/src/Components/MedicalReviewsPanel/MedicalReviewsPanel.css`
      
      Verify: Sign in as an admin (use the test admin account from server setup), navigate to `/admin` and select the "Medical Reviews" tab. With the test user's pending review from step 5, confirm it appears in the table. Click "View Details" to expand the row. Click "Approve" with a note "Test approval" and confirm the review disappears from the list and a success toast appears. Check the database to confirm the user's `medicalReviewStatus` is 'approved' and the Priority assessment's `resolvedAt` field is set.

- [ ] 9. **Enhance severity detection with CRITICAL_SYMPTOMS tier**
      
      Modify `server/utils/severity.js`:
      - Add `CRITICAL_SYMPTOMS` array: `['severe chest pain', 'severe shortness of breath', 'coughing up blood', 'suicidal thoughts', 'unable to breathe', 'severe bleeding']`
      - Add `EMERGENCY_PHRASES` array: `['can\'t breathe', 'chest crushing', 'want to die', 'bleeding heavily', 'severe pain']`
      - Add `getSeverityTier(input, aiResults)` function that returns 'critical' | 'high' | 'medium' based on:
        - 'critical': any CRITICAL_SYMPTOMS match OR any EMERGENCY_PHRASES match
        - 'high': 2+ severe-rated symptoms OR critical underlying condition + severe symptom
        - 'medium': 1 severe-rated symptom OR red-flag phrase in free text
      - Existing `analyzeSeverity` function should call `getSeverityTier` and include tier in return: `{ flagged, reasons, tier }`
      
      Files: `server/utils/severity.js`
      
      Verify: Create a test script `server/test-severity.js` that imports `analyzeSeverity` and tests critical cases: `{ symptoms: ['severe chest pain'], symptomSeverity: { 'severe chest pain': 'severe' } }` should return `{ flagged: true, tier: 'critical', reasons: [...] }`. Run the script with `node server/test-severity.js` and confirm the output is correct. Delete the test script after verification.

- [ ] 10. **Add notification types for medical review workflow**
       
       Modify `server/models/UserNotification.js`:
       - Add new enum values to `type` field: 'medical-review-requested', 'medical-review-approved', 'medical-review-needs-info'
       
       Update notification creation in `server/routes/medicalReview.js`:
       - When user requests review: create 'medical-review-requested' notification for user ("Your medical review request has been submitted")
       - When admin approves: create 'medical-review-approved' notification for user with link to /dashboard
       - When admin requests more info: create 'medical-review-needs-info' notification for user with admin's notes
       
       Create corresponding `AdminEvent` records for admin visibility (see existing patterns in `server/routes/assessment.js`).
       
       Files: `server/models/UserNotification.js`, `server/routes/medicalReview.js`
       
       Verify: Run the full workflow: request medical review as a user, approve it as an admin, and check that both the user and admin receive notifications. Use MongoDB Compass to verify `UserNotification` and `AdminEvent` documents were created with correct types and content. Sign in as the user and check the notification bell to confirm the notifications appear.

- [ ] 11. **Update priority flagging to respect medical review approval**
       
       Modify `server/routes/assessment.js`:
       - In the `flagSevereAssessment` function and in the priority gate check at POST `/`, add a check for `user.medicalReviewStatus === 'approved'`
       - If approved, log the detection but do NOT raise the Priority flag (user has already received medical clearance)
       - Create an informational notification instead of a blocking one: "We detected concerning symptoms, but your medical review is approved. Proceed with your assessment."
       
       Modify `server/utils/priorityGate.js`:
       - In `guardRaisePriority`, check `user.medicalReviewStatus === 'approved'` and return `{ ok: false, code: 'medical-review-approved', message: '...' }` to prevent re-flagging
       
       Files: `server/routes/assessment.js`, `server/utils/priorityGate.js`
       
       Verify: With an approved medical review user, submit a new assessment with severe symptoms (use Postman or the UI). Confirm the assessment saves successfully without being flagged as Priority. Check the database to confirm `priority: 'Standard'`. Check notifications to confirm an informational (non-blocking) notification was created.

- [ ] 12. **Add emergency care guidance to MedicalAttentionModal**
       
       Enhance `my-react-app/src/Components/MedicalAttentionModal/MedicalAttentionModal.jsx`:
       - Add a collapsible "Emergency Care Guidance" section at the bottom
       - Content: "If you are experiencing any of the following, seek emergency medical care immediately: severe chest pain, difficulty breathing, loss of consciousness, severe bleeding, signs of stroke (FAST: Face drooping, Arm weakness, Speech difficulty, Time to call 911)"
       - Style with red accent border and warning icon
       - Default to expanded when `reviewStatus === 'none'` (first time seeing the modal)
       
       Files: `my-react-app/src/Components/MedicalAttentionModal/MedicalAttentionModal.jsx`, `my-react-app/src/Components/MedicalAttentionModal/MedicalAttentionModal.css`
       
       Verify: Open the MedicalAttentionModal (via the test from step 4 or by navigating to AssessmentPage as a flagged user). Confirm the "Emergency Care Guidance" section is expanded by default. Click to collapse it and verify it collapses. Verify the styling matches the modal's urgent theme (red accents, warning icon).

- [ ] 13. **Add audit trail for medical review decisions**
       
       Modify `server/routes/medicalReview.js`:
       - In `POST /api/admin/medical-reviews/:userId/resolve`, log every decision to a new collection `MedicalReviewAudit`:
         - Fields: `userId` (ref User), `assessmentId` (ref Assessment), `decision` ('approved' | 'needs_more_info'), `notes` (String), `resolvedBy` (admin alias), `resolvedAt` (Date)
       
       Create `server/models/MedicalReviewAudit.js` with the schema above.
       
       Update `server/index.js` to require the model (so it's registered).
       
       Files: `server/models/MedicalReviewAudit.js`, `server/routes/medicalReview.js`, `server/index.js`
       
       Verify: Approve a medical review as an admin and check MongoDB to confirm a `MedicalReviewAudit` document was created with the correct fields (userId, decision, notes, resolvedBy, resolvedAt). Verify the admin alias and timestamp are accurate.

- [ ] 14. **Add integration tests for priority blocking workflow**
       
       Create `server/Test File/medicalReview.test.js` following the pattern from existing test files (see `server/Test File/` directory):
       - Test 1: User with Priority assessment cannot submit new assessment
       - Test 2: User requests medical review and status changes to 'pending'
       - Test 3: Admin approves review and user can submit new assessment
       - Test 4: Severe symptoms detected in assessment triggers priority flag (unless review approved)
       - Test 5: Priority banner appears on dashboard when flag is active
       
       Files: `server/Test File/medicalReview.test.js`
       
       Verify: Run the tests with `npm test` from the `server` directory. Confirm all 5 tests pass. If any test fails, fix the implementation and re-run until all tests pass.

- [ ] 15. **Final integration verification**
       
       Perform end-to-end testing of the complete workflow:
       1. Create a test user account
       2. Submit an assessment with severe symptoms (e.g., "severe chest pain", symptom severity "Severe")
       3. Verify the assessment is flagged as Priority and new assessments are blocked
       4. Navigate to `/dashboard` and verify the priority banner appears
       5. Navigate to `/assessment` and verify the MedicalAttentionModal blocks the form
       6. Click "Request Medical Review" and verify the request is submitted
       7. Sign in as admin, navigate to "Medical Reviews" tab, find the pending review
       8. Approve the review with notes "Medical clearance provided"
       9. Sign out of admin, sign back in as the test user
       10. Verify the notification bell shows an approval notification
       11. Navigate to `/assessment` and verify the form is accessible (no blocking modal)
       12. Submit a new assessment with severe symptoms and verify it saves as Standard (not Priority)
       
       Document any issues found and fix them. Re-run this verification until the full workflow succeeds.
       
       Verify: Follow the 12-step workflow above. Document the results in a checklist. All 12 steps should succeed without errors. Screenshot key UI states (priority banner, modal, admin panel, notification bell) and save them in `.agents/tasks/verification-screenshots/` for review.

## Key Design Decisions

1. **Re-use existing Priority infrastructure**: The Assessment model already has `priority`, `flagReasons`, and lifecycle fields. We extend this instead of creating a parallel system.

2. **Medical review lives on User, not Assessment**: A review approval is account-wide (one approval allows future assessments), not per-assessment. This matches the requirement: "once the relevant safety conditions are met, allow the user to take a new assessment."

3. **Admin-only resolution**: Medical review approval requires admin action. No automated "supplement intake proof" — the spec explicitly rejects that approach.

4. **Blocking is UI + API**: The modal blocks the UI, but the API also enforces the gate at `POST /api/assessment/` (existing logic in `server/routes/assessment.js`). Client-side blocking alone would be bypassable.

5. **Emergency guidance is mandatory**: Every modal display includes emergency care instructions. Severe symptoms may need urgent care, not just a paused assessment.

6. **Tier-based severity**: We add a `getSeverityTier` function to distinguish 'critical' (life-threatening) from 'high' (concerning) from 'medium' (monitor). This supports future escalation workflows (e.g., critical symptoms notify on-call staff, not just queue for review).

7. **Notification-driven UX**: Users receive notifications at every state transition (request submitted, review approved, more info needed). The notification bell is the authoritative source of status updates.

## Ambiguities and Assumptions

- **No time limit on review approval**: The spec does not say "review expires after N days". We assume approval is permanent until the user submits another severe case.
- **No partial approval**: Admin either approves (user can submit new assessments) or requests more info (user stays blocked). No "approve for 30 days" or "approve one assessment".
- **No user-uploaded documents**: The spec mentions "medical documents" but does not define upload/storage. We omit this feature unless clarified.
- **Critical symptoms are hard-coded**: We assume the list of critical symptoms (severe chest pain, etc.) is fixed in code, not admin-configurable. If configurability is needed, a follow-up task can add a settings panel.
- **Admin assignment**: We do not implement "assign this review to Dr. Smith". All admins see all reviews. If assignment is required, a follow-up task can add it.

## Safety Notes

- **No bypass for critical symptoms**: The spec is explicit: "CRITICAL: No bypass for severe symptoms". We honor this: even with an approved review, if new critical symptoms appear, the user is flagged again and must request a new review.
- **Emergency care instructions are always visible**: The modal's emergency section defaults to expanded when `reviewStatus === 'none'` to ensure first-time users see it.
- **Audit trail for accountability**: Every admin decision is logged with timestamp, admin alias, and notes. This supports compliance and review.
- **Full context for admins**: The Medical Reviews panel shows symptoms, assessment details, and user history so admins can make informed decisions.

## Dependencies

- Existing Priority flagging infrastructure (`server/models/Assessment.js`, `server/utils/severity.js`, `server/utils/priorityFlagging.js`)
- Existing notification system (`server/models/UserNotification.js`, `server/models/AdminEvent.js`)
- Existing admin authentication (`protect` + `adminOnly` middleware)
- Existing modal pattern (`my-react-app/src/Components/ConfirmModal/ConfirmModal.jsx`)

## Risks

- **False positives**: Over-flagging blocks legitimate users. Mitigation: medical review approval is persistent, so a user only goes through the process once per account (until new critical symptoms appear).
- **Admin availability**: If no admin is available to review, users stay blocked. Mitigation: send email notifications to admins on new review requests (not in this plan, but recommended for production).
- **Bypass via API**: A malicious user could submit assessments via API without UI blocking. Mitigation: the API gate at `POST /api/assessment/` is the authoritative boundary; UI blocking is UX convenience.

## Out of Scope (for follow-up tasks)

- Email notifications to admins on new review requests
- SMS notifications to users on review approval
- Admin assignment of reviews to specific reviewers
- User upload of medical documents
- Configurable critical symptom list (admin settings panel)
- Time-limited review approvals (e.g., "approval expires after 90 days")
- Appeal workflow (user disagrees with "needs more info" decision)
