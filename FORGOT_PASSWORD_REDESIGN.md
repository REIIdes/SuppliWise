# Password reset — the link-based flow

Replaces the 6-digit-code-in-a-modal flow. Supersedes `FORGOT_PASSWORD_FEATURE.md`,
which described the previous design.

## The flow

```
/forgot-password          enter your email
   ↓  POST /api/auth/password-reset/request
   →  emailed link  ──────► /reset-password?token=…
   ↓  GET  /api/auth/password-reset/validate?token=…      (is the link alive?)
   ↓  POST /api/auth/password-reset/complete               (set the password)
   →  done — every signed-in device has been signed out
```

Three screens in the API's view, two in the browser's.

## Why it changed

### It was a modal, and the flow ends in a link

The old reset was a three-step modal inside `LogIn.jsx`. But the user finished
it by clicking a link in an email — usually in a new tab, sometimes hours after
starting. A modal only exists while its component is mounted, so the link had
nowhere to land: a cold load of the URL gave a blank or login screen, and Back
walked out of the flow while it silently kept its state. Two pages with their
own addresses is the shape this problem actually has.

### The codes lived in memory and died on a restart

`routes/auth.js` held reset codes in a module-level `Map` with a comment
admitting "in production, use Redis or database". A nodemon reload, a deploy or a
second process destroyed every outstanding code, and the user with the email open
was told *"No password reset request found"* — with nothing they could do and no
way to tell it wasn't their fault.

Grants are now MongoDB documents (`models/PasswordResetToken.js`), storing only
SHA-256 digests, with a TTL index so nothing needs sweeping.

### The response revealed who had an account

`/forgot-password` returned a `userId` only for real accounts, directly beside a
message insisting it revealed nothing. That is a free account-existence oracle.

Now every request gets a **byte-identical** response: a real account, an unknown
address, and a mail outage all answer `200` with the same body. The outage is
logged loudly for the operator; the user is told to check their inbox and resend.

That last one is a deliberate trade. The old route answered `503` when delivery
failed and `200` when the address had no account — the same oracle in a
different hat. Reporting our own outage honestly would leak the same thing, so it
is reported to the log and the resend button is the user's recovery path.

### A typo'd password burned the link

The grant is now claimed only *after* the new password passes validation, so a
rejected password leaves the user able to try again. Claiming is a single
atomic update conditional on `usedAt: null`, so two simultaneous redemptions of
one link cannot both win.

### A 6-digit code is not a credential

A 6-digit code is ~20 bits, so it is a *fallback*, not the flow: the same email
carries a 256-bit link and the code, for someone reading their mail on another
device or using a client that strips links. The code path is attempt-capped
(5 strikes, then the grant is burned) and rate-limited per account.

## The password rules

**10 characters minimum, 128 maximum, at least one uppercase, one lowercase, one
number and one symbol. Not your current password. Not guessable.**

Length does the work; the class rules raise the cost of the guesses people
actually make and give a concrete target instead of "be stronger".

`Password123!` satisfies every one of those rules, so the obvious
floor-satisfiers are refused too: a blocklist, key runs (`123456`, `abcdef`),
repeated characters, and passwords built from the account's own address.

**One policy, defined once** in `server/utils/passwordRules.js` and used by
`/register`, `/change-password` and the reset flow. Those were three
hand-written copies of four numbers that had already drifted — `/register`
capped length at 128 and the other two did not, so a reset would hand an
unbounded string to argon2.

The client renders its live checklist from `GET /api/auth/password-reset/rules`
over the wire, so what the user is shown is what the server enforces. A bundled
fallback in `my-react-app/src/utils/passwordPolicy.js` covers a failed fetch, and
`Test File/password-policy-agreement.test.js` fails if the two ever diverge.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/password-reset/rules` | The policy, for the checklist |
| `POST` | `/api/auth/password-reset/request` | Ask for a link. Always `200`. |
| `GET` | `/api/auth/password-reset/validate?token=` | Is this link alive? |
| `POST` | `/api/auth/password-reset/complete` | Redeem it, set the password |

Limits: 10 requests / 15 min per IP for `request`; 40 / 15 min for `complete`;
60s between emails per account; at most 3 live links per account. The link is
read from the **body** on `complete` — a query string lands in access logs,
history and `Referer` headers, and this is a credential.

## The old endpoints still work

`/forgot-password`, `/resend-password-reset-otp`, `/verify-password-reset-otp`
and `/reset-password` are kept as thin aliases onto the same service, so a
stale PWA build or a long-open tab can still finish a reset instead of hitting a
404. They are not stubs: each reaches the same MongoDB grant, the same email and
the same policy, so the two paths cannot drift apart. `verify-password-reset-otp`
returns a short-lived, purpose-scoped grant so a client that dropped the code can
finish.

## Configuration

`PUBLIC_WEB_URL` is the origin the emailed link points at. Required in
production — the server refuses to boot without it, because an unset value builds
links for `localhost` and every reset email a real user receives is a dead end.

In development it falls back to the request's `Origin` header, then to
`http://localhost:5173`. **The `Origin` header is ignored in production**: it is
attacker-controlled, and a hostile origin there would rewrite the link in a real
user's inbox so the token went to whoever chose it.

## On success

1. Password written and hashed with argon2id by the pre-save hook.
2. **Every session revoked** — a reset is the owner proving they recovered from a
   compromise, so any token an intruder holds has to stop working.
3. **All other live links invalidated**, so a link requested *before* this one
   cannot be used afterwards.
4. Confirmation email, in-app notification, and a security-audit event.

## Tests

| File | Covers |
| --- | --- |
| `Test File/password-reset.test.js` | The flow against stubs: persistence, the identical response, single use, atomic claim, link survival, cooldown, code fallback, legacy aliases, bad input |
| `Test File/password-reset-db.test.js` | The same against a real database: TTL index, unique digest, `select: false`, the argon2id hash on disk. Skips itself when no MongoDB is reachable |
| `Test File/password-policy-agreement.test.js` | Server policy vs the client fallback, rule by rule |
| `my-react-app/src/utils/passwordPolicy.test.js` | The checklist and the strength meter |

`Test File/stubQuery.js` and `Test File/withResetRouter.js` are the shared
harness. See `stubQuery.js` for why a bare object as a model stub is a trap.
