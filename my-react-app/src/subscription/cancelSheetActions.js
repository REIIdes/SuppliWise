/**
 * The CANCEL sheet's action bar, as data.
 *
 * This is the mirror of sheetActions.js, and it exists for the same reason. The
 * checkout sheet's layout depended on a hand-written condition per render
 * branch, and the two branches disagreed — the default one shipped broken. The
 * lesson was that a COUNT belongs in one place, derived from the thing it
 * counts.
 *
 * The cancel sheet is simpler than checkout: it is one step with two doors, and
 * which door the member picks is a radio, not a layout concern. So this module
 * is not about layout — it is about the one decision that is genuinely easy to
 * get wrong in the view: what the commit button is allowed to SAY.
 *
 * The trap it removes: a "Confirm" button that reads the same whether the plan
 * ends this second or waits for an administrator. Those are completely
 * different promises, and a member who cannot tell them apart has been told
 * something untrue. The label is derived from the mode, so the button always
 * states the actual consequence.
 *
 * Pure data, no React: every field is serialisable and assertable.
 */

/** The door that ends the subscription the moment it is confirmed. */
export const CANCEL_MODE_IMMEDIATE = 'immediate';
/** The door that asks an administrator, and changes nothing until they do. */
export const CANCEL_MODE_REVIEW = 'review';

// Short aliases, kept because the module's own body used the bare names first.
// The `CANCEL_`-prefixed spellings are the canonical ones — they match
// CANCEL_MODES / CANCEL_MODE_COPY below and keep the two constants from reading
// as generic words in a file that also has a checkout sheet. Both spellings
// resolve to the same strings, so no caller has to care which one it imports.
export const MODE_IMMEDIATE = CANCEL_MODE_IMMEDIATE;
export const MODE_REVIEW = CANCEL_MODE_REVIEW;

/** Both doors, in the order they are offered: the reversible one first. */
export const CANCEL_MODES = [CANCEL_MODE_REVIEW, CANCEL_MODE_IMMEDIATE];

/**
 * What each door commits to, in the member's own words.
 *
 * `consequence` is the sentence under the radio. It exists because "immediate"
 * is not self-explanatory: it sounds like a fast request, not the loss of paid
 * access on the spot.
 */
export const CANCEL_MODE_COPY = {
  [CANCEL_MODE_REVIEW]: {
    label: 'Ask an administrator',
    consequence: 'Your plan stays active until an administrator reviews it. '
      + 'You will get a notification either way.',
  },
  [CANCEL_MODE_IMMEDIATE]: {
    label: 'End it now',
    consequence: 'Your paid plan is removed immediately and you go back to Free. '
      + 'The days you have paid for but not used are not refunded.',
  },
};

/**
 * The action bar for the cancel sheet.
 *
 * @param {object} input
 * @param {string}  input.mode     which door is selected
 * @param {string}  input.planName the plan being given up, e.g. "Premium"
 * @param {boolean} input.busy     a request is in flight
 * @param {boolean} input.alreadyPending a review request is already open
 * @param {boolean} input.canCancel the account actually has a paid plan
 * @returns {Array<{key:string,label:string,kind:string,action:string,disabled?:boolean}>}
 */
export function buildCancelActions({
  mode = CANCEL_MODE_REVIEW,
  planName = 'plan',
  busy = false,
  alreadyPending = false,
  canCancel = true,
} = {}) {
  // A member on Free has nothing to cancel. The card never offers the sheet for
  // them, but if it is somehow open there is no honest commit button to show —
  // so the bar is only ever the way out.
  if (!canCancel) {
    return [{ key: 'close', label: 'Close', kind: 'secondary', action: 'close' }];
  }

  const copy = CANCEL_MODE_COPY[mode] || CANCEL_MODE_COPY[CANCEL_MODE_REVIEW];
  void copy; // the radio's consequence text reads from the same table

  // A destructuring default only covers `undefined`, so `planName: null` — a
  // perfectly plausible value straight off a plan record — would render
  // "End null now", and a name that is literally the text "undefined" renders
  // just as badly. Both are refused here, once, so the button can never name a
  // plan that does not exist.
  const raw = typeof planName === 'string' ? planName.trim() : '';
  const lower = raw.toLowerCase();
  const named = raw && lower !== 'undefined' && lower !== 'null' ? raw : 'paid plan';

  return [
    // `disabled` is stated rather than omitted, so "is this live?" is one
    // property to read rather than two competing conventions.
    { key: 'cancel', label: 'Keep my plan', kind: 'secondary', action: 'close', disabled: false },
    {
      key: 'commit',
      // Names the consequence, not the mechanism. This is the whole point: the
      // member must be able to read what pressing it will do.
      label: mode === CANCEL_MODE_IMMEDIATE
        ? `End ${named} now`
        : `Request cancellation`,
      kind: 'primary',
      action: 'commit',
      // A pending review already covers this account: the server would answer
      // 409, so the button says so up front rather than letting the member
      // discover it by clicking.
      disabled: busy || (mode === CANCEL_MODE_REVIEW && alreadyPending),
      busyLabel: mode === CANCEL_MODE_IMMEDIATE ? 'Ending…' : 'Sending…',
    },
  ];
}

/** Total action count — the same derivation the checkout bar uses. */
export function cancelActionsNeedStack(actions) {
  return Array.isArray(actions) && actions.length > 2;
}

/** The className for the cancel action bar, given its actions. */
export function cancelActionBarClassName(actions) {
  return cancelActionsNeedStack(actions)
    ? 'pricing-sheet__actions pricing-sheet__actions--stacked'
    : 'pricing-sheet__actions';
}
