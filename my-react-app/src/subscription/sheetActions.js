/**
 * The checkout sheet's ACTION BAR, as data.
 *
 * This exists because the bar's layout depends on HOW MANY actions there are,
 * and that used to be decided by a hand-written condition per branch:
 *
 *     `...${selfServe && !atProofStep ? ' pricing-sheet__actions--stacked' : ''}`
 *
 * Both summary branches render THREE actions (Cancel, a secondary, the primary),
 * but only the self-serve one was flagged as needing the primary on its own row.
 * Since self-serve fails CLOSED and is therefore off by default, the default
 * path squeezed "Upload proof of payment" into a third of the bar and it wrapped
 * to three lines. Two branches, two conditions, one disagreement — and nothing
 * to catch it.
 *
 * So the count is no longer written down anywhere. `buildSheetActions` returns
 * the list and `actionsNeedStack` derives the layout from it, which means the two
 * branches cannot disagree again, and the test can prove it exhaustively
 * instead of a human having to remember.
 *
 * Pure data, no React: every field is serialisable and assertable.
 */

/** The committing action. Always last — see `tests for the invariant below`. */
export const KIND_PRIMARY = 'primary';
/** Anything that backs out or diverts: Cancel, Back, "I paid by transfer". */
export const KIND_SECONDARY = 'secondary';

/**
 * @param {object} input
 * @param {'summary'|'proof'} input.step     which step of the sheet is showing
 * @param {boolean} input.selfServe          deployment has self-serve billing on
 * @param {string}  input.planName           display name, e.g. "Premium"
 * @param {boolean} input.busy               a request is in flight
 * @param {boolean} input.canSubmit          proof step: a receipt is attached
 * @returns {Array<{key:string,label:string,kind:string,action:string,
 *                  busyLabel?:string,arrow?:boolean,disabled?:boolean}>}
 */
export function buildSheetActions({
  step = 'summary',
  selfServe = false,
  planName = 'plan',
  busy = false,
  canSubmit = true,
} = {}) {
  // Step 2 — the proof form. Two actions: get back, or send it.
  if (step === 'proof') {
    return [
      { key: 'back', label: 'Back', kind: KIND_SECONDARY, action: 'step:summary', disabled: busy },
      {
        key: 'submit',
        label: 'Send for approval',
        kind: KIND_PRIMARY,
        action: 'submit',
        // Disabled with no receipt attached, or while a send is in flight.
        disabled: busy || !canSubmit,
        busyLabel: 'Sending…',
      },
    ];
  }

  // Step 1 — the summary. THREE actions either way: cancel, one diversion, and
  // the way forward. Which diversion depends on the deployment, and which
  // primary depends on it too, but the COUNT does not — and that is the point.
  //
  // Every action carries its own `disabled` rather than leaving the caller to
  // apply `busy` globally. The state then lives in one place and is assertable,
  // and "busy" can no longer reach an action the builder was not asked about.
  return [
    { key: 'cancel', label: 'Cancel', kind: KIND_SECONDARY, action: 'close', disabled: busy },
    selfServe
      ? { key: 'transfer', label: 'I paid by transfer', kind: KIND_SECONDARY, action: 'step:proof', disabled: busy }
      : { key: 'support', label: 'Talk to support', kind: KIND_SECONDARY, action: 'support', disabled: busy },
    selfServe
      ? {
        key: 'confirm',
        label: `Confirm ${planName}`,
        kind: KIND_PRIMARY,
        action: 'confirm',
        disabled: busy,
        busyLabel: 'Activating…',
      }
      : {
        key: 'proof',
        label: 'Upload proof of payment',
        kind: KIND_PRIMARY,
        action: 'step:proof',
        arrow: true,
        // Nothing to disable: moving to the form is always safe.
        disabled: false,
      },
  ];
}

/**
 * Should the primary take a row of its own?
 *
 * True past two actions. Three buttons across one row give each about a third of
 * the bar, and the longest label ("Upload proof of payment") does not fit in a
 * third — it wraps to three lines and the bar grows taller than the dialog was
 * designed for. Giving the primary its own full-width row makes it the largest
 * target on the sheet and lets the secondaries share the row above.
 */
export function actionsNeedStack(actions) {
  return Array.isArray(actions) && actions.length > 2;
}

/** The className for the action bar, given its actions. */
export function actionBarClassName(actions) {
  return actionsNeedStack(actions)
    ? 'pricing-sheet__actions pricing-sheet__actions--stacked'
    : 'pricing-sheet__actions';
}
