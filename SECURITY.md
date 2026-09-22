# SuppliWise — Security Test Report

Date: 2026-09-21 · Environment: local dev (Atlas DB) · Method: live black-box
tests against `http://localhost:5000` + code audit. Result: **33/33 checks pass**.

## Session 2 — 2026-09-22: database + HTTP-layer hardening (23/23 + 13/13 live checks pass)

Re-ran the same method after the patches below. Throwaway pentest scripts
(`pentest-db.cjs`, `verify-layers.cjs`) were removed after passing; the
patterns are preserved here so they can be re-created in minutes.

### DB pentest results (all passing, throwaway user + signed JWTs, self-cleaned)

| # | Test | Result |
|---|------|--------|
| 1 | NoSQL login bypass (`{"email":{"$gt":""},"password":{"$gt":""}}`) → 400, no token | PASS |
| 2 | Login `$ne` password → 400/401 | PASS |
| 3–8 | Unauthenticated `/notifications`, `/dashboard/*`, `/admin/*`, `/assessment/user/:id` → 401 | PASS |
| 9 | Seeded-record `$ne` delete attempt → 404, record intact (was: matched + deleted) | PASS |
| 10–11 | Operator `_id`/`assessmentId` objects → 400 (was: CastError 500) | PASS |
| 12–15 | `scrubKeys` strips `$` keys, dotted keys, keeps data, still blocks `__proto__` | PASS |
| 16 | `/auth/me` leaks no `password`/`twoFactorSecret` | PASS |
| 17–18 | Admin `notifications/read` garbage/empty `$in` → 400 | PASS |
| 19–20 | Garbage admin assessment IDs → 400 (was: 500) | PASS |
| 21 | Search operator `?search[$gt]=` → 200, escaped | PASS |
| 22 | `/admin/users` leaks no secrets | PASS |
| 23 | User JWT on admin assessment route → 403 | PASS |

### HTTP-layer results (all passing)

| # | Test | Result |
|---|------|--------|
| 1 | Health 200 | PASS |
| 2 | `X-Powered-By` removed | PASS |
| 3–5 | Helmet `X-DNS-Prefetch-Control`, `X-Frame-Options`, `X-Content-Type-Options` | PASS |
| 6–7 | Strict CSP `default-src 'none'` + `frame-ancestors 'none'` | PASS |
| 8 | API `Cache-Control: no-store` | PASS |
| 9 | CORS allows `localhost:5173`, rejects `evil.example.com` | PASS |
| 10–11 | 401/400 bodies are JSON with no stack/DB internals | PASS |
| 12 | Rate-limit headers live on `/auth` (health intentionally unlimited) | PASS |

`npm audit`: **0 vulnerabilities** in `server/` and `my-react-app/`.
`npm test`: 1/1 pass. Frontend `eslint`: 0 errors. `npm run build`: passes.

## How to re-run

```powershell
cd server
node test-pentest.js   # throwaway users/admins; self-cleaning (see transcript below)
npm test               # unit: login never leaks OTPs in JSON
```

## Penetration / functional test results (all passing)

| # | Test | Result |
|---|------|--------|
| 1 | No token on protected route → 401 | PASS |
| 2 | No token on admin route → 401 | PASS |
| 3 | User JWT on admin route → 403 | PASS |
| 4 | Admin JWT on user route → 403 | PASS |
| 5 | Forged JWT (`invalid.token.here`) → 401 | PASS |
| 6 | Expired JWT → 401 | PASS |
| 7 | Cross-user isolation (user2 reads user1 admin results) → 403 | PASS |
| 8 | NoSQL injection login (`{"email":{"$gt":""}}`) → 400 | PASS (was 500, patched) |
| 9 | Malformed `dayKey` → 400 | PASS |
| 10 | Future `dayKey` → 400 | PASS |
| 11 | Small AI-results PATCH → 200 | PASS |
| 12 | 600 KB AI-results PATCH → 413 | PASS |
| 13 | 11 MB JSON body → 413 | PASS |
| 14 | XSS payload (`<script>`) stored, no crash; React escapes on render | PASS |
| 15 | Malformed ObjectId on priority route → handled 500 + JSON (no crash/leak) | PASS |
| 16 | OTP brute force (6 wrong codes) → 429 lockout after 5 | PASS |
| 17 | Regex-DoS search (`.*.*…`) → 200, metacharacters escaped | PASS |
| 18 | Helmet `X-Content-Type-Options: nosniff` | PASS |
| 19 | Helmet `X-Frame-Options` | PASS |
| 20 | API `Cache-Control: no-store` | PASS |
| 21–27 | Feature endpoints (dashboard, insights, history, notifications, `/me` without leaks, day records, priority-status) → 200 | PASS |
| 28–32 | Admin endpoints (users, overview, notifications, monitor incl. `?fresh=1` bypass) → 200 | PASS |
| 33 | Full severity lifecycle (flag → block → lift → expire → reflag) | PASS |

## Latency (bottleneck run, Atlas ≈ 0.5 s RTT)

| Endpoint | Time | Notes |
|----------|------|-------|
| User login step 1 | ~790 ms | was 3–10 s (blocked on SMTP); now background send |
| Admin login (password + 2FA) | ~870 ms total | parity with user login |
| Dashboard | ~375 ms | parallelized + lean |
| Insights | ~200 ms | parallelized + lean |
| History (10 incl. AI blobs) | ~140 ms | lean |
| Notifications | ~180–215 ms | backfill capped at 10 |
| `/auth/me` | ~130–160 ms | no image blobs |
| Admin users (100) | ~660–870 ms | lean rows + grouped counts (was tens of seconds via `$lookup` of full AI docs) |
| Security monitor | ~290–430 ms | per-probe 10 s cap; password probe fixed 30.4 s → 0.24 s via `select('password')` |

## Vulnerabilities found and patched

| ID | Severity | Finding | Patch |
|----|----------|---------|-------|
| V-01 | Medium | **NoSQL-injection 500**: object-typed `email`/`password`/`otp` crashed `.trim()` → HTTP 500 + stack log. No bypass, but unhandled-type crash + log noise. | `server/routes/auth.js`: `str()` coercion helper applied to all 17 entry-point trims + `typeof` guards on login/register passwords → clean 400. Verified live (400, no bypass). |
| V-02 | Medium | **Unlimited OTP guessing**: 6-digit email codes had no attempt limit within the 10-min window. | `MAX_OTP_ATTEMPTS = 5` per stored code across login / password-reset / email-change verify routes → 429 + code invalidation. Verified live. |
| V-03 | Medium | **Admin search ReDoS**: raw user input interpolated into 3× `$regex`. | Escaped metacharacters + 64-char cap (`server/routes/admin.js`). Verified live with `.*.*…` payload. |
| V-04 | Medium | **Unbounded AI-results write** (up to 10 MB JSON limit) into a Mixed field → DB bloat/DoS. | 500 KB cap → 413 (`PATCH /:id/results`). Verified live. |
| V-05 | Medium | **Oversized base64 images** in profile updates (near-16 MB docs, slow saves). | 2 MB profile / 3 MB banner caps → 413. |
| V-06 | Low | **Public AI endpoints unmetered** (chat/polish/supplement-detail) → quota burn; chat had "no rate limit" comment. | `aiLimiter` (60/10 min prod) + `apiLimiter`; input caps (chat 1000, history 500/msg, polish 1000). |
| V-07 | Low | **Auth-limiter login bypass** in non-production (`skip` on `/login`). | Removed; brute-force test passes against active limiter. |
| V-08 | Low | **Uncaught async rejections** in 4 admin handlers (Express 4 → process crash risk). | try/catch added (`/profile`, `/profile/password`, `/authenticator/rotate`, `/notifications`). |
| V-09 | Low | **Email regex rejected valid long TLDs** (`{2,6}`) on client, server, and User model. | `{2,}` everywhere; typo-squatting list retained. |
| V-10 | Info | **Monitor probe hung 30.4 s** (full 2.9 MB user doc incl. base64 pictures for one hash check). | `select('password')` + `lean()` → 241 ms; per-probe 10 s timeout wrapper; `?fresh=1` bypass so Sync-Now is real. |
| V-11 | Info | **Service worker cached all `/api` GETs 5 min** → stale dashboard/intake ("not functioning"). | `/api` runtime caching removed from `vite.config.js`. |
| V-12 | Info | **Every auth request loaded MBs of base64 pictures** via `protect`. | `select('-password -profilePicture -bannerPicture').lean()` in `middleware/auth.js`. |
| V-13 | Low | **False-positive production-safeguard warning**: check required `NODE_ENV=production`, flagging healthy dev setups; referenced flag did nothing in code. | Check now verifies the live control (flag off → Secure); production boot hard-fails if the flag is ever `"true"` (`server/index.js`). |
| V-14 | High | **Vulnerable dependencies**: `body-parser` (DoS via limit bypass), `mongoose` 8.0–8.24 (prototype pollution via `__proto__` dotted paths), `nodemailer` (4 advisories incl. recipient-domain bypass), `qs`, `@xmldom/xmldom` (12 injection/ReDoS advisories). | `npm audit fix` both workspaces → **0 vulnerabilities**. Mongoose advisory fixed by upgrade; defense-in-depth `scrubKeys()` strips `__proto__`/`constructor`/`prototype` from AI-results blobs before persist (`PATCH /:id/results`). |
| V-15 | Medium | **TOTP replay**: authenticator codes accepted repeatedly inside the ±30 s window (user + admin). | `utils/totp.js` `verifyTotpOnce()` — one-time-use cache (SHA-256 of secret+code+step, 90 s TTL); applied to all 6 verify sites. |
| V-16 | Medium | **Single global auth limiter** — login, OTP verify, and admin login shared one budget with no per-step throttling. | `sensitiveLimiter` (60/10 min) on admin-login, both 2FA verifies, and all OTP/email-code verify routes, layered over the existing limiter. |
| V-17 | Low | **Stored markup**: free-text fields kept HTML tags into DB/admin views/PDFs/AI prompts. | `stripTags()` in `sanitizeTextField`/`sanitizeShortField`/`preprocessUserInput` (verified: `<script>`/`<b>` stripped, clinical mapping intact). |
| V-18 | Low | **NoSQL type-crash 500s**: object-typed `email`/`password`/`otp` crashed `.trim()` (live log: `email.trim is not a function`). | `str()` coercion at all 17 auth entry points + `typeof` guards → clean 400s. Re-tested live: 400, no bypass. |
| V-19 | Medium | **Prompt injection into AI assessment prompts**: user free-text interpolated into one big instruction message. | `promptSafe()` neutralizer (delimiter-breakers + override phrases stripped) on all interpolated fields; patient block wrapped in `<patient_data>` with ignore-instructions guard (rule 16). |
| V-20 | Low | **PII to third-party AI**: verified clean, locked with a tripwire. | Prompt builder carries only age/gender/health; live probe scans `recommend.js` for identity-field interpolation every monitor run. |
| V-21 | Medium | **Flat rate limits, no account lockout**: a single 15-min window repeated forever; credential-stuffing an account had no per-account consequence. | Escalating lockout (`utils/lockout.js`): every 429 climbs IP ladder **15 min → 1 h → 6 h → 24 h** with `Retry-After`; failed logins/admin-logins/OTP failures climb a per-account ladder; success clears it. Live `Rate-Limit Lockouts` probe shows ladder + current holds. |

## Attack coverage in the Security Center monitor (24 live probes)

System probes: Login, Account Creation, Email OTP, TOTP, Database, OpenRouter,
Delete Account, Sanitization, Hashing, Salting.
Attack probes: XSS Stored, NoSQL Injection, Path Traversal, Prototype
Pollution, Auth Brute Force + Replay, CSRF Stateless, **Prompt Injection (AI),
PII in AI Prompts, AI Quota Abuse, JWT Strength & Lifetime, Security Headers
(Live), Email Enumeration, Sensitive Data Exposure**. AI probes are
behavioral (neutralizer self-test, source tripwire, rate-limit headers over
HTTP, token decode, header assertion, enumeration check, projection check).

## Vulnerabilities found and patched (session 2 — 2026-09-22)

| ID | Severity | Finding | Patch |
|----|----------|---------|-------|
| V-22 | High | **Operator injection in supplement filters** (`dashboard.js` add/remove-supplement): raw `name`/`supplementName` reached Mongoose equality filters — `{"$ne":"x"}` matched and could delete the wrong intake record. Proved live with a seeded record. | `str()` coercion + 200-char cap (`cleanSupplementName`) on both routes; objects neutralize to `"[object Object]"` literals that match nothing. Verified live (404 + record intact). |
| V-23 | Medium | **Unvalidated `$in` array** (`POST /admin/notifications/read`): `notificationIds` flowed raw into `{_id:{$in}}`. | Bounded array (1–100) + every element must pass `isValidObjectId` → 400. Verified live. |
| V-24 | Low | **CastError 500s on garbage IDs**: operator objects/strings in `_id` filters (`dashboard.js` intake/reset, `assessment.js` admin `:userId`/`:assessmentId`) crashed to HTTP 500. | `isValidObjectId` guards → clean 400s. Verified live (no 500s). |
| V-25 | Low | **`$`/dotted keys persisted into Mixed blobs**: `scrubKeys()` stripped only proto keys; dotted keys crash Mongo writes, `$` keys store junk. | `scrubKeys()` now also strips `$`-leading and dotted keys (attack-probe proto test still passes). Verified live. |
| V-26 | Info | **CSP disabled** (`helmet({contentSecurityPolicy:false})`). | Strict `default-src 'none'` + `frame-ancestors 'none'` (safe: API serves JSON only, never HTML). Verified live in response headers. |
| V-27 | Info | **Bare `mongoose.connect()`**: no pool bounds, boot hung forever on unreachable hosts, no guard on missing `MONGO_URI`. | `maxPoolSize:10`, 10 s server-selection + 30 s socket timeouts, refuse-to-boot without `MONGO_URI`, no credentials in logs. |
| V-28 | Info | **bcrypt-only password storage** (GPU-crackable cost 12, 72-byte truncation). | argon2id migration (`server/utils/password.js`, OWASP profile 19 MiB/2 iter): all new passwords argon2id; bcrypt still verifies (zero downtime) + transparent upgrade on next login; pre-save skips finished hashes (no double-hash). 17/17 live checks pass. |

## Residual / accepted risks (updated 2026-09-22)

- Admin `notificationIds` array is now strictly validated (V-23) — the old
  Mongoose-cast note above no longer applies.
- **Rate-limit volume test** (600 req burst) not executed live; limits use standard `express-rate-limit` v7 config, OTP layer tested directly.
- **File upload**: images are base64-in-JSON with byte caps, not multipart; no executable upload path exists.
- **Secrets**: `.env` is git-ignored (`server/.env`); `JWT_SECRET` hard-fails boot when default; transporter password whitespace-tolerant for Gmail app passwords.
- **PII in logs**: login emails appear in server logs; acceptable for self-hosted dev, rotate before sharing logs.
- **Legacy bcrypt hashes** remain until each account's next login (transparent upgrade); `ADMIN_ACCOUNTS` bcrypt entries keep working and upgrade on next admin sign-in.
- **HSTS** is set by Helmet but only effective over HTTPS; local dev is HTTP.
- **CORS** allows LAN origins (`192.168.*` regex, `capacitor://`) for mobile testing — tighten to exact domains in production.
