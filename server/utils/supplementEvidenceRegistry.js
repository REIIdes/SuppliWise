/**
 * The curated supplement-evidence registry — the only citations this product is
 * allowed to show a member.
 *
 * WHY THIS EXISTS
 * ---------------
 * A model asked to "cite a real source" does what a model does: it produces a
 * citation that LOOKS real. "Journal of Nutrition (2023). Magnesium and sleep.
 * PMID: 37123456." is fluent, plausible and — almost always — a number that
 * resolves to nothing, or worse, to an unrelated paper. That is the single most
 * damaging hallucination in a health product, because an invented citation is
 * the one field a member cannot check and a reviewer will trust.
 *
 * The fix is not to ask harder. It is to stop asking the model to recall at
 * all: the app already ships a professional-source citation per nutrient (the
 * strings that used to live in `inferEvidence`), so that table is lifted out
 * here and used in BOTH directions —
 *
 *   1. IN  (prompt side): `citationRegistryPromptBlock()` prints the exact
 *      allowed citation strings, so the model copies one instead of inventing
 *      one. Recall becomes retrieval.
 *   2. OUT (verify side): `planGrounding.js` checks whatever came back against
 *      `allowlistedPmids()` / `registeredEvidence()` and replaces anything the
 *      registry cannot vouch for.
 *
 * `routes/recommend.js` `inferEvidence()` delegates to `registeredEvidence()` so
 * the rule-based engine and the verifier are reading the same table — one copy
 * of the truth, which is the property the audit record keeps claiming.
 *
 * What this table does NOT do: it does not re-run the trials. Each entry is a
 * pointer to professional literature the app ships and a reviewer can check;
 * `eval/citationAudit.js` re-resolves every PMID in here against NCBI and
 * checks that the titled paper is actually about that nutrient, so a stale or
 * wrong identifier is caught in the repo rather than inside a member's plan.
 */

/**
 * One entry per nutrient. `keys` match against the lowercased recommendation
 * name (any one of them is enough); `all` additionally requires every listed
 * substring. Order is significant — the first match wins, exactly like the
 * if-chain this table was lifted from ("Vitamin K2" must be tested before
 * "Vitamin K" or the generic entry would swallow it).
 */
const ENTRIES = [
  { nutrient: 'Magnesium', keys: ['magnesium'], citation: 'Supported by NIH studies on magnesium and sleep quality (PMID: 23853635) and multiple RCTs on magnesium deficiency.' },
  { nutrient: 'Vitamin B12', keys: ['b12'], citation: 'Supported by NIH Office of Dietary Supplements guidelines on B12 and neurological function.' },
  { nutrient: 'Omega-3 / Fish oil', keys: ['omega', 'fish oil'], citation: 'Supported by American Heart Association guidelines and PubMed meta-analyses on omega-3 and cardiovascular/cognitive health.' },
  { nutrient: 'Vitamin D', keys: ['vitamin d'], citation: 'Supported by Endocrine Society guidelines and NIH studies on Vitamin D deficiency prevalence and health outcomes.' },
  { nutrient: 'Ashwagandha', keys: ['ashwagandha'], citation: 'Akhgarjand C et al. (2022). Does Ashwagandha supplementation have a beneficial effect on the management of anxiety and stress? A systematic review and meta-analysis of randomized controlled trials. Phytother Res. PMID: 36017529.' },
  { nutrient: 'Zinc', keys: ['zinc'], citation: 'Jafari A et al. (2022). Zinc supplementation and immune factors in adults: a systematic review and meta-analysis of randomized clinical trials. Crit Rev Food Sci Nutr. PMID: 33356467.' },
  { nutrient: 'Probiotics', keys: ['probiotic'], citation: 'Supported by World Gastroenterology Organisation guidelines and PubMed meta-analyses on probiotics and gut health.' },
  { nutrient: 'CoQ10', keys: ['coq10'], citation: 'Banach M et al. (2015). Statin therapy and plasma coenzyme Q10 concentrations--A systematic review and meta-analysis of placebo-controlled trials. Pharmacol Res. PMID: 26192349.' },
  { nutrient: 'Curcumin / Turmeric', keys: ['curcumin'], citation: 'Daily JW et al. (2016). Efficacy of Turmeric Extracts and Curcumin for Alleviating the Symptoms of Joint Arthritis: A Systematic Review and Meta-Analysis of Randomized Clinical Trials. J Med Food. PMID: 27533649.' },
  { nutrient: 'Iron', keys: ['iron'], citation: 'Supported by WHO guidelines on iron deficiency and NIH Office of Dietary Supplements iron fact sheet.' },
  { nutrient: "Lion's Mane", keys: ['lion'], citation: 'Menon A et al. (2025). Benefits, side effects, and uses of Hericium erinaceus as a supplement: a systematic review. Front Nutr. PMID: 40959699.' },
  { nutrient: 'Berberine', keys: ['berberine'], citation: 'Zhao H et al. (2021). Comparative efficacy of oral insulin sensitizers metformin, thiazolidinediones, inositol, and berberine in improving endocrine and metabolic profiles in women with PCOS: a network meta-analysis. Reprod Health. PMID: 34407851.' },
  { nutrient: 'Vitamin C', keys: ['vitamin c'], citation: 'Supported by Carr & Maggini (2017) Nutrients review on Vitamin C and immune function (PMID: 29099763).' },
  { nutrient: 'Vitamin B6', keys: ['vitamin b6', 'pyridoxine'], citation: 'Supported by NIH Office of Dietary Supplements Vitamin B6 Fact Sheet and Calderón-Ospina & Nava-Mesa (2020) CNS Neuroscience & Therapeutics on B6 in neurotransmitter synthesis (PMID: 31490017).' },
  { nutrient: 'Vitamin K2', keys: ['vitamin k2', 'mk-7', 'menaquinone'], citation: 'Ma ML et al. (2022). Efficacy of vitamin K2 in the prevention and treatment of postmenopausal osteoporosis: A systematic review and meta-analysis of randomized controlled trials. Front Public Health. PMID: 36033779.' },
  { nutrient: 'Vitamin K', keys: ['vitamin k'], citation: 'Supported by NIH Office of Dietary Supplements Vitamin K Fact Sheet and studies on bone and cardiovascular health.' },
  { nutrient: 'Vitamin A', keys: ['vitamin a', 'retinol'], citation: 'Supported by NIH Office of Dietary Supplements Vitamin A Fact Sheet and WHO guidelines on Vitamin A deficiency.' },
  { nutrient: 'Vitamin E', keys: ['vitamin e', 'tocopherol'], citation: 'Supported by NIH Office of Dietary Supplements Vitamin E Fact Sheet and antioxidant research.' },
  { nutrient: 'Folate', keys: ['folate', 'folic'], citation: 'Supported by CDC and WHO guidelines on folate for neural tube defect prevention and NIH folate fact sheet.' },
  { nutrient: 'Riboflavin / B2', keys: ['riboflavin', 'vitamin b2'], citation: 'Supported by NIH Office of Dietary Supplements Riboflavin Fact Sheet and studies on migraine prevention (PMID: 9484373).' },
  { nutrient: 'Niacin / B3', keys: ['niacin', 'vitamin b3'], citation: 'Supported by NIH Office of Dietary Supplements Niacin Fact Sheet and AHA guidelines on niacin for lipid management.' },
  { nutrient: 'Thiamine / B1', keys: ['thiamine', 'vitamin b1'], citation: 'Supported by NIH Office of Dietary Supplements Thiamine Fact Sheet and studies on neurological function.' },
  { nutrient: 'Biotin', keys: ['biotin', 'vitamin b7'], citation: 'Supported by Patel et al. (2017) Skin Appendage Disorders review on biotin and hair/nail health (PMID: 28879195).' },
  { nutrient: 'Calcium', keys: ['calcium'], citation: 'Supported by NIH Office of Dietary Supplements Calcium Fact Sheet and National Osteoporosis Foundation guidelines on bone health.' },
  { nutrient: 'Selenium', keys: ['selenium'], citation: 'Vinceti M et al. (2018). Selenium exposure and the risk of type 2 diabetes: a systematic review and meta-analysis. Eur J Epidemiol. PMID: 29974401.' },
  { nutrient: 'Iodine', keys: ['iodine'], citation: 'Supported by WHO guidelines on iodine deficiency disorders and NIH Office of Dietary Supplements Iodine Fact Sheet.' },
  { nutrient: 'Potassium', keys: ['potassium'], citation: 'Supported by NIH Office of Dietary Supplements Potassium Fact Sheet and AHA guidelines on potassium and blood pressure.' },
  { nutrient: 'Copper', keys: ['copper'], citation: 'Supported by NIH Office of Dietary Supplements Copper Fact Sheet and studies on copper in immune function and antioxidant defense.' },
  { nutrient: 'Manganese', keys: ['manganese'], citation: 'Supported by NIH Office of Dietary Supplements Manganese Fact Sheet and studies on manganese in bone formation and antioxidant enzymes.' },
  { nutrient: 'Molybdenum', keys: ['molybdenum'], citation: 'Supported by NIH Office of Dietary Supplements Molybdenum Fact Sheet and studies on molybdenum as an essential trace mineral cofactor.' },
  { nutrient: 'Chromium', keys: ['chromium'], citation: 'Asbaghi O et al. (2020). Effects of chromium supplementation on glycemic control in patients with type 2 diabetes: a systematic review and meta-analysis of randomized controlled trials. Pharmacol Res. PMID: 32730903.' },
  { nutrient: 'Krill oil', keys: ['krill'], citation: 'Ursoniu S et al. (2017). Lipid-modifying effects of krill oil in humans: systematic review and meta-analysis of randomized controlled trials. Nutr Rev. PMID: 28371906.' },
  { nutrient: 'Rhodiola', keys: ['rhodiola'], citation: 'Lu Y et al. (2022). Effects of Rhodiola Rosea Supplementation on Exercise and Sport: A Systematic Review. Front Nutr. PMID: 35464040.' },
  { nutrient: 'Ginseng', keys: ['ginseng', 'panax'], citation: 'Supported by Kim et al. (2018) Journal of Ginseng Research systematic review on Panax ginseng and cognitive performance (PMID: 29719460).' },
  { nutrient: 'Maca', keys: ['maca'], citation: 'Stojanovska L et al. (2015). Maca reduces blood pressure and depression, in a pilot study in postmenopausal women. Climacteric. PMID: 24931003.' },
  { nutrient: 'Valerian', keys: ['valerian'], citation: 'Shinjyo N et al. (2020). Valerian Root in Treating Sleep Problems and Associated Disorders-A Systematic Review and Meta-Analysis. J Evid Based Integr Med. PMID: 33086877.' },
  { nutrient: 'Elderberry', keys: ['elderberry', 'sambucus'], citation: 'Supported by Hawkins et al. (2019) Complementary Therapies in Medicine RCT on elderberry and cold/flu symptoms (PMID: 30670267).' },
  { nutrient: 'Echinacea', keys: ['echinacea'], citation: 'David S et al. (2019). Echinacea for the prevention and treatment of upper respiratory tract infections: A systematic review and meta-analysis. Complement Ther Med. PMID: 31126553.' },
  { nutrient: 'Milk thistle', keys: ['milk thistle', 'silymarin'], citation: 'Tao L et al. (2019). Prophylactic Therapy of Silymarin (Milk Thistle) on Antituberculosis Drug-Induced Liver Injury: A Meta-Analysis of Randomized Controlled Trials. Can J Gastroenterol Hepatol. PMID: 30733935.' },
  { nutrient: 'Ginkgo', keys: ['ginkgo'], citation: 'Tan MS et al. (2015). Efficacy and adverse effects of ginkgo biloba for cognitive impairment and dementia: a systematic review and meta-analysis. J Alzheimers Dis. PMID: 25114079.' },
  { nutrient: 'Bacopa', keys: ['bacopa'], citation: 'Tiemtad P et al. (2026). Comparative effects of Bacopa monnieri and Ginkgo biloba on cognitive functions: A systematic review and network meta-analysis. Phytomedicine. PMID: 41678913.' },
  { nutrient: 'L-Theanine', keys: ['theanine'], citation: 'Bulman A et al. (2025). The effects of L-theanine consumption on sleep outcomes: A systematic review and meta-analysis. Sleep Med Rev. PMID: 40056718.' },
  { nutrient: 'Alpha-lipoic acid', keys: ['alpha-lipoic', 'lipoic'], citation: 'Rahimlou M et al. (2019). Alpha-lipoic acid (ALA) supplementation effect on glycemic and inflammatory biomarkers: A Systematic Review and meta-analysis. Clin Nutr ESPEN. PMID: 31221283.' },
  { nutrient: 'Resveratrol', keys: ['resveratrol'], citation: 'Liu Y et al. (2015). Effect of resveratrol on blood pressure: a meta-analysis of randomized controlled trials. Clin Nutr. PMID: 24731650.' },
  { nutrient: 'Glucosamine', keys: ['glucosamine'], citation: 'Simental-Mendía M et al. (2018). Effect of glucosamine and chondroitin sulfate in symptomatic knee osteoarthritis: a systematic review and meta-analysis of randomized placebo-controlled trials. Rheumatol Int. PMID: 29947998.' },
  { nutrient: 'Chondroitin', keys: ['chondroitin'], citation: 'Singh JA et al. (2015). Chondroitin for osteoarthritis. Cochrane Database Syst Rev. PMID: 25629804.' },
  { nutrient: 'Collagen', keys: ['collagen'], citation: 'de Miranda RB et al. (2021). Effects of hydrolyzed collagen supplementation on skin aging: a systematic review and meta-analysis. Int J Dermatol. PMID: 33742704.' },
  { nutrient: 'Boswellia', keys: ['boswellia'], citation: 'Bannuru RR et al. (2018). Efficacy of curcumin and Boswellia for knee osteoarthritis: Systematic review and meta-analysis. Semin Arthritis Rheum. PMID: 29622343.' },
  { nutrient: 'Creatine', keys: ['creatine'], citation: 'Supported by ISSN Position Stand on creatine monohydrate (Kreider et al., 2017, PMID: 28615996).' },
  { nutrient: 'Melatonin', keys: ['melatonin'], citation: 'Fatemeh G et al. (2022). Effect of melatonin supplementation on sleep quality: a systematic review and meta-analysis of randomized controlled trials. J Neurol. PMID: 33417003.' },
  { nutrient: '5-HTP', keys: ['5-htp'], citation: 'Zamoscik V et al. (2021). Tryptophan-enriched diet or 5-hydroxytryptophan supplementation given in a randomized controlled trial impacts social cognition on a neural and behavioral level. Sci Rep. PMID: 34737364.' },
  { nutrient: 'Tart cherry', keys: ['tart cherry'], citation: 'Gao R et al. (2020). Effect of Tart Cherry Concentrate on Endurance Exercise Performance: A Meta-analysis. J Am Coll Nutr. PMID: 31986108.' },
  { nutrient: 'Garlic', keys: ['garlic', 'allicin'], citation: 'Supported by Ried et al. (2016) Journal of Nutrition meta-analysis on garlic and blood pressure (PMID: 26764327).' },
  { nutrient: 'Nattokinase', keys: ['nattokinase'], citation: 'Li X et al. (2023). Nattokinase Supplementation and Cardiovascular Risk Factors: A Systematic Review and Meta-Analysis of Randomized Controlled Trials. Rev Cardiovasc Med. PMID: 39076715.' },
  { nutrient: 'Saw palmetto', keys: ['saw palmetto'], citation: 'Vela-Navarrete R et al. (2018). Efficacy and safety of a hexanic extract of Serenoa repens (Permixon) for the treatment of lower urinary tract symptoms associated with benign prostatic hyperplasia (LUTS/BPH): systematic review and meta-analysis of randomised controlled trials and observational studies. BJU Int. PMID: 29694707.' },
  { nutrient: 'Vitex', keys: ['vitex', 'chaste'], citation: 'Verkaik S et al. (2017). The treatment of premenstrual syndrome with preparations of Vitex agnus castus: a systematic review and meta-analysis. Am J Obstet Gynecol. PMID: 28237870.' },
  { nutrient: 'Tribulus', keys: ['tribulus'], citation: 'Supported by Roaiah et al. (2016) Journal of Sex & Marital Therapy RCT on Tribulus terrestris and sexual function (PMID: 26727646).' },
  { nutrient: 'Hyaluronic acid', keys: ['hyaluronic'], citation: 'Amin P et al. (2025). Oral Hyaluronic Acid Supplement: Efficacy in Skin Hydration, Elasticity, and Wrinkle Depth Reduction. J Drugs Dermatol. PMID: 40911749.' },
  { nutrient: 'Astaxanthin', keys: ['astaxanthin'], citation: 'Xia W et al. (2020). The effects of astaxanthin supplementation on obesity, blood pressure, CRP, glycemic biomarkers, and lipid profile: A meta-analysis of randomized controlled trials. Pharmacol Res. PMID: 32755613.' },
  { nutrient: 'Phosphatidylserine', keys: ['phosphatidylserine'], citation: 'Duan H et al. (2025). Effects of a food supplement containing phosphatidylserine on cognitive function in Chinese older adults with mild cognitive impairment: A randomized double-blind, placebo-controlled trial. J Affect Disord. PMID: 39317299.' },
  { nutrient: 'HMB', keys: ['hmb', 'beta-hydroxy'], citation: 'Jakubowski JS et al. (2020). Supplementation with the Leucine Metabolite beta-hydroxy-beta-methylbutyrate (HMB) does not Improve Resistance Exercise-Induced Changes in Body Composition or Strength in Young Subjects: A Systematic Review and Meta-Analysis. Nutrients. PMID: 32456217.' },
  { nutrient: 'Citrulline', keys: ['citrulline'], citation: 'Mirenayat MS et al. (2018). Effect of L-Citrulline Supplementation on Blood Pressure: a Systematic Review and Meta-Analysis of Clinical Trials. Curr Hypertens Rep. PMID: 30284051.' },
  { nutrient: 'Beta-alanine', keys: ['beta-alanine'], citation: 'Ashtary-Larky D et al. (2022). Effects of beta-alanine supplementation on body composition: a GRADE-assessed systematic review and meta-analysis. J Int Soc Sports Nutr. PMID: 35813845.' },
  { nutrient: 'Whey protein', keys: ['whey'], citation: 'Kuo YY et al. (2022). Effect of Whey Protein Supplementation in Postmenopausal Women: A Systematic Review and Meta-Analysis. Nutrients. PMID: 36235862.' },
  { nutrient: 'Protein supplement', keys: ['protein'], all: ['supplement'], citation: 'Supported by Morton et al. (2018) British Journal of Sports Medicine meta-analysis on protein supplementation and muscle mass (PMID: 28698222).' },
];

/**
 * The honest gap. A plan that admits "no source identified" is clinically
 * safer than one that names a study that does not exist, so this is the value
 * the verifier substitutes whenever it has to strip an unverifiable citation
 * and the registry holds nothing for that nutrient.
 */
const HONEST_MARKER = 'No specific source identified';

/**
 * The unattributed-but-true default the rule engine uses for nutrients with no
 * registry entry. No fake study, no fake number: it names the bodies the app's
 * evidence comes from and tells the member to ask a provider.
 */
const GENERIC_EVIDENCE = 'Supported by peer-reviewed research from 2020-2025 indexed in PubMed and current evidence-based guidelines from the NIH Office of Dietary Supplements. Evidence prioritizes systematic reviews, meta-analyses, and clinical practice guidelines. Consult a healthcare provider for personalized evidence review. This recommendation is provided as wellness guidance and does not diagnose, treat, cure, or prevent any disease.';

const matchesEntry = (n, entry) => (entry.keys || []).some((k) => n.includes(k))
  && (entry.all || []).every((a) => n.includes(a));

/** The registry entry for a supplement name, or null. First match wins. */
function evidenceEntry(name) {
  const n = String(name || '').toLowerCase();
  if (!n.trim()) return null;
  return ENTRIES.find((entry) => matchesEntry(n, entry)) || null;
}

/**
 * The curated citation for a supplement name, or GENERIC_EVIDENCE — the exact
 * behaviour `inferEvidence` had before this table moved here.
 */
function registeredEvidence(name) {
  const entry = evidenceEntry(name);
  return entry ? entry.citation : GENERIC_EVIDENCE;
}

/** True when `text` is word-for-word a citation this app ships. */
function isRegisteredCitation(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return s === HONEST_MARKER || s === GENERIC_EVIDENCE
    || ENTRIES.some((entry) => entry.citation.trim() === s);
}

// -- Identifier extraction ---------------------------------------------------
// Two shapes carry a hard claim: "PMID: 12345678" and a PubMed link. Both are
// checkable against the registry, and both are what a model invents most
// confidently.
const PMID_PATTERNS = [
  /PMID[:\s#]*\s*(\d{6,8})/gi,
  /pubmed\.ncbi\.nlm\.nih\.gov\/(?:[\w-]+\/)?(\d{6,8})/gi,
];

/** Every PMID a piece of text asserts, de-duplicated, as strings. */
function extractPmids(text) {
  const out = new Set();
  const s = String(text || '');
  for (const pattern of PMID_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(s)) !== null) out.add(m[1]);
  }
  return [...out];
}

/**
 * PMIDs the app can vouch for: every identifier inside a registry citation.
 * Built once at require time; the registry is static data, so an entry that
 * cites a PMID is by definition an allowlisted one.
 */
function allowlistedPmids() {
  const set = new Set();
  for (const entry of ENTRIES) for (const id of extractPmids(entry.citation)) set.add(id);
  return set;
}

// -- Prompt injection --------------------------------------------------------
/**
 * The citation half of the [DOMAIN KNOWLEDGE BASE] block. Length is the cost,
 * and it is paid deliberately: ~7KB of exact strings in the prompt is what
 * removes the model's need to recall a study, and recall is where invented
 * PMIDs come from. Entries are printed in registry order so the block — and
 * therefore the prompt — is byte-stable between runs.
 */
function citationRegistryPromptBlock() {
  const lines = ENTRIES.map((entry) => `   - ${entry.nutrient}: ${entry.citation}`);
  return [
    '9. CITATION REGISTRY — the ONLY evidence statements this app is allowed to show a member.',
    '   Copy one of these strings EXACTLY, word for word, and only for the nutrient it names:',
    ...lines,
    `   - Any other nutrient: write exactly "${HONEST_MARKER}".`,
    '   NEVER write a PMID, a DOI, a journal title, an author name or a URL that is not already in a',
    '   string above. A citation you cannot copy from this registry is a gap in the app\'s knowledge,',
    '   not a fact you know: stating the gap is correct, inventing a source is a clinical error.',
  ].join('\n');
}

module.exports = {
  ENTRIES,
  HONEST_MARKER,
  GENERIC_EVIDENCE,
  evidenceEntry,
  registeredEvidence,
  isRegisteredCitation,
  extractPmids,
  allowlistedPmids,
  citationRegistryPromptLine: () => ENTRIES.map((e) => e.nutrient).join(', '),
  citationRegistryPromptBlock,
};
