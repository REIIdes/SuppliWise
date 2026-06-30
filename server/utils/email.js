const nodemailer = require('nodemailer');

// Create reusable transporter
let transporter = null;

const getTransporter = () => {
  if (!transporter) {
    // Check if email is configured
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.warn('[Email] Email service not configured. OTP will only be logged to console.');
      return null;
    }

    try {
      transporter = nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE || 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD,
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
    
    // If email not configured, just log to console (development fallback)
    if (!transport) {
      console.log(`[Email/Dev] OTP for ${toEmail}: ${otp}`);
      return true;
    }

    const fromName = process.env.EMAIL_FROM_NAME || 'SuppliWise';
    const fromAddress = process.env.EMAIL_FROM_ADDRESS || process.env.EMAIL_USER;

    // Configure content based on type
    const isLogin = type === 'login';
    const subject = isLogin 
      ? 'Your Login Verification Code - SuppliWise'
      : 'Verify Your Email Change - SuppliWise';
    
    const title = isLogin ? 'Login Verification' : 'Verify Your Email';
    const subtitle = isLogin ? 'SuppliWise Login Security' : 'SuppliWise Email Verification';
    
    const bodyText = isLogin
      ? 'You are attempting to sign in to your SuppliWise account. To complete your login, please use the verification code below:'
      : 'You requested to change your email address on SuppliWise. To complete this process, please use the verification code below:';
    
    const securityText = isLogin
      ? "If you didn't attempt to log in, please secure your account immediately by changing your password."
      : "If you didn't request this change, you can safely ignore this email. Your account remains secure.";

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
                          ${isLogin 
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
    console.log(`[Email] OTP sent successfully to ${toEmail}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send OTP email:', error.message);
    // Log to console as fallback
    console.log(`[Email/Fallback] OTP for ${toEmail}: ${otp}`);
    return false;
  }
};

module.exports = {
  sendOtpEmail,
};
