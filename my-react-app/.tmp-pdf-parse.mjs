// Temporary: extract text positions from each PDF page to prove/disprove overlap.
import fs from 'fs';
import zlib from 'zlib';

const file = process.argv[2];
const buf = fs.readFileSync(file);
const raw = buf.toString('latin1');

const objs = new Map();
const re = /(\d+) 0 obj([\s\S]*?)endobj/g;
let m;
while ((m = re.exec(raw)) !== null) objs.set(+m[1], m[2]);

// Page order: resolve root via /Catalog -> /Pages -> /Kids (never merge trees).
const kids = [];
const catalog = [...objs.values()].find((b) => /\/Type\s*\/Catalog/.test(b));
const rootRef = catalog?.match(/\/Pages\s+(\d+)\s+0\s+R/);
const collect = (id) => {
  const body = objs.get(id) ?? '';
  if (/\/Type\s*\/Page[^s]/.test(body) || /\/Type\s*\/Page\s/.test(body)) { kids.push(id); return; }
  const k = body.match(/\/Kids\s*\[([^\]]*)\]/);
  if (k) for (const [, cid] of k[1].matchAll(/(\d+)\s+0\s+R/g)) collect(+cid);
};
if (rootRef) collect(+rootRef[1]);
else for (const [id, body] of objs) if (/\/Type\s*\/Page[^s]/.test(body)) kids.push(id);

const decode = (id) => {
  const body = objs.get(id) ?? '';
  const head = body.slice(0, body.indexOf('stream'));
  const sm = body.match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
  if (!sm) return '';
  let data = Buffer.from(sm[1], 'latin1');
  if (/FlateDecode/.test(head)) { try { data = zlib.inflateSync(data); } catch { return ''; } }
  return data.toString('latin1');
};

const unescape = (s) => s.replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

const extract = (content) => {
  const items = [];
  let tm = null, td = null;
  const tokens = content.match(/(\[(?:[^\]]|\\\])*\]\s*TJ)|(\((?:\\.|[^\\()])*\)\s*Tj)|(BT)|(ET)|([-.\d]+ [-.\d]+ [-.\d]+ [-.\d]+ [-.\d]+ [-.\d]+ Tm)|([-.\d]+ [-.\d]+ Td)|(T\*)/g) || [];
  for (const t of tokens) {
    if (t === 'BT') { tm = null; td = null; continue; }
    if (t.endsWith('Tm')) { const n = t.match(/[-.\d]+/g).map(Number); tm = { x: n[4], y: n[5] }; continue; }
    if (t.endsWith('Td')) { const n = t.match(/[-.\d]+/g).map(Number); td = { x: n[0], y: n[1] }; continue; }
    if (t.endsWith('Tj') || t.endsWith('TJ')) {
      const base = tm ?? { x: td?.x ?? 0, y: td?.y ?? 0 };
      let txt = '';
      if (t.endsWith('Tj')) txt = unescape(t.slice(t.indexOf('(') + 1, t.lastIndexOf(')')));
      else for (const part of t.matchAll(/\((?:\\.|[^\\()])*\)|-?[\d.]+/g)) {
        const p = part[0];
        if (p.startsWith('(')) txt += unescape(p.slice(1, -1));
      }
      if (txt.trim()) items.push({ x: Math.round(base.x * 10) / 10, y: Math.round(base.y * 10) / 10, txt: txt.trim() });
    }
  }
  return items;
};

const contentsOf = (pageId) => {
  const body = objs.get(pageId) ?? '';
  const single = body.match(/\/Contents\s+(\d+)\s+0\s+R/);
  if (single) return decode(+single[1]);
  const arr = body.match(/\/Contents\s*\[([^\]]*)\]/);
  if (arr) return [...arr[1].matchAll(/(\d+)\s+0\s+R/g)].map(([, n]) => decode(+n)).join('\n');
  return '';
};

console.log(`file: ${file}  pages: ${kids.length}\n`);
const pages = kids.map((id) => extract(contentsOf(id)));

const auditWords = /AUDIT SCOPE|CRITICAL$|HIGH$|REMEDIATED|OPEN \/ ACCEPTED|SECURITY AUDIT RECORD|HEADLINE FINDINGS|OPEN AND ACCEPTED|AUDIT SCOPE|Remediation item|REPORT GENERATED|SCOPE/i;
const rowWords = /Health Records Anchor|Encrypted Decentralized|Achievement NFTs|Token Staking|Key Management|Login flow|Account creation|Login flow|AI provider key|DAO governance|Price oracle|Holder|healthy|HEALTHY|WARNING|CRITICAL/i;

pages.forEach((items, i) => {
  const audit = items.filter((it) => auditWords.test(it.txt) && !/HEALTHY|WARNING/.test(it.txt));
  const rows = items.filter((it) => rowWords.test(it.txt));
  console.log(`--- page ${i + 1}: ${items.length} text items, ${audit.length} audit-ish, ${rows.length} row-ish`);
  if (audit.length && rows.length) {
    const aMin = Math.min(...audit.map((a) => a.y)), aMax = Math.max(...audit.map((a) => a.y));
    const clash = rows.filter((r) => r.y >= aMin - 3 && r.y <= aMax + 3);
    console.log(`    audit text y-range: ${aMin}..${aMax}   row text inside that range: ${clash.length}`);
    for (const c of clash.slice(0, 6)) console.log(`      y=${c.y} x=${c.x} "${c.txt.slice(0, 50)}"`);
    console.log('    audit items:');
    for (const a of audit) console.log(`      y=${a.y} x=${a.x} "${a.txt.slice(0, 55)}"`);
  }
});

if (process.env.FULL) {
  pages.forEach((items, i) => {
    console.log(`\n=== page ${i + 1} (top-to-bottom) ===`);
    [...items].sort((a, b) => b.y - a.y).forEach((it) => console.log(`  y=${String(it.y).padStart(6)} x=${String(it.x).padStart(6)}  ${it.txt.slice(0, 70)}`));
  });
}
