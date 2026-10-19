/**
 * The security audit RECORD has its own failure mode, and it is not a false
 * statement — it is a true statement that stopped being true.
 *
 * The 2026-10-01 follow-up pass found exactly that: `verification.dependencyAudit`
 * asserted "npm audit: 0 vulnerabilities" as a standing fact five days after
 * nodemailer advisories were published, and three openItems (L5, L6, I4) still
 * described holes the code had since closed. A dashboard that under-reports its
 * own fixes is as misleading as one that under-reports its flaws, because the
 * second one is what teaches an operator to stop reading it.
 *
 * So this checks the shape of the claims, not their content — content is a human
 * judgement, shape is arithmetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..');
const { SECURITY_AUDIT: audit } = require('../utils/securityAudit');

const MANIFESTS = [
  path.join(SERVER, 'package.json'),
  path.join(SERVER, '..', 'my-react-app', 'package.json'),
].map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));

function declaredDependency(name) {
  return MANIFESTS.some((pkg) => (pkg.dependencies || {})[name] || (pkg.devDependencies || {})[name]);
}

test('the severity counts add up, and nothing is counted twice', () => {
  const c = audit.counts;
  assert.equal(c.critical + c.high + c.medium + c.low + c.informational, c.total,
    'every finding has a severity and every severity is counted');
  assert.equal(c.remediatedInCode + c.openOrAccepted, c.total,
    'a finding is either closed in code or on the open list — never both, never neither');

  const openIds = audit.openItems.map((item) => item.id);
  assert.equal(new Set(openIds).size, openIds.length, 'openItems ids are unique');
  const closed = audit.remediations.map((line) => line.trim().split(/\s+/)[0]);
  const doubled = openIds.filter((id) => closed.includes(id));
  assert.deepEqual(doubled, [], `${doubled.join(', ')} cannot be both remediated and open`);
});

test('an open item never names a dependency this repository no longer ships', () => {
  // This is the I4 shape exactly: "speakeasy is unmaintained" stayed on the open
  // list after speakeasy was deleted, because the list is prose and prose does
  // not fail when the code changes underneath it.
  const names = /(?:speakeasy|axios|node-xml2js|xml2js|node-gyp|lodash)\b/g;
  const offenders = [];
  for (const item of audit.openItems) {
    const text = `${item.title} ${item.note || ''} ${item.status || ''}`;
    for (const match of text.matchAll(names)) {
      if (!declaredDependency(match[0])) offenders.push(`${item.id} names ${match[0]}, which is not installed`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('; '));
});

test('every verification claim is dated or points at a live measurement', () => {
  // An undated PASS is a claim about a moment nobody can recover. The record's
  // own F1 finding is what this rule exists to prevent repeating.
  for (const [key, value] of Object.entries(audit.verification)) {
    assert.match(String(value), /(PASS|FAIL|MEASURED)\s+(\d{4}-\d{2}-\d{2}|LIVE)/,
      `${key} must carry the date it was measured, or say it is measured live`);
  }
  assert.match(audit.verification.dependencyAudit, /MEASURED LIVE|dependency_audit/,
    'the advisory count must not be a sentence — it has to be the monitor');
});

test('headline findings name what closed them, not just what was wrong', () => {
  for (const item of audit.headlineFindings) {
    assert.match(String(item.status), /fixed|sanitized/, `${item.id} must state its outcome`);
    if (/fixed/i.test(String(item.status))) {
      assert.ok(String(item.status).length > 'fixed'.length, `${item.id} says fixed without saying where`);
    }
  }
});

test('the record re-reads itself instead of only remembering', () => {
  // reverification is the pass that checks the open list against the code. Its
  // absence is how L5 and L6 survived their own closure for weeks.
  assert.ok(audit.reverification, 'no re-verification pass recorded');
  assert.match(audit.reverification.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(audit.reverification.changes.length >= 3, 'a pass that changed nothing is not a re-read');
  for (const line of audit.reverification.changes) {
    assert.match(line, /^[ILHF]\d+|^verification\.|^manualActions/, `not tied to a finding: ${line.slice(0, 60)}`);
  }
});

test('a manual action an operator must perform names the mechanism, not only the wish', () => {
  // "URGENT: rotate JWT_SECRET" sat undone for 26 days because the record stated
  // the goal and not the procedure. Any action that needs a code path to be
  // survivable has to point at it, or the action gets deferred forever.
  const rotation = audit.manualActions.find((line) => /rotate JWT_SECRET/.test(line));
  assert.ok(rotation, 'JWT_SECRET rotation is no longer listed as a manual action');
  assert.match(rotation, /JWT_SECRET_PREVIOUS_KEYS/, 'rotation must name the overlap that makes it survivable');
  assert.match(fs.readFileSync(path.join(SERVER, '.env.example'), 'utf8'), /JWT_SECRET_PREVIOUS_KEYS/,
    'and that variable has to be documented where the operator reads it');
});
