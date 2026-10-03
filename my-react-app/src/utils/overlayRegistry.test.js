/**
 * Overlay registry — the contract behind the AI edge tab standing down for the
 * account menu.
 *
 * Run: npm test
 *
 * Why this exists: the tab is `position: fixed; z-index: 1000`, while the
 * account menu is stuck inside the Navbar's stacking context (100 on desktop,
 * forced to 1000 on phones, which only ties the tab and still loses on DOM
 * order) — so it can never be painted over the tab by declaring a z-index of
 * its own. The tab hides itself while a menu is open — not only to stop it covering the rows, but because at z-index 1000 it
 * SWALLOWED the clicks meant for them, making the right-hand column of the menu
 * unclickable on touch.
 *
 * The one behaviour worth pinning is the late subscribe: `ChatAssistant` is
 * `lazy()`, so it can mount after the menu is already open. A plain "fire an
 * event when it opens" design would be missed and the tab would stay parked on
 * top of the menu, so `subscribeOverlays` replays the current set on attach.
 * That replay, plus the `size > 0` rule ChatAssistant derives `standDown` from,
 * is what this file asserts.
 *
 * The registry is module-level state on purpose (it has to outlive a lazy
 * component's mount), so every test closes what it opened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setOverlayOpen, subscribeOverlays } from './overlayRegistry.js';

// The id ProfileActionsMenu registers under.
const MENU = 'profile-actions-menu';

test('the tab shows when nothing is open, hides for an open menu, and returns', () => {
  setOverlayOpen(MENU, false);
  let standDown = null;
  // The exact expression ChatAssistant evaluates.
  const unsub = subscribeOverlays((set) => { standDown = set.size > 0; });

  assert.equal(standDown, false, 'no overlay open -> the tab stays put');

  setOverlayOpen(MENU, true);
  assert.equal(standDown, true, 'menu open -> the tab must stand down');

  setOverlayOpen(MENU, false);
  assert.equal(standDown, false, 'menu closed -> the tab comes back');

  unsub();
});

test('a subscriber that attaches AFTER the menu opened is replayed, not stale', () => {
  // No subscriber exists yet — the lazy tab has not mounted.
  setOverlayOpen(MENU, true);

  const seen = [];
  const unsub = subscribeOverlays((set) => seen.push(set.size));

  // Without the immediate replay the tab would wait forever for a change that
  // already happened, and would sit on top of the open menu.
  assert.deepEqual(seen, [1], 'current state must be delivered on attach');

  unsub();
  setOverlayOpen(MENU, false);
});

test('unsubscribing stops further notifications', () => {
  setOverlayOpen(MENU, false);
  let calls = 0;
  const unsub = subscribeOverlays(() => { calls += 1; });

  assert.equal(calls, 1, 'only the initial replay so far');
  unsub();

  setOverlayOpen(MENU, true);
  setOverlayOpen(MENU, false);
  assert.equal(calls, 1, 'an unsubscribed listener must never fire again');
});

test('re-setting the same value does not publish (no wasted re-renders)', () => {
  setOverlayOpen(MENU, false);
  let calls = 0;
  const unsub = subscribeOverlays(() => { calls += 1; });

  setOverlayOpen(MENU, true);
  const afterChange = calls;
  setOverlayOpen(MENU, true);
  setOverlayOpen(MENU, true);
  assert.equal(calls, afterChange, 'identical sets are skipped');

  unsub();
  setOverlayOpen(MENU, false);
});

test('every open overlay is counted, and closing one leaves the rest', () => {
  setOverlayOpen('overlay-a', true);
  setOverlayOpen('overlay-b', true);

  const seen = [];
  const unsub = subscribeOverlays((set) => seen.push([...set].sort()));

  setOverlayOpen('overlay-a', false);
  assert.equal(seen.at(-1).length, 1, 'one overlay still holds the edge');
  assert.deepEqual(seen.at(-1), ['overlay-b']);

  unsub();
  setOverlayOpen('overlay-b', false);
});

test('a subscriber that throws cannot stop the others updating', () => {
  setOverlayOpen(MENU, false);
  const survivors = [];

  const unsubBroken = subscribeOverlays(() => { throw new Error('boom'); });
  const unsubGood = subscribeOverlays((set) => survivors.push(set.size));

  setOverlayOpen(MENU, true);
  assert.equal(survivors.at(-1), 1, 'the healthy subscriber still ran');

  unsubBroken();
  unsubGood();
  setOverlayOpen(MENU, false);
});

test('a blank overlay name is ignored rather than opening an anonymous slot', () => {
  setOverlayOpen(MENU, false);
  let calls = 0;
  const unsub = subscribeOverlays(() => { calls += 1; });

  setOverlayOpen('', true);
  setOverlayOpen(undefined, true);
  assert.equal(calls, 1, 'nothing to publish — only the initial replay happened');

  unsub();
});
