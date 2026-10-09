/**
 * TLS configuration — the rules that decide whether this API is encrypted, and
 * what happens when the configuration is wrong.
 *
 * The failure modes this file exists to catch are all invisible from the
 * outside: a server that serves plaintext because a path had a typo, HSTS sent
 * over HTTP (which makes a browser refuse to connect at all), and a production
 * boot that quietly succeeds over cleartext. None of them throw, and none of
 * them show up in the UI — so they are asserted here instead.
 */
const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const tls = require('../utils/tls');

const CERT = path.join(tls.REPO_ROOT, 'certs', 'localhost.pem');
const KEY = path.join(tls.REPO_ROOT, 'certs', 'localhost-key.pem');
const hasCertificate = fs.existsSync(CERT) && fs.existsSync(KEY);

/** Run `fn` with a known environment, then restore it exactly. */
function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  for (const key of Object.keys(values)) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('TLS is off unless TLS_ENABLED is exactly true', () => {
  // "Anything else serves HTTP" is the rule, and each of these is a value
  // somebody might plausibly write. `TLS_ENABLED=1` in particular is the trap:
  // JavaScript's `if (process.env.TLS_ENABLED)` would treat it as on, so the
  // comparison has to be exact or a boolean-ish setting silently means two
  // different things.
  for (const value of [undefined, '', 'false', 'FALSE', '0', '1', 'yes', 'on', 'no']) {
    withEnv({ TLS_ENABLED: value }, () => {
      assert.equal(tls.isEnabled(), false, `TLS_ENABLED=${value} must not enable TLS`);
    });
  }
});

test('TLS_ENABLED=true enables TLS', () => {
  withEnv({ TLS_ENABLED: 'true' }, () => assert.equal(tls.isEnabled(), true));
  // Case and surrounding whitespace, which arrive from a hand-edited .env.
  withEnv({ TLS_ENABLED: ' TRUE ' }, () => assert.equal(tls.isEnabled(), true));
});

test('a missing certificate with TLS enabled is fatal, not a silent fallback', () => {
  // The single most important behaviour in this module. Falling back to HTTP
  // here would produce a server that starts cleanly, logs a normal message, and
  // carries bearer tokens in cleartext — the failure nobody notices until it
  // matters.
  withEnv({ TLS_ENABLED: 'true', TLS_KEY_FILE: 'certs/does-not-exist.key', TLS_CERT_FILE: 'certs/does-not-exist.pem' }, () => {
    assert.throws(() => tls.load(), (error) => {
      assert.match(error.message, /TLS is enabled but the private key could not be read/);
      assert.match(error.message, /Refusing to start rather than serving this API over plain HTTP/);
      return true;
    });
  });
});

test('the fatal message names the file it could not read', () => {
  // An operator reading only the startup output has to be able to fix the
  // typo without going looking for it. The key is read first, so that is the
  // path named here; the certificate is the second case.
  withEnv({ TLS_ENABLED: 'true', TLS_CERT_FILE: 'certs/nope.pem', TLS_KEY_FILE: 'certs/nope.key' }, () => {
    try {
      tls.load();
      assert.fail('expected a throw');
    } catch (error) {
      assert.ok(error.message.includes('nope.key'), 'names the private key path');
    }
  });

  // A real key with a bad certificate path is the second half of the same typo,
  // and it must say so too rather than reporting the key that was fine.
  withEnv({ TLS_ENABLED: 'true', TLS_CERT_FILE: 'certs/nope.pem', TLS_KEY_FILE: KEY }, () => {
    if (!hasCertificate) return; // no valid key to pair with the bad path
    try {
      tls.load();
      assert.fail('expected a throw');
    } catch (error) {
      assert.match(error.message, /certificate could not be read/);
      assert.ok(error.message.includes('nope.pem'), 'names the certificate path');
    }
  });
});

test('describe() never throws, and never leaks key material', () => {
  withEnv({ TLS_ENABLED: 'true', TLS_KEY_FILE: 'certs/nope.key', TLS_CERT_FILE: 'certs/nope.pem' }, () => {
    const result = tls.describe();
    assert.equal(result.enabled, false);
    assert.match(result.error, /could not be read/);
  });
  withEnv({ TLS_ENABLED: 'false' }, () => {
    assert.deepEqual(tls.describe(), { enabled: false, error: null });
  });
});

test('relative certificate paths resolve against the repo root, not the cwd', () => {
  // "npm start" in server/ and "node server/index.js" from the root are both
  // normal ways to run this, and the same .env must not mean two different files.
  assert.equal(tls.resolvePath('certs/localhost.pem'), path.join(tls.REPO_ROOT, 'certs', 'localhost.pem'));
  // An absolute path is left alone — that is how a deployment points at a real
  // certificate path.
  const absolute = path.resolve(tls.REPO_ROOT, 'certs', 'localhost.pem');
  assert.equal(tls.resolvePath(absolute), absolute);
  assert.equal(tls.resolvePath(''), '');
});

test('scheme() reflects what the process will actually serve', () => {
  withEnv({ TLS_ENABLED: 'false' }, () => assert.equal(tls.scheme(), 'http'));
  withEnv({ TLS_ENABLED: 'true' }, () => assert.equal(tls.scheme(), 'https'));
});

test('HSTS is only claimed when TLS is actually being served', () => {
  // Helmet's default sends Strict-Transport-Security on every response. A
  // browser that receives HSTS over HTTP records the host as HTTPS-only and then
  // refuses to reach it over HTTP — so an intentional plain-HTTP run (a test
  // server, a LAN phone) breaks in a way that looks like a network fault.
  withEnv({ TLS_ENABLED: 'false' }, () => assert.equal(tls.shouldSendHsts(), false));
  withEnv({ TLS_ENABLED: 'true' }, () => assert.equal(tls.shouldSendHsts(), true));
});

test('the HSTS max-age is short by default, because the browser caches it', () => {
  // HSTS is cached on the HOST by the BROWSER for the whole max-age, and a
  // browser holding an entry for localhost will not make a plain-HTTP request to
  // it at all. With helmet's year-long default that is a trap in development:
  // turn TLS off to debug something, and http://localhost:5000 stops working
  // with "connection refused" and nothing naming HSTS — cleared only by hand in
  // chrome://net-internals/#hsts, which reads as a machine-specific fault.
  //
  // The development certificate is issued by a local authority that can be
  // uninstalled and regenerated at will, so a year-long HTTPS commitment for
  // localhost is a promise this setup cannot keep. Five minutes keeps the
  // downgrade protection that HSTS actually provides and lets the mistake above
  // recover by itself.
  assert.equal(tls.DEFAULT_HSTS_MAX_AGE, 300);
  withEnv({ HSTS_MAX_AGE: undefined }, () => assert.equal(tls.hstsMaxAge(), 300));
});

test('HSTS_MAX_AGE can be raised for a real deployment', () => {
  // Production is the opposite case: the certificate comes from somewhere that
  // will not disappear, so the long commitment is the correct one.
  withEnv({ HSTS_MAX_AGE: '31536000' }, () => assert.equal(tls.hstsMaxAge(), 31_536_000));
});

test('a nonsense HSTS_MAX_AGE changes nothing and cannot disable the header', () => {
  // A typo must not be able to switch HSTS off — that is the whole reason the
  // fallback is a real number rather than "no header".
  for (const value of ['', '   ', 'abc', '-1', '0', 'null', 'NaN', '1e999', '30s']) {
    withEnv({ HSTS_MAX_AGE: value }, () => {
      assert.equal(
        tls.hstsMaxAge(),
        300,
        `HSTS_MAX_AGE=${JSON.stringify(value)} should fall back to the default`,
      );
    });
  }
});

test('the HSTS max-age is capped at one year', () => {
  // Beyond a year there is no additional security meaning, and a larger value
  // only makes the cache harder to escape if something has to be turned off.
  withEnv({ HSTS_MAX_AGE: '99999999999' }, () => assert.equal(tls.hstsMaxAge(), 31_536_000));
});

test('production refuses to boot over plain HTTP with no proxy', () => {
  withEnv({ NODE_ENV: 'production', TLS_ENABLED: 'false', TRUST_PROXY: undefined }, () => {
    assert.throws(() => tls.assertProductionConfigured(), /Production is serving plain HTTP/);
  });
});

test('production is satisfied by TLS, or by a proxy that terminates it', () => {
  // TLS terminated at a load balancer is the normal production topology, and
  // TRUST_PROXY=true is how this process is told. Both are legitimate; neither
  // should be blocked.
  withEnv({ NODE_ENV: 'production', TLS_ENABLED: 'true', TRUST_PROXY: undefined }, () => {
    assert.doesNotThrow(() => tls.assertProductionConfigured());
  });
  withEnv({ NODE_ENV: 'production', TLS_ENABLED: 'false', TRUST_PROXY: 'true' }, () => {
    assert.doesNotThrow(() => tls.assertProductionConfigured());
  });
});

test('the production check never applies outside production', () => {
  // Development over HTTP is a supported, documented mode. If this threw there,
  // every contributor would have to configure TLS to run the app at all.
  for (const env of [undefined, 'development', 'dev', 'test']) {
    withEnv({ NODE_ENV: env, TLS_ENABLED: 'false', TRUST_PROXY: undefined }, () => {
      assert.doesNotThrow(() => tls.assertProductionConfigured());
    });
  }
});

test('createServer returns a plain http.Server when TLS is off', async () => {
  // The test suite depends on this. e2eServer.js boots this index.js and talks
  // to it over HTTP, so "certificate present" must never be enough to switch a
  // server to TLS — otherwise every suite fails against a port that has
  // silently stopped answering.
  await withEnvAsync({ TLS_ENABLED: 'false' }, async () => {
    const app = (req, res) => res.end('ok');
    const server = tls.createServer(app);
    assert.ok(server instanceof http.Server);
    assert.ok(!(server instanceof https.Server));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      http.get({ host: '127.0.0.1', port: server.address().port }, (res) => {
        assert.equal(res.statusCode, 200);
        res.resume();
        server.close(resolve);
      });
    }));
  });
});

test('createServer returns an https.Server when TLS is on, and it terminates TLS', async (t) => {
  if (!hasCertificate) {
    // Not a skipped test dressed up as a pass — there is genuinely no
    // certificate to test with until `npm run certs` has been run, and a
    // certificate cannot be committed (see scripts/dev-certs.mjs).
    t.skip('no certificate in certs/ — run `npm run certs` at the repo root');
    return;
  }
  await withEnvAsync({ TLS_ENABLED: 'true' }, async () => {
    const app = (req, res) => res.end('ok over tls');
    const server = tls.createServer(app);
    assert.ok(server instanceof https.Server);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    // Connecting with the local CA as the only trust root proves two things at
    // once: the server really terminates TLS, and the chain a browser will see
    // is the one the certificate was issued for. `rejectUnauthorized: false`
    // would prove neither, which is why it is not used.
    const ca = fs.readFileSync(path.join(tls.REPO_ROOT, 'certs', 'rootCA.pem'));
    const body = await new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: '/', ca, servername: 'localhost' }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    server.close();
    assert.match(body, /ok over tls/);
  });
});

// `withEnv` above is synchronous because every assertion it guards is. The two
// server tests need to hold the environment across an `await`, so they get a
// promise-returning variant.
async function withEnvAsync(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  for (const key of Object.keys(values)) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}