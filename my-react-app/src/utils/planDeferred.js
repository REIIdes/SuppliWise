/**
 * The doses of a plan that are NOT today's rows — drawn as a start, not a miss.
 *
 * Run: node --test src/utils/planDeferred.test.js
 *
 * WHY THIS EXISTS AT ALL
 * A plan made at 3 PM has a Morning stack whose window shut at noon. The server
 * stopped charging for it (server/utils/planActivation.js) and then went further:
 * those frames are not written into today at all (server/utils/todayPlanSync.js),
 * because a dose the user is forgiven but still asked to take is a red item on a
 * list they cannot finish. `planDeferred` is the payload that carries them.
 *
 * The tracker must still show them. A plan's Morning stack vanishing from the page
 * with no explanation reads as a bug, and the user has no way to know the doses
 * arrive at the next 4 AM reset. This turns that block into a read-only "starts"
 * section: grouped by frame, worded as a beginning, never as a miss, with nothing
 * to tick.
 *
 * WHY THE ANSWER IS THE SERVER'S
 * `startsDayKey` and `startsAt` come from the server's plan day, which is the one
 * the rows are keyed by. The browser's local day is a different thing for four
 * hours out of twenty-four, and a locally-derived "tomorrow" would be wrong on
 * exactly the boundary this section is about. `todayKey` is handed in so the note
 * can say "tomorrow" only when the server's own next day says so.
 */

import { SLOT_LABELS } from './timeSlots.js';
import { PLAN_DAY_RESET_LABEL, shiftDayKey } from './planDay.js';
import { SLOT_WINDOWS } from './slotSchedule.js';

const asText = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

/** Frames sort in the order the day runs, whatever order the server listed. */
const SLOT_RANK = { morning: 0, afternoon: 1, evening: 2, night: 3, anytime: 4 };

const rank = (key) => (Object.prototype.hasOwnProperty.call(SLOT_RANK, key) ? SLOT_RANK[key] : 5);

const windowText = (key) => {
  const window = SLOT_WINDOWS[key];
  return window ? `${window.opensAt} – ${window.closesAt}` : '';
};

/** "Morning and Night", "Morning, Afternoon and Night" — one frame reads plainest. */
const joinFrames = (labels) => {
  if (labels.length <= 1) return labels[0] || '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
};

/**
 * @param {{count?: number, items?: Array, frames?: Array, startsDayKey?: string,
 *          startsAt?: string, startsAtLabel?: string}|null|undefined} deferred
 *   GET /api/dashboard's `planDeferred`.
 * @param {{todayKey?: string}} [options]
 *   `todayKey` — the plan day being shown, from the server. Used only to decide
 *                whether the reset is "tomorrow" or a dated one.
 * @returns {{active: boolean, count: number, groups: Array, text: string,
 *            startsDayKey: string, startsLabel: string}}
 *   `groups`      — one entry per frame, `{ key, label, window, items }`, in day order.
 *   `startsLabel` — "tomorrow at 4:00 AM", for the section's heading.
 *   `text`        — the sentence saying why these are not on today's list.
 *
 * An absent, empty or malformed block yields `{ active: false }` and the pages
 * render nothing, which is what every day that is not a plan's first looks like.
 */
export function deferredPlanView(deferred, { todayKey = '' } = {}) {
  const empty = { active: false, count: 0, groups: [], text: '', startsDayKey: '', startsLabel: '' };
  if (!deferred || typeof deferred !== 'object') return empty;

  const items = (Array.isArray(deferred.items) ? deferred.items : [])
    .filter((item) => item && asText(item.name).trim());
  if (items.length === 0) return empty;

  const startsDayKey = asText(deferred.startsDayKey);
  const byFrame = new Map();
  for (const item of items) {
    const key = asText(item.timeSlot).toLowerCase();
    if (!byFrame.has(key)) {
      byFrame.set(key, {
        key,
        // The tracker's own wording, not the server's: this page already calls the
        // 10 PM frame "Before Bed", and a second name for it on the same screen
        // reads as a second frame.
        label: SLOT_LABELS[key] || asText(item.timeSlotLabel) || 'Anytime',
        window: windowText(key),
        items: [],
      });
    }
    byFrame.get(key).items.push(item);
  }
  const groups = [...byFrame.values()].sort((a, b) => rank(a.key) - rank(b.key));

  // "Tomorrow" is a claim about the server's day, so it is checked against it
  // rather than assumed: a block read late in the day, or against a stale key,
  // falls back to the date it names.
  const nextFromToday = shiftDayKey(asText(todayKey), 1);
  const isTomorrow = !!startsDayKey && startsDayKey === nextFromToday;
  const at = asText(deferred.startsAtLabel) || PLAN_DAY_RESET_LABEL;
  const startsLabel = startsDayKey
    ? `${isTomorrow ? 'tomorrow' : `on ${startsDayKey}`} at ${at}`
    : `at ${at}`;

  const frames = joinFrames(groups.map((g) => g.label));
  return {
    active: true,
    count: items.length,
    groups,
    startsDayKey,
    startsLabel,
    text: `${items.length === 1 ? '1 dose' : `${items.length} doses`}${frames ? ` from ${frames}` : ''} ${items.length === 1 ? 'is' : 'are'} not part of today — their time frame had already passed when this plan was made.`,
  };
}
