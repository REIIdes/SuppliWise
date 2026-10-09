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

  counts: {
    total: 30,
    critical: 2,
    high: 8,
    medium: 9,
    low: 7,
    informational: 4,
    remediatedInCode: 23,
    openOrAccepted: 7,
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
  ],

  // Findings that are deliberately NOT closed by a code change, plus the
  // ones only an operator can finish. Hiding these would be dishonest.
  openItems: [
    {
      id: 'L3',
      severity: 'low',
      title: 'Admin bearer token stored in localStorage',
      note:
        'Mitigated by the new CSP, a 5-minute token TTL and the 3:30 admin idle kill, but localStorage is still ' +
        'script-readable. A full fix means moving the admin credential to an httpOnly, SameSite cookie — an API ' +
        'contract change that needs its own test pass.',
    },
    {
      id: 'L5',
      severity: 'low',
      title: 'forgot-password still returns a userId for unknown-vs-known accounts',
      note: 'Responses are generic, but a successful response carries a userId an unknown address does not.',
    },
    {
      id: 'L6',
      severity: 'low',
      title: 'Admin provisioning email carries a plaintext password and TOTP seed',
      note: 'Intentional first-run delivery over TLS. Rotate on first sign-in and consider a forced-change flow.',
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
    {
      id: 'I4',
      severity: 'informational',
      title: 'speakeasy is unmaintained; axios is a dependency with no importer',
      note: 'Both are low risk. speakeasy is only used for TOTP math; consider otplib or a maintained RFC-6238 lib.',
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
    ],
    reVerification: {
      serverUnitTests: 'PASS — 990/990, 0 skipped, exits cleanly (originally 796 with 40 silently skipped)',
      syntaxCheck: 'PASS — npm run check: 201 source files, and proven to fail on a deliberately broken file',
      clientUnitTests: 'PASS — 299/299',
      glitchHunt: 'PASS — 122/122',
      glitchHuntWeb3: 'PASS — 133/133',
      web3Flows: 'PASS — 81/81',
      sessionFlows: 'PASS — all checks',
      subscriptionFlows: 'PASS — exit 0',
      subscriptionAdmin: 'PASS - 66/66',
      // `test-subscription-teams.js` was deleted along with the per-seat Team
      // plan it exercised. There is no longer a script by that name to report on.
      subscriptionTeams: 'REMOVED - the per-seat Team plan no longer exists',
      ddosResilience: 'PASS — 3432 requests, 0 5xx, 0 connection errors, 0 timeouts, recovered unaided',
      adminUserIsolation: 'PASS — 13/13',
      supportChat: 'PASS — 74/74',
      blockchainMonitor: 'PASS — all subsystems HEALTHY',
      syntaxCheck: 'PASS — npm run check',
      lint: 'PASS — eslint: 0 errors',
      productionBuild: 'PASS — vite build, PWA service worker generated',
      dependencyAudit: 'PASS — npm audit: 0 vulnerabilities (server and client, prod + dev)',
      liveBrowser: 'PASS — app renders, routes guard correctly, CSP observed enforcing, no app console errors',
      secretSweep: 'PASS — no hash or TOTP-seed shaped values in tracked docs; server/.env is untracked',
    },
  },

  verification: {
    unitTests: 'PASS — node --test "Test File/*.test.js"',
    syntaxCheck: 'PASS — npm run check',
    productionBuild: 'PASS — vite build (287 modules, PWA service worker generated)',
    lint: 'PASS — eslint: 0 errors (4 pre-existing react-hooks warnings)',
    dependencyAudit: 'PASS — npm audit: 0 vulnerabilities (server and client, prod + dev)',
    devServers: 'PASS — API and Vite dev server both answering 200 after the changes',
  },

  manualActions: [
    'URGENT: rotate JWT_SECRET — the old value is permanently in public git history and must be treated as burned.',
    'URGENT: change all six admin passwords (they were published in plaintext).',
    'URGENT: regenerate all six TOTP seeds and re-enrol them in each authenticator app.',
    'URGENT: revoke and reissue the Gmail App Password (published in Security_Fixes_and_Analysis.md).',
    'Purge secrets from git history (history rewrite) — or assume they are known, since the remote is public.',
    'Decide whether this repository should be public at all.',
    'OPERATIONAL: if this API runs behind a reverse proxy or load balancer, set TRUST_PROXY=true — otherwise every client resolves to the proxy address and IP lockouts bucket all users together.',
    'OPERATIONAL: `npm run serve:prod` (my-react-app) serves the built dist/ with X-Frame-Options and Content-Security-Policy: frame-ancestors \'none\' as real headers. If you deploy dist/ to some OTHER host — Netlify, Vercel, nginx, Cloudflare — that host must send the same headers; copy them from `securityHeaders` in my-react-app/vite.config.js so the policy stays one policy.',
    'Keep the new CI green. `npm audit` is now a gate, which is the only reason the nodemailer advisories were caught at all; do not let it be skipped or made non-blocking.',
  ],

  disclaimer:
    'This audit covers the application source in this repository as reviewed on 2026-09-23. It is not a penetration ' +
    'test and does not certify the system as secure or "100% protected". Infrastructure, the database cluster, the ' +
    'dependency supply chain, third-party APIs, and social-engineering vectors were out of scope. Several findings ' +
    'remain open until the manual rotations above are completed, and secrets that have ever been committed must be ' +
    'treated as compromised for as long as they exist.',

  report: 'SECURITY_AUDIT_REPORT.md',
};

module.exports = { SECURITY_AUDIT };
