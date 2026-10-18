/**
 * OWASP Top 10 — the in-repo self-attack suite.
 *
 * `utils/attack_probes.js` is what the admin Security Center runs live. This
 * file pins the same checks into `npm test`, so a protection can only be
 * removed deliberately: the probe itself has to be edited, not just a route.
 *
 * Only the probes that need neither a database nor a listening server are run
 * here; the self-HTTP ones (rate limits, headers, enumeration) live in their own
 * suites and in the monitor, where the server is actually up.
 */

const test = require('node:test');
const assert = require('node:assert');

const { attackProbes } = require('../utils/attack_probes');

const OFFLINE = [
  ['nosql_injection', 'A03 Injection — Mongo operator payloads at the request boundary'],
  ['command_injection', 'A03 Injection — no shell or dynamic code evaluation in request paths'],
  ['ssrf_outbound', 'SSRF — no server-side request targets a client-supplied URL'],
  ['xxe_ssti', 'XXE + SSTI — no XML parser, no template engine reachable'],
  ['insecure_deserialization', 'A08 — only JWT (pinned HS256) is accepted as a serialized object'],
  ['access_control_default_deny', 'A01 — every registered route is gated or explicitly public'],
  ['prototype_pollution', 'A05 misconfig — __proto__ keys cannot reach Object.prototype'],
  ['csrf_stateless', 'CSRF — header-borne bearer tokens, no cookie session to forge'],
];

for (const [key, label] of OFFLINE) {
  test(`${key} — ${label}`, async () => {
    const result = await attackProbes[key]({});
    assert.equal(
      result.status,
      'healthy',
      `${label} is not satisfied: [${result.status}] ${result.detail}`,
    );
  });
}

test('the probe set covers every category the security checklist names', () => {
  // A category can only be verified if a probe exists for it; this list is the
  // contract, and it fails when a probe is deleted rather than silently passing.
  for (const [key] of OFFLINE) {
    assert.equal(typeof attackProbes[key], 'function', `missing probe: ${key}`);
  }
});

test('every registered probe has a Security Center label', () => {
  // The monitor map in routes/admin.js turns a probe key into the row an admin
  // reads. A probe registered without a label still RUNS and reports, but shows
  // up as a bare snake_case key — the failure is invisible to whoever wrote it
  // and obvious to whoever has to interpret the dashboard.
  const fs = require('node:fs');
  const path = require('node:path');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  for (const key of Object.keys(attackProbes)) {
    assert.ok(
      new RegExp(`(^|[{,\\s])'?${key}'?\\s*:\\s*\\[`, 'm').test(admin),
      `${key} is registered as a probe but has no label entry in routes/admin.js`,
    );
  }
});
