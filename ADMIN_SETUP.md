# SuppliWise Admin Access

Admin access is intentionally separate from normal user accounts. Admin credentials are not stored in MongoDB and are never accepted by the normal email login route.

## Configure the server

Add these values to `server/.env`:

```env
ADMIN_ALIAS=AdminDevs
ADMIN_PASSWORD_HASH=$2b$10$replace_with_a_bcrypt_hash
ADMIN_TOTP_SECRET=replace_with_a_base32_authenticator_secret
```

Admin passwords are **never** written down in documents. The workspace is
already configured locally — read the alias, the bcrypt/argon2id hash and the
TOTP secret from `server/.env` (gitignored) or from your password manager.
Add each TOTP secret to the appropriate authenticator app before signing in.

> **Incident note:** this file previously listed six admin passwords in
> plaintext and was committed to a public repository. Those passwords must be
> considered compromised — change every one of them, and rotate the matching
> TOTP secrets. Store new values only in `server/.env` and a password manager.

Generate a password hash from the `server` directory:

```powershell
node -e "require('bcryptjs').hash('use-a-long-unique-password', 12).then(console.log)"
```

Generate a TOTP secret from the `server` directory:

```powershell
node -e "console.log(require('speakeasy').generateSecret({length: 20}).base32)"
```

Add the generated TOTP secret to an authenticator app. Do not commit `server/.env` or share the password, hash, or TOTP secret.

## Sign in

Open `/admin/login`, enter the alias and password, then enter the current authenticator code. The dashboard API accepts only a JWT with the server-issued `admin` role. A user JWT cannot access `/api/admin`.

## Included controls

- System overview: user, assessment, subscription, AI configuration, and security status.
- User operations: search accounts, creation and last-login metadata, 2FA state, and subscription toggling.
- AI management: configured provider/model visibility and optional health endpoint latency checks.
- Admin profile: view the active alias and change its password after verifying the current password and Google Authenticator code.
- Security center: JWT, MFA, bcrypt, email OTP, and production safeguard checks.
- Security report: browser-generated PDF with STRIDE/OWASP-oriented control results.

Passwords remain one-way argon2id hashes (legacy bcrypt accepted, auto-upgraded on next sign-in). They cannot be decrypted or displayed; password reset is the correct recovery operation.
