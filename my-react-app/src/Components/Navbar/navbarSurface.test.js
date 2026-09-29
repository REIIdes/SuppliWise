/**
 * Navbar surface — the rule that stops the sticky header going see-through.
 *
 * Run: npm test
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The bar is `position: sticky; top: 0` at 64px tall, so page content scrolls
 * UNDER it. It was shipped three separate times with a `background: transparent`
 * (or a translucent `rgba(…, 0.94)`) scrolled/light variant, once per file that
 * styles the bar:
 *
 *   1. Navbar.css            — the shared rule          (light pages)
 *   2. mobile-responsive.css — the ≤768px `!important`  (phones)
 *   3. PricingPage.css       — the dark-theme override  (the Pricing page)
 *
 * Each one is a perfectly reasonable-looking line, each one is live CSS, and
 * each one was a separate bug report: page content painted straight through the
 * wordmark and the nav links. There is no way to eyeball "is this alpha 1" at
 * a glance, and no type checker involved — which is exactly why it came back
 * three times. This file turns it into a build failure instead.
 *
 * The Pricing page is the reason a *translucent* surface is also rejected and
 * not just `transparent`: that page is near-black while its body ink is light
 * (#a9b3d4 / #f2f5ff), so 12% of body text showing through a dark bar is still
 * plainly readable. There is no alpha below 1 that is safe on both themes, so
 * every surface declaration is required to be fully opaque and the scroll
 * affordance is carried by the divider and the lift instead.
 *
 * The second half of the file pins the related rule that the top-anchored
 * overlays clear the bar: `.toast` and `.completion-toast` were `top: 24px` at
 * `z-index: 1000`, i.e. painted over the bar's right-hand side, while the phone
 * overrides used a correct 90px. The desktop half was simply missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');

/** The bar's height, as declared in Navbar.css (10px + 44px row + 10px). */
const BAR_HEIGHT = 64;

function cssFiles(dir = SRC, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'android' || entry === 'dist') continue;
      cssFiles(full, found);
    } else if (entry.endsWith('.css')) {
      found.push(full);
    }
  }
  return found;
}

/** Strip `/* … *\/` comments so commented-out CSS cannot trip a check. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Split a stylesheet into `{ selector, body }` pairs.
 *
 * Deliberately shallow: it does not evaluate at-rules, it just scans for
 * `selector { declarations }`. A media-query wrapper appears as part of the
 * selector text, which is harmless for every check below (they are substring
 * tests) and keeps this readable.
 */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const body = m[2];
    if (!/\btop\s*:|\bbottom\s*:|\bborder\w*\s*:/.test(body) && !/background/.test(body)) continue;
    out.push({ selector: m[1].replace(/\s+/g, ' ').trim(), body: body.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/** `background` / `background-color` / `background-image` values in a block. */
function backgrounds(body) {
  const out = [];
  const re = /\bbackground(?:-color|-image)?\s*:\s*([^;]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1].trim().replace(/!important$/, '').trim());
  return out;
}

/**
 * Is this value fully opaque?
 *
 * EVERY colour in the value is checked, not just the first one: a gradient can
 * hide a translucent stop behind an opaque one
 * (`linear-gradient(rgba(255,255,255,0.94) 0%, #fff 100%)`), and an early
 * `return true` on the first `#fff` would wave that straight through. Both
 * colour syntaxes are therefore walked exhaustively.
 *
 * Hex alpha follows CSS shorthand expansion: in `#rgba` the alpha nibble is
 * doubled, so `#ffff` is alpha 0xFF (opaque) and `#fff0` is alpha 0x00. Reading
 * it as a plain byte would call `#ffff` 0x0F and reject an opaque colour.
 *
 * `var(--x)` is accepted: a custom property cannot be resolved without a
 * cascade, and neither can this test. Rejecting it would ban the one safe way
 * to parameterise the surface.
 */
function isOpaque(value) {
  if (/\btransparent\b/i.test(value)) return false;
  if (/^(?:none|0)$/i.test(value.trim())) return false;

  for (const m of value.matchAll(/rgba?\(([^)]*)\)/gi)) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    // rgb(), or rgba() with the alpha omitted, is opaque by definition.
    if (parts.length >= 4 && Number(parts[3]) !== 1) return false;
  }

  for (const m of value.matchAll(/#([0-9a-f]+)/gi)) {
    const h = m[1];
    if (h.length === 3 || h.length === 6) continue;              // no alpha
    if (h.length === 4) { if (h[3].toLowerCase() !== 'f') return false; continue; }
    if (h.length === 8) { if (parseInt(h.slice(6, 8), 16) !== 255) return false; continue; }
    return false;                                                // malformed
  }

  return true;
}

/**
 * Does this selector style the BAR ITSELF (not a part of it)?
 *
 * `.navbar` / `.navbar--scrolled` / `.pricing-page .navbar` are the surface.
 * `.navbar-left`, `.navbar-brand`, `.navbar-logo-box`, `.navbar-signin-btn`,
 * `.navbar-nav-link`… are not — they are their own elements, several of them
 * legitimately translucent (the logo tile is a window onto the bar, and a nav
 * link tints on hover). Those are `navbar-<element>`; the bar's own modifiers
 * are `navbar--<modifier>`, and the two are one character apart.
 */
function isBarSurface(selector) {
  const isBar = (c) => c === 'navbar' || c.startsWith('navbar--');
  // A sub-element of the bar: `navbar-left`, `navbar-brand`, `navbar-nav-link`,
  // but NOT `navbar--scrolled`.
  const isSubElement = (c) => c.startsWith('navbar-') && !c.startsWith('navbar--');
  return selector.split(',').some((sel) => {
    const classes = [...sel.trim().matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    if (!classes.some(isBar)) return false;
    return !classes.some(isSubElement);
  });
}

const ALL = cssFiles().map((f) => ({ file: relative(SRC, f).split(sep).join('/'), css: stripComments(readFileSync(f, 'utf8')) }));

test('the navbar surface is opaque in every declaration that styles it', () => {
  const bad = [];
  for (const { file, css } of ALL) {
    for (const { selector, body } of rules(css)) {
      if (!isBarSurface(selector)) continue;
      for (const value of backgrounds(body)) {
        if (!isOpaque(value)) bad.push(`${file} — \`${selector}\` → background: ${value}`);
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    'A sticky bar with a see-through surface paints page content through the '
      + 'wordmark and the nav links. Every `.navbar` background must be fully '
      + 'opaque; carry the scroll affordance on the divider/shadow instead.\n'
      + bad.join('\n'),
  );
});

test('all three bar definitions declare a scrolled state', () => {
  // Three files style the bar, and each one used to drift: the shared rule, the
  // phone `!important` override and the dark Pricing page override. A file that
  // styles the bar but never mentions the scrolled state is the shape of the
  // bug that shipped three times, so it is worth failing on.
  const expected = {
    'Components/Navbar/Navbar.css': /\.navbar--scrolled\s*\{/,
    'mobile-responsive.css': /\.navbar\.navbar--scrolled\s*\{/,
    'Pages/PricingPage.css': /\.pricing-page \.navbar\.navbar--scrolled\s*\{/,
  };
  const missing = Object.entries(expected)
    .filter(([file, re]) => {
      const entry = ALL.find((e) => e.file === file);
      return !entry || !re.test(entry.css);
    })
    .map(([file]) => file);

  assert.deepEqual(
    missing,
    [],
    `these files style the bar but define no scrolled state: ${missing.join(', ')}`,
  );
});

test('the bar keeps the solid surface it had at rest when scrolled', () => {
  // The scrolled state is a shadow change only. If someone reintroduces a
  // lighter surface "just for the scrolled look", this is the assertion that
  // explains why not: it is the same alpha<1 bug wearing a different hat.
  const navbar = ALL.find((e) => e.file === 'Components/Navbar/Navbar.css');
  // `selector` is already trimmed and the `{` is not part of it, so match it
  // whole rather than trying to reconstruct the raw source.
  const base = rules(navbar.css).find((r) => r.selector === '.navbar');
  const scrolled = rules(navbar.css).find((r) => r.selector === '.navbar--scrolled');

  assert.ok(base, '.navbar has no rule in Navbar.css');
  assert.ok(scrolled, '.navbar--scrolled has no rule in Navbar.css');
  assert.deepEqual(
    backgrounds(scrolled.body),
    backgrounds(base.body),
    'the scrolled surface must match the resting surface exactly — only the '
      + 'divider and the lift may differ',
  );
});

test('no top-anchored fixed overlay parks inside the bar\'s band', () => {
  // `position: fixed` + `top` below the bar's height = painted over the header,
  // because these overlays all carry z-index 1000+ against the bar's 100. The
  // phone overrides already used a correct 90px; `.toast` and `.completion-toast`
  // were 24px on desktop.
  //
  // Full-bleed modal scrims are exempt: they are meant to cover the bar, and
  // they declare `inset` / `bottom`, which is how they are told apart here.
  const bad = [];
  for (const { file, css } of ALL) {
    for (const { selector, body } of rules(css)) {
      if (!/position\s*:\s*fixed/.test(body)) continue;
      const top = body.match(/(?<!max-)\btop\s*:\s*(\d+)px/);
      if (!top) continue;
      if (Number(top[1]) >= BAR_HEIGHT) continue;
      if (/\b(?:inset|bottom)\s*:/.test(body)) continue; // full-bleed scrim
      if (/modal|overlay|backdrop|scrim/i.test(selector)) continue;
      bad.push(`${file} — \`${selector}\` → top: ${top[1]}px (bar is ${BAR_HEIGHT}px)`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    'these fixed overlays are anchored inside the sticky navbar, so they cover '
      + `the notifications bell and the account pill. Anchor them at >= ${BAR_HEIGHT}px.\n`
      + bad.join('\n'),
  );
});
