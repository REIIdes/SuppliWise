# SuppliWise — Complete User Guide

> **Version:** 2026-09 (matches JDMv4 branch)  
> **Audience:** End users, administrators, and developers  
> **Scope:** Every user-facing feature, with step-by-step instructions and screenshots placeholders.

---

## 1. Getting Started

### 1.1 Supported Platforms
| Platform | Access Method | Notes |
|----------|---------------|-------|
| Desktop Web | Chrome / Firefox / Edge / Safari (latest 2 versions) | Full feature set |
| Mobile Web | iOS Safari / Chrome for Android | Responsive layout, PWA installable |
| Android App | Sideload APK (`my-react-app/android/app/build/outputs/apk/debug/app-debug.apk`) | Uses Capacitor WebView, push notifications via FCM |

### 1.2 First Visit
1. Open `https://your-domain.com` (or `http://localhost:5173` in dev).
2. You land on the **Home page** — choose **Start Assessment** or **Sign In**.
3. No account yet? Tap **Create Account** (see §2.1).

### 1.3 Session Model
- **Per-tab sessions**: Tab A can be Account X while Tab B is Account Y.
- **Account directory** (localStorage): remembers every email/name you’ve signed in with on this browser so you can switch instantly (Navbar → avatar → Switch account).
- **Remember me** (optional): creates a long-lived credential that survives browser restarts. Revoked automatically on sign-out, password change, or admin action.

---

## 2. Authentication & Account

### 2.1 Create Account
1. Tap **Create Account** on Home or Login page.
2. Fill:
   - First / Last name (2–50 chars, letters + spaces)
   - Email (unique, becomes your login ID)
   - Date of birth (age 1–120)
   - Gender (Male / Female)
   - Password (min 8 chars, 1 uppercase, 1 number)
3. Solve the math CAPTCHA → **Create Account**.
4. You are signed in and redirected to **Dashboard**.

### 2.2 Sign In
1. Enter email + password.
2. If **Remember me** is checked, a persistent token is stored.
3. A 6-digit email OTP is sent — enter it to complete sign-in.
4. On success you land on **Dashboard** (or `/results` if an assessment just finished).

### 2.3 Forgot Password
1. Login page → **Forgot Password?**
2. Enter your email → **Send OTP**.
3. Check email for 6-digit code (expires in 10 min).
3. Enter code → set new password (same rules as registration).

### 2.4 Profile & Settings  (`/profile`)
| Section | Editable Fields | Notes |
|---------|-----------------|-------|
| **Basic Info** | First/Last name, DOB, Gender | Name change updates display everywhere. |
| **Contact** | Email (triggers OTP verification) | Must confirm new email before it becomes active. |
| **Security** | Password (needs current), 2FA (TOTP) | 2FA uses Google Authenticator / Authy compatible apps. |
| **Pictures** | Profile picture (≤2 MB), Banner (≤3 MB) | Stored as base64 in MongoDB; served via JSON, not static files. |
| **Accounts** | Switch / Add / Sign out other accounts | Per-tab; other tabs unaffected. |
| **Danger Zone** | Delete account (irreversible) | Removes *all* your data: assessments, intake logs, Web3 wallets, etc. |

### 2.5 Sign Out
- Profile page → **Log Out** (bottom left on desktop, below Edit Profile on mobile).
- Current tab clears; other tabs using the same account stay signed in unless you also chose “Sign out everywhere” in the account switcher.

### 2.6 Admin Login (`/admin/login`)
- Separate credential store (env-configured aliases + bcrypt + TOTP).
- Admin sessions are **short-lived (3.5 min idle)** and **never share state** with user sessions.
- Admins bypass all feature gates but are confined to `/admin/*` routes.

---

## 3. Health Assessment (Core Feature)

### 3.1 Start an Assessment
1. From **Dashboard** or **Home** → **Start Assessment**.
2. Four steps — progress saved automatically to `sessionStorage`:
   1. **Basic**: age, gender, weight, height, activity level.
   2. **Diet & Goals**: diet type, health goals (multi-select: energy, sleep, immunity, etc.).
   3. **Symptoms**: pick from list + severity (mild/moderate/severe), sleep quality, water intake.
   4. **Medical**: conditions, medications, allergies, lifestyle (smoking/alcohol/caffeine), optional blood-test notes.
3. **Submit** → AI analysis runs (OpenRouter DeepSeek V4 Flash) → redirected to **Results** page.

### 3.2 Assessment Results (`/results`)
| Panel | Content |
|-------|---------|
| **Priority Supplements** | High / Medium / Low cards with dosage, timing, confidence %, reason, interactions. |
| **Optional Supplements** | Lower-confidence suggestions. |
| **Daily Schedule** | Morning / Afternoon / Evening / Night grouping. |
| **Lifestyle Advice** | Nutrition, sleep, exercise, hydration tips. |
| **Warnings / Avoid List** | Red-flag interactions or contraindications. |
| **Actions** | **Export PDF**, **+ Add to Plan**, **New Assessment**. |

### 3.3 Assessment History (`/history`)
- Paginated list (newest first), page size capped by tier:
  - **FREE**: 5 per page, page 1 only
  - **DELUXE**: 10 per page, page 1 only
  - **PREMIUM / ULTIMATE**: 20 per page, full pagination (5-year window)
- Each row: date, priority flag, eye icon (view read-only), download icon (PDF), symptom/goal chips.
- **No delete** for regular users (admins can delete via Admin Dashboard).

### 3.4 Priority Flagging (PREMIUM+)
- Severe-case detector runs after every AI result.
- Flagged assessments show a **Priority** badge and block new assessments until reviewed.
- Admins can resolve / change priority in Admin Dashboard → Assessments.

---

## 4. Daily Supplement Tracking

### 4.1 My Plan (`/dashboard` → Recommendations tab)
- Shows every supplement from your latest assessment.
- **+ Add to Plan** / **Remove from Plan** toggles.
- Plan persists across assessments; new assessment merges recommendations.

### 4.2 Track Intake (`/track-intake`)
| View | Function |
|------|----------|
| **Today** | List of plan supplements with priority dots. Tap a time-slot button (Morning/Afternoon/Evening/Night) → **Taken** / **Undo**. Completion counter + toast when 100 %. |
| **Calendar** | Month grid: 🟢 100 %, 🟡 partial, 🔴 missed, 🔵 today. Tap a day → detail drawer. |
| **Adherence** | Weekly bar chart (7 days) + streak counter. |
| **Weekly Adherence** | `/dashboard` widget shows current week %. |

### 4.3 Data Model
- Each **IntakeRecord** = (user, assessment, supplement, date, timeSlot, taken).
- **DashboardMetrics** aggregates daily completion % and streak.
- Deleting an assessment cascades to its IntakeRecords & metrics.

---

## 5. Insights & Analytics (`/insights`)

| Tab | What You See |
|-----|--------------|
| **Overview** | Streak, adherence %, wellness score, assessments count, current phase, lifestyle tips. |
| **Today’s Progress** | Circular completion chart + supplement list with taken/pending status. |
| **Adherence** | 7-day bar chart + action plan phases (Week 1–4). |
| **AI Insight** | Personalized phase guidance + tips (requires DELUXE+). |

**Tier gates**: Insights tab requires **DELUXE+**; AI Insight tab requires **PREMIUM+**.

---

## 6. Web3 / Blockchain Features (ULTIMATE Only)

> All Web3 features require an **active ULTIMATE (custom) subscription** and are under `/web3`. The navbar shows **⛓ Web3** only when entitled.

| Feature | Route | Description |
|---------|-------|-------------|
| **Wallet / DID** | `/web3` → Wallet | ed25519 identity, encrypted private key, one-time welcome airdrop. |
| **Supply Chain** | `/web3` → Supply | Batch QR tracking: raw → mfg → QC → retail. Public verify at `/verify/:code`. |
| **Certifications** | Supply → Certifications | Lab / organic / GMP certs anchored on-chain. |
| **Marketplace** | `/web3` → Market | P2P listings, escrow orders, dispute resolution (juror majority). |
| **DAO Governance** | `/web3` → DAO | Proposals, voting, treasury, parameter changes (quorum + FOR > AGAINST). |
| **Knowledge Posts** | DAO → Knowledge | Community posts, AI-anchored proof-of-contribution. |
| **Rewards (WELL)** | `/web3` → Rewards | Check-in, intake, assessment rewards; streak & stake bonuses. |
| **NFT Gallery** | Rewards → NFTs | Achievement NFTs with unique tokenIds, mint tx on-chain. |
| **Staking** | Rewards → Staking | Stake WELL → daily APY (DAO-governed), ≥500 unlocks perks. |
| **Loyalty** | Rewards → Loyalty | Convert WELL → loyalty codes (DAO rate, min 10 WELL). |
| **Health Ledger** | `/web3` → Health | Anchor assessment+intake digest; export verifiable credential. |
| **Data Consent** | `/web3` → Data | Grant/revoke anonymized research shares; +WELL per grant. |
| **Encrypted Storage** | `/web3` → Storage | AES-256-GCM content-addressed blobs (CID), user-owned. |
| **AI Proof** | `/web3` → AI Proof | Anchor recommendation hashes on-chain for audit trail. |
| **Clinical Trials** | `/web3` → Trials | Enroll, consent, data sharing with researchers. |
| **Oracle Feeds** | `/web3` → Oracle | Price / market data feeds for DAO params. |
| **Experts** | `/web3` → Experts | Verified practitioner directory, booking flow. |
| **Share Links** | `/web3` → Share | Time-limited, revocable profile/assessment sharing. |

### 6.1 Wallet Setup (First Visit to `/web3`)
1. Click **Create Wallet** → system generates ed25519 keypair.
2. Private key encrypted with AES-256-GCM (key derived from your JWT secret).
3. Backup: **Export Private Key** (one-time, requires password re-entry) or **Download Credential**.
4. DID = `did:suppliwise:<walletAddress>` — used for all on-chain actions.

### 6.2 Supply Chain Quick Start
1. **Supply** → **Create Batch** → fill product, source, mfg date, certifications.
2. Each step (QC, packaging, shipping, retail) → **Add Event** → geotag + notes + optional photo hash.
3. Batch gets a **QR code** (`/verify/:code`) — anyone can scan, no login needed.
4. Certifications anchored separately; re-anchor if lab report updated.

### 6.3 Marketplace & Escrow
1. **Create Listing** (seller) → title, description, price (WELL), inventory, shipping.
2. Buyer → **Place Order** → funds held in escrow smart-contract.
3. Seller ships → **Confirm Delivery** (or buyer confirms receipt) → funds released.
4. Dispute → jurors (staked WELL holders) vote → majority decides → refund or release.

### 6.4 DAO Participation
- **Propose**: any wallet ≥100 WELL can submit a parameter change or treasury spend.
- **Vote**: 1 wallet = 1 vote (weighted by stake if configured). Quorum + FOR > AGAINST passes.
- **Execute**: passed proposals auto-execute via timelock.

### 6.5 Rewards & Staking
| Action | Base Reward | Streak Bonus | Stake Bonus |
|--------|-------------|--------------|-------------|
| Daily check-in | 1 WELL | ×1.5 at 7-day, ×2 at 30-day | +stakeAPY% |
| Supplement intake | 0.5 WELL | — | — |
| Assessment complete | 10 WELL | — | — |
| Data share grant | 5 WELL | — | — |
- **Stake ≥500 WELL** → premium perks (lower marketplace fee, priority support, etc.).

---

## 7. Subscription Tiers & Entitlements

| Feature | FREE | DELUXE (monthly) | PREMIUM (annual) | ULTIMATE (custom) |
|---------|------|------------------|------------------|-------------------|
| Health Assessment | ✅ | ✅ | ✅ | ✅ |
| Recommendations | ✅ | ✅ | ✅ | ✅ |
| Daily Intake Tracking | ✅ | ✅ | ✅ | ✅ |
| PDF Export (Results & History) | ❌ | ✅ | ✅ | ✅ |
| Insights (Overview, Today, Adherence) | ❌ | ✅ | ✅ | ✅ |
| AI Insight Tab | ❌ | ❌ | ✅ | ✅ |
| Priority Assessment Flagging | ❌ | ❌ | ✅ | ✅ |
| 5-Year History (full pagination) | ❌ | ❌ | ✅ | ✅ |
| History page size | 5 / page 1 | 10 / page 1 | 20 / all pages | 20 / all pages |
| **AI Chat Assistant** | ❌ | ❌ | ❌ | ✅ |
| **All Web3 Features** | ❌ | ❌ | ❌ | ✅ |

### 7.1 Upgrade / Downgrade
- **Admin only**: Admin Dashboard → Users → edit subscription (active + plan + optional expiry).
- **Instant SSE push**: your UI updates within seconds — no refresh needed.
- **Expiry**: set a past date to simulate cancellation; entitlements drop to FREE immediately.

### 7.2 Billing
- No built-in payment gateway. Admins manage tiers manually or via external Stripe/Paddle integration (not included).
- `subscriptionExpiresAt = null` → open-ended (lifetime while admin keeps it active).

---

## 8. AI Chat Assistant (ULTIMATE Only)

### 8.1 Open / Close
- **FAB** (bottom-right): “Ask AI” → opens panel.
- **Close**: ✕ in header, click outside, or press **Esc**.
- Panel remembers open/closed state across navigation.

### 8.2 Using the Chat
1. Type a question or tap a **Quick Prompt** chip.
2. Press **Enter** (Shift+Enter = new line on desktop; mobile keyboards use “Send” key).
3. Response appears with markdown (headings, lists, tables, bold, code).
4. **Scroll to bottom** button appears when you scroll up; auto-hides at bottom.

### 8.3 What You Can Ask
| Category | Examples |
|----------|----------|
| **Supplements** | “Why was magnesium recommended?”, “Can I take zinc with magnesium?” |
| **Nutrition / Wellness** | “What foods are high in vitamin D?”, “How much water should I drink?” |
| **App Help** | “How do I start an assessment?”, “Where is the PDF export button?” |
| **Symptoms / Lifestyle** | “I’m tired and stressed — any suggestions?” |

### 8.4 Guardrails
- **Off-topic** (sports, coding, politics, recipes, etc.) → polite decline.
- **Medical advice** → “Educational only — consult a healthcare provider.”
- **Max message length**: 1,000 characters.
- **History sent to model**: last 4 successful exchanges (errors excluded).
- **Your latest assessment recommendations** are automatically included as context (server-owned, not from browser storage).

### 8.5 Connection States (header dot)
| State | Color | Meaning |
|-------|-------|---------|
| Online | 🟢 Green | OpenRouter healthy. |
| Connecting | 🟡 Amber | Request in flight. |
| Reconnecting | 🟠 Orange | Provider fallback / retry. |
| Busy | 🟠 Orange | Rate-limited (429). |
| Unavailable | 🔴 Red | Network / provider down. |

---

## 9. Admin Dashboard (`/admin`)

### 9.1 Tabs
| Tab | Capabilities |
|-----|--------------|
| **Overview** | User counts, subscription breakdown, revenue proxy, recent activity. |
| **Users** | Search, filter by tier/status, **edit subscription** (active/plan/expiry), view assessments, impersonate (view-only), delete user. |
| **Admins** | List, add/edit/disable admin accounts, rotate TOTP. |
| **Security** | Live monitor (30 probes), download PDF report, view lockout ladder. |
| **AI** | OpenRouter quota, prompt injection scan, PII leak scan. |
| **Assessments** | All users’ assessments, priority flags, delete. |
| **Notifications** | Broadcast in-app notifications to users. |
| **Web3** | Chain height, wallet counts, supply batches, proposals, rewards, storage stats. |

### 9.2 User Subscription Edit
1. Users tab → **Edit** (pencil) → set **Active**, **Plan**, optional **Expires At**.
2. Save → instant SSE → user sees new entitlements immediately.
3. Past expiry date → status = `expired`, tier = FREE.

### 9.3 Security Monitor (Live Probes)
| Probe | Healthy When |
|-------|--------------|
| XSS Stored | Sanitizer strips `<script>` etc. |
| NoSQL Injection | Object payloads coerced to string. |
| **Path Traversal** | Android `SafeDownloadName` blocks `../`, encoded slashes; server has no static file serving. |
| Prototype Pollution | `scrubKeys` + mongoose ≥8.24.1. |
| Auth Brute Force | TOTP single-use, email OTP 5-try lockout, rate limits. |
| CSRF | Stateless JWT in header, no cookies. |
| Prompt Injection | `promptSafe` strips instruction-like patterns. |
| PII in AI Prompts | No email/name/photo sent to OpenRouter. |
| Rate Limit Lockout | 15 min → 1 h → 6 h → 1 day ladder. |

### 9.4 Download Security Report
- Security tab → **Download Report** → PDF with timestamp, all probe results, chain integrity, versions.

---

## 10. Mobile & PWA

### 10.1 Install as App
1. Chrome Android / Safari iOS → menu → **Install App** / **Add to Home Screen**.
2. Icon: `pwa-192x192.png` / `pwa-512x512.png` (maskable).
3. Runs full-screen, offline shell cached (Workbox `generateSW`).

### 10.2 Android APK (Sideload)
```bash
cd my-react-app
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
# Output: app/build/outputs/apk/debug/app-debug.apk
```
- Requires `ANDROID_HOME` + SDK 34.
- Permissions: `INTERNET`, `WRITE_EXTERNAL_STORAGE` (for PDF download via WebView bridge).

### 10.3 Mobile-Specific UI
- Chat panel: full-screen ≤768 px, safe-area insets, `100dvh`.
- Quick prompts: horizontal scroll.
- Navbar: collapsible, avatar menu at bottom.
- Calendar: compact 6-row grid.

---

## 11. Security & Privacy

| Control | Implementation |
|---------|----------------|
| **Passwords** | argon2id (19 MiB, 2 iterations) + legacy bcrypt upgrade on login. |
| **Sessions** | Server-side `Session` collection; JWT carries `sid`; revocation = delete session doc. |
| **2FA** | TOTP (RFC 6238), secret stored encrypted, backup codes not yet implemented. |
| **Rate Limits** | Per-family (auth, user, admin, AI, recommend) + global flood guard + in-flight byte budget. |
| **Lockout Ladder** | 15 min → 1 h → 6 h → 1 day (email + IP buckets). |
| **CORS** | Allowlist only (localhost, LAN, capacitor://, explicit `CORS_ORIGINS`). |
| **Helmet / CSP** | API: `default-src 'none'; frame-ancestors 'none'`. SPA serves its own `<meta CSP>`. |
| **Data at Rest** | MongoDB (no encryption-at-rest config shown — enable in Atlas / self-hosted). |
| **Web3 Keys** | AES-256-GCM envelopes; plaintext never persisted. |
| **PDF Generation** | Client-side (`jspdf` + `autotable`) — no server rendering. |

---

## 12. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| “Failed to fetch” everywhere | API down or CORS mismatch | Check `npm run dev` in `server/`; verify `CORS_ORIGINS` in `.env`. |
| Chat shows “Unavailable” | OpenRouter key missing or quota exhausted | Set `OPENROUTER_API_KEY` in `server/.env`. |
| Assessment stuck on “Saving…” | Network tab shows 413 / 500 | Check `MAX_AI_RESULTS_BYTES` (500 KB) in `server/routes/assessment.js`. |
| PDF export downloads empty file | `jspdf-autotable` version mismatch | Lock `jspdf@4.2.1` + `jspdf-autotable@5.0.8`. |
| Android build fails “SDK not found” | `ANDROID_HOME` unset | `export ANDROID_HOME=$HOME/Android/Sdk` (or set in `local.properties`). |
| Admin login redirects to `/login` | User session collides with admin session | Open `/admin/login` in incognito or clear `adminToken` in localStorage. |
| Chat history lost after tab switch | Normal — history is per-tab | Use **Account Switcher** to move a session to another tab. |

---

## 13. Developer Quick Reference

### 13.1 Repo Layout
```
SuppliWise/
├── server/                    # Express + Mongoose API
│   ├── routes/                # /api/* endpoints
│   ├── models/                # Mongoose schemas
│   ├── utils/                 # chatSafety, floodGuard, attack_probes, entitlements, sessions, lockout, sanitize
│   └── Test File/             # Node --test suites
├── my-react-app/              # Vite + React 18 SPA
│   ├── src/
│   │   ├── Pages/             # Route components
│   │   ├── Components/        # Shared UI (ChatAssistant, Navbar, etc.)
│   │   ├── hooks/             # useAuth, useSubscription
│   │   ├── api.js             # Typed fetch wrappers
│   │   └── auth/              # BroadcastChannel session sync
│   └── android/               # Capacitor project
└── docker-compose.yml / Dockerfile / render.yaml  # Deploy to Render (single service)
```

### 13.2 Common Commands
```bash
# Backend
cd server
npm run dev          # nodemon on :5000
npm test             # 81 server tests
npm run check        # syntax check all entry points

# Frontend
cd my-react-app
npm run dev          # Vite on :5173 (proxy → :5000)
npm run build        # production dist/ + PWA
npm run lint         # ESLint (4 pre-existing hook warnings)
npm test             # 9 entitlement sync tests

# Android
cd my-react-app
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
```

### 13.3 Environment Variables (server/.env)
```ini
PORT=5000
MONGO_URI=mongodb://localhost:27017/suppliwise
JWT_SECRET=…                      # 48+ random hex, never reuse
OPENROUTER_API_KEY=sk-…           # for AI chat / recommendations
OPENAI_API_KEY=sk-…               # fallback
ALLOW_DEV_OTP_RESPONSE=false      # must be false in prod
TRUST_PROXY=false                 # true behind nginx/Cloudflare
EMAIL_SERVICE=gmail
EMAIL_USER=…
EMAIL_PASSWORD=…                  # Gmail App Password
ADMIN_ACCOUNTS=Alias|hash|TOTP,…  # pipe-separated, hash from bcryptjs
CORS_ORIGINS=https://prod.com     # comma-separated extra origins
```

---

## 14. Changelog Highlights (Recent)

| Date | Change |
|------|--------|
| 2026-09 | Chat rewrite: strict validation, server-owned context, account-scoped quota, connection states, scroll preservation, IME-safe input, mobile safe-area. |
| 2026-09 | Path-traversal hardening: Android `SafeDownloadName`, behavioral traversal probes, `dotfiles: 'deny'`, `redirect: false` on static middleware. |
| 2026-09 | Guest chat no longer triggers `/auth/me` redirect; `useSubscription` token-aware. |
| 2026-09 | Admin security monitor now includes live traversal probe + Android filename test. |
| 2026-08 | Web3 layer: 20 features, DAO, marketplace, staking, loyalty, health ledger, data consent, AI proof, trials, oracle, experts, share links. |
| 2026-08 | Subscription system: SSE push, expiry watch, cross-tab BroadcastChannel, tier-gated history pagination. |

---

## 15. Support & Contribution

- **Issues**: GitHub Issues (include `npm run check` output, browser console, network tab).
- **Security**: Email `security@suppliwise.example` — do not file public issues for vulns.
- **PRs**: Follow conventional commits; `npm run check && npm test` must pass.

---

*End of guide. For API endpoint details, see `server/routes/*.js`; for UI components, see `my-react-app/src/Pages/` and `Components/`.*