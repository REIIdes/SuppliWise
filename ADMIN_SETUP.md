# SuppliWise Admin Access

Admin access is intentionally separate from normal user accounts. Admin credentials are not stored in MongoDB and are never accepted by the normal email login route.

## Configure the server

Add these values to `server/.env`:

```env
ADMIN_ALIAS=AdminDevs
ADMIN_PASSWORD_HASH=$2b$10$replace_with_a_bcrypt_hash
ADMIN_TOTP_SECRET=replace_with_a_base32_authenticator_secret
```

This workspace is already configured locally with the example alias `AdminDevs` and password `Devs101`. Change that password before using the app outside local development. The generated TOTP secret is in `server/.env`; add it to an authenticator app before signing in.

Additional local aliases are configured: `AdminJoma` / `Joma123`, `AdminPoli` / `Poli123`, `AdminJohn` / `John123`, and `AdminShMa` / `ShMa123`. Each account has its own TOTP secret in `ADMIN_ACCOUNTS`; add each secret to the appropriate authenticator app.

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

Passwords remain one-way bcrypt hashes. They cannot be decrypted or displayed; password reset is the correct recovery operation.
