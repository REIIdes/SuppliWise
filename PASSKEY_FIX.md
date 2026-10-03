# Passkey Configuration Fix

## Problem
Yung passkey feature hindi gumagana kasi kulang yung WebAuthn configuration sa `.env` file.

## Solution
Added the following WebAuthn configuration to `server/.env`:

```env
# WebAuthn / Passkey Configuration
WEBAUTHN_RP_NAME=SuppliWise
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=http://localhost:5173,http://localhost:5174,http://localhost:5175,http://127.0.0.1:5173
WEBAUTHN_TIMEOUT_MS=120000

# CORS / Trusted Origins
WEB_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174,http://localhost:5175,http://127.0.0.1:5173
PUBLIC_WEB_URL=http://localhost:5173
```

## What These Variables Do

1. **WEBAUTHN_RP_NAME** - Human-readable name shown sa authenticator ("SuppliWise")
2. **WEBAUTHN_RP_ID** - Domain scope ng passkey (localhost for development)
3. **WEBAUTHN_ORIGIN** - Allowed origins para sa WebAuthn ceremony
4. **WEBAUTHN_TIMEOUT_MS** - How long browser waits for user (120 seconds)
5. **WEB_ALLOWED_ORIGINS** - Allowed origins for CORS with credentials
6. **PUBLIC_WEB_URL** - Base URL ng app para sa email links

## For Production
Pag production na, kailangan mo i-update:
- `WEBAUTHN_RP_ID` to your actual domain (e.g., `app.suppliwise.com`)
- `WEBAUTHN_ORIGIN` to your HTTPS URLs (e.g., `https://app.suppliwise.com`)
- `WEB_ALLOWED_ORIGINS` same as WEBAUTHN_ORIGIN
- `PUBLIC_WEB_URL` to your public URL

## TOTP Encryption Key (Optional but Recommended)
For added security, generate a TOTP encryption key:
```bash
openssl rand -base64 32
```
Then add to `.env`:
```env
TOTP_ENCRYPTION_KEY=<generated_key>
```

## Next Steps
1. Restart your server para ma-load ang new configuration
2. Try mag-register ng passkey sa sign-in page
3. Test passkey sign-in

## Notes
- In development, if TOTP_ENCRYPTION_KEY is not set, it will derive from JWT_SECRET (which is okay for dev)
- The passkey feature uses WebAuthn/FIDO2 standard
- Supported browsers: Chrome, Edge, Safari, Firefox
- Works with Touch ID, Windows Hello, security keys, etc.
