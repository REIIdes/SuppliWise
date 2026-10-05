/**
 * Navbar stickiness — the rule that stops the header scrolling away.
 *
 * Run: npm test
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `.navbar` has always been `position: sticky; top: 0`. That was never the bug.
 * The bug was one level up, and it is the quietest CSS failure there is:
 *
 *   A sticky element does not stick to the VIEWPORT. It sticks to its nearest
 *   ancestor SCROLL CONTAINER. Give that ancestor an `overflow` value that
 *   creates a scrollport and the header silently re-binds to it — and since
 *   nothing ever scrolls THAT box (the document does), the bar just sits at the
 *   top of the wrapper and rides away with the page.
 *
 * Every user-facing page renders `<Navbar />` as the first child of its own
 * full-height wrapper, and eight of those wrappers carried:
 *
 *     overflow-x: hidden;
 *
 * to stop the decorative fixed gradient blobs opening a horizontal scrollbar.
 * `hidden` on one axis forces the other axis to compute to `auto`, which is what
 * makes the wrapper a scroll container. So on /dashboard, /assessment,
 * /insights, /track-intake, /history, /recommendations, /login and /signup the
 * header scrolled off screen — while /pricing, which already used the
 * `hidden` + `clip` pair, stayed put. That inconsistency is the tell.
 *
 * The fix is `overflow-x: clip`: it contains the same overflow, but `clip` does
 * NOT create a scrollport, so the navbar keeps resolving against the viewport.
 * `hidden` is still declared first, purely as the fallback for engines without
 * `clip` support. This file holds that line.
 *
 * It also guards the two other ways an ancestor takes a sticky child's sticky
 * away without any `overflow` involved: `transform` / `filter` /
 * `backdrop-filter` / `perspective` / `contain` / `will-change` all make the
 * element a containing block, and `contain: paint` clips it outright.
 *
 * navbarSurface.test.js is the companion: that one keeps the bar OPAQUE, this
 * one keeps it PINNED.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');

/** Walk `src/` for files with one of `ext`. */
function filesWithExt(ext, dir = SRC, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'android' || entry === 'dist') continue;
      filesWithExt(ext, full, found);
    } else if (entry.endsWith(ext)) {
      found.push(full);
    }
  }
  return found;
}

const rel = (f) => relative(SRC, f).split(sep).join('/');

/** Strip `/* … *\/` so commented-out CSS cannot trip a check. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * Shallow `{ selector, body }` split. A media-query wrapper ends up as part of
 * the selector text, which is harmless for the substring tests below and keeps
 * this readable. No at-rule evaluation, on purpose.
 */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    out.push({
      selector: m[1].replace(/\s+/g, ' ').trim(),
      body: m[2].replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

/** `prop: value` pairs in a declaration block, in source order. */
function decls(body, prop) {
  const out = [];
  const re = new RegExp(`(?:^|;)\\s*\\b${prop}\\s*:\\s*([^;]+)`, 'g');
  let m;
  while ((m = re.exec(body)) !== null) {
    out.push(m[1].trim().replace(/!important$/, '').trim());
  }
  return out;
}

/**
 * Does this rule style `cls` ITSELF?
 *
 * Two things disqualify a rule:
 *
 * 1. `.home-wrapper .how-card` mentions the wrapper but styles a child inside
 *    it. Only the LAST compound selector is the element being styled.
 * 2. `.page-wrapper::before` styles a generated box, not the wrapper — a
 *    `filter` or `transform` on a pseudo-element says nothing about whether the
 *    wrapper is a containing block, and its declarations belong to that
 *    pseudo-element. So a `::` in the last compound disqualifies the rule
 *    outright rather than being stripped and then read.
 *
 * Pseudo-CLASSES (`:hover`) do NOT disqualify: `.page-wrapper:hover` really
 * does style the wrapper.
 */
function stylesElementItself(selector, cls) {
  return selector.split(',').some((sel) => {
    const compounds = sel.trim().split(/\s+|>/).filter(Boolean);
    if (!compounds.length) return false;
    const last = compounds[compounds.length - 1];
    if (last.includes('::')) return false;
    return new RegExp(`\\.${cls}\\b`).test(last);
  });
}

/** An `overflow-x` value that turns the element into a scroll container. */
const SCROLL_CREATING = /^(?:hidden|auto|scroll)$/;

/**
 * Ancestors that legitimately DO create a scroll container.
 *
 * `.support-page` is the /support app shell: `height: 100dvh; overflow: hidden`
 * with `.support-page__main` doing the scrolling, precisely so the viewport
 * never scrolls and the navbar cannot be scrolled away (see the note at the top
 * of SupportChatPage.css). Nothing scrolls `.support-page` itself, so the
 * navbar stays put — the pin holds, by a different mechanism.
 *
 * Listing it here rather than leaving the test silent is the point: an
 * exception that is written down is a decision, and one that is merely absent
 * is the thing that rots.
 */
const ALLOWED_SCROLL_CONTAINERS = new Set(['support-page']);

/**
 * The class of the element that wraps `<Navbar />`, per page.
 *
 * Discovered from the JSX rather than hardcoded, so a new page cannot ship a
 * sticky-breaking wrapper without this test noticing. A `<Navbar />` inside a
 * fragment has no wrapper element to inspect (its parent is `#root`), which is
 * recorded as `null`.
 */
function navbarParentClasses() {
  const parents = new Map(); // className -> [files]
  let navbarsFound = 0;

  for (const file of filesWithExt('.jsx')) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/<Navbar\s*\/>/.test(lines[i])) continue;
      navbarsFound++;

      let cls = null;
      for (let j = i - 1; j >= 0; j--) {
        const tag = lines[j].match(/<([A-Za-z][\w.]*)([^>]*?)>/);
        if (!tag) continue;
        const cm = tag[2].match(/className="([^"]+)"/);
        if (cm) cls = cm[1].trim().split(/\s+/)[0];
        break; // nearest enclosing open tag wins; a fragment leaves cls null
      }

      const key = cls ?? '(no wrapper)';
      if (!parents.has(key)) parents.set(key, []);
      parents.get(key).push(rel(file));
    }
  }

  return { parents, navbarsFound };
}

const { parents: PARENTS, navbarsFound: NAVBARS } = navbarParentClasses();
const PARENT_CLASSES = [...PARENTS.keys()].filter((c) => c !== '(no wrapper)');

const CSS = filesWithExt('.css').map((f) => ({
  file: rel(f),
  rules: rules(stripComments(readFileSync(f, 'utf8'))),
}));

/* ═══════════════════════════════════════════════════════════════════════ */

test('the navbar parent is discovered, so this file cannot pass vacuously', () => {
  // The whole file is driven by discovery. If the scan silently stops matching
  // (a JSX refactor, a `<Navbar></Navbar>` rewrite) it would find nothing and
  // every assertion below would pass on an empty set. Pin the counts.
  assert.ok(NAVBARS >= 20, `only found ${NAVBARS} <Navbar /> call sites — the JSX scan is broken`);
  assert.ok(
    PARENT_CLASSES.length >= 10,
    `only found ${PARENT_CLASSES.length} wrapper classes: ${PARENT_CLASSES.join(', ')}`,
  );
  // Spot-check the wrappers that carry the bug, so a discovery that returns the
  // right COUNT of the wrong classes is still caught.
  for (const expected of ['dashboard-wrapper', 'assessment-wrapper', 'insights-wrapper',
    'track-intake-wrapper', 'history-wrapper', 'recommendations-wrapper',
    'page-wrapper', 'pricing-page', 'support-page']) {
    assert.ok(PARENTS.has(expected), `no page renders <Navbar /> inside .${expected} any more`);
  }
  // .home-wrapper, .results-wrapper, .pwreset-page and .w3-page never needed a
  // clip, so they must stay in the set and stay clean.
  assert.ok(PARENTS.has('home-wrapper'));
  assert.ok(PARENTS.has('w3-page'));
});

test('no navbar wrapper is turned into a scroll container', () => {
  // THE assertion. `overflow-x: hidden` forces `overflow-y` to compute to `auto`,
  // which makes the wrapper a scroll container, which silently re-binds the
  // sticky navbar to it — so the header scrolls away with the page.
  // `overflow-x: clip` contains the same overflow and creates no scrollport.
  const bad = [];

  for (const cls of PARENT_CLASSES) {
    if (ALLOWED_SCROLL_CONTAINERS.has(cls)) continue;
    for (const { file, rules: rs } of CSS) {
      for (const { selector, body } of rs) {
        if (!stylesElementItself(selector, cls)) continue;
        const values = [...decls(body, 'overflow-x'), ...decls(body, 'overflow')];
        // The LAST declaration in the file is the one that wins, so that is the
        // one judged. `overflow: clip` counts as safe; shorthand `overflow:
        // hidden` is the exact bug.
        const winner = values[values.length - 1];
        if (winner === undefined) continue;
        if (SCROLL_CREATING.test(winner)) {
          bad.push(`${file} — \`${selector}\` → overflow(-x): ${winner} on .${cls}`);
        }
      }
    }
  }

  assert.deepEqual(
    bad,
    [],
    'a scroll container between the navbar and the viewport silently un-pins the '
      + 'header: a sticky element binds to its NEAREST ancestor scroll container, '
      + 'and nothing scrolls this box. Use `overflow-x: clip` (declare `hidden` '
      + 'first only as the fallback for engines without `clip` support).\n'
      + bad.join('\n'),
  );
});

test('every wrapper that clips also declares clip AFTER hidden', () => {
  // Ordering is the whole mechanism: `clip` must be the winner, and it only
  // wins if it is declared second. Getting this backwards reinstates the bug
  // while still looking correct in the source.
  const bad = [];
  for (const cls of PARENT_CLASSES) {
    if (ALLOWED_SCROLL_CONTAINERS.has(cls)) continue;
    for (const { file, rules: rs } of CSS) {
      let hidden = false;
      let clip = false;
      for (const { selector, body } of rs) {
        if (!stylesElementItself(selector, cls)) continue;
        for (const v of [...decls(body, 'overflow-x'), ...decls(body, 'overflow')]) {
          if (v === 'hidden') { hidden = true; clip = false; }
          if (v === 'clip') clip = true;
        }
      }
      if (hidden && !clip) bad.push(`${file} — .${cls} sets overflow-x: hidden with no clip override`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('no navbar wrapper becomes a containing block or clips itself', () => {
  // The other ways an ancestor takes a sticky child's sticky away, none of
  // which involve `overflow`:
  //   transform / filter / backdrop-filter / perspective / contain → the
  //   element becomes the containing block for its `position: fixed`
  //   descendants, and `contain: paint` clips descendants outright;
  //   will-change on either of those pre-promotes it the same way.
  const CONTAINING_BLOCK = /^(transform|filter|backdrop-filter|perspective|contain|will-change)$/;
  const bad = [];

  for (const cls of PARENT_CLASSES) {
    for (const { file, rules: rs } of CSS) {
      for (const { selector, body } of rs) {
        if (!stylesElementItself(selector, cls)) continue;
        for (const prop of ['transform', 'filter', 'backdrop-filter', 'perspective',
          'contain', 'will-change']) {
          for (const v of decls(body, prop)) {
            // `filter: none`, `transform: none` and a `will-change` that names
            // neither transform nor filter are inert.
            if (/^none$/i.test(v)) continue;
            if (prop === 'will-change' && !/transform|filter|perspective|contain/i.test(v)) continue;
            if (prop === 'contain' && !/paint|layout|strict|content/i.test(v)) continue;
            if (CONTAINING_BLOCK.test(prop)) {
              bad.push(`${file} — \`${selector}\` → ${prop}: ${v} on .${cls}`);
            }
          }
        }
      }
    }
  }

  assert.deepEqual(
    bad,
    [],
    'these turn the navbar\'s wrapper into a containing block, which breaks the '
      + 'sticky header and the notifications panel anchored inside it.\n'
      + bad.join('\n'),
  );
});

test('the scroll-root elements do not create a scroll container either', () => {
  // `body` is one more ancestor between the navbar and the viewport, and
  // mobile-responsive.css sets `overflow-x: hidden` on it for phones in
  // portrait. The rule is inside a media query, so the desktop header is fine
  // and only the mobile one breaks — which is why it survived review.
  const bad = [];
  for (const { file, rules: rs } of CSS) {
    for (const { selector, body } of rs) {
      if (!/^\s*(html|body)\s*$/.test(selector)) continue;
      const values = [...decls(body, 'overflow-x'), ...decls(body, 'overflow')];
      const winner = values[values.length - 1];
      if (winner !== undefined && SCROLL_CREATING.test(winner)) {
        bad.push(`${file} — \`${selector}\` → overflow(-x): ${winner}`);
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    'a scroll container on <html>/<body> rebinds the sticky navbar on every page. '
      + 'Declare `overflow-x: clip` after `hidden` instead.\n'
      + bad.join('\n'),
  );
});

test('the support app shell stays a deliberate, documented exception', () => {
  // Guard the allowlist itself: an entry that is no longer needed must be
  // removed, not left behind weakening the check.
  for (const cls of ALLOWED_SCROLL_CONTAINERS) {
    assert.ok(
      PARENTS.has(cls),
      `.${cls} is allowlisted as a scroll container but no page renders <Navbar /> `
        + 'inside it any more — drop it from ALLOWED_SCROLL_CONTAINERS',
    );
  }
});
