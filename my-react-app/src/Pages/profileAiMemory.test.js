/**
 * The "What the AI remembers about you" card on the Profile page.
 *
 * Run: npm test (from my-react-app)
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The chat prompt carries a derived per-member record, and the guardrail wrapped
 * around it tells the model: "If they ask what the app remembers about them, this
 * block is exactly the answer, in these same words, and you may tell them they can
 * clear it on their Profile page." That sentence is a promise about a screen. If the
 * screen does not exist, the assistant is lying to members about their own health
 * data — in the one place a member is most likely to ask. So these tests tie the
 * promise, the endpoint and the panel together.
 *
 * Three failure modes are worth asserting rather than eyeballing:
 *
 * 1. The card promising to be a transcript. It must show labels and counts, because
 *    labels and counts are what the collection holds; anything else means memory
 *    started copying what members typed.
 * 2. Clearing happening on one click. It is not a cache refresh — the server stamps
 *    `forgetBefore`, and the assistant genuinely starts from nothing.
 * 3. The card rendering for a member whose plan has no assistant, where the endpoint
 *    answers 403 and the page shows an error on a setting they cannot have.
 *
 * The logic lives inside a .jsx component, so — as with profileLanguagePreference.test.js —
 * the source is read and asserted directly rather than imported. No bundler, no React, no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, 'ProfilePage.jsx'), 'utf8');
const api = readFileSync(join(here, '../api.js'), 'utf8');
const serverChat = readFileSync(join(here, '../../../server/routes/chat.js'), 'utf8');
const memory = readFileSync(join(here, '../../../server/utils/memberMemory.js'), 'utf8');

/** The rendered card, from its opening div to the guard that closes the block. */
function card() {
  const start = page.indexOf('id="profile-ai-memory"');
  assert.ok(start > -1, 'the memory card is gone — the guardrail still points members at it');
  const end = page.indexOf('{view === \'security\' && (', start);
  assert.ok(end > start, 'the memory card no longer precedes the security card');
  return page.slice(start, end);
}

test('the guardrail promise and the screen point at the same page', () => {
  assert.match(memory, /you may tell them they can clear it on their Profile page/,
    'if the policy stopped promising a Profile-page control, this card is dead weight');
  assert.match(page, /view === 'personal' && hasChatAccess && \(\s*\n\s*<div className="profile-section profile-section--memory" id="profile-ai-memory"/,
    'the card must live on the card the account menu actually opens');
});

test('both verbs hit the endpoint the server actually mounts', () => {
  assert.match(api, /export const getChatMemory = async \(\) => \{\n\s*const res = await apiFetch\('\/chat\/memory', \{ headers: \{ \.\.\.authHeader\(\) \} \}\)/);
  assert.match(api, /export const clearChatMemory = async \(\) => \{\n\s*const res = await apiFetch\('\/chat\/memory', \{ method: 'DELETE', headers: \{ \.\.\.authHeader\(\) \} \}\)/);
  // BASE_URL already ends in /api, so a client path starting '/api/' would 404 —
  // and a missing authHeader would 401 on a page that is otherwise signed in.
  assert.doesNotMatch(api, /apiFetch\('\/api\/chat\/memory'/);
  assert.match(serverChat, /router\.get\('\/memory', protect, requireFeature\('chat'\)/);
  assert.match(serverChat, /router\.delete\('\/memory', protect, requireFeature\('chat'\)/);
});

test('a refused read is a message, not a broken page', () => {
  for (const name of ['getChatMemory', 'clearChatMemory']) {
    const fn = api.match(new RegExp(`export const ${name} = async \\(\\) => \\{([\\s\\S]*?)\\n\\};`));
    assert.ok(fn, `${name} is missing`);
    assert.match(fn[1], /if \(!res\.ok\) throw new Error\(friendlyError\(res\.status, data\?\.message\)\)/,
      `${name} must surface the server's own wording — 403 here means the plan has no assistant`);
  }
});

test('the card is only fetched when it is both visible and allowed', () => {
  assert.match(page, /const hasChatAccess = canAccess\('chat'\)/,
    'front-end visibility only — the server decides again per request');
  const effect = page.match(/useEffect\(\(\) => \{\s*\n\s*(?:\/\/[^\n]*\n\s*)?if \(view === 'personal' && hasChatAccess\) loadAssistantMemory\(\);\s*\n\s*\}, \[[^\]]*\]\);/);
  assert.ok(effect, 'the entitlement guard and the fetch must be in the same effect, and nothing else');
  // A member on a plan without chat must never fire the request, so they can never see
  // the 403 this endpoint returns for them.
  assert.doesNotMatch(effect[0], /getChatMemory\(\)/, 'the effect must go through the one loader the Retry button uses');
  assert.doesNotMatch(effect[0], /set[A-Z]/,
    'no state is set from this effect body — the loading line is derived, which is also what React asks for');
  assert.match(page, /const aiMemoryPending = aiMemory === null && !aiMemoryError/,
    'a card that was never fetched must not sit on "Loading…" forever');
});

test('clearing is confirmed before it is done, and only in the modal', () => {
  const clearButton = page.match(/className="profile-btn profile-btn-secondary assistant-memory__clear"[\s\S]*?onClick=\{[^}]*\}/);
  assert.ok(clearButton, 'the clear button is missing from the card');
  assert.match(clearButton[0], /setShowClearMemoryConfirm\(true\)/);
  assert.doesNotMatch(clearButton[0], /clearChatMemory\(/, 'one click must not erase the member\'s record');
  assert.equal([...page.matchAll(/await clearChatMemory\(\)/g)].length, 1,
    'exactly one place performs the erase, and it is the confirmed handler');
  const modal = page.match(/\{showClearMemoryConfirm && \([\s\S]*?\n {6}\)\}/);
  assert.ok(modal, 'the confirmation dialog is gone');
  assert.match(modal[0], /onClick=\{handleClearAssistantMemory\}/);
  assert.match(modal[0], /This one cannot be undone/);
  assert.match(modal[0], /disabled=\{aiMemoryBusy\}/, 'a second clear while the first is in flight would double-stamp forgetBefore');
});

test('what the card prints is labels and counts, never anything the member typed', () => {
  const body = card();
  for (const field of ['topics', 'adherence', 'language', 'turns', 'notesVoted', 'rememberedSince']) {
    assert.ok(body.includes(field), `the card stopped showing ${field} — the member can no longer see it`);
  }
  // The view the server hands out has no prose in it. If these ever come back, memory
  // is storing sentences again and this card would be showing them.
  assert.doesNotMatch(body, /questionText|replyText|transcript|narrative|\bconcerns\b|<member_memory>/,
    'a prose field appeared in a card that is supposed to hold labels');
  assert.match(memory, /function describeMemory\(memory\)/);
  const view = memory.match(/return \{\s*\n\s*topics:[\s\S]*?rememberedSince: memory\.builtAt,\s*\n\s*\};/);
  assert.ok(view, 'describeMemory no longer returns the shaped view this card reads');
  assert.doesNotMatch(view[0], /concerns|plan:/, 'memory started storing what the member selected instead of what only this card carries');
});

test('topic chips are formatted ids, and the language name comes from the real list', () => {
  assert.match(page, /function memoryTopicLabel\(id\)/);
  assert.match(page, /\{memoryTopicLabel\(topic\)\}/, 'a raw id like "hair_loss" must not reach the screen');
  assert.match(page, /memoryLanguageLabel\(aiMemory\?\.language\)/);
  const labelFn = page.match(/function memoryLanguageLabel\(code\)[\s\S]*?\n\}/);
  assert.ok(labelFn, 'memoryLanguageLabel is gone');
  assert.match(labelFn[0], /AI_LANGUAGE_OPTIONS\.find/,
    'the card must name the language with the same words the language control uses, not invent a third list');
});

test('an empty memory still explains itself instead of showing a blank card', () => {
  const body = card();
  assert.match(body, /assistant-memory__none/, 'every row needs a "nothing yet" state — a new member sees the card on day one');
  assert.match(body, /It holds topic labels and counts, never anything you typed/);
  assert.match(body, /the History page is for/, 'deleting conversations is a different action and must not look like this one');
});
