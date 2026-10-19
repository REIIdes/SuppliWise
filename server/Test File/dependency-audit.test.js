/**
 * The dependency census must be honest about what it could not measure.
 *
 * `utils/dependencyAudit.js` is the control behind "keep everything patched":
 * it asks npm what the installed production trees owe us. Its dangerous failure
 * mode is not a wrong verdict but a MISSING one rendered as healthy — so these
 * drive it with npm replaced, without touching the network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// CommonJS like every other file here: `npm run check` compiles this tree as
// scripts, so an ES module in it is a file the syntax gate cannot read.
const SERVER = path.resolve(__dirname, '..');
const AUDIT = path.join(SERVER, 'utils', 'dependencyAudit.js');
const auditSrc = fs.readFileSync(AUDIT, 'utf8');
// Prose can name the very constructs these tests forbid, so the source
// assertions look only at code.
const codeOnly = auditSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The module destructures execFile at require time, so patching the
// child_process export later would not reach it — the loader itself has to
// hand back the stub, and the module has to be loaded fresh under it.
function withFakeNpm(run, impl) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request !== 'node:child_process' && request !== 'child_process') {
      return realLoad.call(this, request, parent, isMain);
    }
    return { execFile: impl };
  };
  delete require.cache[AUDIT];
  try {
    return run(require(AUDIT)).finally(() => {
      Module._load = realLoad;
      delete require.cache[AUDIT];
    });
  } finally {
    Module._load = realLoad;
    delete require.cache[AUDIT];
  }
}

const npmFails = (bin, args, opts, cb) => cb(new Error('ENOENT npm'), '', '');
const npmReports = (payload) => (bin, args, opts, cb) => cb(null, JSON.stringify(payload), '');

test('the census covers BOTH shipped packages, not just the API', () => {
  assert.match(auditSrc, /name: 'server'/);
  assert.match(auditSrc, /name: 'client'/);
});

test('an audit that could not run is a warning, never a healthy', () => {
  return withFakeNpm(({ dependencyAudit }) => dependencyAudit().then((result) => {
    assert.equal(result.status, 'warning');
    assert.match(result.detail, /unmeasured/);
  }), npmFails);
});

test('a production advisory is reported critical with the package named', () => {
  return withFakeNpm(({ dependencyAudit }) => dependencyAudit().then((result) => {
    assert.equal(result.status, 'critical');
    assert.match(result.detail, /express \(high\)/);
    assert.match(result.detail, /mongoose \(critical\)/);
  }), npmReports({ vulnerabilities: { express: { severity: 'high' }, mongoose: { severity: 'critical' } } }));
});

test('a clean tree reads healthy and says which trees it checked', () => {
  return withFakeNpm(({ dependencyAudit }) => dependencyAudit().then((result) => {
    assert.equal(result.status, 'healthy');
    assert.match(result.detail, /zero advisories/);
  }), npmReports({ vulnerabilities: {} }));
});

test('dev-tree findings are named, and never mixed into the production verdict', async () => {
  // Two questions with two different answers, which the row used to collapse
  // into one by declaring dev dependencies irrelevant. That sentence is true of
  // the running API and false of the machine that builds it: dev packages get
  // installed and executed there, and an advisory among them is a fact anyone
  // can verify with one command. So production findings alone decide `critical`,
  // and the dev census is reported alongside — including the honest case where
  // upstream has published no fixed release yet.
  const calls = [];
  const impl = (bin, args, opts, cb) => {
    calls.push(args);
    const withDev = !args.includes('--omit=dev');
    cb(null, JSON.stringify({
      vulnerabilities: withDev
        ? { braces: { severity: 'high', fixAvailable: false } }
        : {},
    }), '');
  };
  await withFakeNpm(({ dependencyAudit }) => dependencyAudit().then((result) => {
    assert.notEqual(result.status, 'critical', 'a dev-only advisory must not read as a production compromise');
    assert.match(result.detail, /server\/braces \(high, no fixed release yet\)/);
    assert.match(result.detail, /not reachable from a request/);
  }), impl);
  assert.ok(calls.some(a => a.includes('--omit=dev')), 'production census ran');
  assert.ok(calls.some(a => !a.includes('--omit=dev')), 'dev census ran');

  // And when production is NOT clean, the second census is skipped: the verdict
  // is already the serious one, and this module runs npm over the network.
  const second = [];
  await withFakeNpm(({ dependencyAudit }) => dependencyAudit().then((result) => {
    assert.equal(result.status, 'critical');
  }), (bin, args, opts, cb) => {
    second.push(args);
    cb(null, JSON.stringify({ vulnerabilities: { express: { severity: 'high' } } }), '');
  });
  assert.equal(second.length, 2, 'one census per shipped tree, no dev pass behind a production finding');
});

test('the spawner never asks for a shell and resolves npm without one', () => {
  assert.match(auditSrc, /require\('node:child_process'\)/);
  assert.doesNotMatch(auditSrc, /execSync|spawnSync|shell\s*:\s*true/);
  // Windows: `npm` is a .cmd, and Node refuses to spawn one without a shell
  // since CVE-2024-27980 (spawn EINVAL). The shell-free form is npm's own CLI
  // script run through the binary that started this process — and the module
  // must never name a .cmd at all, even in code.
  const codeOnly = auditSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(codeOnly, /cmd:\s*process\.execPath/);
  assert.match(codeOnly, /npm-cli\.js/);
  assert.doesNotMatch(codeOnly, /['"`][^'"`\n]*\.cmd['"`]/);
});

test('a tree that is not installed here is named, not counted as a failure', () => {
  // The deployed layout splits the two packages into different images: the API
  // container holds the server tree only. If a missing root reached the census
  // as an error, every production monitor would read "server: ENOENT"-ish noise
  // and the one real signal — an advisory — would be indistinguishable from the
  // normal shape of the container. So presence is decided BEFORE spawning npm,
  // and the verdict names the trees it actually measured.
  assert.match(auditSrc, /PACKAGES\.filter\(\(p\) => installedHere\(p\.dir\)\)/);
  assert.match(auditSrc, /is not installed in this deployment/);
  // And an install with NEITHER root is a warning about being unable to measure,
  // never a healthy — the rule that governs every other probe here.
  assert.match(auditSrc, /visible\.length === 0[\s\S]{0,300}status: 'warning'/);
});

test('both shipped images install from the lockfile, not the manifest', () => {
  // `npm install` resolves `^ranges` afresh on every build, so the tree that
  // ships is not the tree this census audited, and a compromised published
  // version enters with nobody reviewing a diff. `npm ci` refuses to proceed
  // unless package-lock.json matches the manifest exactly — which is what makes
  // the lockfile reviewable in git and the audit above mean something.
  const repo = path.resolve(SERVER, '..');
  for (const file of ['Dockerfile.api', 'Dockerfile.web']) {
    const src = fs.readFileSync(path.join(repo, file), 'utf8');
    assert.doesNotMatch(src, /RUN npm install(?! ci)/, `${file} must not resolve ranges at build time`);
    assert.match(src, /COPY[^\n]*package-lock\.json/, `${file} must copy the lockfile`);
    assert.match(src, /npm ci/, `${file} must install with npm ci`);
  }
  // The server tree installs production-only, so the image cannot carry a dev
  // dependency the request path could import.
  assert.match(fs.readFileSync(path.join(repo, 'Dockerfile.api'), 'utf8'), /npm ci --omit=dev/);
});

test('the real spawn is the node binary with a fixed audit argv', () => {
  const calls = [];
  const capture = (bin, args, opts, cb) => {
    calls.push({ bin, args, opts });
    cb(null, JSON.stringify({ vulnerabilities: {} }), '');
  };
  return withFakeNpm(({ dependencyAudit }) => dependencyAudit().then(() => {
    // Two shipped trees, each asked twice — production-only first, then the full
    // tree — so four npm runs and not two.
    assert.equal(calls.length, 4, 'one production census and one dev census per shipped package');
    for (const call of calls) {
      assert.equal(call.bin, process.execPath);
      assert.ok(call.args[1].endsWith('npm-cli.js'), `expected npm's CLI script, got ${call.args[1]}`);
      assert.deepEqual(call.args.slice(2, 4), ['audit', '--json'], 'argv is a fixed audit invocation');
      assert.ok(call.args.length === 4 || call.args[4] === '--omit=dev',
        `only the production pass omits dev, got ${call.args.slice(4).join(' ')}`);
      assert.equal(call.opts.shell, undefined);
      assert.ok(path.isAbsolute(call.opts.cwd));
    }
  }), capture);
});

/**
 * The monitor gives every probe 10 seconds; `npm audit` needs the network and
 * can take forty. Awaiting it inside the poll is what made the row read "Probe
 * timed out after 10 s" after a boot — a control that works displayed as one
 * that is broken, which is exactly how a real advisory gets ignored later.
 */
test('a poll never waits for the registry once a census exists', () => {
  const calls = [];
  const capture = (bin, args, opts, cb) => {
    calls.push(args);
    setTimeout(() => cb(null, JSON.stringify({ vulnerabilities: {} }), ''), 30);
  };
  return withFakeNpm(async ({ dependencyAudit }) => {
    const first = await dependencyAudit();
    assert.equal(first.status, 'healthy');
    assert.equal(calls.length, 4, 'the cold census did run — production and dev, per tree');

    const started = Date.now();
    const second = await dependencyAudit();
    assert.equal(second, first, 'the cached census is the answer, not a promise to npm');
    assert.ok(Date.now() - started < 25, `a warm poll must be instant, took ${Date.now() - started} ms`);
    assert.equal(calls.length, 4, 'and it spawned nothing to ask');

    const third = await dependencyAudit();
    assert.equal(third, first, 'every later poll is the same');
    assert.equal(calls.length, 4, 'still no second npm while the cache is inside its window');
  }, capture);
});

// A background refresh is a chain of awaits, so "one macrotask later" is not a
// reliable point at which to count its spawns.
const waitForCount = async (rows, wanted, ms = 500) => {
  const until = Date.now() + ms;
  while (rows.length < wanted && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return rows.length;
};

test('an aged census is refreshed behind the request, never in front of it', () => {
  const calls = [];
  const capture = (bin, args, opts, cb) => {
    calls.push(args);
    cb(null, JSON.stringify({ vulnerabilities: {} }), '');
  };
  const realNow = Date.now;
  return withFakeNpm(async ({ dependencyAudit }) => {
    const first = await dependencyAudit();
    assert.equal(calls.length, 4, 'the cold census ran');

    // Six hours on, without waiting for them: the poll must answer from the
    // cache and start the refresh on its own.
    Date.now = () => realNow() + 7 * 60 * 60 * 1000;
    try {
      const aged = await dependencyAudit();
      assert.equal(aged, first, 'the poll is served the census it has, not a wait for the one it is taking');
      assert.equal(await waitForCount(calls, 8), 8, 'and the refresh really did go to npm in the background');
    } finally {
      Date.now = realNow;
    }
  }, capture);
});

test('a census that could not run is retried soon; a clean one is not', () => {
  // "npm could not reach the registry" is a gap in the measurement, not a
  // verdict about the tree. Holding it for six hours would hide every advisory
  // published in that window behind a row an admin has learned to ignore — but
  // re-running npm on every 30-second poll is not an answer either, so a
  // warning has its own, short window.
  const realNow = Date.now;
  const age = (ms) => { Date.now = () => realNow() + ms; };

  const clean = [];
  return withFakeNpm(async ({ dependencyAudit }) => {
    await dependencyAudit();
    age(11 * 60 * 1000);
    try {
      await dependencyAudit();
      await new Promise((r) => setImmediate(r));
      assert.equal(clean.length, 4, '11 minutes past a CLEAN census is inside its six-hour window — nothing re-ran');
    } finally {
      Date.now = realNow;
    }
  }, (bin, args, opts, cb) => { clean.push(args); cb(null, JSON.stringify({ vulnerabilities: {} }), ''); })
    .then(() => {
      const tried = [];
      return withFakeNpm(async ({ dependencyAudit }) => {
        const warning = await dependencyAudit();
        assert.equal(warning.status, 'warning', 'precondition: npm could not run');
        assert.equal(tried.length, 2);
        age(11 * 60 * 1000);
        try {
          await dependencyAudit();
          await new Promise((r) => setImmediate(r));
          assert.ok(tried.length > 2, `a warning is retried after its short window, saw ${tried.length} spawns`);
        } finally {
          Date.now = realNow;
        }
      }, (bin, args, opts, cb) => { tried.push(args); cb(new Error('ENETWORK'), '', ''); });
    });
});

test('requiring the census from a process that is not the server spawns no npm', async () => {
  // The boot warm-up is a timer inside a test runner otherwise — a 40-second
  // registry call that looks like a hung suite. Prove it from the outside: load
  // the module in a child process whose entry is not index.js and show it exits
  // on its own, with nothing held open.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const script = `const m = require(${JSON.stringify(AUDIT)});`
    + 'if (typeof m.dependencyAudit !== "function") process.exit(3);';
  const { stderr } = await run(process.execPath, ['-e', script], { cwd: SERVER, timeout: 15000 });
  assert.equal(stderr, '', 'no warning about a lingering handle, because the timer is gated and unref’d');
});
