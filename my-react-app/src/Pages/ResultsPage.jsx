import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { exportResultsToPDF } from '../utils/exportPDF';
import { getSupplementDetail } from '../api';
import './ResultsPage.css';

// Normalize special characters that may render as ? in some environments
function fixChars(str) {
  if (!str) return str;
  return String(str)
    // Fix corrupted em/en dash stored as literal '?' in DB (e.g. "Week 1 ? Build", "Hotline ? Call")
    .replace(/([a-zA-Z0-9])\s?\?\s?([a-zA-Z0-9])/g, '$1 - $2')
    // Standard Unicode em/en dash
    .replace(/[\u2013\u2014]/g, ' - ')
    // Smart quotes
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    // Ellipsis
    .replace(/\u2026/g, '...')
    // Strip remaining non-ASCII that aren't safe latin chars
    .replace(/[^\x00-\xFF]/g, '');
}

// Detect placeholder/template evidence text the AI failed to fill in
function isPlaceholderEvidence(text) {
  if (!text) return true;
  const t = text.toLowerCase();
  return (
    t.includes('author et al') ||
    t.includes('(year)') ||
    t.includes('xxxxxxx') ||
    t.includes('source 2 if applicable') ||
    t.includes('brief finding') ||
    t.includes('journal name') ||
    t.includes('cite 1-2') ||
    t.length < 15
  );
}

// Sanitize triggeredBy — normalize severity labels in parentheses to only Mild/Moderate/Severe
function cleanTriggeredBy(str) {
  if (!str) return str;
  // Replace any parenthetical severity that isn't Mild/Moderate/Severe with just the word
  return fixChars(str).replace(/\(([^)]+)\)/g, (match, inner) => {
    const normalized = inner.trim();
    if (/^(Mild|Moderate|Severe)$/i.test(normalized)) return `(${normalized})`;
    // Map common AI paraphrases back to proper labels
    if (/significant|severe|critical|extreme/i.test(normalized)) return '(Severe)';
    if (/moderate|medium|notable|marked/i.test(normalized)) return '(Moderate)';
    if (/mild|slight|minor|low/i.test(normalized)) return '(Mild)';
    // If not a severity label, keep as-is but run fixChars
    return `(${fixChars(normalized)})`;
  });
}
const priorityColor = { High: '#16a34a', Medium: '#d97706', Low: '#374151' };const priorityIcon = { High: '🔴', Medium: '🟡', Low: '🟢' };
const severityColor = { Severe: '#dc2626', Moderate: '#d97706', 'Mild to Moderate': '#f59e0b', Mild: '#22c55e', Preventive: '#6b7280' };

const SUPPLEMENT_ICONS = {
  magnesium: '🧲', 'vitamin d': '☀️', 'vitamin b': '💉', 'b12': '💉',
  omega: '🐟', 'fish oil': '🐟', iron: '🔴', zinc: '🛡️',
  'vitamin c': '🍊', calcium: '🦴', coq10: '❤️', probiotic: '🦠',
  ashwagandha: '🌿', "lion's mane": '🍄', curcumin: '🟡', berberine: '🌱',
  selenium: '⚡', collagen: '💪', creatine: '💪', melatonin: '🌙',
  'vitamin k': '🥦', riboflavin: '🟠', theanine: '🍵', glucosamine: '🦴',
};

function getSupplementIcon(name) {
  const n = (name || '').toLowerCase();
  for (const [key, icon] of Object.entries(SUPPLEMENT_ICONS)) {
    if (n.includes(key)) return icon;
  }
  return '💊';
}

function ConfidenceBar({ score, delay = 0 }) {
  const [width, setWidth] = useState(0);
  const [displayed, setDisplayed] = useState(0);
  const rafRef = useRef(null);

  // Animate the bar fill after mount (with optional stagger delay)
  useEffect(() => {
    const timer = setTimeout(() => setWidth(score), delay);
    return () => clearTimeout(timer);
  }, [score, delay]);

  // Count-up the number in sync with the bar
  useEffect(() => {
    if (width === 0) { setDisplayed(0); return; }
    const duration = 700; // ms — matches CSS transition
    const start = performance.now();
    const from = displayed;

    const tick = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out curve
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayed(Math.round(from + (score - from) * eased));
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  const color = score >= 85 ? '#22c55e' : score >= 75 ? '#d97706' : '#6b7280';

  return (
    <div className="confidence-bar-wrap">
      <div className="confidence-bar-track">
        <div
          className="confidence-bar-fill"
          style={{ width: `${width}%`, background: color }}
        />
      </div>
      <span className="confidence-label" style={{ color }}>{displayed}% match</span>
    </div>
  );
}

// Map generic food category words to specific examples
const FOOD_SPECIFICS = {
  'fatty fish':       'fatty fish (salmon, tuna, sardines, mackerel)',
  'leafy greens':     'leafy greens (spinach, kale, Swiss chard)',
  'leafy green':      'leafy greens (spinach, kale, Swiss chard)',
  'nuts':             'nuts (almonds, cashews, walnuts, pumpkin seeds)',
  'dairy':            'dairy (Greek yogurt, cheddar cheese, whole milk)',
  'dairy products':   'dairy (Greek yogurt, cheddar cheese, whole milk)',
  'citrus':           'citrus (oranges, grapefruit, kiwi)',
  'citrus fruits':    'citrus (oranges, grapefruit, kiwi)',
  'legumes':          'legumes (lentils, chickpeas, black beans)',
  'whole grains':     'whole grains (oats, brown rice, quinoa)',
  'lean meats':       'lean meats (chicken breast, turkey, lean beef)',
  'lean meat':        'lean meats (chicken breast, turkey, lean beef)',
  'red meat':         'red meat (beef, lamb, bison)',
  'shellfish':        'shellfish (oysters, clams, crab, shrimp)',
  'seeds':            'seeds (pumpkin seeds, sunflower seeds, chia seeds)',
  'berries':          'berries (blueberries, strawberries, raspberries)',
  'cruciferous vegetables': 'cruciferous vegetables (broccoli, Brussels sprouts, cauliflower)',
  'organ meats':      'organ meats (beef liver, chicken liver)',
  'fermented foods':  'fermented foods (kefir, kimchi, sauerkraut, miso)',
};

function expandFoodItem(item) {
  const lower = item.toLowerCase().trim();
  // If already expanded (has parentheses with examples), don't double-expand
  if (item.includes('(') && item.includes(')')) return item;
  for (const [key, expanded] of Object.entries(FOOD_SPECIFICS)) {
    if (lower === key || lower.startsWith(key + ' ') || lower.endsWith(' ' + key)) {
      // Preserve original casing of first letter
      return expanded.charAt(0).toUpperCase() + expanded.slice(1);
    }
  }
  return item;
}

// Strip sentence-like fragments from food strings (AI sometimes returns prose)
function sanitizeFoods(str) {
  if (!str) return str;
  // Remove trailing sentence fragments that start with connective words
  // e.g. ", such as salmon and sardines, are naturally rich in omega-3 fatty acids"
  let cleaned = str
    .replace(/,?\s*(such as|which are|are naturally|naturally rich|found in|including)[^,;]*/gi, '')
    .replace(/,?\s*are\s+[a-z].*$/gi, '')
    .trim()
    .replace(/,\s*$/, ''); // remove trailing comma
  return cleaned || str; // fallback to original if cleaning removed everything
}

// Split food string on commas/semicolons that are NOT inside parentheses
function splitFoods(str) {
  const items = [];
  let current = '';
  let depth = 0;
  for (const ch of str) {
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if ((ch === ',' || ch === ';') && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

// Parse food string into individual examples for display
function FoodExamples({ foods }) {
  if (!foods) return null;
  const cleaned = sanitizeFoods(foods);
  const items = splitFoods(cleaned).map(f => expandFoodItem(f)).filter(Boolean);
  const display = items.length > 0 ? items : [expandFoodItem(cleaned)];
  return (
    <div className="food-examples">
      {display.map((item, i) => (
        <span key={i} className="food-pill">{item}</span>
      ))}
    </div>
  );
}

// ── Evidence Info Modal ──────────────────────────────────────────────────
function EvidenceInfoModal({ onClose }) {
  const overlayRef = useRef(null);

  // Close on overlay click
  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) onClose();
  };

  // Close on Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div className="evidence-info-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="evidence-info-panel" role="dialog" aria-modal="true" aria-label="About Our Evidence">
        <div className="evidence-info-header">
          <h3 className="evidence-info-title">About Our Evidence</h3>
          <button className="evidence-info-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="evidence-info-body">
          <p className="evidence-info-intro">
            To provide reliable and up-to-date recommendations, this system prioritizes:
          </p>

          <div className="evidence-info-checklist">
            <div className="evidence-info-item">
              <span className="evidence-info-check">✅</span>
              <span>Priority: Peer-reviewed research from the last 2 years</span>
            </div>
            <div className="evidence-info-item">
              <span className="evidence-info-check">✅</span>
              <span>If unavailable: Supporting evidence from last 5 years when clinically relevant</span>
            </div>
            <div className="evidence-info-item">
              <span className="evidence-info-check">✅</span>
              <span>If unavailable: Landmark studies or clinical guidelines still widely accepted and not contradicted (clearly labeled)</span>
            </div>
            <div className="evidence-info-item">
              <span className="evidence-info-check">✅</span>
              <span>Quality hierarchy: systematic reviews & meta-analyses, clinical guidelines, RCTs, observational studies</span>
            </div>
            <div className="evidence-info-item">
              <span className="evidence-info-check">✅</span>
              <span>APA-formatted references with PMID from PubMed, NIH, WHO, and recognized medical organizations</span>
            </div>
          </div>

          <div className="evidence-info-disclaimer">
            <span className="evidence-info-warning-icon">⚠️</span>
            <p>
              <strong>Important:</strong> Recommendations are AI-assisted and intended for informational purposes only. 
              They should not replace professional medical advice, diagnosis, or treatment. Always consult a qualified 
              healthcare professional before starting, stopping, or changing any supplement regimen.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Supplement Detail Modal ──────────────────────────────────────────────
function SupplementDetailModal({ supplementName, assessmentId, context, cache, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const overlayRef = useRef(null);

  // localStorage key — scoped to assessment ID so new assessments always fetch fresh from Groq
  const storageKey = `sdm_${assessmentId}_${supplementName.toLowerCase().trim()}`;
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  // Helpers: read/write localStorage with expiry
  const readCache = (key) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const { data, expiresAt } = JSON.parse(raw);
      if (Date.now() > expiresAt) { localStorage.removeItem(key); return null; } // expired
      return data;
    } catch { return null; }
  };

  const writeCache = (key, data) => {
    try {
      localStorage.setItem(key, JSON.stringify({ data, expiresAt: Date.now() + CACHE_TTL_MS }));
    } catch { /* storage full — skip silently */ }
  };

  useEffect(() => {
    let cancelled = false;

    // 1. Check in-memory cache first (fastest — same page session)
    if (cache.current[storageKey]) {
      setDetail(cache.current[storageKey]);
      setLoading(false);
      return;
    }

    // 2. Check localStorage (persists across browser restarts, expires after 30 days)
    const stored = readCache(storageKey);
    if (stored) {
      cache.current[storageKey] = stored; // warm in-memory cache too
      setDetail(stored);
      setLoading(false);
      return;
    }

    // 3. Cache miss — call Groq
    setLoading(true);
    setError('');
    getSupplementDetail(supplementName, context)
      .then(data => {
        if (!cancelled) {
          cache.current[storageKey] = data;
          writeCache(storageKey, data);
          setDetail(data);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err.message || 'Could not load details.');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [supplementName, assessmentId, storageKey, context, cache]);

  // Close on overlay click
  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) onClose();
  };

  // Close on Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div className="sdm-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="sdm-panel" role="dialog" aria-modal="true" aria-label={`Details for ${supplementName}`}>
        {/* Header */}
        <div className="sdm-header">
          <div className="sdm-header-left">
            <span className="sdm-header-icon">{getSupplementIcon(supplementName)}</span>
            <h2 className="sdm-title">{detail?.name || supplementName}</h2>
          </div>
          <button className="sdm-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="sdm-body">
          {loading && (
            <div className="sdm-loading">
              <div className="sdm-spinner" />
              <p>Loading supplement details…</p>
            </div>
          )}

          {error && !loading && (
            <div className="sdm-error">
              <span>⚠️</span>
              <p>{error}</p>
            </div>
          )}

          {detail && !loading && (
            <>
              {/* Overview */}
              {detail.overview && (
                <p className="sdm-overview">{detail.overview}</p>
              )}

              {/* Key Benefits */}
              {detail.keyBenefits?.length > 0 && (
                <div className="sdm-section">
                  <h3 className="sdm-section-title">Key Benefits &amp; Use Cases</h3>
                  <div className="sdm-benefits">
                    {detail.keyBenefits.map((b, i) => (
                      <div key={i} className="sdm-benefit-item">
                        <span className="sdm-benefit-title">{b.title}</span>
                        <p className="sdm-benefit-desc">{b.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* How to Take */}
              {detail.howToTake?.length > 0 && (
                <div className="sdm-section">
                  <h3 className="sdm-section-title">How to Take It</h3>
                  <div className="sdm-howtotake">
                    {detail.howToTake.map((h, i) => (
                      <div key={i} className="sdm-howtotake-item">
                        <span className="sdm-howtotake-label">{h.title}</span>
                        <p className="sdm-howtotake-desc">{h.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Considerations & Safety */}
              {detail.considerations?.length > 0 && (
                <div className="sdm-section">
                  <h3 className="sdm-section-title">Considerations &amp; Safety</h3>
                  <ul className="sdm-considerations">
                    {detail.considerations.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Availability */}
              {detail.availability && (
                <div className="sdm-section sdm-availability">
                  <h3 className="sdm-section-title">Availability</h3>
                  <p>{detail.availability}</p>
                </div>
              )}

              {/* Disclaimer */}
              <p className="sdm-disclaimer">{detail.disclaimer}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SupplementCard({ rec, index = 0, expanded, onToggle, onOpenDetail, detailMode = 'simplified', setShowEvidenceInfo }) {
  const icon = getSupplementIcon(rec.name);
  const pColor = priorityColor[rec.priority] || '#6b7280';
  const pIcon = priorityIcon[rec.priority] || '⚪';

  // Choose which version of the text to display based on mode
  const displayReason = detailMode === 'detailed' ? rec.reason : (rec.simplifiedReason || rec.reason);
  const displayEvidence = detailMode === 'detailed' ? rec.evidence : (rec.simplifiedEvidence || rec.evidence);

  // Simplified mode: cleaner, bigger, friendlier UI
  if (detailMode === 'simplified') {
    return (
      <div className="rec-card rec-card-simple">
        {/* Large icon at top */}
        <div className="rec-simple-icon">{icon}</div>
        
        {/* Supplement name - larger, more prominent */}
        <h3 className="rec-simple-name">{rec.name}</h3>
        
        {/* What it does - large, easy to read */}
        <p className="rec-simple-benefit">{fixChars(displayReason)}</p>
        
        {/* Dosage - simplified display */}
        <div className="rec-simple-dosage">
          <div className="rec-simple-dosage-item">
            <span className="rec-simple-label">💊 Take</span>
            <span className="rec-simple-value">{rec.dosage}</span>
          </div>
          <div className="rec-simple-dosage-item">
            <span className="rec-simple-label">⏰ When</span>
            <span className="rec-simple-value">{rec.timing}</span>
          </div>
        </div>

        {/* Simple expand button */}
        {rec.foods && (
          <button className="rec-simple-expand" onClick={() => onToggle()}>
            {expanded ? '▲ Show Less' : '▼ See Food Sources'}
          </button>
        )}

        {/* Expanded content - just food sources */}
        {expanded && rec.foods && (
          <div className="rec-simple-expanded">
            <div className="rec-simple-foods">
              <span className="rec-simple-foods-label">🥗 Also found in:</span>
              <FoodExamples foods={rec.foods} />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Detailed mode: original detailed UI
  return (
    <div className="rec-card">
      {/* Priority badge — at the very top before the supplement name */}
      <div className="rec-priority-top">
        <span className="rec-priority-label" style={{ background: pColor + '15', color: pColor, border: `1px solid ${pColor}40` }}>
          {pIcon} {rec.priority} Priority
        </span>
      </div>

      {/* Supplement name — clickable to open detail modal */}
      <div className="rec-name-row rec-name-clickable" onClick={onOpenDetail} title="Click for detailed info" role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onOpenDetail()}>
        <span className="rec-icon-large">{icon}</span>
        <div className="rec-name-text-wrap">
          <h3 className="rec-name-large">{rec.name}</h3>
          <span className="rec-name-hint">Tap for details ›</span>
        </div>
      </div>

      {/* Confidence bar — larger and more prominent */}
      {rec.confidenceScore && (
        <div className="rec-confidence-section">
          <span className="rec-confidence-title">Recommendation Match</span>
          <ConfidenceBar score={rec.confidenceScore} delay={index * 120} />
        </div>
      )}

      {rec.triggeredBy && detailMode === 'detailed' && (
        <div className="rec-triggered">
          <span className="rec-triggered-label">Recommended for:</span>
          {cleanTriggeredBy(rec.triggeredBy)}
        </div>
      )}

      {rec.conditionContext && detailMode === 'detailed' && (
        <div className="rec-condition-context">
          <span className="rec-condition-context-icon">🩺</span>
          <p>{fixChars(rec.conditionContext)}</p>
        </div>
      )}

      <p className="rec-reason">{fixChars(displayReason)}</p>

      <div className="rec-details">
        <div className="rec-detail">
          <span className="rec-detail-label">💊 Dosage</span>
          <span>{rec.dosage}</span>
        </div>
        <div className="rec-detail">
          <span className="rec-detail-label">⏰ Best Time</span>
          <span>{rec.timing}</span>
        </div>
        {/* Duration — how long to take the supplement */}
        {rec.duration && (
          <div className="rec-detail">
            <span className="rec-detail-label">📅 Duration</span>
            <span>{rec.duration}</span>
          </div>
        )}
        {rec.interactions && rec.interactions !== 'None identified' && (
          <div className="rec-detail rec-interaction">
            <span className="rec-detail-label">⚠ Interactions</span>
            <span>{rec.interactions}</span>
          </div>
        )}
      </div>

      <button className="rec-expand-btn" onClick={() => onToggle()}>
        {expanded ? '▲ Less details' : '▼ More details'}
      </button>

      {expanded && (
        <div className="rec-expanded">
          {displayEvidence && !isPlaceholderEvidence(displayEvidence) && (
            <div className={`rec-expanded-section ${detailMode === 'simplified' ? 'rec-expanded-simple-evidence' : 'rec-expanded-evidence'}`}>
              <span className="rec-expanded-label">
                {detailMode === 'simplified' ? '✓ Backed by Research' : '📚 Evidence & References'}
                {detailMode === 'detailed' && (
                  <button
                    className="evidence-info-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowEvidenceInfo(true);
                    }}
                    aria-label="About our evidence"
                    title="Learn about our evidence sources"
                  >
                    ⓘ
                  </button>
                )}
              </span>
              <p>{fixChars(displayEvidence)}</p>
            </div>
          )}
          {rec.foods && (
            <div className="rec-expanded-section rec-expanded-foods">
              <span className="rec-expanded-label">🥗 Food Sources</span>
              <FoodExamples foods={rec.foods} />
            </div>
          )}
          {rec.sideEffects && detailMode === 'detailed' && (
            <div className="rec-expanded-section rec-expanded-sideeffects">
              <span className="rec-expanded-label">⚠ Side Effects &amp; Safe Limits</span>
              <p>{fixChars(rec.sideEffects)}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { recommendations: r, assessment, garbageFields = [] } = location.state || {};

  // Scroll to top when results page mounts
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  // Get current user email from localStorage for cache scoping (unique per account)
  const currentUserId = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}').email || 'guest'; } catch { return 'guest'; }
  })();
  const assessmentId = assessment?._id || assessment?.id || 'unknown';
  // Cache key includes userId so different accounts never share cached details
  const cacheScope = `${currentUserId}_${assessmentId}`;
  
  // Detail mode toggle: 'detailed' (technical/medical) or 'simplified' (friendly)
  const [detailMode, setDetailMode] = useState(() => {
    try {
      return localStorage.getItem('suppliwise_detail_mode') || 'simplified';
    } catch {
      return 'simplified';
    }
  });
  
  const [exporting, setExporting] = useState(false);
  const [expandedCardsSimplified, setExpandedCardsSimplified] = useState(new Set());
  const [expandedCardsDetailed, setExpandedCardsDetailed] = useState(new Set());
  const [showAllRecs, setShowAllRecs] = useState(false);
  const [detailSupplement, setDetailSupplement] = useState(null);
  const [showEvidenceInfo, setShowEvidenceInfo] = useState(false);
  const detailCache = useRef({});  // cache: { [supplementName]: detailObject }
  const INITIAL_REC_COUNT = 6;
  
  // Use the appropriate expanded cards set based on current mode
  const expandedCards = detailMode === 'simplified' ? expandedCardsSimplified : expandedCardsDetailed;
  const setExpandedCards = detailMode === 'simplified' ? setExpandedCardsSimplified : setExpandedCardsDetailed;

  // Save preference to localStorage when changed
  useEffect(() => {
    try {
      localStorage.setItem('suppliwise_detail_mode', detailMode);
    } catch {
      // Storage full — skip silently
    }
  }, [detailMode]);

  // Build slim assessment context for supplement detail personalization
  const buildDetailContext = (rec) => {
    if (!assessment) return null;
    return {
      age: assessment.age,
      gender: assessment.gender,
      symptoms: (assessment.symptoms || []).filter(s => s !== 'No current symptoms'),
      goals: assessment.healthGoals || [],
      conditions: (assessment.medicalConditions || []).filter(c => c !== 'None'),
      allergies: assessment.allergies || null,
      lifestyle: (assessment.lifestyleHabits || []).filter(h => h !== 'None'),
      diet: assessment.dietType || null,
      pregnancyStatus: assessment.pregnancyStatus || null,
      recommendationReason: rec?.reason || null,
    };
  };
  const handleToggleCard = (id) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      exportResultsToPDF(r, assessment);
    } finally {
      // Small delay so the button state is visible
      setTimeout(() => setExporting(false), 800);
    }
  };

  if (!r) {
    return (
      <div className="results-wrapper">
        <Navbar />
        <div className="results-container">
          <div className="results-card-simple">
            <div className="results-icon">✅</div>
            <h2>Assessment Complete!</h2>
            <p>Your health profile has been saved.</p>
            <button className="btn-primary" onClick={() => navigate('/assessment')}>Take Assessment</button>
          </div>
        </div>
      </div>
    );
  }

  const allRecommendations = r.recommendations || [];

  // Sort: High → Medium → Low, then by confidenceScore descending within each group
  const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };
  const sortedRecommendations = [...allRecommendations].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 3;
    const pb = PRIORITY_ORDER[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    return (b.confidenceScore || 0) - (a.confidenceScore || 0);
  });

  return (
    <div className="results-wrapper">
      <Navbar />
      <div className="results-container">

        {/* Evidence Info Modal */}
        {showEvidenceInfo && (
          <EvidenceInfoModal onClose={() => setShowEvidenceInfo(false)} />
        )}

        {/* Supplement Detail Modal */}
        {detailSupplement && (
          <SupplementDetailModal
            supplementName={detailSupplement.name}
            assessmentId={cacheScope}
            context={detailSupplement.context}
            cache={detailCache}
            onClose={() => setDetailSupplement(null)}
          />
        )}

        {/* Medical Disclaimer Banner */}
        <div className="results-disclaimer-banner">
          <span className="disclaimer-icon">ℹ️</span>
          <p>This information is for <strong>educational and wellness purposes only</strong> and does not diagnose, treat, or cure any disease. Always consult a licensed healthcare professional before starting any supplement regimen.</p>
        </div>

        {/* Consult Doctor Alert */}
        {r.consultDoctor && r.consultReason && (
          <div className="results-consult-alert">
            <span className="consult-icon">🏥</span>
            <div>
              <strong>Medical Consultation Recommended</strong>
              <p>{r.consultReason}</p>
            </div>
          </div>
        )}

        {/* Summary */}
        <div className="results-header">
          <div className="results-header-top">
            <h2>Your Personalized Health Plan</h2>
            {/* Detail Mode Toggle */}
            <div className="detail-mode-toggle">
              <button
                className={`detail-mode-btn ${detailMode === 'simplified' ? 'active' : ''}`}
                onClick={() => setDetailMode('simplified')}
                title="Friendly, easy-to-understand recommendations"
              >
                Simplified
              </button>
              <button
                className={`detail-mode-btn ${detailMode === 'detailed' ? 'active' : ''}`}
                onClick={() => setDetailMode('detailed')}
                title="Technical, medical-grade information"
              >
                Detailed
              </button>
            </div>
          </div>
          <p className="results-summary">{fixChars(detailMode === 'detailed' ? r.summary : r.simplifiedSummary || r.summary)}</p>
        </div>

        {/* Garbage input warning */}
        {garbageFields.length > 0 && (
          <div className="results-garbage-warning">
            <span className="results-garbage-icon">⚠️</span>
            <div>
              <strong>Some of your inputs were unreadable and were not used.</strong>
              <p style={{ marginBottom: '8px' }}>
                The following {garbageFields.length === 1 ? 'field' : 'fields'} contained unrecognizable text and {garbageFields.length === 1 ? 'was' : 'were'} cleared. Please retake the assessment with plain, readable descriptions for more accurate recommendations.
              </p>
              <ul className="results-garbage-list">
                {garbageFields.map((g, i) => (
                  <li key={i}>
                    <strong>{g.label}:</strong>{' '}
                    <span className="results-garbage-value">"{g.value}"</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* All Supplement Recommendations */}
        {sortedRecommendations.length > 0 && (
          <>
            <div className="results-section-title">💊 Supplement Recommendations</div>
            <p className="results-section-sub">Personalized based on your symptoms, health goals, and profile.</p>
            <div className={`results-grid ${detailMode === 'simplified' ? 'results-grid-simple' : ''}`}>
              {(showAllRecs ? sortedRecommendations : sortedRecommendations.slice(0, INITIAL_REC_COUNT)).map((rec, i) => (
                <SupplementCard
                  key={i}
                  rec={rec}
                  index={i}
                  expanded={expandedCards.has(`rec-${i}`)}
                  onToggle={() => handleToggleCard(`rec-${i}`)}
                  onOpenDetail={() => setDetailSupplement({ name: rec.name, context: buildDetailContext(rec) })}
                  detailMode={detailMode}
                  setShowEvidenceInfo={setShowEvidenceInfo}
                />
              ))}
            </div>
            {sortedRecommendations.length > INITIAL_REC_COUNT && (
              <button className="btn-show-more" onClick={() => setShowAllRecs(v => !v)}>
                {showAllRecs
                  ? '▲ Show Less'
                  : `▼ Show More (${sortedRecommendations.length - INITIAL_REC_COUNT} more)`}
              </button>
            )}
          </>
        )}

        {/* Merged Daily Schedule + Action Plan */}
        {(r.dailySchedule?.length > 0 || r.actionPlan?.length > 0) && (
          <>
            <div className="results-section-title">🗓️ Your Daily Schedule & Recovery Plan</div>

            {/* Daily Schedule */}
            {r.dailySchedule?.length > 0 && (
              <div className="daily-schedule">
                {(() => {
                  // Build dosage lookup — fuzzy match supplement names
                  const dosageMap = {};
                  (r.recommendations || []).forEach(rec => {
                    if (rec.name && rec.dosage) {
                      dosageMap[rec.name.toLowerCase()] = rec.dosage;
                    }
                  });

                  // Fuzzy lookup: find best matching rec dosage for a schedule pill name
                  const getDosage = (pillName) => {
                    const pill = pillName.toLowerCase();
                    // Exact match first
                    if (dosageMap[pill]) return dosageMap[pill];
                    // Partial match: pill name contains rec name or rec name contains pill name
                    for (const [recName, dosage] of Object.entries(dosageMap)) {
                      if (pill.includes(recName) || recName.includes(pill)) return dosage;
                      // Word-level overlap: share at least one meaningful word (>3 chars)
                      const pillWords = pill.split(/\s+/).filter(w => w.length > 3);
                      const recWords = recName.split(/\s+/).filter(w => w.length > 3);
                      if (pillWords.some(w => recWords.includes(w))) return dosage;
                    }
                    return null;
                  };

                  return r.dailySchedule.map((slot, i) => (
                    <div key={i} className="schedule-slot">
                      <div className="schedule-time">{fixChars(slot.time)}</div>
                      <div className="schedule-supplements">
                        {slot.supplements.map((s, si) => {
                          const dosage = getDosage(s);
                          return (
                            <span key={si} className="schedule-pill">
                              {fixChars(s)}{dosage ? <span className="schedule-pill-dosage"> - {fixChars(dosage)}</span> : ''}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}

            {/* Recovery Timeframe */}
            {r.actionPlan?.length > 0 && (
              <div className="recovery-plan" style={{ marginTop: r.dailySchedule?.length > 0 ? '20px' : '0' }}>
                {r.actionPlan.map((phase, i) => {
                  // Support both structured objects and legacy plain strings
                  if (typeof phase === 'string') {
                    return (
                      <div key={i} className="recovery-phase">
                        <div className="recovery-phase-header">
                          <span className="recovery-phase-num">{i + 1}</span>
                          <p className="recovery-phase-title">{fixChars(phase)}</p>
                        </div>
                      </div>
                    );
                  }
                  const steps = phase.steps || [];
                  const expected = phase.expectedChanges || [];
                  // Merge supplements/habits/activity into steps if using old fallback shape
                  const allSteps = steps.length > 0 ? steps : [
                    ...(phase.supplements || []),
                    ...(phase.habits || []),
                    ...(phase.activity || []),
                  ];
                  return (
                    <div key={i} className="recovery-phase">
                      <div className="recovery-phase-header">
                        <span className="recovery-phase-num">{i + 1}</span>
                        <div>
                          <p className="recovery-phase-title">{fixChars(phase.phase || phase.week)}</p>
                          {phase.focus && <p className="recovery-phase-focus">{fixChars(phase.focus)}</p>}
                        </div>
                      </div>
                      {allSteps.length > 0 && (
                        <ul className="recovery-steps">
                          {allSteps.map((step, si) => (
                            <li key={si}>{fixChars(step)}</li>
                          ))}
                        </ul>
                      )}
                      {expected.length > 0 && (
                        <div className="recovery-expected">
                          <span className="recovery-expected-label">✦ Expected Changes</span>
                          <ul>
                            {expected.map((e, ei) => (
                              <li key={ei}>{fixChars(e)}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Lifestyle Advice */}
        {r.lifestyleAdvice?.length > 0 && (
          <>
            <div className="results-section-title">🌿 Lifestyle Recommendations</div>
            <div className="lifestyle-grid">
              {r.lifestyleAdvice.map((item, i) => (
                <div key={i} className="lifestyle-card">
                  <div className="lifestyle-category">{item.category}</div>
                  <p className="lifestyle-advice">{item.advice}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Meal Recommendations */}
        {r.mealRecommendations?.length > 0 && (
          <>
            <div className="results-section-title">🍽️ Meal Recommendations</div>
            <div className="meal-grid">
              {r.mealRecommendations.map((meal, i) => (
                <div key={i} className="meal-card">
                  <div className="meal-type">{meal.meal}</div>
                  <p className="meal-suggestion">{meal.suggestion}</p>
                </div>
              ))}
            </div>
          </>
        )}



        {/* Avoid List */}
        {r.avoidList?.length > 0 && (
          <div className="results-avoid">
            <h4>🚫 Supplements to Avoid</h4>
            <ul>{r.avoidList.map((item, i) => <li key={i}>{item}</li>)}</ul>
          </div>
        )}

        {/* Warnings */}
        {r.warnings?.length > 0 && (
          <div className="results-warnings">
            <h4>⚠️ Important Warnings</h4>
            <ul>{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        )}

        {/* Seeking Support — shown only when recreational drugs are reported */}
        {r.seekingSupport?.include && (
          <div className="results-seeking-support">
            <div className="seeking-support-header">
              <span className="seeking-support-icon">💙</span>
              <h4>{fixChars(r.seekingSupport.title)}</h4>
            </div>
            <p className="seeking-support-intro">{fixChars(r.seekingSupport.intro)}</p>
            <div className="seeking-support-resources">
              {(r.seekingSupport.resources || []).map((res, i) => (
                <a
                  key={i}
                  href={res.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="seeking-support-card"
                >
                  <span className="seeking-support-label">{fixChars(res.label)}</span>
                  <span className="seeking-support-name">{fixChars(res.name)}</span>
                  <p className="seeking-support-desc">{fixChars(res.description)}</p>
                  <span className="seeking-support-link">Visit resource →</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Source note */}
        <div className="results-sources">
          <p>📖 <strong>Evidence Sources:</strong> Recommendations prioritize peer-reviewed research from the last 2 years. If unavailable, evidence from the last 5 years is used when authoritative and clinically relevant. If still unavailable, landmark studies or clinical guidelines that remain widely accepted and uncontradicted may be used (clearly labeled). Evidence prioritizes systematic reviews, meta-analyses, and clinical practice guidelines from PubMed-indexed studies, NIH Office of Dietary Supplements, World Health Organization, Mayo Clinic, and other recognized medical organizations. All recommendations are presented as wellness guidance and do not diagnose, treat, cure, or prevent diseases.</p>
        </div>

        <p className="results-disclaimer">{r.disclaimer}</p>

        <div className="results-actions">
          <button className="btn-export-pdf" onClick={handleExportPDF} disabled={exporting}>
            {exporting ? (
              <>⏳ Generating PDF...</>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px', verticalAlign: 'middle' }}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Export PDF
              </>
            )}
          </button>
          <button className="btn-secondary" onClick={() => navigate('/history')}>View History</button>
          <button className="btn-secondary" onClick={() => navigate('/assessment')}>Retake Assessment</button>
          <button className="btn-primary" onClick={() => navigate('/')}>Back to Home</button>
        </div>

      </div>
    </div>
  );
}

export default ResultsPage;
