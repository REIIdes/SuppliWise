/**
 * Syntax gate for every source file in the server.
 *
 * WHY THIS EXISTS
 * ---------------
 * `npm run check` used to be one enormous hand-written `node --check a && node
 * --check b && ...` chain in package.json. Two problems, both of which had
 * already bitten:
 *
 *   1. It only covered files someone remembered to add. `utils/floodGuard.js` —
 *      the module that decides whether a request is served, refused as too
 *      large, or shed as "busy" — was not on the list. Neither was
 *      `utils/dailyScheduleSlots.js` or `utils/securityAudit.js`. A SyntaxError
 *      in any of them would have reached a review, because the gate that was
 *      supposed to catch it never looked at them.
 *   2. It was a line in package.json that grew with every new module, so the
 *      natural response to "the check list is stale" was to ignore the check.
 *
 * This walks the tree instead, so the gate cannot drift: a new file is covered
 * the moment it exists, and deleting one cannot break the build.
 *
 * WHAT IT SKIPS, AND WHY
 * ----------------------
 *   node_modules, uploads, .git, and the two log files the server writes.
 *   `_flow.js`, `verify.cjs` and the `_tmp_*` / `seed-*` helpers are INCLUDED:
 *   they are loose scripts in the source tree, and a syntax error in one still
 *   means "node <script> does nothing", which is a confusing way to discover a
 *   typo.
 *
 * CJS only. This is a CommonJS project (every file here uses require/module.exports),
 * so `vm.Script` is an accurate syntax check for them. If an ES module is ever
 * added it must be compiled with the `sourceType: 'module'` option here too —
 * otherwise this gate would report a false error, which is worse than no gate.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/** Directories that are never source. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.vite',
  '.vite-build',
  // Runtime upload target. Written by the app, never compiled.
  'uploads',
]);

const SOURCE_FILES = ['.js', '.cjs'];

function walk(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, found);
    } else if (entry.isFile() && SOURCE_FILES.includes(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

const files = walk(ROOT);
const failures = [];

for (const file of files) {
  const relative = path.relative(ROOT, file);
  // The server writes these at runtime; they are not source.
  if (/\.(log)$/i.test(relative)) continue;
  const source = fs.readFileSync(file, 'utf8');
  try {
    // Compiling without running is the whole point: a SyntaxError surfaces here
    // with the real file and line, exactly as `node --check` reports it.
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename: relative });
  } catch (error) {
    failures.push({ relative, message: error.message });
  }
}

if (failures.length > 0) {
  console.error(`Syntax check FAILED — ${failures.length} of ${files.length} file(s):\n`);
  for (const { relative, message } of failures) {
    console.error(`  ${relative}\n    ${message}\n`);
  }
  process.exit(1);
}

console.log(`Syntax OK — ${files.length} source file(s) checked.`);