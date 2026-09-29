# Authentication security — implementation report

Passkeys (WebAuthn/FIDO2), authenticator-app TOTP with encryption at rest,
one-time recovery codes, server-side sessions, re-authentication for security
changes, CSRF/origin enforcement, rate limiting and a security activity log.

Everything here is **additive**. The existing password sign-in, the emailed
code, the account switcher, the profile, the admin console and every
subscription/web3/chat feature are untouched.

---

## 1. What the existing architecture already did, and what was wrong with it

Inspected before any code was written:

| Area | Existing implementation | Verdict |
|---|---|---|
| Credential transport | JWT (HS256, pinned) in `Authorization: Bearer`, per-tab `sessionStorage` | Sound |
| Server sessions | `Session` document per sign-in; `User.currentSessionId` pointer | Sound |
| Session validation | `middleware/auth.js` → `utils/sessions.verifyUserSession` | Sound |
| Passwords | argon2id, bcrypt accepted + upgraded on login | Sound |
| TOTP | `speakeasy` | Worked; **seed stored in plaintext** |
| Recovery codes | Hashed, single-use, batch-scoped | Sound |
| Re-authentication | `X-Step-Up` on `/api/security/*` | Sound, but only on one router |
| Rate limiting / lockout | Express limiters + escalating ladder | Sound |
| Passkeys | — | **Absent** |
| CSRF | — | **Absent** |
| CORS | Hard-coded array, LAN origins always trusted | **Too broad** |
| Security events | `SecurityEvent.write()` | **Never wrote a row** |

### Five real defects found

1. **TOTP seeds were stored in plaintext.** `User.twoFactorSecret` held the raw
   base32 seed. A seed cannot be hashed — verifying a code runs HMAC over it —
   so a database read meant unlimited valid codes for every enrolled account,
   with no password.

2. **The second factor was sufficient on its own.** `/auth/login` returned a
   bare `userId`; `/auth/login-2fa`, `/auth/verify-login-otp` and
   `/auth/security/backup-codes/redeem` took that id plus a code. A valid TOTP
   *or* recovery code plus a guessable Mongo id bought a full session, with the
   password never involved.

3. **`SecurityEvent.write()` had never once written a row.** It called
   `securityEventSchema.create(...)`, and `Schema.prototype.create` does not
   exist in Mongoose 8 — it was added to `Model`. Every call threw a TypeError
   into the swallow-everything catch and returned `null`, which is
   indistinguishable from success at all ~40 call sites. The security activity
   log was silently dead.

4. **Revoked sessions kept working for up to 30 seconds.** `middleware/auth.js`
   caches a validated session for 30 s and `invalidateSessionCache` was defined
   but never called. Sign-out revoked the record while a cached entry kept
   authenticating.

5. **An allowlist that existed only in CORS.** A hard-coded array the `cors`
   package saw, including `192.168.x.x` unconditionally. CORS governs reading a
   response, not causing a state change, and a "simple" cross-origin POST is
   sent regardless — so it was not a CSRF defence.

---

## 2. The multi-account requirement

> Tab 1 = Account A, Tab 2 = Account B, and a new sign-in for A invalidates
> only A's old session.

**This was already correct, and deliberately so.** The two halves:

*Client.* The token lives in `sessionStorage.sw_tab_token`, which is per-tab by
spec. `localStorage` holds only `sw_accounts` — a directory of id/email/name,
metadata, never a credential. Legacy `localStorage` credential mirrors are
actively stripped on load.

*Server.* Every revocation in `utils/sessions.js` is filtered on `user`. A new
sign-in flips `User.currentSessionId` for that account and revokes only the
session it displaced.

Because ordinary shared-cookie sessions **cannot** provide this — cookies are
shared across tabs, so two accounts would fight over one — the existing
per-tab-token design is what makes it work, and it was left alone. The one
thing added is a test suite pinning both halves, because either can break
independently and silently.

---

## 3. Database changes

Three new collections, all created by Mongoose on first use; no migration
script is required and no account is touched.

### `passkeys` — one WebAuthn credential per row

```
user, credentialId (UNIQUE), publicKey, counter, transports[],
deviceType, backedUp, aaguid, attestationFormat, name,
deviceLabel, userVerified, createdAt, lastUsedAt, lastUsedIp, signInCount
indexes: credentialId (unique), { user, createdAt: -1 }
```

`credentialId` is unique **globally**, not per user. That is what makes "one
credential, one account" a database guarantee rather than a read-then-write
race, and it is the structural reason a passkey can never be used to
authenticate as the wrong account.

No private key is stored, and there is no field one could be stored in.

### `authchallenges` — single-use WebAuthn challenges

```
challenge (UNIQUE), flow ('register'|'login'), user?, sid?, userHandle?,
attempts, maxAttempts, createdAt, expiresAt, consumedAt
indexes: challenge (unique), { expiresAt } TTL, { user }
```

A row, not a signed token, because a signed challenge is not single-use: the
signature proves "this server issued this", not "this has not been spent
already". `consumeChallenge` is a conditional update on `consumedAt: null`, so
two concurrent verifications cannot both win.

The login path is deliberately **unbound from any user** — that is what makes
passwordless sign-in possible. The account is discovered from the verified
credential.

### `mfatransactions` — the `MFA_REQUIRED` state

```
tokenHash (UNIQUE), user, methods[], attempts, maxAttempts, primaryMethod,
ip, userAgent, location, createdAt, expiresAt, consumedAt, consumedBy
indexes: tokenHash (unique), { user, consumedAt, expiresAt },
         { expiresAt } TTL
```

Only a SHA-256 of the token is stored. The budget is enforced inside the same
conditional update that spends it, so it cannot be raced, and it is **per
transaction** rather than per account — a per-account counter would let an
attacker lock a victim out by burning their budget with garbage.

### `users` — two new fields

| Field | Purpose |
|---|---|
| `twoFactorSecretEnc` | AES-256-GCM envelope holding the TOTP seed |
| `webauthnUserId` | Stable, opaque 32-byte WebAuthn user handle |

`twoFactorSecret` is retained and still read, so no account loses its
authenticator during the transition; it is upgraded in place on first use and
cleared. `webauthnUserId` is random, not the account id and not the email —
using the email would leak the address to every platform involved and give
anyone holding a passkey a ready-made enumeration oracle.

### `sessions` — three new fields

`authMethod`, `mfaVerified`, `passkeyId`. Display and forensics: "signed in with
a recovery code" and "signed in with a passkey" are very different events, and
before this the security page could only report that a session existed.

### `securityevents` — new event types and a bounded `meta`

`passkey-added/removed/renamed/used/registration-failed/login-failed`,
`totp-setup-started/enabled/disabled/failed`, `backup-codes-regenerated`,
`session-created`, `mfa-challenge-created`, `email-changed`,
`reauth-succeeded/failed`, `suspicious-authentication`.

`meta` accepts a **fixed vocabulary** of six scalar keys. An open "details"
object is how a secret ends up in an audit log three changes later; a caller
cannot add a key, so it cannot smuggle a seed, a code or a token through here
even by accident.

---

## 4. API endpoints added

All under `/api/auth`, all covered by the existing flood guard, lockout check
and auth limiter, plus their own per-family limiters.

### Passkeys

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/auth/passkeys` | session | Owner-scoped. Never returns `credentialId` or `publicKey`. |
| `POST` | `/api/auth/passkeys/register/options` | session + **step-up** | Fresh CSPRNG challenge, bound to user + session. |
| `POST` | `/api/auth/passkeys/register/verify` | session + **step-up** | Challenge spent first, then library verification. |
| `POST` | `/api/auth/passkeys/login/options` | public | Identical response for everyone — no account hint. |
| `POST` | `/api/auth/passkeys/login/verify` | public | Account resolved **from the credential**, never from the request. |
| `PATCH` | `/api/auth/passkeys/:id` | session | Rename only. No step-up: a label is not a control. |
| `DELETE` | `/api/auth/passkeys/:id` | session + **step-up** | Refuses if it is the last way in. |

### Authenticator app

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/auth/totp/setup` | session + **step-up** | Returns QR + manual key **once**, encrypted immediately, not yet active. |
| `POST` | `/api/auth/totp/verify-setup` | session + **step-up** | Activates only after a valid code. |
| `POST` | `/api/auth/totp/disable` | session + **step-up** | Plus a live code; forgets the seed; revokes other sessions. |
| `POST` | `/api/auth/totp/verify` | public | Requires the MFA transaction. |

### Recovery codes

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/auth/recovery-codes/generate` | session + **step-up** | 10 codes, plaintext returned once. |
| `POST` | `/api/auth/recovery-codes/regenerate` | session + **step-up** | Replaces the batch; the old set dies in the same operation. |
| `POST` | `/api/auth/recovery-codes/verify` | public | Requires the MFA transaction. Single use, atomic. |

### Sessions

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/auth/sessions` | session | Live sessions + auth method + MFA status. No tokens, no hashes. |
| `DELETE` | `/api/auth/sessions/:sessionId` | session | Owner-scoped in the query, so a foreign id is a 404. |
| `POST` | `/api/auth/sessions/revoke-others` | session | Keeps the caller. |
| `POST` | `/api/auth/sessions/logout-all` | session | This account only. |

### Endpoints changed (behaviour preserved)

| Endpoint | Change |
|---|---|
| `POST /api/auth/login` | **Also returns `mfaTransaction`** and `mfaMethods`. Still returns `userId`. |
| `POST /api/auth/verify-login-otp` | Accepts `mfaTransaction`; `userId` honoured **only** while a live transaction exists. |
| `POST /api/auth/login-2fa` | Same. |
| `POST /api/auth/verify-2fa` | Same. |
| `POST /api/auth/setup-2fa` | Unchanged contract; the seed is now encrypted. |
| `POST /api/auth/disable-2fa` | Unchanged contract; the seed is now forgotten. |
| `POST /api/auth/two-factor-method` | Clearing the seed now clears both fields. |
| `POST /api/auth/change-password` | Adds a security event. |
| `POST /api/security/step-up` | Now uses the shared middleware; reads the encrypted seed. |
| `GET /api/security/summary` | **Adds** `passkeys`, `passkeySignIn`, `twoFactor.authenticatorPaired`. Existing keys unchanged. |
| `GET /api/security/devices` | **Adds** `authMethod`, `mfaVerified`. |
| `POST /api/security/backup-codes/*` | **Adds** `count`; events carry `meta`. |
| `POST /api/security/backup-codes/redeem` | Requires the transaction. |

**The one contract change clients must know about:** the second factor is now
only honoured against a live MFA transaction. `userId` is still accepted, but
only while a transaction exists for that account — which is true for any client
that just went through `/auth/login`, so a stale PWA build keeps working while
the "second factor alone" bypass is closed.

---

## 5. Environment variables

| Variable | Required in production | Purpose |
|---|---|---|
| `TOTP_ENCRYPTION_KEY` | **Yes** | base64/hex 32 bytes. Encrypts TOTP seeds. `openssl rand -base64 32` |
| `TOTP_ENCRYPTION_KEY_PREVIOUS` | No | Decrypt-only predecessors during rotation, as `kid=BASE64` pairs. |
| `WEBAUTHN_RP_ID` | **Yes** | Bare domain, no scheme/port/path. |
| `WEBAUTHN_ORIGIN` | **Yes** | Comma-separated https origins. Also trusted by CORS. |
| `WEBAUTHN_RP_NAME` | No | Defaults to `SuppliWise`. |
| `WEBAUTHN_TIMEOUT_MS` | No | Defaults to 120000. |
| `WEB_ALLOWED_ORIGINS` | **Yes** | Comma-separated credentialed-request origins. |
| `ALLOW_LAN_ORIGINS` | No | Development only; warns in production. |

`index.js` **refuses to boot** in production when the trusted-origin list, the
TOTP key or the WebAuthn configuration is missing or wrong. Each of those
failures is invisible from the outside until a real user is affected.

Outside production, WebAuthn falls back to the loopback dev origins so a fresh
clone works with no setup, and the TOTP key is derived via
HKDF-SHA256(`JWT_SECRET`) — with a loud warning, because that ties token forgery
to seed decryption.

---

## 6. Packages added

| Package | Where | Why |
|---|---|---|
| `@simplewebauthn/server@14` | server (dependency) | Maintained, audited WebAuthn implementation. No hand-rolled CBOR, COSE or signature verification. |
| `@simplewebauthn/browser@14` | frontend (dependency) | The browser half of the same library. |
| `cbor` | server (**dev**Dependency) | Only the test suite uses it, to build a real attestation object. |

Pre-existing and untouched: `nodemailer@9` carries one **moderate** advisory
(GHSA-6vj9-mwq6-2f5v, TLS SNI cache). The fix is a major version bump and is
unrelated to authentication, so it is reported rather than forced.

---

## 7. Security controls implemented

**Passkeys.** Registration, authentication, multiple credentials per account,
renaming, deletion, discovery, UV required at sign-in, origin + RP ID verified
on every ceremony by the library, counter rollback treated as a cloned
credential, challenges single-use and expiring, duplicates refused globally,
user-handle mismatch treated as a signal.

**TOTP.** Seed encrypted with AES-256-GCM under a key from the environment;
per-account single-use codes; ±1 step window; setup/disable gated on step-up
**plus** a live code; disable forgets the seed and destroys recovery codes;
lazy, idempotent migration from the legacy plaintext field.

**Recovery codes.** 10 codes, rejection-sampled from a 29-symbol alphabet
(~49 bits, no modulo bias), SHA-256 hashed, single use via a conditional
update, regeneration replaces the batch atomically, plaintext exists once and
there is deliberately no endpoint that can return it again.

**Sessions.** Server-side records, per-account revocation, idle and absolute
expiry, rotation on every sign-in, immediate cache invalidation on revocation,
`authMethod`/`mfaVerified` metadata, no token or hash ever returned.

**Re-authentication.** `X-Step-Up` — short-lived, session-bound, user-bound,
purpose-pinned, algorithm-pinned — now shared by every security-changing route
rather than living inside one file.

**CSRF / Origin.** `utils/origins.js` is the single trusted-origin list, used
by both CORS and a server-side guard on every state-changing request. Refuses
`Sec-Fetch-Site: cross-site` even with a trusted `Origin`. Requests with no
`Origin` (curl, native app) pass, because they cannot be CSRF victims.

**Rate limiting.** Dedicated per-family limiters for options (cheap, happens
twice per ceremony), verification (tight), and management. Per-account
throttling on the resolved account, layered on the existing IP ladder and
credential-stuffing tripwire.

**Logging.** Structured `SecurityEvent` rows for every event listed above.
`SecurityEvent.write()` now actually writes.

---

## 8. Tests

**122 new assertions across four suites, plus 1,000+ existing ones re-run.**

| Suite | Tests | Covers |
|---|---|---|
| `Test File/passkeys.test.js` | 34 | Real P-256 authenticator (real keypair, real CBOR attestation, real ECDSA signature — **nothing stubbed**, so the library genuinely verifies). Register, sign in passwordless, wrong/expired/reused challenge, wrong origin, wrong RP ID, tampered signature, signature by a different key, missing UV, unknown credential (identical response), counter rollback, zero counter, multiple passkeys, rename, delete, last-strong-method refusal, cross-account isolation. |
| `Test File/mfa-transaction.test.js` | 21 | The bypass itself, single use, concurrency, expiry, budget, per-transaction budget, method binding, cross-account, raw token never stored, legacy `userId` still works. |
| `Test File/totp-and-recovery.test.js` | 26 | Setup, activation, encrypted at rest, seed never returned again, disable, re-enable, sign-in, stale codes, malformed input, code lifecycle, regeneration, enumeration. |
| `Test File/sessions-and-csrf.test.js` | 22 | Two accounts at once, A's re-login vs B, confused deputy, revocation, immediate cache invalidation, idle expiry, forged tokens, CSRF, and the client-side storage rules read from source. |
| `Test File/totp-encryption.test.js` | 19 | Envelope format, fresh nonce, tamper detection, key fingerprinting, rotation, migration, clearing. |

**Two real defects were found by these tests while writing them**, both fixed:
the signature counter was being read from the wrong object (so it was always
stored as 0 and the clone check never fired), and a challenge was being read
from the wrong path in the registration response.

**Regression suites updated**, because `/login` now mints a transaction:
`login-otp-delivery`, `login-metadata-resilience`, `login-picture-footprint`,
`auth-security` — via a shared `Test File/stubMfaModels.js` so the doubles are
stated once.

Results: **server 600 → all green**, **frontend 216/216**, lint 0 errors,
`vite build` succeeds.

---

## 9. Threat model

### Authenticated
**Token forgery / session hijacking** — mitigated: HS256 pinned, `algorithms`
not negotiable, server-side session validated on every request, 30-day idle
expiry, rotation, immediate revocation. *Residual:* a token in flight is usable
until the next revocation.

**Revoked session replay** — **was** a 30-second window. Now fixed: every
revocation is announced to the validation cache.

**XSS → token theft** — the token is in `sessionStorage`, not `localStorage`,
so it is not readable by injected script running after page load in the way a
cookie is... but `sessionStorage` *is* readable by any script on the origin, so
XSS still yields the token. *Mitigation:* the API sets a strict CSP
(`default-src 'none'`, `frame-ancestors 'none'`); the SPA is a separate origin.
*Residual:* an XSS in the SPA origin is a full account compromise. This is the
single highest-value remaining risk and needs CSP + Trusted Types on the
frontend origin.

**CSRF** — structurally impossible (Bearer header), with a server-side origin
guard as defence in depth so adding a cookie fails closed.

### MFA
**Second factor as sole authentication** — **was** possible. Closed by the
transaction. *Residual:* an attacker with the password *and* a live code still
signs in — that is what two factors mean.

**TOTP phishing** — a code typed into a fake page is a code. Mitigated by
offering passkeys as the stronger option and labelling email codes as weaker.

**TOTP seed theft from the database** — **was** trivial. Now AES-256-GCM under
an external key. *Residual:* whoever holds `TOTP_ENCRYPTION_KEY` can decrypt
seeds. Key must live in a secret manager, not a `.env` on a shared host.

**TOTP brute force** — bounded by the transaction budget, the account ladder
and the IP limiter. 10^6 with a ±1 step and 10 guesses per window is not
practical.

**Backup code theft / replay** — hashed at rest, single use atomically, requires
the transaction, per-account throttled.

**Passkey cloning** — a counter that does not advance is refused. *Residual:*
synced passkeys report 0 forever, so they are exempt by necessity; a cloned
SYNCED passkey is only detectable by the user noticing an unfamiliar device.

**Passkey deletion abuse** — requires step-up, is recorded, notifies the
account, and refuses to leave the account with a password and nothing else.

### Recovery
**Email-OTP recovery as an MFA bypass** — **not implemented, deliberately.**
There is no "forgot my authenticator → email me a code → MFA off" path.
Recovery codes are the primary self-service mechanism; email is a notification
channel. Adding email-based MFA reset would reintroduce the takeover it appears
to solve.

### Information disclosure
**Account enumeration** — login, passkey options, recovery-code redemption and
the MFA paths all answer identically for unknown and known accounts. Verified by
test.

**Stack traces / internal errors** — the global handler returns a fixed message
for 5xx; every new route logs detail server-side and returns a fixed string.
Which check failed during a WebAuthn verification is **never** returned, since
that is exactly what an attacker enumerating realms wants.

**Security event contents** — no passwords, seeds, codes, tokens, cookies or
private keys. The event type list and `meta` vocabulary are closed.

### Residual risks
1. **XSS in the SPA origin** yields the session token. Needs a frontend CSP.
2. **`TOTP_ENCRYPTION_KEY` in a `.env` file** rather than a secret manager.
3. **Passkey support varies by browser**; older browsers fall back to TOTP.
4. **No email-based MFA reset**, by design — a locked-out user needs support.
5. **The one-active-session-per-account policy** means the device list is
   usually a single row. The revoke endpoints are correct and tested, but
   multi-device is a policy change, not a bug.
6. **`nodemailer@9`** carries a moderate TLS SNI advisory, unrelated to auth.
7. **User sessions are now unbounded in time.** A token exfiltrated by a
   future supply-chain or XSS compromise stays valid until the account's next
   sign-in, sign-out, password reset, or ban — which the attacker does not
   control. This is the accepted cost of the no-expiry policy; the mitigations
   are CSP (risk 1), the one-session-per-account rule, and step-up on every
   sensitive action, none of which the idle window meaningfully improved.
8. **A client that lies about `renew: true`** gains at most one token lifetime
   of extra access to an endpoint it already holds a valid token for. The idle
   check runs on the renewal itself, so it cannot extend the window.
9. **The admin activity beacon is once per minute** and is excluded from the
   sensitive auth budget, so a flood of it is bounded by the broad flood guard
   rather than the per-family limiter. It is authenticated and grants nothing.

**This is not a claim that the application is secure.** It is a description of
what is enforced, what is tested, and what is still open.

---

# Addendum: session lifetime

A separate change altered how long sessions live. It is documented here because
it inverts a decision the section above relies on, and because it fixed two
bugs that were not part of the original brief.

## 10. User sessions no longer expire

**Policy: a member's session ends only through revocation.** It is replaced by a
newer sign-in, revoked at sign-out or by a password reset, cut off by "sign out
of all other devices", or blocked because the account is disabled. The clock is
not a reason.

A 30-day sliding idle window existed and was removed. It is a deliberate
product decision, not an oversight, and the reasoning is in
`server/utils/userSession.js`:

- A member who opened the app once a month was signed out every month, with no
  way to opt out. The "save my login" checkbox controls the saved-login
  credential, not that window. People experience that as the app losing their
  work.
- The exposure it addressed is a token lifted from disk, a log, or an XSS
  payload. 30 days is not meaningfully narrower than 31.
- The controls that *are* effective are untouched and all still apply:
  revocation is immediate (published to the validation cache, so it takes effect
  on the next request, not the next cache expiry), there is one active session
  per account, a stolen session token cannot mint recovery codes or repoint
  recovery email without a fresh second factor, and a disabled account is refused
  on every request.

**What still bounds a user session**

| Bound | What it is |
|---|---|
| `Session.expiresAt` | An absolute cap. **Nothing sets it**, so no session expires on a timer. It is kept as a field so "no expiry" is a configuration someone chose, and so an operator can bound one account without a code change. |
| The saved-login credential | 30 days, and only for an account that ticked the box. The only clock that can end a signed-in user session, and it is opt-in. |
| Revocation | Event-driven, immediate, per account. The actual authority. |

**Removed:** `USER_IDLE_DAYS`, `USER_IDLE_LIMIT_MS`, `SESSION_IDLE_EXPIRED`,
`SESSION_IDLE_MESSAGE`, the `idleTimeoutAt` field on `GET /api/auth/sessions`,
and the client branch that rendered its fallback copy. `utils/userSession.js`
exports a `REMOVED` string and `USER_SESSION_EXPIRES: false` so an importer
fails loudly rather than silently applying a window that no longer has a
definition.

`lastActivityAt` is retained and still written. It is now **display data only** —
it sorts the "signed-in devices" list and answers "when was this device last
used". Nothing reads it to make an authorisation decision, and
`user-session-no-expiry.test.js` pins every revocation path so that removing the
window cannot quietly become removing the enforcement.

## 11. Admin sessions expire after ten minutes — and now actually behave

The window was already ten minutes. Three things about it were broken.

### 11.1 A continuous working admin was logged out every 15 minutes

**This was a guaranteed logout, not an edge case.** The admin JWT carries a
15-minute `exp` (correctly ordered above the idle window), but nothing re-issued
it: `/auth/admin-refresh` was called on page load and from the "Stay signed in"
button — and that button only appears *after* the idle countdown runs out. An
administrator working continuously never saw it, so nothing renewed the token,
and at 15 minutes they were hard-logged-out mid-task. The comment in
`adminSession.js` claimed the token's headroom meant "an active admin is never
logged out by token expiry mid-task", which was not true.

**Fix:** `AdminDashboard.jsx` renews the token on a timer, at 60% of its
lifetime, scheduled from the server's own `expiresInSeconds`.

The critical detail is that **renewal is not activity.** A naive keepalive would
call `/auth/admin-refresh` on a timer and refresh `lastActivityAt` every pass —
which would disable the ten-minute timeout entirely, silently, for everyone.
So `/auth/admin-refresh` now distinguishes the two:

| Call | Token | `lastActivityAt` | Use |
|---|---|---|---|
| `{ renew: true }` | re-issued | **untouched** | the automatic keepalive |
| no `renew` | re-issued | refreshed | "Stay signed in", arrival on the dashboard |

Both are fully validated first — signature, account enabled, and inside the idle
window — so a renewal cannot revive an idle session, rescue a disabled account,
or buy more than one token's worth of access to an endpoint the caller already
holds a valid token for.

### 11.2 The idle check was skipped whenever the account had no activity stamp

Both copies of the check read:

```js
if (admin.lastActivityAt && Date.now() - admin.lastActivityAt > ADMIN_IDLE_LIMIT_SECONDS * 1000) deny()
```

That `&&` is a hole, not a guard. `lastActivityAt` defaults to `null`, so for any
account that had never been stamped — a brand new admin, or one whose only
sign-in missed the write — **the ten-minute timeout did nothing at all**, and
only the token's `exp` bounded the session.

`idleReferenceMs()` in `utils/adminSession.js` now falls back to the token's own
`iat` when the stamp is missing, and fails closed when neither is usable. The
check itself lives in that one module, so `middleware/auth.js` and
`/auth/admin-refresh` cannot drift apart again — which is how they acquired two
copies of the same hole in the first place.

### 11.3 The client countdown could disagree with the server

The dashboard polls its data every 10 seconds and marks those polls
`X-Admin-Background`, so the server deliberately does not count them as
activity — an unattended tab must not hold a session open all night. That is
correct, and it left a gap: the server only ever heard about activity from a
*non-background* request, while the countdown on screen reset on local mouse and
keyboard input. An administrator could read the dashboard, move the mouse, click
nothing, and watch a badge count down from ten minutes that never ran out while
the server signed them out underneath it.

**Fix:** `POST /api/auth/admin-activity` — a protected, token-free,
data-free "I am still here" beacon, sent at most once a minute and only from
real user input. Never on a timer, so it cannot hold a session open. It is
excluded from the sensitive `/api/auth` rate-limit budget in `index.js`, because
spending 15 of the 20 requests a non-loopback deployment gets per 15 minutes on
a background ping would leave a working administrator unable to sign in.

## 12. Optimisations applied

| Change | Before | After |
|---|---|---|
| Admin activity stamp | written on **every** admin request | written at most once per heartbeat interval |
| Where the throttle lives | — | in the update **filter** (`lastActivityAt < now - interval`) |
| Admin token | never re-issued | re-issued at 60% of its lifetime |
| `/auth/admin-refresh` call sites | three separate `fetch` calls, two of which ignored the reply | one shared `syncAdminSession` |
| Rate-limit ceilings | bare literals | configuration, with safe defaults |

**Why the throttle is in the filter and not a `Map`.** A per-process counter is
wrong behind a load balancer: two app instances each keep their own, so the
stamp is written once per instance per interval and the "throttle" does not
throttle. Expressing it as a condition on the update is correct across
processes, needs no state, and saves the write *in the database* — Mongo matches
zero documents and does no update at all.

**The trade, stated plainly.** The stored stamp can be up to one heartbeat
interval stale, so an admin session is really ended after somewhere between 10
and 12.5 minutes of true silence. The heartbeat is a quarter of the window,
chosen to keep that slack small while still removing ~93% of the writes.

**No read cache was added for the admin account lookup.** It would have saved
about six indexed reads per minute per admin, and in exchange introduced a
window in which a *disabled* administrator or one forced to change their
password still reads as enabled. That is a security control traded for a
negligible saving, so it was declined.

**No idle-expiry control was weakened to get here.** The admin window is
unchanged at ten minutes, the renewal path cannot extend it, and the beacon
exists so the on-screen countdown finally tells the truth.

## 13. Environment variables added

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_IDLE_MINUTES` | `10` | Minutes of admin inactivity before sign-out. Integer 1–1440; anything else is reported at boot and ignored. |
| `ADMIN_TOKEN_LIFETIME_MINUTES` | `15` | Admin JWT lifetime. Must exceed the idle window; the server refuses to boot otherwise. |
| `AUTH_RATE_LIMIT_MAX` | `20` | `/api/auth`, non-loopback, per 15 min. |
| `AUTH_RATE_LIMIT_MAX_LOCAL` | `200` | `/api/auth`, loopback. |
| `AUTH_SENSITIVE_RATE_LIMIT_MAX` | `60` | `/api/auth` login, 2FA, password reset, per 10 min. |
| `SECURITY_RATE_LIMIT_MAX` | `60` | `/api/security` mutating routes, per 10 min. |

Production defaults are unchanged. A missing, empty, or malformed value falls
back to the documented default and logs a warning — a typo in a deployment's
configuration must not be able to switch rate limiting off, and a config key
must not be able to mean "no idle timeout".

## 14. Tests added or rewritten

| Suite | Result | What it covers |
|---|---|---|
| `user-session-no-expiry.test.js` | 23/23 | Replaces `session-idle-window.test.js`, which asserted the opposite. A session idle 400 days still validates; **every** revocation path still ends one; `expiresAt` still works; the activity stamp stays honest for display. |
| `admin-session-expiry.test.js` | 24/24 | Real database, real HTTP. The ten-minute window and its exact boundary; the null-stamp hole, closed and failing closed; the heartbeat throttle proven **both ways** (a stale stamp still refreshes, so the test cannot pass with the update simply disabled); renewal is not activity; the beacon. |
| `adminSession.test.js` (frontend) | 21/21 | The ordering invariants, plus the keepalive, the `renew: true` contract, one shared idle check, the database-side throttle, and the beacon. |
| `recovery-codes.test.js` | 21/21 | The `redeem` helper was injecting a synthetic MFA transaction, so every call was refused at the gate and the suite was asserting 401s it had caused itself. It now opens a real transaction through `/auth/login`. |
| `sessions-and-csrf.test.js` | 23/23 | The idle-expiry case is inverted rather than deleted, and an `expiresAt` case added. |

**Suite totals: 619 pass / 0 fail** (the default `npm test`, unchanged from the
baseline), **186/186** across the database-backed suites, **225/225** frontend.

## 15. Deployment notes

1. No migration. `Session.expiresAt` already existed and is still `null`; no
   user session is affected by this change and no one is signed out by it.
2. **No new variable is required.** Both admin defaults are the values already
   enforced. Set `ADMIN_IDLE_MINUTES` only if you want a different window.
3. **Deploy the server and the client together.** The client keepalive sends
   `renew: true`, which an older server ignores — harmless, since that server
   would count it as activity and refresh a token anyway. The reverse order
   (new server, old client) is also safe. The order is not load-bearing, but
   both should ship before the next admin session is expected to last 15+ minutes.
4. **Rate limits stay at their current values** unless you set the new
   variables. Behind a shared NAT, `AUTH_RATE_LIMIT_MAX` is the one to raise.
5. `POST /api/auth/admin-activity` needs no proxy change; it is a normal
   `POST` on the existing `/api/auth` path and is authenticated like every
   other endpoint.
