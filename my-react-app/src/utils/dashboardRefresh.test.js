/**
 * Dashboard refresh channel — the Navbar's brand control asking the dashboard
 * to reload.
 *
 * Run: npm test
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The Navbar and the Dashboard are siblings with no common owner, and the Navbar
 * must keep working when the dashboard is not mounted at all. So the request
 * travels on a window event, matching the existing `suppliwise:subscription` /
 * `suppliwise:auth-changed` convention.
 *
 * The behaviour worth pinning is the part that is easy to get wrong:
 *
 *   • It must be an IMPULSE, not a state. utils/overlayRegistry.js replays its
 *     current value to a late subscriber, because "a menu is open" is a
 *     standing fact a latecomer must know. A refresh request is not: replaying
 *     it would make a dashboard that mounted after the click refetch a second
 *     time, on top of the fetch it already performs on mount. A subscriber that
 *     attaches late must therefore receive NOTHING.
 *
 *   • It must not throw when nothing is listening, and not throw at all outside
 *     a browser (the Navbar imports this module unconditionally).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DASHBOARD_REFRESH_EVENT,
  requestDashboardRefresh,
  subscribeDashboardRefresh,
} from './dashboardRefresh.js';

/**
 * Minimal `window` stand-in.
 *
 * A real EventTarget gives us the dispatch semantics that matter, so the two
 * behaviours this channel depends on are reproduced exactly:
 *
 *   • delivery is synchronous;
 *   • `removeEventListener` unsubscribes, and there is NO replay for a listener
 *     that attaches afterwards;
 *   • a listener that THROWS is contained — `dispatchEvent` reports the
 *     exception (to `window.onerror`) and carries on with the next listener,
 *     rather than propagating it to the caller. A naive `forEach` gets this
 *     wrong, which would make the test assert behaviour the browser does not
 *     have.
 */
function withWindow(run) {
  const had = 'window' in globalThis;
  const previous = globalThis.window;
  const listeners = new Map();
  const reported = [];

  globalThis.window = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      for (const fn of [...(listeners.get(event.type) || [])]) {
        try {
          fn(event);
        } catch (error) {
          // What the browser does with a listener exception: report, continue.
          reported.push(error);
        }
      }
      return true;
    },
  };

  try {
    return run(reported);
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }
}

test('the event name is namespaced and stable', () => {
  // A literal that other modules could typo away from. It is duplicated in a
  // doc comment in DashboardPage; this is the assertion that keeps the two in
  // step, and the namespacing is what stops it colliding with anything else.
  assert.equal(DASHBOARD_REFRESH_EVENT, 'suppliwise:dashboard-refresh');
  assert.match(DASHBOARD_REFRESH_EVENT, /^suppliwise:/);
});

test('a subscriber receives the request', () => {
  withWindow(() => {
    const seen = [];
    subscribeDashboardRefresh((detail) => seen.push(detail));

    requestDashboardRefresh();

    // `null`, not `undefined`: CustomEvent's `detail` defaults to null, and the
    // Navbar sends no payload.
    assert.deepEqual(seen, [null]);
  });
});

test('the detail is passed through to subscribers', () => {
  withWindow(() => {
    const seen = [];
    subscribeDashboardRefresh((detail) => seen.push(detail));

    requestDashboardRefresh({ why: 'brand-clicked' });

    assert.deepEqual(seen, [{ why: 'brand-clicked' }]);
  });
});

test('every subscriber is notified', () => {
  withWindow(() => {
    const a = [];
    const b = [];
    subscribeDashboardRefresh((d) => a.push(d));
    subscribeDashboardRefresh((d) => b.push(d));

    requestDashboardRefresh();

    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
  });
});

test('unsubscribing stops delivery', () => {
  withWindow(() => {
    const seen = [];
    const unsubscribe = subscribeDashboardRefresh((d) => seen.push(d));

    requestDashboardRefresh();
    unsubscribe();
    requestDashboardRefresh();

    assert.equal(seen.length, 1, 'the listener kept firing after unsubscribe');
  });
});

test('unsubscribing one subscriber leaves the others alone', () => {
  withWindow(() => {
    const a = [];
    const b = [];
    const dropA = subscribeDashboardRefresh((d) => a.push(d));
    subscribeDashboardRefresh((d) => b.push(d));

    dropA();
    requestDashboardRefresh();

    assert.equal(a.length, 0);
    assert.equal(b.length, 1);
  });
});

test('a request is NOT replayed to a late subscriber', () => {
  // The contrast with overlayRegistry, and the reason this is an event and not
  // a registry: a dashboard mounting after the click already fetches on mount,
  // so replaying would double-fetch. Silence here is the correct behaviour.
  withWindow(() => {
    requestDashboardRefresh();

    const seen = [];
    subscribeDashboardRefresh((d) => seen.push(d));

    assert.deepEqual(seen, [], 'a late subscriber was handed a spent request');
  });
});

test('a request with nobody listening is a silent no-op', () => {
  // The Navbar dispatches this on every brand press, including on pages that
  // have no dashboard mounted. Nothing should be logged, thrown or queued.
  withWindow(() => {
    assert.doesNotThrow(() => requestDashboardRefresh());
    assert.doesNotThrow(() => requestDashboardRefresh());
  });
});

test('a throwing subscriber does not stop the others', () => {
  // The Navbar and the Dashboard share a window. `dispatchEvent` contains a
  // listener's exception, so one bad handler can never leave the page
  // half-refreshed — and it must not propagate into the Navbar's click handler
  // either, which is what would turn a background refresh into a broken button.
  withWindow((reported) => {
    const seen = [];
    subscribeDashboardRefresh(() => { throw new Error('boom'); });
    subscribeDashboardRefresh((d) => seen.push(d));

    assert.doesNotThrow(() => requestDashboardRefresh());

    assert.equal(seen.length, 1, 'the second subscriber never ran');
    assert.equal(reported.length, 1, 'the exception was swallowed, not reported');
    assert.match(String(reported[0]), /boom/);
  });
});

test('neither export throws outside a browser', () => {
  // The Navbar imports this module unconditionally, so the guard has to hold in
  // a non-DOM environment (Node here, and SSR/Capacitor pre-hydration).
  assert.equal(typeof globalThis.window, 'undefined', 'this test needs no window');

  assert.doesNotThrow(() => requestDashboardRefresh());
  const unsubscribe = subscribeDashboardRefresh(() => {});
  assert.equal(typeof unsubscribe, 'function');
  assert.doesNotThrow(() => unsubscribe());
});
