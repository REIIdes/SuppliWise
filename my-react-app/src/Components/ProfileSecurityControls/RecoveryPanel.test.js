/**
 * RecoveryPanel — the two recovery cards, rendered for real.
 *
 * These cards were the most quietly broken part of the security page, and every
 * failure was a state the user could only discover by hitting it:
 *
 *   • The Recovery Codes card read "is two-factor on?" from the security
 *     summary — a second read of state the page already had. 2FA is turned on
 *     and off from OUTSIDE this component, so the card kept describing a state
 *     the account had already left: the "available once two-factor is on" copy,
 *     with no controls, on an account that had just turned two-factor on.
 *   • With two-factor off it rendered a heading, a sentence, and no way
 *     forward, so the one action that unblocks the user was unlabelled and a
 *     card-scroll away.
 *   • The Recovery Email card derived its form from a `mode` state seeded once
 *     from the summary. After REMOVING the address, `mode` still said 'set' and
 *     no branch matched, so the card rendered a heading and a description and
 *     nothing else — no way to add an address back without a reload.
 *   • The codes are shown exactly once and cannot be retrieved again, and the
 *     only way to keep them was to read them off the screen and retype them.
 *
 * Rendered with `react-dom/server` and asserted on the markup, because the
 * dead states above all render SUCCESSFULLY — they just render nothing. Only
 * looking at the output shows that. `useEffect` does not run during server
 * rendering, so these cover the states a user is left in rather than async
 * transitions; the network paths are covered by the server suite.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const MODULE = '/src/Components/ProfileSecurityControls/RecoveryPanel.jsx';

/**
 * The component is JSX and imports its own stylesheet, neither of which Node
 * can load. Vite already knows how to transform both, so the component is
 * loaded through its SSR pipeline rather than adding a JSX toolchain to the
 * test suite. `middlewareMode` means nothing is served or watched — this is a
 * transform, not a second dev server.
 *
 * ── `cacheDir` is load-bearing, not tidiness ─────────────────────────────────
 *
 * This server shares the project root with `npm run dev`, so without an
 * explicit `cacheDir` it defaults to `node_modules/.vite` — the SAME optimizer
 * cache the dev server owns. A Vite server initialising there starts by
 * deleting the committed dependency tree (its own log line: "removing old cache
 * dir …/node_modules/.vite/deps"), so `npm test` — run constantly, and
 * routinely alongside a dev server — silently wipes the dev server's
 * pre-bundled dependencies.
 *
 * The dev server then 504s every dependency URL, which the browser reports as
 *
 *   Failed to fetch dynamically imported module:
 *   http://localhost:5173/node_modules/.vite/deps/@simplewebauthn_browser.js?v=<hash>
 *
 * …with a dev-server log showing nothing wrong and the page refusing to render
 * until someone stops the server, deletes the cache by hand and restarts.
 * Observed here twice: 20 orphaned `deps_temp_*` directories with no committed
 * `deps/` at all, and a dev server left idle-but-wedged (module requests
 * hanging indefinitely while CPU stayed flat at zero).
 *
 * A fresh temp directory per run keeps the two caches separate by construction,
 * and concurrent test runs from sharing one optimizer state. It is removed
 * afterwards, because a throwaway cache has no business outliving its process.
 */
let RecoveryPanel;
let vite;
let cacheDir;
before(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'suppliwise-vitest-cache-'));
  vite = await createServer({
    cacheDir,
    // hmr off: this is a transform, not a server, and an HMR socket would just
    // collide with the dev server's port.
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  RecoveryPanel = await vite.ssrLoadModule(MODULE);
});
after(async () => {
  await vite?.close();
  // close() first: deleting a cacheDir out from under a live server reproduces
  // the exact half-written state this isolation exists to prevent.
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

// Resolved per call rather than at module scope: the load happens in `before`,
// which node:test runs AFTER the module body has been evaluated.
const card = (name) => (...args) => createElement(RecoveryPanel[name], ...args);

const render = (element) => renderToStaticMarkup(element);
const noop = () => {};

const codesSummary = (remaining, total = 10) => ({
  backupCodes: { remaining, total },
  twoFactor: { enabled: true, method: 'authenticator' },
});

const backupCard = (props) => render(card('BackupCodesCard')({
  summary: codesSummary(0),
  twoFactorEnabled: true,
  onRequireStepUp: noop,
  onChanged: noop,
  ...props,
}));

const emailCard = (props) => render(card('RecoveryEmailCard')({
  summary: { recoveryEmail: { address: null, verified: false } },
  onRequireStepUp: noop,
  onChanged: noop,
  ...props,
}));

const codesPanel = (props) => render(card('RecoveryCodesPanel')({
  codes: ['A1B2C-D3E4F'], copied: false, onCopy: noop, onDone: noop, ...props,
}));

const ENTITIES = { '&amp;': '&', '&apos;': "'", '&#x27;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>' };

/** The visible text of every <button> in the markup, entities decoded. */
const buttonTexts = (html) =>
  (html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs) || [])
    .map((m) => m.replace(/<[^>]*>/g, '').replace(/&(amp|apos|#x27|quot|lt|gt);/g, (e) => ENTITIES[e]).trim())
    .filter(Boolean);

// ══ Recovery Codes — the blocked state ════════════════════════════════════

test('with two-factor off, the card names the blocker and offers the way out', () => {
  // THE regression. This state rendered the "available once two-factor is on"
  // copy and no control, leaving the account unable to do anything from here.
  const html = backupCard({ twoFactorEnabled: false, onEnableTwoFactor: noop });

  assert.match(html, /Turn on two-factor authentication/,
    'a user blocked by a prerequisite must be given the action that clears it');
  assert.ok(
    buttonTexts(html).includes('Turn on two-factor authentication'),
    'the way out has to be a real control, not just a sentence',
  );
});

test('with two-factor off and no handler, the card is still informative', () => {
  // The copy must not depend on a callback existing, or the card can render a
  // bare assertion with nothing behind it.
  const html = backupCard({ twoFactorEnabled: false });
  assert.match(html, /only available once two-factor authentication is on/);
  assert.equal(buttonTexts(html).length, 0, 'no control to press, so none is claimed');
});

test('with two-factor off, a stale count is never shown', () => {
  // The server will not let an account without 2FA use codes, so surfacing a
  // leftover "4 left" would describe a capability that does not exist.
  const html = backupCard({ summary: codesSummary(4), twoFactorEnabled: false });
  assert.doesNotMatch(html, /4 of 10 left/);
  assert.doesNotMatch(html, /Regenerate codes/);
  assert.doesNotMatch(html, /Invalidate all/);
});

// ══ Recovery Codes — the enabled states ═══════════════════════════════════

test('with two-factor on and no codes, the card offers to create them', () => {
  const html = backupCard({ summary: codesSummary(0) });
  assert.ok(buttonTexts(html).includes('Create recovery codes'));
  assert.match(html, /0 of 10 left/, 'the badge must report zero, not hide the count');
  assert.match(html, /You have no recovery codes/,
    'an account with no fallback should be told so plainly');
  assert.ok(!buttonTexts(html).includes('Invalidate all'), 'nothing to invalidate');
});

test('with codes left, the card shows the count and both actions', () => {
  const html = backupCard({ summary: codesSummary(7) });
  assert.match(html, /7 of 10 left/);
  const labels = buttonTexts(html);
  assert.ok(labels.includes('Regenerate codes'));
  assert.ok(labels.includes('Invalidate all'));
  assert.doesNotMatch(html, /You have no recovery codes/);
});

test('the "copy" control only exists while the codes are on screen', () => {
  // Before generation there is nothing to copy, and offering it would be a
  // button that silently does nothing.
  assert.doesNotMatch(backupCard({ summary: codesSummary(7) }), /Copy all codes/);
  assert.ok(buttonTexts(codesPanel()).includes('Copy all codes'));
});

test('a summary with no total still reports a real count', () => {
  // A partial or older summary must not render "0 of 0 left", which reads as
  // "you have no codes" on an account that has some.
  const html = backupCard({ summary: { backupCodes: { remaining: 3 } } });
  assert.match(html, /3 left/);
  assert.doesNotMatch(html, /of 0 left/);
  assert.doesNotMatch(html, /You have no recovery codes/);
});

// ══ Recovery Codes — the one-and-only view ═════════════════════════════════

test('the codes view says they cannot be shown again, and offers a way to keep them', () => {
  const panel = codesPanel({ codes: ['A1B2C-D3E4F', 'G5H6J-K7M8N'] });
  assert.match(panel, /Save these now/);
  assert.match(panel, /cannot be shown again/);
  const labels = buttonTexts(panel);
  assert.ok(labels.includes('Copy all codes'), 'retyping ten codes by hand is not a way to keep them');
  assert.ok(labels.includes('I\'ve saved them'), 'there must be a way to dismiss and move on');
});

test('every code in the set is rendered', () => {
  const codes = Array.from({ length: 10 }, (_, i) => `AAA${i}A-BBB${i}B`);
  const panel = codesPanel({ codes });
  for (const code of codes) {
    assert.ok(panel.includes(code), `code ${code} was dropped from the list`);
  }
  assert.equal((panel.match(/<code>/g) || []).length, 10);
});

test('a set with a duplicate still renders ten rows', () => {
  // The React key is index+value, so a repeated value cannot collapse two rows
  // into one — which would hide a code the user is meant to save.
  const panel = codesPanel({ codes: ['A1B2C-D3E4F', 'A1B2C-D3E4F'] });
  assert.equal((panel.match(/<code>/g) || []).length, 2);
});

test('the copy control confirms success, and reverts', () => {
  const done = codesPanel({ copied: true });
  assert.ok(buttonTexts(done).includes('Copied'));
  // While the confirmation is showing, the "keep them somewhere else" nudge is
  // redundant with what the user just did.
  assert.doesNotMatch(done, /somewhere other than this device/);
});

test('the codes view is announced to assistive technology', () => {
  const panel = codesPanel();
  assert.match(panel, /role="status"/, 'a region appearing mid-flow should be announced');
});

// ══ Recovery Email ════════════════════════════════════════════════════════

test('with no address, the form is offered straight away', () => {
  const html = emailCard();
  assert.match(html, /Send confirmation code/);
  assert.match(html, /type="email"/, 'the field must be an email field');
  assert.match(html, /<label[^>]*for="psc-rec-email"/, 'the field needs a label pointing at it');
});

test('with a verified address, it shows the address and offers change and remove', () => {
  const html = emailCard({ summary: { recoveryEmail: { address: 'backup@example.com', verified: true } } });
  assert.match(html, /backup@example\.com/);
  assert.match(html, />Verified</);
  const labels = buttonTexts(html);
  assert.ok(labels.includes('Change'));
  assert.ok(labels.includes('Remove'));
  assert.ok(!labels.includes('Send confirmation code'),
    'the entry form must not sit alongside a saved address');
});

test('an unverified address does not look trustworthy', () => {
  const html = emailCard({ summary: { recoveryEmail: { address: 'backup@example.com', verified: false } } });
  assert.match(html, />Unverified</);
  assert.match(html, /has not been confirmed/);
});

test('the form is offered again after an address is removed', () => {
  // The regression. `mode` was seeded from the summary once; after Remove the
  // summary lost its address while `mode` still said 'set', so every branch was
  // false and the card rendered no controls at all. The state a user lands in
  // after removing an address must always offer the form again.
  const html = emailCard({ summary: { recoveryEmail: { address: null, verified: false } } });
  assert.ok(buttonTexts(html).includes('Send confirmation code'),
    'with no saved address the user must always be able to add one');
  assert.match(html, /id="psc-rec-email"/);
});

test('the form is never rendered twice', () => {
  // Two fields sharing an id break the label association and let a screen
  // reader announce the wrong one.
  const closed = emailCard({ summary: { recoveryEmail: { address: 'backup@example.com', verified: true } } });
  assert.equal((closed.match(/id="psc-rec-email"/g) || []).length, 0);
  const open = emailCard();
  assert.equal((open.match(/id="psc-rec-email"/g) || []).length, 1);
});

// ══ Accessibility & labelling ═════════════════════════════════════════════

test('both cards are labelled by their own heading', () => {
  assert.match(backupCard(), /aria-labelledby="psc-backup-title"/);
  assert.match(emailCard(), /aria-labelledby="psc-recovery-title"/);
});

test('the two cards never share an element id', () => {
  // They render on the same page; a duplicate id would break both label links.
  const html = backupCard() + emailCard();
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});
