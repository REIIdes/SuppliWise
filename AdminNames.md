# SuppliWise Admin Names

> **This file must never contain live credentials.**
>
> A previous revision of this document listed the real base32 TOTP seeds for
> every admin account, and it was committed to a **public** repository. Those
> seeds must be treated as compromised: rotate all of them (Admin Profile →
> authenticator rotation flow, or replace `ADMIN_ACCOUNTS` in `server/.env`)
> and purge them from git history.

## Accounts

| Admin name | TOTP secret | Authenticator setup |
|---|---|---|
| `AdminDevs` | *(stored in `server/.env` → `ADMIN_TOTP_SECRET`)* | Add as a SuppliWise admin account in Google Authenticator |
| `AdminJoma` | *(stored in `server/.env` → `ADMIN_ACCOUNTS`)* | Add as a SuppliWise admin account in Google Authenticator |
| `AdminPoli` | *(stored in `server/.env` → `ADMIN_ACCOUNTS`)* | Add as a SuppliWise admin account in Google Authenticator |
| `AdminJohn` | *(stored in `server/.env` → `ADMIN_ACCOUNTS`)* | Add as a SuppliWise admin account in Google Authenticator |
| `AdminShMa` | *(stored in `server/.env` → `ADMIN_ACCOUNTS`)* | Add as a SuppliWise admin account in Google Authenticator |
| `AdminRaNe` | *(stored in `server/.env` → `ADMIN_ACCOUNTS`)* | Add as a SuppliWise admin account in Google Authenticator |

## Manual setup

In Google Authenticator, choose **Add account**, choose **Enter setup key**,
use the admin name as the account label, and read the TOTP secret from your
secret manager (or from `server/.env` on the server itself). Use
**Time-based** authentication.

Never copy a live secret into a tracked file, a document, a ticket, or a
screenshot. Generate new secrets with:

```powershell
node -e "console.log(require('speakeasy').generateSecret({length: 20}).base32)"
```

If a key is regenerated, it must also be written to the server configuration
(or rotated through the Admin Profile authenticator rotation flow),
otherwise login verification will fail.
