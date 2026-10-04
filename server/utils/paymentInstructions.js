/**
 * WHERE THE MONEY GOES.
 *
 * The checkout had a hole in it. The proof-of-payment step said "send us your
 * payment receipt and an administrator will check it" — and never said where to
 * send it, or how. There was no bank account, no e-wallet, no name, no
 * reference format, anywhere in the codebase. A member following the
 * instructions literally could not complete a purchase: the flow asked for
 * proof of a payment they had no way to make.
 *
 * That makes this file a correctness requirement, not a nicety. The fix has two
 * halves and they only work together:
 *
 *   1. THIS — a single source of truth, configurable per deployment, served on
 *      the public plan payload so the pricing page can show the real
 *      destination instead of an instruction to go and find one.
 *
 *   2. THE UI — render those details in the proof step, AND do not offer the
 *      transfer route at all when `available` is false. Inviting a payment the
 *      product cannot receive is worse than not offering it: the member pays,
 *      uploads a genuine receipt, and then waits for an approval that can never
 *      be verified. `available` exists so that failure is impossible rather
 *      than merely unlikely.
 *
 * WHY IT LIVES ON THE SERVER
 * --------------------------
 * Payment details are the one piece of the checkout a client must never be the
 * source of. A tampered bundle could otherwise display one account number while
 * the operator collects against another. The browser renders what the server
 * says; it cannot change it.
 *
 * CONFIGURED BY ENVIRONMENT, FAILS CLOSED
 * ---------------------------------------
 * Nothing is hardcoded and there is no default account. A deployment that has
 * not set these variables reports `available: false`, and the transfer route
 * disappears — which is the correct behaviour for "we have not told you where to
 * pay yet", and is exactly the state this repository is in.
 */
const env = process.env;

const str = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/**
 * A destination is only a destination if it can actually receive money.
 *
 * The account number is the load-bearing field: a bank name with no number, or
 * an e-wallet with no number, cannot take a payment. An instructions blurb alone
 * is accepted as a fallback, because a deployment may legitimately route people
 * to a hosted checkout page instead of printing an account — but then it must
 * say so, and that is `instructions`.
 */
function isUsableDestination({ accountNumber, instructions }) {
  return Boolean(accountNumber || instructions);
}

/**
 * The payment destination, or an honest "there isn't one yet".
 *
 * @returns {{
 *   available: boolean,
 *   method: string,          // 'bank_transfer' | 'e_wallet' | ''
 *   accountName: string,
 *   bankName: string,
 *   accountNumber: string,
 *   instructions: string,
 *   contactEmail: string,
 *   referenceHint: string,   // what to put in the reference so it is findable
 *   reason: string,          // why it is unavailable, for the UI to explain
 * }}
 */
function getPaymentInstructions() {
  const accountNumber = str(env.PAYMENT_ACCOUNT_NUMBER);
  const bankName = str(env.PAYMENT_BANK_NAME);
  const instructions = str(env.PAYMENT_INSTRUCTIONS);
  const method = str(env.PAYMENT_METHOD).toLowerCase();
  const accountName = str(env.PAYMENT_ACCOUNT_NAME);
  const contactEmail = str(env.PAYMENT_CONTACT_EMAIL);

  const available = isUsableDestination({ accountNumber, instructions });

  if (!available) {
    return {
      available: false,
      method: '',
      accountName: '',
      bankName: '',
      accountNumber: '',
      instructions: '',
      contactEmail,
      referenceHint: '',
      // Named rather than generic, so a member who somehow reaches the proof
      // step is told the truth instead of being left waiting on a payment that
      // was never possible.
      reason: 'No payment details have been set up for this deployment yet. '
        + 'Please contact support and an administrator will activate your plan for you.',
    };
  }

  return {
    available: true,
    // An unrecognised or absent method must not be invented into one that
    // implies a bank; the UI shows the fields it is actually given.
    method: ['bank_transfer', 'e_wallet'].includes(method) ? method : (accountNumber ? 'bank_transfer' : ''),
    accountName,
    bankName,
    accountNumber,
    instructions,
    contactEmail,
    // Telling a payer what to put in the reference is what makes a receipt
    // findable in a bank statement full of anonymous transfers.
    referenceHint: str(env.PAYMENT_REFERENCE_HINT) || 'Use your email address as the reference.',
    // Present and empty rather than absent, so both branches of this function
    // return the SAME keys. A payload that grows and shrinks a field depending
    // on a value is how a consumer ends up reading `undefined` where it
    // expected a string.
    reason: '',
  };
}

/** The subset that is safe to send to anyone — i.e. all of it. It is all public
 *  business information, on the same public endpoint as the price list. */
function toPayload() {
  return getPaymentInstructions();
}

/**
 * MUST this request carry a receipt?
 *
 * True exactly when there is somewhere to send money. That is the whole rule,
 * and it is deliberately the INVERSE of `available`:
 *
 *   destination configured → the member was told an account number → a receipt is
 *                           how that transfer gets verified, so requiring one is
 *                           ordinary practice, not friction.
 *
 *   no destination          → the member was told there is nowhere to send money.
 *                           Requiring proof of a payment that cannot be made is a
 *                           dead end: the sheet says "ask an administrator" and
 *                           then refuses to let them ask, because the only
 *                           acceptable evidence is a receipt of a transfer this
 *                           deployment cannot receive. The flow becomes literally
 *                           uncompletable, which is exactly the bug this exists
 *                           to remove.
 *
 * Expressed as its own predicate rather than re-derived per call site, so the
 * route that ACCEPTS a proof-less request and the copy that PROMISES it cannot
 * disagree — the failure mode when two places each test `available` is that one
 * gets updated and the other does not, and the promise outruns the acceptance.
 */
function receiptRequired() {
  return getPaymentInstructions().available === true;
}

module.exports = {
  getPaymentInstructions,
  toPayload,
  isUsableDestination,
  receiptRequired,
};
