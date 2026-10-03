# SuppliWise Developer Guide — Session Architecture

This document describes how multi-account sessions work end to end: the
server-side session store (`server/`), the browser session layer
(`my-react-app/src/api.js`), the route guards, and the exact commands used to
verify the system. Every statement below matches the code as it exists in
this repository.

Audience: developers changing auth, sessions, route guards, the Accounts
panel, or anything that reads/writes credentials.

---

## 1. Scope and guarantees

The system implements the session rules below. The first six are exercised as
acceptance tests by `server/test-session-flows.js`.

1. **Multiple accounts active simultaneously.** Different accounts are
   signed in at the same time in different tabs; they never invalidate each
   other (Tab 1 = A, Tab 2 = B, Tab 3 = C — all active).
2. **Exactly one active session per account.** A re-login — any tab,
   browser, or device — immediately invalidates that account's previous
   session. The old tab receives `401` + `SESSION_REVOKED` on its next API
   request. ("Newest login wins", race-safe under concurrent logins.)
3. **Invalidation is strictly per-account**, never global: signing out or
   replacing Account A can never touch Account B.
4. **Auth flow:** validate the JWT → identify the account → verify the
   session exists, is owned by that account, is its *current* session, and is
   unrevoked. Rejections carry a machine-readable `code`.
5. **Logout revokes only that account's session.** No shared/global auth
   cookie exists; the credential is an `Authorization: Bearer` header. No
   access token is ever stored in `localStorage`.
6. **Server-side session records are authoritative.** A signed JWT alone is
   never enough; every protected endpoint re-validates the session and never
   trusts client-supplied user IDs.
7. **No expiry for regular users** — no idle timeout, no `exp`. Sessions end
   only by sign-out or replacement. The admin session keeps its own sliding
   TTL + 3½-minute idle kill, untouched by this system.
8. **Existing behavior preserved:** RBAC (admin-only routes), subscription
   gating, admin refresh (`POST /api/auth/admin-refresh`), lockouts/rate
   limits.
9. **The frontend handles 401/session-expired gracefully** — one-shot notice,
   clean redirect, no `/login ↔ /dashboard` loops.

## 2. Architecture at a glance

```
Browser tabs (ONE ACCOUNT PER TAB)
  sessionStorage  sw_tab_account / sw_tab_token / sw_tab_user   ← this tab's JWT
  localStorage    sw_accounts    (metadata directory, no credentials)
                  sw_remember    (opt-in saved-login credentials)
                  sw_dead_tokens (fingerprints of provably dead JWTs)
        │  BroadcastChannel 'suppliwise:auth' (resume / session /
        │  session-dead / sign-out) + window event 'suppliwise:auth-changed'
        ▼
React app — src/api.js (session layer), App.jsx (guards), LogIn.jsx,
            AccountSwitcher (Profile → Accounts), Navbar
        │  fetch with Authorization: Bearer <JWT>
        ▼
Express — /api/auth/* (server/index.js mounts lockoutCheck + authLimiter)
        ▼
protect (server/middleware/auth.js)
        │  signature (pinned HS256) → verifyUserSession (server/utils/sessions.js)
        ▼
MongoDB — Session documents (source of truth) + User.currentSessionId pointer
```

## 3. Backend

### 3.1 Tokens

| | User token | Admin token |
|---|---|---|
| Minted by | `signUserToken(userId, sessionId)` in `utils/sessions.js` | separate admin flow (`routes/auth.js /admin-login`) |
| Claims | `{ sub, id, sid, iat }` (`sub` = `id` = account id, `sid` = session id) | includes `role: 'admin'`, `exp` |
| `exp` | **none** — validity is revocation-based, not time-based | yes — sliding TTL |
| Idle kill | none | 3 min 30 s (`ADMIN_IDLE_TIMEOUT_MS`, refreshed by the `x-admin-background` heartbeat) |
| Storage | `sessionStorage` key `sw_tab_token` (per tab) | `localStorage` key `adminToken` (deliberate, separate flow) |
| Algorithm | HS256, pinned in `jwt.verify(..., { algorithms: ['HS256'] })` | same |

Frontend decoders mirror this: `isTokenExpired()` returns `false` for any
payload without `exp` (users never expire client-side), and the app
distinguishes an admin JWT by its `role === 'admin'` payload
(`isAdminJwt()` in `App.jsx`).

### 3.2 The Session record — `server/models/Session.js`

| Field | Meaning |
|---|---|
| `_id` | **IS the session id** — embedded in the JWT as `sid` |
| `user` | ObjectId of the owning account (indexed) |
| `tokenHash` | sha256 of the JWT minted for this session — **audit trail only**; validity never depends on string-comparing tokens |
| `rememberHash` | sha256 of the opt-in “save my login” credential (`''` unless remembered; indexed) — see §3.6 |
| `createdAt` | sign-in time; index `{ user: 1, createdAt: -1 }` for “sessions of this account, newest first” |
| `lastActivityAt` | informational stamp, written at most once per 5 min (`TOUCH_INTERVAL_MS` in `middleware/auth.js`); **never** used to expire anything |
| `expiresAt` | always `null` for users — no self-expiry |
| `revokedAt` | set when displaced by a newer sign-in or revoked at sign-out |

Companion pointer on the account — `server/models/User.js`:

- `currentSessionId` (select `false` by default): the account's one active
  session.
- `sessionVersion`: incremented atomically on every sign-in (diagnostic
  counter).

Revoked records older than **30 days** (`REVOKED_RETENTION_MS`) are pruned
opportunistically on the next sign-in — pruning only ever touches *revoked*
rows, never the live one.

### 3.3 Starting a session — `issueUserSession(userId)`

Ordering is chosen so that **no interleaving of two concurrent sign-ins can
leave the account with two live sessions or zero live sessions**:

1. **Snapshot** the current `User.currentSessionId` (to know precisely what
   we displace).
2. **Create** the Session record (not active yet — nothing points at it).
3. **Atomically flip** `User.currentSessionId` to the new sid with an
   aggregation-pipeline `updateOne` (`$set` + `$inc sessionVersion`).
   Last writer wins ⇒ **newest login wins**. If the account disappeared
   mid-sign-in (`matchedCount === 0`), the just-created session is deleted
   and an error is thrown — a token is never handed out without an owner.
4. **Revoke the displaced session** — the one seen in step 1, never a
   concurrent login's: a pointer read in step 1 can no longer become the
   final pointer, because any later flip commits after ours.

The function returns the fresh JWT (carrying `sid`).

### 3.4 Validating a session — `verifyUserSession(decoded)`

Runs in this exact order (the “gauntlet”):

1. no `sid` claim (legacy/pre-session token) → `401 SESSION_INVALID`
2. `sub`/`id` disagree (a token confused between accounts) → `401 SESSION_INVALID`
3. `sid` not a valid ObjectId → `401 SESSION_INVALID`
4. parallel fetch: the User (with `+currentSessionId`) and the Session
5. user not found → `401 SESSION_INVALID`
6. session missing **or** owned by another account → `401 SESSION_REVOKED`
7. `revokedAt` set → `401 SESSION_REVOKED`
8. `user.currentSessionId !== sid` (a newer sign-in replaced it) → lazily
   stamps `revokedAt` (safe: the pointer never returns to an older id) →
   `401 SESSION_REVOKED`
9. `accountStatus !== 'active'` → `403 ACCOUNT_DISABLED` (banned vs. no
   longer active)
10. otherwise `{ ok: true, user, sid }`

**It throws nothing.** Database failures propagate to the caller, which
answers **503** — *a database outage must never log users out*, and the
frontend keeps credentials on any non-401/403 response.

### 3.5 The `protect` middleware — `server/middleware/auth.js`

Mounted on protected routes; sequence:

1. **Header-only credential:** `Authorization: Bearer <jwt>`. Query-string
   tokens are rejected (URLs leak into logs/history/Referer). The single
   exception is the subscription SSE stream, whose `streamTokenAuth` copies
   `?token=` into the header *on its own route* before `protect` runs.
   Missing header → `401 { code: NO_SESSION }`.
2. **Signature:** `jwt.verify` pinned to `HS256`. `TokenExpiredError` (only
   possible for admin tokens) → `401 TOKEN_EXPIRED`; verification failure →
   `401 INVALID_TOKEN`.
3. **Admin branch** (`decoded.role === 'admin'`): AdminAccount lookup (DB
   failure → 503), disabled → 401, idle > 3½ min → 401 “Admin session
   expired after inactivity.”, otherwise heartbeat `lastActivityAt` (skipped
   for `x-admin-background: true` requests) and `req.user = admin`.
4. **User branch:** `verifyUserSession(decoded)`; failures go through
   `rejectSession` → `{ message, code }` with the check's status; success
   sets `req.user`, `req.sessionId`, throttled `touchSession(sid)`, and
   `next()`. DB failure → `503 { message: 'The service is temporarily
   unavailable. Please try again.' }`.

`adminOnly` additionally requires `req.user.role === 'admin'`, else
`403 { message: 'Admin access required.' }`.

**Never** read a user id from the request body/query for authorization —
identity always comes from the verified token (`req.user`).

### 3.6 Saved-login credential (“Save my login on this browser”)

Companion credential stored **on the session**, opt-in per sign-in:

- **Attach** — `attachRememberToken(issuedToken)` (called by
  `/verify-login-otp` and `/login-2fa` when the request carried
  `remember: true`): generates `crypto.randomBytes(32)` base64url (43 chars),
  stores only its **sha256** as `Session.rememberHash`, and returns the raw
  value **exactly once** (the response field `rememberToken`). Attaching to a
  gone session returns `''`.
- **Client side** — `startSession(token, profile, rememberToken)` saves the
  raw credential per account under the `localStorage` key `sw_remember`
  (map `{ [userId]: { token, email, name, at } }`, capped at 10). It is a
  remember credential, **not an access token and never the password**.
- **Mint** — `POST /api/auth/remember { token }` (no Authorization header;
  the credential *is* the proof):
  1. length guard (20–200 chars) → otherwise `401 SESSION_INVALID`;
  2. `Session.findOne({ rememberHash: sha256(token) })` merely **finds** the
     candidate — it never grants;
  3. the candidate runs the **full `verifyUserSession` gauntlet** (exists →
     owned → unrevoked → still current → account active), so a saved login
     dies with sign-out, replacement, or a ban;
  4. success → a fresh JWT for the **same `sid`** (no new session is created
     and none displaced — the one-active-session rule is untouched), plus the
     profile. An audit `tokenHash`/`lastActivityAt` stamp is fire-and-forget.
- **Responses:** `200 { user, token }` · `401 SESSION_INVALID` (unknown,
  declined, malformed) · `403 ACCOUNT_DISABLED` · `503` on DB outage.
- **Rate limits:** mounted under `/api/auth`, so `lockoutCheck` +
  `authLimiter` apply (15-min window, max 200 local dev / 20 otherwise).
- **Client rules** (`mintFromRememberedLogin` in `api.js`):
  - 5-second abort timeout;
  - **only a 401/403 response drops** the stored credential — 429/5xx/network
    keep it (an outage must never destroy a valid saved login);
  - confused-deputy guard: the minted JWT must decode to the *requested*
    account id (`accountIdOf(token) === id`), else the result is discarded.

### 3.7 Revocation

- `revokeUserSession(userId, sid)` — sign-out. Scoped to **both** the
  account and the session id: signing out A can't touch B, and a stale token
  can never revoke a newer session. The pointer is cleared only when it
  still points at this session.
- `revokeAllUserSessions(userId)` — used by password reset flows.
- `POST /api/auth/logout` (protected) revokes the caller's own session only.

### 3.8 Endpoints (`/api/auth`, `server/routes/auth.js`)

Session-relevant routes:

| Method & path | Role |
|---|---|
| `POST /api/auth/login` | step 1: password → dispatches `requiresOtp` (email code) or `requiresTwoFactor` (authenticator) |
| `POST /api/auth/verify-login-otp` | step 2 (email code) `{ userId, otp, remember }` → `{ user, token, rememberToken? }` |
| `POST /api/auth/login-2fa` | step 2 (authenticator) — same `remember` flag handling |
| `POST /api/auth/remember` | exchange a saved-login credential for a fresh JWT for the **same** session (§3.6) |
| `POST /api/auth/logout` | revoke **this** session only |
| `GET  /api/auth/me` | current profile/subscription (protected) |
| `POST /api/auth/register` | sign-up (issues a session; remember flag not sent by SignUp) |
| `POST /api/auth/resend-login-otp` | resend the sign-in email code |

Other routes in the same file (unchanged behavior): `captcha`,
`forgot-password` / `verify-password-reset-otp` / `reset-password` /
`resend-password-reset-otp`, `request-email-otp` / `verify-email-otp`,
`setup-2fa` / `verify-2fa` / `disable-2fa` (protected), `PUT profile`, and
the admin flows `admin-login` / `verify-admin-2fa` / `admin-refresh`.

Mounting (`server/index.js`):

```js
app.use('/api/auth/me', sessionLimiter);              // 15-min, 1500 local / 400 prod, non-escalating
app.use('/api/auth', lockoutCheck, authLimiter, authRoutes); // 15-min, 200 local / 20 prod
```

Failed sign-ins escalate an IP up the lockout ladder
(**15 min → 1 h → 6 h → 1 day**) via `lockoutCheck` (hard stop) +
`limitReachedHandler`. `sessionLimiter` deliberately never escalates
lockouts.

Error codes carried in `code` on rejections (constants in
`server/utils/sessions.js`):

| Code | HTTP | Meaning |
|---|---|---|
| `NO_SESSION` | 401 | no credential presented |
| `INVALID_TOKEN` | 401 | signature/verification failed |
| `TOKEN_EXPIRED` | 401 | admin-only TTL (users never expire) |
| `SESSION_INVALID` | 401 | token malformed / no `sid` / unknown user / declined remember credential |
| `SESSION_REVOKED` | 401 | session replaced, revoked, or missing (message: “Your session has ended. Please sign in again.”) |
| `ACCOUNT_DISABLED` | 403 | account banned or otherwise not active |

503 bodies carry the message only (no code) — the client treats **any**
non-401/403 as transient.

## 4. Frontend session layer (`my-react-app/src/api.js`)

### 4.1 Storage map

| Key | Storage | Scope | Holds |
|---|---|---|---|
| `sw_tab_account` | `sessionStorage` | per tab | active account id |
| `sw_tab_token` | `sessionStorage` | per tab | **this tab's** user JWT |
| `sw_tab_user` | `sessionStorage` | per tab | this tab's profile JSON |
| `sw_accounts` | `localStorage` | browser | directory `[{ id, email, name, lastUsedAt }]` — metadata only, most-recent-first, capped at 10 |
| `sw_remember` | `localStorage` | browser | opt-in saved-login credentials per account (cap 10) |
| `sw_dead_tokens` | `localStorage` | browser | fingerprints (`sid:iat:length` — never the token) of provably dead JWTs, cap 20 |
| `sw_auth_notice` | `sessionStorage` | per tab | one-shot sign-in notice (“Your session has ended…”) |
| `sw_user_signed_out` | `sessionStorage` | per tab | “a user session just ended here” flag (guards never divert it to `/admin`) |
| `adminToken` | `localStorage` | browser | admin JWT — separate flow, consulted only where documented |
| legacy: `token`, `user`, `suppliwise_user_last_activity`, `sw_active_account`, `sw_token_*`, `sw_user_*` | `localStorage` | — | pre-session-store builds; adopted into the tab session on load, then **stripped** |

Key constants live in `src/auth/authState.js` (`TAB_*_KEY`,
`DIRECTORY_KEY`, `ADMIN_TOKEN_KEY`, `SIGNED_OUT_KEY`,
`AUTH_CHANGED_EVENT = 'suppliwise:auth-changed'`) and `api.js`
(`AUTH_NOTICE_KEY`, `DEAD_TOKENS_KEY`, `REMEMBER_KEY`,
`AUTH_CHANNEL_NAME = 'suppliwise:auth'`).

### 4.2 Cross-tab protocol — `BroadcastChannel('suppliwise:auth')`

| Message | Sender | Payload | Meaning |
|---|---|---|---|
| `resume` | new/switching tab | `{ type, rid, ids }` | “who holds a session for any of `ids`?” |
| `session` | holder tab | `{ type, rid, token, user }` | handover, addressed to the requesting `rid` — sessions are **never** read from shared storage |
| `session-dead` | teardown / sign-out | `{ type, token }` | “this exact token is dead” — holders fingerprint it, clear themselves, show the notice, `location.replace('/login')`; non-matching tabs are untouched |
| `sign-out` | Accounts panel (non-holder) | `{ type, id }` | the tab *holding* that account's token performs the server-side revocation |

Nothing is persisted by the channel and only same-origin tabs see it. If
`BroadcastChannel` is unavailable, `requestSessionFromTabs` resolves `null`
after the timeout and callers fall back (mint or password form). Within a
tab, components subscribe to the window event
`suppliwise:auth-changed` (fired by `emitAuthChanged()` after every session
write/removal) so the navbar and guards react without reloads.

### 4.3 Core functions

- **`startSession(token, profile, rememberToken = '')`** — installs a
  sign-in *in this tab* (`sw_tab_*`), upserts directory metadata, stores the
  optional saved login, emits `auth-changed`, and returns the previous
  account id when different (so callers can hard-navigate away from the old
  account's UI). Rejects tokens without a decodable user id and admin
  tokens.
- **`listAccounts()`** — directory + active account, **current first, then
  most-recently-used**; only the active account carries a full profile.
- **`resumeSession(timeoutMs = 400)`** — used by the new-tab bootstrap:
  already has a token → `true`; otherwise **tab handoff first** (400 ms), and
  if no holder answers, **mint each known account id in directory order**;
  `false` only when neither works (caller sends the user to `/login`).
  Successful adoption bumps the account's recency.
- **`switchAccount(id)`** — **saved-login mint first** (one round-trip, no
  other tab needed), **then tab handoff** (400 ms, dead-token checked);
  `false` ⇒ caller (`AccountSwitcher`) does
  `location.replace('/login?add=1&email=…')` for a fresh sign-in (which, by
  rule 2, revokes that account's older session).
- **`signOutAccount(id)`** — two branches:
  - *this tab holds the token:* `POST /auth/logout` (4 s abort, best-effort)
    → `clearTabSession({ forgetAccount: true })` →
    `forgetRememberedLogin(id)` → **then** broadcast
    `session-dead { token }` (sent after the local clear so this tab never
    reacts to its own message). Addressed by token ⇒ only that session's
    copies log out; every other account's tabs keep running.
  - *another tab holds it:* broadcast `sign-out { id }`, drop the directory
    entry and the saved login locally, emit — revocation is done by the only
    party that can prove it: the token holder.
- **`signOutCurrentAccount()`** — convenience wrapper.

### 4.4 401 teardown — `handleAuthError(message, code)`

Called from `friendlyError` for any `401` that is not a login/register
attempt:

1. An **admin** token is never torn down here (it owns refresh/idle flow) —
   only the message is returned.
2. Message selection: server message, else `NO_SESSION` → “Please sign in to
   continue.”, else “Your session has ended. Please sign in again.”.
3. If this tab has a token: `rememberDeadToken(token)` (fingerprint, cap 20)
   → broadcast `session-dead` → `clearTabSession()` (**directory entry is
   kept** — another tab may legitimately hold a *newer* session for that
   account) → `setAuthNotice(message)` (one-shot `sw_auth_notice`).
4. `location.replace('/login')` — history **replaced**, and never from
   `/login`/`/signup` themselves (the signup form is never yanked
   mid-typing).

Because the fingerprint blocks re-adoption and the directory survives, a
replaced session can't loop `/dashboard ↔ /login`. A `401` is definitive for
users (the server answers `503` when it merely can't reach the database),
which is why teardown never runs on outages.

### 4.5 Sign-in wiring (`src/Pages/LogIn.jsx`)

1. Optional step 1: password → server dispatches OTP or 2FA stage.
2. Step 2 body is exactly `{ userId, otp, remember }` /
   `{ userId, code, remember }` where `remember` comes from the checkbox
   **“Save my login on this browser”** — *default checked* (persisted only
   via the credential itself; the box reads `true` on each visit).
3. Response `data.rememberToken` (present only when remembered) is passed as
   the **third argument** of `startSession(token, user, rememberToken || '')`.
4. A forced sign-in notice (`sw_auth_notice`) seeds the form's initial error
   state via `takeAuthNotice()` — consumed exactly once.
5. SignIn (`/signup`) does **not** send `remember` (no checkbox there).

### 4.6 Route guards (`src/App.jsx`)

| Guard | Rule |
|---|---|
| `ProtectedRoute` (user pages) | admin JWT → `/admin/login`; user token → render; no token and `!hasUserSignedOut() && hasAdminSession()` → `/admin` (admin-only tabs never see the user login); otherwise → `/login` |
| `PublicOnlyRoute` (`/login`, `/signup`) | **never consults the admin session** — arriving is explicit intent (sign-out, session end, typed URL); exception `?add=1` keeps the form reachable while signed in; an in-progress sign-in transition (`isAuthTransitionActive()`) keeps the form until the flow navigates itself; user token (and not `?add=1`) → `/dashboard`; admin JWT → `/admin` |
| `LandingRoute` (`/`) | admin JWT → `/admin`; user token → `/dashboard`; else home |
| `GlobalChat` | hidden when `pathname.startsWith('/admin')` or the path is in `['/login', '/signup', '/admin/login', '/admin']` |

**Bootstrap gate:** a brand-new tab has no `sessionStorage` of its own.
`App` renders a fallback until `sessionReady`, which starts `true` when this
tab already has a token or the browser knows **no accounts** (first-time
visitors never wait); otherwise `resumeSession()` runs and `.finally()`
releases the gate — so guards never bounce a resumable session to `/login`.

`sw_user_signed_out` (set when a user session ends, cleared on the next
sign-in) is what keeps “signed out ⇒ user Sign In form” true even when an
`adminToken` exists — including the Back button.

### 4.7 UI placement rules

- **Navbar** (`Components/Navbar/Navbar.jsx`): signed-in chip (avatar →
  `/profile`) is **hidden on auth pages**; signed-out visitors get
  `Sign In`, or `Admin Panel` when an admin session exists. Account
  management (switch / add / sign out) lives **only** in Profile →
  Accounts, never in the navbar.
- **Accounts panel** (`Components/AccountSwitcher/AccountSwitcher.jsx`),
  rendered inline in Profile's “Accounts” section: rows show `Current`,
  `Switch`, two-step `Sign out` (“Sign out” → “Confirm?”), row click
  switches, plus `+ Add another account` → `/login?add=1`. It re-renders on
  `suppliwise:auth-changed` **and** on `storage` events for `sw_accounts`,
  so it can never list an account that is already gone. All navigation from
  it uses `location.replace` (history replace — Back can't reopen a dead
  session's page).
- **`SubscriptionSync`** (in `App.jsx`) is anchored at the app root (not the
  chat pill), resets the plan store on sign-out/switch, skips admin sessions
  (their `/auth/me` would 403), and is **keyed by token** so an in-place
  account switch re-mounts the store with the new account's plan.

### 4.8 Service worker / PWA

Development runs with **no service worker** (Vite PWA `devOptions.enabled:
false`; `main.jsx` unregisters stale registrations in dev so an old cached
worker can't pin the app). Production uses `vite-plugin-pwa` with
`registerType: 'autoUpdate'`.

## 5. End-to-end flows

**Sign-in**
`POST /login` → stage dispatch → `POST /verify-login-otp | login-2fa
{ …, remember }` → server `issueUserSession` (4-step flip) → optional
`attachRememberToken` → `{ user, token, rememberToken? }` →
`startSession(token, user, rememberToken)` → directory + optional
`sw_remember` entry → navigation to the destination (history replaced).

**Switch (Accounts panel)**
`switchAccount(id)` → mint (`POST /auth/remember`,5 s) → install on success
→ `location.replace('/dashboard')`; else tab `resume` handoff (400 ms) →
install → same navigation; else `location.replace('/login?add=1&email=…')`
→ prefilled form → a fresh sign-in replaces that account's old session.

**New tab**
Bootstrap gate → `resumeSession()` → handoff from the holder, else mint from
`sw_remember` → session installed, recency bumped → guards render the
dashboard; `false` → `/login`.

**Sign-out (held tab)**
`POST /auth/logout` (Bearer, best-effort) → server `revokeUserSession(uid,
sid)` → local clear + `forgetRememberedLogin` → `session-dead { token }` →
every other copy of *that* token fingerprints it, clears, shows the notice
and replaces to `/login`; other accounts' tabs unaffected.

**Replacement (rule 2)**
Account A signs in again elsewhere → old session's `revokedAt` stamped,
pointer moved → old tab's next request → `verifyUserSession` step 8 →
`401 SESSION_REVOKED` → teardown §4.4 (fingerprint + broadcast + notice +
`/login`), directory entry kept.

## 6. Invariants — never do this

1. **Never** write a user access token to `localStorage` (only the per-tab
   `sessionStorage`; `adminToken` is the deliberate separate exception).
2. **Never** trust a client-supplied user id — identity comes from the
   verified token (`req.user`).
3. **Never** revoke globally: revocation is scoped to `(userId, sid)`.
4. **Never** honor a token without the session gauntlet — a valid signature
   is not authorization.
5. **Never** answer 401/403 because the database is unreachable — answer
   503, and keep client credentials on anything but 401/403.
6. **Never** add `exp`/idle expiry to user tokens (admins only).
7. **Never** hand a session between tabs via shared storage — channel
   message or remember-mint only.
8. **Never** drop a saved login on 429/5xx/network — only on 401/403.
9. **Never** let `PublicOnlyRoute` consult the admin session, and never
   remove the `sw_user_signed_out` distinction — that's what keeps
   sign-out landing on the user form with a sane Back button.
10. **Never** accept query-string tokens (except the SSE route's own
    header copy).
11. **Never** reorder the `issueUserSession` steps — the snapshot/flip/revoke
    ordering is what makes concurrent logins race-safe.
12. **Never** read sessions out of the `sw_accounts` directory — it holds
    metadata only.

## 7. Running locally

- **Backend:** `cd server` → `npm install` → configure `.env`
  (`PORT=5000`, `JWT_SECRET`, `ALLOW_DEV_OTP_RESPONSE=false` — the server
  **refuses to start in production** if that flag is `true`) → `npm run dev`
  (nodemon). Requires MongoDB.
- **Frontend:** `cd my-react-app` → `npm install` → `npm run dev` (Vite,
  `http://localhost:5173`). The API base URL is `VITE_API_URL` if set,
  otherwise the page host on port `5000` (LAN devices reach it too).
- Test sign-ins use a one-time code (email) or an authenticator app when
  2FA is enabled; TOTP codes are **single-use**.

## 8. Verification recipe

Run these after any change to the files in §9. Expected results are what a
clean tree produces today.

```powershell
# 1. Backend syntax check (no DB needed)
cd server
npm run check
#    → node --check over index/middleware/routes/models/utils — silent success

# 2. Backend session suite (API on :5000 + MongoDB required)
node test-session-flows.js
#    →43/43 PASS, including acceptance tests1–6 and the11 save-login checks.
#      A reused step waits ≤ ~30 s for an unused TOTP code — this is normal.

# 3. Frontend lint (cd my-react-app)
npx eslint src/api.js src/App.jsx src/Pages/LogIn.jsx src/Pages/ProfilePage.jsx src/auth/authState.js src/Components/AccountSwitcher/AccountSwitcher.jsx
#    → 0 problems

# 4. Frontend session harness (cd my-react-app — no network, no DB)
node test-session-harness.cjs
#    →46/46 pass (legacy migration, tab isolation, handoff,401 teardown,
#      dead-token loop break, sign-out scoping, save-login flow)

# 5. Unit suites
cd server      && npm test      # node --test "Test File/*.test.js"
cd my-react-app && npm test     # subscription feature tests

# 6. Production build (cd my-react-app)
npm run build
#    → succeeds
```

## 9. Key files

| File | Role |
|---|---|
| `server/models/Session.js` | the session record (`_id` = `sid`, `tokenHash`, `rememberHash`, `revokedAt`) |
| `server/models/User.js` | `currentSessionId` + `sessionVersion` pointers |
| `server/utils/sessions.js` | `signUserToken`, `issueUserSession`, `verifyUserSession`, `attachRememberToken`, `mintFromRememberToken`, `revokeUserSession`, `revokeAllUserSessions`, error-code constants, 30-day pruning |
| `server/middleware/auth.js` | `protect`, `adminOnly`, `rejectSession`, throttled `touchSession`, admin idle timeout |
| `server/routes/auth.js` | endpoints incl. `remember` flag on both step-2 routes and `POST /remember` |
| `server/index.js` | limiter mounts, lockout ladder wiring |
| `server/test-session-flows.js` | backend acceptance suite (43 checks) |
| `my-react-app/src/api.js` | browser session layer: storage map, channel, switch/resume/sign-out, 401 teardown, saved-login helpers, migration |
| `my-react-app/src/auth/authState.js` | reactive auth snapshot, key constants, `hasAdminSession`, signed-out flag |
| `my-react-app/src/App.jsx` | guards, bootstrap gate, chat hiding, `SubscriptionSync` |
| `my-react-app/src/Pages/LogIn.jsx` | two-step sign-in, remember checkbox, notice consumption |
| `my-react-app/src/Pages/ProfilePage.jsx` | Profile → Accounts section |
| `my-react-app/src/Components/AccountSwitcher/*` | the Accounts panel UI |
| `my-react-app/src/Components/Navbar/Navbar.jsx` | auth-page chip hiding, `Admin Panel` button |
| `my-react-app/test-session-harness.cjs` | frontend verification harness (46 checks) |

Related: the end-user behavior described here is documented for users in
[`docs/USER_GUIDE.md`](USER_GUIDE.md).
