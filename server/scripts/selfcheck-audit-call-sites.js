/**
 * Does audit-call-sites.js actually detect the bug it claims to?
 *
 *   node scripts/selfcheck-audit-call-sites.js
 *
 * A scanner that finds nothing is indistinguishable from a scanner that cannot
 * look. This injects the exact historical bug into a scratch copy of the tree
 * and asserts the audit reports it — and then asserts the same tree WITHOUT the
 * bug is reported clean.
 *
 * Both directions are asserted. A scanner that always fails is as useless as one
 * that never does.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..');
const AUDIT = path.join(SERVER, 'scripts', 'audit-call-sites.js');

/** The bug exactly as it shipped: `email` dropped from the signature only. */
const BROKEN_SIGNATURE = 'function reportAccountLockout({ alias, userId, minutes, lockKey })';

function runAudit(root) {
  const args = root ? [AUDIT, root] : [AUDIT];
  try {
    const out = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

// Run the audit against a scratch tree so the real source is never edited.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'callsite-selfcheck-'));
const stamp = new Date().toISOString();
const results = [];

function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

try {
  // A miniature tree carrying the same defect, in miniature form.
  const scratchServer = path.join(scratch, 'server');
  fs.mkdirSync(scratchServer, { recursive: true });

  fs.writeFileSync(path.join(scratchServer, 'reporter.js'), `
function reportThing({ alias, userId, minutes }) {
  return { alias, userId, minutes };
}
module.exports = { reportThing };
`);
  fs.writeFileSync(path.join(scratchServer, 'caller.js'), `
const { reportThing } = require('./reporter');
function go() {
  reportThing({ email: 'a@b.c', minutes: 15 });
  reportThing({ alias: 'ops', minutes: 5 });
}
module.exports = { go };
`);

  const withBug = runAudit(scratchServer);
  check(
    'the audit reports a caller passing a field the callee does not bind',
    withBug.code !== 0 && /reportThing/.test(withBug.out) && /"email"/.test(withBug.out),
    `exit ${withBug.code}`,
  );
  check(
    'it names the file and the offending field',
    /caller\.js/.test(withBug.out) && /"email"/.test(withBug.out),
  );
  check(
    'it does not also flag the call that supplies only bound fields',
    !/FAIL[^\n]*"alias"/.test(withBug.out),
  );

  // Now the clean tree: same shapes, no defect.
  fs.writeFileSync(path.join(scratchServer, 'caller.js'), `
const { reportThing } = require('./reporter');
function go() {
  reportThing({ alias: 'ops', minutes: 5 });
}
module.exports = { go };
`);
  const clean = runAudit(scratchServer);
  check(
    'the same tree with no defect is reported clean',
    clean.code === 0 && /ok/.test(clean.out),
    `exit ${clean.code}`,
  );

  // The false positive this audit shipped with: `public` is a reserved word, so
  // `{ public: pub }` is the only way to write the field, and a caller passing
  // `public:` is correct. Found for real in blockchain/engine.js.
  fs.writeFileSync(path.join(scratchServer, 'reporter.js'), `
function renamed({ userId, amount, public: pub = null }) {
  return { userId, amount, pub };
}
module.exports = { renamed };
`);
  fs.writeFileSync(path.join(scratchServer, 'caller.js'), `
const { renamed } = require('./reporter');
function go() {
  renamed({ userId: 'u', amount: 1, public: { amount: 1 } });
}
module.exports = { go };
`);
  const renamed = runAudit(scratchServer);
  check(
    'a renamed destructured field is not reported as unbound',
    renamed.code === 0,
    renamed.code === 0 ? '' : renamed.out.split('\n').filter((l) => l.includes('FAIL')).join(' | '),
  );

  // A caller that supplies FEWER fields than the callee binds is legal —
  // destructuring yields undefined — and must not be reported.
  fs.writeFileSync(path.join(scratchServer, 'reporter.js'), `
function sparse({ alias, userId, minutes }) {
  return { alias, userId, minutes };
}
module.exports = { sparse };
`);
  fs.writeFileSync(path.join(scratchServer, 'caller.js'), `
const { sparse } = require('./reporter');
function go() {
  sparse({ minutes: 5 });
}
module.exports = { go };
`);
  const sparse = runAudit(scratchServer);
  check(
    'a caller supplying fewer fields than the callee binds is not a defect',
    sparse.code === 0,
    sparse.code === 0 ? '' : sparse.out.split('\n').filter((l) => l.includes('FAIL')).join(' | '),
  );

  // And the real tree, right now.
  const real = runAudit();
  check(
    `the real server tree passes (${stamp.slice(0, 10)})`,
    real.code === 0,
    real.code === 0 ? '' : real.out.split('\n').filter((l) => l.includes('FAIL')).join(' | '),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);