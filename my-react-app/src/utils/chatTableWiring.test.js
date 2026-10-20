/**
 * The chat's markdown tables must stay readable inside a narrow bubble.
 *
 * Run: npm test
 *
 * WHY THIS IS A SOURCE-LEVEL TEST
 * The defect was invisible to every runtime assertion available here: a member
 * asked for their plan and got a four-column table whose columns had been
 * squeezed to 47–88 px, so "Supplement" rendered as "Supp / leme / nt" and the
 * advice underneath it read as a downgrade of the AI itself. The cause is a CSS
 * interaction — `.chat-bubble` sets `overflow-wrap: anywhere` so a long URL
 * cannot widen the transcript, and that rule inherits into table cells, where it
 * deletes the table's minimum content width and lets the automatic layout crush
 * every column. Nothing in the reply text changed; only the geometry did.
 *
 * jsdom does not lay tables out, so this pins the two halves of the fix in
 * source: the cell override and the per-column floor the wrapper scrolls against.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSourceHas } from './sourceAssert.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

const CSS = read('Pages/ChatAssistant.css');
const PAGE = read('Pages/ChatAssistant.jsx');

test('table cells wrap at spaces, not anywhere', () => {
  const block = /\.md-table th,\s*\.md-table td\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(block, 'the shared cell rule is gone');
  assert.match(block[1], /overflow-wrap:\s*normal/);
  assert.match(block[1], /word-break:\s*normal/);
});

test('the bubble still breaks long words outside tables', () => {
  // The override is scoped to tables on purpose: without the bubble rule, one
  // long link in a reply would open a horizontal scrollbar across the transcript.
  const bubble = /\.chat-bubble\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(bubble, 'the bubble rule is gone');
  assert.match(bubble[1], /overflow-wrap:\s*anywhere/);
});

test('every table column gets a readable floor and a scrollable wrapper', () => {
  assertSourceHas(PAGE, /minWidth:\s*`\$\{header\.length \* \d+\}px`/, 'MdTable must size its floor from the column count');
  const wrap = /\.md-table-wrap\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(wrap, 'the table wrapper rule is gone');
  assert.match(wrap[1], /overflow-x:\s*auto/);
});
