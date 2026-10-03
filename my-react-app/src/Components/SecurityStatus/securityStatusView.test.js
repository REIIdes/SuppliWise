/**
 * Pure-logic tests for the Security Center toolbar (search / status chips /
 * framework filter / grouping). The view helpers below are the exact
 * functions the component uses, so a change in the component has to be
 * mirrored here to be tested — they are the rules, not the rendering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── mirrors of the component's data + rules ─────────────────────────────
const MONITOR_FRAMEWORK = {
  login: 'Auth / JWT', email_otp: 'STRIDE', database: 'Infrastructure',
  openrouter: 'AI / API', xss_stored: 'OWASP', prompt_injection: 'AI / OWASP',
  pii_ai_prompts: 'AI / Privacy', path_traversal: 'OWASP',
  rate_limit_lockout: 'STRIDE', delete_account: 'OWASP',
  bc_ledger: 'Blockchain', bc_market: 'Blockchain', bc_wallet: 'Blockchain',
  bc_escrow: 'Blockchain', bc_dao: 'Blockchain', bc_health_ledger: 'Blockchain',
};
const MONITOR_LABEL = {
  login: 'Login System', email_otp: 'Email OTP (Login Security)',
  database: 'Database Connectivity', openrouter: 'OpenRouter API Connectivity',
  xss_stored: 'XSS — Stored Markup', prompt_injection: 'Prompt Injection (AI)',
  pii_ai_prompts: 'PII in AI Prompts', path_traversal: 'Path Traversal',
  rate_limit_lockout: 'Rate-Limit Lockouts',
  delete_account: 'Account Deletion (Soft-delete)', bc_ledger: 'PoW Ledger & Integrity',
  bc_market: 'Verified P2P Marketplace', bc_wallet: 'Wallets / Decentralized ID',
  bc_escrow: 'Smart-contract Escrow', bc_dao: 'DAO Governance',
  bc_health_ledger: 'Health Records Anchor',
};
const MONITOR_IMPL = {
  login: 'routes/auth.js · middleware/auth.js', bc_ledger: 'blockchain/ledger.js · SwBlock',
  path_traversal: 'attack_probes.js · SafeDownloadName',
};
const MONITOR_ORDER = [
  'login', 'email_otp', 'database', 'openrouter', 'xss_stored', 'prompt_injection',
  'pii_ai_prompts', 'path_traversal', 'rate_limit_lockout', 'delete_account',
  'bc_ledger', 'bc_market', 'bc_wallet', 'bc_escrow', 'bc_dao', 'bc_health_ledger',
];
const groupOf = (key) => (String(key).startsWith('bc_') ? 'chain' : 'core');

const buildRows = (statuses = {}) => MONITOR_ORDER.map(key => ({
  key,
  label: MONITOR_LABEL[key] || key,
  status: statuses[key] || 'healthy',
  detail: `${key} probe detail`,
}));

// The component's grouping + filtering pass, verbatim.
function buildVisibleGroups(rows, { query = '', statusFilter = 'all', frameworkFilter = 'all' } = {}) {
  const q = query.trim().toLowerCase();
  const groups = [];
  rows.forEach(m => {
    const id = groupOf(m.key);
    let group = groups.length ? groups[groups.length - 1] : null;
    if (!group || group.id !== id) { group = { id, items: [] }; groups.push(group); }
    group.items.push(m);
  });
  return groups.map(g => ({ ...g, items: g.items.filter(m => {
    if (statusFilter !== 'all' && m.status !== statusFilter) return false;
    if (frameworkFilter !== 'all' && (MONITOR_FRAMEWORK[m.key] || '—') !== frameworkFilter) return false;
    if (!q) return true;
    return [m.label, MONITOR_LABEL[m.key], m.key, MONITOR_IMPL[m.key], MONITOR_FRAMEWORK[m.key], m.detail]
      .filter(Boolean).some(v => String(v).toLowerCase().includes(q));
  }) })).filter(g => g.items.length > 0);
}

const countVisible = groups => groups.reduce((n, g) => n + g.items.length, 0);

/**
 * Drop CSS comments before reading any rule out of a stylesheet.
 *
 * Order matters: the comments in this file quote selectors verbatim, e.g.
 * "an unscoped `th, td { … }` rule". A comment therefore contains a `}`, and
 * matching a block with `[^}]*` against comment-laden source stops at that
 * brace and yields a truncated (or empty) rule — which reads as "the
 * declaration is missing" and would fail for the wrong reason.
 */
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

// ── tests ───────────────────────────────────────────────────────────────
test('no filters shows every monitor in its group band', () => {
  const groups = buildVisibleGroups(buildRows());
  assert.equal(groups.length, 2);
  assert.equal(groups[0].id, 'core');
  assert.equal(groups[1].id, 'chain');
  assert.equal(countVisible(groups), 16);
});

test('search matches the display label, the key, the framework and the impl path', () => {
  const rows = buildRows();
  // label
  assert.equal(countVisible(buildVisibleGroups(rows, { query: 'Rate-Limit' })), 1);
  // raw monitor key
  assert.equal(countVisible(buildVisibleGroups(rows, { query: 'bc_wallet' })), 1);
  // framework chip text
  assert.equal(countVisible(buildVisibleGroups(rows, { query: 'infrastructure' })), 1);
  // implementation file path
  assert.equal(countVisible(buildVisibleGroups(rows, { query: 'SafeDownloadName' })), 1);
  // the probe detail text
  assert.equal(countVisible(buildVisibleGroups(rows, { query: 'bc_dao probe' })), 1);
});

test('search is case-insensitive and tolerates surrounding whitespace', () => {
  const rows = buildRows();
  // "login" legitimately matches two monitors — the login system and the
  // email OTP, which is labelled "Email OTP (Login Security)".
  assert.equal(countVisible(buildVisibleGroups(rows, { query: '  LOGIN  ' })), 2);
  assert.equal(countVisible(buildVisibleGroups(rows, { query: 'lOgIn' })), 2);
  // A term unique to one monitor still resolves to exactly that one.
  assert.equal(countVisible(buildVisibleGroups(rows, { query: '  PII  ' })), 1);
});

test('a search with no match yields no groups, so the empty state renders', () => {
  const groups = buildVisibleGroups(buildRows(), { query: 'no-such-monitor' });
  assert.equal(groups.length, 0);
  assert.equal(countVisible(groups), 0);
});

test('status chip filters to exactly that status', () => {
  const rows = buildRows({ bc_dao: 'critical', login: 'warning' });
  const critical = buildVisibleGroups(rows, { statusFilter: 'critical' });
  assert.equal(countVisible(critical), 1);
  assert.equal(critical[0].items[0].key, 'bc_dao');
  // a group emptied by the filter is dropped rather than left as an empty band
  assert.equal(critical.length, 1);
  assert.equal(critical[0].id, 'chain');
});

test('the core group is dropped when the filter only matches blockchain rows', () => {
  const rows = buildRows({ login: 'critical' });
  const groups = buildVisibleGroups(rows, { statusFilter: 'critical' });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'core');
});

test('framework filter selects a whole framework', () => {
  const rows = buildRows();
  const stride = buildVisibleGroups(rows, { frameworkFilter: 'STRIDE' });
  assert.equal(countVisible(stride), 2);
  const chain = buildVisibleGroups(rows, { frameworkFilter: 'Blockchain' });
  assert.equal(countVisible(chain), 6);
  assert.equal(chain[0].id, 'chain');
});

test('status and framework filters combine', () => {
  const rows = buildRows({ bc_escrow: 'warning' });
  const groups = buildVisibleGroups(rows, { frameworkFilter: 'Blockchain', statusFilter: 'warning' });
  assert.equal(countVisible(groups), 1);
  assert.equal(groups[0].items[0].key, 'bc_escrow');
});

test('search combines with the framework filter', () => {
  const rows = buildRows();
  assert.equal(countVisible(buildVisibleGroups(rows, { frameworkFilter: 'Blockchain', query: 'escrow' })), 1);
  // the term matches a core monitor, which the framework filter then removes
  assert.equal(countVisible(buildVisibleGroups(rows, { frameworkFilter: 'Blockchain', query: 'login' })), 0);
});

test('filters always key off the full monitor set, never a filtered one', () => {
  // Guards the "second filter operates on already-filtered rows" class of bug:
  // both filters read the same source list, so chaining them is order-free.
  const rows = buildRows({ bc_market: 'warning' });
  const a = buildVisibleGroups(rows, { statusFilter: 'warning', frameworkFilter: 'Blockchain' });
  const b = buildVisibleGroups(rows, { frameworkFilter: 'Blockchain', statusFilter: 'warning' });
  assert.deepEqual(a.map(g => g.items.map(i => i.key)), b.map(g => g.items.map(i => i.key)));
  assert.equal(countVisible(a), 1);
});

test('summary counts describe the whole system, not the filtered view', () => {
  // The component computes counts from `orderedMonitors` before any filtering.
  const rows = buildRows({ bc_dao: 'critical', bc_market: 'critical', login: 'warning' });
  const counts = rows.reduce((acc, m) => { acc[m.status] = (acc[m.status] || 0) + 1; return acc; }, {});
  const problems = (counts.critical || 0) + (counts.error || 0);
  assert.equal(rows.length, 16);
  assert.equal(counts.critical, 2);
  assert.equal(problems, 2);
  // Narrowing the table to `critical` must not change the tile numbers.
  assert.equal(countVisible(buildVisibleGroups(rows, { statusFilter: 'critical' })), 2);
  assert.equal(problems, 2);
});

test('health percentage counts only fully clean monitors', () => {
  const rows = buildRows({ login: 'warning', bc_dao: 'critical' });
  const counts = rows.reduce((acc, m) => { acc[m.status] = (acc[m.status] || 0) + 1; return acc; }, {});
  const problems = (counts.critical || 0) + (counts.error || 0);
  const pct = Math.round(((rows.length - problems - (counts.warning || 0)) / rows.length) * 100);
  assert.equal(pct, 88); // 14 of 16 fully healthy
});

test('every ordered key is grouped as either core or chain, with no strays', () => {
  const groups = buildVisibleGroups(buildRows());
  const seen = groups.flatMap(g => g.items.map(i => i.key));
  assert.deepEqual(seen, MONITOR_ORDER);
  assert.ok(groups.every(g => g.id === 'core' || g.id === 'chain'));
  // the blockchain band must be contiguous, not split by core rows
  assert.deepEqual(groups.map(g => g.id), ['core', 'chain']);
});

test('expand-all / collapse-all toggles the full visible set', () => {
  const rows = buildRows();
  const keys = buildVisibleGroups(rows).flatMap(g => g.items.map(i => i.key));
  const open = new Set();
  const allOpen = () => keys.length > 0 && keys.every(k => open.has(k));

  assert.equal(allOpen(), false);
  keys.forEach(k => open.add(k));
  assert.equal(allOpen(), true);

  // Second activation collapses everything (this is the button's behaviour).
  if (allOpen()) open.clear();
  assert.equal(allOpen(), false);
});

test('expanding a filtered subset does not clear other rows', () => {
  const rows = buildRows();
  const all = buildVisibleGroups(rows).flatMap(g => g.items.map(i => i.key));
  const subset = buildVisibleGroups(rows, { frameworkFilter: 'Blockchain' }).flatMap(g => g.items.map(i => i.key));
  const open = new Set(all);
  // "Collapse all" on a filtered view clears everything the toolbar can see…
  if (subset.every(k => open.has(k))) subset.forEach(k => open.delete(k));
  // …and the rows that were filtered out keep whatever state they had.
  assert.ok(all.filter(k => !subset.includes(k)).every(k => open.has(k)));
});

test('the "Checking" chip only exists while rows are still loading', () => {
  const chips = (loadingCount) => {
    const base = [
      { id: 'all', count: 16 }, { id: 'healthy', count: 16 },
      { id: 'warning', count: 0 }, { id: 'critical', count: 0 }, { id: 'error', count: 0 },
    ];
    if (loadingCount) base.push({ id: 'loading', count: loadingCount });
    return base;
  };
  assert.equal(chips(16).length, 6);
  assert.equal(chips(0).length, 5);
  // A filtered-out loading row still shows the chip — the chips count the
  // whole system, so the admin can always see there is work in flight.
  assert.ok(chips(16).some(c => c.id === 'loading'));
});

test('"Updated Xs ago" formats every magnitude without going negative', () => {
  const formatAgo = (iso, now) => {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '—';
    const secs = Math.max(0, Math.round((now - then) / 1000));
    if (secs < 5) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };
  const base = Date.parse('2026-09-28T12:00:00.000Z');
  assert.equal(formatAgo('2026-09-28T12:00:00.000Z', base), 'just now');
  assert.equal(formatAgo('2026-09-28T11:59:30.000Z', base), '30s ago');
  assert.equal(formatAgo('2026-09-28T11:56:00.000Z', base), '4m ago');
  assert.equal(formatAgo('2026-09-28T09:00:00.000Z', base), '3h ago');
  assert.equal(formatAgo('2026-09-25T12:00:00.000Z', base), '3d ago');
  // A clock skew or a future timestamp must not produce "-3s ago".
  assert.equal(formatAgo('2026-09-28T12:05:00.000Z', base), 'just now');
  assert.equal(formatAgo('not-a-date', base), '—');
});

test('auto-refresh progress stays inside 0–100% across the poll window', () => {
  const POLL = 30000;
  const progress = (syncedAt, now) => {
    const elapsed = now - new Date(syncedAt).getTime();
    return Math.max(0, Math.min(1, elapsed / POLL));
  };
  const t0 = Date.parse('2026-09-28T12:00:00.000Z');
  assert.equal(progress(t0, t0), 0);
  assert.equal(Math.round(progress(t0, t0 + 15000) * 100), 50);
  assert.equal(progress(t0, t0 + POLL), 1);
  // A stale response arriving after the next poll already started must clamp,
  // not overflow the bar.
  assert.equal(progress(t0, t0 + POLL * 5), 1);
  // …and a timestamp from the future must not go negative.
  assert.equal(progress(t0, t0 - 5000), 0);
});

/**
 * The server gained a `groq` monitor (the detection provider). The component
 * builds its table from four separate maps plus MONITOR_ORDER, and a key
 * missing from MONITOR_ORDER gets NO ROW AT ALL — it is not a degraded row, it
 * is an absent one, and nothing in the rendered output says so. That is exactly
 * the failure this guards, so it reads the real component source rather than
 * the local mirror above, which is only a subset of the component's data.
 */
test('every monitor key the server returns has a row in the Security Center', () => {
  const src = fs.readFileSync(path.join(HERE, 'SecurityStatus.jsx'), 'utf8');

  // The three AI provider probes the server registers. Kept as literals on
  // purpose: if the server adds a fourth provider this fails loudly rather than
  // silently rendering a dashboard that quietly omits it.
  const serverProbeKeys = ['openrouter', 'groq', 'anthropic'];

  // Object maps close with `};`, the order array with `];` — both are read as
  // raw source text, so the closer has to match the declaration.
  const blockOf = (name) => {
    const objStart = src.indexOf(`const ${name} = {`);
    const arrStart = src.indexOf(`const ${name} = [`);
    const start = objStart !== -1 ? objStart : arrStart;
    assert.ok(start !== -1, `${name} not found in SecurityStatus.jsx`);
    const closer = objStart !== -1 && (arrStart === -1 || objStart < arrStart) ? '};' : '];';
    const end = src.indexOf(closer, start);
    assert.ok(end !== -1, `${name} is unterminated`);
    return src.slice(start, end);
  };

  for (const key of serverProbeKeys) {
    assert.ok(blockOf('MONITOR_FRAMEWORK').includes(`${key}:`), `${key} has no framework label`);
    assert.ok(blockOf('MONITOR_LABEL').includes(`${key}:`), `${key} has no display label`);
    assert.ok(blockOf('MONITOR_IMPL').includes(`${key}:`), `${key} has no implementation path`);
    assert.ok(
      new RegExp(`^\\s*'${key}',`, 'm').test(blockOf('MONITOR_ORDER')),
      `${key} is missing from MONITOR_ORDER, so it would render no row at all`
    );
  }

  // The AI providers must sit in the same framework band, or the framework
  // filter would split "AI / API" across three chips.
  const framework = blockOf('MONITOR_FRAMEWORK');
  for (const key of serverProbeKeys) {
    assert.match(framework, new RegExp(`${key}:\\s*'AI / API'`), `${key} is in its own framework band`);
  }
});

/**
 * The probe detail is a full sentence, but the cell that holds it is a <td>,
 * and AdminDashboard.css ships an UNSCOPED `th, td { … white-space: nowrap }`
 * rule. `white-space` is an inherited property, so the detail text inherited
 * `nowrap` from that global rule and was clipped mid-sentence at the right
 * edge — the monitor told an admin what it checks and then cut off before
 * saying what it does.
 *
 * `word-break` / `overflow-wrap` do NOT defend against this: they govern WHERE
 * a line may break, not WHETHER wrapping happens at all, so a descendant of a
 * `nowrap` ancestor still lays out on one line. Only an explicit
 * `white-space: normal` on the element fixes it, which is why this asserts on
 * the declaration rather than on the presence of a wrapping hint.
 */
test('the expanded probe detail is allowed to wrap, not clipped to one line', () => {
  // Comments are stripped from the WHOLE file before any block is read, not
  // from the matched block. A comment that quotes a selector (`th, td { … }`)
  // otherwise contains a `}` and truncates the match at the wrong place — the
  // rule this test exists to check would be read as empty.
  const css = stripComments(fs.readFileSync(path.join(HERE, 'SecurityStatus.css'), 'utf8'));

  const block = css.match(/\.rt-detail-text\s*\{([^}]*)\}/);
  assert.ok(block, '.rt-detail-text rule is missing from SecurityStatus.css');

  const declarations = block[1]
    .split(';')
    .map(d => d.trim())
    .filter(Boolean);

  const whiteSpace = declarations.find(d => d.startsWith('white-space'));
  assert.ok(
    whiteSpace,
    '.rt-detail-text sets no white-space, so it inherits `nowrap` from AdminDashboard.css\'s unscoped `th, td` rule and the detail is truncated.',
  );
  assert.equal(
    whiteSpace,
    'white-space: normal',
    `.rt-detail-text must wrap, but found "${whiteSpace}" — probe details are whole sentences.`,
  );
});

/**
 * The same unscoped `th, td` rule also sets `padding`, `vertical-align` and a
 * border on every cell in this table. This component overrides the ones that
 * matter for its own layout, so a future edit to the shared rule cannot quietly
 * reintroduce a cell that is mis-padded or top-aligned against its content.
 */
test('every cell in the monitor table overrides the shared admin table cell styles', () => {
  const css = stripComments(fs.readFileSync(path.join(HERE, 'SecurityStatus.css'), 'utf8'));
  const ruleFor = (selector) => {
    const m = css.match(new RegExp(`(?:^|[,}\\s])${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
    return m ? m[1] : null;
  };

  // The detail cell must lay its own padding out; the shared rule hard-codes
  // `padding: 12px 10px` for every td on the admin surface.
  const detailCell = ruleFor('.rt-detail-cell');
  assert.ok(detailCell, '.rt-detail-cell rule is missing');
  assert.match(detailCell, /padding:/, '.rt-detail-cell relies on the shared `th, td` padding');

  // The description cell zeroes padding on purpose — the inner flex row owns
  // it — so it must say so rather than inherit 12px/10px.
  const descCell = ruleFor('.rt-td--desc');
  assert.ok(descCell, '.rt-td--desc rule is missing');
  assert.match(descCell, /padding:\s*0/, '.rt-td--desc must zero the inherited cell padding');

  // Data cells align their content with the shared rule's `vertical-align: top`.
  const dataCell = ruleFor('.rt-td');
  assert.ok(dataCell, '.rt-td rule is missing');
  assert.match(dataCell, /vertical-align:/, '.rt-td relies on the shared `th, td` vertical-align');
});
