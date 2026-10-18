/**
 * Clinical evidence standards — the "proven by health professionals" layer.
 *
 * This module is the system's autonomous knowledge boundary. The AI may only
 * publish a supplement or a condition rule when its evidence citation matches
 * an authoritative professional source (guideline bodies, Cochrane reviews,
 * peer-reviewed meta-analyses/RCTs indexed with a PMID, or the NIH/WHO/EFSA/
 * FAO fact sources the instrument already rates against). Citations are also
 * checked against the app's own curated supplement knowledge (routes/
 * recommend.js inferEvidence + this list), because content the app already
 * ships was itself drawn from those sources.
 *
 * What the gate honestly verifies:
 *   - citation AUTHORITY AND FORM (a real professional source pattern, and a
 *     PMID when one is claimed is well-formed);
 *   - the suggestion is a SUPPLEMENT, never a prescription drug or a known
 *     dangerous substance (blocklist);
 *   - the bundle carries the fields the engine needs to use it safely.
 * It does not re-run the clinical trials. That boundary is stated here so the
 * claim "proven by health professionals" always points at the professional
 * literature the suggestion cites — not at this code pretending to be a panel.
 */

// Authoritative source patterns a citation must contain at least one of.
const AUTHORITATIVE_SOURCES = [
  /\bNIH\b|National Institutes of Health|Office of Dietary Supplements/i,
  /\bWHO\b|World Health Organization/i,
  /\bADA\b|American Diabetes Association|Standards of Care in Diabetes/i,
  /\bAHA\b|American Heart Association/i,
  /\bACG\b|\bAGA\b|American College of Gastroenterology|Gastroenterology/i,
  /\bACOG\b|American College of Obstetricians/i,
  /\bKDOQI\b|\bKDIGO\b|kidney disease (improving|outcome)/i,
  /Cochrane( Database)? (Systematic )?Review/i,
  /meta-?analysis/i,
  /\bRCT\b|randomized (controlled )?trial|randomised/i,
  /\bPMID\b:?\s*\d{6,8}/i,
  /\bEFSA\b|European Food Safety Authority/i,
  /\bFAO\b|Food and Agriculture Organization/i,
  /\bEndocrine Society\b/i,
  /\bAACE\b|\bACE\b.*endocrinology/i,
  /\bGINA\b|Global Initiative for Asthma/i,
  /\bNICE\b.*(guideline|NG\d+)/i,
  /systematic review/i,
  /clinical (nutrition )?guidelines?/i,
  /Annals of Internal Medicine|JAMA|BMJ|The Lancet|New England Journal|Nutrients\b|Journal of\b|American Journal of/i,
  /\bWCRF\b|\bAICR\b|American Institute for Cancer Research/i,
  /\bIDF\b|International Diabetes Federation/i,
];

// Not supplements. Anything matching these is refused outright — the app
// recommends supplements and lifestyle, never prescribes.
const PRESCRIPTION_OR_DANGEROUS = [
  /\binsulin\b/i, /\bmetformin\b/i, /\bglipizide\b|\bglibenclamide\b|\bglimepiride\b/i,
  /\bstatin\b|\batorvastatin\b|\bsimvastatin\b|\brosuvastatin\b/i,
  /\bwarfarin\b|\bapixaban\b|\brivaroxaban\b/i,
  /\b(levothyroxine|methimazole|propylthiouracil)\b/i,
  /\b(ssri|snri|antidepressant|antipsychotic|benzodiazepine)\b/i,
  /\bchemotherapy|antineoplastic|immunotherapy\b/i,
  /\bephedra|ephedrine\b/i, /\bdmaa\b|\bdnp\b|2,4-dinitrophenol/i,
  /\byohimb(e|ina)?\b.*prescription|hgh\b|human growth hormone\b/i,
  /\broyal jelly\b.*hormone|\bika\b|\bdeer antler spray\b/i,
  /\bfibrodan|bromantane|flmodanil\b|\bphenibut\b/i,
];

// Curated supplement names the engine already ships with professional-source
// evidence (mirrors inferEvidence in routes/recommend.js and the condition
// branches). Suggestions drawn from this list clear the authority bar with
// their existing citations; novel ingredients additionally need a citation
// matching AUTHORITATIVE_SOURCES.
const KNOWN_APPROVED_SUPPLEMENTS = new Set([
  'omega-3', 'fish oil', 'algae-based omega-3', 'vitamin d3', 'vitamin d', 'magnesium',
  'magnesium glycinate', 'magnesium citrate', 'zinc', 'vitamin c', 'iron bisglycinate',
  'vitamin b12', 'methylcobalamin', 'folate', 'methylfolate', 'calcium', 'calcium citrate',
  'vitamin k2', 'collagen peptides', 'multivitamin', 'berberine', 'alpha-lipoic acid', 'ala',
  'coq10', 'ubiquinol', 'ashwagandha', 'turmeric', 'curcumin', 'ginger', 'probiotics',
  'fiber', 'psyllium', 'chromium', 'tart cherry', 'eleuthero', 'rhodiola',
  'goldenseal', 'evening primrose oil', 'maca', 'ginkgo', 'lion\'s mane',
  'phosphatidylserine', 'n-acetylcysteine', 'nac', 'milk thistle', 'silymarin',
  'glutamine', 'creatine', 'electrolyte', 'vitamin e', 'selenium', 'iodine',
  'inositol', 'myo-inositol', 'd-chiro-inositol', 'bee pollen', 'royal jelly',
  'devil\'s claw', 'boswellia', 'peppermint', 'melatonin', '5-htp', 'kava',
  'st. john\'s wort', 'valerian', 'passionflower', 'l-theanine', 'gaba',
  'potassium', 'copper', 'manganese', 'boron', 'vitamin a', 'biotin',
  'slippery elm', 'marshmallow root', 'licorice', 'dgl', 'oregano oil',
  'quercetin', 'bromelain', 'papain', 'saw palmetto', 'tribulus',
  'd3 + k2', 'b-complex', 'iron', 'ferrous bisglycinate',
]);

// Priorities the engine accepts on a recommendation row.
const PRIORITIES = new Set(['High', 'Medium', 'Low']);

function citationIsAuthoritative(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return AUTHORITATIVE_SOURCES.some((re) => re.test(s));
}

function isPrescriptionOrDangerous(name) {
  const s = String(name || '');
  return PRESCRIPTION_OR_DANGEROUS.some((re) => re.test(s));
}

function isKnownApprovedSupplement(name) {
  const n = String(name || '').toLowerCase().trim();
  for (const known of KNOWN_APPROVED_SUPPLEMENTS) {
    if (n.includes(known)) return true;
  }
  return false;
}

module.exports = {
  AUTHORITATIVE_SOURCES,
  PRESCRIPTION_OR_DANGEROUS,
  KNOWN_APPROVED_SUPPLEMENTS,
  PRIORITIES,
  citationIsAuthoritative,
  isPrescriptionOrDangerous,
  isKnownApprovedSupplement,
};
