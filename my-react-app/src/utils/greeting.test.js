/**
 * greeting — the dashboard's "Good evening, Janrich!" line.
 *
 * Run: npm test
 *
 * THE FAILURE THIS GUARDS AGAINST
 * The heading is assembled from two inputs that arrive independently: the
 * signed-in profile and the user's clock. Built inline, the three ways it broke
 * were all silent — no error, no crash, just a heading that quietly stopped
 * being personalised:
 *
 *   1. THE NAME VANISHED. The profile is read from per-tab storage and can be
 *      absent for a tick (token restored, profile-heal still in flight). The
 *      old ternary then rendered a bare greeting with no name at all.
 *   2. A WHITESPACE NAME READ AS A NAME. `" "` is truthy, so the heading came
 *      out as "Good evening,  !" — a comma and two spaces hanging off the end.
 *   3. PUNCTUATION WAS PASTED, NOT COMPOSED. `, ${name}!` was appended to an
 *      opener that a future copy edit could give its own "!", producing
 *      "Good evening!!".
 *
 * What is pinned here:
 *   1. a real first name always produces exactly "Good <part>, <Name>!";
 *   2. every unusable name degrades to "Good <part>!" — never ", !" and
 *      never "!!";
 *   3. the four parts of day are read off the APP'S OWN windows, so the
 *      greeting can never contradict the plan underneath it;
 *   4. every boundary minute is exact, and night is right on BOTH sides of
 *      midnight;
 *   5. nothing throws on a missing, empty or junk profile, or a bad clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstNameOf, greetingFor, timeOfDay, TIME_PARTS } from './greeting.js';
import { SLOT_WINDOWS, DEAD_HOURS } from './slotSchedule.js';

/** A local-time Date on a fixed day, so the assertions cannot drift by season. */
const at = (hours, minutes = 0) => new Date(2026, 9, 3, hours, minutes, 0, 0);

// ── firstNameOf ─────────────────────────────────────────────────────────────

test('firstNameOf reads the first name', () => {
  assert.equal(firstNameOf({ firstName: 'Janrich', lastName: 'User' }), 'Janrich');
});

test('firstNameOf falls back to the first word of the full name', () => {
  assert.equal(firstNameOf({ name: 'Janrich User' }), 'Janrich');
  assert.equal(firstNameOf({ name: 'Janrich' }), 'Janrich');
});

test('firstNameOf prefers firstName over the full name', () => {
  assert.equal(firstNameOf({ firstName: 'Jan', name: 'Janrich User' }), 'Jan');
});

test('firstNameOf trims a padded name', () => {
  assert.equal(firstNameOf({ firstName: '  Janrich  ' }), 'Janrich');
  assert.equal(firstNameOf({ firstName: 'Jan   rich' }), 'Jan rich');
});

test('firstNameOf collapses a whitespace-only name to the full-name fallback', () => {
  // " " is truthy, so a naive check would greet the user as " ".
  assert.equal(firstNameOf({ firstName: '   ', name: 'Janrich User' }), 'Janrich');
});

test('firstNameOf never returns a whole full name', () => {
  assert.equal(firstNameOf({ firstName: '', name: 'Janrich Van Der Berg' }), 'Janrich');
});

test('firstNameOf returns empty for a profile with no usable name', () => {
  assert.equal(firstNameOf(null), '');
  assert.equal(firstNameOf(undefined), '');
  assert.equal(firstNameOf({}), '');
  assert.equal(firstNameOf({ firstName: '', name: '' }), '');
  assert.equal(firstNameOf({ firstName: '   ' }), '');
});

test('firstNameOf does not stringify junk into the greeting', () => {
  assert.equal(firstNameOf({ firstName: {} }), '');
  assert.equal(firstNameOf({ firstName: 42 }), '');
  assert.equal(firstNameOf({ name: {} }), '');
  assert.equal(firstNameOf('Janrich'), '');
});

// ── timeOfDay ───────────────────────────────────────────────────────────────

test('the dead hours before dawn are night, not morning', () => {
  assert.equal(timeOfDay(at(0)), 'night');
  assert.equal(timeOfDay(at(1, 30)), 'night');
  assert.equal(timeOfDay(at(3, 59)), 'night');
});

test('morning starts exactly where the dead hours end', () => {
  assert.equal(timeOfDay(at(DEAD_HOURS.end / 60)), 'morning');
  assert.equal(timeOfDay(at(4)), 'morning');
  assert.equal(timeOfDay(at(9)), 'morning');
});

test('afternoon starts exactly on the Afternoon window', () => {
  assert.equal(timeOfDay(at(11, 59)), 'morning');
  assert.equal(timeOfDay(at(SLOT_WINDOWS.afternoon.start / 60)), 'afternoon');
  assert.equal(timeOfDay(at(15)), 'afternoon');
});

test('evening starts exactly on the Evening window', () => {
  assert.equal(timeOfDay(at(17, 59)), 'afternoon');
  assert.equal(timeOfDay(at(SLOT_WINDOWS.evening.start / 60)), 'evening');
  assert.equal(timeOfDay(at(20)), 'evening');
});

test('night starts exactly on the Night window', () => {
  assert.equal(timeOfDay(at(21, 59)), 'evening');
  assert.equal(timeOfDay(at(SLOT_WINDOWS.night.start / 60)), 'night');
  assert.equal(timeOfDay(at(23, 59)), 'night');
});

test('night is right on BOTH sides of midnight', () => {
  // The only band that wraps. Getting this wrong is what makes a 1 AM greeting
  // say "Good morning", so it is checked as a pair rather than one sample.
  assert.equal(timeOfDay(at(23, 30)), 'night');
  assert.equal(timeOfDay(at(0, 0)), 'night');
});

test('every minute of the day maps to a real part, with no gap', () => {
  for (let m = 0; m < 24 * 60; m += 7) {
    const part = timeOfDay(new Date(2026, 9, 3, 0, 0, 0, 0).setHours(0, m));
    assert.ok(TIME_PARTS[part], `no greeting words for minute ${m} (got "${part}")`);
  }
});

test('an unusable clock still yields a greeting rather than throwing', () => {
  assert.equal(timeOfDay(new Date('nonsense')), 'morning');
  assert.equal(timeOfDay(undefined), timeOfDay(new Date()));
});

// ── greetingFor ─────────────────────────────────────────────────────────────

test('greetingFor reads exactly like the reference line', () => {
  assert.equal(greetingFor({ firstName: 'Janrich' }, at(19)), 'Good evening, Janrich!');
});

test('each part of day is greeted with its own words, and the name', () => {
  const cases = [
    [at(7), 'Good morning, Janrich!'],
    [at(13), 'Good afternoon, Janrich!'],
    [at(19), 'Good evening, Janrich!'],
    [at(23), 'Good night, Janrich!'],
    [at(2), 'Good night, Janrich!'],
  ];
  for (const [when, expected] of cases) {
    assert.equal(greetingFor({ firstName: 'Janrich' }, when), expected);
  }
});

test('the name is present, not absent — the whole point of the heading', () => {
  assert.match(greetingFor({ firstName: 'Janrich' }, at(19)), /Janrich/);
});

test('a missing profile degrades to a clean greeting, never a dangling comma', () => {
  assert.equal(greetingFor(null, at(19)), 'Good evening!');
  assert.equal(greetingFor(null, at(7)), 'Good morning!');
});

test('a blank name degrades the same way a missing one does', () => {
  assert.equal(greetingFor({ firstName: '   ' }, at(19)), 'Good evening!');
  assert.equal(greetingFor({ firstName: '' }, at(19)), 'Good evening!');
});

test('the heading never doubles its punctuation', () => {
  for (const profile of [null, {}, { firstName: 'Janrich' }, { firstName: '' }]) {
    for (const when of [at(1), at(7), at(13), at(19), at(23)]) {
      const line = greetingFor(profile, when);
      assert.doesNotMatch(line, /!!/);
      assert.doesNotMatch(line, /,\s*!/);
      assert.doesNotMatch(line, /\s{2}/);
      assert.match(line, /^Good (morning|afternoon|evening|night)(, .+)?!$/);
    }
  }
});

test('a padded name is trimmed, so no space lands before the comma', () => {
  assert.equal(greetingFor({ firstName: '  Janrich  ' }, at(19)), 'Good evening, Janrich!');
});

test('the fallback name is used when firstName is absent', () => {
  assert.equal(greetingFor({ name: 'Janrich User' }, at(19)), 'Good evening, Janrich!');
});

test('the greeting follows the clock, so a tab left open changes with the day', () => {
  const profile = { firstName: 'Janrich' };
  assert.equal(greetingFor(profile, at(8)), 'Good morning, Janrich!');
  assert.equal(greetingFor(profile, at(14)), 'Good afternoon, Janrich!');
  assert.equal(greetingFor(profile, at(20)), 'Good evening, Janrich!');
});