/**
 * Button styles in the security area must have exactly one definition each.
 *
 * ── The bug this guards ────────────────────────────────────────────────────
 *
 * `.psc-btn--sm` (the compact button) was declared in TWO child panels'
 * stylesheets — SessionActivity.css and PasskeyPanel.css — and both
 * declarations were dead. These are plain stylesheets whose order in the
 * bundle follows the import order in ProfileSecurityControls.jsx, and a child
 * panel's CSS is bundled BEFORE its parent's:
 *
 *   ProfileSecurityControls.jsx
 *     import PasskeyPanel              -> PasskeyPanel.css
 *     import './ProfileSecurityControls.css'   -> the base .psc-btn, later
 *
 * Same specificity, later wins, so the base `.psc-btn { padding: 11px 20px }`
 * overrode every `.psc-btn--sm` rule before it. The small buttons rendered at
 * full size, and because the two copies of `--sm` disagreed about what "small"
 * meant, the file that won could not even be identified by reading the source.
 *
 * The same ordering hazard left `margin-top: 14px` and `padding-left: 0` inside
 * `.psc-btn--danger-ghost` — spacing that only made sense for the one place
 * that variant stands alone on its own line. Everywhere else it sits in a
 * horizontal row, so it pushed "Remove" 14px below "Rename", which centring
 * then halved to 7px in `.psc-btn-row`. A button's spacing is its container's
 * job, not the variant's.
 *
 * HONESTY: this asserts source-level invariants — one definition per shared
 * class, variants free of margins, modifiers declared in the file that owns the
 * base class. It measures no pixels, so it would not catch a layout that is
 * wrong for some unrelated reason. What it does catch is the
 * ordering-by-accident failure above, which no error ever reports: the
 * stylesheet stays valid and the rule is simply never applied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const read = (name) => readFileSync(join(here, name), 'utf8');

const CSS_FILES = readdirSync(here).filter((f) => f.endsWith('.css'));

/** Comments are prose, and prose can mention `margin:` or `{`. Strip it first. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Text inside the `{ … }` block that starts at `from`. */
function blockFrom(css, from) {
  const open = css.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Flat rules, ignoring nesting. A rule nested in an at-rule keeps the at-rule
 * prelude in its selector, so structural and media rules stay distinguishable.
 */
function rules(css) {
  const src = stripComments(css);
  const out = [];
  let prelude = '';
  let from = 0;
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '{') {
      const selector = src.slice(from, i).trim();
      const body = blockFrom(src, i) ?? '';
      if (prelude) out.push({ selector: `${prelude} { ${selector}`, body, nested: true });
      else out.push({ selector, body, nested: false });
      // An at-rule prelude ends at the block it opened; everything after the
      // closing brace is either another prelude or the next rule's selector.
      let depth = 0;
      let j = i;
      for (; j < src.length; j += 1) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const after = src.slice(j + 1, src.indexOf('{', j + 1));
      prelude = after.trim().startsWith('@') ? after.trim() : '';
      from = j + 1 + (prelude ? src.slice(j + 1).indexOf(prelude) + prelude.length : 0);
      i = j;
    }
  }
  return out;
}

/** Every rule in every panel stylesheet whose selector list names `.cls`. */
function rulesFor(cls) {
  const out = [];
  for (const file of CSS_FILES) {
    for (const rule of rules(read(file))) {
      if (new RegExp(`\\.${cls}(?![\\w-])`).test(rule.selector)) out.push({ file, ...rule });
    }
  }
  return out;
}

/**
 * The rule whose selector list is exactly `.cls` — no pseudo-class, no
 * descendant, no structural prefix. That is the declaration of the thing
 * itself; everything else is a deliberate variation of it.
 */
function bareRuleFor(cls) {
  const found = rulesFor(cls).filter((r) => r.selector === `.${cls}`);
  assert.equal(
    found.length,
    1,
    `expected one declaration of .${cls}, found ${found.length} `
    + `(${found.map((f) => f.file).join(', ')}); a same-specificity duplicate in a child `
    + "panel's stylesheet is bundled before the base rule and is silently ignored",
  );
  return found[0];
}

test('every stylesheet in the security area is readable', () => {
  assert.ok(CSS_FILES.length >= 5, `expected the panel stylesheets, found ${CSS_FILES.length}`);
});

test('a shared button modifier is declared exactly once, next to the base button', () => {
  for (const cls of ['psc-btn--sm', 'psc-btn--mt']) {
    const rule = bareRuleFor(cls);
    assert.equal(
      rule.file,
      'ProfileSecurityControls.css',
      `.${cls} is declared in ${rule.file}; it modifies the base .psc-btn, so it has to be `
      + 'declared after it',
    );
  }
  assert.ok(rulesFor('psc-btn').some((r) => r.file === 'ProfileSecurityControls.css'), 'the base .psc-btn rule is missing');
});

test('the small-button modifier really sets the size it claims to', () => {
  const { body } = bareRuleFor('psc-btn--sm');
  assert.match(body, /padding:/, '.psc-btn--sm no longer sets padding');
  assert.match(body, /font-size:/, '.psc-btn--sm no longer sets a font size');
  // Equal height whatever the label says, so "Remove" -> "Removing…" cannot
  // resize the row it sits in and leave its neighbour off-centre.
  assert.match(body, /min-height:/, '.psc-btn--sm no longer pins a height');
});

test('a button appearance variant carries no margin', () => {
  // Spacing cannot live on an appearance variant: it cannot know whether the
  // button is in a row or alone on a line, and getting that wrong is what
  // misaligned the pairs. Two exemptions, both deliberate — an explicit
  // spacing modifier, and a structural selector, which is how a one-off offset
  // is expressed without leaking into every use of the variant.
  const SPACING_MODIFIERS = new Set(['psc-btn--mt']);
  // `.psc-btn` / `.psc-btn--x`, but not `.psc-btn-row`: a container that holds
  // buttons may of course be spaced itself.
  const targetsAButton = /\.psc-btn(?=[\s,.:>#[]|$)/;

  for (const file of CSS_FILES) {
    for (const { selector, body } of rules(read(file))) {
      if (!targetsAButton.test(selector)) continue;
      if (/[>~]/.test(selector)) continue;
      const classes = [...selector.matchAll(/\.(psc-[\w-]+)/g)].map((m) => m[1]);
      if (classes.length && classes.every((c) => SPACING_MODIFIERS.has(c))) continue;

      assert.doesNotMatch(
        body,
        /(^|[;{\s])margin(-top|-bottom)?\s*:/,
        `${file}: "${selector}" sets a margin on a button variant; the offset belongs `
        + `in a spacing modifier (${[...SPACING_MODIFIERS].join(', ')}) or in the `
        + 'container, not on every use of the variant',
      );
    }
  }
});

test('the standalone destructive button keeps its offset, but only where it stands alone', () => {
  const base = bareRuleFor('psc-btn--danger-ghost');
  assert.doesNotMatch(base.body, /margin/, 'the variant regained a margin');

  const scoped = rules(read('ProfileSecurityControls.css')).filter((r) =>
    /^\.psc-card\s*>\s*\.psc-btn--danger-ghost$/.test(r.selector));
  assert.equal(scoped.length, 1, 'the standalone offset is no longer declared for the bare case');
  assert.match(scoped[0].body, /margin-top:/);
});

test('the paired device actions are centred, not hung from the top', () => {
  assert.match(bareRuleFor('psc-device__actions').body, /align-items:\s*center/);
});

test('the paired device actions wrap on a narrow screen instead of being squeezed', () => {
  const css = stripComments(read('PasskeyPanel.css'));
  const start = css.indexOf('@media');
  assert.notEqual(start, -1, 'the narrow-screen breakpoint is missing');
  const block = blockFrom(css, start);
  const actions = rules(block).find((r) => /^\.psc-device__actions$/.test(r.selector));
  assert.ok(actions, '.psc-device__actions has no narrow-screen rule');
  assert.match(actions.body, /flex-wrap:\s*wrap/);
  assert.match(actions.body, /width:\s*100%/);
});