const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  attackProbes,
  traversalProbePaths,
} = require('../utils/attack_probes');

const staticRoot = path.resolve(__dirname, '..', '..', 'my-react-app', 'dist');
const canary = 'SUPPLIWISE_TRAVERSAL_CANARY_DO_NOT_SERVE';

function fakeApp({ static = true } = {}) {
  return {
    locals: static ? { staticFileRoot: staticRoot } : {},
    _router: {
      stack: static ? [{ name: 'serveStatic' }] : [],
    },
  };
}

test('path-traversal payloads cover raw, encoded, and double-encoded separators', () => {
  const payloads = traversalProbePaths(staticRoot);

  assert.ok(payloads.some(value => value.includes('/../../server/utils/attack_probes.js')));
  assert.ok(payloads.some(value => value.includes('/%2e%2e/%2e%2e/server/utils/attack_probes')));
  assert.ok(payloads.some(value => value.includes('%2f')));
  assert.ok(payloads.some(value => value.includes('%252f')));
  assert.equal(new Set(payloads).size, payloads.length);
});

test('API-only mode reports healthy without making filesystem probe requests', async () => {
  let called = false;
  const result = await attackProbes.path_traversal(fakeApp({ static: false }), async () => {
    called = true;
    return { status: 404, body: 'Not found' };
  });

  assert.equal(result.status, 'healthy');
  assert.equal(called, false);
});

test('a fixed-root static server passes when every traversal payload is blocked', async () => {
  const attempted = [];
  const result = await attackProbes.path_traversal(fakeApp(), async (rawPath) => {
    attempted.push(rawPath);
    return { status: 404, body: 'Not found' };
  });

  assert.equal(result.status, 'healthy');
  assert.equal(attempted.length, traversalProbePaths(staticRoot).length);
});

test('the probe reports critical when a traversal response exposes a server file', async () => {
  let call = 0;
  const result = await attackProbes.path_traversal(fakeApp(), async () => {
    call += 1;
    return call === 2
      ? { status: 200, body: `source\n${canary}\n` }
      : { status: 404, body: 'Not found' };
  });

  assert.equal(result.status, 'critical');
  assert.match(result.detail, /exposed a server file/i);
  assert.doesNotMatch(result.detail, new RegExp(canary));
});

test('a local connection failure is a warning rather than a false healthy result', async () => {
  const result = await attackProbes.path_traversal(fakeApp(), async () => {
    throw new Error('connection refused');
  });

  assert.equal(result.status, 'warning');
  assert.match(result.detail, /could not complete/i);
});

test('partial probe failure is a warning because full payload coverage is required', async () => {
  let call = 0;
  const result = await attackProbes.path_traversal(fakeApp(), async () => {
    call += 1;
    if (call === 1) throw new Error('one timed-out probe');
    return { status: 404, body: 'Not found' };
  });

  assert.equal(result.status, 'warning');
  assert.match(result.detail, /1 of 6/);
});
