# 💊 SuppliWise — Your Personalized Supplement Advisor

> *Stop guessing. Start knowing what your body actually needs.*

A full-stack MERN web app with **PWA + Android APK support** that delivers **AI-powered, personalized dietary supplement recommendations** from a detailed health assessment — with subscription tiers, an on-chain provability layer, and an administrator control panel.

---

## 📑 Table of Contents

- [What Makes SuppliWise Different](#-what-makes-suppliwise-different)
- [Features](#-features)
  - [Health Assessment](#-health-assessment-4-steps)
  - [Dashboard & Tracking](#-dashboard--tracking)
  - [AI-Powered Recommendations](#-ai-powered-recommendations)
  - [Health Insights](#-health-insights)
  - [Meal Recommendations](#-meal-recommendations)
  - [Export to PDF](#-export-to-pdf)
  - [AI Chat Assistant](#-ai-chat-assistant)
  - [Assessment History](#-assessment-history)
- [Plans, Pricing & Entitlements](#-plans-pricing--entitlements)
- [Web3 / Blockchain Layer](#-web3--blockchain-layer)
- [Support & Notifications](#-support--notifications)
- [Admin Control Panel](#-admin-control-panel)
- [Profile & Account Security](#-profile--account-security)
- [Authentication](#-authentication)
- [Security Architecture](#-security-architecture)
- [AI Architecture](#-ai-architecture)
- [Mobile Support (PWA + Android APK)](#-mobile-support-pwa--android-apk)
- [Database](#-database)
- [Tech Stack](#-tech-stack)
- [Prerequisites](#-prerequisites)
- [Getting Started](#-getting-started)
- [Running the App](#-running-the-app)
- [Testing](#-testing)
- [API Surface](#-api-surface)
- [Documentation](#-documentation)
- [Project Structure](#-project-structure)
- [Important Notes](#-important-notes)

---

## ✨ What Makes SuppliWise Different?

- 🧠 **Real AI, not generic advice** — analyzes your full health profile and generates a clinical wellness plan tailored to YOU
- 🔐 **Enterprise-grade account security** — passkeys (WebAuthn), authenticator apps (TOTP), email OTP, single-use recovery codes, and step-up re-authentication
- 💎 **Four subscription tiers** — Free, Deluxe, Premium and Ultimate, with a Team band, enforced server-side
- ⛓️ **20 on-chain provability features** — supply-chain QR verification, escrow commerce, DAO governance, WELL token rewards and a user-owned health ledger
- 🛡️ **Admin control panel** — user management, subscription review queues, support inbox, and a live 45-probe security monitor
- 📱 **Progressive Web App + Android APK** — install on mobile, works offline with service worker caching
- 📋 **20 personalized supplement recommendations** — prioritized by clinical relevance with confidence scores
- 🔬 **Evidence-backed** — every recommendation cites real peer-reviewed studies with journal names, authors, and PMIDs
- 📄 **Export to PDF** — fully formatted clinical report, plus a dedicated security report from the admin console
- 💬 **Two chat surfaces** — a stateless AI assistant, and a real stored conversation with the support team
- 📲 **Multi-account, per-tab sessions** — sign into several accounts at once and switch between tabs without signing out

---

## 🚀 Features

### 🩺 Health Assessment (4 Steps)

| Step | What You Fill In |
|---|---|
| 1 — Basic Info | Age (auto-calculated from DOB for logged-in users), gender, weight (kg/lbs), height (cm/ft+in), physical activity level |
| 2 — Diet & Goals | Diet type (9 options with tooltips), health goals grouped by General / Fitness / Wellness |
| 3 — Medical & Symptoms | Medical conditions with per-condition symptom severity (Mild/Moderate/Severe), sleep quality, water intake |
| 4 — Lifestyle & Details | Lifestyle habits (Smoking, Alcohol, Recreational Drugs + drug type), supplements, blood test results, medications, allergies, sun exposure, protein intake, pregnancy/breastfeeding (optional, female only) |

- Weight supports **kg / lbs** toggle; height supports **cm / ft+in** toggle
- **9 diet types** with `?` info tooltips
- **Symptoms** with per-symptom severity and contextual descriptions
- **Age-aware tooltips** — pediatric, teen, adult, and senior supplement information
- All Step 4 fields are **optional** — the more you fill in, the more personalized the results
- 💾 Session-persisted progress — assessment saved even if you navigate away mid-flow
- 🛡️ Spam and garbage input detection on all free-text fields
- ⏳ **AI loading screen** with animated progress steps
- 📋 **Assessment History Viewing** — all 4 steps of past assessments, including symptom selections and severity
- 🚨 **Priority flagging** — severe cases are flagged for priority review (Premium+ entitlement, also settable by an admin)

### 📊 Dashboard & Tracking

- **Personalized Dashboard** — today's supplements, wellness score, and quick stats
- **Add Supplements to Plan** — dynamically add recommended supplements to your daily plan
- **Track Daily Intake** — mark supplements as taken/undo with real-time progress tracking
- **Smart Streak System** — earn streaks by completing 100% of supplements each day
  - Immediate +1 on completion; decreases if you undo before midnight
  - Resets at midnight if the previous day was incomplete
  - One increment per calendar day; adding supplements the same day breaks completion
- **Adherence Tracking** — overall adherence percentage and weekly patterns
- **Calendar View** — visual history of completion by day
- **Wellness Score** — AI baseline (0–30) + adherence bonus (0–50) + streak bonus (0–20) = max 100, with a hover tooltip explaining the math
- **Saved logins** — opt-in "Save my login" per browser, with a visible chip in device listings

### 🤖 AI-Powered Recommendations

- **DeepSeek V4 Flash (via OpenRouter)** generates a full clinical wellness plan
- **20 supplement recommendations** sorted by High → Medium → Low priority, then confidence score
- **Smart sorting** — supplements already in your plan move to the bottom
- **Toggle "Add to Plan"** — click once to add, click again to remove, with fast toast feedback
- Each card shows:
  - Priority badge + animated confidence score bar
  - **"Recommended for:"** — the exact conditions/symptoms/goals that triggered it
  - **🩺 Condition callout** — *"Since you reported Diabetes with moderate fatigue..."*
  - Dosage, timing, interaction warnings, and a professional disclaimer
- **Expand card** → evidence with RRL citations (PMID), food sources, side effects & safe limits
- **Tap for Details** → AI generates a personalized deep-dive for your specific profile
- Personalized daily schedule, meal recommendations, lifestyle advice, and 5-phase action plan
- 💙 **Seeking Support** section — shown when recreational drugs are reported, with 4 Philippine resources (DOH SAH 1550, DDB, DSWD Yakap Bayan, NCMH 1553)
- ⚡ Rule-based clinical fallback — always produces results even if every AI provider is unreachable
- 👶 Age-aware: pediatric doses, senior priorities, pregnancy/breastfeeding safeguards

### 📈 Health Insights

- **Today's Progress** — current day's completion with progress visualization
- **Adherence** — weekly adherence patterns with a bar chart
- **Overview** — current wellness phase and lifestyle recommendations
- **AI Insight** — personalized health guidance based on your assessment (Deluxe+)
- **Empty State Guidance** — helpful messages when no data is available yet

### 🍽️ Meal Recommendations

- Fully **diet-aware** — Vegan gets no animal products, Keto gets zero-carb, Paleo avoids grains/dairy
- **Allergy-safe** — checks every ingredient against reported allergies (fish, shellfish, nuts, dairy, eggs, gluten, soy, legumes)
- **Condition-specific** — Diabetes = low-GI only, Hypertension = DASH-aligned, Kidney Disease = low-phosphorus
- **Goal-matched** — energy goals get slow-release carbs, sleep goals get tryptophan/magnesium-rich dinners

### 📄 Export to PDF

- Fully formatted A4 PDF report — from Results, History, or the admin console
- Cover shows **prepared for name**, date and time of generation
- Sections: clinical summary, consult-doctor alert, patient profile, recommendations, evidence & RRL citations, daily schedule, lifestyle advice, meals, action plan, warnings & avoid list, **seeking support** (if applicable)
- Dedicated **Security Report** export from the admin Security Center (controls, live monitors, audit record, recommendations)

### 💬 AI Chat Assistant

- Floating **Ask AI** bubble available on all user pages (hidden on auth pages, `/support`, and the whole admin area)
- **Auto-scroll to top** on open, plus a **scroll-to-bottom button** while reading history
- **Typo handling** — detects health/supplement misspellings and gently corrects them
- **Scoped to health, nutrition, and SuppliWise topics** — politely declines off-topic requests
- **Safety guardrails** server-side (`chatSafety.js`) keep answers inside the health domain
- Multi-turn conversation with history context, quick prompt buttons, and a local fallback when AI is unavailable
- **Ultimate tier entitlement** — gated server-side, not just hidden in the UI

### 🕐 Assessment History

- View all past assessments with full AI results
- Tabs: Assessment data, Supplements, Schedule & Recovery, Meals, Lifestyle, Warnings (+ Seeking Support if applicable)
- **Tap for Details** works from history — cached per assessment (no repeat API calls)
- View, download PDF, or delete — all from the history card
- Page depth scales with plan (Free 5 / Deluxe 10 / Premium+ 20 per page)
- **Update Health Assessment** — re-take the assessment from the history page: the expanded **Active** card pre-fills the form with your previous answers, and the new assessment is linked to the one it updated ("Updated from your previous assessment" on its card)
- Intake records, streaks, and adherence metrics carry over to the new assessment — tracking continues instead of restarting at zero
- In update mode the new AI plan is generated **before** anything is saved, so a failed AI call leaves your last assessment, recommendations, and intake history untouched

---

## 💎 Plans, Pricing & Entitlements

SuppliWise has four tiers. The stored plan ids (`free`, `monthly`, `annual`, `custom`) are the contract for the whole entitlement system and are never renamed — only the display names are.

| Plan | Stored id | Unlocks |
|---|---|---|
| **Free** | `free` | Health Assessment, Supplement Recommendations, Daily Intake |
| **Deluxe** | `monthly` | + Insights & Analytics, PDF Report Export, **the entire Web3/blockchain layer** |
| **Premium** | `annual` | + Priority Assessment, 5-Year Record History |
| **Ultimate** | `custom` | + AI Chat Assistant — every feature SuppliWise has |

There are exactly four plans. A fifth "Team" band was removed on purpose: it was priced
per seat but granted exactly what Premium already granted, it was not a real tier (there is
no `team` plan id), and no account could ever hold a second seat — there was no invitation
or membership mechanism. `plan-catalogue.test.js` enforces its absence.

### How the billing model actually works

- A purchase is exactly **30 days** (`STANDARD_PERIOD_DAYS`). **Nothing renews automatically.**
- Buying again **extends** the window instead of restarting it — no paid day is ever discarded.
- Changing plan applies **immediately**, with no sign-out.
- When the days run out, the account returns to Free — **assessments and history are kept, not deleted**.
- There is no refund system; every "refund" in the codebase is Web3 marketplace escrow, a different product.

### Purchase and approval flow

1. `/pricing` is **public** — a visitor must be able to compare plans before creating an account.
2. A signed-in user picks a plan, is shown the server-computed amount, and submits a **plan request** with a payment reference and optional proof-of-payment image.
3. An **admin reviews the request** in the control panel and approves it (optionally overriding how many days are granted) or declines it with a note.
4. The member sees the decision, and the granted plan is live immediately.

Cancellation requests run through the same review model in the opposite direction.

### Currency

- Base prices live in **PHP** on the server; every other currency is derived there, so a displayed price can never disagree with the charged price.
- Detection order: saved preference → `?currency=` query param → `Accept-Language` → geo → PHP.
- The picker always states where the number came from ("based on your location", "your chosen currency", …).

### Entitlement enforcement

- The **server** is the single source of truth (`server/utils/entitlements.js`). The frontend mirror (`src/subscription/features.js`) exists only to render gates and upgrade prompts instantly.
- Feature lookup **fails closed**: unknown keys and prototype keys (`constructor`, `__proto__`, …) return `null`, so every gate answers "locked".
- Plan changes reach the UI over **SSE** (`/api/subscription/stream`), with a focus refresh, an expiry watch, and a cross-tab relay.
- The entitlement store is keyed by **token**, so an in-place account switch can never hand one account's plan to the next.
- A tasteful `PlanLockedCard` replaces dead-end "🔒 + two grey buttons" screens: it states the value first, shows the literal plan gap, and lists what the upgrade actually buys.

---

## ⛓️ Web3 / Blockchain Layer

SuppliWise runs a **self-contained, simulated proof-of-work chain inside the app**. There is no external chain, no gas, no funded wallets, and no RPC endpoint.

> **MongoDB is the source of truth.** The chain is a tamper-evident **audit anchor**, not a second source of truth. The contract in `server/blockchain/engine.js` is: *mutate the database first, then anchor the change — an anchor failure is logged and never fails or rolls back the business operation.*

**Privacy is non-negotiable:** personal data is never written on-chain. Anything sensitive is reduced to a `sha256` digest over canonical JSON (`stableStringify`), so the same payload always produces the same hash.

### The 20 features

| # | Feature | What it does |
|---|---|---|
| 1 | **Supply chain tracking** | Forward-only batch journey (`raw-sourcing → … → delivered`) with a **public** QR scan view that recomputes every proof |
| 2 | **Verifiable certifications** | Lab / organic / non-GMO / third-party / GMP digests anchored with their block index |
| 3 | **Smart-contract escrow** | Buyer funds locked in `sw_system_escrow`; delivery confirmation executes the split (seller paid − DAO fee) |
| 4 | **P2P marketplace** | Verified listings and orders, priced against oracle feeds |
| 5 | **Decentralized identity (DID)** | ed25519 wallet, `did:suppliwise:<userId>`, PKCS#8 PEM private-key export (owner only) |
| 6 | **User-owned health ledger** | Rolling digest over real assessments + intake volume; **signed portable credential** export |
| 7 | **Data sovereignty** | Coarse, anonymised dataset (age band, gender, volume bands) shared with on-chain consent **and revocation that destroys the payload** |
| 8 | **Decentralized storage** | AES-256-GCM at rest, `bafy…` content address, recomputed on fetch for tamper evidence |
| 9 | **WELL token rewards** | Streak-scaled daily check-in, intake, assessment and data-share rewards — idempotent per day |
| 10 | **Achievement NFTs** | Eligibility computed server-side from real activity, minted soulbound, concurrency-safe |
| 11 | **Staking** | APY-pro-rated yield, threshold-gated premium unlock, partial unstake |
| 12 | **Loyalty program** | Burn WELL for a one-time `LOY-…` code that discounts a marketplace order |
| 13 | **DAO governance** | Stake-weighted, quorum-gated proposals that **actually apply the parameter** on passage |
| 14 | **Community knowledge base** | Publishing and upvote rewards with caps; self-upvotes and double votes rejected |
| 15 | **Dispute resolution** | Jurors drawn from staked non-party wallets; parties can never vote on their own dispute |
| 16 | **Interoperable health profile** | Time-boxed, revocable share link readable by a clinician with **no account** |
| 17 | **Verifiable AI recommendations** | Inputs, outputs and logic version hashed separately; any drift fails re-verification |
| 18 | **Clinical trial consent** | Exact terms hashed and anchored; opt-in and withdrawal both recorded |
| 19 | **Oracle feeds** | Six feeds re-derived deterministically per day and anchored on change |
| 20 | **Expert consultations** | Tokenized booking at `rate × hours` into `sw_system_expert_pool`, refundable on cancel |

### Foundation guarantees

| Concern | Implementation |
|---|---|
| Ledger | Append-only PoW chain, `{index, timestamp, prevHash, nonce, hash, txs}`, difficulty `3` (`CHAIN_DIFFICULTY`) |
| Integrity | `GET /api/web3/chain/verify` recomputes every header hash and `prevHash` linkage |
| Key custody | Private key sealed in an AES-256-GCM envelope keyed from `JWT_SECRET` |
| Reward safety | Unique index `(user, kind, refId)` — a double click can never mint twice |
| Economics | `DEFAULT_PARAMS` in `server/models/Web3.js` — all rates, fees and quorum in one DAO-governed document |
| Public surface | Only `GET /verify/:code`, `/verify/:code/qr` and `/share/:token` are public; everything else is `protect` + `userOnly` |
| Gating | `/web3`, `/marketplace`, `/governance` render a plan gate **instead of** the page, so a sub-tier user never triggers the panels' fetches |

Full feature→code mapping and proof: [`BLOCKCHAIN_FEATURES.md`](BLOCKCHAIN_FEATURES.md) · manuals: [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md), [`docs/DEVELOPER_MANUAL.md`](docs/DEVELOPER_MANUAL.md)

---

## 💬 Support & Notifications

Two deliberately separate chat surfaces, because they answer very different questions:

- **AI Chat Assistant** — a stateless assistant that can only reason over documentation.
- **Support** (`/support`) — a **stored conversation with a person**. Requires a session (a guest has no account for an admin to reply to). Threads carry status (`waiting on us` / `waiting on member` / `resolved`), a category (payment, billing, account, technical, other), and a resolved-threads-are-read-only rule.

### Member side

- Open a thread, reply, and see the admin's answer in the same transcript
- Unread badge and hints, jump-to-latest, auto-follow only when already at the bottom

### Admin side

- Two-pane inbox with status cards as filters, topic filter, debounced search, and 12-second queue polling (paused when the tab is hidden or a send is in flight)
- Reply with a 2000-character cap (Enter sends, Shift+Enter newlines), mark resolved, reopen, or delete spam
- Full keyboard triage (ArrowUp/Down to move, Escape back to the queue)

### Notification inbox

`/api/notifications` powers an in-app inbox: unread count, mark-read, mark-all-read, delete one, delete all read. It is a **mutable** surface — distinct from the append-only `SecurityEvent` log.

---

## 🛡️ Admin Control Panel

A separate identity space at `/admin`, guarded by `protect` + `adminOnly` and a mandatory authenticator step. It is a different product surface from the member app and is never reachable from user navigation.

### Admin authentication

- Alias + password sign-in, then a mandatory **TOTP** challenge
- `mustChangePassword` is carried on the response and **enforced server-side** (403) until it is satisfied
- Server-defined **idle window** (10 min default) with a live client countdown driven by the same value, so the two cannot disagree
- Token lifetime (15 min default) must exceed the idle window — the server **refuses to boot** if the two are mis-ordered
- Auto-renewal at ~60% of lifetime and on tab wake; any 401/403 clears the token and returns to `/admin/login`
- Client activity reporting (max once/minute) keeps the server clock honest

### Eight console tabs

| Tab | What it gives you |
|---|---|
| **Overview** | Users / assessments / active / inactive cards, 14-day activity chart, plan-mix donut, 2FA adoption, signups 7 & 30 day, recent signups, threat panel. Auto-refresh 10s; per-panel `Promise.allSettled` so one failing endpoint never blanks the rest |
| **Users** | Debounced search, filter cards, expandable detail, ban/unban, clear lockout, permanent delete, and an inline subscription editor. Passwords and hashes are never returned |
| **Admins** | Admin roster with enable/disable and lockout clearing |
| **Subscriptions** | Plan-request and cancellation queues with proof-of-payment images, overridable day grants, decision history, and a 409 re-fetch on already-reviewed conflicts |
| **Chats** | The support inbox (above) |
| **Assessment** | Per-member assessment lists with ACTIVE/EXPIRED and PRIORITY pills, read-only view, AI results, PDF export, and a modify/delete modal |
| **AI** | Cached provider status per configured provider, with a forced re-check that reloads `.env` |
| **Security** | The live monitor (below), the static audit record, and the security report export |

### Live security monitor

- **45 probes** — 25 core platform + 20 blockchain-layer — refreshed every 30s with a manual `?fresh=1` sync
- Per-probe status (Healthy / Warning / Critical / Error), framework chip, implementing file, latency, expandable detail rows, expand-all
- Search, status chips with counts, framework filter, and summary tiles
- 20-second request timeout so the panel cannot hang on a stalled connection

### Subscription administration

- Per-user panel: grant / re-grant, add days, deduct days, extend or set expiry, make permanent, change plan
- **Two-layer display** — effective state vs. the user's own paid subscription vs. admin override
- Restore original (captures and returns the user's exact prior paid state), clear override, remove subscription
- Full change log with actor, note and plan transition

### Administrator credential tooling

- `npm run notify-admins` — a **secret-free** notice that stored credentials changed. Safe to re-run.
- `npm run send-admin-credentials` — a **one-time hand-off** carrying alias, password and TOTP seed. Never scheduled.

These are kept as two separate code paths rather than one with a flag, precisely so the recurring channel can never grow a password field.

---

## 👤 Profile & Account Security

Security decisions live in their own panels, not buried inside "Edit Profile" next to name and date of birth.

| Panel | Capability |
|---|---|
| **Two-Factor method** | Authenticator app vs. email codes, with a strength indicator |
| **Password** | Current password + new password against the shared policy, with a live rule checklist |
| **Recovery codes** | Generate, view once, invalidate all |
| **Recovery email** | Add / change / remove a secondary address with OTP verification and masked display |
| **Passkeys** | Register, rename, remove, conditional-mediation autofill, capability detection |
| **Session activity** | Signed-in devices with label, platform, location, IP and auth method; per-device sign-out and sign-out-everywhere-else |
| **Security history** | Newest-first feed of this account's own security events with success/failure indicators |
| **Step-up dialog** | The re-authentication prompt shown before any security-mutating action |

- **Profile picture** — drag-and-drop or click-to-browse, with storage migrated to disk and served as an absolute path
- **Banner picture** — customizable profile banner
- **Change email / name / DOB** — with OTP verification and a countdown for the email path
- **Billing view** — current plan, days remaining, upgrade/cancel requests, and purchase history
- **Saved logins** — per-browser saved credentials with a visible trust chip

---

## 🔐 Authentication

### Member sign-in / sign-up

- Register with a **math CAPTCHA** (single-use, server-issued), name/gender/email/DOB validation, and the shared password policy
- **Enumeration-safe login** — unknown user and wrong password produce identical bodies and timing; the unknown-user path burns a throwaway password compare to equalize it
- Ban/inactive checks run **after** the password proof (they were previously an unauthenticated oracle)
- Legacy bcrypt hashes are transparently upgraded to argon2id on successful login
- New-device detection compares the stored user agent and raises a notification plus status email
- **Saved login** — opt-in, exchanges a stored hash for a fresh JWT on the same session; 30 days, and it dies with the session

### Multi-factor options

| Factor | Details |
|---|---|
| **Email OTP** | 6 digits, 10-minute TTL, in-memory store, 5 wrong attempts before invalidation, 30s resend cooldown, branded templates. Stored only *after* successful delivery |
| **Authenticator app (TOTP)** | speakeasy, 6 digits / 30s / SHA-1, ±1 step window, **seed encrypted at rest** (AES-256-GCM), replay cache keyed by account + secret + code |
| **Passkeys (WebAuthn)** | `@simplewebauthn/server` — no hand-rolled crypto. Account resolved from the verified credential only, registration challenges bound to user + session + userHandle and spent before verification, signature-counter rollback detection, stable 32-byte `webauthnUserId` handle |
| **Recovery codes** | 10 codes, ~49.5 bits each with rejection sampling, only SHA-256 stored, plaintext shown exactly once, single-use enforced by a **conditional update** on `usedAt: null` |
| **Recovery email** | 6-digit verification, 15-minute single-use proof, address not stored until verified, and never allowed to be the account's own or another account's address |

- An account with `twoFactorEnabled` but no readable secret **falls back to email OTP** rather than locking the user out forever
- Disabling 2FA clears the seed entirely and destroys all recovery codes
- Removing the last strong method is refused with `409` — you cannot strand an account
- Setup, verify, disable, backup-code and recovery-email mutations all require **step-up**

### Password policy and reset

- One shared policy (`server/utils/passwordRules.js`): **10–128 characters**, upper + lower + digit + symbol
- Blocklist of common passwords, decorated variants, sequences and repeated runs; refuses passwords built from the account's email local part
- 0–4 strength score with a rule-by-rule checklist, served **over the wire** so the UI cannot drift
- **Reset is a link flow** — `request → validate → complete`, a 256-bit random grant stored only as SHA-256 with a Mongo TTL index, 30-minute lifetime
- Reset revokes **all** sessions, burns outstanding grants, and emails the account owner
- Enumeration-safe: the same `200` body whether or not the account exists or mail went out
- Standalone `/forgot-password` and `/reset-password?token=…` pages — not a modal, because the link is followed from an email client, usually in a new tab and possibly hours later

### Sessions

- **One active session per account**, enforced atomically through `User.currentSessionId`. A new sign-in revokes only the displaced session of the *same* account, so multi-account use is unaffected
- **User sessions do not expire.** There is no idle timer and no `exp` claim — a member is signed out only by signing out, by a newer sign-in, by a password reset, or by the account being disabled. `Session.expiresAt` exists purely as an operator lever
- **Admin sessions do expire** — they are the higher-privilege account
- Middleware validates: session exists → owned → unrevoked → is current → not expired → account active, with a 30s validation cache and immediate invalidation on sign-out
- Bearer header only — query-string tokens are rejected, JWT algorithm pinned to HS256
- Browser side is **per-tab `sessionStorage`** with a shared account directory in `localStorage` and a `BroadcastChannel` for cross-tab session handoff, so several accounts can be open at once

---

## 🛡️ Security Architecture

| Layer | What it does |
|---|---|
| **Headers** | Helmet with a Content Security Policy; CORS with an explicit allowlist (never a wildcard with credentials) |
| **Password hashing** | argon2id (19 MiB, t=2, p=1) via `hash-wasm` — no native build. Legacy bcrypt verified and transparently upgraded |
| **Step-up authentication** | Possessing a session is not enough to change security settings. A 5-minute, session-bound JWT traded for password **+ current TOTP**, carried in `X-Step-Up` and never in a URL |
| **Escalating lockout ladder** | 15 min → 1 h → 6 h → 24 h, with offence history decaying after 30 days and a 3-strike account counter. The 2FA ladder is capped at 1 h so an attacker cannot DoS a victim's recovery |
| **Credential-stuffing tripwire** | 20 distinct failed accounts per IP / 15 min → 5-minute cooldown, in a bucket separate from the hard stop |
| **Flood guard** | Global per-IP envelope that meters but never escalates the ladder |
| **Body metering** | Global in-flight JSON byte cap plus a `Content-Length` pre-check, both mounted **before** `express.json()`, so metering runs ahead of parsing |
| **Owner-scoped reads** | Every `find` pairs the object id with `req.user._id`; a miss returns **404, never 403** |
| **Secret custody** | TOTP seeds and Web3 private keys sealed with AES-256-GCM; production refuses to boot without `TOTP_ENCRYPTION_KEY` |
| **Security event log** | Append-only, closed enum of ~35 event types with a fixed metadata allowlist. No free-form field, so a secret cannot be smuggled into an event |
| **Password field hardening** | Client blocks copy/cut/paste/context-menu/drag/select on every password input and collapses any selection on focus |
| **Error boundary** | Global boundary with a one-shot self-heal for stale dynamic-import chunks, so a recoverable build skew never shows a white screen |
| **Configuration** | Security-critical env values are validated at boot; a nonsense rate limit is warned about and ignored, so a typo can never disable protection |

### Live monitor

The admin Security Center runs **45 probes** (25 core + 20 blockchain) every 30 seconds. Audit record: **30 findings** — 2 critical, 8 high, 9 medium, 7 low, 4 informational — with 23 remediated in code and 7 open/accepted. See [`SECURITY_AUDIT_REPORT.md`](SECURITY_AUDIT_REPORT.md) and [`docs/AUTH_SECURITY_REPORT.md`](docs/AUTH_SECURITY_REPORT.md).

---

## 🧠 AI Architecture

### Providers & routing

Features are dispatched through **one routing table** (`server/utils/aiRouter.js`) rather than by hard-coding a vendor inside each route:

| Purpose | Provider | Fallback | Default model |
|---|---|---|---|
| `assessment` | **OpenRouter** (default) | — | `deepseek/deepseek-v4-flash-0731` |
| `chat` | **Anthropic** | OpenRouter | `claude-haiku-4-5-20251001` |
| `polish` | **OpenAI** | OpenRouter | `gpt-5.4-nano` |
| `supplementDetail` | **OpenRouter** (default) | — | `deepseek/deepseek-v4-flash-0731` |
| `systemDetection` | **Groq** | — | `openai/gpt-oss-120b` |
| `priorityFlagging` | **Anthropic** | — | `claude-haiku-4-5-20251001` |

The features that generate a member's health plan — assessment and detail mode — stay on OpenRouter. `polish` is deliberately **not** on the default: it is the busiest call in the product (every assessment submit polishes a free-text description first) and the shortest job, so a nano-class model on its own provider is the right shape and keeps it off the shared quota. System detection and threat prediction — short, structured, latency-sensitive, and running on a timer — go to Groq. The chat assistant and priority assessment flagging go to Anthropic.

`chat` and `polish` are the two purposes with a **fallback** (OpenRouter). This is load-bearing, not decoration: a provider key can be perfectly valid and still unable to serve a single completion, because Anthropic answers an exhausted balance as a 400 that the model-list health probe cannot see. Without a fallback, moving chat to an unfunded account would put every user on the canned offline reply. The primary is still tried first; the fallback is reached only when it genuinely cannot answer, and `source` in the response names the provider that *actually* replied.

A **declared fallback** (reached when the primary genuinely cannot answer) is a different thing from the **default provider standing in** for a purpose whose own provider is entirely unconfigured; the latter is tagged `viaDefault: true` so the admin panel can report a substitution that actually happened.

To change the split, edit `AI_ROUTES` in `aiRouter.js`. Nothing else needs to know.

**Why the routing table exists:** each call site used to hard-code its own URL and model string, and they had already drifted apart — `chat.js` and `polish.js` sent `deepseek/deepseek-v4-flash` while the admin panel reported `deepseek/deepseek-v4-flash-0731` for the same key. OpenRouter's probe cannot catch this (its model list is ~752 KB and will not fit inside the 5 s probe budget), so it would have surfaced only as a failed user request. A single table removes the possibility rather than the instance.

> ⚠️ **Model ids depend on your key.** Groq and Anthropic both serve different model lists per tier. `openai/gpt-oss-120b` is the strongest model the shipped Groq key can reach; `llama-3.3-70b-versatile` is **not** among its 11. Anthropic's key serves 13 (the `claude-fable-5` / `haiku` / `sonnet` / `opus` families). Check your own list before overriding `GROQ_MODEL` or `ANTHROPIC_MODEL` — a model your key cannot serve fails the first real call, not the health check.

`server/utils/aiProviders.js` holds the provider registry (OpenRouter, Groq, OpenAI, Anthropic) so the admin AI tab can show which keys are actually live rather than which ones are merely configured. Every provider is probed with a real HTTP request, and a key that works but points at a model it cannot reach reports **`Model unavailable`** — a distinct state, because "add a key" is the wrong advice for it.

Anthropic's Messages API is **not** OpenAI-shaped: it takes `system` as a top-level field, has no `role: 'system'` message, and rejects adjacent same-role turns. The router builds a different request body and reads a different response shape per provider (`wire: 'anthropic'`), lifting `system` out of a conversation, merging same-role turns and dropping a leading assistant turn — a chat history does not naturally satisfy any of those. Provider-specific tuning that has no cross-provider equivalent (OpenRouter's `reasoning.effort`) is passed as `extraBody` and applied to the OpenAI-shaped wire only, since Anthropic answers an unknown top-level key with a 400.

### Priority assessment flagging

`utils/severity.js` decides whether a submitted assessment is severe enough to raise a Priority review. It is a deliberate rule engine — fixed lists of red-flag symptoms, critical conditions and emergency phrases — which is auditable, instant, and cannot be talked around by the wording of a free-text field. Its own header records why it was tightened: it once flagged nearly everything, because the word "severe" in a generic AI disclaimer matched.

A fixed list only finds what someone thought to write down. `utils/priorityFlagging.js` adds a second opinion from Anthropic that reads the same submission as free text, looking for clinical concern the keyword list missed.

**The invariant: this layer can only escalate.** The final flag is `ruleVerdict.flagged || aiEscalated`. The AI can add a flag and add reasons; it can never remove one. The asymmetry is deliberate:

- A missed severe case is a clinical risk nobody reviews.
- A spurious flag pauses a user's new assessments — a real cost this codebase has already been bitten by (see `priorityGate.js`: "the panicked user", a gate with no exit).

So an AI-only flag requires **all** of: the rules did *not* flag, confidence ≥ 80, and at least one citable reason. Any failure — no key, no credit, rejected, timeout, unparseable reply, a reply that fails validation — leaves the rule verdict completely untouched. `analyzeSeverity` is deliberately left synchronous, pure and unmodified as that floor.

**Privacy:** only health fields are sent — never a name, email or picture. Patient free text is stripped of emails, phone numbers and handles, and instruction-override phrases are defanged, because `feelingDescription` is written by whoever filled in the form.

> ⚠️ **A valid Anthropic key is not enough.** An account with no credit authenticates fine and serves the model list, so the health card reports **Reachable** while every completion fails and the feature silently never runs. The health probe cannot see this, so the admin panel reports the **last real call** on a separate line. That is the row to read.

### System detection & threat prediction (`/api/admin/ai`)

The Security Center's ~45 probes answer *what is broken now*. Detection (`server/utils/systemDetection.js`) adds *what is likely to go wrong next* by reading those probe results and returning a severity, predicted risks and recommended actions — rendered in the admin **AI Management and Control** tab.

Two properties matter more than the prediction:

- **It cannot break detection.** Every failure path (no key, rejected key, timeout, non-JSON reply, reply that fails validation) falls back to a **rule-based verdict** computed from the same probes. A security panel that goes dark when a third-party API is down would be worse than one that never predicted anything.
- **Model output is never trusted.** Severity is clamped to `nominal | watch | elevated | severe`, categories to a fixed vocabulary, every string is length-bounded and stripped, and a malformed reply is discarded whole rather than half-applied.

**Privacy:** probe details are redacted before they leave the process — emails, IPs, JWTs, API keys and long hashes are replaced. The model receives probe status and a length-capped detail, never user data and never a credential. Verdicts are cached for 5 minutes and recomputed only when a probe's status actually changes.

### Recommendations (`/api/recommend`)
1. **DeepSeek V4 Flash (via OpenRouter)** — full JSON wellness plan with 20 personalized supplements
2. **`sanitizeStrings()`** — recursively cleans AI output (em dashes, smart quotes, special chars) before it reaches the client
3. **Rule-based clinical fallback** — covers all age groups, medications, conditions, symptoms, diet, lifestyle and pregnancy

### AI Prompt Quality Rules
- Rule 4: consider **only** provided information — never invent symptoms or severity
- Rule 9: severity labels only for symptoms actually reported
- Rule 13: `triggeredBy` uses only reported data — falls back to "General wellness"
- `conditionContext` returns `null` when there is nothing to reference
- Meal rules strictly respect diet type, allergies and medical conditions

### Supplement Detail (`/api/supplement-detail`)
- Assessment-aware deep dive tailored to your profile
- Cached in `localStorage` by `assessmentId + supplementName` with a 30-day expiry

### Chat Assistant (`/api/chat`)
- Scoped to health + SuppliWise topics, with server-side safety guardrails
- Typo correction for health/supplement terms built into the system prompt
- **Ultimate** entitlement, enforced server-side

---

## 📱 Mobile Support (PWA + Android APK)

### Progressive Web App (PWA)
- **Install on any device** — iOS, Android, desktop
- **Offline support** — service worker caches assets
- **App-like experience** — runs in standalone mode
- **Automatic updates** — `registerType: 'autoUpdate'`
- **Custom install prompt** with branded UI

### Android APK
- **Native Android app** — built with Capacitor 8
- **SuppliWise branding** — custom app icon with pill logo
- **In-app PDF download** — the WebView now handles `onDownloadStart`, writes generated PDFs through `MediaStore` (scoped storage) or the legacy path, and sanitizes every `Content-Disposition` / URL through a dedicated helper before it can name a file
- **File location:** `my-react-app/android/app/build/outputs/apk/debug/SuppliWise.apk`
- **Installation:**
  1. Transfer `SuppliWise.apk` to your Android phone
  2. Enable "Install from Unknown Sources" in Android settings
  3. Tap the APK file to install
  4. Open SuppliWise from your app drawer

### Building the Android APK

**Prerequisites:** JDK 17, plus the Android SDK and Gradle (installed by Capacitor)

```bash
# 1. Build the web app
cd my-react-app
npm run build

# 2. Sync with Capacitor
npx cap sync android

# 3. Fix Java version (required after sync)
# Edit: android/app/capacitor.build.gradle
# Change: compileOptions { sourceCompatibility JavaVersion.VERSION_21 }
# To:     compileOptions { sourceCompatibility JavaVersion.VERSION_17 }

# 4. Build APK
cd android
.\gradlew.bat assembleDebug

# 5. APK location
# android/app/build/outputs/apk/debug/SuppliWise.apk
```

> **Note:** After every `npx cap sync`, fix the Java version in `capacitor.build.gradle` from `VERSION_21` to `VERSION_17`.

### Mobile-Responsive Design
- Single-column layouts, collapsible sections, touch-optimized dropdowns and modals
- Sticky navigation, optimized font sizes and spacing
- Reduced-motion and increased-contrast preferences respected by the new plan-gate card

### Performance notes
- Route-level code splitting keeps the initial bundle small; every page loads on demand
- `jspdf`, `jspdf-autotable` and the ~30 KB WebAuthn browser SDK are lazily imported
- Separate Vite cache dirs for `dev` and `build` so a running dev server is never invalidated
- `optimizeDeps.include` completeness is **enforced by a test**, because a dependency first reached through a dynamic import triggers a re-optimize that invalidates every module URL the open page is already holding

---

## 🗄️ Database

MongoDB with Mongoose. No migrations needed — `aiResults` is a `Mixed` (schemaless) field.

**Collections:**

| Model | Purpose |
|---|---|
| `users` | Identity, argon2id password, profile & banner pictures, `twoFactorMethod` + encrypted seed, recovery email, login metadata, `currentSessionId` + `sessionVersion` |
| `assessments` | All assessment fields + full `aiResults` JSON snapshot (including `wellnessBaseline`), priority flag, 5-year `expiresAt` |
| `intakerecords` | Supplement tracking records with `dayKey`, taken status and timestamps |
| `dashboardmetrics` | Wellness score, streak data and adherence metrics per assessment |
| `sessions` | One-per-account sessions with device attribution, `trustedAt`, and optional absolute `expiresAt` |
| `passkeys`, `authchallenges`, `mfatransactions` | WebAuthn credentials/challenges and the short-lived MFA transaction budget |
| `backupcodes` | SHA-256 hashes of single-use recovery codes, batched |
| `passwordresettokens` | SHA-256 reset grants with a Mongo TTL index |
| `securityevents` | Append-only per-user security history (closed enum) |
| `usernotifications`, `adminevents` | The two notification streams |
| `subscriptionrequests`, `subscriptioncancelrequests` | The two admin review queues |
| `chatthreads`, `chatmessages` | Stored support conversations |
| `adminaccounts` | Admin identity projection |
| `Web3.js` | All Web3 schemas + `DEFAULT_PARAMS` (DAO-governed economics), wallets, blocks, listings, orders, rewards, proposals, knowledge, trials, feeds |

**Key behaviours:**
- Pre-save hooks stamp `passwordChangedAt` in the same write as the new hash
- Deleting a user cascades to assessments, intake records and dashboard metrics
- Recoverable state (e.g. `resolveFeatureKey`) uses prototype-less lookups and fails closed

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| 🖥️ Frontend | React 18 + Vite 8 |
| 📱 Mobile | PWA (vite-plugin-pwa) + Capacitor 8 (Android APK) |
| 🔀 Routing | React Router v7, route-level code splitting |
| ⚙️ Backend | Node.js 18+ + Express 4 |
| 🗄️ Database | MongoDB + Mongoose 8 |
| 🔑 Auth | JWT (HS256, pinned) + argon2id / bcrypt + sessions |
| 🛡️ WebAuthn | `@simplewebauthn/server` + `@simplewebauthn/browser` |
| 📱 2FA | speakeasy (TOTP) + AES-256-GCM seed encryption |
| 🔒 Secrets | `hash-wasm` (argon2id), AES-256-GCM secret box, ed25519 via Web Crypto |
| 📧 Email | Nodemailer (Gmail App Password) |
| 🤖 AI | OpenRouter — DeepSeek V4 Flash (default, health features) · Groq — system detection · Anthropic — priority flagging |
| ⛓️ Blockchain | Self-hosted append-only PoW chain, ed25519, AES-GCM, content addressing |
| 📄 PDF Export | jsPDF + jspdf-autotable (lazy-loaded) |
| 🛡️ Security | Helmet + CSP, express-rate-limit, `compression`, CORS allowlist |
| 🧪 Testing | `node --test` (server + frontend), vitest-free and dependency-light |

---

## 📋 Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher (uses native `fetch` — no `node-fetch` needed)
- [MongoDB Community Server](https://www.mongodb.com/try/download/community) running locally
- An [OpenRouter](https://openrouter.ai) account for AI features
- **For Android APK builds:** [JDK 17](https://adoptium.net/temurin/releases/)

---

## ⚡ Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/REIIdes/SuppliWise.git
cd SuppliWise
```

### 2. Set up the backend

```bash
cd server
npm install
```

Create a `.env` file by copying the example:

```bash
copy .env.example .env
# macOS / Linux:  cp .env.example .env
```

`server/.env.example` is heavily commented — it explains what each variable is for and, for the security-critical ones, what breaks without it. The minimum you need to boot locally:

```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/suppliwise
JWT_SECRET=your_own_secret_key_here

# AI — see "AI Architecture" for the full routing table.
# The `_here` suffix is REQUIRED: a placeholder written any other way is treated
# as a real credential and the admin panel shows it as live.
OPENROUTER_API_KEY=your_openrouter_api_key_here   # default AI: assessment, chat, polish, detail
GROQ_API_KEY=your_groq_api_key_here               # system detection & threat prediction
ANTHROPIC_API_KEY=your_anthropic_api_key_here     # priority assessment flagging
# Optional model overrides. Unset uses the provider's pinned default.
# GROQ_MODEL / ANTHROPIC_MODEL must be ids YOUR key can reach, AND the account
# must have credit — see the warnings in AI Architecture.
OPENROUTER_MODEL=
GROQ_MODEL=
ANTHROPIC_MODEL=

# Email Configuration (for OTP codes)
EMAIL_SERVICE=gmail
EMAIL_USER=your_email@gmail.com
EMAIL_PASSWORD=your_gmail_app_password_here
EMAIL_FROM_NAME=SuppliWise
EMAIL_FROM_ADDRESS=your_email@gmail.com
```

### Security-critical variables

In development these have sensible fallbacks. **In production the server refuses to start without them**, because each failure mode is invisible until a real user is affected.

| Variable | Why it matters |
|---|---|
| `TOTP_ENCRYPTION_KEY` | A TOTP seed cannot be hashed (the server must run HMAC over it), so it must be encrypted at rest. Without it, anyone who can read the database can mint valid codes forever. Generate: `openssl rand -base64 32`. `TOTP_ENCRYPTION_KEY_PREVIOUS` supports `kid=base64` rotation |
| `WEBAUTHN_RP_ID` | **A bare domain** — no scheme, no port, no path. Must be the domain that serves the web app |
| `WEBAUTHN_ORIGIN` | Comma-separated `https` origins allowed to run a ceremony. Also trusted by CORS. Dev falls back to loopback origins |
| `WEB_ALLOWED_ORIGINS` | Origins allowed to make **credentialed** requests. Never use a wildcard — `*` is incompatible with credentials |
| `PUBLIC_WEB_URL` | The address used in emailed links. Required in production |
| `ALLOW_LAN_ORIGINS` | Development only — trust `http://192.168.x.x:port` so a phone on the same Wi-Fi can reach a dev backend |

### Session lifetime

**User sessions do not expire**, and there is no variable for that — there is no default to set. **Admin sessions do**:

| Variable | Default | Notes |
|---|---|---|
| `ADMIN_IDLE_MINUTES` | 10 | Must be a whole number 1–1440. The client countdown and the server check are driven by this, so they cannot disagree |
| `ADMIN_TOKEN_LIFETIME_MINUTES` | 15 | **Must be greater than `ADMIN_IDLE_MINUTES`** or a working admin is logged out mid-task. The server refuses to boot if the two are mis-ordered |

### Rate limit ceilings

Per-IP ceilings live in config because a security ceiling is also a capacity number: a deployment behind a shared NAT has every user behind one public address, so a value tuned for a home connection locks out a whole school. Unset, empty or nonsense values fall back to the documented default — **a typo must never be able to switch rate limiting off**.

`AUTH_RATE_LIMIT_MAX` · `AUTH_RATE_LIMIT_MAX_LOCAL` · `AUTH_SENSITIVE_RATE_LIMIT_MAX` · `SECURITY_RATE_LIMIT_MAX`

### Administrator accounts

```env
ADMIN_ALIAS=your_admin_name
ADMIN_ACCOUNTS=AdminAlias|$argon2id$v=19$m=19456,t=2,p=1$your_salt$your_hash|your_totp_secret
ADMIN_EMAILS=AdminAlias=admin@example.com
```

- `ADMIN_ALIAS` / `ADMIN_PASSWORD_HASH` / `ADMIN_TOTP_SECRET` — the single-admin (legacy) form
- `ADMIN_ACCOUNTS` — the multi-admin form: `alias|hash|secret` triples
- `ADMIN_EMAILS` — `alias=address` pairs, joined by commas. A delivery address, **not** a login credential. An unparseable entry is skipped rather than half-inserted

### Getting your OpenRouter API key
1. Go to [openrouter.ai](https://openrouter.ai) and sign up
2. Click **API Keys** → **Create Key**
3. Paste it as `OPENROUTER_API_KEY`

> ⚙️ **OpenRouter Privacy Settings:** at [openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy), ensure **"Non-frontier" Zero Data Retention** is **OFF** so DeepSeek endpoints are reachable.

**Setting up Gmail for OTP emails:**
1. Create or use a Gmail account for sending
2. Enable 2-Factor Authentication at [Google Account Security](https://myaccount.google.com/security)
3. Generate an App Password at [App Passwords](https://myaccount.google.com/apppasswords)
   - App: **Mail** · Device: **Other** (type "SuppliWise")
   - Copy the 16-character password (remove spaces)
4. Paste it as `EMAIL_PASSWORD`

> 💡 The app falls back to a rule-based engine if OpenRouter is unavailable — it always produces results.
> 📧 OTP codes are logged to console only if `ALLOW_DEV_OTP_RESPONSE` is set, and never in production.

### 3. Set up the frontend

```bash
cd ../my-react-app
npm install
```

---

## ▶️ Running the App

You need **two terminals running at the same time.**

**Terminal 1 — Backend:**
```bash
cd server
npm run dev
```
```
Connected to MongoDB
Server running on port 5000
```

**Terminal 2 — Frontend:**
```bash
cd my-react-app
npm run dev
```

Open **http://localhost:5173** 🎉

### Testing on Mobile Devices

**Same WiFi Network:**
1. Get your computer's local IP address:
   ```bash
   ipconfig     # Windows — look for "IPv4 Address" (e.g. 192.168.0.102)
   ```
2. On your phone, go to `http://YOUR_IP:5173`
3. Some browsers force HTTPS — you may need `https://` instead
4. If passkeys or secure cookies misbehave on a LAN origin, set `ALLOW_LAN_ORIGINS=true` **in development only**

**Installing PWA on Mobile:**
1. Open the app in Chrome/Safari
2. Menu → "Add to Home Screen" or "Install App"

**Installing Android APK:** build it (see [Mobile Support](#-mobile-support-pwa--android-apk)), transfer the file, install.

---

## 🧪 Testing

```bash
# Server — 658 tests (619 run, 39 environment-gated skips)
cd server
npm test

# Server — live subscription flow checks against a real server
npm run test:flows

# Server — end-to-end HTTP smoke across all 20 Web3 features
node test-web3-flows.js

# Server — syntax check across the security-critical surface
npm run check

# Frontend — 244 tests
cd my-react-app
npm test

# Frontend — lint
npm run lint
npm run build
```

The test suite deliberately includes **contract tests that fail when two copies of the truth drift** — the frontend feature registry against the server entitlements, the client password rules against the shipped server policy, and `optimizeDeps.include` against the dynamic imports that need it.

---

## 🗺️ API Surface

All API routes are mounted under `/api`.

| Group | Path | Guard |
|---|---|---|
| Auth | `/api/auth` | rate-limited, `lockoutCheck` |
| Password reset | `/api/auth/password-reset` | enumeration-safe |
| Passkeys | `/api/auth/passkeys` | WebAuthn, `verifyOrigin` |
| TOTP | `/api/auth/totp` | step-up for mutations |
| Recovery codes | `/api/auth/recovery-codes` | step-up for management |
| Sessions | `/api/auth/sessions` | `verifyOrigin` |
| Assessment | `/api/assessment` | user |
| Subscription | `/api/subscription` | session (purchase), public (plans) |
| AI | `/api/recommend`, `/api/chat`, `/api/supplement-detail`, `/api/polish` | user / `requireFeature('chat')` |
| Support | `/api/support-chat` | user |
| Dashboard / Insights | `/api/dashboard`, `/api/insights` | user |
| Notifications | `/api/notifications` | user |
| Security | `/api/security` | user, admin-excluded |
| Web3 | `/api/web3` | user, admin-excluded — only `/verify/:code`, `/verify/:code/qr`, `/share/:token` are public |
| Admin | `/api/admin`, `/api/admin/chats` | `adminOnly` |

---

## 📖 Documentation

| Document | Audience |
|----------|----------|
| [User Guide — Multiple Accounts & Saved Logins](docs/USER_GUIDE.md) | End users: signing in to several accounts at once, switching, the "Save my login" checkbox, sign-out rules, FAQ |
| [User Manual — Web3 Features](docs/USER_MANUAL.md) | End users: wallet & DID, WELL rewards, staking, marketplace, DAO, data sovereignty, verification |
| [Developer Guide — Session Architecture](docs/DEVELOPER_GUIDE.md) | Developers: server-side session store, browser session layer, route guards, error codes, tests |
| [Developer Manual — Web3 Layer](docs/DEVELOPER_MANUAL.md) | Developers: chain engine, anchor contract, models, params, operating the Web3 layer |
| [Blockchain Feature Map](BLOCKCHAIN_FEATURES.md) | Developers: every one of the 20 features mapped to its implementing file and the check that proves it |
| [Auth Security Report](docs/AUTH_SECURITY_REPORT.md) | Security: passkeys, TOTP encryption, step-up, sessions, recovery, event log |
| [Security Audit Report](SECURITY_AUDIT_REPORT.md) | Security: 30 findings, remediations, open items, manual actions |
| [Additions Summary](ADDITIONS_SUMMARY.md) | Developers: what changed in the security + recovery session, with architecture notes |
| [Priority Assessment Override](PRIORITY_ASSESSMENT_OVERRIDE.md) | Developers: how an admin raises/releases a Priority review and when it is refused |
| [Forgot Password Redesign](FORGOT_PASSWORD_REDESIGN.md) | Developers: why the reset flow is a link flow, not a modal |
| [Admin Setup](ADMIN_SETUP.md) | Operators: provisioning admin accounts and credentials |
| [System Architecture](SYSTEM_ARCHITECTURE.md) | Developers: cross-cutting architecture overview |
| [Patch Notes](docs/SuppliWise_Patch_Notes.pdf) | Everyone: the current release notes (PDF + DOCX) |

---

## 📁 Project Structure

```
SuppliWise/
├── server/
│   ├── blockchain/
│   │   ├── crypto.js                  # stableStringify, sha256, ed25519, AES-GCM, CID
│   │   ├── engine.js                  # The ONLY place Web3 state mutates (DB first, then anchor)
│   │   ├── ledger.js                  # Append-only PoW chain
│   │   ├── rules.js                   # PURE decision logic: tallies, APY, escrow, disputes
│   │   └── seed.js                    # Boot-time demo + oracle seeding
│   ├── models/                        # User, Session, Assessment, IntakeRecord, DashboardMetrics,
│   │                                  # Passkey, AuthChallenge, MfaTransaction, BackupCode,
│   │                                  # PasswordResetToken, SecurityEvent, UserNotification,
│   │                                  # AdminAccount, AdminEvent, SubscriptionRequest,
│   │                                  # SubscriptionCancelRequest, ChatThread, ChatMessage, Web3
│   ├── routes/
│   │   ├── auth.js                    # Register, login, profile, MFA transaction
│   │   ├── passwordReset.js           # Link-flow reset service
│   │   ├── passkeys.js                # WebAuthn ceremonies
│   │   ├── totp.js                    # Authenticator setup/verify/disable
│   │   ├── recoveryCodes.js           # Recovery code lifecycle
│   │   ├── securityRedeem.js          # PUBLIC backup-code redeem as second factor
│   │   ├── security.js                # 30+ account-security endpoints
│   │   ├── sessions.js                # Device listing + revocation
│   │   ├── assessment.js              # Save, retrieve, update, delete, priority override
│   │   ├── recommend.js               # AI recommendations (OpenRouter DeepSeek + clinical fallback)
│   │   ├── supplement_detail.js       # Assessment-aware supplement deep-dive
│   │   ├── chat.js                    # AI chat assistant with safety guardrails
│   │   ├── supportChat.js             # Stored support conversations
│   │   ├── subscription.js            # Plans, purchases, requests, SSE stream
│   │   ├── dashboard.js / insights.js # Tracking + analytics
│   │   ├── notifications.js           # In-app inbox
│   │   ├── admin.js                   # Control panel
│   │   ├── adminSupportChats.js       # Admin inbox
│   │   ├── polish.js                  # AI text quality validation
│   │   └── web3/                      # chain, data, ecosystem, govern, guards, market, rewards, supply
│   ├── middleware/
│   │   ├── auth.js                    # Session validation, JWT pinning, feature guards
│   │   └── stepUp.js                  # The shared step-up gate
│   ├── utils/                         # password, passwordRules, sessions, userSession, adminSession,
│   │                                  # lockout, floodGuard, rateLimits, webauthn, totpSecret,
│   │                                  # secretBox, authFlow, mfaTransaction, entitlements,
│   │                                  # planCatalogue, subscriptionState, paymentInstructions,
│   │                                  # aiProviders, email, pictures, device, geo, currency, ...
│   ├── scripts/                       # notify-admins, send-admin-credentials, picture migration
│   ├── Test File/                     # 45 server test files
│   └── index.js                       # App, helmet, CORS, limiters, body metering, route mounting
│
└── my-react-app/
    ├── android/                       # Capacitor Android project
    │   └── app/src/main/java/com/suppliwise/app/
    │       ├── MainActivity.java      # WebView download handling + MediaStore PDF writes
    │       └── SafeDownloadName.java  # Bounded filename derivation from untrusted headers
    ├── public/                        # favicon.svg, PWA icons, apple-touch-icon, manifest
    ├── src/
    │   ├── Pages/                     # Home, LogIn, SignIn, ForgotPassword, ResetPassword,
    │   │                              # Dashboard, Assessment, Results, History, Profile,
    │   │                              # Recommendations, TrackIntake, Insights, ChatAssistant,
    │   │                              # SupportChatPage, PricingPage, Web3Hub, Marketplace,
    │   │                              # Governance, Verify, Share, AdminLogin,
    │   │                              # AdminChangePassword, AdminDashboard, AssessmentManagement
    │   ├── Components/
    │   │   ├── Web3Panels/            # 8 panels + shared w3ui helpers
    │   │   ├── ProfileSecurityControls/  # 2FA, password, recovery, sessions, passkeys, step-up
    │   │   ├── AdminSubscriptionPanel/ · AdminSubscriptionRequests/ · AdminSubscriptionCancels/
    │   │   ├── AdminSupportChats/ · SupportInbox/ · SecurityStatus/
    │   │   ├── PlanLockedCard/ · Web3PlanGate/ · UpgradeModal/ · PWAInstallPrompt/
    │   │   ├── Navbar/ · AccountSwitcher/ · UserNotifications/ · ConfirmModal/ · Toast/
    │   │   └── ModifyAssessmentModal/ · ReadOnlyAssessment/ · ProfileActionsMenu/
    │   ├── subscription/               # features.js, catalogue.js, paymentCopy, sheetActions
    │   ├── auth/                       # authState.js — cross-tab session + plan relay
    │   ├── hooks/                      # useAuth, useSubscription, useScrolledPast
    │   ├── utils/                      # api helpers, PDF generators, dates, plan, passwordPolicy,
    │   │                              # chunkReload, overlayRegistry, pictureUrl, nameValidation
    │   ├── api.js                      # All API calls + WebAuthn browser SDK (lazy)
    │   ├── api/web3.js                 # Web3 client
    │   ├── App.jsx                     # Routes, guards, ErrorBoundary, subscription sync
    │   ├── main.jsx · theme.css · index.css · mobile-responsive.css
    └── vite.config.js                  # Vite + PWA + optimizeDeps contract
```

---

## ⚠️ Important Notes

- The `.env` file is gitignored — never commit your API keys
- All recommendations use possibility language ("may support", "evidence suggests") — this is **not medical advice**
- Always consult a licensed healthcare professional before starting any supplement regimen
- The blockchain layer is a **simulated in-app chain**, not a real cryptocurrency. No external chain, no gas, no funded wallets
- OpenRouter pricing: DeepSeek V4 Flash costs ~$0.09 / $0.18 per million tokens (input/output)
- Node.js 18+ is required — the server uses the built-in `fetch` API
- Production **refuses to boot** without `TOTP_ENCRYPTION_KEY`, `WEBAUTHN_RP_ID` and an https `WEBAUTHN_ORIGIN`
- `ALLOW_LAN_ORIGINS` and `ALLOW_DEV_OTP_RESPONSE` are development-only switches — never enable them in production
