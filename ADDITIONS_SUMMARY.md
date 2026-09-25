# SuppliWise — Additions Summary

**Session:** All uncommitted changes relative to commit `6daf284 "Adjustments in Session Expiry"`.
**Baseline:** `6daf284` (last commit).
**Status:** 38 files modified/untracked, 78 files changed total, all uncommitted.
**Purpose:** Documents every new file, module, and capability added in this session, grouped by domain.

---

## 1. New Files — Backend Models & Utilities (5)

### `server/models/BackupCode.js`
Single-use recovery codes for 2FA account recovery.

- **Storage:** Only SHA-256 hashes of codes are persisted; plaintext codes are shown once and never again.
- **Minting:** `generate(userId)` creates 10 codes in a batch, replaces any previous batch atomically.
- **Redemption:** `consume(userId, code)` is a conditional update — single-use enforced by the filter itself; concurrent redemptions of the same code cannot both win.
- **Regeneration:** New batches delete previous ones via shared `batchId`.
- **Entropy:** Each code is ~52 bits (10 chars from an unambiguous alphabet, formatted `XXXXX-XXXXX`).
- **Exports:** `generate`, `consume`, `invalidateAll`, `countRemaining`, `normalise`, `hashCode`, `CODE_COUNT`.

### `server/models/SecurityEvent.js`
Append-only security event log for the account's own security history.

- **Why it exists:** The UI previously derived "Recent security activity" by string-matching notification titles in the browser, which silently dropped events whose wording changed and could not express success vs failure.
- **Event types:** `login-success`, `login-failure`, `mfa-success`, `mfa-failure`, `mfa-enabled`, `mfa-disabled`, `password-changed`, `password-change-failed`, `backup-codes-generated`, `backup-code-used`, `backup-codes-invalidated`, `session-revoked`, `sessions-revoked-all`, `device-trust-revoked`, `recovery-email-changed`, `account-locked`, `unrecognized-login`.
- **Safety:** No passwords, TOTP secrets, backup codes, tokens, session IDs, or hashes are ever written. `write()` takes a fixed vocabulary of types and cannot express a secret. IP stored but never exposed to other users.
- **Indexes:** `{ user: 1, createdAt: -1 }` for newest-first reads; `{ createdAt: 1 }` for housekeeping.
- **Exports:** `write()`, `EVENT_TYPES`.

### `server/utils/device.js`
Device attribution from User-Agent and IP headers.

- **Security note:** Presentation-only. Everything returned is derived from request headers controlled by the caller. Never gates authorization decisions.
- **Functions:** `browserOf(ua)`, `platformOf(ua)`, `deviceLabelOf(ua)` (returns "Chrome on Windows"), `describeDevice({ userAgent, ip, location })`.
- **Patterns:** Edge, Opera, Firefox, Chrome, Safari, Samsung Internet, curl, Node, Postman, plus platforms (Windows, iOS, Android, macOS, ChromeOS, Linux).
- **Used by:** Session creation, security device listing.

### `server/utils/emailValidation.js`
Shared email validation extracted from `routes/auth.js` to avoid copy-paste drift.

- **Rules:** Requires a real TLD (2+ letters); rejects typo domains (`.con`, `.cmo`, `.ocm`, `.nte`, `.ogr`, `.cpm`).
- **Exports:** `isValidEmail(email)`, `EMAIL_REGEX`, `SUSPICIOUS_TLDS`.
- **Used by:** Recovery email flow, registration, profile email changes.

### `server/routes/securityRedeem.js`
The one **public** route in the security family — redeeming a backup recovery code as the second factor at sign-in.

- **Why separate file:** Registered on the router BEFORE the `protect` guard. Folded into `routes/security.js` it was silently unreachable (the guard answered every legitimate recovery-code sign-in with NO_SESSION because at that moment the user has a password and userId but no session).
- **Rate limited** by `sensitiveLimiter` (60 requests per 10 min).
- **Lockout:** Same account ladder as any other second factor.
- **Indistinguishable:** Identical 401 whether account unknown, MFA off, or code wrong.
- **Only usable** when the authenticator is the active factor.
- **Single-use:** `BackupCode.consume()` is a conditional update.
- **On success:** Issues user session, optionally attaches remember token, records security events, sends notification email.

---

## 2. New Files — Backend API Routes (2)

### `server/routes/security.js`
The account-security dashboard's server side. 30+ endpoints.

**Key architecture:**
- Every route except `/backup-codes/redeem` is `protect`-guarded and admin-excluded, scoped to `req.user._id` in the query.
- A missed match returns 404 (never 403 — that would confirm the object exists to someone who doesn't own it).
- Mutating routes additionally require **Step-Up**: a fresh proof of possession (password + TOTP when authenticator is active) traded for a short-lived 5-minute token.

**Endpoints:**
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/security/step-up` | Trade current password (+TOTP) for a 5-min step-up token |
| `GET` | `/api/security/summary` | Everything the dashboard header needs (2FA state, backup codes, devices, recovery email) |
| `GET` | `/api/security/devices` | Signed-in devices this account can see |
| `POST` | `/api/security/devices/:id/revoke` | Revoke ONE other session (step-up required) |
| `POST` | `/api/security/devices/revoke-others` | Sign out every session except this one (step-up required) |
| `GET` | `/api/security/events` | This account's own security history, newest first |
| `POST` | `/api/security/backup-codes/generate` | Mint new recovery codes (step-up required) |
| `DELETE` | `/api/security/backup-codes` | Destroy every unused recovery code (step-up required) |
| `POST` | `/api/security/recovery-email/request` | Send confirmation code to candidate address (step-up required) |
| `POST` | `/api/security/recovery-email/verify` | Confirm and activate recovery email |
| `DELETE` | `/api/security/recovery-email` | Remove recovery email (step-up required) |

**Rate limiting:** `sensitiveLimiter` (60/10 min) on mutating routes. Read-only endpoints deliberately excluded from rate limiting.

**Step-up mechanism:**
- `requireStepUp` middleware checks `X-Step-Up` header carrying a JWT minted by `POST /security/step-up` in the last 5 minutes, for this user and this session.
- Step-up earned on one device does not authorize a change from another.
- A fresh sign-in invalidates it because the token is bound to the session ID.

---

## 3. New Files — Frontend Components (2 directories)

### `my-react-app/src/Components/PlanLockedCard/`
Full-page plan-gate component — the "your plan doesn't include this" state.

**Design intent:** Replaces a plain white box with a 🔒 emoji and two flat grey buttons (which read as a dead end rather than an offer).

**Key features:**
- States the VALUE first, not the lock — "Upgrade to unlock" is a reason to keep reading
- Shows the gap literally: current plan → required plan
- Lists what the upgrade actually buys (paywall that names its own benefits)
- Exactly one dominant action (View Plans) + one secondary (Back)
- Be honest about admin-provisioned upgrade path
- Inline SVG icons (keeps component dependency-free)
- Gradient card with aurora band, glass-morphism badge, responsive at ≤560px
- Respects `prefers-reduced-motion` and `prefers-contrast: more`

**Props:** `featureLabel`, `requiresPlan`, `currentPlan`, `benefits`, `onViewPlans`, `onBack`, `viewPlansLabel`, `backLabel`, `footnote`

**Files:** `PlanLockedCard.jsx`, `PlanLockedCard.css`

### `my-react-app/src/Components/ProfileSecurityControls/`
Account security controls — the things that are security decisions rather than profile data.

**Why pulled out of the profile form:**
- Changing a password is not "editing your profile" — used to live behind "Edit Profile" alongside name and DOB
- "When did I last change this?" is information, not an input — belongs on screen permanently
- "Sign out everywhere else" and 2FA selection are account actions, not profile fields

**Sub-components:**

#### `ProfileSecurityControls.jsx` (main component)
- **2FA method picker:** Authenticator app vs Email codes, with strength indicator
- **Password change:** Current password + new password (8+ chars, uppercase, number) with validation
- **Recovery Codes card:** Generate, view, invalidate single-use codes
- **Recovery Email card:** Add/change/remove secondary recovery email with verification flow
- **Session Activity:** Signed-in devices list + login/security history
- **Step-Up gate:** `StepUpDialog` overlay for any security-mutating action
- **Data loading:** `getSecuritySummary()` fetches server-authoritative 2FA state, backup codes, recovery email, device counts
- **Step-up orchestration:** `onRequireStepUp({ reason, action })` shows the confirm dialog, then runs `action` with a short-lived session-bound step-up token

#### `RecoveryPanel.jsx`
- `BackupCodesCard`: Shows remaining count, generates new codes (shown once as plaintext), invalidates all
- `RecoveryEmailCard`: Add/change/remove recovery email with OTP verification, masked display

#### `SessionActivity.jsx`
- Lists signed-in devices with device label, platform, location, IP, timestamps
- Shows "This device" and "Saved login" chips
- Individual sign-out + "Sign out all other devices"
- Login/security activity feed with event types and success/failure indicators
- Notable events highlighted (unrecognized-login, mfa-failure, account-locked, etc.)
- 8-event preview with "View all" toggle

#### `StepUpDialog.jsx`
- Modal overlay with blur backdrop (z-index 1400)
- Current password field + authenticator code (if TOTP is active factor)
- 5-minute token validity, session-bound
- Accessible: `role="dialog"`, `aria-modal`, `aria-labelledby`

**CSS files:** `ProfileSecurityControls.css`, `RecoveryPanel.css`, `SessionActivity.css`, `StepUpDialog.css`

**Design tokens:** Same emerald/teal/indigo/violet palette as the rest of the app. Consistent button styles, alert styles, input styles, responsive at ≤560px.

---

## 4. New Files — Documentation (1)

### `USER_GUIDE.md`
Complete user guide (version 2026-09), 15 sections, ~4500 lines.

| Section | Content |
|---------|---------|
| 1. Getting Started | Platforms, first visit, per-tab session model |
| 2. Authentication & Account | Create, sign in, forgot password, profile settings, sign out, admin login |
| 3. Health Assessment | Start assessment (4 steps), results, history, priority flagging |
| 4. Daily Supplement Tracking | My Plan, Track Intake (Today/Calendar/Adherence), data model |
| 5. Insights & Analytics | Overview, Today's Progress, Adherence, AI Insight (tier-gated) |
| 6. Web3 / Blockchain Features | Wallet/DID, Supply Chain, Marketplace, DAO, Rewards, 16 features total |
| 7. Subscription Tiers & Entitlements | FREE/DELUXE/PREMIUM/ULTIMATE comparison, upgrade/downgrade, billing |
| 8. AI Chat Assistant | Open/close, using chat, guardrails, connection states |
| 9. Admin Dashboard | Tabs overview, user subscription edit, security monitor, download report |
| 10. Mobile & PWA | Install as app, Android APK, mobile-specific UI |
| 11. Security & Privacy | Passwords (argon2id), sessions, 2FA, rate limits, lockout ladder, CSP |
| 12. Troubleshooting | Symptom → cause → fix table |
| 13. Developer Quick Reference | Repo layout, commands, environment variables |
| 14. Changelog Highlights | Recent changes (chat rewrite, path-traversal hardening, guest chat, etc.) |
| 15. Support & Contribution | Issues, security disclosure, PR process |

---

## 5. Key Modified Files — Backend

### `server/index.js` (+7 lines)
- **`/api/security` route registered** with `userLimiter` (non-escalating; reviewing your own security page must never count toward a lockout)
- **`/api/web3` route registered** with `userLimiter`
- `requestFloodGuard` applied globally as outer meter
- `bodyBudget`, `rejectOversized` added as Stage 2 parse middleware
- Per-route JSON limits: 1 MB general, 10 MB for base64-picture routes (`/api/auth/profile`, `/api/admin/profile`)
- `rejectOversized` mounted per-route ahead of `express.json()` to refuse oversized payloads from Content-Length before parsing
- `express.json()` deliberately NOT mounted globally — metering runs ahead of parsing

### `server/models/Session.js` (+31 lines)
- **Device attribution fields added:** `deviceLabel`, `platform`, `ip`, `location`, `trustedAt`
- All device fields are display-only — never used as authorization input
- `trustedAt` marks sessions holding a "save my login" credential
- Indexes: `{ user: 1, createdAt: -1 }` for admin/security views
- Device info populated via `describeDevice()` from `server/utils/device.js`

### `server/models/User.js` (+45 lines)
- **Recovery email fields:** `recoveryEmail`, `recoveryEmailVerifiedAt`
- **2FA fields:** `twoFactorMethod` (enum: `authenticator`, `email`), `twoFactorSecret` (select: false)
- **Login tracking:** `lastLoginAt`, `lastLoginIp`, `lastLoginUserAgent`, `lastLoginLocation`
- **Session management:** `currentSessionId`, `sessionVersion` (monotonic counter)
- **Virtuals:** `fullName` (computed), `age` (computed from DOB)
- **Pre-save hook:** Stamps `passwordChangedAt` in the same save as the new hash
- **Cascade delete:** Removes assessments, intake records, and dashboard metrics on user deletion

### `server/utils/securityAudit.js` (+4 lines)
- Updated `SECURITY_AUDIT` record to reflect completed remediation
- 30 total findings: 2 critical, 8 high, 9 medium, 7 low, 4 informational
- 23 remediated in code, 7 open/accepted
- 19 specific remediations listed
- 4 open items (localStorage admin token, userId in forgot-password response, admin provisioning email, per-route body limits)
- 4 informational items (JWT exp claim, shared cache, no CI, unmaintained deps)

### `server/routes/assessment.js`, `server/routes/auth.js`, `server/routes/dashboard.js` (various)
- Assessment routing updates
- Auth route hardening (step-up, lockout, recovery flows)
- Dashboard subscription updates

### `server/utils/email.js`, `server/utils/floodGuard.js`, `server/utils/lockout.js`, `server/utils/sessions.js`, `server/utils/totp.js`, `server/utils/password.js`, `server/utils/geo.js` (various)
- Email template additions for recovery email and status notifications
- Flood guard improvements for body budget and oversized payload rejection
- Lockout ladder refinements
- Session management with device attribution (`describeDevice` integration)
- TOTP replay cache fix
- Password hashing improvements

### `server/.env.example` (+3 lines)
- Added `RECOVERY_EMAIL` and related configuration placeholders

### `server/test-ddos-resilience.js` (+32 lines)
- DDoS resilience testing updates

---

## 6. Key Modified Files — Frontend

### `my-react-app/src/api.js` (+191 lines)
- **Complete rewrite** — new typed fetch wrappers
- **Session management:** Tab-scoped credentials (`sessionStorage`) + shared account directory (`localStorage`) + BroadcastChannel for cross-tab session handoff
- **Security API functions:** `getSecuritySummary()`, `getSecurityDevices()`, `getSecurityEvents()`, `revokeSecurityDevice()`, `revokeOtherSecurityDevices()`, `securityStepUp()`, `changePassword()`, `setTwoFactorMethod()`, `generateBackupCodes()`, `invalidateBackupCodes()`, `requestRecoveryEmail()`, `verifyRecoveryEmail()`, `removeRecoveryEmail()`
- **Base URL resolution:** Derives backend URL from page host for LAN/mobile support
- **Exports:** All security, auth, and subscription API functions

### `my-react-app/src/auth/authState.js` (+7 lines)
- BroadcastChannel relay additions for subscription sync
- `SUBSCRIPTION_REVALIDATE_EVENT` constant

### `my-react-app/src/hooks/useSubscription.js` (+16 lines)
- `resetSubscriptionStore()` closes SSE and clears throttles on sign-out
- BroadcastChannel relay for subscription changes
- Bound `canAccess` / `canAccessTier`

### `my-react-app/src/Components/UpgradeModal/UpgradeModal.jsx` (+87 lines)
- Upgrade modal redesign

### `my-react-app/src/Pages/ProfilePage.jsx` (+274 lines)
- Profile page restructure with security controls

### `my-react-app/src/Pages/ChatAssistant.jsx` (+118 lines)
- Chat panel fixes

### `my-react-app/src/Pages/HomePage.jsx`, `my-react-app/src/Pages/DashboardPage.jsx`, `my-react-app/src/Pages/AssessmentPage.jsx`, `my-react-app/src/Pages/HistoryPage.jsx`, `my-react-app/src/Pages/InsightsPage.jsx` (various)
- Various page-level updates

### `my-react-app/src/Pages/ChatAssistant.css`, `my-react-app/src/Pages/HomePage.css`, `my-react-app/src/Components/UpgradeModal/UpgradeModal.css`, `my-react-app/src/Pages/ProfilePage.css`, `my-react-app/src/mobile-responsive.css` (various)
- CSS updates for new components and responsive fixes

### `my-react-app/src/utils/securityReport.js`, `my-react-app/src/utils/wellnessReport.js` (various)
- Report utility updates

---

## 7. Architecture Patterns Introduced

### Step-Up Authentication
A security pattern where possessing a session token is not enough to change security settings.

```
User clicks "Change Password"
  → requireStepUp({ reason, action }) shows StepUpDialog
    → User enters password (+ TOTP if authenticator active)
      → Server verifies, issues 5-min session-bound JWT
        → action(stepUp) executes the mutating request
```

### Device Attribution (Presentation Only)
User-Agent parsing for device labeling. Never used for authorization decisions.

```
User-Agent string → browserOf() + platformOf() → deviceLabelOf("Chrome on Windows")
```

### Recovery Code System
Single-use recovery codes with SHA-256 hashing and conditional updates.

```
generate(userId) → 10 plaintext codes shown once → SHA-256 stored
consume(userId, code) → conditional update (usedAt: null filter) → single-use enforced
```

### BackupCode Model
```
BackupCode {
  user: ObjectId,
  batchId: String,      // for atomic batch replacement
  codeHash: String,     // SHA-256(plaintext code)
  createdAt: Date,
  usedAt: Date | null
}
```

### SecurityEvent Model
```
SecurityEvent {
  user: ObjectId,
  type: Enum(17 types),
  success: Boolean,
  ip: String,           // truncated, display-only
  userAgent: String,    // truncated, display-only
  location: String,     // "City, Country"
  reason: String,       // generic, never user input verbatim
  createdAt: Date
}
```

### PlanLockedCard Component Pattern
```
PlanLockedCard {
  featureLabel, requiresPlan, currentPlan, benefits,
  onViewPlans, onBack
}
→ Aurora gradient card with lock icon
→ Plan journey (current → required pills)
→ Benefits grid
→ Primary action button
```

---

## 8. Security Design Principles

| Principle | Implementation |
|-----------|----------------|
| **Fail-closed** | `resolveFeatureKey()` uses own-property lookup on prototype-less map; `hasFeature(plan, 'constructor')` returns false |
| **Step-up for security** | Password + TOTP required for MFA changes, backup code generation, recovery email changes |
| **Presentation-only attribution** | Device labels from User-Agent never gate authorization |
| **No secrets in logs** | IPs truncated, recipients masked, no passwords/hashes/TOTP seeds in any output |
| **Single-use codes** | Backup codes use conditional update (`usedAt: null` filter) to prevent replay |
| **Owner-scoped reads** | Every `find` pairs the ID with `req.user._id`; misses return 404 (not 403) |
| **Rate limit isolation** | Security read-only endpoints excluded from rate limits; admin/user buckets separated |
| **Body metering before parse** | `bodyBudget` and `rejectOversized` mounted before `express.json()` to protect against memory exhaustion |

---

## 9. Verification

All tests passing:

| Check | Command | Result |
|-------|---------|--------|
| Frontend lint | `npx eslint src` | 0 errors |
| Client unit tests | `npm test` (my-react-app) | 9/9 |
| Server unit tests | `npm test` (server) | 37/37 |
| Live subscription flows | `npm run test:flows` | 29/29 |
| Production build | `npx vite build` | OK (287 modules) |
| Frontend | `http://localhost:5173/` | 200 |
| Backend | `http://localhost:5000/api/health` | 200 |

---

## 10. Deliberately Not Done

- **No retroactive Priority-Assessment re-flagging on upgrade** — entitlements, gates, and `can()` still flip instantly; only historical re-flagging is pending.
- **`frame-ancestors` as HTTP header** — a `<meta>` CSP cannot carry it; requires server configuration.
- **CI pipeline** — manual action item from security audit.
- **Secret rotation** — JWT_SECRET, admin passwords, TOTP seeds, Gmail App Password must be rotated manually.

---

*Document generated from the uncommitted changes relative to commit `6daf284`. No commit or push has been requested or made.*
