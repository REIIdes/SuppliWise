/**
 * DDoS / flood resilience stress test.
 *
 * SAFETY: only ever talks to a loopback address and refuses to run against
 * anything else, so it can never be aimed at a system you do not own.
 *
 *     node test-ddos-resilience.js            # http://127.0.0.1:5000
 *     PORT=5010 node test-ddos-resilience.js  # a different local instance
 *
 * What it decides:
 *   1. Baseline     — is it healthy and fast with no load?
 *   2. Concurrency  — does it degrade gracefully, or collapse?
 *   3. Body flood   — is a declared large body refused from its HEADERS, i.e.
 *                     before it is buffered? (express.json() mounted above the
 *                     limiters means the body is read, then counted — the
 *                     limiter protects something already spent). Proven by
 *                     announcing 4 MB, sending 4 KB and never finishing: a
 *                     reply can only arrive early if nothing was waited for.
 *   4. Oversize     — is the parser's hard cap cheap?
 *   5. Metering     — does EVERY /api path emit RateLimit headers? A path
 *                     without them (e.g. /api/health, the JSON 404) is an
 *                     unbounded source of cheap requests.
 *   6. Engagement   — does a sustained flood actually get a 429, and does the
 *                     API recover on its own afterwards?
 *
 * Exit 0 = pass, 1 = fail, 2 = server unreachable / not loopback.
 */

const http = require('http');
const { URL } = require('url');

const HOST = process.env.STRESS_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 5000);
const BASE = `http://${HOST}:${PORT}`;

// ── Loopback guard ─────────────────────────────────────────────────────────
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const isLoopback = (h) => LOOPBACK.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
if (!isLoopback(HOST)) {
  console.error(`REFUSED: "${HOST}" is not loopback. This harness only tests your own local instance.`);
  process.exit(2);
}

// ── Instrumentation ────────────────────────────────────────────────────────
const tally = { ok: 0, rateLimited: 0, shed: 0, clientErr: 0, serverErr: 0, connErr: 0, timeouts: 0 };
const samples = [];
// (Latency is sampled into `samples`; early-rejection timing is measured
//  explicitly by dribbleRequest, which is the only place it means anything.)
const messages = new Map();           // first-seen response message per bucket
const connErrors = new Map();         // ECONNREFUSED / ECONNRESET / ... counts

function bucketOf(status) {
  if (status === 429) return 'rateLimited';
  if (status === 503) return 'shed';   // intentional backpressure, not a bug
  if (status >= 500) return 'serverErr';
  if (status >= 400) return 'clientErr';
  return 'ok';
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/**
 * One request. Never throws — failures are tallied, so a flood cannot hide
 * its own error rate behind an unhandled rejection.
 */
function request(method, path, { body = null, headers = {}, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const url = new URL(path, BASE);
    const payload = body == null ? null : Buffer.from(body);
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => { bytes += c.length; if (chunks.length < 1) chunks.push(c); });
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          const bucket = bucketOf(res.statusCode);
          tally[bucket] += 1;
          samples.push(ms);
          if (!messages.has(bucket) && chunks.length) {
            try { messages.set(bucket, JSON.parse(chunks.join('')).message || ''); } catch { /* not JSON */ }
          }
          resolve({ status: res.statusCode, ms, bytes, headers: res.headers });
        });
      }
    );
    req.setTimeout(timeout, () => {
      tally.timeouts += 1;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      req.destroy(new Error('timeout'));
      samples.push(ms);
      resolve({ status: 0, ms, error: 'timeout' });
    });
    req.on('error', (e) => {
      tally.connErr += 1;
      const code = e.code || e.name || 'unknown';
      connErrors.set(code, (connErrors.get(code) || 0) + 1);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      samples.push(ms);
      resolve({ status: 0, ms, error: code });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Declare a large body, upload a token slice of it, and never finish.
 *
 * This is the only honest way to ask "was the request rejected from its
 * HEADERS?" Measuring end-to-end latency of a full 4 MB upload instead asks
 * "how fast can this client push 320 MB on a loaded box" — a question about
 * the harness, not the server, and it reports seconds no matter how quickly
 * the server answered. Here the status arrives while the body is still
 * incomplete, so a reply proves the server never waited for (or read) it.
 *
 * Returns `{ status, ms, early }`; `early` means a response arrived before the
 * declared body had been sent at all.
 */
function dribbleRequest(path, declareBytes, firstChunkBytes, waitMs, method = 'POST') {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const url = new URL(path, BASE);
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': declareBytes },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          clearTimeout(timer);
          finish({ status: res.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6, early: true });
          req.destroy();
        });
      },
    );

    const timer = setTimeout(() => {
      finish({ status: 0, ms: Number(process.hrtime.bigint() - started) / 1e6, early: false, timeout: true });
      req.destroy();
    }, waitMs);

    req.on('error', () => {
      clearTimeout(timer);
      finish({ status: 0, ms: Number(process.hrtime.bigint() - started) / 1e6, early: false, error: true });
    });

    // Deliberately never `req.end()` — the body stays incomplete by design.
    req.write(Buffer.alloc(firstChunkBytes, 0x61));
  });
}

async function ramp(label, total, concurrency, fn) {
  const before = { ...tally };
  const beforeSamples = samples.length;
  const t0 = process.hrtime.bigint();
  let launched = 0;
  const worker = async () => { while (launched < total) { const i = launched++; await fn(i); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const d = Object.fromEntries(Object.keys(tally).map((k) => [k, tally[k] - before[k]]));
  const win = samples.slice(beforeSamples);
  console.log(`  ${label}`);
  console.log(`    rps=${(total / secs).toFixed(1)}  p50=${percentile(win, 50).toFixed(1)}ms  p95=${percentile(win, 95).toFixed(1)}ms  p99=${percentile(win, 99).toFixed(1)}ms`);
  console.log(`    200=${d.ok}  429=${d.rateLimited}  503_shed=${d.shed}  4xx=${d.clientErr}  5xx=${d.serverErr}  conn_err=${d.connErr}  timeouts=${d.timeouts}`);
  return { secs, ...d };
}

/** "Alive" means it answers. A 429 proves liveness AND that metering works. */
async function alive(label) {
  const r = await request('GET', '/api/health', { timeout: 5000 });
  const ok = r.status === 200 || r.status === 429;
  console.log(`  ${label}: ${ok ? `RESPONSIVE (${r.status})` : `DOWN (status=${r.status}, ${r.error || 'n/a'})`}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Advertised bucket size and window (seconds) from the standard headers.
 * RateLimit-Policy looks like "600;w=60". The window matters as much as the
 * limit: a bucket that only refills after 10 minutes cannot be tripped *and*
 * recovered from inside a test run, so engagement is proven on a fast bucket.
 */
function limitInfo(res) {
  const raw = res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit'] || '';
  const limit = Number(raw);
  const policy = String(res.headers['ratelimit-policy'] || '');
  const w = /(?:^|[;\s])w=(\d+)/.exec(policy);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 0,
    window: w ? Number(w[1]) : 0,
  };
}

async function main() {
  const failures = [];
  const notes = [];
  console.log(`\nDDoS resilience stress test → ${BASE} (loopback only)\n`);

  // ── 0. Reachability ──────────────────────────────────────────────────────
  const first = await request('GET', '/api/health', { timeout: 5000 });
  if (first.status === 0) {
    console.error(`Server unreachable at ${BASE} — start it first (npm start in server/).`);
    process.exit(2);
  }
  console.log(`[0] Reachable: ${first.status} in ${first.ms.toFixed(1)}ms`);

  // ── 1. Baseline ──────────────────────────────────────────────────────────
  console.log('\n[1] Baseline (no load)');
  await ramp('200 sequential GET /api/health', 200, 1, () => request('GET', '/api/health'));

  // ── 2. Concurrency ───────────────────────────────────────────────────────
  console.log('\n[2] Concurrency ramp (GET /api/health)');
  await ramp('50 concurrent', 500, 50, () => request('GET', '/api/health'));
  await ramp('200 concurrent', 2000, 200, () => request('GET', '/api/health'));
  if (!(await alive('Post-concurrency liveness'))) failures.push('API went down under plain concurrency.');

  // ── 3. Body flood ────────────────────────────────────────────────────────
  // 3a asks the decisive question directly: is an oversized body rejected
  // BEFORE it arrives? Six requests each announce a body far past their
  // route's cap, push 4 KB, then go quiet. A status back while the body is
  // still incomplete can only happen if the server read headers alone.
  //
  // Both caps are probed, because they are enforced by separate mounts: the
  // blanket 1 mb parser, and the widened 10 mb parser scoped to the two
  // base64-picture routes. A bug in either mount shows up as silence here.
  //
  // This matters more than it looks. body-parser's own 413 path calls dump(),
  // which drains the whole request before responding — so without the header
  // guard an oversized body costs a full upload to refuse, and one that stops
  // mid-flight gets no answer at all.
  const dribbleCases = [
    { label: 'blanket 1 MB cap', path: '/api/chat', method: 'POST', declare: 4 * 1024 * 1024 },
    { label: 'scoped 10 MB cap', path: '/api/auth/profile', method: 'PUT', declare: 12 * 1024 * 1024 },
  ];
  for (const c of dribbleCases) {
    console.log(`\n[3a] Header-only rejection — ${c.label}: declare ${(c.declare / 1048576).toFixed(0)} MB, send 4 KB, never finish`);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => dribbleRequest(c.path, c.declare, 4096, 3000, c.method)),
    );
    const answered = results.filter((r) => r.status !== 0);
    const ms = answered.map((r) => r.ms);
    console.log(`    answered before the body completed: ${answered.length}/${results.length}`
      + `  statuses=${[...new Set(answered.map((r) => r.status))].join(',') || '—'}`
      + `  p50=${percentile(ms, 50).toFixed(1)}ms`);
    if (answered.length < results.length) {
      failures.push(`${results.length - answered.length} of ${results.length} oversized requests to ${c.path} waited for the body`
        + ' instead of being refused from headers — a body flood would have to be uploaded in full before it can be turned away.');
    } else if (percentile(ms, 50) > 1000) {
      failures.push(`Header-only rejections on ${c.path} took p50=${percentile(ms, 50).toFixed(0)}ms — far slower than a header check.`);
    } else if (answered.some((r) => r.status !== 413)) {
      failures.push(`Oversized requests to ${c.path} answered ${[...new Set(answered.map((r) => r.status))].join(',')} instead of 413.`);
    } else {
      console.log('    ✓ refused 413 from headers alone; the body never touched memory.');
    }
  }

  // 3b floods real volume to make sure surviving that is harmless. It targets
  // /api/chat, not an auth path: an auth flood spends the brute-force budget,
  // and a repeated run could escalate the lockout ladder against the very IP
  // running the test. Latency is NOT asserted here — end-to-end time includes
  // this client pushing ≈320 MB, which measures the harness, not the server.
  console.log('\n[3b] Volume flood — 80 x 4 MB JSON POSTed concurrently (≈320 MB offered)');
  const flood = await ramp('80 x 4 MB concurrent', 80, 80, () => request('POST', '/api/chat', {
    body: JSON.stringify({ message: 'a'.repeat(4 * 1024 * 1024) }),
    timeout: 30000,
  }));
  const shedNow = flood.shed + flood.clientErr;
  console.log(`    turned away=${shedNow}/80  (503 budget=${flood.shed}, 413 too-large=${flood.clientErr}, 429=${flood.rateLimited})`);
  if (shedNow === 0) failures.push('Every 4 MB body was accepted during the flood — neither the size cap nor the in-flight budget engaged.');
  else if (flood.serverErr > 0) failures.push(`${flood.serverErr} x 5xx during the body flood — the flood reached application code.`);
  if (!(await alive('Post-flood liveness'))) failures.push('API went down after the body flood.');

  // ── 4. Oversized body ────────────────────────────────────────────────────
  console.log('\n[4] Oversized body — 6 concurrent 20 MB bodies vs the 10 MB cap');
  const over = await ramp('6 x 20 MB', 6, 6, () => request('POST', '/api/auth/register', {
    body: JSON.stringify({ email: 'b'.repeat(20 * 1024 * 1024) }),
    timeout: 30000,
  }));
  const rejected = over.shed + over.clientErr + over.rateLimited;
  console.log(`    rejected=${rejected}/6 (Content-Length is checked before reading, so this stays cheap)`);
  if (rejected === 0) failures.push('Oversized bodies were not rejected.');

  // ── 5. Metering coverage ─────────────────────────────────────────────────
  // Every /api path must carry RateLimit headers. A path without them is an
  // unbounded cheap-request source — the exact gap this harness exists for.
  console.log('\n[5] Metering coverage — do all /api paths emit RateLimit headers?');
  const probePaths = [
    ['GET', '/api/health'],
    ['GET', '/api/definitely-not-a-route'],
    ['GET', '/api/auth/me'],
    ['GET', '/api/dashboard'],
    ['GET', '/api/web3/chain'],
  ];
  const unmetered = [];
  for (const [m, p] of probePaths) {
    const r = await request(m, p, { timeout: 5000 });
    const hdr = r.headers['ratelimit-limit'] || r.headers['x-ratelimit-limit'];
    const tag = hdr ? `limit=${hdr}` : 'NO LIMIT';
    if (!hdr) unmetered.push(p);
    console.log(`    ${p.padEnd(32)} status=${String(r.status).padEnd(4)} ratelimit=${tag}`);
  }
  if (unmetered.length > 0) {
    failures.push(`Unmetered /api path(s): ${unmetered.join(', ')} — unbounded request source.`);
  }

  // ── 6. Engagement + recovery ─────────────────────────────────────────────
  // Probe the advertised buckets and pick the TIGHTEST one that also refills
  // fast. Flooding /api/health (12000/min) cannot prove anything: at any
  // achievable request rate you outrun your own window before you reach the
  // ceiling, so you finish having sent 12 000 requests and still never seen a
  // 429 — a false negative that reads like "rate limiting is broken".
  console.log('\n[6] Metering engagement — trip the tightest fast bucket, then recover');
  const candidates = ['/api/recommend', '/api/dashboard', '/api/chat', '/api/assessment', '/api/health'];
  let target = null;
  let targetInfo = null;
  for (const p of candidates) {
    const r = await request('GET', p);
    const info = limitInfo(r);
    const usable = info.limit > 0 && info.window > 0 && info.window <= 120;
    if (usable && (!targetInfo || info.limit < targetInfo.limit)) { target = p; targetInfo = info; }
    console.log(`    ${p.padEnd(22)} status=${String(r.status).padEnd(4)} limit=${info.limit || '—'} window=${info.window || '—'}s${usable ? '  ← candidate' : ''}`);
  }

  if (!target) {
    failures.push('No path advertised a fast (≤120 s) rate-limit bucket — cannot verify engagement.');
  } else {
    const preStatus = (await request('GET', target)).status;
    const budget = targetInfo.limit + 15;
    console.log(`    tightest fast bucket: ${target} @ ${targetInfo.limit}/${targetInfo.window}s → sending ${budget}`);
    const hit = await ramp('flood until 429', budget, Math.min(120, budget), () => request('GET', target));

    if (hit.rateLimited === 0) {
      failures.push(`Sent ${budget} requests past the advertised limit of ${targetInfo.limit} on ${target} and never got a 429 — rate limiting is not engaging.`);
    } else {
      console.log(`    ✓ throttled: ${hit.rateLimited} x 429`);
      // Still answering while throttled? That is availability under attack.
      const during = await request('GET', target);
      if (during.status === 0) failures.push('API stopped responding at the moment it started throttling.');

      // Recovery must be observed on the SAME bucket, on its own clock.
      const waitCap = Math.min(targetInfo.window * 1000 + 15000, 90000);
      const t0 = Date.now();
      let recovered = false;
      while (Date.now() - t0 < waitCap) {
        const r = await request('GET', target, { timeout: 5000 });
        if (r.status !== 429 && r.status !== 0) { recovered = true; break; }
        await sleep(2000);
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      if (recovered) console.log(`    ✓ recovered on ${target} after ${secs}s without a restart (expected status ${preStatus})`);
      else failures.push(`${target} never stopped returning 429 within ${Math.round(waitCap / 1000)}s — it did not recover on its own.`);
    }
  }

  if (!(await alive('Final liveness'))) failures.push('API unresponsive at the end of the run.');

  return report(failures, notes);
}

function report(failures, notes) {
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  console.log('\n────────── SUMMARY ──────────');
  console.log(`requests=${total}  200=${tally.ok}  429=${tally.rateLimited}  503=${tally.shed}  4xx=${tally.clientErr}  5xx=${tally.serverErr}  conn_err=${tally.connErr}  timeouts=${tally.timeouts}`);
  if (tally.shed > 0) console.log(`  ${tally.shed} x 503 = deliberate backpressure (in-flight JSON budget) — load shed, not a failure.`);
  console.log(`latency p50=${percentile(samples, 50).toFixed(1)}ms  p95=${percentile(samples, 95).toFixed(1)}ms  p99=${percentile(samples, 99).toFixed(1)}ms`);
  for (const [bucket, msg] of messages) if (msg) console.log(`  sample ${bucket}: "${msg}"`);
  if (tally.serverErr > 0) failures.push(`${tally.serverErr} 5xx response(s) under load.`);
  if (connErrors.size > 0) {
    const detail = [...connErrors].map(([k, v]) => `${k}=${v}`).join('  ');
    console.log(`  connection errors: ${detail}`);
    if (connErrors.has('ECONNREFUSED')) {
      console.log('  ⚠ ECONNREFUSED means the listener was gone mid-run — a crash, a restart, or an external');
      console.log('    process (e.g. nodemon recompiling on a file edit). Check the server log before blaming load.');
    }
  }
  if (tally.connErr + tally.timeouts > 0) {
    const detail = [...connErrors].map(([k, v]) => `${k}=${v}`).join(', ');
    failures.push(`${tally.connErr + tally.timeouts} dropped/timed-out request(s)${detail ? ` [${detail}]` : ''}.`);
  }
  if (tally.rateLimited === 0) failures.push('No 429 observed anywhere in the run.');
  for (const n of notes) console.log(`  note: ${n}`);

  if (failures.length === 0) {
    console.log('\nRESULT: PASS — stayed up, stayed correct, metered abuse, recovered.\n');
    process.exit(0);
  }
  console.log('\nRESULT: FAIL');
  for (const f of [...new Set(failures)]) console.log(`  ✗ ${f}`);
  console.log('');
  process.exit(1);
}

main().catch((err) => {
  console.error('stress harness crashed:', err);
  process.exit(1);
});
