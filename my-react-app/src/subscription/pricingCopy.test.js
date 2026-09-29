/**
 * Pricing page copy — a claim guard.
 *
 * The server suite (server/Test File/plan-catalogue.test.js) checks that a plan
 * CARD only advertises gated features and real limits. This file covers the part
 * the server cannot see: the explanatory COLUMNS and the billing card on the
 * profile page, which are where a pricing page quietly invents a policy.
 *
 * Three policies were invented there and none of them could be kept:
 *
 *   1. "Model runs on your machine, in an isolated sandbox, or in our cloud."
 *      There is no local, sandbox or cloud execution mode anywhere in the app.
 *   2. "Extra usage is drawn from a pre-purchased block."
 *      There is no usage allowance of any kind. Every rate limit in the system is
 *      per-IP abuse protection, none of it tier-aware.
 *   3. "Cancel from account settings to stop renewal… Refund eligibility depends
 *      on your location and timing."
 *      There is no user-facing cancel, no renewal to stop, and no refund system.
 *      Every "refund" in the codebase is Web3 marketplace escrow between a buyer
 *      and a seller, which is a different product.
 *
 * A policy promise is not marketing copy. It is a commitment the code must be
 * able to keep, and these three could not be. So the copy is now derived from the
 * server, and these tests fail if any of it creeps back.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import serverCatalogue from '../../../server/utils/planCatalogue.js';
import { buildInfoColumns, PLAN_META } from './catalogue.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, ...parts), 'utf8');

/**
 * Source text with comments removed.
 *
 * These tests check for forbidden PHRASES, and the code that removed those
 * phrases explains itself in a comment that necessarily quotes them. Stripping
 * comments first is what makes the check about the shipped text rather than
 * about how carefully the author worded the note next to it.
 *
 * Only whole-line `//` comments and `/* … *\/` blocks are removed. A line is
 * never truncated mid-string, so a `https://` inside a string is untouched.
 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

/** Read a source file and return only its executable text. */
const readCode = (...parts) => stripComments(read(...parts));

/** The catalogue as the page actually receives it. */
const payload = serverCatalogue.cataloguePayload('PHP');
const columns = buildInfoColumns(payload.plans, payload.standardPeriodDays);
const allCopy = columns.map((c) => `${c.title} ${c.body} ${c.action.label}`).join(' \n ');

/**
 * The fingerprints of the three invented policies. If a phrase reappears, the
 * page is again promising something the product does not do.
 */
const INVENTED = [
  [/\bsandbox\b/i, 'a local/cloud sandbox that does not exist'],
  [/on your machine/i, 'local execution that does not exist'],
  [/pre-purchased/i, 'a pre-purchased usage block that does not exist'],
  [/usage allowance/i, 'a usage allowance that does not exist'],
  [/\brefunds?\b/i, 'a refund policy with no refund system'],
  [/stop renewal/i, 'a renewal that does not exist'],
  [/cancel from/i, 'a cancel path that does not exist'],
  [/more usage/i, 'a usage multiplier with no tier-aware quota'],
];

test('the info columns promise no policy the product does not implement', () => {
  for (const [pattern, what] of INVENTED) {
    assert.ok(!pattern.test(allCopy), `the pricing page still claims ${what} ("${pattern}")`);
  }
});

test('the period quoted in prose is the period the server grants', () => {
  // "30 days, and it never renews on its own" must not become "60 days" by
  // someone editing the sentence.
  const periodColumn = columns.find((c) => c.id === 'period');
  assert.ok(periodColumn, 'the period column exists');
  const days = payload.standardPeriodDays;
  assert.equal(days, 30, 'the server grants 30 days');
  assert.ok(
    periodColumn.title.includes(String(days)),
    `the column title must quote ${days}: "${periodColumn.title}"`,
  );
  assert.ok(
    periodColumn.body.includes(String(days)),
    `the column body must quote ${days}`,
  );
});

test('the limits quoted in prose are the limits the server enforces', () => {
  // The history sentence is assembled from the payload, so a change to the
  // engine's limit flows straight into the sentence with no second edit.
  const limitsColumn = columns.find((c) => c.id === 'limits');
  assert.ok(limitsColumn, 'the limits column exists');
  for (const plan of payload.plans) {
    const raw = plan.limits[0] || '';
    const n = /^(\d+)\s+/.exec(raw);
    if (!n) continue;
    const label = plan.label === 'Premium' ? 'Premium' : plan.label;
    if (plan.id === 'custom') {
      // Ultimate shares Premium's limit, which the sentence words as
      // "on Premium and above" — so the number is checked, not the phrasing.
      assert.ok(limitsColumn.body.includes(n[1]), `missing the limit for ${label}`);
    } else {
      assert.ok(
        limitsColumn.body.includes(`${n[1]}`),
        `the sentence is missing ${label}'s limit of ${n[1]}`,
      );
    }
  }
});

test('every column links somewhere this app actually serves', () => {
  // A dead link in a trust-building column is the same class of defect as a
  // false claim: it says "go here for the detail" and there is no detail.
  //
  // The route list is read out of App.jsx rather than restated, so a route that
  // is renamed or removed makes this fail instead of leaving a column pointing
  // at nothing.
  const appSource = readCode('..', 'App.jsx');
  const routes = new Set(
    [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]),
  );
  assert.ok(routes.size > 5, 'the route table was found; the regex is not silently empty');

  for (const column of columns) {
    const to = column.action.to;
    assert.ok(typeof to === 'string' && to.startsWith('/'), `${column.id}: bad link "${to}"`);
    // Strip the query: /profile?view=billing is served by the /profile route.
    const path = to.split('?')[0];
    assert.ok(routes.has(path), `${column.id} links to "${path}", which is not a route`);
    if (to.includes('?')) {
      const view = to.split('view=')[1];
      assert.ok(
        ['billing', 'security', 'accounts', 'personal'].includes(view),
        `${column.id} asks for an unknown profile view "${view}"`,
      );
    }
  }
});

test('the column links are real links, not buttons that navigate', () => {
  // A <button> that navigates breaks middle-click, Ctrl+click and the
  // "opens in a new tab" affordance, and a screen reader announces an action
  // rather than navigation. The columns read as navigation, so they must be
  // anchors — and this asserts the rendered element type, not the intent.
  const source = readCode('..', 'Pages', 'PricingPage.jsx');
  assert.ok(
    /<Link[^>]*className="pricing-info__link"/.test(source),
    'the info column link should be a <Link>',
  );
  assert.ok(
    !/<button[^>]*className="pricing-info__link"/.test(source),
    'the info column link is still a <button> that navigates',
  );
});

test('the plan cards name no retired tier and carry no local feature list', () => {
  // The bullets come from the server payload; this asserts the frontend has not
  // reintroduced a second copy of them.
  const source = readCode('catalogue.js');
  for (const plan of Object.values(PLAN_META)) {
    assert.equal(
      plan.features, undefined,
      `${plan.id} has a local features list again — bullets must come from the server`,
    );
    assert.equal(plan.featureKeys, undefined, `${plan.id} has a local featureKeys list again`);
  }
  for (const name of ['Pro+', 'Basic', 'Standard', 'Enterprise']) {
    assert.ok(
      !new RegExp(`name: '${name}'`).test(source),
      `PLAN_META reintroduces the retired tier "${name}"`,
    );
  }
});

test('the profile billing card does not advertise a cancel or a renewal', () => {
  // The same two claims, on the page a customer reaches AFTER paying. The
  // button used to read "Change or cancel plan" and the footnote claimed
  // cancelling stops a renewal; neither exists.
  const source = readCode('..', 'Pages', 'ProfilePage.jsx');
  assert.ok(
    !/Change or cancel plan/.test(source),
    'the billing button still offers a cancel that does not exist',
  );
  assert.ok(
    !/cancelling stops the renewal/i.test(source),
    'the billing footnote still claims cancelling stops a renewal',
  );
  assert.ok(
    !/paid access continues to the end of the period/i.test(source),
    'the billing footnote still claims a period-end cancel policy',
  );
  assert.ok(
    /Change plan/.test(source),
    'the billing button should offer the change that IS possible',
  );
});

test('the derived columns are stable: same payload, same copy', () => {
  // Guards the derivation itself: a non-deterministic column would make the page
  // change text on every render, which reads as a glitch.
  const again = buildInfoColumns(payload.plans, payload.standardPeriodDays);
  assert.deepEqual(again.map((c) => c.body), columns.map((c) => c.body));
});

/**
 * A source-wide sweep for the retired plan copy.
 *
 * The rendered-output tests above all pass while a plan card still shows the
 * old bullets if that copy lives in a file nothing imports on the pricing path —
 * which is exactly how "Access to basic AI model" and "Maximum context window"
 * survived a rename, and how the same text can reappear on a surface nobody
 * tests. This reads every source file directly, so the strings are gone from the
 * repository, not merely absent from one render.
 *
 * Comments are stripped first, because the notes explaining the removal quote
 * the phrases by necessity. Exported-string checks would defeat the purpose.
 */
const RETIRED_COPY = [
  'Access to basic AI model',
  'Limited responses',
  'Agent mode with local sandbox',
  'Access to the best AI models',
  'Extended limits',
  'Full reading list',
  'File uploads',
  'Cloud agents',
  'Maximum context window',
  'Priority access to new features',
  'Centralized billing and invoicing',
  'Advanced team + seat management',
];

test('no source file still contains the retired plan bullets', () => {
  // Every .js/.jsx/.css under src, plus the server's own modules, so a stale
  // copy on either side of the boundary is caught.
  const roots = [join(here, '..', '..'), join(here, '..', '..', '..', 'server', 'utils')];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(js|jsx|css)$/.test(entry.name)) files.push(full);
    }
  };
  roots.forEach(walk);
  assert.ok(files.length > 40, `the sweep found only ${files.length} files — the walk is broken`);

  const offenders = [];
  for (const file of files) {
    // A test file legitimately NAMES the retired strings in order to forbid
    // them; it is the only place they are allowed to appear.
    if (file.endsWith('.test.js')) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const phrase of RETIRED_COPY) {
      if (code.includes(phrase)) {
        offenders.push(`${file.replace(here, '…')}: "${phrase}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `retired plan copy is back in:\n    ${offenders.join('\n    ')}`);
});

test('the only source of plan bullets is the server payload', () => {
  // The page must not hold its own list at all. This is the structural half of
  // the guard above: even brand-new invented copy cannot appear on a card,
  // because there is nowhere on the client to put it.
  const source = readCode('catalogue.js');
  for (const plan of Object.values(PLAN_META)) {
    assert.ok(
      !/\bfeatures\s*:/.test(JSON.stringify(plan)),
      `${plan.id} carries its own features array again`,
    );
  }
  assert.ok(
    !/features\s*:\s*\[/.test(source),
    'PLAN_META has a features array again — bullets must come from the server',
  );
});
