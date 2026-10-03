/**
 * The reported bug, driven end to end.
 *
 * Simulates the two tabs exactly as described:
 *   Tab A — the admin console, holding only `adminToken` (localStorage).
 *   Tab B — a user tab, already signed in (the passkey path ends in startSession).
 *
 *   1. Tab A boots its session bootstrap. It must NOT become a user tab.
 *   2. Tab B signs out. Tab A must stay on the admin console — not be thrown onto
 *      /login with "Your session has ended."
 *
 * Two real module instances, a real BroadcastChannel bus, and the real
 * `signOutAccount`, so the cross-tab message is genuinely produced by one tab and
 * genuinely handled by the other.
 *
 * ── Why `act()` exists ────────────────────────────────────────────────────
 *
 * A browser tab has its own `window`; a Node process has one `globalThis.window`.
 * The modules read `window.location` lazily, at call time, so a tab's code run
 * outside its own context would read the WRONG tab's route — and the test would
 * pass or fail for reasons that cannot happen in a browser. `act()` installs the
 * tab's window for the duration of a call, so each module instance observes the
 * route its own tab is on.
 */
const storage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};

// One shared bus, as in a real browser: same-origin tabs only.
//
// `contexts` is the important part. Message HANDLERS run asynchronously, so a
// listener dispatched here would read whichever tab's storage happened to be
// installed globally — not its own. Every channel therefore remembers how to
// enter and leave its own tab, and delivery happens inside that. Without it the
// simulation quietly tests the wrong tab and passes for the wrong reason.
const bus = new Map();
const contexts = new WeakMap();

class BusChannel {
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this.listeners = new Set();
    if (!bus.has(name)) bus.set(name, new Set());
    bus.get(name).add(this);
  }
  postMessage(data) {
    // Structured-clone-ish, delivered asynchronously like the real thing.
    queueMicrotask(() => {
      for (const peer of bus.get(this.name)) {
        if (peer === this) continue;
        const event = { data: JSON.parse(JSON.stringify(data)) };
        const ctx = contexts.get(peer);
        if (!ctx) { deliver(peer, event); continue; }
        ctx.enter();
        try { deliver(peer, event); } finally { ctx.exit(); }
      }
    });
  }
  addEventListener(type, fn) { if (type === 'message') this.listeners.add(fn); }
  removeEventListener(type, fn) { if (type === 'message') this.listeners.delete(fn); }
  close() { bus.get(this.name)?.delete(this); }
  unref() {}
}

const deliver = (peer, event) => {
  for (const fn of peer.listeners) fn(event);
  if (typeof peer.onmessage === 'function') peer.onmessage(event);
};

const userJwt = (id) => `h.${btoa(JSON.stringify({ id, iat: 1700000000 }))}.s`;

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? '  -> ' + extra : ''}`);
  ok ? pass += 1 : fail += 1;
};

async function makeTab(pathname, { local = {}, session = {} } = {}) {
  const localStore = storage();
  for (const [k, v] of Object.entries(local)) localStore.setItem(k, v);
  const sessionStore = storage();
  for (const [k, v] of Object.entries(session)) sessionStore.setItem(k, v);

  const navigations = [];
  // Messages this tab's module instance sends, so a test can assert that the
  // cross-tab notification actually went out (a sign-out that silently skipped
  // it would leave the other tabs stale, and the redirect guard would look
  // correct for the wrong reason).
  const posted = [];
  const win = {
    location: {
      pathname,
      hostname: 'localhost',
      protocol: 'http:',
      replace: (u) => navigations.push(u),
    },
    dispatchEvent: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const previous = {
    window: globalThis.window,
    sessionStorage: globalThis.sessionStorage,
    localStorage: globalThis.localStorage,
    BroadcastChannel: globalThis.BroadcastChannel,
    fetch: globalThis.fetch,
  };

  // Installed BEFORE the import: api.js constructs its BroadcastChannel at module
  // load, so a wrapper added afterwards would never see a thing. Recording what a
  // tab announces matters because a sign-out that silently skipped the
  // notification would leave every other tab stale — and the redirect guard
  // would then look correct for entirely the wrong reason.
  class RecordingChannel extends BusChannel {
    constructor(name) {
      super(name);
      // This channel belongs to THIS tab, so a message it receives is handled as
      // this tab. The context is the globals api.js reads at call time.
      contexts.set(this, {
        enter: () => {
          globalThis.window = win;
          globalThis.sessionStorage = sessionStore;
          globalThis.localStorage = localStore;
        },
        exit: () => { /* the caller's finally restores the previous globals */ },
      });
    }
    postMessage(data) { posted.push(data); super.postMessage(data); }
  }
  globalThis.window = win;
  globalThis.sessionStorage = sessionStore;
  globalThis.localStorage = localStore;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  globalThis.BroadcastChannel = RecordingChannel;

  const api = await import(`../src/api.js?tab=${Math.random().toString(36).slice(2)}`);

  const restore = () => {
    globalThis.window = previous.window;
    globalThis.sessionStorage = previous.sessionStorage;
    globalThis.localStorage = previous.localStorage;
    globalThis.BroadcastChannel = previous.BroadcastChannel;
    globalThis.fetch = previous.fetch;
  };

  return {
    api,
    win,
    navigations,
    posted,
    localStore,
    sessionStore,
    /** Run `fn` with THIS tab installed as the ambient context. */
    act: async (fn) => {
      globalThis.window = win;
      globalThis.sessionStorage = sessionStore;
      globalThis.localStorage = localStore;
      try { return await fn(); } finally { restore(); }
    },
    restore,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

(async () => {
  // A browser that has, at some point, had a user signed in: the shared
  // directory is populated. This is the precondition for the whole bug — it is
  // the only reason an admin tab ever thought it should resume anything.
  const directory = JSON.stringify([{ id: 'acc-1', lastUsedAt: 1 }]);

  // Tab B: a user tab, already signed in.
  const user = await makeTab('/dashboard', {
    local: { sw_accounts: directory },
    session: { sw_tab_account: 'acc-1', sw_tab_token: userJwt('acc-1') },
  });

  // Tab A: the admin console, opened fresh. Only `adminToken` — no user session.
  const admin = await makeTab('/admin', {
    local: { sw_accounts: directory, adminToken: userJwt('admin-1') },
  });

  const adminTokenBefore = admin.localStore.getItem('adminToken');
  const startToken = await admin.act(() => admin.api.getToken());
  check('the admin tab starts with no user session', startToken === '', startToken || '(none)');

  // ── Step 1: the admin tab boots its session bootstrap ───────────────────
  const resumed = await admin.act(() => admin.api.resumeSession(80));
  await settle();
  check('the admin tab refuses to resume a user session', resumed === false, `resumeSession -> ${resumed}`);
  const afterResume = await admin.act(() => admin.api.getToken());
  check('  and still holds no user token', afterResume === '', afterResume || '(none)');
  check('  and was not navigated anywhere', admin.navigations.length === 0, JSON.stringify(admin.navigations));

  // ── Step 2: the user signs out in the OTHER tab ─────────────────────────
  // `signOutAccount` clears the tab and tells its siblings; the tab's OWN
  // redirect is the caller's job (the navbar owns where sign-out goes next), so
  // what this tab does is drop the token — and what the ADMIN tab does is
  // nothing at all.
  await user.act(() => user.api.signOutAccount('acc-1'));
  await settle();
  const userToken = await user.act(() => user.api.getToken());
  check('the user tab dropped its token', userToken === '', userToken || '(none)');
  check('  and told the other tabs the session is dead',
    user.posted.some((m) => m.type === 'session-dead'), JSON.stringify(user.posted.map((m) => m.type)));

  // ── Step 3: what the admin tab did ─────────────────────────────────────
  check('THE BUG: the admin tab was NOT sent to the user login',
    !admin.navigations.includes('/login'), JSON.stringify(admin.navigations));
  check('  the admin tab was not navigated at all',
    admin.navigations.length === 0, JSON.stringify(admin.navigations));
  check('  the admin token is untouched', admin.localStore.getItem('adminToken') === adminTokenBefore);
  check('  the admin tab is still on an admin route', admin.win.location.pathname.startsWith('/admin'),
    admin.win.location.pathname);

  // ── And the reverse direction, which must also hold ────────────────────
  // A user tab must STILL resume a held session. If the fix had simply disabled
  // the bootstrap, every check above would pass and the feature would be gone.
  //
  // The holder must hold an account that is IN THE SHARED DIRECTORY: a resume
  // request only names known account ids, so a holder of some other account
  // correctly declines and the test would be measuring its own bad fixture.
  const heldToken = userJwt('acc-1');
  const holder = await makeTab('/dashboard', {
    local: { sw_accounts: directory },
    session: { sw_tab_account: 'acc-1', sw_tab_token: heldToken },
  });
  const newcomer = await makeTab('/dashboard', { local: { sw_accounts: directory } });
  const pending = newcomer.act(() => newcomer.api.resumeSession(150));
  await settle();
  const freshResumed = await pending;
  check('a new user tab still resumes a held session', freshResumed === true, `-> ${freshResumed}`);
  const adopted = await newcomer.act(() => newcomer.api.getToken());
  check('  and received the holder\'s token', adopted === heldToken, adopted || '(none)');

  // And the admin tab must not have picked that session up either, just because
  // one is on offer.
  check('the admin tab ignored the handover it was offered',
    admin.navigations.length === 0 && (await admin.act(() => admin.api.getToken())) === '',
    JSON.stringify(admin.navigations));

  [admin, user, holder, newcomer].forEach((t) => t.restore());
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', (e && e.stack) || e); process.exit(1); });
