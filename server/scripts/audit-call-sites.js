/**
 * CALL-SITE / SIGNATURE AUDIT — the bug class that shipped to production.
 *
 *   node scripts/audit-call-sites.js [root]
 *
 * `root` defaults to this package. The self-check passes a scratch directory so
 * it can prove the audit detects a known defect without editing real source.
 *
 * ── The bug this exists to prevent ───────────────────────────────────────────
 *
 * reportAccountLockout() was edited to stop naming members in the admin bell.
 * The edit renamed the destructured parameter and dropped `email` from it:
 *
 *   -  function reportAccountLockout({ email, userId, alias, minutes, lockKey })
 *   +  function reportAccountLockout({ alias, userId, minutes, lockKey })
 *
 * routes/auth.js:642 kept calling it with `{ email, minutes, lockKey }` — it
 * always did, because that path locks by address before any account is resolved.
 *
 * Inside the function `email` was then not defined. The line that read it sat
 * inside `catch { }`, so the ReferenceError was swallowed exactly as designed
 * and the function kept "succeeding". The visible effect: a member locked out by
 * repeated failed passwords received no notification and no email.
 *
 * Why nothing caught it:
 *
 *   · The whole write sat in a `try {} catch {}` whose entire job is to swallow
 *     failures, so there was no error to surface.
 *   · The route's own response was unaffected — the lockout itself worked.
 *   · The unit suite passed, because it covered the function's contract rather
 *     than the values it reads from its arguments.
 *
 * A `ReferenceError` inside a best-effort block is invisible from outside. The
 * only way to catch this class is statically, before it runs.
 *
 * ── What is checked ─────────────────────────────────────────────────────────
 *
 * For every function whose FIRST parameter is a destructured object, compare the
 * fields each call site supplies against the fields the function binds.
 *
 *   Reported:  a caller passes `email`, the function binds `alias, userId`
 *   Ignored:   the function passing its own bound name on (normal forwarding)
 *   Ignored:   a caller passing fewer fields than the function binds (optional)
 *
 * Only the FIRST direction is a defect. Passing extra is a silent no-op at best
 * and a ReferenceError at worst; passing fewer is legal because destructuring
 * yields `undefined` for absent keys.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');

/**
 * Files that contain EXAMPLE SOURCE rather than source.
 *
 * selfcheck-audit-call-sites.js embeds a deliberately-defective call as a string
 * literal, so its own fixtures prove the audit works. Read as code, that fixture
 * reports itself as the very defect the audit exists to catch — a scanner that
 * audits its own test data is worse than no scanner, because every run then ends
 * in a failure nobody can action.
 *
 * Excluded by name and only by name. Everything else in the tree, tooling
 * included, is scanned.
 */
const FIXTURE_HOLDERS = new Set(['selfcheck-audit-call-sites.js']);

/** Source files worth scanning: server code, excluding tests and node_modules. */
function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'Test File') continue;
      collect(full, out);
    } else if (entry.name.endsWith('.js') && !FIXTURE_HOLDERS.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The names a destructuring pattern ACCEPTS from a caller.
 *
 * Nested patterns ({ a: { b } }) bind `b`, not `a`, so the walk descends into
 * any object pattern and takes only leaf identifiers.
 *
 * A RENAME contributes both names. `{ public: pub = null }` binds `pub`, but a
 * caller must and does write `public:` — `public` is a reserved word and cannot
 * be an identifier, so the rename is the only way to write that field at all.
 * Treating the key as unaccepted reports every such call as a defect; the
 * scanner found exactly this in blockchain/engine.js before it accounted for it.
 */
function boundNames(pattern) {
  const names = new Set();
  let depth = 0;
  let token = '';
  const tokens = [];
  for (const ch of pattern) {
    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') depth -= 1;
    if (depth === 0 && (ch === ',' || ch === ' ')) {
      if (token) tokens.push(token);
      token = '';
    } else {
      token += ch;
    }
  }
  if (token) tokens.push(token);

  for (const raw of tokens) {
    let t = raw.trim();
    if (!t) continue;
    // Default value: `userId = req.user._id` binds `userId`.
    const eq = t.indexOf('=');
    if (eq !== -1) t = t.slice(0, eq).trim();
    // Renamed: `public: pub` accepts either name.
    const colon = t.indexOf(':');
    if (colon !== -1) {
      const key = t.slice(0, colon).trim();
      const bound = t.slice(colon + 1).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
      t = bound;
    }
    // Nested pattern: descend rather than bind the key.
    if (t.startsWith('{') || t.startsWith('[')) continue;
    t = t.replace(/^\.\.\./, '').replace(/\s*=.*$/, '').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
  }
  return names;
}

/**
 * The keys an object literal supplies, read WITHOUT evaluating anything.
 *
 * Both `{ email }` (shorthand) and `{ email: x }` supply `email`. A spread
 * (`{ ...opts }`) supplies an unknown set, so the literal is marked unanalysable
 * and skipped rather than guessed at.
 */
function suppliedKeys(literal) {
  const keys = new Set();
  let unanalysable = false;
  let depth = 0;
  let segment = '';
  const segments = [];
  for (const ch of literal) {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (depth === 0 && ch === ',') {
      segments.push(segment);
      segment = '';
    } else {
      segment += ch;
    }
  }
  segments.push(segment);

  for (const raw of segments) {
    const part = raw.trim();
    if (!part) continue;
    if (part.startsWith('...')) { unanalysable = true; continue; }
    // Comments would otherwise be read as a key.
    const cleaned = part.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
    if (!cleaned) continue;
    const m = /^([A-Za-z_$][\w$]*)\s*(?::|,|$)/.exec(cleaned);
    if (m) keys.add(m[1]);
    else unanalysable = true;
  }
  return { keys, unanalysable };
}

/** Read a balanced `{...}` starting at `open`, which must be a `{`. */
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** Line number of a character offset, for a readable report. */
function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

const files = collect(ROOT);

/** name → { bound:Set, declaredAt:[] } for functions with a destructured first param. */
const signatures = new Map();

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);

  // Function declarations and arrow functions assigned to consts.
  const decl = /function\s+([A-Za-z_$][\w$]*)\s*\(\s*\{/g;
  const arrow = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(\s*\{/g;
  for (const re of [decl, arrow]) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const open = src.indexOf('{', m.index + m[0].length - 1);
      const literal = balanced(src, open);
      if (!literal) continue;
      const bound = boundNames(literal.slice(1, -1));
      if (bound.size === 0) continue;
      const name = m[1];
      if (!signatures.has(name)) signatures.set(name, { bound, at: [] });
      signatures.get(name).at.push(`${rel}:${lineOf(src, m.index)}`);
      re.lastIndex = open + literal.length - 1;
    }
  }
}

const findings = [];
let callSites = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);

  for (const [name, sig] of signatures) {
    // A call is `name(` followed by `{`. Excluded: the declaration itself, and
    // any occurrence that is a property access (`.name(`).
    const re = new RegExp(`(^|[^\\w.$])${name}\\s*\\(\\s*\\{`, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const after = src.indexOf('{', m.index + m[0].length - 1);
      if (sig.at.some((loc) => loc === `${rel}:${lineOf(src, m.index)}`)) continue;
      const literal = balanced(src, after);
      if (!literal) continue;
      const { keys, unanalysable } = suppliedKeys(literal.slice(1, -1));
      if (unanalysable) continue;
      callSites += 1;
      const extra = [...keys].filter((k) => !sig.bound.has(k));
      if (extra.length > 0) {
        findings.push({
          file: rel,
          line: lineOf(src, m.index),
          name,
          extra,
          bound: [...sig.bound].sort(),
          declaredAt: sig.at,
        });
      }
      re.lastIndex = after + literal.length - 1;
    }
  }
}

console.log(`\n── call-site / signature audit ──`);
console.log(`   ${files.length} source files, ${signatures.size} object-destructured signatures`);
console.log(`   ${callSites} analysable call site(s)\n`);

if (findings.length === 0) {
  console.log('   ok  every call site supplies only fields its callee binds');
  process.exit(0);
}

for (const f of findings) {
  console.log(`   FAIL ${f.file}:${f.line}  ${f.name}(…) passes ${f.extra.map((e) => `"${e}"`).join(', ')}`);
  console.log(`        binds only: ${f.bound.map((b) => `"${b}"`).join(', ')}`);
  console.log(`        declared at: ${f.declaredAt.join(', ')}`);
  console.log('        the extra field is undefined inside the callee; if it is read,');
  console.log('        that is a ReferenceError swallowed by whichever catch{} it sits in.\n');
}
console.log(`   ${findings.length} mismatch(es).\n`);
process.exit(1);