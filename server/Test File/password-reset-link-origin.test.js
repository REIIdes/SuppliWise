'use strict';

/**
 * WHERE THE RESET LINK POINTS
 * ===========================
 *
 * A password reset is completed from a DIFFERENT device from the one that
 * requested it — that is the whole point of emailing a link, and it is why the
 * email also carries a code.
 *
 * The origin used to come straight from the request's `Origin` header in
 * development. Requesting a reset from the desktop therefore produced an email
 * containing `https://localhost:5173/reset-password?token=…`, which works on the
 * machine that asked for it and nowhere else. Open that mail on a phone — the
 * obvious move for an account-recovery message — and `localhost` resolves to the
 * PHONE, so there is no server there and the account cannot be recovered. The
 * link looked perfect and was dead on arrival.
 *
 * The old warning did not help: it sat in the branch a browser request never
 * reaches, because a browser always sends a perfectly valid Origin, so the
 * failure was completely silent.
 *
 * The guard below is therefore the first test: a reset requested from a loopback
 * origin must NOT produce a loopback link.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-link-origin';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveWebOrigin, buildResetUrl } = require('../utils/passwordReset');

/** Restore both variables so a case cannot decide the next one. */
function withEnv({ nodeEnv, publicWebUrl }, fn) {
  const originalEnv = process.env.NODE_ENV;
  const originalUrl = process.env.PUBLIC_WEB_URL;
  process.env.NODE_ENV = nodeEnv;
  if (publicWebUrl === undefined) delete process.env.PUBLIC_WEB_URL;
  else process.env.PUBLIC_WEB_URL = publicWebUrl;
  try {
    return fn();
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
    if (originalUrl === undefined) delete process.env.PUBLIC_WEB_URL;
    else process.env.PUBLIC_WEB_URL = originalUrl;
  }
}

const requestFrom = (origin) => ({ headers: origin ? { origin } : {} });

const isLoopback = (value) => /localhost|127\.0\.0\.1|\[::1\]/.test(value);

test('a reset requested from this machine still emails a link another device can open', () => {
  // THE REGRESSION GUARD. Both schemes, because the dev server serves https by
  // default and http when VITE_DEV_HTTPS=false, and both were affected.
  for (const origin of ['https://localhost:5173', 'http://localhost:5173']) {
    const resolved = withEnv({ nodeEnv: 'development' }, () => resolveWebOrigin(requestFrom(origin)));

    assert.ok(
      !isLoopback(resolved),
      `a link built for ${resolved} cannot be opened on a phone — that is the bug this guards`
    );
    assert.match(resolved, /^https?:\/\/[^/]+:\d+$/, `expected a scheme, host and port, got ${resolved}`);
  }
});

test('the emailed link is built from the same origin the page is served on', () => {
  const url = withEnv({ nodeEnv: 'development' }, () => {
    const origin = resolveWebOrigin(requestFrom('http://localhost:5173'));
    return buildResetUrl(origin, 'abc123');
  });

  assert.ok(!isLoopback(url), `the emailed URL must not be loopback: ${url}`);
  assert.match(url, /\/reset-password\?token=abc123$/);
});

test('the code entry page in the same email shares that origin', () => {
  // The two links in one email disagreeing would send half the reader somewhere
  // the reset form is not.
  const [link, codePage] = withEnv({ nodeEnv: 'development' }, () => {
    const origin = resolveWebOrigin(requestFrom('http://localhost:5173'));
    return [buildResetUrl(origin, 'abc123'), `${origin}/reset-password`];
  });

  const hostOf = (value) => new URL(value).host;
  assert.equal(hostOf(link), hostOf(codePage));
});

test('a caller already browsing on a reachable address keeps it', () => {
  // Phone testing over the LAN: the caller is already on an address that works,
  // so it is used unchanged rather than replaced.
  const lan = 'http://192.168.1.7:5173';
  const resolved = withEnv({ nodeEnv: 'development' }, () => resolveWebOrigin(requestFrom(lan)));

  assert.equal(resolved, lan);
});

test('a request with no Origin at all still gets a usable address', () => {
  const resolved = withEnv({ nodeEnv: 'development' }, () => resolveWebOrigin(requestFrom(null)));

  assert.ok(!isLoopback(resolved) || resolved === 'https://localhost:5173',
    'a machine with no LAN interface has nothing better to offer');
  assert.match(resolved, /^https?:\/\//);
});

test('PUBLIC_WEB_URL wins over anything the request says', () => {
  const resolved = withEnv(
    { nodeEnv: 'development', publicWebUrl: 'https://app.example.com/' },
    () => resolveWebOrigin(requestFrom('https://evil.example.com')),
  );

  // Trailing slash normalised away, so the built path is never `//reset-password`.
  assert.equal(resolved, 'https://app.example.com');
});

test('production takes the origin from configuration only', () => {
  // The Origin header is attacker-controlled. In production it must not be able
  // to rewrite the link in a real user's inbox — which is what would hand the
  // token to whoever chose the header.
  const resolved = withEnv(
    { nodeEnv: 'production', publicWebUrl: 'https://app.example.com' },
    () => resolveWebOrigin(requestFrom('https://evil.example.com')),
  );

  assert.equal(resolved, 'https://app.example.com');
});

test('a loopback address is only ever returned as the documented last resort', () => {
  // With configuration set there is no path that can reach it at all.
  assert.equal(
    withEnv({ nodeEnv: 'production', publicWebUrl: 'https://app.example.com' },
      () => resolveWebOrigin(requestFrom('https://app.example.com'))),
    'https://app.example.com'
  );
});