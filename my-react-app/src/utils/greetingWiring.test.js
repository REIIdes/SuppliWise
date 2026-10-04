/**
 * The greeting, as wired into the dashboard.
 *
 * Run: node --test src/utils/greetingWiring.test.js
 *
 * WHY THIS IS A SOURCE-LEVEL TEST
 * `utils/greeting.test.js` proves the sentence is assembled correctly. It cannot
 * prove the dashboard ever asks for it — and that is the half that was missing:
 * the module and its tests existed while the page still rendered the fixed
 * string `isFirstLogin ? 'Welcome' : 'Welcome back'` plus a hand-built
 * `, ${firstName}` suffix. Every one of the module's guarantees (the band
 * boundaries, the whitespace-only-name guard, the single exclamation mark) was
 * true of a function no page called.
 *
 * A pure function cannot reach the JSX that decides whether it is used, so this
 * asserts the wiring instead — the same approach as planDayWiring.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSourceHas, assertSourceLacks } from './sourceAssert.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

const DASHBOARD = 'Pages/DashboardPage.jsx';

const dashboard = () => read(DASHBOARD);

test('the dashboard builds its heading through greetingFor', () => {
  assertSourceHas(dashboard(), /import \{ greetingFor \} from '\.\.\/utils\/greeting\.js'/, 'the greeting module must be imported');
  assertSourceHas(dashboard(), /greetingFor\(\s*userData,\s*now\s*\)/, 'the heading must come from greetingFor');
});

test('the rendered heading is the greeting, with nothing appended to it', () => {
  // The old markup was `{greeting}{firstName}!` — the name and the punctuation
  // were the page's job, which is exactly how a trailing space or a second "!"
  // gets into a heading. The finished sentence has to render as one string.
  assertSourceHas(dashboard(), /<h1 className="dashboard-title">\{greeting\}<\/h1>/, 'the heading must render the greeting verbatim');
  assertSourceLacks(dashboard(), /\{greeting\}\{/, 'the heading must not append a second fragment');
});

test('the old first-visit greeting is gone', () => {
  // `Welcome` / `Welcome back` keyed off `isFirstVisit` described a first login,
  // which is a property of the ACCOUNT and not of this visit. It cannot answer
  // "what time is it for this user", and it left the state and its setter in the
  // page with nothing reading them.
  assertSourceLacks(dashboard(), /'Welcome back'/, 'the account-scoped greeting must not come back');
  assertSourceLacks(dashboard(), /isFirstLogin/, 'the unused first-login state must not linger');
  assertSourceLacks(dashboard(), /setIsFirstLogin/, 'and neither must its setter');
});

test('the greeting reads a live clock, not a frozen one', () => {
  // `new Date()` at render time is correct exactly once: on a tab left open past
  // a boundary it is stale until the next reload, so the heading would disagree
  // with the slot sections underneath it. useNow also re-reads the clock on wake,
  // which is what a laptop asleep across 6 PM comes back to.
  assertSourceHas(dashboard(), /const now = useNow\(\)/, 'the greeting must read the shared live clock');
  assertSourceHas(dashboard(), /useNow from '\.\.\/hooks\/useNow'/, 'via the shared hook, not a second private interval');
  assertSourceLacks(
    dashboard(),
    /greetingFor\(userData\s*,\s*new Date\(\)/,
    'the greeting must not be handed a one-shot Date',
  );
});

test('the clock the greeting uses is the clock the slots use', () => {
  // Two clocks on one page is how "Good afternoon" ends up above a locked Night
  // stack: each read its own `new Date()`, so they disagreed for the length of a
  // 30-second tick — and only ever on a boundary, which is the worst moment to be
  // wrong. This page already kept a live clock for the dose windows; the greeting
  // reuses that one rather than taking a second reading.
  assertSourceHas(dashboard(), /const now = useNow\(\)/, 'one clock, one reading');
  assert.ok(
    (dashboard().match(/const now = /g) || []).length === 1,
    'the clock must be declared exactly once on the page',
  );
  assert.ok(
    (dashboard().match(/setInterval\(\s*tick/g) || []).length === 0,
    'the page must not carry a second private interval alongside the shared hook',
  );
  // The greeting and the slot layout have to read the same variable, not two
  // values that happened to be computed on the same line.
  assertSourceHas(dashboard(), /layoutPlan\(slotGroups, now\)/, 'the dose windows still read the shared clock');
  assertSourceHas(dashboard(), /greetingFor\(\s*userData,\s*now\s*\)/, 'and so does the greeting');
});

test('the greeting survives a profile that has not loaded yet', () => {
  // `userData` is null until the profile resolves, and the page deliberately
  // renders a retry card rather than a blank one — but the greeting is computed
  // above that guard, on every render including the loading one. It must be
  // handed the profile, not `userData.firstName` reached into blindly.
  assertSourceLacks(dashboard(), /userData\.firstName/, 'the name must be read by the module that defends against a missing profile');
});