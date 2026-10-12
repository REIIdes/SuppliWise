/**
 * The SMS layer: number validation, transport selection, and eligibility.
 *
 * The tests here are mostly about REFUSAL, because that is where this feature
 * can do real damage. Every number reaching the database was typed by someone,
 * and every number reaching a carrier costs money and lands on a stranger's
 * handset if it is wrong — so "what does this refuse?" is the question worth
 * pinning down, far more than "what does it accept?".
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-sms';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePhone, isValidE164, maskPhone } = require('../utils/phoneNumber');
const sms = require('../utils/sms');

/** Restore the SMS-related environment after a test that changes it. */
function withSmsEnv(overrides, fn) {
  const keys = [
    'SMS_PROVIDER', 'TEXTBEE_API_KEY', 'TEXTBEE_DEVICE_ID',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM',
    'SMS_WEBHOOK_URL', 'SMS_WEBHOOK_SECRET', 'ALLOW_DEV_SMS_RESPONSE',
  ];
  const before = {};
  for (const key of keys) before[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

// ── Normalisation ───────────────────────────────────────────────────────────

test('a number is accepted only in E.164 form', () => {
  assert.equal(normalizePhone('+447700900123'), '+447700900123');
  assert.equal(normalizePhone('  +447700900123  '), '+447700900123');
});

test('formatting characters are stripped because they cannot change the number', () => {
  for (const input of ['+44 7700 900123', '+44-7700-900123', '+44.7700.900123', '+44 (7700) 900123']) {
    assert.equal(normalizePhone(input), '+447700900123', `failed for ${input}`);
  }
});

test('a bracketed country code with no + is still refused', () => {
  // `(44) 7700 900123` strips cleanly to `447700900123`, which has no `+` — and
  // a number with no `+` is ambiguous by definition: it could be a national
  // number that merely happens to start with 44. Stripping is not enough to make
  // it safe, so it is refused and the user is asked to type the `+`.
  assert.equal(normalizePhone('(44) 7700 900123'), null);
});

test('a national number is refused rather than guessed at', () => {
  // THE decisive case. `07700900123` is a UK mobile; guessing a country code is
  // how a verification code gets texted to somebody who never asked for one,
  // at the deployment's expense. A refusal costs the user one keystroke.
  assert.equal(normalizePhone('07700900123'), null);
  assert.equal(normalizePhone('2071838750'), null);
});

test('an explicit international prefix is honoured, because it is unambiguous', () => {
  assert.equal(normalizePhone('00447700900123'), '+447700900123');
});

test('letters and extension noise are refused, not stripped', () => {
  // Stripping "07700900123 ext 4" to digits yields 077009001234 — a real number
  // belonging to somebody else. Refusing is the only safe reading.
  assert.equal(normalizePhone('+447700900123 ext 4'), null);
  assert.equal(normalizePhone('+4477009O0123'), null);
  assert.equal(normalizePhone('call me on +447700900123'), null);
});

test('length and leading-zero rules are enforced', () => {
  assert.equal(normalizePhone('+1234'), null, 'too short to be real');
  assert.equal(normalizePhone(`+${'1'.repeat(16)}`), null, 'E.164 caps at 15 digits');
  assert.equal(normalizePhone('+0123456789'), null, 'a country code never starts with 0');
});

test('empty and non-string input is refused without throwing', () => {
  for (const input of ['', '   ', null, undefined, {}, [], 447700900123]) {
    assert.equal(normalizePhone(input), null);
  }
});

// ── isValidE164: the check that runs at the point of USE ─────────────────────

test('isValidE164 is a strict identity check, not a normaliser', () => {
  // This is the gate that runs before a send, on a value read back from the
  // database. It must reject a merely-parseable number, because accepting one
  // would let a hand-edited row become an outgoing message.
  assert.equal(isValidE164('+447700900123'), true);
  assert.equal(isValidE164('07700900123'), false);
  assert.equal(isValidE164('+44 7700 900123'), false, 'spacing is not canonical');
  assert.equal(isValidE164(''), false);
  assert.equal(isValidE164(undefined), false);
});

// ── Masking ──────────────────────────────────────────────────────────────────

test('masking keeps the last three digits and nothing else', () => {
  const masked = maskPhone('+447700900123');
  assert.equal(masked, '+•••••••••123');
  assert.ok(!masked.includes('447700'), 'the subscriber number must not survive');
});

test('masking tolerates junk without throwing', () => {
  assert.equal(maskPhone(''), 'your phone');
  assert.equal(maskPhone(null), 'your phone');
  assert.equal(maskPhone('+12'), '+•••');
});

// ── Transport selection ──────────────────────────────────────────────────────

test('with no credentials configured, SMS reports itself unavailable', () => {
  withSmsEnv({
    SMS_PROVIDER: '', TEXTBEE_API_KEY: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '',
    TWILIO_FROM: '', SMS_WEBHOOK_URL: '', ALLOW_DEV_SMS_RESPONSE: '',
  }, () => {
    assert.equal(sms.isConfigured(), false);
    assert.equal(sms.status().configured, false);
  });
});

test('a TextBee key alone selects TextBee, without an explicit provider', () => {
  withSmsEnv({
    SMS_PROVIDER: '', TEXTBEE_API_KEY: 'txb_example', TWILIO_ACCOUNT_SID: '',
    TWILIO_AUTH_TOKEN: '', TWILIO_FROM: '', SMS_WEBHOOK_URL: '',
  }, () => {
    assert.deepEqual(sms.status(), { configured: true, provider: 'textbee', development: false });
  });
});

test('an explicit provider wins over inference', () => {
  withSmsEnv({ SMS_PROVIDER: 'console', TEXTBEE_API_KEY: 'txb_example' }, () => {
    assert.equal(sms.status().provider, 'console');
  });
});

test('an unknown provider name is unavailable rather than half-working', () => {
  withSmsEnv({ SMS_PROVIDER: 'carrier-pigeon', TEXTBEE_API_KEY: 'txb_example' }, () => {
    assert.equal(sms.isConfigured(), false);
  });
});

// ── Eligibility ──────────────────────────────────────────────────────────────

const eligibleUser = {
  phoneNumber: '+447700900123',
  phoneNumberVerifiedAt: new Date(),
  phoneNumberAsSecondFactor: true,
};

test('recovery needs a canonical number, a verification, and a working provider', () => {
  withSmsEnv({ SMS_PROVIDER: '', TEXTBEE_API_KEY: 'txb_example' }, () => {
    assert.equal(sms.isEligible(eligibleUser), true);

    assert.equal(sms.isEligible({ ...eligibleUser, phoneNumber: '' }), false, 'no number');
    assert.equal(sms.isEligible({ ...eligibleUser, phoneNumberVerifiedAt: null }), false, 'never verified');
    assert.equal(sms.isEligible({ ...eligibleUser, phoneNumber: '07700900123' }), false, 'not canonical');
    assert.equal(sms.isEligible(null), false);
  });
});

test('a deployment with no provider cannot recover by phone', () => {
  // Otherwise we would collect a code the user can never receive.
  withSmsEnv({ SMS_PROVIDER: '', TEXTBEE_API_KEY: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_FROM: '', SMS_WEBHOOK_URL: '' }, () => {
    assert.equal(sms.isEligible(eligibleUser), false);
  });
});

test('second-factor use additionally requires the explicit opt-in', () => {
  // The two carry different risk: recovery is used when access is already lost,
  // whereas standing second-factor use opens every ordinary sign-in.
  withSmsEnv({ SMS_PROVIDER: '', TEXTBEE_API_KEY: 'txb_example' }, () => {
    assert.equal(sms.eligibleForSecondFactor(eligibleUser), true);
    assert.equal(sms.eligibleForSecondFactor({ ...eligibleUser, phoneNumberAsSecondFactor: false }), false);
    assert.equal(sms.eligibleForSecondFactor({ ...eligibleUser, phoneNumberAsSecondFactor: undefined }), false);
    assert.equal(sms.eligibleForSecondFactor({ ...eligibleUser, phoneNumberAsSecondFactor: 'true' }), false, 'string is not a boolean');
  });
});

// ── sendSms refusal paths (no network is touched) ────────────────────────────

test('a non-canonical recipient is refused before any network call', async () => {
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { sent.push(args); return Promise.reject(new Error('should not be called')); };
  try {
    for (const to of ['07700900123', 'not-a-number', '', null, undefined, '+44 7700 900123']) {
      const result = await sms.sendSms({ to, body: '123456', purpose: 'test' });
      assert.equal(result.ok, false, `expected a refusal for ${to}`);
      assert.equal(result.reason, 'invalid-recipient');
    }
    assert.equal(sent.length, 0, 'nothing may reach the network');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an unconfigured provider refuses the send instead of throwing', async () => {
  await withSmsEnv({ SMS_PROVIDER: '', TEXTBEE_API_KEY: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_FROM: '', SMS_WEBHOOK_URL: '' }, async () => {
    const result = await sms.sendSms({ to: '+447700900123', body: '123456', purpose: 'test' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-configured');
  });
});

test('an empty message is refused', async () => {
  await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example' }, async () => {
    const result = await sms.sendSms({ to: '+447700900123', body: '   ', purpose: 'test' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty-message');
  });
});

test('a provider that hangs is cut off rather than holding the request open', async () => {
  const originalFetch = globalThis.fetch;
  // Never resolves: without the transport's own timeout this would hang the
  // request — and a sign-in — indefinitely.
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  try {
    await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example' }, async () => {
      const result = await sms.sendSms({ to: '+447700900123', body: '123456', purpose: 'test' });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'timed-out');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a TextBee gateway warning is reported as a failure, not a success', async () => {
  // SMS_PERMISSION_MISSING means the sending phone cannot send at all. Treating
  // the 200 as a success would tell a user a code is on its way when it is
  // guaranteed not to arrive — the worst outcome this path has.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      data: {
        smsBatchId: 'batch_1',
        recipientCount: 1,
        warning: { code: 'SMS_PERMISSION_MISSING', message: 'No SMS permission' },
      },
    }),
  });
  try {
    await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example' }, async () => {
      const result = await sms.sendSms({ to: '+447700900123', body: '123456', purpose: 'test' });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'gateway-warning');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an accepted batch that failed to push is reported as a failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      data: { smsBatchId: 'batch_2', recipientCount: 1, successCount: 0, failureCount: 1 },
    }),
  });
  try {
    await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example' }, async () => {
      const result = await sms.sendSms({ to: '+447700900123', body: '123456', purpose: 'test' });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'gateway-rejected');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an exhausted plan limit is a clean refusal, not a crash', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
  try {
    await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example' }, async () => {
      const result = await sms.sendSms({ to: '+447700900123', body: '123456', purpose: 'test' });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'plan-exhausted');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a clean TextBee acceptance returns the batch id', async () => {
  const originalFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = (url, options) => {
    seen = { url, options };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { smsBatchId: 'batch_3', recipientCount: 1, successCount: 1 } }),
    });
  };
  try {
    await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example' }, async () => {
      const result = await sms.sendSms({ to: '+447700900123', body: 'code 123456', purpose: 'login' });
      assert.equal(result.ok, true);
      assert.equal(result.sid, 'batch_3');
      // Pins the documented request shape: the API key goes in x-api-key, and
      // the recipient is an E.164 string in a one-element array.
      assert.equal(seen.url, 'https://api.textbee.dev/api/v1/gateway/send-sms');
      assert.equal(seen.options.headers['x-api-key'], 'txb_example');
      const sent = JSON.parse(seen.options.body);
      assert.deepEqual(sent.recipients, ['+447700900123']);
      assert.equal(sent.message, 'code 123456');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a transport that throws cannot escape sendSms', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('socket hang up'));
  try {
    await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example' }, async () => {
      const result = await sms.sendSms({ to: '+447700900123', body: '123456', purpose: 'test' });
      assert.equal(result.ok, false, 'a transport failure must resolve, never throw');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the development transport refuses to run in production', async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await withSmsEnv({ SMS_PROVIDER: 'console', ALLOW_DEV_SMS_RESPONSE: '' }, async () => {
      const result = await sms.sendSms({ to: '+447700900123', body: 'code 123456', purpose: 'test' });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'development-transport-disabled');
    });
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});

// ── Delivery confirmation ────────────────────────────────────────────────────
//
// TextBee returns 200 when a message is QUEUED. The gateway phone then pushes it
// to the radio, and THAT is where a phone with no credit, no signal or a carrier
// block fails — seconds later, through a different endpoint. Without a delivery
// check the app would tell a user their code is on its way for a message that
// was already doomed.

/**
 * Route `fetch` by URL so one test can drive the send, the device lookup and
 * the batch poll independently.
 */
function mockTextbee({ sendBody, sendStatus = 200, devices, batch }) {
  const calls = [];
  globalThis.fetch = (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/devices')) {
      return Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve({ data: devices || [] }),
      });
    }
    if (String(url).includes('/sms-batch/')) {
      if (!batch) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve(batch()),
      });
    }
    return Promise.resolve({
      ok: sendStatus >= 200 && sendStatus < 300,
      status: sendStatus,
      json: () => Promise.resolve(sendBody || { data: {} }),
    });
  };
  return calls;
}

const ACCEPTED = { data: { smsBatchId: 'batch_9', recipientCount: 1, successCount: 1 } };
const ONE_DEVICE = [{ _id: 'dev_1', enabled: true, isDefault: true, lastHeartbeat: '2026-01-01T00:00:00Z' }];

test('a batch the gateway reports as failed is NOT reported as a send success', async () => {
  // The defect this exists to prevent: without the check, this returns ok:true
  // and the user waits forever for a message that will never arrive.
  sms._resetCache();
  const originalFetch = globalThis.fetch;
  mockTextbee({
    sendBody: ACCEPTED,
    devices: ONE_DEVICE,
    batch: () => ({
      data: {
        batch: { status: 'failed', failureCount: 1 },
        messages: [{ status: 'failed', errorMessage: 'no SMS credit on SIM' }],
      },
    }),
  });
  try {
    await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example', SMS_DELIVERY_WAIT_MS: '4000' }, async () => {
      const result = await sms.sendSms({ to: '+447700900123', body: '123456', purpose: 'test' });
      assert.equal(result.ok, false, 'a failed delivery must not be reported as a send success');
      assert.equal(result.reason, 'delivery-failed');
    });
  } finally {
    globalThis.fetch = originalFetch;
    sms._resetCache();
  }
});

test('a batch the gateway reports as completed is a success', async () => {
  sms._resetCache();
  const originalFetch = globalThis.fetch;
  mockTextbee({
    sendBody: ACCEPTED,
    devices: ONE_DEVICE,
    batch: () => ({ data: { batch: { status: 'completed', failureCount: 0 }, messages: [] } }),
  });
  try {
    await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example', SMS_DELIVERY_WAIT_MS: '4000' }, async () => {
      const result = await sms.sendSms({ to: '+447700900123', body: '123456', purpose: 'test' });
      assert.equal(result.ok, true);
      assert.equal(result.sid, 'batch_9');
    });
  } finally {
    globalThis.fetch = originalFetch;
    sms._resetCache();
  }
});

test('no verdict within the wait is treated as UNKNOWN, never as failure', async () => {
  // Refusing a message that would have arrived only costs the user a retry.
  // Treating silence as failure would break working gateways on a slow device.
  sms._resetCache();
  const originalFetch = globalThis.fetch;
  mockTextbee({ sendBody: ACCEPTED, devices: ONE_DEVICE, batch: null });
  try {
    await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example', SMS_DELIVERY_WAIT_MS: '300' }, async () => {
      const result = await sms.sendSms({ to: '+447700900123', body: '123456', purpose: 'test' });
      assert.equal(result.ok, true, 'silence must not be read as failure');
    });
  } finally {
    globalThis.fetch = originalFetch;
    sms._resetCache();
  }
});

test('the delivery check is bounded — it cannot hang the request', async () => {
  sms._resetCache();
  const originalFetch = globalThis.fetch;
  mockTextbee({
    sendBody: ACCEPTED,
    devices: ONE_DEVICE,
    // Stays 'processing' forever: the poll must give up on schedule.
    batch: () => ({ data: { batch: { status: 'processing' }, messages: [] } }),
  });
  try {
    await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example', SMS_DELIVERY_WAIT_MS: '600' }, async () => {
      const started = Date.now();
      const result = await sms.sendSms({ to: '+447700900123', body: '123456', purpose: 'test' });
      const elapsed = Date.now() - started;
      assert.equal(result.ok, true);
      assert.ok(elapsed < 5000, `waited ${elapsed}ms — the cap is not being enforced`);
    });
  } finally {
    globalThis.fetch = originalFetch;
    sms._resetCache();
  }
});

test('an account with no enabled device is reported, not silently queued', async () => {
  sms._resetCache();
  const originalFetch = globalThis.fetch;
  mockTextbee({ sendBody: ACCEPTED, devices: [] });
  try {
    await withSmsEnv({ SMS_PROVIDER: 'textbee', TEXTBEE_API_KEY: 'txb_example', SMS_DELIVERY_WAIT_MS: '300' }, async () => {
      // Still a send — TextBee may pick a device up later — but the absence is
      // logged, because it is the single most common cause of "it never arrives".
      const result = await sms.sendSms({ to: '+447700900123', body: '123456', purpose: 'test' });
      assert.equal(result.ok, true);
    });
  } finally {
    globalThis.fetch = originalFetch;
    sms._resetCache();
  }
});

// ── Failure messages ────────────────────────────────────────────────────────

test('a permanent gateway failure is not answered with "try again"', () => {
  // "Try again in a moment" against a phone with no credit sends the user round
  // in circles for a failure that will repeat exactly.
  for (const reason of ['delivery-failed', 'gateway-rejected', 'gateway-warning']) {
    const message = sms.failureMessage(reason);
    assert.match(message, /another way/i, `reason ${reason} should point elsewhere`);
    assert.doesNotMatch(message, /try again/i, `reason ${reason} should not advise a futile retry`);
  }
});

test('a transient failure does invite a retry', () => {
  for (const reason of ['unreachable', 'timed-out']) {
    assert.match(sms.failureMessage(reason), /try again/i, `reason ${reason} should invite a retry`);
  }
});

test('a failure message never reveals anything account-specific', () => {
  for (const reason of ['delivery-failed', 'not-configured', 'invalid-recipient', 'plan-exhausted', 'unreachable', 'weird']) {
    const message = sms.failureMessage(reason);
    assert.doesNotMatch(message, /@/, 'no address');
    assert.doesNotMatch(message, /\+\d/, 'no number');
    assert.ok(message.length < 200, 'keep it short enough to render');
  }
});

test('a message carries the code and nothing that identifies an account', () => {
  const body = sms.verificationBody('123456');
  assert.ok(body.includes('123456'), 'the recipient has to read the code back');
  assert.ok(!/@/.test(body), 'an address in a message is an enumeration oracle');
  assert.ok(!/\d{5,}/.test(body.replace('123456', '')), 'no other long number to confuse');
});

test('the code body agrees with the expiry the server enforces', () => {
  assert.ok(
    sms.verificationBody('123456').includes(String(sms.SMS_CODE_TTL_MINUTES)),
    'the message must not promise a window the server does not honour',
  );
  assert.ok(sms.recoveryBody('123456').includes(String(sms.SMS_CODE_TTL_MINUTES)));
});