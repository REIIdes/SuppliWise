# Recovery Phone & SMS Second Factor

Phone-number recovery and an optional SMS second factor, added on top of the
existing authenticator / passkey / recovery-email system.

SMS is a **fallback**, never a replacement. Every other factor an account has
keeps working, and nothing about the flow can leave someone locked out.

---

## What it does

| Surface | Endpoint | Notes |
|---|---|---|
| Recovery phone — add | `POST /api/security/recovery-phone/request` | Step-up required |
| Recovery phone — confirm | `POST /api/security/recovery-phone/verify` | |
| Recovery phone — remove | `DELETE /api/security/recovery-phone` | Step-up required |
| Recovery phone — allow as 2nd factor | `PATCH /api/security/recovery-phone/second-factor` | Step-up required |
| Summary | `GET /api/security/summary` | → `recoveryPhone` |
| Password recovery — request | `POST /api/auth/password-reset/phone-code` | Unauthenticated, answers generically |
| Password recovery — redeem | `POST /api/auth/password-reset/phone` | |
| Capability report | `GET /api/auth/password-reset/capabilities` | → `{ recoveryMethods: { sms, passkey } }` |
| Sign-in — request code | `POST /api/auth/send-login-sms` | Requires a live MFA transaction |
| Sign-in — redeem | `POST /api/auth/verify-login-sms` | |

## Configuration

Everything is off until a provider is configured, and with none configured the
whole feature is invisible — no buttons, no errors, and every existing flow
behaves exactly as before.

```env
# server/.env  (git-ignored — never commit the key)
SMS_PROVIDER=textbee
TEXTBEE_API_KEY=your_textbee_api_key_here
# Optional, only when the account has more than one gateway device:
TEXTBEE_DEVICE_ID=
```

Supported transports: `textbee`, `twilio`, `webhook`, `console`. Leaving
`SMS_PROVIDER` empty infers it from whichever credentials are present.

**Twilio is not available in the deployment's country**, which is why TextBee is
the configured provider. The Twilio transport is still implemented and still
works; it is simply not the one in use.

### Providers

- **TextBee** — sends from an Android phone registered on your TextBee account.
- **Twilio** — classic aggregator. Implemented, not configured.
- **webhook** — `POST {to, body, purpose}` to your own relay.
- **console** — prints messages instead of sending. Refuses to run in
  production (`index.js` throws at boot for `ALLOW_DEV_SMS_RESPONSE=true` or
  `SMS_PROVIDER=console`).

## ⚠ Before this works: register a TextBee device

TextBee sends **through an Android phone on your account**. The API key alone is
not enough — a device must be registered in the TextBee dashboard and paired via
the app, or every send returns `400 No enabled device to send from`.

A 200 from the API means *the gateway accepted the message*, **not** that a
handset received it. `utils/sms.js` treats two cases as **failures** rather than
successes, so the UI never tells a user a code is on its way when it is not:

- `SMS_PERMISSION_MISSING` — the gateway phone has no SMS permission
- a non-zero `failureCount`

If the gateway phone is offline, messages queue silently. That is a real
dependency for anything as sensitive as a login code.

## Security model

**A verified number is never sufficient by itself.**

- `sms-otp` is appended to a second factor the account already has. The guard is
  `phoneSecondFactor && methods.length > 0` in `utils/mfaTransaction.js`, so
  "never the only way in" is structural rather than a convention — a dropped
  text costs a wasted minute, never an account.
- A phone number is **inert until verified** (`phoneNumberVerifiedAt`), so
  someone who edits a profile cannot redirect recovery.
- Standing second-factor use carries its **own opt-in**
  (`phoneNumberAsSecondFactor`), separate from having a number. Recovery is
  used when access is already lost; this opens every ordinary sign-in.
- Numbers must be **E.164 with an explicit `+`**. A national number is refused
  rather than guessed at — guessing sends codes to strangers at our expense.
- `send-login-sms` requires a live MFA transaction, so it cannot be reached
  without the password. Sending is a paid side effect.
- Shared cooldown with the emailed code: alternating methods does not double
  the messages an account can trigger.
- Numbers and message bodies are masked in every log line.
- Removal clears the second-factor opt-in too, so no flag survives pointing at
  a number that is gone.

**Anti-enumeration.** Unknown account, no number, unverified number, wrong code,
expired code and locked account all return **one** status and **one** message.
`requestPhoneCode` is generic for the same reason `/request` is.

## Why SMS is the weakest factor

The codes are generated and stored exactly like every other code here — CSPRNG,
HMAC digest at rest, five attempts, single use. The weakness is the **last hop**:
a text is relayed through a carrier, onto a SIM that can be swapped, is readable
by anyone near the handset, and is silently dropped by carrier filtering without
either end noticing. None of that is true of an email, a TOTP seed or a passkey
key. The UI says so rather than letting "Verified" imply parity.

## Files

```
server/utils/phoneNumber.js          E.164 normalisation, validation, masking
server/utils/sms.js                  pluggable transports + shared eligibility
server/utils/passwordRecovery.js     requestPhoneCode, withPhoneCode
server/routes/security.js            manage the number; summary projection
server/routes/passwordReset.js       /phone-code, /phone, /capabilities
server/routes/auth.js                /send-login-sms, /verify-login-sms
server/utils/mfaTransaction.js       sms-otp in the allowlist + methodsFor
server/models/User.js                phoneNumber, phoneNumberVerifiedAt,
                                     phoneNumberAsSecondFactor
```

Client: `api.js`, `RecoveryPanel.jsx` (RecoveryPhoneCard),
`ProfileSecurityControls.jsx`, `ForgotPassword.jsx`, `LogIn.jsx`.

## Tests

```
server/Test File/sms-and-phone.test.js        numbers, transports, eligibility
server/Test File/mfa-sms-fallback.test.js     the "never the only way in" invariant
server/Test File/otp-context-contract.test.js the store-key/HMAC-context contract
```