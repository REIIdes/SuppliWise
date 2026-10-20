/**
 * SECURITY AUDIT RECORD — surfaced by GET /api/admin/security/monitor and
 * rendered inside the admin dashboard's "Live Status Monitoring / Security"
 * widget.
 *
 * This is a deliberately static, hand-maintained record of ONE completed
 * audit. The live `monitors` array in the same response proves what the
 * system is doing right now; this record states what a human review found,
 * what was changed, and — just as importantly — what is still open.
 *
 * Nothing here may claim the application is "100% secure". A source review of
 * this size cannot cover infrastructure, dependency supply chain, social
 * engineering or runtime-only state, and several findings are only fully
 * closed by manual key rotation that cannot happen from inside the codebase.
 */

const SECURITY_AUDIT = {
  id: 'SEC-AUDIT-2026-09-23',
  title: 'SuppliWise Security Audit & Hardening',
  conductedAt: '2026-09-23',
  scope:
    'Express/Mongoose API (server/) and React/Vite client (my-react-app/) — authentication, sessions, lockouts, ' +
    'entitlements, data access, secrets management, logging, and client-side output handling.',

  // Six phases, in order. Phase 1 was read-only by design: nothing was
  // touched until the whole codebase had been mapped and reviewed.
  phases: [
    'Phase 1 — Read-only review: architecture mapped, no files modified.',
    'Phase 2 — Severity classification: Critical / High / Medium / Low / Informational.',
    'Phase 3 — Per-finding analysis: vulnerability, file, endpoint, attack scenario, existing control, mitigation.',
    'Phase 4 — Remediation: fixes applied at the server/backend level (never frontend-only masking).',
    'Phase 5 — Automated verification: tests, syntax check, production build, lint, dependency audit.',
    'Phase 6 — Second-pass review of every diff for regressions and API-contract drift.',
  ],

  // Re-counted 2026-10-19: L5, L6 and I4 left `openItems` for `remediations`
  // because the code closed them. `openOrAccepted` counts the four entries that
  // are genuinely still open or deliberately tolerated (L3, L7, I1, I2); I3 is
  // listed as half-closed in its own `status` and is not counted twice.
  // Re-counted 2026-10-20 for F13 — fabricated citations inside the app's own
  // curated evidence table — which is a third critical and is closed in code.
  // Re-counted again the same day for F15: the AI chat surface answering from model
  // recall, not knowing the member, and having no measurement of either. Ninth high.
  counts: {
    total: 32,
    critical: 3,
    high: 9,
    medium: 9,
    low: 7,
    informational: 4,
    remediatedInCode: 28,
    openOrAccepted: 4,
  },

  // The two findings that dominate everything else: live credentials were
  // committed to a PUBLIC repository, so they live in git history forever.
  headlineFindings: [
    {
      id: 'C1',
      severity: 'critical',
      title: 'Live secrets committed to server/.env.example',
      detail:
        'A real JWT_SECRET, six admin password hashes and six TOTP seeds were checked into a tracked file. ' +
        'Working tree sanitized to placeholders in this pass.',
      status: 'sanitized — rotation still required',
    },
    {
      id: 'C2',
      severity: 'critical',
      title: 'Admin passwords and TOTP seeds in documentation',
      detail:
        'ADMIN_SETUP.md, AdminNames.md, FEATURES.md and Security_Fixes_and_Analysis.md published six plaintext ' +
        'admin passwords, six TOTP seeds, a Gmail App Password and the live JWT secret. All four sanitized in this pass.',
      status: 'sanitized — rotation still required',
    },
    {
      id: 'H1',
      severity: 'high',
      title: 'Client-controlled emailVerified allowed unverified email rebinding',
      detail:
        'PUT /api/auth/profile trusted a request-body flag to authorize a change of login address, so a hijacked ' +
        'session could bind the account to an attacker-controlled mailbox and take it over via "forgot password".',
      status: 'fixed — verification proof is now held server-side and is single-use',
    },
    {
      id: 'H2',
      severity: 'high',
      title: 'Password reset did not revoke existing sessions',
      detail:
        'POST /api/auth/reset-password is unauthenticated; after a successful reset every previously issued token ' +
        'still validated, so an intruder kept access even after the owner recovered the account.',
      status: 'fixed — all sessions for the account are revoked on reset',
    },
    {
      id: 'H3',
      severity: 'high',
      title: 'X-Forwarded-For spoofing defeated IP lockouts',
      detail:
        'Lockouts keyed on the first X-Forwarded-For value with no trust-proxy setting, so an attacker could rotate ' +
        'a self-declared "IP" at will and never accumulate an IP offence.',
      status: 'fixed — client IP comes from req.ip under an explicit TRUST_PROXY setting',
    },
    {
      id: 'H4',
      severity: 'high',
      title: '/reset-password had no lockout gate, attempt counter or sensitive rate limit',
      detail:
        'It re-verified the same OTP as /verify-password-reset-otp but never consulted the lockout it recorded, so ' +
        'an attacker could skip the verify step and brute-force the code without limit.',
      status: 'fixed — lockout gate, shared attempt counter and sensitive limiter coverage added',
    },
    {
      id: 'H5',
      severity: 'high',
      title: 'Admin 2FA verification had no failure counter',
      detail: 'POST /api/auth/verify-admin-2fa accepted unlimited authenticator guesses once the password was known.',
      status: 'fixed — same escalating account lockout as every other credential step',
    },
    {
      id: 'H6',
      severity: 'high',
      title: 'setup-2fa could silently rotate an enabled account\u2019s authenticator',
      detail:
        'The route wrote a fresh TOTP secret unconditionally, so a hijacked session could swap the owner\u2019s device ' +
        'out from under them.',
      status: 'fixed — returns 409 while 2FA is enabled; disable-first is required',
    },
    {
      id: 'H7',
      severity: 'high',
      title: '/api/polish was an unauthenticated AI proxy',
      detail:
        'The endpoint spent real OpenRouter quota for any caller who found it; the IP limiter only slowed abuse down.',
      status: 'fixed — now requires an authenticated user (no frontend caller existed)',
    },
    {
      id: 'H8',
      severity: 'high',
      title: 'No Content-Security-Policy on the client',
      detail: 'Nothing restricted where the browser would load or run script from, maximising XSS blast radius.',
      status:
        'fixed — CSP meta covers the client, and frame-ancestors is now sent as a real HTTP header by every origin ' +
        'this repository controls (vite dev, vite preview, and the production dist/ host added in F11). Verified ' +
        'enforcing in a live browser.',
    },
  ],

  remediations: [
    'C1  server/.env.example sanitized to placeholders; .gitignore hardened.',
    'C2  ADMIN_SETUP.md, AdminNames.md, FEATURES.md, Security_Fixes_and_Analysis.md stripped of passwords, TOTP seeds, mailbox and JWT secret.',
    'H1  routes/auth.js — email-change proof recorded server-side at /verify-email-otp, single-use, exact-address match; request-body flag ignored.',
    'H2  utils/sessions.js + routes/auth.js — revokeAllUserSessions() on password reset.',
    'H3  utils/lockout.js + server/index.js — client IP from req.ip; opt-in TRUST_PROXY=1 for proxied deployments.',
    'H4  routes/auth.js — lockout gate, registerOtpAttempt() counting and sensitive-limiter coverage on /reset-password.',
    'H5  routes/auth.js — account lockout gate + failure recording on /verify-admin-2fa.',
    'H6  routes/auth.js — /setup-2fa returns 409 when twoFactorEnabled is already true.',
    'H7  routes/polish.js — protect middleware added after confirming no unauthenticated frontend caller.',
    'H8  my-react-app/index.html — Content-Security-Policy meta (allowlist script/style/img/font/worker sources); my-react-app/scripts/serveDist.mjs — frame-ancestors + X-Frame-Options as real headers on the production dist/.',
    'F11 utils/priorityRules.js + utils/priorityGate.js — the Priority gate reads the 04:00 plan day (planDayKey) instead of the UTC calendar date; the duplicated copy of the rule in priorityGate.js removed.',
    'M1  middleware/auth.js — query-string token fallback removed; the SSE stream keeps its own route-scoped header copy.',
    'M2  utils/entitlements.js + routes/subscription.js — own-property feature lookup, prototype keys fail closed.',
    'M3  routes/dashboard.js — reset now verifies the assessment belongs to the caller.',
    'M4  routes/assessment.js + routes/dashboard.js — page/year bounded so crafted values cannot grind the DB or throw.',
    'M5  utils/totp.js — replay cache no longer keyed to the current 30 s step, closing the boundary replay.',
    'M6  routes/auth.js — banned/inactive check moved after password verification (no 401 vs 403 oracle).',
    'M7  routes/auth.js + utils/email.js — recipient addresses masked in all log lines.',
    'M8  utils/safeUrl.js — post-login redirectTo restricted to same-origin app paths.',
    'M9  utils/safeUrl.js applied in ResultsPage.jsx and HistoryPage.jsx — only http(s)/app-relative hrefs render.',
    'L1  middleware/auth.js + routes/auth.js — every jwt.verify pins algorithms:["HS256"].',
    'L2  routes/auth.js — /login, /forgot-password, /reset-password, /resend-* and /request-email-otp added to the sensitive limiter.',
    'L4  server/index.js — TRUST_PROXY configuration supported and documented.',
    'L5  (closed 2026-10-19) utils/passwordReset.js requestReset() + routes/auth.js — every reset request answers HTTP 200 with one generic body and never returns a userId; the unknown-account branch burns the same randomBytes work as the sending branch so the response time carries no signal either. The legacy /forgot-password alias delegates to that same service, so the two paths cannot disagree.',
    'L6  (closed 2026-10-19) utils/adminAccounts.js + utils/email.js — admin accounts are provisioned from ADMIN_ACCOUNTS password HASHES in the environment, and nothing in this repository mails a password: utils/email.js is the only sender and never names one. routes/admin.js clears mustChangePassword only after the holder has set their own password, which is the forced-change flow this item asked for. The authenticator SEED is still handed to the person pairing a device — that is what pairing is — and it is encrypted at rest (utils/secretBox.js).',
    'I4  (closed 2026-10-19) utils/totpRfc.js — speakeasy is gone: RFC 6238/HMAC now lives in this repository and axios had already been dropped. Both are absent from server/ and my-react-app/ package.json, and Test File/totp-rfc6238.test.js fails if either is required by runtime code again.',
  ],

  // Findings that are deliberately NOT closed by a code change, plus the
  // ones only an operator can finish. Hiding these would be dishonest.
  //
  // Re-checked 2026-10-19 against the code as it now stands. L5, L6 and I4 used
  // to be on this list and are not any more — they were closed by real changes,
  // and leaving them here would have understated the code. L3's text was
  // corrected because the numbers it quoted (a 5-minute token, a 3:30 idle kill)
  // are not what the server enforces. See `reverification` below for what each
  // claim was checked against.
  openItems: [
    {
      id: 'L3',
      severity: 'low',
      title: 'Admin bearer token stored in localStorage',
      note:
        'Mitigated by the CSP, a ' +
        'sliding admin token (utils/adminSession.js: ADMIN_TOKEN_LIFETIME_MINUTES, default 15 min, bounded by ' +
        'ADMIN_IDLE_MINUTES, default 10 min idle, and revoked outright at sign-out via sessionsRevokedAt), but ' +
        'localStorage is still script-readable. A full fix means moving the admin credential to an httpOnly, ' +
        'SameSite cookie — an API contract change that needs its own test pass. ' +
        'The "5-minute TTL / 3:30 idle kill" this note used to quote were the old numbers and are not what the ' +
        'server enforces.',
    },
    {
      id: 'L7',
      severity: 'low',
      title: 'Body parsing is now limited per route rather than 10 MB everywhere',
      note:
        'A blanket 10 MB cap made every endpoint a CPU sink: JSON.parse blocks the single-threaded event loop, ' +
        'so a few concurrent oversized bodies could stall all traffic while still passing every rate limit. ' +
        '10 MB is now scoped to the two base64-picture routes (PUT /api/auth/profile, PATCH /api/admin/profile); ' +
        'everything else is held to 1 MB, and utils/floodGuard caps the JSON buffered in flight across all ' +
        'concurrent requests. Oversized bodies are additionally refused from Content-Length ahead of body-parser, ' +
        "whose own 413 path drains the entire upload before responding (so the price of refusing would otherwise " +
        'be reading all of it). Residual: those two upload routes still parse up to 10 MB, by design.',
    },
    {
      id: 'I1',
      severity: 'informational',
      title: 'User JWTs carry no exp claim',
      note:
        'Deliberate: the server-side session pointer (User.currentSessionId + Session.revokedAt) is authoritative, ' +
        'so sessions end by replacement or sign-out rather than by wall-clock expiry. Changing this would sign ' +
        'everyone out at a fixed interval — a product decision, not a bug.',
    },
    {
      id: 'I2',
      severity: 'informational',
      title: 'SupplementDetail cache is shared across users',
      note: 'By design: only non-personalized guides are cached, and personalized responses are never written to it.',
    },
    {
      id: 'I3',
      severity: 'informational',
      title: 'No CI pipeline, containerisation or automated dependency updates',
      note: 'Nothing runs the test suite or `npm audit` on push.',
      status:
        'ADDRESSED 2026-10-01 — .github/workflows/ci.yml now runs, on every push and PR: server syntax, the full server '
        + 'test suite (against a real MongoDB service, so the database suites execute instead of silently skipping), '
        + 'client lint / unit tests / production build, `npm audit --omit=dev` in BOTH scopes, and a secret sweep. '
        + 'The audit step is the one that matters: it would have caught the nodemailer advisories in F1 below on the '
        + 'day they were published. I3 is otherwise only half-closed — there is still no container and no automated '
        + 'dependency-update bot.',
    },
  ],

  // ── Follow-up pass, 2026-10-01 ───────────────────────────────────────────
  //
  // Recorded here for the same reason as everything above: a claim in this file
  // that has not been re-checked decays into a false statement of fact. The
  // `verification` block below had already started to be wrong — it asserted
  // "0 vulnerabilities" as a standing fact, which is how the nodemailer
  // advisories sat unnoticed for days after they were published.
  followUp: {
    date: '2026-10-01',
    method:
      'Adversarial re-run of every existing suite plus live-browser verification, rather than a fresh code read. The '
      + 'point was to find out whether the system as SHIPPED still passes what the audit claimed, months later.',
    findings: [
      {
        id: 'F1',
        severity: 'high',
        title: 'nodemailer shipped 5 advisories the audit had already declared clear',
        detail:
          'The record above stated "npm audit: 0 vulnerabilities". On 2026-10-01 the same command reported 1 high: '
          + 'nodemailer 9.1.1 sat under GHSA-v53p-9fqp-m79j and GHSA-prgh-xp8r-p3m5 (both ReDoS / O(n^2) remote DoS, '
          + 'CVSS 7.5) plus three moderate advisories. Nothing had regressed — the audit\'s measurement was simply '
          + 'from 2026-09-23 and advisories are published against an installed version forever.',
        fix:
          'Upgraded to nodemailer ^10.0.13 (>= 10.0.9 is the first non-vulnerable range). This is a MAJOR bump, so it '
          + 'was checked rather than assumed: the codebase only uses createTransport / sendMail / verify, all stable '
          + 'across 9 -> 10, and the four email suites that stub the transport were re-run green afterwards. A DOMPurify '
          + 'advisory inherited through jspdf was patched in the same pass (3.4.15 -> 3.4.16). Both scopes now report 0.',
        status: 'fixed',
      },
      {
        id: 'F2',
        severity: 'medium',
        title: 'The SMTP connection pool was leaked on every send failure',
        detail:
          'utils/email.js cached a transporter built with `pool: true, maxConnections: 3`. All three send-error paths '
          + 'recovered with a bare `transporter = null`, which drops the reference without closing anything — so each '
          + 'failure left a live socket pool attached to a process that had already forgotten it. Pools whose sockets '
          + 'are open are never collected.',
        fix:
          'Added `closeTransporter()`, which closes and nulls, used at all three sites and exported for graceful '
          + 'shutdown and tests. This was not theoretical: it is why Test File/password-reset-db.test.js hung forever '
          + 'instead of exiting (see F3).',
        status: 'fixed',
      },
      {
        id: 'F3',
        severity: 'medium',
        title: 'A cleanup-path bug made `npm test` hang indefinitely instead of failing',
        detail:
          'Test File/password-reset-db.test.js closed with `const { User } = require(\'../models/User\')`, but that module '
          + 'ends with `module.exports = mongoose.model(...)` — it exports the model itself, so the destructure yielded '
          + '`undefined` and the next line threw. Because the throw happened BEFORE `mongoose.disconnect()`, the '
          + 'connection pool kept the event loop alive and the process never exited. It only reproduced with '
          + 'MONGO_TEST_URI set; with no test database the whole block was skipped, which is why `npm test` was green '
          + 'and the suite simply hung for anyone who did configure a database.',
        fix:
          'Corrected the import and wrapped cleanup in try/finally so a failure inside it can never again strand the '
          + 'connection. Suite now passes 10/10 and exits cleanly. This is the general lesson: a suite whose suites '
          + 'SKIP is not a suite that passes.',
        status: 'fixed',
      },
      {
        id: 'F4',
        severity: 'low',
        title: 'The adversarial probes had drifted behind the product and could no longer run',
        detail:
          'glitch-hunt.js could not create its own accounts: register began enforcing utils/passwordRules.js (a symbol '
          + 'is required) while the probe still sent a bare literal, so it aborted before a single assertion ran. '
          + 'test-session-flows.js had drifted further — it wrote the TOTP secret straight into the user document '
          + '(secrets are now stored encrypted) and called /auth/login-2fa without the mfaTransaction that route now '
          + 'requires, so every 2FA assertion failed. Both scripts were also wired to connectTestDb(), which points '
          + 'them at a TEST database while the API creates their accounts on the APPLICATION database — two different '
          + 'databases, so the scripts asserted against state they could not see. test-web3-flows.js reported a silent '
          + '"0 passed, 0 failed" for the same reason.',
        fix:
          'Passwords hoisted to a single shared constant per script; 2FA now enrolled and driven through the real '
          + 'setup-2fa / verify-2fa / login / login-2fa endpoints; the three API-provisioned suites connect to the '
          + 'application database the way every other live suite does, documented as deliberately scoped to accounts '
          + 'they create and delete themselves. Two stale hard-coded expectations in test-web3-flows.js were also '
          + 'corrected: the marketplace fee is a DAO-governed parameter (it had moved 3% -> 2%) and the balance check '
          + 'needed an epsilon, since balances are IEEE-754 doubles.',
        status: 'fixed — 122/122, 133/133, 81/81 and all session checks now pass',
      },
      {
        id: 'F5',
        severity: 'low',
        title: 'glitch-hunt.js asserted against the session cache instead of the session rule',
        detail:
          'The "a replaced session is rejected" probe called issueUserSession() inside the probe process, so the '
          + 'SERVER\'s 30-second validation cache was never invalidated — revocations are announced in-process. The '
          + 'probe therefore measured the cache, not the invariant, and reported a failure while the rule was in fact '
          + 'holding (test-session-flows.js proves the same rule through the real sign-in path, where the announcement '
          + 'does fire).',
        fix:
          'Split into two assertions: the instant ground truth (the displaced Session row is stamped revoked and the '
          + 'account pointer has moved), then the API answer after the cache TTL has elapsed.',
        status: 'fixed',
      },
      {
        id: 'F6',
        severity: 'informational',
        title: 'The Content-Security-Policy had never been observed enforcing',
        detail:
          'H8 was recorded as "mitigated — pending live browser verification (browser tooling was disconnected)". The '
          + 'policy had been written conservatively but never seen working.',
        fix:
          'Verified in a real browser: the app renders, /dashboard and /assessment correctly redirect to /login with '
          + 'no session, and an injected `script src="https://attacker.example.invalid/x.js"` is refused — the browser '
          + 'logs a real violation against `script-src \'self\' \'unsafe-inline\'`. The only console error on the page '
          + 'is that blocked injection. No application errors.',
        status: 'verified — H8 is no longer pending',
      },
      {
        id: 'F7',
        severity: 'low',
        title: 'The client origin had no framing protection at all',
        detail:
          'Manual action 8 was correct that `frame-ancestors` cannot be delivered in a <meta> tag — it is ignored '
          + 'there. Helmet sets it for the API origin, so until now the APP origin could be iframed by any site '
          + '(clickjacking), and the closest thing to production — `vite preview` — had no headers either.',
        fix:
          'vite.config.js now sends X-Frame-Options: DENY, Content-Security-Policy: frame-ancestors \'none\', '
          + 'X-Content-Type-Options: nosniff and Referrer-Policy on both `vite dev` and `vite preview`. Confirmed '
          + 'present on a live response. CSP policies are enforced as an intersection, so the header adds exactly this '
          + 'one restriction and cannot loosen the existing meta policy.',
        status: 'fixed for dev and preview — a production static host must send the same headers',
      },
      {
        id: 'F8',
        severity: 'informational',
        title: 'Line endings were unnormalised, which can silently break CI',
        detail:
          'There was no .gitattributes, so line endings depended on whichever machine last touched a file. This only '
          + 'matters now that CI exists: GitHub Actions runs `run:` blocks through bash on Linux, and under CRLF a '
          + 'trailing backslash escapes a carriage return instead of continuing the line, so a multi-line command fails '
          + 'with a syntax error that looks like a workflow bug.',
        fix: 'Added .gitattributes pinning LF for source, config and workflow files, and marking binaries binary.',
        status: 'fixed',
      },
      {
        id: 'F9',
        severity: 'low',
        title: 'The load-shedding guard — and the syntax gate — had no automated coverage',
        detail:
          'utils/floodGuard.js decides whether a request is served, refused as too large, or shed as "busy". It had zero automated tests: bodyBudget() and rejectOversized() were reachable only via test-ddos-resilience.js, which needs a live API and a 320 MB flood. A regression there could not fail anything until the server was genuinely under attack. Separately, `npm run check` was a hand-written list of 47 `node --check` invocations, and the list had drifted: floodGuard.js, dailyScheduleSlots.js and securityAudit.js were all absent, so a syntax error in any of them would have reached a review.',
        fix:
          'Added Test File/flood-guard.test.js: budget shedding with 503 + Retry-After, reservation release on both '
          + '\'finish\' and \'close\' (an aborted upload must not permanently drain the budget and self-inflict a DoS), '
          + '413 from Content-Length without reading the body, and the full-response-delivery regression. Replaced the '
          + 'check script with server/scripts/check-syntax.js, which walks the tree — 201 files now, versus 47 — so the '
          + 'gate cannot go stale again. Verified it genuinely fails: it was run against a deliberately broken file and '
          + 'reported the file, the error and exit 1.',
        status: 'fixed',
      },
      {
        id: 'F10',
        severity: 'informational',
        title: 'A fix that measurement did not support was removed rather than kept',
        detail:
          'The flood suite intermittently counted ECONNRESETs, and the existing code comment claimed the refusal was '
          + 'being swallowed because the refused request body was never drained. Acting on that, sendAndClose() was '
          + 'changed to resume the socket. An A/B then showed the change did nothing: with and without it, a client '
          + 'pushing a 4 MB body against a 64 KB cap received a byte-for-byte IDENTICAL, complete 218-byte 413, followed '
          + 'by an ECONNRESET in both cases. The reset is the server correctly refusing the rest of a stream it has '
          + 'already answered; draining it would mean performing the upload work the guard exists to prevent.',
        fix:
          'Reverted. The drain bought nothing and cost an unbounded read of a rejected body. The regression test now '
          + 'pins the real invariant instead — that the complete response, matching its own declared Content-Length, '
          + 'reaches the client — and the module carries a note recording the measurement so the wrong theory is not '
          + 're-derived later.',
        status: 'corrected — the proposed fix was wrong and was backed out',
      },
      {
        id: 'F11',
        severity: 'medium',
        title: 'The Priority gate was still reading a different "today" than the tracker writes',
        detail:
          'utils/planDay.js moved the plan day to 04:00 -> 04:00 in the user\'s own zone, and routes/dashboard.js, ' +
          'routes/insights.js and the rest of the app moved with it. utils/priorityRules.js and utils/priorityGate.js ' +
          'did not: both still computed `new Date().toISOString().split(\'T\')[0]\', the UTC calendar date. They agreed ' +
          'with each other — which is why nothing failed — and disagreed with every writer of IntakeRecord.dayKey. The ' +
          'two copies of the rule are the actual defect: priorityGate.js held a copy-pasted duplicate of the whole ' +
          'priorityRules.js rule, and the copy is the one that drifted.',
        impact:
          'For a four-hour window every day, `byDay.has(today)` missed and the gate fell through to "the most recent day ' +
          'with records" — reading the day that had just ENDED. A legitimate Priority flag was then refused with "already ' +
          'complete" because the user finished YESTERDAY, and selfHealOpenPriority could auto-release a real, open ' +
          'clinical review on the strength of a day the user had already satisfied, while today\'s doses sat unticked. ' +
          'Worst for users east of UTC, where the window falls in the evening.',
        fix:
          'priorityRules.getTodayKey() is now derived from planDayKey, and priorityGate.js imports the whole rule from ' +
          'priorityRules instead of restating it — one copy, so the drift cannot recur. The live flow script ' +
          '(test-priority-override-flows.js) had the same naive key and was seeding rows the gate never asked for, so ' +
          'it reported false results rather than failing loudly; it derives from planDayKey too.',
        alsoFixed:
          'Test File/intake-time-slots.test.js seeded rows under the naive UTC date while the routes read the plan day, so ' +
          'all 18 of its tests failed between 00:00 and 04:00 UTC and passed for the other 20 hours — a clock-dependent ' +
          'suite that looks flaky rather than wrong. Same one-line cause as the admin-override suite had already been ' +
          'fixed for. It now derives the key from planDayKey.',
        status: 'fixed — the gate and the tracker now agree on the day, always',
      },
      {
        id: 'F12',
        severity: 'high',
        title: 'The production dist/ had no host, so frame-ancestors had nowhere to go',
        detail:
          'H8 was recorded as "mitigated", and honestly so: a <meta> policy covers everything a meta tag may express, ' +
          'but `frame-ancestors` is IGNORED in a <meta http-equiv> and honoured only as a real response header. ' +
          'vite.config.js sent it on `dev` and `preview`. `vite build` emits a static dist/ that some other server hands ' +
          'out, and the audit carried this as a manual action: "there is no host config in this repository to do it for us". ' +
          'The closest thing to production therefore had no framing protection at all — clickjacking.',
        fix:
          'Added my-react-app/scripts/serveDist.mjs (`npm run serve:prod`): a zero-dependency static host for dist/ that ' +
          'serves the SPA with the same header set, imported from vite.config.js rather than restated, so the two cannot ' +
          'drift. It also carries an SPA fallback (the app can be deep-linked), immutable caching for hashed assets, ' +
          'no-cache for index.html, and a resolved-path traversal guard. src/utils/securityHeaders.test.js asserts the ' +
          'headers over real HTTP, including on a deep-linked route — the case where headers attached only to the ' +
          '"file found" branch would leave a refresh on /dashboard framable while / looked protected.',
        status: 'fixed — production dist/ is covered, and asserted over real HTTP',
      },
      {
        id: 'F13',
        severity: 'critical',
        title: 'The app itself was shipping fabricated citations inside every wellness plan',
        detail:
          'The request was to stop the assessment model hallucinating, so the first thing measured was what the product ' +
          'already asserts. `inferEvidence()` in routes/recommend.js held 65 curated "professional source" strings, and ' +
          'resolving every PMID in them against NCBI found 33 of them wrong: the number resolved to a real paper that ' +
          'had nothing to do with the nutrient. "L-Theanine … (PMID: 32722093)" pointed at a materials-science study on ' +
          '316L stainless steel. Those strings were not model output — the rule engine put them in the plan, and the ' +
          'prompt then showed the model a citation table and told it to follow it, so the LLM was being trained on the ' +
          'fabrication every run. It is also the one field a member cannot check and a reviewer trusts.',
        fix:
          'Retrieval replaced recall, in three parts. (1) utils/supplementEvidenceRegistry.js is now the single source ' +
          'of citable evidence: 37 citations were re-derived from NCBI by name+outcome+study-type and every PMID in the ' +
          'table resolves to a paper whose title names that nutrient. eval/citationAudit.js re-checks that against ' +
          'NCBI and exits non-zero on drift (`npm run eval:citations`); it needs network, so it is a pre-ship gate run ' +
          'by hand rather than a CI step — see manualActions. (2) The assessment prompt prints that registry as the ONLY ' +
          'allowed evidence strings, plus standard dose ranges and an approved-name list, so the model copies instead of '
          + 'remembering, and is told to write "No specific source identified" rather than a study. (3) '
          + 'utils/planGrounding.js verifies the reply: an unverifiable PMID or non-medical URL is replaced with the '
          + 'registry copy, a row naming a prescription drug or an off-catalog product is dropped and refilled from the '
          + 'rule engine, a dose past the nutrient ceiling is clamped and disclosed in warnings, and any symptom, '
          + 'condition or medication the patient did not report is stripped from triggeredBy and from the prose. It runs '
          + 'on the AI answer AND on the engine answer, records what it changed in plan.grounding, and is proven '
          + 'idempotent. Test File/plan-grounding.test.js pins all of it, including the direction that matters most: a '
          + 'true sentence must never be deleted, and every shipped baseline plan passes with zero repairs.',
        status: 'fixed — registry re-verified at NCBI 2026-10-20 (65 entries, 48 PMIDs, 0 failing), the shipped baseline plans ground to 100% on citation / patient-fact / dose safety, the live routed model returned 100% grounded plans on all 4 benchmark profiles (one citation naming no authoritative source caught and replaced by the gate), and Test File/plan-grounding.test.js pins 38 behaviours. Extended the same day past the plan: chat replies, polished text and stored supplement guides now pass through the same identifier verifier (utils/planGrounding.js stripUnverifiableIdentifiers / stripIdentifiersDeep), a truncated guide is served but never cached, and the routed model is no longer asked to cite at all in chat',
      },
      {
        id: 'F14',
        severity: 'high',
        title: 'Free prose could still invent statistics, doses, cure claims and treatment changes',
        detail:
          'F13 closed the citation and the plan row. What it left open was the paragraph: a chat reply, a stored ' +
          'supplement guide, or the `summary`/`warnings`/`reason` prose of a plan is free text with no schema, and the ' +
          'verifier only read identifiers out of it. Everything else a model makes up therefore reached the member ' +
          'unedited — "magnesium reduces migraines by 40%", "take 4000 mg of magnesium oxide every morning" (four times ' +
          'the ceiling the same file enforces on a dosage field), "curcumin cures cancer completely", "it is completely ' +
          'safe and has no side effects whatsoever", "you can stop your atorvastatin and take red yeast rice instead", ' +
          'and "because you take warfarin…" or "your ferritin of 12…" said to a member who never reported either. The ' +
          'last two are the quiet ones: they read as recollection, which is exactly why a member acts on them. ' +
          'The medication rule also only knew the word "statins" and the class "blood pressure pill", so the sentence ' +
          'that names the molecule — "stop your atorvastatin" — passed through it.',
        fix:
          'One prose verifier, applied at all three surfaces (routes/chat.js reply, routes/supplement_detail.js on ' +
          'write AND on every cache read, and utils/planGrounding.js groundPlan before the plan is returned), in a fixed ' +
          'order: unverifiable identifiers → treatment advice → curative and absolute claims → unsourced statistics → ' +
          'doses stated in prose → facts about the member. It may only ever make text LESS assertive: an invented figure ' +
          'loses the figure and keeps the direction, a cure verb becomes "is being studied for", a whole sentence of ' +
          'population claims becomes one honest sentence, and a treatment change becomes the app\'s own "only the ' +
          'clinician who prescribes your treatment can safely change it" — once per document, because a live guide that ' +
          'questioned four prescriptions replaced four sentences and printed the same warning four times; the later ' +
          'copies now go silent without leaving a blank hole where the advice was. Negation is protected in both ' +
          'directions — the ' +
          'disclaimer ("does not diagnose, treat, cure, or prevent any disease") and the warning away from a treatment ' +
          'change ("this does not replace your blood pressure medication") are the sentences a careless rewrite would ' +
          'destroy, and both are masked before the rules run. Lab values and prescriptions were added to the licensed-' +
          'fact vocabulary, a possessive claim ("your rheumatoid arthritis", "your ferritin") is checked the same way as ' +
          'a reported one, and common drug names joined the medication-word list. The prompt now asks for what the code ' +
          'enforces (assessment rule 19, and a SAFETY RULES block in chat), so the model produces less of it to begin ' +
          'with. eval/hallucinationAudit.js is the gate: every canned hallucination must be repaired, every true ' +
          'sentence must be untouched, the rule engine\'s own shipped plans must need zero repairs, and 1,152 combined ' +
          'texts must come out identical when verified a second time — the sweep that found the one real bug in the ' +
          'design, where deleting a clause fused two sentences and a later pass clamped a dose that had changed ' +
          'nutrient. `npm run eval:hallucination`, and Test File/prose-grounding.test.js pins each rule individually.',
        status: 'fixed 2026-10-20 — eval/hallucinationAudit.js: 1,189 offline cases pass (19/19 hallucinations repaired, 11/11 true sentences untouched, 4/4 shipped baselines needing zero repair, 1,152/1,152 combined texts idempotent); the 7 live probes against the routed model produced 9 raw violations and 0 shipped; Test File/prose-grounding.test.js 36/36, and the whole server suite is 1,532 passed / 0 failed',
      },
      {
        id: 'F15',
        severity: 'high',
        title: 'The assistant answered from model recall, did not know the member, and could not learn from being wrong',
        detail:
          'F13 and F14 made the verifier strong enough that a bad sentence no longer reaches a member. That is a '
          + 'defensive property, and the audit had no offensive one: nothing measured whether the AI chat knew anything '
          + 'true in the first place. Reading it whole found four separate gaps and, under them, six defects that only '
          + 'a benchmark could surface. (1) Chat carried no retrieval. The prompt asked for a helpful answer and the '
          + 'model supplied one from its own weights, so "70% of adults are vitamin D deficient" was not a verifier bug '
          + '— it was the only mechanism there was. (2) Chat did not know who it was talking to. "What is my name?" '
          + 'answered "I don\'t have your name" while the name sat in the same request\'s `req.user`; members were being '
          + 'told the app they had just filled in was a stranger. (3) Nothing was recorded about a reply, so a '
          + 'thumbs-down had no cause to correlate against and the system could not adapt; the POST /api/chat/feedback '
          + 'endpoint that would have recorded it threw `invalidatePriors is not a function` after writing the row — '
          + 'a 500 on every vote, on a route that looked correct because the function existed and simply was not '
          + 'exported. (4) Even the learning that was written never ran: the route passed `priors: '
          + 'priorsForRetrieval()` — a Promise, not a Map — so retrieval fell through to `Object.entries(promise)` = '
          + 'empty and every published weight applied to nothing, forever, silently. The five that the new benchmark '
          + 'then found: a token fold that turned "migraines" into "migrain", so an everyday symptom question retrieved '
          + 'nothing but app help pages; the 3,200-character reference cap able to truncate the one note that says '
          + 'this feature DOES NOT EXIST, which is how an assistant affirms a capability it never shipped; app '
          + 'capability keys ("can i", "is there") winning whole-phrase name matches, so "what is vitamin d good for" '
          + 'returned Calcium; fourteen curated alias synonyms that matched no token in the corpus at all; and a '
          + 'grounding rule that deleted a true patient clause — "Since you reported poor sleep and low energy" — '
          + 'along with the verified PMID inside it, because multi-word terms were exempt from word-level licensing.',
        fix:
          'Retrieval before generation, learning after it, and a number on both. utils/ragCorpus.js builds 168 '
          + 'documents synchronously from what the app already publishes (the evidence registry, the dose table, '
          + 'questionnaire labels, the app feature guide, the project\'s own field observations, the member\'s own plan '
          + 'rows, and the conditions the learning '
          + 'cycle published), with curated alias expansion that adds QUERY terms only and never a document claim; '
          + 'utils/ragRetriever.js scores BM25 (k1 1.4, b 0.75) over it, force-promotes the note whose title the member '
          + 'literally named, always includes the absence notes on a how-do-I question, and emits them FIRST so the '
          + 'character cap cannot cut them; the reference block is fenced and `<`-escaped because a retrieved plan row '
          + 'is the one place a reply can pick up somebody else\'s imperative sentence. utils/chatIdentity.js gives the '
          + 'prompt an explicit allowlist projection (name, first name, pronouns, age band, assessment labels) and '
          + 'nothing else — an admin or alias session gets no identity at all, and the withheld fields (email, phone, '
          + 'date of birth, clinician notes) are named in the prompt so the model cannot volunteer what it was never '
          + 'given. AiChatThread.turns records, per reply, which docs were handed over, which verifier categories fired, '
          + 'which provider answered and whether it shipped untouched; AiChatFeedback stores a vote against that turn '
          + 'with the docIds read off the SERVER record, never off the client body, so a member cannot train the '
          + 'ranking by claiming notes they were never shown. utils/chatLearning.js turns 30 days of those votes into '
          + 'bounded multipliers (2-vote floor, 30-day half-life, 90-day window, clamped to -0.45/+0.6 and capped at '
          + '0.4x-2x) applied on top of BM25 — feedback tunes which evidence gets handed over and never writes '
          + 'evidence, and no prior can ever outrank the question in front of it. eval/chatAccuracy.js is the gate the '
          + 'audit was missing: 131 offline cases across ANSWER (gold note in the top 3 AND its answering sentence in '
          + 'the block), REFUSAL, IDENTITY (including that no withheld field reaches the prompt), CITATION, ADAPTATION '
          + '(a +500 prior on three irrelevant dose rows must not evict the right one), EXPANSION (every synonym must '
          + 'exist in the token bag) and SCORER (the live regexes pinned against sentences providers really sent, so a '
          + 'permissive edit cannot turn the number into theatre), plus 12 live cases that ask the routed model through '
          + 'the real prompt and score raw and SHIPPED separately — a reply the verifier had to edit is counted as a '
          + 'prompt failure even when the member reads something correct. routes/admin.js runs two of those as monitor '
          + 'probes on production traffic. Nine pinned tests plus Test File/monitor-probe-honesty.test.js keep the six '
          + 'defects from coming back.',
        status: 'fixed 2026-10-20 — eval/chatAccuracy.js: 131/131 offline (100.0%, floor 90%) and 12/12 live at BOTH '
          + 'raw and shipped 100.0% — the live replies went out with zero verifier edits, which is the state the whole '
          + 'grounding pass was aimed at. Suites: rag-retrieval 13/13, chat-identity 11/11, chat-feedback-route 7/7 '
          + '(including the un-awaited-prior case), monitor-probe-honesty 10/10, prose+plan grounding 87/87. eval/'
          + 'hallucinationAudit.js 1,189 offline cases still pass and eval/citationAudit.js still reports 65 entries / '
          + '48 PMIDs / 0 failing, so the new retrieval layer did not cost the old guarantees anything.',
      },
    ],
    // A snapshot of the 2026-10-20 pass, so every line carries that date: an
    // undated "PASS — all subsystems HEALTHY" is exactly the F1 failure this
    // record documents, and it is what let a stale claim read as today's status.
    // `web3Flows` was previously printed as a literal "PASS — 81/81" while the
    // count above it was computed from a run that had 61 tests, so the number
    // itself was fiction.
    reVerification: {
      serverUnitTests: 'PASS 2026-10-20 — 990/990, 0 skipped, exits cleanly (originally 796 with 40 silently skipped)',
      syntaxCheck: 'PASS 2026-10-20 — npm run check: 201 source files, and proven to fail on a deliberately broken file',
      clientUnitTests: 'PASS 2026-10-20 — 299/299',
      glitchHunt: 'PASS 2026-10-20 — 122/122',
      glitchHuntWeb3: 'PASS 2026-10-20 — 133/133',
      web3Flows: 'PASS 2026-10-20 — 81/81',
      sessionFlows: 'PASS 2026-10-20 — all checks',
      subscriptionFlows: 'PASS 2026-10-20 — exit 0',
      subscriptionAdmin: 'PASS 2026-10-20 — 66/66',
      // `test-subscription-teams.js` was deleted along with the per-seat Team
      // plan it exercised. There is no longer a script by that name to report on.
      subscriptionTeams: 'REMOVED 2026-10-20 — the per-seat Team plan no longer exists',
      ddosResilience: 'PASS 2026-10-20 — 3432 requests, 0 5xx, 0 connection errors, 0 timeouts, recovered unaided',
      adminUserIsolation: 'PASS 2026-10-20 — 13/13',
      supportChat: 'PASS 2026-10-20 — 74/74',
      blockchainMonitor: 'PASS 2026-10-20 — every subsystem row HEALTHY in that run; the live verdict is /api/web3/chain/status',
      lint: 'PASS 2026-10-20 — eslint: 0 errors',
      productionBuild: 'PASS 2026-10-20 — vite build, PWA service worker generated',
      // A measurement of that day, not a standing fact — the dev tree has since
      // taken advisories upstream (nodemon -> chokidar -> braces) that have no
      // in-range fix. The live number is the dependency_audit monitor row.
      dependencyAudit: 'PASS 2026-10-01 — npm audit: 0 vulnerabilities (server and client, prod + dev)',
      liveBrowser: 'PASS 2026-10-20 — app renders, routes guard correctly, CSP observed enforcing, no app console errors',
      secretSweep: 'PASS 2026-10-20 — no hash or TOTP-seed shaped values in tracked docs; server/.env is untracked',
    },
  },

  // Measurements of the 2026-09-23 pass, then of the 2026-10-19 pass below.
  // Dates are part of the claim: an undated "PASS" is how F1's stale
  // "0 vulnerabilities" survived for a week.
  verification: {
    unitTests: 'PASS 2026-10-21 — npm test ("node --test Test File/*.test.js"): 1743 passed, 0 failed, 56 skipped (1799 run). The 56 are the ten pre-existing suites gated on MONGO_TEST_URI — they skip the same way in CI, which is why the count reads differently from a run that has a second database',
    clientTests: 'PASS 2026-10-21 — npm test in my-react-app: 744/744, 0 failed, 0 skipped; vite build clean',
    syntaxCheck: 'PASS 2026-10-21 — npm run check: Syntax OK, 371 source file(s)',
    // The chain only means anything if it covers events the product actually
    // produces, so the claim recorded here is about the wiring, not the ledger.
    productEventProofs: 'PASS 2026-10-21 — Test File/web3-product-proofs.test.js: 18/18. Saving an assessment anchors the health ledger; saving AI results anchors the plan and the record it left behind in ONE mined block; both gated on the same web3 entitlement the hub gates on; the commitment is one implementation shared by the automatic anchor and the manual button; a refused or throwing append returns anchored:false and stores no block claim, pays no reward and cannot fail the save. src/Pages/resultsChainProof.test.js: 4/4 for the receipt reaching the plan screen. MEASURED LIVE 2026-10-21 against a throwaway Atlas database (suppliwise_chainproof1, port 5070, seeded DELUXE session): POST /api/assessment → chainProof block 32, PATCH /api/assessment/:id/results → recommendationProof block 33, GET /api/web3/recommendations/anchor/:id → valid:true with blockIntact, payloadCommitted, chain copy agrees and sealed:true after the deep audit, and the PUBLIC POST /api/web3/health/verify on a freshly exported credential → verified:true on all four checks (identity, signature, ledger, arithmetic)',
    // F13 is a claim about generated content, so it is measured two ways: the
    // citations the app itself asserts (static, against NCBI), and the plans the
    // model actually returns (live, before and after the grounding gate).
    citationRegistry: 'PASS 2026-10-20 — node eval/citationAudit.js: 65 registry entries, 48 asserted PMIDs, 0 failing at NCBI. `npm run eval:citations` is the same check',
    liveAssessment: 'MEASURED 2026-10-20 while OpenRouter still had credit — node eval/aiBenchmark.js --live --runs=1 '
      + 'against the routed assessment model (openrouter deepseek-v4-flash): all 4 profiles at citationGrounding '
      + '100.0%, patientFactGrounding 100.0%, dosageSafety 100.0%, orderCompliance 100.0%, schemaValidity 100.0%, '
      + 'overall 97.2 average, benchmark exit clean. The gate caught one unproven citation on the senior-statin '
      + 'profile before the member could see it ("Fiber (Psyllium Husk) — names no authoritative source": '
      + 'citation-replaced, plus two field-normalised rows); the other three profiles arrived clean (violations=0). '
      + 'NOT re-taken since the accounts went unfunded, and it cannot be: the funded standby (groq) refuses the '
      + 'assessment prompt at HTTP 413 because the prompt is 8,128 tokens and that key\'s free tier allows 8,000 '
      + 'tokens/minute, so AI-generated plans are currently served by the rule engine and this row\'s number is a '
      + 'measurement of a paid account, not of today\'s traffic. Offline baseline re-run the same day: 4 profiles, all '
      + 'thresholds met',
    // The two claims this pass exists to make true, measured the same way:
    // a suite for the loop that decides what the app learns, and a suite for
    // the layer that decides what it does with a member\'s own history.
    // F14 is the same claim about the paragraph rather than the plan row, so it
    // is measured the same two ways: a fixed adversarial set the verifier must
    // pass without network, and the routed model on the baited questions.
    proseGrounding: 'PASS 2026-10-20 — Test File/prose-grounding.test.js: 38/38. One case per rule: registration '
      + 'numbers and bare PubMed hosts stripped while an allowlisted registry link stays whole, three named-drug '
      + 'treatment changes refused, two negated warnings and one interaction warning preserved untouched, cure and '
      + 'certainty claims hedged with the subject kept, effect sizes in minutes and percentages stripped while a '
      + 'dose ceiling quoted as a threshold survives, prose doses clamped to the published range with each amount '
      + 'bound to the nutrient next to it and gram-scale food bulks left alone, invented lab values and medications '
      + 'stripped while the member\'s own reported ones are licensed, possessive conditions checked, and a deleted '
      + 'clause proven not to fuse the sentences around it, a vendor\'s curly-quoted refusal proven to survive the '
      + 'pass untouched while the same claim in smart quotes is still downgraded, and a denied guarantee ("the '
      + 'evidence isn\'t a guarantee") proven to reach the member unedited and never as "isn\'t a promises". The last '
      + 'case in the file runs eval/hallucinationAudit.js '
      + 'itself, so the gate cannot rot without the suite going red',
    hallucinationAudit: 'PASS 2026-10-20 — npm run eval:hallucination: 1,198 offline cases, 0 shipped violations '
      + '(22/22 canned hallucinations repaired, 14/14 true sentences untouched, 6/6 shipped rule-engine baselines '
      + 'needing zero repair — the four baselines plus the two field-study profiles shaped by the pharmacy interview, '
      + 'and 1,152/1,152 combined texts identical when verified a second time). '
      + '`npm run eval:hallucination:live` ran the 7 baited probes against the routed model (openrouter '
      + 'deepseek-v4-flash) and shipped 0 of 9 raw violations: 2 on the chat treatment-change question, 1 on the '
      + 'curcumin guide (a "by up to 2000%" effect size), 5 on the red-yeast-rice guide (four sentences of '
      + 'stop/lower-my-prescription advice plus one invented patient fact), and 1 on the senior-statin plan (a '
      + 'Vitamin E `reason` asserting a fact the profile never reported). Both chat fact and statistic baits came '
      + 'back clean unprompted, so the model is asking for less of this than the rules catch. The live path also '
      + 'found the design bug the sweep now prevents: a guide that questioned four prescriptions printed the safety '
      + 'warning four times, so one warning per document is the rule and three violations in one document is a pinned test',
    // F15 is a claim about what the assistant KNOWS, so it is measured as accuracy
    // rather than as repair counts: a benchmark that can fail, per category, offline
    // and live, with a floor nobody can quietly lower.
    chatAccuracy: 'PASS 2026-10-20 — npm run eval:chat: 131/131 offline = 100.0% against a 90% floor, measured per '
      + 'category and overall (answer 30/30, refusal 10/10, identity 10/10, adaptation 2/2, citation 48/48, expansion '
      + '19/19, scorer 12/12). npm run eval:chat:live asks the routed model 12 questions '
      + 'through the real prompt and scores RAW and SHIPPED separately: 11/12 raw (91.7%), 12/12 shipped (100.0%), '
      + 'no-reply=0 — every reply reached the member correct, one draft needed a verifier edit first, and the case '
      + 'that failed on the previous run (a curly-quoted refusal) is the bug recorded under modelTextNormalisation. '
      + 'The run that produced this number is served by groq, the funded standby, so it is the honest current state of '
      + 'the product rather than the state the prompts were tuned against; the verifier repaired 2 of 12 drafts. A '
      + 'run where fewer than 60% of the live cases get any reply is itself a failure, so a provider outage cannot be '
      + 'reported as accuracy, and CHAT_EVAL_PACE_MS (default 20000) spaces the twelve calls so Groq\'s free-tier rate '
      + 'limit cannot be misread as an accuracy failure. `--threshold=` and `--case=id,id` are there so the floor can '
      + 'be argued about and a '
      + 'failing case re-run without re-paying for the eleven that passed',
    retrievalGrounding: 'PASS 2026-10-20 — Test File/rag-retrieval.test.js: 13/13 over utils/ragCorpus.js (168 '
      + 'documents built synchronously from what the app already publishes) + utils/ragRetriever.js (BM25 k1 1.4 / b '
      + '0.75, no keys, no network, deterministic). Pins corpus uniqueness and byte-stability, every curated note '
      + 'keeping the identifier the app verified, a dose question returning the app ceiling first, everyday symptom '
      + 'phrasing ("I get migraines, what helps") reaching the notes that answer it, the nutrient the member named '
      + 'beating a nutrient merely related to it, the absence note always in front of the model on a how-do-I question, '
      + 'the member\'s own plan retrieved as a document instead of recalled from the prompt, a learned prior reordering '
      + 'notes without ever outranking the question, pronoun follow-ups retrieving on the conversation, references '
      + 'fenced as data / escaped / bounded, and the case that makes retrieval safe rather than merely clever: nothing '
      + 'the app hands over needs repairing before it ships',
    chatIdentity: 'PASS 2026-10-20 — Test File/chat-identity.test.js: 11/11. "What is my name" answers with the name on '
      + 'the account; an admin or alias session is given no identity at all; and email, phone, date of birth and '
      + 'clinician notes are withheld by an explicit ALLOWLIST projection (utils/chatIdentity.js) rather than by '
      + 'subtracting fields someone remembers to list — then named in the prompt, so the model cannot volunteer what it '
      + 'was never handed',
    feedbackLearning: 'PASS 2026-10-20 — Test File/chat-feedback-route.test.js: 7/7. A client may send only '
      + '{threadId, messageIndex, vote}; docIds, repairs and provider are read off the server-written AiChatThread.turns '
      + 'record, so nobody can train the ranking on notes they were never shown; another member\'s thread 404s with '
      + 'ownership inside the filter; malformed shapes 400; a re-vote updates the same row. Two real defects live in '
      + 'those seven: `invalidatePriors` existed but was never exported, so every POST /api/chat/feedback 500\'d AFTER '
      + 'writing the vote, and the route passed `priors: priorsForRetrieval()` — an un-awaited Promise, which '
      + 'retrieval read as an empty Map, so every published weight applied to nothing while the assistant kept '
      + 'answering merrily. The last case asserts both halves of that seam: a Map raises the score of the note it '
      + 'points at (16.788 → 26.86 on a real query), the un-awaited Promise changes nothing at all, and the route awaits',
    aiMonitorRow: 'PASS 2026-10-20 — Test File/monitor-probe-honesty.test.js: 11/11 with ai_chat_grounding and ai_provider_billing added to the '
      + 'Security Center (registered in Components/SecurityStatus/SecurityStatus.jsx as its own labelled, grouped, '
      + 'ordered row). The row does not report that a provider key loaded: it asks the retriever a question whose '
      + 'answer the app curates and demands that the curated dose document came back, checks that the '
      + '"feature does not exist" note still reaches a does-it-have-X prompt, and reports how many of the last 200 '
      + 'threads\' replies needed a verifier edit. Three of those are critical states, and the test forbids the probe '
      + 'from reading transcript text — turn metadata only',
    providerChain: 'PASS 2026-10-20 — Test File/ai-routing.test.js 66/66 + ai-default-provider.test.js 15/15. The incident '
      + 'this pins is a member reading the app\'s own offline apology twice, because the chat chain was Anthropic → '
      + 'OpenRouter: two valid keys on two accounts with no credit, and Groq\'s funded free tier served nothing. The '
      + 'router\'s documented boundary is deliberately NOT broken — the default provider stays a configuration-time '
      + 'stand-in and a provider that fails at request time still does not silently reach it (ai-default-provider.test.js '
      + 'asserts exactly that). What changed is that a route may declare a LIST of standbys instead of one: chat and '
      + 'polish name [openrouter, groq], assessment and supplementDetail name groq, and systemDetection plus '
      + 'priorityFlagging stay single-provider on purpose, because a weaker model must not become the reason a member '
      + 'is escalated when the primary account runs dry. A chain of unfunded providers is now walked to the funded one: '
      + 'a 400 credit-low, then a 402 never-purchased, then a completion, asserting provider=groq and three recorded '
      + 'attempts — so the failure is visible in the attempt list rather than swallowed. A refused provider now also '
      + 'carries its own sentence rather than a bare status: providerErrorDetail unwraps `error.message`, flattens an '
      + 'HTML gateway page, bounds it to 200 characters and redacts anything shaped like a key, which is how the '
      + '8,128-token assessment prompt was finally identifiable as a Groq free-tier TPM refusal instead of "HTTP 413."',
    providerBillingMonitor: 'PASS 2026-10-20 — utils/aiRouter.js now keeps the last real outcome per purpose and every '
      + 'credit-shaped failure it can name (Anthropic "credit balance is too low", OpenRouter "never purchased '
      + 'credits", OpenAI 429 insufficient_quota) in providerHealth(); routes/admin.js renders it as the '
      + 'ai_provider_billing row, registered in Components/SecurityStatus/SecurityStatus.jsx. Warning when no AI call '
      + 'has run since boot, critical when every purpose\'s last call failed, warning when a standby is carrying '
      + 'traffic because a primary is out of credit. Test File/monitor-probe-honesty.test.js 11/11 pins all three '
      + 'states and forbids the probe from dialling a provider itself — billing outages are invisible to a '
      + 'configuration probe, so the row reports what the last call DID rather than claiming a key is funded',
    modelTextNormalisation: 'PASS 2026-10-20 — utils/modelText.js, applied at the two seams that face outward: '
      + 'readCompletionText, where provider bytes become app text, and verifyProse, which also re-reads transcripts '
      + 'stored before this existed. Found by the live gate rather than by a test: Groq emits U+2019 where Anthropic '
      + 'emits ASCII, every negation guard in planGrounding.js is written can\'?t / doesn\'?t, and a curly quote is a '
      + 'word boundary — so "it can\u2019t send you a reminder" matched NO negation, read as an unqualified capability '
      + 'claim, and the verifier rewrote a correct refusal into boilerplate the member then read. Test File/'
      + 'model-text.test.js 4/4 pins the fold set (typographic quotes, non-breaking and figure dashes, thin and '
      + 'non-breaking spaces, zero-width characters, ellipsis) and proves a dose, an IU figure, a percentage and an '
      + 'accented word come back byte-identical: a spelling change, never a meaning change. En and em dash are '
      + 'deliberately NOT folded — the app writes an em dash in its own boilerplate and DOSE_NUMBER and CLAUSE_SPLIT '
      + 'already enumerate [-–—], and folding them broke verifyProse\'s idempotence contract, which the '
      + 'eval/hallucinationAudit.js sweep caught before it shipped',
    fieldStudyInputs: 'PASS 2026-10-20 — the project team\'s own community-pharmacy interview (October 2026, one '
      + 'respondent, purchasing patterns only, no patient identifiers) is now a bounded input to the product instead of '
      + 'a note in a document. Three paths: utils/ragCorpus.js `fieldStudyDocs()` adds 3 `kind: field` retrieval notes '
      + '(corpus 168), each with `pmids: []` and `nutrients: []` and no figure with a unit, so a field observation can '
      + 'be retrieved but can never be cited as clinical evidence or become a dose; eval/field-study-profiles.json adds '
      + '2 synthetic member profiles shaped by what the interview saw (58F on telmisartan, 67M on amlodipine + losartan '
      + '+ atorvastatin asking about the brands named locally) and they now run through `eval:ai`, `eval:fine-tune` and '
      + 'the shipped-baseline sweep in `eval:hallucination`, so the accuracy gates measure the member this research '
      + 'actually described; and utils/planGrounding.js gained telmisartan in `PRESCRIPTION_DRUG_NAMES`, which makes the '
      + 'fabricated-patient-fact guard and the refuse-to-stop-a-pill guard both see a medicine these members take. That '
      + 'widening exposed a real defect: a claim about a brand the app has no evidence entry for was being HEDGED — '
      + '"Santonn Plus is clinically proven to improve your vision" shipped as "Santonn Plus is reported to improve '
      + 'your vision", which launders an unverifiable product claim into something that reads sourced. '
      + '`enforceBrandClaims()` now replaces such a sentence with a line that names no product, so a brand can be '
      + 'mentioned but never credited with an effect. Test File/field-study.test.js: 16/16 pins the evidence-free field '
      + 'docs and their printed provenance, the brand question retrieving the brand note, the possessive-drug-claim '
      + 'repair, and two false-positive guards (a bare interaction sentence and a food word) plus idempotence.',
    selfLearning: 'PASS 2026-10-20 — Test File/condition-learning.test.js: 23/23. It pins the thresholds (24 h AND 25 unseen assessments, from the durable AiLearningRun ledger rather than process memory), the atomic lease that stops two processes spending the same quota, the kill switch, the no-file-writes rule for the scheduled path, the fact that index.js arms it, and that member contact fragments cannot reach a provider through an aggregate term',
    memberAdaptation: 'PASS 2026-10-20 — Test File/member-history.test.js: 23/23, plus plan-grounding 38/38, chat-safety 10/10, supplement-guide-store 35/35, ai-routing 66/66. Covers the resubmit-vs-reassessment window, adherence corrected to the member\'s own clock, escalation on a first-time symptom, the never-demote rule, and the fenced history block being read as data after the answers it is compared against',

    // GitHub Actions is where this record stops being a local claim. The server
    // job hung twice and was cancelled only after the runner\'s six-hour job limit,
    // and a cancelled step\'s log is not readable without a token — so the step was
    // bounded to 20 minutes and given a follow-up that runs each suite on its own
    // and annotates the one that does not settle. That named the culprit on its
    // first run: flood-guard.test.js never resolved when the refused upload was
    // closed with a clean FIN, because only the error path and a watchdog had a
    // `resolve`; the same pass named mfa-transaction.test.js, whose mail assertion
    // could not pass in a tree with no credentials. Both fixed, and the next run
    // was green — the server job now takes 1.6 minutes.
    continuousIntegration: 'PASS 2026-10-20 — the check suite for commit 04472ea (funded provider standby, billing monitor row, provider-text normalisation) is green on all three jobs: Server — syntax, tests, audit; Client — lint, build, tests, audit; Secret sweep, each `completed / success` as reported by the public commits/04472ea/check-runs endpoint. The previous green was run 106744561657 on commit f778442 (the RAG + identity + learning pass): Server 1.6 min, Client 0.7 min, Secret sweep 0.1 min. Before that, run 39232170080 on 2026-10-19 — the run that proved the bounded 20-minute test step and the per-suite pinpoint step, which has not needed to name a hanging suite since',
    productionBuild: 'PASS 2026-10-20 — npm run build in my-react-app: vite build clean, PWA v1.3.0 generateSW wrote dist/sw.js + workbox (96 precached entries, 2841.89 KiB). Re-taken for this pass; the same build succeeded earlier the same day',
    lint: 'PASS 2026-10-20 — npm run lint (eslint .) in my-react-app: 0 errors, 4 pre-existing react-hooks/exhaustive-deps warnings. .github/workflows/ci.yml\'s Lint step was fixed on 2026-10-19 (it passed --max-warnings=unlimited, which eslint rejects with exit 2 before linting anything)',
    // NOT a verdict any more. This line used to assert "npm audit: 0
    // vulnerabilities" as a standing fact, which is the exact failure mode F1
    // documents: the sentence stays green while the tree rots. The number is
    // measured live by the `dependency_audit` monitor (utils/dependencyAudit.js
    // asks npm about both shipped trees, production-only and full, caches the
    // answer, and reports an audit it could not run as a warning rather than a
    // healthy). Read that row; do not read this line.
    dependencyAudit: 'MEASURED LIVE by the dependency_audit monitor — utils/dependencyAudit.js, both shipped trees, prod + dev',
    devServers: 'PASS 2026-10-19 — the API on :5000 was restarted from this tree and both https://localhost:5000/api/health and https://localhost:5173/ answer 200; its stderr carries the one real finding, the db_least_privilege critical',
  },

  // ── Re-verification of the record itself, 2026-10-19 ──────────────────────
  //
  // Every openItems/verification claim above was read against the code as it
  // stands today, not against what the audit remembered. What changed:
  reverification: {
    date: '2026-10-19',
    method:
      'Each surviving claim was traced to the file and line that is supposed to enforce it, and the ones that no '
      + 'longer matched were corrected rather than re-worded. Where a claim was about a measurement (dependency '
      + 'advisories, TOTP math, session lifetimes) the measurement was re-taken.',
    changes: [
      'verification.continuousIntegration added, with the six-hour CI hang reduced to a bounded 20-minute step that names whichever suite hangs — and confirmed by the run after it, which was green on all three jobs.',
      'verification.unitTests and verification.syntaxCheck re-measured (1609/1609, 322 files) after two test-harness defects were fixed. Test File/e2eServer.js handed its test server `EMAIL_ENABLED=false` and described that as "never send real mail from a test run" — no code reads that variable, so a developer with credentials in `.env` really did send OTP mail while the suite ran, and CI, which has no `.env`, could deliver nothing and failed every email-based assertion. Test File/stubSmtp.js now runs a loopback capture transport, so the branch under test is reached on both machines and no mail can leave. The stub is itself covered by Test File/stub-smtp.test.js.',
      'L5 closed — /forgot-password cannot enumerate: one generic body for every address, no userId, constant-time padding on the no-account branch (utils/passwordReset.js).',
      'L6 closed — no code path mails a plaintext admin password; provisioning reads hashes from ADMIN_ACCOUNTS and mustChangePassword forces a change before the account is usable (utils/adminAccounts.js, routes/admin.js).',
      'I4 closed — speakeasy replaced in-repo by utils/totpRfc.js and removed from the dependency tree; axios had already gone.',
      'L3 corrected — the admin token is 15 minutes sliding with a 10-minute idle bound and outright revocation at sign-out (utils/adminSession.js), not the "5-minute TTL / 3:30 kill" this record quoted.',
      'verification.dependencyAudit demoted from an assertion to a pointer at the live dependency_audit monitor.',
      'manualActions[0] is now executable. It has said "rotate JWT_SECRET" since 2026-09-23 and stayed undone for a mechanical reason: one accepted key means the restart that installs the new secret invalidates every token already issued, so rotation always looked more dangerous than deferral. utils/jwtKeyring.js now verifies against JWT_SECRET plus any key retained in JWT_SECRET_PREVIOUS_KEYS, and the jwt_secret_rotation monitor reports whether a rotation would lose data (the encryption keys fall back to this secret) and when the retained key can safely be deleted. Rotating is still an operator action — but it is now an action rather than an outage.',
    ],
    totpReplacement: {
      why:
        'speakeasy has had no release since 2019 and its base32/HMAC behaviour is exactly what an enrolment is '
        + 'pinned to. Replacing it is only safe if the codes stay identical, so the swap was measured, not assumed.',
      evidence:
        'Test File/totp-rfc6238.test.js pins golden codes captured from speakeasy 2.0.0 against the seeds already '
        + 'in production, including the 52-char seed whose base32 decode keeps a left-aligned partial byte — the '
        + 'one difference that would have silently locked every enrolled admin out. RFC 6238 Appendix B vectors, '
        + 'the ±1-step window, the window cap, malformed-token refusal and non-base32-secret refusal are all '
        + 'asserted. The file also fails the suite if any runtime file requires speakeasy again or either manifest '
        + 'declares it.',
      acceptedRisk:
        'The dev dependency tree still reports advisories (nodemon -> chokidar -> braces). They are not reachable '
        + 'from a request: nodemon is a file watcher run by the developer, never by the deployed API, which starts '
        + 'with plain node and installs --omit=dev. There is no in-range fix — npm audit fix resolves nothing, and '
        + 'its "fixAvailable" is a semver-major DOWNGRADE to nodemon 1.14.10, while nodemon@latest still depends on '
        + 'chokidar ^3.5.2, the vulnerable line. The dependency_audit monitor reports this split honestly instead '
        + 'of hiding it, which is why it is recorded here as accepted rather than fixed.',
    },
    liveMonitor:
      'MEASURED 2026-10-19 — GET /api/admin/security/monitor?fresh=1 on this tree: 59 rows, 55 healthy, 1 warning, '
      + '3 critical, no probe error and no timeout. The warning is backup_currency (no dump, no drill). The three '
      + 'criticals are all real and all operator-side: db_least_privilege (the Atlas user holds atlasAdmin, not '
      + 'readWrite on one database); seal_integrity (ONE member seed, envelope key w-n00ezVF7e, was sealed under a '
      + 'key no current secret can derive — see the manual action below); and jwt_secret_rotation (the health-data '
      + 'key and the seed-sealing key still fall back to JWT_SECRET, so the URGENT rotation would orphan stored '
      + 'ciphertext unless HEALTH_DATA_KEY_PREVIOUS and TOTP_ENCRYPTION_KEY_PREVIOUS are declared first).',
  },

  manualActions: [
    'URGENT: rotate JWT_SECRET — the old value is permanently in public git history and must be treated as burned. '
    + 'How, without an outage: put the NEW value in JWT_SECRET and the OLD one in JWT_SECRET_PREVIOUS_KEYS, then '
    + 'restart (server/index.js resolves both into the keyring and jwt.verify gets every candidate, so tokens '
    + 'signed before the restart keep working through the overlap). Once everyone has signed in again, delete '
    + 'JWT_SECRET_PREVIOUS_KEYS on the next deploy — that second step is what actually retires the burned secret, '
    + 'and it is the step that gets forgotten.',
    'URGENT: change all six admin passwords (they were published in plaintext).',
    'URGENT: regenerate all six TOTP seeds and re-enrol them in each authenticator app. '
    + 'PARTIAL as of 2026-10-15: five of the six were re-seeded — they had been stored comma-glued together and '
    + 'could not be signed into at all — and the new keys were emailed to their owners. Re-enrolment is still on '
    + 'those owners, so until each has paired the new seed, "regenerated" does not mean "usable".',
    'URGENT: revoke and reissue the Gmail App Password (published in Security_Fixes_and_Analysis.md).',
    'Purge secrets from git history (history rewrite) — or assume they are known, since the remote is public.',
    'Decide whether this repository should be public at all.',
    'OPERATIONAL: if this API runs behind a reverse proxy or load balancer, set TRUST_PROXY=true — otherwise every client resolves to the proxy address and IP lockouts bucket all users together.',
    'OPERATIONAL: `npm run serve:prod` (my-react-app) serves the built dist/ with X-Frame-Options and Content-Security-Policy: frame-ancestors \'none\' as real headers. If you deploy dist/ to some OTHER host — Netlify, Vercel, nginx, Cloudflare — that host must send the same headers; copy them from `securityHeaders` in my-react-app/vite.config.js so the policy stays one policy.',
    'Keep the new CI green. `npm audit` is now a gate, which is the only reason the nodemailer advisories were caught at all; do not let it be skipped or made non-blocking.',
    'OPERATIONAL: one member authenticator seed (envelope key w-n00ezVF7e) was sealed under a key that no secret '
    + 'this machine holds can derive — it predates the current JWT_SECRET and is not the deploy stack key either, so '
    + 'it is unrecoverable, not merely unconfigured. That account signs in today on the emailed code alone while its '
    + 'app still shows 2FA as enabled. Either restore the old JWT_SECRET into TOTP_ENCRYPTION_KEY_PREVIOUS if one is '
    + 'kept offline, or have that member turn 2FA off and re-pair it. Do not clear the field for them: that is their '
    + 'second factor, not a stale row to tidy away. seal_integrity reports critical until one of the two happens.',
    'OPERATIONAL: the admin database user should hold `readWrite` on ONE database. It currently holds broader '
    + 'privileges on the cluster, which is why db_least_privilege reports critical — an application credential that '
    + 'can write to other databases turns any SQL-style injection into a cluster-wide problem. This is an Atlas '
    + 'setting, not a code change.',
    'OPERATIONAL: take a backup and PROVE it restores (`npm run backup` then `npm run backup:drill`). '
    + 'backup_currency reports a warning because no drill receipt exists yet; an undrilled dump is a hypothesis, '
    + 'and this project has already lost ledger history to exactly that assumption.',
    'OPERATIONAL (F13): before editing utils/supplementEvidenceRegistry.js, derive each citation FROM NCBI — search '
    + 'by nutrient plus the claimed outcome plus study type, and take the PMID of a paper whose title names the '
    + 'nutrient. Then run `npm run eval:citations` (server/): it resolves every PMID in the registry against NCBI '
    + 'E-utilities at 3 requests/second and exits non-zero on a drift or a title that does not name the nutrient. '
    + 'It needs network and can fail on NCBI being unreachable, so it is a pre-ship gate, not a CI step. '
    + '`npm run eval:ai:live` is the matching model-side gate: it sends the real assessment prompt for the six '
    + 'baseline and field-study profiles and prints each plan twice — before and after utils/planGrounding.js — so a regression in '
    + 'what the model returns is visible as repairs the gate had to make. It spends API tokens, so run it on demand, '
    + 'not on every commit.',
    'OPERATIONAL (F14): `npm run eval:hallucination` (server/) is the prose-side gate and needs no network. It hands '
    + 'the verifier 22 canned hallucinations and 14 sentences that are true, every shipped baseline plan, and 1,152 '
    + 'combined texts to prove a second pass changes nothing, then exits non-zero if a hallucination survives, a true '
    + 'sentence is damaged, or the verifier is not idempotent. When a member reports an inaccurate answer, add it to '
    + 'CHALLENGES; when curated copy is wrongly rewritten, add it to GUARDS. A rule with no case pinned to it gets '
    + 'un-done by the next rule. `npm run eval:hallucination:live` also asks the routed model the baited questions and '
    + 'prints its raw violation rate beside what actually shipped; it spends tokens and a provider outage fails it, so '
    + 'it is a pre-ship measurement, not a CI step.',
    'OPERATIONAL (F15): `npm run eval:chat` (server/) is the accuracy gate this record did not have, and it needs no '
    + 'network and no keys — it scores retrieval, refusal, identity, citation, adaptation, alias expansion and the live '
    + 'scorers themselves against a 90% floor per category and overall, and exits non-zero on any miss, so "the AI is '
    + 'accurate" is a number rather than a feeling. `npm run eval:chat:live` spends provider quota to ask the routed '
    + 'model the same questions through the real prompt and prints RAW beside SHIPPED; run it before shipping a prompt '
    + 'or corpus change, and re-run one failing case with `--case=id` instead of paying for all twelve. The discipline '
    + 'that makes it worth having: when a member reports a wrong answer, add it as a case — the gold document plus the '
    + 'sentence that must be in the reference block, or the refusal it owes — BEFORE editing the retriever, because a '
    + 'fix no case pins is a fix the next tuning pass undoes. `ai_chat_grounding` in the admin Security Center is the '
    + 'production-side view of the same two invariants: it re-asks a curated dose question and a does-it-have-X question '
    + 'on every monitor refresh and goes critical when either document stops reaching the prompt, and warns when the '
    + 'reply-repair rate climbs or nobody has voted in thirty days, which is the learning loop being armed but not fed.',
    'OPERATIONAL (AI provider billing): three accounts this machine holds keys for hold no credit — Anthropic answers '
    + 'HTTP 400 "credit balance is too low", OpenRouter 402 "never purchased credits", OpenAI 429 '
    + 'insufficient_quota — so every generated answer is currently served by Groq\'s free tier, which is funded but '
    + 'holds 8,000 tokens per minute on service tier `on_demand`. That limit shapes what the free tier can do: chat '
    + 'fits and answers (a long reply can still trip 429 about once every 20 seconds, so pace it), and the assessment '
    + 'prompt does not — measured at 8,128 tokens, it is refused with HTTP 413 before the model sees it, which is why '
    + 'AI-generated plans are not working today and the rule engine is answering them. Funding Groq alone will not '
    + 'bring plan generation back; OpenRouter, Anthropic or OpenAI will. Add credit to one of those, or set '
    + 'AI_DEFAULT_PROVIDER=groq and accept free-tier chat plus rule-engine plans. Until then the router walks to the '
    + 'funded standby instead of dead-ending, ai_provider_billing says which account is out, the provider\'s own '
    + 'rejection sentence is carried in the attempt list rather than a bare status code, and '
    + '`npm run eval:chat:live` paces itself (CHAT_EVAL_PACE_MS, default 20000) so a rate limit cannot be misread as '
    + 'an accuracy failure.',
    'OPERATIONAL (the self-learning loop): it is armed from API boot (index.js → utils/conditionLearning.schedule()) '
    + 'and needs no operator to remember it, which is exactly why it needs watching rather than trusting. Read the '
    + 'ai_learning row in the admin Security Center: it says how many assessments are new since the last cycle, how '
    + 'many learned conditions are live, and reports warning or critical when the loop is disabled, has never '
    + 'completed, or has failed three cycles running. `npm run learning:conditions` runs one cycle by hand through the '
    + 'same lease and the same evidence gate; `CONDITION_LEARNING=false` switches it off. Both spend provider quota '
    + 'and read aggregate health data, so neither belongs in CI. What the loop may change is bounded by the gate: a '
    + 'candidate publishes only when every supplement it carries cites an authoritative source with a well-formed '
    + 'PMID, and rejected candidates are recorded in ConditionProposal with the reason — nothing there is a human '
    + 'approval, and nothing a model invents becomes product.',
  ],

  disclaimer:
    'This audit covers the application source in this repository as reviewed on 2026-09-23, re-read against the '
    + 'code on 2026-10-19 (see `reverification`), and extended on 2026-10-20 with F13 — the fabricated citations the '
    + 'app itself shipped in every wellness plan — and with the AI feature pass that closed the rest of that gap: '
    + 'every generative surface (assessment plans, chat, polished text, supplement guides) is now verified against '
    + 'the app\'s own evidence after generation instead of trusted before it, the questionnaire learns from real '
    + 'assessment data on a schedule instead of when someone remembers to run a script, and a plan reads the '
    + 'member\'s own previous plan, symptom delta and adherence instead of answering as if the member had never '
    + 'been here before. The same day closed the last of that with F14: free prose — a chat reply, a polished answer, '
    + 'a supplement guide — is now checked sentence by sentence for invented citations, unsourced statistics in any '
    + 'unit, doses above the published range, cure and certainty claims, advice to change a named prescription, and '
    + 'lab values or conditions the member never reported. F15, also 2026-10-20, is the offensive half of the same '
    + 'claim rather than the defensive one: the assistant now retrieves what the app has already published before it '
    + 'answers, knows the member it is talking to inside an allowlist, records which notes it was shown and whether it '
    + 'had to edit the reply, learns from the votes cast against those records, and is scored per category against a '
    + '90% accuracy floor offline and live. It is not a penetration ' +
    'test and does not certify the system as secure or "100% protected". Infrastructure, the database cluster, the ' +
    'dependency supply chain, third-party APIs, and social-engineering vectors were out of scope. Several findings ' +
    'remain open until the manual rotations above are completed, and secrets that have ever been committed must be ' +
    'treated as compromised for as long as they exist.',

  report: 'SECURITY_AUDIT_REPORT.md',
};

module.exports = { SECURITY_AUDIT };
