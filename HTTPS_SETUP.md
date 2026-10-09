# HTTPS Setup

Both servers now run over HTTPS: the API on **https://localhost:5000**, the
frontend dev server on **https://localhost:5173**.

## One-time setup, per machine

```bash
npm run certs
```

That installs [mkcert](https://github.com/FiloSottile/mkcert) if you use
`winget`/`choco` (it will tell you), creates a local certificate authority, puts
**that authority into this machine's trust store**, and issues a certificate
covering `localhost`, `127.0.0.1`, `::1` and this machine's LAN address.

Check the result at any time:

```bash
npm run certs:check
```

## Why a local CA rather than a self-signed certificate

Browsers and Node **refuse** an untrusted certificate rather than warning about
it. `fetch()` to an untrusted HTTPS origin fails outright. So an HTTPS upgrade
built on a self-signed certificate produces a page that will not load a single
module — which is exactly why `@vitejs/plugin-basic-ssl` was previously
disabled in `vite.config.js` under the note "Causes Mixed Content errors with
HTTP backend". That note was really a trust note.

Trust lives in the operating system's certificate store, on one machine. That is
why the certificate cannot be committed: it would be useless everywhere else,
and the private key would be a key everyone can read. `certs/` is gitignored and
regenerated per machine.

To remove the development authority entirely:

```bash
mkcert -CAROOT        # where it lives
mkcert -uninstall     # remove it from the trust store
```

## Running it

```bash
# Terminal 1 — API
cd server
npm start

# Terminal 2 — frontend
cd my-react-app
npm run dev
```

Then open **https://localhost:5173** — no certificate warning, because the
authority is trusted.

Confirm both are actually on HTTPS. The first line of the API's startup output
is the thing to read:

```
Server running on https://localhost:5000
[tls] serving https (certificate ...\certs\localhost.pem)| hsts=max-age=300s
```

If either says `http://`, that one is not using TLS.

## Configuration

All of this is optional — with no `certs/` directory both servers start on plain
HTTP exactly as before, so a fresh clone works with no setup.

### Server (`server/.env`)

| Variable | Default | Meaning |
|---|---|---|
| `TLS_ENABLED` | `false` | `true` serves HTTPS on `PORT`. Anything else serves HTTP. |
| `TLS_KEY_FILE` | `certs/localhost-key.pem` | Private key (PEM). Absolute, or relative to the **repository root**. |
| `TLS_CERT_FILE` | `certs/localhost.pem` | Certificate (PEM). Same path rule. |
| `TLS_CA_FILE` | unset | Optional extra chain, for a deployment presenting more than its leaf. |
| `HSTS_MAX_AGE` | `300` | Seconds for `Strict-Transport-Security`. Digits only. |
| `PUBLIC_WEB_URL` | — | Must be `https://` when TLS is on; password-reset links point here. |

`TLS_ENABLED` is **opt-in** rather than "use the certificate if one is there"
for a specific reason: the test suite boots this same `index.js` as a child
process and talks to it over plain HTTP. Auto-detecting would flip the test
server to TLS mid-run and every suite would fail against a port that had
quietly stopped answering HTTP. `Test File/e2eServer.js` pins it off for that
reason.

### Frontend

`my-react-app/vite.config.js` picks the certificate up automatically when
`certs/` exists, and reads the API's scheme from `server/.env` so the dev proxy
cannot disagree with the server.

| Variable | Default | Meaning |
|---|---|---|
| `VITE_DEV_HTTPS` | `true` | `false` forces the dev server back to HTTP. |
| `VITE_API_URL` | derived | Overrides the API origin. Needed for the Android build. |
| `SERVE_HTTPS` | `true` | `false` makes `npm run serve:prod` serve plain HTTP. |

## The phone on your Wi-Fi

The certificate includes this machine's LAN address, so a phone reaching
`https://192.168.x.x:5000` gets a valid certificate — but the phone has to trust
the same authority, which `mkcert -install` put on **this** machine only.

So on the phone, in this order:

1. `npm run certs:copy-ca` and transfer the CA to the phone
2. install it (Settings → Security → Install from storage), OR
3. use the **Android app**, which bundles the CA itself (see below)

Emulator note: the Android emulator maps the host machine to `10.0.2.2`, which
the certificate does not cover. Either add it (`mkcert -cert-file … -key-file …
localhost 127.0.0.1 ::1 10.0.2.2 192.168.x.x`) or use the LAN address from the
host browser.

## The Android app

Cleartext is **off**. `androidScheme` is `https`, and
`network_security_config.xml` permits no cleartext at all, for any host.

What replaced it: a **debug-only** network security config
(`android/app/src/debug/res/xml/network_security_config.xml`) that trusts the
development CA, bundled into the APK by `npm run certs` from
`src/debug/res/raw/`. Android compiles `src/debug/` only into a debug build, so
a release APK cannot contain a trust anchor for an authority that exists on one
developer's laptop. `network_security_config.xml` in `src/main/` is
HTTPS-only with system trust anchors, and is what a release ships.

The previous config permitted cleartext to `localhost`, `10.0.2.2` and three
hard-coded `192.168.x.x` addresses. That was two problems: bearer tokens and OTP
codes crossing a shared network in the clear, and a host list unrelated to any
current network — so whether the app worked depended on which router the phone
had joined.

Build order matters: run `npm run certs` before building the debug APK, or the
raw CA resource is missing and the build fails. That is intentional; a build
that requires a machine-local certificate cannot silently produce an APK that
distrusts it.

The app also needs `VITE_API_URL` at build time, because it runs from the
phone's own local origin and `localhost` there means the phone:

```bash
# my-react-app/.env.production
VITE_API_URL=https://192.168.x.x:5000/api
```

## Node scripts and the probes

Node does not read the OS certificate store, so a script using `fetch` cannot
trust the development CA on its own. (`fetch` accepts no `ca` option, and
`NODE_EXTRA_CA_CERTS` is read once at startup, so setting it from inside a
script does nothing — both verified, not assumed.)

The probe scripts are wrapped for you:

```bash
npm run glitch-hunt --prefix server
npm run glitch-hunt:web3 --prefix server
npm run verify:bc-monitor --prefix server
npm run test:flows --prefix server
```

Anything else that talks to a live API over TLS:

```bash
cd server
node scripts/withDevCa.mjs your-probe.js
```

That adds `--use-system-ca` (or `NODE_EXTRA_CA_CERTS` on an older Node) and
leaves certificate verification **on**. It deliberately does not use
`NODE_TLS_REJECT_UNAUTHORIZED=0`, which would make a security probe pass against
a server presenting somebody else's certificate.

## HSTS, and why the default is short

HSTS is cached by the **browser**, on the **host**, for the whole `max-age` —
and a browser holding an entry for `localhost` will refuse to make a plain-HTTP
request to it at all. No warning, no click-through.

That makes a long `max-age` a trap in development:

1. run with `TLS_ENABLED=true` → the browser remembers `localhost` as HTTPS-only
2. debug something by setting `TLS_ENABLED=false`
3. `http://localhost:5000` is now dead, reporting "connection refused" and
   nothing mentioning HSTS — cleared only by hand in
   `chrome://net-internals/#hsts`

Five minutes keeps the protection HSTS actually provides (refusing a downgrade
within a session) and lets step 3 recover by itself. The development
certificate can be uninstalled and regenerated at any time, so a year-long HTTPS
commitment for `localhost` is a promise this setup cannot keep.

**In production, set `HSTS_MAX_AGE=31536000`.** A real certificate comes from
somewhere that will not disappear, and the long commitment is the right one.

## Production

A production process that serves plain HTTP with no proxy in front of it
**refuses to boot**. Either:

```bash
TLS_ENABLED=true
TLS_KEY_FILE=/etc/ssl/private/suppliwise.key
TLS_CERT_FILE=/etc/ssl/certs/suppliwise.crt
HSTS_MAX_AGE=31536000
```

…or, when a load balancer or reverse proxy terminates TLS ahead of the process:

```bash
TRUST_PROXY=true
```

With `TRUST_PROXY=true` Express takes the real client address from the
forwarded chain rather than the raw header, so rate limits, lockouts and
login-location evidence key on the actual client. Set it to `1`, not `true`, if
possible — one hop is the proxy itself, never the whole chain.

## Checking it works

With both servers running:

```bash
npm run smoke:https
```

This verifies the certificate, loads the app document and every module it
references, calls the API both through the proxy and directly, checks the
security headers and the CORS allowlist, and confirms the API port does **not**
also answer plain HTTP.

It exists because the three classic failures of an HTTPS migration are invisible
from the browser console and produce no server-side log line at all:

- an https page whose module graph fails to load renders a blank screen
- an https page reaching an http API is refused as mixed content *before* the
  request is sent, so every request fails while the server reports health
- a CORS allowlist that does not match the page origin fails only in the browser

## Troubleshooting

**Browser: "Your connection is not private"**
The authority is not in this machine's trust store. Re-run `npm run certs`.
Private/incognito windows sometimes ignore trust-store additions — use a normal
window to test.

**`SELF_SIGNED_CERT_IN_CHAIN` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE` from Node**
Node does not read the OS store. Run through `scripts/withDevCa.mjs`, or set
`NODE_OPTIONS=--use-system-ca`.

**Every request fails with no error in the console**
Almost always a scheme mismatch. An HTTPS page requesting an HTTP API is blocked
as mixed content before the request is sent. Check the two startup lines: both
servers must say `https`.

**`502 Bad Gateway` from the dev server**
The dev proxy is aimed at the wrong scheme for the API. It reads
`TLS_ENABLED` from `server/.env`; if you changed TLS in the running server's
environment only, restart the dev server too.

**`EADDRINUSE` on port 5000**
An older API process is still running. `taskkill /F /IM node.exe` stops
everything, then start both again.

**The dev server says HTTP when you expected HTTPS**
No `certs/` directory, or `VITE_DEV_HTTPS=false`. `npm run certs` fixes the
first; unset the second.

**Passkeys fail after switching schemes**
Passkeys are scoped to an origin. Credentials registered against
`http://localhost:5173` do not exist on `https://localhost:5173` — this is the
WebAuthn spec working correctly, not a bug. Re-register. The API's development
origins already list both schemes.