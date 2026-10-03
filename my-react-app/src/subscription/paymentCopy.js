/**
 * WHERE DOES THE MONEY GO — part 2: the copy, as data.
 *
 * The bug this fixes
 * ------------------
 * The proof-of-payment step said:
 *
 *   "Send us your payment receipt and an administrator will check it and
 *    activate Ultimate for you."
 *
 * …and never said WHERE to send it, or how. A member following that sentence
 * literally has no account to transfer to, no wallet to scan, and no amount to
 * send. The flow asks for proof of a payment the product never told them how to
 * make. It is a dead end dressed as a checkout.
 *
 * WHY THIS IS DATA AND NOT JSX
 * -----------------------------
 * Two reasons, both about the failure being impossible rather than unlikely.
 *
 * 1. The transfer route must be CONDITIONAL. The server says whether a
 *    destination exists (`catalogue.payment.available`). When it does not, the
 *    honest screen is "ask an administrator", not "send us a receipt" — because
 *    inviting a payment we cannot receive is worse than not offering it: the
 *    member pays, uploads a genuine receipt, and waits forever for an approval
 *    nobody can verify. If that decision lived as a hand-written `&&` beside the
 *    button, the copy and the button would drift apart exactly the way the last
 *    two fixes in this file drifted apart.
 *
 * 2. The instructions are server-owned. A tampered bundle must not be able to
 *    display one account number while the operator collects against another.
 *    So the page renders what the server sent and nothing else.
 *
 * Pure functions, no React, so every branch is assertable.
 */

/** The member has somewhere to send money. */
export const PAY_AVAILABLE = 'available';
/** Nobody can receive a transfer, so the honest route is a person. */
export const PAY_UNAVAILABLE = 'unavailable';

/**
 * May the member use the transfer route at all?
 *
 * Fails CLOSED: anything that is not an explicit `available: true` means no.
 * A payload that failed to load, an older server that does not send the field
 * at all, a network blip mid-render — every one of those must land on "ask an
 * administrator", never on "send us money".
 */
export function transferIsAvailable(payment) {
  return Boolean(payment && payment.available === true);
}

/**
 * Where to send it — a list of {label, value} lines ready to render.
 *
 * Empty pairs are dropped rather than printed as a blank row, because
 * "Bank:" with nothing after it looks like a bug and teaches the member to
 * distrust the other values. `value` is kept verbatim (dashes in an account
 * number matter) but is trimmed, so a half-filled .env does not print a gap.
 */
export function paymentDetailRows(payment) {
  if (!transferIsAvailable(payment)) return [];
  const raw = [
    ['Pay to', payment.accountName],
    ['Bank', payment.bankName],
    ['Account number', payment.accountNumber],
    ['Contact', payment.contactEmail],
  ];
  return raw
    .map(([label, value]) => ({ label, value: String(value == null ? '' : value).trim() }))
    .filter((row) => row.value.length > 0);
}

/** One sentence, shown under the details. Always present, never empty. */
export function paymentInstructionText(payment) {
  if (!transferIsAvailable(payment)) return '';
  const text = String(payment.instructions || '').trim();
  if (text) return text;
  // No written steps, but there IS somewhere to pay: still say what to do, so
  // the screen is never just an account number with no instruction.
  return 'Send the exact amount shown above, then upload your receipt here.';
}

/** The reference note — what to type so the transfer is findable. */
export function paymentReferenceHint(payment) {
  if (!transferIsAvailable(payment)) return '';
  return String(payment.referenceHint || '').trim();
}

/**
 * The whole proof step, as data.
 *
 * `selfServe` is the deployment's billing switch and is deliberately NOT
 * consulted here: a member paying by transfer is exactly the non-self-serve
 * route, and letting the two flags be confused is how a deployment ends up
 * collecting money it cannot reconcile. The caller passes the mode it is
 * actually in.
 *
 * @returns {{
 *   canUseTransfer: boolean,
 *   headline: string,
 *   body: string,
 *   reason: string,
 *   detailRows: Array<{label: string, value: string}>,
 *   instructions: string,
 *   referenceHint: string,
 *   transferLabel: string,
 *   fallbackLabel: string,
 * }}
 */
export function buildProofCopy({ planName = 'your plan', selfServe = false, payment = null } = {}) {
  const canUseTransfer = !selfServe && transferIsAvailable(payment);

  if (selfServe) {
    // Nothing to send and nothing to upload: the plan activates on confirm.
    return {
      canUseTransfer: false,
      headline: 'Confirm your plan',
      body: `You will have access as soon as you confirm — no reference, no receipt, nothing to upload.`,
      reason: '',
      detailRows: [],
      instructions: '',
      referenceHint: '',
      transferLabel: 'I paid by transfer',
      fallbackLabel: 'I paid by transfer',
    };
  }

  if (canUseTransfer) {
    // The bug, fixed: it now says WHERE, shows the details, and says how.
    return {
      canUseTransfer: true,
      headline: 'Pay, then send your receipt',
      body: `Transfer the exact amount shown, then upload the receipt here. `
        + `An administrator will check it and activate ${planName} for you — `
        + `your features unlock as soon as it is approved, with no need to sign in again.`,
      reason: '',
      detailRows: paymentDetailRows(payment),
      instructions: paymentInstructionText(payment),
      referenceHint: paymentReferenceHint(payment),
      transferLabel: 'I paid by transfer',
      fallbackLabel: 'Ask an administrator to activate it',
    };
  }

  // No destination configured. The screen must not pretend otherwise.
  return {
    canUseTransfer: false,
    headline: 'Ask an administrator to activate it',
    body: `There is no payment address set up on this deployment yet, so there is nothing to `
      + `transfer to. Send an administrator a request and they will activate `
      + `${planName} for you — you will get a notification when it is done.`,
    // The server's own words, because it is the only party that knows whether
    // an address is coming. A generic excuse would be a guess.
    reason: String((payment && payment.reason) || '').trim(),
    detailRows: [],
    instructions: '',
    referenceHint: '',
    transferLabel: 'I paid by transfer',
    fallbackLabel: 'Ask an administrator to activate it',
  };
}
