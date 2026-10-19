'use strict';
/**
 * The capture transport every e2e suite hands its test server.
 *
 * This file exists because the thing it replaces was worse than having nothing:
 * `EMAIL_ENABLED=false` was read by no code at all, so a developer's run sent
 * real OTP emails through the provider in their `.env`, and CI — which has no
 * `.env` — could not deliver any, which failed every assertion about the
 * email-based second factor. Both halves depend on this stub actually completing
 * an SMTP session, so the stub is tested rather than trusted.
 *
 * It is driven through nodemailer, not by hand: nodemailer is what decides
 * whether a greeting, an AUTH challenge and a DATA terminator were acceptable,
 * and a hand-written client would pass against a stub the real sender rejects.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');

const { startStubSmtp, stubSmtpEnv } = require('./stubSmtp');

/** The transport the test server is configured with, given a running stub. */
function transportFor(stub) {
  const env = stubSmtpEnv(stub.port);
  return nodemailer.createTransport({
    host: env.EMAIL_HOST,
    port: Number(env.EMAIL_PORT),
    secure: env.EMAIL_SECURE === 'true',
    auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASSWORD },
  });
}

test('the stub takes an SMTP session from a real nodemailer transport', async (t) => {
  const stub = await startStubSmtp();
  const transport = transportFor(stub);
  t.after(async () => {
    await transport.close();
    await stub.stop();
  });

  const info = await transport.sendMail({
    from: stubSmtpEnv(stub.port).EMAIL_FROM_ADDRESS,
    to: 'member@example.com',
    subject: 'Your login code is 123456',
    text: 'line one\nline two',
  });

  assert.ok(info.messageId, 'the send is accepted, so issueOtp() reports delivered');
  assert.equal(stub.messages.length, 1, 'exactly one message was captured');
  const [message] = stub.messages;
  assert.match(message.from, /member|stub/i, 'and the envelope sender survived the round-trip');
  assert.deepEqual(message.to, ['<member@example.com>']);
  assert.match(message.body, /subject: Your login code is 123456/i);
  assert.match(message.body, /line one\r?\nline two/, 'the body arrived whole');
});

test('nothing leaves the machine: the only host ever named is loopback', () => {
  const env = stubSmtpEnv(2525);
  assert.equal(env.EMAIL_HOST, '127.0.0.1',
    'a test run must not be able to reach a provider, even by accident');
  assert.equal(env.EMAIL_SECURE, 'false', 'and the stub speaks plaintext, so no certificate is required');
  // The credentials are placeholders, not secrets — but both must be present, or
  // utils/email.js declines to build a transporter at all and every email
  // assertion falls into the delivery-failure branch instead.
  assert.ok(env.EMAIL_USER && env.EMAIL_PASSWORD, 'creds exist so a transporter is actually created');
});

test('the stub stops, and leaves no handle behind', async () => {
  // A leftover listening socket is an unsettled handle in the PARENT process, and
  // an unsettled handle is what makes `node --test` never exit — the failure mode
  // that burned six hours of CI before the hanging suite was named.
  const stub = await startStubSmtp();
  const { port } = stub;
  await stub.stop();

  const net = require('node:net');
  const refused = await new Promise((resolve) => {
    const probe = net.connect(port, '127.0.0.1');
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', () => resolve(true));
    setTimeout(() => { probe.destroy(); resolve(false); }, 2000);
  });
  assert.ok(refused, 'the capture port is closed again');
});
