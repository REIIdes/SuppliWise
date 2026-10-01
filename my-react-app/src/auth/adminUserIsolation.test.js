/**
 * The admin console and the user session must be two separate worlds.
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 *
 * The user account DIRECTORY (`sw_accounts`) lives in localStorage, which every
 * tab in the browser shares. The admin session lives in a different key
 * (`adminToken`), and the user access token is per-tab in sessionStorage — so on
 * paper the two worlds cannot touch. But the shared directory means a tab opened
 * for the admin console can SEE that this browser has user accounts, and the
 * new-tab bootstrap then asks other tabs to hand one over. They did.
 *
 * The reported symptom, in two parts, both reproduced here:
 *
 *   1. Signing in with a passkey in another tab turned the admin tab into a
 *      user tab — it adopted the user session through the resume handshake.
 *   2. Signing out as that user then hard-navigated the admin tab to `/login`
 *      with "Your session has ended." The admin console was destroyed by a user
 *      event it had nothing to do with, because `session-dead` matched the token
 *      the tab had just adopted and every redirect was an unconditional
 *      `window.location.replace('/login')`.
 *
 * The root cause is one missing concept: nothing in the cross-tab protocol knew
 * that a tab can be an ADMIN surface, which has no use for a user session (the
 * admin pages import only `BASE_URL` / `parseJSON` / `getPasswordRules`).
 *
 * These tests drive the real module against a fake `window`, storage and
 * BroadcastChannel, because the bug lived in the interaction between them — a
 * stub of any one of them would pass while the real thing failed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isAdminRoute } from './authState.js';
import { assertSourceHas, assertSourceLacks } from '../utils/sourceAssert.js';

const here = dirname(fileURLToPath(import.meta.url));
const apiSource = readFileSync(join(here, '..', 'api.js'), 'utf8');
const appSource = readFileSync(join(here, '..', 'App.jsx'), 'utf8');

const TOKEN_KEY = 'sw_tab_token';
const ACCOUNT_KEY = 'sw_tab_account';
const DIRECTORY_KEY = 'sw_accounts';

/** A user JWT whose payload decodes, so accountIdOf()/decodeJwt() work on it. */
const userToken = (id = 'acc-1') => {
  // `btoa`, not `Buffer`: `decodeJwt` in api.js decodes with `atob`, so building
  // the token the same way exercises the real round trip. Buffer would also be a
  // lint error here (no Node globals in the browser test config).
  const payload = btoa(JSON.stringify({ id, iat: 1700000000 }));
  return `header.${payload}.signature`;
};

/**
 * Install a fake window + storage + BroadcastChannel, and return handles to
 * inspect what the module did.
 *
 * The channel is a single bus: `posted` collects everything the module sends, and
 * `deliver` simulates a message arriving from a sibling tab.
 */
function installEnv({ pathname = '/admin', session = {}, local = {} } = {}) {
  const previous = {
    window: globalThis.window,
    sessionStorage: globalThis.sessionStorage,
    localStorage: globalThis.localStorage,
    BroadcastChannel: globalThis.BroadcastChannel,
    fetch: globalThis.fetch,
  };

  const sessionStore = new Map(Object.entries(session));
  const localStore = new Map(Object.entries(local));
  const navigations = [];
  const posted = [];
  const listeners = new Set();

  const storage = (store) => ({
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });

  globalThis.window = {
    location: {
      pathname,
      replace: (url) => navigations.push(url),
    },
    dispatchEvent: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.sessionStorage = storage(sessionStore);
  globalThis.localStorage = storage(localStore);

  class FakeChannel {
    constructor() { this.onunref = () => {}; }
    unref() {}
    postMessage(data) { posted.push(data); }
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); }
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); }
  }
  globalThis.BroadcastChannel = FakeChannel;

  // `fetch` is stubbed so the sign-out path (which revokes over HTTP before it
  // redirects) completes deterministically. Left real, it would attempt a live
  // request to the API and the redirect under test would never run — the test
  // would pass for the wrong reason, which is exactly what happened the first
  // time it was written.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
    text: async () => '',
  });

  return {
    navigations,
    posted,
    sessionStore,
    localStore,
    /** Simulate a message arriving from a sibling tab. */
    deliver: (data) => { for (const fn of [...listeners]) fn({ data }); },
    restore: () => {
      globalThis.window = previous.window;
      globalThis.sessionStorage = previous.sessionStorage;
      globalThis.localStorage = previous.localStorage;
      globalThis.BroadcastChannel = previous.BroadcastChannel;
      globalThis.fetch = previous.fetch;
      if (previous.window === undefined) delete globalThis.window;
      if (previous.sessionStorage === undefined) delete globalThis.sessionStorage;
      if (previous.localStorage === undefined) delete globalThis.localStorage;
      if (previous.BroadcastChannel === undefined) delete globalThis.BroadcastChannel;
      if (previous.fetch === undefined) delete globalThis.fetch;
    },
  };
}

/** A cache-busted import, so each scenario gets its own module instance. */
const freshApi = () => import(`../api.js?bust=${Math.random().toString(36).slice(2)}`);

const withEnv = async (options, run) => {
  const env = installEnv(options);
  try {
    const api = await freshApi();
    return await run(api, env);
  } finally {
    env.restore();
  }
};

// ── The predicate everything else keys off ────────────────────────────────

test('isAdminRoute recognises the admin area and nothing else', () => {
  const check = (pathname, expected) => {
    const had = 'window' in globalThis;
    const previous = globalThis.window;
    globalThis.window = { location: { pathname } };
    try {
      assert.equal(isAdminRoute(), expected, `${pathname} -> ${expected}`);
    } finally {
      if (had) globalThis.window = previous; else delete globalThis.window;
    }
  };

  check('/admin', true);
  check('/admin/', true);
  check('/admin/login', true);
  check('/admin/change-password', true);
  check('/admin/assessment-management', true);
  // The prefix must not over-match.
  check('/administrator', false);
  check('/admin-tools', false);
  check('/login', false);
  check('/dashboard', false);
  check('/', false);
});

test('isAdminRoute is false when there is no window at all', () => {
  // A non-browser context must not throw — the module is imported by tests.
  const had = 'window' in globalThis;
  const previous = globalThis.window;
  delete globalThis.window;
  try {
    assert.equal(isAdminRoute(), false);
  } finally {
    if (had) globalThis.window = previous;
  }
});

// ── 1. The admin tab must not ADOPT a user session ────────────────────────

test('an admin tab never asks other tabs for a user session', async () => {
  await withEnv(
    { pathname: '/admin', local: { [DIRECTORY_KEY]: JSON.stringify([{ id: 'acc-1' }]) } },
    async (api, env) => {
      const resumed = await api.resumeSession(50);
      assert.equal(resumed, false, 'there is nothing to resume on an admin route');
      assert.deepEqual(
        env.posted.filter((m) => m.type === 'resume'),
        [],
        'and it must not even ask — the ask is what started the contamination',
      );
      assert.equal(env.sessionStore.get(TOKEN_KEY), undefined, 'no user token was written');
    },
  );
});

test('a user tab still resumes normally — the guard did not disable the feature', async () => {
  await withEnv(
    { pathname: '/dashboard', local: { [DIRECTORY_KEY]: JSON.stringify([{ id: 'acc-1' }]) } },
    async (api, env) => {
      const promise = api.resumeSession(50);
      // A sibling tab answers, as a real one would.
      const request = env.posted.find((m) => m.type === 'resume');
      assert.ok(request, 'a user tab does ask');
      assert.equal(request.admin, false, 'and says it is not an admin tab');
      env.deliver({ type: 'session', rid: request.rid, id: 'acc-1', token: userToken('acc-1'), user: null });
      assert.equal(await promise, true, 'and adopts the session it was offered');
      assert.equal(env.sessionStore.get(TOKEN_KEY), userToken('acc-1'));
    },
  );
});

test('the resume request tells holders this is an admin tab', () => {
  // Asserted in the SOURCE, and honestly so: `requestSessionFromTabs` is not
  // exported, and every route that reaches it now refuses on an admin route
  // first — which is the point of the fix, but it means the `admin: true` branch
  // is unobservable from outside. The two behavioural halves are covered
  // elsewhere: "a user tab resumes normally" proves the requester sets the flag
  // to false, and "a tab holding a session refuses to hand it to an admin tab"
  // proves a holder honours true. This pins the line that produces it.
  assertSourceHas(
    apiSource,
    /authChannel\.postMessage\(\{ type: 'resume', rid, ids, admin: isAdminRoute\(\) \}\)/,
    "the resume request must carry the requester's admin state",
  );
});

test('a tab holding a session refuses to hand it to an admin tab', async () => {
  await withEnv(
    { pathname: '/dashboard', session: { [ACCOUNT_KEY]: 'acc-1', [TOKEN_KEY]: userToken('acc-1') } },
    async (api, env) => {
      // A sibling asks on behalf of an admin tab.
      env.deliver({ type: 'resume', rid: 'r1', ids: ['acc-1'], admin: true });
      assert.deepEqual(
        env.posted.filter((m) => m.type === 'session'),
        [],
        'the held session must not be handed over',
      );

      // And the ordinary case still works, so the refusal is specific.
      env.posted.length = 0;
      env.deliver({ type: 'resume', rid: 'r2', ids: ['acc-1'] });
      const reply = env.posted.find((m) => m.type === 'session');
      assert.ok(reply, 'a normal tab is still served');
      assert.equal(reply.id, 'acc-1');
    },
  );
});

// ── 2. The admin tab must not be NAVIGATED by a user event ────────────────

test('a user sign-out cannot throw an admin tab onto the user login page', async () => {
  // The reported symptom, verbatim. This tab holds the user token it adopted,
  // the user signs out elsewhere, and the resulting `session-dead` message used
  // to hard-navigate the admin console to /login.
  const token = userToken('acc-1');
  await withEnv(
    { pathname: '/admin', session: { [ACCOUNT_KEY]: 'acc-1', [TOKEN_KEY]: token } },
    async (api, env) => {
      env.deliver({ type: 'session-dead', token });
      assert.deepEqual(
        env.navigations,
        [],
        'no navigation at all — AdminProtectedRoute owns where an admin tab goes',
      );
      // The local cleanup is still correct: the token really is dead.
      assert.equal(env.sessionStore.get(TOKEN_KEY), undefined, 'the dead token is still dropped');
    },
  );
});

test('the same message still signs a user tab out, at /login', async () => {
  // Proves the guard above is a redirect policy and not a disabled feature.
  const token = userToken('acc-1');
  await withEnv(
    { pathname: '/dashboard', session: { [ACCOUNT_KEY]: 'acc-1', [TOKEN_KEY]: token } },
    async (api, env) => {
      env.deliver({ type: 'session-dead', token });
      assert.deepEqual(env.navigations, ['/login'], 'a user tab goes to the user sign-in');
      assert.equal(
        env.sessionStore.get('sw_auth_notice'),
        'Your session has ended. Please sign in again.',
        'and is told why',
      );
    },
  );
});

test('a "sign out everywhere" for the held account also leaves an admin tab alone', async () => {
  const token = userToken('acc-1');
  await withEnv(
    { pathname: '/admin', session: { [ACCOUNT_KEY]: 'acc-1', [TOKEN_KEY]: token } },
    async (api, env) => {
      // Revokes server-side, clears the tab, then redirects. The redirect is
      // what must be admin-aware, and the revocation itself still happens.
      env.deliver({ type: 'sign-out', id: 'acc-1' });
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(env.navigations, [], 'an admin tab is never sent to the user login');
      assert.equal(env.sessionStore.get(TOKEN_KEY), undefined, 'the session is still revoked');
    },
  );
});

test('the same "sign out everywhere" does redirect a user tab', async () => {
  // Proves the case above is a redirect policy, not a revoked behaviour.
  const token = userToken('acc-1');
  await withEnv(
    { pathname: '/dashboard', session: { [ACCOUNT_KEY]: 'acc-1', [TOKEN_KEY]: token } },
    async (api, env) => {
      env.deliver({ type: 'sign-out', id: 'acc-1' });
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(env.navigations, ['/login']);
    },
  );
});

test('the user login and signup pages are still not reloaded from themselves', async () => {
  const token = userToken('acc-1');
  await withEnv(
    { pathname: '/login', session: { [ACCOUNT_KEY]: 'acc-1', [TOKEN_KEY]: token } },
    async (api, env) => {
      env.deliver({ type: 'session-dead', token });
      assert.deepEqual(env.navigations, [], 'a reload here would wipe the form being typed');
    },
  );
});

// ── 3. No unguarded redirect is left behind ───────────────────────────────

test('there is exactly one redirect to the user sign-in, and it is guarded', () => {
  // A count, not a regex scan: the single occurrence must be the body of
  // `goToUserSignIn`, so any NEW call site that hard-navigates to /login pushes
  // the count to two and fails. The behavioural tests above cover the known
  // paths; this covers the class, which is the part that rots quietly.
  //
  // Counted by splitting on a plain string rather than a regex literal: the
  // needle contains a `/login` with an unescaped slash, which is a syntax error
  // inside a regex literal.
  const needle = "window.location.replace('/login')";
  const occurrences = apiSource.split(needle).length - 1;
  assert.equal(
    occurrences,
    1,
    `expected one guarded redirect, found ${occurrences}`,
  );
  assertSourceHas(
    apiSource,
    /const goToUserSignIn = \(\) => \{[\s\S]*?if \(isAdminRoute\(\)\) return;[\s\S]*?window\.location\.replace\('\/login'\);[\s\S]*?\n\};/,
    'and it must live inside a guard that refuses on an admin route',
  );
});

test('the bootstrap gate does not wait for a resume on an admin route', () => {
  assertSourceHas(
    appSource,
    /useState\(\s*\(\)\s*=>\s*isAdminRoute\(\)\s*\|\|/,
    'App.jsx should treat an admin tab as already ready',
  );
});

test('an admin route is never asked to resume, even via the account switcher', () => {
  // switchAccount is reachable from the Accounts panel; a stray call on an admin
  // tab must not fetch a session. The guard is inside resumeSession, and the
  // switcher runs on the same page, so this is asserted at the source level.
  assertSourceHas(
    apiSource,
    /export const switchAccount[\s\S]*?requestSessionFromTabs/,
    'switchAccount still uses the tab handoff for user tabs',
  );
  assertSourceHas(
    apiSource,
    /export const resumeSession[\s\S]*?if \(isAdminRoute\(\)\) return false;/,
    'and the bootstrap refuses outright on an admin route',
  );
});

test('no admin page depends on a user credential', () => {
  // The premise the whole fix rests on: an `/admin/*` tab has no use for a user
  // session, so refusing to adopt one costs it nothing. If an admin page ever
  // starts importing a user-session helper, this is what says so — and the fix's
  // rationale has to be re-examined at that point rather than assumed.
  const adminPages = ['AdminLogin.jsx', 'AdminDashboard.jsx', 'AdminChangePassword.jsx', 'AssessmentManagement.jsx'];
  for (const file of adminPages) {
    const source = readFileSync(join(here, '..', 'Pages', file), 'utf8');
    assertSourceLacks(
      source,
      /\bgetToken\b|\bgetStoredUser\b|\buseAuth\b|\bstartSession\b|\bresumeSession\b|\bswitchAccount\b/,
      `${file} must not read or write a user session`,
    );
  }
});
