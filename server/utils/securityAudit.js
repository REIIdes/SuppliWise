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
        'mitigated — CSP meta added (external script hosts and eval refused). frame-ancestors must still be set as ' +
        'an HTTP header; the policy must be re-verified in a live browser.',
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
    'H8  my-react-app/index.html — Content-Security-Policy meta (allowlist script/style/img/font/worker sources).',
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
        'concurrent requests. Residual: those two upload routes still parse up to 10 MB, by design.',
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
      note: 'Nothing runs the test suite or `npm audit` on push. Adding CI is the cheapest way to keep this audit honest.',
    },
    {
      id: 'I4',
      severity: 'informational',
      title: 'speakeasy is unmaintained; axios is a dependency with no importer',
      note: 'Both are low risk. speakeasy is only used for TOTP math; consider otplib or a maintained RFC-6238 lib.',
    },
  ],

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
    'Serve frame-ancestors / X-Frame-Options as HTTP headers for the client origin (a <meta> tag cannot carry them).',
    'Verify the new Content-Security-Policy in a live browser (browser tooling was unavailable during this audit).',
    'Re-run the 30-item audit after rotation and after CI is in place.',
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
