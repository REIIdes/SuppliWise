# SuppliWise — Patch Notes, Build Log & Struggles

**Scope:** everything delivered in the current working session (all uncommitted).
**Baseline:** last commit `6daf284 "Adjustments in Session Expiry"`.
**Companion document:** [`SECURITY_AUDIT_REPORT.md`](./SECURITY_AUDIT_REPORT.md) — the full 30-item security audit (Phases 1–6). This file does **not** repeat that report; it records *what was patched*, *why*, and *what fought back*.

> **Verification caveat:** the desktop browser never connected during this session
> (`browser.disconnected`). Every number below is from lint, unit tests, integration
> tests and production builds. **Nothing in this session was confirmed visually.**
> Treat all UI descriptions as "built and compiled", not "seen working".

---

## 1. What was built / patched

### Phase 1 — Unified entitlement system (FREE → ULTIMATE)

One authoritative definition of what each plan gets, on both sides of the wire.

| Tier | Plan id | Rank | Unlocks |
|---|---|---|---|
| **FREE** | `free` | 0 | Health Assessment, Supplement Recommendations, Daily Intake |
| **DELUXE** | `monthly` | 1 | + Insights & Analytics, PDF Report Export |
| **PREMIUM** | `annual` | 2 | + Priority Assessment, 5-Year Record History |
| **ULTIMATE** | `custom` | 3 | + AI Chat Assistant (everything) |

Strict inheritance: every higher tier is a superset of the tier below it.

- **Backend (source of truth):** `server/utils/entitlements.js`
  — `FEATURES`, `resolveSubscription()`, `entitlementsFor()`, `describeSubscription()`,
  `can()`, `requireFeature()`, `requirePlan()`.
- **`server/utils/plan.js`** was verified as a pure re-export of that module — there is
  no second, divergent backend source to drift.
- **Frontend twin:** `my-react-app/src/subscription/features.js`
  — `PLAN_RANK`, `PLAN_ORDER`, `PLAN_LABELS`, `FEATURES`, `FEATURE_TIERS`,
  plus `resolveFeatureKey()` / `isKnownFeature()`.
- **Centralised API:** `my-react-app/src/utils/plan.js` → `hasFeature()`, `canAccess()`,
  `canAccessTier()`, `planFromUser()`, `applyPlanToCache()`.
- **Drift guard test:** `my-react-app/src/subscription/features.test.js` imports the
  *real server module* and asserts the two registries are byte-identical. If someone
  edits one side, CI fails.

**Fail-closed key resolution.** `resolveFeatureKey()` accepts the spec spelling
(`priority_assessment`, `analytics`, `pdf_reports`, `five_year_history`) and camelCase,
case-insensitively, but only through an **own-property** lookup on a prototype-less map.

### Phase 2 — Sign In / login page fixes

Validation messaging, error states and layout corrections on `/login`
(`LogIn.jsx` / `LogIn.css`, `SignIn`).

### Phase 3 — Notification panels (user + admin)

Hover- and scroll-anchored panels with a pointer arrow, in both the member navbar
and `AdminTopbar`. Made robust against page scroll and hover-gap traversal.

### Phase 4 — Security audit (30 items, Phases 1–6)

Full detail in `SECURITY_AUDIT_REPORT.md`. Summary of surface:

- **Secrets:** removed from code, logs, responses and bundle; final sweep clean.
- **Backend:** `auth.js`, login lockout, session handling, `totp`, `entitlements`,
  `index.js`, plus dashboard/assessment/polish routes.
- **Frontend:** `src/utils/safeUrl.js`, CSP `<meta>` in `index.html`.
- **Auditability:** `server/utils/securityAudit.js` → `SECURITY_AUDIT` record, served on
  `GET /api/admin/security/monitor`, rendered as an `AuditRecord` card in the admin
  **Live Status Monitoring / Security** widget.

### Phase 5 — Subscription: instant, centralised sync

**Requirement:** any plan change (admin upgrade / downgrade / cancel / expire / remove)
must reach an online user with **no refresh, no polling storm, no logout, no manual action**.

**Backend was already correct.** The live integration suite passed **29/29 before a
single line was changed** — every bug was frontend-architectural.

Root cause: **the subscription store's liveness was accidental.** The only always-mounted
`useSubscription()` caller was `GlobalChat → ChatAssistant`, itself `lazy()` inside a
`<Suspense fallback={null}>` and hidden on auth/admin routes. In those windows there was
no SSE listener, no expiry check, no revalidation.

Patches:

| File | Patch |
|---|---|
| `src/App.jsx` | New `<SubscriptionSync />` (SSE, expiry, revalidation) mounted in the router; `<SubscriptionStoreMount key={token} />` so the store remounts per session. Skipped for admin sessions (their `/auth/me` and `/subscription/stream` answer 403). |
| `src/hooks/useSubscription.js` | `resetSubscriptionStore()` closes the SSE and clears throttles on sign-out; BroadcastChannel relay; bound `canAccess` / `canAccessTier`. |
| `src/subscription/features.js` | `FEATURE_ALIASES`, `resolveFeatureKey`, `isKnownFeature` — own-property, fail-closed. |
| `src/utils/plan.js` | `hasFeature()` routes through `resolveFeatureKey()`; `canAccess`, `canAccessTier`. |
| 4 page components | **10 gate call sites** migrated off scattered `hasFeature(plan,…)` / `planMeetsTier` onto the centralised `canAccess`. |

Two bugs found *while* fixing the first:

1. **Sign-out left the previous user's plan on screen** for up to 30 s (user JWTs carry no
   `exp`, so nothing else invalidates it) and the dead stream kept listening. → reset on teardown.
2. **Account switch A → B kept `userSession === true`**, so the mount effect never re-ran
   and the new account inherited the old one's plan. → store keyed by token.

Plus the frontend twin of a Phase-4 backend fix:
**`hasFeature(plan, 'constructor')` returned `true` for FREE** — a truthy prototype member
with no `minTier`. Now own-property + fail-closed.

**Cross-tab:** BroadcastChannel `suppliwise:subscription`, same-account `_id` guard with an
`applyingRemote` echo-break. The payload was deliberately slimmed to subscription fields only —
the cached profile can hold multi-MB base64 images, and **credentials are never broadcast**.

### Phase 6 — ChatAssistant panel (`ChatAssistant.jsx` / `.css`, `mobile-responsive.css`)

| # | Bug | Root cause | Patch |
|---|---|---|---|
| 1 | Panel header cut off above the viewport | `max-height: 580px` + `bottom: 90px` needs **670 px** of viewport; any shorter window pushed the top off-screen | `max-height: min(580px, calc(100vh - 110px))`, `max-width: calc(100vw - 20px)`, same treatment for the ≤480 px rule |
| 2 | **Horizontal scrollbar across the chat** | `overflow-y: auto` makes `overflow-x` *compute* to `auto`, and nothing set `overflow-wrap` — one long URL widened the transcript | `overflow-x: hidden`, `overflow-wrap: anywhere` on `.chat-bubble` (inherited by all markdown), `height: 0` on the WebKit scrollbar, `overscroll-behavior: contain` |
| 3 | Jump-to-newest arrow floating over the wrong element | Hardcoded `bottom: 195px` from the window base (`145px !important` on mobile) while the chip row changes height as it wraps | New `.chat-messages-region` positioned wrapper; button anchored `bottom: 12px` **inside** the scroll region |
| 4 | Page behind the chat jumped while scrolling | Two effects fought: one `scrollIntoView()` (scrolls *every ancestor*, including the document), the other a `setTimeout` resetting `scrollTop = 0` | Single effect scrolling the container directly; also follows the typing indicator and re-focuses the composer |
| 5 | Composer could not shrink | Flex item `min-width: auto` pins the input to its intrinsic width | `min-width: 0` |
| 6 | Upgrade modal triggered a full page reload | `window.location.href = '/profile'` | `navigate('/profile')` |

### Phase 7 — Admin Profile: vibrant redesign + a real scoping bug

`AdminDashboard.jsx` (`ProfilePanel`) + `AdminDashboard.css`.

**Design work:**

- **Hero account card** — deep green→teal gradient, two blurred radial glows, amber/red
  gradient avatar tile, `Administrator` pill, and two glass "stat" cells
  (*Last login* / *Member since*) instead of loose grey text.
- **Section headers** — icons moved into gradient chips (violet for *Change password*,
  amber for *Rotate authenticator key*) that tilt on panel hover.
- **Panels** — 18 px radius, a 4 px colour-coded top rail, lift-on-hover, staggered entrance.
- **Forms** — tinted per-panel labels, 12 px rounded inputs, hover + focus rings, and a
  **stronger `:focus-visible` ring** for keyboard users.
- **Buttons** — full-width gradient pills with lift/press states and a defined
  `:disabled` look (the old flat `.admin-primary` / `.admin-secondary` look leaked through).
- **Alerts** — gradient background with a circular ✓/✕ chip.
- **QR panel** — violet dashed card, shadowed white QR tile, indigo manual-entry key.
- Responsive stacking at ≤640 px, plus a `prefers-reduced-motion` guard.

**Bug patched while doing it — CSS class-name collision:**

`ProfilePage.css` (the **member** profile) and `AdminDashboard.css` (the **admin** profile)
both define `.profile-page`, `.profile-form` and `.profile-alert`. Both stylesheets land in
the same document, so whichever chunk loads *last* wins — the admin rules could restyle the
member page, or vice-versa. Every selector in the admin profile block (≈40 of them, including
its `@media` query) is now prefixed with `.admin-shell`. All new rules are scoped the same way.

Two smaller traps avoided in the same pass:

- `.profile-eye:hover` had to restate `translateY(-50%)` — a bare `scale()` would have
  dropped the vertical centring and made the reveal button jump.
- Entrances use `animation-fill-mode: backwards`, **not** `both`. With `both`, a finished
  animation keeps winning the cascade, so every `:hover` transform would have silently
  done nothing. (The pre-existing `.ov-metric` rules have exactly this problem.)

---

## 2. Verification — all green

| Check | Command | Result |
|---|---|---|
| Frontend lint | `npx eslint src` | **0 errors**, 4 pre-existing warnings¹ |
| Client unit tests | `npm test` (my-react-app) | **9 / 9** |
| Server unit tests | `npm test` (server) | **37 / 37** |
| Live subscription flows | `npm run test:flows` | **29 / 29** |
| Production build | `npx vite build` | **OK** — 287 modules, SW generated |
| Frontend | `http://localhost:5173/` | **200** |
| Backend | `http://localhost:5000/api/health` | **200** |

¹ `HistoryPage:355`, `InsightsPage:146`, `ProfilePage:226`, `ResultsPage:680` — all
`react-hooks/exhaustive-deps`, all pre-existing, all in code this work did not functionally
change. Left alone deliberately.

---

## 3. Struggles we hit

### Blocked: no browser, so no visual truth
The desktop browser never connected (`browser.disconnected`, no playwright/puppeteer).
**Nothing visual could be confirmed this session:** multi-tab BroadcastChannel relay,
instant re-render on an admin plan change, CSP enforcement vs. Vite HMR, notification
hover/scroll/arrow behaviour, the `AuditRecord` widget, the stray `-` on `/login`, the chat
panel, and the admin Profile redesign. Everything rests on static analysis + tests + build.

### The screenshot vanished
The ChatAssistant screenshot was attached to the message but was **not in the session
uploads directory** (only six older Sign In shots were on disk), and the browser was down.
The chat fixes had to be derived from the described symptoms plus the source. If a symptom
remains, re-attach the image.

### The backend was already correct
The subscription suite passed 29/29 *before* any change. That meant no failing test to steer
by — the defects were architectural (mount timing, session teardown, prototype lookups) and
only visible by reading the React lifecycle, not by running the API.

### Store liveness was accidental
The subscription store only stayed alive because one always-mounted component happened to
call the hook — and that component was `lazy()` behind a `null` Suspense fallback. Nothing
in the code said "keep this alive"; it worked by luck.

### Account switch did not remount
`userSession` stayed `true` when switching token A → B, so the mount effect never re-ran and
the new user inherited the old user's plan. Found in a second review pass, not the first.

### A prototype member granted a paid tier
`hasFeature(plan, 'constructor')` was `true` for FREE — `constructor` is a truthy inherited
property with no `minTier`. The frontend mirror of a backend bug already fixed in Phase 4.

### The cross-tab payload was enormous
Broadcasting the cached profile pushed multi-MB base64 images between tabs. Slimmed to
subscription fields only — which also removed any chance of leaking credentials.

### Scrollbar where none should be
`overflow-y: auto` silently makes `overflow-x` compute to `auto`. Combined with no
`overflow-wrap` anywhere, a single long word opened a horizontal scrollbar across the chat.

### A fixed panel taller than the window
`max-height: 580px` + `bottom: 90px` = 670 px of viewport required. Below that the header
disappeared above the screen — invisible in code review, obvious in a screenshot.

### Magic numbers drifting
`bottom: 195px` on the jump button was wrong whenever the chip rows wrapped differently.
Replaced with a positioned wrapper so the offset is structural.

### `scrollIntoView` scrolling the document
It walks *every* ancestor. Inside the chat it dragged the page behind the panel along, and a
second effect then reset `scrollTop = 0` — two effects fighting over one container.

### Two profile pages, one set of class names
`.profile-page` / `.profile-form` / `.profile-alert` exist in both `ProfilePage.css` and
`AdminDashboard.css`. Load order decided who won. Fixed by scoping the admin block.

### Animations silently disabling hover
`animation-fill-mode: both` keeps winning the cascade after the animation ends, so the
`transform` in `:hover` never applied. Switched the new work to `backwards`.

### Environment friction
- **PowerShell has no `&&`** — commands must be chained with `;` + `$LASTEXITCODE` guards.
- **ESLint config is `js.configs.recommended` + browser globals**, so `no-undef` is active
  and lint passing is meaningful coverage; but **JSX is not checked by `node --check`**.
- **A self-inflicted slip:** one edit deleted `messagesContainerRef` instead of `bottomRef`.
  Caught by reading the file back before linting; corrected immediately.
- **The server restarted mid-session**, so work resumed from the checkpoint rather than from
  an in-flight command.
- **Concurrent user edits appear mid-session** (observed in `App.jsx` — the `GlobalChat`
  `/admin` guard). These are preserved, never overwritten.
- A leftover scratch file `write_chat_assistant.js` sits at the repo root; left untouched.

### Deliberately not done (awaiting your decision)
- **No retroactive Priority-Assessment re-flagging on upgrade.** Re-flagging historical
  *Severe Case* assessments on upgrade would fire notifications and block new-assessment
  creation; un-flagging on downgrade would discard an admin-only medical alert. Entitlements,
  gates and `can()` still flip instantly — only the historical re-flag is pending.

---

## 4. Outstanding manual actions (from the security audit)

**Highest priority — these are not code-fixable:**

1. **Rotate `JWT_SECRET`.**
2. **Rotate all 6 admin passwords.**
3. **Rotate all 6 TOTP seeds.**
4. **Rotate the Gmail App Password.**
5. **Purge git history** and decide whether the repo stays **public**.
6. Set **`TRUST_PROXY=true`** behind a reverse proxy (otherwise `req.ip` is spoofable).
7. Serve **`frame-ancestors` as an HTTP header** — a `<meta>` CSP cannot carry it.
8. **Add CI** so these test suites run on every push.

Accepted risks, documented **not** changed: `SupplementDetail` cache, 10 MB JSON body limit,
`speakeasy`, admin token in localStorage, CSP `script-src 'unsafe-inline'`, and user JWTs
carrying no `exp`.

> Historical secret values exist in public git history and are **burned**. They are
> deliberately not reproduced anywhere in this document.

---

## 5. Repository state

- **78 files modified/untracked, all uncommitted.** Last commit: `6daf284`.
- Remote is **public** (`github.com/REIIdes/SuppliWise.git`, branch `JDMv2`).
- Dev servers running: nodemon backend on **:5000**, Vite dev on **:5173**.
- New/renotable test entrypoints: `npm test` (client), `npm test` + `npm run test:flows` (server).
- **No commit or push has been requested or made.**
