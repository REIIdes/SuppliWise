# Cascading Evidence Search Implementation

## Summary
Implemented a transparent 3-tier cascading evidence search system with mandatory labeling for landmark studies and clinical guidelines.

---

## THE CASCADING SEARCH PROCESS

### Tier 1: Recent Research (FIRST PRIORITY)
**Timeframe:** Last 2 years (2024-2025)  
**Action:** Search for peer-reviewed medical research  
**If Found:** Use this evidence (no special label needed)

### Tier 2: Supporting Evidence (SECOND PRIORITY)
**Timeframe:** Last 5 years (2020-2025)  
**Action:** If no suitable evidence from Tier 1, search last 5 years  
**Requirements:** Must be authoritative and clinically relevant  
**If Found:** Use this evidence (no special label needed)

### Tier 3: Landmark/Guidelines (LAST RESORT)
**Timeframe:** Older than 5 years  
**Action:** If no suitable evidence from Tier 1 or 2  
**Requirements:**
- Must be a landmark study or clinical guideline
- Still widely accepted in medical community
- Has NOT been contradicted by newer evidence

**If Found:** Use with **MANDATORY LABELING**
- Prefix with: `[LANDMARK STUDY]` or `[CLINICAL GUIDELINE]`
- Example: `[CLINICAL GUIDELINE] Institute of Medicine. (2011). Dietary Reference Intakes for Calcium and Vitamin D.`

---

## LABELING REQUIREMENTS

### When to Use Labels

| Evidence Type | Age | Label Required? | Example |
|---------------|-----|-----------------|---------|
| Recent research | 2024-2025 | ❌ No | Standard APA citation |
| Supporting evidence | 2020-2023 | ❌ No | Standard APA citation |
| Landmark study | Pre-2020 | ✅ **YES** | `[LANDMARK STUDY] Author et al. (Year)...` |
| Clinical guideline | Pre-2020 | ✅ **YES** | `[CLINICAL GUIDELINE] Organization. (Year)...` |

### Why Labeling Matters

**Transparency:** Users immediately know when evidence is older
**Trust:** Shows system honestly handles evidence age
**Context:** Users understand the citation's significance
**Compliance:** Demonstrates rigorous evidence standards

---

## IMPLEMENTATION DETAILS

### AI Prompt Changes

**Section 1: Recency Requirements**
```
1. RECENCY REQUIREMENTS (CASCADING SEARCH):
   ✅ FIRST: Search for peer-reviewed medical research published within the last 2 years (2024-2025)
   ✅ SECOND: If no suitable evidence from last 2 years exists, search within the last 5 years (2020-2025)
   ✅ THIRD: If no suitable evidence from last 5 years exists, use an older landmark study or 
      current clinical guideline ONLY if:
      - It is still widely accepted in the medical community
      - It has NOT been contradicted by newer evidence
      - You MUST clearly label it as "Landmark Study" or "Clinical Guideline" in the citation
   ⚠️ IMPORTANT: When using evidence older than 5 years, explicitly state: "[LANDMARK STUDY]" 
      or "[CLINICAL GUIDELINE]" at the start of the citation
```

**Section 2: Evidence Field Instructions**
Updated with:
- CASCADING SEARCH directive with numbered tiers
- Explicit labeling requirement for older evidence
- Example formats for both recent and landmark citations

### Frontend Changes

**Evidence Info Modal:**
Now shows cascading priority:
```
✅ Priority: Peer-reviewed research from the last 2 years
✅ If unavailable: Supporting evidence from last 5 years when clinically relevant
✅ If unavailable: Landmark studies or clinical guidelines still widely accepted and 
   not contradicted (clearly labeled)
```

**Evidence Sources Footer:**
```
Recommendations prioritize peer-reviewed research from the last 2 years. If unavailable, 
evidence from the last 5 years is used when authoritative and clinically relevant. If still 
unavailable, landmark studies or clinical guidelines that remain widely accepted and 
uncontradicted may be used (clearly labeled).
```

---

## EXAMPLES

### Example 1: Tier 1 Evidence (Recent) ✅
```json
{
  "evidence": "Smith, J. A., & Brown, L. M. (2024). Magnesium supplementation for 
  sleep quality: A systematic review and meta-analysis. Sleep Medicine Reviews, 
  65, 101-112. (PMID: 12345678). This systematic review found that magnesium may 
  support improved sleep quality in adults."
}
```
**No label needed** - Recent evidence from 2024

### Example 2: Tier 2 Evidence (5-Year) ✅
```json
{
  "evidence": "Johnson, K. P., Lee, M. H., & Davis, R. T. (2021). Omega-3 fatty 
  acids and cardiovascular health: A meta-analysis of randomized controlled trials. 
  Journal of the American Heart Association, 10(8), e019584. (PMID: 33876345). 
  Evidence suggests omega-3 supplementation may support cardiovascular health."
}
```
**No label needed** - Within 5-year window (2021)

### Example 3: Tier 3 Evidence (Landmark) ✅
```json
{
  "evidence": "[CLINICAL GUIDELINE] Institute of Medicine. (2011). Dietary Reference 
  Intakes for Calcium and Vitamin D. National Academies Press. This widely-accepted 
  guideline established reference intakes for calcium that remain the standard for 
  nutritional recommendations."
}
```
**Label required** - Older than 5 years, clearly marked as guideline

### Example 4: Tier 3 Evidence (Landmark Study) ✅
```json
{
  "evidence": "[LANDMARK STUDY] Holick, M. F., Binkley, N. C., Bischoff-Ferrari, 
  H. A., et al. (2011). Evaluation, treatment, and prevention of vitamin D deficiency: 
  An Endocrine Society clinical practice guideline. Journal of Clinical Endocrinology 
  & Metabolism, 96(7), 1911-1930. (PMID: 21646368). This landmark guideline remains 
  the definitive reference for vitamin D assessment and has not been superseded."
}
```
**Label required** - Landmark study from 2011, clearly marked

---

## QUALITY ASSURANCE

### AI Checklist (per recommendation)

- [ ] Searched for evidence from 2024-2025 first?
- [ ] If none found, searched 2020-2023 next?
- [ ] If still none found, using landmark/guideline?
- [ ] If using landmark/guideline, is it:
  - [ ] Still widely accepted?
  - [ ] Not contradicted by newer research?
  - [ ] Properly labeled with `[LANDMARK STUDY]` or `[CLINICAL GUIDELINE]`?
- [ ] Citation in proper APA format?
- [ ] Uses wellness guidance language?

### User Experience

**Transparent:** Users see when older evidence is used
**Educational:** Labels explain why older evidence is valid
**Trustworthy:** Honesty about evidence age builds credibility

---

## COMPARISON: BEFORE vs AFTER

| Aspect | Before | After |
|--------|--------|-------|
| **Search** | "Prioritize 2 years, use 5 years if needed" | 3-tier cascading search (2yr → 5yr → landmark) |
| **Old Evidence** | Allowed with conditions | Allowed ONLY if labeled as landmark/guideline |
| **Transparency** | No indication of age | Clear `[LANDMARK STUDY]` or `[CLINICAL GUIDELINE]` labels |
| **Process** | Vague fallback | Explicit cascading search with conditions |
| **User Info** | Generic recency mention | Detailed 3-tier explanation in modal |

---

## USER-FACING MESSAGING

### In Evidence Info Modal (ⓘ):
```
✅ Priority: Peer-reviewed research from the last 2 years
✅ If unavailable: Supporting evidence from last 5 years when clinically relevant
✅ If unavailable: Landmark studies or clinical guidelines still widely accepted 
   and not contradicted (clearly labeled)
```

### In Footer:
```
Recommendations prioritize peer-reviewed research from the last 2 years. If unavailable, 
evidence from the last 5 years is used when authoritative and clinically relevant. 
If still unavailable, landmark studies or clinical guidelines that remain widely accepted 
and uncontradicted may be used (clearly labeled).
```

---

## BENEFITS

### 1. Transparency
✅ Users know exactly when older evidence is used  
✅ Labels make evidence age immediately visible  
✅ Cascading process is clearly explained

### 2. Flexibility
✅ System can handle supplements with limited recent research  
✅ Allows use of definitive landmark studies  
✅ Permits current clinical guidelines when appropriate

### 3. Integrity
✅ Older evidence must meet strict criteria (widely accepted, not contradicted)  
✅ Mandatory labeling prevents confusion  
✅ Maintains high standards while being practical

### 4. Legal Protection
✅ Demonstrates thorough evidence search process  
✅ Shows system doesn't cherry-pick convenient studies  
✅ Clear documentation of evidence selection rationale

---

## REAL-WORLD SCENARIOS

### Scenario 1: Vitamin D
**Recent Evidence Available:** Yes (2024 meta-analyses exist)
**Action:** Use Tier 1 evidence from 2024
**Label:** None needed

### Scenario 2: Coenzyme Q10
**Recent Evidence Available:** Limited (2024 studies exist but are narrow)
**Action:** Use Tier 2 evidence from 2021-2023 systematic reviews
**Label:** None needed

### Scenario 3: Calcium & Vitamin D Intakes
**Recent Evidence Available:** Insufficient (2011 IOM guidelines remain definitive)
**Action:** Use Tier 3 - IOM (2011) Dietary Reference Intakes
**Label:** `[CLINICAL GUIDELINE]` - Required
**Justification:** Still widely accepted, not contradicted, official reference standard

### Scenario 4: Omega-3 for Cardiovascular Health
**Recent Evidence Available:** Yes (2023-2024 RCTs and meta-analyses)
**Action:** Use Tier 1 evidence from 2023-2024
**Label:** None needed
**Note:** Even though older landmark studies exist (e.g., GISSI-Prevenzione), use recent evidence first

---

## MAINTENANCE

### Annual Review
- Update year ranges (e.g., 2025-2026 for "last 2 years")
- Verify landmark studies remain uncontradicted
- Check if newer evidence has superseded guidelines

### Quarterly Audit
- Spot-check AI outputs for proper labeling
- Verify cascading search is being followed
- Ensure landmark/guideline justifications are valid

---

## FILES MODIFIED

1. **`server/routes/recommend.js`**
   - Updated RECENCY REQUIREMENTS section with cascading search
   - Added labeling requirements and examples
   - Updated evidence field instructions

2. **`my-react-app/src/Pages/ResultsPage.jsx`**
   - Updated evidence info modal with 3-tier explanation
   - Updated footer with cascading process description

---

## STATUS: ✅ COMPLETE

The system now has:
- ✅ Transparent 3-tier cascading evidence search
- ✅ Mandatory labeling for landmark studies and clinical guidelines
- ✅ Clear conditions for using older evidence
- ✅ User-visible explanation of evidence selection process
- ✅ Maintains high standards while being practical
- ✅ Legal protection through transparent documentation

**Backend + Frontend = Fully Implemented** 🎉
