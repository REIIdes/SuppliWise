/**
 * Reports every notification the system writes and whether it carries a
 * destination. Run it after adding a bell so a new one cannot be shipped
 * without a link — the failure mode this whole change exists to remove.
 *
 *   node scripts/audit-bell-links.js
 *
 * Exits non-zero if any writer is missing one. Not part of `npm test`: it is a
 * static scan of the source, not a runtime check.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'Test File' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `Model.create(` / `.insertMany(` call, with the statement that
 * PREPARES its rows as well as the call itself.
 *
 * That preamble matters: an insertMany is routinely handed a mapped array whose
 * fields were written a line earlier (`admins.map((a) => ({ … }))`), so reading
 * only the call's own parentheses reports every one of those as having no
 * destination even when it does. Braces are counted so each window ends at the
 * end of its statement rather than at a fixed line count.
 */
function writerCalls(source) {
  const calls = [];
  const re = /\b(UserNotification|AdminEvent)\s*\.\s*(create|insertMany)\s*\(/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const model = match[1];
    const method = match[2];
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(' || ch === '{' || ch === '[') depth += 1;
      else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
      i += 1;
    }
    const end = i;
    // The rows may not be in the call at all: `insertMany(docs)` is routinely
    // handed an array built a statement earlier. Find what the first argument
    // actually is, and if it is a bare identifier, include the assignment that
    // produced it — otherwise every fan-out writer reads as having no fields.
    let start = match.index;
    const firstArg = source.slice(re.lastIndex, i).split(/[,)]/)[0].trim();
    const identifier = /^[A-Za-z_$][\w$]*$/.test(firstArg) ? firstArg : null;
    if (identifier) {
      const assign = new RegExp(`(?:const|let|var)\\s+${identifier}\\s*=`, 'g');
      let last = null;
      let found;
      while ((found = assign.exec(source)) !== null) {
        if (found.index > match.index) break;
        last = found.index;
      }
      if (last !== null) start = last;
    }
    calls.push({
      model,
      method,
      line: source.slice(0, match.index).split('\n').length,
      body: source.slice(start, end),
    });
  }
  return calls;
}

const targets = [
  { label: 'member bell', model: 'UserNotification' },
  { label: 'admin bell', model: 'AdminEvent' },
];

let problems = 0;
for (const { label, model } of targets) {
  console.log(`\n${label}  (${model})`);
  let total = 0;
  let linked = 0;
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (rel.startsWith('scripts/') || rel.endsWith('test-priority-override-flows.js')) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const call of writerCalls(source)) {
      if (call.model !== model) continue;
      total += 1;
      const hasLink = /\blink\s*:/.test(call.body);
      if (hasLink) linked += 1;
      const title = (call.body.match(/title:\s*[`'"]([^`'"]{0,60})/) || [])[1] || '(composed title)';
      const type = (call.body.match(/type:\s*[`'"]([^`'"]+)/) || [])[1]
        || (call.body.match(/type:\s*([^,\n?}]+\?)/) || [])[1]?.trim()
        || '?';
      console.log(`  ${hasLink ? 'ok  ' : 'MISS'} ${rel}:${call.line}  [${type}] ${title}`);
      if (!hasLink) problems += 1;
    }
  }
  console.log(`  → ${linked}/${total} carry a link`);
}

console.log('');
if (problems) {
  console.log(`${problems} writer(s) with no destination. Every bell needs one —`);
  console.log('see server/models/UserNotification.js for the link contract.');
  process.exit(1);
}
console.log('Every notification the system writes carries a destination.');