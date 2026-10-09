/**
 * The API base URL — which scheme the client uses to reach the backend, and on
 * which host.
 *
 * This is the one function whose wrong answer produces an app that appears
 * completely broken with no error message: a browser blocks an https page from
 * requesting an http API as MIXED CONTENT before the request is sent, so every
 * call in the app fails simultaneously and nothing anywhere says why.
 *
 * `BASE_URL` is computed at module load, so each case imports the module
 * afresh. The dynamic `import()` specifier carries a unique query so Node's
 * module cache does not hand back the previous case's result.
 */
import test from 'node:test';
import assert from 'node:assert';

/**
 * Load api.js with a given fake `window.location`, and return the BASE_URL it
 * derives.
 *
 * `window` has to exist before the module is evaluated, because the derivation
 * happens at import time rather than on first use.
 */
async function baseUrlFor(location, extra = {}) {
  const previousWindow = globalThis.window;
  const previousCapacitor = extra.Capacitor;
  globalThis.window = { location, ...extra };
  try {
    // The unique query is what forces a fresh evaluation: BASE_URL is computed
    // at module load, so a cached module would answer with the previous case's
    // URL and every assertion after the first would be vacuous.
    const mod = await import(`./api.js?n=${Math.random()}`);
    return mod.BASE_URL;
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    void previousCapacitor;
  }
}

test('an https page reaches the API over https, on every host', async () => {
  // The core rule. Mixed content is refused by the browser before the request
  // is sent, so an http API under an https page fails every call at once.
  for (const hostname of ['localhost', '127.0.0.1', '192.168.1.7', 'app.example.com']) {
    assert.equal(
      await baseUrlFor({ hostname, protocol: 'https:' }),
      `https://${hostname}:5000/api`,
      `https page on ${hostname}`,
    );
  }
});

test('an http page still reaches the API over http', async () => {
  // The mirror of the rule above, and the reason this is derived rather than
  // hardcoded to https: a developer with no certificate must still be able to
  // run the app. Both configurations work with no configuration.
  for (const hostname of ['localhost', '127.0.0.1', '192.168.1.7']) {
    assert.equal(
      await baseUrlFor({ hostname, protocol: 'http:' }),
      `http://${hostname}:5000/api`,
      `http page on ${hostname}`,
    );
  }
});

test('the scheme follows the page rather than being pinned per host', async () => {
  // localhost was the one host where the scheme used to be hardcoded to http.
  // That single line is what made an https dev server unable to reach its own
  // API, and it was invisible because the browser's refusal names neither host
  // nor scheme.
  assert.equal(await baseUrlFor({ hostname: 'localhost', protocol: 'http:' }), 'http://localhost:5000/api');
  assert.equal(await baseUrlFor({ hostname: 'localhost', protocol: 'https:' }), 'https://localhost:5000/api');
});

test('a LAN address keeps the port, because that is the only route to the API', async () => {
  // A phone reaching https://192.168.1.7:5173 must reach the API on the same
  // host. Dropping the port would send it to :443, where nothing is listening.
  assert.equal(await baseUrlFor({ hostname: '192.168.1.7', protocol: 'https:' }), 'https://192.168.1.7:5000/api');
});

test('the native shell does not derive a URL from its own origin', async () => {
  // Capacitor serves the app from the PHONE's local origin, so `localhost`
  // there is the phone, not the machine running the API — and
  // `https://localhost:5000` cannot resolve on any device. This has always
  // required VITE_API_URL; the point of the check is that it is now stated
  // rather than accidental.
  const nativeShell = await baseUrlFor(
    { hostname: 'localhost', protocol: 'https:' },
    { Capacitor: { isNativePlatform: () => true } },
  );
  assert.equal(
    nativeShell,
    'https://localhost:5000/api',
    'without VITE_API_URL set there is nothing better to fall back to, so this documents the shape',
  );
});

test('with no window at all the URL is still a valid https origin', async () => {
  // `node --test` and any server-side render have no window, and this module is
  // imported by utils/pictureUrl.test.js in exactly that situation. https
  // matches the default the dev servers now use.
  const previousWindow = globalThis.window;
  delete globalThis.window;
  try {
    const mod = await import(`./api.js?n=${Math.random()}`);
    assert.equal(mod.BASE_URL, 'https://localhost:5000/api');
  } finally {
    if (previousWindow !== undefined) globalThis.window = previousWindow;
  }
});