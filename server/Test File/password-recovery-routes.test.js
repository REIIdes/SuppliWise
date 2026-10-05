/**
 * Route-table check for the alternative recovery methods.
 *
 * Boots the real router against a throwaway Express app with NO database and NO
 * mail transport, then walks the printed route table. This catches the failure
 * mode that is otherwise invisible until someone clicks the button: a handler
 * registered on a path the client does not call, or a path that shadows another
 * because of ordering.
 *
 * No network, no Mongo — every assertion is about the table itself.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-route-table';

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../routes/passwordReset');

/**
 * The router's own layer stack.
 *
 * `app.router` is deprecated and THROWS in Express 4, so the router is inspected
 * directly rather than through a mounted app. A layer with `.route` is an
 * endpoint; a named layer without one is middleware (`requestLimiter` here).
 */
function layers() {
  return (router.stack || []).filter((layer) => layer.route || layer.name);
}

function routePaths() {
  return layers()
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods)
      .map((method) => `${method.toUpperCase()} ${layer.route.path}`));
}

test('the recovery methods are mounted on the paths the client calls', () => {
  const routes = routePaths();

  const expected = [
    'POST /recovery-code',
    'POST /authenticator',
    'POST /passkey/options',
    'POST /passkey/verify',
    'POST /recovery-email',
    // The pre-existing emailed flow must survive alongside them.
    'GET /rules',
    'POST /request',
    'GET /validate',
    'POST /complete',
  ];

  for (const path of expected) {
    assert.ok(routes.includes(path), `missing route: ${path}\nregistered:\n${routes.join('\n')}`);
  }
});

test('the recovery routes are registered BEFORE requestLimiter', () => {
  // Ordering is load-bearing: router.use(requestLimiter) is the emailed path's
  // budget, and the recovery methods must not share it. If someone moves the
  // `router.use` back above them this fails, which is the point.
  const stack = layers();

  // Express names an unnamed handler "<anonymous>", so the limiter is found by
  // SHAPE rather than by name: the only non-route layer in this router.
  const limitAt = stack.findIndex((layer) => !layer.route);
  assert.ok(limitAt !== -1, 'the router-wide limiter layer is gone');
  assert.equal(
    stack.filter((layer) => !layer.route).length, 1,
    'expected exactly one router-wide middleware layer'
  );

  for (const name of ['recovery-code', 'authenticator', 'recovery-email']) {
    const at = stack.findIndex((layer) => layer.route && layer.route.path === `/${name}`);
    assert.ok(at !== -1, `route not found: ${name}`);
    assert.ok(
      at < limitAt,
      `${name} must be registered before requestLimiter so it keeps its own rate-limit budget`
    );
  }
});