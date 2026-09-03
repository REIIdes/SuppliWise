# Security Fix: OTP Leakage and JWT Secret Hardening

## Summary
A security regression was identified in the authentication flow. OTP values were being exposed in both API responses and server logs during development, and the app accepted a default insecure JWT secret value.

## Root cause
In the authentication routes, the login and password-reset flows included OTPs in the JSON response when `NODE_ENV === 'development'`.

The email fallback logger also printed OTP values directly to the console, and the server startup path allowed the default placeholder `JWT_SECRET` value to remain in production-like environments.

## Fix applied
- Removed OTP values from all authentication JSON responses.
- Removed OTP values from console logging and fallback email logging.
- Added a startup guard to fail fast when `JWT_SECRET` is missing or still using the default placeholder.
- Updated the example environment file to use a safe placeholder for developers.
- Added a regression test to prevent the OTP leak from returning.

## Files updated
- `server/routes/auth.js`
- `server/utils/email.js`
- `server/index.js`
- `server/.env.example`
- `server/tests/auth-security.test.js`

## Verification
I validated the fix with a targeted regression test:

- Command: `cd c:\Users\Devs\Desktop\SuppliWise\server ; node --test tests/auth-security.test.js --test-reporter=spec`
- Result: 1 test passed, 0 failed.

I also ran a JavaScript syntax check for the server entry points:

- Command: `cd c:\Users\Devs\Desktop\SuppliWise\server ; node --check index.js && node --check routes/auth.js && node --check utils/email.js`
- Result: no syntax errors.

## Recommended follow-up
- Set a strong random JWT secret in the live environment.
- Keep email sending enabled only with valid provider credentials.
- Do not log OTPs or authentication data in production logs.
