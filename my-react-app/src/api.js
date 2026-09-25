import {
  emitAuthChanged,
  TAB_ACCOUNT_KEY,
  TAB_TOKEN_KEY,
  TAB_USER_KEY,
  DIRECTORY_KEY,
  markUserSignedOut,
  clearUserSignedOut,
  SUBSCRIPTION_REVALIDATE_EVENT,
} from './auth/authState';

// Resolve the backend URL: explicit env override wins; otherwise derive it
// from the page host so phones/tablets on the LAN (e.g. 192.168.x.x) reach
// the backend instead of a dead localhost:5000 ("Failed to fetch").
const getBaseUrl = () => {
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  if (typeof window !== 'undefined') {
    const { hostname, protocol } = window.location;
    if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
      const scheme = protocol === 'https:' ? 'https:' : 'http:';
      return `${scheme}//${hostname}:5000/api`;
    }
  }
  return 'http://localhost:5000/api';
};
const BASE_URL = getBaseUrl();

// Export BASE_URL so other components can use it
export { BASE_URL };

// ── Sessions: tab-scoped credentials + shared account directory ────────────
// WHAT LIVES WHERE (and why):
//
// • sessionStorage (`sw_tab_*`) — THIS TAB's session: active account id,
//   its JWT and its profile. sessionStorage is per-tab, so Tab 1 can run as
//   Account A while Tab 2 runs as Account B: signing in, switching or
//   signing out in one tab can never overwrite another tab's auth state
//   (no shared mirror, no forced cross-tab reloads).
//
// • localStorage (`sw_accounts`) — browser-wide DIRECTORY of which accounts
//   are signed in here: id, email, display name, last-used time. Metadata
//   only — never tokens or passwords (credentials don't belong in shared
//   storage).
//
// • BroadcastChannel (`suppliwise:auth`) — same-origin tabs hand sessions to
//   each other on request (a new tab resumes a known account; the switcher
//   adopts another open tab's session) and honour cross-tab sign-out.
//   Nothing is persisted by the channel, and only tabs of THIS origin ever
//   see its messages.
//
// Server-side each token maps to ONE session record. The backend rejects any
// token that is no longer its account's current active session
// (401 + SESSION_REVOKED); handleAuthError then clears THIS tab only.
const AUTH_NOTICE_KEY = 'sw_auth_notice';

// Fallback copy for a session the server rejected (also used by the
// cross-tab dead-session handlers below).
const SESSION_ENDED_MESSAGE = 'Your session has ended. Please sign in again.';

// One-shot message shown by the login screen after a forced sign-out
// ("session expired / signed out elsewhere" state).
export const setAuthNotice = (message) => {
  try { sessionStorage.setItem(AUTH_NOTICE_KEY, String(message || '')); } catch { /* best-effort */ }
};

export const takeAuthNotice = () => {
  try {
    const msg = sessionStorage.getItem(AUTH_NOTICE_KEY);
    if (msg) sessionStorage.removeItem(AUTH_NOTICE_KEY);
    return msg || '';
  } catch { return ''; }
};

// Pre-session-storage builds mirrored credentials into localStorage under
// these keys. They are adopted into the tab session on load, then stripped.
const LEGACY_SHARED_KEYS = ['token', 'user', 'suppliwise_user_last_activity', 'sw_active_account'];
const LEGACY_ACCOUNT_PREFIXES = ['sw_token_', 'sw_user_'];

const AUTH_CHANNEL_NAME = 'suppliwise:auth';
let authChannel = null;
try {
  authChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(AUTH_CHANNEL_NAME) : null;
} catch { authChannel = null; }

const postToTabs = (message) => {
  try { authChannel?.postMessage(message); } catch { /* channel closed — best-effort */ }
};

// Ask the other tabs whether any of them holds one of `ids`; the first reply
// wins. Resolves null after `timeoutMs` (no holder, or BroadcastChannel is
// unavailable) — the caller then falls back to a fresh sign-in.
const requestSessionFromTabs = (ids, timeoutMs = 400) => new Promise((resolve) => {
  if (!authChannel || !Array.isArray(ids) || !ids.length) { resolve(null); return; }
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    authChannel.removeEventListener('message', onMessage);
    resolve(value);
  };
  const onMessage = (event) => {
    const msg = event?.data;
    if (!msg || msg.type !== 'session' || msg.rid !== rid) return;
    if (!msg.token || !ids.includes(msg.id)) return;
    finish({ id: msg.id, token: msg.token, user: msg.user || null });
  };
  const timer = setTimeout(() => finish(null), timeoutMs);
  authChannel.addEventListener('message', onMessage);
  try { authChannel.postMessage({ type: 'resume', rid, ids }); } catch { finish(null); }
});

// This tab's answers to other tabs: hand over THIS session when asked for an
// account we actively hold (the requester can only name account ids — it
// never learns about accounts this tab doesn't have), and end it when asked
// to sign out. Handlers only run on messages, i.e. after module init.
if (authChannel) {
  authChannel.addEventListener('message', (event) => {
    const msg = event?.data;
    if (!msg) return;
    if (msg.type === 'session-dead' && msg.token && msg.token === getToken()) {
      // A sibling tab proved THIS exact token copy is rejected: clear it here
      // too so this tab can neither keep calling with it nor hand it back on
      // resume. Only this token's copy dies — other sessions/accounts stay.
      rememberDeadToken(msg.token);
      clearTabSession();
      setAuthNotice(SESSION_ENDED_MESSAGE);
      const deadPath = window.location.pathname;
      if (deadPath !== '/login' && deadPath !== '/signup') window.location.replace('/login');
      return;
    }
    if (msg.type === 'resume' && Array.isArray(msg.ids)) {
      const id = getActiveAccountId();
      const token = getToken();
      if (!id || !token || !msg.ids.includes(id)) return;
      if (isDeadToken(token)) {
        // Never hand a dead session over — heal this tab instead, so the
        // requester's bootstrap resolves to "no session" and shows the
        // login form rather than looping through a doomed /dashboard.
        clearTabSession();
        setAuthNotice(SESSION_ENDED_MESSAGE);
        const heldPath = window.location.pathname;
        if (heldPath !== '/login' && heldPath !== '/signup') window.location.replace('/login');
        return;
      }
      postToTabs({ type: 'session', rid: msg.rid, id, token, user: getStoredUser() });
      return;
    }
    if (msg.type === 'sign-out' && msg.id && msg.id === getActiveAccountId() && getToken()) {
      // Another tab asked this account to end everywhere: revoke server-side
      // (only THIS account's session — others are untouched), clear the tab,
      // and show the login screen if we're on an app page.
      signOutCurrentAccount().then(() => {
        const path = window.location.pathname;
        if (path !== '/login' && path !== '/signup') window.location.replace('/login');
      }).catch(() => { /* local clear already happened */ });
    }
  });
}

const safeParse = (raw) => {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
};

const decodeJwt = (token) => {
  try {
    // JWT segments are base64URL ('-', '_'); normalise before atob so profile
    // payloads that hit those characters still decode instead of silently
    // failing (which would break account identity lookups).
    const segment = String(token).split('.')[1] || '';
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch { return null; }
};

const accountIdOf = (token) => {
  const payload = decodeJwt(token);
  return payload && payload.id ? String(payload.id) : null;
};

const isAdminToken = (token) => !!token && decodeJwt(token)?.role === 'admin';

// ── Dead-session registry (shared, fingerprint only) ───────────────────────
// When the server rejects a token (401 + SESSION_* code), that EXACT token
// copy is dead for every tab that holds it — several tabs can share one
// legacy/handover session. Remembering the fact stops a fatal bounce: a
// cleared tab's new-tab bootstrap asks the channel for a session, an idle
// sibling tab hands the dead copy back, the guard bounces /login →
// /dashboard, the API 401s again — an infinite spinner/redirect loop.
// Only a fingerprint (sid/iat/length — never the token) is stored, and only
// for THAT token: a newer session for the same account, and every other
// account, is unaffected.
const DEAD_TOKENS_KEY = 'sw_dead_tokens';

const tokenFingerprint = (token) => {
  const payload = decodeJwt(token);
  if (!payload) return `len:${String(token).length}`;
  return `${payload.sid || 'legacy'}:${payload.iat || 0}:${String(token).length}`;
};

const rememberDeadToken = (token) => {
  if (!token) return;
  try {
    const fp = tokenFingerprint(token);
    const arr = safeParse(localStorage.getItem(DEAD_TOKENS_KEY));
    const list = Array.isArray(arr) ? arr : [];
    if (list.includes(fp)) return;
    localStorage.setItem(DEAD_TOKENS_KEY, JSON.stringify([fp, ...list].slice(0, 20)));
  } catch { /* best-effort */ }
};

const isDeadToken = (token) => {
  if (!token) return false;
  try {
    const list = safeParse(localStorage.getItem(DEAD_TOKENS_KEY));
    return Array.isArray(list) && list.includes(tokenFingerprint(token));
  } catch { return false; }
};

const readDirectory = () => {
  const list = safeParse(localStorage.getItem(DIRECTORY_KEY));
  return Array.isArray(list) ? list : [];
};

const writeDirectory = (list) => {
  try { localStorage.setItem(DIRECTORY_KEY, JSON.stringify(list)); } catch { /* quota — best-effort */ }
};

const fullNameOf = (profile) => {
  if (!profile) return '';
  const full = profile.firstName && profile.lastName
    ? `${profile.firstName} ${profile.lastName}`
    : profile.name;
  return String(full || '').trim();
};

// Add/refresh one account's METADATA (never its credentials) in the shared
// directory, most-recent first. Fields we weren't given are left as-is.
const upsertDirectory = (id, fields = {}) => {
  if (!id) return;
  try {
    const list = readDirectory();
    const entry = { ...(list.find((e) => e.id === id) || { id }) };
    if (fields.email) entry.email = fields.email;
    if (fields.name) entry.name = fields.name;
    entry.lastUsedAt = Date.now();
    writeDirectory([entry, ...list.filter((e) => e.id !== id)].slice(0, 10));
  } catch { /* best-effort */ }
};

// The account THIS TAB is acting as (never another tab's).
export const getActiveAccountId = () => {
  try {
    const tabAccount = sessionStorage.getItem(TAB_ACCOUNT_KEY);
    if (tabAccount) return tabAccount;
  } catch { /* fall through to the token */ }
  const token = getToken();
  return token && !isAdminToken(token) ? accountIdOf(token) : null;
};

// THIS TAB's access token. Deliberately never in localStorage: per-tab
// state is what lets several accounts be signed in across tabs at once
// without clashing over a shared mirror.
export const getToken = () => {
  try { return sessionStorage.getItem(TAB_TOKEN_KEY) || ''; } catch { return ''; }
};

// THIS TAB's cached profile (profile/plan/2FA edits write through here).
export const getStoredUser = () => {
  try { return safeParse(sessionStorage.getItem(TAB_USER_KEY)); } catch { return null; }
};

// Persist a profile update for this tab's account and refresh the shared
// directory's name/email metadata. Only THIS account's copies change.
export const setStoredUser = (profile) => {
  if (!profile) return;
  try {
    sessionStorage.setItem(TAB_USER_KEY, JSON.stringify(profile));
  } catch { /* quota — the in-memory copy still applies for this render */ }
  const id = getActiveAccountId();
  if (id) upsertDirectory(id, { email: profile.email, name: fullNameOf(profile) });
  emitAuthChanged();
};

// Install a session into THIS TAB (`id` must be the token's own account).
const writeTabSession = (id, token, profile) => {
  try {
    sessionStorage.setItem(TAB_ACCOUNT_KEY, id);
    sessionStorage.setItem(TAB_TOKEN_KEY, token);
    if (profile) sessionStorage.setItem(TAB_USER_KEY, JSON.stringify(profile));
    else sessionStorage.removeItem(TAB_USER_KEY);
    // Leftover from the retired idle-timer feature — never re-created.
    localStorage.removeItem('suppliwise_user_last_activity');
  } catch { /* storage blocked: the session still works for this page load */ }
  // Signed in again (fresh sign-in, switch, or cross-tab resume): this tab
  // is back in an active USER session, so the signed-out routing flag no
  // longer applies — guards follow the live token from here.
  clearUserSignedOut();
};

// Drop THIS TAB's session. `forgetAccount` (explicit sign-out) also removes
// the account from the shared directory; a server-side 401 KEEPS the entry —
// another tab may legitimately hold a newer session for that account.
const clearTabSession = ({ forgetAccount = false } = {}) => {
  const id = getActiveAccountId();
  try {
    sessionStorage.removeItem(TAB_ACCOUNT_KEY);
    sessionStorage.removeItem(TAB_TOKEN_KEY);
    sessionStorage.removeItem(TAB_USER_KEY);
    localStorage.removeItem('suppliwise_user_last_activity');
    if (forgetAccount && id) writeDirectory(readDirectory().filter((e) => e.id !== id));
  } catch { /* best-effort */ }
  // A user session ENDED in this tab: remember it so route guards keep this
  // tab in the USER flow — always back to the Sign In form, never diverted
  // to the admin panel — until a new session installs here (writeTabSession
  // clears the flag). This is what keeps sign-out and admin routing as two
  // separate logics.
  markUserSignedOut();
  emitAuthChanged();
  return id;
};

// ── OPT-IN saved logins ("Save my login on this browser") ───────────────────
// The deliberate counterpart to "no credentials in shared storage": when the
// sign-in form's save box is checked we keep ONLY a remember credential per
// account — never an access token. It can do exactly one thing: ask the
// server to re-sign a JWT for that account's SAME session (server-side it is
// a sha256 on the Session record, so sign-out, a newer sign-in and account
// bans all kill it automatically). Per-account, capped, and dropped the
// moment the server declines it.
const REMEMBER_KEY = 'sw_remember';
const REMEMBER_CAP = 10;

const readRememberMap = () => {
  const map = safeParse(localStorage.getItem(REMEMBER_KEY));
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
};

const writeRememberMap = (map) => {
  try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(map)); } catch { /* quota — best-effort */ }
};

// Keep this account's saved login (newest kept, map capped at REMEMBER_CAP).
export const saveRememberedLogin = (id, fields) => {
  if (!id || !fields || !fields.token) return;
  try {
    const map = readRememberMap();
    map[id] = {
      token: String(fields.token),
      email: fields.email || (map[id] && map[id].email) || '',
      name: fields.name || (map[id] && map[id].name) || '',
      at: Date.now(),
    };
    const keep = Object.keys(map).sort((a, b) => (map[b].at || 0) - (map[a].at || 0)).slice(0, REMEMBER_CAP);
    const next = {};
    keep.forEach((k) => { next[k] = map[k]; });
    writeRememberMap(next);
  } catch { /* best-effort */ }
};

// Drop ONE account's saved login — explicit sign-out always calls this, so a
// signed-out account can never be re-entered from this browser's storage.
export const forgetRememberedLogin = (id) => {
  if (!id) return;
  try {
    const map = readRememberMap();
    if (!Object.prototype.hasOwnProperty.call(map, id)) return;
    delete map[id];
    writeRememberMap(map);
  } catch { /* best-effort */ }
};

const getRememberedLogin = (id) => {
  try { return readRememberMap()[id] || null; } catch { return null; }
};

// Swap a saved login for a fresh access token FOR THE SAME SESSION. Resolves
// null when: nothing is saved, the server declines it (401/403 only — the
// stale entry is dropped; 429/5xx outages never destroy the credential), the
// minted token belongs to a different account (confused-deputy guard), or the
// network fails. Callers fall through to tab handoff / fresh sign-in.
const mintFromRememberedLogin = async (id) => {
  const saved = getRememberedLogin(id);
  if (!saved || !saved.token) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${BASE_URL}/auth/remember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: saved.token }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    let data = null;
    try { data = await response.json(); } catch { /* empty/non-JSON body */ }
    if (response.ok && data && data.token && accountIdOf(data.token) === id) {
      // Refresh stored metadata alongside (name/email may have changed).
      saveRememberedLogin(id, {
        token: saved.token,
        email: (data.user && data.user.email) || saved.email,
        name: (data.user && data.user.name) || saved.name,
      });
      return { token: data.token, user: data.user || null };
    }
    if (response.status === 401 || response.status === 403) forgetRememberedLogin(id);
    return null;
  } catch {
    return null; // timeout/network — leave the saved login for the next try
  }
};

// Sign in (or add another account) IN THIS TAB: install its session here and
// record its metadata in the shared directory. Other tabs keep whatever
// account they were on — nothing browser-wide is re-pointed, so Tab 1 stays
// Account A while Tab 2 signs in as Account B. Returns the id of the account
// this tab was on before (when different) so callers can hard-navigate and
// leave the previous account's state behind. `rememberToken` (opt-in) is the
// sign-in's saved-login credential — stored per account, never as a token.
export const startSession = (token, profile = null, rememberToken = '') => {
  const id = accountIdOf(token);
  if (!id || isAdminToken(token)) return null;
  const previousId = getActiveAccountId();
  writeTabSession(id, token, profile);
  upsertDirectory(id, { email: profile?.email, name: fullNameOf(profile) });
  if (rememberToken) {
    saveRememberedLogin(id, { token: rememberToken, email: profile?.email, name: fullNameOf(profile) });
  }
  emitAuthChanged();
  return previousId && previousId !== id ? previousId : null;
};

// Accounts this browser has signed in to (most recent first). Other
// accounts are metadata only; the full profile belongs to this tab's account.
export const listAccounts = () => {
  const activeId = getActiveAccountId();
  const activeProfile = getStoredUser();
  const dir = readDirectory();
  // The active account always belongs in the list, even if its session was
  // installed without directory metadata (legacy migration edge).
  const base = (activeId && !dir.some((e) => e.id === activeId))
    ? [{ id: activeId, lastUsedAt: Date.now() }, ...dir]
    : dir;
  // Current account first, then most-recently-used. The directory is written
  // most-recent-first, but entries stored before switch-time recency bumps
  // would otherwise keep stale sign-in order — sorting here is self-healing.
  const sorted = [...base].sort((a, b) => {
    if (a.id === activeId) return -1;
    if (b.id === activeId) return 1;
    return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
  });
  return sorted.map((entry) => {
    const isCurrent = entry.id === activeId;
    return {
      id: entry.id,
      email: entry.email || (isCurrent ? activeProfile?.email : '') || '',
      name: entry.name || (isCurrent ? fullNameOf(activeProfile) : '') || '',
      profile: isCurrent ? activeProfile : null,
      isCurrent,
    };
  });
};

// Give THIS tab a live session for one of the known accounts: handed over by
// whichever open tab still holds it (BroadcastChannel), or — when no tab
// does — re-entered from that account's OPT-IN saved login (passwordless
// mint). Used by the new-tab bootstrap (a fresh tab lands where the browser
// left off) and by the account switcher. Resolves false only when neither
// works — the caller then falls back to a fresh sign-in.
export const resumeSession = async (timeoutMs = 400) => {
  if (getToken()) return true;
  const ids = readDirectory().map((e) => e.id);
  if (!ids.length) return false;
  const hit = await requestSessionFromTabs(ids, timeoutMs);
  if (hit && !isDeadToken(hit.token)) {
    // Adopting a session means USING that account — bump its recency so the
    // directory (and the Accounts panel) stays truly most-recently-used first,
    // not merely most-recently-signed-in.
    upsertDirectory(hit.id, {});
    writeTabSession(hit.id, hit.token, hit.user);
    emitAuthChanged();
    return true;
  }
  // Nobody holds any of them. A saved login (opt-in) can still re-enter the
  // most recently used account silently — directory order = newest first —
  // so closing every tab no longer means typing the password again.
  for (const id of ids) {
    const minted = await mintFromRememberedLogin(id);
    if (minted) {
      upsertDirectory(id, {});
      writeTabSession(id, minted.token, minted.user);
      emitAuthChanged();
      return true;
    }
  }
  return false;
};

// Make another stored account active IN THIS TAB. First try that account's
// OPT-IN saved login (one server round-trip — no other tab needed, no
// password). Otherwise hand off from the tab that holds the session; shared
// storage is never a session source. Returns false when neither works; the
// caller then sends the user to /login?add=1, where a fresh sign-in becomes
// that account's new session (and, by the one-active-session rule, revokes
// the account's older one).
export const switchAccount = async (id) => {
  if (!id) return false;
  if (id === getActiveAccountId() && getToken()) return true;
  const minted = await mintFromRememberedLogin(id);
  if (minted) {
    upsertDirectory(id, {});
    writeTabSession(id, minted.token, minted.user);
    emitAuthChanged();
    return true;
  }
  const hit = await requestSessionFromTabs([id], 400);
  if (!hit || isDeadToken(hit.token)) return false;
  // Becoming the active account = being used: bump recency so the shared
  // directory (and the panel order) reflects usage, not just sign-in time.
  upsertDirectory(hit.id, {});
  writeTabSession(hit.id, hit.token, hit.user);
  emitAuthChanged();
  return true;
};

// Sign one account out: revoke ITS session server-side — scoped to that
// account and that session id, so signing out Account A can never sign out
// Account B — and forget it here. If the session lives in ANOTHER tab, ask
// that tab to do the revoking (only the holder of a token can revoke it);
// when THIS tab holds the token, every other copy of it is told the session
// is dead so those tabs log out and return to /login immediately instead of
// living on stale UI until their next API call happens to 401.
export const signOutAccount = async (id) => {
  if (!id) return;

  const isThisTab = id === getActiveAccountId() && !!getToken();
  if (!isThisTab) {
    // Not our session to revoke: the tab holding it does the work; we only
    // drop the directory entry (and this account's saved login) so the
    // switcher stops listing the account and it cannot be re-entered
    // passwordless from storage we no longer want it in.
    postToTabs({ type: 'sign-out', id });
    try { writeDirectory(readDirectory().filter((e) => e.id !== id)); } catch { /* best-effort */ }
    forgetRememberedLogin(id);
    emitAuthChanged();
    return;
  }

  const liveToken = getToken();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${liveToken}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch { /* revoke is best-effort — local sign-out always proceeds */ }

  clearTabSession({ forgetAccount: true });
  // Sign-out also drops the OPT-IN saved login for this account — locally
  // and (via the holder path above) browser-wide, since storage is shared.
  forgetRememberedLogin(id);

  // After this tab's own copy is gone: tell every OTHER tab holding this
  // exact token the session is over — they fingerprint it as dead, clear
  // themselves, and land on /login right now. Addressed by TOKEN, so only
  // this session's copies are affected; other accounts' tabs keep running.
  // (Sent after the local clear so this tab can never act on its own message
  // — its token no longer matches.)
  if (liveToken) postToTabs({ type: 'session-dead', token: liveToken });
};

// Sign THIS tab's account out.
export const signOutCurrentAccount = () => signOutAccount(getActiveAccountId());

// ── Load-time migration ────────────────────────────────────────────────────
// Earlier builds mirrored credentials into localStorage (`token` / `user`,
// plus per-account `sw_token_*` / `sw_user_*` copies). Credentials never
// belong in shared storage now: adopt this tab's predecessor session (if a
// complete token+profile pair exists) into the tab session, then strip every
// shared credential copy. The `sw_accounts` directory survives — metadata
// only. Admin tokens live in their own `adminToken` key and are untouched.
(() => {
  try {
    if (!getToken()) {
      const legacyMirror = localStorage.getItem('token');
      const legacyActive = localStorage.getItem('sw_active_account');
      const candidateId = legacyActive
        || (legacyMirror && !isAdminToken(legacyMirror) ? accountIdOf(legacyMirror) : null);
      if (candidateId) {
        const legacyToken = localStorage.getItem(`sw_token_${candidateId}`)
          || (legacyMirror && accountIdOf(legacyMirror) === candidateId ? legacyMirror : '');
        const legacyUser = localStorage.getItem(`sw_user_${candidateId}`)
          || localStorage.getItem('user');
        if (legacyToken && accountIdOf(legacyToken) === candidateId && safeParse(legacyUser)) {
          const adopted = safeParse(legacyUser);
          writeTabSession(candidateId, legacyToken, adopted);
          // Seed the shared directory too — startSession normally does this,
          // and without it the account would be missing from Profile →
          // Accounts (switcher, add-account entry point) after migration.
          upsertDirectory(candidateId, { email: adopted.email, name: fullNameOf(adopted) });
        }
      }
    }
    LEGACY_SHARED_KEYS.forEach((key) => localStorage.removeItem(key));
    Object.keys(localStorage).forEach((key) => {
      if (LEGACY_ACCOUNT_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        localStorage.removeItem(key);
      }
    });
  } catch { /* best-effort */ }
})();

// Helper to get auth header
const authHeader = () => {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// Safely parse JSON — returns null if body is empty or unparseable
export const parseJSON = async (res) => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// fetch with a hard timeout so a stalled network can never spin loaders forever.
// AI calls get a longer budget via the timeoutMs argument.
// Safe GETs get one automatic retry on connection-level failures.
const apiFetch = async (path, options = {}, timeoutMs = 30000) => {
  const method = (options.method || 'GET').toUpperCase();
  const attempts = method === 'GET' ? 2 : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE_URL}${path}`, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        const timeoutError = new Error('Request timed out. Please check your connection and try again.');
        timeoutError.isTimeout = true;
        throw timeoutError;
      }
      lastError = err;
      // Retry once on connection failures (server restart, network blip)
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, 800));
        continue;
      }
      if (err instanceof TypeError) {
        throw new Error('Cannot reach the server. Check your connection and that the backend is running.', { cause: err });
      }
      throw err;
    }
  }
  throw lastError;
};

// Check if token is expired before making requests
const isTokenExpired = () => {
  const token = getToken();
  if (!token) return true;

  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    // User tokens carry no `exp`: they never expire on their own. They end
    // only through revocation (a newer sign-in replaced the session, or it
    // was signed out), which the server reports as a 401. Admin tokens keep
    // a real exp and are still checked here.
    if (!payload.exp) return false;
    // Check if token expires in next 60 seconds
    return payload.exp * 1000 < Date.now() + 60000;
  } catch {
    return true;
  }
};

// Handle authentication errors by clearing THIS TAB's session and redirecting.
// A 401 for a user token is definitive (the server answers 503 instead when
// it merely can't reach the database): this session is no longer the
// account's current active session — a newer sign-in replaced it, it was
// signed out elsewhere, or it predates the session store. So this tab's copy
// is dropped, a one-shot notice explains it on the login screen, and every
// OTHER tab/account — which holds its own independent session — is left
// untouched. Admin tokens keep their own refresh/idle flow and are never
// torn down from here.
//
// `code` is the machine-readable reason from the server (SESSION_REVOKED,
// SESSION_INVALID, NO_SESSION, INVALID_TOKEN, TOKEN_EXPIRED): operationally
// every session code means the same thing for this tab — you're signed out —
// so the server's human message wins when present, and NO_SESSION (no
// credential was even presented) falls back to the plain sign-in copy.
const handleAuthError = (serverMessage, code) => {
  const token = getToken();
  if (token && isAdminToken(token)) {
    return serverMessage || 'Something went wrong. Please try again.';
  }
  const message = serverMessage
    || (code === 'NO_SESSION' ? 'Please sign in to continue.' : SESSION_ENDED_MESSAGE);
  if (token) {
    // THIS copy is provably dead: fingerprint it (never the token itself) and
    // tell the other tabs, so no bootstrap can hand it back — that re-adoption
    // is what used to loop /dashboard ↔ /login with a stuck spinner. Then drop
    // this tab's session. The account directory entry is kept: another tab may
    // legitimately hold a NEWER session for the same account.
    rememberDeadToken(token);
    postToTabs({ type: 'session-dead', token });
    clearTabSession();
    setAuthNotice(message);
  }
  // Redirect to login page (but never yank the signup form mid-typing).
  if (window.location.pathname !== '/login' && window.location.pathname !== '/signup') {
    window.location.replace('/login');
  }
  return message;
};

// Map HTTP status codes to user-friendly messages.
// Server validation messages (4xx with a message field) are passed through as-is.
// Generic 5xx and network errors get a safe fallback message.
const friendlyError = (status, serverMessage, isLoginAttempt = false, code = null) => {
  // Handle 401 - but NOT for login/register attempts.
  // This tab's session is only cleared when the server truly rejects it.
  if (status === 401 && !isLoginAttempt) {
    return handleAuthError(serverMessage, code);
  }
  
  // Trust explicit server validation messages for 4xx
  if (status >= 400 && status < 500 && serverMessage) return serverMessage;

  switch (status) {
    case 403: return 'You do not have permission to do that.';
    case 404: return 'The requested resource was not found.';
    case 413: return 'File is too large. Please use a smaller image (profile picture: max 2MB, banner: max 3MB).';
    case 429: return 'Too many requests. Please wait a moment and try again.';
    case 500:
    case 502:
    case 503:
    case 504: return 'Something went wrong on our end. Please try again later.';
    default:  return serverMessage || 'Something went wrong. Please try again.';
  }
};

// A plan-gate rejection is also proof that THIS tab's plan snapshot is stale —
// the server just told us the account no longer qualifies. Nudge the shared
// subscription store to re-read the authoritative state so every gate in the
// app (profile grid, history paging, PDF, chat, insights) locks at once instead
// of waiting for the next push/poll.
//
// Dispatched as a DOM event on purpose: api.js is imported BY the store, so a
// direct import here would create a module cycle.
const notePlanRejection = (data) => {
  if (typeof window === 'undefined') return;
  if (!data || (!data.requiresPlan && !data.currentPlan && !data.feature)) return;
  try {
    window.dispatchEvent(new CustomEvent(SUBSCRIPTION_REVALIDATE_EVENT, { detail: data }));
  } catch { /* non-browser safe */ }
};

// Build an Error that also carries plan-gate info (403 requiresPlan/currentPlan)
// so gated pages can show an upgrade prompt instead of a generic message.
const throwFriendly = (status, data, isLoginAttempt = false) => {
  const err = new Error(friendlyError(status, data?.message, isLoginAttempt, data?.code));
  if (data?.requiresPlan) err.requiresPlan = data.requiresPlan;
  if (data?.currentPlan) err.currentPlan = data.currentPlan;
  err.status = status;
  err.code = data?.code || null;
  notePlanRejection(status === 403 ? data : null);
  throw err;
};

// Register a new user
export const registerUser = async (firstName, lastName, gender, dateOfBirth, email, password, captcha) => {
  const res = await apiFetch('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName, lastName, gender, dateOfBirth, email, password, captchaId: captcha?.id, captchaAnswer: captcha?.answer }),
  });
  const data = await parseJSON(res);
  if (!res.ok) {
    const err = new Error(friendlyError(res.status, data?.message, true)); // true = is register attempt
    if (data?.captchaFailed) err.captchaFailed = true;
    throw err;
  }
  return data;
};

// Math CAPTCHA challenge for registration
export const getCaptcha = async () => {
  const res = await apiFetch('/auth/captcha');
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message, true));
  return data;
};

// Login user
export const loginUser = async (email, password) => {
  const res = await apiFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  // Check content type - if it's HTML, log and throw better error
  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('text/html')) {
    const htmlText = await res.text();
    console.error('Received HTML instead of JSON:', htmlText.substring(0, 200));
    throw new Error('Server returned an HTML page instead of data. Please check your network connection.');
  }

  const data = await parseJSON(res);
  if (!res.ok) {
    const err = new Error(friendlyError(res.status, data?.message, true)); // true = is login attempt
    if (data?.lockedBy) err.lockedBy = data.lockedBy;
    if (data?.remainingSeconds != null) err.remainingSeconds = data.remainingSeconds;
    throw err;
  }
  return data;
};

// Save assessment (requires auth)
export const saveAssessment = async (assessmentData) => {
  // Check token expiration before making request
  if (isTokenExpired()) {
    handleAuthError();
    throw new Error('Your session has expired. Please sign in again.');
  }
  
  const res = await apiFetch('/assessment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
    },
    body: JSON.stringify(assessmentData),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get AI supplement recommendations
export const getRecommendations = async (assessmentData) => {
  // Check token expiration before making request
  if (isTokenExpired()) {
    handleAuthError();
    throw new Error('Your session has expired. Please sign in again.');
  }
  
  // AI generation can take minutes — budget 150s (server caps at 180s)
  const res = await apiFetch('/recommend', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
    },
    body: JSON.stringify(assessmentData),
  }, 150000);
  const data = await parseJSON(res);
  if (!res.ok) throwFriendly(res.status, data);
  return data;
};

// Get assessment history for logged-in user
// (page size is capped server-side by subscription tier;
// the response may include planLimit/currentPlan for upgrade hints)
export const getHistory = async (page = 1, limit = 10, fields = '') => {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (fields) params.set('fields', fields);
  const res = await apiFetch(`/assessment/history?${params.toString()}`, {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throwFriendly(res.status, data);
  if (Array.isArray(data)) {
    return {
      serverTime: new Date().toISOString(),
      assessments: data,
      pagination: null,
    };
  }
  return {
    serverTime: data.serverTime || new Date().toISOString(),
    assessments: data.assessments || [],
    pagination: data.pagination || null,
    planLimit: data.planLimit || null,
    currentPlan: data.currentPlan || null,
  };
};

// Save AI results to an assessment record
export const saveAssessmentResults = async (assessmentId, results) => {
  const res = await apiFetch(`/assessment/${assessmentId}/results`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(results),
  }, 60000);
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Delete an assessment
export const deleteAssessment = async (assessmentId) => {
  const res = await apiFetch(`/assessment/${assessmentId}`, {
    method: 'DELETE',
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Send a chat message to the AI assistant (ULTIMATE only — 403 carries requiresPlan)
export const sendChatMessage = async (message, history = []) => {
  const res = await apiFetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ message, history }),
  }, 45000);
  const data = await parseJSON(res);
  if (!res.ok) {
    // Chat validation errors use `reply` for the transcript while `message`
    // remains the machine/API-friendly field. Prefer either one so a 400 never
    // degrades into the generic "Something went wrong" copy.
    const err = new Error(friendlyError(res.status, data?.message || data?.reply));
    if (data?.requiresPlan) err.requiresPlan = data.requiresPlan;
    if (data?.currentPlan) err.currentPlan = data.currentPlan;
    err.status = res.status;
    err.code = data?.code || null;
    notePlanRejection(res.status === 403 ? data : null);
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterSeconds = retryAfter;
    throw err;
  }
  return data;
};

// Fetch detailed supplement information (assessment-aware)
export const getSupplementDetail = async (supplementName, context = null) => {
  const res = await apiFetch('/supplement-detail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ supplementName, context }),
  }, 45000);
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get current user profile incl. subscription status (lightweight, no image blobs)
export const getMyProfile = async (timeoutMs = 15000) => {
  const res = await apiFetch('/auth/me', { headers: { ...authHeader() } }, timeoutMs);
  const data = await parseJSON(res);
  if (!res.ok) {
    const err = new Error(friendlyError(res.status, data?.message));
    // Callers (the reactive plan store) need the status + cooldown so a 429
    // pauses refreshing instead of retrying into the lockout ladder.
    err.status = res.status;
    const retryAfter = Number(res.headers.get('retry-after'));
    err.retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter
      : (Number(data?.remainingSeconds) || 0);
    throw err;
  }
  return data;
};

// ── Account security ───────────────────────────────────────────────────────
// All three live here rather than inline in ProfilePage so the endpoint,
// auth header and error shape stay in one place.

/**
 * Change the password on its own (POST /auth/change-password).
 * Deliberately NOT part of the profile form: mixing a credential change into
 * a profile save means a user who only wanted to fix a typo has to satisfy
 * the password-strength rules, and one who only wants to change their password
 * has to fill in every profile field.
 */
export const changePassword = async (currentPassword, newPassword) => {
  const res = await apiFetch('/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data; // { message, passwordChangedAt, otherSessionsRevoked }
};

/** Revoke every other session and drop their saved-login credentials. */
export const signOutAllOtherDevices = async () => {
  const res = await apiFetch('/auth/sign-out-all', {
    method: 'POST',
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data; // { message, revoked }
};

/**
 * Choose the second factor used at sign-in: 'authenticator' or 'email'.
 * `currentPassword` is required when DOWNGRADING to email, because that removes
 * a stronger factor — the server enforces it, this only avoids a round trip.
 */
export const setTwoFactorMethod = async (method, currentPassword = '') => {
  const res = await apiFetch('/auth/two-factor-method', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ method, currentPassword }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data; // { message, twoFactorMethod, twoFactorEnabled }
};

// ── Account security dashboard (/api/security) ─────────────────────────────
// Step-up is passed as the X-Step-Up header. The token is short-lived and
// bound to the session that earned it, so it is held in component state only —
// never persisted, and never written to storage.

/** Everything the dashboard header needs, in one call. */
export const getSecuritySummary = async () => {
  const res = await apiFetch('/security/summary', { headers: { ...authHeader() } });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

/** Live session(s) + any trusted devices. Never includes token material. */
export const getSecurityDevices = async () => {
  const res = await apiFetch('/security/devices', { headers: { ...authHeader() } });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

/** Sign out one other device. Requires stepUp. */
export const revokeSecurityDevice = async (id, stepUp) => {
  const res = await apiFetch(`/security/devices/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    headers: { ...authHeader(), ...(stepUp ? { 'X-Step-Up': stepUp } : {}) },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

/** Sign out every other device. Requires stepUp. */
export const revokeOtherSecurityDevices = async (stepUp) => {
  const res = await apiFetch('/security/devices/revoke-others', {
    method: 'POST',
    headers: { ...authHeader(), ...(stepUp ? { 'X-Step-Up': stepUp } : {}) },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

/** This account's own security history, newest first. */
export const getSecurityEvents = async (limit = 25) => {
  const res = await apiFetch(`/security/events?limit=${limit}`, { headers: { ...authHeader() } });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

/**
 * Prove possession of the account: password, plus a TOTP when the
 * authenticator is the active factor. Returns a short-lived step-up token.
 */
export const securityStepUp = async (password, otp = '') => {
  const res = await apiFetch('/security/step-up', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ password, otp }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data; // { stepUp, expiresInSeconds }
};

/** Mint a new set of single-use recovery codes. Returns the ONLY copy. */
export const generateBackupCodes = async (stepUp) => {
  const res = await apiFetch('/security/backup-codes/generate', {
    method: 'POST',
    headers: { ...authHeader(), ...(stepUp ? { 'X-Step-Up': stepUp } : {}) },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data; // { codes: [...], message }
};

/** Destroy every unused recovery code. */
export const invalidateBackupCodes = async (stepUp) => {
  const res = await apiFetch('/security/backup-codes', {
    method: 'DELETE',
    headers: { ...authHeader(), ...(stepUp ? { 'X-Step-Up': stepUp } : {}) },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

/** Email a confirmation code to a candidate recovery address (not yet saved). */
export const requestRecoveryEmail = async (email, stepUp) => {
  const res = await apiFetch('/security/recovery-email/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(), ...(stepUp ? { 'X-Step-Up': stepUp } : {}) },
    body: JSON.stringify({ email }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

/** Confirm the candidate address and activate it. */
export const verifyRecoveryEmail = async (code) => {
  const res = await apiFetch('/security/recovery-email/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ code }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

/** Remove the recovery email. Requires stepUp. */
export const removeRecoveryEmail = async (stepUp) => {
  const res = await apiFetch('/security/recovery-email', {
    method: 'DELETE',
    headers: { ...authHeader(), ...(stepUp ? { 'X-Step-Up': stepUp } : {}) },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Backend entitlement check for a single feature (200 = allowed, 403 carries
// requiresPlan/currentPlan). Used BEFORE client-rendered gated actions —
// most notably PDF export, where the document is produced in the browser:
// the server verdict, never local visibility, decides whether we proceed.
export const checkFeature = async (featureKey) => {
  const res = await apiFetch(`/subscription/feature/${encodeURIComponent(featureKey)}`, {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throwFriendly(res.status, data);
  return data; // { allowed: true, feature, currentPlan }
};

// ── User notifications ────────────────────────────────────────────────
export const getNotifications = async (limit = 20) => {
  const res = await apiFetch(`/notifications?limit=${limit}`, {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

export const markNotificationRead = async (notificationId) => {
  const res = await apiFetch(`/notifications/${notificationId}/read`, {
    method: 'PATCH',
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

export const markAllNotificationsRead = async () => {
  const res = await apiFetch('/notifications/read-all', {
    method: 'POST',
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

export const deleteNotification = async (notificationId) => {
  const res = await apiFetch(`/notifications/${notificationId}`, {
    method: 'DELETE',
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Titles the server uses for account-security events (lockout.js, admin.js,
// auth.js). Matched exactly so assessment notices never leak into the
// security feed.
const SECURITY_NOTIFICATION_TITLES = new Set([
  'Too many failed sign-in attempts',
  "You're back online",
  'Your account has been restricted',
  'Your account is active again',
  'Two-factor authentication enabled',
  'Two-factor authentication disabled',
  'Password changed',
]);

// True for account-security notices → these deep-link to Profile Security.
export const isSecurityNotification = (item) =>
  !!item && item.type !== 'severe-flag' && SECURITY_NOTIFICATION_TITLES.has(item.title);

// Check whether new assessments are blocked by unresolved Priority items
export const getPriorityStatus = async () => {
  const res = await apiFetch('/assessment/priority-status', {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get dashboard data (latest assessment metrics)
export const getDashboard = async () => {
  const res = await apiFetch('/dashboard', {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  // Thread the server's machine-readable `code` + status so a 401 takes the
  // proper session-ended path (clear + notice) and callers can tell an
  // expected teardown from a real failure.
  if (!res.ok) throwFriendly(res.status, data);
  return data;
};

// Mark supplement as taken or undo
export const updateIntake = async (recordId, taken) => {
  const res = await apiFetch('/dashboard/intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ recordId, taken }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Update energy level
export const updateEnergyLevel = async (energyLevel) => {
  const res = await apiFetch('/dashboard/energy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ energyLevel }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get insights and tracking data (Deluxe/Monthly plan and above)
export const getInsights = async () => {
  const res = await apiFetch('/insights', {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throwFriendly(res.status, data);
  return data;
};

// Get full intake records for one day (interactive calendar detail)
export const getDayRecords = async (dayKey) => {
  const res = await apiFetch(`/dashboard/day/${dayKey}`, {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get calendar completion history for a specific month
export const getCalendarData = async (year, month) => {
  const res = await apiFetch(`/dashboard/calendar/${year}/${month}`, {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Add supplement to user's daily plan
export const addSupplementToPlan = async (supplementData) => {
  const res = await apiFetch('/dashboard/add-supplement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(supplementData),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Remove supplement from user's daily plan
export const removeSupplementFromPlan = async (supplementName) => {
  const res = await apiFetch('/dashboard/remove-supplement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ supplementName }),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get user's personalized supplement plan
export const getMyPlan = async () => {
  const res = await apiFetch('/dashboard/my-plan', {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};

// Get weekly adherence data
export const getWeeklyAdherence = async () => {
  const res = await apiFetch('/dashboard/weekly-adherence', {
    headers: { ...authHeader() },
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error(friendlyError(res.status, data?.message));
  return data;
};
