const nodemailer = require('nodemailer');

/**
 * How long an emailed code stays valid, as told to the user in the mail itself.
 *
 * MUST equal OTP_TTL_MS in routes/auth.js. That one governs enforcement; this
 * one governs what the recipient is told. They were both `10` before, and the
 * enforcement value has just been reduced to 5 minutes — so if this had been left
 * at 10, the mail would make a claim the server does not honour, and a user who
 * read it would wait out a timer that had already expired the code.
 *
 * Exported so the test suite can assert the two agree rather than trusting a
 * comment to keep them aligned.
 */
const OTP_TTL_MINUTES = 5;

// Logs land in shared stdout/log files, so recipients are never written out
// in full: keeps the local part's first character plus the domain so an
// incident stays diagnosable without persisting PII.
function maskEmail(value) {
  const email = String(value || '').trim();
  const at = email.indexOf('@');
  if (at <= 0) return '[redacted]';
  return `${email[0]}***@${email.slice(at + 1)}`;
}

/**
 * Escape a value for interpolation into the HTML bodies below.
 *
 * The older senders strip `< > & "` out of the values they interpolate, which
 * mangles a name into something unreadable but does block tag injection. This
 * escapes instead, so a value survives the round trip intact — which matters
 * most for the emailed OTP, the one value in these templates that a recipient
 * has to read back character-for-character.
 *
 * `'` is escaped too even though none of these templates use single-quoted
 * attributes, because a future template that does would otherwise be a stored
 * XSS in an email client.
 */
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

// Create reusable transporter
let transporter = null;

/**
 * Drop the cached transporter, actually CLOSING it first.
 *
 * The error paths below used to do a bare `transporter = null`. That discards
 * the reference without closing anything, and this transporter is created with
 * `pool: true, maxConnections: 3` — so every failure left a live connection pool
 * (sockets, timers) attached to a process that had already forgotten about it.
 * Those pools are never garbage collected while their sockets are open.
 *
 * That is a slow resource leak in production, and it is also what made
 * `Test File/password-reset-db.test.js` hang FOREVER instead of exiting: the
 * suite reached the real `sendStatusEmail`, built a pooled transporter, and the
 * open pool kept the event loop alive after the last test. `npm test` only ever
 * exercised the skip path, so it was invisible.
 *
 * `close()` is safe to call on an unconnected transporter and never rejects, but
 * it is still guarded: a failure here must not mask the error that sent us down
 * this path in the first place.
 *
 * @returns {Promise<void>}
 */
async function closeTransporter() {
  const dying = transporter;
  transporter = null;
  if (!dying || typeof dying.close !== 'function') return;
  try {
    await dying.close();
  } catch {
    /* the original failure is the one worth reporting */
  }
}

/**
 * Reject a recipient that is not a single, well-formed address.
 *
 * Applied to every sender below, not only the ones that already did it.
 *
 * WHY
 * ---
 * `sendOtpEmail` was the one sender in this file that took its recipient
 * verbatim from the caller. The other five validate with a regex and cap the
 * length; this one did neither. Nodemailer builds the header from the value, so
 * a CRLF inside it is a header-injection primitive — an extra recipient, an
 * extra header, or a body the recipient never saw. Even with a library that
 * happens to sanitise, relying on that is how header injection gets reintroduced
 * after a dependency bump.
 *
 * CR/LF/NUL are rejected outright rather than stripped: no legitimate address
 * contains them, so there is no valid input to preserve.
 *
 * @returns {string|null} the trimmed address, or null if unusable.
 */
function safeRecipient(value) {
  const address = String(value == null ? '' : value).trim();
  if (!address || address.length > 254) return null;
  if (/[\r\n\0]/.test(address)) return null;
  // Exactly one address. A comma or angle bracket means the caller tried to
  // append a second recipient or smuggle a header, and none of these flows ever
  // need to send to more than one person.
  if (/[,<>]/.test(address)) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
  return address;
}

const getTransporter = () => {
  if (!transporter) {
    // Check if email is configured
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.error('[Email] Email service is not configured.');
      return null;
    }

    try {
      const common = {
        // Pooled connections: reuse the SMTP session instead of a full
        // TLS handshake per OTP (major send-latency win on repeated logins)
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
        // Certificate validation is nodemailer's default, but it is stated
        // explicitly rather than inherited. `rejectUnauthorized: false` is the
        // single most common SMTP misconfiguration — it turns up in a hundred
        // "fix self-signed cert" threads — and making the secure value the
        // explicit one means a later edit has to type the insecure one to turn
        // it off.
        tls: { rejectUnauthorized: true },
        auth: {
          user: process.env.EMAIL_USER,
          pass: String(process.env.EMAIL_PASSWORD).replace(/\s+/g, ''),
        },
      };

      // Explicit SMTP endpoint (self-hosted relay, Mailpit/Mailhog for local
      // dev, or a capture server in the auth stress suite). When set, it wins
      // over the EMAIL_SERVICE preset — a `service` preset would otherwise
      // overwrite host/port with the provider's well-known values.
      const host = String(process.env.EMAIL_HOST || '').trim();
      const secure = String(process.env.EMAIL_SECURE || '').trim().toLowerCase() === 'true';
      const options = host
        ? {
            ...common,
            host,
            port: Number.parseInt(process.env.EMAIL_PORT, 10) || 587,
            secure,
            // DOWNGRADE PROTECTION.
            //
            // With `secure: false` (the default for port 587) nodemailer uses
            // STARTTLS *if the server advertises it*, and silently proceeds in
            // cleartext when it does not. An active network attacker who strips
            // the STARTTLS capability advertisement from the server's greeting
            // downgrades the connection without either endpoint noticing — and
            // the SMTP AUTH credentials plus every OTP in flight then cross the
            // network in the clear.
            //
            // `requireTLS` makes that downgrade a hard connection failure. In
            // production a relay that cannot do STARTTLS is a misconfiguration
            // to fix, not something to work around silently. It stays off in
            // development so Mailpit/Mailhog on plain localhost still works.
            requireTLS: !secure && process.env.NODE_ENV === 'production',
          }
        : { ...common, service: process.env.EMAIL_SERVICE || 'gmail' };

      transporter = nodemailer.createTransport(options);

      console.log('[Email] Email service configured successfully');
    } catch (error) {
      console.error('[Email] Failed to create transporter:', error.message);
      return null;
    }
  }
  return transporter;
};

/**
 * Send OTP email for email verification or login
 * @param {string} toEmail - Recipient email address
 * @param {string} otp - 6-digit OTP code
 * @param {string} type - 'email-change' | 'login' | 'password-reset' | 'recovery'
 * @returns {Promise<boolean>} - Success status
 */
const sendOtpEmail = async (toEmail, otp, type = 'email-change') => {
  try {
    const transport = getTransporter();

    if (!transport) {
      return false;
    }

    // Validated here, at the boundary, rather than trusted from the caller. This
    // was the one sender that did not validate its recipient, and it is the most
    // exposed of them: the address arrives from a request body on the email-change
    // and recovery-email routes. See safeRecipient.
    const recipient = safeRecipient(toEmail);
    if (!recipient) return false;

    // Interpolated into the HTML body. The code is generated from
    // crypto.randomInt and is therefore always six digits, but it is escaped
    // like any other interpolated value so a future change to the generator
    // cannot silently turn this into an injection point.
    const safeOtp = escapeHtml(String(otp == null ? '' : otp));

    const fromName = process.env.EMAIL_FROM_NAME || 'SuppliWise';
    const fromAddress = process.env.EMAIL_FROM_ADDRESS || process.env.EMAIL_USER;

    // Configure content based on type
    const isLogin = type === 'login';
    const isPasswordReset = type === 'password-reset';
    // Recovery-email confirmation. Deliberately worded so the recipient knows
    // they are being added as a backup contact and that it does not grant
    // access on its own.
    const isRecovery = type === 'recovery';
    
    let subject, title, subtitle, bodyText, securityText;
    
    if (isRecovery) {
      subject = 'Confirm Your Recovery Email - SuppliWise';
      title = 'Confirm Recovery Email';
      subtitle = 'SuppliWise Account Security';
      bodyText = 'You asked to use this address as a recovery email on your SuppliWise account. Use the verification code below to confirm it:';
      securityText = "This address is only used to warn you about activity on your account. It cannot be used to sign in. If you didn't request this, ignore this email and change your password.";
    } else if (isPasswordReset) {
      subject = 'Password Reset Verification Code - SuppliWise';
      title = 'Reset Your Password';
      subtitle = 'SuppliWise Password Recovery';
      bodyText = 'You requested to reset your password for your SuppliWise account. To complete this process, please use the verification code below:';
      securityText = "If you didn't request a password reset, please secure your account immediately by changing your password or contacting support.";
    } else if (isLogin) {
      subject = 'Your Login Verification Code - SuppliWise';
      title = 'Login Verification';
      subtitle = 'SuppliWise Login Security';
      bodyText = 'You are attempting to sign in to your SuppliWise account. To complete your login, please use the verification code below:';
      securityText = "If you didn't attempt to log in, please secure your account immediately by changing your password.";
    } else {
      subject = 'Verify Your Email Change - SuppliWise';
      title = 'Verify Your Email';
      subtitle = 'SuppliWise Email Verification';
      bodyText = 'You requested to change your email address on SuppliWise. To complete this process, please use the verification code below:';
      securityText = "If you didn't request this change, you can safely ignore this email. Your account remains secure.";
    }

    const mailOptions = {
      from: `"${fromName}" <${fromAddress}>`,
      to: recipient,
      subject: subject,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${title}</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f0faf0;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f0faf0; padding: 40px 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);">
                  
                  <!-- Header -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); padding: 40px 30px; text-align: center;">
                      <div style="width: 60px; height: 60px; background: rgba(255, 255, 255, 0.2); border: 3px solid white; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
                        <svg width="32" height="32" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <rect width="100" height="100" rx="22" fill="white"/>
                          ${isPasswordReset 
                            ? '<g transform="translate(25, 25)"><rect x="15" y="20" width="20" height="30" rx="3" fill="none" stroke="#22c55e" stroke-width="4"/><circle cx="25" cy="15" r="12" fill="none" stroke="#22c55e" stroke-width="4"/><line x1="22" y1="30" x2="28" y2="30" stroke="#22c55e" stroke-width="4" stroke-linecap="round"/><line x1="25" y1="30" x2="25" y2="35" stroke="#22c55e" stroke-width="4" stroke-linecap="round"/></g>'
                            : isLogin 
                            ? '<g transform="translate(30, 30)"><circle cx="20" cy="15" r="10" fill="#22c55e"/><path d="M 5 40 Q 5 25 20 25 Q 35 25 35 40 L 5 40 Z" fill="#22c55e"/></g>'
                            : '<g transform="rotate(-40, 50, 50)"><rect x="22" y="36" width="56" height="28" rx="14" fill="none" stroke="#22c55e" stroke-width="6"/><line x1="50" y1="36" x2="50" y2="64" stroke="#22c55e" stroke-width="6"/></g>'
                          }
                        </svg>
                      </div>
                      <h1 style="color: white; font-size: 28px; font-weight: 700; margin: 0;">${title}</h1>
                      <p style="color: rgba(255, 255, 255, 0.9); font-size: 16px; margin: 8px 0 0;">${subtitle}</p>
                    </td>
                  </tr>
                  
                  <!-- Body -->
                  <tr>
                    <td style="padding: 40px 30px;">
                      <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 24px;">Hi there,</p>
                      
                      <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 24px;">
                        ${bodyText}
                      </p>
                      
                      <!-- OTP Box -->
                      <div style="background: #f0fdf4; border: 2px solid #bbf7d0; border-radius: 12px; padding: 24px; text-align: center; margin: 0 0 24px;">
                        <p style="color: #166534; font-size: 14px; font-weight: 600; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
                        <div style="background: white; border: 2px solid #22c55e; border-radius: 8px; padding: 16px; display: inline-block;">
                          <span style="color: #111827; font-size: 36px; font-weight: 700; letter-spacing: 8px; font-family: 'Courier New', monospace;">${safeOtp}</span>
                        </div>
                        <p style="color: #166534; font-size: 13px; margin: 12px 0 0;">This code will expire in <strong>${OTP_TTL_MINUTES} minutes</strong></p>
                      </div>
                      
                      <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 24px;">
                        ${securityText}
                      </p>
                      
                      <!-- Security Notice -->
                      <div style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 16px; border-radius: 4px; margin: 0 0 24px;">
                        <p style="color: #1e40af; font-size: 14px; line-height: 1.5; margin: 0;">
                          <strong>🔒 Security Tip:</strong> Never share this code with anyone. SuppliWise staff will never ask for your verification code.
                        </p>
                      </div>
                      
                      <p style="color: #6b7280; font-size: 14px; line-height: 1.6; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #22c55e;">The SuppliWise Team</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f9fafb; padding: 24px 30px; text-align: center; border-top: 1px solid #e5e7eb;">
                      <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin: 0 0 8px;">
                        This is an automated message from SuppliWise.
                      </p>
                      <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                        © ${new Date().getFullYear()} SuppliWise. All rights reserved.
                      </p>
                    </td>
                  </tr>
                  
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
      text: `
SuppliWise - ${title}

Hi there,

${bodyText}

VERIFICATION CODE: ${otp}

This code will expire in ${OTP_TTL_MINUTES} minutes.

${securityText}

Security Tip: Never share this code with anyone. SuppliWise staff will never ask for your verification code.

Best regards,
The SuppliWise Team

---
This is an automated message from SuppliWise.
© ${new Date().getFullYear()} SuppliWise. All rights reserved.
      `,
    };

    await transport.sendMail(mailOptions);
    console.log(`[Email] Verification email sent successfully to ${maskEmail(recipient)}`);
    return true;
  } catch (error) {
    // Close, don't just forget — see closeTransporter(). Dropping the reference
    // on its own leaked the whole connection pool on every send failure.
    await closeTransporter();
    console.error('[Email] Failed to send OTP email:', error.message);
    return false;
  }
};

/**
 * Password-reset LINK — the primary recovery credential.
 *
 * The 6-digit `code` is a secondary path in the same mail: some people read
 * their email on one device while resetting on another, some clients strip
 * links, and some screen readers only surface the text. The button is the
 * action; the code is the fallback, and the wording says so rather than making
 * the reader choose between two things that look equally required.
 *
 * Returns true on sent, false otherwise — never throws.
 */
async function sendPasswordResetEmail(toEmail, { resetUrl, code, expiresInMinutes = 30 } = {}) {
  try {
    const clean = safeRecipient(toEmail);
    const link = String(resetUrl || '').trim();
    if (!clean) return false;
    // Refuse to send a "reset your password" mail with no working link: that
    // would be a credential-shaped email that helps nobody.
    if (!/^https?:\/\//i.test(link)) return false;

    const transport = getTransporter();
    if (!transport) return false;

    const fromName = process.env.EMAIL_FROM_NAME || 'SuppliWise';
    const fromAddress = process.env.EMAIL_FROM_ADDRESS || process.env.EMAIL_USER;
    const minutes = Math.max(1, Math.ceil(Number(expiresInMinutes) || 30));
    const safeLink = link.replace(/"/g, '%22');
    const year = new Date().getFullYear();

    await transport.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: clean,
      subject: 'Reset your SuppliWise password',
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Reset your password</title></head>
        <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#f0faf0;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0faf0;padding:40px 20px;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
                <tr>
                  <td style="background:linear-gradient(135deg,#22c55e 0%,#16a34a 100%);padding:36px 30px;text-align:center;">
                    <div style="width:56px;height:56px;background:rgba(255,255,255,0.2);border:3px solid #ffffff;border-radius:50%;display:inline-block;margin-bottom:14px;line-height:56px;">
                      <svg width="28" height="28" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;">
                        <g transform="translate(25, 25)"><rect x="15" y="20" width="20" height="30" rx="3" fill="none" stroke="#22c55e" stroke-width="4"/><circle cx="25" cy="15" r="12" fill="none" stroke="#22c55e" stroke-width="4"/><line x1="22" y1="30" x2="28" y2="30" stroke="#22c55e" stroke-width="4" stroke-linecap="round"/><line x1="25" y1="30" x2="25" y2="35" stroke="#22c55e" stroke-width="4" stroke-linecap="round"/></g>
                      </svg>
                    </div>
                    <h1 style="color:#ffffff;font-size:26px;font-weight:700;margin:0;">Reset your password</h1>
                    <p style="color:rgba(255,255,255,0.9);font-size:15px;margin:8px 0 0;">SuppliWise account recovery</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:36px 30px;">
                    <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 20px;">Hi there,</p>
                    <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 28px;">
                      We received a request to reset the password on your SuppliWise account.
                      Press the button below to choose a new one. This link works once and expires in
                      <strong>${minutes} minutes</strong>.
                    </p>
                    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                      <tr><td align="center">
                        <a href="${safeLink}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 32px;border-radius:10px;">Choose a new password</a>
                      </td></tr>
                    </table>
                    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 28px;word-break:break-all;">
                      If the button does not work, open this address:<br>
                      <a href="${safeLink}" style="color:#16a34a;">${safeLink}</a>
                    </p>
                    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin:0 0 24px;">
                      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 10px;">
                        <strong>Opening this on a different device?</strong> Use this ${String(code).length}-digit code on the reset screen instead:
                      </p>
                      <div style="background:#ffffff;border:2px solid #22c55e;border-radius:8px;padding:12px;text-align:center;">
                        <span style="color:#111827;font-size:32px;font-weight:700;letter-spacing:8px;font-family:'Courier New',monospace;">${code}</span>
                      </div>
                    </div>
                    <div style="background:#fef2f2;border-left:4px solid #dc2626;padding:16px;border-radius:4px;margin:0 0 24px;">
                      <p style="color:#991b1b;font-size:14px;line-height:1.6;margin:0;">
                        <strong>Did not request this?</strong> Nothing has changed and you can ignore this email.
                        To be safe, reset your password anyway — and note that SuppliWise staff will never
                        ask you for a reset link or a verification code.
                      </p>
                    </div>
                    <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0;">Best regards,<br><strong style="color:#22c55e;">The SuppliWise Team</strong></p>
                  </td>
                </tr>
                <tr>
                  <td style="background:#f9fafb;padding:20px 30px;text-align:center;border-top:1px solid #e5e7eb;">
                    <p style="color:#6b7280;font-size:13px;line-height:1.5;margin:0 0 6px;">This is an automated message from SuppliWise.</p>
                    <p style="color:#9ca3af;font-size:12px;margin:0;">© ${year} SuppliWise. All rights reserved.</p>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>`,
      text: `Reset your SuppliWise password

We received a request to reset the password on your SuppliWise account.
Open this link to choose a new one. It works once and expires in ${minutes} minutes:

${link}

Opening this on a different device? Use this code on the reset screen instead:

    ${code}

Did not request this? Nothing has changed and you can ignore this email. To be
safe, reset your password anyway. SuppliWise staff will never ask you for a
reset link or a verification code.

Best regards,
The SuppliWise Team`,
    });
    console.log(`[Email] Password reset link sent to ${maskEmail(clean)}`);
    return true;
  } catch (error) {
    // Close, don't just forget — see closeTransporter(). Dropping the reference
    // on its own leaked the whole connection pool on every send failure.
    await closeTransporter();
    console.error('[Email] Failed to send password reset link:', error.message);
    return false;
  }
}

/**
 * "Your password was changed" — the confirmation both the reset flow and the
 * signed-in change-password route send. Named wrapper so neither caller has to
 * know the preset name, and so a third caller can't typo it into a silent no-op
 * (sendStatusEmail returns false for an unknown `kind` without complaining).
 */
async function sendPasswordChangedEmail(toEmail) {
  return sendStatusEmail(toEmail, 'password-changed', {});
}

module.exports = {
  sendOtpEmail,
  // The TTL the mail TELLS the user about. Exported so a test can assert it
  // equals the TTL routes/auth.js actually enforces, instead of trusting two
  // independent constants to stay in agreement.
  OTP_TTL_MINUTES,
  sendStatusEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  // Verifies SMTP credentials at startup so a bad app-password shows up in
  // the server log immediately instead of as mysterious login failures.
  verifyEmailConfig,
  // Closes the pooled transporter. Exported so a graceful shutdown and the test
  // suites can release the socket pool — an unclosed pool keeps the Node event
  // loop alive forever.
  closeTransporter,
};

// Account-status emails: lockout / back-online / banned / reactivated.
// Best-effort and non-blocking — callers fire-and-forget; failures only log.
// Returns true on sent, false otherwise (never throws).
async function sendStatusEmail(toEmail, kind, context = {}) {
  try {
    const clean = safeRecipient(toEmail);
    if (!clean) return false;
    const transport = getTransporter();
    if (!transport) return false;

    const fromName = process.env.EMAIL_FROM_NAME || 'SuppliWise';
    const fromAddress = process.env.EMAIL_FROM_ADDRESS || process.env.EMAIL_USER;
    const minutes = Math.max(1, Math.ceil(Number(context.minutes) || 15));
    const year = new Date().getFullYear();

    const presets = {
      lockout: {
        subject: 'Sign-in temporarily paused — SuppliWise',
        title: 'Sign-in Temporarily Paused',
        subtitle: 'SuppliWise Account Security',
        accent: '#dc2626',
        body: `Too many failed sign-in attempts were detected on your account, so sign-in was temporarily paused for ~${minutes} minute(s) to protect you. The pause lifts automatically — please wait and try again.`,
        advice: "If this wasn't you, please change your password once you're back in.",
      },
      'back-online': {
        subject: "You're back online — SuppliWise",
        title: "You're Back Online",
        subtitle: 'SuppliWise Account Security',
        accent: '#16a34a',
        body: 'Good news — the temporary sign-in pause on your account has been lifted and you can sign in again right now.',
        advice: "If you didn't expect this pause, please review your recent activity and change your password.",
      },
      banned: {
        subject: 'Your SuppliWise account has been restricted',
        title: 'Account Restricted',
        subtitle: 'SuppliWise Account Notice',
        accent: '#dc2626',
        body: 'An administrator has restricted your SuppliWise account. You cannot sign in while the restriction is in place.',
        advice: 'If you believe this is a mistake, please contact support.',
      },
      reactivated: {
        subject: 'Your SuppliWise account is active again',
        title: 'Account Active Again',
        subtitle: 'SuppliWise Account Notice',
        accent: '#16a34a',
        body: 'Good news — your SuppliWise account has been reactivated and you can sign in again right now.',
        advice: 'Thanks for your patience. Contact support if anything looks wrong.',
      },
      // A sign-in from a device we have not seen before. Wording is neutral on
      // purpose: an unfamiliar device is worth checking, but it is NOT evidence
      // of an attack, and accusing the user would be wrong as often as not.
      'new-device': {
        subject: 'New sign-in to your SuppliWise account',
        title: 'New Sign-In',
        subtitle: 'SuppliWise Account Security',
        accent: '#4f46e5',
        body: 'Your account was just signed into from a device we had not seen before. If this was you, no action is needed.',
        advice: "If you don't recognise this sign-in, change your password and sign out your other devices.",
      },
      'recovery-email': {
        subject: 'Your SuppliWise recovery email was changed',
        title: 'Recovery Email Changed',
        subtitle: 'SuppliWise Account Security',
        accent: '#d97706',
        body: `The recovery email on your account was set to ${context.address || 'a new address'}. It can only be used to warn you about account activity — never to sign in.`,
        advice: "If you didn't do this, change your password and contact support immediately.",
      },
      'security-change': {
        subject: 'A security setting on your SuppliWise account changed',
        title: 'Security Setting Changed',
        subtitle: 'SuppliWise Account Security',
        accent: '#d97706',
        body: `A security setting on your account was just changed: ${context.change || 'an update'}.`,
        advice: "If you didn't make this change, reset your password and contact support immediately.",
      },
      // Sent after a successful reset. This is the ONLY signal the account
      // owner gets that their credential changed: a reset is how someone
      // recovers from a compromise, so a silent reset is exactly the event
      // they most need to be told about — and the "if this wasn't you" line
      // is the first warning they'd otherwise never receive.
      'password-changed': {
        subject: 'Your SuppliWise password was changed',
        title: 'Password Changed',
        subtitle: 'SuppliWise Account Security',
        accent: '#16a34a',
        body: 'The password on your SuppliWise account was just changed, and every signed-in device has been signed out. You can sign in again with your new password.',
        advice: "If you didn't do this, reset your password again immediately and contact support.",
      },
    };
    const p = presets[kind];
    if (!p) return false;

    await transport.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: clean,
      subject: p.subject,
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${p.title}</title></head>
        <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#f0faf0;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0faf0;padding:40px 20px;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
                <tr><td style="background:${p.accent};padding:36px 30px;text-align:center;">
                  <h1 style="color:white;font-size:26px;font-weight:700;margin:0;">${p.title}</h1>
                  <p style="color:rgba(255,255,255,0.9);font-size:15px;margin:8px 0 0;">${p.subtitle}</p>
                </td></tr>
                <tr><td style="padding:36px 30px;">
                  <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 16px;">Hi there,</p>
                  <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 16px;">${p.body}</p>
                  <div style="background:#eff6ff;border-left:4px solid #3b82f6;padding:16px;border-radius:4px;margin:0 0 24px;">
                    <p style="color:#1e40af;font-size:14px;line-height:1.5;margin:0;"><strong>🔒 Security Tip:</strong> ${p.advice}</p>
                  </div>
                  <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0;">Best regards,<br><strong style="color:#22c55e;">The SuppliWise Team</strong></p>
                </td></tr>
                <tr><td style="background:#f9fafb;padding:20px 30px;text-align:center;border-top:1px solid #e5e7eb;">
                  <p style="color:#6b7280;font-size:13px;margin:0 0 6px;">This is an automated message from SuppliWise.</p>
                  <p style="color:#9ca3af;font-size:12px;margin:0;">© ${year} SuppliWise. All rights reserved.</p>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>`,
      text: `SuppliWise - ${p.title}\n\nHi there,\n\n${p.body}\n\n${p.advice}\n\nBest regards,\nThe SuppliWise Team`,
    });
    console.log(`[Email] Status email (${kind}) sent to ${maskEmail(clean)}`);
    return true;
  } catch (error) {
    console.error(`[Email] Failed to send ${kind} email:`, error.message);
    return false;
  }
}

async function verifyEmailConfig() {
  const transport = getTransporter();
  if (!transport) return false;
  try {
    await transport.verify();
    console.log('[Email] SMTP connection verified — OTP delivery ready');
    return true;
  } catch (error) {
    console.error('[Email] SMTP verification failed:', error.message);
    return false;
  }
}