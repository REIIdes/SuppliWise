# SuppliWise — Security Audit & Hardening Report

| | |
|---|---|
| **Audit ID** | `SEC-AUDIT-2026-09-23` |
| **Date conducted** | 2026-09-23 |
| **Auditor** | Automated code review (OpenCode agent), six-phase methodology |
| **Repository** | `github.com/REIIdes/SuppliWise` — branch `JDMv2` (remote is **public**) |
| **Scope** | `server/` (Express + Mongoose API) and `my-react-app/` (React + Vite client) |
| **Findings** | **30** — 2 Critical · 8 High · 9 Medium · 7 Low · 4 Informational |
| **Remediated in code** | **23** |
| **Open / accepted** | **7** (3 Low, 4 Informational) |
| **Recorded in UI** | Admin dashboard → Live Status Monitoring → **Security Audit Record** |
| **Machine-readable record** | `server/utils/securityAudit.js` (served by `GET /api/admin/security/monitor`) |

> ### Honesty statement
> This report does **not** claim SuppliWise is secure, hardened to the maximum, or "100% protected".
> It is a source-code review of one repository on one date. It is not a penetration test, and it did
> not cover the database cluster, cloud infrastructure, the dependency supply chain, third-party APIs,
> physical access, or social engineering. Several Critical findings are only *sanitized* in the working
> tree — the underlying credentials live forever in public git history and **must be rotated by a human**.
> Until that rotation happens, those credentials should be treated as compromised.

---

## 1. Executive summary

The audit ran in six phases, beginning with a strictly read-only review: nothing was modified until the
architecture had been mapped and every subsystem had been reviewed independently (backend data access &
IDOR, secrets/deps/config, frontend XSS & token handling, auth/OTP/MFA).

**The dominant finding is a secret-management failure, not a code bug.** Real credentials were committed
to a public repository in five separate files: the JWT signing secret, six admin password hashes, six
TOTP seeds, six admin passwords in plaintext, and a Gmail App Password. Because the remote is public,
everything that was ever committed is effectively public knowledge. All five files have been sanitized
to placeholders in this pass, and `.gitignore` has been hardened — but **sanitizing a file does not
un-leak it**. Rotation and history purge are mandatory follow-ups (§9).

Behind that, the code review found a cluster of authorization and abuse-control weaknesses that shared
one root cause: **several critical decisions were being trusted to the client or to attacker-controlled
input.** An email change was authorized by a request-body flag; IP lockouts were keyed on a header the
caller writes; entitlement lookups read the prototype chain; a dashboard reset accepted any assessment
id; and one password-reset route ran with no lockout at all. Each was fixed at the server layer, which
is where the decision belongs.

**Verification (Phase 5) passed cleanly on every axis** — unit tests, syntax checks, production build,
lint (0 errors), and `npm audit` reporting **0 vulnerabilities** in both the server and client scopes.
A final Phase 6 pass reviewed every diff for regression risk, including two cases where a fix could have
broken a live flow (the email-change OTP sequence and the password-reset sequence); both were traced
end-to-end against the actual frontend callers before being signed off.

Seven findings remain open. They are listed in full in §9 rather than being quietly dropped — three are
low-risk items with a deliberate trade-off, four are informational, and nine manual actions cannot be
performed from inside the codebase.

---

## 2. Scope & methodology

### In scope
| Layer | Area |
|---|---|
| API | Authentication, OTP/MFA, session lifecycle, rate limiting & lockout, entitlements, object-level authorization, input bounds, logging |
| Data | NoSQL injection, prototype pollution, IDOR, cache scoping, query-parameter bounds |
| Secrets | Committed configuration, documentation, logs, email contents |
| Client | XSS output handling, redirect handling, CSP, token storage, debug output |
| Dependencies | `npm audit` across all three `package.json` scopes |

### Out of scope
Database cluster configuration, cloud/network infrastructure, CI/CD (none exists), physical security,
social engineering, business-logic review beyond authorization, formal penetration testing.

### Phases

| Phase | Description | Mode |
|---|---|---|
| **1** | Read-only review — architecture mapped via four parallel deep-dives (backend data/IDOR, secrets/deps/config, frontend XSS/tokens, auth/OTP/MFA) plus direct verification of every critical finding | **No files touched** |
| **2** | Severity classification — Critical / High / Medium / Low / Informational | Read-only |
| **3** | Per-finding analysis — vulnerability, file, endpoint, attack scenario, existing control, mitigation, change, compatibility impact | Read-only |
| **4** | Remediation — fixes applied at the server/backend level only | Write |
| **5** | Automated verification — tests, syntax, build, lint, dependency audit, live endpoint probes | Execute |
| **6** | Second-pass regression review of every diff | Read-only |

### Ground rules observed
- No frontend-only "fix" for a backend vulnerability.
- No control was disabled or weakened to make a check pass.
- Business logic and API contracts preserved — every change was traced to a real frontend caller first.
- No secrets written into code, logs, responses, or bundles.
- Where a fix required a contract change that could break a caller, it was **documented instead of shipped**.

---

## 3. Severity classification

| Severity | Count | Definition |
|---|---:|---|
| **Critical** | 2 | Direct credential/account takeover, or secrets exposed to the public |
| **High** | 8 | Bypasses an authentication, authorization, or abuse-control guarantee |
| **Medium** | 9 | Weakens a defense, leaks information, or creates an injection/redirect primitive |
| **Low** | 7 | Defense-in-depth gap with a mitigating control already in place |
| **Informational** | 4 | Accepted design decision or operational gap — no direct exploit |
| **Total** | **30** | |
| ↳ remediated in code | **23** | |
| ↳ open / accepted | **7** | 3 Low + 4 Informational |

---

## 4. Findings register (all 30)

Each entry records: **vulnerability → file → endpoint → attack scenario → existing control → mitigation →
change made → compatibility impact.**

### CRITICAL

#### C1 — Live secrets committed to `server/.env.example`
| | |
|---|---|
| **Vulnerability** | Tracked configuration file contained a real JWT signing secret, six admin password hashes, and six TOTP seeds. |
| **File** | `server/.env.example` |
| **Endpoint** | n/a (offline artifact) — but the JWT secret directly signs `POST /api/auth/*` tokens |
| **Attack scenario** | The remote is **public**. Anyone clones the repo, reads the JWT secret, and mints a valid `role:'admin'` token offline — no brute force, no interaction. With `ADMIN_ACCOUNTS`, they also have the password hashes and the TOTP seeds, i.e. the complete admin login. |
| **Existing control** | `.gitignore` excluded `server/.env` — but **not** `.env.example`, which was tracked with live values. |
| **Mitigation** | Replaced every value with an empty field plus generation instructions; documented that any previously committed value is burned. |
| **Change** | `server/.env.example` fully rewritten to placeholders; `.gitignore` hardened (log/credential/key patterns, explicit `.env.example` allowance). |
| **Compatibility** | None — the file is documentation only; the live `server/.env` was not touched. |
| **Status** | **Sanitized — rotation REQUIRED (§9).** |

#### C2 — Admin passwords and TOTP seeds published in documentation
| | |
|---|---|
| **Vulnerability** | Four Markdown documents published live credentials. |
| **Files** | `ADMIN_SETUP.md` (6 plaintext passwords), `AdminNames.md` (6 TOTP seeds), `FEATURES.md` (password + TOTP seed for one admin), `Security_Fixes_and_Analysis.md` (Gmail App Password, mailbox address, live `JWT_SECRET`) |
| **Endpoint** | `/admin/login` (alias + password + TOTP) — fully compromised by the published values |
| **Attack scenario** | Read the doc, open `/admin/login`, enter the published password and the published authenticator seed. Full admin access with zero interaction. The Gmail App Password additionally permits reading/sending mail as the application mailbox (and therefore intercepting every login OTP). |
| **Existing control** | `AdminNames.md` carried a "sensitive file — do not commit" banner… inside a committed file. A warning is not a control. |
| **Mitigation** | All four documents scrubbed; each now carries an explicit incident note stating the old values must be rotated. |
| **Change** | Secrets replaced with pointers (`stored in server/.env`) and placeholders; incident notes added. |
| **Compatibility** | None — these are documentation files. |
| **Status** | **Sanitized — rotation REQUIRED (§9).** |

---

### HIGH

#### H1 — Client-controlled `emailVerified` allowed unverified email rebinding
| | |
|---|---|
| **Vulnerability** | `PUT /api/auth/profile` authorized a login-address change using a boolean read from the request body. |
| **File** | `server/routes/auth.js` |
| **Endpoint** | `POST /api/auth/verify-email-otp`, `PUT /api/auth/profile` |
| **Attack scenario** | Any signed-in session (stolen token, shared device, XSS anywhere in origin) sends `PUT /profile` with the victim's account, `email: attacker@evil.com`, `emailVerified: true`. No OTP is ever requested. The attacker then uses *forgot password* on `attacker@evil.com` and owns the account. |
| **Existing control** | The `/verify-email-otp` route validated and deleted an OTP — but **persisted nothing**, so its result could not be checked; the client flag was the only gate. |
| **Mitigation** | Verification now records *which address* was proven, for *this* account, with a 15-minute TTL. `/verify-email-otp` writes that proof; `/profile` requires `proof.email === newEmail`, rejects expired proofs, ignores the body flag entirely, and consumes the proof on success (single use). |
| **Change** | Added `emailChangeProofs` store + `EMAIL_PROOF_TTL_MS`; proof written on verify, checked on profile update, deleted after consumption; `emailVerified` removed from the destructured body. |
| **Compatibility** | None. Traced the live frontend flow: `ProfilePage.jsx` → `requestEmailOtp(newEmail)` → OTP modal → `verify-email-otp` → `submitProfileUpdate(true)` → `PUT /profile`. Both sides normalize with `str().trim().toLowerCase()`, so the proof address matches the profile address exactly. The client's now-unused `emailVerified` field is simply ignored. |
| **Status** | **Fixed.** |

#### H2 — Password reset did not revoke existing sessions
| | |
|---|---|
| **Vulnerability** | A successful password reset left every previously issued token valid. |
| **File** | `server/routes/auth.js`, `server/utils/sessions.js` |
| **Endpoint** | `POST /api/auth/reset-password` |
| **Attack scenario** | Attacker holds a stolen session token. Victim notices, and correctly resets their password. Because reset is unauthenticated and revoked nothing, the attacker's token continues to validate — the recovery action the victim was told to take did nothing to the attacker. |
| **Existing control** | One-active-session-per-account on *sign-in*, and sign-out revoked only the presented session. Reset revoked none. |
| **Mitigation** | New `revokeAllUserSessions(userId)` revokes every live `Session` row for that user **and** clears `User.currentSessionId`, so all outstanding tokens stop validating. Scoped strictly to `userId`. |
| **Change** | Helper added + exported; called immediately after `user.save()` in `/reset-password`. |
| **Compatibility** | None. Only the reset path revokes everything — the authenticated password-*change* path keeps the caller's session (it is, by the one-active-session invariant, the only session that exists; signing the user straight out would be a pure UX regression). That reasoning is now a code comment. |
| **Status** | **Fixed.** |

#### H3 — `X-Forwarded-For` spoofing defeated IP lockouts
| | |
|---|---|
| **Vulnerability** | `clientIp()` preferred the first `X-Forwarded-For` value with no trust-proxy configuration. |
| **File** | `server/utils/lockout.js`, `server/index.js` |
| **Endpoint** | Every route behind `lockoutCheck` / the IP rate limiters |
| **Attack scenario** | Attacker sends `X-Forwarded-For: 1.2.3.4` (varying per request). Each request is bucketed under a fresh "IP", so the IP ladder never accumulates and IP-level lockout never fires. Combined with an account-key attack this removes half the brute-force defense. |
| **Existing control** | `app.set('trust proxy')` was never configured, so Express's own `req.ip` was correct — but `clientIp()` bypassed it and read the raw header instead. It was also **inconsistent**: `lockMeta()` and `noteIpAccountFailure()` already used `req.ip`. |
| **Mitigation** | `clientIp()` now returns `req.ip`, which honours Express's `trust proxy` setting: off by default (real socket peer, header ignored), on only when `TRUST_PROXY=true` (Express picks the correct hop from the chain). |
| **Change** | `clientIp()` rewritten; `TRUST_PROXY` support added to `server/index.js` (`app.set('trust proxy', 1)` — one hop, never the whole chain); documented in `.env.example`. |
| **Compatibility** | Direct deployments: identical `req.ip`, now consistent across all three call sites. **Behind a proxy, `TRUST_PROXY=true` must be set**, otherwise all clients resolve to the proxy address. Flagged as a manual action (§9). |
| **Status** | **Fixed.** |

#### H4 — `/reset-password` had no lockout gate, attempt counter, or sensitive rate limit
| | |
|---|---|
| **Vulnerability** | The route re-verified the reset OTP but never consulted the lockout it recorded, never counted attempts, and was absent from `sensitiveLimiter`. |
| **File** | `server/routes/auth.js` |
| **Endpoint** | `POST /api/auth/reset-password` |
| **Attack scenario** | Skip `/verify-password-reset-otp` (which *did* count attempts) and hit `/reset-password` directly. Each wrong code recorded an offense that **this route never checked**, so guessing could continue indefinitely — the escalation ladder was being built and simply never enforced. |
| **Existing control** | `/verify-password-reset-otp` had lockout + attempt counting, but was a *separate* step an attacker is free to bypass. `sensitiveLimiter` covered six other auth routes but not this one. |
| **Mitigation** | Added a lockout gate at the top of the route (same 429 shape as its siblings); OTP mismatches now run through `registerOtpAttempt()` — 5 strikes invalidates the code and escalates; the route and five other previously-uncovered routes added to `sensitiveLimiter`. |
| **Change** | Lockout gate + `registerOtpAttempt` in `/reset-password`; `sensitiveLimiter` paths extended to `/login`, `/forgot-password`, `/reset-password`, `/resend-login-otp`, `/resend-password-reset-otp`, `/request-email-otp`. |
| **Compatibility** | None. Verified the real frontend sequence (`verify-password-reset-otp` → `reset-password`): attempts increment **only on mismatch**, so a correct code consumed twice never burns an attempt. Generous limits (60/10 min) far above any human flow. |
| **Status** | **Fixed.** |

#### H5 — Admin 2FA verification had no failure counter
| | |
|---|---|
| **Vulnerability** | `POST /api/auth/verify-admin-2fa` accepted unlimited authenticator guesses. |
| **File** | `server/routes/auth.js` |
| **Endpoint** | `POST /api/auth/verify-admin-2fa` |
| **Attack scenario** | Attacker with the admin password (see C1/C2, where it was published) faces only a 6-digit TOTP. The endpoint had no lockout and no failure recording; the IP limiter throttles but never *stops*. A 5-minute challenge plus repeatable challenges gives a practical path to a lucky hit. |
| **Existing control** | Challenge expiry (5 min) and the IP-based `sensitiveLimiter`. |
| **Mitigation** | Account-lockout gate on the alias bucket *before* verification; `recordAccountFailure` on each wrong code; `clearAccountState` on success. Three failures in 15 minutes locks the alias — the same bucket `/admin-login` checks. |
| **Change** | Lockout gate + failure accounting added to `/verify-admin-2fa`. |
| **Compatibility** | None — identical key (`accountKey('admin', alias)`) and identical 429 payload shape as every other credential step; the frontend already handles these. |
| **Status** | **Fixed.** |

#### H6 — `setup-2fa` could silently rotate an enabled account's authenticator
| | |
|---|---|
| **Vulnerability** | `POST /api/auth/setup-2fa` wrote a fresh TOTP secret unconditionally, regardless of current state. |
| **File** | `server/routes/auth.js` |
| **Endpoint** | `POST /api/auth/setup-2fa` |
| **Attack scenario** | With a hijacked session, the attacker calls `setup-2fa` on an account that already has 2FA enabled. The owner's authenticator is replaced by a seed only the attacker holds — the owner is locked out of login while the attacker can complete second-factor checks. |
| **Existing control** | `protect` (authentication only — no re-authentication, no state check). |
| **Mitigation** | Returns `409` while `twoFactorEnabled` is already `true`, directing the caller to disable first. |
| **Change** | Guard added at the top of the handler. |
| **Compatibility** | None. Verified the UI only renders the setup control when 2FA is **off** (`ProfilePage.jsx` → `{!twoFactorEnabled ? …}`), and the only path onto an enabled account is *disable → setup → verify*. No legitimate flow reaches the guard. |
| **Status** | **Fixed.** |

#### H7 — `/api/polish` was an unauthenticated AI proxy
| | |
|---|---|
| **Vulnerability** | The route was documented `@access Public` and had no `protect` middleware. |
| **File** | `server/routes/polish.js` |
| **Endpoint** | `POST /api/polish` |
| **Attack scenario** | Anyone who discovers the route converts it into a free OpenRouter proxy — burning paid quota, exhausting the account, and using the service as an anonymous text-processing oracle. The IP `aiLimiter` (60/10 min) throttles but never authorizes. |
| **Existing control** | `aiLimiter` (rate limit only), a 1000-character cap, and a garbage-input filter. |
| **Mitigation** | `protect` middleware added. |
| **Change** | `router.post('/', protect, async …)`; access documentation updated. |
| **Compatibility** | **Verified before shipping** — a repo-wide search for `polish` across all `js/jsx/ts/tsx/html` returned matches in `AssessmentPage.css` only. There is **no frontend caller** at all (only orphaned CSS), so no request can break. |
| **Status** | **Fixed.** |

#### H8 — No Content-Security-Policy on the client
| | |
|---|---|
| **Vulnerability** | The document shipped without any CSP, so nothing constrained where the browser would load or execute script. |
| **File** | `my-react-app/index.html` |
| **Endpoint** | Every page of the SPA |
| **Attack scenario** | Given *any* HTML-injection primitive, the injected payload loads `https://attacker/x.js` and runs it in-origin with full access to session storage. Without a CSP there is no second line of defense behind React's escaping. |
| **Existing control** | React's default output escaping and the API origin's Helmet CSP (which only covers `localhost:5000`, not the app origin). |
| **Mitigation** | CSP `<meta>` added: `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `frame-src 'none'`, `media-src 'none'`, `form-action 'self'`, allowlisted `script/style/img/font/manifest/worker` sources, and a permissive `connect-src` (the API origin is derived from the page host, so LAN devices call `http://<ip>:5000`). |
| **Change** | One `<meta http-equiv="Content-Security-Policy">` block with an inline rationale, verified against the actual codebase: no `<iframe>`, no Google Fonts, no external scripts/styles/images, `data:` used only for inline SVG icons and profile pictures, service worker served same-origin. |
| **Compatibility** | `script-src` keeps `'unsafe-inline'` **deliberately** — `@vitejs/plugin-react` injects an inline Fast Refresh preamble in dev and React sets inline style attributes. The meaningful win is preserved anyway: **no external script host and no `eval()` is ever permitted**, so an injected `<script src="https://…">` simply never loads. `frame-ancestors` cannot be set from `<meta>` and must be sent as a header (§9). |
| **Status** | **Mitigated — pending live browser verification (browser tooling was disconnected for this audit).** |

---

### MEDIUM

#### M1 — Query-string token accepted on every protected route
- **Vulnerability** · **File** `server/middleware/auth.js` · **Endpoint** all `protect` routes.
- **Scenario** · `?token=…` lands in proxy/access logs, browser history, analytics, and `Referer` headers — a bearer credential leaking through channels that are rarely guarded.
- **Control** · `Authorization: Bearer` was the primary path; the query fallback was a convenience.
- **Mitigation** · Fallback removed — `protect` is now header-only.
- **Change** · One branch deleted. **Compatibility verified:** the only query-token consumer in the repo is `useSubscription.js`'s `EventSource`, and `routes/subscription.js` has its own route-scoped `streamTokenAuth` that copies `?token` → `Authorization` **before** `protect` runs. SSE keeps working; every other route now requires the header.
- **Status** · **Fixed.**

#### M2 — Prototype-chain feature lookup failed *open*
- **Vulnerability** · `FEATURES[key]` with raw request input reads inherited members. **File** `server/utils/entitlements.js`, `server/routes/subscription.js`. **Endpoint** `GET /api/subscription/feature/:key` and every `requireFeature()` gate.
- **Scenario** · `…/feature/constructor` (or `toString`, `hasOwnProperty`) resolves to a truthy inherited value with no `minTier`; `rankOf(undefined)` falls back to `0`, and `rank >= 0` is always true — the "unknown feature" branch never runs and `can()` answers **TRUE** for a feature that does not exist.
- **Control** · `if (!def) return false` — correct for genuinely missing keys, defeated by the prototype chain.
- **Mitigation** · `hasFeature()` / `getFeature()` using `Object.prototype.hasOwnProperty.call(FEATURES, key)`; `can()`, `requireFeature()` and the subscription route all route through it.
- **Change** · New helpers + three call sites. **Compatibility** · identical for all registered feature keys.
- **Status** · **Fixed.**

#### M3 — Dashboard reset accepted a foreign `assessmentId`
- **Vulnerability** · Missing object-level authorization. **File** `server/routes/dashboard.js`. **Endpoint** `POST /api/dashboard/reset`.
- **Scenario** · Any authenticated user posts another account's assessment id and binds their own `DashboardMetrics` to it — broken IDOR hygiene and a corrupted object graph.
- **Control** · `mongoose.isValidObjectId` rejected malformed ids but never checked the owner.
- **Mitigation** · `Assessment.findOne({ _id, user: req.user._id })` — 404 when not owned.
- **Change** · Ownership query inserted after the id-format check. **Compatibility** · a repo-wide search shows **no frontend caller** for this endpoint, so nothing can break.
- **Status** · **Fixed.**

#### M4 — Unbounded `page` / `year` query and path parameters
- **Vulnerability** · Unclamped numeric input. **File** `server/routes/assessment.js`, `server/routes/dashboard.js`. **Endpoints** `GET /api/assessment/history?page=`, `GET /api/dashboard/calendar/:year/:month`.
- **Scenario** · `?page=999999999999999999` produced a `skip` far beyond `Number.MAX_SAFE_INTEGER` — imprecise, and a cheap way to make the database grind. `…/calendar/999999999999/1` built an Invalid Date whose `.toISOString()` threw, turning a crafted URL into an unhandled **500**.
- **Control** · `page` floored at 1; month validated 1–12; year only checked for `NaN`.
- **Mitigation** · `page` clamped to `1…1,000,000`; year clamped to `2000…(currentYear + 1)`; `parseInt(..., 10)` everywhere.
- **Change** · Four bounds added. **Compatibility** · no real pagination reaches anywhere near these windows; out-of-range values now yield an empty result or a 400 instead of a 500.
- **Status** · **Fixed.**

#### M5 — TOTP replay cache keyed to the current time step
- **Vulnerability** · The single-use cache keyed on `secret:code:<current 30 s step>`. **File** `server/utils/totp.js`. **Endpoint** every TOTP check (login 2FA, admin 2FA, disable 2FA, email OTP verify).
- **Scenario** · Verification uses `window: 1`, so a code minted for step *N* still validates during step *N+1*. Entering the *same* code after the boundary produced a **different key**, so the replay passed a second time.
- **Control** · 90-second TTL replay cache — undermined by the step component in the key.
- **Mitigation** · Key is now `secret:code` only. The 90 s TTL already exceeds the code's full ±1-step validity span, so a consumed code can never be replayed.
- **Change** · One line + rationale comment. **Compatibility** · a fresh 6-digit code colliding with a just-consumed one inside 90 s is a 1-in-10⁶ event that merely asks the user to wait one tick.
- **Status** · **Fixed.**

#### M6 — Banned-account status leaked before password verification
- **Vulnerability** · An unauthenticated existence/status oracle. **File** `server/routes/auth.js`. **Endpoint** `POST /api/auth/login`.
- **Scenario** · The `accountStatus !== 'active'` check ran **before** `matchPassword`. A wrong password on a banned account returned **403**, while a wrong password on a normal account returned **401** — confirming both that the account exists *and* that it was banned, without knowing the password.
- **Control** · Generic "Invalid email or password" messaging on the not-found and wrong-password paths (the ban check simply sat in the wrong place).
- **Mitigation** · Ban check moved to *after* a successful password verification.
- **Change** · Reordered two blocks. **Compatibility** · verified against the unit-test mock (no `accountStatus` property → check skipped) and against real behavior: an attacker with a valid password learns nothing they could not already use; anonymous callers now always see 401.
- **Status** · **Fixed.**

#### M7 — Full email addresses written to server logs
- **Vulnerability** · PII persisted in shared stdout/log files. **File** `server/routes/auth.js`, `server/utils/email.js`.
- **Scenario** · Log aggregation, support bundles, and copied terminal output all become a durable list of user addresses — a privacy exposure and a target whenever logs are less protected than the database.
- **Control** · None; four log sites interpolated `${email}` directly. (OTP codes were verified **never** logged.)
- **Mitigation** · `maskEmail()` — keeps the first character of the local part plus the domain (`a***@example.com`), preserving diagnosability.
- **Change** · Added to both files; applied at every recipient-logging site (password reset, OTP delivery ×2, status mail, admin credentials).
- **Status** · **Fixed.**

#### M8 — Open-redirect primitive via `location.state.redirectTo`
- **Vulnerability** · Unvalidated redirect target used for a full page navigation. **File** `my-react-app/src/Pages/LogIn.jsx`, `SignIn.jsx`. **Endpoint** post-login navigation.
- **Scenario** · `window.location.href = redirectTo` on the account-switch path accepts whatever router state holds — including `https://evil.com`. Sign-in becomes an open redirect, the classic ingredient for credential phishing ("you clicked Sign in from SuppliWise…").
- **Control** · A `|| '/dashboard'` fallback — only for *missing* values, not hostile ones.
- **Mitigation** · `safeRedirectPath()` in the new `src/utils/safeUrl.js`: string-only, must be a single-leading-slash app path, rejects `//host`, `/\host`, absolute URLs, and auth-screen loops.
- **Change** · Helper + two call sites. **Compatibility** · both in-app callers pass `/assessment` or `/dashboard`, both of which pass unchanged.
- **Status** · **Fixed.**

#### M9 — `javascript:` scheme reachable in AI-generated resource links
- **Vulnerability** · Model output placed directly into `href`. **File** `my-react-app/src/Pages/ResultsPage.jsx`, `HistoryPage.jsx`. **Endpoint** the "Seeking Support" resource cards.
- **Scenario** · The resource URLs come from the AI response. A `javascript:` value renders as a normal-looking link and executes script in-origin the moment it is clicked — a **stored XSS** primitive that survives in saved assessment history.
- **Control** · React escaping (irrelevant — `href` is an attribute, not text), `rel="noopener noreferrer"` (only matters for external targets), `target="_blank"`.
- **Mitigation** · `safeUrl()` allowlist: strips control characters first (defeating `java\tscript:` obfuscation), then accepts only `http:`/`https:`/root-relative. Anything else returns `null`, and `href={undefined}` renders the card as an unlinked element with its content intact.
- **Change** · Helper + two call sites.
- **Status** · **Fixed.**

---

### LOW

#### L1 — `jwt.verify` without an `algorithms` allowlist — **Fixed**
File `server/middleware/auth.js`, `server/routes/auth.js` (4 sites: `protect`, `/admin-refresh`, `/request-email-otp`, `/verify-email-otp`, `/profile`).
*Scenario* — without pinning, a token signed under a different algorithm (including `none` in some library configurations) can be accepted. *Change* — `{ algorithms: ['HS256'] }` on every call; all tokens this server mints are HS256.

#### L2 — Sensitive endpoints missing from `sensitiveLimiter` — **Fixed**
File `server/routes/auth.js`. Six routes (`/login`, `/forgot-password`, `/reset-password`, `/resend-login-otp`, `/resend-password-reset-otp`, `/request-email-otp`) sat outside the strict per-IP budget. Added — with a shared escalation path, so hitting the limit still climbs the lockout ladder.

#### L3 — Admin bearer token stored in `localStorage` — **Open (accepted with mitigation)**
File `my-react-app/src/auth/authState.js`, `AdminProtectedRoute.jsx`, `ModifyAssessmentModal.jsx`. *Scenario* — `localStorage` is script-readable, so any XSS in the admin origin yields the token. *Why not fixed here* — moving it to an `httpOnly; SameSite` cookie is an API-contract change touching every admin call site and the `x-admin-background` header convention; shipping it without a live browser to verify would risk breaking the dashboard. *Mitigations already in place* — the new CSP (H8), a 5-minute token TTL, and the 3:30 admin idle kill, which together bound the exposure window. **Recommendation: schedule the cookie migration as its own change.**

#### L4 — No `trust proxy` configuration — **Fixed**
File `server/index.js`. `TRUST_PROXY=true` now enables `app.set('trust proxy', 1)` (exactly one hop). Documented in `.env.example` and flagged as a deployment requirement in §9.

#### L5 — Partial account enumeration via `forgot-password` — **Open (accepted)**
File `server/routes/auth.js`. *Scenario* — responses are deliberately generic ("If an account exists…"), but a successful response carries a `userId` an unknown address does not. *Why not fixed here* — the value is required by the reset flow as currently designed (the client needs it to POST `/reset-password`); removing it changes the contract. *Verified* — a live probe with an unknown address returned generic `200` and **no** `userId`.

#### L6 — Admin provisioning email carries a plaintext password and TOTP seed — **Open (accepted)**
File `server/utils/email.js`. Intentional first-run delivery over TLS, and the email itself instructs the recipient to change the password. *Recommendation* — add a forced-change-on-first-login flow and stop sending the TOTP seed by mail.

#### L7 — `express.json` body limit is 10 MB — **Open (accepted)**
File `server/index.js`. Required by base64 banner uploads (≤3 MB) and profile pictures (≤2 MB) after JSON overhead. The uploads are individually size-checked with `413` responses; a per-route limit would be the improvement.

---

### INFORMATIONAL

| ID | Finding | Position |
|---|---|---|
| **I1** | **User JWTs carry no `exp` claim** | **Deliberate design**, documented in `server/utils/sessions.js`: the server-side pointer (`User.currentSessionId` + `Session.revokedAt`) is authoritative, so sessions end by replacement or sign-out, never by wall-clock expiry. Adding `exp` would silently sign everyone out at a fixed interval — a product decision, not a bug. Server-side revocation (H2) is what actually matters, and it now works. |
| **I2** | **`SupplementDetail` cache is shared across users** | **By design.** Only non-personalized guides are written to it; personalized responses are never cached. Making it per-user would multiply storage for no security gain. |
| **I3** | **No CI pipeline, containers, or automated dependency updates** | Nothing runs the test suite or `npm audit` on push. This is the cheapest way to keep this audit honest — and `npm audit` currently reports **0 vulnerabilities**, which CI should be confirming on every commit. |
| **I4** | **`speakeasy` is unmaintained; `axios` is an unused dependency** | Both low risk. `speakeasy` is used only for RFC-6238 math (its output is independently verified by the replay self-test); `axios` has **zero importers** anywhere in `my-react-app/src`. Left in place rather than churning lockfiles during a security pass — removing `axios` and evaluating `otplib` as a `speakeasy` replacement are clean follow-ups. |

---

## 5. Remediation changes (file by file)

### Secrets & repository hygiene
| File | Change |
|---|---|
| `server/.env.example` | Full rewrite — all live values replaced with empty fields + generation instructions; `TRUST_PROXY` documented; incident note about burned history |
| `AdminNames.md` | Six TOTP seeds replaced with pointers to `server/.env`; incident note added |
| `ADMIN_SETUP.md` | Six plaintext passwords removed; incident note added |
| `FEATURES.md` | Admin password + TOTP seed removed; incident note added |
| `Security_Fixes_and_Analysis.md` | Gmail App Password, mailbox address, and live `JWT_SECRET` replaced (2 blocks + a 3rd occurrence at the "Generate Secure Secret" section) |
| `.gitignore` | Credential/key/log patterns added; `.env.example` explicitly allowed; comment records *why* examples must be placeholder-only |

### Backend — authorization & abuse control
| File | Change |
|---|---|
| `routes/auth.js` | Server-side email-change proof (H1) · session revocation on reset (H2) · lockout gate + attempt counter on `/reset-password` (H4) · admin-2FA failure counter (H5) · `setup-2fa` 409 guard (H6) · banned check moved after password (M6) · `algorithms:['HS256']` ×4 (L1) · `sensitiveLimiter` paths ×6 (L2) · email masking (M7) · `revokeAllUserSessions` import · comment documenting why password *change* keeps its session |
| `middleware/auth.js` | Query-token fallback removed (M1) · `algorithms:['HS256']` (L1) |
| `utils/lockout.js` | `clientIp()` → `req.ip` (H3) |
| `utils/sessions.js` | New `revokeAllUserSessions()` + export (H2) |
| `utils/totp.js` | Replay key drops the time step (M5) |
| `utils/entitlements.js` | `hasFeature()` / `getFeature()` own-property guards (M2) |
| `routes/subscription.js` | Route uses `getFeature()` (M2) |
| `routes/polish.js` | `protect` added (H7) |
| `routes/dashboard.js` | Reset ownership check (M3) · year clamp (M4) |
| `routes/assessment.js` | `page` clamp + `parseInt(…, 10)` (M4) |
| `utils/email.js` | `maskEmail()` + 3 log sites (M7) |
| `index.js` | `TRUST_PROXY` support (H3/L4) |
| `routes/admin.js` | `audit` attached to `/security/monitor` payload (§8) |
| `utils/securityAudit.js` | **New** — the machine-readable audit record |

### Frontend
| File | Change |
|---|---|
| `src/utils/safeUrl.js` | **New** — `safeUrl()` (M9) and `safeRedirectPath()` (M8) |
| `src/Pages/ResultsPage.jsx`, `HistoryPage.jsx` | Resource `href` routed through `safeUrl()` (M9) |
| `src/Pages/LogIn.jsx`, `SignIn.jsx` | Post-login target routed through `safeRedirectPath()` (M8) |
| `index.html` | CSP `<meta>` + inline rationale (H8) |
| `src/Components/SecurityStatus/SecurityStatus.jsx` | `AuditRecord` section rendering the audit (§8) |
| `src/Components/SecurityStatus/SecurityStatus.css` | `aud-*` styles for the record |

### Intentionally unchanged
User-JWT `exp` (I1) · `SupplementDetail` cache scoping (I2) · `express.json` 10 MB limit (L7) · admin token
storage (L3) · `forgot-password` contract (L5) · `speakeasy` / `axios` dependencies (I4) · adding `protect`
to `/api/polish`'s sibling AI routes without first confirming their callers · any test, limiter, or
verification control.

---

## 6. Verification — Phase 5 results

| Check | Command | Result |
|---|---|---|
| Unit tests | `npm test` → `node --test "Test File/*.test.js"` | ✅ **1/1 pass** — *"login route does not leak OTPs in the JSON response"* |
| Syntax | `npm run check` + `node --check` on all 11 edited modules | ✅ **All pass** |
| Production build | `npx vite build` | ✅ **287 modules**, PWA service worker generated |
| Lint | `npx eslint .` | ✅ **0 errors** · 4 pre-existing `react-hooks/exhaustive-deps` **warnings** (in `useEffect` dependency arrays at lines I did not touch — `ProfilePage.jsx:226` is in a file this audit never modified, confirming they predate it) |
| Dependency audit (prod) | `npm audit --omit=dev` | ✅ **0 vulnerabilities** — server |
| Dependency audit (prod) | `npm audit --omit=dev` | ✅ **0 vulnerabilities** — client |
| Dependency audit (all) | `npm audit` | ✅ **0 vulnerabilities** — both scopes |
| Live: API healthy | `GET /api/health` | ✅ 200 |
| Live: captcha | `GET /api/auth/captcha` | ✅ 200 |
| Live: client serves CSP | `GET http://localhost:5173/` | ✅ 200, `Content-Security-Policy` present; also present in built `dist/index.html` |
| Live: **polish now authed** | `POST /api/polish` (no token) | ✅ **401** — was previously public |
| Live: query token rejected | `GET /api/subscription?token=…` | ✅ **401** |
| Live: auth required | `/api/subscription`, `/api/assessment/history`, `/api/dashboard/reset`, `/api/subscription/feature/constructor` | ✅ all **401** |
| Live: anti-enumeration intact | `POST /api/auth/forgot-password` (unknown address) | ✅ 200 generic, **no `userId`** |
| Live: reset with bad OTP | `POST /api/auth/reset-password` | ✅ 401 (no 500, no unhandled throw) |
| Live: bad login | `POST /api/auth/login` | ✅ 401 |

**Secret sweep of the working tree** (post-remediation): no bcrypt/argon2 hashes, no base32 TOTP seeds of
32+ characters, no Gmail App Password, no live JWT secret remain anywhere in tracked files. The only
residual match is an already-redacted Atlas URI (`mongodb+srv://[CREDENTIALS]@cluster0…`) — **the cluster
hostname is still exposed**, which is informational but worth noting.

---

## 7. Second review — Phase 6 regression analysis

Every diff was re-read specifically looking for changes that could break working behavior. Two findings
were corrected during the review rather than after it:

1. **Email-change flow (H1)** — the fix would have been wrong if the frontend never called
   `/verify-email-otp`, or if the two endpoints normalized the address differently. Traced end to end:
   `handleSubmit` → `requestEmailOtp(newEmail)` → OTP modal → `verifyEmailOtp()` posting
   **`{ newEmail, otp }`** → `submitProfileUpdate(true)` posting `email: pendingEmailChange`.
   The backend reads `newEmail` on the verify route and `email` on the profile route, and **both**
   normalize via `str().trim().toLowerCase()` — so the proof address matches the target address exactly.
   Proof TTL (15 min) comfortably covers the time a user takes to read and type a code.
2. **Password-reset flow (H4)** — adding `registerOtpAttempt` to `/reset-password` would have double-counted
   attempts if it fired on success, because the frontend legitimately presents the same code to both
   `/verify-password-reset-otp` and `/reset-password`. Confirmed it increments **only on mismatch**, so a
   correct code costs nothing. The lockout gate uses the identical key as the verify route, so a user who
   has genuinely been locked out now gets the same 429 from both.

Additional checks:
- **`/api/polish` (H7)** and **`POST /dashboard/reset` (M3)** each have **zero frontend callers** —
  confirmed by repo-wide search before adding `protect` / the ownership check, so neither can break a flow.
- **`setup-2fa` guard (H6)** — the UI only offers setup when 2FA is off; disable requires a valid current
  TOTP. The guard has no reachable legitimate path.
- **Lockout key consistency (H3)** — `clientIp()` previously disagreed with `lockMeta()`/`noteIpAccountFailure()`,
  which already used `req.ip`. The change makes all three agree rather than introducing a new divergence.
- **`sensitiveLimiter` (L2)** — 60/10 min is far above any human login flow, and it shares the same
  escalation handler as `authLimiter`, so no new lockout behavior is introduced.
- **No control was weakened** — no limiter, verifier, test, or check was relaxed anywhere in this pass.
- **Nothing in the prior uncommitted work was reverted** — the entitlement system, login-page fixes, and
  notification panels are untouched by this audit (visible in the shared diffs, which contain both bodies
  of work).

---

## 8. Recorded inside Live Status Monitoring → Security

The audit is recorded **in the product itself**, not only in this document:

- **Backend** — `server/utils/securityAudit.js` exports `SECURITY_AUDIT`, attached to the
  `GET /api/admin/security/monitor` payload as `audit`, alongside the live `monitors` array. The two are
  intentionally different: *probes say what the system is doing right now; the audit record says what a
  human review found and what is still open.*
- **Frontend** — `SecurityStatus.jsx` renders a new **“Security Audit Record”** card under the Real-time
  Security Monitor table, styled with a new `aud-*` block in `SecurityStatus.css`.

The card shows:

| Element | Content |
|---|---|
| Header | Title, audit ID `SEC-AUDIT-2026-09-23`, conduct date, scope |
| Stat tiles | Critical · High · Medium · Low · Informational · **Total** · **Remediated** · **Open/accepted** |
| *Method* (collapsible) | All six phases |
| *Key findings* (collapsible) | C1, C2, H1–H8 with severity chips, attack detail, and status |
| *Changes applied* (collapsible) | All 23 fixes, keyed by finding ID and file |
| *Open & accepted items* (open by default) | All 7, with the reasoning for each |
| *Automated verification* (open by default) | Phase 5 results, PASS-highlighted |
| ⚠ **Manual action required** | Deliberately loud amber box — the rotation list |
| Disclaimer | States plainly that this is not a penetration test and does not certify the system as secure |
| Footer | Pointer to this document |

> The widget could not be **visually** confirmed — browser tooling was disconnected for this audit.
> It compiles, lints clean, builds, and the API contract it consumes was verified by reading the route.

---

## 9. Manual actions & residual risk

### 🔴 Urgent — credentials are compromised, not merely "leaked once"
Because the remote is **public**, everything below is in git history and must be treated as known until rotated:

| # | Action |
|---|---|
| 1 | **Rotate `JWT_SECRET`** — generate fresh (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`). Until then anyone can forge admin tokens offline. |
| 2 | **Change all six admin passwords** (published in plaintext in `ADMIN_SETUP.md`). |
| 3 | **Regenerate all six TOTP seeds** and re-enrol each in its authenticator — publishing a seed means the attacker already holds the second factor. |
| 4 | **Revoke and reissue the Gmail App Password** — it controls the mailbox that receives every login OTP. |
| 5 | **Purge secrets from git history** (history rewrite), *or* accept that they are known and rely entirely on step 1–4. Rotation makes purge optional; **not** rotating makes purge mandatory. |
| 6 | **Decide whether this repository should be public.** |

### 🟡 Operational
| # | Action |
|---|---|
| 7 | **Set `TRUST_PROXY=true` if the API sits behind a reverse proxy / load balancer.** With it off (the secure default), every client resolves to the proxy address and IP lockouts bucket all users together. |
| 8 | **Send `frame-ancestors` / `X-Frame-Options` as HTTP headers** for the client origin — a `<meta>` tag cannot carry them (Helmet already does this for the API origin only). |
| 9 | **Verify the new CSP in a live browser.** Browser tooling was disconnected throughout this audit; the policy was written conservatively (and deliberately keeps `'unsafe-inline'` so dev and prod both work), but it has never been observed enforcing. |
| 10 | **Add CI** running `npm test`, `npx eslint .`, `npx vite build`, and `npm audit` on every push. |
| 11 | **Re-run this audit** after rotation and after CI exists. |

### Residual risk — what is still true after this pass
- **The exposed credentials remain valid until a human rotates them.** Sanitizing five files changes the
  repository, not the secrets. This is the single largest remaining risk and no code change can close it.
- **The admin token still lives in `localStorage` (L3)** — mitigated by the CSP, a 5-minute TTL and the
  3:30 idle kill, but not eliminated.
- **`forgot-password` still returns a `userId` (L5)** for existing accounts — a narrow enumeration gap.
- **The CSP has `'unsafe-inline'` for scripts (H8)** — required for Vite's dev preamble and React's inline
  styles. It blocks external script hosts and `eval()`, but does *not* stop an inline injected `<script>`.
  The robust fix is a nonce/hash-based **header** CSP in production, which also unlocks `frame-ancestors`.
- **Rate limiting and lockout are in-memory** (documented in `utils/lockout.js`) — correct for a
  single-instance deployment, but every lockout resets on restart and does not span replicas.
- **No dependency, infrastructure, or third-party review was performed** — `npm audit` reporting 0 known
  vulnerabilities is not the same as the supply chain being clean.
- **`speakeasy` is unmaintained (I4)** — its output is exercised by the replay self-test, but it receives
  no upstream security fixes.

---

## 9A. Addendum — Glitch Hunt (2026-09-24)

A second, adversarial pass ran the day after the audit: instead of reading code, it *attacked the live
API* with `server/glitch-hunt.js` — a 120-probe suite that deliberately tries to break, confuse, or
cheat every subsystem (auth, sessions, entitlements, IDOR, injection, prototype chain, parameter bounds,
XSS, open redirect, mass assignment, admin boundaries, output hygiene). Every probe asserts the *safe*
outcome; a wrong status, a leak, a 500, or a hung response is a FAIL. The first run crashed the server
mid-hunt — which is itself proof the method finds real defects.

### New glitches found and fixed (G-series)

| ID | Glitch | File | Fix |
|---|---|---|---|
| **G1** | `POST /api/polish` with a non-string `text` (`[]`, `12345`, `null`) **hung the request forever** (no response) and raised an unhandled rejection from a re-thrown catch — a client could wedge connections at will. | `server/routes/polish.js` | Top-of-route type guard (`typeof text === 'string'`) → clean **400**; defensive catch so a handler error answers 500 instead of never responding. |
| **G2** | `POST /api/assessment` with `age: "not-a-number"` (or non-numeric `weight`/`height`) returned **500** — a Mongoose `CastError` escaping validation. | `server/routes/assessment.js` | `finite()` numeric validation on age/weight/height → **400** with a clear message. |
| **G3** | `POST /api/chat` with a non-string `message` (e.g. `12345`) fell through to a generic **200** instead of a validation error. | `server/routes/chat.js` | `typeof message !== 'string'` guard → **400**. |
| **G4** | `add-supplement` accepted hostile field types: uncoerced `dosage`/`timing` objects and a non-whitelisted `priority` (Mongoose enum `ValidationError` → **500**); `cleanSupplementName` did not strip markup, allowing `<img onerror=…>` to persist in stored supplement names (stored-XSS primitive). | `server/routes/dashboard.js` | `str()` coercion on `dosage`/`timing`, `priority` whitelisted to `High/Medium/Low`, `cleanSupplementName` strips all markup (`/<[^>]*>/g`). |
| **G5** | The process-level crash guards themselves could throw from their logging path and take the API down. | `server/index.js` | Guard bodies wrapped in `try/catch` — a throwing log can no longer kill the process. |
| **G6** | Prior probe-run accounts (`hunt-*`) survived the crashed hunt — test artifacts accumulating in the live database. | n/a (operational) | Cleanup verified: accounts deleted (`deleteMany` on `^hunt-`), and the suite now always tears down its throwaway accounts. |

### Probe-suite fixes (the tool, not the product)

Also fixed in `glitch-hunt.js` so the harness reports truth rather than its own bugs: hard 10 s timeout
on every call (a hung response surfaces as status-0 FAIL, never a frozen suite), no bodies on GET/HEAD
(undici rejects those client-side), and the deep-history probe accepts **403** as the correct
`historyFull` entitlement gate.

### Verification — all green after fixes

| Check | Result |
|---|---|
| `node glitch-hunt.js` (live API) | ✅ **120 passed, 0 failed**, exit 0 |
| `node test-session-flows.js` (live) | ✅ all pass — sessions, revocation, races, saved logins |
| `node test-subscription-flows.js` (live) | ✅ **29/29** — SSE pushes, tier gates, expiry |
| `npm run check` (server syntax) | ✅ exit 0 |
| `npm test` (server) | ✅ **68/68** |
| `npx eslint .` (client) | ✅ 0 errors (4 pre-existing warnings) |
| `npx vite build` | ✅ built, PWA worker generated |
| `npm test` (client entitlements) | ✅ **9/9** |
| `npm audit --omit=dev` | ✅ **0 vulnerabilities** — both scopes |
| `GET /api/health` | ✅ 200 (API left running on the fixed code) |

Notable behaviors confirmed by the hunt: forged/`alg:none`/wrong-secret tokens all **401**; query-string
tokens dead everywhere except the SSE stream; mass assignment of `role`/`subscriptionPlan` ignored at
register *and* profile; IDOR probes (foreign assessment reset/delete/read/patch) all refused; NoSQL
operators rejected with 400; prototype keys (`constructor`, `__proto__`, …) fail closed with 403; FREE
tier correctly 403s on insights/chat/page-2 history; email-change rebind refused without OTP proof;
logout and session displacement revoke server-side immediately.

---

## 10. Appendix

### A. How to re-verify this audit
```powershell
# Backend
cd server
npm run check          # syntax on core modules
npm test               # node --test "Test File/*.test.js"
node glitch-hunt.js    # adversarial probe suite (API must be running) — needs 0 failures

# Frontend
cd ..\my-react-app
npx eslint .           # must report 0 errors
npx vite build         # must complete, PWA worker generated

# Dependency audit (both scopes)
npm audit --omit=dev

# Secret sweep of tracked docs — must return nothing.
# Pattern covers: bcrypt/argon2 hashes, base32 TOTP seeds, and the
# previously-leaked 16-char Gmail App Password. Do NOT paste real secret
# values into this pattern — search for structure, never for the literal.
git grep -nE '\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}|\$argon2id\$|[A-Z2-7]{32}' -- '*.md' '*.example'
```

### B. Where each fix lives (quick index)

| Fix | File |
|---|---|
| Secrets sanitization | `server/.env.example`, `AdminNames.md`, `ADMIN_SETUP.md`, `FEATURES.md`, `Security_Fixes_and_Analysis.md`, `.gitignore` |
| Email-change proof | `server/routes/auth.js` |
| Session revocation on reset | `server/routes/auth.js`, `server/utils/sessions.js` |
| IP spoof → `req.ip` | `server/utils/lockout.js`, `server/index.js` |
| Reset lockout + attempts | `server/routes/auth.js` |
| Admin 2FA counter | `server/routes/auth.js` |
| `setup-2fa` guard | `server/routes/auth.js` |
| `/api/polish` auth | `server/routes/polish.js` |
| Query-token removal | `server/middleware/auth.js` |
| Entitlement prototype guard | `server/utils/entitlements.js`, `server/routes/subscription.js` |
| Dashboard ownership | `server/routes/dashboard.js` |
| Parameter clamps | `server/routes/assessment.js`, `server/routes/dashboard.js` |
| TOTP replay key | `server/utils/totp.js` |
| Banned-check ordering | `server/routes/auth.js` |
| PII log masking | `server/routes/auth.js`, `server/utils/email.js` |
| JWT algorithm pinning | `server/middleware/auth.js`, `server/routes/auth.js` |
| Sensitive limiter coverage | `server/routes/auth.js` |
| Safe URLs & redirects | `my-react-app/src/utils/safeUrl.js`, `ResultsPage.jsx`, `HistoryPage.jsx`, `LogIn.jsx`, `SignIn.jsx` |
| CSP | `my-react-app/index.html` |
| Audit record | `server/utils/securityAudit.js`, `server/routes/admin.js`, `SecurityStatus.jsx`, `SecurityStatus.css` |

### C. Notable *non*-changes (decided deliberately, not overlooked)
| Candidate | Decision |
|---|---|
| Add `exp` to user JWTs | **No** — would sign every user out on a timer; server-side revocation is the real control and now works (I1). |
| Require a password on `setup-2fa` | **No** — an API-contract change with no frontend caller to satisfy; the state guard (H6) closes the actual hole. |
| Put `/api/polish` behind a *tier* gate | **No** — authentication (H7) was sufficient; entitlement gating would be new business logic. |
| Per-user `SupplementDetail` cache | **No** — only non-personalized content is cached (I2). |
| Drop the 10 MB JSON limit | **No** — banner uploads need it; uploads are already size-capped with `413` (L7). |
| Remove `axios` / replace `speakeasy` | **No** — dependency churn during a security pass carries its own risk; documented instead (I4). |
| Remove debug `console.log` calls | **Investigated, not needed** — a repo-wide sweep found no logging of tokens, OTPs, or full credentials in the client. The four remaining client logs are benign (`saveAssessmentResults failed: <message>`, PWA install outcome, "App ready to work offline"), and `api.js:653` logs only a server HTML error body. Server-side recipient logging *was* fixed (M7). |

---

*Report generated 2026-09-23 as part of audit `SEC-AUDIT-2026-09-23`. The machine-readable record is
`server/utils/securityAudit.js`; this document is referenced from the admin Live Status Monitoring widget.*

---

## 9B. Addendum — Blockchain (Web3) Glitch Hunt (2026-09-24/25)

A focused, adversarial stress test of the entire `/api/web3` surface ran over two days (2026-09-24 to
2026-09-25). The probe (`server/glitch-hunt-web3.js`) deliberately tries to break, confuse, or cheat
every blockchain subsystem: wallets/DID, marketplace with smart-contract escrow, decentralized dispute
resolution, DAO governance, community knowledge base, achievement NFTs, staking/loyalty, supply-chain
journey anchoring, privacy storage, expert bookings, oracle feeds, and clinical-trial consent.

### Threat model

The probe assumes a live server and throws the entire glitch catalog at it:

| Class | Probes |
|---|---|
| **Auth boundary** | 401 on every protected endpoint; 3 public endpoints reachable without account |
| **IDOR** | 9 cross-account access attempts (storage, data shares, profile shares, supply events, escrow confirm, assessment rewards, recommendations) — all 4xx |
| **Malformed ids** | 15 endpoints with garbage ObjectIds — all 4xx, never 500 |
| **Public regressions** | Unknown/well-formed codes/tokens → 4xx, never 500 |
| **Maxlength overflows** | 6 fields pushed past schema limits (listing title 300, proposal title 300, knowledge title/body 300/5000, data-share recipient 500, supply productName 300) — all truncated or 4xx, no 500 |
| **Non-finite numerics** | 20 hostile values (raw `1e999`, `Infinity`, `NaN`, negatives, fractional qty `1.5`) — all rejected 400 |
| **Prototype-chain params** | `toString`, `constructor`, `__proto__` as DAO parameters — all rejected 400 |
| **DAO parameter bounds** | 7 out-of-range values (negative, null, 1e12, 0 voting days, 1e6 voting days) — all 400; vote on expired proposal → 400 |
| **Wallet-creation race** | 5 concurrent first-reads on a fresh account — single identity, balance 100 exactly once |
| **Check-in race** | 6 concurrent daily claims — exactly one minted, balance delta matches the single reward |
| **Escrow double-confirm** | 2 concurrent delivery confirmations — exactly one succeeds, seller paid +9.7 once (never +19.4) |
| **Loyalty double-spend** | 2 concurrent orders with the same code — exactly one discount applied, stock −1, buyer −10 once |
| **Zero-total order** | Full discount (code ≥ subtotal) → 201 with total 0, then confirm → released, no `BAD_AMOUNT` |
| **Stock race** | 6 concurrent orders vs stock 2 — exactly 2 succeed, stock 0, never negative |
| **Dispute lifecycle under concurrency** | Overlong reason (1500 chars) sliced; non-party blocked 403; confirm blocked while open 400; 2 juror votes + 2 lazy GETs concurrent — resolved exactly once, buyer refunded +12 once, juror paid |
| **Supply journey races** | 2 forward steps concurrent → both persist, no lost update, strictly forward; 2 duplicate steps concurrent → exactly one applied |
| **DAO vote race** | 3 concurrent votes on one proposal — all persist, voterCount = 4 (proposer + 3) |
| **Knowledge upvote race** | 4 concurrent upvotes — all persist, `upvotes = 4` |
| **NFT mint race** | 5 concurrent `achievements/check` — all 200, no E11000 crashes, kinds unique |
| **Booking double-cancel** | 2 concurrent cancels on one booking — idempotent, refund paid once (balance restored to 100, never 190) |
| **Oracle refresh** | 4 concurrent — all 200 |
| **Oversize privacy storage** | 901 KB pin → 4xx (never 500) |
| **Stress burst + integrity** | 30 parallel reads — all healthy; sweep confirms every listing `priceWell` finite; chain `/verify` valid |

### Root-cause defects fixed (B-series)

| ID | Defect | File | Fix |
|---|---|---|---|
| **B1** | `releaseEscrow` / `refundEscrow` / `tryResolve` had in-memory status guards only → double-settlement under concurrency | `server/routes/web3/market.js` | Atomic `updateOne({_id, status:'escrow'}, {$set:{status}})` claim before any transfer; rollback on payment failure; `refundEscrow` same pattern; `tryResolve` claim open→resolved before payout; targeted `$set` for `resolvedTx` so concurrent juror pushes aren't overwritten |
| **B2** | `confirm` route allowed release while a dispute was open → buyer could "confirm away" a contested order | `server/routes/web3/market.js` | `Dispute.exists({order})` check before release |
| **B3** | Dispute reason unbounded → ValidationError 500 on overlong string | `server/routes/web3/market.js` | `.slice(0, 1000)` after trim; 11000 duplicate-open catch → 400 |
| **B4** | Juror selection padded with arbitrary unstaked wallets (`others`) when staked pool < 3 → sybil juror manipulation, escrow deadlock | `server/routes/web3/market.js` | `selectJurors` = staked non-party wallets only (up to 5); empty → open jury (per rules.js docs) |
| **B5** | Loyalty code claimed by read-then-save → double-spend under concurrency | `server/routes/web3/market.js` | Atomic conditional `updateOne({_id, status:'unused'}, {$set:{status:'redeemed'}})` before stock reserve; revert on any failure |
| **B6** | Order qty parsed with `parseInt` → `1.5` truncated to 1, stock corrupted | `server/routes/web3/market.js` | Strict `Number.isInteger(qty)` on raw value; zero-total escrows zero, skips transfer |
| **B7** | Listing priceWell `Infinity` accepted (JSON `1e999` literal) → stored as `null`, sweep saw `null` | `server/routes/web3/market.js` | `Number.isFinite(priceWell)` guard |
| **B8** | Supply journey event append: read-validate-push-save → lost updates, out-of-sequence under race | `server/routes/web3/supply.js` | Optimistic size-guarded `$push` loop: re-load → re-validate forward-only against fresh last step → conditional push by `events: {$size}`; 409 after 5 retries |
| **B9** | Certifications: read-validate-push-save → lost updates | `server/routes/web3/supply.js` | Atomic `$push` + reload |
| **B10** | DAO `finalizeExpired`: setParam then status flip → two GETs could both execute the same param change | `server/routes/web3/govern.js` | Claim-first `updateOne({_id, status:'active'}, {$set:{status}})`; then setParam+anchor; per-proposal `try/catch` so one bad proposal can't abort the sweep |
| **B11** | DAO proposal creation: `param in DEFAULT_PARAMS` reads prototype; no null/empty/NaN/bounds on numeric params | `server/routes/web3/govern.js` | `hasOwnProperty` + `engine.assertParamValue()` (finite, ≥0, ≤1e9, votingDays 1–365); null/'' → 400 |
| **B12** | DAO vote: no endsAt check; push+save → lost updates | `server/routes/web3/govern.js` | EndsAt gate; atomic conditional `$push` on `{_id, status:'active', 'votes.user':{$ne}}`; reload for tally |
| **B13** | Knowledge post/upvote: title/body unbounded; upvote push+save → lost updates | `server/routes/web3/govern.js` | Title/body sliced (140/4000); upvote atomic `$push` + `$inc` + reload for `upvotes` |
| **B14** | Achievement NFT mint: concurrent `countDocuments` → serial collision → E11000 500 | `server/routes/web3/rewards.js` + `models/Web3.js` | Try/catch 11000 skip; unique index `{owner, kind}` on NFT schema |
| **B15** | Booking cancel: read-status-save → double refund under concurrency | `server/routes/web3/ecosystem.js` | Atomic `updateOne({_id, status:'confirmed'}, {$set:{status:'cancelled'}})` claim; rollback on refund failure; idempotent 200 for loser |
| **B16** | Oracle refresh `create` → 11000 on concurrent first refresh | `server/routes/web3/ecosystem.js` | 11000 catch → update existing |
| **B17** | Data share recipient unbounded → ValidationError 500 | `server/routes/web3/data.js` | `.slice(0, 120)` |
| **B18** | Supply batch productName/brand unbounded | `server/routes/web3/supply.js` | `.slice(0, 120)` / `.slice(0, 80)` |
| **B19** | Engine `credit/debit/transfer/stake/unstake/grantReward` accepted `Infinity` | `server/blockchain/engine.js` | `Number.isFinite(value)` on every amount |
| **B20** | Engine `setParam`: `param in DEFAULT_PARAMS` reads prototype; no bounds | `server/blockchain/engine.js` | `hasOwnProperty` + exported `assertParamValue` (finite, ≥0, ≤1e9, votingDays 1–365) |
| **B21** | Smoke suite juror determinism broken by leftover wallets | `server/test-web3-flows.js` | Precondition = staked non-system wallets === 0; C stakes before dispute; orphan purge in cleanup |

### Verification — all green after fixes

| Check | Result |
|---|---|
| `node glitch-hunt-web3.js` (live API) | ✅ **132 passed, 0 failed**, exit 0 |
| `node glitch-hunt.js` (original suite) | ✅ **120 passed, 0 failed** |
| `node test-session-flows.js` | ✅ **51/51** — sessions, revocation, races, saved logins |
| `node test-subscription-flows.js` | ✅ **29/29** — SSE pushes, tier gates, expiry |
| `node test-web3-flows.js` | ✅ **81/81** — all Web3 features including staked juror C |
| `npm run check` (server syntax) | ✅ exit 0 |
| `npm test` (server) | ✅ **68/68** |
| `npx eslint .` (client) | ✅ 0 errors (4 pre-existing warnings) |
| `npx vite build` | ✅ built, PWA worker generated |
| `npm test` (client entitlements) | ✅ **9/9** |
| `npm audit --omit=dev` | ✅ **0 vulnerabilities** — both scopes |
| `GET /api/health` | ✅ 200 (API left running on the fixed code) |

### Residual risk — Web3 layer

- **Knowledge-author payout cap micro-race** (B13 note): concurrent upvotes can each see `alreadyPaid < cap` and both grant; bounded by `upvotes` (max ~100 posts × ~100 upvotes) and documented — no automated fix without a heavier lock.
- **Stored markup in Web3 content** (knowledge posts, supply notes, dispute reasons) — React escapes on render; no server-side sanitization applied.
- **Juror pool composition** — staked-only is sound against deadlock, but an empty staked pool means *any* non-party may vote. If no non-party exists, escrow stalls. In practice the platform always has ≥1 wallet (the real user) and the smoke/probe suites stake C/HJ1/HJ2.
- **Chain anchor availability** — a failed anchor is logged and the DB mutation still commits. This is the intended availability-over-audit design.
- **Unique NFT index** — `{owner, kind}` unique index added; existing DB had no duplicates, so `db.SwNft.createIndex({owner:1,kind:1},{unique:true})` succeeded on restart.

---

*Report generated 2026-09-23 as part of audit `SEC-AUDIT-2026-09-23`. The machine-readable record is
`server/utils/securityAudit.js`; this document is referenced from the admin Live Status Monitoring widget.*
