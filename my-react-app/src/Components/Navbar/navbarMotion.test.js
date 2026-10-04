/**
 * Navbar motion — every animation in the bar must be cancellable.
 *
 * Run: npm test
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Motion was added to the header: press feedback on the brand, the nav links,
 * the bell, the account pill and the Sign In pill, a lift on the logo tile, and
 * a focus ring that fades in. Each one is a small, obviously-correct CSS rule,
 * which is exactly why they are worth a guard:
 *
 *   Adding a `transition` or a `:hover { transform }` and forgetting the
 *   `prefers-reduced-motion` counterpart is the most common way motion ships,
 *   and nothing catches it. No type checker sees it, the build passes, and the
 *   page looks right in a screenshot taken by someone whose system has motion
 *   enabled. Someone who asked their OS for less movement gets the animation
 *   anyway.
 *
 * So the contract is asserted structurally rather than left to review.
 *
 * SCOPE — MOVEMENT, NOT COLOUR
 * ───────────────────────────
 * A change of colour is not motion. The focus ring fading from transparent to
 * green, a hover tint, the scrolled-state shadow, the bell's background: those
 * are left alone on purpose. Demanding they be removed too would mean gutting a
 * design that is otherwise fine, and that is how an accessibility guard ends up
 * disabled by the next person who finds it annoying. So the properties in
 * scope are the ones that MOVE something:
 *
 *   transform, animation, and a `transition` that lists a movement property
 *   (or `all`, which cannot be reasoned about and is assumed to move).
 *
 * A `transition` left in place that only names colour properties passes, which
 * is how the bell keeps its tint without keeping its press.
 *
 * WHY THESE THREE FILES
 * ─────────────────────
 * The bar is drawn by three stylesheets. A guard reading only the first would
 * have passed while the bell and the account pill animated regardless of the
 * user's motion preference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');

const FILE_PATHS = [
  'Components/Navbar/Navbar.css',
  'Components/UserNotifications/UserNotifications.css',
  'Components/ProfileActionsMenu/ProfileActionsMenu.css',
];

const FILES = FILE_PATHS.map((f) => ({
  file: f,
  // Comments stripped first: they are full of example declarations
  // (`transform: none`, `overflow-x: hidden`) that are not live CSS.
  css: readFileSync(join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' '),
}));

/** Properties that move something. Colour/opacity/shadow are not in scope. */
const MOVEMENT_PROP = /(^|[\s,])(transform|all|background-position|translate|rotate|scale)([\s,]|$)/;

/**
 * Flat `{ selector, body, start, end }` split, with positions.
 *
 * Positions are the point. The obvious `[^{}]+\{[^{}]*\}` cannot see an at-rule
 * wrapper, so for
 *
 *     @media (prefers-reduced-motion: reduce) { .x { transform: none } }
 *
 * it matches starting AFTER the media query's brace and reports the selector as
 * `.x` — the `@media` is simply gone. Believing the wrapper is part of the
 * selector (as an earlier draft of this file did) therefore finds no
 * reduced-motion block at all, and the guard silently passes on everything.
 */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    out.push({
      selector: m[1].replace(/\s+/g, ' ').trim(),
      body: m[2].replace(/\s+/g, ' ').trim(),
      start: m.index,
      end: re.lastIndex,
    });
  }
  return out;
}

/** Byte ranges covered by a `prefers-reduced-motion` at-rule, braces matched. */
function reducedMotionSpans(css) {
  const spans = [];
  const re = /@media[^{]*prefers-reduced-motion[^{]*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const from = m.index + m[0].length;
    let depth = 1;
    let i = from;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    spans.push([from, i - 1]);
  }
  return spans;
}

/** Byte ranges covered by an `@keyframes` at-rule, braces matched. */
function keyframeSpans(css) {
  const spans = [];
  const re = /@keyframes[^{]*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const from = m.index + m[0].length;
    let depth = 1;
    let i = from;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    spans.push([from, i - 1]);
  }
  return spans;
}

/** A rule the user can trigger: `:hover`, `:active`, `:focus-visible`, anywhere in it. */
const hasState = (sel) => /:(hover|active|focus-visible)\b/.test(sel);

/** `prop: value` pairs in a declaration block. */
function decls(body, prop) {
  const out = [];
  const re = new RegExp(`(?:^|[;{])\\s*\\b${prop}\\s*:\\s*([^;]+)`, 'g');
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1].trim().replace(/!important$/, '').trim());
  return out;
}

const isNone = (v) => /^none$/i.test(v.trim());
const eachSelector = (selector) => selector.split(',').map((s) => s.trim()).filter(Boolean);

/** The compound that actually names the element: `.pam--pill .trigger:active` → `.trigger:active`. */
const lastCompound = (sel) => sel.trim().split(/\s+|>/).filter(Boolean).pop() || sel.trim();

/** Strip a trailing state so `.x:active` can be matched by a `.x` rule. */
const baseOf = (key) => key.replace(/:(hover|active|focus-visible|focus)$/, '');

test('every interactive animation in the bar is neutralised for reduced motion', () => {
  const missing = [];

  for (const { file, css } of FILES) {
    const spans = reducedMotionSpans(css);
    const frames = keyframeSpans(css);
    const all = rules(css);
    const inSpan = (list) => (r) => list.some(([a, b]) => r.start >= a && r.end <= b);
    const inReduced = inSpan(spans);
    const inKeyframes = inSpan(frames);

    // Index the reduced block by the element each of its rules targets.
    const reducedByKey = new Map();
    for (const r of all) {
      if (!inReduced(r)) continue;
      for (const sel of eachSelector(r.selector)) {
        const key = lastCompound(sel);
        if (!reducedByKey.has(key)) reducedByKey.set(key, []);
        reducedByKey.get(key).push(r);
      }
    }

    /** Is this element's motion cancelled for reduced motion? */
    const cancelled = (key, needs) => {
      const candidates = [...(reducedByKey.get(key) || []), ...(reducedByKey.get(baseOf(key)) || [])];
      return candidates.some((red) => {
        const kills = (prop, used) => !used
          || decls(red.body, prop).some((v) => isNone(v)
            // A surviving `transition` is acceptable only if it no longer names
            // anything that moves.
            || (prop === 'transition' && !MOVEMENT_PROP.test(v)));
        return kills('transform', needs.transform) && kills('animation', needs.animation) && kills('transition', needs.transition);
      });
    };

    for (const r of all) {
      // Inside a reduced-motion block already, or inside @keyframes — where
      // `from`/`to` blocks are the animation's own definition, not a rule that
      // needs cancelling (the `animation` on the element is what is cancelled).
      if (inReduced(r) || inKeyframes(r)) continue;

      const transforms = decls(r.body, 'transform').filter((v) => !isNone(v));
      const animations = decls(r.body, 'animation').filter((v) => !isNone(v));
      const transitions = decls(r.body, 'transition').filter((v) => !isNone(v) && MOVEMENT_PROP.test(v));
      if (!transforms.length && !animations.length && !transitions.length) continue;

      const needs = { transform: transforms.length, animation: animations.length, transition: transitions.length };
      const moved = [...transforms, ...animations, ...transitions].join('; ');

      for (const sel of eachSelector(r.selector)) {
        const key = lastCompound(sel);

        // Two distinct obligations, and conflating them is what produced a
        // first pass that flagged `translateX(-50%)` — a pseudo-element using
        // a transform to CENTRE ITSELF, which is layout, not motion:
        //
        //   • a state the user triggers (hover/press/focus) moves the element,
        //     so the movement itself has to be cancelled;
        //   • a resting transition that NAMES a movement property will animate
        //     whatever that state does, so the transition has to go even when
        //     the rule declares no transform of its own.
        //
        // A bare `transform` with no state and no transition is neither: it is a
        // fixed offset, and cancelling it would move the element somewhere else.
        const userTriggered = hasState(sel);
        if (!userTriggered && !transitions.length) continue;

        if (cancelled(key, needs)) continue;
        missing.push(
          `${file} — \`${sel}\` moves (${moved}) with no prefers-reduced-motion counterpart`,
        );
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    'these move something on hover/press/focus with nothing cancelling them under '
      + 'prefers-reduced-motion, so someone who asked their OS for less movement gets '
      + `it anyway:\n${missing.join('\n')}`,
  );
});

test('each bar stylesheet that moves something has a reduced-motion block', () => {
  // The per-rule assertion can be satisfied by an unrelated reduced-motion rule
  // elsewhere in the file. This pins the coarser fact: a file that moves things
  // must carry a block of its own.
  for (const { file, css } of FILES) {
    const moves = rules(css).some((r) => {
      const t = decls(r.body, 'transform').some((v) => !isNone(v));
      const a = decls(r.body, 'animation').some((v) => !isNone(v));
      const tr = decls(r.body, 'transition').some((v) => !isNone(v) && MOVEMENT_PROP.test(v));
      return t || a || tr;
    });
    if (moves) {
      assert.ok(
        reducedMotionSpans(css).length > 0,
        `${file} animates but declares no prefers-reduced-motion block`,
      );
    }
  }
});

test('the bar and its right-hand cluster never gain a containing block', () => {
  // The warning at the top of Navbar.css, as an assertion.
  //
  // The notifications panel inside the bar is `position: fixed` and JS-anchored
  // to the VIEWPORT. `transform`, `filter`, `backdrop-filter`, `perspective`,
  // `contain` or a promoting `will-change` on `.navbar` — or on `.navbar-right`,
  // the panel's parent — would make that element the panel's containing block,
  // and the panel would anchor to the bar instead, drifting as the bar pins.
  //
  // Animating the bar's CHILDREN is safe and is what the motion work does: this
  // is specifically about the two boxes the panel descends through.
  const navbar = FILES[0];
  const bad = [];

  for (const { selector, body } of rules(navbar.css)) {
    for (const sel of eachSelector(selector)) {
      const element = sel.replace(/::?[a-z-]+(?:\([^)]*\))?$/, '').trim();
      if (element !== '.navbar' && element !== '.navbar-right') continue;
      for (const prop of ['transform', 'filter', 'backdrop-filter', 'perspective', 'contain', 'will-change']) {
        for (const v of decls(body, prop)) {
          if (isNone(v)) continue;
          if (prop === 'will-change' && !/transform|filter|perspective/i.test(v)) continue;
          bad.push(`\`${sel}\` → ${prop}: ${v}`);
        }
      }
    }
  }

  assert.deepEqual(
    bad,
    [],
    'the fixed notifications panel inside the bar would anchor to the bar rather '
      + `than the viewport:\n${bad.join('\n')}`,
  );
});
