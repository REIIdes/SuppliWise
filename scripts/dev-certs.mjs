#!/usr/bin/env node
/**
 * Generate the local HTTPS certificate SuppliWise runs on in development.
 *
 * WHY A SCRIPT AND NOT A COMMITTED CERTIFICATE
 * --------------------------------------------
 * A certificate is only useful if the machine presenting it is trusted, and
 * trust lives in the operating system's certificate store — not in this
 * repository. So the certificate cannot be committed: it would be either
 * useless (expired, or issued for someone else's host) or actively harmful (a
 * private key that every other machine would also hold). It has to be minted on
 * each machine, by that machine, and thrown away with the machine.
 *
 * mkcert is the tool for this. It creates a local certificate authority,
 * installs THAT into the OS trust store, and issues leaf certificates signed by
 * it. Browsers and Node both honour the store, so https://localhost stops
 * producing a certificate warning — which is the whole reason this exists.
 * A plain self-signed certificate cannot do that: browsers and Node refuse
 * untrusted certificates outright, and `fetch()` to one fails rather than
 * warning, so an https app pointing at an untrusted API is an app that does
 * not work.
 *
 * WHAT IT WRITES
 *   certs/localhost.pem         leaf certificate  (gitignored: *.pem)
 *   certs/localhost-key.pem     leaf private key  (gitignored: *.key)
 *   certs/rootCA.pem            the local CA, for programs that verify manually
 *
 *   plus, when the Android project is present:
 *   my-react-app/android/app/src/debug/res/raw/mkcert_rootca.pem
 *
 * The Android copy is there because an app on a real phone has to trust the
 * same CA as the machine that issued the certificate. Without it, an HTTPS
 * backend on your LAN works in the browser and fails in the app with
 * ERR_CERT_AUTHORITY_INVALID, and the two disagreeing is a genuinely baffling
 * thing to debug.
 *
 * It goes into `src/debug/` on purpose. Android compiles `src/debug/res` only
 * into a debug build, so a release APK cannot contain a trust anchor for a
 * certificate authority that exists on one developer's laptop. The debug
 * network_security_config.xml is in `src/debug/` for the same reason.
 *
 * HOSTS
 *   localhost, 127.0.0.1, ::1 and every non-internal IPv4 address on this
 *   machine. The LAN address is what makes the phone-on-Wi-Fi case work: the
 *   browser reaches https://192.168.x.x:5000 and the certificate has to be
 *   valid for that address, not just for localhost.
 *
 * REQUIREMENTS
 *   mkcert on PATH  (winget install FiloSottile.mkcert, or choco install mkcert)
 *
 * USAGE
 *   node scripts/dev-certs.mjs              generate or refresh the certificate
 *   node scripts/dev-certs.mjs --check      report status, change nothing
 *   node scripts/dev-certs.mjs --copy-ca    copy the CA to the Desktop, so a
 *                                           phone can be made to trust it
 */

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = join(ROOT, 'certs');
const CERT_FILE = join(CERT_DIR, 'localhost.pem');
const KEY_FILE = join(CERT_DIR, 'localhost-key.pem');
const CA_FILE = join(CERT_DIR, 'rootCA.pem');
// `src/debug/`, never `src/main/`: Android only compiles this into a debug
// build, so a release APK cannot ship a trust anchor for a dev certificate
// authority. See the note above.
const ANDROID_RAW = join(ROOT, 'my-react-app', 'android', 'app', 'src', 'debug', 'res', 'raw');

const MIN_DAYS_LEFT = 30;

/** True when a usable certificate already exists on disk. */
function readExisting() {
  if (!existsSync(CERT_FILE) || !existsSync(KEY_FILE)) return null;
  return { cert: CERT_FILE, key: KEY_FILE };
}

/**
 * How many days the current certificate has left, or null when it cannot be
 * read. Used so a certificate that is about to expire is refreshed quietly
 * rather than producing an expiry warning in the middle of a work session.
 */
function daysRemaining() {
  try {
    // Node parses the certificate itself rather than shelling out to openssl,
    // which is not installed on every machine that runs this repo (it is not
    // on a stock Windows box, and this script is how such a box gets a usable
    // certificate in the first place — depending on openssl here would be
    // circular).
    const cert = new X509Certificate(readFileSync(CERT_FILE));
    const expiry = new Date(cert.validTo);
    if (Number.isNaN(expiry.getTime())) return null;
    return Math.floor((expiry.getTime() - Date.now()) / 86_400_000);
  } catch {
    return null;
  }
}

/** Non-internal IPv4 addresses, so a phone on the LAN can be reached over https. */
function lanAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      found.push(entry.address);
    }
  }
  return [...new Set(found)];
}

function hasMkcert() {
  try {
    execFileSync('mkcert', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function caroot() {
  return execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim();
}

function usage() {
  console.log([
    'HTTPS certificate status for SuppliWise',
    '',
    `  certificate : ${CERT_FILE}`,
    `  private key : ${KEY_FILE}`,
    `  local CA    : ${CA_FILE}`,
    existsSync(CERT_FILE)
      ? `  expires     : ${daysRemaining() === null ? 'unknown' : `${daysRemaining()} day(s) from now`}`
      : '  expires     : no certificate',
    '',
    'Run `node scripts/dev-certs.mjs` to create or refresh it.',
  ].join('\n'));
}

/**
 * Copy the CA somewhere the user can get at it — for installing on a phone that
 * has to trust the same authority.
 *
 * A separate flag rather than a line in the usage output because this is the one
 * operation that puts a file somewhere a human will find: the desktop, named
 * obviously. Nobody should have to know that mkcert's CAROOT is where it lives
 * in order to install a certificate authority on their phone.
 */
async function copyCaForPhone() {
  if (!hasMkcert()) {
    console.error('mkcert is not on PATH, so there is no CA to copy. Run `npm run certs` first.');
    process.exitCode = 1;
    return;
  }
  const source = join(caroot(), 'rootCA.pem');
  if (!existsSync(source)) {
    console.error('No local CA exists yet. Run `npm run certs` first.');
    process.exitCode = 1;
    return;
  }

  // Deliberately a .crt: Android's "install certificate" flow, and iOS, both
  // filter on the extension, and a .pem lands in a folder the user cannot see.
  // The content is identical — the extension is the only difference.
  const target = join(homedir(), 'Desktop', 'suppliwise-dev-ca.crt');
  copyFileSync(source, target);

  console.log([
    `CA copied to:\n  ${target}`,
    '',
    'To install it on a phone (needed for the Android app or a browser on the LAN):',
    '  1. Transfer the file to the phone.',
    '  2. Settings -> Security -> Install from storage, and select it.',
    '  3. Confirm the warning. Android asks for a PIN to install a CA.',
    '',
    'It is a development certificate authority. It is trusted by nothing except',
    'this machine and any device you install it on. Remove it from the phone when',
    'you are done.',
  ].join('\n'));
}

async function main() {
  if (process.argv.includes('--check')) {
    usage();
    return;
  }
  if (process.argv.includes('--copy-ca')) {
    await copyCaForPhone();
    return;
  }

  if (!hasMkcert()) {
    console.error([
      'mkcert is not on PATH, so no trusted certificate can be made.',
      '',
      '  winget install FiloSottile.mkcert',
      '  choco install mkcert',
      '',
      'Then run this script again. A certificate cannot be committed instead:',
      'trust lives in the OS certificate store, on this machine only.',
    ].join('\n'));
    process.exitCode = 1;
    return;
  }

  const hosts = ['localhost', '127.0.0.1', '::1', ...lanAddresses()];
  mkdirSync(CERT_DIR, { recursive: true });

  // Idempotent: installing the CA again on a machine that already has it is a
  // no-op, so this is safe to run on every fresh clone.
  execFileSync('mkcert', ['-install'], { stdio: 'inherit' });
  execFileSync('mkcert', [
    '-cert-file', CERT_FILE,
    '-key-file', KEY_FILE,
    ...hosts,
  ], { stdio: 'inherit' });

  // mkcert writes 0600 on Unix; on Windows the ACL is what matters and
  // chmodSync is a no-op, but calling it keeps the intent explicit.
  try {
    chmodSync(KEY_FILE, 0o600);
  } catch {
    /* not supported on this platform; the OS ACL already restricts it */
  }

  const caSource = join(caroot(), 'rootCA.pem');
  if (existsSync(caSource)) copyFileSync(caSource, CA_FILE);

  // The Android app trusts the same CA, so it needs a copy inside the APK's
  // resources. Copied rather than referenced because it has to be inside the
  // app; the source of truth stays in mkcert's own store.
  if (existsSync(dirname(ANDROID_RAW))) {
    mkdirSync(ANDROID_RAW, { recursive: true });
    copyFileSync(caSource, join(ANDROID_RAW, 'mkcert_rootca.pem'));
    console.log(`  Android trust anchor -> ${join(ANDROID_RAW, 'mkcert_rootca.pem')}`);
  }

  writeFileSync(
    join(CERT_DIR, 'README.txt'),
    [
      'Generated by scripts/dev-certs.mjs — do not commit these files.',
      '',
      'localhost.pem / localhost-key.pem  the certificate the dev servers use',
      'rootCA.pem                         the local certificate authority',
      '',
      'Trusted because `mkcert -install` put the authority in this machine\'s',
      'certificate store. Remove the authority with `mkcert -uninstall` and',
      'regenerate with `node scripts/dev-certs.mjs`.',
      '',
      'These are valid for development on localhost and this machine\'s own LAN',
      'address only. They are not valid for any real domain and must never be',
      'used in a deployment.',
      '',
    ].join('\n'),
  );

  console.log(usage());
}

main().catch((error) => {
  console.error(`Failed to create the development certificate: ${error.message}`);
  process.exitCode = 1;
});