// Builds the deployment environment for the Docker stack:
//
//   deploy/.env         -> mounted read-only at /app/.env inside the API container
//                          and read by the app's own loader (server/utils/envFile.js).
//                          NOT passed through Compose: Compose interpolates `$name`
//                          and `$NAME` inside env_file contents, which shredded every
//                          argon2 hash in ADMIN_ACCOUNTS (1220 chars in, 657 out).
//   deploy/.env.caddy   -> PUBLIC_HOSTNAME + DUCKDNS_TOKEN for Caddy. Deliberately
//                          free of `$`, because this one does go through Compose.
//   deploy/.env.duckdns -> SUBDOMAINS + TOKEN for the A-record updater.
//
// Usage (this script prints names and lengths, never values):
//   node deploy/make-container-env.cjs --origin=https://mysuppli.duckdns.org
//   node deploy/make-container-env.cjs --origin=https://mysuppli.duckdns.org:8443 \
//        --sub=mysuppli --token=xxxxxxxx
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY = __dirname;
const DEMO_DB = 'suppliwise_demo_pub1';

const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z]+)=(.*)$/.exec(a);
  if (m) args[m[1]] = m[2];
}

const origin = (args.origin || 'http://192.168.1.7:8080').replace(/\/+$/, '');
const parsed = new URL(origin);
const hostname = parsed.hostname;
const isSecure = parsed.protocol === 'https:';
// A non-standard port is part of the Caddy site address, so it belongs there
// rather than being configured in a second place.
const siteAddress = parsed.port ? `${hostname}:${parsed.port}` : hostname;
// This machine's LAN address, so devices on the home Wi-Fi can reach the stack
// directly when the router has no NAT loopback. Override with --lan=<ip>.
const LAN_HOST = args.lan || '192.168.1.7';

const readEnvFile = (file) => {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([^=]+)=(.*)$/.exec(line);
    if (m) map.set(m[1].trim(), m[2]);
  }
  return map;
};

const source = readEnvFile(path.join(ROOT, 'server', '.env'));
for (const required of ['MONGO_URI', 'PORT', 'TLS_ENABLED']) {
  if (!source.has(required)) throw new Error(`${required} is missing from server/.env`);
}

const swapDb = (uri, dbName = DEMO_DB) => {
  const [basePart, ...rest] = uri.split('?');
  const query = rest.length ? '?' + rest.join('?') : '';
  const at = basePart.indexOf('@');
  const authority = at >= 0 ? basePart.slice(at + 1) : basePart;
  const slash = authority.indexOf('/');
  if (slash < 0) return `${basePart}/${DEMO_DB}${query}`;
  const tail = authority.slice(slash + 1);
  return tail
    ? `${basePart.slice(0, basePart.length - tail.length)}${DEMO_DB}${query}`
    : `${basePart}${DEMO_DB}${query}`;
};

// Carried over from an existing deploy/.env when there is one. The demo database
// now holds argon2/TOTP envelopes written under that key (the AdminAccount model
// encrypts totpSecret on save), so minting a fresh key here would silently make
// every stored seed undecryptable — the admin 2FA panel would fail and no boot
// log would say why. A fresh key is only correct for the very first run.
const existingEnv = readEnvFile(path.join(DEPLOY, '.env'));
const totpKey = existingEnv.get('TOTP_ENCRYPTION_KEY') || crypto.randomBytes(32).toString('base64');

// The key this app used BEFORE an explicit one existed. In development
// TOTP_ENCRYPTION_KEY is unset, so server/utils/secretBox.js derived the write
// key from JWT_SECRET (HKDF-SHA256, info "suppliwise/totp/v1") and sealed every
// 2FA seed with it. Those envelopes carry that key's own fingerprint, so under
// this deployment's explicit key they will not open — and secretBox.decrypt
// answers `null` rather than throwing. routes/auth.js then reads that as "no
// usable authenticator", so Google Authenticator silently vanishes from sign-in
// and an emailed code is demanded instead.
//
// Declaring the legacy key as a decrypt-only predecessor makes those seeds
// readable again without undoing the rotation: new seals still use
// TOTP_ENCRYPTION_KEY, and a predecessor can never be used to write.
const HKDF_INFO = 'suppliwise/totp/v1';
const legacyTotpKey = (() => {
  const secret = String(source.get('JWT_SECRET') || '');
  if (!secret) return null;
  const key = Buffer.from(crypto.hkdfSync(
    'sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(HKDF_INFO, 'utf8'), 32,
  ));
  // Same fingerprint rule as secretBox.keyId: 8 bytes of SHA-256 over the key.
  return { material: key, id: crypto.createHash('sha256').update(key).digest('base64url').slice(0, 11) };
})();

const previousEntries = [
  ...(existingEnv.get('TOTP_ENCRYPTION_KEY_PREVIOUS') || source.get('TOTP_ENCRYPTION_KEY_PREVIOUS') || '').split(','),
  legacyTotpKey ? `${legacyTotpKey.id}=${legacyTotpKey.material.toString('base64')}` : '',
].map(s => s.trim()).filter(Boolean);
// Deduplicated by the key's own fingerprint, not by the written label, because
// loadKeys re-keys every entry by fingerprint anyway and a duplicated entry is
// harmless but noisy.
const seenIds = new Set();
const totpPrevious = previousEntries.filter(pair => {
  const at = pair.indexOf('=');
  if (at <= 0) return false;
  const kid = pair.slice(0, at);
  if (seenIds.has(kid)) return false;
  seenIds.add(kid);
  return true;
});

// The connection string in server/.env has no database segment, so the driver
// defaults to `test` — that is the live application data. `--db=<name>` selects a
// different one; `--db=default` leaves the URI exactly as configured.
//
// Only ONE API process may run against a given database at a time. The web3 ledger
// anchors per database name (server/uploads/.chain-head.<hash>.anchor), so a second
// writer on the same database forks the chain — and if `node index.js` is still
// running on port 5000 against `test`, that is exactly what pointing this container
// at `test` does.
const DB = args.db || DEMO_DB;
const targetUri = DB === 'default'
  ? source.get('MONGO_URI')
  : swapDb(source.get('MONGO_URI'), DB);

const overrides = {
  NODE_ENV: 'production',
  PORT: '5000',
  // Caddy terminates TLS. Inside the network everything is plain HTTP, which is
  // only allowed by server/utils/tls.js because TRUST_PROXY says a proxy sits in
  // front — the guard that otherwise refuses a plaintext production API.
  TLS_ENABLED: 'false',
  TLS_CERT_FILE: '',
  TLS_KEY_FILE: '',
  TRUST_PROXY: 'true',
  ALLOW_DEV_OTP_RESPONSE: 'false',
  MONGO_URI: targetUri,
  PUBLIC_WEB_URL: origin,
  // The deployed app is single-origin (nginx proxies /api), so nothing else ever
  // needs to be trusted. The localhost entry is the direct `web:8080` path used to
  // test without going through Caddy; the LAN-IP entry is what other devices on the
  // home Wi-Fi use, because most home gateways (PLDT included) have no NAT hairpin,
  // so the duckdns hostname is unreachable from inside the LAN. Without that entry
  // every write request from those devices was refused with
  // 403 {"message":"Request origin is not allowed."}
  WEB_ALLOWED_ORIGINS: `${origin},http://localhost:8080,http://${LAN_HOST}:8080`,
  WEBAUTHN_ORIGIN: origin,
  // An rpId is a DOMAIN: no scheme, no port. A duckdns.org subdomain is itself a
  // registrable domain, so the site's own host is a valid, correctly scoped
  // choice — passkeys minted here can never be presented to another site.
  WEBAUTHN_RP_ID: hostname,
  WEBAUTHN_RP_NAME: 'SuppliWise',
  // Carried over above rather than minted here: the demo database already holds
  // totpSecret envelopes written under the key in deploy/.env, and a fresh key
  // makes them undecryptable with no error at boot.
  TOTP_ENCRYPTION_KEY: totpKey,
  // Decrypt-only predecessors, derived above. Without this every account that
  // enrolled an authenticator in development loses Google Authenticator at
  // sign-in with no error anywhere — see the note above.
  TOTP_ENCRYPTION_KEY_PREVIOUS: totpPrevious.join(','),
  // The default auth ceiling (20 requests / 15 min per IP) is unreachable for a
  // demo hosted behind one home ISP address. Signing in is a multi-call flow —
  // captcha, login, then the mandatory OTP verify — and a verification failure
  // reloads the page and starts over. The first 429 does not just shed that
  // request: limitReachedHandler records an offense on the `ip:` bucket, and
  // lockoutCheck then hard-stops EVERY /api/auth route for that address,
  // correct password included, escalating 15 min -> 1 h -> 6 h -> 24 h. Every
  // device on the LAN shares one bucket, so one user's typos locked out the
  // whole household.
  //
  // Raising this ceiling costs no protection. Per-ACCOUNT lockout is
  // untouched: 3 consecutive wrong passwords still lock that account for 15
  // min and still climb the ladder, which is where the guess-a-password
  // defence actually lives. Volume is still bounded by the flood guard
  // (1200 req/min). Only the shared-network false positive is removed.
  AUTH_RATE_LIMIT_MAX: '200',
};

// The passkey guard in server/index.js refuses to boot production on a plain
// http origin. Saying so here beats reading a stack trace at 3 a.m.
if (!isSecure && overrides.NODE_ENV === 'production') {
  console.warn('WARNING: origin is not https — server/index.js will refuse to boot production because WEBAUTHN_ORIGIN must be https.');
}

const env = new Map(source);
for (const [k, v] of Object.entries(overrides)) env.set(k, v);

fs.writeFileSync(path.join(DEPLOY, '.env'), [
  '# GENERATED by deploy/make-container-env.cjs — gitignored (**/.env). Do not commit.',
  '# Mounted at /app/.env in the api container and read by server/utils/envFile.js.',
  '# Real OS environment still wins over anything set here.',
  '',
  ...[...env.entries()].map(([k, v]) => `${k}=${v}`),
  '',
].join('\n'));

// The DuckDNS token is stored once, in the updater's file, and copied into
// Caddy's environment because Caddy needs it to write the DNS-01 TXT record.
const duckFile = path.join(DEPLOY, '.env.duckdns');
let duck = readEnvFile(duckFile);
if (args.sub && args.token) {
  fs.writeFileSync(duckFile, [
    '# GENERATED — DuckDNS A-record updater. Gitignored. Do not commit.',
    `SUBDOMAINS=${args.sub}`,
    `TOKEN=${args.token}`,
    'LOG_FILE=false',
    'TZ=Asia/Manila',
    '',
  ].join('\n'));
  duck = readEnvFile(duckFile);
}

fs.writeFileSync(path.join(DEPLOY, '.env.caddy'), [
  '# GENERATED — Caddy environment. Gitignored. Do not commit.',
  '# Kept separate from deploy/.env because Compose interpolates `$name` inside',
  '# env_file contents. Nothing in this file may contain a dollar sign.',
  `PUBLIC_HOSTNAME=${siteAddress}`,
  `DUCKDNS_TOKEN=${duck.get('TOKEN') || ''}`,
  '',
].join('\n'));

console.log(JSON.stringify({
  apiEnvKeys: env.size,
  database: DB === 'default' ? 'test (driver default, no path in URI)' : DB,
  origin,
  caddySiteAddress: siteAddress,
  rpId: overrides.WEBAUTHN_RP_ID,
  jwtLength: (env.get('JWT_SECRET') || '').length,
  // The check that would have caught the Compose corruption before boot: these
  // must survive the round trip at full length.
  adminAccountsLength: (env.get('ADMIN_ACCOUNTS') || '').length,
  adminHashLength: (env.get('ADMIN_PASSWORD_HASH') || '').length,
  authRequestsPerIpPer15Min: overrides.AUTH_RATE_LIMIT_MAX,
  totpPreviousKeyIds: totpPrevious.map(p => p.split('=')[0]),
  duckdns: duck.size
    ? { subdomains: duck.get('SUBDOMAINS'), tokenLength: (duck.get('TOKEN') || '').length }
    : 'not configured — pass --sub=<name> --token=<token> or create deploy/.env.duckdns',
}, null, 2));
