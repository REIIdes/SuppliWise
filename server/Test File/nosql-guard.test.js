/**
 * OWASP A03/A01 — injection + broken access control, at the request boundary.
 *
 * The Mongo driver parameterizes every query, so the injection risk in this
 * stack is *operator injection*: a client sending `{"email": {"$ne": null}}`
 * or `?id[$gt]=` hands the driver a query OBJECT where a value was expected.
 * Credential routes type-check their own inputs; middleware/nosqlGuard.js is
 * the single rule that covers the whole surface, including routes added later.
 *
 * These tests drive the middleware directly (no server, no database) and then
 * assert where it is mounted, because a guard mounted after the routers or
 * after the body parsers guards nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { nosqlGuard } = require('../middleware/nosqlGuard');

function run(req) {
  let nextCalled = 0;
  nosqlGuard(req, {}, () => { nextCalled += 1; });
  assert.equal(nextCalled, 1, 'the guard must always call next()');
  return req;
}

test('query objects built by the extended qs parser lose every operator key', () => {
  const req = run({
    query: { email: { $ne: null }, id: { $gt: '', $where: 'sleep(5000)' } },
    params: {}, body: undefined,
  });
  assert.deepEqual(req.query, {}, 'operator payloads must not survive to a filter');
});

test('top-level body operators and prototype keys are removed, data is kept', () => {
  // Parsed exactly like a request body arrives: an object literal's `__proto__`
  // sets a prototype instead of creating a key, so only JSON.parse produces it.
  const req = run({
    query: {}, params: {},
    body: JSON.parse('{"$where":"x","a.b":1,"__proto__":{"polluted":true},"email":"a@b.com","age":30}'),
  });
  assert.deepEqual(Object.keys(req.body).sort(), ['age', 'email']);
  assert.equal(req.body.email, 'a@b.com', 'legitimate fields are untouched');
});

test('the canonical login bypass — a field whose value is an operator bag — is dropped', () => {
  const req = run({
    query: {}, params: {},
    body: JSON.parse('{"email":{"$ne":null},"password":{"$gt":""},"otp":{"$regex":".*"},"age":30}'),
  });
  assert.deepEqual(Object.keys(req.body), ['age'], 'operator-valued fields must not reach a filter');
});

test('a field that mixes data with an operator keeps its data', () => {
  // Only a value made ENTIRELY of operator keys is unambiguous attack input;
  // deleting a partly-legitimate payload would corrupt real requests.
  const req = run({ query: {}, params: {}, body: { email: { value: 'a@b.com', $gt: '' } } });
  assert.deepEqual(req.body.email, { value: 'a@b.com' });
});

test('nested operator keys are stripped inside stored blobs too, data survives', () => {
  // aiResults and friends are Mixed payloads, but an operator key is not data
  // anywhere — it is removed at every depth, exactly as the per-route persist
  // sites already scrub what they save.
  const req = run({
    query: {}, params: {},
    body: { aiResults: { plan: [{ name: 'Magnesium', $gt: 'x' }, { '$where': 'y', dose: '200mg' }] } },
  });
  assert.deepEqual(req.body.aiResults, { plan: [{ name: 'Magnesium' }, { dose: '200mg' }] });
});

test('a field that legitimately arrives as an empty object is left alone', () => {
  // `symptomSeverity: {}` is real client output. Only a field whose keys were
  // ALL operators disappears — deleting a pre-existing empty value would turn
  // "sent" into "not sent" and change what the route stores.
  const req = run({ query: {}, params: {}, body: { symptomSeverity: {} } });
  assert.deepEqual(req.body, { symptomSeverity: {} });
});

test('array bodies, missing bodies and junk never throw', () => {
  for (const body of [undefined, null, '', 42, [1, 2]]) {
    assert.doesNotThrow(() => run({ query: {}, params: {}, body }));
  }
  assert.doesNotThrow(() => run({ query: undefined, params: undefined, body: undefined }));
});

test('the guard is mounted after every JSON parser and before every router', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const guardAt = src.indexOf('app.use(nosqlGuard)');
  assert.ok(guardAt > -1, 'index.js must mount nosqlGuard');
  const lastParser = src.lastIndexOf('express.json({ limit: JSON_LIMIT_BYTES })');
  assert.ok(lastParser < guardAt, 'parsing has to happen before there is anything to scrub');
  const firstRouter = src.indexOf("app.use('/api/auth/password-reset'");
  assert.ok(firstRouter > guardAt, 'the guard must run ahead of the first router');
});

test('no route reads a credential-shaped query key without string coercion', () => {
  // The per-route type checks stay the primary defence; this asserts they were
  // not quietly removed in favour of the global guard.
  const login = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  const loginHandler = login.slice(login.indexOf("router.post('/login'"));
  assert.match(
    loginHandler.slice(0, 900),
    /typeof email !== 'string' \|\| typeof password !== 'string'/,
    'login must still reject non-string credentials itself',
  );
});
