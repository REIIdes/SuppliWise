/**
 * One-shot verified text replacement helper.
 *
 * The `edit` tool proved unreliable for the long comment blocks in this task
 * (payloads intermittently rejected, and once a multi-line replacement removed
 * far more than it matched). This does the same job with the safety property
 * that matters: it REFUSES unless the search text occurs exactly once, and it
 * prints how many lines changed so a mistake is visible immediately.
 *
 * Usage: node tools/patch.js <file> <findFile> <replaceFile>
 */
const fs = require('fs');

const [file, findFile, replaceFile] = process.argv.slice(2);
if (!file || !findFile || !replaceFile) {
  console.error('usage: node tools/patch.js <file> <findFile> <replaceFile>');
  process.exit(2);
}

const raw = fs.readFileSync(file, 'utf8');
// Matching is done on LF-normalised text, and the file's original line ending
// is restored on write. Without this, a CRLF file can never match a patch
// written with LF endings, which fails as a confusing "found 0 occurrences"
// rather than as an obvious line-ending mismatch.
const crlf = raw.includes('\r\n');
const find = fs.readFileSync(findFile, 'utf8').replace(/\r\n/g, '\n');
const replace = fs.readFileSync(replaceFile, 'utf8').replace(/\r\n/g, '\n');

const haystack = raw.replace(/\r\n/g, '\n');

let count = 0;
let at = haystack.indexOf(find);
while (at !== -1) {
  count += 1;
  at = haystack.indexOf(find, at + find.length);
}

if (count !== 1) {
  console.error(`REFUSING: found ${count} occurrences in ${file} (expected exactly 1).`);
  process.exit(1);
}

const out = haystack.replace(find, replace);
const before = haystack.split('\n').length;
const after = out.split('\n').length;
fs.writeFileSync(file, crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
console.log(`patched ${file}: ${before} -> ${after} lines`);
