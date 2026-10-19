'use strict';
/**
 * A local SMTP server that captures mail instead of sending it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `startTestServer` used to hand the test server `EMAIL_ENABLED=false` and call
 * that "never send real mail from a test run". Nothing in the codebase reads
 * `EMAIL_ENABLED` — the flag was a control that existed only in its own comment.
 * What actually decided whether mail went out was `utils/email.js`:120, which
 * builds a transporter only when `EMAIL_USER` and `EMAIL_PASSWORD` are present.
 * So a test run did the opposite of what the flag claimed, on both machines:
 *
 *   - on a developer's machine, whose `.env` carries real credentials, every
 *     sign-in test connected to the production provider and SENT REAL OTP EMAILS
 *     while it ran;
 *   - on CI, which has no `.env`, no transporter could be built, `issueOtp()`
 *     answered `{ ok: false }`, and the routes returned the delivery-failure 503
 *     instead of the `requiresOtp` / `mfaMethods` body the suite was asserting.
 *     That is the failure CI reported as `mfa-transaction.test.js failed (exit 1)`.
 *
 * A capture transport fixes both halves: delivery always succeeds, so the routes
 * take the branch under test, and nothing ever leaves the machine, because the
 * only host the transporter is pointed at is 127.0.0.1 on an ephemeral port.
 *
 * WHAT IT IMPLEMENTS
 * ------------------
 * Just enough RFC 5321 for nodemailer: EHLO with an advertised AUTH LOGIN (only
 * LOGIN, so nodemailer cannot pick a mechanism this stub handles worse), the
 * three-step LOGIN challenge, MAIL FROM, RCPT TO, DATA until the lone dot, RSET,
 * NOOP, QUIT. Anything else is refused with 502, which nodemailer ignores.
 * STARTTLS is deliberately NOT advertised — the test server runs with
 * `requireTLS` off (it is only forced in production), so the session stays
 * cleartext on loopback and no certificate has to exist for it.
 */
const net = require('net');

const B64_USER_PROMPT = Buffer.from('Username:').toString('base64');
const B64_PASS_PROMPT = Buffer.from('Password:').toString('base64');

/**
 * @returns {Promise<{port: number, messages: Array<object>, stop: () => Promise<void>}>}
 */
async function startStubSmtp() {
  const messages = [];

  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buffer = '';
    let message = null;    // the envelope being built (MAIL FROM / RCPT TO / body)
    let inData = false;    // between `DATA` and the lone dot, every line is body
    let authStep = 0;       // 0 = not authenticating, 1 = user sent, 2 = password sent

    const send = (line) => { if (!sock.destroyed) sock.write(`${line}\r\n`); };

    // RFC 5321 puts the server first: nodemailer will not send EHLO until it has
    // read a 220 greeting, and "Greeting never received" is the whole error.
    send('220 localhost ESMTP stub');

    sock.on('error', () => { /* a client that hangs up mid-session is not a failure */ });
    sock.on('data', (chunk) => {
      buffer += chunk;
      let at = buffer.indexOf('\r\n');
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        handle(line);
        at = buffer.indexOf('\r\n');
      }
    });
    sock.once('close', () => { message = null; inData = false; });

    function handle(line) {
      // Only the DATA phase swallows lines; before it, `RCPT TO` and `DATA` itself
      // are commands and must be read as such.
      if (inData) {
        if (line === '.') {
          inData = false;
          messages.push(message);
          message = null;
          send('250 2.0.0 <stub> Queued');
        } else if (message) {
          message.body += `${line}\r\n`;
        }
        return;
      }

      const verb = line.slice(0, 4).toUpperCase();

      // AUTH LOGIN is a challenge exchange, and a client may put the first
      // credential inline (`AUTH LOGIN <base64>`), which nodemailer does. While a
      // challenge is outstanding the next line IS the credential, so it is matched
      // by state — testing it for "looks like base64" cannot work, because base64
      // is uppercase letters by construction.
      if (authStep > 0) {
        if (authStep === 1) {
          authStep = 2;
          return send(`334 ${B64_PASS_PROMPT}`);
        }
        authStep = 0;
        return send('235 2.7.0 Accepted');
      }

      switch (verb) {
        case 'EHLO':
          // Only LOGIN is advertised: a client that chose PLAIN or XOAUTH2 would
          // be sent down a path this file does not implement.
          return send('250-localhost at your service\r\n250-AUTH LOGIN\r\n250-SIZE 10485760\r\n250 8BITMIME');
        case 'HELO':
          return send('250 localhost');
        case 'AUTH': {
          const inline = /^AUTH\s+LOGIN\s+(\S+)/i.exec(line);
          if (!/^AUTH\s+LOGIN/i.test(line)) return send('504 Unrecognized authentication type');
          if (inline) {
            // Username arrived with the command, so the only challenge left is
            // the password's.
            authStep = 2;
            return send(`334 ${B64_PASS_PROMPT}`);
          }
          authStep = 1;
          return send(`334 ${B64_USER_PROMPT}`);
        }
        case 'MAIL':
          message = { from: line.replace(/^MAIL\s+FROM:\s*/i, '').trim(), to: [], body: '' };
          return send('250 OK');
        case 'RCPT':
          if (!message) return send('503 Need MAIL FROM first');
          message.to.push(line.replace(/^RCPT\s+TO:\s*/i, '').trim());
          return send('250 OK');
        case 'DATA':
          if (!message) return send('503 Need MAIL FROM first');
          inData = true;
          return send('354 End data with <CR><LF>.<CR><LF>');
        case 'RSET':
          message = null;
          inData = false;
          return send('250 OK');
        case 'NOOP':
          return send('250 OK');
        case 'QUIT':
          send('221 Bye');
          return sock.end();
        default:
          return send('502 Command not implemented');
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  const stop = () => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

  return { port, messages, stop };
}

/** The environment a test server needs in order to hand its mail to the stub. */
function stubSmtpEnv(port) {
  return {
    EMAIL_HOST: '127.0.0.1',
    EMAIL_PORT: String(port),
    EMAIL_SECURE: 'false',
    // Both are required just to reach the transporter at all (utils/email.js:120);
    // the stub accepts any credential because it replies 235 to the LOGIN dance.
    EMAIL_USER: 'stub@localhost',
    EMAIL_PASSWORD: 'stub-password-not-a-secret',
    EMAIL_FROM_ADDRESS: 'Suppliwise Tests <stub@localhost>',
  };
}

module.exports = { startStubSmtp, stubSmtpEnv };
