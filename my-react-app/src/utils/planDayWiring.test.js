/**
 * The 4 AM reset, as wired into the pages that show "Today's Supplements".
 *
 * Run: node --test src/utils/planDayWiring.test.js
 *
 * WHY THIS IS A SOURCE-LEVEL TEST
 * The bug was never in a formula — `utils/planDay.js` computes the right day, and
 * `Test File/plan-day.test.js` on the server side proves it. The bug was in what
 * the PAGES DID with it:
 *
 *   - they built their own day key from the calendar date, so at 2 AM the
 *     calendar highlighted a day whose doses the plan above had already rolled
 *     past;
 *   - nothing watched for the rollover, so a page left open across 4:00 AM kept
 *     rendering yesterday's finished plan until a manual reload;
 *   - the heading date came from `new Date()`, printing "Sunday 4 October" above
 *     doses belonging to the plan day that opened on the 3rd.
 *
 * None of that is reachable by calling a pure function, so this asserts the
 * wiring instead: the pages read the server's key, they refetch when it changes,
 * and no page reconstructs a day key from the calendar any more.
 *
 * A source-level assertion is a blunt instrument and this uses it deliberately.
 * What it protects is a regression that would otherwise need a browser at 4 AM to
 * notice — and which ships silently, because the page still renders, just wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

const DASHBOARD = 'Pages/DashboardPage.jsx';
const TRACKER = 'Pages/TrackIntakePage.jsx';
const INSIGHTS = 'Pages/InsightsPage.jsx';

test('both plan pages read the day key the server sent', () => {
  for (const page of [DASHBOARD, TRACKER]) {
    const source = read(page);
    assert.match(
      source,
      /data\.planDay\?\.todayKey/,
      `${page} must adopt planDay.todayKey from the response, not derive its own`,
    );
    assert.match(source, /usePlanDay\(/, `${page} must go through usePlanDay`);
  }
});

test('no plan page derives "today" from the calendar date any more', () => {
  // The shape both pages used: a helper that asked `new Date()` for its year,
  // month and day and spliced them into a YYYY-MM-DD. That answer is the calendar
  // date, which is the previous calendar date for four hours out of every eight —
  // and it is how the tracker and the server came to disagree about "today".
  //
  // Scoped to `now`/`new Date` rather than to every getFullYear(), because
  // assembling a CELL address from the month being paged through
  // (`currentDate.getFullYear()`, `getMonth()`) is correct and must stay: that
  // says where a calendar cell is, not which day it is.
  const derivedToday = /const\s+todayKey\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,320}getFullYear\(\)/;
  for (const page of [DASHBOARD, TRACKER]) {
    assert.doesNotMatch(
      read(page),
      derivedToday,
      `${page} must not derive the plan day from the calendar date`,
    );
  }
});

test('both plan pages refetch when the plan day rolls over', () => {
  // Without this the reset is only observable by reloading, which is the
  // complaint this whole change exists to fix.
  for (const page of [DASHBOARD, TRACKER]) {
    const source = read(page);
    assert.match(source, /onPlanDayReset/, `${page} must handle the reset`);
    assert.match(source, /fetchDashboardData\(\)|fetchTrackingData\(\)/, `${page} must refetch on reset`);
  }
});

test('the dashboard heading names the plan day, not the calendar date', () => {
  const source = read(DASHBOARD);
  // The heading used to be `now.toLocaleDateString(...)` — the calendar date,
  // printed directly above doses that belong to the plan day. At 2 AM that read
  // as a fresh untouched day above yesterday's completed one.
  assert.match(
    source,
    /todayKey\.split\('-'\)/,
    'the heading must be built from the plan-day key',
  );
  assert.doesNotMatch(
    source,
    /now\.toLocaleDateString\(\s*'en-US',\s*\{\s*weekday:\s*'long'/,
    'the heading must not be derived from the raw clock',
  );
});

test('the tracker calendar decides today and future from one key', () => {
  const source = read(TRACKER);
  // Two derivations (one from `new Date()`, one from a second date string) is
  // how a cell became simultaneously "today" and "future".
  assert.match(source, /const isToday = cellKey === todayKey;/);
  assert.match(source, /cellKey > todayKey/);
  assert.match(
    source,
    /if \(key >= todayKey\)/,
    'a day click must be resolved against the plan-day key',
  );
});

test('the reset boundary is written down once per package', () => {
  // One file owns the constant on each side. A second definition is a second
  // rule, which is the defect class this change removed.
  const planDay = read('utils/planDay.js');
  assert.match(planDay, /PLAN_DAY_RESET_MINUTES = 4 \* 60/);
  assert.match(planDay, /PLAN_DAY_RESET_LABEL = '4:00 AM'/);
  for (const page of [DASHBOARD, TRACKER, INSIGHTS]) {
    assert.doesNotMatch(
      read(page),
      /DEAD_HOURS = \{|PLAN_DAY_RESET_MINUTES\s*=/,
      `${page} must not redefine the boundary`,
    );
  }
});

test('the reset watcher only runs when there is a plan to roll over into', () => {
  // A user with no assessment has no plan day to change. Arming the watcher for
  // them would mean a timer and two listeners per page for nothing.
  for (const page of [DASHBOARD, TRACKER]) {
    assert.match(
      read(page),
      /enabled: todaysSupplements\.length > 0/,
      `${page} must gate the watcher on having a plan`,
    );
  }
});

test('the watcher can never spin on a near-zero delay', () => {
  // At 03:59:59.9 the raw time to the reset is under a second. Unfloored, the
  // timer fires immediately, recomputes the same near-zero delay and pins the
  // main thread until the boundary actually arrives.
  const planDay = read('utils/planDay.js');
  assert.match(planDay, /Math\.min\(Math\.max\(until, 1000\), 60 \* 60 \* 1000\)/);
  assert.match(planDay, /Math\.max\(msToNextReset\(now\), 1000\)/);
});

test('the insights progress heading names the day the server counted', () => {
  const source = read(INSIGHTS);
  assert.match(source, /data\.planDay\?\.todayKey/);
  // Parsed through the shared helper rather than `new Date(string)`, which would
  // read a bare YYYY-MM-DD as UTC midnight and shift the label by a day for
  // anyone west of Greenwich.
  assert.match(source, /parseDayKey\(dayKey\)/);
  assert.doesNotMatch(source, /new Date\(dayKey\)/, 'a day key must not be parsed by Date');
});

test("the tracker's own clock interval is not the reset mechanism", () => {
  // The 30-second tick exists to close dose WINDOWS. It is deliberately not what
  // detects the day rolling over: a page in a suspended tab can miss ticks
  // entirely, and the reset must not depend on a timer having fired. The wake
  // handlers are what make that safe, which is why usePlanDay keeps its own.
  const source = read(TRACKER);
  assert.match(source, /setInterval\(tick, 30_000\)/, 'the window clock stays');
  const hook = read('hooks/usePlanDay.js');
  assert.match(hook, /visibilitychange/, 'the reset watcher needs a wake path');
  assert.match(hook, /addEventListener\(\s*'focus'/, 'and a focus wake path');
  assert.match(hook, /planDayPollDelay/, 'and its own timer, independent of the window tick');
});