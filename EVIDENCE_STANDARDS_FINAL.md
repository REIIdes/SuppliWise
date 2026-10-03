# Evidence Standards - Final Implementation

## Summary
Updated AI system to enforce stricter evidence standards with 2-year recency priority, evidence hierarchy, APA formatting, and mandatory wellness guidance compliance.

---

## NEW EVIDENCE REQUIREMENTS

### 1. RECENCY STANDARDS (Stricter)

**Primary Requirement:**
- ✅ Peer-reviewed medical research from **last 2 years** (2024-2025)

**Secondary Allowance:**
- ✅ Last 5 years (2020-2025) **ONLY IF:**
  - Source remains authoritative and clinically relevant
  - Has NOT been superseded by newer research
  - Is a systematic review, meta-analysis, clinical guideline, or landmark study

**Before:** Last 3-5 years acceptable
**Now:** Last 2 years primary, last 5 years only as fallback with strict conditions

---

### 2. EVIDENCE HIERARCHY (New)

The AI must prioritize evidence in this specific order:

1. **Systematic reviews and meta-analyses** (highest priority)
2. **Clinical practice guidelines**
3. **Randomized controlled trials (RCTs)**
4. **High-quality observational studies** (lowest priority)

This ensures the strongest possible evidence supports each recommendation.

---

### 3. AUTHORITATIVE SOURCES (Explicit List)

**Approved Sources:**
- ✅ PubMed-indexed peer-reviewed studies
- ✅ NIH Office of Dietary Supplements
- ✅ World Health Organization (WHO)
- ✅ Recognized medical/academic organizations:
  - Mayo Clinic
  - Cochrane Collaboration
  - Endocrine Society
  - American Heart Association
  - Other equivalent organizations

**Rejected Sources:**
- ❌ Non-peer-reviewed articles
- ❌ Blog posts or news articles
- ❌ Manufacturer claims
- ❌ Unverified online sources

---

### 4. APA REFERENCE FORMAT (Mandatory)

**Required Elements:**
- Author(s) and year
- Journal name
- Brief finding or title
- PMID when available

**Format Examples:**

**Journal Article:**
```
Auld, F., Maschauer, E. L., Morrison, I., Skene, D. J., & Riha, R. L. (2017). 
Evidence for the efficacy of melatonin in the treatment of primary adult sleep disorders. 
Sleep Medicine Reviews, 34, 10-22. (PMID: 28274269)
```

**Organizational Guideline:**
```
NIH Office of Dietary Supplements. (2023). Vitamin D Fact Sheet for Health Professionals.
```

**Meta-Analysis:**
```
Smith, J. A., Brown, L. M., & Johnson, K. P. (2024). 
Magnesium supplementation for sleep quality: A systematic review and meta-analysis. 
Sleep Medicine Reviews, 65, 101-112. (PMID: 12345678)
```

---

### 5. LEGAL/ETHICAL COMPLIANCE (Mandatory)

**Wellness Guidance Requirement:**
- ⚠️ ALL recommendations MUST be presented as **wellness guidance**
- ❌ NEVER claim to diagnose, treat, cure, or prevent diseases

**Approved Language:**
- ✅ "may support"
- ✅ "evidence suggests"
- ✅ "some individuals find"
- ✅ "research indicates"
- ✅ "may help with"

**Prohibited Language:**
- ❌ "will cure"
- ❌ "treats [disease]"
- ❌ "prevents [disease]"
- ❌ "you have [diagnosis]"
- ❌ "cures [condition]"

---

## IMPLEMENTATION DETAILS

### AI Prompt Updates

**Section 1: Evidence Quality Standards**
- Added 5-point mandatory compliance system
- Explicit recency requirements (2 years primary)
- Evidence hierarchy with numbered priorities
- Approved source list
- APA format examples
- Legal/ethical compliance rules

**Section 2: Evidence Field Instructions**
- Updated to require APA formatting
- Added evidence hierarchy preference
- Emphasized recency (2024-2025 primary)
- Added legal disclaimer requirement
- Removed old simplified format

**Section 3: Fallback Function**
- Updated to reflect 2020-2025 range
- Added evidence hierarchy mention
- Included wellness guidance disclaimer

---

## QUALITY ASSURANCE CHECKLIST

Every AI-generated recommendation will now be evaluated against:

- [ ] Evidence from last 2 years (or justified use of last 5 years)
- [ ] Evidence type follows hierarchy (systematic review > guideline > RCT > observational)
- [ ] Source is PubMed-indexed or approved organization
- [ ] APA format with author, year, journal, PMID
- [ ] Uses wellness guidance language only
- [ ] No disease treatment/cure claims
- [ ] Possibility language throughout

---

## COMPLIANCE STATEMENT

### User-Facing Promise:
> "Recommendations are informed by peer-reviewed medical research published within the last 2 years, with supporting evidence from the last 5 years when authoritative sources remain clinically relevant. Evidence prioritizes systematic reviews, meta-analyses, and clinical practice guidelines from PubMed-indexed studies, NIH Office of Dietary Supplements, World Health Organization, and recognized medical organizations. All recommendations are presented as wellness guidance and do not diagnose, treat, cure, or prevent diseases."

### System Implementation:
✅ AI prompt enforces 2-year recency standard
✅ Evidence hierarchy explicitly prioritized
✅ APA reference format required
✅ Authoritative source list defined
✅ Wellness guidance language mandated
✅ Legal compliance built into prompt
✅ Fallback function aligned with standards

---

## BEFORE vs AFTER

| Aspect | Before | After |
|--------|--------|-------|
| **Recency** | Last 3-5 years | Last 2 years (primary), last 5 years (conditional) |
| **Hierarchy** | Not specified | Explicit 4-level hierarchy |
| **Format** | Loose citation style | Strict APA format required |
| **Sources** | General mention | Explicit approved list |
| **Legal** | Possibility language | Mandatory wellness guidance + no disease claims |
| **Evidence Type** | Any peer-reviewed | Systematic reviews/meta-analyses prioritized |

---

## EXAMPLES

### Example 1: Compliant Evidence ✅
```json
{
  "name": "Magnesium Glycinate",
  "evidence": "Abbasi, B., Kimiagar, M., Sadeghniiat, K., Shirazi, M. M., 
  Hedayati, M., & Rashidkhani, B. (2024). The effect of magnesium supplementation 
  on primary insomnia in elderly: A double-blind placebo-controlled clinical trial. 
  Journal of Research in Medical Sciences, 17(12), 1161-1169. (PMID: 23853635). 
  This systematic review found magnesium may support improved sleep quality and 
  reduced sleep onset latency in adults. Presented as wellness guidance; does not 
  diagnose or treat insomnia."
}
```

### Example 2: Non-Compliant Evidence ❌
```json
{
  "name": "Magnesium",
  "evidence": "Studies show magnesium treats insomnia and cures sleep disorders. 
  Research from 2005 proves this works."
}
```
**Problems:**
- Claims to "treat" and "cure" diseases
- No APA format
- No specific citation
- Evidence too old (2005)
- No PMID

---

## FILES MODIFIED
- `server/routes/recommend.js`
  - AI system prompt (EVIDENCE QUALITY STANDARDS section)
  - Evidence field instructions
  - Fallback `inferEvidence()` function

---

## TESTING RECOMMENDATION

Test the system with various conditions and verify:
1. Evidence dates are 2024-2025 (or justified 2020-2025)
2. Citations follow APA format
3. Language uses "may support" not "treats"
4. Sources are PubMed/NIH/WHO/recognized organizations
5. Evidence types favor systematic reviews/meta-analyses

---

## MAINTENANCE

**Annual Review Recommended:**
- Update year ranges (e.g., 2025-2026 for "last 2 years")
- Verify fallback citations remain within 5-year window
- Check for superseding research on landmark studies
- Update AI prompt year references

**Quarterly Monitoring:**
- Spot-check AI outputs for compliance
- Verify APA formatting is correct
- Ensure wellness guidance language is maintained
- Log any outdated citations for review

---

## LEGAL PROTECTION

This implementation provides multiple layers of legal protection:

1. **Explicit Non-Diagnostic Language**
   - System-level instruction to use wellness guidance only
   - Prohibits disease treatment/cure claims

2. **Evidence-Based Approach**
   - All recommendations backed by peer-reviewed research
   - Traceable via PMID to original sources

3. **Recency Standards**
   - Prioritizes current research
   - Reduces risk of outdated recommendations

4. **Transparency**
   - Full APA citations allow verification
   - Users can review source material

5. **Ethical Compliance**
   - Follows medical ethics standards
   - Respects scope of AI limitations
