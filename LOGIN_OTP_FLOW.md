# Login OTP Flow Diagrams

## 📊 Visual Flow Charts

### 1. Complete Login Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER JOURNEY                            │
└─────────────────────────────────────────────────────────────────┘

    👤 User                    🖥️  Frontend              🔧 Backend

     │                           │                          │
     │  Navigate to /login       │                          │
     ├──────────────────────────>│                          │
     │                           │                          │
     │  Enter email/password     │                          │
     ├──────────────────────────>│                          │
     │                           │                          │
     │  Click "Sign In"          │                          │
     ├──────────────────────────>│                          │
     │                           │                          │
     │                           │  POST /api/auth/login    │
     │                           ├─────────────────────────>│
     │                           │  { email, password }     │
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Validate
     │                           │                          │ │ credentials
     │                           │                          │<┘
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Generate
     │                           │                          │ │ 6-digit OTP
     │                           │                          │<┘
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Store OTP
     │                           │                          │ │ in memory
     │                           │                          │<┘
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Send email
     │                           │                          │ │ with OTP
     │                           │                          │<┘
     │                           │                          │
     │                           │  { requiresOtp: true,    │
     │                           │    userId: "..." }       │
     │                           │<─────────────────────────┤
     │                           │                          │
     │                           ├─┐                        │
     │                           │ │ Show OTP modal         │
     │  OTP Modal appears ◄──────┤<┘                        │
     │                           │                          │
     │  📧 Check email           │                          │
     ├────────────┐              │                          │
     │            │              │                          │
     │  [Inbox]   │              │                          │
     │  ┌─────────────────────┐  │                          │
     │  │ SuppliWise          │  │                          │
     │  │ Login Code: 123456  │  │                          │
     │  └─────────────────────┘  │                          │
     │            │              │                          │
     │<───────────┘              │                          │
     │                           │                          │
     │  Enter OTP: 123456        │                          │
     ├──────────────────────────>│                          │
     │                           │                          │
     │  Click "Verify & Sign In" │                          │
     ├──────────────────────────>│                          │
     │                           │                          │
     │                           │  POST /verify-login-otp  │
     │                           ├─────────────────────────>│
     │                           │  { userId, otp }         │
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Verify OTP
     │                           │                          │ │ matches
     │                           │                          │<┘
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Check not
     │                           │                          │ │ expired
     │                           │                          │<┘
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Delete OTP
     │                           │                          │ │ from store
     │                           │                          │<┘
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Generate
     │                           │                          │ │ JWT token
     │                           │                          │<┘
     │                           │                          │
     │                           │  { token, user: {...} }  │
     │                           │<─────────────────────────┤
     │                           │                          │
     │                           ├─┐                        │
     │                           │ │ Store token            │
     │                           │ │ in localStorage        │
     │                           │<┘                        │
     │                           │                          │
     │                           ├─┐                        │
     │  Redirect to home ◄───────┤ │ Navigate to /         │
     │                           │<┘                        │
     │                           │                          │
     ✅ Logged In!               │                          │
```

---

### 2. Resend OTP Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      RESEND OTP SCENARIO                        │
└─────────────────────────────────────────────────────────────────┘

    👤 User                    🖥️  Frontend              🔧 Backend

     │                           │                          │
     │  OTP modal open           │                          │
     │  (didn't receive email)   │                          │
     │                           │                          │
     │  Click "Send Again"       │                          │
     ├──────────────────────────>│                          │
     │                           │                          │
     │                           ├─┐                        │
     │                           │ │ Check cooldown         │
     │                           │ │ (60 seconds)           │
     │                           │<┘                        │
     │                           │                          │
     │                           │  If cooldown:            │
     │  "Send Again (59s)" ◄─────┤  Show countdown          │
     │  Button disabled          │  Disable button          │
     │                           │                          │
     │  [Wait 60 seconds...]     │                          │
     │                           │  ⏱️ Timer counting down   │
     │  "Send Again (1s)"        │  59, 58, 57... 1, 0      │
     │                           │                          │
     │  "Send Again" enabled     │  ✅ Countdown complete    │
     │                           │                          │
     │  Click "Send Again"       │                          │
     ├──────────────────────────>│                          │
     │                           │                          │
     │                           │  POST /resend-login-otp  │
     │                           ├─────────────────────────>│
     │                           │  { userId }              │
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Check rate
     │                           │                          │ │ limit
     │                           │                          │<┘
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Generate
     │                           │                          │ │ new OTP
     │                           │                          │<┘
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Replace old
     │                           │                          │ │ OTP
     │                           │                          │<┘
     │                           │                          │
     │                           │                          ├─┐
     │                           │                          │ │ Send new
     │                           │                          │ │ email
     │                           │                          │<┘
     │                           │                          │
     │                           │  { message: "Sent!" }    │
     │                           │<─────────────────────────┤
     │                           │                          │
     │  "Code sent again!" ◄─────┤  Show success message    │
     │                           │  Restart 60s cooldown    │
     │                           │                          │
     │  📧 Check email again     │                          │
     │  [New OTP: 654321]        │                          │
     │                           │                          │
     │  Enter new OTP            │                          │
     ├──────────────────────────>│                          │
     │                           │                          │
     ✅ Continue verification     │                          │
```

---

### 3. Error Handling Flows

#### A. Invalid Credentials

```
User enters wrong password
         │
         ▼
Backend validates credentials
         │
         ▼
    ❌ INVALID
         │
         ▼
Return error: "Invalid email or password"
         │
         ▼
Show error message
         │
         ▼
NO OTP SENT ← Security: Don't reveal which field is wrong
         │
         ▼
User can retry login
```

#### B. Invalid OTP

```
User enters wrong OTP
         │
         ▼
Backend checks OTP
         │
         ▼
    ❌ MISMATCH
         │
         ▼
Return error: "Invalid verification code"
         │
         ▼
Show error in modal
         │
         ▼
User can retry (same OTP still valid)
         │
         ▼
OR click "Send Again" for new OTP
```

#### C. Expired OTP

```
User waits 11+ minutes
         │
         ▼
User enters OTP
         │
         ▼
Backend checks expiration
         │
         ▼
    ❌ EXPIRED (> 10 minutes)
         │
         ▼
Delete OTP from store
         │
         ▼
Return error: "Code expired"
         │
         ▼
Show error: "Please request new code"
         │
         ▼
User clicks "Send Again"
         │
         ▼
New OTP generated
```

#### D. Rate Limited

```
User clicks "Send Again" too soon
         │
         ▼
Backend checks last request time
         │
         ▼
    ⏱️ < 60 seconds since last request
         │
         ▼
Calculate remaining time
         │
         ▼
Return 429: { remainingSeconds: 45 }
         │
         ▼
Show countdown: "Send Again (45s)"
         │
         ▼
Timer counts down
         │
         ▼
After 60s: Button enabled
```

---

### 4. Data Storage Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      OTP DATA LIFECYCLE                         │
└─────────────────────────────────────────────────────────────────┘

Generation:
    ├─ crypto.randomInt(100000, 999999)
    ├─ Creates 6-digit number
    └─ Example: 123456

Storage:
    ├─ Key: `login_${userId}`
    ├─ Value: { 
    │     otp: "123456",
    │     expiresAt: Date.now() + 600000,  // 10 minutes
    │     requestedAt: Date.now()
    │  }
    └─ Stored in: otpStore (Map)

Rate Limit Storage:
    ├─ Key: userId
    ├─ Value: lastRequestTimestamp
    └─ Stored in: otpRateLimitMap (Map)

Verification:
    ├─ Retrieve stored OTP by userId
    ├─ Compare with user input
    ├─ Check expiration
    └─ Delete if valid or expired

Cleanup:
    ├─ Manual: On verification success
    ├─ Manual: On expiration check
    └─ Automatic: [Future] Periodic cleanup task
```

---

### 5. Timeline Visualization

```
┌─────────────────────────────────────────────────────────────────┐
│                    OTP LIFETIME (10 MINUTES)                    │
└─────────────────────────────────────────────────────────────────┘

t=0s         Generate & Send OTP
  ├──────────────────────────────────────────────────────────────►
  │
  │ ✅ VALID PERIOD (0-10 minutes)
  │ User can enter OTP and verify successfully
  │
  ├─── 1 min  ─── User checks email
  │
  ├─── 2 min  ─── User enters OTP ✅ Success
  │
  ├─── 3 min  ─── [Still valid]
  │
  ├─── 5 min  ─── [Still valid]
  │
  ├─── 8 min  ─── [Still valid]
  │
  ├─── 9 min  ─── [Warning: Expiring soon]
  │
t=10m        ❌ EXPIRED - OTP no longer valid
  │
  └──────────────────────────────────────────────────────────────►
                     User must request new OTP

┌─────────────────────────────────────────────────────────────────┐
│                  RATE LIMIT WINDOW (60 SECONDS)                 │
└─────────────────────────────────────────────────────────────────┘

t=0s         First "Send Again" request
  ├──────────────────────────────────────────────────────────────►
  │
  │ 🚫 COOLDOWN PERIOD (0-60 seconds)
  │ Cannot request new OTP
  │
  ├─── 10s ─── "Send Again (50s)"
  │
  ├─── 20s ─── "Send Again (40s)"
  │
  ├─── 30s ─── "Send Again (30s)"
  │
  ├─── 40s ─── "Send Again (20s)"
  │
  ├─── 50s ─── "Send Again (10s)"
  │
  ├─── 59s ─── "Send Again (1s)"
  │
t=60s        ✅ COOLDOWN COMPLETE - Can request again
  │
  └──────────────────────────────────────────────────────────────►
```

---

### 6. State Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      LOGIN STATES                               │
└─────────────────────────────────────────────────────────────────┘

         ┌──────────────┐
         │   INITIAL    │
         │  (Login Page)│
         └──────┬───────┘
                │
         Enter credentials
                │
                ▼
         ┌──────────────┐
         │ VALIDATING   │ ──── Error ───► Show error message
         │ CREDENTIALS  │                       │
         └──────┬───────┘                       │
                │                               │
             Valid                              │
                │                               │
                ▼                               │
         ┌──────────────┐                       │
         │ OTP_SENT     │                       │
         │ (Modal open) │◄──────────────────────┘
         └──────┬───────┘                       │
                │                               │
         ┌──────┴──────┐                        │
         │             │                        │
    User enters    "Send Again"                 │
        OTP            │                        │
         │             ▼                        │
         │      ┌──────────────┐                │
         │      │  RESENDING   │                │
         │      │     OTP      │                │
         │      └──────┬───────┘                │
         │             │                        │
         │         Success                      │
         │             │                        │
         │             └──────┐                 │
         │                    │                 │
         ▼                    ▼                 │
    ┌──────────────┐   ┌──────────────┐        │
    │ VERIFYING    │   │ Rate limited │────────┘
    │     OTP      │   │ (show timer) │
    └──────┬───────┘   └──────────────┘
           │
    ┌──────┴──────┐
    │             │
 Invalid       Valid
    │             │
    ▼             ▼
Show error   ┌──────────────┐
    │        │   LOGGED_IN  │
    │        │ (Redirect /) │
    │        └──────────────┘
    │
    └────────► Back to OTP_SENT
```

---

### 7. Security Layer Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    SECURITY PROTECTIONS                         │
└─────────────────────────────────────────────────────────────────┘

Layer 1: Credential Validation
    ├─ Email format validation
    ├─ Password strength check
    ├─ User existence check
    └─ Password hash comparison

Layer 2: OTP Generation
    ├─ Cryptographically secure random
    ├─ 6-digit numeric (1,000,000 combinations)
    ├─ Timestamp-based expiration
    └─ Single-use enforcement

Layer 3: Rate Limiting
    ├─ Per-user cooldown (60 seconds)
    ├─ Prevents brute force
    ├─ Timestamp validation
    └─ In-memory tracking

Layer 4: OTP Verification
    ├─ Exact match required
    ├─ Expiration check (10 minutes)
    ├─ One-time use (deleted after verification)
    └─ Case-sensitive comparison

Layer 5: Token Issuance
    ├─ JWT with 7-day expiration
    ├─ Signed with secret key
    ├─ Contains user ID only
    └─ HTTPS required (production)

┌─────────────────────────────────────────────────────────────────┐
│                     ATTACK MITIGATION                           │
└─────────────────────────────────────────────────────────────────┘

Attack Type            │ Protection Method
─────────────────────────────────────────────────────────────────
Brute Force OTP        │ Rate limiting + Expiration
Credential Stuffing    │ OTP required even with valid password
Man-in-the-Middle      │ HTTPS + JWT tokens
Session Hijacking      │ New OTP per login
Replay Attacks         │ Single-use OTP codes
Email Interception     │ 10-minute expiration window
Spam/DoS               │ 60-second cooldown
Account Takeover       │ Email verification required
```

---

### 8. Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    FRONTEND COMPONENTS                          │
└─────────────────────────────────────────────────────────────────┘

LogIn.jsx
    ├─ State Management
    │   ├─ email, password (credentials)
    │   ├─ showOtpModal (boolean)
    │   ├─ otp (6-digit string)
    │   ├─ pendingUserId (string)
    │   ├─ resendCooldown (number)
    │   └─ loading, error, success (UI state)
    │
    ├─ Functions
    │   ├─ handleLogin() → Validate & request OTP
    │   ├─ handleOtpSubmit() → Verify OTP
    │   ├─ handleResendOtp() → Request new OTP
    │   ├─ startResendCooldown() → Manage timer
    │   ├─ completeLogin() → Store token & redirect
    │   └─ handleCancelOtp() → Close modal
    │
    └─ UI Elements
        ├─ Login Form (email, password, submit)
        ├─ OTP Modal (conditional render)
        ├─ OTP Input Field (6-digit)
        ├─ Resend Button (with countdown)
        ├─ Error Display
        └─ Success Feedback

┌─────────────────────────────────────────────────────────────────┐
│                     BACKEND ENDPOINTS                           │
└─────────────────────────────────────────────────────────────────┘

auth.js (Route Handler)
    ├─ POST /api/auth/login
    │   ├─ Validate credentials
    │   ├─ Generate OTP
    │   ├─ Store in otpStore
    │   ├─ Send email
    │   └─ Return { requiresOtp, userId }
    │
    ├─ POST /api/auth/verify-login-otp
    │   ├─ Find OTP in store
    │   ├─ Check expiration
    │   ├─ Compare OTP
    │   ├─ Delete OTP
    │   └─ Return { token, user }
    │
    └─ POST /api/auth/resend-login-otp
        ├─ Check rate limit
        ├─ Generate new OTP
        ├─ Update store
        ├─ Send email
        └─ Return success

email.js (Utility)
    └─ sendOtpEmail(email, otp, type)
        ├─ Get transporter (Nodemailer)
        ├─ Select template (login vs email-change)
        ├─ Build HTML email
        ├─ Build plain text email
        ├─ Send email
        └─ Return success boolean
```

---

**These diagrams show the complete flow of the login OTP system!**

For implementation details, see [LOGIN_OTP_SECURITY.md](./LOGIN_OTP_SECURITY.md)
