'use strict';

/**
 * SMS delivery — the one place this application talks to a phone network.
 *
 * WHY A TRANSPORT LAYER AT ALL
 * ----------------------------
 * The three requirements below cannot be met by calling a provider SDK inline
 * from a route, and the first one is the reason this file exists at all:
 *
 *   1. It must run with NO provider credentials. This repository has no SMS
 *      account, and the feature should not be a landmine until one exists. Every
 *      send reports `{ ok: false, reason: 'not-configured' }` rather than
 *      throwing, so an unconfigured deployment degrades to "this method is not
 *      available" instead of a 500 on a login path. A phone number is a FALLBACK
 *      here, so an absent provider must never take down sign-in or password reset.
 *   2. The provider must be swappable. Twilio, MessageBird, Vonage and a
 *      self-hosted relay all want different SDKs; none of them should leak into
 *      the routes. Adding a provider means adding a function below, nothing else.
 *   3. No provider call may hang a request. Carrier APIs are slow and sometimes
 *      silent. Everything here is on a hard timeout so a wedged gateway costs a
 *      few seconds, not a stuck request holding a database connection.
 *
 * WHAT IS NEVER LOGGED
 * --------------------
 * Recipient numbers and message bodies contain a live credential (the code) and
 * personal data. Outside the explicit development mode below, neither is ever
 * written to a log — only a masked form and a coarse failure reason. This is the
 * same rule utils/email.js follows for its recipients.
 *
 * THE DEVELOPMENT MODE
 * --------------------
 * `SMS_PROVIDER=console`, or `ALLOW_DEV_SMS_RESPONSE=true`, prints the message
 * to stdout instead of sending it. It exists so the whole verification flow is
 * testable end-to-end with no account and no spend, exactly as
 * `ALLOW_DEV_OTP_RESPONSE` does for email — and it is refused outright in
 * production, both here and at boot in index.js. A development mode that prints
 * live sign-in codes must never reach a real deployment.
 */

/** Longest we will wait on a carrier API before giving up on one message. */
const REQUEST_TIMEOUT_MS = 10_000;

// How long a code is valid, as told to the recipient in the message itself.
//
// MUST stay aligned with the enforcement window in the routes that call this.
// A message that promises ten minutes while the server expires at five is a
// user watching a dead timer; the routes publish the enforced value on their
// response so the client countdown cannot disagree with the server either.
const SMS_CODE_TTL_MINUTES = 5;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function envFlag(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

/** Which transport is selected, normalised. Empty string means "none". */
function providerName() {
  const explicit = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  if (explicit) return explicit;
  // Inferred from credentials so that adding a key is enough to go live.
  // TextBee is checked first: it is a single header and the default for
  // deployments that cannot use a conventional aggregator.
  if (String(process.env.TEXTBEE_API_KEY || '').trim()) return 'textbee';
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
    return 'twilio';
  }
  if (String(process.env.SMS_WEBHOOK_URL || '').trim()) return 'webhook';
  return '';
}

/**
 * Can this deployment actually deliver a message right now?
 *
 * Reported to the UI so it can hide the phone option instead of offering a
 * button that cannot work. This is a CAPABILITY report, never an authorisation
 * input — a client cannot talk this into `true`.
 *
 * @returns {{ configured: boolean, provider: string, development: boolean }}
 */
function status() {
  const provider = providerName();
  const development = provider === 'console' || envFlag('ALLOW_DEV_SMS_RESPONSE');
  if (provider === 'console') {
    return { configured: development, provider, development: true };
  }
  if (provider === 'textbee') {
    return {
      configured: Boolean(String(process.env.TEXTBEE_API_KEY || '').trim()),
      provider,
      development,
    };
  }
  if (provider === 'twilio') {
    return {
      configured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM),
      provider,
      development,
    };
  }
  if (provider === 'webhook') {
    return { configured: Boolean(String(process.env.SMS_WEBHOOK_URL || '').trim()), provider, development };
  }
  return { configured: false, provider, development };
}

const isConfigured = () => status().configured;

/**
 * Development transport: print it instead of sending it.
 *
 * Refuses to run in production. index.js also throws at boot for
 * ALLOW_DEV_SMS_RESPONSE, so a deployment cannot even start in this state —
 * this second check exists because the function is also reachable in tests and
 * tooling that do not go through boot.
 */
async function consoleTransport({ to, body, purpose }) {
  if (process.env.NODE_ENV === 'production') {
    return { ok: false, reason: 'development-transport-disabled' };
  }
  // The only place the full recipient and the full body are ever written down.
  console.log(`[SMS:console] to=${to} purpose=${purpose || 'unknown'}\n[SMS:console] ${body}`);
  return { ok: true, sid: 'console', development: true };
}

/**
 * How long to wait for the gateway to report an outcome before giving up and
 * calling the send accepted.
 *
 * WHY A BOUNDED WAIT IS NEEDED — the defect it fixes
 * --------------------------------------------------
 * TextBee returns `200 { success: true }` the moment a message is QUEUED. The
 * Android device then pushes it to the radio, and *that* is where it fails. A
 * phone with no SMS credit, no signal, or a carrier block reports the failure
 * some seconds later, asynchronously, through a different endpoint entirely.
 *
 * So treating the 200 as success means telling a user "we sent your code" about a
 * message that is already doomed. They sit on a verification screen waiting for
 * something that will never arrive, with no error and no way to tell that from a
 * slow carrier.
 *
 * WHY IT IS NOT LONGER
 * --------------------
 * This is a person waiting on a login, so the wait is short by design. Observed
 * gateway failures land 4–7 seconds after the enqueue, and the poll schedule
 * below asks early and widens, so a 5-second budget still catches the common
 * case. Anything slower is reported as "unknown" and treated as ACCEPTED, never
 * as failed — refusing a message that would have arrived costs a retry, while
 * accepting one that will not leaves the user no worse off than a slow carrier,
 * and they always have another recovery method available.
 *
 * Raise it on a slow network; lower it (or set 0 to skip) to make sign-in feel
 * faster at the cost of occasionally missing a slow failure.
 */
const DEFAULT_DELIVERY_WAIT_MS = 5_000;

/**
 * Poll schedule for the delivery check, in order.
 *
 * The gateway typically reports a failure 3–7 seconds after the enqueue, so the
 * useful questions are asked early and often at first. A flat 1.2s interval
 * either misses the verdict (and waits out the whole budget for nothing) or
 * wastes half the budget sleeping before it looks. This schedule asks at 0.5s,
 * then widens — cheap when the answer arrives fast, still bounded when it does
 * not, and never more requests than the budget can actually pay for.
 */
const DELIVERY_POLL_SCHEDULE_MS = [500, 800, 1_200, 1_800, 2_500, 3_500];

/** Cached default device id, so a send does not have to look it up every time. */
let cachedDeviceId = '';
let cachedDeviceIdAt = 0;
const DEVICE_ID_TTL_MS = 10 * 60 * 1000;

function deliveryWaitMs() {
  const raw = Number.parseInt(process.env.SMS_DELIVERY_WAIT_MS, 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_DELIVERY_WAIT_MS;
}

/**
 * Which registered phone sends by default, cached for ten minutes.
 *
 * Returns '' when the account has no enabled device, or the lookup fails —
 * which is itself worth knowing, because "no device" is a hard send failure at
 * TextBee rather than something the send call reports.
 */
async function defaultDeviceId() {
  const explicit = String(process.env.TEXTBEE_DEVICE_ID || '').trim();
  if (explicit) return explicit;

  if (cachedDeviceId && Date.now() - cachedDeviceIdAt < DEVICE_ID_TTL_MS) {
    return cachedDeviceId;
  }

  try {
    const response = await fetch('https://api.textbee.dev/api/v1/gateway/devices', {
      headers: { 'x-api-key': String(process.env.TEXTBEE_API_KEY || '').trim() },
    });
    if (!response.ok) return cachedDeviceId;
    const payload = await response.json().catch(() => ({}));
    const devices = Array.isArray(payload && payload.data) ? payload.data : [];
    // An explicit default wins; otherwise the enabled device that reported most
    // recently, which is the same rule TextBee itself applies.
    const usable = devices.filter((d) => d && d.enabled !== false);
    const chosen = usable.find((d) => d.isDefault === true)
      || usable.sort((a, b) => String(b.lastHeartbeat || '').localeCompare(String(a.lastHeartbeat || '')))[0];
    cachedDeviceId = chosen && chosen._id ? String(chosen._id) : '';
    cachedDeviceIdAt = Date.now();
    if (!cachedDeviceId) {
      console.error('[SMS:textbee] no enabled device on this account — sends will be refused by the gateway');
    }
    return cachedDeviceId;
  } catch {
    return cachedDeviceId;
  }
}

/**
 * Ask TextBee what became of a queued batch, for at most `budgetMs`.
 *
 * @returns {Promise<{outcome: 'delivered'|'failed'|'unknown', error?: string}>}
 *   'unknown' means no verdict was available in time — NOT a failure.
 */
async function awaitDelivery({ deviceId, batchId, budgetMs }) {
  if (!deviceId || !batchId || budgetMs <= 0) return { outcome: 'unknown' };

  const apiKey = String(process.env.TEXTBEE_API_KEY || '').trim();
  const deadline = Date.now() + budgetMs;

  // Sleep first, then look. Asking immediately after the enqueue almost always
  // returns "processing" and only burns one of a small number of questions.
  for (let attempt = 0; ; attempt += 1) {
    const waitFor = DELIVERY_POLL_SCHEDULE_MS[Math.min(attempt, DELIVERY_POLL_SCHEDULE_MS.length - 1)];
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitFor, remaining)));

    try {
      const response = await fetch(
        `https://api.textbee.dev/api/v1/gateway/devices/${encodeURIComponent(deviceId)}/sms-batch/${encodeURIComponent(batchId)}`,
        { headers: { 'x-api-key': apiKey } },
      );
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        const batch = payload && payload.data && payload.data.batch;
        const messages = (payload && payload.data && payload.data.messages) || [];

        // PER-MESSAGE status first. The batch summary is deliberately coarse —
        // it stays "processing" while individual messages have already reached
        // the radio — so a healthy send would otherwise be made to sit out the
        // entire budget before being called a success.
        const perMessage = messages.map((m) => String((m && m.status) || '').toLowerCase());
        if (perMessage.some((s) => s === 'failed')) {
          const detail = (messages.find((m) => String(m && m.status).toLowerCase() === 'failed') || {}).errorMessage
            || (batch && batch.error) || '';
          return { outcome: 'failed', error: String(detail).slice(0, 200) };
        }
        // 'dispatched' means the push reached the sending phone. That is the
        // last point at which this server can usefully know anything: the radio
        // handover is the carrier's problem now, not ours.
        if (perMessage.some((s) => s === 'dispatched' || s === 'sent' || s === 'delivered')) {
          return { outcome: 'delivered' };
        }

        const status = batch && String(batch.status || '').toLowerCase();
        if (status === 'failed') {
          const detail = ((messages[0] || {}).errorMessage) || (batch && batch.error) || '';
          return { outcome: 'failed', error: String(detail).slice(0, 200) };
        }
        if (status && status !== 'pending' && status !== 'processing') {
          return { outcome: 'delivered' };
        }
      }
    } catch {
      // A lookup failure is not a verdict; keep waiting until the cap.
    }
    if (Date.now() >= deadline) break;
  }
  return { outcome: 'unknown' };
}

/**
 * TextBee — POST https://api.textbee.dev/api/v1/gateway/send-sms
 *
 *   header : x-api-key
 *   body   : { message, recipients: [ '+<e164>' ], deviceId? }
 *   200    : { data: { smsBatchId, successCount, failureCount, warning? } }
 *
 * WHY A 200 IS NOT ENOUGH TO REPORT SUCCESS — the reason this transport is more
 * than a copy of the cURL example.
 *
 * TextBee sends from an Android phone registered on the account, so a 200 means
 * "accepted by the gateway", not "delivered to the handset". Two documented
 * cases make that distinction load-bearing rather than theoretical, and both are
 * handled here as FAILURES:
 *
 *   1. `data.warning.code === 'SMS_PERMISSION_MISSING'` — the sending phone
 *      last reported that it has no SMS permission. The docs are explicit that
 *      the message is queued and will fail. Reporting that as a success is the
 *      single worst outcome available on this path: the user is told a code is on
 *      its way, it never is, and they have no way to tell that from a carrier
 *      drop.
 *   2. `failureCount` above zero — the message did not reach the phone.
 *
 * A 429 (plan limit exhausted) is likewise reported as a failure, not thrown.
 *
 * And because the gateway itself can reject the message seconds AFTER the 200
 * (no credit, no signal, carrier block), the send is followed by a bounded
 * delivery check — see awaitDelivery() for why that is not optional.
 */
async function textbeeTransport({ to, body }) {
  const apiKey = String(process.env.TEXTBEE_API_KEY || '').trim();
  if (!apiKey) return { ok: false, reason: 'not-configured' };

  // Resolved before the send, so the delivery check knows where to look.
  const deviceId = await defaultDeviceId();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const payload = {
      message: body,
      recipients: [to],
    };
    if (deviceId) payload.deviceId = deviceId;

    const response = await fetch('https://api.textbee.dev/api/v1/gateway/send-sms', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // The provider's body can echo the number and the code back at us, so it
      // is logged by status only. Its own status codes are enough to act on:
      // 400 = no enabled device / unverified email, 401 = bad key,
      // 429 = plan limit used up.
      console.error(`[SMS:textbee] delivery refused with status ${response.status}`);
      return { ok: false, reason: response.status === 429 ? 'plan-exhausted' : 'provider-rejected' };
    }

    const parsed = await response.json().catch(() => ({}));
    const data = (parsed && parsed.data) || {};

    // The send is done; its timeout has no further business. Disarming it here
    // rather than waiting for the `finally` matters because the delivery check
    // below can outlive it, and an abort firing against an already-completed
    // request is the kind of thing that reads as a mystery later.
    clearTimeout(timer);

    // Accepted by the gateway, but flagged as certain not to arrive. Treated as
    // a failure on purpose — see the note above.
    if (data.warning && data.warning.code) {
      console.error(`[SMS:textbee] gateway flagged the send: ${data.warning.code}`);
      return { ok: false, reason: 'gateway-warning' };
    }
    // A batch can be accepted and still contain nothing that went out.
    const failures = Number(data.failureCount);
    if (Number.isFinite(failures) && failures > 0) {
      console.error(`[SMS:textbee] gateway accepted the batch but ${failures} message(s) failed to push`);
      return { ok: false, reason: 'gateway-rejected' };
    }

    const batchId = str(data.smsBatchId);

    // The send was ACCEPTED. Now find out whether it actually leaves the phone.
    const verdict = await awaitDelivery({
      deviceId,
      batchId,
      budgetMs: deliveryWaitMs(),
    });
    if (verdict.outcome === 'failed') {
      console.error(`[SMS:textbee] the device could not send: ${verdict.error || 'no reason given'}`);
      return { ok: false, reason: 'delivery-failed' };
    }

    return { ok: true, sid: batchId };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    console.error(`[SMS:textbee] delivery failed: ${aborted ? 'timed out' : error.message}`);
    return { ok: false, reason: aborted ? 'timed-out' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Twilio over its REST API.
 *
 * Uses the global `fetch` rather than the Twilio SDK: this is one POST with
 * three form fields, and an SDK would add a dependency tree to a repository that
 * currently reaches for raw libraries everywhere else (`nodemailer`, `speakeasy`
 * are used because they do real work; this would not be).
 */
async function twilioTransport({ to, body }) {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  const from = String(process.env.TWILIO_FROM || '').trim();
  if (!sid || !token || !from) return { ok: false, reason: 'not-configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          // Twilio authenticates with HTTP Basic on the account SID/token pair.
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`, 'utf8').toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
      },
    );

    if (!response.ok) {
      // The provider's body can echo the number and the code back at us, so it
      // is logged by status only. Twilio's own error codes are enough to
      // diagnose the common cases.
      console.error(`[SMS:twilio] delivery refused with status ${response.status}`);
      return { ok: false, reason: 'provider-rejected' };
    }

    const payload = await response.json().catch(() => ({}));
    return { ok: true, sid: str(payload && payload.sid) };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    console.error(`[SMS:twilio] delivery failed: ${aborted ? 'timed out' : error.message}`);
    // 'unreachable' is retryable by the user; anything else is treated the same
    // by callers, so one reason is enough here.
    return { ok: false, reason: aborted ? 'timed-out' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A generic HTTP relay, for deployments that front their own SMS gateway.
 *
 * POSTs `{ to, body, purpose }` as JSON to SMS_WEBHOOK_URL and treats any 2xx
 * as delivered. This is the seam for MessageBird, Vonage, a self-hosted relay or
 * a carrier aggregator, without any of them appearing in the routes.
 */
async function webhookTransport({ to, body, purpose }) {
  const url = String(process.env.SMS_WEBHOOK_URL || '').trim();
  if (!url) return { ok: false, reason: 'not-configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const secret = String(process.env.SMS_WEBHOOK_SECRET || '').trim();
    if (secret) headers.Authorization = `Bearer ${secret}`;

    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({ to, body, purpose }),
    });
    if (!response.ok) {
      console.error(`[SMS:webhook] relay refused with status ${response.status}`);
      return { ok: false, reason: 'provider-rejected' };
    }
    const payload = await response.json().catch(() => ({}));
    return { ok: true, sid: str(payload && (payload.sid || payload.id)) };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    console.error(`[SMS:webhook] relay failed: ${aborted ? 'timed out' : error.message}`);
    return { ok: false, reason: aborted ? 'timed-out' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

const TRANSPORTS = {
  console: consoleTransport,
  textbee: textbeeTransport,
  twilio: twilioTransport,
  webhook: webhookTransport,
};

/**
 * Deliver one message.
 *
 * Never throws and never rejects: a transport outage must be a refused send
 * that a route can turn into an honest "we could not send that", not an
 * exception that escapes into a generic 500 and tells the caller nothing.
 *
 * @param {object}  args
 * @param {string}  args.to       Canonical E.164 recipient.
 * @param {string}  args.body     Message text.
 * @param {string} [args.purpose] Free-text tag for logs; never a credential.
 * @returns {Promise<{ok: boolean, sid?: string, reason?: string}>}
 */
async function sendSms({ to, body, purpose } = {}) {
  const { isValidE164, maskPhone } = require('./phoneNumber');

  // Re-validated at the point of USE, not trusted from wherever it was stored.
  // This is what makes a hand-edited or imported database row incapable of
  // producing an outgoing request to an arbitrary destination.
  if (!isValidE164(to)) {
    console.error('[SMS] refused a message to a recipient that is not a canonical number');
    return { ok: false, reason: 'invalid-recipient' };
  }

  const text = str(body).trim();
  if (!text) return { ok: false, reason: 'empty-message' };

  const { configured, provider } = status();
  if (!configured) return { ok: false, reason: 'not-configured' };

  const transport = TRANSPORTS[provider];
  if (!transport) {
    console.error(`[SMS] unknown SMS_PROVIDER "${provider}"`);
    return { ok: false, reason: 'not-configured' };
  }

  try {
    const result = await transport({ to, body: text, purpose });
    if (!result || result.ok !== true) {
      // Masked, so a delivery failure stays diagnosable without writing the
      // subscriber's number into the log.
      console.error(`[SMS] delivery failed for ${maskPhone(to)} (${provider}): ${(result && result.reason) || 'unknown'}`);
      return { ok: false, reason: (result && result.reason) || 'unknown' };
    }
    return result;
  } catch (error) {
    console.error(`[SMS] transport threw: ${error.message}`);
    return { ok: false, reason: 'unknown' };
  }
}

/**
 * Can SMS be offered to this account for RECOVERY right now?
 *
 * Three conditions, all necessary:
 *   • the number is canonical E.164 — re-read from storage, never trusted from
 *     wherever it was written;
 *   • it has been proven — `phoneNumberVerifiedAt` is what separates a number
 *     the account holder controls from one somebody else typed in;
 *   • this deployment can actually deliver — otherwise we would collect a code
 *     the user can never receive.
 *
 * Read paths call this instead of checking the fields themselves, so "is this
 * account recoverable by phone?" is answered the same way everywhere. A caller
 * that forgets one of the conditions cannot under-enforce it in a way the other
 * callers would not also under-enforce.
 *
 * @param {object|null} user
 * @returns {boolean}
 */
function isEligible(user) {
  const { isValidE164 } = require('./phoneNumber');
  if (!user) return false;
  if (!isValidE164(user.phoneNumber)) return false;
  if (!user.phoneNumberVerifiedAt) return false;
  return status().configured;
}

/**
 * Can SMS stand in as a second factor at SIGN-IN for this account?
 *
 * Recovery eligibility is necessary but not sufficient: standing second-factor
 * use is the riskier of the two, because it hands a SIM-swap a way past an
 * authenticator app on every ordinary sign-in rather than only during a recovery
 * the account holder has already lost access to. It therefore carries its own
 * explicit opt-in, which is separate from having a verified number.
 *
 * @param {object|null} user
 * @returns {boolean}
 */
function eligibleForSecondFactor(user) {
  return isEligible(user) && user.phoneNumberAsSecondFactor === true;
}

/**
 * What to tell a person when a send is refused.
 *
 * The distinction that matters is TEMPORARY versus PERMANENT. "Try again in a
 * moment" is honest for a timeout and actively misleading for a gateway whose
 * phone has no credit — the user will retry, fail identically, and conclude the
 * feature is broken rather than that the sending phone needs airtime.
 *
 * Deliberately says nothing about WHICH factor failed or anything account-
 * specific: this string is safe to return from an unauthenticated route.
 *
 * @param {string} reason  the value from a sendSms() failure
 * @returns {string}
 */
function failureMessage(reason) {
  switch (reason) {
    case 'delivery-failed':
    case 'gateway-rejected':
    case 'gateway-warning':
      return 'We could not send a text message right now. Please use another way to recover or sign in.';
    case 'not-configured':
    case 'invalid-recipient':
      return 'Text messages are not available on this account right now. Please use another way to recover or sign in.';
    case 'plan-exhausted':
      return 'Text messages cannot be sent right now. Please use another way to recover or sign in.';
    case 'unreachable':
    case 'timed-out':
      return 'We could not reach the text service. Please try again in a moment, or use another way to sign in.';
    default:
      return 'We could not send a text message. Please try again in a moment, or use another way to sign in.';
  }
}

// ── Message bodies ──────────────────────────────────────────────────────────
//
// Short by necessity, and SEGMENT-COUNTED by necessity. SMS is billed per
// 160-character segment (153 once concatenated), so every character past that
// boundary costs another whole message. The recovery body was 167 characters —
// three characters of filler, billed as two segments on every single password
// recovery. Both are now held under the limit by `segmentOverflow`, asserted in
// the suite, so a future edit cannot quietly reintroduce the doubling.
//
// Each says the same three things: who is asking, what the code is, and that the
// code is not a password. None contain an account identifier — the recipient
// already has to know which account they are signing into, and a message that
// leaks "an account with this email exists" turns every inbox into an
// enumeration oracle.
const GSM7_SEGMENT_LIMIT = 160;

function verificationBody(code) {
  return `Your SuppliWise verification code is ${code}. It expires in ${SMS_CODE_TTL_MINUTES} minutes. If you did not request this, ignore this message and do not share the code.`;
}

function recoveryBody(code) {
  return `Your SuppliWise account recovery code is ${code}. It expires in ${SMS_CODE_TTL_MINUTES} minutes. Use it only on the SuppliWise recovery page. If you did not ask for this, ignore it.`;
}

/**
 * How many characters a body exceeds the single-segment budget by.
 *
 * Zero or negative means one billable segment. Exposed so the suite can assert
 * it: a body two characters over is invisible when reading the source and
 * doubles the cost of every send, so it is checked rather than trusted to a
 * comment.
 */
function segmentOverflow(body) {
  return String(body || '').length - GSM7_SEGMENT_LIMIT;
}

/** Test seam: forget the cached device id so a suite can re-resolve it. */
function _resetCache() {
  cachedDeviceId = '';
  cachedDeviceIdAt = 0;
}

module.exports = {
  SMS_CODE_TTL_MINUTES,
  REQUEST_TIMEOUT_MS,
  DEFAULT_DELIVERY_WAIT_MS,
  status,
  isConfigured,
  isEligible,
  eligibleForSecondFactor,
  sendSms,
  failureMessage,
  verificationBody,
  recoveryBody,
  segmentOverflow,
  GSM7_SEGMENT_LIMIT,
  _resetCache,
};