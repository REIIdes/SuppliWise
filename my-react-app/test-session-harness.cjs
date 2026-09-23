/**
 * Harness running the REAL src/api.js (Vite/ESM stripped to plain JS) against
 * stubbed browser globals, verifying the TAB-SCOPED session layer: legacy
 * migration, startSession, resume/switch handoff via BroadcastChannel,
 * 401 teardown, the dead-token registry (loop break), sign-out scoping,
 * tab isolation and the saved-login ("Save my login on this browser") flow.
 *
 * Run: node my-react-app/test-session-harness.cjs   (works from any cwd)
 * CommonJS via the .cjs extension because my-react-app is an ESM package.
 * No network, database or build step needed — not part of the app bundle.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'src', 'api.js');
const STATE_FILE = path.join(__dirname, 'src', 'auth', 'authState.js');
let src = fs.readFileSync(FILE, 'utf8');
// authState.js (no imports itself) is inlined so the real key names and
// AUTH_CHANGED_EVENT flow through.
let stateSrc = fs.readFileSync(STATE_FILE, 'utf8');

// Vite-only expression -> harmless in Node
src = src.replace(/import\.meta\.env(\.\w+)?/g, 'undefined');
stateSrc = stateSrc.replace(/^export const /gm, 'const ');
// ESM imports -> provided by the inlined authState above
src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';?\s*$/gm, '');
// ESM exports -> plain declarations (re-export lines vanish)
src = src.replace(/^export const /gm, 'const ');
src = src.replace(/^export \{[^}]*\};?\s*$/gm, '');

// ── browser stubs ──────────────────────────────────────────────────────────
// Plain object so Object.keys(localStorage) sees stored keys (browsers behave
// this way; the migration prefix-strips with Object.keys).
const makeStorage = () => ({
  getItem(k) {
    return Object.prototype.hasOwnProperty.call(this, k) && typeof this[k] === 'string' ? this[k] : null;
  },
  setItem(k, v) { this[k] = String(v); },
  removeItem(k) { delete this[k]; },
});
const localStorage = makeStorage(); // shared across "tabs" (same browser)

const windowHandlers = {};
const window = {
  location: {
    href: 'http://localhost:5173/dashboard',
    pathname: '/dashboard',
    protocol: 'http:',
    hostname: 'localhost',
    reload: () => {},
    // api.js redirects with location.replace (history REPLACE): sign-outs and
    // session-dead teardowns must not leave the dead page in history for the
    // Back button to re-open (that was the "sign out → admin, Back → admin"
    // trap).
    replace: (url) => {
      window.location.href = url;
      if (String(url).startsWith('/')) window.location.pathname = url;
    },
  },
  addEventListener: (type, fn) => { windowHandlers[type] = fn; },
  removeEventListener: () => {},
  dispatchEvent: () => {},
};

const document = { visibilityState: 'visible' };
const navigator = { userAgent: 'node-test' };
const console_ = { log: () => {}, error: () => {}, warn: () => {} };
const atob = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('binary');
class EventShim { constructor(type) { this.type = type; } }

// One browser-wide BroadcastChannel bus; each module instance joins it.
const bus = { instances: [] };
class BroadcastChannelShim {
  constructor(name) {
    this.name = name;
    this.listeners = [];
    this.posts = [];
    bus.instances.push(this);
  }
  addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter((f) => f !== fn); }
  postMessage(msg) { this.posts.push(msg); }
}
const deliverTo = (channel, msg) => {
  for (const fn of [...channel.listeners]) fn({ data: msg });
};

// fetch stub: records calls, returns a scripted response
const fetchCalls = [];
let nextResponse = { status: 200, body: {} };
const fetchStub = async (url, options = {}) => {
  fetchCalls.push({ url, options });
  const body = nextResponse.body;
  return {
    ok: nextResponse.status >= 200 && nextResponse.status < 300,
    status: nextResponse.status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
};

// ── module loader ──────────────────────────────────────────────────────────
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeJwt = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;

const exportNames = ['getToken', 'getStoredUser', 'getActiveAccountId', 'startSession',
  'listAccounts', 'resumeSession', 'switchAccount', 'signOutAccount', 'signOutCurrentAccount',
  'setAuthNotice', 'takeAuthNotice', 'parseJSON', 'saveAssessment', 'getDashboard',
  'saveRememberedLogin', 'forgetRememberedLogin'];
const code = `${stateSrc}\n${src}\nreturn { ${exportNames.join(', ')} };`;

// Each factory call = one fresh TAB: its own sessionStorage + channel join.
const makeTab = () => {
  const sessionStorage = makeStorage();
  const factory = new Function(
    'localStorage', 'sessionStorage', 'window', 'document', 'navigator',
    'console', 'atob', 'fetch', 'BroadcastChannel', 'Event',
    code,
  );
  const api = factory(localStorage, sessionStorage, window, document, navigator,
    console_, atob, fetchStub, BroadcastChannelShim, EventShim);
  const channel = bus.instances[bus.instances.length - 1];
  return { api, channel, sessionStorage };
};

let failures = 0;
const check = (label, condition, detail = '') => {
  console.info(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
};

(async () => {
  // ── 1. Legacy migration adopts the shared mirror, then strips it ────────
  const legacyTokenA = makeJwt({ id: 'user-a', iat: 111 });
  const userA = { firstName: 'Alpha', lastName: 'Tester', email: 'a@example.com' };
  const tokenCopyB = makeJwt({ id: 'user-b', iat: 222 });
  const userB = { firstName: 'Bravo', lastName: 'Tester', email: 'b@example.com' };
  localStorage.setItem('token', legacyTokenA);
  localStorage.setItem('user', JSON.stringify(userA));
  localStorage.setItem('sw_active_account', 'user-a');
  localStorage.setItem('sw_token_user-b', tokenCopyB);
  localStorage.setItem('sw_user_user-b', JSON.stringify(userB));
  localStorage.setItem('suppliwise_user_last_activity', '123');
  localStorage.setItem('sw_accounts', JSON.stringify([{ id: 'user-c', email: 'c@example.com', name: 'Charlie T' }]));
  localStorage.setItem('adminToken', 'admintok-keep');

  const tab1 = makeTab();
  check('legacy mirror adopted into the tab session',
    tab1.api.getToken() === legacyTokenA && tab1.api.getActiveAccountId() === 'user-a');
  check('legacy profile adopted', tab1.api.getStoredUser()?.email === 'a@example.com');
  check('migration seeds the account directory',
    tab1.api.listAccounts().some((a) => a.id === 'user-a'),
    JSON.stringify(tab1.api.listAccounts().map((a) => a.id)));
  check('directory keeps other accounts', tab1.api.listAccounts().some((a) => a.id === 'user-c'));
  const stripped = ['token', 'user', 'sw_active_account', 'sw_token_user-b', 'sw_user_user-b', 'suppliwise_user_last_activity']
    .every((k) => localStorage.getItem(k) === null);
  check('shared credential keys are stripped after migration', stripped);
  check('admin token survives migration', localStorage.getItem('adminToken') === 'admintok-keep');
  check('metadata directory survives migration', localStorage.getItem('sw_accounts') !== null);

  // ── 2. startSession: tab session + directory + displaced id ─────────────
  const tokenA2 = makeJwt({ id: 'user-a', sid: 'sid-a2', iat: 333 });
  check('first startSession reports no displaced account',
    tab1.api.startSession(tokenA2, userA) === null);
  check('active token updated', tab1.api.getToken() === tokenA2);
  const tokenB = makeJwt({ id: 'user-b', sid: 'sid-b1', iat: 444 });
  const displaced = tab1.api.startSession(tokenB, userB);
  check('signing in B over A reports A as displaced',
    displaced === 'user-a', `got ${displaced}`);
  const listed = tab1.api.listAccounts();
  check('both accounts listed, B current',
    listed.length >= 2 && listed.find((a) => a.id === 'user-b')?.isCurrent === true);
  check('directory metadata for inactive account retained',
    listed.find((a) => a.id === 'user-a')?.email === 'a@example.com');

  // ── 3. Tab isolation: a second tab signs in as C — tab1 keeps B ─────────
  const tokenC = makeJwt({ id: 'user-c', sid: 'sid-c1', iat: 555 });
  const tab2 = makeTab();
  tab2.api.startSession(tokenC, { firstName: 'Charlie', lastName: 'T', email: 'c@example.com' });
  check('tab2 is signed in as C', tab2.api.getToken() === tokenC);
  check('tab1 is untouched by tab2 sign-in',
    tab1.api.getToken() === tokenB && tab1.api.getActiveAccountId() === 'user-b');

  // ── 4. resumeSession adopts a holder reply (healthy token) ──────────────
  const tab3 = makeTab();
  const resumeP = tab3.api.resumeSession(600);
  await new Promise((r) => setTimeout(r, 5)); // let the resume post go out
  const resumePost = tab3.channel.posts.find((p) => p.type === 'resume');
  check('fresh tab asks other tabs for a session',
    !!resumePost && resumePost.ids.includes('user-c'), JSON.stringify(tab3.channel.posts));
  deliverTo(tab3.channel, { type: 'session', rid: resumePost.rid, id: 'user-c', token: tokenC, user: null });
  check('resume adopts the handed-over session', await resumeP === true);
  check('resumed tab holds the session', tab3.api.getToken() === tokenC);

  // ── 5. 401 teardown: clear this tab, notice, redirect, broadcast, keep directory
  window.location.href = 'http://localhost:5173/dashboard';
  window.location.pathname = '/dashboard';
  nextResponse = { status: 401, body: { message: 'Your session has ended. Please sign in again.', code: 'SESSION_REVOKED' } };
  let thrown = null;
  try { await tab1.api.getDashboard(); } catch (err) { thrown = err; }
  check('401 surfaces the session-ended message',
    thrown?.message === 'Your session has ended. Please sign in again.', `got ${thrown?.message}`);
  check('dead tab session cleared', tab1.api.getToken() === '' && tab1.api.getActiveAccountId() === null);
  check('one-shot notice written', tab1.api.takeAuthNotice() !== '');
  check('notice is consumed once', tab1.api.takeAuthNotice() === '');
  check('redirected to /login', String(window.location.href).endsWith('/login'), String(window.location.href));
  check('session-dead broadcast posted', tab1.channel.posts.some((p) => p.type === 'session-dead' && p.token === tokenB),
    JSON.stringify(tab1.channel.posts.map((p) => p.type)));
  check('directory entry kept after 401 (a newer session may exist elsewhere)',
    tab1.api.listAccounts().some((a) => a.id === 'user-b'));

  // ── 6. THE LOOP BREAK: a dead token can never be re-adopted ──────────────
  const tab4 = makeTab();
  const deadResume = tab4.api.resumeSession(600);
  await new Promise((r) => setTimeout(r, 5));
  const deadPost = tab4.channel.posts.find((p) => p.type === 'resume');
  check('new tab asks for sessions (directory lists the account)', !!deadPost);
  // A holder would answer with the dead copy — adoption must refuse it.
  deliverTo(tab4.channel, { type: 'session', rid: deadPost.rid, id: 'user-b', token: tokenB, user: userB });
  check('resume REFUSES the dead token (no /login→/dashboard loop)', await deadResume === false);
  check('dead token not installed in the tab', tab4.api.getToken() === '');
  // switchAccount path: request a handoff, holder answers with the dead copy.
  const swP = tab4.api.switchAccount('user-b');
  await new Promise((r) => setTimeout(r, 5));
  const swPost = [...tab4.channel.posts].reverse().find((p) => p.type === 'resume');
  deliverTo(tab4.channel, { type: 'session', rid: swPost.rid, id: 'user-b', token: tokenB, user: userB });
  check('switchAccount also REFUSES the dead token', await swP === false);

  // ── 7. Holder side: never hands a dead token; heals itself ──────────────
  // tab3 still holds tokenC (healthy): responder hands it over on request.
  const asker = makeTab();
  deliverTo(tab3.channel, { type: 'resume', rid: 'rid-healthy', ids: ['user-c'] });
  check('healthy holder answers a resume request',
    tab3.channel.posts.some((p) => p.type === 'session' && p.rid === 'rid-healthy' && p.token === tokenC));
  // Simulate a holder of the DEAD copy that missed the broadcast.
  const deadHolder = makeTab();
  deadHolder.sessionStorage.setItem('sw_tab_account', 'user-b');
  deadHolder.sessionStorage.setItem('sw_tab_token', tokenB);
  deadHolder.sessionStorage.setItem('sw_tab_user', JSON.stringify(userB));
  const holderPostsBefore = deadHolder.channel.posts.length;
  deliverTo(deadHolder.channel, { type: 'resume', rid: 'rid-dead', ids: ['user-b'] });
  check('dead holder does NOT hand its token over',
    !deadHolder.channel.posts.some((p) => p.type === 'session' && p.rid === 'rid-dead'));
  check('dead holder self-heals (session cleared)',
    deadHolder.sessionStorage.getItem('sw_tab_token') === null);

  // ── 8. session-dead broadcast clears matching tabs only ─────────────────
  const holderX = makeTab();
  holderX.sessionStorage.setItem('sw_tab_account', 'user-x');
  holderX.sessionStorage.setItem('sw_tab_token', 'x-token');
  holderX.sessionStorage.setItem('sw_tab_user', JSON.stringify({ email: 'x@e.com' }));
  deliverTo(holderX.channel, { type: 'session-dead', token: 'x-token' });
  check('matching holder cleared by session-dead',
    holderX.sessionStorage.getItem('sw_tab_token') === null);
  const holderY = makeTab();
  holderY.sessionStorage.setItem('sw_tab_account', 'user-y');
  holderY.sessionStorage.setItem('sw_tab_token', 'y-token-live');
  deliverTo(holderY.channel, { type: 'session-dead', token: 'x-token' });
  check('non-matching holder keeps its live session',
    holderY.sessionStorage.getItem('sw_tab_token') === 'y-token-live');

  // ── 9. Sign-out scoping: revokes with bearer, forgets only that account ──
  const tab5 = makeTab();
  tab5.api.startSession(tokenC, { firstName: 'Charlie', lastName: 'T', email: 'c@example.com' });
  fetchCalls.length = 0;
  nextResponse = { status: 200, body: { message: 'Signed out successfully.' } };
  await tab5.api.signOutAccount('user-c');
  check('sign-out calls the API with THIS account token',
    fetchCalls.some((c) => c.url.endsWith('/auth/logout') && c.options.headers?.Authorization === `Bearer ${tokenC}`));
  check('signed-out account forgotten locally', tab5.api.getToken() === ''
    && !tab5.api.listAccounts().some((a) => a.id === 'user-c'));
  check('other accounts remain listed',
    tab5.api.listAccounts().some((a) => a.id === 'user-b') && tab5.api.listAccounts().some((a) => a.id === 'user-a'));

  // ── 10. No cross-tab storage listeners (tab independence by design) ─────
  check('no cross-tab storage listener registered', windowHandlers.storage === undefined);

  // ── 11. exp-less tokens are never treated as expired ────────────────────
  const tab6 = makeTab();
  tab6.api.startSession(tokenC, { firstName: 'Charlie', lastName: 'T', email: 'c@example.com' });
  nextResponse = { status: 201, body: { assessment: { _id: 'x' } } };
  let saveError = null;
  try { await tab6.api.saveAssessment({ q: [] }); } catch (err) { saveError = err; }
  check('an exp-less token is never flagged as expired', saveError === null, saveError && saveError.message);

  // ── 12. OPT-IN saved logins: mint instead of asking for the password ────
  const readRemember = () => JSON.parse(localStorage.getItem('sw_remember') || '{}');
  const tab7 = makeTab();
  tab7.api.startSession(tokenC, { firstName: 'Charlie', lastName: 'T', email: 'c@example.com' },
    'remember-c-secret');
  check('startSession stores the opt-in remember credential',
    readRemember()['user-c']?.token === 'remember-c-secret', JSON.stringify(readRemember()));
  // Explicit sign-out forgets THIS account's saved login.
  fetchCalls.length = 0;
  nextResponse = { status: 200, body: { message: 'Signed out successfully.' } };
  await tab7.api.signOutAccount('user-c');
  check('sign-out forgets the saved login for that account',
    readRemember()['user-c'] === undefined, JSON.stringify(readRemember()));
  // No open tab holds user-d: switch via the saved login (mint round-trip).
  tab7.api.saveRememberedLogin('user-d', { token: 'remember-d-secret', email: 'd@example.com', name: 'Delta T' });
  fetchCalls.length = 0;
  nextResponse = {
    status: 200,
    body: {
      token: makeJwt({ id: 'user-d', sid: 'sid-d1', iat: 1001 }),
      user: { _id: 'user-d', email: 'd@example.com', name: 'Delta T' },
    },
  };
  const swSaved = await tab7.api.switchAccount('user-d');
  check('switchAccount mints a session from the saved login (no holder, no password)',
    swSaved === true && tab7.api.getActiveAccountId() === 'user-d',
    `sw=${swSaved} active=${tab7.api.getActiveAccountId()}`);
  check('mint posted the stored credential to /auth/remember',
    fetchCalls.some((c) => c.url.endsWith('/auth/remember')
      && String(c.options.body || '').includes('remember-d-secret')));
  check('minted profile installed for the switched account',
    tab7.api.getStoredUser()?.email === 'd@example.com',
    JSON.stringify(tab7.api.getStoredUser()));
  // Server declines the saved login → drop it, fall through to handoff.
  tab7.api.saveRememberedLogin('user-a', { token: 'remember-a-stale' });
  nextResponse = { status: 401, body: { code: 'SESSION_REVOKED', message: 'Your session has ended. Please sign in again.' } };
  const swDeclined = await tab7.api.switchAccount('user-a');
  check('declined saved login is dropped and the switch falls through',
    swDeclined === false && readRemember()['user-a'] === undefined
      && tab7.api.getActiveAccountId() === 'user-d',
    `sw=${swDeclined} active=${tab7.api.getActiveAccountId()}`);
  // A transient failure (5xx) must NOT destroy the saved login.
  nextResponse = { status: 503, body: { message: 'Unable to verify your saved login right now.' } };
  tab7.api.saveRememberedLogin('user-e', { token: 'remember-e-secret' });
  await tab7.api.switchAccount('user-e');
  check('transient mint failure KEEPS the saved login',
    readRemember()['user-e']?.token === 'remember-e-secret', JSON.stringify(readRemember()));
  // An empty/no-op save never writes garbage into the shared store.
  tab7.api.saveRememberedLogin('user-f', {});
  check('save without a credential is a no-op', readRemember()['user-f'] === undefined);
  nextResponse = { status: 200, body: {} }; // restore the default stub

  console.info(failures === 0 ? '\nAll frontend session checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(1);
});
