'use strict';
/**
 * The edges that answer for the whole system: proxy, containers, and the small
 * honesty bugs on the way through.
 *
 * The nginx rule that bites is the one nobody expects: a `location` that
 * declares ANY `add_header` inherits NONE of the server-level ones. So framing
 * protection silently vanished from `/assets/` and `/index.html` responses the
 * moment those blocks needed their own Cache-Control, and the symptom was a
 * clickjacking report against a config that "sets X-Frame-Options".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const REPO = path.resolve(__dirname, '..');
const NGINX = fs.readFileSync(path.join(REPO, '..', 'deploy', 'nginx.conf'), 'utf8');
const COMPOSE = fs.readFileSync(path.join(REPO, '..', 'docker-compose.yml'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8');
const VITE_SRC = fs.readFileSync(path.join(REPO, '..', 'my-react-app', 'vite.config.js'), 'utf8');
const SMS_SRC = fs.readFileSync(path.join(REPO, 'utils', 'sms.js'), 'utf8');
const AUTH_SRC = fs.readFileSync(path.join(REPO, 'routes', 'auth.js'), 'utf8');
const SURVEY_SRC = fs.readFileSync(path.join(REPO, 'routes', 'survey.js'), 'utf8');
const CHAT_SRC = fs.readFileSync(path.join(REPO, 'routes', 'adminSupportChats.js'), 'utf8');

/** Config with comments removed — prose says "add_header" as often as nginx does. */
const withoutComments = (text) => text.replace(/^\s*#.*$/gm, '');

/** The add_header names declared at server level (before the first location). */
function serverLevelHeaders() {
  const cfg = withoutComments(NGINX);
  const head = cfg.slice(0, cfg.indexOf('  location '));
  return [...head.matchAll(/add_header\s+([A-Za-z-]+)/g)].map((m) => m[1]);
}

/** Every location block, as { name, body }. */
function locations() {
  const out = [];
  const cfg = withoutComments(NGINX);
  const re = /location\s+([^\n{]*)\{([\s\S]*?)\n  \}/g;
  let m;
  while ((m = re.exec(cfg)) !== null) out.push({ name: m[1].trim(), body: m[2] });
  return out;
}

test('every location that sets a header sets ALL of them', () => {
  const required = serverLevelHeaders();
  assert.ok(required.includes('X-Frame-Options'), 'precondition: the server block declares framing protection');
  const offenders = locations()
    .filter((l) => /add_header/.test(l.body))
    .filter((l) => !required.every((h) => l.body.includes(`add_header ${h}`)))
    .map((l) => l.name);
  assert.deepEqual(offenders, [],
    'nginx gives a location with its own add_header NONE of the server-level ones — these blocks would answer without framing or nosniff');
});

test('the proxy ceiling sits above the API ceiling, so the API is the one that decides', () => {
  const nginxBytes = Number(NGINX.match(/client_max_body_size\s+(\d+)m/)[1]) * 1024 * 1024;
  const apiBytes = Number(INDEX_SRC.match(/JSON_UPLOAD_LIMIT_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/)[1]) * 1024 * 1024;
  assert.ok(nginxBytes > apiBytes,
    `nginx must answer 413 only ABOVE the API limit (nginx ${nginxBytes} vs api ${apiBytes}) — below it, the visitor gets an HTML error page where the app would have said "image too large"`);
  assert.ok(nginxBytes - apiBytes <= 4 * 1024 * 1024, 'and it is not a blank cheque either');
});

test('nginx does not re-introduce the buffering the SSE fix removed', () => {
  const api = locations().find((l) => l.name.startsWith('/api/'));
  assert.ok(api, 'the /api/ proxy block exists');
  assert.match(api.body, /proxy_buffering off;/, 'a buffered proxy holds every event until the buffer fills');
  const gzipTypes = NGINX.match(/gzip_types([^;]*);/)[1];
  assert.doesNotMatch(gzipTypes, /text\/event-stream/, 'and gzip must not be told to compress an event stream either');
});

test('the header list is copied from the app, not restated from memory', () => {
  // vite.config.js is what dev serves and what a static host reads out of
  // index.html; nginx is what production answers with. They drift silently
  // unless something compares the two, and a drifted CSP is a security control
  // that exists in exactly one of the two environments.
  const declared = [...VITE_SRC.matchAll(/^\s*'([A-Za-z-]+)':\s*(?:'([^']*)'|"([^"]*)"),/gm)]
    .map((m) => [m[1], m[2] !== undefined ? m[2] : m[3]]);
  assert.ok(declared.length >= 4, `precondition: securityHeaders parsed, got ${declared.length}`);
  const cfg = withoutComments(NGINX);
  for (const [name, value] of declared) {
    const line = cfg.match(new RegExp(`add_header ${name} "([^"]*)"`));
    assert.ok(line, `nginx must send ${name}`);
    assert.equal(line[1], value, `nginx's ${name} must equal the app's, not merely exist`);
  }
});

test('the version of the web server is not announced', () => {
  assert.match(NGINX, /^\s*server_tokens off;/m);
});

test('the two containers that handle requests are hardened, and the API is not directly reachable', () => {
  const services = {};
  const blocks = COMPOSE.split('\n  ').filter((b) => /^\S+:/);
  for (const raw of COMPOSE.split(/\n(?=  [a-z-]+:\n)/)) {
    const name = raw.match(/^  ([a-z-]+):/);
    if (name) services[name[1]] = raw;
  }
  for (const svc of ['api', 'web']) {
    assert.ok(services[svc], `${svc} exists`);
    assert.match(services[svc], /\n\s+init: true/, `${svc} needs an init reaper: PID 1 ignoring SIGTERM means a stopped container, not a stopped process`);
    assert.match(services[svc], /no-new-privileges:true/, `${svc} must not let a exploited process gain capabilities`);
  }
  // Loopback binding is the PRECONDITION for trusting Caddy's forwarded-for
  // chain: the API reads the rightmost entry, which is only trustworthy if
  // nothing outside this host can put a value there.
  assert.match(services.web, /127\.0\.0\.1:8080:80/, 'web must not take internet connections directly');
  assert.doesNotMatch(services.api || '', /^\s*-\s+"(?:5000|\d{2,5}:\d+)/m, 'the API publishes no host port');
  assert.match(INDEX_SRC, /TRUST_PROXY === 'true'[\s\S]{0,60}trust proxy', 1/, 'and the app trusts exactly one hop, no more');
});

// ── The small honesty bugs ────────────────────────────────────────────────
test('a development SMS transport refuses to run in production, and shouts when it runs anywhere undefined', () => {
  assert.match(SMS_SRC, /if \(process\.env\.NODE_ENV === 'production'\) \{\s*\n\s*return \{ ok: false, reason: 'development-transport-disabled' \};/);
  // The dangerous host is not `NODE_ENV=development`, it is the one that never
  // set NODE_ENV at all — index.js's boot refusal is `=== 'production'`, so an
  // unset mode slips past and live sign-in codes go into a shared log.
  assert.match(SMS_SRC, /!\['development', 'test'\]\.includes\(process\.env\.NODE_ENV\)/);
  assert.match(SMS_SRC, /Live verification codes are being written to this log/);
  // Warned once, not per code: a flood of sends must not flood the log it is
  // complaining about.
  const decl = SMS_SRC.match(/let devSmsWarned/g);
  assert.equal(decl.length, 1, 'the latch is declared exactly once — a duplicate `let` in the same scope is a SyntaxError at require time');
});

test('the OTP window the user is told is the window that is enforced', () => {
  // Both numbers now live in utils/otpChallenge.js. auth.js restating a literal
  // is how a message ends up promising five minutes while the code spends four.
  const otpChallenge = require('../utils/otpChallenge');
  assert.equal(otpChallenge.CODE_TTL_MS, 5 * 60 * 1000);
  assert.equal(otpChallenge.RESEND_COOLDOWN_MS, 30 * 1000);
  assert.match(AUTH_SRC, /const OTP_TTL_MS = otpChallenge\.CODE_TTL_MS;/);
  assert.match(AUTH_SRC, /const OTP_COOLDOWN_MS = otpChallenge\.RESEND_COOLDOWN_MS;/);
  assert.doesNotMatch(AUTH_SRC, /const OTP_TTL_MS = \d/, 'no second copy of the number');
});

test('a survey answer cannot be attached to another account assessment', () => {
  // The id used to be stored verbatim from the body: any member could point a
  // response at another account's assessment, and the admin report joins on it.
  assert.match(SURVEY_SRC, /Assessment\.exists\(\{ _id: assessmentId, user: req\.user\._id \}\)/);
  assert.match(SURVEY_SRC, /not yours/);
  assert.match(SURVEY_SRC, /isValidObjectId\(String\(assessmentId\)\)/, 'a non-objectId is a 400, not a CastError 500');
  assert.match(SURVEY_SRC, /assessmentId: linkedAssessmentId/, 'and only the checked value is stored');
});

test('an administrator cannot stamp a colleague name onto a chat assignment', () => {
  // `alias` came from the request body, so any admin could record that someone
  // else handled a case. Attribution has to come from the session that signed
  // in, which is the only thing an audit trail can be built on.
  // The comment in that handler QUOTES the old line, so the check runs on code.
  const assign = CHAT_SRC.slice(CHAT_SRC.indexOf("/assign"))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(assign, /req\.user\.alias/);
  assert.doesNotMatch(assign, /req\.body\.alias/, 'the body must not decide who did it');
});

test('the public health share link is metered, and described as it actually behaves', () => {
  // This endpoint hands out a member's health profile with no account and no
  // token of their own — the only thing between it and the internet is a random
  // URL. So two things have to be true: something bounds the rate at which
  // anyone can walk those URLs, and the code does not claim a control it does
  // not have. It used to be documented as showing "only the fields the sharing
  // user exposes"; ShareLink stores a token, an owner, an expiry and a revoked
  // flag, and nothing else, so what a live link discloses is a FIXED set and a
  // member who believed otherwise was leaking more than they intended to.
  const web3 = fs.readFileSync(path.join(REPO, 'routes', 'web3', 'index.js'), 'utf8');
  const shareAt = web3.indexOf("router.get('/share/:token'");
  const protectAt = web3.indexOf('router.use(protect)');
  assert.ok(shareAt > 0 && protectAt > shareAt, 'the share link is a PUBLIC route by design');
  assert.match(INDEX_SRC, /app\.use\('\/api\/web3', userLimiter\)/,
    'and it is still metered — by IP, since a visitor with no session has no user id');
  const data = fs.readFileSync(path.join(REPO, 'routes', 'web3', 'data.js'), 'utf8');
  const doc = data.slice(data.indexOf('// PUBLIC: read a shared health profile'), data.indexOf('async function publicShare'));
  assert.match(doc, /There is NO[\s\S]{0,12}field-level scoping/, 'described as the fixed set it is');
  assert.match(doc, /128-bit random token/, 'the real gate is named');
  assert.match(doc, /expir/, 'with expiry and revocation');
  // And the gate is enforced, not just written down.
  const handler = data.slice(data.indexOf('async function publicShare'), data.indexOf('module.exports'));
  assert.match(handler, /revoked/, 'a revoked link refuses');
  assert.match(handler, /expiresAt/, 'an expired link refuses');
});
