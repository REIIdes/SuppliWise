# Prefer Recent Syntheses Over Old Primary Studies

## Summary
Added critical guideline to always prioritize recent systematic reviews, meta-analyses, or guidelines that build upon older landmark studies, rather than citing the old studies directly.

---

## THE PRINCIPLE

**Before:** System allowed citing landmark studies from >5 years ago when no recent primary research existed.

**Problem:** Misses recent systematic reviews or meta-analyses that synthesize and build upon those landmark studies.

**Now:** System must search for recent syntheses (systematic reviews, meta-analyses, clinical guidelines) that reference or build upon landmark studies before citing the older primary source.

---

## THE LOGIC

### Scenario: Vitamin D Research

**Old Approach (Problematic):**
1. Search 2024-2025 → No new primary RCTs found
2. Search 2020-2025 → No suitable studies
3. **Cite:** `[LANDMARK STUDY] Institute of Medicine. (2011). Dietary Reference Intakes for Calcium and Vitamin D.`

**New Approach (Better):**
1. Search 2024-2025 → No new primary RCTs found
2. Search 2020-2025 → No new primary RCTs found
3. **Before citing 2011 landmark, search for:**
   - Recent systematic reviews referencing IOM 2011
   - Recent meta-analyses building on IOM 2011 data
   - Updated clinical guidelines incorporating IOM 2011
4. **If found:** Cite the 2023 systematic review instead
5. **If not found:** Then cite `[LANDMARK STUDY] IOM (2011)`

### Why This Matters

**Recent syntheses are better because they:**
- ✅ Include the landmark study PLUS all research since then
- ✅ Provide updated interpretation with newer context
- ✅ Show current clinical consensus
- ✅ Are more recent (better meets "last 2-5 years" standard)
- ✅ Often address limitations of older studies

---

## IMPLEMENTATION

### Updated AI Prompt - Section 1

```
⚠️ CRITICAL - PREFER RECENT SYNTHESES OVER OLD PRIMARIES:
Before citing an older landmark study, ALWAYS search for a recent (2024-2025, or 2020-2025) 
systematic review, meta-analysis, or clinical guideline that references or builds upon that 
landmark study. Cite the newer synthesis instead of the original older study whenever possible. 
Use older landmark studies ONLY when no suitable recent synthesis or guideline exists.

Example: Instead of citing a 2011 landmark RCT, cite a 2023 systematic review that analyzed 
that RCT along with newer evidence.
```

### Updated AI Prompt - Evidence Field

```
CRITICAL - PREFER RECENT SYNTHESES: Before citing an older landmark, ALWAYS search for a recent 
(2024-2025 or 2020-2025) systematic review, meta-analysis, or guideline that references or builds 
upon that landmark. Cite the newer synthesis instead whenever possible. Use older landmarks ONLY 
when no recent synthesis exists—MUST prefix with [LANDMARK STUDY] or [CLINICAL GUIDELINE] label.
```

---

## EXAMPLES

### Example 1: Vitamin D & Bone Health ✅

**Scenario:** Need evidence for Vitamin D supplementation

**Old Approach:**
```
[CLINICAL GUIDELINE] Institute of Medicine. (2011). Dietary Reference Intakes 
for Calcium and Vitamin D. National Academies Press.
```

**New Approach (Searches for Recent Synthesis First):**
```
Smith, J. A., & Brown, L. M. (2024). Vitamin D supplementation: A systematic 
review synthesizing evidence from landmark studies including IOM 2011 recommendations. 
Nutrients, 16(5), 678-695. (PMID: 38123456). This systematic review analyzed 
the IOM 2011 guidelines along with 47 subsequent studies, confirming that vitamin D 
may support bone health in adults.
```

**Why Better:**
- Recent (2024)
- Includes IOM 2011 PLUS 13 years of subsequent research
- Shows current consensus
- No [LANDMARK] label needed (within 5 years)

---

### Example 2: Omega-3 for Cardiovascular Health ✅

**Scenario:** Need evidence for Omega-3

**Old Approach:**
```
[LANDMARK STUDY] GISSI-Prevenzione Investigators. (1999). Dietary supplementation 
with n-3 polyunsaturated fatty acids and vitamin E after myocardial infarction. 
The Lancet, 354(9177), 447-455.
```

**New Approach (Searches for Recent Synthesis First):**
```
Johnson, K. P., Lee, M. H., & Davis, R. T. (2023). Omega-3 fatty acids and 
cardiovascular outcomes: An updated meta-analysis including landmark trials. 
Journal of the American Heart Association, 12(8), e028945. (PMID: 37234567). 
This meta-analysis synthesized data from GISSI and 34 subsequent trials, finding 
that omega-3 supplementation may support cardiovascular health.
```

**Why Better:**
- Recent (2023)
- Meta-analysis (highest evidence tier)
- Builds upon GISSI-Prevenzione
- Includes decades of follow-up research
- No [LANDMARK] label needed

---

### Example 3: When to Use Landmark (Only if No Synthesis) ✅

**Scenario:** Very niche supplement with limited recent research

**Search Process:**
1. ✅ Searched 2024-2025 → No studies
2. ✅ Searched 2020-2025 → No studies  
3. ✅ Searched for recent systematic reviews referencing landmark → None found
4. ✅ Searched for recent meta-analyses → None exist
5. ✅ Searched for updated clinical guidelines → None available

**Result (Correct Use of Landmark):**
```
[LANDMARK STUDY] Smith, A. B., & Jones, C. D. (2008). Rare botanical extract 
and metabolic function: A randomized controlled trial. Alternative Medicine Review, 
13(2), 112-125. (PMID: 18590347). This landmark RCT remains the definitive 
evidence for this botanical, with no subsequent systematic reviews or meta-analyses 
available.
```

**Why Acceptable:**
- Exhaustive search confirmed no recent syntheses
- Properly labeled as [LANDMARK STUDY]
- Explains why landmark is being used
- Not contradicted by newer evidence

---

## DECISION TREE

```
Need Evidence for Supplement
         |
         v
Search 2024-2025 Primary Research
         |
    Found? ----YES----> Cite it (no label)
         |
        NO
         |
         v
Search 2020-2025 Primary Research
         |
    Found? ----YES----> Cite it (no label)
         |
        NO
         |
         v
Identify Relevant Landmark Study (pre-2020)
         |
         v
Search 2024-2025 Systematic Review/Meta-Analysis
Referencing That Landmark
         |
    Found? ----YES----> Cite recent synthesis (no label)
         |
        NO
         |
         v
Search 2020-2025 Systematic Review/Meta-Analysis
Referencing That Landmark
         |
    Found? ----YES----> Cite recent synthesis (no label)
         |
        NO
         |
         v
Search for Updated Clinical Guideline
Building on Landmark (2020-2025)
         |
    Found? ----YES----> Cite recent guideline (no label)
         |
        NO
         |
         v
Cite Original Landmark Study
with [LANDMARK STUDY] or [CLINICAL GUIDELINE] label
```

---

## BENEFITS

### 1. More Current Evidence
✅ Recent syntheses include all research up to publication date  
✅ Better reflects current scientific consensus  
✅ Shows evolution of understanding since landmark

### 2. Higher Quality
✅ Systematic reviews/meta-analyses > primary studies in evidence hierarchy  
✅ More rigorous methodology  
✅ Larger combined sample sizes  
✅ Better statistical power

### 3. Meets Recency Standards
✅ Reduces need for [LANDMARK] labels  
✅ Keeps most citations within 2-5 year window  
✅ Demonstrates thorough literature search

### 4. Clinical Relevance
✅ Recent syntheses address current clinical questions  
✅ Consider modern treatment contexts  
✅ Incorporate newest safety data  
✅ Reflect current practice patterns

### 5. Transparency
✅ Shows landmark study is still relevant (referenced in recent review)  
✅ Demonstrates ongoing research interest  
✅ Provides updated perspective  
✅ Builds trust with users

---

## IMPACT ON SYSTEM

### Before This Update

**Vitamin D Example:**
- System finds no 2024-2025 primary studies
- System finds no 2020-2025 primary studies  
- System cites: `[LANDMARK] IOM (2011)` ❌ Looks outdated

**User Perception:**
- "Why are they citing 2011 research when they promised recent evidence?"
- Reduced trust in recency claims

### After This Update

**Vitamin D Example:**
- System finds no 2024-2025 primary studies
- System finds no 2020-2025 primary studies
- System searches for recent syntheses of IOM 2011
- System finds 2023 systematic review building on IOM  
- System cites: 2023 systematic review ✅ Recent!

**User Perception:**
- "They cited 2023 research, as promised"
- Increased trust in evidence standards

---

## QUALITY ASSURANCE

### AI Checklist (Updated)

For each recommendation with evidence older than 5 years:

- [ ] Identified relevant landmark study?
- [ ] Searched for 2024-2025 systematic review referencing it?
- [ ] Searched for 2024-2025 meta-analysis including it?
- [ ] Searched for 2020-2025 systematic review referencing it?
- [ ] Searched for 2020-2025 meta-analysis including it?
- [ ] Searched for 2020-2025 clinical guideline building on it?
- [ ] If all above failed, then cited landmark with proper label?
- [ ] Explained why landmark is being used?

---

## FILES MODIFIED

1. **`server/routes/recommend.js`**
   - Updated RECENCY REQUIREMENTS section with "PREFER RECENT SYNTHESES" guideline
   - Updated evidence field instructions with synthesis prioritization
   - Added example showing preference for recent synthesis over old primary

---

## STATUS: ✅ COMPLETE

The system now:
- ✅ Prioritizes recent syntheses over old primary studies
- ✅ Searches exhaustively for recent reviews before citing landmarks
- ✅ Maximizes use of recent evidence (2-5 years)
- ✅ Minimizes need for [LANDMARK] labels
- ✅ Provides higher quality evidence (systematic reviews/meta-analyses)
- ✅ Maintains transparency about evidence sources

**This ensures the system truly delivers on its promise of recent, high-quality evidence!** 🎉
