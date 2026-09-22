# SuppliWise Admin Names and TOTP Keys

> **Sensitive file:** These TOTP keys provide administrator access. Do not commit, upload, or share this file. Store it in a secure password manager and delete this local copy when no longer needed.

The entries below match the active admin configuration in `server/.env`.

| Admin name | TOTP secret | Authenticator setup |
|---|---|---|
| `AdminDevs` | `LN5T652PIVISUXSXKFFXWKCEIN6XKTBPJZIFWXTNMVOVAOD3PFKA` | Add as a SuppliWise admin account in Google Authenticator |
| `AdminJoma` | `OVVXWNR2K5KXIXL5IRZUEPSKIFFFKPDX` | Add as a SuppliWise admin account in Google Authenticator |
| `AdminPoli` | `MRKCGSJKOBSTGYK6FQUV2V3SOBGCQVCJ` | Add as a SuppliWise admin account in Google Authenticator |
| `AdminJohn` | `LJXUEQ3TN5TTQWBVGZMEIXLJH4RWMYZF` | Add as a SuppliWise admin account in Google Authenticator |
| `AdminShMa` | `NFWFEL26EERWCQTVJVRX2JRYENDSKQCQ` | Add as a SuppliWise admin account in Google Authenticator |
| `AdminRaNe` | `SGQ5ZASCMJRYYXPOC53A` | Add as a SuppliWise admin account in Google Authenticator |

## Manual setup

In Google Authenticator, choose **Add account**, choose **Enter setup key**, use the admin name as the account label, and enter the matching TOTP secret. Use **Time-based** authentication.

Do not regenerate or replace a key in this document alone. The key must also be changed in the server configuration or through the Admin Profile authenticator rotation flow, otherwise login verification will fail.
