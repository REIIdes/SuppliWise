/**
 * The "starts tomorrow" block, as built and as wired.
 *
 * Run: node --test src/utils/planDeferred.test.js
 *
 * WHY THIS FILE EXISTS
 * `slotSchedule.test.js` proves a forgiven frame never shows as a miss. It cannot
 * prove the frame is still EXPLAINED somewhere. The server stopped writing those
 * rows into today at all (server/utils/todayPlanSync.js), so from the page's point
 * of view half the plan simply is not there — and a plan whose Morning stack
 * vanished reads as a bug, not as a 4 AM reset. This covers the two things that
 * make it visible: the view built from `planDeferred`, and the pages actually
 * rendering it.
 *
 * The wording is load-bearing. "Not part of today" is true; "missed" is not, and
 * a user who is told they missed a dose they were never asked to take will try to
 * make it up at 11 PM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSourceHas, assertSourceLacks } from './sourceAssert.js';
import { deferredPlanView } from './planDeferred.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

const DASHBOARD = 'Pages/DashboardPage.jsx';
const TRACKER = 'Pages/TrackIntakePage.jsx';
const SECTION = 'Components/DeferredPlanSection.jsx';

/** The payload `GET /api/dashboard` sends for a plan made at 3 PM. */
const deferred = (items, overrides = {}) => ({
  count: items.length,
  items,
  startsDayKey: '2031-04-18',
  startsAtLabel: '4:00 AM',
  ...overrides,
});

const dose = (name, timeSlot, extra = {}) => ({
  name,
  dosage: '1 capsule',
  priority: 'Medium',
  scheduledTime: 'Morning',
  timeSlot,
  timeSlotLabel: timeSlot === 'night' ? 'Night' : 'Morning',
  timeSlotOrder: 0,
  ...extra,
});

// ── When the block says nothing ────────────────────────────────────────────

test('an absent, empty or malformed block activates nothing', () => {
  // Every day that is not a plan's first looks like this, and so does a response
  // from a server that predates the feature. Both must render no section rather
  // than an empty heading with a count of zero under it.
  for (const input of [null, undefined, {}, [], 'nope', 0, deferred([])]) {
    const view = deferredPlanView(input, { todayKey: '2031-04-17' });
    assert.equal(view.active, false, `${JSON.stringify(input)} must be inactive`);
    assert.equal(view.count, 0);
    assert.deepEqual(view.groups, []);
    assert.equal(view.text, '');
  }
});

test('a list of items with no names activates nothing', () => {
  // The server builds these from AI recommendations, so an entry whose name lost
  // its text is a real shape. A section reading "2 doses are not part of today"
  // over two blank rows is worse than no section.
  const view = deferredPlanView(
    deferred([dose('   ', 'morning'), { timeSlot: 'morning' }, null]),
    { todayKey: '2031-04-17' },
  );
  assert.equal(view.active, false);
});

// ── Grouping ───────────────────────────────────────────────────────────────

test('items group by frame in the order the day runs, not the server order', () => {
  const view = deferredPlanView(
    deferred([
      dose('Magnesium', 'night'),
      dose('Vitamin D3', 'morning'),
      dose('Zinc', 'afternoon'),
      dose('Omega-3', 'morning', { dosage: '1000 mg' }),
    ]),
    { todayKey: '2031-04-17' },
  );

  assert.deepEqual(view.groups.map((g) => g.key), ['morning', 'afternoon', 'night']);
  assert.equal(view.groups[0].items.length, 2, 'two doses in one frame is one group');
  assert.equal(view.count, 4, 'the count is doses, not frames');
});

test('the frame is named the way the rest of the page names it', () => {
  // The server calls the 10 PM frame "Night". This page has always called it
  // "Before Bed", and two names for one frame on one screen reads as two frames.
  const view = deferredPlanView(deferred([dose('Magnesium', 'night')]), {
    todayKey: '2031-04-17',
  });
  assert.equal(view.groups[0].label, 'Before Bed');
  assert.notEqual(view.groups[0].label, view.groups[0].items[0].timeSlotLabel);
});

test('a frame is shown with the window the client already locks it by', () => {
  const view = deferredPlanView(deferred([dose('Vitamin D3', 'morning')]), {
    todayKey: '2031-04-17',
  });
  assert.equal(view.groups[0].window, '4:00 AM – 12:00 PM');
});

test('an unrecognised frame keeps the server label and shows no window', () => {
  // A frame the client has never heard of must still be listed — dropping it
  // would hide a dose from a user who will be asked for it tomorrow. It just
  // cannot be given a window it does not have.
  const view = deferredPlanView(
    deferred([dose('Weird One', 'with-food', { timeSlotLabel: 'With Food' })]),
    { todayKey: '2031-04-17' },
  );
  assert.equal(view.active, true);
  assert.equal(view.groups[0].label, 'With Food');
  assert.equal(view.groups[0].window, '');
});

// ── When they start ────────────────────────────────────────────────────────

test('the reset is "tomorrow" only when the server day says so', () => {
  const view = deferredPlanView(deferred([dose('Vitamin D3', 'morning')]), {
    todayKey: '2031-04-17',
  });
  assert.equal(view.startsDayKey, '2031-04-18');
  assert.equal(view.startsLabel, 'tomorrow at 4:00 AM');

  // The same block read a day later — a tab left open, or a stale fetch — names
  // a day that is no longer tomorrow. Saying "tomorrow" then is a promise the
  // page cannot keep, so it falls back to the date it actually means.
  assert.equal(
    deferredPlanView(deferred([dose('Vitamin D3', 'morning')]), { todayKey: '2031-04-15' })
      .startsLabel,
    'on 2031-04-18 at 4:00 AM',
  );
  assert.equal(
    deferredPlanView(deferred([dose('Vitamin D3', 'morning')])).startsLabel,
    'on 2031-04-18 at 4:00 AM',
    'no day context is not a licence to guess',
  );
});

test('a block with no start day still gives the hour', () => {
  // The 4 AM reset is a constant of the product, so it is shown even when the
  // payload is missing the date; the heading never reads "Starts ".
  const view = deferredPlanView(deferred([dose('Vitamin D3', 'morning')], { startsDayKey: '' }));
  assert.equal(view.startsLabel, 'at 4:00 AM');
});

test('the reset hour comes from the payload when the server sends one', () => {
  const view = deferredPlanView(
    deferred([dose('Vitamin D3', 'morning')], { startsAtLabel: '5:00 AM' }),
    { todayKey: '2031-04-17' },
  );
  assert.equal(view.startsLabel, 'tomorrow at 5:00 AM');
});

// ── The sentence ───────────────────────────────────────────────────────────

test('one dose reads as one dose', () => {
  const view = deferredPlanView(deferred([dose('Vitamin D3', 'morning')]), {
    todayKey: '2031-04-17',
  });
  assert.equal(
    view.text,
    '1 dose from Morning is not part of today — their time frame had already passed when this plan was made.',
  );
});

test('two frames join with "and", three with a list', () => {
  const two = deferredPlanView(
    deferred([dose('Vitamin D3', 'morning'), dose('Magnesium', 'night')]),
    { todayKey: '2031-04-17' },
  );
  assert.match(two.text, /2 doses from Morning and Before Bed are not part of today/);

  const three = deferredPlanView(
    deferred([
      dose('Vitamin D3', 'morning'),
      dose('Zinc', 'afternoon'),
      dose('Magnesium', 'night'),
    ]),
    { todayKey: '2031-04-17' },
  );
  assert.match(three.text, /3 doses from Morning, Afternoon and Before Bed are not part of today/);
});

test('the wording is a start, never a miss', () => {
  // "Missed" would be a lie — the window closed before the plan existed — and a
  // user who believes they missed a dose tries to catch up on it late at night.
  const view = deferredPlanView(deferred([dose('Vitamin D3', 'morning')]), {
    todayKey: '2031-04-17',
  });
  assert.doesNotMatch(view.text, /missed|failed|overdue/i);
  assert.doesNotMatch(view.startsLabel, /missed/i);
});

// ── The section itself ─────────────────────────────────────────────────────

test('the section renders nothing when there is no view', () => {
  const source = read(SECTION);
  assertSourceHas(source, /export default function DeferredPlanSection\(\{ view \}\)/, 'a named component taking the view');
  assertSourceHas(source, /if \(!view \|\| !view\.active\) return null;/, 'inactive must render nothing');
});

test('the section is read-only', () => {
  // A deferred dose cannot be ticked: it is not on today's plan yet, and a tick
  // would write an IntakeRecord for a day the server has not seeded.
  const source = read(SECTION);
  assertSourceLacks(source, /<input/, 'no checkbox');
  assertSourceLacks(source, /onClick/, 'no click handler');
  assertSourceLacks(source, /slot-tray/, 'and not the locked-window styling, which reads as a miss');
});

// ── The pages render it ────────────────────────────────────────────────────

test('both plan pages build the view from the server payload and its plan day', () => {
  // `todayKey` has to be the server\'s day, not `new Date()` in the browser: for
  // four hours out of twenty-four those two disagree, and the disagreement is
  // exactly on the "is the reset tomorrow?" question this block answers.
  for (const file of [DASHBOARD, TRACKER]) {
    const source = read(file);
    assertSourceHas(source, /import \{ deferredPlanView \} from '\.\.\/utils\/planDeferred\.js'/, `${file} imports the view builder`);
    assertSourceHas(source, /import DeferredPlanSection from '\.\.\/Components\/DeferredPlanSection\.jsx'/, `${file} imports the section`);
    assertSourceHas(source, /const \[planDeferred, setPlanDeferred\] = useState\(null\);/, `${file} holds the payload`);
    assertSourceHas(source, /setPlanDeferred\(data\.planDeferred \|\| null\);/, `${file} reads the payload from GET /`);
    assertSourceHas(
      source,
      /deferredPlanView\(planDeferred, \{ todayKey: planDayKey \}\)/,
      `${file} keys the view to the server's plan day`,
    );
  }
});

test('both plan pages render the section, and hide it during the dead hours', () => {
  for (const file of [DASHBOARD, TRACKER]) {
    const source = read(file);
    assertSourceHas(
      source,
      /!plan\.deadHour && <DeferredPlanSection view=\{deferredView\} \/>/,
      `${file} renders the section, not during the 00:00-04:00 pause`,
    );
  }
});

test('a plan whose only doses start tomorrow is not the "no supplements" empty state', () => {
  // The empty state says "you have no supplements yet — take an assessment". For
  // a plan built at 11 PM that is doubly wrong: the assessment is done, and the
  // doses exist, they just open at 4 AM. The guard has to know about the block.
  assertSourceHas(read(DASHBOARD), /\{!hasPlan && !deferredView\.active \? \(/, 'the dashboard empty state is guarded');
  assertSourceHas(read(TRACKER), /\{todaysSupplements\.length === 0 && !deferredView\.active \? \(/, 'and so is the tracker\'s');
});

test('a user with no assessment is not shown a stale block', () => {
  // The payload is per-response. Leaving the previous one set while `hasAssessment`
  // is false would render "starts tomorrow" under an account that has no plan.
  assertSourceHas(read(DASHBOARD), /if \(!data\.hasAssessment\) \{[\s\S]{0,600}?setPlanDeferred\(null\);/, 'the dashboard clears it');
  assertSourceHas(read(TRACKER), /setPlanDeferred\(null\);/, 'and so does the tracker');
});
