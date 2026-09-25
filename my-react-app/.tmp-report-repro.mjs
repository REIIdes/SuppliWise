// Temporary repro: security report layout overlap
import { downloadSecurityReport } from './src/utils/securityReport.js';

const monitors = [
  ['health_records_anchor', 'Health Records Anchor', 'healthy', '2 health snapshot(s), 2 committed with block refs - digest covers every assessment and intake, so record tampering is detectable.', 189],
  ['encrypted_storage', 'Encrypted Decentralized Storage', 'healthy', '2 object(s) (240 bytes) content-addressed by CID and encrypted with AES-256-GCM - no plaintext at rest, and the CID itself binds the content hash.', 320],
  ['achievement_nfts', 'Achievement NFTs', 'healthy', '8 achievement NFT(s) minted with globally unique tokenIds, each carrying its on-chain mint txHash. Gallery eligibility derives from the same reward events above.', 216],
  ['token_staking', 'Token Staking', 'healthy', '3 holder(s) staking 43 WELL total. APY (stakeApyPct) accrues daily and is governed by the DAO; staked >= 500 unlocks premium perks.', 233],
  ['key_management', 'Key Management Envelope', 'healthy', 'ed25519 signing keys stored only inside AES-256-GCM envelopes - plaintext keys are never persisted. One-time welcome airdrop on first access.', 96],
  ['login', 'Login flow', 'healthy', 'JWT issued with short TTL and rotating refresh tokens; brute-force lockout armed.', 74],
  ['account_creation', 'Account creation', 'healthy', 'Email verification required before first token is issued.', 81],
  ['email_otp', 'Email OTP challenge', 'healthy', 'OTP hashed at rest, single use, 5 minute expiry, 3 attempt ceiling.', 122],
  ['totp', 'TOTP second factor', 'healthy', 'TOTP secrets encrypted with AES-256-GCM and never returned by any endpoint.', 143],
  ['database', 'Database access', 'warning', 'Read replica failover not configured; primary restart would drop in-flight writes.', 402],
  ['openrouter', 'AI provider key', 'healthy', 'Provider key scoped server-side only; never shipped to the client bundle.', 158],
  ['delete_account', 'Account deletion', 'healthy', 'Cascades sessions, subscriptions and cached AI artifacts within 24 hours.', 191],
  ['input_sanitization', 'Input sanitization', 'healthy', 'All write endpoints run schema validation before touching the driver.', 88],
  ['password_hashing', 'Password hashing', 'healthy', 'bcrypt cost factor 12 with per-user salt.', 63],
  ['salting', 'Password salting', 'healthy', 'Unique 16 byte salt per account.', 58],
  ['xss_stored', 'Stored XSS surface', 'healthy', 'Stored chat content is escaped on render and sanitized on write.', 105],
  ['nosql_injection', 'NoSQL injection', 'healthy', 'Operator keys stripped from user supplied objects before queries.', 92],
  ['path_traversal', 'Path traversal', 'healthy', 'Static file resolver rejects .. segments and resolves inside the app root.', 77],
  ['prototype_pollution', 'Prototype pollution', 'healthy', 'JSON body parser configured to ignore __proto__ and constructor keys.', 69],
  ['auth_bruteforce', 'Auth brute force', 'healthy', 'Lockout ladder: 5 attempts, escalating cooldown, IP and account scoped.', 111],
  ['csrf_stateless', 'CSRF posture', 'healthy', 'Stateless bearer tokens in memory; no ambient credential forwarding.', 84],
  ['prompt_injection', 'Prompt injection filter', 'warning', 'System prompt hardening present but no output classifier on free text.', 247],
  ['pii_ai_prompts', 'PII in AI prompts', 'healthy', 'Names and ages redacted before any outbound AI request.', 166],
  ['ai_quota', 'AI quota', 'healthy', 'Per user daily token budget enforced at the gateway.', 129],
  ['jwt_security', 'JWT hardening', 'healthy', 'HS256 with rotating secret, audience and issuer claims validated.', 71],
  ['headers_security', 'Security headers', 'healthy', 'CSP, HSTS, frame-ancestors and referrer policy all present.', 64],
  ['email_enumeration', 'Email enumeration', 'healthy', 'Login and reset share identical timing and responses.', 95],
  ['sensitive_data', 'Sensitive data at rest', 'healthy', 'PII columns encrypted with AES-256-GCM; keys held in app secrets.', 137],
  ['rate_limit_lockout', 'Rate limiting', 'healthy', 'Per family limiters plus coarse global flood guard.', 86],
  ['bc_dao', 'DAO governance', 'critical', 'Multisig threshold is 2 of 5; policy requires 3 of 5 for treasury moves.', 284],
  ['bc_oracle', 'Price oracle feed', 'warning', 'Fallback oracle heartbeat is 15 minutes; stale quotes possible.', 311],
].map(([key, label, status, detail, latencyMs]) => ({ key, label, status, detail, latencyMs }));

const checks = Array.from({ length: 23 }, (_, i) => ({
  status: i < 2 ? 'critical' : i < 8 ? 'vulnerable' : 'secure',
  framework: i % 3 === 0 ? 'OWASP' : 'STRIDE',
  label: `Control ${i + 1}: ${['Session rotation', 'Secret storage', 'Output encoding', 'Least privilege', 'Audit trail'][i % 5]}`,
  fix: i % 2 ? 'Rotate keys quarterly' : 'Harden configuration',
}));

const recommendations = Array.from({ length: 8 }, (_, i) => ({
  priority: i < 2 ? 'critical' : i < 5 ? 'high' : 'medium',
  title: `Remediation item ${i + 1}`,
  fix: 'Apply the documented control and re-run the scan to confirm.',
}));

const security = {
  checks,
  recommendations,
  overallStatus: 'vulnerable',
  lastScanned: '2026-09-25T08:00:00Z',
  audit: {
    scope: 'Express/Mongoose API (server/) and React/Vite client (my-react-app/) - authentication, sessions, lockouts, entitlements, data access, secrets management, logging, and client-side output handling.',
    counts: { critical: 2, high: 8, remediatedInCode: 23, openOrAccepted: 7 },
    headlineFindings: [
      { severity: 'critical', title: 'DAO treasury threshold too low', detail: 'Multisig accepts 2 of 5 signatures for treasury moves.' },
      { severity: 'high', title: 'Prompt output not classified', detail: 'Model output is returned to users without a safety classifier.' },
    ],
    openItems: [
      { severity: 'high', title: 'Legacy reset tokens', detail: 'Tokens issued before the rotation are still accepted.' },
      { severity: 'medium', title: 'Replica failover', detail: 'Read replica failover is not configured.' },
      { severity: 'low', title: 'CSP report endpoint', detail: 'report-uri not wired to a collector.' },
      { severity: 'medium', title: 'Stale oracle heartbeat', detail: 'Fallback oracle heartbeat is 15 minutes.' },
    ],
  },
};

const result = await downloadSecurityReport({
  security,
  overview: { metrics: { users: 128, activeSubscriptions: 41 } },
  save: true,
});
console.log('generated:', JSON.stringify(result));
