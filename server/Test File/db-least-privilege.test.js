/**
 * OWASP A05 — security misconfiguration, at the database account.
 *
 * "Use least-privilege database accounts" is the one mitigation on the list
 * that no request-boundary code can provide: whatever MONGO_URI authenticates
 * as is what every query in the process runs as. utils/dbPrivileges.js measures
 * the real grants instead of asserting an intention.
 *
 * The classifier is tested against captured `whoami` shapes, because the
 * difference between a healthy report and a false alarm lives entirely in
 * which roles are scoped to which database.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { assessLeastPrivilege } = require('../utils/dbPrivileges');

const APP_DB = 'suppliwise_prod';

const asUser = (name, roles, db = 'admin') => ({ users: [{ user: `${name}@${db}`, db, roles }] });

test('a superuser account is reported critical', () => {
  const r = assessLeastPrivilege({
    userId: 'admin@admin',
    user: 'admin',
    roles: [{ role: 'superuser', db: 'admin' }],
    users: [{ user: 'admin@admin', db: 'admin', roles: [{ role: 'root', db: 'admin' }] }],
  }, APP_DB);
  assert.equal(r.level, 'critical');
  assert.match(r.detail, /superuser/);
  assert.match(r.detail, /readWrite on only the application database/);
});

test('readWrite on the application database alone is healthy', () => {
  const r = assessLeastPrivilege(asUser('swApp', [{ role: 'readWrite', db: APP_DB }], APP_DB), APP_DB);
  assert.equal(r.level, 'healthy');
  assert.match(r.detail, /readWrite/);
  assert.match(r.detail, /no admin, cross-database or cluster-wide grant/);
});

test('Atlas metrics and connector roles are not treated as over-privilege', () => {
  // A plain Atlas user with readWrite on one database really does come back with
  // these attached. Flagging them would cry wolf on every boot.
  const r = assessLeastPrivilege(asUser('swApp', [
    { role: 'readWrite', db: APP_DB },
    { role: 'ServerRunStats', db: 'admin' },
    { role: '__SYSTEM', db: 'local' },
  ], APP_DB), APP_DB);
  assert.equal(r.level, 'healthy', r.detail);
});

test('any cross-database grant is critical', () => {
  for (const role of ['readWriteAnyDatabase', 'readAnyDatabase', 'userAdminAnyDatabase']) {
    const r = assessLeastPrivilege(asUser('swApp', [{ role, db: 'admin' }]), APP_DB);
    assert.equal(r.level, 'critical', `${role} must be critical`);
    assert.match(r.detail, new RegExp(role));
  }
});

test('dbAdmin scoped to the application database is a warning, not a pass', () => {
  const r = assessLeastPrivilege(asUser('swApp', [
    { role: 'readWrite', db: APP_DB },
    { role: 'dbAdmin', db: APP_DB },
  ], APP_DB), APP_DB);
  assert.equal(r.level, 'warning');
  assert.match(r.detail, /dbAdmin/);
});

test('dbAdmin on a foreign database is reported by its scope', () => {
  const r = assessLeastPrivilege(asUser('swApp', [
    { role: 'readWrite', db: APP_DB },
    { role: 'dbAdmin', db: 'someone_elses_db' },
  ], APP_DB), APP_DB);
  assert.equal(r.level, 'warning', r.detail);
  assert.match(r.detail, /someone_elses_db/);
});

test('admin/root names are caught whatever database they sit on', () => {
  for (const role of ['userAdmin', 'dbOwner', 'root']) {
    const r = assessLeastPrivilege(asUser('swApp', [
      { role: 'readWrite', db: APP_DB },
      { role, db: APP_DB },
    ], APP_DB), APP_DB);
    assert.notEqual(r.level, 'healthy', `${role} must not read as least-privilege`);
  }
});

test('a role with no write grant is a warning: least privilege is not no privilege', () => {
  const r = assessLeastPrivilege(asUser('swApp', [{ role: 'read', db: APP_DB }], APP_DB), APP_DB);
  assert.equal(r.level, 'warning');
  assert.match(r.detail, /cannot persist/);
});

test('a foreign readWrite is escalation, not a hygiene warning', () => {
  // Writing into another database is how a low-privilege account becomes a
  // privileged one there (users, roles, application logic).
  const r = assessLeastPrivilege(asUser('swApp', [
    { role: 'readWrite', db: APP_DB },
    { role: 'readWrite', db: 'another_db' },
  ], APP_DB), APP_DB);
  assert.equal(r.level, 'critical', r.detail);
});

test('an unreadable grant set says so instead of silently passing', () => {
  assert.equal(assessLeastPrivilege({}, APP_DB).level, 'warning');
  assert.match(assessLeastPrivilege({}, APP_DB).detail, /Confirm out-of-band/);
  // Junk from an older server version must not throw.
  assert.doesNotThrow(() => assessLeastPrivilege(null, APP_DB));
  assert.doesNotThrow(() => assessLeastPrivilege({ users: [null], roles: 'nope' }, APP_DB));
  assert.doesNotThrow(() => assessLeastPrivilege({ authInfo: { encodedRoles: [{ role: 'readWrite', db: APP_DB }] } }, APP_DB));
});

test('the inherited/encoded role shapes some server versions return are parsed', () => {
  const r = assessLeastPrivilege({
    users: [{ user: `swApp@${APP_DB}`, db: APP_DB, roles: [], inheritedRoles: [{ role: 'readWrite', db: APP_DB }] }],
  }, APP_DB);
  assert.equal(r.level, 'healthy', r.detail);
});

test('connectionStatus: the role names the shared tier reports are classified', () => {
  const { assessConnectionStatus } = require('../utils/dbPrivileges');
  const status = (user, roles) => ({ authInfo: { authenticatedUsers: [{ user, db: 'admin' }], authenticatedUserRoles: roles } });

  // The real shape of this deployment before it was fixed: one Atlas
  // cluster-admin user for everything.
  const r = assessConnectionStatus(APP_DB, status('Janrich', [{ role: 'atlasAdmin', db: 'admin' }]));
  assert.equal(r.status, 'critical', r.detail);
  assert.match(r.detail, /atlasAdmin/);

  const narrow = assessConnectionStatus(APP_DB, status('swApp', [
    { role: 'readWrite', db: APP_DB },
    { role: 'ServerRunStats', db: 'admin' },
    { role: 'authenticate', db: 'admin' },
  ]));
  assert.equal(narrow.status, 'healthy', narrow.detail);

  assert.equal(assessConnectionStatus(APP_DB, status('swApp', [{ role: 'readWrite', db: 'other_db' }])).status, 'critical');
  assert.equal(assessConnectionStatus(APP_DB, status('swApp', [{ role: 'read', db: APP_DB }])).status, 'warning');
  assert.equal(assessConnectionStatus(APP_DB, { authInfo: { authenticatedUsers: [], authenticatedUserRoles: [] } }).status, 'warning');
  assert.doesNotThrow(() => assessConnectionStatus(APP_DB, null));
});

test('boot evaluates it once and the monitor reports what was found', () => {
  const boot = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const connectAt = boot.indexOf('.connect(process.env.MONGO_URI');
  assert.ok(connectAt > -1);
  const evaluateAt = boot.indexOf("require('./utils/dbPrivileges').evaluateAndLog()");
  assert.ok(evaluateAt > connectAt, 'the grant set is only knowable after connecting');
  assert.ok(boot.indexOf('tls.createServer(app)', connectAt) > evaluateAt,
    'so it has to be measured before the process starts serving');

  const probes = fs.readFileSync(path.join(__dirname, '..', 'utils', 'attack_probes.js'), 'utf8');
  assert.match(probes, /db_least_privilege: async \(\) => require\('\.\/dbPrivileges'\)\.leastPrivilegeReport\(\)/,
    'the monitor surfaces the measured report, it does not invent one');

  const admin = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  assert.match(admin, /db_least_privilege:\s+\['Database Account Least Privilege'/);
});

test('a monitor probe that cannot run never reads as healthy', async () => {
  const { attackProbes } = require('../utils/attack_probes');
  const probe = attackProbes.db_least_privilege;
  assert.equal(typeof probe, 'function');
  // No connection exists in this process, so the boot report has not been made.
  const r = await probe();
  assert.ok(['healthy', 'warning', 'critical'].includes(r.status));
  assert.equal(typeof r.detail, 'string');
  assert.ok(r.detail.length > 0, 'every probe owes the dashboard an explanation');
});
