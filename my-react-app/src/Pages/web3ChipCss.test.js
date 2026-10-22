/**
 * The tx-hash chip's shrink rules.
 *
 * A chip holds an unbreakable token, so it is the one element that can widen a
 * whole page sideways on a phone. It first shipped with `word-break: break-all`
 * (which split a hash mid-character — "841 63e ab9…" reads as corrupted data),
 * then with `white-space: nowrap` alone (which pushed the document 61px past
 * the viewport edge on the Block Explorer tab). Only the pair below is correct:
 * refuse to break, and accept being clipped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Web3.css'), 'utf8');

const rule = (selector) => {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `${selector} must still exist`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
};

test('a hash chip never breaks a token mid-character', () => {
  const body = rule('.w3-hash {');
  assert.doesNotMatch(body, /word-break:\s*break-all/, 'break-all splits a tx hash into unreadable chunks');
  assert.match(body, /white-space:\s*nowrap/);
  // nowrap without a clip is what spills the page instead of shrinking the chip.
  assert.match(body, /overflow:\s*hidden/);
});

test('the clipped text ellipsises rather than vanishing', () => {
  const body = rule('.w3-hash-text {');
  assert.match(body, /min-width:\s*0/, 'a flex item defaults to min-width:auto and refuses to shrink');
  assert.match(body, /text-overflow:\s*ellipsis/);
});

test('a wide table scrolls inside its wrapper instead of widening the page', () => {
  assert.match(rule('.w3-table-wrap {'), /overflow-x:\s*auto/);
  assert.match(css, /\.w3-table-wrap\s*\{[^}]*min-width:\s*0/, 'the wrapper must shrink below its table');
});
