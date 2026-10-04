/**
 * The dashboard greeting — "Good evening, Janrich!"
 *
 * Run: node --test src/utils/greeting.test.js
 *
 * THE LINE IS BUILT FROM TWO INDEPENDENT FACTS
 *
 *   <Time>  what part of the day it is for THIS user, right now
 *   <User>  who is signed in in this tab
 *
 * They arrive independently and either can be missing, so the name and the
 * punctuation are decided together, here, and the page only ever renders the
 * finished sentence.
 *
 * WHY A SHARED FUNCTION
 *
 * Assembled inline in the page it was three string concats wide, and every way
 * it could go wrong was invisible until a real account hit it:
 *
 *   1. `userData?.firstName ? `, ${userData.firstName}` : ''` dropped the name
 *      whenever the profile had not loaded yet, so the heading silently
 *      degraded to a bare greeting — with no name there is nothing to tell the
 *      user the page is personalised at all.
 *   2. A profile whose `firstName` was whitespace (" ") was truthy, so the
 *      heading rendered "Good evening,  !" — two spaces and a comma hanging off
 *      the end of a sentence.
 *   3. `, ${name}!` was appended to a string that already ended in "!", so any
 *      future copy edit that added its own punctuation produced "Good evening!!".
 *
 * WHY THE BANDS ARE NOT INVENTED HERE
 *
 * The four parts of day are read straight off the constants the rest of the app
 * already uses (SLOT_WINDOWS / DEAD_HOURS in utils/slotSchedule.js) rather than
 * from a second, prettier set of numbers written for greetings. A greeting that
 * disagrees with the dashboard underneath it is worse than no greeting: at
 * 05:00 this app opens the Morning stack, so it must not say "Good night". One
 * source means the day has exactly one definition, and this file cannot drift
 * away from it when the windows move.
 *
 *   00:00–03:59  night    the dead hours — the pause before the 4 AM reset
 *   04:00–11:59  morning   exactly the app's Morning window
 *   12:00–17:59  afternoon exactly the app's Afternoon window
 *   18:00–21:59  evening   exactly the app's Evening window
 *   22:00–23:59  night     exactly the app's Night window
 *
 * NIGHT IS THE ONE BAND THAT CROSSES MIDNIGHT, so it is tested twice (before
 * and after the dead hours) instead of once.
 *
 * LOCAL CLOCK, NOT THE SERVER'S
 *
 * 04:00 is the user's own 4 AM. The moment belongs to the person reading it, so
 * it is read from the browser — the same reasoning as the supplement windows in
 * slotSchedule.js, where a server-side clock would greet a user in UTC+5:30 at
 * the wrong hour for most of the planet.
 *
 * FIRST NAME, NOT FULL NAME
 *
 * "Good evening, Janrich User!" reads like a database row. `name` is only
 * consulted when `firstName` is genuinely absent (older cached profiles,
 * accounts created before the field existed), and only its FIRST word is used so
 * the fallback cannot reintroduce the full-name problem.
 */
import { SLOT_WINDOWS, DEAD_HOURS, minutesOfDay } from './slotSchedule.js';

/** Collapse internal runs of whitespace and trim the ends. Non-strings are
    treated as absent rather than coerced — `0` or `{}` are not names, and
    stringifying them would put "[object Object]" in someone's greeting. */
const clean = (value) => {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
};

/**
 * The name to greet the signed-in user by, or '' when there is nothing usable.
 *
 * Prefers `firstName`; falls back to the first word of the combined `name` so
 * a profile that only carries a full name still gets a personalised heading
 * instead of a bare greeting.
 */
export const firstNameOf = (profile) => {
  if (!profile || typeof profile !== 'object') return '';
  const first = clean(profile.firstName);
  if (first) return first;
  return clean(profile.name).split(' ')[0] || '';
};

/** The words each part of day is greeted with. */
export const TIME_PARTS = {
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
  night: 'Good night',
};

/**
 * Which part of day it is, for the user's own clock.
 *
 * @param {Date} [now]
 * @returns {'morning'|'afternoon'|'evening'|'night'} Never throws: an
 *          unparseable `now` reads as 'morning', so a greeting still renders.
 */
export function timeOfDay(now = new Date()) {
  const minutes = minutesOfDay(now);
  if (minutes === null) return 'morning';
  // Night is checked twice on purpose — it is the only band that spans midnight.
  if (minutes < DEAD_HOURS.end) return 'night';
  if (minutes >= SLOT_WINDOWS.night.start) return 'night';
  if (minutes >= SLOT_WINDOWS.evening.start) return 'evening';
  if (minutes >= SLOT_WINDOWS.afternoon.start) return 'afternoon';
  return 'morning';
}

/**
 * The full greeting line, punctuation included.
 *
 * @param {object|null} profile This tab's cached profile (see useAuth).
 * @param {Date}        [now]    Defaults to the current time. Pass the page's
 *                               clock so a long-lived tab re-reads the clock
 *                               and the greeting changes with the day.
 * @returns {string} e.g. "Good evening, Janrich!", or "Good evening!" when the
 *                   profile carries no usable name.
 */
export const greetingFor = (profile, now = new Date()) => {
  const opener = TIME_PARTS[timeOfDay(now)];
  const firstName = firstNameOf(profile);
  return firstName ? `${opener}, ${firstName}!` : `${opener}!`;
};