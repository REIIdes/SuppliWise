/**
 * Citation audit — proves every PMID the product shows a member is real.
 *
 * WHY THIS EXISTS
 * ---------------
 * `utils/supplementEvidenceRegistry.js` is the only source of citations an
 * assessment plan may display, so its own accuracy decides whether the product
 * is truthful. Running the first audit (2026-10-20) resolved all 44 identifiers
 * against NCBI and 33 of them named papers that had nothing to do with the
 * nutrient — "Lion's Mane … (PMID: 32549918)" pointed at a study of ivermectin
 * on ovarian cancer, "L-Theanine … (PMID: 32722093)" at a materials-science
 * paper on 316L stainless steel. Those strings were written by a model years
 * ago and never checked, and every plan the app generated repeated them as
 * fact.
 *
 * This script is the check. Two modes, both needing network (so it is a
 * maintainer command, never a CI step):
 *
 *   node eval/citationAudit.js              VERIFY — every registry PMID must
 *     resolve at NCBI and its real title must name the nutrient. Non-zero exit
 *     if any fails. Run this after touching the registry, and before releasing
 *     a plan-format change.
 *   node eval/citationAudit.js --rebuild    REPLACE — for each failing entry,
 *     search PubMed for a peer-reviewed study that genuinely is about that
 *     nutrient and print a citation built ONLY from NCBI's own metadata
 *     (authors, year, journal, title, PMID). Nothing here can invent a study
 *     because nothing here is written from memory.
 *
 * `--rebuild` deliberately prints proposals instead of editing the registry: a
 * citation is a clinical claim, so a human pastes it in, and VERIFY then proves
 * it held.
 */

require('../utils/envFile').reloadFromDisk();
const { ENTRIES, extractPmids } = require('../utils/supplementEvidenceRegistry');

const REBUILD = process.argv.includes('--rebuild');
/** `--all` proposes a citation for every entry, not only the failing ones, so
 *  the entries that currently cite an institution with no resolvable
 *  identifier can be upgraded to a specific peer-reviewed study. */
const ALL = process.argv.includes('--all');
/** `--only=Ginkgo,Selenium` restricts a rebuild to named nutrients (the flag
 *  exists so refining one citation costs one query, not a full registry pass). */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=').pop();
const onlySet = ONLY && ONLY !== '--rebuild' ? new Set(ONLY.split(',').map((s) => s.trim().toLowerCase())) : null;
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const RET_DELAY_MS = 400; // NCBI's unauthenticated limit is 3 requests/second.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.slice(0, 80)}`);
  return res.json();
}

/** NCBI metadata for a list of PMIDs, as { id: { title, journal, year, authors, types } }. */
async function summarize(ids) {
  if (ids.length === 0) return {};
  const j = await getJson(`${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`);
  const out = {};
  for (const id of ids) {
    const r = j?.result?.[id];
    if (!r || r.error) continue;
    out[id] = {
      title: String(r.title || '').replace(/[?]/g, '').trim(),
      journal: String(r.source || r.fulljournalname || '').trim(),
      year: String(r.pubdate || '').slice(0, 4),
      authors: (r.authors || []).map((a) => a.name),
      types: r.pubtype && r.pubtype !== '-' ? String(r.pubtype) : '',
    };
  }
  return out;
}

/**
 * Alias forms that a PubMed title uses but the registry key does not spell.
 * Without these the matcher would reject a perfect citation for e.g. "CoQ10"
 * (titles say "coenzyme Q10") or "5-HTP" (titles say "5-hydroxytryptophan").
 */
const TITLE_ALIASES = {
  'b12': ['vitamin b12', 'cobalamin'],
  'omega': ['omega-3', 'omega 3', 'n-3'],
  'fish oil': ['fish oil', 'omega-3'],
  'coq10': ['coenzyme q10', 'coq10', 'ubiquinol'],
  '5-htp': ['5-htp', '5-hydroxytryptophan'],
  'alpha-lipoic': ['alpha-lipoic', 'lipoic'],
  'lipoic': ['lipoic'],
  'lion': ["lion's mane", 'hericium'],
  'theanine': ['theanine'],
  'vitamin d': ['vitamin d', 'cholecalciferol', '25-hydroxy'],
  'vitamin c': ['vitamin c', 'ascorbic'],
  'vitamin k': ['vitamin k'],
  'vitamin k2': ['vitamin k2', 'menaquinone', 'mk-7'],
  'vitamin e': ['vitamin e', 'tocopherol'],
  'vitamin a': ['vitamin a', 'retinol', 'carotene'],
  'vitamin b6': ['vitamin b6', 'pyridoxine'],
  'hmb': ['hmb', 'beta-hydroxy beta-methylbutyrate'],
  'tart cherry': ['tart cherry', 'prunus cerasus', 'cherry'],
  'milk thistle': ['milk thistle', 'silymarin', 'silybin'],
  'saw palmetto': ['saw palmetto', 'serenoa'],
  'vitex': ['vitex', 'agnus-castus', 'chasteberry'],
  'hyaluronic': ['hyaluronic'],
  'nattokinase': ['nattokinase'],
  'astaxanthin': ['astaxanthin'],
  'bacopa': ['bacopa', 'brahmi'],
  'glucosamine': ['glucosamine'],
  'chondroitin': ['chondroitin'],
  'devil\x27s claw': ['devil\x27s claw', 'harpagophytum'],
};

/** Every string a title could use to say this entry's nutrient. */
function titleTerms(entry) {
  const base = (entry.keys || []).map((k) => String(k).toLowerCase().trim());
  const out = new Set();
  for (const k of base) {
    (TITLE_ALIASES[k] || [k]).forEach((t) => out.add(t));
  }
  return [...out];
}

/** A title "names the nutrient" when it contains one of its alias forms. */
function titleNamesNutrient(title, entry) {
  const t = String(title || '').toLowerCase();
  return titleTerms(entry).some((term) => t.includes(term));
}

/** Study types that carry weight, best first. */
const STUDY_PREFERENCE = ['Meta-Analysis', 'Systematic Review', 'Randomized Controlled Trial', 'Clinical Trial', 'Journal Article'];

/**
 * Outcome context per nutrient. Title-matching alone can return a real study
 * on the right nutrient and the wrong question — "Selenium and preeclampsia",
 * "Hexavalent chromium and stomach cancer" — which is technically a citation
 * and clinically noise. A human-read plan cites the literature the
 * recommendation is actually about, so the search is narrowed to the outcome a
 * wellness plan would name. Anything not listed here falls back to "is this a
 * supplementation study", which alone removes most toxicology/veterinary/injectable
 * oddities.
 */
const OUTCOME_QUERY = {
  'Selenium': 'oxidative stress[Title/Abstract] OR thyroid[Title/Abstract] OR immune[Title/Abstract] OR "selenium deficiency"[Title/Abstract]',
  'Chromium': 'glycemic[Title/Abstract] OR insulin[Title/Abstract] OR "type 2 diabetes"[Title/Abstract] OR lipid[Title/Abstract]',
  'Rhodiola': 'fatigue[Title/Abstract] OR stress[Title/Abstract] OR burnout[Title/Abstract] OR cognition[Title/Abstract]',
  'Melatonin': 'sleep[Title/Abstract] OR insomnia[Title/Abstract] OR "sleep onset"[Title/Abstract]',
  'Astaxanthin': 'skin[Title/Abstract] OR exercise[Title/Abstract] OR oxidative[Title/Abstract] OR lipid[Title/Abstract]',
  'Hyaluronic acid': 'skin[Title/Abstract] OR oral[Title/Abstract] OR hydration[Title/Abstract] OR joint[Title/Abstract]',
  'L-Theanine': 'stress[Title/Abstract] OR sleep[Title/Abstract] OR cognition[Title/Abstract] OR anxiety[Title/Abstract]',
  'Alpha-lipoic acid': 'neuropathy[Title/Abstract] OR glycemic[Title/Abstract] OR oxidative[Title/Abstract] OR insulin[Title/Abstract]',
  'Resveratrol': 'lipid[Title/Abstract] OR blood pressure[Title/Abstract] OR inflammation[Title/Abstract] OR cardiometabolic[Title/Abstract]',
  'Whey protein': 'muscle[Title/Abstract] OR exercise[Title/Abstract] OR sarcopenia[Title/Abstract] OR protein synthesis[Title/Abstract]',
  'Protein supplement': 'muscle[Title/Abstract] OR exercise[Title/Abstract] OR sarcopenia[Title/Abstract]',
  'Maca': 'sexual function[Title/Abstract] OR energy[Title/Abstract] OR fatigue[Title/Abstract] OR menopause[Title/Abstract]',
  'Ginkgo': 'cognition[Title/Abstract] OR cognitive[Title/Abstract] OR memory[Title/Abstract] OR dementia[Title/Abstract]',
  'Selenium': '"selenium supplementation"[Title/Abstract] OR thyroid[Title/Abstract] OR "oxidative stress"[Title/Abstract] OR immune[Title/Abstract]',
  'Saw palmetto': 'benign prostatic[Title/Abstract] OR "lower urinary"[Title/Abstract] OR BPH[Title/Abstract] OR prostate[Title/Abstract]',
  'Bacopa': 'memory[Title/Abstract] OR cognition[Title/Abstract] OR cognitive[Title/Abstract] OR "Alzheimer"[Title/Abstract]',
  'Echinacea': 'common cold[Title/Abstract] OR "upper respiratory"[Title/Abstract] OR "respiratory infection"[Title/Abstract]',
  'Zinc': '"common cold"[Title/Abstract] OR "upper respiratory"[Title/Abstract] OR immune[Title/Abstract] OR infection[Title/Abstract]',
  'CoQ10': 'statin[Title/Abstract] OR blood pressure[Title/Abstract] OR heart failure[Title/Abstract] OR muscle[Title/Abstract]',
  'Curcumin / Turmeric': 'inflammation[Title/Abstract] OR osteoarthritis[Title/Abstract] OR joint[Title/Abstract] OR "C-reactive"[Title/Abstract]',
  'Krill oil': 'lipid[Title/Abstract] OR omega-3[Title/Abstract] OR cardiovascular[Title/Abstract]',
  'Phosphatidylserine': 'cognition[Title/Abstract] OR memory[Title/Abstract] OR stress[Title/Abstract]',
  'Vitamin K2': 'bone[Title/Abstract] OR arterial[Title/Abstract] OR vitamin D[Title/Abstract]',
  'Boswellia': 'osteoarthritis[Title/Abstract] OR joint[Title/Abstract] OR inflammation[Title/Abstract]',
  'Milk thistle': 'liver[Title/Abstract] OR hepatic[Title/Abstract] OR "transaminase"[Title/Abstract]',
  'Valerian': 'sleep[Title/Abstract] OR insomnia[Title/Abstract]',
  'Berberine': 'glycemic[Title/Abstract] OR lipid[Title/Abstract] OR "type 2 diabetes"[Title/Abstract] OR insulin resistance[Title/Abstract]',
  "Lion's Mane": 'cognition[Title/Abstract] OR cognitive[Title/Abstract] OR mood[Title/Abstract] OR nerve[Title/Abstract]',
};

/** Every entry is at minimum asking for a human supplementation study. */
const BASE_CONTEXT = 'supplementation[Title/Abstract] OR supplement*[Title/Abstract] OR intake[Title/Abstract] OR dietar*[Title/Abstract]';

function buildSearchTerm(entry, { useOutcome = true } = {}) {
  const titleOr = titleTerms(entry).map((k) => `"${k}"[Title]`).join(' OR ');
  const types = STUDY_PREFERENCE.slice(0, 4).map((t) => `"${t}"[Publication Type]`).join(' OR ');
  const context = (useOutcome && OUTCOME_QUERY[entry.nutrient]) || BASE_CONTEXT;
  return `(${titleOr}) AND (${context}) AND (${types})`;
}

async function searchStudyIds(entry, opts) {
  const url = `${EUTILS}/esearch.fcgi?retmode=json&db=pubmed&retmax=8&sort=relevance&term=${encodeURIComponent(buildSearchTerm(entry, opts))}`;
  const j = await getJson(url);
  return (j?.esearchresult?.idlist || []);
}

/**
 * Build a citation from NCBI metadata alone. Form:
 *   "Author as PubMed lists it et al. (Year). Exact title. Journal. PMID: n."
 * The first author is copied verbatim because NCBI's own author string format
 * is not consistent enough to split safely (some records list "Smith J", others
 * "J Smith"), and a garbled surname is its own inaccuracy. No claim about what
 * the study found, because the app cannot verify a finding from a title — it can
 * only verify that the literature exists.
 */
function formatCitation(meta, pmid) {
  const first = (meta.authors[0] || 'Anonymous').trim();
  const tail = meta.authors.length > 1 ? ' et al.' : '';
  return `${first}${tail} (${meta.year}). ${meta.title.replace(/[®™]/g, '').replace(/\s+/g, ' ').trim()} ${meta.journal}. PMID: ${pmid}.`;
}

/** NCBI's record for every PMID the registry asserts: { pmid: title|null }. */
async function resolveAll(ids) {
  const map = {};
  // 200 per request keeps a 44-id registry in one call and a large one bounded.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    // eslint-disable-next-line no-await-in-loop
    const meta = await summarize(chunk);
    for (const id of chunk) map[id] = meta[id] || null;
    // eslint-disable-next-line no-await-in-loop
    await sleep(RET_DELAY_MS);
  }
  return map;
}

async function main() {
  const ids = [...new Set(ENTRIES.flatMap((e) => extractPmids(e.citation)))];
  const resolved = await resolveAll(ids);

  const failures = [];
  for (const entry of ENTRIES) {
    const claimed = extractPmids(entry.citation);
    if (claimed.length === 0) continue; // institutional citation, nothing to resolve
    for (const pmid of claimed) {
      const meta = resolved[pmid];
      if (!meta) {
        failures.push({ entry, pmid, why: 'PMID does not exist at NCBI' });
      } else if (!titleNamesNutrient(meta.title, entry)) {
        failures.push({ entry, pmid, why: `paper is about something else: "${meta.title.slice(0, 70)}"` });
      }
    }
  }

  console.log(`Registry: ${ENTRIES.length} entries, ${ids.length} asserted PMIDs, ${failures.length} failing.\n`);

  if (!REBUILD) {
    for (const f of failures) console.log(`FAIL  ${f.entry.nutrient} (PMID: ${f.pmid}) — ${f.why}`);
    if (failures.length === 0) console.log('All citations verified against NCBI.');
    process.exit(failures.length ? 1 : 0);
  }

  console.log('--- REPLACEMENT CITATIONS (paste these into the registry) ---\n');
  const seen = new Set();
  for (const entry of ENTRIES) {
    const wasFailing = failures.some((f) => f.entry === entry);
    const wanted = onlySet ? onlySet.has(String(entry.nutrient).toLowerCase()) : (ALL || wasFailing);
    if (!wanted) continue;
    if (seen.has(entry.nutrient)) continue;
    seen.add(entry.nutrient);
    // eslint-disable-next-line no-await-in-loop
    const found = await searchStudyIds(entry);
    // eslint-disable-next-line no-await-in-loop
    await sleep(RET_DELAY_MS);
    // eslint-disable-next-line no-await-in-loop
    const metas = await summarize(found);
    // eslint-disable-next-line no-await-in-loop
    await sleep(RET_DELAY_MS);
    const pick = (pool, minYear) => STUDY_PREFERENCE.map((type) => Object.entries(pool)
      .find(([, m]) => m.types.includes(type) && titleNamesNutrient(m.title, entry) && m.year >= minYear)).find(Boolean);
    let best = pick(metas, '2015');
    if (!best) best = pick(metas, '2010');
    if (!best) {
      // The outcome narrowing can be too tight for a minor nutrient; a real
      // supplementation study on the nutrient still beats a fabricated one.
      // eslint-disable-next-line no-await-in-loop
      const broadIds = await searchStudyIds(entry, { useOutcome: false });
      // eslint-disable-next-line no-await-in-loop
      await sleep(RET_DELAY_MS);
      // eslint-disable-next-line no-await-in-loop
      best = pick(await summarize(broadIds), '2010');
    }
    if (!best) {
      console.log(`- ${entry.nutrient}: NO VERIFIED STUDY FOUND — use the NIH ODS fact-sheet form, no PMID.`);
      continue;
    }
    console.log(`- ${entry.nutrient}:\n    ${formatCitation(best[1], best[0])}`);
  }
}

main().catch((err) => {
  console.error('Citation audit failed:', err.message);
  process.exit(1);
});
