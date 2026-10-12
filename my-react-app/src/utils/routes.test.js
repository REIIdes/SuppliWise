/**
 * The route table itself — a guard, not a feature test.
 *
 * src/utils/routes.js exists because three plan-buttons pointed at three
 * different answers to the same question ("where do plans live?"), and one of
 * those answers was the page the button was rendered on. A route that is
 * renamed, re-pathed or deleted is the failure mode: nothing at runtime says
 * "this link is dead", the click just politely does nothing.
 *
 * So the table is checked against the thing that actually serves routes —
 * App.jsx — the same way the pricing-copy test checks the info column links.
 * If a path here stops matching a `<Route path="…">`, this fails naming it.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ROUTES,
  PROFILE_VIEWS,
  DEFAULT_PROFILE_VIEW,
  profileView,
  pricingPath,
  PRICING_ANCHORS,
} from './routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, '..', 'App.jsx'), 'utf8');

/** Every `<Route path="…">` in App.jsx, read rather than restated. */
const routeTable = new Set(
  [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]),
);

test('the route table was actually read out of App.jsx', () => {
  // The regex is the only thing standing between this file and a table of
  // constants that silently agrees with nothing. If App.jsx's route
  // formatting ever changes, this is the failure that should sound.
  assert.ok(routeTable.size > 15, `only found ${routeTable.size} routes — the regex is empty`);
});

test('every path in ROUTES is a real route', () => {
  for (const [key, path] of Object.entries(ROUTES)) {
    assert.ok(
      routeTable.has(path),
      `ROUTES.${key} is "${path}", which App.jsx does not serve`,
    );
  }
});

test('ROUTES holds each path once', () => {
  const seen = new Map();
  for (const [key, path] of Object.entries(ROUTES)) {
    assert.ok(!seen.has(path), `ROUTES.${key} and ROUTES.${seen.get(path)} are both "${path}"`);
    seen.set(path, key);
  }
});

test('profileView only ever produces a view ProfilePage renders', () => {
  // ProfilePage allow-lists the same four names and falls back to 'personal'.
  // A helper that could emit anything else would send someone to a URL the
  // page answers with the wrong card, which is the old dead-link bug in a new
  // costume.
  for (const view of PROFILE_VIEWS) {
    assert.equal(profileView(view), `/profile?view=${view}`);
  }

  // Case and padding are tolerated — the match is on the trimmed, lowercased
  // name. Anything outside the list is not.
  assert.equal(profileView(' BILLING '), '/profile?view=billing');

  for (const junk of [undefined, null, '', '   ', 'hub', 'billing?x=1', '/profile?view=billing']) {
    assert.equal(
      profileView(junk),
      `/profile?view=${DEFAULT_PROFILE_VIEW}`,
      `profileView(${JSON.stringify(junk)}) should fall back to the default view`,
    );
  }
});

test('pricingPath builds the plans deep link and the plain page', () => {
  assert.equal(pricingPath(), '/pricing');
  assert.equal(pricingPath(undefined), '/pricing');
  assert.equal(pricingPath('plans'), '/pricing#plans');
  assert.equal(pricingPath(PRICING_ANCHORS.plans), '/pricing#plans');
  // Whatever the anchor, the PATH half must still be a served route — that is
  // what keeps the info column's "Change plan" from pointing at a dead URL.
  const path = pricingPath(PRICING_ANCHORS.plans).split('#')[0];
  assert.ok(routeTable.has(path), `the anchor path "${path}" is not a route`);
});

test('PRICING_ANCHORS names an id the pricing page actually renders', () => {
  // The pair that makes the anchor work: the helper emits the hash, the page
  // carries the element. Checked as text because PricingPage.jsx is JSX the
  // node test loader does not import.
  const source = readFileSync(join(here, '..', 'Pages', 'PricingPage.jsx'), 'utf8');
  for (const anchor of Object.values(PRICING_ANCHORS)) {
    assert.ok(
      source.includes(`id={PRICING_ANCHORS.${anchor}}`),
      `PRICING_ANCHORS.${anchor} = "${anchor}" is not rendered as an element id by PricingPage`,
    );
  }
});
