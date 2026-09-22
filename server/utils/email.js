const nodemailer = require('nodemailer');

// Create reusable transporter
let transporter = null;

const getTransporter = () => {
  if (!transporter) {
    // Check if email is configured
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.error('[Email] Email service is not configured.');
      return null;
    }

    try {
      transporter = nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE || 'gmail',
        // Pooled connections: reuse the SMTP session instead of a full
        // TLS handshake per OTP (major send-latency win on repeated logins)
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
        auth: {
          user: process.env.EMAIL_USER,
          pass: String(process.env.EMAIL_PASSWORD).replace(/\s+/g, ''),
        },
      });

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
 * @param {string} type - 'email-change' or 'login'
 * @returns {Promise<boolean>} - Success status
 */
const sendOtpEmail = async (toEmail, otp, type = 'email-change') => {
  try {
    const transport = getTransporter();
    
    if (!transport) {
      return false;
    }

    const fromName = process.env.EMAIL_FROM_NAME || 'SuppliWise';
    const fromAddress = process.env.EMAIL_FROM_ADDRESS || process.env.EMAIL_USER;

    // Configure content based on type
    const isLogin = type === 'login';
    const isPasswordReset = type === 'password-reset';
    
    let subject, title, subtitle, bodyText, securityText;
    
    if (isPasswordReset) {
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
      to: toEmail,
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
                          <span style="color: #111827; font-size: 36px; font-weight: 700; letter-spacing: 8px; font-family: 'Courier New', monospace;">${otp}</span>
                        </div>
                        <p style="color: #166534; font-size: 13px; margin: 12px 0 0;">This code will expire in <strong>10 minutes</strong></p>
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

This code will expire in 10 minutes.

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
    console.log(`[Email] Verification email sent successfully to ${toEmail}`);
    return true;
  } catch (error) {
    transporter = null;
    console.error('[Email] Failed to send OTP email:', error.message);
    return false;
  }
};

module.exports = {
  sendOtpEmail,
  sendStatusEmail,
  sendAdminCredentialsEmail,
  // Verifies SMTP credentials at startup so a bad app-password shows up in
  // the server log immediately instead of as mysterious login failures.
  verifyEmailConfig,
};

// New-administrator credential delivery: alias + initial password + TOTP
// setup secret. Sent once per admin by an operator script — never from any
// public route. Returns true on sent, false otherwise (never throws).
async function sendAdminCredentialsEmail(toEmail, { alias, password, totpSecret } = {}) {
  try {
    const clean = String(toEmail || '').trim().slice(0, 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return false;
    if (!alias || !password || !totpSecret) return false;
    const transport = getTransporter();
    if (!transport) return false;

    const fromName = process.env.EMAIL_FROM_NAME || 'SuppliWise';
    const fromAddress = process.env.EMAIL_FROM_ADDRESS || process.env.EMAIL_USER;
    const year = new Date().getFullYear();

    await transport.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: clean,
      subject: 'Your SuppliWise administrator access',
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Administrator access</title></head>
        <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#f0faf0;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0faf0;padding:40px 20px;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
                <tr><td style="background:linear-gradient(135deg,#065f46,#059669);padding:36px 30px;text-align:center;">
                  <h1 style="color:white;font-size:24px;font-weight:700;margin:0;">SuppliWise Administrator Access</h1>
                  <p style="color:rgba(255,255,255,0.9);font-size:15px;margin:8px 0 0;">Sign in at <strong>/admin/login</strong></p>
                </td></tr>
                <tr><td style="padding:36px 30px;">
                  <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 16px;">Hi ${String(alias).replace(/[<>&"]/g, '')},</p>
                  <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 16px;">Your administrator account is ready. Use these credentials to sign in:</p>
                  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin:0 0 16px;">
                    <p style="color:#065f46;font-size:14px;margin:0 0 6px;"><strong>Alias:</strong> ${String(alias).replace(/[<>&"]/g, '')}</p>
                    <p style="color:#065f46;font-size:14px;margin:0 0 6px;"><strong>Password:</strong> ${String(password).replace(/[<>&"]/g, '')}</p>
                    <p style="color:#065f46;font-size:14px;margin:0;"><strong>Authenticator key:</strong> ${String(totpSecret).replace(/[<>&"]/g, '')}</p>
                  </div>
                  <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Add the authenticator key to Google Authenticator (<strong>Enter setup key</strong>, time-based), then sign in with your alias, password, and the 6-digit code.</p>
                  <div style="background:#eff6ff;border-left:4px solid #3b82f6;padding:16px;border-radius:4px;margin:0 0 16px;">
                    <p style="color:#1e40af;font-size:14px;line-height:1.5;margin:0;"><strong>🔒 Security:</strong> change your password after first sign-in, and never share these credentials. If you did not expect this email, contact the system owner immediately.</p>
                  </div>
                  <p style="color:#6b7280;font-size:14px;margin:0;">Best regards,<br><strong style="color:#22c55e;">The SuppliWise Team</strong></p>
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
      text: `SuppliWise Administrator Access\n\nHi ${alias},\n\nAlias: ${alias}\nPassword: ${password}\nAuthenticator key: ${totpSecret}\n\nSign in at /admin/login. Add the key to Google Authenticator (Enter setup key, time-based).\n\nPlease change your password after first sign-in and never share these credentials.`,
    });
    console.log(`[Email] Admin credentials sent to ${clean}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send admin credentials:', error.message);
    return false;
  }
}

// Account-status emails: lockout / back-online / banned / reactivated.
// Best-effort and non-blocking — callers fire-and-forget; failures only log.
// Returns true on sent, false otherwise (never throws).
async function sendStatusEmail(toEmail, kind, context = {}) {
  try {
    const clean = String(toEmail || '').trim().slice(0, 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return false;
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
    console.log(`[Email] Status email (${kind}) sent to ${clean}`);
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
