/**
 * Database account least privilege.
 *
 * "Use least-privilege database accounts" is the one mitigation on the OWASP
 * injection list that no amount of request-boundary code can satisfy: whatever
 * `MONGO_URI` authenticates as is what every query in this process runs as, and
 * a `superuser` account makes every other guard a policy question rather than a
 * technical one — an injected operator, a leaked URI, or a compromised app can
 * all reach `userAdmin`/`dropDatabase`/other databases.
 *
 * This measures the real grants instead of asserting an intention: ask the
 * connected server who it authenticated (`whoami`, falling back to
 * `connectionStatus`) and classify what came back against what the application
 * actually needs, which is read AND write on exactly one database and nothing
 * else.
 */

// ServerRunStats is a read-only metrics role; Atlas' sharded-cluster connector
// grants it (and, on localhost, `__SYSTEM`) alongside a perfectly narrow
// readWrite user, so treating it as over-privileged would train nobody to
// ignore the alert.
const TOLERABLE_ROLES = new Set([
  'serverrunstats', 'directshardoperations', '__system',
  'clustermonitor', 'clusterupdater',
  // Held implicitly by any authenticated connection on admin; granting it is
  // not a privilege the application can lose by narrowing anything else.
  'authenticate', 'auth',
]);

// A role scoped to a database OTHER than the application's.
const CROSS_DB_WRITE = new Set(['readWriteAnyDatabase', 'readAnyDatabase', 'dbAdminAnyDatabase']);
// Any scoped database, the whole cluster. `atlasAdmin` is Atlas' own
// cluster-admin role — the account that can create other users.
const CLUSTER_ADMIN = new Set([
  'atlasAdmin', 'clusterAdmin', 'root',
  'userAdminAnyDatabase', 'dbOwnerAnyDatabase', 'backupAnyDatabase',
  'restore', 'hostAuthenticator', 'swapSpace', 'internal',
]);
// Management, not data. This application never needs any of it, on any
// database: collection/index/LDAP/user administration is a human job here.
const MANAGEMENT_ROLES = new Set([
  'dbAdmin', 'dbOwner', 'userAdmin', 'clusterManager', 'keyManager', 'restore',
]);
const ADMIN_NAME = /(^|_)admin|root|__system$/i;

const WRITE_ROLES = new Set(['readWrite', 'dbOwner', 'readWriteAnyDatabase']);

const asArray = (value) => (Array.isArray(value) ? value : []);

function assessLeastPrivilege(whoami, appDb) {
  const roles = [];
  const push = (role, db) => {
    if (!role || !role.role) return;
    roles.push({ role: role.role, db: role.db || db || '' });
  };
  const granted = asArray(whoami && whoami.users);
  for (const user of granted) {
    const userDb = (user && user.user && String(user.user).includes('@'))
      ? String(user.user).split('@').pop()
      : (user && user.db) || '';
    for (const role of asArray(user && user.roles)) push(role, userDb);
    // `directlyAuthorized`/`inheritedRoles` show up on some server versions.
    for (const role of asArray(user && user.inheritedRoles)) push(role, userDb);
  }
  for (const role of asArray(whoami && whoami.roles)) push(role, '');
  for (const item of asArray(whoami && whoami.authInfo && whoami.authInfo.encodedRoles)) push(item, '');

  const user = (granted[0] && granted[0].user) || String(process.env.MONGO_USER || '(unknown)');

  const isSuper = (Array.isArray(whoami && whoami.roles) ? whoami.roles : [])
    .some(r => r && r.role === 'superuser' && r.db === 'admin');
  if (isSuper) {
    return {
      level: 'critical',
      detail: `The database account "${user}" is a superuser: one injection or one leaked `
        + 'MONGO_URI reaches every database, every user, and every collection on the cluster. '
        + 'Create a dedicated user with readWrite on only the application database and point MONGO_URI at it.',
    };
  }

  const scoped = roles.filter(r => r.role !== 'superuser');
  const beyond = scoped.filter(r => {
    const name = String(r.role);
    if (TOLERABLE_ROLES.has(name.toLowerCase())) return false;    // A plain data grant on somebody else's database is still not this app's.
    if (Boolean(appDb) && r.db && r.db !== appDb && r.db !== 'local') return true;
    // No scope makes an admin-class role acceptable to this application.
    return CLUSTER_ADMIN.has(name) || CROSS_DB_WRITE.has(name)
      || MANAGEMENT_ROLES.has(name) || ADMIN_NAME.test(name);
  });
  const list = [...new Set(scoped.map(r => `${r.role}@${r.db || '-'}`))].join(', ') || 'none readable';

  if (beyond.length === 0 && scoped.length === 0) {
    return {
      level: 'warning',
      detail: `Could not read the grants of database account "${user}". Confirm out-of-band that it `
        + 'holds readWrite on only the application database, and nothing else.',
    };
  }

  if (beyond.length > 0) {
    const names = [...new Set(beyond.map(r => `${r.role}@${r.db || '-'}`))].join(', ');
    // Anything that can read or write outside the application database, or that
    // administers the cluster, is escalation — not a hygiene warning.
    const reachesTheWholeCluster = beyond.some(r => CLUSTER_ADMIN.has(r.role) || CROSS_DB_WRITE.has(r.role)
      || (WRITE_ROLES.has(r.role) && r.db && r.db !== appDb));
    return {
      level: reachesTheWholeCluster ? 'critical' : 'warning',
      detail: `Database account "${user}" holds ${names} beyond readWrite on "${appDb || 'the application database'}" `
        + `(${list}). It can administer, drop, or read more than this application uses — grant it only readWrite on that one database.`,
    };
  }

  const writes = (Array.isArray(whoami && whoami.localRoles) ? whoami.localRoles : [])
    .concat(scoped)
    .filter(r => WRITE_ROLES.has(r.role) && (!appDb || !r.db || r.db === appDb));
  if (writes.length === 0) {
    return {
      level: 'warning',
      detail: `Database account "${user}" holds ${list}, which has no write role on "${appDb}" — the API `
        + 'cannot persist. Grant readWrite on that database (least privilege, not no privilege).',
    };
  }
  return {
    level: 'healthy',
    detail: `Database account "${user}" holds ${list} — read/write on "${appDb}" only, with no admin, `
      + 'cross-database or cluster-wide grant.',
  };
}

// `connectionStatus` is the fallback, and in practice the primary: shared
// tier M0 clusters answer `whoami` with CommandNotFound, while
// connectionStatus needs no special privilege on any server. It returns ROLE
// NAMES, not their action lists — asking for `privileges: 1` as an over-
// privileged user is refused by design — so the classification is made from
// the role and its scope, and a role this server would not expand is never
// silently read as "no rights".
function assessConnectionStatus(connectedDb, status) {
  const info = (status && status.authInfo) || {};
  const users = (info.authenticatedUsers || []).map(u => `${u.user}@${u.db}`);
  const granted = (info.authenticatedUserRoles || [])
    .filter(r => !TOLERABLE_ROLES.has(String(r.role).toLowerCase()));
  if (users.length === 0 || granted.length === 0) {
    return {
      status: 'warning',
      detail: 'connectionStatus reports no authenticated user or no readable roles, so least privilege '
        + 'is unmeasured for this account.',
    };
  }
  const list = [...new Set(granted.map(r => `${r.role}@${r.db}`))].join(', ');
  const user = users.join(', ');
  const outside = granted.filter(r => r.db !== 'admin' && r.db !== 'local' && r.db !== connectedDb);
  const adminClass = granted.filter(r => CLUSTER_ADMIN.has(r.role) || CROSS_DB_WRITE.has(r.role)
    || MANAGEMENT_ROLES.has(r.role) || ADMIN_NAME.test(r.role));
  const names = (rows) => [...new Set(rows.map(r => `${r.role}@${r.db}`))].join(', ');

  if (adminClass.length > 0 || outside.length > 0) {
    return {
      status: 'critical',
      detail: `Database account ${user} holds ${names(adminClass.concat(outside))} — that is cluster-wide `
        + `or another database's write, while this API only ever uses readWrite on "${connectedDb}" (${list}). `
        + 'Create a dedicated user with that single grant and point MONGO_URI at it.',
    };
  }
  if (!granted.some(r => WRITE_ROLES.has(r.role) && (r.db === connectedDb || r.db === 'admin'))) {
    return {
      status: 'warning',
      detail: `Database account ${user} holds ${list} with no write role on "${connectedDb}" — the API `
        + 'cannot persist. Grant readWrite on that database (least privilege, not no privilege).',
    };
  }
  return {
    status: 'healthy',
    detail: `Database account ${user} holds ${list} — read/write on "${connectedDb}" only; no admin, `
      + 'cross-database or cluster-wide grant.',
  };
}

let report = { status: 'warning', detail: 'Least privilege has not been evaluated in this process yet.' };

// Once per boot, on the connection that every request will reuse. Never fatal:
// an older server, an unauthenticated localhost, or a user with no right to run
// `whoami` must not keep the API from coming up — the monitor keeps reporting
// whatever it found, so the gap stays visible instead of becoming an outage.
// What it cannot do is stay silent: a measurement that never ran is not a pass.
async function evaluateAndLog() {
  const connection = mongooseConnection().connection;
  const connectedDb = connection.name;
  const line = (r) => `[mongo] database privileges — ${r.status}: ${r.detail}`;
  const finish = (r) => {
    report = r;
    if (r.status === 'healthy') console.log(line(r));
    else console.warn(line(r));
    return r;
  };

  let admin;
  try {
    admin = connection.db.admin();
  } catch (err) {
    return finish({
      status: 'warning',
      detail: `The admin database is not reachable on this connection (${err.message}) — least privilege is unmeasured.`,
    });
  }

  let whoami;
  try {
    whoami = await admin.command({ whoami: 1 });
  } catch {
    whoami = null;
  }
  if (whoami) return finish(assessLeastPrivilege(whoami, connectedDb));

  try {
    return finish(assessConnectionStatus(connectedDb, await connection.db.command({ connectionStatus: 1 })));
  } catch (err) {
    return finish({
      status: 'warning',
      detail: `Neither whoami nor connectionStatus could be run (${err.codeName || err.message}) — least privilege is unmeasured for this account.`,
    });
  }
}

function leastPrivilegeReport() {
  return report;
}

// Required lazily so requiring this module never pulls in the driver.
function mongooseConnection() {
  return require('mongoose');
}

module.exports = { assessLeastPrivilege, assessConnectionStatus, evaluateAndLog, leastPrivilegeReport };
