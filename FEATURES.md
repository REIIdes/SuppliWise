# SuppliWise — Feature & Implementation Documentation

Everything added in this build: what it is for, how it works, and where it
is implemented. Companion docs: `SECURITY.md` (vulnerabilities),
`SYSTEM_ARCHITECTURE.md` (original architecture).

Run: backend `npm start` in `server/` (:5000), frontend `npm run dev` in
`my-react-app/` (:5173).

---

## 1. Code health sweep (no errors, no bugs baseline)

**Use:** keep the app shippable — zero lint errors, passing tests, fast builds.
**How it works:** all 90+ ESLint errors fixed (unused vars, hook violations,
false-positive TDZ refactors via lazy `useState` initializers and hoisted
fetch functions); backend `node --check` clean; `npm test` green.
**Implemented:** `my-react-app/eslint.config.js` (ignores `dev-dist`),
20+ files under `my-react-app/src`; `server/* --check`.

## 2. Performance fixes

**Use:** pages load in ~1 s instead of ~3 s on remote MongoDB (≈528 ms RTT).
**How it works:**
- Dashboard GET fetches metrics + today's records in parallel.
- Weekly adherence: 7 sequential queries → 1 `$in` query.
- Intake updates use `countDocuments` instead of full-history loads.
- `sanitize.js` regexes pre-compiled once at module load.
- Auth middleware excludes MB-size base64 pictures and uses `.lean()`.
- Route code-splitting: main bundle 1027 KB → ~190 KB + per-page chunks.
- DB indexes: `Assessment(user, createdAt)`, `User(createdAt/lastLoginAt)`,
  `AdminEvent(createdAt, type)`.
- Service-worker `/api` caching removed (it served stale dashboard data).
**Implemented:** `server/routes/dashboard.js`, `server/routes/insights.js`,
`server/middleware/auth.js`, `server/utils/sanitize.js`,
`server/models/*`, `my-react-app/src/App.jsx` (React.lazy),
`my-react-app/vite.config.js`.

## 3. Subscription plans (FREE / DELUXE / PREMIUM / ULTIMATE)

**Use:** admins sell four tiers; the app shows and enforces them.
Tiers: `free`→FREE, `monthly`→DELUXE, `annual`→PREMIUM,
`custom`→ULTIMATE. Inactive/expired/cancelled subscriptions always fall
back to FREE (resolved at read time — no cron needed).
**Structure:**
- FREE — Health Assessment, Supplement Recommendations, Daily Intake
- DELUXE — all FREE + Insights & Analytics, PDF Report Export
- PREMIUM — all FREE/DELUXE + Priority Assessment, 5-Year Record History
- ULTIMATE — unlocks all available features (incl. AI Chat Assistant)

**How it works:**
- Single source of truth: `server/utils/entitlements.js` (FEATURES table,
  `can()`, `requireFeature()`, `describeSubscription()`); the frontend
  mirrors it exactly in `my-react-app/src/subscription/features.js` and
  re-exports it from `src/utils/plan.js` (no inline tier math anywhere).
- `requireFeature(key)` middleware → 403 with
  `requiresPlan`/`currentPlan` (client shows upgrade prompt, never logs out).
  Applied to Insights, AI Chat; `can()` gates Priority auto-flag and the
  history depth check.
- History: page size capped per tier (5 / 10 / 20 / 20) AND page > 1 is a
  403 below PREMIUM — "5-Year Record History" is server-enforced.
- PDF export is rendered client-side (jsPDF), so the export path first calls
  `GET /api/subscription/feature/pdfExport` — the backend verdict decides,
  frontend visibility is UI only.
- All auth responses (`/me`, login, register, 2FA, profile update) carry a
  resolved `subscription` snapshot (`describeSubscription`) that honours
  expiry/cancellation; the client re-resolves it at read time as well.
- Live sync: `GET /api/subscription/stream` (SSE) pushes every admin
  upgrade/downgrade/cancel/remove instantly to the user's open tabs; a local
  expiry timer flips to FREE at `subscriptionExpiresAt`; a shared throttled
  poll + focus refresh back it up. All paths funnel into one store commit
  (`src/hooks/useSubscription.js`) that notifies pages exactly once per real
  change — no refresh, re-login, or profile reopen required.
- Admin PATCH (`/api/admin/users/:id/subscription`) normalizes plan aliases
  and never escalates a tier when `plan` is omitted.
- Admin User Management has a per-user plan dropdown; overview counters
  update optimistically.
- Profile page shows a status card + per-tier feature showcase (locked items
  greyed with lock icons for lower tiers) rendered from the registry.
**Implemented:** `server/utils/entitlements.js` (+ `utils/plan.js` shim),
`server/routes/insights.js`, `server/routes/chat.js`,
`server/routes/assessment.js` (cap + depth gate), `server/routes/auth.js`
(snapshot fields), `server/routes/admin.js` (subscription PATCH),
`server/routes/subscription.js` (state/feature/SSE),
`my-react-app/src/subscription/features.js`, `src/utils/plan.js`,
`src/hooks/useSubscription.js`,
`src/Components/UpgradeModal/*`, `ProfilePage`, `ChatAssistant`,
`InsightsPage`, `HistoryPage`, `ResultsPage`, `AdminDashboard`, `LogIn`,
`SignIn`.

## 4. Severe-case flagging → Priority reviews

**Use:** AI or admin flags dangerous assessments; the user is notified and
guided, admins are alerted.
**How it works (`server/utils/severity.js`):** rule-based scan of severe
symptom ratings, red-flag symptoms/conditions, concerning free text, and AI
warning text → `{ flagged, reasons[] }`. Runs on assessment create and when
AI results are saved (Premium+ auto-flag only; manual admin flags apply to
any tier). Flagging sets `priority: 'Priority'`, `expiresAt: null` (never
expires while flagged) and creates a user notification + admin event.
**Implemented:** `server/utils/severity.js`, `server/routes/assessment.js`
(`flagSevereAssessment`), `server/models/Assessment.js`
(`priority/flagReasons/flaggedAt/resolvedAt/resolvedReason/expiresAt`),
`server/models/UserNotification.js`, `ModifyAssessmentModal` (Priority /
Standard / Delete with timeout + 401 redirect), PRIORITY badges in
`AssessmentManagement` and `HistoryPage`.

## 5. Priority block gate (new assessments paused)

**Use:** while a Priority review is open, the user must finish it first.
**How it works:** `POST /assessment` returns 403 if any Priority assessment
exists; dashboard shows a red banner + "Paused" card + modal; the assessment
page shows a blocked screen (read-only history views unaffected); submit
rethrows 403 immediately. Lifted when no Priority items remain.
**Implemented:** `server/routes/assessment.js` (gate + `GET
/assessment/priority-status`), `server/routes/dashboard.js`
(`priorityBlock`, `priorityAssessments`), `DashboardPage`,
`AssessmentPage`.

## 6. Auto-lift on completion + strict re-flag on undo

**Use:** finishing all of today's supplements resolves the review; undoing
reinstates it — the restriction is real, not cosmetic.
**How it works (`POST /dashboard/intake`):** after each toggle it evaluates
today's completion. 100% on a Priority assessment → Standard, `resolvedAt`,
`resolvedReason: 'intake-complete'`, `expiresAt: now` (expires immediately),
user info notification + admin `resolved` event, response
`priorityLifted: true`. Incomplete on an auto-resolved assessment → back to
Priority (`expiresAt: null`, reasons noted), `priorityReflagged: true`, new
flag notification + admin event. Admin-manual resolutions are never touched.
Toasts on Track + Dashboard announce both transitions and refresh state.
**Implemented:** `server/routes/dashboard.js`, `TrackIntakePage`,
`DashboardPage`.

## 7. Assessment expiry lifecycle

**Use:** old records retire from active views but are never deleted; flagged
items have no expiry until resolved.
**How it works (`server/utils/assessments.js`):** `isExpired()` (Priority
never expires), `notExpiredFilter()` applied to all 8 dashboard lookups +
insights + day view, `findActiveAssessment()` helper. Expired → EXPIRED
badge/pill in History + admin list, delete allowed on expired only, dashboard
falls back to empty. History is read-only: `POST /intake` rejects
non-today `dayKey` with 400 (server-enforced, tested with forged past-day
toggle).
**Implemented:** `server/utils/assessments.js`, `server/routes/dashboard.js`,
`server/routes/insights.js`, `server/routes/assessment.js` (expiry
transitions on flag/resolve/manual), `HistoryPage`, `AssessmentManagement`.

## 8. Daily plan snapshot (missed days)

**Use:** every day lists what needed taking — untouched days read MISSED.
**How it works:** first dashboard load of a day with an empty plan seeds
today's intake records from AI recommendations (idempotent per-supplement
upserts, capped at 20). Calendar colors red (0%), yellow (partial), green
(100%); day-detail shows the full list read-only.
**Implemented:** `server/routes/dashboard.js` (snapshot block).

## 9. Interactive calendar + day history

**Use:** click any past date to see taken / not-taken supplements.
**How it works:** `GET /api/dashboard/day/:YYYY-MM-DD` (validated, future
rejected, lean minimal fields). Dates are buttons with legend colors,
selection ring, disabled futures, tooltips; detail panel with status pills,
summary, retry, and close. Read-only by design.
**Implemented:** `server/routes/dashboard.js` (`/day/:dayKey`),
`my-react-app/src/api.js` (`getDayRecords`), `TrackIntakePage`.

## 10. User + admin notifications

**Use:** users learn about flags/lifts; admins get actionable alerts.
**How it works:**
- Users: navbar bell with unread badge, dropdown (mark read on open →
  History, mark-all-read, per-item delete), 60 s poll + refresh on tab
  focus/return. `GET /notifications` self-heals: every Priority assessment
  is guaranteed a matching unread flag (covers pre-existing/manual flags).
- Admins: topbar bell panel; severe flags deep-link to Assessment
  Management; security items open the Security tab; mark-all-read + delete.
  Monitor probes + 10 s background refresh feed the list.
**Implemented:** `server/routes/notifications.js`,
`server/models/UserNotification.js`, `server/routes/admin.js`
(`/notifications/*`), `my-react-app/src/Components/UserNotifications/*`,
`Navbar`, `AdminDashboard`, `my-react-app/src/api.js`.

## 11. Login speed parity (≈280 ms user vs ≈870 ms admin total)

**Use:** sign-in feels instant.
**How it works:** OTP emails send in the background (fire-and-forget with
failure cleanup so retries stay possible); Nodemailer connection pooling
(`pool`, 3 connections); SMTP verified once at boot with clear logs.
**Implemented:** `server/routes/auth.js` (`sendOtpInBackground`),
`server/utils/email.js`.

## 12. Session robustness (no false logouts)

**Use:** users are never kicked out by a stray 401.
**How it works:** `handleAuthError` decodes the stored JWT first — session is
cleared only when the token is missing/malformed/expired; otherwise the
server message surfaces and the session survives. Admin idle guard
(3:30 + 30 s warning) moved into a memoized badge so the dashboard no
longer re-renders every second.
**Implemented:** `my-react-app/src/api.js`, `AdminDashboard`
(`AdminIdleStatus`).

## 13. Network resilience ("failed to fetch")

**Use:** app works from phones/tablets and survives blips.
**How it works:** backend URL derived from page host (LAN IPs work),
`VITE_API_URL` override supported; safe GETs retry once; timeouts on every
call (30 s default, 150 s AI, 45 s chat/detail); human-readable offline
messages; backend crash guards + 127.0.0.1 CORS origins.
**Implemented:** `my-react-app/src/api.js` (`getBaseUrl`, `apiFetch`),
`server/index.js`.

## 14. Login bug fixes

- Forgot-password for unknown emails no longer strands users on the OTP
  step (stays on email step with guidance; anti-enumeration preserved).
- 2FA/Authenticator login hides the email-OTP countdown (TOTP rotates in-app).
**Implemented:** `my-react-app/src/Pages/LogIn.jsx`.

## 15. Admin Assessment Management reliability

**Use:** user list loads fast and stays fresh.
**How it works:** `/admin/users` rewritten (lean rows + grouped counts,
868 ms measured; regex-escaped search); component self-loads when rendered
routeless, clears stale per-user lists on switch, refresh button + count,
focus-refresh, error + retry states.
**Implemented:** `server/routes/admin.js` (`GET /users`),
`AssessmentManagement.jsx`.

## 16. IP device / location intelligence

**Use:** admin sees device IP fallback and resolved locations.
**How it works (`server/utils/geo.js`):** loopback→"This device",
private→"Local network", public IPs geo-resolved (cached 24 h, 3.5 s cap,
fire-and-forget so login stays fast); admin list backfills unknowns in the
background; UI falls back to `IP x.x.x.x` when UA/location missing.
**Implemented:** `server/utils/geo.js`, `server/routes/auth.js`,
`server/routes/admin.js`, `AdminDashboard`.

## 17. Security hardening + live attack monitor (24 probes)

**Use:** prove protections continuously; catch regressions.
**How it works:** `GET /admin/security/monitor` runs system probes (login,
email, OTP, TOTP, DB, OpenRouter, delete, sanitize, hashing, salting) plus
behavioral attack probes (XSS, NoSQL, traversal, prototype pollution, brute
force/replay, CSRF, prompt injection, PII-in-AI, AI quota, JWT, headers,
enumeration, sensitive data, **rate-limit lockouts**). 60 s cache with
`?fresh=1` Sync-Now bypass, 10 s per-probe cap. Frontend table with expand,
banner, PDF report integration.
Patches along the way: OTP 5-attempt lockout, TOTP single-use cache,
escalating IP+account lockout ladder (15m→1h→6h→24h), sensitive-endpoint
limiter, NoSQL `str()` guards, HTML stripping, `scrubKeys`, AI prompt
`promptSafe()` + `<patient_data>` guard, SMTP pooling, audit-fixed
dependencies (0 vulns), crash guards, email TLD fix, image caps, AI payload
caps, admin try/catch coverage. Full list in `SECURITY.md`.
**Implemented:** `server/utils/attack_probes.js`, `server/utils/totp.js`,
`server/utils/lockout.js`, `server/routes/admin.js`,
`SecurityStatus.jsx`, `AdminDashboard` (PDF map).

## 18. Profile page (redesign + subscription)

**Use:** modern account hub with plan visibility.
**How it works:** cover header with legibility overlay, avatar with
unbreakable initial fallback, card sections with icons + focus glow,
subscription card (badge/plan/updated + skeleton/retry), per-tier feature
showcase (locked items greyed), `GET /api/auth/me` refresh, age display,
lazy localStorage hydration.
**Implemented:** `ProfilePage.jsx/.css`, `server/routes/auth.js` (`/me`,
PUT subscription fields).

## 19. Admin extras

Plan dropdown per user (FREE/DELUXE/PREMIUM/ULTIMATE) with optimistic
counters; high-contrast hamburger/back-arrow toggle with press pop-in;
staggered tab entrance, active-pill sweep, icon micro-interactions
(reduced-motion safe); monitor PDF word-boundary truncation + wider latency
column; monitor result caching.
**Implemented:** `AdminDashboard.jsx/.css`.

---

## Session 2 — 2026-09-22 additions

Every item below was verified with `eslint` (0 errors), `npm run build`,
backend `node --check` + `npm test`, and live tests against `:5000`/`:5173`
(throwaway data removed afterward). Servers: backend `npm start` in
`server/`, frontend `npm run dev` in `my-react-app/`.

## 20. Lockout sync fix (admin Clear vs login 429)

**Use:** the admin panel and the login gate can never disagree about lockouts.
**How it works:** all 429s carry `lockedBy: account|network`; `/admin/users`
and `/admin/overview` attach the same account + network-bucket state via one
`attachLockout()` helper; admin unlock clears account buckets, evidence IPs,
last-login IP (both `::ffff:` forms) and the requester's IP; Users tab
polls every 15 s + on focus without clobbering searches; unlock re-fetches
instead of optimistic UI.
**Implemented:** `server/routes/auth.js`, `server/routes/admin.js`,
`server/utils/lockout.js`, `AdminDashboard.jsx`, `LogIn.jsx`, `api.js`.

## 21. Account-status email notifier

**Use:** users get emailed on lockout, unlock, ban, and reactivation.
**How it works:** `sendStatusEmail(to, kind)` (lockout / back-online /
banned / reactivated) with branded HTML+text, validated address, never
throws; fired fire-and-forget from `reportAccountLockout`, admin
ban/reactivate transitions (transition-only), and admin unlock — each paired
with its in-app notice twin.
**Implemented:** `server/utils/email.js`, `server/utils/lockout.js`,
`server/routes/admin.js`.

## 22. Friendly device labels

**Use:** admin user rows show "Chrome on Windows 10/11" instead of the
broken `Mozilla/5.0 (Windows NT` fragment (first-3-UA-tokens bug).
**How it works:** `friendlyDevice()` parses browser (Edge checked before
Chrome) + OS with safe fallbacks; role badge capitalized.
**Implemented:** `server/routes/admin.js`, `AdminDashboard.jsx`.

## 23. Realtime lockout countdown

**Use:** the Locked badge ticks every second and never freezes/vanishes.
**How it works:** `LockoutCountdown` ticks locally against
`fetchedAt + remainingSeconds` (self-contained 1 s interval, pure-render
safe); at zero it re-fetches and only flips to Clear on server confirmation;
`usersFetchedAt`/`adminsFetchedAt` re-anchor it on every poll.
**Implemented:** `AdminDashboard.jsx`.

## 24. Admins management tab

**Use:** same card-box UI as Users, but for administrator accounts.
**How it works:** `GET /admins` (safe-field select — hashes/secrets never
leave the server) + `PATCH /admins/:id` enable/disable with self-disable
and last-admin guards; sidebar tab with shield icon, instant search, 15 s
poll, `(you)` marker, red `disabled` badge.
**Implemented:** `server/routes/admin.js`, `AdminDashboard.jsx/.css`.

## 25. Admin lockout status + unlock

**Use:** admins get the same lockout card users have (Clear/Reset, live
countdown, Unlock now).
**How it works:** `GET /admins` attaches alias-bucket lockout state;
`DELETE /admins/:id/lockout` clears alias + evidence IP buckets with an
audit event; toggle-merge preserves the badge (PATCH carries no lockout).
**Implemented:** `server/routes/admin.js`, `AdminDashboard.jsx`.

## 26. Provisioning: AdminRaNe

**Use:** additional admin account from `ADMIN_ACCOUNTS`.
**How it works:** bcrypt cost-12 hash + random base32 TOTP appended to
`server/.env`; boot upsert created the enabled DB record; password + TOTP
verified live.

> **Secrets removed:** this entry previously published the plaintext password
> and TOTP seed for `AdminRaNe`. It was committed to a public repository, so
> both must be rotated. Credentials now live only in `server/.env`
> (gitignored) and a password manager — never in documentation.

## 27. Chat gate button fix (CSS collision)

**Use:** "Maybe later" was green-on-green (unreadable).
**How it works:** `LogIn.css` redefined bare `.auth-btn` globally
(999px pill + `!important` gradient) and Vite bundles all CSS into one
scope. Fix: `.chat-auth-required .auth-btn` overrides (higher specificity +
`!important`): teal-gradient primary, white/dark-green secondary, 50px
targets, focus rings, reduced-motion safe. Login page untouched.
**Implemented:** `ChatAssistant.css` (verified shipping in built bundle).

## 28. Modify Assessment redesign

**Use:** vibrant priority/standard/delete actions.
**How it works:** pure-CSS makeover (no logic change): glowing pill
buttons (amber Priority, emerald Standard, rose Delete that fills red on
hover), staggered entrance, blurred backdrop, gradient ribbon + title,
spinning close chip.
**Implemented:** `ModifyAssessmentModal.css`.

## 29. Read-only assessment overflow fix

**Use:** left-clipped labels/title are gone everywhere the viewer renders.
**How it works:** `.ro-box` is fluid (`100%`, max 860px, centered) instead
of fixed 860px; new `ro-box--inline` variant + the previously-ignored
`inline` prop (History page); admin wrapper deframes via `:has()` with a
no-`:has` fallback; `min-width: 0` + `overflow-wrap` on values.
**Implemented:** `ReadOnlyAssessment.jsx/.css`,
`AssessmentManagement.css`.

## 30. Profile security activity + deep links

**Use:** Account Security card shows recent security events; bell
notifications land there.
**How it works:** new security-event notices on 2FA enable/disable and
password change/reset (`auth.js`); shared `isSecurityNotification()`
exact-title matcher (`api.js`); profile feed (newest 5, unread glow,
click-to-read) + `?section=security` smooth-scroll with emerald flash;
bell routes security items to profile, flags stay on history.
**Implemented:** `server/routes/auth.js`, `api.js`, `ProfilePage.jsx/.css`,
`UserNotifications.jsx`.

## 31. Results view redesign

**Use:** cooler, vibrant assessment results.
**How it works:** pure-CSS (`ard-` scoped): gradient section rules, mint
summary glow, pulsing amber doctor chip, emerald→teal card headers,
glass gradient priority pills, glowing confidence bar, staggered card
entrance, reduced-motion safe.
**Implemented:** `AssessmentResultsDisplay.css`.

## 32. Netflix-type instant search

**Use:** Users/Admins search-as-you-type, no button needed.
**How it works:** 400 ms debounced fetch on every keystroke (first render
skipped); Search button flushes immediately; background poll still skips
active searches; clearing restores the full list.
**Implemented:** `AdminDashboard.jsx` (Users + Admins).

## 33. Overview analytics

**Use:** the System Overview answers "what's happening" at a glance.
**How it works:** `/overview` adds one-round-trip analytics (signups
7d/30d, plan breakdown, 2FA count, live locked-account snapshot);
frontend renders a 14-day assessment bar chart (previously fetched but
never shown), plan-mix bars, and security/growth stats — pure CSS/SVG,
responsive collapse, fallbacks for old payloads.
**Implemented:** `server/routes/admin.js`, `AdminDashboard.jsx/.css`.

## 34. argon2id password hashing

**Use:** modern memory-hard hashing for users and admins.
**How it works (`server/utils/password.js`, `hash-wasm`, OWASP profile
19 MiB/2 iter): all new passwords hash argon2id; bcrypt still verifies
(zero downtime) with transparent upgrade on next login; pre-save skips
finished hashes (no double-hash). Admin login + admin password change
migrated; probes/checks accept both formats; `.env.example` updated.
**Implemented:** `server/utils/password.js`, `server/models/User.js`,
`server/routes/auth.js`, `server/routes/admin.js`. Verified 17/17 live.

## 35. Strict Content-Security-Policy

**Use:** close the last open HTTP-security gap.
**How it works:** `default-src 'none'` + `frame-ancestors 'none'` (safe:
API serves JSON only). Verified live in headers alongside existing
helmet/CORS/rate-limit/no-store posture.
**Implemented:** `server/index.js`.
