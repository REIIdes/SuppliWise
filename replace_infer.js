const fs = require('fs');
const file = 'c:\\Users\\johnr\\SuppliWise\\server\\routes\\recommend.js';
let src = fs.readFileSync(file, 'utf8');
const startMarker = 'function inferEvidence(name) {';
const endMarker = 'function buildMealRecs(';
const startIdx = src.indexOf(startMarker);
const endIdx = src.indexOf(endMarker);
if (startIdx === -1 || endIdx === -1) { console.error('Markers not found', startIdx, endIdx); process.exit(1); }
const commentStart = src.lastIndexOf('\n', startIdx - 2);
const before = src.slice(0, commentStart + 1);
const after = src.slice(endIdx);
